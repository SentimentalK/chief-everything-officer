import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp.js";
import { loadProductPolicy } from "../src/product-policy.js";
import type { CeoWorkspace } from "../src/workspace.js";

const closeables: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
});

describe("MCP contract", () => {
  it("discovers all seven read tools, three write transactions, and policy_read", async () => {
    const workspace = { config: {} } as CeoWorkspace;
    const policy = await loadProductPolicy();
    const server = createMcpServer(workspace, policy);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.listTools();
    expect(response.tools.map((tool) => tool.name)).toEqual([
      "workspace_status",
      "list_files",
      "read_files",
      "search_text",
      "apply_change_set",
      "policy_read",
      "resource_capture",
      "resource_apply",
      "resource_search",
      "resource_get",
      "resource_delete",
    ]);
    const writeToolNames = new Set(["apply_change_set", "resource_capture", "resource_apply", "resource_delete"]);
    const readTools = response.tools.filter((t) => !writeToolNames.has(t.name));
    expect(readTools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    const openWorldWriteTools = response.tools.filter((t) => ["apply_change_set", "resource_capture", "resource_apply"].includes(t.name));
    expect(openWorldWriteTools.every((tool) => tool.annotations?.readOnlyHint === false && tool.annotations?.openWorldHint === true)).toBe(true);
    const deleteTool = response.tools.find((tool) => tool.name === "resource_delete");
    expect(deleteTool?.annotations?.readOnlyHint).toBe(false);
    expect(deleteTool?.annotations?.destructiveHint).toBe(true);
    expect(deleteTool?.annotations?.openWorldHint).toBe(false);
  });
});
