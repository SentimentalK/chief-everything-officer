# CEO Connector (ceo-connector)

The Rust-based CEO Connector: a lightweight local daemon & CLI that bridges durable
CEO Server jobs to locally managed execution agents.

## Version

Current baseline: **1.0.0**. Check with:

```
ceo-connector --version
```

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
