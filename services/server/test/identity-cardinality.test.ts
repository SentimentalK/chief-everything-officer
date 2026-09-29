import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  IdentityStore,
  IdentityDbUnavailable,
  IDENTITY_DDL,
  IDENTITY_DB_USER_VERSION,
} from "../src/identity/store.js";
import {
  IdentityService,
  WorkspaceAccessDeniedError,
  WorkspaceSelectionRequiredError,
} from "../src/identity/service.js";

const cleanupDirs: string[] = [];
const cleanupStores: IdentityStore[] = [];
const cleanupServices: IdentityService[] = [];

afterEach(async () => {
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
  remoteB: string;
  branchB: string;
  userB: string;
  workspaceB: string;
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
    remoteB: "git@example.com:org/repo-b.git",
    branchB: "main",
    userB: "usr_bob",
    workspaceB: "ws_bravo",
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

  db.close();
  return ctx;
}

describe("Identity request-scoped cardinality", () => {
  it("I. users A and B resolve request-scoped workspace identities; user with 0 workspaces is denied; workspaces are isolated", async () => {
    const ctx = await createMultiRowCtx();

    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES (?, ?, NULL);").run("usr_charlie", 1000);
    raw.close();

    const service = IdentityService.open(ctx.dbPath);
    cleanupServices.push(service);

    // User A and B each resolve their one workspace deterministically
    const identityA = service.resolveUserWorkspace(ctx.userA);
    expect(identityA).toEqual({
      user_id: ctx.userA,
      workspace_id: ctx.workspaceA,
    });
    const identityB = service.resolveUserWorkspace(ctx.userB);
    expect(identityB).toEqual({
      user_id: ctx.userB,
      workspace_id: ctx.workspaceB,
    });

    // Workspace access is scoped: a user cannot reach another user's workspace
    expect(service.hasWorkspaceAccess(ctx.workspaceA, ctx.userA)).toBe(true);
    expect(service.hasWorkspaceAccess(ctx.workspaceA, ctx.userB)).toBe(false);
    expect(service.hasWorkspaceAccess(ctx.workspaceB, ctx.userB)).toBe(true);
    expect(service.hasWorkspaceAccess(ctx.workspaceB, ctx.userA)).toBe(false);

    // User with 0 memberships fails closed (no workspace is guessed)
    expect(() => service.resolveUserWorkspace("usr_charlie")).toThrow(WorkspaceAccessDeniedError);
  });

  it("I2. DB failure during workspace resolution propagates IdentityDbUnavailable (fail-closed); unexpected errors propagate", async () => {
    const ctx = await createMultiRowCtx();

    const service = IdentityService.open(ctx.dbPath);
    cleanupServices.push(service);

    // Baseline resolution works
    expect(service.resolveUserWorkspace(ctx.userA).workspace_id).toBe(ctx.workspaceA);

    const origMethod = service.storeInstance.listWorkspaceMembershipsForUser.bind(service.storeInstance);
    service.storeInstance.listWorkspaceMembershipsForUser = () => {
      throw new IdentityDbUnavailable("Simulated DB connection lost during workspace check");
    };

    try {
      expect(() => service.resolveUserWorkspace(ctx.userA)).toThrow(IdentityDbUnavailable);
    } finally {
      service.storeInstance.listWorkspaceMembershipsForUser = origMethod;
    }

    service.storeInstance.listWorkspaceMembershipsForUser = () => {
      throw new TypeError("Unrelated unexpected programming error");
    };

    try {
      expect(() => service.resolveUserWorkspace(ctx.userA)).toThrow(TypeError);
    } finally {
      service.storeInstance.listWorkspaceMembershipsForUser = origMethod;
    }
  });

  it("J. workspace resolution never infers a workspace with LIMIT 1 once a user owns several", async () => {
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

    // A second workspace makes selection required; no single workspace is inferred
    expect(() => service.resolveUserWorkspace(ctx.userA)).toThrow(WorkspaceSelectionRequiredError);
    expect(service.hasWorkspaceAccess(ctx.workspaceA, ctx.userA)).toBe(true);
    expect(service.hasWorkspaceAccess("ws_alpha_2", ctx.userA)).toBe(true);

    // User B is unaffected
    expect(service.resolveUserWorkspace(ctx.userB).workspace_id).toBe(ctx.workspaceB);
    expect(service.hasWorkspaceAccess(ctx.workspaceA, ctx.userB)).toBe(false);
  });
});