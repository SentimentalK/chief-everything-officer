import { describe, expect, it } from "vitest";
import { LifeOSError } from "../src/errors.js";
import { assertNoSymlink, isAllowedTrackedPath, validateContentPath } from "../src/security.js";

describe("security boundary (validateContentPath)", () => {
  it.each([
    "TODO.md",
    "tasks/INS-001.md",
    "inbox/article.md",
    "knowledge/english/grammar.md",
    "records/2026/finances.md",
    "archive/2026/OLD.md",
  ])("allows content Markdown path: %s", (candidate) => {
    expect(validateContentPath(candidate)).toBe(candidate);
  });

  it.each([
    "../TODO.md",
    "/etc/passwd",
    "tasks\\evil.md",
    ".git/config",
    ".Git/config",
    ".github/workflows/pwn.yaml",
    "mcp/src/server.ts",
    ".env",
    ".env.production",
    ".hidden/file.md",
    "tasks/not-markdown.txt",
    "tasks/cafe\u0301.md", // NFC normalization failure check
  ])("rejects system, code, or traversal path: %s", (candidate) => {
    expect(() => validateContentPath(candidate)).toThrow(LifeOSError);
  });

  it("isAllowedTrackedPath returns true for content files and false for system paths", () => {
    expect(isAllowedTrackedPath("tasks/INS-001.md")).toBe(true);
    expect(isAllowedTrackedPath("mcp/src/server.ts")).toBe(false);
    expect(isAllowedTrackedPath(".git/HEAD")).toBe(false);
  });
});
