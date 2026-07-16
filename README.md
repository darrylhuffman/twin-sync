# twin-sync

Sync two project directories that live in **separate git repositories** but are
the **same codebase** — e.g. an open-source mirror and a private fork, or a
customer-specific copy of a shared product.

It migrates changes in either direction by:

1. **Enumerating candidate files with git** — tracked + untracked, with
   `.gitignore` applied automatically. Optionally scoped to files changed
   `--since <ref>` (this is the "look at git history" part).
2. **Comparing content by hash** — a `sha256` of each file's bytes (same idea as
   git's blob SHA, but computed from the working tree so it also covers
   uncommitted/untracked files). Only files that *actually differ* are touched.
3. **Copying the diff** into the destination, with a preview and confirmation.

Because the two repos have independent histories, a shared git ref can't tell
you what differs between them — so the content hash is the source of truth and
git history is just a fast way to narrow the search.

## Install

```bash
npm install -g twin-sync      # global CLI
# or, inside a project:
npm install --save-dev twin-sync
```

## Quick start

```bash
# 1. Point at the two checkouts (writes .twin-sync.json in the current dir)
twin-sync init --a ../frontend-oss --b ../frontend-internal \
  --label-a oss --label-b internal

# 2. See what differs
twin-sync status

# 3. Migrate — always preview first
twin-sync push --dry-run        # oss → internal (A → B)
twin-sync push                  # apply, with a confirmation prompt
twin-sync pull                  # internal → oss (B → A)
```

> The command is also available as `tsync` for short.

## Setting the paths

Priority order: `--config <file>` › environment variables › `.twin-sync.json`
found by walking up from the current directory.

```jsonc
// .twin-sync.json
{
  "a": "/abs/path/to/project-1",
  "b": "/abs/path/to/project-2",
  "labels": { "a": "oss", "b": "internal" },
  "exclude": ["*.env", "config/secrets.*"]   // always skipped
}
```

Or via environment variables (handy in CI):

```bash
export TWIN_SYNC_A=/abs/path/to/project-1
export TWIN_SYNC_B=/abs/path/to/project-2
twin-sync status
```

## Commands

| Command | Direction | Description |
| --- | --- | --- |
| `twin-sync init` | — | Write `.twin-sync.json`. |
| `twin-sync status` | — | List every file that differs between A and B. |
| `twin-sync push` | A → B | Migrate A's changes into B. |
| `twin-sync pull` | B → A | Migrate B's changes into A. |
| `twin-sync sync --from a --to b` | explicit | Same as push/pull, spelled out. |

## Options

| Flag | Meaning |
| --- | --- |
| `--since <ref>` | Only consider files changed since `<ref>` in the source repo (branch, tag, or commit). |
| `--include <glob>` | Restrict to matching paths (repeatable; a git pathspec). |
| `--exclude <glob>` | Skip matching paths (repeatable; a git pathspec). |
| `--delete` | Also remove files from the destination that no longer exist in the source. Off by default — sync is additive unless you ask. |
| `--dry-run`, `-n` | Preview the plan without writing anything. |
| `--yes`, `-y` | Skip the confirmation prompt (required in non-interactive shells). |
| `--json` | Machine-readable output. |
| `--config <file>` | Use a specific config file. |
| `--no-color` | Disable colored output. |

## Examples

```bash
# Only migrate what changed in the last 5 commits, and preview it
twin-sync push --since HEAD~5 --dry-run

# Mirror only the src/ tree, never touch env files, and prune deletions
twin-sync pull --include 'src/**' --exclude '*.env' --delete --yes

# One-off run against arbitrary checkouts, no config file
TWIN_SYNC_A=~/a TWIN_SYNC_B=~/b twin-sync status --json
```

## Programmatic API

```ts
import { loadConfig, buildPlan, apply } from "twin-sync";

const cfg = loadConfig({});
const plan = await buildPlan(cfg.a, cfg.b, {
  include: [],
  exclude: cfg.exclude,
  deletions: false,
});
console.log(plan.changes);      // [{ path, type: "add" | "modify" | "delete" }]
apply(plan, /* dryRun */ false);
```

## How it decides what to copy

For each candidate file:

- present in source, **absent** in destination → **add**
- present in both, **different** sha256 → **modify**
- absent in source, present in destination → **delete** (only with `--delete`)
- identical bytes → skipped

A `stat()` size check short-circuits before hashing, so unchanged trees are
scanned quickly.

## Notes & safety

- `.gitignore` is always respected — ignored files (build output, `node_modules`,
  secrets) are never enumerated.
- Deletions are **opt-in** (`--delete`).
- Nothing is written without a confirmation prompt unless you pass `--yes`.
- Both directories must be git working trees; you'll get a warning otherwise.

## License

MIT
