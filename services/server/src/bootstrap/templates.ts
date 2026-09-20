import type { BootstrapLocale } from "./locale.js";

export const README_ZH = `# Welcome to CEO

CEO（Chief Everything Officer）为你的 AI 提供一个长期、由你拥有的工作空间，让不同对话和不同 AI 都能按需继续理解和帮助你。

你的 CEO 数据保存在这个私有 GitHub 仓库中，并使用普通的 Markdown 和 Git。你可以随时查看、编辑、克隆、备份或迁移这些数据。

## 你不需要先配置任何东西

直接正常地和已经连接 CEO 的 AI 对话即可。

CEO 已经内置了默认规则，并会在需要时自动创建和维护相应的数据，例如：

- Personal — 可以长期复用的个人信息、偏好与状态
- Tasks — 尚未完成的事情、等待项和后续行动
- Journal — 值得保留的经历、变化与生活片段
- Decisions — 重要选择及其判断依据
- Resources — 你保存的文章、视频、文档等外部资料

这些文件和目录不一定一开始就存在。CEO 会在真正需要时创建它们。

## 你可以修改 CEO 的规则

如果默认行为不适合你，可以在 \`rules/\` 下创建对应领域的规则文件（如 \`rules/<area>.md\`）。

规则文件必须在开头使用 YAML frontmatter 声明扩展模式：

\`\`\`markdown
---
mode: extend
---

你的自定义规则...
\`\`\`

有两种模式可选：
- \`extend\`（常规/默认选择）：保留 CEO 该领域的内置政策，并在此基础上补充或重载你的工作空间专属行为。绝大多数情况下应该使用此模式。
- \`override\`：彻底废弃该领域的内置政策，完全使用你编写的自定义规则。

例如：

\`rules/tasks.md\`

可以根据你的偏好定义 Tasks 领域的扩展或自定义规则。

## 你也可以创建自己的领域

CEO 的 workspace 不是固定 schema。

你可以创建自己的目录，例如：

\`recipes/\`

如果希望 AI 按特定方式维护它，可以再创建：

\`rules/recipes.md\`

描述这个领域应该如何读取、记录和更新即可。

## 语言

CEO 默认跟随你与 AI 当前使用的语言。

你使用中文交流时，新产生的 CEO 记录通常使用中文；使用英文交流时则通常使用英文。

来源材料、代码、名称和引用在适当情况下会保留原语言。

## 你的数据属于你

这个仓库是你的长期数据空间。CEO 使用它帮助不同 AI 按需理解和继续你的工作，但数据本身仍然是普通的 Git 和 Markdown。

请不要在 CEO workspace 中保存密码、API Token、私钥、恢复码或其他秘密凭据。

## Early Trial

如果你正在参加 CEO 的早期试用，需要帮助、重新连接或停止使用 CEO，请通过你收到邀请的渠道联系我们。
`;

export const README_EN = `# Welcome to CEO

CEO (Chief Everything Officer) gives your AI a durable workspace that you own, so different conversations and different AI systems can continue working with the context that matters to you.

Your CEO data lives in this private GitHub repository as ordinary Markdown and Git data. You can inspect, edit, clone, back up, or migrate it yourself.

## You do not need to configure anything first

Just talk normally to an AI that is connected to CEO.

CEO already provides built-in rules and creates the necessary data only when it is needed, including:

- Personal — reusable facts, preferences, and long-term state
- Tasks — unfinished work, waiting items, and next actions
- Journal — experiences, changes, and moments worth keeping
- Decisions — important choices and the reasoning behind them
- Resources — articles, videos, documents, and other material you save

These files and folders may not exist yet. CEO creates them when they become useful.

## You can customize how CEO works

If the default behavior for an area does not fit you, create a corresponding rule file under \`rules/\` (such as \`rules/<area>.md\`).

Rule files must declare an extension mode using YAML frontmatter at the very top:

\`\`\`markdown
---
mode: extend
---

Your custom rules...
\`\`\`

Two modes are available:
- \`extend\` (normal / default choice): keep CEO's built-in policy for this area, while adding or overriding workspace-specific behaviors. This is the standard choice in almost all cases.
- \`override\`: completely replace the built-in policy for that area with your own custom rules.

For example:

\`rules/tasks.md\`

can describe how you want your Tasks maintained.

## You can create your own areas

A CEO workspace is not a fixed schema.

You may create your own directory, for example:

\`recipes/\`

and, if you want AI to maintain it in a specific way, add:

\`rules/recipes.md\`

describing how that area should be read, recorded, and updated.

## Language

CEO normally follows the language you use with your AI.

If you talk in Chinese, new CEO notes and records will normally be written in Chinese. If you use English, they will normally be written in English.

Source material, code, names, and quotations keep their original language when appropriate.

## Your data belongs to you

This repository is your durable data workspace. CEO uses it to help different AI systems retrieve and continue your context, while the underlying data remains ordinary Git and Markdown.

Do not store passwords, API tokens, private keys, recovery codes, or other secret credentials in your CEO workspace.

## Early Trial

If you are participating in the early CEO trial and need help, want to reconnect, or want to stop using CEO, use the same contact or invitation channel through which you received access.
`;

export function renderBootstrapReadme(locale: BootstrapLocale = "en"): string {
  switch (locale) {
    case "zh":
      return README_ZH;
    case "en":
    default:
      return README_EN;
  }
}
