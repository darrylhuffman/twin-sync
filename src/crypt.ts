/**
 * Cryptographic primitives for the encrypted vault.
 *
 * One passphrase (supplied on the command line, or via TWIN_SYNC_KEY) is
 * stretched with scrypt into a 256-bit key; every file — and the manifest —
 * is sealed with AES-256-GCM under that key. GCM is authenticated, so a wrong
 * key or a tampered blob fails loudly instead of silently yielding garbage.
 *
 * Because the vault only ever re-encrypts a file when its *plaintext* actually
 * changed (see vault.ts), we can afford a fresh random nonce on every seal
 * without churning git — no deterministic-nonce compromise required. That's the
 * security win that justifies rolling this ourselves instead of using git-crypt.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/** Blob framing: MAGIC ‖ nonce(12) ‖ tag(16) ‖ ciphertext. */
const MAGIC = Buffer.from("TSV1", "ascii"); // twin-sync vault, format v1
const KEY_LEN = 32; // AES-256
const NONCE_LEN = 12; // 96-bit GCM nonce
const TAG_LEN = 16; // 128-bit GCM auth tag
const HEADER_LEN = MAGIC.length + NONCE_LEN + TAG_LEN;

/** Public, non-secret parameters stored beside the vault (crypt-meta.json). */
export interface CryptMeta {
  version: 1;
  kdf: "scrypt";
  /** hex-encoded scrypt salt. */
  salt: string;
  n: number;
  r: number;
  p: number;
  cipher: "aes-256-gcm";
}

// scrypt cost: ~100ms and ~32MB per derivation — fine for a one-shot CLI.
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/** Fresh metadata for a brand-new vault (new random salt). */
export function newMeta(): CryptMeta {
  return {
    version: 1,
    kdf: "scrypt",
    salt: randomBytes(16).toString("hex"),
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    cipher: "aes-256-gcm",
  };
}

/** Stretch a passphrase into the AES key using the vault's stored parameters. */
export function deriveKey(passphrase: string, meta: CryptMeta): Buffer {
  if (meta.kdf !== "scrypt") throw new Error(`Unsupported KDF: ${meta.kdf}`);
  if (meta.cipher !== "aes-256-gcm") throw new Error(`Unsupported cipher: ${meta.cipher}`);
  return scryptSync(passphrase, Buffer.from(meta.salt, "hex"), KEY_LEN, {
    N: meta.n,
    r: meta.r,
    p: meta.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** Seal plaintext → a self-framed, authenticated blob. */
export function seal(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, nonce, tag, ct]);
}

/** Reverse of {@link seal}. Throws on wrong key, tampering, or bad framing. */
export function open(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < HEADER_LEN || !timingSafeEqual(blob.subarray(0, MAGIC.length), MAGIC)) {
    throw new Error("Not a twin-sync vault blob (bad magic or truncated).");
  }
  const nonce = blob.subarray(MAGIC.length, MAGIC.length + NONCE_LEN);
  const tag = blob.subarray(MAGIC.length + NONCE_LEN, HEADER_LEN);
  const ct = blob.subarray(HEADER_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // GCM tag mismatch — the one place a wrong key surfaces.
    throw new Error("Decryption failed — wrong key or corrupt vault.");
  }
}
