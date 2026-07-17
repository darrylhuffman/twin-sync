/**
 * The encrypted vault: project A's files, mirrored into directory B as a flat
 * pile of opaque blobs plus one encrypted manifest (the "sourcemap").
 *
 * Layout of the vault (B):
 *   crypt-meta.json    public KDF/cipher params (salt etc.) — not secret
 *   manifest.enc       encrypted { path -> { id, sha256, size } }
 *   store/<id>.enc     one sealed blob per file; plaintext is `path\0contents`
 *
 * Push (A → B): decrypt the manifest, hash A's files, and re-seal only the ones
 * whose sha changed (plus new ones); drop blobs for deleted files. The per-file
 * plaintext sha lives in the manifest, so detecting "what changed" never
 * decrypts a single file blob — only the small manifest.
 *
 * Pull (B → A): decrypt the manifest and write each blob back to its real path,
 * skipping files already identical on disk.
 *
 * Every blob embeds its own real path, so the manifest is a rebuildable index,
 * not a single point of catastrophic loss. B's directory tree leaks nothing
 * about A's names or structure — only the file count and per-file sizes.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { isGitRepo, listFiles } from "./git.js";
import { sha256, statSize } from "./hash.js";
import { seal, open, deriveKey, newMeta, type CryptMeta } from "./crypt.js";

const META_FILE = "crypt-meta.json";
const MANIFEST_FILE = "manifest.enc";
const STORE_DIR = "store";
const ATTRIBUTES_FILE = ".gitattributes";
const PATH_SEP = 0x00; // NUL never appears in a path, so it's a safe delimiter

// Pin ciphertext as binary so no platform's autocrlf/eol/text filter can ever
// mangle a byte — that would silently break decryption after a git round-trip.
const ATTRIBUTES = [
  "# twin-sync vault — ciphertext. Never apply text/eol filters.",
  "manifest.enc binary",
  "store/** binary",
  "crypt-meta.json -text",
  "",
].join("\n");

export interface VaultEntry {
  /** opaque blob id (store/<id>.enc). */
  id: string;
  /** sha256 of the file's plaintext bytes — the change-detection key. */
  sha256: string;
  size: number;
}

export interface Manifest {
  version: 1;
  files: Record<string, VaultEntry>;
}

export interface VaultChange {
  path: string;
  type: "add" | "modify" | "delete";
}

export interface VaultResult {
  changes: VaultChange[];
  /** files identical on both sides (skipped). */
  unchanged: number;
  /** candidate files inspected on the source side. */
  scanned: number;
}

export interface PushOptions {
  include: string[];
  exclude: string[];
  dryRun: boolean;
  /** remove blobs for files that no longer exist in the source. */
  prune: boolean;
}

// ---------------------------------------------------------------------------
// vault paths
// ---------------------------------------------------------------------------

const metaPath = (vault: string) => join(vault, META_FILE);
const manifestPath = (vault: string) => join(vault, MANIFEST_FILE);
const blobPath = (vault: string, id: string) => join(vault, STORE_DIR, `${id}.enc`);

// ---------------------------------------------------------------------------
// metadata + manifest
// ---------------------------------------------------------------------------

function loadMeta(vault: string): CryptMeta | null {
  const p = metaPath(vault);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CryptMeta) : null;
}

function saveMeta(vault: string, meta: CryptMeta): void {
  writeFileSync(metaPath(vault), JSON.stringify(meta, null, 2) + "\n", "utf8");
}

/** Write the vault's .gitattributes if absent (protects ciphertext from eol filters). */
function ensureAttributes(vault: string): void {
  const p = join(vault, ATTRIBUTES_FILE);
  if (!existsSync(p)) writeFileSync(p, ATTRIBUTES, "utf8");
}

function loadManifest(vault: string, key: Buffer): Manifest {
  const p = manifestPath(vault);
  if (!existsSync(p)) return { version: 1, files: {} };
  return JSON.parse(open(key, readFileSync(p)).toString("utf8")) as Manifest;
}

function saveManifest(vault: string, key: Buffer, m: Manifest): void {
  writeFileSync(manifestPath(vault), seal(key, Buffer.from(JSON.stringify(m), "utf8")));
}

// ---------------------------------------------------------------------------
// blob framing — plaintext is `<path>\0<contents>`
// ---------------------------------------------------------------------------

function frame(path: string, contents: Buffer): Buffer {
  return Buffer.concat([Buffer.from(path, "utf8"), Buffer.from([PATH_SEP]), contents]);
}

function unframe(plain: Buffer): { path: string; contents: Buffer } {
  const nul = plain.indexOf(PATH_SEP);
  if (nul === -1) throw new Error("Corrupt vault blob: missing path header.");
  return {
    path: plain.subarray(0, nul).toString("utf8"),
    contents: plain.subarray(nul + 1),
  };
}

function newId(): string {
  return randomBytes(8).toString("hex"); // 16 hex chars
}

function buildPathspecs(include: string[], exclude: string[]): string[] {
  const specs = [...include];
  for (const ex of exclude) specs.push(`:(exclude)${ex}`);
  return specs;
}

async function inBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

// ---------------------------------------------------------------------------
// diff: source tree vs manifest (never touches the encrypted blobs)
// ---------------------------------------------------------------------------

interface Diff {
  add: { path: string; sha: string; size: number }[];
  modify: { path: string; sha: string; size: number; id: string }[];
  delete: { path: string; id: string }[];
  unchanged: number;
  scanned: number;
}

async function diffAgainstManifest(
  src: string,
  manifest: Manifest,
  pathspecs: string[],
): Promise<Diff> {
  const files = listFiles(src, pathspecs);

  const prints = await inBatches(files, 64, async (rel) => {
    const abs = join(src, rel);
    const size = await statSize(abs);
    const sha = size === null ? null : await sha256(abs);
    return { rel, sha, size };
  });

  // "present" = files that actually exist on disk. git ls-files still lists a
  // tracked file whose working copy was deleted, so basing this on the on-disk
  // fingerprint (size !== null) is what makes such a deletion count as one.
  const present = new Set(prints.filter((p) => p.size !== null).map((p) => p.rel));

  const diff: Diff = { add: [], modify: [], delete: [], unchanged: 0, scanned: files.length };
  for (const { rel, sha, size } of prints) {
    if (sha === null || size === null) continue; // deleted from disk — handled as a deletion below
    const entry = manifest.files[rel];
    if (!entry) diff.add.push({ path: rel, sha, size });
    else if (entry.sha256 !== sha) diff.modify.push({ path: rel, sha, size, id: entry.id });
    else diff.unchanged++;
  }
  for (const [rel, entry] of Object.entries(manifest.files)) {
    if (!present.has(rel)) diff.delete.push({ path: rel, id: entry.id });
  }
  return diff;
}

function collectChanges(diff: Diff, prune: boolean): VaultChange[] {
  const changes: VaultChange[] = [];
  for (const a of diff.add) changes.push({ path: a.path, type: "add" });
  for (const m of diff.modify) changes.push({ path: m.path, type: "modify" });
  if (prune) for (const d of diff.delete) changes.push({ path: d.path, type: "delete" });
  changes.sort((x, y) => x.path.localeCompare(y.path));
  return changes;
}

// ---------------------------------------------------------------------------
// push  (A → encrypted vault B)
// ---------------------------------------------------------------------------

export async function encryptPush(
  src: string,
  vault: string,
  passphrase: string,
  opts: PushOptions,
): Promise<VaultResult> {
  const pathspecs = buildPathspecs(opts.include, opts.exclude);

  const existing = loadMeta(vault);
  const meta = existing ?? newMeta();
  const key = deriveKey(passphrase, meta);
  // loadManifest decrypts with `key`; on an existing vault this is where a
  // wrong passphrase is caught (GCM auth failure) before we touch anything.
  const manifest = loadManifest(vault, key);

  const diff = await diffAgainstManifest(src, manifest, pathspecs);

  if (!opts.dryRun) {
    mkdirSync(join(vault, STORE_DIR), { recursive: true });
    ensureAttributes(vault);
    if (!existing) saveMeta(vault, meta);

    for (const a of diff.add) {
      const id = newId();
      writeFileSync(blobPath(vault, id), seal(key, frame(a.path, readFileSync(join(src, a.path)))));
      manifest.files[a.path] = { id, sha256: a.sha, size: a.size };
    }
    for (const m of diff.modify) {
      writeFileSync(blobPath(vault, m.id), seal(key, frame(m.path, readFileSync(join(src, m.path)))));
      manifest.files[m.path] = { id: m.id, sha256: m.sha, size: m.size };
    }
    if (opts.prune) {
      for (const d of diff.delete) {
        rmSync(blobPath(vault, d.id), { force: true });
        delete manifest.files[d.path];
      }
    }
    saveManifest(vault, key, manifest);
  }

  return { changes: collectChanges(diff, opts.prune), unchanged: diff.unchanged, scanned: diff.scanned };
}

// ---------------------------------------------------------------------------
// pull  (encrypted vault B → A)
// ---------------------------------------------------------------------------

export interface PullOptions {
  include: string[];
  exclude: string[];
  dryRun: boolean;
  /** remove git-visible files from A that are no longer in the vault. */
  prune: boolean;
}

export async function decryptPull(
  vault: string,
  dst: string,
  passphrase: string,
  opts: PullOptions,
): Promise<VaultResult> {
  const meta = loadMeta(vault);
  if (!meta) {
    throw new Error(`No vault at ${vault} (missing ${META_FILE}). Run a push first.`);
  }
  const key = deriveKey(passphrase, meta);
  const manifest = loadManifest(vault, key);
  const entries = Object.entries(manifest.files);
  const inVault = new Set(Object.keys(manifest.files));

  const changes: VaultChange[] = [];
  let unchanged = 0;

  await inBatches(entries, 32, async ([rel, entry]) => {
    const abs = join(dst, rel);
    const localSha = existsSync(abs) ? await sha256(abs) : null;
    if (localSha === entry.sha256) {
      unchanged++;
      return;
    }
    const type: VaultChange["type"] = localSha === null ? "add" : "modify";
    if (!opts.dryRun) {
      const { contents } = unframe(open(key, readFileSync(blobPath(vault, entry.id))));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    }
    changes.push({ path: rel, type });
  });

  // Mirror deletions: git-visible files in A that the vault no longer has are
  // removed. Scoped to git's file list so .gitignore'd paths (node_modules,
  // secrets, build output) are never touched. Skipped when A isn't a git repo
  // (e.g. a first decrypt into an empty dir) — there's nothing to prune.
  if (opts.prune && isGitRepo(dst)) {
    const pathspecs = buildPathspecs(opts.include, opts.exclude);
    for (const rel of listFiles(dst, pathspecs)) {
      if (inVault.has(rel)) continue;
      if (!opts.dryRun) rmSync(join(dst, rel), { force: true });
      changes.push({ path: rel, type: "delete" });
    }
  }

  changes.sort((x, y) => x.path.localeCompare(y.path));
  return { changes, unchanged, scanned: entries.length };
}

// ---------------------------------------------------------------------------
// status  (preview A vs vault, writes nothing)
// ---------------------------------------------------------------------------

export function vaultStatus(
  src: string,
  vault: string,
  passphrase: string,
  opts: { include: string[]; exclude: string[] },
): Promise<VaultResult> {
  return encryptPush(src, vault, passphrase, {
    include: opts.include,
    exclude: opts.exclude,
    dryRun: true,
    prune: true,
  });
}
