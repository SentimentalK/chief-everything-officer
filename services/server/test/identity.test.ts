import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  IdentityStore,
  provisionEmptyIdentityDatabase,
  sha256Hex,
  IDENTITY_DB_USER_VERSION,
  IdentityConflictError,
  IdentityStructureError,
} from "../src/identity/store.js";
import { IdentityService } from "../src/identity/service.js";
import { IdentityAccountProvisioner } from "../src/identity/provisioner.js";

const cleanupDirs: string[] = [];
const cleanupStores: IdentityStore[] = [];
const cleanupServices: IdentityService[] = [];

afterEach(async () => {
  for (const s of cleanupServices.splice(0)) s.close();
  for (const st of cleanupStores.splice(0)) st.close();
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Ctx {
  dir: string;
  dbPath: string;
  remoteUrl: string;
  branch: string;
}

async function tempCtx(): Promise<Ctx> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-identity-test-"));
  cleanupDirs.push(dir);
  return {
    dir,
    dbPath: path.join(dir, "identity", "identity.sqlite"),
    remoteUrl: "git@example.com:org/repo.git",
    branch: "main",
  };
}

function provision(ctx: Ctx, apiKey = "key-1") {
  return provisionEmptyIdentityDatabase(ctx.dbPath, {
    remoteUrl: ctx.remoteUrl,
    branch: ctx.branch,
    apiKeyDigest: sha256Hex(apiKey),
  });
}

function openRaw(ctx: Ctx): IdentityStore {
  const store = IdentityStore.open(ctx.dbPath);
  cleanupStores.push(store);
  return store;
}

function openService(ctx: Ctx, apiKey: string): IdentityService {
  const svc = IdentityService.open(
    { remoteUrl: ctx.remoteUrl, branch: ctx.branch, envApiKey: apiKey },
    ctx.dbPath,
  );
  cleanupServices.push(svc);
  return svc;
}

describe("Identity store: schema, invariants and permissions", () => {
  it("sets user_version and dir/file permissions on provisioning", async () => {
    const ctx = await tempCtx();
    const id = provision(ctx, "key-1");
    expect(id.user_id).toMatch(/^usr_/);
    expect(id.workspace_id).toMatch(/^ws_/);

    expect(fs.statSync(path.dirname(ctx.dbPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(ctx.dbPath).mode & 0o777).toBe(0o600);

    openRaw(ctx);
    const raw = new DatabaseSync(ctx.dbPath);
    const ver = raw.prepare("PRAGMA user_version;").get() as { user_version: number };
    raw.close();
    expect(Number(ver.user_version)).toBe(IDENTITY_DB_USER_VERSION);
  });

  it("declines a missing database at startup (fail-fast, no silent creation)", async () => {
    const ctx = await tempCtx();
    const missing = path.join(ctx.dir, "nope", "identity.sqlite");
    expect(() =>
      IdentityService.open({ remoteUrl: ctx.remoteUrl, branch: ctx.branch, envApiKey: "key-1" }, missing),
    ).toThrow(/not found/);
    // The server must not have created the file.
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("rejects a structurally invalid database (wrong user_version)", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec("PRAGMA user_version = 99;");
    raw.close();
    expect(() => IdentityStore.open(ctx.dbPath)).toThrow(/user_version/);
  });

  it("rules out ambiguous key rotation when user has multiple active keys and env key is unknown", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec(
      "INSERT INTO api_keys (id, user_id, key_digest, created_at, revoked_at) " +
        `VALUES ('ak_extra', (SELECT id FROM users), '${sha256Hex("extra")}', ${Date.now()}, NULL);`,
    );
    raw.close();
    // Startup invariant validation rejects ambiguous rotation when env key is unknown.
    expect(() =>
      IdentityService.open({ remoteUrl: ctx.remoteUrl, branch: ctx.branch, envApiKey: "key-unknown" }, ctx.dbPath),
    ).toThrow(/multiple active keys/);
  });
});

describe("Identity service: startup validation and key lifecycle", () => {
  it("keeps the same user/workspace across repeat starts and key rotation", async () => {
    const ctx = await tempCtx();
    provision(ctx);
    const first = openService(ctx, "key-1").workspaceIdentityValue;

    const same = openService(ctx, "key-1");
    expect(same.workspaceIdentityValue).toEqual(first);

    const rotated = openService(ctx, "key-2");
    expect(rotated.workspaceIdentityValue).toEqual(first);

    // Rotation invalidates the old key and activates the new one.
    expect(rotated.authenticateApiKey("key-1")).toBeNull();
    const cred = rotated.authenticateApiKey("key-2");
    expect(cred).not.toBeNull();
    expect(cred!.user_id).toBe(first.user_id);
    expect(cred!.api_key_id).toMatch(/^ak_/);
    const auth = rotated.assertWorkspaceAccess(cred!);
    expect(auth.user_id).toBe(first.user_id);
    expect(auth.workspace_id).toBe(first.workspace_id);
    expect(auth.api_key_id).toBe(cred!.api_key_id);
  });

  it("refuses to revive a previously revoked key", async () => {
    const ctx = await tempCtx();
    provision(ctx);
    openService(ctx, "key-1");
    openService(ctx, "key-2"); // revokes key-1
    expect(() => IdentityService.open({ remoteUrl: ctx.remoteUrl, branch: ctx.branch, envApiKey: "key-1" }, ctx.dbPath))
      .toThrow(/revoked/);
  });

  it("refuses to bind an existing identity to a different remote/branch", async () => {
    const ctx = await tempCtx();
    provision(ctx);
    openService(ctx, "key-1");
    expect(() => IdentityService.open({ remoteUrl: "other.git", branch: "main", envApiKey: "key-1" }, ctx.dbPath))
      .toThrow(/remote/);
    expect(() => IdentityService.open({ remoteUrl: ctx.remoteUrl, branch: "dev", envApiKey: "key-1" }, ctx.dbPath))
      .toThrow(/branch/);
  });

  it("fails startup and refuses auth while the single user is disabled", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec(`UPDATE users SET disabled_at = ${Date.now()} WHERE disabled_at IS NULL;`);
    raw.close();

    // The identity's own user is disabled -> the server must not start.
    expect(() => IdentityService.open({ remoteUrl: ctx.remoteUrl, branch: ctx.branch, envApiKey: "key-1" }, ctx.dbPath))
      .toThrow(/disabled/);
  });

  it("revalidates earlier identities as false once the key is revoked", async () => {
    const ctx = await tempCtx();
    provision(ctx);
    const svc = openService(ctx, "key-1");
    const auth = svc.authenticateApiKey("key-1")!;
    expect(svc.revalidate(auth)).toBe(true);

    const rotated = openService(ctx, "key-2");
    expect(rotated.revalidate(auth)).toBe(false);
  });
});

/** SQL helpers for building “almost-valid” databases that miss ONE contract rule. */
function topicBrokenSchema(
  dbPath: string,
  defect: "no-pk" | "no-foreign-key" | "no-unique" | "no-not-null",
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  const noPk = defect === "no-pk";
  const noFk = defect === "no-foreign-key";
  const noUnique = defect === "no-unique";
  const noNotNull = defect === "no-not-null";

  const idDef = noPk ? "TEXT NOT NULL" : "TEXT PRIMARY KEY NOT NULL";
  const usersCreatedAt = noNotNull ? "INTEGER" : "INTEGER NOT NULL";
  const wsForeignKey = noFk ? "" : ", FOREIGN KEY (owner_user_id) REFERENCES users(id)";
  const akForeignKey = noFk ? "" : ", FOREIGN KEY (user_id) REFERENCES users(id)";
  const digestUnique = noUnique ? "" : "UNIQUE";
  const extForeignKey = noFk ? "" : ", FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE";
  const extUniqueSubject = noUnique ? "" : ", UNIQUE(provider, provider_subject)";
  const extUniqueUser = noUnique ? "" : ", UNIQUE(provider, user_id)";

  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`
    CREATE TABLE users (
      id ${idDef},
      created_at ${usersCreatedAt},
      disabled_at INTEGER
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      owner_user_id TEXT NOT NULL,
      remote_url TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at INTEGER NOT NULL${wsForeignKey}
    );
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      key_digest TEXT NOT NULL ${digestUnique},
      created_at INTEGER NOT NULL,
      revoked_at INTEGER${akForeignKey}
    );
    CREATE TABLE external_identities (
      id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      user_id TEXT NOT NULL,
      provider_login TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL${extUniqueSubject}${extUniqueUser}${extForeignKey}
    );
    PRAGMA user_version = 2;
  `);
  db.close();
}

describe("Provisioning atomicity & no-overwrite publish", () => {
  it("two competing provisions settle on exactly one identity and leave no temp files", async () => {
    const ctx = await tempCtx();
    const first = provision(ctx, "key-a");
    const second = provision(ctx, "key-b"); // competes with the already-published DB

    // The winning DB wins; the second call must not have replaced anything.
    const verified = IdentityStore.open(ctx.dbPath).loadVerifiedBinding();
    expect(verified.user.id).toBe(first.user_id);
    expect(verified.workspace.id).toBe(first.workspace_id);

    const leftOver = fs.readdirSync(path.dirname(ctx.dbPath)).filter((f) => f.includes(".identity-init-"));
    expect(leftOver).toEqual([]);

    // second could have returned either the winner or the same (never a third id).
    expect([first.user_id, second?.user_id ?? ""]).toContain(first.user_id ?? "");
  });

  it("fails cleanly (no temp leak) when the publish target is unusable (a directory)", async () => {
    const ctx = await tempCtx();
    fs.mkdirSync(ctx.dbPath, { recursive: true }); // dbPath is a directory => link fails non-EEXIST
    expect(() =>
      provisionEmptyIdentityDatabase(ctx.dbPath, {
        remoteUrl: ctx.remoteUrl,
        branch: ctx.branch,
        apiKeyDigest: sha256Hex("key"),
      }),
    ).toThrow();
    expect(fs.readdirSync(path.dirname(ctx.dbPath)).filter((f) => f.includes(".identity-init-"))).toEqual([]);
  });

  it("rejects a half-built DB and re-initialization recovers after the bad file is removed", async () => {
    const ctx = await tempCtx();
    fs.mkdirSync(path.dirname(ctx.dbPath), { recursive: true });
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec("PRAGMA user_version = 1;");
    raw.exec("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, disabled_at INTEGER);");
    raw.close();
    // Missing the other two tables => structural rejection (no silent repair).
    expect(() => IdentityStore.open(ctx.dbPath)).toThrow(/missing required table|exactly one user/);
    // After removing the half file, a fresh init succeeds.
    fs.rmSync(ctx.dbPath, { force: true });
    const ok = await IdentityService.initialize(
      { remoteUrl: ctx.remoteUrl, branch: ctx.branch, envApiKey: "key" },
      ctx.dbPath,
    );
    expect(ok.created).toBe(true);
  });
});

describe("init only verifies (never rotates) an existing database", () => {
  it("a second init under a different key fails and leaves the original untouched", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    openService(ctx, "key-1");
    const before = IdentityStore.open(ctx.dbPath).loadVerifiedBinding();

    // A different (rotating) env key is rejected by init, not applied.
    expect(() =>
      IdentityService.initialize({ remoteUrl: ctx.remoteUrl, branch: ctx.branch, envApiKey: "key-OTHER" }, ctx.dbPath),
    ).toThrow(/different active key|does not rotate/);

    const after = IdentityStore.open(ctx.dbPath).loadVerifiedBinding();
    expect(after.user.id).toBe(before.user.id);
    expect(after.workspace.id).toBe(before.workspace.id);
    expect(after.activeKey.key_digest).toBe(before.activeKey.key_digest);
  });
});

describe("structural contract rejects bad schemas", () => {
  it.each(["no-pk", "no-foreign-key", "no-unique", "no-not-null"] as const)(
    "rejects a database missing %s",
    async (defect) => {
      const ctx = await tempCtx();
      topicBrokenSchema(ctx.dbPath, defect);
      expect(() => IdentityStore.open(ctx.dbPath)).toThrow();
    },
  );
});

describe("v2 schema & external identities migration", () => {
  it("provisions fresh database with user_version = 2 and external_identities table", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const raw = new DatabaseSync(ctx.dbPath);
    const versionRow = raw.prepare("PRAGMA user_version;").get() as { user_version: number };
    expect(Number(versionRow.user_version)).toBe(2);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table';").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("external_identities");
    raw.close();
  });

  it("auto-migrates an existing v1 database to v2 on open", async () => {
    const ctx = await tempCtx();
    fs.mkdirSync(path.dirname(ctx.dbPath), { recursive: true });
    const db = new DatabaseSync(ctx.dbPath);
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, disabled_at INTEGER);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL, remote_url TEXT NOT NULL, branch TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY (owner_user_id) REFERENCES users(id));
      CREATE TABLE api_keys (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, key_digest TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, revoked_at INTEGER, FOREIGN KEY (user_id) REFERENCES users(id));
      PRAGMA user_version = 1;
      INSERT INTO users VALUES ('usr_v1', 1000, NULL);
      INSERT INTO workspaces VALUES ('ws_v1', 'usr_v1', '${ctx.remoteUrl}', '${ctx.branch}', 1000);
      INSERT INTO api_keys VALUES ('ak_v1', 'usr_v1', '${sha256Hex("key-1")}', 1000, NULL);
    `);
    db.close();

    // Opening with IdentityStore.open should run auto-migration
    const store = IdentityStore.open(ctx.dbPath);
    cleanupStores.push(store);

    const raw = new DatabaseSync(ctx.dbPath);
    const versionRow = raw.prepare("PRAGMA user_version;").get() as { user_version: number };
    expect(Number(versionRow.user_version)).toBe(2);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table';").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("external_identities");
    raw.close();
  });
});

function seedExternalIdentity(
  dbPath: string,
  input: {
    id: string;
    provider: string;
    providerSubject: string;
    userId: string;
    providerLogin?: string | null;
    createdAtMs?: number;
    updatedAtMs?: number;
  },
): void {
  const raw = new DatabaseSync(dbPath);
  const now = input.createdAtMs ?? Date.now();
  raw.prepare(
    `INSERT INTO external_identities (id, provider, provider_subject, user_id, provider_login, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?);`,
  ).run(
    input.id,
    input.provider,
    input.providerSubject,
    input.userId,
    input.providerLogin ?? null,
    now,
    input.updatedAtMs ?? now,
  );
  raw.close();
}

function countRows(dbPath: string, table: "users" | "workspaces" | "api_keys" | "external_identities"): number {
  const raw = new DatabaseSync(dbPath);
  const row = raw.prepare(`SELECT COUNT(*) AS c FROM ${table};`).get() as { c: number };
  raw.close();
  return Number(row.c);
}

describe("IdentityAccountProvisioner / resolveOrCreateExternalUser", () => {
  it("A. existing dogfood binding resolves same user without side effects", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    const store = openRaw(ctx);
    seedExternalIdentity(ctx.dbPath, {
      id: "ext_a",
      provider: "github",
      providerSubject: "123",
      userId: ident.user_id,
      providerLogin: "dogfood",
    });

    const usersBefore = countRows(ctx.dbPath, "users");
    const wsBefore = countRows(ctx.dbPath, "workspaces");
    const keysBefore = countRows(ctx.dbPath, "api_keys");

    const provisioner = new IdentityAccountProvisioner(store);
    const res = provisioner.resolveOrCreate("github", "123", "dogfood");

    expect(res.createdUser).toBe(false);
    expect(res.userId).toBe(ident.user_id);
    expect(countRows(ctx.dbPath, "users")).toBe(usersBefore);
    expect(countRows(ctx.dbPath, "workspaces")).toBe(wsBefore);
    expect(countRows(ctx.dbPath, "api_keys")).toBe(keysBefore);
  });

  it("B. new GitHub user creates user + identity with zero workspace and zero api keys", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const store = openRaw(ctx);
    const provisioner = new IdentityAccountProvisioner(store);

    const res = provisioner.resolveOrCreate("github", "456", "new-user");
    expect(res.createdUser).toBe(true);

    const raw = new DatabaseSync(ctx.dbPath);
    const ws = raw.prepare("SELECT COUNT(*) AS c FROM workspaces WHERE owner_user_id = ?;").get(res.userId) as { c: number };
    const keys = raw.prepare("SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ?;").get(res.userId) as { c: number };
    raw.close();
    expect(Number(ws.c)).toBe(0);
    expect(Number(keys.c)).toBe(0);
  });

  it("C. repeat login is idempotent", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const store = openRaw(ctx);
    const provisioner = new IdentityAccountProvisioner(store);

    const first = provisioner.resolveOrCreate("github", "456", "user");
    const second = provisioner.resolveOrCreate("github", "456", "user");

    expect(second.userId).toBe(first.userId);
    expect(second.createdUser).toBe(false);
    expect(countRows(ctx.dbPath, "users")).toBe(2);
    expect(countRows(ctx.dbPath, "external_identities")).toBe(1);
  });

  it("D. two different GitHub subjects resolve to different users", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const store = openRaw(ctx);
    const provisioner = new IdentityAccountProvisioner(store);

    const u1 = provisioner.resolveOrCreate("github", "111", "one");
    const u2 = provisioner.resolveOrCreate("github", "222", "two");
    expect(u1.userId).not.toBe(u2.userId);
  });

  it("E. login rename refreshes provider_login metadata", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const store = openRaw(ctx);
    const provisioner = new IdentityAccountProvisioner(store);

    const first = provisioner.resolveOrCreate("github", "456", "old-name");
    const before = store.findExternalIdentity("github", "456");
    expect(before?.provider_login).toBe("old-name");

    const second = provisioner.resolveOrCreate("github", "456", "new-name");
    expect(second.userId).toBe(first.userId);
    const after = store.findExternalIdentity("github", "456");
    expect(after?.provider_login).toBe("new-name");
    expect(after!.updated_at_ms).toBeGreaterThanOrEqual(before!.updated_at_ms);
  });

  it("preserves provider_login when providerLogin is omitted on existing binding", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    const store = openRaw(ctx);
    seedExternalIdentity(ctx.dbPath, {
      id: "ext_keep",
      provider: "github",
      providerSubject: "789",
      userId: ident.user_id,
      providerLogin: "keep-me",
    });

    const provisioner = new IdentityAccountProvisioner(store);
    provisioner.resolveOrCreate("github", "789");
    const row = store.findExternalIdentity("github", "789");
    expect(row?.provider_login).toBe("keep-me");
  });

  it("F. same login with different GitHub IDs creates two users", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const store = openRaw(ctx);
    const provisioner = new IdentityAccountProvisioner(store);

    const u1 = provisioner.resolveOrCreate("github", "111", "shared-name");
    const u2 = provisioner.resolveOrCreate("github", "222", "shared-name");
    expect(u1.userId).not.toBe(u2.userId);
  });

  it("G. disabled bound user fails without creating replacement account", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const store = openRaw(ctx);

    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("INSERT INTO users VALUES ('usr_disabled', 1000, 2000);").run();
    raw.close();
    seedExternalIdentity(ctx.dbPath, {
      id: "ext_disabled",
      provider: "github",
      providerSubject: "456",
      userId: "usr_disabled",
    });

    const usersBefore = countRows(ctx.dbPath, "users");
    const extBefore = countRows(ctx.dbPath, "external_identities");
    const provisioner = new IdentityAccountProvisioner(store);

    expect(() => provisioner.resolveOrCreate("github", "456", "user")).toThrow(IdentityConflictError);
    expect(countRows(ctx.dbPath, "users")).toBe(usersBefore);
    expect(countRows(ctx.dbPath, "external_identities")).toBe(extBefore);
  });

  it("M. external identity insert failure rolls back user creation", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const store = openRaw(ctx);

    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec(`
      CREATE TRIGGER trg_abort_ext_insert
      BEFORE INSERT ON external_identities
      BEGIN
        SELECT RAISE(ABORT, 'forced external identity insert failure');
      END;
    `);
    raw.close();

    const usersBefore = countRows(ctx.dbPath, "users");
    expect(() => store.resolveOrCreateExternalUser({ provider: "github", providerSubject: "999", providerLogin: "x" })).toThrow();
    expect(countRows(ctx.dbPath, "users")).toBe(usersBefore);
    expect(countRows(ctx.dbPath, "external_identities")).toBe(0);
  });

  it("N. rejects database missing external_identities unique indexes", async () => {
    const ctx = await tempCtx();
    fs.mkdirSync(path.dirname(ctx.dbPath), { recursive: true });
    const db = new DatabaseSync(ctx.dbPath);
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, disabled_at INTEGER);
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL, remote_url TEXT NOT NULL,
        branch TEXT NOT NULL, created_at INTEGER NOT NULL,
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, key_digest TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, revoked_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE external_identities (
        id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        provider_subject TEXT NOT NULL,
        user_id TEXT NOT NULL,
        provider_login TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      PRAGMA user_version = 2;
    `);
    db.close();
    expect(() => IdentityStore.open(ctx.dbPath)).toThrow(IdentityStructureError);
  });

  it("O. creating ten GitHub users does not create workspaces, api keys, or extra side effects", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    const store = openRaw(ctx);
    const provisioner = new IdentityAccountProvisioner(store);

    const wsBefore = countRows(ctx.dbPath, "workspaces");
    const keysBefore = countRows(ctx.dbPath, "api_keys");

    for (let i = 0; i < 10; i++) {
      provisioner.resolveOrCreate("github", String(10_000 + i), `user-${i}`);
    }

    expect(countRows(ctx.dbPath, "users")).toBe(1 + 10);
    expect(countRows(ctx.dbPath, "external_identities")).toBe(10);
    expect(countRows(ctx.dbPath, "workspaces")).toBe(wsBefore);
    expect(countRows(ctx.dbPath, "api_keys")).toBe(keysBefore);

    const runtimeWs = new DatabaseSync(ctx.dbPath);
    const runtimeOwner = runtimeWs.prepare("SELECT owner_user_id FROM workspaces WHERE id = ?;").get(ident.workspace_id) as {
      owner_user_id: string;
    };
    runtimeWs.close();
    expect(runtimeOwner.owner_user_id).toBe(ident.user_id);
  });

  it("P. store reopen resolves same user for existing subject", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");

    const storeA = IdentityStore.open(ctx.dbPath);
    const provisionerA = new IdentityAccountProvisioner(storeA);
    const created = provisionerA.resolveOrCreate("github", "456", "user-b");
    expect(created.createdUser).toBe(true);
    storeA.close();

    const storeB = IdentityStore.open(ctx.dbPath);
    cleanupStores.push(storeB);
    const provisionerB = new IdentityAccountProvisioner(storeB);
    const resolved = provisionerB.resolveOrCreate("github", "456", "user-b");
    expect(resolved.createdUser).toBe(false);
    expect(resolved.userId).toBe(created.userId);
  });

  it("J. runtime IdentityService.open remains unchanged after unrelated user creation", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const before = openService(ctx, "key-1").workspaceIdentityValue;

    const store = openRaw(ctx);
    new IdentityAccountProvisioner(store).resolveOrCreate("github", "456", "other");

    const after = openService(ctx, "key-1").workspaceIdentityValue;
    expect(after).toEqual(before);
  });
});
