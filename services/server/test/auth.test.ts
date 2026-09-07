import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { rm } from "node:fs/promises";
import http from "node:http";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fixture, createIdentityService } from "./helpers.js";
import { createIdentityAuthMiddleware, createHostGuard, createOriginGuard } from "../src/auth.js";
import type { IdentityService } from "../src/identity/service.js";

const cleanupDirs: string[] = [];
const cleanupServers: HttpServer[] = [];
const cleanupServices: IdentityService[] = [];

afterEach(async () => {
  for (const s of cleanupServers.splice(0)) {
    s.closeAllConnections?.();
    s.closeIdleConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const svc of cleanupServices.splice(0)) {
    svc.close();
  }
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(allowedOrigins: string[] = []) {
  const item = await fixture();
  cleanupDirs.push(item.root);
  const apiKey = "secret-mcp-key";
  const service = createIdentityService(item.config, apiKey);
  cleanupServices.push(service);

  const app = express();
  app.use(express.json());
  app.use(createHostGuard(item.config.allowedHosts));
  app.use(createOriginGuard(allowedOrigins));
  app.get("/protected", createIdentityAuthMiddleware(service), (req, res) => {
    res.status(200).json({ identity: res.locals.identity });
  });

  const server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  cleanupServers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, port, apiKey, service };
}

describe("createIdentityAuthMiddleware", () => {
  it("rejects when no Authorization header", async () => {
    const { baseUrl } = await setup();
    const res = await fetch(`${baseUrl}/protected`);
    expect(res.status).toBe(401);
  });

  it("rejects when Authorization is not Bearer scheme", async () => {
    const { baseUrl } = await setup();
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { Authorization: "Basic abc123" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects when Bearer token is wrong", async () => {
    const { baseUrl } = await setup();
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  it("ignores a forged X-User-ID (identity comes only from verified key)", async () => {
    const { baseUrl } = await setup();
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { Authorization: "Bearer wrong-key", "X-User-Id": "usr_fake" },
    });
    expect(res.status).toBe(401);
  });

  it("allows a valid Bearer and exposes the resolved identity", async () => {
    const { baseUrl, service, apiKey } = await setup();
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: { user_id: string; workspace_id: string; api_key_id: string } };
    expect(body.identity.user_id).toMatch(/^usr_/);
    expect(body.identity.workspace_id).toBe(service.workspaceIdentityValue.workspace_id);
    expect(body.identity.api_key_id).toMatch(/^ak_/);
  });
});

describe("createHostGuard", () => {
  it("rejects an unknown host with 421", async () => {
    const { port } = await setup();
    const status = await new Promise<number>((resolve, reject) => {
      const r = http.request(
        { hostname: "127.0.0.1", port, path: "/protected", method: "GET", headers: { host: "evil.domain.com" } },
        (res) => resolve(res.statusCode ?? 0),
      );
      r.on("error", reject);
      r.end();
    });
    expect(status).toBe(421);
  });
});

describe("createOriginGuard", () => {
  it("allows requests with no Origin (server-to-server)", async () => {
    const { baseUrl } = await setup();
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { Authorization: "Bearer definitely-wrong" },
    });
    // Origin absent is allowed, so the auth layer reports 401 for the bad credential.
    expect(res.status).toBe(401);
  });

  it("rejects requests with an unknown Origin before auth is evaluated", async () => {
    const { baseUrl } = await setup();
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { Origin: "https://evil.com", Authorization: "Bearer x" },
    });
    expect(res.status).toBe(403);
  });
});
