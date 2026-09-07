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

## Doctor 缓存机制与环境指纹

为了消除每会话重复运行 Doctor 带来的耗时与模型消耗（每次约 30-40 秒及 10 万 tokens），CEO Worker 实现了**基于确定性环境指纹与零模型本地预检的 Doctor 缓存**：

1. **快速本地预检（零模型开销）**：
   - 在启动任何 Agent 进程或调用模型 API 之前，Worker 预先执行本地文件系统与配置检查：
     - 工作区可写性探测（通过写入探测文件验证）。
     - `<workspace>/AGENTS.md` 必选 `rule_marker` 元数据标记解析。
     - Agent 可执行文件权限验证（`libc::access(X_OK)`）。
     - 核心 JSON 配置完整性校验。
   - 任何检查未通过立即返回 `BLOCKED` 状态，绝不调用模型，实现零开销快速熔断。

2. **14 项确定性环境指纹（$F$）**：
   - 对以下 14 类环境组件生成标准化 SHA-256 复合指纹：
     1. CLI 设置文件（`~/.gemini/antigravity-cli/settings.json`）
     2. 全局规则（`~/.gemini/GEMINI.md`、`~/.gemini/config/AGENTS.md`、`~/.gemini/config/GEMINI.md`）
     3. 工作区规则（`<workspace>/AGENTS.md`、`<workspace>/GEMINI.md`）
     4. Guide 说明文件（配置列表及 `<workspace>/AGENT_GUIDE.md`）
     5. MCP 配置文件（`~/.gemini/config/mcp_config.json`、`<workspace>/.agents/mcp_config.json`）
     6. 技能定义（递归扫描 `<workspace>/.agents/skills/` 与全局 skills 下的所有 `*.md`）
     7. 插件与启用状态清单
     8. Hook 脚本配置与脚本实体
     9. 保守监视项（`~/.gemini/config/config.json`、项目配置、rules 目录 Markdown）
     10. 执行器路径、可执行文件 SHA256 与版本号
     11. 规范化工作区绝对路径
     12. Worker 逻辑指纹（Worker 二进制 SHA256 + Doctor Prompt 模板 SHA256）
     13. 系统身份（UID、GID、附加用户组、内核版本）
     14. 运行时环境变量（XDG 路径、TMP/TEMP、PATH、Proxy 变量，未设置项显式记录为 `UNSET`）
   - 严格排除动态 Nonce、时间戳与 Attempt ID，避免无效 miss。

3. **24 小时 TTL 与双轮到单轮无缝切换**：
   - 缓存持久化于 `<workspace>/.ceo/doctor/cache.json`。
   - 仅当 $F_{before} == F_{cached}$、上次 Doctor 通过、当前本地检查正常且 $0 \le \text{now} - \text{checked\_at} < 86,400\text{秒}$ 时复用结果。
   - **缓存命中**：完全跳过 Turn 1 Doctor 探针，直接在 Turn 1 提交业务任务，当前 Doctor 耗时记为 0ms，同时在回执中保留历史度量指标。
   - **缓存未命中/失效**：执行 Turn 1（Doctor 探针） $\to$ 验证前后一致性（$F_{before} == F_{after}$） $\to$ 持久化缓存 $\to$ 继续执行 Turn 2（任务 Prompt）。

4. **选择性缓存失效**：
   - 普通业务失败（如任务逻辑错误或产物未验证）保留 Doctor 缓存。
   - 授权工作区路径权限拒绝、沙箱配置异常或协议崩溃则立即失效缓存并强制重检。

## CLI 常用命令

- **运行 Preflight Doctor 检查**：
  ```bash
  ceo-worker doctor --workspace /path/to/workspace [--force]
  ```
- **运行无人值守任务**：
  ```bash
  ceo-worker run --workspace /path/to/workspace --prompt-file /path/to/prompt.md [--job-id <id>] [--force-doctor]
  ```
- **查看任务状态**：
  ```bash
  ceo-worker status --workspace /path/to/workspace --job-id <id>
  ```
- **查看实时日志与事件流**：
  ```bash
  ceo-worker logs --workspace /path/to/workspace --job-id <id> --follow
  ```
