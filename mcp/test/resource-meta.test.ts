import { describe, expect, it } from "vitest";
import {
  deriveResourceStage,
  formatMetaMarkdown,
  parseMetaMarkdown,
} from "../src/resource/meta.js";
import type { ResourceMeta } from "../src/resource/types.js";

describe("Resource Metadata & Frontmatter Serialization", () => {
  const sampleMeta: ResourceMeta = {
    schema_version: 1,
    resource_id: "res-01234567-89ab-cdef-0123-456789abcdef",
    resource_kind: "document",
    source_type: "file",
    source_identity: null, // Valid for provisional resource
    source_ref: "chatgpt_upload_id_123",
    canonical_ref: null,
    platform: null,
    platform_id: null,
    original_name: "contract.pdf",
    media_type: null,
    format: null,
    asset_ref: null,
    source_hash: null,
    title: null,
    author: null,
    published_at: null,
    first_captured_at: "2026-09-05T12:00:00.000Z",
    language: null,
    topics: ["contract", "employment"],
    metadata_method: "user_provided",
    metadata_fetched_at: null,
    capture_surface: "mcp",
  };

  it("formats and parses meta.md with exact schema and null representation", () => {
    const markdown = formatMetaMarkdown(
      sampleMeta,
      "Saved during employment contract review",
      ["2026-09-05T12:00:00.000Z — first_capture — initial upload"],
    );

    expect(markdown).toContain('schema_version: 1');
    expect(markdown).toMatch(/resource_kind:\s*"?document"?/);
    expect(markdown).toMatch(/source_type:\s*"?file"?/);
    expect(markdown).toContain('source_identity: null');
    expect(markdown).toContain('## Capture Note');
    expect(markdown).toContain('Saved during employment contract review');
    expect(markdown).toContain('## Capture History');

    const parsed = parseMetaMarkdown(markdown);
    expect(parsed.meta.resource_id).toBe(sampleMeta.resource_id);
    expect(parsed.meta.resource_kind).toBe("document");
    expect(parsed.meta.source_identity).toBeNull();
    expect(parsed.meta.title).toBeNull();
    expect(parsed.meta.topics).toEqual(["contract", "employment"]);
    expect(parsed.capture_note).toBe("Saved during employment contract review");
    expect(parsed.capture_history).toHaveLength(1);
  });

  describe("Artifact-derived stage derivation", () => {
    it("derives CAPTURED when only meta.md exists", () => {
      const stage = deriveResourceStage(new Set(["meta.md"]));
      expect(stage).toBe("CAPTURED");
    });

    it("derives EXTRACTED when evidence.md exists", () => {
      const stage = deriveResourceStage(new Set(["meta.md", "evidence.md"]));
      expect(stage).toBe("EXTRACTED");
    });

    it("derives NORMALIZED when content.md exists", () => {
      const stage = deriveResourceStage(new Set(["meta.md", "evidence.md", "content.md"]));
      expect(stage).toBe("NORMALIZED");
    });

    it("derives READY_FOR_DISCUSSION when summary.md exists", () => {
      const stage = deriveResourceStage(
        new Set(["meta.md", "content.md", "summary.md"]),
      );
      expect(stage).toBe("READY_FOR_DISCUSSION");
    });

    it("derives DISCUSSED when interactions.md contains substantive entries", () => {
      const stage = deriveResourceStage(
        new Set(["meta.md", "summary.md", "interactions.md"]),
        "# Interactions\n\n## 2026-09-05T14:00:00Z (host_semantic)\nDiscussed non-compete clause.",
      );
      expect(stage).toBe("DISCUSSED");
    });

    it("does NOT derive DISCUSSED when interactions.md is empty", () => {
      const stage = deriveResourceStage(
        new Set(["meta.md", "summary.md", "interactions.md"]),
        "",
      );
      expect(stage).toBe("READY_FOR_DISCUSSION");
    });
  });
});
