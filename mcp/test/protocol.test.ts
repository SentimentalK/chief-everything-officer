import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import http from "node:http";
import { rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthMiddleware, createHostGuard, createOriginGuard } from "../src/auth.js";
import { createMcpServer } from "../src/mcp.js";
import { loadProductPolicy } from "../src/product-policy.js";
import { CeoWorkspace } from "../src/workspace.js";
import { fixture } from "./helpers.js";

const cleanupDirs: string[] = [];
const cleanupServers: HttpServer[] = [];

afterEach(async () => {
  for (const s of cleanupServers.splice(0)) {
    s.closeAllConnections?.();
    s.closeIdleConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Protocol & Runtime Modernization (Stage 1)", () => {
  it("Test B — Modern 2026 protocol succeeds with in-process handler", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();

    const handler = createMcpHandler(() => createMcpServer(workspace, policy), { legacy: "reject" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });

    const client = new Client(
      { name: "modern-test-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );

    await client.connect(transport);
    expect(client.getProtocolEra()).toBe("modern");

    const toolsResponse = await client.listTools();
    expect(toolsResponse.tools.map((t) => t.name)).toEqual([
      "workspace_status",
      "list_files",
      "read_files",
      "search_text",
      "apply_change_set",
      "policy_read",
    ]);

    const statusResult = await client.callTool({ name: "workspace_status" });
    expect(statusResult.isError).toBeFalsy();
    expect(statusResult.structuredContent).toMatchObject({
      ok: true,
      workspace_state: "READY",
      version: "0.2.0",
      build: expect.any(String),
    });

    const policyResult = await client.callTool({ name: "policy_read", arguments: { name: "tasks" } });
    expect(policyResult.isError).toBeFalsy();
    expect(policyResult.structuredContent).toMatchObject({ name: "tasks", status: "FOUND" });

    // Verify no Mcp-Session-Id is required or held
    expect(transport.sessionId).toBeUndefined();

    await client.close();
  });

  it("Test C — Legacy 2025 protocol requests are rejected with unsupported protocol version", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();

    const handler = createMcpHandler(() => createMcpServer(workspace, policy), { legacy: "reject" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });

    const client = new Client(
      { name: "legacy-test-client", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy" } },
    );

    await expect(client.connect(transport)).rejects.toThrow(/Unsupported protocol version.*-32022|-32022/);
  });

  it("Test D — Security regressions rejected before MCP handler, modern client succeeds", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();

    const config = {
      ...item.config,
      mcpApiKey: "secret-test-token-123",
      allowedHosts: ["localhost", "127.0.0.1"],
      allowedOrigins: ["http://localhost"],
    };

    const app = createMcpExpressApp({ host: config.bindHost });
    const handler = createMcpHandler(() => createMcpServer(workspace, policy), { legacy: "reject" });
    const nodeHandler = toNodeHandler(handler);

    app.all(
      "/mcp",
      createHostGuard(config.allowedHosts),
      createOriginGuard(config.allowedOrigins),
      createAuthMiddleware(config.mcpApiKey),
      (req, res) => {
        void nodeHandler(req, res, req.body);
      },
    );

    const httpServer = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    cleanupServers.push(httpServer);
    const port = (httpServer.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/mcp`;

    // 1. Missing Authorization header -> 401
    const missingAuthRes = await fetch(url, {
      method: "POST",
      headers: {
        Host: "127.0.0.1",
        "Content-Type": "application/json",
      },
    });
    expect(missingAuthRes.status).toBe(401);

    // 2. Invalid Bearer token -> 401
    const badTokenRes = await fetch(url, {
      method: "POST",
      headers: {
        Host: "127.0.0.1",
        Authorization: "Bearer wrong-token",
        "Content-Type": "application/json",
      },
    });
    expect(badTokenRes.status).toBe(401);

    // 3. Wrong Host -> 421 Misdirected Request
    const wrongHostStatus = await new Promise<number>((resolve, reject) => {
      const r = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            host: "evil.domain.com",
            authorization: "Bearer secret-test-token-123",
            "content-type": "application/json",
          },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      r.on("error", reject);
      r.end();
    });
    expect([403, 421]).toContain(wrongHostStatus);

    // 4. Disallowed Origin -> 403 Forbidden
    const badOriginRes = await fetch(url, {
      method: "POST",
      headers: {
        Host: "127.0.0.1",
        Origin: "https://evil.attacker.com",
        Authorization: "Bearer secret-test-token-123",
        "Content-Type": "application/json",
      },
    });
    expect(badOriginRes.status).toBe(403);

    // 5. Valid credentials -> official modern Client connects through real Express endpoint
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: {
          Host: "127.0.0.1",
          Origin: "http://localhost",
          Authorization: "Bearer secret-test-token-123",
        },
      },
    });
    const client = new Client(
      { name: "authorized-modern-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );

    await client.connect(transport);
    expect(client.getProtocolEra()).toBe("modern");

    const toolsResponse = await client.listTools();
    expect(toolsResponse.tools.map((t) => t.name)).toEqual([
      "workspace_status",
      "list_files",
      "read_files",
      "search_text",
      "apply_change_set",
      "policy_read",
    ]);

    // Real tool call through Express + auth endpoint succeeds
    const statusCall = await client.callTool({ name: "workspace_status" });
    expect(statusCall.isError).toBeFalsy();
    expect(statusCall.structuredContent).toMatchObject({
      ok: true,
      workspace_state: "READY",
      version: "0.2.0",
      build: expect.any(String),
    });

    const policyCall = await client.callTool({ name: "policy_read", arguments: { name: "tasks" } });
    expect(policyCall.isError).toBeFalsy();
    expect(policyCall.structuredContent).toMatchObject({ name: "tasks", status: "FOUND" });

    const unknownCall = await client.callTool({ name: "policy_read", arguments: { name: "projects" } });
    expect(unknownCall.isError).toBeFalsy();
    expect(unknownCall.structuredContent).toMatchObject({ name: "projects", status: "NO_DEFAULT_POLICY" });

    await client.close();
  });

  it("Test E — Request-scoped McpServer with shared persistent CeoWorkspace", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();

    let serverFactoryCallCount = 0;
    const handler = createMcpHandler(
      () => {
        serverFactoryCallCount++;
        return createMcpServer(workspace, policy);
      },
      { legacy: "reject" },
    );

    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });

    const client = new Client(
      { name: "stateless-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);

    const initialFactoryCount = serverFactoryCallCount;
    expect(initialFactoryCount).toBeGreaterThanOrEqual(1);

    // Request A: list tools
    const listRes = await client.listTools();
    expect(listRes.tools).toHaveLength(6);
    const countAfterReqA = serverFactoryCallCount;
    expect(countAfterReqA).toBeGreaterThan(initialFactoryCount);

    // Request B: call workspace_status
    const statusRes = await client.callTool({ name: "workspace_status" });
    expect(statusRes.structuredContent).toMatchObject({ ok: true, workspace_state: "READY" });
    const countAfterReqB = serverFactoryCallCount;
    expect(countAfterReqB).toBeGreaterThan(countAfterReqA);

    // Both requests ran through separate server instances, but both access the same workspace
    expect(workspace.readiness).toBe("READY");

    await client.close();
  });
});

