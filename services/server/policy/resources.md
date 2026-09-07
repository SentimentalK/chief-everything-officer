# CEO 资源策略 (Resource Policy)

Resource 平面负责管理外部材料（URL、文章、视频、PDF、办公文档、数据集）的持久化、结构化理解。它与 State（Personal、Tasks、Journal）共享同一个属于用户的 Git 工作空间，存放在 `resources/` 目录下，但默认与 State 的常规检索相互隔离。

---

## 1. 核心原则

1. **Markdown 理解是 V0 的核心**：
   - Resource 的主要价值在于结构化的 Markdown 记忆：`meta.md`、`evidence.md`、`content.md`、`summary.md` 和 `interactions.md`。
   - 原始文档文件存储（`resources/<dir>/source/original.<ext>`）是可选的、依赖具体能力的功能增强。
   - 即使无法存储原始素材的二进制数据，Resource 依然完全有效且具备核心价值。

2. **保存意图 vs 临时阅读**：
   - 如果用户要求“读一下这个”、“解释一下”或“这是什么意思”，在对话中进行临时推理即可，无需持久化。
   - 如果用户明确要求保存（“记一下”、“存下来”、“放进 CEO”、“以后记得这个”），使用 `resource_capture` 将其捕获进持久化的 Resource 记忆中。

3. **确定性权威边界**：
   - **来源事实**（`canonical_ref`、`platform`、`platform_id`、`source_hash`、`title`、`author`、`published_at`）必须来自确定性的适配器、解析器或文件提取。
   - AI 严禁猜测、推断或使用模型自身知识臆造规范的来源元数据。
   - 当元数据获取失败时，保存仍会成功，对应字段记录为 `null`；系统如实汇报失败。
   - AI 仅负责提供用户语义字段：`display_name`、`Capture Note`、`topics`、摘要、章节映射和互动讨论笔记。

4. **服务端确定性元数据丰富**：
   - URL 捕获时可在服务端自动进行受信任的确定性元数据丰富。
   - 模型不应手动将解析器的输出机械搬运到 Resource 元数据中。
   - 解析器失败不会阻塞持久化的 Resource 捕获。
   - 元数据丰富状态属于运维信息，严禁持久化为 Resource 的生命周期阶段。

---

## 2. 产物与来源溯源 (Artifacts & Provenance)

- **`resource_id`**：存储在 `meta.md` 中的不可变逻辑标识（`res-<uuid-v4>`）。
- **物理目录与命名**：新资源始终在其稳定的 ID 目录（`resources/res-<uuid>/`）下捕获，临时占位符为 `display_name = resource_id` 且 `naming_source = "id"`。AI 随后检查元数据/内容，并通过带 `op: "rename"` 的 `resource_apply` 执行语义化命名，将目录重命名为整洁、便于检索的存储标识。
  - 命名规范：默认沿用用户语言，使用简短自然的语义化标题；不为模拟物理文件额外拼接扩展名（允许专有名词自身包含扩展名，如 `DESIGN.md`、`RFC-7231.pdf`），不机械拼接 topics，收藏动机记入 capture note。
  - 新资源仅收藏、命名时保持 CAPTURED；已有资源 rename 不改变阶段。

```text
resources/<directory_label>/
  meta.md         -> CAPTURED (初始收藏 / 纯命名保持)
  evidence.md     -> EXTRACTED
  content.md      -> NORMALIZED
  summary.md      -> READY_FOR_DISCUSSION (仅当 basis 为 source_content 时)
  interactions.md -> DISCUSSED (存在实际讨论记录时)
```

- **`meta.md`**：不可变身份标识（`resource_id: res-<uuid>`）、语义化 `display_name`、`naming_source`（`explicit` | `id`）、`source_aliases`、受限的 `last_metadata_attempt`、规范化 `source_identity`、来源事实、收藏笔记、主题标签、捕获历史。显式目录重命名使用 `op: "rename"`。
- **`naming_source`**：追踪展示名称的来源溯源（`explicit` | `id`）。初始捕获使用 `"id"`；由 AI 或用户进行的语义重命名使用 `"explicit"`。
- **`last_metadata_attempt`**：记录外部元数据抓取尝试的有界诊断凭证（`attempted_at`、`status`、`code`、`fields_resolved`）。过期的尝试将被跳过。
- **`source_aliases`**：对称的 URL/平台别名，确保双向去重。
- **`evidence.md`**：平台原始/近原始字幕、ASR、OCR 或精确网页正文。来源溯源必须是 `host_exact`、`trusted_adapter` 或 `worker`。**严禁使用 `host_semantic` 作为 evidence**。
- **`content.md`**：无损、规范化的可读内容，使用稳定的章节 ID（`S001`、`S002` 等）组织结构。
- **`summary.md`**：高层概览、目录/章节映射、章节摘要、核心论点、注意事项及主题标签。必须包含严格的 YAML frontmatter，声明 `provenance` 和 `basis`：
  - `basis: metadata`：只依据标题、简介等元数据，不提升阶段至 `READY_FOR_DISCUSSION`。
  - `basis: source_content`：确实读取了来源内容（不要求保存原文件），可达成 `READY_FOR_DISCUSSION`。
- **`interactions.md`**：用户提问、讨论片段、结论、开放问题以及向 State 提升的结果的 append-only 日志。存在有效讨论记录时阶段为 `DISCUSSED`（若存在 summary.md 仍优先校验其合法性）。

---

## 3. 讨论与向 State 提升

- 对 Resource 的讨论不会自动修改用户的偏好、任务或个人事实。
- 当讨论产生了真实的用户行动、决定或具有时间线意义的洞察时：
  - 模型可以在同一原子事务中包含合理的 `state_changes`（目标指向 `personal/`、`tasks/` 或 `JOURNAL.md`），与 Resource 的更新一同提交。

---

## 4. 渐进式检索

- 发现已保存素材：使用 `resource_search`（扫描轻量元数据卡片，绝不全量输出正文）。
- 读取具体细节：使用 `resource_get`，指定具体的 `view` 并传入有界的 `start_line` / `line_count` 或 `section_ids`。

---

## 5. 命名恢复规则 (Naming Recovery)

- **`naming_source = "id"` 是合法状态**：表示捕获时信息不足或语义命名步骤尚未完成，不是元数据失败；CAPTURED 阶段只表示“已收藏”，不代表需要抓取来源内容。不要因为目录仍为 `res-<uuid>` 就反复刷新元数据或下载内容。
- **用户要求“完成保存 / 继续命名 / 处理未命名资源”时**：
  1. 若已有可靠元数据（`title`、`original_name` 等）或用户上下文足以确定名称，直接调用 `resource_apply` 的 `op: "rename"` 完成语义命名。
  2. 若信息不足且存在可用的来源 URL，可至多重跑一次 `resource_capture` 尝试补齐元数据。
  3. 仍然不足时，保留 ID 目录并向用户说明原因；禁止无意义的循环重试。
- **不得仅为完成命名而触发重型动作**：不下载视频、不抓取转录、不生成摘要。同一任务中用户明确要求这些动作（如提取字幕）时不受此限。普通浏览与检索永远不触发自动写入。
- **已显式命名的资源（`naming_source = "explicit"`）**：后续每次捕获刷新/重访都不得自动再次改名。
- **恢复元数据时不随手生成新的 note 或 topics**；调用方显式更新这些字段的既有能力保持不变。
