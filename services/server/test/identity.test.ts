import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  IdentityStore,
  provisionEmptyControlPlaneDatabase,
  IDENTITY_DB_USER_VERSION,
  IdentityConflictError,
  IdentityStructureError,
} from "../src/identity/store.js";
import { IdentityService } from "../src/identity/service.js";
import { IdentityAccountProvisioner } from "../src/identity/provisioner.js";
import { seedIdentity, requestIdentity } from "./helpers.js";

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
  return seedIdentity({ identityDbPath: ctx.dbPath, remoteUrl: ctx.remoteUrl, branch: ctx.branch }, apiKey);
}

function openRaw(ctx: Ctx): IdentityStore {
  const store = IdentityStore.open(ctx.dbPath);
  cleanupStores.push(store);
  return store;
}

function openService(ctx: Ctx): IdentityService {
  const svc = IdentityService.open(ctx.dbPath);
  cleanupServices.push(svc);
  return svc;
}

describe("Identity store: schema, invariants and permissions", () => {
  it("sets user_version and dir/file permissions on control-plane provisioning", async () => {
    const ctx = await tempCtx();
    provisionEmptyControlPlaneDatabase(ctx.dbPath);

    expect(fs.statSync(path.dirname(ctx.dbPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(ctx.dbPath).mode & 0o777).toBe(0o600);

    const raw = new DatabaseSync(ctx.dbPath);
    const ver = raw.prepare("PRAGMA user_version;").get() as { user_version: number };
    expect(Number(ver.user_version)).toBe(IDENTITY_DB_USER_VERSION);
    expect(Number((raw.prepare("SELECT COUNT(*) AS n FROM users;").get() as { n: number }).n)).toBe(0);
    expect(Number((raw.prepare("SELECT COUNT(*) AS n FROM workspaces;").get() as { n: number }).n)).toBe(0);
    raw.close();
  });

  it("declines a missing database at startup (fail-fast, no silent creation)", async () => {
    const ctx = await tempCtx();
    const missing = path.join(ctx.dir, "nope", "identity.sqlite");
    expect(() => IdentityService.open(missing)).toThrow(/not found/);
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
});

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
  it("two competing control-plane provisions settle on one empty DB and leave no temp files", async () => {
    const ctx = await tempCtx();
    provisionEmptyControlPlaneDatabase(ctx.dbPath);
    provisionEmptyControlPlaneDatabase(ctx.dbPath);

    const raw = new DatabaseSync(ctx.dbPath);
    expect(Number((raw.prepare("SELECT COUNT(*) AS n FROM users;").get() as { n: number }).n)).toBe(0);
    expect(Number((raw.prepare("SELECT COUNT(*) AS n FROM workspaces;").get() as { n: number }).n)).toBe(0);
    raw.close();

    const leftOver = fs.readdirSync(path.dirname(ctx.dbPath)).filter((f) => f.includes(".identity-init-"));
    expect(leftOver).toEqual([]);
    IdentityStore.open(ctx.dbPath).close();
  });

  it("fails cleanly (no temp leak) when the publish target is unusable (a directory)", async () => {
    const ctx = await tempCtx();
    fs.mkdirSync(ctx.dbPath, { recursive: true });
    expect(() => provisionEmptyControlPlaneDatabase(ctx.dbPath)).toThrow();
    expect(fs.readdirSync(path.dirname(ctx.dbPath)).filter((f) => f.includes(".identity-init-"))).toEqual([]);
  });

  it("rejects a half-built DB and re-initialization recovers after the bad file is removed", async () => {
    const ctx = await tempCtx();
    fs.mkdirSync(path.dirname(ctx.dbPath), { recursive: true });
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec("PRAGMA user_version = 1;");
    raw.exec("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, disabled_at INTEGER);");
    raw.close();
    expect(() => IdentityStore.open(ctx.dbPath)).toThrow(/missing required table|exactly one user|Cannot migrate to v2/);
    fs.rmSync(ctx.dbPath, { force: true });
    provisionEmptyControlPlaneDatabase(ctx.dbPath);
    IdentityStore.open(ctx.dbPath).close();
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

describe("current schema tables", () => {
  it("provisions fresh database with current tables", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const raw = new DatabaseSync(ctx.dbPath);
    const versionRow = raw.prepare("PRAGMA user_version;").get() as { user_version: number };
    expect(Number(versionRow.user_version)).toBe(IDENTITY_DB_USER_VERSION);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table';").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("external_identities");
    expect(names).toContain("workspace_memberships");
    expect(names).toContain("github_installations");
    expect(names).toContain("github_installation_users");
    expect(names).toContain("github_repository_bindings");
    raw.close();
  });
});

function countRows(
  dbPath: string,
  table:
    | "users"
    | "workspaces"
    | "api_keys"
    | "external_identities"
    | "workspace_memberships"
    | "github_installations"
    | "github_installation_users"
    | "github_repository_bindings"
    | "workspace_bootstraps",
): number {
  const raw = new DatabaseSync(dbPath);
  const row = raw.prepare(`SELECT COUNT(*) AS c FROM ${table};`).get() as { c: number };
  raw.close();
  return Number(row.c);
}

describe("workspace_memberships invariants", () => {
  it("fresh provision creates owner membership that matches workspace.owner_user_id", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    expect(countRows(ctx.dbPath, "users")).toBe(1);
    expect(countRows(ctx.dbPath, "workspaces")).toBe(1);
    expect(countRows(ctx.dbPath, "workspace_memberships")).toBe(1);
    expect(countRows(ctx.dbPath, "api_keys")).toBe(1);
    expect(countRows(ctx.dbPath, "external_identities")).toBe(0);

    const raw = new DatabaseSync(ctx.dbPath);
    const membership = raw.prepare(
      "SELECT workspace_id, user_id, role FROM workspace_memberships LIMIT 1;",
    ).get() as { workspace_id: string; user_id: string; role: string };
    const workspace = raw.prepare("SELECT owner_user_id FROM workspaces WHERE id = ?;").get(ident.workspace_id) as {
      owner_user_id: string;
    };
    raw.close();
    expect(membership.workspace_id).toBe(ident.workspace_id);
    expect(membership.user_id).toBe(ident.user_id);
    expect(membership.role).toBe("owner");
    expect(workspace.owner_user_id).toBe(ident.user_id);
  });

  it("F. duplicate (user, workspace) membership violates UNIQUE constraint", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const raw = new DatabaseSync(ctx.dbPath);
    expect(() =>
      raw.prepare(
        "INSERT INTO workspace_memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?);",
      ).run("wsm_dup", (raw.prepare("SELECT id FROM workspaces LIMIT 1;").get() as { id: string }).id, (raw.prepare("SELECT id FROM users LIMIT 1;").get() as { id: string }).id, Date.now()),
    ).toThrow();
    raw.close();
  });

  it("G. duplicate owner for same workspace violates partial unique index", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const raw = new DatabaseSync(ctx.dbPath);
    const ws = raw.prepare("SELECT id FROM workspaces LIMIT 1;").get() as { id: string };
    raw.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES ('usr_other', 2000, NULL);").run();
    expect(() =>
      raw.prepare(
        "INSERT INTO workspace_memberships (id, workspace_id, user_id, role, created_at) VALUES ('wsm_other', ?, 'usr_other', 'owner', 2000);",
      ).run(ws.id),
    ).toThrow();
    raw.close();
  });

  it("H. shadow mismatch fails open()", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES ('usr_other', 2000, NULL);").run();
    raw.exec("UPDATE workspaces SET owner_user_id = 'usr_other' WHERE 1=1;");
    raw.close();
    expect(() => IdentityStore.open(ctx.dbPath)).toThrow(IdentityStructureError);
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
    raw.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES ('usr_disabled', 1000, 2000);").run();
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

  it("J. IdentityService.open still authenticates the original key after unrelated user creation", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const before = requestIdentity(openService(ctx), "key-1");

    const store = openRaw(ctx);
    new IdentityAccountProvisioner(store).resolveOrCreate("github", "456", "other");

    const after = requestIdentity(openService(ctx), "key-1");
    expect(after).toEqual(before);
  });
});

describe("github_installations", () => {
  it("fresh provision has zero installation rows at current user_version", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    expect(countRows(ctx.dbPath, "users")).toBe(1);
    expect(countRows(ctx.dbPath, "workspaces")).toBe(1);
    expect(countRows(ctx.dbPath, "workspace_memberships")).toBe(1);
    expect(countRows(ctx.dbPath, "api_keys")).toBe(1);
    expect(countRows(ctx.dbPath, "external_identities")).toBe(0);
    expect(countRows(ctx.dbPath, "github_installations")).toBe(0);
    expect(countRows(ctx.dbPath, "github_installation_users")).toBe(0);
    expect(countRows(ctx.dbPath, "github_repository_bindings")).toBe(0);

    const raw = new DatabaseSync(ctx.dbPath);
    const ver = raw.prepare("PRAGMA user_version;").get() as { user_version: number };
    raw.close();
    expect(Number(ver.user_version)).toBe(IDENTITY_DB_USER_VERSION);
  });

  it("E. duplicate callbacks for same user and installation are idempotent via ON CONFLICT", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    const store = openRaw(ctx);

    const first = store.upsertGitHubInstallationWithUser({
      githubInstallationId: "123456",
      githubAppId: "999",
      accountId: "888",
      accountLogin: "acme-corp",
      accountType: "Organization",
      repositorySelection: "all",
      suspendedAtMs: null,
      userId: ident.user_id,
    });

    expect(first.installation.github_installation_id).toBe("123456");
    expect(first.installation.account_login).toBe("acme-corp");
    expect(first.installation.repository_selection).toBe("all");
    expect(first.userLink.user_id).toBe(ident.user_id);
    expect(countRows(ctx.dbPath, "github_installations")).toBe(1);
    expect(countRows(ctx.dbPath, "github_installation_users")).toBe(1);

    // Call again with updated repositorySelection
    const second = store.upsertGitHubInstallationWithUser({
      githubInstallationId: "123456",
      githubAppId: "999",
      accountId: "888",
      accountLogin: "acme-corp",
      accountType: "Organization",
      repositorySelection: "selected",
      suspendedAtMs: null,
      userId: ident.user_id,
    });

    expect(second.installation.id).toBe(first.installation.id);
    expect(second.installation.repository_selection).toBe("selected");
    expect(second.userLink.id).toBe(first.userLink.id);
    expect(countRows(ctx.dbPath, "github_installations")).toBe(1);
    expect(countRows(ctx.dbPath, "github_installation_users")).toBe(1);

    const list = store.listGitHubInstallationsForUser(ident.user_id);
    expect(list.length).toBe(1);
    expect(list[0]?.repository_selection).toBe("selected");
  });

  it("F. shared installation across two CEO users links correctly (M:N)", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    const store = openRaw(ctx);

    const userB = store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "55555",
      providerLogin: "user-b",
    });

    // User A links installation 777
    const linkA = store.upsertGitHubInstallationWithUser({
      githubInstallationId: "777",
      githubAppId: "100",
      accountId: "200",
      accountLogin: "shared-org",
      accountType: "Organization",
      repositorySelection: "all",
      userId: ident.user_id,
    });

    // User B links same installation 777
    const linkB = store.upsertGitHubInstallationWithUser({
      githubInstallationId: "777",
      githubAppId: "100",
      accountId: "200",
      accountLogin: "shared-org",
      accountType: "Organization",
      repositorySelection: "all",
      userId: userB.user_id,
    });

    expect(countRows(ctx.dbPath, "github_installations")).toBe(1);
    expect(countRows(ctx.dbPath, "github_installation_users")).toBe(2);
    expect(linkA.installation.id).toBe(linkB.installation.id);
    expect(linkA.userLink.id).not.toBe(linkB.userLink.id);

    const listA = store.listGitHubInstallationsForUser(ident.user_id);
    const listB = store.listGitHubInstallationsForUser(userB.user_id);
    expect(listA.length).toBe(1);
    expect(listB.length).toBe(1);
    expect(listA[0]?.id).toBe(listB[0]?.id);
  });

  it("G. multiple installations for one CEO user links correctly (M:N)", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    const store = openRaw(ctx);

    store.upsertGitHubInstallationWithUser({
      githubInstallationId: "101",
      githubAppId: "100",
      accountId: "201",
      accountLogin: "org-1",
      accountType: "Organization",
      repositorySelection: "all",
      userId: ident.user_id,
    });

    store.upsertGitHubInstallationWithUser({
      githubInstallationId: "102",
      githubAppId: "100",
      accountId: "202",
      accountLogin: "org-2",
      accountType: "User",
      repositorySelection: "selected",
      userId: ident.user_id,
    });

    expect(countRows(ctx.dbPath, "github_installations")).toBe(2);
    expect(countRows(ctx.dbPath, "github_installation_users")).toBe(2);

    const list = store.listGitHubInstallationsForUser(ident.user_id);
    expect(list.length).toBe(2);
    const ids = list.map((i) => i.github_installation_id);
    expect(ids).toContain("101");
    expect(ids).toContain("102");
  });

  it("H. validation rejects non-numeric IDs, invalid enums, negative suspended_at, and disabled users", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    const store = openRaw(ctx);

    // Non-numeric installation id
    expect(() =>
      store.upsertGitHubInstallationWithUser({
        githubInstallationId: "abc",
        githubAppId: "100",
        accountId: "200",
        accountLogin: "org",
        accountType: "Organization",
        repositorySelection: "all",
        userId: ident.user_id,
      }),
    ).toThrow(IdentityStructureError);

    // Non-numeric app id
    expect(() =>
      store.upsertGitHubInstallationWithUser({
        githubInstallationId: "100",
        githubAppId: "invalid",
        accountId: "200",
        accountLogin: "org",
        accountType: "Organization",
        repositorySelection: "all",
        userId: ident.user_id,
      }),
    ).toThrow(IdentityStructureError);

    // Non-numeric account id
    expect(() =>
      store.upsertGitHubInstallationWithUser({
        githubInstallationId: "100",
        githubAppId: "100",
        accountId: "invalid",
        accountLogin: "org",
        accountType: "Organization",
        repositorySelection: "all",
        userId: ident.user_id,
      }),
    ).toThrow(IdentityStructureError);

    // Invalid accountType
    expect(() =>
      store.upsertGitHubInstallationWithUser({
        githubInstallationId: "100",
        githubAppId: "100",
        accountId: "200",
        accountLogin: "org",
        accountType: "Bot" as any,
        repositorySelection: "all",
        userId: ident.user_id,
      }),
    ).toThrow(IdentityStructureError);

    // Invalid repositorySelection
    expect(() =>
      store.upsertGitHubInstallationWithUser({
        githubInstallationId: "100",
        githubAppId: "100",
        accountId: "200",
        accountLogin: "org",
        accountType: "User",
        repositorySelection: "none" as any,
        userId: ident.user_id,
      }),
    ).toThrow(IdentityStructureError);

    // Negative suspendedAtMs
    expect(() =>
      store.upsertGitHubInstallationWithUser({
        githubInstallationId: "100",
        githubAppId: "100",
        accountId: "200",
        accountLogin: "org",
        accountType: "User",
        repositorySelection: "all",
        suspendedAtMs: -50,
        userId: ident.user_id,
      }),
    ).toThrow(IdentityStructureError);

    // Disabled user
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("UPDATE users SET disabled_at = ? WHERE id = ?;").run(Date.now(), ident.user_id);
    raw.close();

    expect(() =>
      store.upsertGitHubInstallationWithUser({
        githubInstallationId: "100",
        githubAppId: "100",
        accountId: "200",
        accountLogin: "org",
        accountType: "User",
        repositorySelection: "all",
        userId: ident.user_id,
      }),
    ).toThrow(IdentityConflictError);
  });

  it("I. positive decimal string and positive suspended_at_ms validation (write and open-time)", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    const store = openRaw(ctx);

    // Rejects zero, signs, leading zero, decimals, empty as IDs at write-time
    for (const badId of ["0", "-1", "+1", "0123", "", "1.5"]) {
      expect(() =>
        store.upsertGitHubInstallationWithUser({
          githubInstallationId: badId,
          githubAppId: "100",
          accountId: "200",
          accountLogin: "org",
          accountType: "Organization",
          repositorySelection: "all",
          userId: ident.user_id,
        }),
      ).toThrow(IdentityStructureError);

      expect(() =>
        store.upsertGitHubInstallationWithUser({
          githubInstallationId: "100",
          githubAppId: badId,
          accountId: "200",
          accountLogin: "org",
          accountType: "Organization",
          repositorySelection: "all",
          userId: ident.user_id,
        }),
      ).toThrow(IdentityStructureError);

      expect(() =>
        store.upsertGitHubInstallationWithUser({
          githubInstallationId: "100",
          githubAppId: "100",
          accountId: badId,
          accountLogin: "org",
          accountType: "Organization",
          repositorySelection: "all",
          userId: ident.user_id,
        }),
      ).toThrow(IdentityStructureError);
    }

    // Rejects zero suspendedAtMs at write-time (must be > 0)
    expect(() =>
      store.upsertGitHubInstallationWithUser({
        githubInstallationId: "100",
        githubAppId: "100",
        accountId: "200",
        accountLogin: "org",
        accountType: "Organization",
        repositorySelection: "all",
        suspendedAtMs: 0,
        userId: ident.user_id,
      }),
    ).toThrow(IdentityStructureError);

    store.close();

    // Open-time integrity checks:
    const testOpenViolation = (column: string, badValue: any) => {
      const raw = new DatabaseSync(ctx.dbPath);
      raw.prepare("DELETE FROM github_installations;").run();
      raw.prepare(`
        INSERT INTO github_installations (
          id, github_installation_id, github_app_id, account_id,
          account_login, account_type, repository_selection,
          suspended_at_ms, created_at_ms, updated_at_ms
        ) VALUES ('ghi_test', '100', '100', '200', 'org', 'Organization', 'all', NULL, 1000, 1000);
      `).run();
      raw.prepare(`UPDATE github_installations SET ${column} = ? WHERE id = 'ghi_test';`).run(badValue);
      raw.close();

      expect(() => IdentityStore.open(ctx.dbPath)).toThrow(IdentityStructureError);
    };

    testOpenViolation("github_installation_id", "0");
    testOpenViolation("github_installation_id", "0123");
    testOpenViolation("github_app_id", "0");
    testOpenViolation("github_app_id", "+100");
    testOpenViolation("account_id", "0");
    testOpenViolation("account_id", "-200");
    testOpenViolation("suspended_at_ms", 0);
    testOpenViolation("suspended_at_ms", -1);
  });
});

describe("github_repository_bindings", () => {
  it("fresh provision has github_repository_bindings and zero bindings", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    expect(countRows(ctx.dbPath, "github_repository_bindings")).toBe(0);

    const raw = new DatabaseSync(ctx.dbPath);
    const ver = raw.prepare("PRAGMA user_version;").get() as { user_version: number };
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='github_repository_bindings';").all();
    raw.close();
    expect(Number(ver.user_version)).toBe(IDENTITY_DB_USER_VERSION);
    expect(tables.length).toBe(1);

    const store = openRaw(ctx);
    expect(store.findRepositoryBindingByWorkspaceId(ident.workspace_id)).toBeNull();
  });

  it("5. duplicate workspace binding rejected by DB constraint", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    const store = openRaw(ctx);

    const instResult = store.upsertGitHubInstallationWithUser({
      githubInstallationId: "12345",
      githubAppId: "6789",
      accountId: "99999",
      accountLogin: "test-org",
      accountType: "Organization",
      repositorySelection: "selected",
      userId: ident.user_id,
    });

    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec(`
      INSERT INTO github_repository_bindings (
        id, workspace_id, github_repository_id, github_installation_row_id,
        owner_account_id, owner_login, repository_name, full_name,
        branch, created_at_ms, updated_at_ms
      ) VALUES ('grb_1', '${ident.workspace_id}', '100', '${instResult.installation.id}', '99999', 'test-org', 'repo1', 'test-org/repo1', 'main', 1000, 1000);
    `);

    expect(() => {
      raw.exec(`
        INSERT INTO github_repository_bindings (
          id, workspace_id, github_repository_id, github_installation_row_id,
          owner_account_id, owner_login, repository_name, full_name,
          branch, created_at_ms, updated_at_ms
        ) VALUES ('grb_2', '${ident.workspace_id}', '200', '${instResult.installation.id}', '99999', 'test-org', 'repo2', 'test-org/repo2', 'main', 1000, 1000);
      `);
    }).toThrow(/UNIQUE constraint failed: github_repository_bindings\.workspace_id/);
    raw.close();
  });

  it("6. duplicate GitHub repo binding rejected by DB constraint", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const store = openRaw(ctx);

    const testUser = store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "99999",
      providerLogin: "test-org",
    });

    const instResult = store.upsertGitHubInstallationWithUser({
      githubInstallationId: "12345",
      githubAppId: "6789",
      accountId: "99999",
      accountLogin: "test-org",
      accountType: "Organization",
      repositorySelection: "selected",
      userId: testUser.user_id,
    });

    const res1 = store.createWorkspaceWithRepositoryBinding({
      userId: testUser.user_id,
      installationRowId: instResult.installation.id,
      githubRepositoryId: "100",
      ownerAccountId: "99999",
      ownerLogin: "test-org",
      repositoryName: "repo1",
      fullName: "test-org/repo1",
      branch: "main",
    });

    expect(res1.binding.github_repository_id).toBe("100");

    // Attempting to bind same repository ID "100" again to a new workspace fails
    expect(() => {
      store.createWorkspaceWithRepositoryBinding({
        userId: testUser.user_id,
        installationRowId: instResult.installation.id,
        githubRepositoryId: "100",
        ownerAccountId: "99999",
        ownerLogin: "test-org",
        repositoryName: "repo1",
        fullName: "test-org/repo1",
        branch: "main",
      });
    }).toThrow(IdentityConflictError);

    // Also verify DB level constraint directly
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("INSERT INTO workspaces VALUES ('ws_extra', ?, 'https://github.com/extra.git', 'main', 1000);").run(testUser.user_id);
    expect(() => {
      raw.exec(`
        INSERT INTO github_repository_bindings (
          id, workspace_id, github_repository_id, github_installation_row_id,
          owner_account_id, owner_login, repository_name, full_name,
          branch, created_at_ms, updated_at_ms
        ) VALUES ('grb_extra', 'ws_extra', '100', '${instResult.installation.id}', '99999', 'test-org', 'repo1', 'test-org/repo1', 'main', 1000, 1000);
      `);
    }).toThrow(/UNIQUE constraint failed: github_repository_bindings\.github_repository_id/);
    raw.close();
  });

  it("7. atomic new workspace operation creates exactly Workspace + owner WorkspaceMembership + binding and no API key; owner shadow/membership match; workspace remote has no token", async () => {
    const ctx = await tempCtx();
    provision(ctx, "key-1");
    const store = openRaw(ctx);

    const testUser = store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "44444",
      providerLogin: "acme-corp",
    });

    const instResult = store.upsertGitHubInstallationWithUser({
      githubInstallationId: "55555",
      githubAppId: "9999",
      accountId: "44444",
      accountLogin: "acme-corp",
      accountType: "Organization",
      repositorySelection: "selected",
      userId: testUser.user_id,
    });

    const beforeWs = countRows(ctx.dbPath, "workspaces");
    const beforeMemb = countRows(ctx.dbPath, "workspace_memberships");
    const beforeBindings = countRows(ctx.dbPath, "github_repository_bindings");
    const beforeKeys = countRows(ctx.dbPath, "api_keys");

    const created = store.createWorkspaceWithRepositoryBinding({
      userId: testUser.user_id,
      installationRowId: instResult.installation.id,
      githubRepositoryId: "987654",
      ownerAccountId: "44444",
      ownerLogin: "acme-corp",
      repositoryName: "super-repo",
      fullName: "acme-corp/super-repo",
      branch: "release-v1",
    });

    expect(countRows(ctx.dbPath, "workspaces")).toBe(beforeWs + 1);
    expect(countRows(ctx.dbPath, "workspace_memberships")).toBe(beforeMemb + 1);
    expect(countRows(ctx.dbPath, "github_repository_bindings")).toBe(beforeBindings + 1);
    expect(countRows(ctx.dbPath, "api_keys")).toBe(beforeKeys); // NO API key created!

    expect(created.workspace.id).toMatch(/^ws_/);
    expect(created.workspace.owner_user_id).toBe(testUser.user_id);
    expect(created.workspace.remote_url).toBe("https://github.com/acme-corp/super-repo.git");
    expect(created.workspace.remote_url).not.toMatch(/ghp_|github_pat_|Bearer|x-access-token|@/);
    expect(created.workspace.branch).toBe("release-v1");

    expect(created.membership.id).toMatch(/^wsm_/);
    expect(created.membership.workspace_id).toBe(created.workspace.id);
    expect(created.membership.user_id).toBe(testUser.user_id);
    expect(created.membership.role).toBe("owner");

    expect(created.binding.id).toMatch(/^grb_/);
    expect(created.binding.workspace_id).toBe(created.workspace.id);
    expect(created.binding.github_repository_id).toBe("987654");
    expect(created.binding.github_installation_row_id).toBe(instResult.installation.id);
    expect(created.binding.owner_account_id).toBe("44444");
    expect(created.binding.owner_login).toBe("acme-corp");
    expect(created.binding.repository_name).toBe("super-repo");
    expect(created.binding.full_name).toBe("acme-corp/super-repo");
    expect(created.binding.branch).toBe("release-v1");

    // Lookup APIs
    const byWs = store.findRepositoryBindingByWorkspaceId(created.workspace.id);
    expect(byWs?.id).toBe(created.binding.id);
    const byGh = store.findRepositoryBindingByGitHubRepoId("987654");
    expect(byGh?.id).toBe(created.binding.id);
    const byId = store.findRepositoryBindingById(created.binding.id);
    expect(byId?.full_name).toBe("acme-corp/super-repo");
    const listInst = store.listRepositoryBindingsForInstallation(instResult.installation.id);
    expect(listInst.length).toBe(1);
    expect(listInst[0]?.id).toBe(created.binding.id);
  });

  it("8. store transaction failure leaves no partial workspace/membership/binding", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    const store = openRaw(ctx);

    const beforeWs = countRows(ctx.dbPath, "workspaces");
    const beforeMemb = countRows(ctx.dbPath, "workspace_memberships");
    const beforeBindings = countRows(ctx.dbPath, "github_repository_bindings");

    // Case A: non-existent installation row
    expect(() => {
      store.createWorkspaceWithRepositoryBinding({
        userId: ident.user_id,
        installationRowId: "ghi_nonexistent",
        githubRepositoryId: "999",
        ownerAccountId: "111",
        ownerLogin: "org",
        repositoryName: "repo",
        fullName: "org/repo",
        branch: "main",
      });
    }).toThrow(IdentityStructureError);

    expect(countRows(ctx.dbPath, "workspaces")).toBe(beforeWs);
    expect(countRows(ctx.dbPath, "workspace_memberships")).toBe(beforeMemb);
    expect(countRows(ctx.dbPath, "github_repository_bindings")).toBe(beforeBindings);

    // Case B: user not associated with installation row
    const inst2 = store.upsertGitHubInstallationWithUser({
      githubInstallationId: "77777",
      githubAppId: "123",
      accountId: "456",
      accountLogin: "org2",
      accountType: "Organization",
      repositorySelection: "all",
      userId: ident.user_id,
    });

    // Create second user without installation link
    const user2 = store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "subject_other",
      providerLogin: "other",
    });

    expect(() => {
      store.createWorkspaceWithRepositoryBinding({
        userId: user2.user_id,
        installationRowId: inst2.installation.id,
        githubRepositoryId: "999",
        ownerAccountId: "456",
        ownerLogin: "org2",
        repositoryName: "repo",
        fullName: "org2/repo",
        branch: "main",
      });
    }).toThrow(IdentityConflictError);

    expect(countRows(ctx.dbPath, "workspaces")).toBe(beforeWs);
    expect(countRows(ctx.dbPath, "workspace_memberships")).toBe(beforeMemb);
    expect(countRows(ctx.dbPath, "github_repository_bindings")).toBe(beforeBindings);
  });

  it("9. validation of IDs, strings, branch with NUL character, and open-time integrity", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    const store = openRaw(ctx);

    const inst = store.upsertGitHubInstallationWithUser({
      githubInstallationId: "100",
      githubAppId: "200",
      accountId: "300",
      accountLogin: "org",
      accountType: "Organization",
      repositorySelection: "all",
      userId: ident.user_id,
    });

    // Bad numeric IDs
    for (const badId of ["0", "-1", "+100", "0123", "", "1.2", "abc"]) {
      expect(() => {
        store.createWorkspaceWithRepositoryBinding({
          userId: ident.user_id,
          installationRowId: inst.installation.id,
          githubRepositoryId: badId,
          ownerAccountId: "300",
          ownerLogin: "org",
          repositoryName: "repo",
          fullName: "org/repo",
          branch: "main",
        });
      }).toThrow(IdentityStructureError);

      expect(() => {
        store.createWorkspaceWithRepositoryBinding({
          userId: ident.user_id,
          installationRowId: inst.installation.id,
          githubRepositoryId: "100",
          ownerAccountId: badId,
          ownerLogin: "org",
          repositoryName: "repo",
          fullName: "org/repo",
          branch: "main",
        });
      }).toThrow(IdentityStructureError);
    }

    // Branch with NUL
    expect(() => {
      store.createWorkspaceWithRepositoryBinding({
        userId: ident.user_id,
        installationRowId: inst.installation.id,
        githubRepositoryId: "100",
        ownerAccountId: "300",
        ownerLogin: "org",
        repositoryName: "repo",
        fullName: "org/repo",
        branch: "main\0bad",
      });
    }).toThrow(IdentityStructureError);

    // Empty branch or strings
    expect(() => {
      store.createWorkspaceWithRepositoryBinding({
        userId: ident.user_id,
        installationRowId: inst.installation.id,
        githubRepositoryId: "100",
        ownerAccountId: "300",
        ownerLogin: "",
        repositoryName: "repo",
        fullName: "org/repo",
        branch: "main",
      });
    }).toThrow(IdentityStructureError);

    store.close();

    // Open-time integrity check
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare(`
      INSERT INTO github_repository_bindings (
        id, workspace_id, github_repository_id, github_installation_row_id,
        owner_account_id, owner_login, repository_name, full_name,
        branch, created_at_ms, updated_at_ms
      ) VALUES ('grb_bad', '${ident.workspace_id}', '0', '${inst.installation.id}', '300', 'org', 'repo', 'org/repo', 'main', 1000, 1000);
    `).run();
    raw.close();

    expect(() => IdentityStore.open(ctx.dbPath)).toThrow(IdentityStructureError);
  });
});

describe("workspace_bootstraps lifecycle", () => {
  it("fresh provision has workspace_bootstraps table and zero rows", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    expect(countRows(ctx.dbPath, "workspace_bootstraps")).toBe(0);

    const raw = new DatabaseSync(ctx.dbPath);
    const ver = raw.prepare("PRAGMA user_version;").get() as { user_version: number };
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_bootstraps';").all();
    const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_workspace_bootstraps_state';").all();
    raw.close();

    expect(Number(ver.user_version)).toBe(IDENTITY_DB_USER_VERSION);
    expect(tables.length).toBe(1);
    expect(indexes.length).toBe(1);

    const store = openRaw(ctx);
    expect(store.findWorkspaceBootstrapByWorkspaceId(ident.workspace_id)).toBeNull();
  });

  it("E. new createWorkspaceWithRepositoryBinding atomically creates exactly Workspace + owner membership + binding + PENDING bootstrap, no API key", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    const store = openRaw(ctx);

    const inst = store.upsertGitHubInstallationWithUser({
      githubInstallationId: "12345",
      githubAppId: "6789",
      accountId: "999",
      accountLogin: "org",
      accountType: "Organization",
      repositorySelection: "selected",
      userId: ident.user_id,
    });

    const user2 = store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "sub-user-2",
      providerLogin: "login2",
    });

    store.upsertGitHubInstallationWithUser({
      githubInstallationId: "12345",
      githubAppId: "6789",
      accountId: "999",
      accountLogin: "org",
      accountType: "Organization",
      repositorySelection: "selected",
      userId: user2.user_id,
    });

    const result = store.createWorkspaceWithRepositoryBinding({
      userId: user2.user_id,
      installationRowId: inst.installation.id,
      githubRepositoryId: "2001",
      ownerAccountId: "999",
      ownerLogin: "org",
      repositoryName: "bound-repo",
      fullName: "org/bound-repo",
      branch: "main",
    });

    expect(result.workspace.owner_user_id).toBe(user2.user_id);
    expect(result.membership.role).toBe("owner");
    expect(result.binding.github_repository_id).toBe("2001");
    expect(result.bootstrap).toEqual({
      workspace_id: result.workspace.id,
      bootstrap_version: 1,
      state: "PENDING",
      attempt_count: 0,
      last_attempt_id: null,
      last_base_commit_sha: null,
      ready_commit_sha: null,
      last_error_kind: null,
      last_error_code: null,
      last_error_message: null,
      created_at_ms: expect.any(Number),
      updated_at_ms: expect.any(Number),
      ready_at_ms: null,
    });

    // Verify DB counts: no API key created
    expect(countRows(ctx.dbPath, "workspaces")).toBe(2);
    expect(countRows(ctx.dbPath, "workspace_memberships")).toBe(2);
    expect(countRows(ctx.dbPath, "github_repository_bindings")).toBe(1);
    expect(countRows(ctx.dbPath, "workspace_bootstraps")).toBe(1);
    expect(countRows(ctx.dbPath, "api_keys")).toBe(1); // Only the initial key for user 1

    expect(store.findWorkspaceBootstrapByWorkspaceId(result.workspace.id)).toEqual(result.bootstrap);
  });

  it("F. forced transaction failure leaves none of those partial rows", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    const store = openRaw(ctx);

    const inst = store.upsertGitHubInstallationWithUser({
      githubInstallationId: "12345",
      githubAppId: "6789",
      accountId: "999",
      accountLogin: "org",
      accountType: "Organization",
      repositorySelection: "selected",
      userId: ident.user_id,
    });

    const user2 = store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "sub-user-fail",
      providerLogin: "loginfail",
    });

    store.upsertGitHubInstallationWithUser({
      githubInstallationId: "12345",
      githubAppId: "6789",
      accountId: "999",
      accountLogin: "org",
      accountType: "Organization",
      repositorySelection: "selected",
      userId: user2.user_id,
    });

    // Create a first workspace for user2
    store.createWorkspaceWithRepositoryBinding({
      userId: user2.user_id,
      installationRowId: inst.installation.id,
      githubRepositoryId: "3001",
      ownerAccountId: "999",
      ownerLogin: "org",
      repositoryName: "repo-1",
      fullName: "org/repo-1",
      branch: "main",
    });

    const beforeWs = countRows(ctx.dbPath, "workspaces");
    const beforeBindings = countRows(ctx.dbPath, "github_repository_bindings");
    const beforeBootstraps = countRows(ctx.dbPath, "workspace_bootstraps");

    // Second call fails due to single-owned-workspace invariant
    expect(() => {
      store.createWorkspaceWithRepositoryBinding({
        userId: user2.user_id,
        installationRowId: inst.installation.id,
        githubRepositoryId: "3002",
        ownerAccountId: "999",
        ownerLogin: "org",
        repositoryName: "repo-2",
        fullName: "org/repo-2",
        branch: "main",
      });
    }).toThrow(IdentityConflictError);

    // Assert counts did not change (clean rollback)
    expect(countRows(ctx.dbPath, "workspaces")).toBe(beforeWs);
    expect(countRows(ctx.dbPath, "github_repository_bindings")).toBe(beforeBindings);
    expect(countRows(ctx.dbPath, "workspace_bootstraps")).toBe(beforeBootstraps);
  });

  it("G. begin attempt increments count and records opaque attempt id; stale attempt cannot mark READY/failure after a newer attempt begins", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    const store = openRaw(ctx);

    const inst = store.upsertGitHubInstallationWithUser({
      githubInstallationId: "12345",
      githubAppId: "6789",
      accountId: "999",
      accountLogin: "org",
      accountType: "Organization",
      repositorySelection: "selected",
      userId: ident.user_id,
    });

    const user2 = store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "sub-user-lifecycle",
      providerLogin: "loginlifecycle",
    });

    store.upsertGitHubInstallationWithUser({
      githubInstallationId: "12345",
      githubAppId: "6789",
      accountId: "999",
      accountLogin: "org",
      accountType: "Organization",
      repositorySelection: "selected",
      userId: user2.user_id,
    });

    const res = store.createWorkspaceWithRepositoryBinding({
      userId: user2.user_id,
      installationRowId: inst.installation.id,
      githubRepositoryId: "4001",
      ownerAccountId: "999",
      ownerLogin: "org",
      repositoryName: "lifecycle-repo",
      fullName: "org/lifecycle-repo",
      branch: "main",
    });
    const wsId = res.workspace.id;

    // First attempt
    const att1 = store.beginWorkspaceBootstrapAttempt(wsId);
    expect(att1.attemptId).toMatch(/^wba_[0-9a-f-]{36}$/);
    expect(att1.bootstrap.state).toBe("APPLYING");
    expect(att1.bootstrap.attempt_count).toBe(1);
    expect(att1.bootstrap.last_attempt_id).toBe(att1.attemptId);

    // Second attempt started before first completes (e.g. process crash or retry)
    const att2 = store.beginWorkspaceBootstrapAttempt(wsId);
    expect(att2.attemptId).toMatch(/^wba_[0-9a-f-]{36}$/);
    expect(att2.attemptId).not.toBe(att1.attemptId);
    expect(att2.bootstrap.state).toBe("APPLYING");
    expect(att2.bootstrap.attempt_count).toBe(2);
    expect(att2.bootstrap.last_attempt_id).toBe(att2.attemptId);

    const sha1 = "1".repeat(40);
    const sha2 = "2".repeat(40);

    // Old attempt cannot mark READY
    expect(() => {
      store.markWorkspaceBootstrapReady(wsId, att1.attemptId, { readyCommitSha: sha1 });
    }).toThrow(IdentityConflictError);

    // Old attempt cannot mark retryable failure
    expect(() => {
      store.markWorkspaceBootstrapRetryableFailure(wsId, att1.attemptId, { code: "NETWORK_ERROR", message: "fail" });
    }).toThrow(IdentityConflictError);

    // Old attempt cannot mark manual recovery
    expect(() => {
      store.markWorkspaceBootstrapManualRecovery(wsId, att1.attemptId, { code: "INVALID_BINDING", message: "manual" });
    }).toThrow(IdentityConflictError);

    // State is still APPLYING under att2
    const current = store.getWorkspaceBootstrap(wsId);
    expect(current?.state).toBe("APPLYING");
    expect(current?.last_attempt_id).toBe(att2.attemptId);

    // Active attempt att2 can mark ready
    const ready = store.markWorkspaceBootstrapReady(wsId, att2.attemptId, { readyCommitSha: sha2 });
    expect(ready.state).toBe("READY");
    expect(ready.ready_commit_sha).toBe(sha2);
    expect(ready.ready_at_ms).toBeGreaterThan(0);
    expect(ready.last_error_kind).toBeNull();
    expect(ready.last_error_code).toBeNull();
    expect(ready.last_error_message).toBeNull();

    // After ready, another mark on same or old attempt is rejected
    expect(() => {
      store.markWorkspaceBootstrapReady(wsId, att2.attemptId, { readyCommitSha: sha2 });
    }).toThrow(IdentityConflictError);
  });

  it("H. READY/failure state semantic validation rejects impossible combinations", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    const store = openRaw(ctx);

    const inst = store.upsertGitHubInstallationWithUser({
      githubInstallationId: "12345",
      githubAppId: "6789",
      accountId: "999",
      accountLogin: "org",
      accountType: "Organization",
      repositorySelection: "selected",
      userId: ident.user_id,
    });

    const user2 = store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "sub-user-validation",
      providerLogin: "loginval",
    });

    store.upsertGitHubInstallationWithUser({
      githubInstallationId: "12345",
      githubAppId: "6789",
      accountId: "999",
      accountLogin: "org",
      accountType: "Organization",
      repositorySelection: "selected",
      userId: user2.user_id,
    });

    const res = store.createWorkspaceWithRepositoryBinding({
      userId: user2.user_id,
      installationRowId: inst.installation.id,
      githubRepositoryId: "5001",
      ownerAccountId: "999",
      ownerLogin: "org",
      repositoryName: "val-repo",
      fullName: "org/val-repo",
      branch: "main",
    });
    store.close();

    const wsId = res.workspace.id;

    // Helper to mutate DB directly and verify IdentityStore.open throws IdentityStructureError
    const testDirectViolation = (sql: string, params: unknown[] = []) => {
      const raw = new DatabaseSync(ctx.dbPath);
      raw.prepare(sql).run(...params);
      raw.close();
      expect(() => IdentityStore.open(ctx.dbPath)).toThrow(IdentityStructureError);
    };

    // 1. READY missing ready_commit_sha
    testDirectViolation(
      "UPDATE workspace_bootstraps SET state='READY', ready_commit_sha=NULL, ready_at_ms=1000 WHERE workspace_id=?",
      [wsId],
    );

    // 2. READY missing ready_at_ms
    testDirectViolation(
      "UPDATE workspace_bootstraps SET state='READY', ready_commit_sha=?, ready_at_ms=NULL WHERE workspace_id=?",
      ["a".repeat(40), wsId],
    );

    // 3. READY with active failure field
    testDirectViolation(
      "UPDATE workspace_bootstraps SET state='READY', ready_commit_sha=?, ready_at_ms=1000, last_error_kind='retryable', last_error_code='ERR', last_error_message='msg' WHERE workspace_id=?",
      ["a".repeat(40), wsId],
    );

    // 4. PENDING claiming ready
    testDirectViolation(
      "UPDATE workspace_bootstraps SET state='PENDING', ready_commit_sha=?, ready_at_ms=1000, last_error_kind=NULL, last_error_code=NULL, last_error_message=NULL WHERE workspace_id=?",
      ["a".repeat(40), wsId],
    );

    // 5. APPLYING claiming ready
    testDirectViolation(
      "UPDATE workspace_bootstraps SET state='APPLYING', ready_commit_sha=?, ready_at_ms=1000, last_error_kind=NULL, last_error_code=NULL, last_error_message=NULL WHERE workspace_id=?",
      ["a".repeat(40), wsId],
    );

    // 6. RETRYABLE_FAILURE with wrong error kind (manual)
    testDirectViolation(
      "UPDATE workspace_bootstraps SET state='RETRYABLE_FAILURE', ready_commit_sha=NULL, ready_at_ms=NULL, last_error_kind='manual', last_error_code='ERR', last_error_message='msg' WHERE workspace_id=?",
      [wsId],
    );

    // 7. MANUAL_RECOVERY with wrong error kind (retryable)
    testDirectViolation(
      "UPDATE workspace_bootstraps SET state='MANUAL_RECOVERY', ready_commit_sha=NULL, ready_at_ms=NULL, last_error_kind='retryable', last_error_code='ERR', last_error_message='msg' WHERE workspace_id=?",
      [wsId],
    );

    // 8. RETRYABLE_FAILURE with empty error code
    testDirectViolation(
      "UPDATE workspace_bootstraps SET state='RETRYABLE_FAILURE', ready_commit_sha=NULL, ready_at_ms=NULL, last_error_kind='retryable', last_error_code='', last_error_message='msg' WHERE workspace_id=?",
      [wsId],
    );

    // 9. MANUAL_RECOVERY with empty error message
    testDirectViolation(
      "UPDATE workspace_bootstraps SET state='MANUAL_RECOVERY', ready_commit_sha=NULL, ready_at_ms=NULL, last_error_kind='manual', last_error_code='ERR', last_error_message='' WHERE workspace_id=?",
      [wsId],
    );

    // 10. Invalid commit SHA length
    testDirectViolation(
      "UPDATE workspace_bootstraps SET state='READY', ready_commit_sha='badsha', ready_at_ms=1000, last_error_kind=NULL, last_error_code=NULL, last_error_message=NULL WHERE workspace_id=?",
      [wsId],
    );

    // 11. Unsupported bootstrap version
    testDirectViolation(
      "UPDATE workspace_bootstraps SET state='PENDING', bootstrap_version=2, ready_commit_sha=NULL, ready_at_ms=NULL, last_error_kind=NULL, last_error_code=NULL, last_error_message=NULL WHERE workspace_id=?",
      [wsId],
    );

    // 12. Negative attempt count
    testDirectViolation(
      "UPDATE workspace_bootstraps SET state='PENDING', bootstrap_version=1, attempt_count=-1 WHERE workspace_id=?",
      [wsId],
    );

    // 13. Negative created_at_ms
    testDirectViolation(
      "UPDATE workspace_bootstraps SET state='PENDING', attempt_count=0, created_at_ms=-100 WHERE workspace_id=?",
      [wsId],
    );
  });
});


