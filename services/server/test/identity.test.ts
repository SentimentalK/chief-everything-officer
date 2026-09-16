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
    expect(() => IdentityStore.open(ctx.dbPath)).toThrow(/missing required table|exactly one user|Cannot migrate to v2/);
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

describe("v2/v3/v4/v5 schema & external identities migration", () => {
  it("provisions fresh database with user_version = 5, external_identities, workspace_memberships, github_installations, and github_repository_bindings", async () => {
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

  it("auto-migrates an existing v1 database to v5 on open", async () => {
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
    expect(Number(versionRow.user_version)).toBe(IDENTITY_DB_USER_VERSION);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table';").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("external_identities");
    expect(names).toContain("workspace_memberships");
    expect(names).toContain("github_installations");
    expect(names).toContain("github_installation_users");
    expect(names).toContain("github_repository_bindings");
    const membership = raw.prepare(
      "SELECT user_id, role FROM workspace_memberships WHERE workspace_id = 'ws_v1';",
    ).get() as { user_id: string; role: string };
    expect(membership.user_id).toBe("usr_v1");
    expect(membership.role).toBe("owner");
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
    | "github_installation_users",
): number {
  const raw = new DatabaseSync(dbPath);
  const row = raw.prepare(`SELECT COUNT(*) AS c FROM ${table};`).get() as { c: number };
  raw.close();
  return Number(row.c);
}

function seedV2Database(
  dbPath: string,
  input: {
    remoteUrl: string;
    branch: string;
    users?: Array<{ id: string; created_at: number; disabled_at?: number | null }>;
    workspaces?: Array<{
      id: string;
      owner_user_id: string;
      remote_url: string;
      branch: string;
      created_at: number;
    }>;
    apiKeys?: Array<{
      id: string;
      user_id: string;
      key_digest: string;
      created_at: number;
      revoked_at?: number | null;
    }>;
  },
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
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
      UNIQUE(provider, provider_subject),
      UNIQUE(provider, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_external_identities_user ON external_identities(user_id);
    PRAGMA user_version = 2;
  `);
  for (const user of input.users ?? []) {
    db.prepare("INSERT INTO users VALUES (?, ?, ?);").run(user.id, user.created_at, user.disabled_at ?? null);
  }
  for (const ws of input.workspaces ?? []) {
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
      ws.id,
      ws.owner_user_id,
      ws.remote_url,
      ws.branch,
      ws.created_at,
    );
  }
  for (const key of input.apiKeys ?? []) {
    db.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, ?);").run(
      key.id,
      key.user_id,
      key.key_digest,
      key.created_at,
      key.revoked_at ?? null,
    );
  }
  db.close();
}

function seedV3Database(
  dbPath: string,
  input: {
    remoteUrl: string;
    branch: string;
    users?: Array<{ id: string; created_at: number; disabled_at?: number | null }>;
    workspaces?: Array<{
      id: string;
      owner_user_id: string;
      remote_url: string;
      branch: string;
      created_at: number;
    }>;
    workspaceMemberships?: Array<{
      id: string;
      workspace_id: string;
      user_id: string;
      role: string;
      created_at: number;
    }>;
    apiKeys?: Array<{
      id: string;
      user_id: string;
      key_digest: string;
      created_at: number;
      revoked_at?: number | null;
    }>;
    externalIdentities?: Array<{
      id: string;
      provider: string;
      provider_subject: string;
      user_id: string;
      provider_login?: string | null;
      created_at_ms: number;
      updated_at_ms: number;
    }>;
  },
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
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
      UNIQUE(provider, provider_subject),
      UNIQUE(provider, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE workspace_memberships (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(workspace_id, user_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX idx_workspaces_owner ON workspaces(owner_user_id);
    CREATE INDEX idx_api_keys_user ON api_keys(user_id);
    CREATE INDEX idx_external_identities_user ON external_identities(user_id);
    CREATE INDEX idx_workspace_memberships_user ON workspace_memberships(user_id);
    CREATE INDEX idx_workspace_memberships_workspace ON workspace_memberships(workspace_id);
    CREATE UNIQUE INDEX ux_workspace_memberships_owner ON workspace_memberships(workspace_id) WHERE role = 'owner';
    PRAGMA user_version = 3;
  `);
  for (const user of input.users ?? []) {
    db.prepare("INSERT INTO users VALUES (?, ?, ?);").run(user.id, user.created_at, user.disabled_at ?? null);
  }
  for (const ws of input.workspaces ?? []) {
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
      ws.id,
      ws.owner_user_id,
      ws.remote_url,
      ws.branch,
      ws.created_at,
    );
  }
  for (const m of input.workspaceMemberships ?? []) {
    db.prepare("INSERT INTO workspace_memberships VALUES (?, ?, ?, ?, ?);").run(
      m.id,
      m.workspace_id,
      m.user_id,
      m.role,
      m.created_at,
    );
  }
  for (const key of input.apiKeys ?? []) {
    db.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, ?);").run(
      key.id,
      key.user_id,
      key.key_digest,
      key.created_at,
      key.revoked_at ?? null,
    );
  }
  for (const ext of input.externalIdentities ?? []) {
    db.prepare("INSERT INTO external_identities VALUES (?, ?, ?, ?, ?, ?, ?);").run(
      ext.id,
      ext.provider,
      ext.provider_subject,
      ext.user_id,
      ext.provider_login ?? null,
      ext.created_at_ms,
      ext.updated_at_ms,
    );
  }
  db.close();
}

function seedV4Database(
  dbPath: string,
  input: {
    remoteUrl: string;
    branch: string;
    users?: Array<{ id: string; created_at: number; disabled_at?: number | null }>;
    workspaces?: Array<{
      id: string;
      owner_user_id: string;
      remote_url: string;
      branch: string;
      created_at: number;
    }>;
    workspaceMemberships?: Array<{
      id: string;
      workspace_id: string;
      user_id: string;
      role: string;
      created_at: number;
    }>;
    apiKeys?: Array<{
      id: string;
      user_id: string;
      key_digest: string;
      created_at: number;
      revoked_at?: number | null;
    }>;
    externalIdentities?: Array<{
      id: string;
      provider: string;
      provider_subject: string;
      user_id: string;
      provider_login?: string | null;
      created_at_ms: number;
      updated_at_ms: number;
    }>;
    githubInstallations?: Array<{
      id: string;
      github_installation_id: string;
      github_app_id: string;
      account_id: string;
      account_login: string;
      account_type: string;
      repository_selection: string;
      suspended_at_ms?: number | null;
      created_at_ms: number;
      updated_at_ms: number;
    }>;
    githubInstallationUsers?: Array<{
      id: string;
      github_installation_row_id: string;
      user_id: string;
      created_at_ms: number;
      verified_at_ms: number;
    }>;
  },
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
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
      UNIQUE(provider, provider_subject),
      UNIQUE(provider, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE workspace_memberships (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(workspace_id, user_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE github_installations (
      id TEXT PRIMARY KEY NOT NULL,
      github_installation_id TEXT NOT NULL UNIQUE,
      github_app_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_login TEXT NOT NULL,
      account_type TEXT NOT NULL,
      repository_selection TEXT NOT NULL,
      suspended_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE github_installation_users (
      id TEXT PRIMARY KEY NOT NULL,
      github_installation_row_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      verified_at_ms INTEGER NOT NULL,
      UNIQUE(github_installation_row_id, user_id),
      FOREIGN KEY (github_installation_row_id) REFERENCES github_installations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_workspaces_owner ON workspaces(owner_user_id);
    CREATE INDEX idx_api_keys_user ON api_keys(user_id);
    CREATE INDEX idx_external_identities_user ON external_identities(user_id);
    CREATE INDEX idx_workspace_memberships_user ON workspace_memberships(user_id);
    CREATE INDEX idx_workspace_memberships_workspace ON workspace_memberships(workspace_id);
    CREATE UNIQUE INDEX ux_workspace_memberships_owner ON workspace_memberships(workspace_id) WHERE role = 'owner';
    CREATE INDEX idx_github_installation_users_user ON github_installation_users(user_id);
    CREATE INDEX idx_github_installation_users_installation ON github_installation_users(github_installation_row_id);
    PRAGMA user_version = 4;
  `);
  for (const user of input.users ?? []) {
    db.prepare("INSERT INTO users VALUES (?, ?, ?);").run(user.id, user.created_at, user.disabled_at ?? null);
  }
  for (const ws of input.workspaces ?? []) {
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
      ws.id,
      ws.owner_user_id,
      ws.remote_url,
      ws.branch,
      ws.created_at,
    );
  }
  for (const m of input.workspaceMemberships ?? []) {
    db.prepare("INSERT INTO workspace_memberships VALUES (?, ?, ?, ?, ?);").run(
      m.id,
      m.workspace_id,
      m.user_id,
      m.role,
      m.created_at,
    );
  }
  for (const key of input.apiKeys ?? []) {
    db.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, ?);").run(
      key.id,
      key.user_id,
      key.key_digest,
      key.created_at,
      key.revoked_at ?? null,
    );
  }
  for (const ext of input.externalIdentities ?? []) {
    db.prepare("INSERT INTO external_identities VALUES (?, ?, ?, ?, ?, ?, ?);").run(
      ext.id,
      ext.provider,
      ext.provider_subject,
      ext.user_id,
      ext.provider_login ?? null,
      ext.created_at_ms,
      ext.updated_at_ms,
    );
  }
  for (const inst of input.githubInstallations ?? []) {
    db.prepare(`
      INSERT INTO github_installations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `).run(
      inst.id,
      inst.github_installation_id,
      inst.github_app_id,
      inst.account_id,
      inst.account_login,
      inst.account_type,
      inst.repository_selection,
      inst.suspended_at_ms ?? null,
      inst.created_at_ms,
      inst.updated_at_ms,
    );
  }
  for (const iu of input.githubInstallationUsers ?? []) {
    db.prepare(`
      INSERT INTO github_installation_users VALUES (?, ?, ?, ?, ?);
    `).run(
      iu.id,
      iu.github_installation_row_id,
      iu.user_id,
      iu.created_at_ms,
      iu.verified_at_ms,
    );
  }
  db.close();
}

function seedV5Database(
  dbPath: string,
  input: {
    remoteUrl: string;
    branch: string;
    users?: Array<{ id: string; created_at: number; disabled_at?: number | null }>;
    workspaces?: Array<{
      id: string;
      owner_user_id: string;
      remote_url: string;
      branch: string;
      created_at: number;
    }>;
    workspaceMemberships?: Array<{
      id: string;
      workspace_id: string;
      user_id: string;
      role: string;
      created_at: number;
    }>;
    apiKeys?: Array<{
      id: string;
      user_id: string;
      key_digest: string;
      created_at: number;
      revoked_at?: number | null;
    }>;
    externalIdentities?: Array<{
      id: string;
      provider: string;
      provider_subject: string;
      user_id: string;
      provider_login?: string | null;
      created_at_ms: number;
      updated_at_ms: number;
    }>;
    githubInstallations?: Array<{
      id: string;
      github_installation_id: string;
      github_app_id: string;
      account_id: string;
      account_login: string;
      account_type: string;
      repository_selection: string;
      suspended_at_ms?: number | null;
      created_at_ms: number;
      updated_at_ms: number;
    }>;
    githubInstallationUsers?: Array<{
      id: string;
      github_installation_row_id: string;
      user_id: string;
      created_at_ms: number;
      verified_at_ms: number;
    }>;
    githubRepositoryBindings?: Array<{
      id: string;
      workspace_id: string;
      github_repository_id: string;
      github_installation_row_id: string;
      owner_account_id: string;
      owner_login: string;
      repository_name: string;
      full_name: string;
      branch: string;
      created_at_ms: number;
      updated_at_ms: number;
    }>;
  },
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
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
      UNIQUE(provider, provider_subject),
      UNIQUE(provider, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE workspace_memberships (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(workspace_id, user_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE github_installations (
      id TEXT PRIMARY KEY NOT NULL,
      github_installation_id TEXT NOT NULL UNIQUE,
      github_app_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_login TEXT NOT NULL,
      account_type TEXT NOT NULL,
      repository_selection TEXT NOT NULL,
      suspended_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE github_installation_users (
      id TEXT PRIMARY KEY NOT NULL,
      github_installation_row_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      verified_at_ms INTEGER NOT NULL,
      UNIQUE(github_installation_row_id, user_id),
      FOREIGN KEY (github_installation_row_id) REFERENCES github_installations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE github_repository_bindings (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL UNIQUE,
      github_repository_id TEXT NOT NULL UNIQUE,
      github_installation_row_id TEXT NOT NULL,
      owner_account_id TEXT NOT NULL,
      owner_login TEXT NOT NULL,
      repository_name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY (github_installation_row_id) REFERENCES github_installations(id)
    );
    CREATE INDEX idx_workspaces_owner ON workspaces(owner_user_id);
    CREATE INDEX idx_api_keys_user ON api_keys(user_id);
    CREATE INDEX idx_external_identities_user ON external_identities(user_id);
    CREATE INDEX idx_workspace_memberships_user ON workspace_memberships(user_id);
    CREATE INDEX idx_workspace_memberships_workspace ON workspace_memberships(workspace_id);
    CREATE UNIQUE INDEX ux_workspace_memberships_owner ON workspace_memberships(workspace_id) WHERE role = 'owner';
    CREATE INDEX idx_github_installation_users_user ON github_installation_users(user_id);
    CREATE INDEX idx_github_installation_users_installation ON github_installation_users(github_installation_row_id);
    CREATE INDEX idx_github_repository_bindings_installation ON github_repository_bindings(github_installation_row_id);
    PRAGMA user_version = 5;
  `);
  for (const user of input.users ?? []) {
    db.prepare("INSERT INTO users VALUES (?, ?, ?);").run(user.id, user.created_at, user.disabled_at ?? null);
  }
  for (const ws of input.workspaces ?? []) {
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
      ws.id,
      ws.owner_user_id,
      ws.remote_url,
      ws.branch,
      ws.created_at,
    );
  }
  for (const m of input.workspaceMemberships ?? []) {
    db.prepare("INSERT INTO workspace_memberships VALUES (?, ?, ?, ?, ?);").run(
      m.id,
      m.workspace_id,
      m.user_id,
      m.role,
      m.created_at,
    );
  }
  for (const key of input.apiKeys ?? []) {
    db.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, ?);").run(
      key.id,
      key.user_id,
      key.key_digest,
      key.created_at,
      key.revoked_at ?? null,
    );
  }
  for (const ext of input.externalIdentities ?? []) {
    db.prepare("INSERT INTO external_identities VALUES (?, ?, ?, ?, ?, ?, ?);").run(
      ext.id,
      ext.provider,
      ext.provider_subject,
      ext.user_id,
      ext.provider_login ?? null,
      ext.created_at_ms,
      ext.updated_at_ms,
    );
  }
  for (const inst of input.githubInstallations ?? []) {
    db.prepare(`
      INSERT INTO github_installations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `).run(
      inst.id,
      inst.github_installation_id,
      inst.github_app_id,
      inst.account_id,
      inst.account_login,
      inst.account_type,
      inst.repository_selection,
      inst.suspended_at_ms ?? null,
      inst.created_at_ms,
      inst.updated_at_ms,
    );
  }
  for (const iu of input.githubInstallationUsers ?? []) {
    db.prepare(`
      INSERT INTO github_installation_users VALUES (?, ?, ?, ?, ?);
    `).run(
      iu.id,
      iu.github_installation_row_id,
      iu.user_id,
      iu.created_at_ms,
      iu.verified_at_ms,
    );
  }
  for (const grb of input.githubRepositoryBindings ?? []) {
    db.prepare(`
      INSERT INTO github_repository_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `).run(
      grb.id,
      grb.workspace_id,
      grb.github_repository_id,
      grb.github_installation_row_id,
      grb.owner_account_id,
      grb.owner_login,
      grb.repository_name,
      grb.full_name,
      grb.branch,
      grb.created_at_ms,
      grb.updated_at_ms,
    );
  }
  db.close();
}

describe("v3 workspace_memberships schema & migration", () => {
  it("A. fresh v3 provision creates exact counts and owner membership with shadow match", async () => {
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

  it("B. v2→v3 migration preserves IDs and adds one owner membership per workspace", async () => {
    const ctx = await tempCtx();
    seedV2Database(ctx.dbPath, {
      remoteUrl: ctx.remoteUrl,
      branch: ctx.branch,
      users: [{ id: "usr_a", created_at: 1000 }],
      workspaces: [{ id: "ws_a", owner_user_id: "usr_a", remote_url: ctx.remoteUrl, branch: ctx.branch, created_at: 1000 }],
      apiKeys: [{ id: "ak_a", user_id: "usr_a", key_digest: sha256Hex("key-1"), created_at: 1000 }],
    });

    const store = IdentityStore.open(ctx.dbPath);
    cleanupStores.push(store);

    const raw = new DatabaseSync(ctx.dbPath);
    expect(Number((raw.prepare("PRAGMA user_version;").get() as { user_version: number }).user_version)).toBe(IDENTITY_DB_USER_VERSION);
    expect(countRows(ctx.dbPath, "users")).toBe(1);
    expect(countRows(ctx.dbPath, "workspaces")).toBe(1);
    expect(countRows(ctx.dbPath, "workspace_memberships")).toBe(1);
    const membership = raw.prepare(
      "SELECT user_id, role, created_at FROM workspace_memberships WHERE workspace_id = 'ws_a';",
    ).get() as { user_id: string; role: string; created_at: number };
    expect(membership.user_id).toBe("usr_a");
    expect(membership.role).toBe("owner");
    expect(membership.created_at).toBe(1000);
    raw.close();
  });

  it("C. multi-workspace v2 migration binds each workspace to its owner", async () => {
    const ctx = await tempCtx();
    seedV2Database(ctx.dbPath, {
      remoteUrl: ctx.remoteUrl,
      branch: ctx.branch,
      users: [
        { id: "usr_a", created_at: 1000 },
        { id: "usr_b", created_at: 1001 },
      ],
      workspaces: [
        { id: "ws_a", owner_user_id: "usr_a", remote_url: ctx.remoteUrl, branch: ctx.branch, created_at: 1000 },
        { id: "ws_b", owner_user_id: "usr_b", remote_url: "git@example.com:org/b.git", branch: "main", created_at: 1001 },
      ],
      apiKeys: [
        { id: "ak_a", user_id: "usr_a", key_digest: sha256Hex("key-a"), created_at: 1000 },
        { id: "ak_b", user_id: "usr_b", key_digest: sha256Hex("key-b"), created_at: 1001 },
      ],
    });

    const store = IdentityStore.open(ctx.dbPath);
    cleanupStores.push(store);

    const raw = new DatabaseSync(ctx.dbPath);
    const memberships = raw.prepare(
      "SELECT workspace_id, user_id FROM workspace_memberships ORDER BY workspace_id ASC;",
    ).all() as Array<{ workspace_id: string; user_id: string }>;
    raw.close();
    expect(memberships).toEqual([
      { workspace_id: "ws_a", user_id: "usr_a" },
      { workspace_id: "ws_b", user_id: "usr_b" },
    ]);
  });

  it("D. zero-workspace user survives migration with zero memberships", async () => {
    const ctx = await tempCtx();
    seedV2Database(ctx.dbPath, {
      remoteUrl: ctx.remoteUrl,
      branch: ctx.branch,
      users: [
        { id: "usr_a", created_at: 1000 },
        { id: "usr_b", created_at: 1001 },
      ],
      workspaces: [{ id: "ws_a", owner_user_id: "usr_a", remote_url: ctx.remoteUrl, branch: ctx.branch, created_at: 1000 }],
      apiKeys: [{ id: "ak_a", user_id: "usr_a", key_digest: sha256Hex("key-a"), created_at: 1000 }],
    });

    const store = IdentityStore.open(ctx.dbPath);
    cleanupStores.push(store);

    const raw = new DatabaseSync(ctx.dbPath);
    const bMemberships = raw.prepare(
      "SELECT COUNT(*) AS c FROM workspace_memberships WHERE user_id = 'usr_b';",
    ).get() as { c: number };
    raw.close();
    expect(Number(bMemberships.c)).toBe(0);
  });

  it("E. user may own multiple workspaces after migration", async () => {
    const ctx = await tempCtx();
    seedV2Database(ctx.dbPath, {
      remoteUrl: ctx.remoteUrl,
      branch: ctx.branch,
      users: [{ id: "usr_a", created_at: 1000 }],
      workspaces: [
        { id: "ws_1", owner_user_id: "usr_a", remote_url: ctx.remoteUrl, branch: ctx.branch, created_at: 1000 },
        { id: "ws_2", owner_user_id: "usr_a", remote_url: "git@example.com:org/other.git", branch: "dev", created_at: 1001 },
      ],
      apiKeys: [{ id: "ak_a", user_id: "usr_a", key_digest: sha256Hex("key-a"), created_at: 1000 }],
    });

    const store = IdentityStore.open(ctx.dbPath);
    cleanupStores.push(store);

    const raw = new DatabaseSync(ctx.dbPath);
    const count = raw.prepare(
      "SELECT COUNT(*) AS c FROM workspace_memberships WHERE user_id = 'usr_a';",
    ).get() as { c: number };
    raw.close();
    expect(Number(count.c)).toBe(2);
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
    raw.prepare("INSERT INTO users VALUES ('usr_other', 2000, NULL);").run();
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
    raw.prepare("INSERT INTO users VALUES ('usr_other', 2000, NULL);").run();
    raw.exec("UPDATE workspaces SET owner_user_id = 'usr_other' WHERE 1=1;");
    raw.close();
    expect(() => IdentityStore.open(ctx.dbPath)).toThrow(IdentityStructureError);
  });

  it("M. forced v2→v3 migration error leaves version at 2 with no partial truth", async () => {
    const ctx = await tempCtx();
    fs.mkdirSync(path.dirname(ctx.dbPath), { recursive: true });
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, disabled_at INTEGER);
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL, remote_url TEXT NOT NULL,
        branch TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, key_digest TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE external_identities (
        id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        provider_subject TEXT NOT NULL,
        user_id TEXT NOT NULL,
        provider_login TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(provider, provider_subject),
        UNIQUE(provider, user_id)
      );
      PRAGMA user_version = 2;
      INSERT INTO users VALUES ('usr_a', 1000, NULL);
      INSERT INTO workspaces VALUES ('ws_a', 'usr_missing', '${ctx.remoteUrl}', '${ctx.branch}', 1000);
    `);
    raw.close();

    expect(() => IdentityStore.open(ctx.dbPath)).toThrow(/version 2 to 3|FOREIGN KEY/);
    const after = new DatabaseSync(ctx.dbPath);
    expect(Number((after.prepare("PRAGMA user_version;").get() as { user_version: number }).user_version)).toBe(2);
    const tables = after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_memberships';").all();
    expect(tables).toEqual([]);
    after.close();
  });

  it("M2. forced v1→v2 migration error leaves version at 1", async () => {
    const ctx = await tempCtx();
    fs.mkdirSync(path.dirname(ctx.dbPath), { recursive: true });
    const db = new DatabaseSync(ctx.dbPath);
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, disabled_at INTEGER);
      PRAGMA user_version = 1;
    `);
    db.close();

    expect(() => IdentityStore.open(ctx.dbPath)).toThrow(/Cannot migrate to v2|version 1 to 2/);
    const after = new DatabaseSync(ctx.dbPath);
    expect(Number((after.prepare("PRAGMA user_version;").get() as { user_version: number }).user_version)).toBe(1);
    const tables = after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='external_identities';").all();
    expect(tables).toEqual([]);
    after.close();
  });

  it("N. v1 fixture migrates through v2 to v3", async () => {
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
      PRAGMA user_version = 1;
      INSERT INTO users VALUES ('usr_chain', 1000, NULL);
      INSERT INTO workspaces VALUES ('ws_chain', 'usr_chain', '${ctx.remoteUrl}', '${ctx.branch}', 1000);
      INSERT INTO api_keys VALUES ('ak_chain', 'usr_chain', '${sha256Hex("key-chain")}', 1000, NULL);
    `);
    db.close();

    const store = IdentityStore.open(ctx.dbPath);
    cleanupStores.push(store);

    const raw = new DatabaseSync(ctx.dbPath);
    expect(Number((raw.prepare("PRAGMA user_version;").get() as { user_version: number }).user_version)).toBe(IDENTITY_DB_USER_VERSION);
    expect(countRows(ctx.dbPath, "workspace_memberships")).toBe(1);
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

describe("v4 github_installations control-plane schema & migration", () => {
  it("A. fresh v4 provision creates zero installation rows and sets user_version = 4", async () => {
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

  it("B. v3→v4 migration preserves v3 data, performs no backfill, and sets user_version = 4", async () => {
    const ctx = await tempCtx();
    seedV3Database(ctx.dbPath, {
      remoteUrl: ctx.remoteUrl,
      branch: ctx.branch,
      users: [{ id: "usr_v3", created_at: 1000 }],
      workspaces: [
        { id: "ws_v3", owner_user_id: "usr_v3", remote_url: ctx.remoteUrl, branch: ctx.branch, created_at: 1000 },
      ],
      workspaceMemberships: [
        { id: "wsm_v3", workspace_id: "ws_v3", user_id: "usr_v3", role: "owner", created_at: 1000 },
      ],
      apiKeys: [{ id: "ak_v3", user_id: "usr_v3", key_digest: sha256Hex("key-3"), created_at: 1000 }],
      externalIdentities: [
        {
          id: "ext_v3",
          provider: "github",
          provider_subject: "98765",
          user_id: "usr_v3",
          provider_login: "octocat",
          created_at_ms: 1000,
          updated_at_ms: 1000,
        },
      ],
    });

    const store = IdentityStore.open(ctx.dbPath);
    cleanupStores.push(store);

    const raw = new DatabaseSync(ctx.dbPath);
    expect(Number((raw.prepare("PRAGMA user_version;").get() as { user_version: number }).user_version)).toBe(IDENTITY_DB_USER_VERSION);
    raw.close();

    expect(countRows(ctx.dbPath, "users")).toBe(1);
    expect(countRows(ctx.dbPath, "workspaces")).toBe(1);
    expect(countRows(ctx.dbPath, "workspace_memberships")).toBe(1);
    expect(countRows(ctx.dbPath, "api_keys")).toBe(1);
    expect(countRows(ctx.dbPath, "external_identities")).toBe(1);
    expect(countRows(ctx.dbPath, "github_installations")).toBe(0);
    expect(countRows(ctx.dbPath, "github_installation_users")).toBe(0);
    expect(countRows(ctx.dbPath, "github_repository_bindings")).toBe(0);

    const ext = store.findExternalIdentity("github", "98765");
    expect(ext).not.toBeNull();
    expect(ext?.provider_login).toBe("octocat");
  });

  it("C. v1→v4 migration chain executes all steps sequentially up to v4", async () => {
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
      PRAGMA user_version = 1;
      INSERT INTO users VALUES ('usr_v1', 1000, NULL);
      INSERT INTO workspaces VALUES ('ws_v1', 'usr_v1', '${ctx.remoteUrl}', '${ctx.branch}', 1000);
      INSERT INTO api_keys VALUES ('ak_v1', 'usr_v1', '${sha256Hex("key-1")}', 1000, NULL);
    `);
    db.close();

    const store = IdentityStore.open(ctx.dbPath);
    cleanupStores.push(store);

    const raw = new DatabaseSync(ctx.dbPath);
    expect(Number((raw.prepare("PRAGMA user_version;").get() as { user_version: number }).user_version)).toBe(IDENTITY_DB_USER_VERSION);
    raw.close();

    expect(countRows(ctx.dbPath, "workspace_memberships")).toBe(1);
    expect(countRows(ctx.dbPath, "external_identities")).toBe(0);
    expect(countRows(ctx.dbPath, "github_installations")).toBe(0);
    expect(countRows(ctx.dbPath, "github_installation_users")).toBe(0);
    expect(countRows(ctx.dbPath, "github_repository_bindings")).toBe(0);
  });

  it("D. failed v3→v4 migration rolls back cleanly to v3", async () => {
    const ctx = await tempCtx();
    fs.mkdirSync(path.dirname(ctx.dbPath), { recursive: true });
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, disabled_at INTEGER);
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL, remote_url TEXT NOT NULL,
        branch TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, key_digest TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE external_identities (
        id TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, provider_subject TEXT NOT NULL,
        user_id TEXT NOT NULL, provider_login TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      PRAGMA user_version = 3;
      INSERT INTO users VALUES ('usr_a', 1000, NULL);
      INSERT INTO workspaces VALUES ('ws_a', 'usr_a', '${ctx.remoteUrl}', '${ctx.branch}', 1000);
    `);
    // Note: missing workspace_memberships table!
    raw.close();

    expect(() => IdentityStore.open(ctx.dbPath)).toThrow(/version 3 to 4|missing required v3 table/);
    const after = new DatabaseSync(ctx.dbPath);
    expect(Number((after.prepare("PRAGMA user_version;").get() as { user_version: number }).user_version)).toBe(3);
    const tables = after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='github_installations';").all();
    expect(tables).toEqual([]);
    after.close();
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

describe("v5 github_repository_bindings control-plane schema & migration", () => {
  it("1. fresh v5 has github_repository_bindings table and zero bindings", async () => {
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

  it("2. v4→v5 preserves all existing rows/IDs and adds no binding", async () => {
    const ctx = await tempCtx();
    seedV4Database(ctx.dbPath, {
      remoteUrl: ctx.remoteUrl,
      branch: ctx.branch,
      users: [{ id: "usr_v4", created_at: 1000 }],
      workspaces: [
        { id: "ws_v4", owner_user_id: "usr_v4", remote_url: ctx.remoteUrl, branch: ctx.branch, created_at: 1000 },
      ],
      workspaceMemberships: [
        { id: "wsm_v4", workspace_id: "ws_v4", user_id: "usr_v4", role: "owner", created_at: 1000 },
      ],
      apiKeys: [{ id: "ak_v4", user_id: "usr_v4", key_digest: sha256Hex("key-4"), created_at: 1000 }],
      externalIdentities: [
        {
          id: "ext_v4",
          provider: "github",
          provider_subject: "88888",
          user_id: "usr_v4",
          provider_login: "dev4",
          created_at_ms: 1000,
          updated_at_ms: 1000,
        },
      ],
      githubInstallations: [
        {
          id: "ghi_v4",
          github_installation_id: "12345",
          github_app_id: "6789",
          account_id: "99999",
          account_login: "test-org",
          account_type: "Organization",
          repository_selection: "selected",
          created_at_ms: 1000,
          updated_at_ms: 1000,
        },
      ],
      githubInstallationUsers: [
        {
          id: "ghiu_v4",
          github_installation_row_id: "ghi_v4",
          user_id: "usr_v4",
          created_at_ms: 1000,
          verified_at_ms: 1000,
        },
      ],
    });

    const store = IdentityStore.open(ctx.dbPath);
    cleanupStores.push(store);

    const raw = new DatabaseSync(ctx.dbPath);
    expect(Number((raw.prepare("PRAGMA user_version;").get() as { user_version: number }).user_version)).toBe(IDENTITY_DB_USER_VERSION);
    raw.close();

    expect(countRows(ctx.dbPath, "users")).toBe(1);
    expect(countRows(ctx.dbPath, "workspaces")).toBe(1);
    expect(countRows(ctx.dbPath, "workspace_memberships")).toBe(1);
    expect(countRows(ctx.dbPath, "api_keys")).toBe(1);
    expect(countRows(ctx.dbPath, "external_identities")).toBe(1);
    expect(countRows(ctx.dbPath, "github_installations")).toBe(1);
    expect(countRows(ctx.dbPath, "github_installation_users")).toBe(1);
    expect(countRows(ctx.dbPath, "github_repository_bindings")).toBe(0);

    const inst = store.findGitHubInstallationById("12345");
    expect(inst).not.toBeNull();
    expect(inst?.account_login).toBe("test-org");
  });

  it("3. v1 fixture migrates through v5", async () => {
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
      PRAGMA user_version = 1;
      INSERT INTO users VALUES ('usr_v1_5', 1000, NULL);
      INSERT INTO workspaces VALUES ('ws_v1_5', 'usr_v1_5', '${ctx.remoteUrl}', '${ctx.branch}', 1000);
      INSERT INTO api_keys VALUES ('ak_v1_5', 'usr_v1_5', '${sha256Hex("key-v1-5")}', 1000, NULL);
    `);
    db.close();

    const store = IdentityStore.open(ctx.dbPath);
    cleanupStores.push(store);

    const raw = new DatabaseSync(ctx.dbPath);
    expect(Number((raw.prepare("PRAGMA user_version;").get() as { user_version: number }).user_version)).toBe(IDENTITY_DB_USER_VERSION);
    raw.close();

    expect(countRows(ctx.dbPath, "workspace_memberships")).toBe(1);
    expect(countRows(ctx.dbPath, "external_identities")).toBe(0);
    expect(countRows(ctx.dbPath, "github_installations")).toBe(0);
    expect(countRows(ctx.dbPath, "github_installation_users")).toBe(0);
    expect(countRows(ctx.dbPath, "github_repository_bindings")).toBe(0);
  });

  it("4. forced v4→v5 failure rolls back to v4 with no partial table", async () => {
    const ctx = await tempCtx();
    fs.mkdirSync(path.dirname(ctx.dbPath), { recursive: true });
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, disabled_at INTEGER);
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL, remote_url TEXT NOT NULL,
        branch TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, key_digest TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE external_identities (
        id TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, provider_subject TEXT NOT NULL,
        user_id TEXT NOT NULL, provider_login TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE workspace_memberships (
        id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE github_installations (
        id TEXT PRIMARY KEY NOT NULL, github_installation_id TEXT NOT NULL UNIQUE, github_app_id TEXT NOT NULL, account_id TEXT NOT NULL, account_login TEXT NOT NULL, account_type TEXT NOT NULL, repository_selection TEXT NOT NULL, suspended_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      PRAGMA user_version = 4;
      INSERT INTO users VALUES ('usr_a', 1000, NULL);
      INSERT INTO workspaces VALUES ('ws_a', 'usr_a', '${ctx.remoteUrl}', '${ctx.branch}', 1000);
    `);
    // Note: missing github_installation_users table!
    raw.close();

    expect(() => IdentityStore.open(ctx.dbPath)).toThrow(/version 4 to 5|missing required v4 table/);
    const after = new DatabaseSync(ctx.dbPath);
    expect(Number((after.prepare("PRAGMA user_version;").get() as { user_version: number }).user_version)).toBe(4);
    const tables = after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='github_repository_bindings';").all();
    expect(tables).toEqual([]);
    after.close();
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

describe("v6 workspace_bootstraps schema & lifecycle state machine (Step 3.6A)", () => {
  it("A. Fresh v6 schema contains workspace_bootstraps", async () => {
    const ctx = await tempCtx();
    const ident = provision(ctx, "key-1");
    expect(countRows(ctx.dbPath, "workspace_bootstraps")).toBe(0);

    const raw = new DatabaseSync(ctx.dbPath);
    const ver = raw.prepare("PRAGMA user_version;").get() as { user_version: number };
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_bootstraps';").all();
    const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_workspace_bootstraps_state';").all();
    raw.close();

    expect(Number(ver.user_version)).toBe(IDENTITY_DB_USER_VERSION);
    expect(Number(ver.user_version)).toBe(6);
    expect(tables.length).toBe(1);
    expect(indexes.length).toBe(1);

    const store = openRaw(ctx);
    expect(store.findWorkspaceBootstrapByWorkspaceId(ident.workspace_id)).toBeNull();
  });

  it("B. v5->v6 preserves all IDs and creates PENDING bootstrap rows exactly for existing repository bindings, not unbound legacy workspaces", async () => {
    const ctx = await tempCtx();
    seedV5Database(ctx.dbPath, {
      remoteUrl: ctx.remoteUrl,
      branch: ctx.branch,
      users: [
        { id: "usr_legacy", created_at: 1000 },
        { id: "usr_bound", created_at: 1100 },
      ],
      workspaces: [
        { id: "ws_legacy", owner_user_id: "usr_legacy", remote_url: ctx.remoteUrl, branch: ctx.branch, created_at: 1000 },
        { id: "ws_bound", owner_user_id: "usr_bound", remote_url: "https://github.com/org/repo.git", branch: "main", created_at: 1100 },
      ],
      workspaceMemberships: [
        { id: "wsm_legacy", workspace_id: "ws_legacy", user_id: "usr_legacy", role: "owner", created_at: 1000 },
        { id: "wsm_bound", workspace_id: "ws_bound", user_id: "usr_bound", role: "owner", created_at: 1100 },
      ],
      apiKeys: [
        { id: "ak_legacy", user_id: "usr_legacy", key_digest: sha256Hex("key-legacy"), created_at: 1000 },
      ],
      externalIdentities: [
        {
          id: "ext_bound",
          provider: "github",
          provider_subject: "55555",
          user_id: "usr_bound",
          provider_login: "devbound",
          created_at_ms: 1100,
          updated_at_ms: 1100,
        },
      ],
      githubInstallations: [
        {
          id: "ghi_bound",
          github_installation_id: "77777",
          github_app_id: "8888",
          account_id: "9999",
          account_login: "test-org",
          account_type: "Organization",
          repository_selection: "selected",
          created_at_ms: 1100,
          updated_at_ms: 1100,
        },
      ],
      githubInstallationUsers: [
        {
          id: "ghiu_bound",
          github_installation_row_id: "ghi_bound",
          user_id: "usr_bound",
          created_at_ms: 1100,
          verified_at_ms: 1100,
        },
      ],
      githubRepositoryBindings: [
        {
          id: "grb_bound",
          workspace_id: "ws_bound",
          github_repository_id: "123456",
          github_installation_row_id: "ghi_bound",
          owner_account_id: "9999",
          owner_login: "test-org",
          repository_name: "repo",
          full_name: "test-org/repo",
          branch: "main",
          created_at_ms: 1150,
          updated_at_ms: 1160,
        },
      ],
    });

    const store = IdentityStore.open(ctx.dbPath);
    cleanupStores.push(store);

    const raw = new DatabaseSync(ctx.dbPath);
    expect(Number((raw.prepare("PRAGMA user_version;").get() as { user_version: number }).user_version)).toBe(6);
    raw.close();

    // Verify all rows preserved
    expect(countRows(ctx.dbPath, "users")).toBe(2);
    expect(countRows(ctx.dbPath, "workspaces")).toBe(2);
    expect(countRows(ctx.dbPath, "workspace_memberships")).toBe(2);
    expect(countRows(ctx.dbPath, "api_keys")).toBe(1);
    expect(countRows(ctx.dbPath, "external_identities")).toBe(1);
    expect(countRows(ctx.dbPath, "github_installations")).toBe(1);
    expect(countRows(ctx.dbPath, "github_installation_users")).toBe(1);
    expect(countRows(ctx.dbPath, "github_repository_bindings")).toBe(1);

    // Exactly one bootstrap row created for the bound workspace, NONE for legacy unbound workspace
    expect(countRows(ctx.dbPath, "workspace_bootstraps")).toBe(1);
    expect(store.findWorkspaceBootstrapByWorkspaceId("ws_legacy")).toBeNull();

    const boot = store.findWorkspaceBootstrapByWorkspaceId("ws_bound");
    expect(boot).not.toBeNull();
    expect(boot).toEqual({
      workspace_id: "ws_bound",
      bootstrap_version: 1,
      state: "PENDING",
      attempt_count: 0,
      last_attempt_id: null,
      last_base_commit_sha: null,
      ready_commit_sha: null,
      last_error_kind: null,
      last_error_code: null,
      last_error_message: null,
      created_at_ms: 1150,
      updated_at_ms: 1160,
      ready_at_ms: null,
    });
  });

  it("C. v1 fixture migrates through v6", async () => {
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
      PRAGMA user_version = 1;
      INSERT INTO users VALUES ('usr_v1_6', 1000, NULL);
      INSERT INTO workspaces VALUES ('ws_v1_6', 'usr_v1_6', '${ctx.remoteUrl}', '${ctx.branch}', 1000);
      INSERT INTO api_keys VALUES ('ak_v1_6', 'usr_v1_6', '${sha256Hex("key-v1-6")}', 1000, NULL);
    `);
    db.close();

    const store = IdentityStore.open(ctx.dbPath);
    cleanupStores.push(store);

    const raw = new DatabaseSync(ctx.dbPath);
    expect(Number((raw.prepare("PRAGMA user_version;").get() as { user_version: number }).user_version)).toBe(6);
    raw.close();

    expect(countRows(ctx.dbPath, "workspace_memberships")).toBe(1);
    expect(countRows(ctx.dbPath, "external_identities")).toBe(0);
    expect(countRows(ctx.dbPath, "github_installations")).toBe(0);
    expect(countRows(ctx.dbPath, "github_installation_users")).toBe(0);
    expect(countRows(ctx.dbPath, "github_repository_bindings")).toBe(0);
    expect(countRows(ctx.dbPath, "workspace_bootstraps")).toBe(0);
  });

  it("D. forced v5->v6 failure rolls back cleanly to v5", async () => {
    const ctx = await tempCtx();
    fs.mkdirSync(path.dirname(ctx.dbPath), { recursive: true });
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, disabled_at INTEGER);
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL, remote_url TEXT NOT NULL,
        branch TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, key_digest TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE external_identities (
        id TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, provider_subject TEXT NOT NULL,
        user_id TEXT NOT NULL, provider_login TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE workspace_memberships (
        id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE github_installations (
        id TEXT PRIMARY KEY NOT NULL, github_installation_id TEXT NOT NULL UNIQUE, github_app_id TEXT NOT NULL, account_id TEXT NOT NULL, account_login TEXT NOT NULL, account_type TEXT NOT NULL, repository_selection TEXT NOT NULL, suspended_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE github_installation_users (
        id TEXT PRIMARY KEY NOT NULL, github_installation_row_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL, verified_at_ms INTEGER NOT NULL
      );
      PRAGMA user_version = 5;
      INSERT INTO users VALUES ('usr_a', 1000, NULL);
      INSERT INTO workspaces VALUES ('ws_a', 'usr_a', '${ctx.remoteUrl}', '${ctx.branch}', 1000);
    `);
    // Missing required v5 table github_repository_bindings!
    raw.close();

    expect(() => IdentityStore.open(ctx.dbPath)).toThrow(/version 5 to 6|missing required v5 table/);
    const after = new DatabaseSync(ctx.dbPath);
    expect(Number((after.prepare("PRAGMA user_version;").get() as { user_version: number }).user_version)).toBe(5);
    const tables = after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_bootstraps';").all();
    expect(tables).toEqual([]);
    after.close();
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


