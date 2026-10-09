# CEO in Practice

[Home](../README.md) | [简体中文](USE-CASES.zh-CN.md)

These examples come from the creator's ongoing dogfood. They are not a controlled benchmark or a guarantee for every user.

## 1. Continue work in a new AI session

**Problem:** A new conversation may not know the accepted design, open blocker, or next task.

**With CEO:** The AI reads current Project/Task files in the user's Git-backed workspace, checks the real code and CI, and continues from verified state.

**Observed:** The creator uses this across CEO, Connector and Echolet projects. Some sessions still expose stale records or missed instructions; canonical context improves continuity but does not replace review.

## 2. Save a resource and revisit it later

**Problem:** A useful article or video link disappears into a previous chat.

**With CEO:** Capture a Resource, acquire source content when available, and retrieve it for discussion in a later session.

**Observed:** YouTube and WeChat sources have been saved and reused. Extraction and metadata naming are not reliable for every source.

## 3. Dispatch coding work from a web chat

**Problem:** A remote AI host may not have your local codebase, build environment, GPU or authenticated browser tools.

**With CEO:** A capable web-based Master writes a comprehensive technical design. A configured local Connector and Orca dispatch an authorized worker to implement, test, commit, push and check CI. The Master independently reviews delivery.

**Observed:** Selected real Jobs delivered code and CI, including a safe same-worktree quota handoff. Orca and model compatibility, process ownership and duplicate-worker prevention remain active dogfood areas.

Mobile dispatch is only possible when the mobile AI host exposes the connected MCP tools. Local data and browser tools require explicit authorization and supported integrations.

## 4. Cost is a workflow decision

The creator reports roughly **2 billion tokens of web AI use** during intensive development. This is self-reported host-side usage, not CEO-metered API billing and not measured savings.

As an *illustrative API equivalent*, the public GPT-6 Sol Standard short-context rates on 2026-10-08 were US$2 per 1M input tokens and US$10 per 1M output tokens. At an assumed 90% uncached input / 10% output split:

```text
1,800M input / 1M x $2    = $3,600
  200M output / 1M x $10 = $2,000
Illustrative API total     $5,600 USD
```

Source: [OpenAI API pricing](https://platform.openai.com/pricing). This is **not** the creator's bill or actual savings. The web and API accounting methods, caching, subscription costs, local compute and retry rates differ.

The actual value is flexible division of labor: strong model for planning and review; suitable lower-cost worker for bounded execution. Compare total cost **per accepted task**, not just token prices.

## Current limitations

- Fresh-user, zero-state onboarding still needs final live acceptance.
- Resource metadata and extraction may need manual review.
- Workers need a compatible agent/runtime and safe process recovery; unknown worker state must fail closed.
- Hosted MCP plus a local worker is not an end-to-end local or offline workflow.
