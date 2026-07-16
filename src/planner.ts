/**
 * Turn "these two roots" into "here is exactly what would change".
 *
 * The plan is direction-aware: `src` is authoritative, `dest` is rewritten to
 * match it. Deletions (files present in dest but not in src) are only included
 * when explicitly requested — the safe default is additive.
 */

import { join } from "node:path";
import { changedSince, listFiles } from "./git.js";
import { compare, statSize } from "./hash.js";

export type ChangeType = "add" | "modify" | "delete";

export interface Change {
  /** repo-relative path (forward slashes). */
  path: string;
  type: ChangeType;
}

export interface PlanOptions {
  since?: string;
  include: string[];
  exclude: string[];
  deletions: boolean;
}

export interface Plan {
  from: string;
  to: string;
  changes: Change[];
  /** number of candidate files inspected. */
  scanned: number;
}

/** Build git pathspecs: includes are plain, excludes become `:!pattern`. */
function buildPathspecs(include: string[], exclude: string[]): string[] {
  const specs: string[] = [...include];
  for (const ex of exclude) specs.push(`:(exclude)${ex}`);
  return specs;
}

function toDisk(p: string): string {
  // git yields forward slashes; join() handles the OS separator for us.
  return p.split("/").join("/");
}

export async function buildPlan(
  from: string,
  to: string,
  opts: PlanOptions,
): Promise<Plan> {
  const pathspecs = buildPathspecs(opts.include, opts.exclude);

  const candidates = opts.since
    ? changedSince(from, opts.since, pathspecs)
    : listFiles(from, pathspecs);

  const changes: Change[] = [];

  // Bounded-concurrency scan so a huge repo doesn't open thousands of fds.
  const limit = 64;
  for (let i = 0; i < candidates.length; i += limit) {
    const batch = candidates.slice(i, i + limit);
    const results = await Promise.all(
      batch.map(async (rel): Promise<Change | null> => {
        const cmp = await compare(join(from, toDisk(rel)), join(to, toDisk(rel)));
        if (cmp.status === "missing-dest") return { path: rel, type: "add" };
        if (cmp.status === "differ") return { path: rel, type: "modify" };
        // missing-src (deleted between ref and worktree) and same → nothing here.
        return null;
      }),
    );
    for (const r of results) if (r) changes.push(r);
  }

  if (opts.deletions) {
    changes.push(...(await computeDeletions(from, to, pathspecs)));
  }

  changes.sort((x, y) => x.path.localeCompare(y.path));
  return { from, to, changes, scanned: candidates.length };
}

/** Files that exist in dest (tracked/untracked) but not in src → delete. */
async function computeDeletions(
  from: string,
  to: string,
  pathspecs: string[],
): Promise<Change[]> {
  const destFiles = listFiles(to, pathspecs);
  const out: Change[] = [];
  const limit = 64;
  for (let i = 0; i < destFiles.length; i += limit) {
    const batch = destFiles.slice(i, i + limit);
    const results = await Promise.all(
      batch.map(async (rel): Promise<Change | null> => {
        const srcSize = await statSize(join(from, toDisk(rel)));
        return srcSize === null ? { path: rel, type: "delete" } : null;
      }),
    );
    for (const r of results) if (r) out.push(r);
  }
  return out;
}

export function summarize(changes: Change[]): Record<ChangeType, number> {
  const counts: Record<ChangeType, number> = { add: 0, modify: 0, delete: 0 };
  for (const c of changes) counts[c.type]++;
  return counts;
}
