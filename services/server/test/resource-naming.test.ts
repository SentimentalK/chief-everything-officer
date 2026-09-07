import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_DIRECTORY_BYTES,
  MAX_DISPLAY_NAME_CHARS,
  allocateUniqueDirectoryName,
  cleanDisplayName,
  directoryComparisonKey,
  isWindowsReservedName,
  toSafeDirectoryName,
} from "../src/resource/naming.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmpResourcesRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ceo-naming-"));
  cleanupDirs.push(root);
  await mkdir(path.join(root, "resources"), { recursive: true });
  return path.join(root, "resources");
}

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

  describe("Windows reserved names & collision key safety", () => {
    it("detects Windows reserved stems case-insensitively, with and without extension forms", () => {
      for (const reserved of ["CON", "con", "Con", "CON.md", "com1", "COM9.txt", "lpt3", "LPT3.tar.gz", "PRN", "aux", "NUL.dat"]) {
        expect(isWindowsReservedName(reserved), reserved).toBe(true);
      }
      for (const safe of ["CONS", "CON10", "COM0", "AUX1", "CON-2", "console", "COM4K", ""]) {
        expect(isWindowsReservedName(safe), safe).toBe(false);
      }
    });

    it("folds superscript digits like Windows reserved-name matching", () => {
      for (const reserved of ["COM¹", "com².md", "LPT³", "lpt¹.txt"]) {
        expect(isWindowsReservedName(reserved), reserved).toBe(true);
      }
      expect(isWindowsReservedName("COM⁴")).toBe(false);
    });

    it("directoryComparisonKey folds case and NFC normalization", () => {
      expect(directoryComparisonKey("Design")).toBe(directoryComparisonKey("design"));
      expect(directoryComparisonKey("Design")).toBe(directoryComparisonKey("DESIGN"));
      expect(directoryComparisonKey("Café")).toBe(directoryComparisonKey("Café"));
    });

    it("toSafeDirectoryName preserves fullwidth colon U+FF1A while stripping ASCII colon", () => {
      const fullwidth = "人工智能：从入门到精通";
      expect(toSafeDirectoryName(fullwidth)).toBe(fullwidth);
      expect(toSafeDirectoryName("a:b")).toBe("a b");
    });

    it("allocateUniqueDirectoryName prefixes reserved final candidates with underscore, preserving extensions", async () => {
      const root = await tmpResourcesRoot();
      expect(await allocateUniqueDirectoryName(root, "CON")).toBe("_CON");
      expect(await allocateUniqueDirectoryName(root, "CON.md")).toBe("_CON.md");
      expect(await allocateUniqueDirectoryName(root, "COM¹")).toBe("_COM¹");
      expect(await allocateUniqueDirectoryName(root, "com1")).toBe("_com1");
      expect(await allocateUniqueDirectoryName(root, "lpt3")).toBe("_lpt3");
    });

    it("reserved-prefixed candidates stay within MAX_DIRECTORY_BYTES", async () => {
      const root = await tmpResourcesRoot();
      const longReserved = `CON.${"a".repeat(200)}`;
      const result = await allocateUniqueDirectoryName(root, longReserved);
      expect(result.startsWith("_CON.")).toBe(true);
      expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(MAX_DIRECTORY_BYTES);
    });

    it("suffixed candidates of reserved names are not re-prefixed (_CON taken -> CON-2 -> CON-3)", async () => {
      const root = await tmpResourcesRoot();
      await mkdir(path.join(root, "_CON"));
      await mkdir(path.join(root, "CON-2"));
      const result = await allocateUniqueDirectoryName(root, "CON");
      expect(result).toBe("CON-3");
    });

    it("case-variant of an occupied name allocates a suffixed directory", async () => {
      const root = await tmpResourcesRoot();
      await mkdir(path.join(root, "Design"));
      const result = await allocateUniqueDirectoryName(root, "design");
      expect(result).toBe("design-2");
    });

    it("returns the current directory when only case/NFC differs and no other entry occupies the key", async () => {
      const root = await tmpResourcesRoot();
      await mkdir(path.join(root, "Design"));
      // Own directory "Design", renaming display to "design": keep physical dir.
      expect(await allocateUniqueDirectoryName(root, "design", "Design")).toBe("Design");
    });

    it("propagates readdir failures instead of treating an unreadable root as empty", async () => {
      const missing = path.join(await mkdtemp(path.join(os.tmpdir(), "ceo-naming-")), "does-not-exist");
      cleanupDirs.push(path.dirname(missing));
      await expect(allocateUniqueDirectoryName(missing, "CON")).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });
    });
  });
});
