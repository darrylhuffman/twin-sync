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
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";

import { loadConfig, writeConfig, CONFIG_FILENAME, type Config } from "./config.js";
import { isGitRepo, lastCommit } from "./git.js";
import { buildPlan, summarize, type Change, type Plan } from "./planner.js";
import { apply, shortPath } from "./sync.js";
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
  "json",
  "no-color",
  "force",
  "help",
  "version",
]);
const MULTI_FLAGS = new Set(["include", "exclude"]);
const ALIASES: Record<string, string> = { y: "yes", h: "help", v: "version", n: "dry-run" };

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
  since?: string;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
}

function commonOpts(args: Args, cfg: Config): CommonOpts {
  return {
    include: args.multi.get("include") ?? [],
    exclude: [...cfg.exclude, ...(args.multi.get("exclude") ?? [])],
    deletions: args.bool.has("delete"),
    since: args.str.get("since"),
    dryRun: args.bool.has("dry-run"),
    yes: args.bool.has("yes"),
    json: args.bool.has("json"),
  };
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
  requireRepos(cfg);
  const opts = commonOpts(args, cfg);

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
  requireRepos(cfg);
  const opts = commonOpts(args, cfg);
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

function cmdHelp(): void {
  out(`${c.bold("twin-sync")} ${c.gray("v" + VERSION)} — sync two repos that share one codebase

${c.bold("Usage")}
  twin-sync init --a <path> --b <path> [--label-a <name>] [--label-b <name>]
  twin-sync status [options]
  twin-sync push   [options]        migrate A → B
  twin-sync pull   [options]        migrate B → A

${c.bold("Options")}
  --since <ref>        only consider files changed since <ref> in the source repo
  --include <glob>     restrict to matching paths (repeatable, git pathspec)
  --exclude <glob>     skip matching paths (repeatable, git pathspec)
  --delete             also remove files that no longer exist in the source
  --dry-run, -n        preview without writing
  --yes, -y            skip the confirmation prompt
  --json               machine-readable output
  --config <file>      use a specific .twin-sync.json
  --no-color           disable colored output
  --help, -h           show this help
  --version, -v        print version

${c.bold("Configuration")} ${c.gray("(priority: --config > env > .twin-sync.json)")}
  TWIN_SYNC_A, TWIN_SYNC_B   absolute paths to the two project roots

${c.bold("Examples")}
  twin-sync init --a ../frontend-oss --b ../frontend-internal
  twin-sync status
  twin-sync push --since HEAD~5 --dry-run
  twin-sync pull --exclude 'node_modules' --exclude '*.env' --yes
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
