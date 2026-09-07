import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Stable identity bound to a deployment workspace. Fixed at startup and made
 * available to MCP tools (e.g. `workspace_status`). It deliberately omits
 * `api_key_id`, which is a per-request authentication outcome.
 */
export interface WorkspaceIdentity {
  user_id: string;
  workspace_id: string;
}

/** Per-request authentication result. Extends the stable workspace identity. */
export interface AuthIdentity extends WorkspaceIdentity {
  api_key_id: string;
}

export interface IdentitySnapshot {
  user: { id: string; created_at: number; disabled_at: number | null };
  workspace: { id: string; owner_user_id: string; remote_url: string; branch: string; created_at: number };
  activeKey: {
    id: string;
    user_id: string;
    key_digest: string;
    created_at: number;
    revoked_at: number | null;
  } | null;
}

export class IdentityError extends Error {}

/**
 * Raised when the identity database is structurally missing/invalid or the
 * deployment binding is inconsistent. These are startup failures that must
 * abort boot, never silently recover.
 */
export class IdentityStructureError extends IdentityError {}

/**
 * Raised when a runtime database access fails (e.g. backing file removed while
 * running). Callers must not fall through to an unauthenticated path; HTTP
 * maps this to 503.
 */
export class IdentityDbUnavailable extends IdentityError {}

export const IDENTITY_DB_USER_VERSION = 1;

// Application data schema. Table ordering respects foreign key dependencies
// (users -> workspaces.owner, users -> api_keys.user).
export const IDENTITY_DDL = `
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL,
  remote_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  key_digest TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_workspaces_owner ON workspaces(owner_user_id);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
`;

function expectedTableNames(): string[] {
  return ["users", "workspaces", "api_keys"];
}

const EXPECTED_COLUMNS: Record<string, string[]> = {
  users: ["id", "created_at", "disabled_at"],
  workspaces: ["id", "owner_user_id", "remote_url", "branch", "created_at"],
  api_keys: ["id", "user_id", "key_digest", "created_at", "revoked_at"],
};

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function newId(prefix: "usr" | "ws" | "ak"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Creates a brand-new identity database and provisions exactly one user, one
 * workspace, and one active key in a single transaction. Only used for first
 * initialization. Returns the seeded stable WorkspaceIdentity.
 */
export function provisionEmptyIdentityDatabase(
  dbPath: string,
  input: { remoteUrl: string; branch: string; apiKeyDigest: string },
): WorkspaceIdentity {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  const nowMs = Date.now();
  const userId = newId("usr");
  const workspaceId = newId("ws");
  const apiKeyId = newId("ak");
  try {
    db.exec("BEGIN IMMEDIATE;");
    db.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES (?, ?, NULL);").run(userId, nowMs);
    db.prepare(
      "INSERT INTO workspaces (id, owner_user_id, remote_url, branch, created_at) VALUES (?, ?, ?, ?, ?);",
    ).run(workspaceId, userId, input.remoteUrl, input.branch, nowMs);
    db.prepare(
      "INSERT INTO api_keys (id, user_id, key_digest, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL);",
    ).run(apiKeyId, userId, input.apiKeyDigest, nowMs);
    db.exec("COMMIT;");
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(dbPath, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(`${dbPath}-wal`, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(`${dbPath}-shm`, { force: true }); } catch { /* ignore */ }
    throw new IdentityStructureError(
      `Identity database provisioning failed; no records were persisted: ${error}`,
    );
  }
  try {
    db.close();
  } catch { /* ignore */ }
  try { fs.chmodSync(dbPath, 0o600); } catch { /* ignore */ }
  return { user_id: userId, workspace_id: workspaceId };
}


/** Applies schema + app-version pragmas to a freshly created database handle. */
export function applySchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 100;");
  db.exec(`PRAGMA user_version = ${IDENTITY_DB_USER_VERSION};`);
  db.exec(IDENTITY_DDL);
}

export class IdentityStore {
  private readonly dbPath: string;
  private db: DatabaseSync | null;

  private constructor(dbPath: string, db: DatabaseSync) {
    this.dbPath = dbPath;
    this.db = db;
  }

  /**
   * Opens an existing, valid identity database. Does NOT create the file;
   * creation is reserved for `cli init`. Throws IdentityStructureError if the
   * file is missing, corrupt, or the schema/invariants do not match.
   */
  static open(dbPath: string): IdentityStore {
    if (!fs.existsSync(dbPath)) {
      throw new IdentityStructureError(
        `Identity database not found at ${dbPath}. Run 'node dist/identity/cli.js init' before starting the server.`,
      );
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(dbPath);
    } catch (error) {
      throw new IdentityStructureError(`Identity database cannot be opened: ${error}`);
    }
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec("PRAGMA busy_timeout = 100;");
      ensureJournalMode(db);

      const store = new IdentityStore(dbPath, db);
      store.validateStructure();
      return store;
    } catch (error) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      if (error instanceof IdentityStructureError) throw error;
      throw new IdentityStructureError(`Identity database failed structural validation: ${error}`);
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

  get path(): string {
    return this.dbPath;
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new IdentityDbUnavailable("Identity database is not open.");
    return this.db;
  }

  private withDb<T>(operation: (db: DatabaseSync) => T): T {
    const db = this.requireDb();
    try {
      return operation(db);
    } catch (error) {
      if (error instanceof IdentityStructureError || error instanceof IdentityDbUnavailable) {
        throw error;
      }
      // Anything else reaching a query is a runtime availability fault.
      throw new IdentityDbUnavailable(
        `Identity database access failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private validateStructure(): void {
    const db = this.requireDb();

    // Application schema version.
    const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
    const userVersion = Number(versionRow.user_version);
    if (userVersion !== IDENTITY_DB_USER_VERSION) {
      throw new IdentityStructureError(
        `Identity database has unsupported user_version ${userVersion}; expected ${IDENTITY_DB_USER_VERSION}.`,
      );
    }

    // Required tables.
    const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table';").all() as Array<{ name: string }>;
    const present = new Set(tableRows.map((r) => r.name));
    for (const t of expectedTableNames()) {
      if (!present.has(t)) {
        throw new IdentityStructureError(`Identity database is missing required table '${t}'.`);
      }
    }

    // Required columns.
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      const cols = db.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      for (const c of columns) {
        if (!names.has(c)) {
          throw new IdentityStructureError(`Identity database table '${table}' is missing column '${c}'.`);
        }
      }
    }
  }

  /** Enforces exactly one user with a disabled_at (or null). */
  private assertSingleUserState(db: DatabaseSync): void {
    const rows = db.prepare("SELECT id, disabled_at FROM users;").all() as Array<{
      id: string;
      disabled_at: number | null;
    }>;
    if (rows.length !== 1) {
      throw new IdentityStructureError(
        `Identity database must contain exactly one user, found ${rows.length}.`,
      );
    }
    const u = rows[0];
    if (!u) {
      throw new IdentityStructureError("Identity user record is missing.");
    }
    if (u.disabled_at != null) {
      throw new IdentityStructureError(
        `Identity user '${u.id}' is disabled and cannot be used to start or authorize access.`,
      );
    }
  }

  private assertSingleWorkspaceState(db: DatabaseSync): void {
    const rows = db.prepare("SELECT id, owner_user_id, remote_url, branch FROM workspaces;").all() as Array<{
      id: string;
      owner_user_id: string;
      remote_url: string;
      branch: string;
    }>;
    if (rows.length !== 1) {
      throw new IdentityStructureError(
        `Identity database must contain exactly one workspace, found ${rows.length}.`,
      );
    }
    const w = rows[0];
    if (!w) {
      throw new IdentityStructureError("Identity workspace record is missing.");
    }
    const user = db.prepare("SELECT id FROM users;").get() as { id: string } | undefined;
    if (w.owner_user_id !== user?.id) {
      throw new IdentityStructureError(
        `Workspace owner '${w.owner_user_id}' does not match the single user '${user?.id}'.`,
      );
    }
  }

  private assertSingleActiveKeyState(db: DatabaseSync): void {
    const rows = db
      .prepare("SELECT id FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at ASC, id ASC;")
      .all() as Array<{ id: string }>;
    if (rows.length !== 1) {
      throw new IdentityStructureError(
        `Identity database must contain exactly one active (unrevoked) key, found ${rows.length}.`,
      );
    }
    const user = db.prepare("SELECT id FROM users;").get() as { id: string } | undefined;
    const keyId = rows[0]?.id;
    if (!keyId) {
      throw new IdentityStructureError("Active API key row is missing.");
    }
    const row = db.prepare("SELECT user_id FROM api_keys WHERE id = ?;").get(keyId) as
      | { user_id: string }
      | undefined;
    if (row?.user_id !== user?.id) {
      throw new IdentityStructureError(`Active API key is not bound to the single user.`);
    }
  }

  /**
   * Structural + single-user invariant validation performed at startup. Does
   * NOT compare remote/branch or the env key, which is the service's job.
   */
  validateRuntimeShape(): void {
    this.withDb((db) => {
      this.assertSingleUserState(db);
      this.assertSingleWorkspaceState(db);
      this.assertSingleActiveKeyState(db);
    });
  }

  /** Resolves the stable WorkspaceIdentity (user + workspace) for the deployment. */
  workspaceIdentity(): WorkspaceIdentity {
    return this.withDb((db) => {
      const user = db.prepare("SELECT id FROM users;").get() as { id: string } | undefined;
      const ws = db.prepare("SELECT id FROM workspaces;").get() as { id: string } | undefined;
      if (!user || !ws) {
        throw new IdentityStructureError("Identity database is missing the single user or workspace record.");
      }
      return { user_id: user.id, workspace_id: ws.id };
    });
  }

  workspaceBinding(): { remote_url: string; branch: string; owner_user_id: string } {
    return this.withDb((db) => {
      const ws = db.prepare("SELECT owner_user_id, remote_url, branch FROM workspaces;").get() as
        | { owner_user_id: string; remote_url: string; branch: string }
        | undefined;
      if (!ws) {
        throw new IdentityStructureError("Identity database is missing the single workspace record.");
      }
      return ws;
    });
  }

  /**
   * The single active key row. Throws if the invariant (exactly one active key
   * bound to the single non-disabled user) is violated.
   */
  activeKeyRow(): { id: string; user_id: string; key_digest: string } {
    return this.withDb((db) => {
      const user = db.prepare("SELECT id FROM users WHERE disabled_at IS NULL;").get() as
        | { id: string }
        | undefined;
      if (!user) {
        throw new IdentityStructureError("Identity user is disabled.");
      }
      const rows = db
        .prepare("SELECT id, user_id, key_digest FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at ASC, id ASC;")
        .all() as Array<{ id: string; user_id: string; key_digest: string }>;
      if (rows.length !== 1) {
        throw new IdentityStructureError(
          `Identity database must contain exactly one active key, found ${rows.length}.`,
        );
      }
      const current = rows[0];
      if (!current) {
        throw new IdentityStructureError("Active API key row is missing.");
      }
      if (current.user_id !== user.id) {
        throw new IdentityStructureError("The active API key is not bound to the single enabled user.");
      }
      return current;
    });
  }

  /**
   * Authenticates a raw bearer token by its digest. Returns null if no active
   * key matches or the owning user is disabled. Binds to the workspace owner.
   */
  authenticateByDigest(digest: string): AuthIdentity | null {
    return this.withDb((db) => {
      const row = db
        .prepare(
          `SELECT k.id AS api_key_id, k.user_id,
                  w.id AS workspace_id
           FROM api_keys k
           JOIN users u ON u.id = k.user_id
           JOIN workspaces w ON w.owner_user_id = k.user_id
           WHERE k.key_digest = ? AND k.revoked_at IS NULL AND u.disabled_at IS NULL
           LIMIT 1;`,
        )
        .get(digest) as { api_key_id: string; user_id: string; workspace_id: string } | undefined;
      if (!row) return null;
      return {
        user_id: row.user_id,
        api_key_id: row.api_key_id,
        workspace_id: row.workspace_id,
      };
    });
  }

  /**
   * Re-validates an already-authenticated identity: the api_key must be active
   * (not revoked) and its user must be enabled.
   */
  revalidateKey(api_key_id: string, user_id: string): boolean {
    return this.withDb((db) => {
      const row = db
        .prepare(
          `SELECT k.id
           FROM api_keys k
           JOIN users u ON u.id = k.user_id
           WHERE k.id = ? AND k.user_id = ? AND k.revoked_at IS NULL AND u.disabled_at IS NULL;`,
        )
        .get(api_key_id, user_id) as { id: string } | undefined;
      return Boolean(row);
    });
  }

  /** Whether the given digest corresponds to an already-revoked key. */
  isRevokedDigest(digest: string): boolean {
    return this.withDb((db) => {
      const row = db.prepare("SELECT id FROM api_keys WHERE key_digest = ? AND revoked_at IS NOT NULL;").get(digest) as
        | { id: string }
        | undefined;
      return Boolean(row);
    });
  }

  /**
   * Replaces the single active key with a new digest bound to the same user in
   * one transaction. Old active key is revoked. Caller is responsible for the
   * invariants (user enabled, new digest not already present/revoked).
   */
  rotateToDigest(newDigest: string): string {
    return this.withDb((db) => {
      const current = this.activeKeyRow();
      const nowMs = Date.now();
      db.exec("BEGIN IMMEDIATE;");
      try {
        // Revoke the single current active key, then insert the replacement.
        db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL;").run(nowMs, current.id);
        const newId = `ak_${crypto.randomUUID()}`;
        db.prepare(
          "INSERT INTO api_keys (id, user_id, key_digest, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL);",
        ).run(newId, current.user_id, newDigest, nowMs);
        db.exec("COMMIT;");
        return newId;
      } catch (error) {
        db.exec("ROLLBACK;");
        if (error instanceof IdentityStructureError) throw error;
        throw new IdentityDbUnavailable(`Failed to rotate API key: ${error}`);
      }
    });
  }

  /** Full snapshot support for the CLI and validation utilities. */
  snapshot(): IdentitySnapshot {
    return this.withDb((db) => {
      const user = db.prepare("SELECT id, created_at, disabled_at FROM users;").get() as
        | { id: string; created_at: number; disabled_at: number | null }
        | undefined;
      const ws = db.prepare(
        "SELECT id, owner_user_id, remote_url, branch, created_at FROM workspaces;",
      ).get() as
        | { id: string; owner_user_id: string; remote_url: string; branch: string; created_at: number }
        | undefined;
      const keys = db.prepare("SELECT id, user_id, key_digest, created_at, revoked_at FROM api_keys;").all() as Array<{
        id: string;
        user_id: string;
        key_digest: string;
        created_at: number;
        revoked_at: number | null;
      }>;
      const active = keys.find((k) => k.revoked_at == null) ?? null;
      if (!user || !ws) {
        throw new IdentityStructureError("Identity database is missing the single user or workspace record.");
      }
      return {
        user: { id: user.id, created_at: user.created_at, disabled_at: user.disabled_at },
        workspace: {
          id: ws.id,
          owner_user_id: ws.owner_user_id,
          remote_url: ws.remote_url,
          branch: ws.branch,
          created_at: ws.created_at,
        },
        activeKey: active ? { ...active } : null,
      };
    });
  }
}

function ensureJournalMode(db: DatabaseSync): void {
  // WAL is optional for runtime identity reads; if it can't be set we keep going
  // only as long as reads still work. Do not fail structural boot over journal mode.
  try {
    db.exec("PRAGMA journal_mode = WAL;");
  } catch {
    /* ignore */
  }
}
