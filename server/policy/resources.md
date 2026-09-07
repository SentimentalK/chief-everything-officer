# CEO Resource Policy

The Resource Plane manages durable, structured understanding of external materials (URLs, articles, videos, PDFs, office documents, datasets). It shares the same user-owned Git workspace as State (Personal, Tasks, Journal) under `resources/`, but is isolated from default State retrieval.

---

## 1. Core Principles

1. **Markdown Understanding is the V0 Core**:
   - The primary value of a Resource is structured Markdown memory: `meta.md`, `evidence.md`, `content.md`, `summary.md`, and `interactions.md`.
   - Original document file storage (`resources/<dir>/source/original.<ext>`) is an optional, capability-dependent enhancement.
   - A Resource is completely valid and valuable even when original source bytes cannot be stored.

2. **Save Intent vs Temporary Reading**:
   - If the user asks "read this", "explain this", or "what does this mean", perform temporary reasoning in conversation without persisting.
   - If the user explicitly asks to save ("记一下", "存下来", "放进 CEO", "以后记得这个"), capture it into durable Resource memory using `resource_capture`.

3. **Deterministic Authority Boundary**:
   - **Source facts** (`canonical_ref`, `platform`, `platform_id`, `source_hash`, `title`, `author`, `published_at`) must come from deterministic adapters, parsers, or file ingestion.
   - AI must NEVER guess, infer, or use model knowledge to invent canonical source metadata.
   - When metadata acquisition fails, save succeeds with `null` fields; failure is reported honestly.
   - AI only contributes user-semantic fields: `display_name`, `Capture Note`, `topics`, summaries, section mappings, and interaction notes.

4. **Server-Side Deterministic Metadata Enrichment**:
   - URL capture may automatically perform trusted deterministic metadata enrichment server-side.
   - The model should not manually shuttle resolver output into Resource metadata.
   - Resolver failure does not block durable Resource capture.
   - Metadata enrichment status is operational and must not be persisted as Resource lifecycle state.

---

## 2. Artifacts & Provenance

- **`resource_id`**: Immutable logical identity (`res-<uuid-v4>`) stored in `meta.md`.
- **Physical Directory & Naming**: New resources are always captured under their stable ID directory (`resources/res-<uuid>/`) with temporary placeholder `display_name = resource_id` and `naming_source = "id"`. AI subsequently inspects metadata/content and performs semantic naming via `resource_apply` with `op: "rename"`, which renames the directory to a clean, retrieval-friendly storage label.
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

- **`meta.md`**: Immutable identity (`resource_id: res-<uuid>`), semantic `display_name`, `naming_source` (`explicit` | `id`), `source_aliases`, bounded `last_metadata_attempt`, normalized `source_identity`, source facts, capture note, topics, capture history. Explicit directory renames use `op: "rename"`.
- **`naming_source`**: Tracks display name provenance (`explicit` | `id`). Initial capture uses `"id"`; semantic renames by AI or user use `"explicit"`.
- **`last_metadata_attempt`**: Records bounded diagnostic evidence (`attempted_at`, `status`, `code`, `fields_resolved`) of external enrichment attempts. Stale attempts are skipped.
- **`source_aliases`**: Symmetrical URL/platform aliases ensuring bidirectional deduplication.
- **`evidence.md`**: Raw/near-raw platform transcripts, ASR, OCR, or exact web text. Provenance must be `host_exact`, `trusted_adapter`, or `worker`. **`host_semantic` is strictly forbidden for evidence**.
- **`content.md`**: Lossless, normalized readable content structured with stable section IDs (`S001`, `S002`, ...).
- **`summary.md`**: High-level overview, TOC / section map, section summaries, key claims, caveats, and topic tags. 必须包含严格的 YAML frontmatter，声明 `provenance` 和 `basis`：
  - `basis: metadata`：只依据标题、简介等元数据，不提升阶段至 `READY_FOR_DISCUSSION`。
  - `basis: source_content`：确实读取了来源内容（不要求保存原文件），可达成 `READY_FOR_DISCUSSION`。
- **`interactions.md`**: Append-only log of user questions, discussion episodes, conclusions, open questions, and promoted State consequences. 存在有效讨论记录时阶段为 `DISCUSSED`（若存在 summary.md 仍优先校验其合法性）。

---

## 3. Discussion & State Promotion

- Discussion of a Resource does not automatically alter user preferences, tasks, or personal facts.
- When discussion produces real user actions, decisions, or timeline-relevant insights:
  - Model may include justified `state_changes` (targeting `personal/`, `tasks/`, or `JOURNAL.md`) in the same atomic transaction as Resource updates.

---

## 4. Progressive Retrieval

- For discovering saved material: use `resource_search` (scans lightweight metadata cards; never dumps full bodies).
- For reading specific details: use `resource_get` with specific `view` and bounded `start_line` / `line_count` or `section_ids`.
