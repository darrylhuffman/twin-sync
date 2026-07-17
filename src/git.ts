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
      // Capture stderr instead of letting it inherit the terminal, so probes
      // that are *expected* to fail (e.g. isGitRepo) don't spew "fatal:" lines.
      stdio: ["ignore", "pipe", "pipe"],
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

/**
 * Stage everything and commit. Returns false (a no-op, not an error) when there
 * was nothing staged to commit — e.g. a re-push that changed no files.
 */
export function commitAll(cwd: string, message: string): boolean {
  git(cwd, ["add", "-A"]);
  try {
    // `diff --cached --quiet` exits 0 when the index matches HEAD (nothing to do).
    git(cwd, ["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    // exit 1 => staged changes exist; fall through and commit them.
  }
  git(cwd, ["commit", "-m", message]);
  return true;
}

/**
 * Push the current branch. If an upstream is already set, a plain `git push`
 * suffices; otherwise (a fresh vault repo) pick a remote — preferring `origin`
 * — and push with `-u` so subsequent pushes are just `git push`.
 */
export function pushRepo(cwd: string): void {
  try {
    git(cwd, ["rev-parse", "--abbrev-ref", "@{u}"]); // throws if no upstream
    git(cwd, ["push"]);
    return;
  } catch {
    // no upstream configured yet — fall through to first-push setup
  }

  const remotes = git(cwd, ["remote"]).split("\n").map((s) => s.trim()).filter(Boolean);
  if (remotes.length === 0) {
    throw new GitError(
      "no git remote configured for the vault — add one: git remote add origin <url>",
    );
  }
  const remote = remotes.includes("origin") ? "origin" : (remotes[0] as string);
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  git(cwd, ["push", "-u", remote, branch]);
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
