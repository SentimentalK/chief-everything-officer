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
  it("discovers exactly five read tools, one write transaction, and policy_read", async () => {
    const workspace = {} as CeoWorkspace;
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
    ]);
    const readTools = response.tools.filter((t) => t.name !== "apply_change_set");
    expect(readTools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    const writeTool = response.tools.find((t) => t.name === "apply_change_set");
    expect(writeTool?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });
});
