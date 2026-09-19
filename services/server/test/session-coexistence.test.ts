import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "os";
import type { Server as HttpServer } from "node:http";
import { IdentityService } from "../src/identity/service.js";
import { seedIdentity } from "./helpers.js";
import { AuditStore, createAuditRouter } from "../src/audit.js";
import { UserSessionManager } from "../src/auth/user-session.js";
import { createUserRouter } from "../src/auth/user-router.js";

const cleanupDirs: string[] = [];
const cleanupServers: HttpServer[] = [];
const cleanupServices: IdentityService[] = [];
const cleanupStores: AuditStore[] = [];

afterEach(async () => {
  for (const s of cleanupServers.splice(0)) {
    s.closeAllConnections?.();
    s.closeIdleConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const svc of cleanupServices.splice(0)) svc.close();
  for (const store of cleanupStores.splice(0)) store.close();
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupApp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-audit-session-test-"));
  cleanupDirs.push(dir);

  const dbPath = path.join(dir, "identity.sqlite");
  const auditDbPath = path.join(dir, "audit.sqlite");
  const apiKey = "mcp-secret-key-123";

  const ident = seedIdentity({ identityDbPath: dbPath, remoteUrl: "git@example.com:test/repo.git", branch: "main" }, apiKey);

  const identityService = IdentityService.open(dbPath);
  cleanupServices.push(identityService);

  const auditStore = new AuditStore(auditDbPath);
  cleanupStores.push(auditStore);

  const sessionManager = new UserSessionManager({ secureCookies: false });

  const app = express();
  app.use(express.json());
  app.use(createAuditRouter({ auditStore, identityService, sessionManager }));
  app.use("/api/user", createUserRouter({ store: identityService.storeInstance, sessionManager }));

  const server = app.listen(0);
  cleanupServers.push(server);
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return { baseUrl, apiKey, ident, sessionManager, identityService };
}

function cookieHeader(sessionId: string): string {
  return `ceo_user_session=${sessionId}`;
}

describe("Audit uses ceo_user_session + users.is_admin", () => {
  it("admin user session can read traces; non-admin cannot; API-key cookie is gone", async () => {
    const env = await setupApp();
    env.identityService.storeInstance.grantAdmin(env.ident.user_id);

    const adminSession = env.sessionManager.createSession({
      userId: env.ident.user_id,
      provider: "github",
      providerSubject: "40360455",
      providerLogin: "SentimentalK",
    });

    const adminTraces = await fetch(`${env.baseUrl}/api/audit/traces`, {
      headers: { Cookie: cookieHeader(adminSession.sessionId) },
    });
    expect(adminTraces.status).toBe(200);

    const adminStatus = await fetch(`${env.baseUrl}/api/audit/session`, {
      headers: { Cookie: cookieHeader(adminSession.sessionId) },
    });
    expect(await adminStatus.json()).toEqual({
      authenticated: true,
      authorized: true,
      user: { id: env.ident.user_id },
    });

    env.identityService.storeInstance.revokeAdmin(env.ident.user_id);
    const afterRevoke = await fetch(`${env.baseUrl}/api/audit/traces`, {
      headers: { Cookie: cookieHeader(adminSession.sessionId) },
    });
    expect(afterRevoke.status).toBe(403);

    const afterRevokeSession = await fetch(`${env.baseUrl}/api/audit/session`, {
      headers: { Cookie: cookieHeader(adminSession.sessionId) },
    });
    expect(await afterRevokeSession.json()).toEqual({
      authenticated: true,
      authorized: false,
      user: { id: env.ident.user_id },
    });

    env.identityService.storeInstance.grantAdmin(env.ident.user_id);
    const afterGrant = await fetch(`${env.baseUrl}/api/audit/session`, {
      headers: { Cookie: cookieHeader(adminSession.sessionId) },
    });
    expect((await afterGrant.json()).authorized).toBe(true);

    const loginGone = await fetch(`${env.baseUrl}/api/audit/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: env.apiKey }),
    });
    expect(loginGone.status).toBe(410);

    const bearer = await fetch(`${env.baseUrl}/api/audit/traces`, {
      headers: { Authorization: `Bearer ${env.apiKey}` },
    });
    expect(bearer.status).toBe(401);
  });

  it("clears both cookies on audit logout without overwriting Set-Cookie", async () => {
    const env = await setupApp();
    env.identityService.storeInstance.grantAdmin(env.ident.user_id);
    const session = env.sessionManager.createSession({
      userId: env.ident.user_id,
      provider: "github",
      providerSubject: "1",
    });

    const logoutRes = await fetch(`${env.baseUrl}/api/audit/session`, {
      method: "DELETE",
      headers: { Cookie: cookieHeader(session.sessionId) },
    });
    expect(logoutRes.status).toBe(200);
    const cookies = logoutRes.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("ceo_user_session=") && c.includes("Max-Age=0"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("ceo_audit_session=") && c.includes("Max-Age=0"))).toBe(true);
  });

  it("disabled admin session is destroyed on GET /api/audit/session", async () => {
    const env = await setupApp();
    env.identityService.storeInstance.grantAdmin(env.ident.user_id);
    const session = env.sessionManager.createSession({
      userId: env.ident.user_id,
      provider: "github",
      providerSubject: "1",
    });

    env.identityService.storeInstance.withDb((db) => {
      db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?;").run(Date.now(), env.ident.user_id);
    });

    const status = await fetch(`${env.baseUrl}/api/audit/session`, {
      headers: { Cookie: cookieHeader(session.sessionId) },
    });
    expect(await status.json()).toEqual({ authenticated: false, authorized: false });
    const cookies = status.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("ceo_user_session=") && c.includes("Max-Age=0"))).toBe(true);
    expect(env.sessionManager.getSessionFromToken(session.sessionId)).toBeNull();
  });
});
