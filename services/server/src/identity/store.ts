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

export const IDENTITY_DB_USER_VERSION = 5;

export type GitHubAccountType = "User" | "Organization";
export type GitHubRepositorySelection = "all" | "selected";

export interface GitHubInstallationRecord {
  id: string;
  github_installation_id: string;
  github_app_id: string;
  account_id: string;
  account_login: string;
  account_type: GitHubAccountType;
  repository_selection: GitHubRepositorySelection;
  suspended_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface GitHubInstallationUserRecord {
  id: string;
  github_installation_row_id: string;
  user_id: string;
  created_at_ms: number;
  verified_at_ms: number;
}

export interface GitHubRepositoryBindingRecord {
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
}

export interface CreateWorkspaceWithRepositoryBindingInput {
  userId: string;
  installationRowId: string;
  githubRepositoryId: string;
  ownerAccountId: string;
  ownerLogin: string;
  repositoryName: string;
  fullName: string;
  branch: string;
}

export interface UserGitHubInstallationItem {
  id: string;
  github_installation_id: string;
  github_app_id: string;
  account_id: string;
  account_login: string;
  account_type: GitHubAccountType;
  repository_selection: GitHubRepositorySelection;
  suspended_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  verified_at_ms: number;
}

export interface UpsertGitHubInstallationInput {
  githubInstallationId: string;
  githubAppId: string;
  accountId: string;
  accountLogin: string;
  accountType: GitHubAccountType;
  repositorySelection: GitHubRepositorySelection;
  suspendedAtMs?: number | null;
  userId: string;
}

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
`;

// Fixed expected tables and their NOT NULL columns (nullable columns excluded).
const EXPECTED_TABLES = [
  "users",
  "workspaces",
  "api_keys",
  "external_identities",
  "workspace_memberships",
  "github_installations",
  "github_installation_users",
  "github_repository_bindings",
] as const;

const REQUIRED_NOT_NULL: Record<string, string[]> = {
  users: ["id", "created_at"],
  workspaces: ["id", "owner_user_id", "remote_url", "branch", "created_at"],
  api_keys: ["id", "user_id", "key_digest", "created_at"],
  external_identities: ["id", "provider", "provider_subject", "user_id", "created_at_ms", "updated_at_ms"],
  workspace_memberships: ["id", "workspace_id", "user_id", "role", "created_at"],
  github_installations: [
    "id",
    "github_installation_id",
    "github_app_id",
    "account_id",
    "account_login",
    "account_type",
    "repository_selection",
    "created_at_ms",
    "updated_at_ms",
  ],
  github_installation_users: [
    "id",
    "github_installation_row_id",
    "user_id",
    "created_at_ms",
    "verified_at_ms",
  ],
  github_repository_bindings: [
    "id",
    "workspace_id",
    "github_repository_id",
    "github_installation_row_id",
    "owner_account_id",
    "owner_login",
    "repository_name",
    "full_name",
    "branch",
    "created_at_ms",
    "updated_at_ms",
  ],
};

const REQUIRED_FOREIGN_KEYS: Record<string, { from: string; to: string; referencedTable: string }[]> = {
  workspaces: [{ from: "owner_user_id", to: "id", referencedTable: "users" }],
  api_keys: [{ from: "user_id", to: "id", referencedTable: "users" }],
  external_identities: [{ from: "user_id", to: "id", referencedTable: "users" }],
  workspace_memberships: [
    { from: "workspace_id", to: "id", referencedTable: "workspaces" },
    { from: "user_id", to: "id", referencedTable: "users" },
  ],
  github_installation_users: [
    { from: "github_installation_row_id", to: "id", referencedTable: "github_installations" },
    { from: "user_id", to: "id", referencedTable: "users" },
  ],
  github_repository_bindings: [
    { from: "workspace_id", to: "id", referencedTable: "workspaces" },
    { from: "github_installation_row_id", to: "id", referencedTable: "github_installations" },
  ],
};

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function newId(prefix: "usr" | "ws" | "ak" | "ext" | "wsm" | "ghi" | "ghiu" | "grb"): string {
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
  const membershipId = newId("wsm");
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
          "INSERT INTO workspace_memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?);",
        ).run(membershipId, workspaceId, userId, nowMs);
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

      IdentityStore.migrateToCurrent(db);

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
      if (error instanceof IdentityError) {
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

    this.requireUniqueIndex(db, "api_keys", ["key_digest"]);
    this.requireUniqueIndex(db, "external_identities", ["provider", "provider_subject"]);
    this.requireUniqueIndex(db, "external_identities", ["provider", "user_id"]);
    this.requireUniqueIndex(db, "workspace_memberships", ["workspace_id", "user_id"]);
    this.requirePartialUniqueIndex(db, "workspace_memberships", ["workspace_id"], "role = 'owner'");
    this.requireUniqueIndex(db, "github_installations", ["github_installation_id"]);
    this.requireUniqueIndex(db, "github_installation_users", ["github_installation_row_id", "user_id"]);
    this.requireUniqueIndex(db, "github_repository_bindings", ["workspace_id"]);
    this.requireUniqueIndex(db, "github_repository_bindings", ["github_repository_id"]);

    this.validateData();
  }

  private validateData(): void {
    const db = this.requireDb();

    const badRole = db.prepare(
      "SELECT id FROM workspace_memberships WHERE role != 'owner' LIMIT 1;",
    ).get() as { id: string } | undefined;
    if (badRole) {
      throw new IdentityStructureError(
        `Identity database contains workspace membership '${badRole.id}' with unsupported role (only 'owner' is allowed).`,
      );
    }

    const workspaces = db.prepare("SELECT id, owner_user_id FROM workspaces;").all() as Array<{
      id: string;
      owner_user_id: string;
    }>;
    for (const workspace of workspaces) {
      const owners = db.prepare(
        "SELECT id, user_id FROM workspace_memberships WHERE workspace_id = ? AND role = 'owner';",
      ).all(workspace.id) as Array<{ id: string; user_id: string }>;
      if (owners.length !== 1) {
        throw new IdentityStructureError(
          `Workspace '${workspace.id}' must have exactly one owner membership, found ${owners.length}.`,
        );
      }
      const owner = owners[0]!;
      if (owner.user_id !== workspace.owner_user_id) {
        throw new IdentityStructureError(
          `Workspace '${workspace.id}' owner membership user '${owner.user_id}' does not match shadow owner '${workspace.owner_user_id}'.`,
        );
      }
    }

    const numericIdRegex = /^[1-9][0-9]*$/;
    const installations = db.prepare(
      "SELECT id, github_installation_id, github_app_id, account_id, account_login, account_type, repository_selection, suspended_at_ms, created_at_ms, updated_at_ms FROM github_installations;",
    ).all() as Array<{
      id: string;
      github_installation_id: string;
      github_app_id: string;
      account_id: string;
      account_login: string;
      account_type: string;
      repository_selection: string;
      suspended_at_ms: number | null;
      created_at_ms: number;
      updated_at_ms: number;
    }>;

    for (const inst of installations) {
      if (typeof inst.id !== "string" || !inst.id.startsWith("ghi_")) {
        throw new IdentityStructureError(`Invalid github_installations id '${inst.id}'.`);
      }
      if (typeof inst.github_installation_id !== "string" || !numericIdRegex.test(inst.github_installation_id)) {
        throw new IdentityStructureError(
          `github_installation_id '${inst.github_installation_id}' must be a positive decimal string.`,
        );
      }
      if (typeof inst.github_app_id !== "string" || !numericIdRegex.test(inst.github_app_id)) {
        throw new IdentityStructureError(
          `github_app_id '${inst.github_app_id}' must be a positive decimal string.`,
        );
      }
      if (typeof inst.account_id !== "string" || !numericIdRegex.test(inst.account_id)) {
        throw new IdentityStructureError(
          `account_id '${inst.account_id}' must be a positive decimal string.`,
        );
      }
      if (typeof inst.account_login !== "string" || inst.account_login.trim().length === 0) {
        throw new IdentityStructureError(
          `account_login '${inst.account_login}' must be a non-empty string.`,
        );
      }
      if (inst.account_type !== "User" && inst.account_type !== "Organization") {
        throw new IdentityStructureError(
          `Invalid account_type '${inst.account_type}'; must be 'User' or 'Organization'.`,
        );
      }
      if (inst.repository_selection !== "all" && inst.repository_selection !== "selected") {
        throw new IdentityStructureError(
          `Invalid repository_selection '${inst.repository_selection}'; must be 'all' or 'selected'.`,
        );
      }
      if (inst.suspended_at_ms !== null && inst.suspended_at_ms !== undefined) {
        if (!Number.isInteger(inst.suspended_at_ms) || inst.suspended_at_ms <= 0) {
          throw new IdentityStructureError(
            `Invalid suspended_at_ms '${inst.suspended_at_ms}'; must be a positive integer when present.`,
          );
        }
      }
      if (!Number.isInteger(inst.created_at_ms) || inst.created_at_ms < 0) {
        throw new IdentityStructureError(`Invalid created_at_ms in github_installations row '${inst.id}'.`);
      }
      if (!Number.isInteger(inst.updated_at_ms) || inst.updated_at_ms < 0) {
        throw new IdentityStructureError(`Invalid updated_at_ms in github_installations row '${inst.id}'.`);
      }
    }

    const installationUsers = db.prepare(
      "SELECT id, github_installation_row_id, user_id, created_at_ms, verified_at_ms FROM github_installation_users;",
    ).all() as Array<{
      id: string;
      github_installation_row_id: string;
      user_id: string;
      created_at_ms: number;
      verified_at_ms: number;
    }>;

    for (const link of installationUsers) {
      if (typeof link.id !== "string" || !link.id.startsWith("ghiu_")) {
        throw new IdentityStructureError(`Invalid github_installation_users id '${link.id}'.`);
      }
      if (!Number.isInteger(link.created_at_ms) || link.created_at_ms < 0) {
        throw new IdentityStructureError(`Invalid created_at_ms in github_installation_users row '${link.id}'.`);
      }
      if (!Number.isInteger(link.verified_at_ms) || link.verified_at_ms < 0) {
        throw new IdentityStructureError(`Invalid verified_at_ms in github_installation_users row '${link.id}'.`);
      }
    }

    const bindings = db.prepare(
      "SELECT id, workspace_id, github_repository_id, github_installation_row_id, owner_account_id, owner_login, repository_name, full_name, branch, created_at_ms, updated_at_ms FROM github_repository_bindings;",
    ).all() as Array<{
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

    for (const b of bindings) {
      if (typeof b.id !== "string" || !b.id.startsWith("grb_")) {
        throw new IdentityStructureError(`Invalid github_repository_bindings id '${b.id}'.`);
      }
      if (typeof b.github_repository_id !== "string" || !numericIdRegex.test(b.github_repository_id)) {
        throw new IdentityStructureError(
          `github_repository_id '${b.github_repository_id}' must be a positive decimal string.`,
        );
      }
      if (typeof b.owner_account_id !== "string" || !numericIdRegex.test(b.owner_account_id)) {
        throw new IdentityStructureError(
          `owner_account_id '${b.owner_account_id}' must be a positive decimal string.`,
        );
      }
      if (typeof b.owner_login !== "string" || b.owner_login.trim().length === 0) {
        throw new IdentityStructureError(`owner_login '${b.owner_login}' must be a non-empty string.`);
      }
      if (typeof b.repository_name !== "string" || b.repository_name.trim().length === 0) {
        throw new IdentityStructureError(`repository_name '${b.repository_name}' must be a non-empty string.`);
      }
      if (typeof b.full_name !== "string" || b.full_name.trim().length === 0) {
        throw new IdentityStructureError(`full_name '${b.full_name}' must be a non-empty string.`);
      }
      if (typeof b.branch !== "string" || b.branch.trim().length === 0 || b.branch.includes("\0")) {
        throw new IdentityStructureError(
          `branch '${b.branch}' must be a non-empty string containing no NUL characters.`,
        );
      }
      if (!Number.isInteger(b.created_at_ms) || b.created_at_ms < 0) {
        throw new IdentityStructureError(`Invalid created_at_ms in github_repository_bindings row '${b.id}'.`);
      }
      if (!Number.isInteger(b.updated_at_ms) || b.updated_at_ms < 0) {
        throw new IdentityStructureError(`Invalid updated_at_ms in github_repository_bindings row '${b.id}'.`);
      }
    }

    const fkViolations = db.prepare("PRAGMA foreign_key_check;").all() as Array<{
      table: string;
      rowid: number;
      parent: string;
      fkid: number;
    }>;
    if (fkViolations.length > 0) {
      const sample = fkViolations[0]!;
      throw new IdentityStructureError(
        `Identity database foreign key check failed (${fkViolations.length} violation(s); first: table '${sample.table}' rowid ${sample.rowid}).`,
      );
    }
  }

  private requireUniqueIndex(db: DatabaseSync, table: string, columns: string[]): void {
    const indexes = db.prepare(`PRAGMA index_list(${table});`).all() as Array<{
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
      if (keyed.length === columns.length && columns.every((col, i) => keyed[i] === col)) {
        return;
      }
    }
    throw new IdentityStructureError(
      `Identity table '${table}' must have a UNIQUE index over exactly the columns (${columns.join(", ")}).`,
    );
  }

  private requirePartialUniqueIndex(
    db: DatabaseSync,
    table: string,
    columns: string[],
    whereClause: string,
  ): void {
    const normalizedWhere = whereClause.replace(/\s+/g, " ").trim().toLowerCase();
    const indexes = db.prepare(`PRAGMA index_list(${table});`).all() as Array<{
      seq: number;
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;
    for (const idx of indexes) {
      if (idx.unique !== 1 || idx.partial !== 1) continue;
      const cols = db.prepare(`PRAGMA index_xinfo(${quoteIdent(idx.name)});`).all() as Array<{
        seqno: number;
        cid: number;
        name: string | null;
      }>;
      const keyed = cols.filter((c) => c.cid >= 0).map((c) => c.name);
      if (keyed.length !== columns.length || !columns.every((col, i) => keyed[i] === col)) {
        continue;
      }
      const master = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?;").get(idx.name) as
        | { sql: string | null }
        | undefined;
      const sqlNorm = (master?.sql ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      if (sqlNorm.includes(`where ${normalizedWhere}`)) {
        return;
      }
    }
    throw new IdentityStructureError(
      `Identity table '${table}' must have a partial UNIQUE index over (${columns.join(", ")}) WHERE ${whereClause}.`,
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
      const membership = db.prepare(
        "SELECT id, workspace_id, user_id, role, created_at FROM workspace_memberships WHERE workspace_id = ? AND role = 'owner' LIMIT 1;",
      ).get(workspace.id) as
        | { id: string; workspace_id: string; user_id: string; role: string; created_at: number }
        | undefined;

      if (!membership) {
        throw new IdentityStructureError(
          `Workspace '${workspace.id}' has no owner membership.`,
        );
      }
      if (membership.user_id !== workspace.owner_user_id) {
        throw new IdentityStructureError(
          `Workspace '${workspace.id}' owner membership user '${membership.user_id}' does not match shadow owner '${workspace.owner_user_id}'.`,
        );
      }

      const user = db.prepare(
        "SELECT id, created_at, disabled_at FROM users WHERE id = ?;",
      ).get(membership.user_id) as
        | { id: string; created_at: number; disabled_at: number | null }
        | undefined;

      if (!user) {
        throw new IdentityStructureError(
          `Workspace owner user '${membership.user_id}' does not exist.`,
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
        if (error instanceof IdentityError) throw error;
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

  static migrateToCurrent(db: DatabaseSync): void {
    while (true) {
      const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
      const version = Number(versionRow.user_version);
      if (version >= IDENTITY_DB_USER_VERSION) {
        return;
      }
      switch (version) {
        case 1:
          IdentityStore.migrateV1ToV2(db);
          break;
        case 2:
          IdentityStore.migrateV2ToV3(db);
          break;
        case 3:
          IdentityStore.migrateV3ToV4(db);
          break;
        case 4:
          IdentityStore.migrateV4ToV5(db);
          break;
        default:
          throw new IdentityStructureError(
            `Identity database has unsupported user_version ${version}; expected at least 1 before migration to ${IDENTITY_DB_USER_VERSION}.`,
          );
      }
    }
  }

  static migrateV1ToV2(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
      if (Number(versionRow.user_version) !== 1) {
        throw new IdentityStructureError("migrateV1ToV2 requires user_version = 1.");
      }

      for (const table of ["users", "workspaces", "api_keys"] as const) {
        const row = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;",
        ).get(table) as { name: string } | undefined;
        if (!row) {
          throw new IdentityStructureError(`Cannot migrate to v2: missing required v1 table '${table}'.`);
        }
      }

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
      if (error instanceof IdentityStructureError) throw error;
      throw new IdentityStructureError(`Failed to migrate identity database from version 1 to 2: ${error}`);
    }
  }

  static migrateV2ToV3(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
      if (Number(versionRow.user_version) !== 2) {
        throw new IdentityStructureError("migrateV2ToV3 requires user_version = 2.");
      }

      for (const table of ["users", "workspaces", "api_keys", "external_identities"] as const) {
        const row = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;",
        ).get(table) as { name: string } | undefined;
        if (!row) {
          throw new IdentityStructureError(`Cannot migrate to v3: missing required v2 table '${table}'.`);
        }
      }

      db.exec(`
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
        CREATE INDEX idx_workspace_memberships_user ON workspace_memberships(user_id);
        CREATE INDEX idx_workspace_memberships_workspace ON workspace_memberships(workspace_id);
        CREATE UNIQUE INDEX ux_workspace_memberships_owner ON workspace_memberships(workspace_id) WHERE role = 'owner';
      `);

      const workspaces = db.prepare(
        "SELECT id, owner_user_id, created_at FROM workspaces ORDER BY id ASC;",
      ).all() as Array<{ id: string; owner_user_id: string; created_at: number }>;

      const insertMembership = db.prepare(
        "INSERT INTO workspace_memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?);",
      );
      for (const workspace of workspaces) {
        insertMembership.run(newId("wsm"), workspace.id, workspace.owner_user_id, workspace.created_at);
      }

      const workspaceCount = db.prepare("SELECT COUNT(*) AS c FROM workspaces;").get() as { c: number };
      const membershipCount = db.prepare("SELECT COUNT(*) AS c FROM workspace_memberships;").get() as { c: number };
      if (Number(membershipCount.c) !== Number(workspaceCount.c)) {
        throw new IdentityStructureError(
          `v2→v3 migration membership count ${membershipCount.c} does not match workspace count ${workspaceCount.c}.`,
        );
      }

      for (const workspace of workspaces) {
        const owner = db.prepare(
          "SELECT user_id FROM workspace_memberships WHERE workspace_id = ? AND role = 'owner' LIMIT 1;",
        ).get(workspace.id) as { user_id: string } | undefined;
        if (!owner || owner.user_id !== workspace.owner_user_id) {
          throw new IdentityStructureError(
            `v2→v3 migration owner membership for workspace '${workspace.id}' does not match shadow owner.`,
          );
        }
      }

      db.exec("PRAGMA user_version = 3;");
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        /* ignore */
      }
      if (error instanceof IdentityStructureError) throw error;
      throw new IdentityStructureError(`Failed to migrate identity database from version 2 to 3: ${error}`);
    }
  }

  static migrateV3ToV4(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
      if (Number(versionRow.user_version) !== 3) {
        throw new IdentityStructureError("migrateV3ToV4 requires user_version = 3.");
      }

      for (const table of [
        "users",
        "workspaces",
        "api_keys",
        "external_identities",
        "workspace_memberships",
      ] as const) {
        const row = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;",
        ).get(table) as { name: string } | undefined;
        if (!row) {
          throw new IdentityStructureError(`Cannot migrate to v4: missing required v3 table '${table}'.`);
        }
      }

      db.exec(`
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

        CREATE INDEX idx_github_installation_users_user ON github_installation_users(user_id);
        CREATE INDEX idx_github_installation_users_installation ON github_installation_users(github_installation_row_id);

        PRAGMA user_version = 4;
      `);
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        /* ignore */
      }
      if (error instanceof IdentityStructureError) throw error;
      throw new IdentityStructureError(`Failed to migrate identity database from version 3 to 4: ${error}`);
    }
  }

  static migrateV4ToV5(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
      if (Number(versionRow.user_version) !== 4) {
        throw new IdentityStructureError("migrateV4ToV5 requires user_version = 4.");
      }

      for (const table of [
        "users",
        "workspaces",
        "api_keys",
        "external_identities",
        "workspace_memberships",
        "github_installations",
        "github_installation_users",
      ] as const) {
        const row = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;",
        ).get(table) as { name: string } | undefined;
        if (!row) {
          throw new IdentityStructureError(`Cannot migrate to v5: missing required v4 table '${table}'.`);
        }
      }

      db.exec(`
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

        CREATE INDEX idx_github_repository_bindings_installation ON github_repository_bindings(github_installation_row_id);

        PRAGMA user_version = 5;
      `);
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        /* ignore */
      }
      if (error instanceof IdentityStructureError) throw error;
      throw new IdentityStructureError(`Failed to migrate identity database from version 4 to 5: ${error}`);
    }
  }

  findExternalIdentity(provider: string, providerSubject: string): {
    id: string;
    provider: string;
    provider_subject: string;
    user_id: string;
    provider_login: string | null;
    created_at_ms: number;
    updated_at_ms: number;
  } | null {
    return this.withDb((db) => {
      const row = db.prepare(
        "SELECT id, provider, provider_subject, user_id, provider_login, created_at_ms, updated_at_ms FROM external_identities WHERE provider = ? AND provider_subject = ? LIMIT 1;",
      ).get(provider, providerSubject) as
        | {
            id: string;
            provider: string;
            provider_subject: string;
            user_id: string;
            provider_login: string | null;
            created_at_ms: number;
            updated_at_ms: number;
          }
        | undefined;
      return row ?? null;
    });
  }

  /**
   * Atomically resolve an existing CEO user by external identity or create a new
   * user + external identity pair. Never creates workspaces or API keys.
   */
  resolveOrCreateExternalUser(input: {
    provider: string;
    providerSubject: string;
    providerLogin?: string;
  }): {
    user_id: string;
    external_identity_id: string;
    created: boolean;
    provider: string;
    provider_subject: string;
    provider_login: string | null;
  } {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const existing = db.prepare(
          "SELECT id, provider, provider_subject, user_id, provider_login, created_at_ms, updated_at_ms FROM external_identities WHERE provider = ? AND provider_subject = ? LIMIT 1;",
        ).get(input.provider, input.providerSubject) as
          | {
              id: string;
              provider: string;
              provider_subject: string;
              user_id: string;
              provider_login: string | null;
              created_at_ms: number;
              updated_at_ms: number;
            }
          | undefined;

        if (existing) {
          const userRow = db.prepare(
            "SELECT id, disabled_at FROM users WHERE id = ? LIMIT 1;",
          ).get(existing.user_id) as { id: string; disabled_at: number | null } | undefined;

          if (!userRow) {
            throw new IdentityStructureError(
              `External identity '${existing.id}' references missing user '${existing.user_id}'.`,
            );
          }
          if (userRow.disabled_at != null) {
            throw new IdentityConflictError(
              `Bound user '${existing.user_id}' is disabled; cannot authenticate external identity ${input.provider}:${input.providerSubject}.`,
            );
          }

          let providerLogin = existing.provider_login;
          if (input.providerLogin !== undefined) {
            const nowMs = Date.now();
            db.prepare(
              "UPDATE external_identities SET provider_login = ?, updated_at_ms = ? WHERE id = ?;",
            ).run(input.providerLogin, nowMs, existing.id);
            providerLogin = input.providerLogin;
          }

          db.exec("COMMIT;");
          return {
            user_id: existing.user_id,
            external_identity_id: existing.id,
            created: false,
            provider: existing.provider,
            provider_subject: existing.provider_subject,
            provider_login: providerLogin,
          };
        }

        const nowMs = Date.now();
        const userId = newId("usr");
        const externalIdentityId = newId("ext");

        db.prepare(
          "INSERT INTO users (id, created_at, disabled_at) VALUES (?, ?, NULL);",
        ).run(userId, nowMs);

        db.prepare(
          `INSERT INTO external_identities (id, provider, provider_subject, user_id, provider_login, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?);`,
        ).run(
          externalIdentityId,
          input.provider,
          input.providerSubject,
          userId,
          input.providerLogin ?? null,
          nowMs,
          nowMs,
        );

        db.exec("COMMIT;");
        return {
          user_id: userId,
          external_identity_id: externalIdentityId,
          created: true,
          provider: input.provider,
          provider_subject: input.providerSubject,
          provider_login: input.providerLogin ?? null,
        };
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        if (error instanceof IdentityError) throw error;
        throw new IdentityDbUnavailable(
          `Failed to resolve or create external user: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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

  hasWorkspaceAccess(workspaceId: string, userId: string): boolean {
    return this.withDb((db) => {
      const row = db.prepare(
        "SELECT id FROM workspace_memberships WHERE workspace_id = ? AND user_id = ? AND role = 'owner' LIMIT 1;",
      ).get(workspaceId, userId) as { id: string } | undefined;
      return Boolean(row);
    });
  }

  getOwnerMembershipForWorkspace(workspaceId: string): {
    id: string;
    workspace_id: string;
    user_id: string;
    role: string;
    created_at: number;
  } | null {
    return this.withDb((db) => {
      const row = db.prepare(
        "SELECT id, workspace_id, user_id, role, created_at FROM workspace_memberships WHERE workspace_id = ? AND role = 'owner' LIMIT 1;",
      ).get(workspaceId) as
        | { id: string; workspace_id: string; user_id: string; role: string; created_at: number }
        | undefined;
      return row ?? null;
    });
  }

  upsertGitHubInstallationWithUser(input: UpsertGitHubInstallationInput): {
    installation: GitHubInstallationRecord;
    userLink: GitHubInstallationUserRecord;
  } {
    const numericRegex = /^[1-9][0-9]*$/;
    if (typeof input.githubInstallationId !== "string" || !numericRegex.test(input.githubInstallationId)) {
      throw new IdentityStructureError(
        `githubInstallationId must be a positive decimal string, got '${input.githubInstallationId}'.`,
      );
    }
    if (typeof input.githubAppId !== "string" || !numericRegex.test(input.githubAppId)) {
      throw new IdentityStructureError(
        `githubAppId must be a positive decimal string, got '${input.githubAppId}'.`,
      );
    }
    if (typeof input.accountId !== "string" || !numericRegex.test(input.accountId)) {
      throw new IdentityStructureError(
        `accountId must be a positive decimal string, got '${input.accountId}'.`,
      );
    }
    if (typeof input.accountLogin !== "string" || input.accountLogin.trim().length === 0) {
      throw new IdentityStructureError("accountLogin must be a non-empty string.");
    }
    if (input.accountType !== "User" && input.accountType !== "Organization") {
      throw new IdentityStructureError(
        `Invalid accountType '${input.accountType}'; must be 'User' or 'Organization'.`,
      );
    }
    if (input.repositorySelection !== "all" && input.repositorySelection !== "selected") {
      throw new IdentityStructureError(
        `Invalid repositorySelection '${input.repositorySelection}'; must be 'all' or 'selected'.`,
      );
    }
    if (input.suspendedAtMs !== undefined && input.suspendedAtMs !== null) {
      if (!Number.isInteger(input.suspendedAtMs) || input.suspendedAtMs <= 0) {
        throw new IdentityStructureError(
          `Invalid suspendedAtMs '${input.suspendedAtMs}'; must be a positive integer when present.`,
        );
      }
    }

    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const userRow = db.prepare(
          "SELECT id, disabled_at FROM users WHERE id = ? LIMIT 1;",
        ).get(input.userId) as { id: string; disabled_at: number | null } | undefined;

        if (!userRow) {
          throw new IdentityStructureError(`User '${input.userId}' does not exist.`);
        }
        if (userRow.disabled_at != null) {
          throw new IdentityConflictError(`User '${input.userId}' is disabled.`);
        }

        const nowMs = Date.now();
        const candidateGhiId = newId("ghi");
        const suspendedAt = input.suspendedAtMs ?? null;

        const installRow = db.prepare(`
          INSERT INTO github_installations (
            id, github_installation_id, github_app_id, account_id,
            account_login, account_type, repository_selection,
            suspended_at_ms, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(github_installation_id) DO UPDATE SET
            github_app_id = excluded.github_app_id,
            account_id = excluded.account_id,
            account_login = excluded.account_login,
            account_type = excluded.account_type,
            repository_selection = excluded.repository_selection,
            suspended_at_ms = excluded.suspended_at_ms,
            updated_at_ms = excluded.updated_at_ms
          RETURNING id, github_installation_id, github_app_id, account_id, account_login, account_type, repository_selection, suspended_at_ms, created_at_ms, updated_at_ms;
        `).get(
          candidateGhiId,
          input.githubInstallationId,
          input.githubAppId,
          input.accountId,
          input.accountLogin,
          input.accountType,
          input.repositorySelection,
          suspendedAt,
          nowMs,
          nowMs,
        ) as unknown as GitHubInstallationRecord;

        const candidateGhiuId = newId("ghiu");

        const userLinkRow = db.prepare(`
          INSERT INTO github_installation_users (
            id, github_installation_row_id, user_id, created_at_ms, verified_at_ms
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(github_installation_row_id, user_id) DO UPDATE SET
            verified_at_ms = excluded.verified_at_ms
          RETURNING id, github_installation_row_id, user_id, created_at_ms, verified_at_ms;
        `).get(
          candidateGhiuId,
          installRow.id,
          input.userId,
          nowMs,
          nowMs,
        ) as unknown as GitHubInstallationUserRecord;

        db.exec("COMMIT;");
        return {
          installation: installRow,
          userLink: userLinkRow,
        };
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        if (error instanceof IdentityError) throw error;
        throw new IdentityDbUnavailable(
          `Failed to upsert GitHub installation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  listGitHubInstallationsForUser(userId: string): UserGitHubInstallationItem[] {
    return this.withDb((db) => {
      return db.prepare(`
        SELECT
          i.id,
          i.github_installation_id,
          i.github_app_id,
          i.account_id,
          i.account_login,
          i.account_type,
          i.repository_selection,
          i.suspended_at_ms,
          i.created_at_ms,
          i.updated_at_ms,
          u.verified_at_ms
        FROM github_installations i
        JOIN github_installation_users u ON u.github_installation_row_id = i.id
        WHERE u.user_id = ?
        ORDER BY u.verified_at_ms DESC, i.id ASC;
      `).all(userId) as unknown as UserGitHubInstallationItem[];
    });
  }

  findGitHubInstallationById(githubInstallationId: string): GitHubInstallationRecord | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT id, github_installation_id, github_app_id, account_id, account_login, account_type, repository_selection, suspended_at_ms, created_at_ms, updated_at_ms
        FROM github_installations
        WHERE github_installation_id = ?
        LIMIT 1;
      `).get(githubInstallationId);
      return (row as unknown as GitHubInstallationRecord) ?? null;
    });
  }

  findGitHubInstallationUser(githubInstallationRowId: string, userId: string): GitHubInstallationUserRecord | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT id, github_installation_row_id, user_id, created_at_ms, verified_at_ms
        FROM github_installation_users
        WHERE github_installation_row_id = ? AND user_id = ?
        LIMIT 1;
      `).get(githubInstallationRowId, userId);
      return (row as unknown as GitHubInstallationUserRecord) ?? null;
    });
  }

  findGitHubInstallationByRowId(id: string): GitHubInstallationRecord | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT id, github_installation_id, github_app_id, account_id, account_login, account_type, repository_selection, suspended_at_ms, created_at_ms, updated_at_ms
        FROM github_installations
        WHERE id = ?
        LIMIT 1;
      `).get(id);
      return (row as unknown as GitHubInstallationRecord) ?? null;
    });
  }

  findRepositoryBindingByWorkspaceId(workspaceId: string): GitHubRepositoryBindingRecord | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT id, workspace_id, github_repository_id, github_installation_row_id, owner_account_id, owner_login, repository_name, full_name, branch, created_at_ms, updated_at_ms
        FROM github_repository_bindings
        WHERE workspace_id = ?
        LIMIT 1;
      `).get(workspaceId);
      return (row as unknown as GitHubRepositoryBindingRecord) ?? null;
    });
  }

  findRepositoryBindingByGitHubRepoId(githubRepositoryId: string): GitHubRepositoryBindingRecord | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT id, workspace_id, github_repository_id, github_installation_row_id, owner_account_id, owner_login, repository_name, full_name, branch, created_at_ms, updated_at_ms
        FROM github_repository_bindings
        WHERE github_repository_id = ?
        LIMIT 1;
      `).get(githubRepositoryId);
      return (row as unknown as GitHubRepositoryBindingRecord) ?? null;
    });
  }

  findRepositoryBindingById(id: string): GitHubRepositoryBindingRecord | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT id, workspace_id, github_repository_id, github_installation_row_id, owner_account_id, owner_login, repository_name, full_name, branch, created_at_ms, updated_at_ms
        FROM github_repository_bindings
        WHERE id = ?
        LIMIT 1;
      `).get(id);
      return (row as unknown as GitHubRepositoryBindingRecord) ?? null;
    });
  }

  listRepositoryBindingsForInstallation(installationRowId: string): GitHubRepositoryBindingRecord[] {
    return this.withDb((db) => {
      return db.prepare(`
        SELECT id, workspace_id, github_repository_id, github_installation_row_id, owner_account_id, owner_login, repository_name, full_name, branch, created_at_ms, updated_at_ms
        FROM github_repository_bindings
        WHERE github_installation_row_id = ?
        ORDER BY created_at_ms ASC, id ASC;
      `).all(installationRowId) as unknown as GitHubRepositoryBindingRecord[];
    });
  }

  countOwnedWorkspacesForUser(userId: string): number {
    return this.withDb((db) => {
      const row = db.prepare(
        "SELECT COUNT(*) AS c FROM workspace_memberships WHERE user_id = ? AND role = 'owner';",
      ).get(userId) as { c: number } | undefined;
      return Number(row?.c ?? 0);
    });
  }

  createWorkspaceWithRepositoryBinding(input: CreateWorkspaceWithRepositoryBindingInput): {
    workspace: { id: string; owner_user_id: string; remote_url: string; branch: string; created_at: number };
    membership: { id: string; workspace_id: string; user_id: string; role: string; created_at: number };
    binding: GitHubRepositoryBindingRecord;
  } {
    const numericRegex = /^[1-9][0-9]*$/;
    if (typeof input.githubRepositoryId !== "string" || !numericRegex.test(input.githubRepositoryId)) {
      throw new IdentityStructureError(
        `githubRepositoryId must be a positive decimal string, got '${input.githubRepositoryId}'.`,
      );
    }
    if (typeof input.ownerAccountId !== "string" || !numericRegex.test(input.ownerAccountId)) {
      throw new IdentityStructureError(
        `ownerAccountId must be a positive decimal string, got '${input.ownerAccountId}'.`,
      );
    }
    if (typeof input.ownerLogin !== "string" || input.ownerLogin.trim().length === 0) {
      throw new IdentityStructureError("ownerLogin must be a non-empty string.");
    }
    if (typeof input.repositoryName !== "string" || input.repositoryName.trim().length === 0) {
      throw new IdentityStructureError("repositoryName must be a non-empty string.");
    }
    if (typeof input.fullName !== "string" || input.fullName.trim().length === 0) {
      throw new IdentityStructureError("fullName must be a non-empty string.");
    }
    if (typeof input.branch !== "string" || input.branch.trim().length === 0 || input.branch.includes("\0")) {
      throw new IdentityStructureError("branch must be a non-empty string without NUL characters.");
    }

    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const userRow = db.prepare(
          "SELECT id, disabled_at FROM users WHERE id = ? LIMIT 1;",
        ).get(input.userId) as { id: string; disabled_at: number | null } | undefined;

        if (!userRow) {
          throw new IdentityStructureError(`User '${input.userId}' does not exist.`);
        }
        if (userRow.disabled_at != null) {
          throw new IdentityConflictError(`User '${input.userId}' is disabled.`);
        }

        const instRow = db.prepare(
          "SELECT id FROM github_installations WHERE id = ? LIMIT 1;",
        ).get(input.installationRowId) as { id: string } | undefined;

        if (!instRow) {
          throw new IdentityStructureError(`GitHub installation row '${input.installationRowId}' does not exist.`);
        }

        const userLink = db.prepare(
          "SELECT id FROM github_installation_users WHERE github_installation_row_id = ? AND user_id = ? LIMIT 1;",
        ).get(input.installationRowId, input.userId) as { id: string } | undefined;

        if (!userLink) {
          throw new IdentityConflictError(
            `User '${input.userId}' has no verified association with installation row '${input.installationRowId}'.`,
          );
        }

        const existingBinding = db.prepare(
          "SELECT id FROM github_repository_bindings WHERE github_repository_id = ? LIMIT 1;",
        ).get(input.githubRepositoryId) as { id: string } | undefined;

        if (existingBinding) {
          throw new IdentityConflictError(
            `GitHub repository '${input.githubRepositoryId}' is already bound to a workspace.`,
          );
        }

        // V1 Product Policy: User may only own a single workspace
        const ownerRow = db.prepare(
          "SELECT COUNT(*) AS c FROM workspace_memberships WHERE user_id = ? AND role = 'owner';",
        ).get(input.userId) as { c: number } | undefined;

        if ((ownerRow?.c ?? 0) > 0) {
          throw new IdentityConflictError(
            `User '${input.userId}' already owns a workspace; V1 policy restricts users to one owned workspace.`,
          );
        }

        const nowMs = Date.now();
        const workspaceId = newId("ws");
        const membershipId = newId("wsm");
        const bindingId = newId("grb");
        const remoteUrl = `https://github.com/${input.fullName.trim()}.git`;

        db.prepare(
          "INSERT INTO workspaces (id, owner_user_id, remote_url, branch, created_at) VALUES (?, ?, ?, ?, ?);",
        ).run(workspaceId, input.userId, remoteUrl, input.branch.trim(), nowMs);

        db.prepare(
          "INSERT INTO workspace_memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?);",
        ).run(membershipId, workspaceId, input.userId, nowMs);

        db.prepare(`
          INSERT INTO github_repository_bindings (
            id, workspace_id, github_repository_id, github_installation_row_id,
            owner_account_id, owner_login, repository_name, full_name,
            branch, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        `).run(
          bindingId,
          workspaceId,
          input.githubRepositoryId,
          input.installationRowId,
          input.ownerAccountId,
          input.ownerLogin.trim(),
          input.repositoryName.trim(),
          input.fullName.trim(),
          input.branch.trim(),
          nowMs,
          nowMs,
        );

        db.exec("COMMIT;");
        return {
          workspace: {
            id: workspaceId,
            owner_user_id: input.userId,
            remote_url: remoteUrl,
            branch: input.branch.trim(),
            created_at: nowMs,
          },
          membership: {
            id: membershipId,
            workspace_id: workspaceId,
            user_id: input.userId,
            role: "owner",
            created_at: nowMs,
          },
          binding: {
            id: bindingId,
            workspace_id: workspaceId,
            github_repository_id: input.githubRepositoryId,
            github_installation_row_id: input.installationRowId,
            owner_account_id: input.ownerAccountId,
            owner_login: input.ownerLogin.trim(),
            repository_name: input.repositoryName.trim(),
            full_name: input.fullName.trim(),
            branch: input.branch.trim(),
            created_at_ms: nowMs,
            updated_at_ms: nowMs,
          },
        };
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        if (error instanceof IdentityError) throw error;
        throw new IdentityDbUnavailable(
          `Failed to create workspace with repository binding: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
