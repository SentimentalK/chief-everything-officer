import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { CeoError } from "../src/errors.js";
import { createMcpServer } from "../src/mcp.js";
import { loadProductPolicy } from "../src/product-policy.js";
import { ResourceService } from "../src/resource/service.js";
import { CeoWorkspace, type ChangeOperation } from "../src/workspace.js";
import { fixture, git } from "./helpers.js";

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function openWorkspace(): Promise<{ item: Fixture; workspace: CeoWorkspace }> {
  const item = await fixture();
  cleanupDirs.push(item.root);
  const workspace = new CeoWorkspace(item.config);
  await workspace.initialize();
  return { item, workspace };
}

async function readOne(workspace: CeoWorkspace, filePath: string): Promise<{ base_commit: string; blob_oid: string; content: string }> {
  const read = await workspace.readFiles([filePath]);
  const file = (read.files as Array<{ blob_oid: string; content: string }>)[0]!;
  return { base_commit: read.base_commit as string, blob_oid: file.blob_oid, content: file.content };
}

async function applyOne(workspace: CeoWorkspace, operation: ChangeOperation, base?: string): Promise<Record<string, unknown>> {
  const baseCommit = base ?? (await workspace.readFiles(["TODO.md"])).base_commit as string;
  return await workspace.applyChangeSet({ base_commit: baseCommit, summary: `${operation.op} ${operation.path}`, operations: [operation] });
}

async function appendTo(workspace: CeoWorkspace, filePath: string, content: string): Promise<Record<string, unknown>> {
  const file = await readOne(workspace, filePath);
  return await workspace.applyChangeSet({
    base_commit: file.base_commit,
    summary: `append ${filePath}`,
    operations: [{ op: "append", path: filePath, expected_blob_oid: file.blob_oid, content }],
  });
}

async function captureError(promise: Promise<unknown>): Promise<CeoError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CeoError) return error;
    throw error;
  }
  throw new Error("Expected the operation to fail with CeoError.");
}

describe("patch operation", { timeout: 30_000 }, () => {
  it("replaces the unique fragment in place and pushes the result", async () => {
    const { item, workspace } = await openWorkspace();
    const file = await readOne(workspace, "TODO.md");

    const result = await workspace.applyChangeSet({
      base_commit: file.base_commit,
      summary: "Patch TODO",
      operations: [{ op: "patch", path: "TODO.md", expected_blob_oid: file.blob_oid, find: "- Original", replace: "- Patched" }],
    });

    expect(result.ok).toBe(true);
    expect(result.changed_files).toEqual(["TODO.md"]);
    expect(git(item.remote, "show", "main:TODO.md")).toBe("# TODO\n\n- Patched");
  });

  it("rejects zero and multiple matches with the actual match_count and leaves the file unchanged", async () => {
    const { item, workspace } = await openWorkspace();
    const file = await readOne(workspace, "TODO.md");

    const missing = await captureError(workspace.applyChangeSet({
      base_commit: file.base_commit,
      summary: "Patch missing fragment",
      operations: [{ op: "patch", path: "TODO.md", expected_blob_oid: file.blob_oid, find: "- Absent", replace: "- X" }],
    }));
    expect(missing.code).toBe("INVALID_OPERATION");
    expect(missing.details.match_count).toBe(0);

    // "# TODO\n\n- Original\n" contains "O" in "TODO" twice and in "Original" once.
    const ambiguous = await captureError(workspace.applyChangeSet({
      base_commit: file.base_commit,
      summary: "Patch ambiguous fragment",
      operations: [{ op: "patch", path: "TODO.md", expected_blob_oid: file.blob_oid, find: "O", replace: "0" }],
    }));
    expect(ambiguous.code).toBe("INVALID_OPERATION");
    expect(ambiguous.details.match_count).toBe(3);

    expect(git(item.remote, "show", "main:TODO.md")).toBe("# TODO\n\n- Original");
  });

  it("applies several patches to one path in order against the shared base blob", async () => {
    const { item, workspace } = await openWorkspace();
    const file = await readOne(workspace, "TODO.md");

    const result = await workspace.applyChangeSet({
      base_commit: file.base_commit,
      summary: "Two ordered patches",
      operations: [
        { op: "patch", path: "TODO.md", expected_blob_oid: file.blob_oid, find: "- Original", replace: "- Step one" },
        // Only matches after the first patch has been applied.
        { op: "patch", path: "TODO.md", expected_blob_oid: file.blob_oid, find: "Step one", replace: "Step two" },
        { op: "patch", path: "TODO.md", expected_blob_oid: file.blob_oid, find: "# TODO\n\n", replace: "" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(git(item.remote, "show", "main:TODO.md")).toBe("- Step two");
  });

  it("rejects mixing patch with any other operation on the same path", async () => {
    const { item, workspace } = await openWorkspace();
    const file = await readOne(workspace, "TODO.md");

    for (const operations of [
      [
        { op: "patch", path: "TODO.md", expected_blob_oid: file.blob_oid, find: "- Original", replace: "- A" },
        { op: "replace", path: "TODO.md", expected_blob_oid: file.blob_oid, content: "# TODO\n" },
      ],
      [
        { op: "replace", path: "TODO.md", expected_blob_oid: file.blob_oid, content: "# TODO\n" },
        { op: "patch", path: "TODO.md", expected_blob_oid: file.blob_oid, find: "# TODO", replace: "# Done" },
      ],
    ] satisfies ChangeOperation[][]) {
      const error = await captureError(workspace.applyChangeSet({ base_commit: file.base_commit, summary: "Mixed ops", operations }));
      expect(error.code).toBe("INVALID_OPERATION");
      expect(error.details).toMatchObject({ path: "TODO.md", reason: "PATCH_EXCLUSIVE_PATH" });
    }
    expect(git(item.remote, "show", "main:TODO.md")).toBe("# TODO\n\n- Original");
  });

  it("rejects a stale expected_blob_oid with BLOB_MISMATCH", async () => {
    const { item, workspace } = await openWorkspace();
    const stale = await readOne(workspace, "TODO.md");
    await workspace.applyChangeSet({
      base_commit: stale.base_commit,
      summary: "Concurrent replace",
      operations: [{ op: "replace", path: "TODO.md", expected_blob_oid: stale.blob_oid, content: "# TODO\n\n- Original\n- Added\n" }],
    });
    const fresh = await readOne(workspace, "TODO.md");

    const error = await captureError(workspace.applyChangeSet({
      base_commit: fresh.base_commit,
      summary: "Patch with stale blob",
      operations: [{ op: "patch", path: "TODO.md", expected_blob_oid: stale.blob_oid, find: "- Added", replace: "- Changed" }],
    }));

    expect(error.code).toBe("BLOB_MISMATCH");
    expect(git(item.remote, "show", "main:TODO.md")).toBe("# TODO\n\n- Original\n- Added");
  });

  it("rejects a rules/*.md patch whose result no longer parses as a workspace rule", async () => {
    const { item, workspace } = await openWorkspace();
    const created = await applyOne(workspace, { op: "create", path: "rules/journal.md", content: "---\nmode: extend\n---\n\nKeep entries short.\n" });
    expect(created.ok).toBe(true);
    const rule = await readOne(workspace, "rules/journal.md");

    const broken = await captureError(workspace.applyChangeSet({
      base_commit: rule.base_commit,
      summary: "Break rule mode",
      operations: [{ op: "patch", path: "rules/journal.md", expected_blob_oid: rule.blob_oid, find: "mode: extend", replace: "mode: merge" }],
    }));
    expect(broken.code).toBe("VALIDATION_FAILED");
    expect(broken.details.reason).toBe("UNSUPPORTED_MODE");
    expect(git(item.remote, "show", "main:rules/journal.md")).toContain("mode: extend");
  });
});

describe("area write_mode", { timeout: 30_000 }, () => {
  it("rejects append in runtime-default state areas while root files and stream areas still append", async () => {
    const { item, workspace } = await openWorkspace();

    const error = await captureError(appendTo(workspace, "tasks/TEST-001.md", "\n## Update\nDone.\n"));
    expect(error.code).toBe("INVALID_OPERATION");
    expect(error.details).toMatchObject({ path: "tasks/TEST-001.md", area: "tasks", write_mode: "state", reason: "APPEND_NOT_ALLOWED" });
    expect(error.details.use).toContain("patch");
    expect(error.details.use).toContain("replace");
    expect(error.message).toMatch(/patch/);
    expect(error.message).toMatch(/new file/);
    expect(git(item.remote, "show", "main:tasks/TEST-001.md")).toBe("# TEST-001");

    expect((await appendTo(workspace, "JOURNAL.md", "- Root entry\n")).ok).toBe(true);
    expect((await appendTo(workspace, "inbox/测试文章.md", "- Inbox entry\n")).ok).toBe(true);
    expect(git(item.remote, "show", "main:JOURNAL.md")).toContain("- Root entry");
    expect(git(item.remote, "show", "main:inbox/测试文章.md")).toContain("- Inbox entry");
  });

  it("lets rules/<area>.md write_mode override the runtime default in both directions", async () => {
    const { workspace } = await openWorkspace();

    expect((await captureError(appendTo(workspace, "tasks/TEST-001.md", "- before rule\n"))).details.reason).toBe("APPEND_NOT_ALLOWED");
    expect((await applyOne(workspace, {
      op: "create",
      path: "rules/tasks.md",
      content: "---\nmode: extend\nwrite_mode: stream\n---\n\nTasks keep an append-only log.\n",
    })).ok).toBe(true);
    expect((await appendTo(workspace, "tasks/TEST-001.md", "- after rule\n")).ok).toBe(true);

    expect((await appendTo(workspace, "inbox/测试文章.md", "- before rule\n")).ok).toBe(true);
    expect((await applyOne(workspace, {
      op: "create",
      path: "rules/inbox.md",
      content: "---\nmode: extend\nwrite_mode: state\n---\n\nInbox items hold current values.\n",
    })).ok).toBe(true);
    const inboxError = await captureError(appendTo(workspace, "inbox/测试文章.md", "- after rule\n"));
    expect(inboxError.code).toBe("INVALID_OPERATION");
    expect(inboxError.details).toMatchObject({ area: "inbox", reason: "APPEND_NOT_ALLOWED" });

    // patch and replace remain available in state areas.
    const inbox = await readOne(workspace, "inbox/测试文章.md");
    expect((await workspace.applyChangeSet({
      base_commit: inbox.base_commit,
      summary: "Patch inbox",
      operations: [{ op: "patch", path: "inbox/测试文章.md", expected_blob_oid: inbox.blob_oid, find: "- before rule", replace: "- current value" }],
    })).ok).toBe(true);
  });

  it("rejects writing an invalid write_mode through create and patch", async () => {
    const { item, workspace } = await openWorkspace();

    const created = await captureError(applyOne(workspace, {
      op: "create",
      path: "rules/tasks.md",
      content: "---\nmode: extend\nwrite_mode: bogus\n---\n\nBody.\n",
    }));
    expect(created.code).toBe("VALIDATION_FAILED");
    expect(created.details).toMatchObject({ path: "rules/tasks.md", reason: "UNSUPPORTED_WRITE_MODE" });

    expect((await applyOne(workspace, {
      op: "create",
      path: "rules/inbox.md",
      content: "---\nmode: extend\nwrite_mode: stream\n---\n\nBody.\n",
    })).ok).toBe(true);
    const rule = await readOne(workspace, "rules/inbox.md");
    const patched = await captureError(workspace.applyChangeSet({
      base_commit: rule.base_commit,
      summary: "Patch invalid write_mode",
      operations: [{ op: "patch", path: "rules/inbox.md", expected_blob_oid: rule.blob_oid, find: "write_mode: stream", replace: "write_mode: bogus" }],
    }));
    expect(patched.code).toBe("VALIDATION_FAILED");
    expect(patched.details.reason).toBe("UNSUPPORTED_WRITE_MODE");
    expect(git(item.remote, "show", "main:rules/inbox.md")).toContain("write_mode: stream");
  });

  it("treats an existing invalid write_mode as the runtime default when reading", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    // A rule that already carries an invalid value, pushed outside CEO.
    const outside = path.join(item.root, "outside");
    git(item.root, "clone", item.remote, outside);
    await mkdir(path.join(outside, "rules"), { recursive: true });
    for (const area of ["tasks", "inbox"]) {
      await writeFile(path.join(outside, "rules", `${area}.md`), "---\nmode: extend\nwrite_mode: bogus\n---\n\nBody.\n");
    }
    git(outside, "add", "-A");
    git(outside, "commit", "-m", "outside rules");
    git(outside, "push", "origin", "main");
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const fallback = await captureError(appendTo(workspace, "tasks/TEST-001.md", "- entry\n"));
    expect(fallback.details).toMatchObject({ area: "tasks", reason: "APPEND_NOT_ALLOWED" });
    expect((await appendTo(workspace, "inbox/测试文章.md", "- entry\n")).ok).toBe(true);
  });

  it("applies the same rules to Resource state_changes", async () => {
    const { item, workspace } = await openWorkspace();
    const service = new ResourceService(workspace, item.config);
    const task = await readOne(workspace, "tasks/TEST-001.md");

    const rejected = await captureError(service.capture({
      source: { type: "url", url: "https://example.com/write-mode-append" },
      summary: "Capture with task append",
      state_changes: [{ op: "append", path: "tasks/TEST-001.md", expected_blob_oid: task.blob_oid, content: "- from resource\n" }],
    }));
    expect(rejected.code).toBe("INVALID_OPERATION");
    expect(rejected.details.reason).toBe("APPEND_NOT_ALLOWED");
    expect(git(item.remote, "show", "main:tasks/TEST-001.md")).toBe("# TEST-001");

    const captured = await service.capture({
      source: { type: "url", url: "https://example.com/write-mode-patch" },
      summary: "Capture with task patch",
      state_changes: [{ op: "patch", path: "tasks/TEST-001.md", expected_blob_oid: task.blob_oid, find: "# TEST-001\n", replace: "# TEST-001\n\nSource: captured article.\n" }],
    });
    expect(captured.ok).toBe(true);
    expect(captured.changed_files).toContain("tasks/TEST-001.md");
    expect(git(item.remote, "show", "main:tasks/TEST-001.md")).toBe("# TEST-001\n\nSource: captured article.");
  });
});

describe("apply_change_set MCP contract", { timeout: 30_000 }, () => {
  it("accepts patch operations through a real MCP client", async () => {
    const { item, workspace } = await openWorkspace();
    const productPolicy = await loadProductPolicy();
    const mcpHandler = createMcpHandler(() => createMcpServer(workspace, productPolicy), { legacy: "reject" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => mcpHandler.fetch(new Request(url, init)),
    });
    const client = new Client({ name: "write-mode-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);

    const read = await client.callTool({ name: "read_files", arguments: { paths: ["tasks/TEST-001.md"] } });
    const data = read.structuredContent as { base_commit: string; files: Array<{ blob_oid: string }> };

    const appended = await client.callTool({
      name: "apply_change_set",
      arguments: {
        base_commit: data.base_commit,
        summary: "MCP append task",
        operations: [{ op: "append", path: "tasks/TEST-001.md", expected_blob_oid: data.files[0]!.blob_oid, content: "- x\n" }],
      },
    });
    expect(appended.isError).toBe(true);
    expect((appended.structuredContent as { details: Record<string, unknown> }).details.reason).toBe("APPEND_NOT_ALLOWED");

    const patched = await client.callTool({
      name: "apply_change_set",
      arguments: {
        base_commit: data.base_commit,
        summary: "MCP patch task",
        operations: [{ op: "patch", path: "tasks/TEST-001.md", expected_blob_oid: data.files[0]!.blob_oid, find: "TEST-001", replace: "TEST-001 (patched)" }],
      },
    });
    expect(patched.isError).toBeFalsy();
    expect((patched.structuredContent as { ok: boolean }).ok).toBe(true);
    expect(git(item.remote, "show", "main:tasks/TEST-001.md")).toBe("# TEST-001 (patched)");

    await client.close();
  });
});
