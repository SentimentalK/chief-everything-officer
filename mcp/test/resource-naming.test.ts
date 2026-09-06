import { describe, expect, it } from "vitest";
import {
  MAX_DIRECTORY_BYTES,
  MAX_DISPLAY_NAME_CHARS,
  determineInitialDisplayName,
  toSafeDirectoryName,
} from "../src/resource/naming.js";

describe("Resource Naming: display_name selection & filesystem sanitization", () => {
  describe("determineInitialDisplayName priority cascade", () => {
    it("prefers explicit input.display_name over all else", () => {
      const name = determineInitialDisplayName({
        inputDisplayName: "CUDA生态与NVIDIA软件护城河",
        resolverTitle: "Why CUDA Moat is Unbreakable",
        source: { type: "url", url: "https://www.youtube.com/watch?v=12345" },
        originalName: "video.mp4",
      });
      expect(name).toBe("CUDA生态与NVIDIA软件护城河");
    });

    it("uses resolver title when input.display_name is absent", () => {
      const name = determineInitialDisplayName({
        resolverTitle: "Understanding Transformer Attention Heads",
        source: { type: "url", url: "https://example.com/transformer" },
      });
      expect(name).toBe("Understanding Transformer Attention Heads");
    });

    it("uses original filename stem when title is absent", () => {
      const name = determineInitialDisplayName({
        originalName: "annual_report_2025.pdf",
        source: { type: "file_descriptor", filename: "annual_report_2025.pdf" },
      });
      expect(name).toBe("annual_report_2025");
    });

    it("uses external ref when title and filename are absent", () => {
      const name = determineInitialDisplayName({
        source: { type: "external_ref", provider: "arxiv", ref: "2401.12345" },
      });
      expect(name).toBe("2401.12345");
    });

    it("uses source identity or URL path segment when available", () => {
      const name = determineInitialDisplayName({
        sourceIdentity: "bilibili:BV1NCgVzoEG9",
        source: { type: "url", url: "https://www.bilibili.com/video/BV1NCgVzoEG9" },
      });
      expect(name).toBe("BV1NCgVzoEG9");
    });

    it("falls back to 'Untitled Resource' when no meaningful name is derivable", () => {
      const name = determineInitialDisplayName({
        source: { type: "url", url: "https://example.com/" },
      });
      expect(name).toBe("Untitled Resource");
    });

    it("strictly strips superficial provider prefixes", () => {
      expect(
        determineInitialDisplayName({
          inputDisplayName: "Bilibili - 深度学习入门课",
          source: { type: "url", url: "https://example.com" },
        }),
      ).toBe("深度学习入门课");

      expect(
        determineInitialDisplayName({
          resolverTitle: "YouTube - Rick Astley - Never Gonna Give You Up",
          source: { type: "url", url: "https://example.com" },
        }),
      ).toBe("Rick Astley - Never Gonna Give You Up");
    });
  });

  describe("toSafeDirectoryName rules", () => {
    it("preserves Chinese, Japanese, and international Unicode characters in NFC", () => {
      const input = "CUDA生态与NVIDIA软件护城河";
      const safe = toSafeDirectoryName(input);
      expect(safe).toBe("CUDA生态与NVIDIA软件护城河");
      expect(safe.normalize("NFC")).toBe(safe);
    });

    it("replaces path separators, backslashes, control characters, and forbidden symbols", () => {
      const input = 'folder/name\\with:illegal*chars?"<>|and\0null';
      const safe = toSafeDirectoryName(input);
      expect(safe).not.toContain("/");
      expect(safe).not.toContain("\\");
      expect(safe).not.toContain(":");
      expect(safe).not.toContain("*");
      expect(safe).not.toContain("?");
      expect(safe).not.toContain('"');
      expect(safe).not.toContain("<");
      expect(safe).not.toContain(">");
      expect(safe).not.toContain("|");
      expect(safe).not.toContain("\0");
      expect(safe).toBe("folder name with illegal chars and null");
    });

    it("strips leading dots, avoids hidden directories, and strips trailing dots/spaces", () => {
      expect(toSafeDirectoryName("...hidden.dir...")).toBe("hidden.dir");
      expect(toSafeDirectoryName(".")).toBe("Untitled Resource");
      expect(toSafeDirectoryName("..")).toBe("Untitled Resource");
      expect(toSafeDirectoryName("trailing spaces   ")).toBe("trailing spaces");
    });

    it("bounds total length by UTF-8 bytes (<= 180 bytes) without splitting Unicode code points", () => {
      // 3-byte Chinese characters: 70 characters = 210 bytes > 180 bytes
      const chineseStr = "深度学习与大语言模型架构演进全解析及其工程落地实践总结与前沿探索".repeat(3);
      const safe = toSafeDirectoryName(chineseStr);

      const byteLength = Buffer.byteLength(safe, "utf8");
      expect(byteLength).toBeLessThanOrEqual(MAX_DIRECTORY_BYTES);
      // Valid UTF-8 string that decodes cleanly
      expect(Buffer.from(safe, "utf8").toString("utf8")).toBe(safe);
    });

    it("returns 'Untitled Resource' for empty or whitespace-only names", () => {
      expect(toSafeDirectoryName("")).toBe("Untitled Resource");
      expect(toSafeDirectoryName("   ")).toBe("Untitled Resource");
      expect(toSafeDirectoryName("/\\::*?")).toBe("Untitled Resource");
    });
  });
});
