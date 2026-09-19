import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import express from "express";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import {
  IdentityStore,
  IdentityDbUnavailable,
  sha256Hex,
  IDENTITY_DDL,
  IDENTITY_DB_USER_VERSION,
} from "../src/identity/store.js";
import {
  IdentityService,
  WorkspaceAccessDeniedError,
  WorkspaceSelectionRequiredError,
} from "../src/identity/service.js";
import { createIdentityAuthMiddleware } from "../src/auth.js";

const cleanupDirs: string[] = [];
const cleanupStores: IdentityStore[] = [];
const cleanupServices: IdentityService[] = [];
const cleanupServers: HttpServer[] = [];

afterEach(async () => {
  for (const s of cleanupServers.splice(0)) {
    s.closeAllConnections?.();
    s.closeIdleConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const svc of cleanupServices.splice(0)) svc.close();
  for (const st of cleanupStores.splice(0)) st.close();
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface MultiRowCtx {
  dir: string;
  dbPath: string;
  remoteA: string;
  branchA: string;
  userA: string;
  workspaceA: string;
  keyA: string;
  remoteB: string;
  branchB: string;
  userB: string;
  workspaceB: string;
  keyB: string;
}

async function createMultiRowCtx(): Promise<MultiRowCtx> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-cardinality-test-"));
  cleanupDirs.push(dir);
  const dbPath = path.join(dir, "identity", "identity.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });

  const ctx: MultiRowCtx = {
    dir,
    dbPath,
    remoteA: "git@example.com:org/repo-a.git",
    branchA: "main",
    userA: "usr_alice",
    workspaceA: "ws_alpha",
    keyA: "secret-key-alice",
    remoteB: "git@example.com:org/repo-b.git",
    branchB: "main",
    userB: "usr_bob",
    workspaceB: "ws_bravo",
    keyB: "secret-key-bob",
  };

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(IDENTITY_DDL);
  db.exec(`PRAGMA user_version = ${IDENTITY_DB_USER_VERSION};`);

  const nowMs = 1000000;
  db.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES (?, ?, NULL);").run(ctx.userA, nowMs);
  db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
    ctx.workspaceA,
    ctx.userA,
    ctx.remoteA,
    ctx.branchA,
    nowMs,
  );
  db.prepare("INSERT INTO workspace_memberships VALUES (?, ?, ?, ?, ?);").run(
    "wsm_alice",
    ctx.workspaceA,
    ctx.userA,
    "owner",
    nowMs,
  );
  db.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, NULL);").run(
    "ak_alice_1",
    ctx.userA,
    sha256Hex(ctx.keyA),
    nowMs,
  );

  db.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES (?, ?, NULL);").run(ctx.userB, nowMs + 1);
  db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
    ctx.workspaceB,
    ctx.userB,
    ctx.remoteB,
    ctx.branchB,
    nowMs + 1,
  );
  db.prepare("INSERT INTO workspace_memberships VALUES (?, ?, ?, ?, ?);").run(
    "wsm_bob",
    ctx.workspaceB,
    ctx.userB,
    "owner",
    nowMs + 1,
  );
  db.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, NULL);").run(
    "ak_bob_1",
    ctx.userB,
    sha256Hex(ctx.keyB),
    nowMs + 1,
  );

  db.close();
  return ctx;
}

describe("Identity request-scoped cardinality", () => {
  it("I. API key A and B resolve request-scoped workspace identities; user with 0 workspaces rejected 403; unknown/revoked key remains 401", async () => {
    const ctx = await createMultiRowCtx();

    const userC = "usr_charlie";
    const keyC = "secret-key-charlie";
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES (?, ?, NULL);").run(userC, 1000);
    raw.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, NULL);").run(
      "ak_charlie_1",
      userC,
      sha256Hex(keyC),
      1000,
    );
    raw.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, ?);").run(
      "ak_alice_revoked",
      ctx.userA,
      sha256Hex("revoked-alice-key"),
      1000,
      2000,
    );
    raw.close();

    const service = IdentityService.open(ctx.dbPath);
    cleanupServices.push(service);

    const app = express();
    app.use(express.json());
    app.get("/test", createIdentityAuthMiddleware(service), (_req, res) => {
      res.status(200).json({ identity: res.locals.identity });
    });

    const server = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    cleanupServers.push(server);
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const resA = await fetch(`${baseUrl}/test`, {
      headers: { Authorization: `Bearer ${ctx.keyA}` },
    });
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as { identity: { user_id: string; workspace_id: string } };
    expect(bodyA.identity.user_id).toBe(ctx.userA);
    expect(bodyA.identity.workspace_id).toBe(ctx.workspaceA);

    const resB = await fetch(`${baseUrl}/test`, {
      headers: { Authorization: `Bearer ${ctx.keyB}` },
    });
    expect(resB.status).toBe(200);
    const bodyB = (await resB.json()) as { identity: { user_id: string; workspace_id: string } };
    expect(bodyB.identity.user_id).toBe(ctx.userB);
    expect(bodyB.identity.workspace_id).toBe(ctx.workspaceB);

    const credB = service.authenticateApiKey(ctx.keyB);
    expect(credB).not.toBeNull();
    expect(service.resolveRequestIdentity(credB!).workspace_id).toBe(ctx.workspaceB);
    expect(service.hasWorkspaceAccess(ctx.workspaceA, ctx.userB)).toBe(false);

    const resC = await fetch(`${baseUrl}/test`, {
      headers: { Authorization: `Bearer ${keyC}` },
    });
    expect(resC.status).toBe(403);

    const credC = service.authenticateApiKey(keyC);
    expect(credC).not.toBeNull();
    expect(() => service.resolveRequestIdentity(credC!)).toThrow(WorkspaceAccessDeniedError);

    const resUnknown = await fetch(`${baseUrl}/test`, {
      headers: { Authorization: `Bearer not-a-real-key` },
    });
    expect(resUnknown.status).toBe(401);

    const resRevoked = await fetch(`${baseUrl}/test`, {
      headers: { Authorization: `Bearer revoked-alice-key` },
    });
    expect(resRevoked.status).toBe(401);
  });

  it("I2. DB failure during workspace-authorization phase returns 503, while access denial returns 403 and unexpected errors return 500", async () => {
    const ctx = await createMultiRowCtx();

    const userC = "usr_charlie_i2";
    const keyC = "secret-key-charlie-i2";
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES (?, ?, NULL);").run(userC, 1000);
    raw.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, NULL);").run(
      "ak_charlie_i2",
      userC,
      sha256Hex(keyC),
      1000,
    );
    raw.close();

    const service = IdentityService.open(ctx.dbPath);
    cleanupServices.push(service);

    const app = express();
    app.use(express.json());
    app.get("/test", createIdentityAuthMiddleware(service), (_req, res) => {
      res.status(200).json({ identity: res.locals.identity });
    });

    const server = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    cleanupServers.push(server);
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const normalRes = await fetch(`${baseUrl}/test`, {
      headers: { Authorization: `Bearer ${ctx.keyA}` },
    });
    expect(normalRes.status).toBe(200);

    const resC = await fetch(`${baseUrl}/test`, {
      headers: { Authorization: `Bearer ${keyC}` },
    });
    expect(resC.status).toBe(403);

    const origMethod = service.storeInstance.listWorkspaceMembershipsForUser.bind(service.storeInstance);
    service.storeInstance.listWorkspaceMembershipsForUser = () => {
      throw new IdentityDbUnavailable("Simulated DB connection lost during workspace check");
    };

    try {
      const dbFailRes = await fetch(`${baseUrl}/test`, {
        headers: { Authorization: `Bearer ${ctx.keyA}` },
      });
      expect(dbFailRes.status).toBe(503);
      const dbFailBody = await dbFailRes.json();
      expect(dbFailBody).toEqual({
        jsonrpc: "2.0",
        error: { code: -32050, message: "Identity service unavailable" },
        id: null,
      });
    } finally {
      service.storeInstance.listWorkspaceMembershipsForUser = origMethod;
    }

    service.storeInstance.listWorkspaceMembershipsForUser = () => {
      throw new TypeError("Unrelated unexpected programming error");
    };

    try {
      const unexpectedErrRes = await fetch(`${baseUrl}/test`, {
        headers: { Authorization: `Bearer ${ctx.keyA}` },
      });
      expect(unexpectedErrRes.status).toBe(500);
      const unexpectedErrBody = await unexpectedErrRes.json();
      expect(unexpectedErrBody).toEqual({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      });
    } finally {
      service.storeInstance.listWorkspaceMembershipsForUser = origMethod;
    }
  });

  it("J. Revalidation does not infer a workspace with LIMIT 1 and preserves revoke semantics", async () => {
    const ctx = await createMultiRowCtx();

    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
      "ws_alpha_2",
      ctx.userA,
      "git@example.com:org/repo-a-other.git",
      "main",
      4000000,
    );
    raw.prepare("INSERT INTO workspace_memberships VALUES (?, ?, ?, ?, ?);").run(
      "wsm_alpha_2",
      "ws_alpha_2",
      ctx.userA,
      "owner",
      4000000,
    );
    raw.close();

    const service = IdentityService.open(ctx.dbPath);
    cleanupServices.push(service);

    const credA = service.storeInstance.resolveCredentialByKey("ak_alice_1", ctx.userA);
    expect(credA).not.toBeNull();
    expect(() => service.resolveRequestIdentity(credA!)).toThrow(WorkspaceSelectionRequiredError);
    expect(service.hasWorkspaceAccess(ctx.workspaceA, ctx.userA)).toBe(true);
    expect(service.hasWorkspaceAccess("ws_alpha_2", ctx.userA)).toBe(true);

    const credB = service.storeInstance.resolveCredentialByKey("ak_bob_1", ctx.userB);
    expect(credB).not.toBeNull();
    expect(service.hasWorkspaceAccess(ctx.workspaceA, ctx.userB)).toBe(false);

    const raw2 = new DatabaseSync(ctx.dbPath);
    raw2.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = 'ak_alice_1';").run(Date.now());
    raw2.close();

    expect(service.storeInstance.resolveCredentialByKey("ak_alice_1", ctx.userA)).toBeNull();
  });
});
