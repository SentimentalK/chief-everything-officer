# Resource Rule

`resources/` 保存用户主动带入的外部材料，以及围绕材料形成的理解和互动。临时阅读不要求存档；用户要求保存，或当前任务明确需要长期复用时才写入。

## 保存与更新

新资料用 `resource_capture`，已有资料用 `resource_apply`。不通过 `apply_change_set` 修改 `resources/**`，不手工复制资源目录或先搜索查重。相同来源由后端复用 Resource 身份。

保存引用、取得 metadata、取得正文、保存原文件是不同结果。只报告实际完成的部分；获取失败不等于保存失败，刷新失败不代表已有信息丢失。没有原始 bytes/ref 也可以保存已有引用和可靠理解，不声称原文件已经落盘。

用户要求重试或当前任务确需缺失信息时，可以重新 capture 同一 URL；普通读取不自动刷新。重试不随手改 note/topics，不删除重建。网络重传同一操作复用 request_id，有意发起新一次获取使用新请求。故障和登录问题记在获取状态中，不放进正文；未取得可查询的完成回执时，不承诺任务已完成或会主动通知。

## 文件分工

- `meta.md`：稳定身份、来源信息、display name、topics、capture note/history。
- `content.md`：提取或整理后的来源正文，保留原意和细节，支持分段读取。
- `summary.md`：面向 AI 的简短概览与正文索引。
- `interactions.md`：用户围绕材料的联想、问题、观点、讨论结果和未决事项。
- `source/*`：可选原始附件，仅在实际传输并保存成功时存在。

文件按需存在，不创建空占位。新正文统一进入 content，不要求另存 evidence；已有 evidence 可以读取，不自动删除或迁移。

兼容旧 Resource 时，`evidence.md` 仍表示平台原始 / 近原始字幕、ASR、OCR 或精确网页正文。其 provenance 只能来自实际精确来源链路（如 `host_exact`、`trusted_adapter`、`worker`）；不要把 AI 整理或语义改写标成 evidence，也不要用 `host_semantic` 冒充精确来源。除非当前工具 / workflow 明确需要 evidence，新获取的可读来源正文默认进入 `content.md`。

## Content：正文与章节

可以合并字幕碎片、去掉字幕序号和重复的逐句时间码、补标点、按主题分段。清洗不是摘要：保留论证、例子、数字、限定条件、否定和异议，不只保留用户当前关注的部分。识别不清处标明不确定，不根据模型知识补写。

整理后的正文采用下列结构。二级标题以唯一章节 ID 开头，作为读取边界；段内标题使用三级或更深层级。

```markdown
# 材料标题

## S001 · 主题标题
时间：00:00–04:52

该主题的完整正文。

## S002 · 另一个主题标题
时间：04:52–09:10

该主题的完整正文。
```

时间仅在有可靠时间信息的音视频中保留，供回看使用；其他材料省略。时间只存于 content，summary 不重复。按主题切分，不要求固定段长或时长。

修改文字、标题或排版时保留章节 ID；新增章节用未占用 ID，不将旧 ID 改指其他内容。正文实质变化或章节拆分、合并时，同步更新受影响的 summary 索引。

未整理的提取文字可以先保存，不伪称已有结构。讨论不以重写全文并落盘为前提；先回答当前问题，确需整理且属于已授权工作时再更新。

## Summary：概览与索引

先用一句或一小段概括材料，再用普通列表列出章节 ID、主题和覆盖要点。索引覆盖材料的各个主题，不只列用户已关注的部分；不用表格、不重复时间、不手工维护行号，不复制大段正文。

```markdown
---
provenance: host_semantic
basis: source_content
---

一句话概括材料内容。

- S001 — 主题标题：本段讲什么，能查到什么。
- S002 — 另一个主题标题：主要问题、条件或限制。
```

ID 对应实际 content 标题。概览和章节标题是整理结果，不是作者原话；索引帮助定位，不能替代细节核验。

frontmatter 的 provenance 和 basis 必填：
- `source_content`：确实读取过来源内容。正文已存时引用实际章节；无法保存正文时可保留有依据的概览，但不伪造可读取的章节。
- `metadata`：仅依据标题、简介。确有需要时可写材料简介，不能编造正文结构或声称读过内容。

只有链接和收藏意图时，不默认生成 summary。用户的兴趣、联想或用途判断属于 interactions，不能代替来源概览。

## Interactions：用户与材料的关系

Interactions 保存用户如何理解材料、将它与自身需求建立何种联系，以及这种理解如何发展。用户表达的兴趣、用途设想、潜在关联或初步判断本身就有记录价值，不以读完材料、判断正确或形成成熟结论为前提。

在已授权保存的范围内，记录真实发生的用户表达、AI 回应和未决事项，保留时间、归属与不确定性；不要求每项齐全，不保存整段聊天转储。

区分作者主张、用户观点、AI 建议和待验证假设。没有用户表达时，不从自动生成的 content/summary 推断其认同；过去的讨论不自动代表当前偏好。

capture note/history 继续记录保存背景，不能替代需要长期检索的用户想法。不为讨论另建平行 notes 目录或 ID 映射。后续变化追加说明，不把新的认识伪装成原来已经得出的结论。

## 来源与阶段

标题、作者、发布时间、canonical/source reference、平台与平台 ID、文件 hash、source identity 等来源事实必须来自实际来源、受信任适配器 / 解析器或文件提取，不凭模型知识猜测。AI 可提炼语义名称、topics、概览、章节标题和讨论记录，但不能将理解或改写冒充来源事实或原始文本。metadata 获取失败不会阻止已经成功的 capture；缺失字段保持缺失，只报告实际取得的结果。

服务端可以对 URL capture 做确定性的 metadata enrichment；模型不要把解析器结果手工重建成另一套来源事实。metadata enrichment 的成功、失败、重试状态属于获取 / 诊断信息，不等于 Resource 生命周期阶段。

provenance 如实反映获取或整理方式，不是正确性的保证。遵循当前工具允许的取值；不把 AI 整理稿伪标为 host_exact、trusted_adapter 或 worker 来绕过写入限制。能力不支持时报告限制。

阶段由后端推导，不由 AI 为了表示“处理完成”手工设置。纯收藏或 rename 不提升内容阶段；metadata 简介不触发 READY_FOR_DISCUSSION；source_content 摘要不要求原文件存在。DISCUSSED 表示已有互动，不证明取得或读完全部正文。

## 身份与命名

`resource_id` 是稳定逻辑身份，不随 metadata、标题或目录变化。更新与查找使用 Resource ID，不从 display_name 自行拼路径。

`source_identity`、`source_aliases`、`last_metadata_attempt` 等来源归一化、别名去重与 metadata 诊断字段由后端维护。不要根据模型猜测手工生成或改写它们；alias 用于识别同一来源，metadata attempt 只表示最近一次 enrichment 尝试，不代表 Resource 内容阶段。

原始 `title` 保留来源写法；`display_name` 是语义名称，目录由后端处理。首次 capture 以稳定 ID 占位，naming_source=id 不代表 metadata 失败。来源信息刷新不自动改名，也不把已有语义名称改回 ID。

AI 命名默认沿用用户语言，使用简短自然标题，去掉标题党和无意义前缀；不机械拼接 topics，不额外附加文件扩展名，保留 DESIGN.md 等专有名词。收藏目的写入 capture note，用户联想按 interactions 规则保存。

capture 后或用户要求继续命名时，已有 metadata/上下文足够则调用 rename；不足且有可用 URL 时至多刷新一次，仍不足保留 ID 并说明。不仅为命名获取字幕、下载正文或生成摘要。已 explicit 的资源不因普通读取或刷新再次改名；只有回执确认后才报告改名成功。

## 渐进式读取

已知 ID 直接 resource_get；需要发现资料才 resource_search。问用户以前怎么想，先读 interactions；了解材料讲什么，先读 summary。

有有效索引时，用 `resource_get(view="content", section_ids=["S002"])` 读取相关章节。没有章节或段落过长时用 start_line/line_count；返回 truncated 时，沿用相同视图与章节选择，按 next_start_line 继续。章节筛选后的分页行号不当作原文件行号。

缺失或失效索引不能作为内容证据，按需定位正文。核对论证、引用、条件或未覆盖问题时读取相关段落；需要整体比较或用户要求时可以读全文，不因局部问题默认加载全部。

默认 search_text 在 Resource 中只包含 interactions；发现资料用 resource_search，定向搜索来源文字时显式指定范围。

## 与个人状态的关系

每次保存或更新 Resource 时，判断讨论是否已经形成跨材料复用的个人状态、用户自己的真实 Well-being observation、明确行动、值得保留的个人 episode，或经过实际权衡且未来值得作为 precedent 的具体选择。若已形成，在本次记录中读取目标领域规则及已有记录，分别更新 Personal、Well-being、Task、Journal 或 Decision，不等材料读完或讨论结束才处理。

Resource 讨论不会仅因为“聊过”就自动修改 State。只有确实形成对应语义时才提升；尤其不能从文章、视频、报告作者的描述推断用户本人存在某种 Well-being 状态。只有用户实际报告、可靠个人测量/文档明确属于该用户，且语义确实需要进入纵向记录时，才更新 Well-being。工具支持 `state_changes` 时，优先与本次 Resource capture / update 在同一原子事务中提交，避免 Resource 已更新但对应 State consequence 丢失。

围绕当前材料的联想和用途假设留在 interactions；不能仅因用户觉得可能有用就创建任务、形成 Decision 或归纳长期偏好。已确认成为用户状态的结果由对应文件维护，interactions 保留形成过程和具体引用，不复制维护同一结论。需要既有个人背景帮助理解材料时，读取实际被引用文件；不把出处观点当作用户事实。

不是每次讨论都需要提炼到其他目录，普通来源摘要也不自动成为 Knowledge。规则只保留数据语义和 AI 行为；实现、部署、测试、迁移和待修问题维护在项目任务与代码仓库。


## Capture 后的强制命名后续

`resource_capture` 返回后必须检查回执中的 `naming_source` 与可靠来源 metadata。若 `naming_source = "id"`，且回执或 Resource metadata 已取得非空的可靠 `title` 或 `original_name`，则本次 workflow **必须继续调用 `resource_apply` 的 `op: "rename"`**，不能在 capture 成功后直接结束。rename 只更新语义化 `display_name` 与目录名，不改写来源 `title`；名称应遵守上文的命名规范。

若没有可靠 `title` / `original_name`，但用户上下文已经足以给出安全、明确的语义名称，也应继续 rename。只有在 metadata 与用户上下文都不足以安全命名时，才允许保留 `naming_source = "id"`。已为 `naming_source = "explicit"` 的资源不适用本条，不因普通 refresh / revisit 自动再次改名。

## 删除与销毁

Resource 的生命周期销毁必须通过官方的 `resource_delete` 工具执行。

- **显式意图要求**：只有在用户明确提出删除、销毁或清理特定资源时，才能调用 `resource_delete`；不得因整理、重命名或更新而擅自删除 Resource。
- **原子彻底删除**：`resource_delete` 一次性永久删除目标 Resource 的整个目录及其所有 owned artifacts（包括 metadata、content、summary、evidence、interactions 及 source assets 等）。
- **无应用层墓碑（Tombstone）**：当前工作空间 HEAD 中直接删除，不保留墓碑标记文件；历史变更由底层 Git commit 自然追踪。删除后若用户再次 capture 相同来源，将作为全新 Resource 分配新 ID。
- **禁止绕过 Resource Plane**：严禁尝试使用 `apply_change_set`、GitHub 直接操作或文件系统删除手段操作 `resources/**`。

