import { describe, expect, it } from "vitest";
import { CeoError } from "../src/errors.js";
import { validateArchive, validatePath } from "../src/policy.js";

describe("path policy", () => {
  it.each(["TODO.md", "tasks/INS-001.md", "inbox/article.md", "tasks/work/deep.md", "archive/2026/OLD.md"])(
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
    "mcp/src/server.ts",
    "tasks/not-markdown.txt",
    "tasks/cafe\u0301.md",
  ])("rejects %s", (candidate) => {
    expect(() => validatePath(candidate)).toThrow(CeoError);
  });

  it("only permits valid archive route from tasks/ to archive/ directory", () => {
    expect(() => validateArchive("tasks/TEST-001.md", "archive/2026/TEST-001.md")).not.toThrow();
    expect(() => validateArchive("tasks/group/TEST-001.md", "archive/2026/group/TEST-001.md")).not.toThrow();
    expect(() => validateArchive("inbox/ARTICLE.md", "archive/2026/ARTICLE.md")).toThrow(CeoError);
    expect(() => validateArchive("SYSTEM.md", "archive/SYSTEM.md")).toThrow(CeoError);
    expect(() => validateArchive("archive/2026/TEST-001.md", "archive/2027/TEST-001.md")).toThrow(CeoError);
    expect(() => validateArchive("tasks/TEST-001.md", "tasks/TEST-002.md")).toThrow(CeoError);
  });
});
