/**
 * Content identity. The whole tool hinges on one question: "are these two
 * files byte-for-byte the same?" We answer it with a sha256 of the file's
 * contents — the same idea as git's blob SHA, but computed directly from the
 * working tree so it also covers uncommitted and untracked files.
 *
 * A stat() short-circuit keeps the common case (unchanged file) cheap-ish and
 * lets us skip hashing entirely when sizes already disagree.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export interface FileFingerprint {
  exists: boolean;
  size: number;
  /** sha256 hex, or null if not yet computed / file absent. */
  sha: string | null;
}

export async function statSize(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

export function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Compare one file across two roots.
 * Returns "same" | "differ" | "missing-src" | "missing-dest".
 * Only hashes when it has to (both present and same size).
 */
export async function compare(
  srcPath: string,
  destPath: string,
): Promise<{
  status: "same" | "differ" | "missing-src" | "missing-dest";
  srcSha?: string;
  destSha?: string;
}> {
  const [srcSize, destSize] = await Promise.all([
    statSize(srcPath),
    statSize(destPath),
  ]);

  if (srcSize === null && destSize === null) return { status: "same" }; // neither exists
  if (srcSize === null) return { status: "missing-src" };
  if (destSize === null) return { status: "missing-dest" };
  if (srcSize !== destSize) return { status: "differ" };

  const [srcSha, destSha] = await Promise.all([
    sha256(srcPath),
    sha256(destPath),
  ]);
  return {
    status: srcSha === destSha ? "same" : "differ",
    srcSha,
    destSha,
  };
}
