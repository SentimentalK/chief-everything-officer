import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createIdentityAuthMiddleware, createHostGuard, createOriginGuard } from "../src/auth.js";
import { createMcpServer } from "../src/mcp.js";
import { loadProductPolicy } from "../src/product-policy.js";
import { CeoWorkspace } from "../src/workspace.js";
import { fixture, createIdentityService } from "./helpers.js";
import type { IdentityService } from "../src/identity/service.js";

const API_KEY = "http-boundary-key";

const cleanupDirs: string[] = [];
const cleanupServers: HttpServer[] = [];
const cleanupServices: IdentityService[] = [];

afterEach(async () => {
  for (const s of cleanupServers.splice(0)) {
    s.closeAllConnections?.();
    s.closeIdleConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const svc of cleanupServices.splice(0)) svc.close();
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function buildServer() {
  const item = await fixture();
  cleanupDirs.push(item.root);
  const workspace = new CeoWorkspace(item.config);
  await workspace.initialize();
  const policy = await loadProductPolicy();

  const identityService = createIdentityService(item.config, API_KEY);
  cleanupServices.push(identityService);
  const workspaceIdentity = identityService.workspaceIdentityValue;

  const app = createMcpExpressApp({ host: item.config.bindHost });
  app.use(express.json());

  app.get(
    "/api/identity",
    createHostGuard(item.config.allowedHosts),
    createOriginGuard(item.config.allowedOrigins),
    createIdentityAuthMiddleware(identityService),
    (_req, res) => {
      res.status(200).json({
        user_id: identityService.workspaceIdentityValue.user_id,
        workspace_id: identityService.workspaceIdentityValue.workspace_id,
        deployment_mode: "single_user",
      });
    },
  );

  const handler = createMcpHandler(() => createMcpServer(workspace, policy, { identity: workspaceIdentity }), {
    legacy: "reject",
  });
  const nodeHandler = toNodeHandler(handler);
  app.all(
    "/mcp",
    createHostGuard(item.config.allowedHosts),
    createOriginGuard(item.config.allowedOrigins),
    createIdentityAuthMiddleware(identityService),
    (req, res) => void nodeHandler(req, res, req.body),
  );

  const server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  cleanupServers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, workspaceIdentity };
}

describe("GET /api/identity", () => {
  it("returns stable user/workspace and single_user mode for a valid key", async () => {
    const { baseUrl, workspaceIdentity } = await buildServer();
    const res = await fetch(`${baseUrl}/api/identity`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_id: string; workspace_id: string; deployment_mode: string };
    expect(body.user_id).toBe(workspaceIdentity.user_id);
    expect(body.user_id).toMatch(/^usr_/);
    expect(body.workspace_id).toBe(workspaceIdentity.workspace_id);
    expect(body.deployment_mode).toBe("single_user");
    // Sensitive info must never be exposed.
    expect(JSON.stringify(body)).not.toContain("key_digest");
  });

  it("returns 401 for a missing or wrong key", async () => {
    const { baseUrl } = await buildServer();
    const missing = await fetch(`${baseUrl}/api/identity`);
    expect(missing.status).toBe(401);
    const wrong = await fetch(`${baseUrl}/api/identity`, {
      headers: { Authorization: "Bearer not-the-key" },
    });
    expect(wrong.status).toBe(401);
  });
});

describe("workspace_status identity surfaced over real HTTP + MCP", () => {
  it("reports the authenticated user_id and workspace_id", async () => {
    const { baseUrl } = await buildServer();
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
    });
    const client = new Client({ name: "api-id-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
    const res = await client.callTool({ name: "workspace_status" });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { user_id: string; workspace_id: string };
    expect(sc.user_id).toMatch(/^usr_/);
    expect(sc.workspace_id).toMatch(/^ws_/);
    await client.close();
  });
});
