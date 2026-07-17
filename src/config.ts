/**
 * Where the two project roots come from, in priority order:
 *   1. an explicit --config <file>
 *   2. environment variables TWIN_SYNC_A / TWIN_SYNC_B
 *   3. a .twin-sync.json found by walking up from the cwd
 *
 * `init` writes option 3. Either A or B may be overridden by env vars even
 * when a file exists, so CI can point at different checkouts without editing
 * the committed config.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CONFIG_FILENAME = ".twin-sync.json";

export interface Config {
  /** Absolute path to project A ("push" source, "pull" destination). */
  a: string;
  /** Absolute path to project B. */
  b: string;
  /** Friendly names shown in output. */
  labels: { a: string; b: string };
  /** Default exclude pathspecs applied to every command. */
  exclude: string[];
  /**
   * Shell command whose stdout is the vault passphrase (e.g. a secret-manager
   * read). Safe to commit — it names where the key lives, not the key itself.
   */
  keyCommand?: string;
  /** Path the config was loaded from, if any (for messaging). */
  source: string | null;
}

interface RawConfig {
  a?: string;
  b?: string;
  labels?: { a?: string; b?: string };
  exclude?: string[];
  keyCommand?: string;
}

function findUp(startDir: string, filename: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readRaw(file: string): RawConfig {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RawConfig;
  } catch (err) {
    throw new Error(
      `Could not parse ${file}: ${(err as Error).message}`,
    );
  }
}

export function loadConfig(opts: {
  configPath?: string;
  cwd?: string;
}): Config {
  const cwd = opts.cwd ?? process.cwd();
  const file =
    opts.configPath ??
    findUp(cwd, CONFIG_FILENAME) ??
    undefined;

  const raw: RawConfig = file ? readRaw(file) : {};

  const a = process.env.TWIN_SYNC_A ?? raw.a;
  const b = process.env.TWIN_SYNC_B ?? raw.b;

  if (!a || !b) {
    throw new Error(
      "Both project paths must be set. Run `twin-sync init --a <path> --b <path>`, " +
        "or export TWIN_SYNC_A and TWIN_SYNC_B.",
    );
  }

  return {
    a: resolve(a),
    b: resolve(b),
    labels: {
      a: raw.labels?.a ?? "A",
      b: raw.labels?.b ?? "B",
    },
    exclude: raw.exclude ?? [],
    keyCommand: raw.keyCommand,
    source: file ?? null,
  };
}

export function writeConfig(
  file: string,
  data: { a: string; b: string; labels?: { a: string; b: string }; exclude?: string[] },
): void {
  const payload: RawConfig = {
    a: data.a,
    b: data.b,
    ...(data.labels ? { labels: data.labels } : {}),
    ...(data.exclude ? { exclude: data.exclude } : {}),
  };
  writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
}
