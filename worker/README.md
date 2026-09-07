# CEO Worker

[English](README.md) | [简体中文](README.zh-CN.md)

---

CEO Worker is a generic, unattended agent task runner for Linux designed to orchestrate local Google Antigravity (`agy`) CLI sessions within dedicated workspaces.

## Empirical Test Report & Live Verification

A comprehensive empirical evaluation of `agy` flags, approval mechanics, boundary defense, and live E2E task execution was conducted on **2026-09-06**:

👉 **[Read the Full Empirical Evaluation Report (2026-09-06)](docs/antigravity-cli-evaluation-2026-09-06.md)** | **[阅读中文实测报告](docs/antigravity-cli-evaluation-2026-09-06.zh-CN.md)**

### Key Highlights from Live Testing:
- **`--dangerously-skip-permissions`**: Confirmed mandatory for unattended headless execution. Without this flag, tool calls requiring confirmation are auto-denied by the engine (`jetski: no output produced — a tool required ... permission that headless mode cannot prompt for`).
- **`--sandbox` & Defense in Depth**: Bubblewrap namespace isolation and hardcoded protection rules (e.g. blocking access to `~/.gemini/antigravity-cli`) remain strictly active.
- **Boundary Refusal**: When prompted to write outside the workspace (`/home/sentimentalk/unauthorized_boundary_probe.txt`), the agent explicitly refused and zero host files were created.
- **Zero Configuration Overwrite**: Test runs verified 100% SHA-256 immutability of `~/.gemini/antigravity-cli/settings.json` and `~/.gemini/config/config.json`.
- **E2E Task Success**: `ceo-worker doctor` passed 5/5 checks; `ceo-worker run` autonomously executed a live task to completion, writing `task_output.txt` (`CEO_E2E_TASK_SUCCESSFUL`).

---

## Execution Model & Unattended Execution Flags

By default, the worker spawns `agy` in headless streaming mode with the following parameters:

```bash
agy --input-format stream-json \
    --output-format stream-json \
    --mode accept-edits \
    --dangerously-skip-permissions \
    --sandbox \
    --log-file <workspace>/.ceo/jobs/<job-id>/attempts/<attempt-id>/agy.log \
    --model gemini-3.8-flash-medium
```

### Verified Parameter Semantics

1. **`--dangerously-skip-permissions`**: Auto-approves tool permission checks, preventing headless auto-denials.
2. **`--mode accept-edits`**: Directly applies code/file modifications without requiring an interactive approval turn.
3. **`--sandbox`**: Enforces containerized filesystem mounts and namespace restrictions.
4. **`--model gemini-3.8-flash-medium`**: Fixed default model identifier for consistent execution and token predictability. Overridable via `CEO_AGENT_MODEL`.

## Configuration Discovery & Limitations

- **Hardcoded Config Paths**: `agy` loads configuration exclusively from `~/.gemini/antigravity-cli/settings.json` and `~/.gemini/config/config.json`.
- **No Independent Profile Flag**: `agy` lacks `--config` or `--profile` CLI options, and does not discover `<workspace>/.gemini/antigravity-cli/settings.json`.
- **Global Instruction Injection**: If the user has configured global guidelines in `~/.gemini/config/AGENTS.md` (e.g. Always Plan Mode), `agy` injects these instructions into every session prompt. For unattended task execution to proceed without stalling for interactive plan review, prompts should include execution framing (e.g. `[Step 3 - Fully Autonomous Execution]`).

## Security Boundary & Residual Risk Disclosure

- **Sandbox Scope**: `--sandbox` activates Linux namespaces and Bubblewrap mounts. It prevents modifications outside authorized mounts and enforces system boundaries.
- **Residual Risks**:
  - The agent process runs under the host user's UID.
  - Passing doctor probes and boundary tests does **not** guarantee total operating system isolation or virtual machine security.
  - Directories permitted by the sandbox configuration (e.g., `/tmp` or configured user directories) remain accessible to the agent.
  - Users accept remaining local execution risks when deploying unattended agent runs.

## CLI Commands

- **Preflight Doctor Check**:
  ```bash
  ceo-worker doctor --workspace /path/to/workspace
  ```
- **Run Unattended Task**:
  ```bash
  ceo-worker run --workspace /path/to/workspace --prompt-file /path/to/prompt.md [--job-id <id>]
  ```
- **Inspect Job Status**:
  ```bash
  ceo-worker status --workspace /path/to/workspace --job-id <id>
  ```
- **Stream Logs & Events**:
  ```bash
  ceo-worker logs --workspace /path/to/workspace --job-id <id> --follow
  ```
