# Task Rule

`tasks/` 保存仍值得追踪的当前事项。Task 是当前工作的状态、检索与路由索引。

Task 优先回答五件事：**Owner、Scope、Status、Priority、Size**。结构化字段只保存低基数、稳定、值得检索的信息；复杂背景、风险、计划与理由用自然语言。不要为了“完整”增加字段。

## 1. Core schema

```markdown
# [ID] — [标题]

- 状态: BACKLOG | ACTIVE | WAITING | BLOCKED | DONE | DROPPED
- 优先级: P0 | P1 | P2 | P3
- 规模: S | M | L | XL
- 类型: ACTION | DECISION | DISCOVERY | MONITORING | EPIC
- 父任务: [ID] — [标题]
- 子任务:
  - [ID] — [标题]：一句话 scope
- 目标结果: ...
- 下一动作 / 触发器: ...
- 依赖: ...
- 关联: ...
- 最后更新: ...
```

除稳定 ID 与 Status 外，Priority 和 Size 在能合理判断时尽量填写；无法判断时保持缺失。Type 和关系字段按实际需要使用。

三个核心索引维度彼此独立：

- **Status = lifecycle index**：这件事现在是什么状态、是否仍需追踪。
- **Priority = attention index**：没有其他上下文时，它默认多值得被优先想起 / 提出。
- **Size = effort index**：现在执行时 active work 大概多大，用于机会匹配和拆分。

**Priority 不是执行顺序，Size 不是工时承诺，Status 不表达重要程度。** P3 可以今天做；P0 可以 WAITING；XL 可以是低优先级长期项目；S 也可以是关键修复。选择“现在做什么”时，综合 Priority、Size、依赖、时间、精力、兴趣、风险和机会窗口。

## 2. Status

Status = lifecycle index，表示 Task 当前所处的生命周期阶段，以及它是否仍属于 current working set。只使用以下状态：

- **BACKLOG**：Task 有效且值得继续追踪，当前没有主动执行承诺。适用于 future work、低优先级事项、条件触发事项和暂未排期事项。
- **ACTIVE**：Task 当前正在主动推进，近期存在真实执行、设计、决策或验证工作。
- **WAITING**：下一步依赖时间、外部回复、结果、资格、窗口或其他外部事件；当前没有合理主动动作。
- **BLOCKED**：Task 当前存在需要解决的具体 blocker，解除后可继续推进。
- **DONE**：Task 定义的目标已经达到，并有足够证据支持当前 scope 完成。
- **DROPPED**：该独立 Task 的生命周期结束。典型原因包括取消、scope 失效、原架构或假设被替代，或 ownership 已正式转移。

DROPPED 结束的是 Task lifecycle。仍有长期价值的 option、preference、constraint、hypothesis 或 future trigger 应转交对应长期 owner。

日期、执行顺序、计划阶段和 ownership transfer 使用对应字段或正文表达。

## 3. Priority

Priority = attention / retrieval index，不是“先做完 P0 才能做 P1/P2/P3”的队列。表示 Task 在缺少其他上下文时的默认注意力权重，主要用于检索、筛选和 routing。

- **P0 — Critical / must surface**：当前关键路径、硬期限、明显 blocker 或高损失事项。用户问“现在最需要注意什么”时应优先浮现；数量应很少。
- **P1 — Important / near-term**：重要且近期值得持续关注；没有更强约束时通常值得主动推进或检查。
- **P2 — Normal backlog**：真实且值得做，但没有进入近期注意力窗口；通常按上下文、相关项目或 review 被召回。
- **P3 — Opportunistic / someday / conditional**：值得记住但默认低注意力；适合在用户主动询问、出现空闲窗口、兴趣、机会条件或 trigger 时浮现。

Priority 可随现实变化升降，但不要因 Ticket 年龄、文件长度或长期未执行而自动调整。

Priority 决定默认召回权重。实际执行选择由 Priority、Size、依赖和当前上下文共同决定，因此 P3/S 或 P3/M 完全可能成为当前最合适的行动。

## 4. Size

Size = active-effort index，表示完成当前 Task scope 所需的粗粒度 active effort，用于时间窗口匹配、候选筛选和 scope decomposition。

- **S**：约 1 小时以内；一个短 session 能处理掉。
- **M**：约 1–4 小时；通常是一个上午或下午的 focused block。
- **L**：接近一个完整工作日；通常需要专门留出当天的大块时间。
- **XL**：明显需要多天、多 session，或 scope 大到不适合作为一次 bounded execution 完成。

这些范围是 calibration anchor，用于判断“短 session / 半天 / 一天 / 多 session”哪一种工作窗口更匹配。

Size 产生方式：

- 用户可用任意自然语言描述：“很快”“一个小时”“一个下午”“可能两三天”等；
- AI 结合用户判断、Task scope 和一般经验，归一化为 bucket；
- 用户判断是重要 evidence，但 scope 明显更大时 AI 可选择更合理的 bucket，并在正文说明；
- 无法合理判断量级时保持 Size 缺失。XL 表示已经可以判断该 scope 属于 multi-day / multi-session。
- 只有 Size 明显影响选择、而 AI 又无法合理估计时，才值得追问。

Size 主要用于：

1. **Opportunity matching**：找到当前时间窗口内可以完成的事项。
2. **Avoid bad fits**：快速排除明显不适合当前时间窗口的 Task。
3. **Decomposition signal**：可直接执行的 ACTION + XL 应检查是否可以拆出更小、独立可验收的工作单元。

长期 EPIC、DISCOVERY、MONITORING 可以合理保持 XL。

Size 描述 active effort。等待时间、审批周期和 calendar duration 由 Status、Trigger、deadline 或正文表达。

完成后，如果真实投入与原估计存在明显学习价值，可以在 completion note 中记录实际情况；actual effort 暂不作为核心字段。

## 5. Type

Type = task-shape index，帮助快速理解 Task 的主要工作形态。

- **ACTION**：交付一个具体结果。
- **DECISION**：形成一个需要保留的选择或判断。
- **DISCOVERY**：通过研究、实验或探索降低未知。
- **MONITORING**：持续观察状态或等待条件变化。
- **EPIC**：长期 parent scope，负责方向、routing 和 roll-up。

Type 是辅助索引。Task 同时具有多种性质时，选择最有助于理解和 routing 的主要形态；标题与正文已经足够清楚时可以省略。

## 6. 创建、ownership 与拆分

创建或更新 Task 前，先检查是否已有 owner。能由已有 Task 清楚承载的内容优先更新已有 Task；不要因为一次讨论、新想法、未来可能做的事项或局部步骤自动建 Ticket。

独立 Task 的常见信号：

- 有自己的目标 / completion condition；
- 有独立 lifecycle；
- 会跨多次推进；
- 有明显独立设计、调研、决策或执行；
- 有独立 blocker / external wait；
- 细节已开始妨碍 parent 表达整体状态。
- 可以独立交给人或 Agent 推进并判断完成。

这些是判断信号，不是机械门槛。

不同信息类型由对应 owner 保存：

- 长期事实、偏好、约束 → Personal
- 重复性身心状态、daily adherence、routine observation → Well-being
- 有时间语境且值得保留的个人 episode → Journal
- 可复用 decision evidence → Decision
- 当前工作范围、状态、执行与验证 → Task

Task 保留这些信息对当前 scope 的影响和必要引用。MONITORING / treatment / habit Task 可以维护趋势结论、阈值、策略和下一动作，但不应继续堆积每次 daily observation；原始纵向记录由 Well-being 等对应 owner 保存。

一旦拆 child，详细 ownership 下沉：

- child 拥有该 scope 的设计、调研、执行、问题、状态、验收和历史；
- parent 只保留 child ID、scope、必要边界和简短 roll-up；
- child 信息默认写 child；
- 影响 parent 整体目标、架构、边界或总体状态的信息同步到 parent。

## 7. Routing 与关系

Parent / child 表示 **scope decomposition**，不是泛化“相关”。

Parent 应帮助回答：“这个 child 做什么、现在大概什么状态、当前问题是否需要继续打开它？”而不是复制 child 的完整 roadmap / design / history。

读取遵循 progressive routing：

1. 问整体先读 parent；
2. 问具体 subsystem 优先读对应 owner；
3. 跨 scope 问题读取必要的多个 authority；
4. 搜索用于发现 owner，不替代 ownership。
5. 深层信息按需继续读取。

关系语义：

- **Parent / Child**：scope decomposition；
- **Depends on / Blocked by**：影响推进顺序或可执行性；
- **Related**：上下文关联；
- **Uses**：消费另一个能力但不代表 ownership。

稳定 ID 是 identity，路径只是当前位置：

```text
Task ID = durable identity
file path = current physical location
```

rename / move / archive 不改变 Task identity。

## 8. 更新与证据纪律

更新时区分：

- **planned**：计划 / 候选；
- **executed**：已经做过；
- **verified**：有证据确认结果成立。

以下语义升级需要新的直接证据：
- planned             -> executed
- executed            -> verified
- hypothesis          -> conclusion
- no known blocker    -> approval
- architecture change -> historical defect fixed
- downstream success  -> upstream validation

整理、合并、归档和 cleanup 保持已有 evidence strength。

已有 decision、threshold、preference、policy 和用户判断保持原语义，直到出现新的明确输入。

保留仍影响未来工作的决定、阻塞、结论和必要历史；合并或移除已经被替代且不再帮助当前推进的重复 checkpoint。

## 9. 结束与归档

Task 达到目标、明确停止或不再需要作为独立工作存在时，应退出 `tasks/`：

- 达成目标 -> `DONE`
- 停止 / scope 失效 / ownership 正式转移 -> `DROPPED`

结束时写清最终结果、已验证范围、未完成部分如何处理，以及 underlying option 是否仍保留。仍有长期价值的信息由谁承接。

若用户此前可能仍认为该 Task 在进行中，关闭 / DROP / archive 时必须显式告诉用户。

归档前检查：

- 长期事实 / preference / option / decision 是否已有正确 owner；
- parent 是否只保留必要 routing / roll-up；
- 新 owner / child 的稳定 ID 是否明确；
- dependency / relation 是否仍正确；
- stale next action / status 是否已处理；
- 全局引用是否仍指向正确 authority。

随后移动到 `archive/<year>/`。归档保留历史 authority，但不继续作为 current working set。

## 10. Semantic self-check

整理一组 Task 后检查：

- **Owner clarity**：每个 current scope 是否只有一个权威 owner？
- **Scope clarity**：每张 Task 的工作边界是否清楚？
- **Lifecycle clarity**：Status 是否准确表达当前生命周期？
- **Attention clarity**：Priority 是否能支持默认召回和筛选？
- **Size clarity**：Size 是否能支持时间窗口匹配和 decomposition？
- **Routing clarity**：只读 parent 是否能判断下一步该打开哪个 child？
- **Progressive context**：理解整体是否无需读取所有 descendants？
- **Active-set clarity**：仍值得追踪的事项是否保留在 tasks/，结束事项是否退出？
- **Semantic preservation**：cleanup 是否保持已有 decision、evidence、option 和 preference 语义？

出现问题时优先修正 ownership、scope、lifecycle 和 routing，再考虑增加新的结构化字段。


## 11. Current-state consistency

Task 的 current state、next action、milestone / trend summary、last updated 与 Status 必须和最新已知 evidence 保持一致。

当新的 completed evidence 出现，或详细信息由 Well-being、child Task、Resource 等其他 canonical owner 维护时，Task 只保留足够支持当前 scope 的 roll-up 与引用，但必须同步更新自己的派生状态。

已经执行的动作不得继续作为 next action；已经失效的 blocker / trigger 不得继续冒充当前状态；也不能因为 detail 下沉到其他 owner，就让新的已执行事实从 Task roll-up 中消失。
