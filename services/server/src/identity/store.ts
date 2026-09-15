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

/** Authenticated credential identity decoupled from any workspace resolution. */
export interface CredentialIdentity {
  user_id: string;
  api_key_id: string;
}

/** Per-request authentication result. Extends the stable workspace identity. */
export interface AuthIdentity extends WorkspaceIdentity {
  api_key_id: string;
}

/** Explicitly scoped workspace binding matching a configured remote URL and branch. */
export interface ScopedWorkspaceBinding {
  user: { id: string; created_at: number; disabled_at: number | null };
  workspace: { id: string; owner_user_id: string; remote_url: string; branch: string; created_at: number };
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

/**
 * Raised when an external identity binding encounters a conflict (e.g. attempting
 * to bind an external account already associated with another CEO user, or vice versa).
 */
export class IdentityConflictError extends IdentityError {}

export const IDENTITY_DB_USER_VERSION = 2;

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

CREATE INDEX idx_workspaces_owner ON workspaces(owner_user_id);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
CREATE INDEX idx_external_identities_user ON external_identities(user_id);
`;

// Fixed expected tables and their NOT NULL columns (nullable columns excluded).
// Used only for precise structural validation of the four fixed tables.
const EXPECTED_TABLES = ["users", "workspaces", "api_keys", "external_identities"] as const;

const REQUIRED_NOT_NULL: Record<string, string[]> = {
  users: ["id", "created_at"],
  workspaces: ["id", "owner_user_id", "remote_url", "branch", "created_at"],
  api_keys: ["id", "user_id", "key_digest", "created_at"],
  external_identities: ["id", "provider", "provider_subject", "user_id", "created_at_ms", "updated_at_ms"],
};

const REQUIRED_FOREIGN_KEYS: Record<string, { from: string; to: string; referencedTable: string }[]> = {
  workspaces: [{ from: "owner_user_id", to: "id", referencedTable: "users" }],
  api_keys: [{ from: "user_id", to: "id", referencedTable: "users" }],
  external_identities: [{ from: "user_id", to: "id", referencedTable: "users" }],
};

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function newId(prefix: "usr" | "ws" | "ak" | "ext"): string {
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
        return openExistingWorkspaceIdentity(dbPathResolved, input);
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

/** Opens an existing formal database, validates it, and returns its identity for the matching workspace. */
function openExistingWorkspaceIdentity(
  dbPath: string,
  input: { remoteUrl: string; branch: string; apiKeyDigest: string },
): WorkspaceIdentity {
  const store = IdentityStore.open(dbPath);
  try {
    const binding = store.loadScopedWorkspaceBinding(input.remoteUrl, input.branch);
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

      IdentityStore.migrateIfVersion1(db);

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
   * Resolves the transitional runtime workspace corresponding to the given
   * remote_url and branch. Fails clearly if 0 or >1 workspaces match, or if
   * the workspace owner does not exist or is disabled.
   * Extra rows in the database do not affect validation.
   */
  loadScopedWorkspaceBinding(remoteUrl: string, branch: string): ScopedWorkspaceBinding {
    return this.withDb((db) => {
      const workspaces = db.prepare(
        "SELECT id, owner_user_id, remote_url, branch, created_at FROM workspaces WHERE remote_url = ? AND branch = ?;",
      ).all(remoteUrl, branch) as Array<{
        id: string;
        owner_user_id: string;
        remote_url: string;
        branch: string;
        created_at: number;
      }>;

      if (workspaces.length === 0) {
        throw new IdentityStructureError(
          `No workspace found matching remote '${remoteUrl}' and branch '${branch}'.`,
        );
      }
      if (workspaces.length > 1) {
        throw new IdentityStructureError(
          `Ambiguous runtime target: ${workspaces.length} workspaces match remote '${remoteUrl}' and branch '${branch}'.`,
        );
      }

      const workspace = workspaces[0]!;
      const user = db.prepare(
        "SELECT id, created_at, disabled_at FROM users WHERE id = ?;",
      ).get(workspace.owner_user_id) as
        | { id: string; created_at: number; disabled_at: number | null }
        | undefined;

      if (!user) {
        throw new IdentityStructureError(
          `Workspace owner user '${workspace.owner_user_id}' does not exist.`,
        );
      }
      if (user.disabled_at != null) {
        throw new IdentityStructureError(
          `Workspace owner user '${user.id}' is disabled and cannot be used to start or authorize access.`,
        );
      }

      return { user, workspace };
    });
  }

  /** Finds an API key row by its digest regardless of revocation or user. */
  findKeyByDigest(digest: string): {
    id: string;
    user_id: string;
    key_digest: string;
    created_at: number;
    revoked_at: number | null;
  } | null {
    return this.withDb((db) => {
      const row = db.prepare(
        "SELECT id, user_id, key_digest, created_at, revoked_at FROM api_keys WHERE key_digest = ? LIMIT 1;",
      ).get(digest) as
        | { id: string; user_id: string; key_digest: string; created_at: number; revoked_at: number | null }
        | undefined;
      return row ?? null;
    });
  }

  /** Returns all active (unrevoked) API keys owned by a specific user. */
  getActiveKeysForUser(userId: string): Array<{
    id: string;
    user_id: string;
    key_digest: string;
    created_at: number;
    revoked_at: number | null;
  }> {
    return this.withDb((db) => {
      return db.prepare(
        "SELECT id, user_id, key_digest, created_at, revoked_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at ASC, id ASC;",
      ).all(userId) as Array<{
        id: string;
        user_id: string;
        key_digest: string;
        created_at: number;
        revoked_at: number | null;
      }>;
    });
  }

  /**
   * @deprecated Legacy helper for test suites asserting whole-database singleton invariants.
   * Production runtime paths must use loadScopedWorkspaceBinding instead.
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
   * Authenticates a raw bearer token (by digest). Returns the CredentialIdentity,
   * or null when no active key matches or its user is disabled.
   * Does NOT join or guess any workspace.
   */
  authenticateCredentialByDigest(digest: string): CredentialIdentity | null {
    return this.withDb((db) => {
      const row = db.prepare(
        `SELECT k.id AS api_key_id, k.user_id
         FROM api_keys k
         JOIN users u ON u.id = k.user_id
         WHERE k.key_digest = ? AND k.revoked_at IS NULL AND u.disabled_at IS NULL
         LIMIT 1;`,
      ).get(digest) as { api_key_id: string; user_id: string } | undefined;
      if (!row) return null;
      return { user_id: row.user_id, api_key_id: row.api_key_id };
    });
  }

  authenticateByDigest(digest: string): CredentialIdentity | null {
    return this.authenticateCredentialByDigest(digest);
  }

  /**
   * Re-derives credential identity from known api_key_id + user_id.
   * Returns null if the key is revoked or user disabled.
   * Does NOT join or guess any workspace.
   */
  resolveCredentialByKey(api_key_id: string, user_id: string): CredentialIdentity | null {
    return this.withDb((db) => {
      const row = db.prepare(
        `SELECT k.id AS api_key_id, k.user_id
         FROM api_keys k
         JOIN users u ON u.id = k.user_id
         WHERE k.id = ? AND k.user_id = ? AND k.revoked_at IS NULL AND u.disabled_at IS NULL
         LIMIT 1;`,
      ).get(api_key_id, user_id) as { api_key_id: string; user_id: string } | undefined;
      if (!row) return null;
      return { user_id: row.user_id, api_key_id: row.api_key_id };
    });
  }

  resolveAuthIdentityByKey(api_key_id: string, user_id: string): CredentialIdentity | null {
    return this.resolveCredentialByKey(api_key_id, user_id);
  }

  /**
   * Scoped startup key rotation in a single transaction:
   * verifies the target user is enabled, validates the new digest is not revoked or bound to another user,
   * checks that the target user has exactly one active key matching expectedActiveKeyId,
   * then revokes that one expected key and inserts a new active key for the SAME user.
   * All reads and writes occur inside BEGIN IMMEDIATE...COMMIT.
   */
  rotateUserKeyToDigest(userId: string, expectedActiveKeyId: string, newDigest: string): void {
    this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const userRow = db.prepare("SELECT id FROM users WHERE id = ? AND disabled_at IS NULL;").get(userId) as
          | { id: string }
          | undefined;
        if (!userRow) {
          throw new IdentityStructureError(`Identity user '${userId}' is disabled or does not exist; cannot rotate its key.`);
        }

        const activeRows = db
          .prepare("SELECT id, user_id, key_digest FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at ASC, id ASC;")
          .all(userId) as Array<{ id: string; user_id: string; key_digest: string }>;

        if (activeRows.length === 0) {
          throw new IdentityStructureError(
            `User '${userId}' has no active API keys to rotate.`,
          );
        }
        if (activeRows.length > 1) {
          throw new IdentityStructureError(
            `Ambiguous key rotation: user '${userId}' has multiple active keys (${activeRows.length}). Cannot choose which key to rotate.`,
          );
        }

        const current = activeRows[0]!;
        if (current.id !== expectedActiveKeyId || current.user_id !== userId) {
          throw new IdentityStructureError(
            `Expected active key '${expectedActiveKeyId}' for user '${userId}', but found '${current.id}'. Cannot rotate key.`,
          );
        }

        const existingKey = db.prepare(
          "SELECT id, user_id, revoked_at FROM api_keys WHERE key_digest = ?;",
        ).get(newDigest) as { id: string; user_id: string; revoked_at: number | null } | undefined;

        if (existingKey) {
          if (existingKey.revoked_at != null) {
            throw new IdentityStructureError(
              "The configured MCP_API_KEY matches a previously revoked key. A replaced key is created fresh; revoked credentials are not revived.",
            );
          }
          if (existingKey.user_id !== userId) {
            throw new IdentityStructureError(
              `The configured MCP_API_KEY is already bound to another user ('${existingKey.user_id}'). Cannot rebind credentials across users.`,
            );
          }
          if (existingKey.id !== expectedActiveKeyId) {
            throw new IdentityStructureError(
              `The configured MCP_API_KEY is already active for key '${existingKey.id}', but expected '${expectedActiveKeyId}'.`,
            );
          }
          // Already active for this user under the expected key id: nothing to mutate.
          db.exec("COMMIT;");
          return;
        }

        const nowMs = Date.now();
        const updateResult = db.prepare(
          "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL;",
        ).run(nowMs, current.id, userId);
        if (Number(updateResult.changes) !== 1) {
          throw new IdentityStructureError(
            `Failed to revoke active key '${current.id}' for user '${userId}': expected 1 change, got ${updateResult.changes}.`,
          );
        }

        const newKeyId = `ak_${crypto.randomUUID()}`;
        db.prepare(
          "INSERT INTO api_keys (id, user_id, key_digest, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL);",
        ).run(newKeyId, userId, newDigest, nowMs);

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

  static migrateIfVersion1(db: DatabaseSync): void {
    const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number } | undefined;
    const version = Number(versionRow?.user_version ?? 0);
    if (version === 1) {
      db.exec("BEGIN IMMEDIATE;");
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS external_identities (
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
          CREATE INDEX IF NOT EXISTS idx_external_identities_user ON external_identities(user_id);
          PRAGMA user_version = 2;
        `);
        db.exec("COMMIT;");
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        throw new IdentityStructureError(`Failed to migrate identity database from version 1 to 2: ${error}`);
      }
    }
  }

  findExternalIdentity(provider: string, providerSubject: string): {
    id: string;
    provider: string;
    provider_subject: string;
    user_id: string;
    provider_login: string | null;
  } | null {
    return this.withDb((db) => {
      const row = db.prepare(
        "SELECT id, provider, provider_subject, user_id, provider_login FROM external_identities WHERE provider = ? AND provider_subject = ? LIMIT 1;",
      ).get(provider, providerSubject) as
        | { id: string; provider: string; provider_subject: string; user_id: string; provider_login: string | null }
        | undefined;
      return row ?? null;
    });
  }

  findExternalIdentityForUser(provider: string, userId: string): {
    id: string;
    provider: string;
    provider_subject: string;
    user_id: string;
    provider_login: string | null;
  } | null {
    return this.withDb((db) => {
      const row = db.prepare(
        "SELECT id, provider, provider_subject, user_id, provider_login FROM external_identities WHERE provider = ? AND user_id = ? LIMIT 1;",
      ).get(provider, userId) as
        | { id: string; provider: string; provider_subject: string; user_id: string; provider_login: string | null }
        | undefined;
      return row ?? null;
    });
  }

  bindExternalIdentity(record: {
    id: string;
    provider: string;
    providerSubject: string;
    userId: string;
    providerLogin?: string;
  }): void {
    this.withDb((db) => {
      const nowMs = Date.now();
      db.prepare(
        `INSERT INTO external_identities (id, provider, provider_subject, user_id, provider_login, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?);`,
      ).run(
        record.id,
        record.provider,
        record.providerSubject,
        record.userId,
        record.providerLogin ?? null,
        nowMs,
        nowMs,
      );
    });
  }

  isUserActive(userId: string): boolean {
    return this.withDb((db) => {
      const row = db.prepare(
        "SELECT id FROM users WHERE id = ? AND disabled_at IS NULL LIMIT 1;",
      ).get(userId) as { id: string } | undefined;
      return Boolean(row);
    });
  }

  isWorkspaceOwnedByUser(workspaceId: string, userId: string): boolean {
    return this.withDb((db) => {
      const row = db.prepare(
        "SELECT id FROM workspaces WHERE id = ? AND owner_user_id = ? LIMIT 1;",
      ).get(workspaceId, userId) as { id: string } | undefined;
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
