import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp.js";
import type { LifeOSWorkspace } from "../src/workspace.js";

const closeables: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
});

describe("MCP contract", () => {
  it("discovers exactly four read tools and one write transaction", async () => {
    const workspace = {} as LifeOSWorkspace;
    const server = createMcpServer(workspace);
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
    ]);
    expect(response.tools.slice(0, 4).every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(response.tools[4]?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });
});
