# twin-sync

Keep a plaintext working copy in sync with an **encrypted git repo**. You edit
normally in **A** (plaintext); what gets committed in **B** is ciphertext — names,
paths, and contents all encrypted, safe to push to any host. `push` encrypts
**A → B**, `pull` decrypts **B → A**.

## Quick start

**1 & 2 — install and point it at your two directories:**

```bash
npm install -g twin-sync

# --a = your code (plaintext),  --b = the encrypted git repo
twin-sync init --a . --b ../my-encrypted-repo --label-b vault
git -C ../my-encrypted-repo init                              # first time only
git -C ../my-encrypted-repo remote add origin <your-remote>   # first time only
```

**3 — store your key in Windows' keychain, ONCE (PowerShell).** This creates a
password-less encrypted store (DPAPI — no password file, no prompt) and tells
twin-sync how to read it. Copy-paste the whole block:

```powershell
Install-Module Microsoft.PowerShell.SecretManagement, Microsoft.PowerShell.SecretStore -Scope CurrentUser -Force
Register-SecretVault -Name SecretStore -ModuleName Microsoft.PowerShell.SecretStore -DefaultVault
Set-SecretStoreConfiguration -Authentication None -Interaction None -Confirm:$false
Set-Secret twin-sync 'your-passphrase'          # ← your vault key (change 'your-passphrase')
[Environment]::SetEnvironmentVariable('TWIN_SYNC_KEY_COMMAND','pwsh -NoProfile -Command "Get-Secret twin-sync -AsPlainText"','User')
```

Open a **new** terminal so the last line takes effect. To change the key later,
just re-run `Set-Secret twin-sync '...'`.

**4 — sync (no key needed on the command line ever again):**

```bash
twin-sync push --yes --push     # encrypt A → B, commit, and git push
twin-sync pull  --yes           # decrypt B → A
```

That's the whole thing. (`tsync` works as a shorter alias.)

---

*Everything below is reference — the four steps above are all you need day to day.*

## Setting the key

The key is **never** written to the config file. It's resolved in this order:

1. `--key <pass>` — a literal (handy for one-offs / CI).
2. `--key-command <cmd>` — run a command, use its stdout. ← **recommended**
3. `TWIN_SYNC_KEY_COMMAND` — same, as an environment variable.
4. `keyCommand` in `.twin-sync.json` — same, per-project (stores the *command*, not the secret).
5. `TWIN_SYNC_KEY` — a literal environment variable.

**Recommended: keep the secret in your OS keychain and fetch it on demand.** The
secret never lands in a dotfile, an env var, or a `ps` listing — only the
*retrieval command* is stored.

**Windows (PowerShell SecretStore)** — built in, no third-party account, encrypted
at rest with DPAPI. One-time setup (same block as quick-start step 3):

```powershell
Install-Module Microsoft.PowerShell.SecretManagement, Microsoft.PowerShell.SecretStore -Scope CurrentUser -Force
Register-SecretVault -Name SecretStore -ModuleName Microsoft.PowerShell.SecretStore -DefaultVault
Set-SecretStoreConfiguration -Authentication None -Interaction None -Confirm:$false   # no store password
Set-Secret twin-sync 'your-passphrase'                                                # store the key
[Environment]::SetEnvironmentVariable('TWIN_SYNC_KEY_COMMAND','pwsh -NoProfile -Command "Get-Secret twin-sync -AsPlainText"','User')
```

- `Set-Secret twin-sync '...'` puts the key in the store — re-run it to change the key.
- `-Authentication None` means it auto-unlocks for your Windows user (no prompt); the
  tradeoff is any process running as you can read it, but it's encrypted on disk and
  never exposed as plaintext env/args.

> **`pwsh is not recognized`?** twin-sync runs the key command via `cmd`, so the
> PowerShell it names has to be findable there. Pick the one you have:
> - **PowerShell 7 installed but not on PATH** — use its absolute, space-free path:
>   `C:\PROGRA~1\POWERS~1\7\pwsh.exe -NoProfile -Command "Get-Secret twin-sync -AsPlainText"`
>   (or add `C:\Program Files\PowerShell\7` to PATH).
> - **Only Windows PowerShell 5.1** (in `System32`, there's no `pwsh`) — use `powershell`,
>   which is always on PATH:
>   ```powershell
>   [Environment]::SetEnvironmentVariable('TWIN_SYNC_KEY_COMMAND','powershell -NoProfile -Command "Get-Secret twin-sync -AsPlainText"','User')
>   ```
>   5.1 keeps its modules separately, so install them from a **5.1** prompt if `Get-Secret`
>   is unknown there: `Install-Module Microsoft.PowerShell.SecretManagement, Microsoft.PowerShell.SecretStore -Scope CurrentUser -Force`
>
> Open a new terminal after changing the command.

**Any other command works too** — `--key-command` just uses a command's stdout, so
anything that prints your secret is valid (a trailing newline is trimmed; stdin/stderr
pass through so an interactive/biometric unlock still works). Prefer to keep it with
the project? Put the *command* in the config: `"keyCommand": "pwsh -NoProfile -Command \"Get-Secret twin-sync -AsPlainText\""`.

> ⚠️ This one key decrypts the entire vault and can't be rotated without
> re-encrypting. Back it up; if you lose it, the vault is unrecoverable.

## How the vault works

Roles are fixed by direction — **A = plaintext local tree**, **B = encrypted git repo**.

**Vault layout (B):**

```
crypt-meta.json    public KDF/cipher params (salt) — not secret
manifest.enc       encrypted map: path → { id, sha256, size }
store/<id>.enc     one sealed blob per file; the real path is inside it
.gitattributes     pins ciphertext as binary (never eol-munged)
```

- Each file is sealed with **AES-256-GCM**, key derived from your passphrase via
  **scrypt**. Filenames and structure never appear in B.
- The manifest holds each file's *plaintext* `sha256`, so a push detects changes
  by decrypting **only the manifest** — never the blobs. Only changed files are
  re-sealed, so `git push` of B transfers just the real diff (native incremental pull).
- Every blob embeds its own path, so the manifest is a rebuildable index, not a
  single point of failure.
- **Hidden:** names, paths, structure, contents. **Visible to the host:** the file
  count and each file's approximate size — the price of per-file incremental pull.
- Additive by default; add `--delete` to prune blobs for files removed from A.
  `.gitignore` is respected. A wrong key fails loudly (auth error), never writes garbage.

## Commands

| Command | Direction | Description |
| --- | --- | --- |
| `twin-sync init` | — | Write `.twin-sync.json` (paths only — never the key). |
| `twin-sync status` | — | Show what would change (add `--key` for the vault). |
| `twin-sync push` | A → B | Encrypt A → B (with `--key`) — or plaintext mirror without it. |
| `twin-sync pull` | B → A | Decrypt B → A (with `--key`) — or plaintext mirror without it. |

## Options

| Flag | Meaning |
| --- | --- |
| `--key <passphrase>` | **Encrypted-vault mode.** `push` encrypts A → B, `pull` decrypts B → A. |
| `--key-command <cmd>` | Run `<cmd>` and use its stdout as the key (e.g. a keychain read). See [Setting the key](#setting-the-key). |
| `--commit` | After an encrypted `push`, `git add -A && git commit` the vault repo B. |
| `--push` | After an encrypted `push`, commit **and** `git push` B (implies `--commit`). |
| `--message`, `-m <msg>` | Commit message for `--commit`/`--push` (default summarizes the change counts). |
| `--delete` | Also remove destination files that no longer exist in the source. Off by default. |
| `--dry-run`, `-n` | Preview without writing anything. |
| `--yes`, `-y` | Skip the confirmation prompt (required in non-interactive shells). |
| `--since <ref>` | Only consider files changed since `<ref>` in the source repo. |
| `--include <glob>` / `--exclude <glob>` | Restrict / skip matching paths (repeatable git pathspecs). |
| `--json` | Machine-readable output. |
| `--config <file>` | Use a specific `.twin-sync.json`. |
| `--no-color` | Disable colored output. |

## Also: plaintext repo sync (no `--key`)

Without a key, twin-sync simply mirrors changed files between two repos that share
a codebase (e.g. an OSS mirror and a private fork). It enumerates files with git
(`.gitignore` respected), compares content by `sha256`, and copies only what
actually differs — with a preview and confirmation.

```bash
twin-sync init --a ../frontend-oss --b ../frontend-internal --label-a oss --label-b internal
twin-sync status
twin-sync push --dry-run     # preview  oss → internal
twin-sync push               # apply
twin-sync pull               # internal → oss
```

## Configuration

Paths resolve in priority order: `--config <file>` › environment variables ›
`.twin-sync.json` (found by walking up from the cwd). The key is separate — see
[Setting the key](#setting-the-key).

```jsonc
// .twin-sync.json  (written by `init`)
{
  "a": "/abs/path/to/plaintext",
  "b": "/abs/path/to/encrypted-repo",
  "labels": { "a": "A", "b": "vault" },
  "exclude": ["*.env", "config/secrets.*"],  // always skipped
  "keyCommand": "pwsh -NoProfile -Command \"Get-Secret twin-sync -AsPlainText\""  // optional: where to fetch the key
}
```

```bash
# Or point at paths via env vars (handy in CI)
export TWIN_SYNC_A=/abs/path/to/plaintext
export TWIN_SYNC_B=/abs/path/to/encrypted-repo
```

## Programmatic API

```ts
import { loadConfig, encryptPush, decryptPull } from "twin-sync";

const cfg = loadConfig({});
await encryptPush(cfg.a, cfg.b, process.env.TWIN_SYNC_KEY!, {
  include: [], exclude: cfg.exclude, dryRun: false, prune: false,
});
await decryptPull(cfg.b, cfg.a, process.env.TWIN_SYNC_KEY!, { dryRun: false });
```

Plaintext mode is exposed too: `buildPlan(from, to, opts)` → `apply(plan, dryRun)`.

## License

MIT
