/**
 * Thin wrapper around the git CLI.
 *
 * We lean on git for two things it does better than we ever could:
 *   1. Enumerating the "real" files of a project (tracked + untracked,
 *      with .gitignore applied automatically).
 *   2. Applying include/exclude filters as native pathspecs.
 *
 * Everything here operates on a single repo root (`cwd`).
 */

import { execFileSync } from "node:child_process";

export class GitError extends Error {}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message: string };
    const detail = e.stderr ? e.stderr.toString().trim() : e.message;
    throw new GitError(`git ${args.join(" ")}\n${detail}`);
  }
}

/** True if `dir` is inside a git working tree. */
export function isGitRepo(dir: string): boolean {
  try {
    return (
      git(dir, ["rev-parse", "--is-inside-work-tree"]).trim() === "true"
    );
  } catch {
    return false;
  }
}

/** Absolute path to the top level of the working tree containing `dir`. */
export function repoRoot(dir: string): string {
  return git(dir, ["rev-parse", "--show-toplevel"]).trim();
}

function splitZ(raw: string): string[] {
  return raw.split("\0").filter((s) => s.length > 0);
}

/**
 * All files that make up the project: tracked files plus untracked files
 * that aren't ignored. Paths are repo-relative and use forward slashes
 * (git's native format), which we keep consistent across platforms.
 */
export function listFiles(cwd: string, pathspecs: string[]): string[] {
  const specSep = pathspecs.length ? ["--", ...pathspecs] : [];
  const tracked = splitZ(git(cwd, ["ls-files", "-z", ...specSep]));
  const untracked = splitZ(
    git(cwd, ["ls-files", "-z", "--others", "--exclude-standard", ...specSep]),
  );
  return unique([...tracked, ...untracked]).sort();
}

/**
 * Files that changed since `ref` (a branch, tag, or commit) up to and
 * including the current working tree — this is the "look at git history"
 * path. Renames are surfaced as an add + delete of each side. Untracked
 * new files are folded in so a brand-new file still gets migrated.
 */
export function changedSince(
  cwd: string,
  ref: string,
  pathspecs: string[],
): string[] {
  const specSep = pathspecs.length ? ["--", ...pathspecs] : [];
  const diff = splitZ(
    git(cwd, ["diff", "--name-only", "-z", ref, ...specSep]),
  );
  const untracked = splitZ(
    git(cwd, ["ls-files", "-z", "--others", "--exclude-standard", ...specSep]),
  );
  return unique([...diff, ...untracked]).sort();
}

/** Last commit that touched `file`, for informational "which side is ahead" hints. */
export function lastCommit(
  cwd: string,
  file: string,
): { hash: string; date: string; subject: string } | null {
  try {
    const raw = git(cwd, [
      "log",
      "-1",
      "--format=%h%x00%cI%x00%s",
      "--",
      file,
    ]).trim();
    if (!raw) return null;
    const [hash = "", date = "", subject = ""] = raw.split("\0");
    return { hash, date, subject };
  } catch {
    return null;
  }
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
