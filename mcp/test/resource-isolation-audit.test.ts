import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { CeoWorkspace } from "../src/workspace.js";
import { createMcpServer } from "../src/mcp.js";
import { loadProductPolicy } from "../src/product-policy.js";
import { AuditStore } from "../src/audit.js";
import { fixture } from "./helpers.js";

const cleanupDirs: string[] = [];
const closeables: Array<{ close(): Promise<void> | void }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Resource State Isolation, Policy, and Audit Sanitization", () => {
  it("isolates resources from default search_text, allows scoped search, and preserves root listing", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();
    const server = createMcpServer(workspace, policy);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // 1. Capture resource containing unique keyword
    await client.callTool({
      name: "resource_capture",
      arguments: {
        source: { type: "url", url: "https://example.com/unique-test-page" },
        note: "EXCLUSIVE_RESOURCE_SECRET_NOTE",
        topics: ["testing"],
        initial_operations: [
          {
            op: "upsert_summary",
            provenance: "host_semantic",
            content: "# Exclusive Summary\n\nEXCLUSIVE_RESOURCE_SECRET_KEYWORD\n",
          },
        ],
      },
    });

    // 2. Unscoped search_text must NOT find the keyword because resources/ is isolated
    const unscopedSearch = await client.callTool({
      name: "search_text",
      arguments: { query: "EXCLUSIVE_RESOURCE_SECRET_KEYWORD" },
    });
    const unscopedMatches = (unscopedSearch.structuredContent as any).matches;
    expect(unscopedMatches).toHaveLength(0);

    // 3. Scoped search_text with prefixes=["resources/"] DOES find the keyword
    const scopedSearch = await client.callTool({
      name: "search_text",
      arguments: {
        query: "EXCLUSIVE_RESOURCE_SECRET_KEYWORD",
        prefixes: ["resources/"],
      },
    });
    const scopedMatches = (scopedSearch.structuredContent as any).matches;
    expect(scopedMatches).toHaveLength(1);
    expect(scopedMatches[0].path).toMatch(/^resources\/res-.*\/summary\.md$/);

    // 4. list_files at root still discovers resources/ directory
    const listRes = await client.callTool({
      name: "list_files",
      arguments: { prefix: "" },
    });
    const dirs = (listRes.structuredContent as any).directories;
    expect(dirs).toContain("resources/");
  });

  it("reads runtime policy for resources via policy_read", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();
    const server = createMcpServer(workspace, policy);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const policyCall = await client.callTool({
      name: "policy_read",
      arguments: { name: "resources" },
    });
    expect(policyCall.isError).toBeFalsy();
    const res = policyCall.structuredContent as any;
    expect(res.ok).toBe(true);
    expect(res.status).toBe("FOUND");
    expect(res.content).toContain("# CEO Resource Policy");
    expect(res.content).toContain("Markdown Understanding is the V0 Core");
  });

  it("sanitizes data_base64 from audit log while recording affected paths and commit hash", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();
    const auditStore = new AuditStore(item.config.auditDbPath);
    closeables.push(auditStore);

    const server = createMcpServer(workspace, policy, auditStore);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const secretBase64 = Buffer.from("%PDF-1.4 SECRET_BASE64_BYTES").toString("base64");

    const captureRes = await client.callTool({
      name: "resource_capture",
      arguments: {
        source: {
          type: "file_inline",
          filename: "private.pdf",
          mime_type: "application/pdf",
          data_base64: secretBase64,
        },
        note: "Audit test",
      },
    });

    expect(captureRes.isError).toBeFalsy();
    const commit = (captureRes.structuredContent as any).commit;
    expect(commit).toBeDefined();

    // Query audit trace
    const traces = auditStore.listSummaries({ limit: 10 });
    const captureTrace = traces.find((t) => t.tool_name === "resource_capture");
    expect(captureTrace).toBeDefined();

    // Verify commit and affected paths
    expect(captureTrace!.resulting_commit).toBe(commit);
    expect(captureTrace!.affected_paths!.some((p: string) => p.includes("meta.md"))).toBe(true);
    expect(captureTrace!.affected_paths!.some((p: string) => p.includes("source/original.pdf"))).toBe(true);

    // Verify secretBase64 is NEVER in audit input_json
    const detail = auditStore.getDetail(captureTrace!.id);
    expect(detail!.input_json).not.toContain(secretBase64);
    expect(detail!.input_json).toContain("[omitted base64 payload:");
  });
});
