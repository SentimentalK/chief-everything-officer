import { randomUUID } from "node:crypto";
import { chmod, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CeoError } from "../src/errors.js";
import { CeoWorkspace } from "../src/workspace.js";
import { fixture, git } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CeoWorkspace", () => {
  it("reads allowlisted files and hides code paths", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const shallow = await workspace.listFiles();
    expect(shallow.directories).toEqual(["inbox/", "tasks/"]);
    expect((shallow.files as any[]).map((f) => f.path)).toEqual(expect.arrayContaining(["TODO.md"]));

    const listed = await workspace.listFiles("", true);
    expect(listed.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "TODO.md" }),
      expect.objectContaining({ path: "tasks/TEST-001.md" }),
      expect.objectContaining({ path: "inbox/测试文章.md" }),
    ]));
    const read = await workspace.readFiles(["TODO.md", "inbox/测试文章.md"]);
    expect(read.base_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(read.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "TODO.md", content: "# TODO\n\n- Original\n" }),
      expect.objectContaining({ path: "inbox/测试文章.md", content: "# 测试文章\n" }),
    ]));
    const search = await workspace.searchText("测试", [], 10);
    expect(search.matches).toEqual([
      expect.objectContaining({ path: "inbox/测试文章.md", line: 1, snippet: "# 测试文章" }),
    ]);
    await expect(workspace.readFiles(["mcp/package.json"])).rejects.toMatchObject({ code: "INVALID_PATH" });
  });

  it("commits and pushes one atomic, idempotent change set with replace and append", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const read = await workspace.readFiles(["TODO.md", "JOURNAL.md"]);
    const files = read.files as Array<{ path: string; blob_oid: string }>;
    const todo = files.find((file) => file.path === "TODO.md")!;
    const journal = files.find((file) => file.path === "JOURNAL.md")!;
    const requestId = randomUUID();
    const input = {
      request_id: requestId,
      base_commit: read.base_commit as string,
      summary: "Update test plan",
      operations: [
        { op: "replace" as const, path: "TODO.md", expected_blob_oid: todo.blob_oid, content: "# TODO\n\n- Updated\n" },
        { op: "append" as const, path: "JOURNAL.md", expected_blob_oid: journal.blob_oid, content: "\n- Updated test plan.\n" },
      ],
    };
    const first = await workspace.applyChangeSet(input);
    const second = await workspace.applyChangeSet(input);
    expect(first.commit).toBe(second.commit);
    expect(first.changed_files).toEqual(["JOURNAL.md", "TODO.md"]);
    expect(git(item.remote, "show", "main:TODO.md")).toContain("Updated");
    expect(git(item.remote, "rev-list", "--count", "main")).toBe("2");
  });

  it("supports create on arbitrary Markdown area and append on non-journal file", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const status = await workspace.workspaceStatus();

    // 1. Create in new area 'projects/'
    const createRes = await workspace.applyChangeSet({
      base_commit: status.remote_commit as string,
      summary: "Create project document",
      operations: [{
        op: "create",
        path: "projects/alpha.md",
        content: "# Project Alpha\n\nInitial plan.\n",
      }],
    });
    expect(createRes.ok).toBe(true);

    // 2. Read and append to projects/alpha.md
    const read = await workspace.readFiles(["projects/alpha.md"]);
    const alphaFile = (read.files as Array<{ path: string; blob_oid: string }>)[0]!;

    const appendRes = await workspace.applyChangeSet({
      base_commit: read.base_commit as string,
      summary: "Append milestone to project",
      operations: [{
        op: "append",
        path: "projects/alpha.md",
        expected_blob_oid: alphaFile.blob_oid,
        content: "## Milestone 1\nDone.\n",
      }],
    });
    expect(appendRes.ok).toBe(true);

    const reRead = await workspace.readFiles(["projects/alpha.md"]);
    expect((reRead.files as any[])[0].content).toContain("## Milestone 1\nDone.\n");
  });

  it("supports generic move of safe Markdown and rejects overwrite or moving to ignored path", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const read = await workspace.readFiles(["tasks/TEST-001.md"]);
    const file = (read.files as Array<{ blob_oid: string }>)[0]!;

    // 1. Valid move
    const moveRes = await workspace.applyChangeSet({
      base_commit: read.base_commit as string,
      summary: "Archive test ticket via generic move",
      operations: [{
        op: "move",
        path: "tasks/TEST-001.md",
        expected_blob_oid: file.blob_oid,
        target: "archive/2026/TEST-001.md",
      }],
    });
    expect(moveRes.ok).toBe(true);
    expect(git(item.remote, "show", "main:archive/2026/TEST-001.md")).toContain("TEST-001");
    expect(() => git(item.remote, "show", "main:tasks/TEST-001.md")).toThrow();

    // 2. Reject moving over existing target
    const readAgain = await workspace.readFiles(["archive/2026/TEST-001.md", "TODO.md"]);
    const archived = (readAgain.files as any[]).find((f) => f.path === "archive/2026/TEST-001.md")!;
    await expect(workspace.applyChangeSet({
      base_commit: readAgain.base_commit as string,
      summary: "Try moving over existing TODO.md",
      operations: [{
        op: "move",
        path: "archive/2026/TEST-001.md",
        expected_blob_oid: archived.blob_oid,
        target: "TODO.md",
      }],
    })).rejects.toMatchObject({ code: "INVALID_OPERATION" });
  });

  it("supports delete with fresh blob OID and rejects stale blob OID", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const read = await workspace.readFiles(["TODO.md"]);
    const file = (read.files as Array<{ blob_oid: string }>)[0]!;

    // Reject delete with stale blob OID
    await expect(workspace.applyChangeSet({
      base_commit: read.base_commit as string,
      summary: "Delete with stale oid",
      operations: [{
        op: "delete",
        path: "TODO.md",
        expected_blob_oid: "0".repeat(40),
      }],
    })).rejects.toMatchObject({ code: "BLOB_MISMATCH" });

    // Succeed delete with fresh blob OID
    const delRes = await workspace.applyChangeSet({
      base_commit: read.base_commit as string,
      summary: "Delete TODO.md",
      operations: [{
        op: "delete",
        path: "TODO.md",
        expected_blob_oid: file.blob_oid,
      }],
    });
    expect(delRes.ok).toBe(true);
    expect(() => git(item.remote, "show", "main:TODO.md")).toThrow();
  });

  it("respects .ceoignore: excludes paths from list, read, search, and rejects write operations", async () => {
    const item = await fixture();
    cleanup.push(item.root);

    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    // Create a .ceoignore and an ignored directory in repo
    const ignoreFile = path.join(item.config.repoDir, ".ceoignore");
    await writeFile(ignoreFile, "mcp/\nignored-notes/\nsecret.md\n", "utf8");

    const ignoredDir = path.join(item.config.repoDir, "ignored-notes");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(ignoredDir, { recursive: true }));
    await writeFile(path.join(ignoredDir, "hidden.md"), "# Hidden\n", "utf8");
    await writeFile(path.join(item.config.repoDir, "secret.md"), "# Secret\n", "utf8");

    git(item.config.repoDir, "add", ".");
    git(item.config.repoDir, "commit", "-m", "add .ceoignore and ignored files");
    git(item.config.repoDir, "push", "origin", "main");

    // 1. listFiles excludes ignored files in both shallow and recursive modes
    const shallow = await workspace.listFiles();
    expect(shallow.directories).not.toContain("ignored-notes/");
    expect((shallow.files as any[]).map((f) => f.path)).not.toContain("secret.md");

    const listed = await workspace.listFiles("", true);
    const paths = (listed.files as any[]).map((f) => f.path);
    expect(paths).not.toContain("ignored-notes/hidden.md");
    expect(paths).not.toContain("secret.md");

    // 2. readFiles rejects ignored files with ACCESS_DENIED
    await expect(workspace.readFiles(["ignored-notes/hidden.md"])).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(workspace.readFiles(["secret.md"])).rejects.toMatchObject({ code: "ACCESS_DENIED" });

    // 3. searchText does not match inside ignored files
    const search = await workspace.searchText("Hidden", [], 10);
    expect(search.matches).toEqual([]);

    // 4. applyChangeSet rejects create into ignored path
    const status = await workspace.workspaceStatus();
    await expect(workspace.applyChangeSet({
      base_commit: status.remote_commit as string,
      summary: "Try writing to ignored directory",
      operations: [{
        op: "create",
        path: "ignored-notes/new.md",
        content: "forbidden",
      }],
    })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it(".ceoignore fails closed on non-ENOENT read errors without exposing raw error strings", async () => {
    const item = await fixture();
    cleanup.push(item.root);

    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    // Create .ceoignore as a directory to trigger EISDIR when reading as file
    const ignoreDir = path.join(item.config.repoDir, ".ceoignore");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(ignoreDir, { recursive: true }));

    await expect(workspace.listFiles()).rejects.toMatchObject({
      code: "NOT_READY",
      message: "Failed to read .ceoignore access boundary file.",
      details: { code: "EISDIR" },
    });
  });

  it("rejects stale revisions after another writer advances main", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const read = await workspace.readFiles(["TODO.md"]);
    const file = (read.files as Array<{ blob_oid: string }>)[0]!;

    const other = path.join(item.root, "other");
    git(item.root, "clone", item.remote, other);
    await readFile(path.join(other, "TODO.md"), "utf8");
    await import("node:fs/promises").then(({ appendFile }) => appendFile(path.join(other, "TODO.md"), "\nExternal\n"));
    git(other, "add", "TODO.md");
    git(other, "commit", "-m", "external");
    git(other, "push", "origin", "main");

    await expect(workspace.applyChangeSet({
      base_commit: read.base_commit as string,
      summary: "Stale update",
      operations: [{ op: "replace", path: "TODO.md", expected_blob_oid: file.blob_oid, content: "stale\n" }],
    })).rejects.toBeInstanceOf(CeoError);
    await expect(workspace.applyChangeSet({
      base_commit: read.base_commit as string,
      summary: "Stale update",
      operations: [{ op: "replace", path: "TODO.md", expected_blob_oid: file.blob_oid, content: "stale\n" }],
    })).rejects.toMatchObject({ code: "STALE_REVISION" });
  });

  it("persists a commit after push failure and safely recovers it", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const read = await workspace.readFiles(["TODO.md"]);
    const file = (read.files as Array<{ blob_oid: string }>)[0]!;
    const hook = path.join(item.remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    await expect(workspace.applyChangeSet({
      base_commit: read.base_commit as string,
      summary: "Recover interrupted push",
      operations: [{ op: "replace", path: "TODO.md", expected_blob_oid: file.blob_oid, content: "# Recovered\n" }],
    })).rejects.toMatchObject({ code: "PUSH_PENDING" });

    await unlink(hook);
    const status = await workspace.workspaceStatus();
    expect(status.workspace_state).toBe("READY");
    expect(git(item.remote, "show", "main:TODO.md")).toBe("# Recovered");
    expect(git(item.remote, "rev-list", "--count", "main")).toBe("2");
  });

  it("rejects a mismatched blob without changing remote history", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const status = await workspace.workspaceStatus();
    await expect(workspace.applyChangeSet({
      base_commit: status.remote_commit as string,
      summary: "Reject bad blob",
      operations: [{
        op: "replace",
        path: "TODO.md",
        expected_blob_oid: "0".repeat(40),
        content: "# Must not land\n",
      }],
    })).rejects.toMatchObject({ code: "BLOB_MISMATCH" });
    expect(git(item.remote, "rev-list", "--count", "main")).toBe("1");
  });
});
