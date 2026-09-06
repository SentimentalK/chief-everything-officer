import { rm, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CeoWorkspace, type ChangeOperation, isResourcePath, assertNoResourceMutations } from "../src/workspace.js";
import { ResourceService } from "../src/resource/service.js";
import { fixture } from "./helpers.js";
import { CeoError } from "../src/errors.js";
import { createMcpServer } from "../src/mcp.js";
import { loadProductPolicy } from "../src/product-policy.js";
import type { UrlMetadataResolver } from "../src/resource/resolver-client.js";

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Resource Authority & Namespace Hardening", () => {
  it("isResourcePath identifies exact and descendant resources paths", () => {
    expect(isResourcePath("resources")).toBe(true);
    expect(isResourcePath("resources/")).toBe(true);
    expect(isResourcePath("resources/res-123/meta.md")).toBe(true);
    expect(isResourcePath("resources/anything/deep/file.md")).toBe(true);

    expect(isResourcePath("tasks/001.md")).toBe(false);
    expect(isResourcePath("personal/bio.md")).toBe(false);
    expect(isResourcePath("resources_backup/test.md")).toBe(false);
    expect(isResourcePath("inbox/resources.md")).toBe(false);
  });

  it("assertNoResourceMutations throws RESOURCE_API_REQUIRED for any operation under resources/**", () => {
    const createOp: ChangeOperation = {
      op: "create",
      path: "resources/res-001/meta.md",
      content: "# Meta",
    };

    expect(() => assertNoResourceMutations([createOp], "apply_change_set")).toThrowError(
      expect.objectContaining({
        code: "RESOURCE_API_REQUIRED",
        message: expect.stringContaining("Generic apply_change_set cannot mutate resources/**"),
      })
    );

    const moveSourceOp: ChangeOperation = {
      op: "move",
      path: "resources/res-001/meta.md",
      target: "tasks/orphan.md",
    };
    expect(() => assertNoResourceMutations([moveSourceOp], "apply_change_set")).toThrowError(
      expect.objectContaining({
        code: "RESOURCE_API_REQUIRED",
      })
    );

    const moveTargetOp: ChangeOperation = {
      op: "move",
      path: "inbox/memo.md",
      target: "resources/res-001/meta.md",
    };
    expect(() => assertNoResourceMutations([moveTargetOp], "state_changes")).toThrowError(
      expect.objectContaining({
        code: "RESOURCE_API_REQUIRED",
        message: expect.stringContaining("Resource state_changes cannot mutate resources/**"),
      })
    );
  });

  it("generic apply_change_set rejects all 6 mutation types targeting resources/** and leaves workspace clean", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const read = await workspace.readFiles(["JOURNAL.md"]);
    const baseCommit = read.base_commit;

    const dummyOid = "0000000000000000000000000000000000000000";

    const testCases: { name: string; op: ChangeOperation }[] = [
      {
        name: "create under resources/",
        op: { op: "create", path: "resources/fake-res/meta.md", content: "# Stolen" },
      },
      {
        name: "replace under resources/",
        op: { op: "replace", path: "resources/fake-res/meta.md", expected_blob_oid: dummyOid, content: "# Replaced" },
      },
      {
        name: "append under resources/",
        op: { op: "append", path: "resources/fake-res/interactions.md", expected_blob_oid: dummyOid, content: "text" },
      },
      {
        name: "delete under resources/",
        op: { op: "delete", path: "resources/fake-res/summary.md", expected_blob_oid: dummyOid },
      },
      {
        name: "move into resources/",
        op: { op: "move", path: "JOURNAL.md", target: "resources/fake-res/meta.md" },
      },
      {
        name: "move out of resources/",
        op: { op: "move", path: "resources/fake-res/meta.md", target: "inbox/stolen.md" },
      },
    ];

    for (const tc of testCases) {
      await expect(
        workspace.applyChangeSet({
          base_commit: baseCommit,
          summary: `Attempt ${tc.name}`,
          operations: [tc.op],
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          code: "RESOURCE_API_REQUIRED",
        })
      );
    }

    // Verify workspace remains clean and on original baseCommit
    const status = await workspace.workspaceStatus();
    expect(status.workspace_state).toBe("READY");
    expect(status.local_commit).toBe(baseCommit);
  });

  it("resource_capture rejects state_changes mutating resources/** before calling resolver", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver: UrlMetadataResolver = {
      resolve: vi.fn().mockResolvedValue({ status: "disabled" }),
    };

    const service = new ResourceService(workspace, item.config, mockResolver);

    await expect(
      service.capture({
        source: { type: "url", url: "https://example.com/article" },
        state_changes: [
          {
            op: "create",
            path: "resources/bypass/meta.md",
            content: "hacked",
          },
        ],
      })
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "RESOURCE_API_REQUIRED",
      })
    );

    // CRITICAL: Resolver should NOT be invoked when state_changes validation fails
    expect(mockResolver.resolve).not.toHaveBeenCalled();
  });

  it("resource_apply rejects state_changes mutating resources/** before transaction", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const service = new ResourceService(workspace, item.config);

    // 1. Capture valid resource
    const cap = await service.capture({
      source: { type: "url", url: "https://example.com/test1" },
    });
    const resourceId = (cap.resource as any)?.resource_id;
    const metaFile = (cap.changed_files as string[]).find((f) => f.endsWith("meta.md"))!;

    // 2. Attempt resource_apply with smuggled resources/** mutation in state_changes
    const read = await workspace.readFiles([metaFile]);
    await expect(
      service.apply({
        resource_id: resourceId,
        base_commit: read.commit,
        summary: "Smuggle attempt",
        operations: [
          {
            type: "upsert_summary",
            content: "Legit summary",
          },
        ],
        state_changes: [
          {
            op: "create",
            path: "resources/other/meta.md",
            content: "unauthorized",
          },
        ],
      })
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "RESOURCE_API_REQUIRED",
      })
    );
  });

  it("allows legitimate State consequences in resource_capture state_changes", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const service = new ResourceService(workspace, item.config);

    const cap = await service.capture({
      source: { type: "url", url: "https://example.com/doc-with-task" },
      note: "Need to review this paper",
      state_changes: [
        {
          op: "create",
          path: "tasks/REVIEW-001.md",
          content: "# Review Paper\n\nTask created on capture.",
        },
      ],
    });

    expect(cap.ok).toBe(true);
    const taskContent = await readFile(path.join(item.config.repoDir, "tasks/REVIEW-001.md"), "utf8");
    expect(taskContent).toContain("Task created on capture.");
  });

  it("non-Resource Markdown areas remain writable via apply_change_set", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const read = await workspace.readFiles(["JOURNAL.md"]);
    const res = await workspace.applyChangeSet({
      base_commit: read.base_commit,
      summary: "Add personal state and task",
      operations: [
        {
          op: "create",
          path: "personal/profile.md",
          content: "# User Profile\n\nIdentity data.",
        },
        {
          op: "create",
          path: "tasks/TEST-002.md",
          content: "# Test Task",
        },
      ],
    });

    expect(res.ok).toBe(true);
    const profile = await readFile(path.join(item.config.repoDir, "personal/profile.md"), "utf8");
    expect(profile).toContain("# User Profile");
  });

  it("tool descriptions contain required boundary and routing guidance", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();

    const server = createMcpServer(workspace, policy);
    const tools = (server as any)._registeredTools;

    // resource_capture
    const capDesc = tools["resource_capture"].description;
    expect(capDesc).toContain("Primary tool for saving, remembering, capturing, or importing an external URL/artifact");
    expect(capDesc).toContain("Do not pre-search for duplicates before capture");
    expect(capDesc).toContain("resource_capture performs dedupe server-side");

    // resource_apply
    const appDesc = tools["resource_apply"].description;
    expect(appDesc).toContain("Do not modify Resource artifacts through generic apply_change_set");

    // resource_search
    const searchDesc = tools["resource_search"].description;
    expect(searchDesc).toContain("Do not call resource_search merely to check whether a source already exists before resource_capture");

    // apply_change_set
    const changeDesc = tools["apply_change_set"].description;
    expect(changeDesc).toContain("This tool cannot mutate resources/**");
    expect(changeDesc).toContain("Use resource_capture for new Resources or resource_apply for existing Resources");

    // bootstrap policy
    expect(policy.bootstrap).toContain(
      "For external-source save intent, call `resource_capture` directly; it already handles dedupe and metadata enrichment. Do not manually construct Resource files."
    );
  });
});
