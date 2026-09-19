# Decision Rule

`decision/` 保存用户真实经历过的决策 case，作为未来类似选择的可检索 precedent。它不是自动替用户决策的规则引擎，也不是把一次选择直接升级为永久偏好。

## 文件组织

Decision 按自然年份分片：

```text
decision/YYYY.md
```

例如：

```text
decision/2026.md
decision/2027.md
```

新 case 根据首次记录 / 形成该 decision case 的日期写入对应年份文件；文件存在则 append，不存在则 create。年度文件只是物理分片，不改变 Decision 的语义。OPEN case 后续形成最终选择时更新原 case，即使跨年也不移动、不另造重复 case。

## 什么时候记录

当一个选择已经进入有实际权衡的 reasoning 层，并且未来可能值得参考时，可以记录。通常存在两个或多个合理选项、若干实际影响判断的条件，并形成当前倾向或最终选择。普通、无实际权衡的小选择不要求记录；尊重用户不记录的要求。

“真实经历过的决策”指用户已经实际进行了这次权衡并形成了当前倾向或选择，不要求外部事件已经发生或执行结果已经出现。明确做出的策略、决策原则或未来处理方式也可以作为 case，只要它是在当前真实问题上形成的选择，并能用具体适用条件和 reasoning 表达；不要把未经实际权衡的抽象格言或纯 hypothetical 情景当成 Decision。

未最终决定的 case 也可以记录，但必须明确 `OPEN` / 当前倾向，不得伪装成已做出的决定。后续用户给出最终选择时，更新同一个 case，不另造重复记录。

## Case 结构

保持高信息密度。V0 只维护以下核心信息：

```markdown
## YYYY-MM-DD — [简短标题]
- Status: OPEN | DECIDED
- Question: [当时真正要回答的问题]
- Dimensions:
  - [本次实际进入判断的维度]: [当时值/状态]
- Decision: [当前倾向或最终选择]
- Reason: [一句话保存最终起主要作用的 reasoning]
```

`Dimensions` 是 schemaless 的 case-local 对象，不建立统一字段表，也不为了格式完整而填充无关维度。只记录本次真正影响 reasoning、且有助于未来检索或比较的条件。字段名应简短、语义清楚；不同 case 可以拥有完全不同的 dimensions。

`Reason` 只保留能防止未来误读 decision 的核心逻辑，不复制完整讨论，也不枚举所有 hypothetical “what would change the answer”。

## 检索与使用

面对新的选择时，若历史 precedent 可能有帮助，可按当前问题和相关 dimensions 在 `decision/` 中检索类似 case。历史 decision 是 preference evidence，不是命令：比较旧 case 与当前 case 的相同点、差异和新增维度，再结合当前需要的 Personal、Task、Resource 或外部实时信息重新 reasoning，并向用户说明理由。

不要因为过去在相似问题上选择 A，就自动再次选择 A。新的 context 可以产生不同结果；历史记录的价值是帮助 AI 更快识别用户通常在意的 trade-off 和过去的 decision boundary。

## 与其他领域的边界

- `decision/`：保存一次具体选择在当时条件下如何权衡，以及当前/最终选择。
- `personal/`：保存跨 case 稳定、可复用的偏好或长期判断。单个 decision 不足以证明长期 preference；多个 case 稳定显示同一 pattern 时，才按 Personal 规则考虑抽象。
- `well-being/`：保存睡眠、精力、压力、时间使用、训练、症状等纵向 observation。它们可以成为某次 Decision 的 evidence / dimension，但 raw observation 的 canonical owner 仍在 Well-being，不复制进 Decision。
- `journal/`：保存值得保留的生活事件、体验和变化；如果一次 decision 本身也是有时间意义的生活片段，Journal 可以记录“发生了这次选择”，但不复制完整 dimensions/reasoning。
- `tasks/`：保存仍需执行、等待、监控或继续推进的事项。Decision record 不替代 task tracking；一个选择产生后续行动时，由 Task 维护执行状态。

同一 decision 的 reasoning canonical truth 留在对应的 `decision/YYYY.md`，其他领域只保存各自语义或引用，避免重复维护。
