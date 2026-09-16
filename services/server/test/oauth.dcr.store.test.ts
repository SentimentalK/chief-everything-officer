import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  DcrStore,
  DcrStoreConflictError,
  DcrStoreStructureError,
  DCR_DB_USER_VERSION,
} from "../src/oauth/dcr/store.js";

const cleanupDirs: string[] = [];
const cleanupStores: DcrStore[] = [];

afterEach(async () => {
  for (const st of cleanupStores.splice(0)) st.close();
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-dcr-store-test-"));
  cleanupDirs.push(dir);
  return path.join(dir, "oauth-dcr.sqlite");
}

describe("DcrStore", () => {
  it("initializes a fresh database at schema v1", async () => {
    const dbPath = await createDbPath();
    const store = new DcrStore(dbPath);
    cleanupStores.push(store);
    store.close();

    const db = new DatabaseSync(dbPath);
    try {
      const version = (db.prepare("PRAGMA user_version;").get() as { user_version: number }).user_version;
      expect(version).toBe(DCR_DB_USER_VERSION);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dynamic_clients';",
      ).all();
      expect(tables).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("reopens an existing v1 database", async () => {
    const dbPath = await createDbPath();
    const first = new DcrStore(dbPath);
    cleanupStores.push(first);
    first.insertClient("dcr_one", "{}", 1, 1);
    first.close();

    const second = new DcrStore(dbPath);
    cleanupStores.push(second);
    expect(second.getClient("dcr_one")?.metadata_json).toBe("{}");
  });

  it("inserts and retrieves clients; unknown client returns null", async () => {
    const dbPath = await createDbPath();
    const store = new DcrStore(dbPath);
    cleanupStores.push(store);
    store.insertClient("dcr_abc", '{"client_name":"X"}', 10, 1000);
    const row = store.getClient("dcr_abc");
    expect(row).toEqual({
      client_id: "dcr_abc",
      metadata_json: '{"client_name":"X"}',
      issued_at_s: 10,
      created_at_ms: 1000,
    });
    expect(store.getClient("dcr_missing")).toBeNull();
  });

  it("rejects duplicate client IDs", async () => {
    const dbPath = await createDbPath();
    const store = new DcrStore(dbPath);
    cleanupStores.push(store);
    store.insertClient("dcr_dup", "{}", 1, 1);
    expect(() => store.insertClient("dcr_dup", "{}", 2, 2)).toThrow(DcrStoreConflictError);
  });

  it("fails closed on unsupported schema version", async () => {
    const dbPath = await createDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 99;");
    db.close();
    expect(() => new DcrStore(dbPath)).toThrow(DcrStoreStructureError);
  });

  it("fails closed when v1 is missing required table", async () => {
    const dbPath = await createDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 1;");
    db.close();
    expect(() => new DcrStore(dbPath)).toThrow(/missing required table/);
  });
});
