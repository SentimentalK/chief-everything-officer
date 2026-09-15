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
  IdentityStructureError,
  sha256Hex,
  IDENTITY_DDL,
  IDENTITY_DB_USER_VERSION,
} from "../src/identity/store.js";
import { IdentityService, WorkspaceAccessDeniedError } from "../src/identity/service.js";
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
  // User A and Workspace A and Key A
  db.prepare("INSERT INTO users VALUES (?, ?, NULL);").run(ctx.userA, nowMs);
  db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
    ctx.workspaceA,
    ctx.userA,
    ctx.remoteA,
    ctx.branchA,
    nowMs,
  );
  db.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, NULL);").run(
    "ak_alice_1",
    ctx.userA,
    sha256Hex(ctx.keyA),
    nowMs,
  );

  // User B and Workspace B and Key B
  db.prepare("INSERT INTO users VALUES (?, ?, NULL);").run(ctx.userB, nowMs + 1);
  db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
    ctx.workspaceB,
    ctx.userB,
    ctx.remoteB,
    ctx.branchB,
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

describe("CEO Step 3.1: Identity database cardinality decoupling", () => {
  it("A. A v2 DB with User A/Workspace A/Key A plus User B/Workspace B/Key B opens and IdentityService configured for A starts successfully", async () => {
    const ctx = await createMultiRowCtx();

    // Store opens without error
    const store = IdentityStore.open(ctx.dbPath);
    cleanupStores.push(store);

    // IdentityService configured for A starts successfully
    const serviceA = IdentityService.open(
      { remoteUrl: ctx.remoteA, branch: ctx.branchA, envApiKey: ctx.keyA },
      ctx.dbPath,
    );
    cleanupServices.push(serviceA);

    expect(serviceA.workspaceIdentityValue).toEqual({
      user_id: ctx.userA,
      workspace_id: ctx.workspaceA,
    });
  });

  it("B. Extra active keys belonging to B do not cause A startup to fail and are never mutated by A startup/rotation", async () => {
    const ctx = await createMultiRowCtx();

    // Add extra active keys for Bob
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, NULL);").run(
      "ak_bob_2",
      ctx.userB,
      sha256Hex("secret-key-bob-extra"),
      2000000,
    );
    const bobKeysBefore = raw
      .prepare("SELECT id, user_id, key_digest, created_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY id ASC;")
      .all(ctx.userB);
    raw.close();

    // Startup for Alice with rotation
    const serviceA = IdentityService.open(
      { remoteUrl: ctx.remoteA, branch: ctx.branchA, envApiKey: "new-alice-key" },
      ctx.dbPath,
    );
    cleanupServices.push(serviceA);

    // Bob's key rows must remain byte-for-byte and logically identical
    const rawAfter = new DatabaseSync(ctx.dbPath);
    const bobKeysAfter = rawAfter
      .prepare("SELECT id, user_id, key_digest, created_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY id ASC;")
      .all(ctx.userB);
    rawAfter.close();

    expect(bobKeysAfter).toEqual(bobKeysBefore);
  });

  it("C. If A env key is already active, A startup succeeds even while unrelated credentials exist", async () => {
    const ctx = await createMultiRowCtx();

    // Bob has extra keys, revoked keys, etc.
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, ?);").run(
      "ak_bob_revoked",
      ctx.userB,
      sha256Hex("bob-revoked"),
      500000,
      600000,
    );
    raw.close();

    const serviceA = IdentityService.open(
      { remoteUrl: ctx.remoteA, branch: ctx.branchA, envApiKey: ctx.keyA },
      ctx.dbPath,
    );
    cleanupServices.push(serviceA);

    expect(serviceA.workspaceIdentityValue.user_id).toBe(ctx.userA);
    const cred = serviceA.authenticateApiKey(ctx.keyA);
    expect(cred).not.toBeNull();
    expect(cred!.user_id).toBe(ctx.userA);
  });

  it("D. If A env key changes and A has exactly one active key, only A's key rotates; B key rows remain byte-for-byte/logically unchanged", async () => {
    const ctx = await createMultiRowCtx();

    const rawBefore = new DatabaseSync(ctx.dbPath);
    const bobRowsBefore = rawBefore
      .prepare("SELECT id, user_id, key_digest, created_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY id ASC;")
      .all(ctx.userB);
    rawBefore.close();

    const serviceA = IdentityService.open(
      { remoteUrl: ctx.remoteA, branch: ctx.branchA, envApiKey: "rotated-alice-key" },
      ctx.dbPath,
    );
    cleanupServices.push(serviceA);

    const rawAfter = new DatabaseSync(ctx.dbPath);
    const aliceRows = rawAfter
      .prepare("SELECT id, user_id, key_digest, created_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY created_at ASC;")
      .all(ctx.userA) as Array<{ id: string; user_id: string; key_digest: string; revoked_at: number | null }>;
    const bobRowsAfter = rawAfter
      .prepare("SELECT id, user_id, key_digest, created_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY id ASC;")
      .all(ctx.userB);
    rawAfter.close();

    expect(bobRowsAfter).toEqual(bobRowsBefore);
    expect(aliceRows).toHaveLength(2);
    expect(aliceRows[0].id).toBe("ak_alice_1");
    expect(aliceRows[0].revoked_at).not.toBeNull();
    expect(aliceRows[1].key_digest).toBe(sha256Hex("rotated-alice-key"));
    expect(aliceRows[1].revoked_at).toBeNull();
  });

  it("E. If configured env key is active for B while runtime config selects A, startup fails and neither user's key state changes", async () => {
    const ctx = await createMultiRowCtx();

    const rawBefore = new DatabaseSync(ctx.dbPath);
    const allKeysBefore = rawBefore.prepare("SELECT * FROM api_keys ORDER BY id ASC;").all();
    rawBefore.close();

    // Alice configuration presenting Bob's key
    expect(() =>
      IdentityService.open(
        { remoteUrl: ctx.remoteA, branch: ctx.branchA, envApiKey: ctx.keyB },
        ctx.dbPath,
      ),
    ).toThrow(IdentityStructureError);

    const rawAfter = new DatabaseSync(ctx.dbPath);
    const allKeysAfter = rawAfter.prepare("SELECT * FROM api_keys ORDER BY id ASC;").all();
    rawAfter.close();

    expect(allKeysAfter).toEqual(allKeysBefore);
  });

  it("F. If A env digest is unknown and A has >1 active keys, startup fails as ambiguous with no mutation", async () => {
    const ctx = await createMultiRowCtx();

    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, NULL);").run(
      "ak_alice_2",
      ctx.userA,
      sha256Hex("another-alice-key"),
      2000000,
    );
    const keysBefore = raw.prepare("SELECT * FROM api_keys ORDER BY id ASC;").all();
    raw.close();

    expect(() =>
      IdentityService.open(
        { remoteUrl: ctx.remoteA, branch: ctx.branchA, envApiKey: "completely-new-key" },
        ctx.dbPath,
      ),
    ).toThrow(/multiple active keys/);

    const rawAfter = new DatabaseSync(ctx.dbPath);
    const keysAfter = rawAfter.prepare("SELECT * FROM api_keys ORDER BY id ASC;").all();
    rawAfter.close();

    expect(keysAfter).toEqual(keysBefore);
  });

  it("G. Zero configured remote/branch matches fails; duplicate configured remote/branch matches fails instead of selecting arbitrary row", async () => {
    const ctx = await createMultiRowCtx();

    // Zero matches
    expect(() =>
      IdentityService.open(
        { remoteUrl: "git@example.com:org/nonexistent.git", branch: "main", envApiKey: ctx.keyA },
        ctx.dbPath,
      ),
    ).toThrow(/No workspace found/);

    // Duplicate matches
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
      "ws_duplicate",
      ctx.userA,
      ctx.remoteA,
      ctx.branchA,
      3000000,
    );
    raw.close();

    expect(() =>
      IdentityService.open(
        { remoteUrl: ctx.remoteA, branch: ctx.branchA, envApiKey: ctx.keyA },
        ctx.dbPath,
      ),
    ).toThrow(/Ambiguous runtime target/);
  });

  it("H. Disabled unrelated User B does not block A startup; disabled selected owner A does block startup/auth", async () => {
    const ctx = await createMultiRowCtx();

    // Disable Bob
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("UPDATE users SET disabled_at = ? WHERE id = ?;").run(Date.now(), ctx.userB);
    raw.close();

    // Alice startup succeeds despite Bob being disabled
    const serviceA = IdentityService.open(
      { remoteUrl: ctx.remoteA, branch: ctx.branchA, envApiKey: ctx.keyA },
      ctx.dbPath,
    );
    cleanupServices.push(serviceA);
    expect(serviceA.workspaceIdentityValue.user_id).toBe(ctx.userA);

    // Now disable Alice
    const raw2 = new DatabaseSync(ctx.dbPath);
    raw2.prepare("UPDATE users SET disabled_at = ? WHERE id = ?;").run(Date.now(), ctx.userA);
    raw2.close();

    // Alice startup now fails
    expect(() =>
      IdentityService.open(
        { remoteUrl: ctx.remoteA, branch: ctx.branchA, envApiKey: ctx.keyA },
        ctx.dbPath,
      ),
    ).toThrow(/disabled/);

    // Already open service refuses authentication for disabled Alice
    expect(serviceA.authenticateApiKey(ctx.keyA)).toBeNull();
  });

  it("I. API key A reaches current runtime; valid key B is recognized as authenticated but rejected 403 for runtime A; unknown/revoked key remains 401", async () => {
    const ctx = await createMultiRowCtx();

    // Add a revoked key for Alice
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, ?);").run(
      "ak_alice_revoked",
      ctx.userA,
      sha256Hex("revoked-alice-key"),
      1000,
      2000,
    );
    raw.close();

    const serviceA = IdentityService.open(
      { remoteUrl: ctx.remoteA, branch: ctx.branchA, envApiKey: ctx.keyA },
      ctx.dbPath,
    );
    cleanupServices.push(serviceA);

    // Express app using createIdentityAuthMiddleware
    const app = express();
    app.use(express.json());
    app.get("/test", createIdentityAuthMiddleware(serviceA), (_req, res) => {
      res.status(200).json({ identity: res.locals.identity });
    });

    const server = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    cleanupServers.push(server);
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Key A succeeds -> 200
    const resA = await fetch(`${baseUrl}/test`, {
      headers: { Authorization: `Bearer ${ctx.keyA}` },
    });
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as { identity: { user_id: string; workspace_id: string } };
    expect(bodyA.identity.user_id).toBe(ctx.userA);
    expect(bodyA.identity.workspace_id).toBe(ctx.workspaceA);

    // 2. Key B is valid credential for Bob but not authorized for runtime A -> 403
    const resB = await fetch(`${baseUrl}/test`, {
      headers: { Authorization: `Bearer ${ctx.keyB}` },
    });
    expect(resB.status).toBe(403);

    // 3. Unknown key -> 401
    const resUnknown = await fetch(`${baseUrl}/test`, {
      headers: { Authorization: `Bearer not-a-real-key` },
    });
    expect(resUnknown.status).toBe(401);

    // 4. Revoked key -> 401
    const resRevoked = await fetch(`${baseUrl}/test`, {
      headers: { Authorization: `Bearer revoked-alice-key` },
    });
    expect(resRevoked.status).toBe(401);
  });

  it("J. Revalidation/session path does not infer a workspace with LIMIT 1 and preserves revoke semantics", async () => {
    const ctx = await createMultiRowCtx();

    // Alice owns a second workspace ws_alpha_2
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
      "ws_alpha_2",
      ctx.userA,
      "git@example.com:org/repo-a-other.git",
      "main",
      4000000,
    );
    raw.close();

    const serviceA = IdentityService.open(
      { remoteUrl: ctx.remoteA, branch: ctx.branchA, envApiKey: ctx.keyA },
      ctx.dbPath,
    );
    cleanupServices.push(serviceA);

    // Revalidation for Alice's key resolves explicitly to serviceA's served workspace, never ws_alpha_2
    const resolved = serviceA.revalidateAndOwnership({ api_key_id: "ak_alice_1", user_id: ctx.userA });
    expect(resolved).not.toBeNull();
    expect(resolved!.workspace_id).toBe(ctx.workspaceA);
    expect(resolved!.user_id).toBe(ctx.userA);

    // Revalidation for Bob's key against serviceA returns null (not authorized for workspaceA)
    const bobResolved = serviceA.revalidateAndOwnership({ api_key_id: "ak_bob_1", user_id: ctx.userB });
    expect(bobResolved).toBeNull();

    // Revoking Alice's key causes revalidation to return null
    const raw2 = new DatabaseSync(ctx.dbPath);
    raw2.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = 'ak_alice_1';").run(Date.now());
    raw2.close();

    const revokedResolved = serviceA.revalidateAndOwnership({ api_key_id: "ak_alice_1", user_id: ctx.userA });
    expect(revokedResolved).toBeNull();
  });

  it("K. initialize() against an existing multi-row DB validates the selected A binding/key and never rotates it", async () => {
    const ctx = await createMultiRowCtx();

    const rawBefore = new DatabaseSync(ctx.dbPath);
    const keysBefore = rawBefore.prepare("SELECT * FROM api_keys ORDER BY id ASC;").all();
    rawBefore.close();

    // Matching key: succeeds and reports unchanged
    const initResult = IdentityService.initialize(
      { remoteUrl: ctx.remoteA, branch: ctx.branchA, envApiKey: ctx.keyA },
      ctx.dbPath,
    );
    expect(initResult).toEqual({
      userId: ctx.userA,
      workspaceId: ctx.workspaceA,
      created: false,
    });

    const rawAfter = new DatabaseSync(ctx.dbPath);
    const keysAfter = rawAfter.prepare("SELECT * FROM api_keys ORDER BY id ASC;").all();
    rawAfter.close();
    expect(keysAfter).toEqual(keysBefore);

    // Non-matching key: fails and never rotates
    expect(() =>
      IdentityService.initialize(
        { remoteUrl: ctx.remoteA, branch: ctx.branchA, envApiKey: "different-key" },
        ctx.dbPath,
      ),
    ).toThrow(/different active key/);

    const rawAfterFail = new DatabaseSync(ctx.dbPath);
    const keysAfterFail = rawAfterFail.prepare("SELECT * FROM api_keys ORDER BY id ASC;").all();
    rawAfterFail.close();
    expect(keysAfterFail).toEqual(keysBefore);
  });
});
