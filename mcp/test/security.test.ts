import { describe, expect, it } from "vitest";
import { CeoError } from "../src/errors.js";
import { assertNoSymlink, isAllowedTrackedPath, validateContentPath } from "../src/security.js";
import { symlink, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("security boundary (validateContentPath)", () => {
  it.each([
    "README.md",
    "TODO.md",
    "tasks/INS-001.md",
    "inbox/article.md",
    "knowledge/english/grammar.md",
    "records/2026/finances.md",
    "archive/2026/OLD.md",
    "projects/ceo.md",
    "arbitrary/new-area/file.md",
    "whatever/deep/nested/structure/doc.md",
  ])("allows safe Markdown path: %s", (candidate) => {
    expect(validateContentPath(candidate)).toBe(candidate);
  });

  it.each([
    "../TODO.md",
    "../outside.md",
    "/etc/passwd",
    "tasks\\evil.md",
    ".git/config",
    ".Git/config",
    ".github/workflows/pwn.yaml",
    ".env",
    ".env.production",
    ".foo/test.md",
    "foo/.cache/test.md",
    "foo/data.json",
    ".hidden/file.md",
    "tasks/not-markdown.txt",
    "tasks/cafe\u0301.md", // NFC normalization failure check
  ])("rejects system, hidden, non-md, or traversal path: %s", (candidate) => {
    expect(() => validateContentPath(candidate)).toThrow(CeoError);
  });

  it("isAllowedTrackedPath returns true for safe markdown and false for system paths", () => {
    expect(isAllowedTrackedPath("tasks/INS-001.md")).toBe(true);
    expect(isAllowedTrackedPath("arbitrary/new-area/file.md")).toBe(true);
    expect(isAllowedTrackedPath("foo/data.json")).toBe(false);
    expect(isAllowedTrackedPath(".git/HEAD")).toBe(false);
    expect(isAllowedTrackedPath("foo/.cache/test.md")).toBe(false);
  });

  it("assertNoSymlink detects and rejects symlinks", async () => {
    const testDir = path.join(tmpdir(), `ceo-symlink-test-${Date.now()}`);
    await mkdir(path.join(testDir, "real"), { recursive: true });
    await symlink(path.join(testDir, "real"), path.join(testDir, "linked-dir"));

    await expect(assertNoSymlink(testDir, "linked-dir/file.md")).rejects.toThrow(CeoError);
    await rm(testDir, { recursive: true, force: true });
  });
});
