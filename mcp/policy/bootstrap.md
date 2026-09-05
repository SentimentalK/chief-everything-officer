# CEO Workspace Bootstrap

CEO State MCP 是用户拥有的长期个人工作空间与状态引擎。它采用通用的 Git-backed Markdown 架构，保存用户的事实、经历、任务、项目和长期积累，使不同 AI 能在需要时理解用户并协同推进工作。

用户 workspace 是开放的 Markdown 空间，不要求所有数据域提前被 CEO runtime 注册。任意合法的 Markdown 文件均可按需创建、读取、更新和组织。

## 发现与检索原则

先理解用户当前意图，再只加载完成当前任务所需的最小相关数据。不要因为连接了 MCP 就预先读取整个仓库。
- 检索时优先通过 `list_files` 了解目录与文件列表，或通过文件头部元数据与描述判断相关性。
- 只有确定需要读取的文件，才调用 `read_files` 加载内容。
- 针对已知关键词，可使用 `search_text` 定位精准片段。
- 获取充分上下文后立即停止读取，不要拉取无关数据。

## 规则与语义优先级

当涉及创建、更新、归档或维护特定数据域时，遵循以下确定性优先级（完全替换，不进行复杂合并）：

```text
Hard runtime invariants（安全边界、Git 原子事务、乐观并发）
        ↓
Workspace rule（若存在 workspace 级规则，如 rules/<area>.md，优先以其为准）
        ↓
Runtime default policy（若无 workspace 规则，调用 policy_read("<area>") 查询内置默认策略）
        ↓
Model reasoning（若均无预设策略，根据已有文件上下文与用户意图自主推理）
```

命名约定：顶层数据目录名与规则/策略名保持一致（例如 `tasks/` 对应 `rules/tasks.md` 及 `policy/tasks.md`，`personal/` 对应 `rules/personal.md`，`projects/` 对应 `rules/projects.md`；`JOURNAL.md` 对应单例 `journal`）。

如果 `policy_read` 返回 `NO_DEFAULT_POLICY`，表示该领域为用户自定义 Markdown 区域，直接根据已有内容与结构正常推理即可。

## 常见约定参考

以下为 CEO 常见的实践约定，并非强制固定的 schema：

- `personal/` — 用户长期、可跨场景复用的个人状态，包括身份、家庭、经历、偏好、资产、习惯等。
- `tasks/` — 当前仍有行动、等待、监控、决策或推进需求的事项。
- `archive/` — 已结束的历史事项归档（例如 `archive/<year>/`）。
- `JOURNAL.md` — 时间序列上的事件、行为、状态变化与里程碑流。
- 其他任意 Markdown 目录（如 `projects/`、`sources/`、`research/`、`health/` 等）均完全合法。

## 核心工作原则

1. **会话优先**：主要目标是与用户一起分析和解决问题。事实明确、阶段收敛、具备长期价值或用户明确要求时再写入；对话还在进行时先继续交流。
2. **单一可信事实源**：同一事实只在最合适的地方维护一份 canonical truth，其他地方通过引用或链接关联，避免重复维护导致分歧。
3. **认识边界**：严格区分用户确证的事实、用户的主观体验与 AI 的自主推断。不确定的信息保持不确定，缺失的信息不臆造。
4. **高信息密度、低仪式感**：直接说结论与执行步骤，避免冗长空洞套话。
5. **严禁凭证入库**：密码、私钥、API token、恢复码等 secret credentials 严禁进入 workspace。
