# CEO 真实案例

[首页](../README.md) | [English](USE-CASES.md)

CEO 的作者持续在真实项目中使用产品。以下是个人 dogfood 记录，不等于外部用户的性能保证。

## 1. 新窗口继续旧项目

新 Session 的 AI 读取 Git 仓库里的 canonical Project/Task、当前设计和下一动作，再核对实际代码、commit 和 CI。作者用这个流程推进 CEO、Connector 和 Echolet。仍可能发生规则漏读或状态漂移，所以真实代码 Review 是必需的。

## 2. 保存资料，下次继续讨论

通过 Resource 保存微信视频、YouTube 等链接；必要时获取正文、字幕或元数据。新窗口可以重新检索来源与讨论记录。已发生过 metadata/rename 漏操作，保存 URL 不等于拿到了完整内容。

## 3. 网页端把任务交给本地 Agent

网页端强模型负责 comprehensive technical design 和独立验收。CEO Job 进入持久化队列，由本地 Connector + Orca 启动授权 Worker。Worker 完成代码、测试、commit/push 与 CI。已有真实交付和 quota handoff；Orca 兼容、重复 worker 和恢复仍需完善。

用户可把闲置电脑或服务器变成执行环境，并在明确配置和授权后使用本地代码、算力或浏览器登录工具。手机端发起任务的前提是手机 AI Host 支持已连接的 MCP 工具，不能直接假设所有客户端都支持。

## 4. 成本：计算方式与边界

作者报告密集开发期网页端用量约 **20 亿 tokens**。这是用户提供的数字，不是 CEO 实测账单或实际节省金额。

API 对照公式：`总成本 = 非缓存输入(M)×输入费率 + 缓存输入(M)×缓存费率 + 输出(M)×输出费率 + 工具及其他费用`。

例如**纯假设**每百万输入 US$2、输出 US$10，20 亿 tokens 中 90% 为非缓存输入、10% 为输出：`1800×$2 + 200×$10 = US$5,600`。这不是作者真实费用，也不是 CEO 带来的确定节省。真实比较应包含网页订阅、本地模型、重试、算力和人工验收，关注每个通过验收任务的总成本。

## 当前边界

- State / Resource 已用于日常工作，但全新用户 onboarding 仍待完整验收。
- Worker 受本机 runtime、授权、进程生命周期与 provider 限制；执行状态不明必须 fail closed。
- 托管 MCP + 本地 Worker 不意味着整个流程完全离线或所有个人数据只留在本机。
