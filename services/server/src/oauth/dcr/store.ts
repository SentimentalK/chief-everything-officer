import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export class DcrError extends Error {}
export class DcrStoreUnavailable extends DcrError {}
export class DcrStoreStructureError extends DcrError {}
export class DcrStoreConflictError extends DcrError {}

export const DCR_DB_USER_VERSION = 1;

export const DCR_DDL = `
CREATE TABLE dynamic_clients (
  client_id TEXT PRIMARY KEY NOT NULL,
  metadata_json TEXT NOT NULL,
  issued_at_s INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);
`;

const REQUIRED_COLUMNS = ["client_id", "metadata_json", "issued_at_s", "created_at_ms"] as const;

export interface DcrClientRecord {
  client_id: string;
  metadata_json: string;
  issued_at_s: number;
  created_at_ms: number;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { errcode?: number }).errcode;
  if (code === 19 || code === 1555) return true;
  return /UNIQUE constraint failed/i.test(error.message);
}

export class DcrStore {
  private readonly dbPath: string;
  private db: DatabaseSync | null;

  constructor(dbPath: string) {
    this.dbPath = path.resolve(dbPath);
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    try {
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec("PRAGMA busy_timeout = 200;");
      try {
        this.db.exec("PRAGMA journal_mode = WAL;");
      } catch {
        /* ignore */
      }
      this.initSchema();
    } catch (error) {
      this.close();
      if (error instanceof DcrError) throw error;
      throw new DcrStoreStructureError(`Failed to open or initialize DCR database: ${error}`);
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = null;
    }
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new DcrStoreUnavailable("DCR database is not open.");
    return this.db;
  }

  private withDb<T>(op: (db: DatabaseSync) => T): T {
    const db = this.requireDb();
    try {
      return op(db);
    } catch (error) {
      if (error instanceof DcrError) throw error;
      throw new DcrStoreUnavailable(`DCR database access failed: ${error}`);
    }
  }

  private initSchema(): void {
    const db = this.requireDb();
    const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number } | undefined;
    const version = Number(versionRow?.user_version ?? 0);

    if (version === 0) {
      db.exec("BEGIN IMMEDIATE;");
      try {
        db.exec(DCR_DDL);
        db.exec(`PRAGMA user_version = ${DCR_DB_USER_VERSION};`);
        db.exec("COMMIT;");
      } catch (err) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        throw err;
      }
      this.assertV1Schema(db);
      return;
    }

    if (version === DCR_DB_USER_VERSION) {
      this.assertV1Schema(db);
      return;
    }

    throw new DcrStoreStructureError(
      `DCR database has unsupported user_version ${version}; expected ${DCR_DB_USER_VERSION}.`,
    );
  }

  private assertV1Schema(db: DatabaseSync): void {
    const columns = db.prepare("PRAGMA table_info(dynamic_clients);").all() as Array<{ name: string }>;
    if (columns.length === 0) {
      throw new DcrStoreStructureError("DCR database is missing required table dynamic_clients.");
    }
    const names = new Set(columns.map((col) => col.name));
    for (const required of REQUIRED_COLUMNS) {
      if (!names.has(required)) {
        throw new DcrStoreStructureError(
          `DCR database dynamic_clients is missing required column ${required}.`,
        );
      }
    }
  }

  insertClient(
    clientId: string,
    metadataJson: string,
    issuedAtS: number,
    createdAtMs: number,
  ): void {
    this.withDb((db) => {
      try {
        db.prepare(
          `INSERT INTO dynamic_clients (client_id, metadata_json, issued_at_s, created_at_ms)
           VALUES (?, ?, ?, ?);`,
        ).run(clientId, metadataJson, issuedAtS, createdAtMs);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new DcrStoreConflictError(`DCR client_id already exists: ${clientId}`);
        }
        throw error;
      }
    });
  }

  getClient(clientId: string): DcrClientRecord | null {
    return this.withDb((db) => {
      const row = db.prepare(
        `SELECT client_id, metadata_json, issued_at_s, created_at_ms
         FROM dynamic_clients WHERE client_id = ? LIMIT 1;`,
      ).get(clientId) as DcrClientRecord | undefined;
      return row ?? null;
    });
  }
}
