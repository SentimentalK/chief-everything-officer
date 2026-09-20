import { randomUUID } from "node:crypto";
import { rm, mkdir, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { CeoWorkspace } from "../src/workspace.js";
import { createMcpServer } from "../src/mcp.js";
import { loadProductPolicy } from "../src/product-policy.js";
import { runGit, resolveRef } from "../src/git.js";
import { AuditStore } from "../src/audit.js";
import { ResourceService } from "../src/resource/service.js";
import { CeoError } from "../src/errors.js";
import { fixture } from "./helpers.js";

const cleanupDirs: string[] = [];
const closeables: Array<{ close(): Promise<void> | void }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CEO Resource Delete (resource_delete)", () => {
  async function setupEnvironment(options?: { withAudit?: boolean }) {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();

    let auditStore: AuditStore | undefined;
    let identity: { user_id: string; workspace_id: string } | undefined;
    if (options?.withAudit) {
      auditStore = new AuditStore(item.config.auditDbPath);
      closeables.push(auditStore);
      identity = { user_id: "usr_test", workspace_id: "ws_delete_test" };
    }

    const server = createMcpServer(workspace, policy, { auditStore, identity });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    return { item, workspace, server, client, auditStore };
  }

  // Test 1: Delete ID-named Resource (res-...)
  it("1. deletes an ID-named Resource (resources/res-...) completely", async () => {
    const { client, workspace } = await setupEnvironment();

    const captureRes = await client.callTool({
      name: "resource_capture",
      arguments: {
        source: { type: "file_descriptor", filename: "doc.txt" },
        note: "Delete test ID named",
      },
    });
    expect(captureRes.isError).toBeFalsy();
    const captureReceipt = captureRes.structuredContent as any;
    const resourceId = captureReceipt.resource.resource_id;
    const baseCommit = captureReceipt.commit;

    const deleteRes = await client.callTool({
      name: "resource_delete",
      arguments: {
        resource_id: resourceId,
        base_commit: baseCommit,
        summary: "Delete ID named resource",
      },
    });
    expect(deleteRes.isError).toBeFalsy();
    const deleteReceipt = deleteRes.structuredContent as any;
    expect(deleteReceipt.ok).toBe(true);
    expect(deleteReceipt.commit).toBeDefined();
    expect(deleteReceipt.commit).not.toEqual(baseCommit);
    expect(deleteReceipt.deleted).toBe(true);
    expect(deleteReceipt.resource.resource_id).toBe(resourceId);
    expect(deleteReceipt.deleted_path).toBe(`resources/${resourceId}`);

    // Verify directory is deleted from repo snapshot
    const snapshot = await workspace.captureReadSnapshot();
    const treeEntries = await (workspace as any).listSnapshotTreeEntries(snapshot.commit);
    const remainingInResource = treeEntries.filter((e: any) => e.path.startsWith(`resources/${resourceId}`));
    expect(remainingInResource).toHaveLength(0);
  });

  // Test 2: Delete renamed Resource (resources/Display Name)
  it("2. deletes a renamed Resource with a semantic directory name", async () => {
    const { client, workspace } = await setupEnvironment();

    const captureRes = await client.callTool({
      name: "resource_capture",
      arguments: {
        source: { type: "file_descriptor", filename: "whitepaper.pdf" },
        note: "Rename and delete test",
      },
    });
    const captureReceipt = captureRes.structuredContent as any;
    const resourceId = captureReceipt.resource.resource_id;

    // Rename
    const renameRes = await client.callTool({
      name: "resource_apply",
      arguments: {
        resource_id: resourceId,
        base_commit: captureReceipt.commit,
        summary: "Rename resource",
        operations: [{ op: "rename", display_name: "Strategic Analysis" }],
      },
    });
    expect(renameRes.isError).toBeFalsy();
    const renameReceipt = renameRes.structuredContent as any;
    expect(renameReceipt.resource.relative_path).toBe("resources/Strategic Analysis");

    // Delete
    const deleteRes = await client.callTool({
      name: "resource_delete",
      arguments: {
        resource_id: resourceId,
        base_commit: renameReceipt.commit,
        summary: "Delete renamed resource",
      },
    });
    expect(deleteRes.isError).toBeFalsy();
    const deleteReceipt = deleteRes.structuredContent as any;
    expect(deleteReceipt.deleted_path).toBe("resources/Strategic Analysis");

    const snapshot = await workspace.captureReadSnapshot();
    const treeEntries = await (workspace as any).listSnapshotTreeEntries(snapshot.commit);
    const remaining = treeEntries.filter((e: any) => e.path.startsWith("resources/Strategic Analysis"));
    expect(remaining).toHaveLength(0);
  });

  // Test 3: Delete Resource with all artifact types + binary source asset
  it("3. deletes a Resource with all artifact kinds and binary source asset", async () => {
    const { client, workspace } = await setupEnvironment();

    const pdfBase64 = Buffer.from("%PDF-1.4 sample content").toString("base64");
    const captureRes = await client.callTool({
      name: "resource_capture",
      arguments: {
        source: {
          type: "file_inline",
          filename: "sample.pdf",
          mime_type: "application/pdf",
          data_base64: pdfBase64,
        },
        note: "Full resource test",
        initial_operations: [
          {
            op: "upsert_summary",
            provenance: "host_semantic",
            basis: "source_content",
            content: "# Summary\nSummary details\n",
          },
          {
            op: "upsert_content",
            provenance: "host_exact",
            content: "# Content\nFull document content\n",
          },
          {
            op: "upsert_evidence",
            provenance: "host_exact",
            content: "# Evidence\nKey evidence\n",
          },
          {
            op: "append_interaction",
            provenance: "host_exact",
            entry: "Initial discussion entry",
          },
        ],
      },
    });
    expect(captureRes.isError).toBeFalsy();
    const captureReceipt = captureRes.structuredContent as any;
    const resourceId = captureReceipt.resource.resource_id;

    const deleteRes = await client.callTool({
      name: "resource_delete",
      arguments: {
        resource_id: resourceId,
        base_commit: captureReceipt.commit,
        summary: "Delete comprehensive resource",
      },
    });
    expect(deleteRes.isError).toBeFalsy();
    const deleteReceipt = deleteRes.structuredContent as any;
    const changedFiles = deleteReceipt.changed_files as string[];

    // Ensure all artifacts were deleted
    expect(changedFiles).toEqual(
      expect.arrayContaining([
        `resources/${resourceId}/meta.md`,
        `resources/${resourceId}/content.md`,
        `resources/${resourceId}/summary.md`,
        `resources/${resourceId}/evidence.md`,
        `resources/${resourceId}/interactions.md`,
        `resources/${resourceId}/source/original.pdf`,
      ]),
    );

    const snapshot = await workspace.captureReadSnapshot();
    const treeEntries = await (workspace as any).listSnapshotTreeEntries(snapshot.commit);
    expect(treeEntries.filter((e: any) => e.path.startsWith(`resources/${resourceId}`))).toHaveLength(0);
  });

  // Test 4: Visibility after deletion
  it("4. verifies resource_get returns NOT_FOUND and resource_search omits deleted resource", async () => {
    const { client } = await setupEnvironment();

    const captureRes = await client.callTool({
      name: "resource_capture",
      arguments: {
        source: { type: "url", url: "https://example.com/unique-test-4" },
        note: "Visibility test",
      },
    });
    const captureReceipt = captureRes.structuredContent as any;
    const resourceId = captureReceipt.resource.resource_id;

    // Delete
    await client.callTool({
      name: "resource_delete",
      arguments: {
        resource_id: resourceId,
        base_commit: captureReceipt.commit,
        summary: "Delete for visibility check",
      },
    });

    // resource_get must fail with NOT_FOUND
    const getRes = await client.callTool({
      name: "resource_get",
      arguments: { resource_id: resourceId },
    });
    expect(getRes.isError).toBe(true);
    expect((getRes.content[0] as any).text).toContain("NOT_FOUND");

    // resource_search must not find it
    const searchRes = await client.callTool({
      name: "resource_search",
      arguments: { query: "unique-test-4" },
    });
    expect(searchRes.isError).toBeFalsy();
    const searchResults = (searchRes.structuredContent as any).results;
    expect(searchResults.some((r: any) => r.resource_id === resourceId)).toBe(false);
  });

  // Test 5: Stale revision rejection (STALE_REVISION)
  it("5. rejects deletion with STALE_REVISION when base_commit is outdated", async () => {
    const { client } = await setupEnvironment();

    // 1. Capture Resource A
    const capA = await client.callTool({
      name: "resource_capture",
      arguments: { source: { type: "url", url: "https://example.com/stale-a" } },
    });
    const resAId = (capA.structuredContent as any).resource.resource_id;
    const staleCommit = (capA.structuredContent as any).commit;

    // 2. Capture Resource B (moves HEAD)
    await client.callTool({
      name: "resource_capture",
      arguments: { source: { type: "url", url: "https://example.com/stale-b" } },
    });

    // 3. Attempt to delete Resource A using staleCommit
    const deleteRes = await client.callTool({
      name: "resource_delete",
      arguments: {
        resource_id: resAId,
        base_commit: staleCommit,
        summary: "Stale delete attempt",
      },
    });
    expect(deleteRes.isError).toBe(true);
    expect((deleteRes.content[0] as any).text).toContain("STALE_REVISION");
  });

  // Test 6: Idempotent replay with same request_id
  it("6. supports idempotent retry with the same request_id", async () => {
    const { client } = await setupEnvironment();

    const captureRes = await client.callTool({
      name: "resource_capture",
      arguments: { source: { type: "url", url: "https://example.com/idempotent" } },
    });
    const captureReceipt = captureRes.structuredContent as any;
    const resourceId = captureReceipt.resource.resource_id;
    const baseCommit = captureReceipt.commit;

    const requestId = randomUUID();

    // First call
    const firstRes = await client.callTool({
      name: "resource_delete",
      arguments: {
        request_id: requestId,
        resource_id: resourceId,
        base_commit: baseCommit,
        summary: "Idempotent delete",
      },
    });
    expect(firstRes.isError).toBeFalsy();
    const firstReceipt = firstRes.structuredContent as any;
    expect(firstReceipt.ok).toBe(true);
    expect(firstReceipt.deleted).toBe(true);

    // Second call with identical request_id and original baseCommit
    const secondRes = await client.callTool({
      name: "resource_delete",
      arguments: {
        request_id: requestId,
        resource_id: resourceId,
        base_commit: baseCommit,
        summary: "Idempotent delete",
      },
    });
    expect(secondRes.isError).toBeFalsy();
    const secondReceipt = secondRes.structuredContent as any;
    expect(secondReceipt.ok).toBe(true);
    expect(secondReceipt.commit).toBe(firstReceipt.commit);
    expect(secondReceipt.request_id).toBe(requestId);
    expect(secondReceipt.deleted).toBe(true);
    expect(secondReceipt.deleted_path).toBe(firstReceipt.deleted_path);
  });

  // Test 7: New request on already deleted Resource -> NOT_FOUND
  it("7. returns NOT_FOUND for a new request targeting an already deleted Resource", async () => {
    const { client } = await setupEnvironment();

    const captureRes = await client.callTool({
      name: "resource_capture",
      arguments: { source: { type: "url", url: "https://example.com/already-deleted" } },
    });
    const captureReceipt = captureRes.structuredContent as any;
    const resourceId = captureReceipt.resource.resource_id;

    // Delete once
    const del1 = await client.callTool({
      name: "resource_delete",
      arguments: {
        resource_id: resourceId,
        base_commit: captureReceipt.commit,
        summary: "Delete once",
      },
    });
    const deleteCommit = (del1.structuredContent as any).commit;

    // Delete again with new request
    const del2 = await client.callTool({
      name: "resource_delete",
      arguments: {
        resource_id: resourceId,
        base_commit: deleteCommit,
        summary: "Delete second time",
      },
    });
    expect(del2.isError).toBe(true);
    expect((del2.content[0] as any).text).toContain("NOT_FOUND");
  });

  // Test 8: Multi-resource isolation
  it("8. isolates deletion: deleting Resource A leaves Resource B untouched", async () => {
    const { client, workspace } = await setupEnvironment();

    const capA = await client.callTool({
      name: "resource_capture",
      arguments: { source: { type: "url", url: "https://example.com/iso-a" }, note: "Resource A" },
    });
    const resAId = (capA.structuredContent as any).resource.resource_id;

    const capB = await client.callTool({
      name: "resource_capture",
      arguments: { source: { type: "url", url: "https://example.com/iso-b" }, note: "Resource B" },
    });
    const resBId = (capB.structuredContent as any).resource.resource_id;
    const baseCommit = (capB.structuredContent as any).commit;

    // Delete Resource A
    const delA = await client.callTool({
      name: "resource_delete",
      arguments: {
        resource_id: resAId,
        base_commit: baseCommit,
        summary: "Delete Resource A only",
      },
    });
    expect(delA.isError).toBeFalsy();

    // Verify Resource B is completely intact
    const getB = await client.callTool({
      name: "resource_get",
      arguments: { resource_id: resBId, view: "metadata" },
    });
    expect(getB.isError).toBeFalsy();
    expect((getB.structuredContent as any).metadata.source_ref).toBe("https://example.com/iso-b");

    const snapshot = await workspace.captureReadSnapshot();
    const treeEntries = await (workspace as any).listSnapshotTreeEntries(snapshot.commit);
    expect(treeEntries.some((e: any) => e.path === `resources/${resBId}/meta.md`)).toBe(true);
    expect(treeEntries.some((e: any) => e.path.startsWith(`resources/${resAId}`))).toBe(false);
  });

  // Test 9: Generic mutation boundary regression (apply_change_set rejects resources/**)
  it("9. prevents apply_change_set from mutating or deleting resources/**", async () => {
    const { client } = await setupEnvironment();

    const cap = await client.callTool({
      name: "resource_capture",
      arguments: { source: { type: "url", url: "https://example.com/boundary" } },
    });
    const resId = (cap.structuredContent as any).resource.resource_id;
    const commit = (cap.structuredContent as any).commit;

    // Try delete via apply_change_set
    const attemptDelete = await client.callTool({
      name: "apply_change_set",
      arguments: {
        base_commit: commit,
        summary: "Bypass attempt to delete resource",
        operations: [
          {
            op: "delete",
            path: `resources/${resId}/meta.md`,
            expected_blob_oid: "0000000000000000000000000000000000000000",
          },
        ],
      },
    });
    expect(attemptDelete.isError).toBe(true);
    const errText = (attemptDelete.content[0] as any).text;
    expect(errText).toContain("RESOURCE_API_REQUIRED");
    expect(errText).toContain("resource_delete");
  });

  // Test 10: Security traversal guard
  it("10. rejects directory traversal, non-1-level paths, and symlink targets", async () => {
    const { client, workspace, item } = await setupEnvironment();

    // 1. Invalid ID formats rejected at API schema boundary
    const badIdRes = await client.callTool({
      name: "resource_delete",
      arguments: {
        resource_id: "../tasks",
        base_commit: await resolveRef(item.config, item.config.repoDir, "HEAD"),
        summary: "Path traversal attempt",
      },
    });
    expect(badIdRes.isError).toBe(true);
    expect((badIdRes.content[0] as any).text).toContain("Invalid arguments for tool resource_delete");

    // 2. Resource target pointing to a symlink instead of real directory
    const cap = await client.callTool({
      name: "resource_capture",
      arguments: { source: { type: "url", url: "https://example.com/symlink-guard" } },
    });
    const resId = (cap.structuredContent as any).resource.resource_id;
    const commit = (cap.structuredContent as any).commit;

    // Replace target resource dir in repo with symlink to another dir
    const realDir = path.join(item.config.repoDir, "resources", resId);
    const outsideTarget = path.join(item.root, "outside-folder");
    await mkdir(outsideTarget, { recursive: true });
    await rm(realDir, { recursive: true, force: true });
    await symlink(outsideTarget, realDir);
    await runGit(item.config, item.config.repoDir, ["add", "."]);
    await runGit(item.config, item.config.repoDir, ["commit", "-m", "replace resource dir with symlink"]);
    await runGit(item.config, item.config.repoDir, ["push", "origin", "main"]);

    const newCommit = await resolveRef(item.config, item.config.repoDir, "HEAD");
    const symlinkDeleteRes = await client.callTool({
      name: "resource_delete",
      arguments: {
        resource_id: resId,
        base_commit: newCommit,
        summary: "Delete symlink directory",
      },
    });
    expect(symlinkDeleteRes.isError).toBe(true);
    // Symlink dir is not enumerated as a valid resource directory
    expect((symlinkDeleteRes.content[0] as any).text).toContain("NOT_FOUND");

    // 3. Direct invocation of ResourceService.delete with manipulated invariants
    const service = new ResourceService(workspace, item.config);
    // Directly test that delete rejects invalid resource directory invariants
    await expect(
      service.delete({
        resource_id: "res-00000000-0000-4000-8000-000000000000",
        base_commit: newCommit,
        summary: "Non-existent resource",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  // Test 11: Audit trace logging
  it("11. records resource_delete in AuditStore with affected_paths and resulting_commit", async () => {
    const { client, auditStore } = await setupEnvironment({ withAudit: true });
    expect(auditStore).toBeDefined();

    const cap = await client.callTool({
      name: "resource_capture",
      arguments: { source: { type: "url", url: "https://example.com/audit-delete" }, note: "Audit deletion" },
    });
    const resId = (cap.structuredContent as any).resource.resource_id;
    const baseCommit = (cap.structuredContent as any).commit;

    const delRes = await client.callTool({
      name: "resource_delete",
      arguments: {
        resource_id: resId,
        base_commit: baseCommit,
        summary: "Audit logged delete",
      },
    });
    expect(delRes.isError).toBeFalsy();
    const delCommit = (delRes.structuredContent as any).commit;

    // Verify Audit record
    const traces = auditStore!.listSummaries("ws_delete_test", { limit: 10 });
    const deleteTrace = traces.find((t) => t.tool_name === "resource_delete");
    expect(deleteTrace).toBeDefined();
    expect(deleteTrace!.resulting_commit).toBe(delCommit);
    expect(deleteTrace!.status).toBe("success");
    expect(deleteTrace!.affected_paths).toEqual(
      expect.arrayContaining([`resources/${resId}/meta.md`]),
    );
  });

  // Test 12: Delete legacy / unknown owned artifact (e.g. legacy-artifact.xyz)
  it("12. deletes legacy or arbitrary owned artifacts inside the resource directory via resourceDeletePrefix", async () => {
    const { client, item, workspace } = await setupEnvironment();

    const cap = await client.callTool({
      name: "resource_capture",
      arguments: { source: { type: "url", url: "https://example.com/legacy-test" } },
    });
    const resId = (cap.structuredContent as any).resource.resource_id;

    // Directly commit legacy files into the resource directory in git
    const legacyJsonPath = path.join(item.config.repoDir, "resources", resId, "legacy-metadata.json");
    const legacyXyzPath = path.join(item.config.repoDir, "resources", resId, "old-artifact.xyz");
    await writeFile(legacyJsonPath, '{"legacy": true}\n', "utf8");
    await writeFile(legacyXyzPath, "XYZ RAW BYTES\n", "utf8");
    await runGit(item.config, item.config.repoDir, ["add", "."]);
    await runGit(item.config, item.config.repoDir, ["commit", "-m", "add legacy non-markdown artifacts to resource"]);
    await runGit(item.config, item.config.repoDir, ["push", "origin", "main"]);

    const latestCommit = await resolveRef(item.config, item.config.repoDir, "HEAD");

    // Attempt resource_delete
    const deleteRes = await client.callTool({
      name: "resource_delete",
      arguments: {
        resource_id: resId,
        base_commit: latestCommit,
        summary: "Delete resource with legacy artifacts",
      },
    });
    expect(deleteRes.isError).toBeFalsy();
    const deleteReceipt = deleteRes.structuredContent as any;
    expect(deleteReceipt.ok).toBe(true);

    const changedFiles = deleteReceipt.changed_files as string[];
    expect(changedFiles).toContain(`resources/${resId}/legacy-metadata.json`);
    expect(changedFiles).toContain(`resources/${resId}/old-artifact.xyz`);

    const snapshot = await workspace.captureReadSnapshot();
    const treeEntries = await (workspace as any).listSnapshotTreeEntries(snapshot.commit);
    expect(treeEntries.filter((e: any) => e.path.startsWith(`resources/${resId}`))).toHaveLength(0);
  });
});
