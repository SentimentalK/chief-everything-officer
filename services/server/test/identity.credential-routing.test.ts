import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { rm, mkdtemp } from "node:fs/promises";
import express from "express";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  IdentityService,
  WorkspaceAccessDeniedError,
  WorkspaceSelectionRequiredError,
  IdentityDbUnavailable,
} from "../src/identity/service.js";
import { IDENTITY_DDL, IDENTITY_DB_USER_VERSION, sha256Hex } from "../src/identity/store.js";
import { createIdentityAuthMiddleware } from "../src/auth.js";

import { OAuthService } from "../src/oauth/service.js";
import { OAuthStore } from "../src/oauth/store.js";
import { OAUTH_DDL, OAUTH_DB_USER_VERSION } from "../src/oauth/store.js";

describe("Step 4B.1: Request-scoped credential to workspace resolution", () => {
  const cleanupDirs: string[] = [];
  const cleanupServices: IdentityService[] = [];
  const cleanupServers: HttpServer[] = [];
  const cleanupOAuthStores: OAuthStore[] = [];

  afterEach(async () => {
    for (const s of cleanupServers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    for (const svc of cleanupServices.splice(0)) svc.close();
    for (const store of cleanupOAuthStores.splice(0)) store.close();
    await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createTestEnv() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-cred-routing-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "identity.sqlite");
    const oauthDbPath = path.join(dir, "oauth.sqlite");

    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(IDENTITY_DDL);
    db.exec(`PRAGMA user_version = ${IDENTITY_DB_USER_VERSION};`);

    const now = 1000000;

    // Seed deployment workspace (ws_deploy) and owner user (usr_deploy)
    db.prepare("INSERT INTO users VALUES (?, ?, NULL);").run("usr_deploy", now);
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
      "ws_deploy",
      "usr_deploy",
      "git@github.com:org/deploy.git",
      "main",
      now,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES (?, ?, ?, ?, ?);").run(
      "wsm_deploy",
      "ws_deploy",
      "usr_deploy",
      "owner",
      now,
    );
    db.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, NULL);").run(
      "ak_deploy",
      "usr_deploy",
      sha256Hex("key_deploy"),
      now,
    );

    // User Single: has exactly 1 workspace membership
    db.prepare("INSERT INTO users VALUES (?, ?, NULL);").run("usr_single", now);
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
      "ws_single",
      "usr_single",
      "git@github.com:org/single.git",
      "main",
      now,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES (?, ?, ?, ?, ?);").run(
      "wsm_single",
      "ws_single",
      "usr_single",
      "owner",
      now,
    );
    db.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, NULL);").run(
      "ak_single",
      "usr_single",
      sha256Hex("key_single"),
      now,
    );

    // User Zero: has 0 workspace memberships
    db.prepare("INSERT INTO users VALUES (?, ?, NULL);").run("usr_zero", now);
    db.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, NULL);").run(
      "ak_zero",
      "usr_zero",
      sha256Hex("key_zero"),
      now,
    );

    // User Multi: has 2 workspace memberships
    db.prepare("INSERT INTO users VALUES (?, ?, NULL);").run("usr_multi", now);
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
      "ws_multi_1",
      "usr_multi",
      "git@github.com:org/multi-1.git",
      "main",
      now,
    );
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
      "ws_multi_2",
      "usr_multi",
      "git@github.com:org/multi-2.git",
      "main",
      now,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES (?, ?, ?, ?, ?);").run(
      "wsm_multi_1",
      "ws_multi_1",
      "usr_multi",
      "owner",
      now,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES (?, ?, ?, ?, ?);").run(
      "wsm_multi_2",
      "ws_multi_2",
      "usr_multi",
      "owner",
      now + 100,
    );
    db.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, NULL);").run(
      "ak_multi",
      "usr_multi",
      sha256Hex("key_multi"),
      now,
    );

    db.close();

    // Setup OAuth DB
    const oauthDb = new DatabaseSync(oauthDbPath);
    oauthDb.exec("PRAGMA foreign_keys = ON;");
    oauthDb.exec(OAUTH_DDL);
    oauthDb.exec(`PRAGMA user_version = ${OAUTH_DB_USER_VERSION};`);
    oauthDb.close();

    const identityService = IdentityService.open(
      {
        remoteUrl: "git@github.com:org/deploy.git",
        branch: "main",
        envApiKey: "key_deploy",
      },
      dbPath,
    );
    cleanupServices.push(identityService);

    const oauthStore = new OAuthStore(oauthDbPath);
    cleanupOAuthStores.push(oauthStore);

    const oauthService = new OAuthService(oauthStore, identityService.store, {
      publicOrigin: "http://localhost:3000",
      clientResolver: {
        getClient: async () => ({
          client_id: "test-client",
          redirect_uris: ["http://localhost:3000/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      },
    });

    return {
      identityService,
      oauthService,
      oauthStore,
    };
  }

  it("resolveRequestIdentity: 1 membership selects workspace; 0 memberships rejects 403; >1 rejects 403", async () => {
    const { identityService } = await createTestEnv();

    // 1. Single workspace membership resolves cleanly
    const credSingle = identityService.authenticateApiKey("key_single");
    expect(credSingle).not.toBeNull();
    const authSingle = identityService.resolveRequestIdentity(credSingle!);
    expect(authSingle).toEqual({
      user_id: "usr_single",
      api_key_id: "ak_single",
      workspace_id: "ws_single",
    });

    // 2. Zero workspace memberships throws WorkspaceAccessDeniedError
    const credZero = identityService.authenticateApiKey("key_zero");
    expect(credZero).not.toBeNull();
    expect(() => identityService.resolveRequestIdentity(credZero!)).toThrow(
      WorkspaceAccessDeniedError,
    );

    // 3. Multiple workspace memberships throws WorkspaceSelectionRequiredError
    const credMulti = identityService.authenticateApiKey("key_multi");
    expect(credMulti).not.toBeNull();
    expect(() => identityService.resolveRequestIdentity(credMulti!)).toThrow(
      WorkspaceSelectionRequiredError,
    );
  });

  it("createIdentityAuthMiddleware: verifies 200 for single, 403 for 0 and >1, 503 on DB fault", async () => {
    const { identityService } = await createTestEnv();

    const app = express();
    app.use(express.json());
    app.get("/identity", createIdentityAuthMiddleware(identityService), (_req, res) => {
      res.status(200).json(res.locals.identity);
    });

    const server = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    cleanupServers.push(server);
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/identity`;

    // 1. User with 1 workspace gets 200 with request-scoped workspace
    const resSingle = await fetch(url, { headers: { Authorization: "Bearer key_single" } });
    expect(resSingle.status).toBe(200);
    const bodySingle = await resSingle.json();
    expect(bodySingle).toEqual({
      user_id: "usr_single",
      api_key_id: "ak_single",
      workspace_id: "ws_single",
    });

    // 2. User with 0 workspaces gets 403 Forbidden: workspace access denied
    const resZero = await fetch(url, { headers: { Authorization: "Bearer key_zero" } });
    expect(resZero.status).toBe(403);
    const bodyZero = await resZero.json();
    expect(bodyZero.error.message).toBe("Forbidden: workspace access denied");

    // 3. User with >1 workspaces gets 403 Forbidden: workspace selection required
    const resMulti = await fetch(url, { headers: { Authorization: "Bearer key_multi" } });
    expect(resMulti.status).toBe(403);
    const bodyMulti = await resMulti.json();
    expect(bodyMulti.error.message).toBe("Forbidden: workspace selection required");

    // 4. DB failure in listWorkspaceMembershipsForUser returns 503
    const origList = identityService.store.listWorkspaceMembershipsForUser.bind(identityService.store);
    identityService.store.listWorkspaceMembershipsForUser = () => {
      throw new IdentityDbUnavailable("DB disconnected");
    };

    try {
      const res503 = await fetch(url, { headers: { Authorization: "Bearer key_single" } });
      expect(res503.status).toBe(503);
      const body503 = await res503.json();
      expect(body503.error.code).toBe(-32050);
      expect(body503.error.message).toBe("Identity service unavailable");
    } finally {
      identityService.store.listWorkspaceMembershipsForUser = origList;
    }
  });

  it("OAuth approveConsent: binds to user's single workspace; rejects 0 and >1 memberships", async () => {
    const { oauthService, oauthStore } = await createTestEnv();

    const initAuth = (requestId: string) => {
      oauthStore.createAuthorizationRequest({
        id: requestId,
        client_id: "test-client",
        client_name: "Test Client",
        redirect_uri: "http://localhost:3000/callback",
        code_challenge: "E9Melhoa2OwvFrGMTJguCH5rtx64KA344jbyt7ZVD67",
        code_challenge_method: "S256",
        scope: "mcp",
        resource: "http://localhost:3000/mcp",
        state: "xyz",
        expires_at_ms: Date.now() + 600000,
        created_at_ms: Date.now(),
      });
    };

    // 1. Single workspace user -> approves and returns code
    initAuth("req_single");
    const nonceSingle = oauthService.createConsentNonce("req_single");
    const approveResult = oauthService.approveConsent("req_single", nonceSingle, "usr_single");
    expect(approveResult.code).toBeDefined();
    expect(approveResult.redirectUri).toBe("http://localhost:3000/callback");

    // 2. Zero workspace user -> access_denied
    initAuth("req_zero");
    const nonceZero = oauthService.createConsentNonce("req_zero");
    expect(() => oauthService.approveConsent("req_zero", nonceZero, "usr_zero")).toThrowError(
      /User has no accessible workspaces/,
    );

    // 3. Multi workspace user -> access_denied (Workspace selection required)
    initAuth("req_multi");
    const nonceMulti = oauthService.createConsentNonce("req_multi");
    expect(() => oauthService.approveConsent("req_multi", nonceMulti, "usr_multi")).toThrowError(
      /Workspace selection required/,
    );
  });
});
