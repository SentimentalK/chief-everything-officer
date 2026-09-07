# CEO Worker

[English](README.md) | [简体中文](README.zh-CN.md)

---

CEO Worker 是一个通用的 Linux 本机无人值守 Agent 任务启动器，用于在专用 Workspace 工作区中编排和驱动本地 Google Antigravity (`agy`) CLI 会话。

## 实测评估报告与真实验证

我们在 **2026-09-06** 对 `agy` 启动参数、权限放行机制、执行边界防御以及端到端真实任务执行进行了完整的实测评估：

👉 **[阅读完整实测报告 (2026-09-06)](docs/antigravity-cli-evaluation-2026-09-06.zh-CN.md)** | **[Read Full Report in English](docs/antigravity-cli-evaluation-2026-09-06.md)**

### 实测核心成果摘要：
- **`--dangerously-skip-permissions`**：确认为无人值守执行所必需。未传该参数时，Headless 模式因无法弹窗而直接将工具调用 auto-denied 报错退出（`jetski: no output produced — a tool required ... permission that headless mode cannot prompt for`）。
- **`--sandbox` 与深度防御**：Bubblewrap 命名空间隔离与硬编码系统保护规则（如禁止访问 `~/.gemini/antigravity-cli`）在跳过权限后依然严格生效。
- **越界明确拒绝**：当要求在工作区外写入敏感路径（`/home/sentimentalk/unauthorized_boundary_probe.txt`）时，Agent 明确拒绝执行，宿主系统零文件生成。
- **用户配置零污染**：实测全程确保用户 `~/.gemini/antigravity-cli/settings.json` 与 `~/.gemini/config/config.json` 的 SHA-256 哈希值保持 100% 不变。
- **真实 E2E 任务通过**：`ceo-worker doctor` 5 项检查全绿；`ceo-worker run` 驱动 Agent 自主完成双轮交互，成功生成 `task_output.txt`（内容为 `CEO_E2E_TASK_SUCCESSFUL`）并完成回执归档。

---

## 执行模型与无人值守启动参数

默认情况下，Worker 以 Headless 流式模式启动 `agy`，装配以下参数：

```bash
agy --input-format stream-json \
    --output-format stream-json \
    --mode accept-edits \
    --dangerously-skip-permissions \
    --sandbox \
    --log-file <workspace>/.ceo/jobs/<job-id>/attempts/<attempt-id>/agy.log \
    --model gemini-3.8-flash-medium
```

### 实测验证的参数语义

1. **`--dangerously-skip-permissions`**：自动放行工具调用权限检查，避免 Headless 模式自动拒绝。
2. **`--mode accept-edits`**：直接应用模型生成的文件修改，免除交互式编辑确认轮次。
3. **`--sandbox`**：强制执行 Bubblewrap 容器化文件系统挂载与 Linux 命名空间隔离。
4. **`--model gemini-3.8-flash-medium`**：固定默认模型标识，保证执行稳定性与消耗可预测性。可通过环境变量 `CEO_AGENT_MODEL` 覆盖。

## 配置发现机制与限制说明

- **路径硬编码**：官方 `agy` 仅从 `~/.gemini/antigravity-cli/settings.json` 与 `~/.gemini/config/config.json` 读取配置。
- **无独立 Profile 参数**：`agy` 缺少 `--config` 或 `--profile` 命令行参数，且不识别 `<workspace>/.gemini/antigravity-cli/settings.json`。
- **全局指令注入**：若用户配置了全局规范（如 `~/.gemini/config/AGENTS.md` 中的 Always Plan Mode），`agy` 会将其注入到每个会话的系统 Prompt 中。为了让无人值守任务顺利执行而不停在规划审批阶段，Prompt 应包含明确的执行上下文标识（例如 `[Step 3 - Fully Autonomous Execution]`）。

## 安全边界与剩余风险披露

- **沙箱范围**：`--sandbox` 激活 Bubblewrap 挂载隔离，阻止向未授权挂载点写入，并保障系统目录边界。
- **剩余风险说明**：
  - Agent 进程以宿主当前用户的 UID 运行。
  - 通过 Doctor 检查与边界探针并不等同于虚拟机级别的完全隔离。
  - 本地沙箱配置中显式允许写入的目录（如 `/tmp` 或配置的用户目录）依然可被访问。
  - 用户在部署本机无人值守 Agent 时需知晓并接受相应的本地执行风险。

## CLI 常用命令

- **运行 Preflight Doctor 检查**：
  ```bash
  ceo-worker doctor --workspace /path/to/workspace
  ```
- **运行无人值守任务**：
  ```bash
  ceo-worker run --workspace /path/to/workspace --prompt-file /path/to/prompt.md [--job-id <id>]
  ```
- **查看任务状态**：
  ```bash
  ceo-worker status --workspace /path/to/workspace --job-id <id>
  ```
- **查看实时日志与事件流**：
  ```bash
  ceo-worker logs --workspace /path/to/workspace --job-id <id> --follow
  ```
