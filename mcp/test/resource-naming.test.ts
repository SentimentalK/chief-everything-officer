import { describe, expect, it } from "vitest";
import {
  MAX_DIRECTORY_BYTES,
  MAX_DISPLAY_NAME_CHARS,
  cleanDisplayName,
  toSafeDirectoryName,
} from "../src/resource/naming.js";

describe("Resource Naming: display_name selection & filesystem sanitization", () => {
  describe("cleanDisplayName", () => {
    it("strictly strips superficial provider prefixes", () => {
      expect(cleanDisplayName("Bilibili - 深度学习入门课")).toBe("深度学习入门课");
      expect(cleanDisplayName("YouTube - Rick Astley - Never Gonna Give You Up")).toBe("Rick Astley - Never Gonna Give You Up");
      expect(cleanDisplayName("web: Article Title")).toBe("Article Title");
      expect(cleanDisplayName("PDF - Whitepaper 2026")).toBe("Whitepaper 2026");
    });

    it("collapses internal whitespace and trims outer whitespace", () => {
      expect(cleanDisplayName("   Title   with   excessive   spaces   ")).toBe("Title with excessive spaces");
    });

    it("bounds display_name to MAX_DISPLAY_NAME_CHARS code points", () => {
      const longName = "字".repeat(200);
      const cleaned = cleanDisplayName(longName);
      expect(Array.from(cleaned).length).toBe(MAX_DISPLAY_NAME_CHARS);
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
