import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  IdentityStore,
  IDENTITY_DDL,
  IDENTITY_DB_USER_VERSION,
  IdentityStructureError,
  provisionEmptyControlPlaneDatabase,
} from "../src/identity/store.js";

const cleanupDirs: string[] = [];
const cleanupStores: IdentityStore[] = [];

afterEach(async () => {
  for (const s of cleanupStores.splice(0)) s.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDbPath(): Promise<{ dir: string; dbPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-v12-structure-test-"));
  cleanupDirs.push(dir);
  return { dir, dbPath: path.join(dir, "identity.sqlite") };
}

describe("Identity DB v12 Structural Validation", () => {
  it("fails closed when devices table is missing", async () => {
    const { dbPath } = await tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec(IDENTITY_DDL);
    db.exec("DROP TABLE devices;");
    db.exec(`PRAGMA user_version = ${IDENTITY_DB_USER_VERSION};`);
    db.close();

    expect(() => IdentityStore.open(dbPath)).toThrow(/missing required table 'devices'/);
  });

  it("fails closed when device_credentials is missing secret_digest unique index", async () => {
    const { dbPath } = await tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec(IDENTITY_DDL);
    db.exec("DROP TABLE device_credentials;");
    db.exec(`
      CREATE TABLE device_credentials (
        id TEXT PRIMARY KEY NOT NULL,
        device_id TEXT NOT NULL,
        secret_digest TEXT NOT NULL,
        issued_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER,
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
      );
    `);
    db.exec(`PRAGMA user_version = ${IDENTITY_DB_USER_VERSION};`);
    db.close();

    expect(() => IdentityStore.open(dbPath)).toThrow(/must have a UNIQUE index over exactly the columns \(secret_digest\)/);
  });

  it("fails closed when execution_targets is missing (workspace_id, alias) unique index", async () => {
    const { dbPath } = await tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec(IDENTITY_DDL);
    db.exec("DROP TABLE execution_targets;");
    db.exec(`
      CREATE TABLE execution_targets (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        repository_provider TEXT,
        repository_external_id TEXT,
        repository_full_name TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        disabled_at_ms INTEGER,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CHECK (
          (repository_provider IS NULL AND repository_external_id IS NULL AND repository_full_name IS NULL)
          OR
          (repository_provider IS NOT NULL AND repository_external_id IS NOT NULL AND repository_full_name IS NOT NULL)
        )
      );
    `);
    db.exec(`PRAGMA user_version = ${IDENTITY_DB_USER_VERSION};`);
    db.close();

    expect(() => IdentityStore.open(dbPath)).toThrow(/must have a UNIQUE index over exactly the columns \(workspace_id, alias\)/);
  });

  it("fails closed when device_target_bindings is missing (device_id, target_id) unique index", async () => {
    const { dbPath } = await tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec(IDENTITY_DDL);
    db.exec("DROP TABLE device_target_bindings;");
    db.exec(`
      CREATE TABLE device_target_bindings (
        id TEXT PRIMARY KEY NOT NULL,
        device_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        disabled_at_ms INTEGER,
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES execution_targets(id) ON DELETE CASCADE
      );
    `);
    db.exec(`PRAGMA user_version = ${IDENTITY_DB_USER_VERSION};`);
    db.close();

    expect(() => IdentityStore.open(dbPath)).toThrow(/must have a UNIQUE index over exactly the columns \(device_id, target_id\)/);
  });

  it("fails closed when execution_targets is missing the repository triple CHECK constraint", async () => {
    const { dbPath } = await tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec(IDENTITY_DDL);
    db.exec("DROP TABLE execution_targets;");
    db.exec(`
      CREATE TABLE execution_targets (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        repository_provider TEXT,
        repository_external_id TEXT,
        repository_full_name TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        disabled_at_ms INTEGER,
        UNIQUE(workspace_id, alias),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
    `);
    db.exec(`PRAGMA user_version = ${IDENTITY_DB_USER_VERSION};`);
    db.close();

    expect(() => IdentityStore.open(dbPath)).toThrow(/missing required repository CHECK constraint/);
  });

  it("fails closed when a required NOT NULL column is missing in devices", async () => {
    const { dbPath } = await tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec(IDENTITY_DDL);
    db.exec("DROP TABLE devices;");
    db.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        platform TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    db.exec(`PRAGMA user_version = ${IDENTITY_DB_USER_VERSION};`);
    db.close();

    expect(() => IdentityStore.open(dbPath)).toThrow(/column 'platform' must be NOT NULL/);
  });
});
