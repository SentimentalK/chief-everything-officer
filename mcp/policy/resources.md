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
- **Physical Directory**: Readable storage label (e.g. `resources/CUDA生态与NVIDIA软件护城河/`) independent of identity. Historical UUID directories (`resources/res-<uuid>/`) and new readable directories coexist.

```text
resources/<readable_directory_label>/
  meta.md         -> CAPTURED
  evidence.md     -> EXTRACTED
  content.md      -> NORMALIZED
  summary.md      -> READY_FOR_DISCUSSION
  interactions.md -> DISCUSSED
```

- **`meta.md`**: Immutable identity (`resource_id: res-<uuid>`), semantic `display_name`, normalized `source_identity`, source facts, capture note, topics, capture history.
- **`evidence.md`**: Raw/near-raw platform transcripts, ASR, OCR, or exact web text. Provenance must be `host_exact`, `trusted_adapter`, or `worker`. **`host_semantic` is strictly forbidden for evidence**.
- **`content.md`**: Lossless, normalized readable content structured with stable section IDs (`S001`, `S002`, ...).
- **`summary.md`**: High-level overview, TOC / section map, section summaries, key claims, caveats, and topic tags. Acceptable with `host_semantic` provenance.
- **`interactions.md`**: Append-only log of user questions, discussion episodes, conclusions, open questions, and promoted State consequences.

---

## 3. Discussion & State Promotion

- Discussion of a Resource does not automatically alter user preferences, tasks, or personal facts.
- When discussion produces real user actions, decisions, or timeline-relevant insights:
  - Model may include justified `state_changes` (targeting `personal/`, `tasks/`, or `JOURNAL.md`) in the same atomic transaction as Resource updates.

---

## 4. Progressive Retrieval

- For discovering saved material: use `resource_search` (scans lightweight metadata cards; never dumps full bodies).
- For reading specific details: use `resource_get` with specific `view` and bounded `start_line` / `line_count` or `section_ids`.
