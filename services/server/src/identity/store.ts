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

export interface VerifiedBinding {
  user: { id: string; created_at: number; disabled_at: number | null };
  workspace: { id: string; owner_user_id: string; remote_url: string; branch: string; created_at: number };
  activeKey: { id: string; user_id: string; key_digest: string; created_at: number; revoked_at: number | null };
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

// Application data schema. DDL runs inside a single provisioning transaction.
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

// Fixed expected tables and their NOT NULL columns (nullable columns excluded).
// Used only for precise structural validation of the three fixed tables.
const EXPECTED_TABLES = ["users", "workspaces", "api_keys"] as const;

const REQUIRED_NOT_NULL: Record<string, string[]> = {
  users: ["id", "created_at"],
  workspaces: ["id", "owner_user_id", "remote_url", "branch", "created_at"],
  api_keys: ["id", "user_id", "key_digest", "created_at"],
};

const REQUIRED_FOREIGN_KEYS: Record<string, { from: string; to: string; referencedTable: string }[]> = {
  workspaces: [{ from: "owner_user_id", to: "id", referencedTable: "users" }],
  api_keys: [{ from: "user_id", to: "id", referencedTable: "users" }],
};

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function newId(prefix: "usr" | "ws" | "ak"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function unlinkDbFiles(dbPath: string): void {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore missing */
    }
  }
}

/**
 * Creates a brand-new identity database that publishes atomically. The DDL,
 * user_version, and initial data all execute inside ONE transaction on a
 * private temp file in the target directory, then the finished file is
 * published via a non-overwriting hard link. On any failure only the caller's
 * own temp artifacts are removed; an already-existing formal database is never
 * deleted or overwritten.
 *
 * When a competing process already published a formal database, this returns
 * (after validating) that existing database's identity rather than replacing it.
 */
export function provisionEmptyIdentityDatabase(
  dbPath: string,
  input: { remoteUrl: string; branch: string; apiKeyDigest: string },
): WorkspaceIdentity {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const dbPathResolved = path.resolve(dbPath);
  const dirResolved = path.dirname(dbPathResolved);

  // Exclusive temp in the SAME directory so we can hard-link it onto the final
  // name (hard links require a common filesystem). Created 0600 from the start.
  const tmpName = path.join(dirResolved, `.identity-init-${crypto.randomBytes(8).toString("hex")}.sqlite`);
  let fd: number;
  try {
    fd = fs.openSync(tmpName, "wx", 0o600);
  } catch (error) {
    throw new IdentityDbUnavailable(`Unable to create provisioning temp file: ${error}`);
  }
  try {
    fs.closeSync(fd);
  } catch {
    /* still writable below */
  }

  const userId = newId("usr");
  const workspaceId = newId("ws");
  const apiKeyId = newId("ak");

  try {
    const db = new DatabaseSync(tmpName);
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec("PRAGMA journal_mode = DELETE;");
      db.exec("PRAGMA busy_timeout = 100;");

      db.exec("BEGIN IMMEDIATE;");
      try {
        db.exec(IDENTITY_DDL);
        db.exec(`PRAGMA user_version = ${IDENTITY_DB_USER_VERSION};`);
        const nowMs = Date.now();
        db.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES (?, ?, NULL);").run(userId, nowMs);
        db.prepare(
          "INSERT INTO workspaces (id, owner_user_id, remote_url, branch, created_at) VALUES (?, ?, ?, ?, ?);",
        ).run(workspaceId, userId, input.remoteUrl, input.branch, nowMs);
        db.prepare(
          "INSERT INTO api_keys (id, user_id, key_digest, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL);",
        ).run(apiKeyId, userId, input.apiKeyDigest, nowMs);
        db.exec("COMMIT;");
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        throw error;
      }
      db.close();
    } catch (error) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      // Clean only our own temp; never touch an existing formal DB.
      unlinkDbFiles(tmpName);
      throw new IdentityStructureError(
        `Identity database provisioning failed; no database was published: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Publish without clobbering. Hard link fails with EEXIST if the target
    // already exists; we then validate the existing formal DB and return it.
    try {
      fs.linkSync(tmpName, dbPathResolved);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        unlinkDbFiles(tmpName);
        return openExistingWorkspaceIdentity(dbPathResolved);
      }
      unlinkDbFiles(tmpName);
      throw new IdentityStructureError(
        `Identity database could not be published: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Publish succeeded: drop the temp link (final path retains the data).
    unlinkDbFiles(tmpName);
    return { user_id: userId, workspace_id: workspaceId };
  } catch (error) {
    // Single catch-all ensuring no temp file is leaked on unexpected errors.
    unlinkDbFiles(tmpName);
    throw error;
  }
}

/** Opens an existing formal database, validates it, and returns its identity. */
function openExistingWorkspaceIdentity(dbPath: string): WorkspaceIdentity {
  const store = IdentityStore.open(dbPath);
  try {
    const binding = store.loadVerifiedBinding();
    return { user_id: binding.user.id, workspace_id: binding.workspace.id };
  } finally {
    store.close();
  }
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
   * creation is reserved for provisioning/`cli init`. Throws
   * IdentityStructureError if the file is missing, corrupt, or does not match
   * the proven schema contract (PK / NOT NULL / FK / single-column UNIQUE).
   */
  static open(dbPath: string): IdentityStore {
    const resolved = path.resolve(dbPath);
    if (!fs.existsSync(resolved)) {
      throw new IdentityStructureError(
        `Identity database not found at ${resolved}. Run 'node dist/identity/cli.js init' before starting the server.`,
      );
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(resolved);
    } catch (error) {
      throw new IdentityStructureError(`Identity database cannot be opened: ${error}`);
    }
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec("PRAGMA busy_timeout = 100;");
      ensureJournalMode(db);

      const store = new IdentityStore(resolved, db);
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

  /**
   * Returns a validated IdentityStore, or null when the file does not exist
   * (used by the initializer to decide between creating and verifying). Does
   * NOT create the file.
   */
  static openIfMissing(dbPath: string): IdentityStore | null {
    const resolved = path.resolve(dbPath);
    if (!fs.existsSync(resolved)) return null;
    return IdentityStore.open(resolved);
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
    if (!this.db) throw new IdentityDbContextClosed(
      "Identity database is not open.",
    );
    return this.db;
  }

  private withDb<T>(operation: (db: DatabaseSync) => T): T {
    const db = this.requireDb();
    try {
      return operation(db);
    } catch (error) {
      if (
        error instanceof IdentityStructureError ||
        error instanceof IdentityDbUnavailable ||
        error instanceof IdentityDbContextClosed
      ) {
        throw error;
      }
      throw new IdentityDbUnavailable(
        `Identity database access failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private validateStructure(): void {
    const db = this.requireDb();

    // Application schema version.
    const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
    if (Number(versionRow.user_version) !== IDENTITY_DB_USER_VERSION) {
      throw new IdentityStructureError(
        `Identity database has unsupported user_version ${Number(versionRow.user_version)}; expected ${IDENTITY_DB_USER_VERSION}.`,
      );
    }

    // Required tables.
    const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table';").all() as Array<{
      name: string;
    }>;
    const present = new Set(tableRows.map((r) => r.name));
    for (const t of EXPECTED_TABLES) {
      if (!present.has(t)) {
        throw new IdentityStructureError(`Identity database is missing required table '${t}'.`);
      }
    }

    for (const table of EXPECTED_TABLES) {
      const columns = db.prepare(`PRAGMA table_info(${table});`).all() as Array<{
        name: string;
        type: string | null;
        notnull: number;
        pk: number;
      }>;

      // PK must be exactly the `id` column.
      const pkColumns = columns.filter((c) => c.pk > 0).map((c) => c.name);
      if (pkColumns.length !== 1 || pkColumns[0] !== "id") {
        throw new IdentityStructureError(
          `Identity table '${table}' must have exactly one primary key column 'id' (found: ${pkColumns.join(",")})`,
        );
      }

      // NOT NULL on the expected columns only; nullable columns are free.
      const colSet = new Set(columns.map((c) => c.name));
      for (const required of REQUIRED_NOT_NULL[table] ?? []) {
        if (!colSet.has(required)) {
          throw new IdentityStructureError(`Identity table '${table}' is missing column '${required}'.`);
        }
        const info = columns.find((c) => c.name === required);
        if (!info || info.notnull !== 1) {
          throw new IdentityStructureError(`Identity table '${table}' column '${required}' must be NOT NULL.`);
        }
      }
    }

    // Foreign keys.
    for (const table of EXPECTED_TABLES) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${table});`).all() as Array<{
        table: string;
        from: string;
        to: string;
      }>;
      const wanted = REQUIRED_FOREIGN_KEYS[table] ?? [];
      for (const w of wanted) {
        const match = fks.some((f) => f.from === w.from && f.to === w.to && f.table === w.referencedTable);
        if (!match) {
          throw new IdentityStructureError(
            `Identity table '${table}' is missing foreign key ${w.from} -> ${w.referencedTable}(${w.to}).`,
          );
        }
      }
    }

    // Single-column, non-partial UNIQUE index on api_keys.key_digest.
    this.requireUniqueKeyDigestIndex(db);
  }

  private requireUniqueKeyDigestIndex(db: DatabaseSync): void {
    const indexes = db.prepare("PRAGMA index_list(api_keys);").all() as Array<{
      seq: number;
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;
    for (const idx of indexes) {
      if (idx.unique !== 1 || idx.partial !== 0) continue;
      const cols = db.prepare(`PRAGMA index_xinfo(${quoteIdent(idx.name)});`).all() as Array<{
        seqno: number;
        cid: number;
        name: string | null;
      }>;
      const keyed = cols.filter((c) => c.cid >= 0).map((c) => c.name);
      if (keyed.length === 1 && keyed[0] === "key_digest") {
        return; // acceptable single-column unique (e.g. UNIQUE column or explicit index)
      }
    }
    throw new IdentityStructureError(
      "Identity table 'api_keys' must have a UNIQUE index over exactly the single column 'key_digest'.",
    );
  }

  /**
   * The single source of truth for init/startup invariants. Enforces exactly
   * one non-disabled user, one workspace owned by that user, and exactly one
   * active (unrevoked) key bound to that user. Throws IdentityStructureError.
   */
  loadVerifiedBinding(): VerifiedBinding {
    return this.withDb((db) => {
      const users = db.prepare("SELECT id, created_at, disabled_at FROM users;").all() as Array<{
        id: string;
        created_at: number;
        disabled_at: number | null;
      }>;
      const workspaces = db.prepare(
        "SELECT id, owner_user_id, remote_url, branch, created_at FROM workspaces;",
      ).all() as Array<{
        id: string;
        owner_user_id: string;
        remote_url: string;
        branch: string;
        created_at: number;
      }>;
      const keys = db.prepare("SELECT id, user_id, key_digest, created_at, revoked_at FROM api_keys;").all() as Array<{
        id: string;
        user_id: string;
        key_digest: string;
        created_at: number;
        revoked_at: number | null;
      }>;

      if (users.length !== 1) {
        throw new IdentityStructureError(`Identity database must contain exactly one user, found ${users.length}.`);
      }
      const user = users[0]!;
      if (user.disabled_at != null) {
        throw new IdentityStructureError(
          `Identity user '${user.id}' is disabled and cannot be used to start or authorize access.`,
        );
      }
      if (workspaces.length !== 1) {
        throw new IdentityStructureError(
          `Identity database must contain exactly one workspace, found ${workspaces.length}.`,
        );
      }
      const workspace = workspaces[0]!;
      if (workspace.owner_user_id !== user.id) {
        throw new IdentityStructureError(
          `Workspace owner '${workspace.owner_user_id}' does not match the single user '${user.id}'.`,
        );
      }

      const active = keys.filter((k) => k.revoked_at == null);
      if (active.length !== 1) {
        throw new IdentityStructureError(
          `Identity database must contain exactly one active (unrevoked) key, found ${active.length}.`,
        );
      }
      const key = active[0]!;
      if (key.user_id !== user.id) {
        throw new IdentityStructureError("The active API key is not bound to the single enabled user.");
      }

      return { user, workspace, activeKey: key };
    });
  }

  /**
   * Authenticates a raw bearer token (by digest). Returns null when no active
   * key matches or its user is disabled/owner no longer matches. Reads the
   * current workspace ownership from the DB.
   */
  authenticateByDigest(digest: string): AuthIdentity | null {
    return this.queryIdentity(
      `SELECT k.id AS api_key_id, k.user_id, w.id AS workspace_id
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
       JOIN workspaces w ON w.owner_user_id = k.user_id
       WHERE k.key_digest = ? AND k.revoked_at IS NULL AND u.disabled_at IS NULL
       LIMIT 1;`,
      [digest],
    );
  }

  /**
   * Re-derives an identity from a known api_key_id + user_id (used by cookie
   * sessions). Reads the current workspace ownership from the DB. Returns null
   * if the key is revoked, its user disabled, or the owner/current workspace no
   * longer corresponds.
   */
  resolveAuthIdentityByKey(api_key_id: string, user_id: string): AuthIdentity | null {
    return this.queryIdentity(
      `SELECT k.id AS api_key_id, k.user_id, w.id AS workspace_id
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
       JOIN workspaces w ON w.owner_user_id = k.user_id
       WHERE k.id = ? AND k.user_id = ? AND k.revoked_at IS NULL AND u.disabled_at IS NULL
       LIMIT 1;`,
      [api_key_id, user_id],
    );
  }

  private queryIdentity(sql: string, params: string[]): AuthIdentity | null {
    return this.withDb((db) => {
      const row = db.prepare(sql).get(...params) as
        | { api_key_id: string; user_id: string; workspace_id: string }
        | undefined;
      if (!row) return null;
      return { user_id: row.user_id, api_key_id: row.api_key_id, workspace_id: row.workspace_id };
    });
  }

  /**
   * Startup key rotation in a single transaction: resolve the current active
   * key and its owning enabled user, reject re-activating an already-revoked
   * digest, then revoke the active key and insert a new one bound to the SAME
   * user. All reads/writes occur inside one BEGIN IMMEDIATE...COMMIT.
   */
  rotateActiveToDigest(newDigest: string): void {
    this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        // Resolve the single non-disabled user + single active key.
        const userRow = db.prepare("SELECT id FROM users WHERE disabled_at IS NULL;").get() as
          | { id: string }
          | undefined;
        if (!userRow) {
          throw new IdentityStructureError("Identity user is disabled; cannot rotate its key.");
        }
        const activeRows = db
          .prepare("SELECT id, user_id, key_digest FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at ASC, id ASC;")
          .all() as Array<{ id: string; user_id: string; key_digest: string }>;
        if (activeRows.length !== 1) {
          throw new IdentityStructureError(
            `Identity database must contain exactly one active key, found ${activeRows.length}.`,
          );
        }
        const current = activeRows[0]!;
        if (current.user_id !== userRow.id) {
          throw new IdentityStructureError("The active API key is not bound to the single enabled user.");
        }

        // A previously revoked credential must not be revived by re-start.
        const revoked = db
          .prepare("SELECT id FROM api_keys WHERE key_digest = ? AND revoked_at IS NOT NULL;")
          .get(newDigest) as { id: string } | undefined;
        if (revoked) {
          throw new IdentityStructureError(
            "The configured MCP_API_KEY matches a previously revoked key. A replaced key is created fresh; revoked credentials are not revived.",
          );
        }

        const nowMs = Date.now();
        db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL;").run(nowMs, current.id);
        const newId = `ak_${crypto.randomUUID()}`;
        db.prepare(
          "INSERT INTO api_keys (id, user_id, key_digest, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL);",
        ).run(newId, userRow.id, newDigest, nowMs);
        db.exec("COMMIT;");
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        if (error instanceof IdentityStructureError) throw error;
        throw new IdentityDbUnavailable(`Failed to rotate API key: ${error}`);
      }
    });
  }

  /** Whether a digest corresponds to an already-revoked key. */
  isRevokedDigest(digest: string): boolean {
    return this.withDb((db) => {
      const row = db.prepare("SELECT id FROM api_keys WHERE key_digest = ? AND revoked_at IS NOT NULL;").get(digest) as
        | { id: string }
        | undefined;
      return Boolean(row);
    });
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function ensureJournalMode(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA journal_mode = WAL;");
  } catch {
    /* ignore */
  }
}

/**
 * Internal marker for an already-closed store used to keep 503 semantics
 * (runtime availability) distinct from startup structural errors.
 */
export class IdentityDbContextClosed extends IdentityError {}
