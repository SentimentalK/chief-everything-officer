import type { BootstrapLocale } from "./locale.js";

export const README_ZH = `# Welcome to CEO

CEO（Chief Everything Officer）为你的 AI 提供一个长期、由你拥有的工作空间，让不同对话和不同 AI 都能按需继续理解和帮助你。

你的 CEO 数据保存在这个私有 GitHub 仓库中，并使用普通的 Markdown 和 Git。你可以随时查看、编辑、克隆、备份或迁移这些数据。

## 你不需要先配置任何东西

直接正常地和已经连接 CEO 的 AI 对话即可。

CEO 已经内置了默认规则，并在需要时自动创建和维护相应的数据，例如：

- **Personal** — 可以长期复用的个人信息、偏好与状态
- **Tasks** — 尚未完成的事情、等待项和后续行动
- **Journal** — 值得保留的经历、变化与生活片段
- **Decisions** — 重要选择及其判断依据
- **Resources** — 你保存的文章、视频、文档等外部资料

这些文件和目录不一定一开始就存在。CEO 会在真正需要时自动创建它们。

## 你可以修改 CEO 的规则

如果默认行为不完全符合你的习惯，可以在 \`rules/\` 下创建对应领域的规则文件（如 \`rules/<area>.md\`）。

规则文件必须在开头使用 YAML frontmatter 声明扩展模式：

\`\`\`markdown
---
mode: extend
---

你的自定义规则...
\`\`\`

有两种模式可选：
- \`extend\`（常规 / 默认选择）：保留 CEO 该领域的内置政策，并在此基础上补充或重载你的工作空间专属行为。绝大多数情况下应该使用此模式。
- \`override\`：彻底废弃该领域的内置政策，完全使用你编写的自定义规则。

例如：创建 \`rules/tasks.md\` 可以根据你的偏好定义 Tasks 领域的扩展或自定义规则。

## 你也可以创建自己的领域与文件夹

CEO 的 workspace 不是固定 schema，你可以按需创建自己的目录和规则：

1. **自定义文件夹**：你可以创建任何适合你工作流的目录，例如 \`projects/\`（项目）、\`recipes/\`（菜谱）、\`reading/\`（读书笔记）或专门的业务目录。
2. **自定义规则**：在 \`rules/\` 目录下创建同名规则文件（如 \`rules/recipes.md\`），描述这个领域应该如何读取、记录、命名与更新。
3. **它能帮你干什么**：通过自定义规则，你可以让 AI 按照你习惯的格式整理信息、遵守特定的工作流程，并在跨会话中始终保持一致的组织风格。

## 语言

CEO 默认跟随你与 AI 当前使用的语言。

你使用中文交流时，新产生的 CEO 记录通常使用中文；使用英文交流时则通常使用英文。来源材料、代码、名称和引用在适当情况下会保留原语言。

## 你的数据属于你

这个仓库是你的长期数据空间。CEO 使用它帮助不同 AI 按需理解和继续你的工作，但数据本身仍然是普通的 Git 和 Markdown。

请不要在 CEO workspace 中保存密码、API Token、私钥、恢复码或其他秘密凭据。

## 如何快速上手（给用户与 AI 的快速启动建议）

如果你想快速上手或初始化自己的 workspace，最好的方式是**从一件你正在做的事情开始**：

- **选择一个具体起点**：挑选一个你手头正在推进的项目、近期的计划、或者一个你正在反复考虑的事情。
- **直接告诉 AI**：例如跟 AI 说 *“我最近正在筹备 X，帮我理清后续行动，并记录到我的 CEO workspace 中”*。AI 会在自然沟通中为你梳理并建立第一批记录。
- **直接修改这份 README**：你可以根据自己的个人偏好自由修改、精简或重写这份 README 模板，把它变成专属于你的主页。

## Early Trial

如果你正在参加 CEO 的早期试用，需要帮助、重新连接或提出建议，请通过你收到邀请的原渠道联系我们。
`;

export const README_EN = `# Welcome to CEO

CEO (Chief Everything Officer) gives your AI a durable workspace that you own, so different conversations and different AI systems can continue working with the context that matters to you.

Your CEO data lives in this private GitHub repository as ordinary Markdown and Git data. You can inspect, edit, clone, back up, or migrate it yourself.

## You do not need to configure anything first

Just talk normally to an AI that is connected to CEO.

CEO already provides built-in rules and creates the necessary data only when it is needed, including:

- **Personal** — reusable facts, preferences, and long-term state
- **Tasks** — unfinished work, waiting items, and next actions
- **Journal** — experiences, changes, and moments worth keeping
- **Decisions** — important choices and the reasoning behind them
- **Resources** — articles, videos, documents, and other material you save

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

For example, \`rules/tasks.md\` can describe how you want your Tasks maintained.

## You can create your own areas and folders

A CEO workspace is not a fixed schema. You can create your own directories and rules as needed:

1. **Custom folders**: You can create any directory that fits your workflow, such as \`projects/\`, \`recipes/\`, \`reading/\`, or specific work areas.
2. **Custom rules**: Create a matching rule file in \`rules/\` (such as \`rules/recipes.md\`) describing how that area should be read, recorded, named, and updated.
3. **What it helps you do**: Custom rules enable AI to format information according to your preferences, follow specific workflows, and maintain consistent organization across conversations.

## Language

CEO normally follows the language you use with your AI.

If you talk in Chinese, new CEO notes and records will normally be written in Chinese. If you use English, they will normally be written in English. Source material, code, names, and quotations keep their original language when appropriate.

## Your data belongs to you

This repository is your durable data workspace. CEO uses it to help different AI systems retrieve and continue your context, while the underlying data remains ordinary Git and Markdown.

Do not store passwords, API tokens, private keys, recovery codes, or other secret credentials in your CEO workspace.

## Quick Setup Guide (For You & AI)

If you want to quickly set up your workspace and experience its value, the best way is to **start with one real thing you are currently working on**:

- **Pick a starting point**: Choose an ongoing project, an upcoming plan, or an open question you have been thinking about.
- **Tell your AI**: For example, say *“I'm working on project X right now; help me clarify next steps and record it into my CEO workspace.”* Your AI will naturally create the initial structure and notes.
- **Customize this README**: You can freely edit, personalize, or trim this README template to make it your own personal homepage.

## Early Trial

If you are participating in the early CEO trial and need help, want to reconnect, or have feedback, please reach out through the channel where you received your invitation.
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
