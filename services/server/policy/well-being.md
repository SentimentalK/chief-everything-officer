# Well-being Rule

`well-being/` 保存重复性的个人观察与日常行为。单次记录未必重要，但连续记录可以帮助理解用户在睡眠、精力、情绪与压力、时间使用、饮食、训练、恢复和其他长期关注维度上的变化。

Well-being 比医疗意义上的 Health 更宽；它不是诊断系统，也不是第二份 Journal。用户在自然对话中透露具有纵向记录价值的日常状态、行为或重复性观察时，不需要额外说“记一下”才允许记录。先按当前语义判断是否适合进入 Well-being，并尊重用户明确不记录的要求。

## 文件组织

默认使用两个季度 stream：

```text
well-being/
├── daily/
│   └── YYYY-QN.md
└── training/
    └── YYYY-QN.md
```

季度只是物理分片。不要因为每个小主题都可能重复出现就提前拆目录；只有数据量或 retrieval pattern 已经明显不同、独立 stream 能实质改善读取时再拆。

### Daily

`daily/YYYY-QN.md` 按日期保存用户当天实际报告的 observation。默认可复用的稳定字段：

- **睡眠**
- **精力**
- **情绪与压力**
- **时间使用**
- **饮食**
- **恢复与症状**
- **其他**

这些字段不是每日 checklist。只写用户实际提供的信息，不为格式完整制造空字段，不把未提及的信息猜成事实。

同一语义使用稳定字段名，避免因为措辞变化产生多个近义字段。用户有长期、独立的观察需求，而现有字段无法自然承载时，可以为该 workspace 增加稳定的自定义字段；一次性或偶发内容先使用最接近的已有字段或其他，不自动扩展 schema。

自定义字段应使用简短、稳定、便于检索的名称，并明确它负责哪类观察。以后用户使用不同说法表达同一内容时，继续写入已有字段，不重复创造近义字段。

### Training

`training/YYYY-QN.md` 保存实际发生的训练 session，包括按需要记录：

- 动作或器械；
- 重量、档位；
- sets / reps；
- 时长、距离、心率；
- 主观强度；
- 恢复情况。

按训练日期组织。已知时复用稳定的动作和器械名称；单位按用户实际提供的内容记录，未知则保持未知，不补假精度。

未实际发生的训练不写成 session。取消训练、没有去 gym 或选择休息，如果其原因对生活状态或习惯实验有记录价值，可以进入 Daily 或对应 Task。

## 什么时候记录

当信息主要通过纵向比较才有价值时，优先记录到 Well-being。例如：

- 一晚睡了多久、睡眠是否中断；
- 当天精力或疲劳体验；
- 日常压力与情绪状态；
- 有意义的大块时间使用；
- 实际饮食；
- 刷牙、牙间清洁等 routine adherence；
- 训练 session；
- 重复出现的身体观察或症状。

不要求每天都有记录，也不因为某一天缺失就补造状态。

## 记录什么

保留实际知道的日期、时间、数值、行为和用户自己的主观体验。区分计划、尝试、实际完成与结果；不确定的信息明确保留不确定性。

主观压力、情绪、疲劳和恢复按用户自己的体验记录，不转换成医学或心理诊断。

时间使用只保留对生活负荷、恢复、习惯或长期模式有意义的大块内容，不默认复制完整活动流水。

饮食记录真实吃了什么和必要上下文，不默认升级为 calorie tracking。

用户纠正旧记录时，更新或追加明确 correction，不让错误信息继续作为当前事实。

## 与其他领域的边界

- **Well-being**：重复性 observation / behavior，价值主要来自纵向比较。
- **Journal**：值得以后记住的具体生活 episode。Routine telemetry 不仅因为“今天发生了”就进入 Journal。
- **Personal**：跨场景稳定、可复用的事实、偏好、约束或长期结论。Well-being 的几次 observation 不自动升级成 Personal。
- **Task**：目标、治疗、habit experiment、follow-up、monitoring decision、策略和下一动作。Task 可以保存趋势结论，但不积累每次 daily telemetry。
- **Decision**：实际权衡形成的 choice / precedent。Well-being 可以作为 decision evidence，但不复制 raw log。
- **Resource**：外部材料及围绕材料的互动。不能从外部内容推断用户本人存在某种 Well-being 状态。

同一轮对话可以同时更新多个 owner，但各处只保存自己的 semantic consequence。例如“昨晚只睡 5 小时，因为和家人就买房发生了一次重要争执”：睡眠/压力 observation 可以进 Well-being；如果争执本身值得以后记住，可另进 Journal；若产生明确后续行动或决定，再分别进入 Task / Decision。不要复制整段对话。

## 归纳与长期状态

Well-being 保存 observation，不负责把有限样本自动解释成稳定结论。

从多次记录形成趋势、summary，或进一步更新 Personal、Task、Journal、Decision 时，应保持原有 evidence strength：

- 用户表达的“怀疑 / 可能相关 / 感觉”不能自动升级为已确认的 trigger、因果关系或长期 pattern；
- 单次或少量 observation 不足以形成稳定长期结论；
- 行为与内部状态需要区分，例如“白天大部分时间躺着刷手机”不能自动等价为“精力低”；
- 只有用户明确表达，或足够的 observation / measurement 支持与证据强度相匹配的归纳时，才形成更高层 summary，并保留必要的不确定性。

当 observation 被进一步用于其他领域时，Well-being 继续保存纵向比较所需的原始记录；Personal、Task、Journal、Decision 只保存各自需要的长期结论、策略、episode 或 decision，不复制 raw detail。

## 检索

- 已知季度 / stream：直接读取对应季度文件。
- 查某一 daily 维度的近期趋势：在 `well-being/daily/` 下按稳定字段名或具体关键词做 scoped `search_text`。
- 查训练历史：在 `well-being/training/` 下按稳定动作 / 器械名称搜索。
- 只需要近期信息时，不加载完整长期历史。
- 需要基于 Well-being 形成其他领域的结论或更新时，先读足够相关 observation，再按目标领域规则处理，不把单次记录直接提升成长期结论。
