#!/usr/bin/env node
/**
 * twin-sync — migrate changes between two checkouts of the same codebase that
 * live in separate git repositories.
 *
 *   twin-sync init --a <path> --b <path>   configure the pair
 *   twin-sync status                       show what differs
 *   twin-sync push [opts]                  migrate A → B
 *   twin-sync pull [opts]                  migrate B → A
 *   twin-sync sync --from a --to b [opts]  explicit direction
 */

import { createInterface } from "node:readline/promises";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";

import { loadConfig, writeConfig, CONFIG_FILENAME, type Config } from "./config.js";
import { isGitRepo, lastCommit, commitAll, pushRepo } from "./git.js";
import { buildPlan, summarize, type Change, type Plan } from "./planner.js";
import { apply, shortPath } from "./sync.js";
import { encryptPush, decryptPull, vaultStatus, type VaultChange, type VaultResult } from "./vault.js";
import { c, setColor, out, info, warn, fail } from "./logger.js";

const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

interface Args {
  command: string;
  positionals: string[];
  str: Map<string, string>;
  multi: Map<string, string[]>;
  bool: Set<string>;
}

const BOOL_FLAGS = new Set([
  "dry-run",
  "yes",
  "delete",
  "no-delete",
  "json",
  "no-color",
  "force",
  "commit",
  "push",
  "help",
  "version",
]);
const MULTI_FLAGS = new Set(["include", "exclude"]);
const ALIASES: Record<string, string> = {
  y: "yes",
  h: "help",
  v: "version",
  n: "dry-run",
  m: "message",
};

function parse(argv: string[]): Args {
  const args: Args = {
    command: "",
    positionals: [],
    str: new Map(),
    multi: new Map(),
    bool: new Set(),
  };

  const tokens = [...argv];
  while (tokens.length) {
    const tok = tokens.shift() as string;

    if (tok.startsWith("--") || (tok.startsWith("-") && tok.length === 2)) {
      let name = tok.startsWith("--") ? tok.slice(2) : tok.slice(1);
      let inlineVal: string | undefined;
      const eq = name.indexOf("=");
      if (eq !== -1) {
        inlineVal = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      name = ALIASES[name] ?? name;

      if (BOOL_FLAGS.has(name)) {
        args.bool.add(name);
        continue;
      }
      const value = inlineVal ?? (tokens.shift() as string | undefined);
      if (value === undefined) fail(`Flag --${name} expects a value.`);
      if (MULTI_FLAGS.has(name)) {
        const list = args.multi.get(name) ?? [];
        list.push(value);
        args.multi.set(name, list);
      } else {
        args.str.set(name, value);
      }
      continue;
    }

    if (!args.command) args.command = tok;
    else args.positionals.push(tok);
  }

  return args;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

interface CommonOpts {
  include: string[];
  exclude: string[];
  deletions: boolean;
  noDelete: boolean;
  since?: string;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  /** Passphrase for encrypted-vault mode; when set, push/pull encrypt/decrypt. */
  key?: string;
  /** After an encrypted push, commit the vault repo B. Implied by `push`. */
  commit: boolean;
  /** After an encrypted push, commit and `git push` the vault repo B. */
  push: boolean;
  /** Commit message for --commit/--push. */
  message?: string;
}

function commonOpts(args: Args, cfg: Config): CommonOpts {
  return {
    include: args.multi.get("include") ?? [],
    exclude: [...cfg.exclude, ...(args.multi.get("exclude") ?? [])],
    deletions: args.bool.has("delete"),
    noDelete: args.bool.has("no-delete"),
    since: args.str.get("since"),
    dryRun: args.bool.has("dry-run"),
    yes: args.bool.has("yes"),
    json: args.bool.has("json"),
    key: resolveKey(args, cfg),
    commit: args.bool.has("commit"),
    push: args.bool.has("push"),
    message: args.str.get("message"),
  };
}

/**
 * Resolve the vault passphrase, most-explicit source first:
 *   --key <literal> › --key-command <cmd> › TWIN_SYNC_KEY_COMMAND › config
 *   keyCommand › TWIN_SYNC_KEY <literal>
 * A "command" source has its stdout used as the key, so the secret can live in
 * a keychain instead of a plaintext env var or file.
 */
function resolveKey(args: Args, cfg: Config): string | undefined {
  const literal = args.str.get("key");
  if (literal !== undefined) return literal;

  const cmd =
    args.str.get("key-command") ??
    process.env.TWIN_SYNC_KEY_COMMAND ??
    cfg.keyCommand;
  if (cmd) return runKeyCommand(cmd);

  return process.env.TWIN_SYNC_KEY;
}

/** Run a key command and use its stdout (minus a trailing newline) as the key. */
function runKeyCommand(cmd: string): string {
  let out: string;
  try {
    // stdout is captured (the secret); stdin/stderr are inherited so an
    // interactive unlock (biometric popup, passphrase prompt) still works.
    out = execSync(cmd, {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "inherit"],
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    return fail(`Key command failed: ${cmd}\n${(err as Error).message}`);
  }
  const key = out.replace(/[\r\n]+$/, "");
  return key || fail(`Key command produced no output: ${cmd}`);
}

function sym(type: Change["type"]): string {
  if (type === "add") return c.green("+");
  if (type === "modify") return c.yellow("~");
  return c.red("-");
}

function printPlan(plan: Plan, fromLabel: string, toLabel: string): void {
  if (plan.changes.length === 0) {
    info(c.green("✔ ") + `Already in sync (${plan.scanned} files scanned).`);
    return;
  }
  info(
    c.bold(`\n${fromLabel} `) +
      c.gray("→") +
      c.bold(` ${toLabel}`) +
      c.gray(`  (${plan.scanned} scanned)`),
  );
  for (const ch of plan.changes) {
    info(`  ${sym(ch.type)} ${ch.path}`);
  }
  const s = summarize(plan.changes);
  info(
    "\n  " +
      c.green(`${s.add} added`) +
      c.gray(" · ") +
      c.yellow(`${s.modify} modified`) +
      c.gray(" · ") +
      c.red(`${s.delete} deleted`),
  );
}

function printVault(res: VaultResult, title: string): void {
  if (res.changes.length === 0) {
    info(c.green("✔ ") + `Vault in sync (${res.scanned} files, ${res.unchanged} unchanged).`);
    return;
  }
  info(c.bold(`\n${title}`) + c.gray(`  (${res.scanned} scanned, ${res.unchanged} unchanged)`));
  for (const ch of res.changes) info(`  ${sym(ch.type)} ${ch.path}`);
  const s = summarizeVault(res.changes);
  info(
    "\n  " +
      c.green(`${s.add} added`) +
      c.gray(" · ") +
      c.yellow(`${s.modify} modified`) +
      c.gray(" · ") +
      c.red(`${s.delete} deleted`),
  );
}

function summarizeVault(changes: VaultChange[]): Record<VaultChange["type"], number> {
  const counts: Record<VaultChange["type"], number> = { add: 0, modify: 0, delete: 0 };
  for (const ch of changes) counts[ch.type]++;
  return counts;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    warn("Non-interactive shell: pass --yes to apply, or --dry-run to preview.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const ans = (await rl.question(question + c.gray(" [y/N] "))).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

function resolveRoots(
  cfg: Config,
  from: "a" | "b",
): { fromPath: string; toPath: string; fromLabel: string; toLabel: string } {
  const to = from === "a" ? "b" : "a";
  return {
    fromPath: cfg[from],
    toPath: cfg[to],
    fromLabel: `${cfg.labels[from]} (${shortPath(cfg[from])})`,
    toLabel: `${cfg.labels[to]} (${shortPath(cfg[to])})`,
  };
}

function requireRepos(cfg: Config): void {
  for (const key of ["a", "b"] as const) {
    const p = cfg[key];
    if (!existsSync(p)) fail(`Path for ${cfg.labels[key]} does not exist: ${p}`);
    if (!isGitRepo(p)) warn(`${cfg.labels[key]} is not a git repository: ${p}`);
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function cmdInit(args: Args): void {
  const target = resolve(process.cwd(), CONFIG_FILENAME);
  if (existsSync(target) && !args.bool.has("force")) {
    fail(`${CONFIG_FILENAME} already exists here. Re-run with --force to overwrite.`);
  }

  const a = args.str.get("a");
  const b = args.str.get("b");
  if (!a || !b) {
    fail("init requires --a <path> and --b <path>.");
  }
  const aAbs = resolve(a as string);
  const bAbs = resolve(b as string);

  for (const [label, p] of [["A", aAbs], ["B", bAbs]] as const) {
    if (!existsSync(p)) warn(`Path ${label} does not exist yet: ${p}`);
    else if (!isGitRepo(p)) warn(`Path ${label} is not a git repository: ${p}`);
  }

  writeConfig(target, {
    a: aAbs,
    b: bAbs,
    labels: {
      a: args.str.get("label-a") ?? "A",
      b: args.str.get("label-b") ?? "B",
    },
    exclude: args.multi.get("exclude") ?? [],
  });

  info(c.green("✔ ") + `Wrote ${shortPath(target)}`);
  info(c.gray(`  ${args.str.get("label-a") ?? "A"} → ${aAbs}`));
  info(c.gray(`  ${args.str.get("label-b") ?? "B"} → ${bAbs}`));
  info("\nNext: " + c.cyan("twin-sync status") + " to see what differs.");
}

async function cmdStatus(args: Args): Promise<void> {
  const cfg = loadConfig({ configPath: args.str.get("config") });
  const opts = commonOpts(args, cfg);
  if (opts.key !== undefined) return cmdVaultStatus(cfg, opts);

  requireRepos(cfg);

  // Symmetric view: deletions=true surfaces files present on only one side.
  const plan = await buildPlan(cfg.a, cfg.b, {
    include: opts.include,
    exclude: opts.exclude,
    deletions: true,
    since: opts.since,
  });

  if (opts.json) {
    out(
      JSON.stringify(
        {
          a: cfg.a,
          b: cfg.b,
          scanned: plan.scanned,
          changes: plan.changes.map((ch) => ({
            path: ch.path,
            state:
              ch.type === "add"
                ? "only-in-a"
                : ch.type === "delete"
                  ? "only-in-b"
                  : "differ",
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (plan.changes.length === 0) {
    info(c.green("✔ ") + `In sync (${plan.scanned} files scanned).`);
    return;
  }

  info(
    c.bold(`\n${cfg.labels.a}`) +
      c.gray(` (${shortPath(cfg.a)})  vs  `) +
      c.bold(cfg.labels.b) +
      c.gray(` (${shortPath(cfg.b)})`),
  );

  for (const ch of plan.changes) {
    if (ch.type === "add") {
      info(`  ${c.green("A only")}  ${ch.path}`);
    } else if (ch.type === "delete") {
      info(`  ${c.blue("B only")}  ${ch.path}`);
    } else {
      info(`  ${c.yellow("differ")}  ${ch.path}${aheadHint(cfg, ch.path)}`);
    }
  }

  const s = summarize(plan.changes);
  info(
    "\n  " +
      c.green(`${s.add} only in ${cfg.labels.a}`) +
      c.gray(" · ") +
      c.blue(`${s.delete} only in ${cfg.labels.b}`) +
      c.gray(" · ") +
      c.yellow(`${s.modify} differ`),
  );
  info(
    c.gray(
      `\nMigrate with  twin-sync push  (${cfg.labels.a}→${cfg.labels.b})  or  twin-sync pull  (${cfg.labels.b}→${cfg.labels.a})`,
    ),
  );
}

/** Small hint about which side's git history is more recent for a file. */
function aheadHint(cfg: Config, file: string): string {
  const ca = lastCommit(cfg.a, file);
  const cb = lastCommit(cfg.b, file);
  if (!ca || !cb) return "";
  if (ca.date === cb.date) return "";
  const newer = ca.date > cb.date ? cfg.labels.a : cfg.labels.b;
  return c.gray(`  (${newer} newer)`);
}

async function cmdMigrate(args: Args, direction: "a" | "b"): Promise<void> {
  const cfg = loadConfig({ configPath: args.str.get("config") });
  const opts = commonOpts(args, cfg);
  if (opts.key !== undefined) return cmdVaultMigrate(cfg, direction, opts);

  requireRepos(cfg);
  const { fromPath, toPath, fromLabel, toLabel } = resolveRoots(cfg, direction);

  const plan = await buildPlan(fromPath, toPath, {
    include: opts.include,
    exclude: opts.exclude,
    deletions: opts.deletions,
    since: opts.since,
  });

  if (opts.json) {
    out(JSON.stringify({ from: fromPath, to: toPath, dryRun: opts.dryRun, changes: plan.changes }, null, 2));
    if (!opts.dryRun && plan.changes.length) apply(plan, false);
    return;
  }

  printPlan(plan, fromLabel, toLabel);
  if (plan.changes.length === 0) return;

  if (opts.dryRun) {
    info(c.gray("\nDry run — nothing was written."));
    return;
  }

  if (!opts.yes) {
    const ok = await confirm(`\nApply ${plan.changes.length} change(s) to ${cfg.labels[direction === "a" ? "b" : "a"]}?`);
    if (!ok) {
      info(c.gray("Aborted."));
      return;
    }
  }

  const result = apply(plan, false);
  info(c.green("\n✔ ") + `Applied ${result.applied.length} change(s).`);
  if (result.failed.length) {
    warn(`${result.failed.length} change(s) failed:`);
    for (const f of result.failed) info(`  ${c.red("✖")} ${f.change.path}: ${f.error}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// encrypted-vault mode (push/pull/status with --key)
//
// A = plaintext local dev tree; B = an encrypted git repo (the "vault").
// push encrypts A → B; pull decrypts B → A. Only files whose plaintext sha
// changed are re-sealed, so git sees (and transfers) just the real diff.
// ---------------------------------------------------------------------------

async function cmdVaultStatus(cfg: Config, opts: CommonOpts): Promise<void> {
  if (!existsSync(cfg.a)) fail(`Source path for ${cfg.labels.a} does not exist: ${cfg.a}`);
  if (!isGitRepo(cfg.a)) warn(`${cfg.labels.a} is not a git repository — file enumeration needs git.`);

  const res = await vaultStatus(cfg.a, cfg.b, opts.key as string, {
    include: opts.include,
    exclude: opts.exclude,
  });
  if (opts.json) return void out(JSON.stringify(res, null, 2));
  printVault(res, `${cfg.labels.a} → vault (${shortPath(cfg.b)})`);
}

async function cmdVaultMigrate(cfg: Config, direction: "a" | "b", opts: CommonOpts): Promise<void> {
  const key = opts.key as string;
  const isPush = direction === "a";

  if (isPush) {
    if (!existsSync(cfg.a)) fail(`Source path for ${cfg.labels.a} does not exist: ${cfg.a}`);
    if (!isGitRepo(cfg.a)) warn(`${cfg.labels.a} is not a git repository — file enumeration needs git.`);
  }

  const title = isPush
    ? `${cfg.labels.a} → vault (${shortPath(cfg.b)})`
    : `vault (${shortPath(cfg.b)}) → ${cfg.labels.a}`;

  const run = (dry: boolean): Promise<VaultResult> =>
    isPush
      ? encryptPush(cfg.a, cfg.b, key, {
          include: opts.include,
          exclude: opts.exclude,
          dryRun: dry,
          // The vault mirrors A, so deletions propagate by default; --no-delete
          // keeps it additive (never removes a blob from B).
          prune: !opts.noDelete,
        })
      : decryptPull(cfg.b, cfg.a, key, {
          include: opts.include,
          exclude: opts.exclude,
          dryRun: dry,
          // Symmetric with push: A mirrors the vault, so files removed from B
          // are removed from A too. --no-delete keeps it additive.
          prune: !opts.noDelete,
        });

  const preview = await run(true);

  if (opts.json) {
    out(JSON.stringify(preview, null, 2));
    if (!opts.dryRun && preview.changes.length) {
      const applied = await run(false);
      if (isPush) finalizeVault(cfg, opts, applied);
    }
    return;
  }

  printVault(preview, title);
  if (preview.changes.length === 0) return;
  if (opts.dryRun) return void info(c.gray("\nDry run — nothing was written."));

  if (!opts.yes) {
    const target = isPush ? `vault ${cfg.labels.b}` : cfg.labels.a;
    const ok = await confirm(`\nApply ${preview.changes.length} change(s) to ${target}?`);
    if (!ok) return void info(c.gray("Aborted."));
  }

  const applied = await run(false);
  info(c.green("\n✔ ") + `Applied ${applied.changes.length} change(s).`);
  if (isPush) finalizeVault(cfg, opts, applied);
}

/** After an encrypted push, optionally commit (and push) the vault repo B. */
function finalizeVault(cfg: Config, opts: CommonOpts, applied: VaultResult): void {
  const b = shortPath(cfg.b);

  if (!opts.commit && !opts.push) {
    info(c.gray(`\nVault updated — commit & push it to encrypt-at-rest on the remote:`));
    info(c.gray(`  git -C ${b} add -A && git -C ${b} commit -m sync && git -C ${b} push`));
    return;
  }

  if (!isGitRepo(cfg.b)) {
    warn(`${cfg.labels.b} is not a git repository — run 'git -C ${b} init' first to use --commit/--push.`);
    process.exitCode = 1;
    return;
  }

  const s = summarizeVault(applied.changes);
  const message =
    opts.message ?? `twin-sync: ${s.add} added, ${s.modify} modified, ${s.delete} deleted`;

  let committed: boolean;
  try {
    committed = commitAll(cfg.b, message);
  } catch (err) {
    warn(`Vault files written, but 'git commit' failed:\n${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (committed) info(c.green("✔ ") + `Committed vault: ${c.gray(message)}`);
  else info(c.gray("Nothing new to commit in the vault."));

  if (opts.push) {
    try {
      pushRepo(cfg.b);
      info(c.green("✔ ") + "Pushed vault to its remote.");
    } catch (err) {
      warn(`Vault committed, but 'git push' failed:\n${(err as Error).message}`);
      warn(`Set a remote/upstream, then: git -C ${b} push`);
      process.exitCode = 1;
    }
  }
}

function cmdHelp(): void {
  out(`${c.bold("twin-sync")} ${c.gray("v" + VERSION)} — sync two repos that share one codebase

${c.bold("Usage")}
  twin-sync init --a <path> --b <path> [--label-a <name>] [--label-b <name>]
  twin-sync status [options]
  twin-sync push   [options]        migrate A → B
  twin-sync pull   [options]        migrate B → A

${c.bold("Options")}
  --key <passphrase>   encrypted-vault mode: push encrypts A → B, pull decrypts B → A
  --key-command <cmd>  run <cmd> and use its stdout as the key (e.g. a keychain read)
  --commit             after an encrypted push, git-commit the vault repo B
  --push               after an encrypted push, git-commit AND git-push B
  --message, -m <msg>  commit message for --commit/--push
  --since <ref>        only consider files changed since <ref> in the source repo
  --include <glob>     restrict to matching paths (repeatable, git pathspec)
  --exclude <glob>     skip matching paths (repeatable, git pathspec)
  --delete             (plaintext mode) also remove dest files missing from the source
  --no-delete          (vault mode) don't propagate deletions — push/pull stay additive
  --dry-run, -n        preview without writing
  --yes, -y            skip the confirmation prompt
  --json               machine-readable output
  --config <file>      use a specific .twin-sync.json
  --no-color           disable colored output
  --help, -h           show this help
  --version, -v        print version

${c.bold("Encrypted vault")} ${c.gray("(--key)")}
  With --key, B becomes an encrypted git repo: files are stored as opaque
  store/<id>.enc blobs plus an encrypted manifest — no names, paths, or
  contents leak to the git host. Only files whose content changed are
  re-sealed, so 'git push' of B transfers just the real diff. push and pull
  both mirror: a file deleted on one side is removed from the other on the
  next sync. Pass --no-delete to keep the target additive instead.

${c.bold("Configuration")} ${c.gray("(priority: --config > env > .twin-sync.json)")}
  TWIN_SYNC_A, TWIN_SYNC_B   absolute paths to the two project roots
  TWIN_SYNC_KEY              vault passphrase (literal)
  TWIN_SYNC_KEY_COMMAND      command whose stdout is the passphrase (e.g. a keychain read)

${c.bold("Examples")}
  twin-sync init --a ../frontend-oss --b ../frontend-internal
  twin-sync status
  twin-sync push --since HEAD~5 --dry-run
  twin-sync pull --exclude 'node_modules' --exclude '*.env' --yes
  twin-sync push --key 's3cret' --dry-run          # preview encrypt A → vault B
  TWIN_SYNC_KEY=s3cret twin-sync pull --yes        # decrypt vault B → A
`);
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));

  if (args.bool.has("no-color")) setColor(false);
  if (args.bool.has("version")) return void out(VERSION);
  if (args.bool.has("help") || args.command === "" || args.command === "help") {
    return cmdHelp();
  }

  switch (args.command) {
    case "init":
      return cmdInit(args);
    case "status":
      return cmdStatus(args);
    case "push":
      return cmdMigrate(args, "a");
    case "pull":
      return cmdMigrate(args, "b");
    case "sync": {
      const from = (args.str.get("from") ?? "a").toLowerCase();
      if (from !== "a" && from !== "b") fail("--from must be 'a' or 'b'.");
      return cmdMigrate(args, from as "a" | "b");
    }
    default:
      fail(`Unknown command '${args.command}'. Run 'twin-sync --help'.`);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
