import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { rm } from "node:fs/promises";
import http from "node:http";
import type { Server as HttpServer } from "node:http";
import { fixture } from "./helpers.js";
import { createHostGuard, createOriginGuard } from "../src/auth.js";

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

async function setup(allowedOrigins: string[] = []) {
  const item = await fixture();
  cleanupDirs.push(item.root);

  const app = express();
  app.use(express.json());
  app.use(createHostGuard(item.config.allowedHosts));
  app.use(createOriginGuard(allowedOrigins));
  app.get("/protected", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  cleanupServers.push(server);
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}`, port };
}

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
    const res = await fetch(`${baseUrl}/protected`);
    expect(res.status).toBe(200);
  });

  it("rejects requests with an unknown Origin before the route is evaluated", async () => {
    const { baseUrl } = await setup();
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { Origin: "https://evil.com" },
    });
    expect(res.status).toBe(403);
  });

  it("allows a known Origin", async () => {
    const { baseUrl } = await setup(["https://ceo-web.example"]);
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { Origin: "https://ceo-web.example" },
    });
    expect(res.status).toBe(200);
  });
});