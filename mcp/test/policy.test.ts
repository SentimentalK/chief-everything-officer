import { describe, expect, it } from "vitest";
import { CeoError } from "../src/errors.js";
import { assertContentSize, validatePath } from "../src/policy.js";

describe("path policy", () => {
  it.each([
    "README.md",
    "TODO.md",
    "tasks/INS-001.md",
    "inbox/article.md",
    "tasks/work/deep.md",
    "archive/2026/OLD.md",
    "projects/new-proj.md",
    "sources/book.md",
  ])(
    "allows %s",
    (candidate) => expect(validatePath(candidate)).toBe(candidate),
  );

  it.each([
    "../TODO.md",
    "/etc/passwd",
    "tasks\\evil.md",
    ".git/config",
    ".Git/config",
    ".github/workflows/pwn.yaml",
    "tasks/not-markdown.txt",
    "tasks/cafe\u0301.md",
  ])("rejects %s", (candidate) => {
    expect(() => validatePath(candidate)).toThrow(CeoError);
  });

  it("assertContentSize verifies within limit and throws on excess", () => {
    expect(assertContentSize("hello")).toBe(5);
    const oversized = "x".repeat(10 * 1024 * 1024 + 1);
    expect(() => assertContentSize(oversized)).toThrow(CeoError);
  });
});
