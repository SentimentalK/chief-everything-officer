import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CeoWorkspace, normalizeListPrefix } from "../src/workspace.js";
import { git } from "./helpers.js";
import type { Config } from "../src/config.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function createHierarchyFixture(): Promise<{ workspace: CeoWorkspace; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ceo-list-test-"));
  cleanupDirs.push(root);
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const dataRoot = path.join(root, "data");

  await mkdir(remote);
  git(remote, "init", "--bare", "--initial-branch=main");

  await mkdir(seed);
  git(seed, "init", "--initial-branch=main");

  await writeFile(path.join(seed, "README.md"), "# Readme\n");
  await writeFile(path.join(seed, "JOURNAL.md"), "# Journal\n");

  await mkdir(path.join(seed, "personal"), { recursive: true });
  await writeFile(path.join(seed, "personal", "a.md"), "# A\n");
  await writeFile(path.join(seed, "personal", "b.md"), "# B\n");

  await mkdir(path.join(seed, "tasks"), { recursive: true });
  await writeFile(path.join(seed, "tasks", "TASK-1.md"), "# Task 1\n");

  await mkdir(path.join(seed, "inbox", "game"), { recursive: true });
  await writeFile(path.join(seed, "inbox", "article.md"), "# Article\n");
  await writeFile(path.join(seed, "inbox", "game", "video.md"), "# Video\n");

  // Ignored paths
  await mkdir(path.join(seed, "ignored"), { recursive: true });
  await writeFile(path.join(seed, "ignored", "secret.md"), "# Secret\n");
  await writeFile(path.join(seed, "top-secret.md"), "# Top Secret\n");
  await writeFile(path.join(seed, ".ceoignore"), "ignored/\ntop-secret.md\n");

  git(seed, "add", "-A");
  git(seed, "commit", "-m", "initial hierarchy");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");

  const config: Config = {
    dataRoot,
    repoDir: path.join(dataRoot, "repo"),
    txnDir: path.join(dataRoot, "txns"),
    stateDir: path.join(dataRoot, "state"),
    branch: "main",
    remoteUrl: remote,
    port: 3000,
    bindHost: "127.0.0.1",
    gitAuthorName: "Test",
    gitAuthorEmail: "test@example.com",
    gitCommitterName: "Test Committer",
    gitCommitterEmail: "committer@example.com",
    allowedHosts: ["localhost", "127.0.0.1"],
    allowedOrigins: [],
    auditDir: path.join(dataRoot, "audit"),
    auditDbPath: path.join(dataRoot, "audit", "trace.sqlite"),
  };

  const workspace = new CeoWorkspace(config);
  await workspace.initialize();
  return { workspace, root };
}

describe("Hierarchical & Bounded list_files (v0.2.1)", () => {
  it("normalizeListPrefix handles slashes and trims correctly", () => {
    expect(normalizeListPrefix("")).toBe("");
    expect(normalizeListPrefix("   ")).toBe("");
    expect(normalizeListPrefix("inbox")).toBe("inbox/");
    expect(normalizeListPrefix("inbox/")).toBe("inbox/");
    expect(normalizeListPrefix("personal/sub")).toBe("personal/sub/");
    expect(normalizeListPrefix("personal/sub/")).toBe("personal/sub/");
  });

  it("list_files() default returns root directories + README/JOURNAL only (no personal/a.md)", async () => {
    const { workspace } = await createHierarchyFixture();
    const res = await workspace.listFiles();

    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(false);
    expect(res.directories).toEqual(["inbox/", "personal/", "tasks/"]);

    const filePaths = (res.files as any[]).map((f) => f.path);
    expect(filePaths).toEqual(["JOURNAL.md", "README.md"]);
    expect(filePaths).not.toContain("personal/a.md");
    expect(filePaths).not.toContain("tasks/TASK-1.md");
    expect(filePaths).not.toContain("inbox/article.md");
  });

  it("list_files(prefix='personal/') returns a.md and b.md without tasks/TASK-1.md", async () => {
    const { workspace } = await createHierarchyFixture();
    const res = await workspace.listFiles("personal/");

    expect(res.ok).toBe(true);
    expect(res.directories).toEqual([]);
    const filePaths = (res.files as any[]).map((f) => f.path);
    expect(filePaths).toEqual(["personal/a.md", "personal/b.md"]);
    expect(filePaths).not.toContain("tasks/TASK-1.md");
  });

  it("list_files(prefix='personal') normalizes to directory scope and matches personal/ strictly", async () => {
    const { workspace } = await createHierarchyFixture();
    const res = await workspace.listFiles("personal");

    expect(res.ok).toBe(true);
    expect(res.directories).toEqual([]);
    const filePaths = (res.files as any[]).map((f) => f.path);
    expect(filePaths).toEqual(["personal/a.md", "personal/b.md"]);
  });

  it("list_files(prefix='inbox/') returns article.md + game/ directory without video.md", async () => {
    const { workspace } = await createHierarchyFixture();
    const res = await workspace.listFiles("inbox/");

    expect(res.ok).toBe(true);
    expect(res.directories).toEqual(["inbox/game/"]);
    const filePaths = (res.files as any[]).map((f) => f.path);
    expect(filePaths).toEqual(["inbox/article.md"]);
    expect(filePaths).not.toContain("inbox/game/video.md");
  });

  it("list_files(prefix='inbox/game/') returns video.md", async () => {
    const { workspace } = await createHierarchyFixture();
    const res = await workspace.listFiles("inbox/game/");

    expect(res.ok).toBe(true);
    expect(res.directories).toEqual([]);
    const filePaths = (res.files as any[]).map((f) => f.path);
    expect(filePaths).toEqual(["inbox/game/video.md"]);
  });

  it("list_files(recursive=true) makes descendant Markdown files visible across workspace", async () => {
    const { workspace } = await createHierarchyFixture();
    const res = await workspace.listFiles("", true);

    expect(res.ok).toBe(true);
    expect(res.directories).toEqual([]);
    const filePaths = (res.files as any[]).map((f) => f.path);
    expect(filePaths).toEqual([
      "inbox/article.md",
      "inbox/game/video.md",
      "JOURNAL.md",
      "personal/a.md",
      "personal/b.md",
      "README.md",
      "tasks/TASK-1.md",
    ]);
  });

  it(".ceoignore paths are invisible in shallow, scoped, and recursive modes", async () => {
    const { workspace } = await createHierarchyFixture();

    // 1. Shallow root
    const shallow = await workspace.listFiles();
    expect(shallow.directories).not.toContain("ignored/");
    const shallowPaths = (shallow.files as any[]).map((f) => f.path);
    expect(shallowPaths).not.toContain("top-secret.md");

    // 2. Scoped to ignored dir
    const scoped = await workspace.listFiles("ignored/");
    expect(scoped.directories).toEqual([]);
    expect(scoped.files).toEqual([]);

    // 3. Recursive
    const recursive = await workspace.listFiles("", true);
    const recPaths = (recursive.files as any[]).map((f) => f.path);
    expect(recPaths).not.toContain("top-secret.md");
    expect(recPaths).not.toContain("ignored/secret.md");
  });

  it("deterministic combined limit slices sorted unified entries", async () => {
    const { workspace } = await createHierarchyFixture();
    // At root, unified entries sorted by path (localeCompare) are:
    // 1. inbox/ (directory)
    // 2. JOURNAL.md (file)
    // 3. personal/ (directory)
    // 4. README.md (file)
    // 5. tasks/ (directory)
    // If limit = 3: should take first 3 entries (inbox/, JOURNAL.md, personal/)
    const res = await workspace.listFiles("", false, 3);
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.directories).toEqual(["inbox/", "personal/"]);
    const filePaths = (res.files as any[]).map((f) => f.path);
    expect(filePaths).toEqual(["JOURNAL.md"]);
  });
});
