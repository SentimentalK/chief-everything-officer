import { describe, expect, it } from "vitest";
import { formatSummaryDocument, parseSummaryDocument } from "../src/resource/summary.js";

describe("Resource Summary Document Contract", () => {
  describe("formatSummaryDocument", () => {
    it("formats valid summary document with frontmatter", () => {
      const doc = formatSummaryDocument("host_semantic", "source_content", "# Summary\nValid body.");
      expect(doc).toBe("---\nprovenance: host_semantic\nbasis: source_content\n---\n\n# Summary\nValid body.\n");
    });

    it("rejects invalid or missing provenance at runtime", () => {
      expect(() => formatSummaryDocument("invalid_prov" as any, "source_content", "body")).toThrowError(
        /Invalid summary provenance: 'invalid_prov'/,
      );
      expect(() => formatSummaryDocument(undefined as any, "source_content", "body")).toThrowError(
        /Invalid summary provenance/,
      );
    });

    it("rejects invalid or missing basis at runtime", () => {
      expect(() => formatSummaryDocument("host_semantic", "unsupported_basis" as any, "body")).toThrowError(
        /Invalid or missing summary basis: 'unsupported_basis'/,
      );
      expect(() => formatSummaryDocument("host_semantic", undefined as any, "body")).toThrowError(
        /Invalid or missing summary basis/,
      );
    });

    it("rejects empty or whitespace body at runtime", () => {
      expect(() => formatSummaryDocument("host_semantic", "source_content", "")).toThrowError(
        /Summary content cannot be empty/,
      );
      expect(() => formatSummaryDocument("host_semantic", "source_content", "   \n\t  ")).toThrowError(
        /Summary content cannot be empty/,
      );
    });
  });

  describe("parseSummaryDocument", () => {
    it("parses valid summary document and returns structured metadata and trimmed body", () => {
      const raw = "---\nprovenance: host_semantic\nbasis: metadata\n---\n\n  # Heading\nSummary body content.  \n";
      const parsed = parseSummaryDocument(raw, "/test/path/summary.md");
      expect(parsed.provenance).toBe("host_semantic");
      expect(parsed.basis).toBe("metadata");
      expect(parsed.content).toBe("# Heading\nSummary body content.");
      expect(parsed.raw).toBe(raw);
    });

    it("rejects summary without frontmatter and mentions file path", () => {
      expect(() => parseSummaryDocument("# Just markdown without frontmatter", "/test/path/summary.md")).toThrowError(
        /Summary document in \/test\/path\/summary\.md is missing required YAML frontmatter/,
      );
    });

    it("rejects summary with malformed YAML frontmatter", () => {
      const malformed = "---\n: : bad yaml\n---\n\nBody";
      expect(() => parseSummaryDocument(malformed, "/test/path/summary.md")).toThrowError(
        /Failed to parse YAML frontmatter in \/test\/path\/summary\.md/,
      );
    });

    it("rejects summary missing provenance field", () => {
      const missingProv = "---\nbasis: source_content\n---\n\nBody";
      expect(() => parseSummaryDocument(missingProv, "/test/path/summary.md")).toThrowError(
        /Invalid or missing summary provenance: 'undefined' in \/test\/path\/summary\.md/,
      );
    });

    it("rejects summary missing basis field (zero tolerant fallback)", () => {
      const missingBasis = "---\nprovenance: host_semantic\n---\n\nBody";
      expect(() => parseSummaryDocument(missingBasis, "/test/path/summary.md")).toThrowError(
        /Invalid or missing summary basis: 'undefined' in \/test\/path\/summary\.md/,
      );
    });

    it("rejects summary with invalid basis value", () => {
      const invalidBasis = "---\nprovenance: host_semantic\nbasis: guessing\n---\n\nBody";
      expect(() => parseSummaryDocument(invalidBasis, "/test/path/summary.md")).toThrowError(
        /Invalid or missing summary basis: 'guessing' in \/test\/path\/summary\.md/,
      );
    });

    it("rejects summary with empty body", () => {
      const emptyBody = "---\nprovenance: host_semantic\nbasis: source_content\n---\n\n   \n";
      expect(() => parseSummaryDocument(emptyBody, "/test/path/summary.md")).toThrowError(
        /Summary body content cannot be empty in \/test\/path\/summary\.md/,
      );
    });
  });
});
