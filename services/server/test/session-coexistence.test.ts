import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Server as HttpServer } from "node:http";
import {
  IdentityStore,
  provisionEmptyIdentityDatabase,
  sha256Hex,
} from "../src/identity/store.js";
import { IdentityService } from "../src/identity/service.js";
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

async function setupCoexistenceApp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-coexistence-test-"));
  cleanupDirs.push(dir);

  const dbPath = path.join(dir, "identity.sqlite");
  const auditDbPath = path.join(dir, "audit.sqlite");
  const apiKey = "mcp-secret-key-123";

  const ident = provisionEmptyIdentityDatabase(dbPath, {
    remoteUrl: "git@example.com:test/repo.git",
    branch: "main",
    apiKeyDigest: sha256Hex(apiKey),
  });

  const identityService = IdentityService.open(
    { remoteUrl: "git@example.com:test/repo.git", branch: "main", envApiKey: apiKey },
    dbPath,
  );
  cleanupServices.push(identityService);

  const auditStore = new AuditStore(auditDbPath);
  cleanupStores.push(auditStore);

  const sessionManager = new UserSessionManager({ secureCookies: false });

  const app = express();
  app.use(express.json());

  // Mount both routers exactly as in server.ts
  app.use(createAuditRouter({ auditStore, identityService }));
  app.use("/api/user", createUserRouter({ store: identityService.storeInstance, sessionManager }));

  const server = app.listen(0);
  cleanupServers.push(server);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    apiKey,
    ident,
    sessionManager,
  };
}

describe("Session Coexistence: ceo_audit_session vs ceo_user_session", () => {
  it("strictly enforces boundary separation and independent lifetimes", async () => {
    const env = await setupCoexistenceApp();

    // 1. Obtain ceo_audit_session via API key login
    const auditLoginRes = await fetch(`${env.baseUrl}/api/audit/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: env.apiKey }),
    });
    expect(auditLoginRes.status).toBe(200);
    const auditSetCookie = auditLoginRes.headers.get("set-cookie")!;
    expect(auditSetCookie).toContain("ceo_audit_session=");
    const auditToken = auditSetCookie.match(/ceo_audit_session=([^;]+)/)![1];

    // 2. Create ceo_user_session via UserSessionManager
    const userSession = env.sessionManager.createSession({
      userId: env.ident.user_id,
      workspaceId: env.ident.workspace_id,
      provider: "github",
      providerSubject: "40360455",
      providerLogin: "SentimentalK",
    });
    const userToken = userSession.sessionId;

    // Test A: ONLY ceo_user_session presented
    const reqA_User = await fetch(`${env.baseUrl}/api/user/session`, {
      headers: { Cookie: `ceo_user_session=${userToken}` },
    });
    expect(reqA_User.status).toBe(200);
    expect((await reqA_User.json()).authenticated).toBe(true);

    const reqA_Audit = await fetch(`${env.baseUrl}/api/audit/traces`, {
      headers: { Cookie: `ceo_user_session=${userToken}` },
    });
    expect(reqA_Audit.status).toBe(401); // User session MUST NOT grant audit access

    // Test B: ONLY ceo_audit_session presented
    const reqB_Audit = await fetch(`${env.baseUrl}/api/audit/traces`, {
      headers: { Cookie: `ceo_audit_session=${auditToken}` },
    });
    expect(reqB_Audit.status).toBe(200); // Audit session grants audit access

    const reqB_User = await fetch(`${env.baseUrl}/api/user/session`, {
      headers: { Cookie: `ceo_audit_session=${auditToken}` },
    });
    expect(reqB_User.status).toBe(200);
    expect((await reqB_User.json()).authenticated).toBe(false); // Audit session MUST NOT count as product user

    // Test C: BOTH cookies presented simultaneously
    const reqC_Audit = await fetch(`${env.baseUrl}/api/audit/traces`, {
      headers: { Cookie: `ceo_user_session=${userToken}; ceo_audit_session=${auditToken}` },
    });
    expect(reqC_Audit.status).toBe(200);

    const reqC_User = await fetch(`${env.baseUrl}/api/user/session`, {
      headers: { Cookie: `ceo_user_session=${userToken}; ceo_audit_session=${auditToken}` },
    });
    expect(reqC_User.status).toBe(200);
    expect((await reqC_User.json()).authenticated).toBe(true);

    // Test D: Log out from user session does NOT destroy audit session
    const logoutUserRes = await fetch(`${env.baseUrl}/api/user/session/logout`, {
      method: "POST",
      headers: { Cookie: `ceo_user_session=${userToken}; ceo_audit_session=${auditToken}` },
    });
    expect(logoutUserRes.status).toBe(200);

    // Audit session remains valid
    const reqD_Audit = await fetch(`${env.baseUrl}/api/audit/traces`, {
      headers: { Cookie: `ceo_audit_session=${auditToken}` },
    });
    expect(reqD_Audit.status).toBe(200);

    // User session is gone
    const reqD_User = await fetch(`${env.baseUrl}/api/user/session`, {
      headers: { Cookie: `ceo_user_session=${userToken}` },
    });
    expect((await reqD_User.json()).authenticated).toBe(false);
  });
});
