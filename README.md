# Chief Everything Officer (CEO)

[English](README.md) | [简体中文](README.zh-CN.md)

---

Chief Everything Officer (CEO) is a personal long-term system.

It preserves and maintains **what relates to you**: who you are, what you have lived through, what you are currently doing, what you care about, how you make decisions, what you own, and how these states evolve over time.

This context does not belong to any single chat session, nor should it belong to any single AI.

## Goal

CEO's objective is to transform personal long-term state into a continuously compounding asset usable by any AI or tool.

When you switch models, change devices, adopt new apps, or revisit a problem years later, you should never have to explain yourself from scratch. The truly valuable context remains intact and keeps evolving.

Long-term AI memory is part of this problem, but not the goal itself. We do not care how many tokens a model can memorize in theory; we care about:

> **What is worth knowing about this person long-term, how it should be preserved, and when it should be brought back into action.**

## Core Capabilities

- **Universal Git-Backed Markdown Workspace**: Open-ended Markdown storage engine. Safe `.md` files can be organized freely into any structure (`personal/`, `tasks/`, `projects/`, `sources/`, etc.) without requiring runtime schema changes.
- **Modern Model Context Protocol (MCP)**: Native Streamable HTTP MCP server (2026-07-28 protocol) connecting ChatGPT, Claude, and autonomous host agents directly to your canonical state.
- **Atomic Git Transactions**: Optimistic concurrency control via Git blob OIDs and isolated worktrees. Zero partial writes, single-line commits, and fast-forward-only pushes.
- **Security & `.ceoignore` Boundary**: Hard runtime invariants (safe Markdown only, no hidden files, no symlinks, no credentials) paired with user-defined `.ceoignore` access boundaries.
- **Extensible Semantic Rule Hierarchy**: Decoupled filesystem engine from domain semantics:
  $$\text{Hard Invariants} \longrightarrow \text{Workspace Rules (rules/)} \longrightarrow \text{Runtime Defaults (policy/)} \longrightarrow \text{Model Reasoning}$$
- **Full Trace Audit & Observability**: Embedded SQLite audit logging capturing exact tool inputs, outputs, estimated token usage, latencies, affected files, and resulting commit hashes with an accompanying Audit Web UI.

## What Belongs Here

CEO focuses on the relationship between a person and the world, rather than the world itself.

- A company’s public profile is not personal state. That you worked there, what you experienced, and how that chapter shaped your worldview, is.
- A software tool's documentation is not personal state. Why you chose it, your evaluation after using it, and whether it altered how you work, is.
- A single life event may produce multiple distinct signals: active state, an ongoing project, an episodic journal entry, or a lasting preference.

CEO does not force a rigid taxonomy onto your life. Structure evolves alongside real-world needs.

## Principles

1. **User Ownership**: You own your canonical data. Models and runtimes are interchangeable; your personal state endures.
2. **Single Canonical Truth**: One trusted source for any long-term fact. Reference it across tasks rather than maintaining duplicate copies.
3. **Compounding Value**: Recording is not the goal. Only preserve information that helps understand the person, continue an effort, or make better decisions in the future.
4. **Epistemic Honesty**: Unknown is unknown, subjective experience is experience, AI deduction is deduction. Never fabricate certainty for the sake of completeness.
5. **Radical Simplicity**: Markdown, Git, and clear ownership are enough. Only introduce complexity when real-world usage proves necessity.

## Direction

CEO ultimately goes beyond passive recording.

It leverages accumulated state to understand new problems, absorb materials you are reading, continue unfinished work, and orchestrate specialized tools or workers to deliver results.

> **AI knows you, grows with you, and works for you.**
> *(懂你，陪你成长，替你干活)*

- **Knows you**: Rooted in continuously maintained personal state, not transient chat context.
- **Grows with you**: Understands what was past, what is present, and what is changing.
- **Works for you**: Context leads directly into real-world execution.

CEO's enduring value is not giving AI more memory, but enabling a person’s lived experiences, state, judgment, and active pursuits to compound durably and be truly usable in the future.
