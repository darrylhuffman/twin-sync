/**
 * Apply a Plan to disk. Copies preserve file mode; directories are created as
 * needed; deletions prune newly-empty directories so the destination tree
 * stays tidy. A dry run touches nothing.
 */

import {
  copyFileSync,
  mkdirSync,
  rmSync,
  rmdirSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Change, Plan } from "./planner.js";

export interface ApplyResult {
  applied: Change[];
  failed: { change: Change; error: string }[];
}

function toDisk(rel: string): string {
  return rel.split("/").join("/");
}

/**
 * Remove a directory and any now-empty parents, stopping at `root`.
 * Best-effort and non-throwing: tidying the tree must never turn a successful
 * file deletion into a reported failure.
 */
function pruneEmptyDirs(root: string, startDir: string): void {
  let dir = startDir;
  while (dir.startsWith(root) && dir !== root) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir); // only removes an empty directory
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

export function apply(plan: Plan, dryRun: boolean): ApplyResult {
  const result: ApplyResult = { applied: [], failed: [] };

  for (const change of plan.changes) {
    const srcPath = join(plan.from, toDisk(change.path));
    const destPath = join(plan.to, toDisk(change.path));
    try {
      if (!dryRun) {
        if (change.type === "delete") {
          rmSync(destPath, { force: true });
          pruneEmptyDirs(plan.to, dirname(destPath));
        } else {
          mkdirSync(dirname(destPath), { recursive: true });
          copyFileSync(srcPath, destPath);
        }
      }
      result.applied.push(change);
    } catch (err) {
      result.failed.push({ change, error: (err as Error).message });
    }
  }

  return result;
}

/** Human-readable relative label for a root, from the process cwd. */
export function shortPath(p: string): string {
  const rel = relative(process.cwd(), p);
  return rel === "" ? "." : rel.length < p.length ? rel : p;
}
