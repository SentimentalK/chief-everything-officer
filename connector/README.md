# CEO Connector (ceo-connector)

The Rust-based CEO Connector: a lightweight local daemon & CLI that bridges durable
CEO Server jobs to locally managed execution agents.

## Version

Current baseline: **2.4.0**. Check with:

```bash
ceo-connector --version
```

## Installation, Update & Uninstall

Deterministic binary packages are provided for five supported platforms:
- **Linux x86_64**: `ceo-connector-linux-x64.tar.gz`
- **Linux aarch64**: `ceo-connector-linux-arm64.tar.gz`
- **macOS x86_64 (Intel)**: `ceo-connector-macos-x64.zip`
- **macOS arm64 (Apple Silicon)**: `ceo-connector-macos-arm64.zip`
- **Windows x86_64**: `ceo-connector-windows-x64.zip`

### Prerequisites
- **Git**: Installed and available on PATH (for repository worktrees and state tracking).
- **Orca runtime / CLI**: For managing agent runs and session lifecycle.
- **Local execution Agent**: Configured agent executor (e.g. `opencode`, Claude Code, Codex, or custom agent).

### Manual Installation

#### Linux and macOS
1. Download the matching archive and `SHA256SUMS` from the GitHub Release (`connector-v2.4.0`).
2. Verify the archive against `SHA256SUMS`:
   ```bash
   sha256sum -c SHA256SUMS --ignore-missing
   # or on macOS:
   shasum -a 256 -c SHA256SUMS --ignore-missing
   ```
3. Extract the archive:
   ```bash
   # Linux x86_64:
   tar -xzf ceo-connector-linux-x64.tar.gz
   # or macOS Apple Silicon:
   unzip ceo-connector-macos-arm64.zip
   ```
4. Place `ceo-connector` in a directory on your `PATH` (such as `~/.local/bin`) and ensure executable permissions:
   ```bash
   mkdir -p ~/.local/bin
   cp ceo-connector-2.4.0/ceo-connector ~/.local/bin/ceo-connector
   chmod +x ~/.local/bin/ceo-connector
   ```
5. Verify the installation:
   ```bash
   ceo-connector --version
   ```

#### Windows (x86_64)
1. Download `ceo-connector-windows-x64.zip` and `SHA256SUMS`.
2. Verify SHA256 using built-in PowerShell:
   ```powershell
   Get-FileHash ceo-connector-windows-x64.zip -Algorithm SHA256
   ```
   Confirm the hash matches the entry in `SHA256SUMS`.
3. Extract the ZIP archive:
   ```powershell
   Expand-Archive -Path ceo-connector-windows-x64.zip -DestinationPath .
   ```
4. Place `ceo-connector-2.4.0\ceo-connector.exe` into a directory included on your `PATH` (for example, `%USERPROFILE%\bin`).
5. Verify the installation:
   ```cmd
   ceo-connector.exe --version
   ```

### Updating
1. Stop any currently running connector daemon:
   - If running in foreground, terminate with `Ctrl+C`.
   - If running as a background service, stop the service.
2. Replace the existing `ceo-connector` (or `ceo-connector.exe`) executable with the newly verified release binary.
3. Durable user state under `~/.ceo/connector` (credentials, target mappings, history) is preserved and compatible across minor versions.

### Uninstalling
1. Delete the `ceo-connector` (or `ceo-connector.exe`) executable from your PATH directory.
2. *(Optional)* If you wish to erase local device state completely, delete the `~/.ceo/connector` directory:
   ```bash
   rm -rf ~/.ceo/connector
   ```
   *Note: Removing local files never deletes Server-side workspaces, Targets, or job history.*


## Local Config Schema v3 & Authority Split (2.0.0)

`config.json` uses **schema version 3**. Local target state stores ONLY Device-owned
durable state, keyed by the Server-owned immutable `target_id`:

```json
{
  "schema_version": 3,
  "server_url": "https://ceo.sentimentalk.com",
  "targets": {
    "tgt_...": {
      "local_path": "/home/me/codes/project",
      "executor": {
        "kind": "orca_tui",
        "agent_id": "opencode",
        "command": "opencode",
        "model": null
      }
    }
  }
}
```

The `model` field is optional and omitted when unset (existing serde convention).

All Server-owned Target metadata — workspace membership, alias/name, kind, repository,
disabled state, device bindings, and the workspace default Agent Runtime relation —
lives exclusively in the Server catalogue. The Connector keeps exactly one authority
per concept:

- **Server catalogue**: alias/kind/repository/disabled/binding/default-runtime views
  (`target list`, exact alias selector, rename). A logged-in Connector that cannot
  obtain the Server catalogue fails clearly instead of fabricating Server-owned
  metadata from local state. Locally-mapped targets absent from the catalogue render
  honestly as `LOCAL_ONLY` with unknown alias/kind.
- **Local schema v3 config**: `local_path`, executor (`agent_id`/`command`), and the
  optional model override. Raw immutable target IDs keep working for local-only
  executor operations without a Server connection.

### One-time schema v2 -> v3 migration

Legacy schema v1/v2 config files are migrated automatically, deterministically, and
once on the first `ceo-connector` command run:

- `target_id` keys, `local_path`, executor `agent_id`/`command`/`model` are preserved
  exactly; legacy `workspace_id`/`alias`/`kind` are dropped from durable local state.
- The rewrite is atomic and crash-safe; a failure leaves the original valid file
  intact and fails with an actionable error. Device-owned fields that v3 still needs
  (path/executor/model) are validated before the rewrite — malformed entries fail
  closed instead of being silently dropped.
- Migration is concurrency-safe under the shared `state.lock`; a stale migrated
  snapshot can never overwrite a newer local mutation.
- No Server contact or Target mutation is involved in the migration.

## Target Selectors & Rename (1.3.0)

Target-affecting commands (`target bind`, `target set-agent`, `target set-model`,
`target set-default-runtime`, `target rename`) accept a **target selector**:

- the exact human alias (server-authoritative, case-sensitive; no fuzzy, partial,
  or case-insensitive matching), or
- the exact immutable target ID (`tgt_...`, kept for scripts/backward compatibility).

Aliases are resolved against the authenticated Server catalogue on every use; schema v3
local config stores no alias at all, so aliases can never resolve from local state. A
selector that is simultaneously one target's ID and another target's alias fails closed
rather than guessing.

### Rename a target's alias

```
ceo-connector target rename <current-selector> <new-alias>
```

The Server atomically updates the workspace-unique alias for the immutable target ID
(no delete/recreate): bindings, the default-runtime relation, and job history stay
attached. Renaming to the current alias is a safe no-op; the old alias is released
immediately. Add `--json` for machine-readable output.

## Local State Root

Since 1.0.0, all Connector-owned durable local state lives under a **single root**:

```
~/.ceo/connector/
```

Layout:

```
~/.ceo/connector/
  config.json          # local configuration (bound origin, execution targets)
  credential.json      # device credential (0600)
  enrollment.json      # pending enrollment session
  control.json         # pause/resume control state
  active-attempt.json  # currently active attempt pointer
  locks/
    daemon.lock        # single-daemon advisory lock
    state.lock         # control-file mutation lock
  history/             # delivered job attempt history
  outbox/              # pending result deliveries
  results/             # preserved managed results
  runtime/
    <attempt-id>/
      managed-result.json
  tmp/                 # scratch space
```

Notes:

- All directories and files are private (`0700`/`0600` on Linux).
- Diagnostics go to stdout/stderr only; the Connector never writes persistent log files.
- Execution Target repositories and Orca-owned worktrees/sessions remain external and
  are never stored under this root.

### Root override

For tests and isolated runs, set a single environment variable that **replaces the
entire root**:

```
CEO_CONNECTOR_ROOT=/path/to/isolated-root
```

If the user home directory cannot be determined, the Connector fails with an
actionable error instead of guessing.

### Clean break from pre-1.0 (no migration)

Pre-1.0 development builds stored state under the XDG split
(`~/.config/ceo/connector` and `~/.local/state/ceo/connector`). Version 1.0.0 does
**not** migrate, import, or read that state. If you ran a pre-1.0 development build,
remove the old directories manually, then run `ceo-connector login` and re-bind your
execution targets.
