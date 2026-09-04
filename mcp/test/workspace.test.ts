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
    const listed = await workspace.listFiles();
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

  it("commits and pushes one atomic, idempotent change set", async () => {
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

  it("archives without exposing a general move or delete", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const read = await workspace.readFiles(["tasks/TEST-001.md"]);
    const file = (read.files as Array<{ blob_oid: string }>)[0]!;
    await workspace.applyChangeSet({
      base_commit: read.base_commit as string,
      summary: "Archive test ticket",
      operations: [{
        op: "archive",
        path: "tasks/TEST-001.md",
        expected_blob_oid: file.blob_oid,
        target: "archive/2026/TEST-001.md",
      }],
    });
    expect(git(item.remote, "show", "main:archive/2026/TEST-001.md")).toContain("TEST-001");
    expect(() => git(item.remote, "show", "main:tasks/TEST-001.md")).toThrow();
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
