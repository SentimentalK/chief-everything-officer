import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * MCP-visible sanitized request workspace identity. Populated per request
 * from credential → membership resolution. It deliberately omits `api_key_id`,
 * which is a per-request authentication outcome.
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

/** Per-request authentication result. Extends the sanitized workspace identity. */
export interface AuthIdentity extends WorkspaceIdentity {
  api_key_id: string;
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

export const IDENTITY_DB_USER_VERSION = 9;

export type WorkspaceBootstrapState =
  | "PENDING"
  | "APPLYING"
  | "RETRYABLE_FAILURE"
  | "MANUAL_RECOVERY"
  | "READY";

export type WorkspaceBootstrapErrorKind = "retryable" | "manual";

export interface WorkspaceBootstrapRecord {
  workspace_id: string;
  bootstrap_version: number;
  state: WorkspaceBootstrapState;
  attempt_count: number;
  last_attempt_id: string | null;
  last_base_commit_sha: string | null;
  ready_commit_sha: string | null;
  last_error_kind: WorkspaceBootstrapErrorKind | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  ready_at_ms: number | null;
}

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
  access_scope_verified_at_ms: number | null;
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
  accessScopeVerifiedAtMs?: number | null;
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
  access_scope_verified_at_ms INTEGER,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (github_installation_row_id) REFERENCES github_installations(id)
);

CREATE TABLE workspace_bootstraps (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  bootstrap_version INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  last_attempt_id TEXT,
  last_base_commit_sha TEXT,
  ready_commit_sha TEXT,
  last_error_kind TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  ready_at_ms INTEGER,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE onboarding_flows (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  mode TEXT NOT NULL,
  desired_repository_name TEXT,
  installation_row_id TEXT,
  repository_id TEXT,
  workspace_id TEXT,
  state TEXT NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT,
  host_oauth_request_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (installation_row_id) REFERENCES github_installations(id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
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
CREATE INDEX idx_workspace_bootstraps_state ON workspace_bootstraps(state);
CREATE INDEX idx_onboarding_flows_user ON onboarding_flows(user_id);
CREATE INDEX idx_onboarding_flows_state ON onboarding_flows(state);
CREATE UNIQUE INDEX idx_onboarding_one_active_per_user
ON onboarding_flows(user_id)
WHERE state IN (
  'AWAITING_REPOSITORY_CHOICE',
  'AWAITING_GITHUB_ACCESS',
  'PROVISIONING',
  'AWAITING_REPOSITORY_RESTRICTION',
  'READY_TO_RESUME',
  'RECOVERY_REQUIRED'
);
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
  "workspace_bootstraps",
  "onboarding_flows",
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
  workspace_bootstraps: [
    "workspace_id",
    "bootstrap_version",
    "state",
    "attempt_count",
    "created_at_ms",
    "updated_at_ms",
  ],
  onboarding_flows: [
    "id",
    "user_id",
    "provider_subject",
    "mode",
    "state",
    "created_at_ms",
    "updated_at_ms",
    "expires_at_ms",
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
  workspace_bootstraps: [
    { from: "workspace_id", to: "id", referencedTable: "workspaces" },
  ],
  onboarding_flows: [
    { from: "user_id", to: "id", referencedTable: "users" },
    { from: "installation_row_id", to: "id", referencedTable: "github_installations" },
    { from: "workspace_id", to: "id", referencedTable: "workspaces" },
  ],
};

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function newId(prefix: "usr" | "ws" | "ak" | "ext" | "wsm" | "ghi" | "ghiu" | "grb" | "wba" | "onb"): string {
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
 * Creates a brand-new, empty control-plane identity database that publishes atomically.
 * Contains 0 users, 0 workspaces, and 0 API keys with the latest schema.
 * If the database already exists, it validates the existing database without clobbering.
 */
export function provisionEmptyControlPlaneDatabase(dbPath: string): void {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const dbPathResolved = path.resolve(dbPath);
  const dirResolved = path.dirname(dbPathResolved);

  if (fs.existsSync(dbPathResolved)) {
    const existing = IdentityStore.open(dbPathResolved);
    existing.close();
    return;
  }

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
      unlinkDbFiles(tmpName);
      throw new IdentityStructureError(
        `Identity database provisioning failed; no database was published: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      fs.linkSync(tmpName, dbPathResolved);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        unlinkDbFiles(tmpName);
        const existing = IdentityStore.open(dbPathResolved);
        existing.close();
        return;
      }
      unlinkDbFiles(tmpName);
      throw new IdentityStructureError(
        `Identity database could not be published: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    unlinkDbFiles(tmpName);
  } catch (error) {
    unlinkDbFiles(tmpName);
    throw error;
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

  ping(): boolean {
    if (!this.db) return false;
    try {
      this.db.prepare("SELECT 1;").get();
      return true;
    } catch {
      return false;
    }
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new IdentityDbContextClosed(
      "Identity database is not open.",
    );
    return this.db;
  }

  withDb<T>(operation: (db: DatabaseSync) => T): T {
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

      // PK must be exactly the expected primary key column ('workspace_id' for workspace_bootstraps, 'id' for other tables).
      const expectedPk = table === "workspace_bootstraps" ? "workspace_id" : "id";
      const pkColumns = columns.filter((c) => c.pk > 0).map((c) => c.name);
      if (pkColumns.length !== 1 || pkColumns[0] !== expectedPk) {
        throw new IdentityStructureError(
          `Identity table '${table}' must have exactly one primary key column '${expectedPk}' (found: ${pkColumns.join(",")})`,
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
    this.requirePartialUniqueIndex(
      db,
      "onboarding_flows",
      ["user_id"],
      "state IN ('AWAITING_REPOSITORY_CHOICE', 'AWAITING_GITHUB_ACCESS', 'PROVISIONING', 'AWAITING_REPOSITORY_RESTRICTION', 'READY_TO_RESUME', 'RECOVERY_REQUIRED')",
    );

    const bindingCols = db.prepare("PRAGMA table_info(github_repository_bindings);").all() as Array<{ name: string }>;
    if (!bindingCols.some((c) => c.name === "access_scope_verified_at_ms")) {
      throw new IdentityStructureError("Identity table 'github_repository_bindings' is missing column 'access_scope_verified_at_ms'.");
    }

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
      "SELECT id, workspace_id, github_repository_id, github_installation_row_id, owner_account_id, owner_login, repository_name, full_name, branch, created_at_ms, updated_at_ms, access_scope_verified_at_ms FROM github_repository_bindings;",
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
      access_scope_verified_at_ms: number | null;
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
      if (b.access_scope_verified_at_ms !== null && b.access_scope_verified_at_ms !== undefined) {
        if (!Number.isInteger(b.access_scope_verified_at_ms) || b.access_scope_verified_at_ms < 0) {
          throw new IdentityStructureError(`Invalid access_scope_verified_at_ms in github_repository_bindings row '${b.id}'.`);
        }
      }
    }

    const bootstraps = db.prepare(
      "SELECT workspace_id, bootstrap_version, state, attempt_count, last_attempt_id, last_base_commit_sha, ready_commit_sha, last_error_kind, last_error_code, last_error_message, created_at_ms, updated_at_ms, ready_at_ms FROM workspace_bootstraps;",
    ).all() as Array<{
      workspace_id: string;
      bootstrap_version: number;
      state: string;
      attempt_count: number;
      last_attempt_id: string | null;
      last_base_commit_sha: string | null;
      ready_commit_sha: string | null;
      last_error_kind: string | null;
      last_error_code: string | null;
      last_error_message: string | null;
      created_at_ms: number;
      updated_at_ms: number;
      ready_at_ms: number | null;
    }>;

    const commitShaRegex = /^[0-9a-fA-F]{40,64}$/;
    const validBootstrapStates = new Set([
      "PENDING",
      "APPLYING",
      "RETRYABLE_FAILURE",
      "MANUAL_RECOVERY",
      "READY",
    ]);

    for (const b of bootstraps) {
      if (typeof b.workspace_id !== "string" || !b.workspace_id.startsWith("ws_")) {
        throw new IdentityStructureError(`Invalid workspace_bootstraps workspace_id '${b.workspace_id}'.`);
      }
      if (!Number.isInteger(b.bootstrap_version) || b.bootstrap_version !== 1) {
        throw new IdentityStructureError(
          `workspace_bootstraps bootstrap_version must be 1, found '${b.bootstrap_version}' in row '${b.workspace_id}'.`,
        );
      }
      if (!Number.isInteger(b.attempt_count) || b.attempt_count < 0) {
        throw new IdentityStructureError(
          `workspace_bootstraps attempt_count must be a non-negative integer, found '${b.attempt_count}' in row '${b.workspace_id}'.`,
        );
      }
      if (!Number.isInteger(b.created_at_ms) || b.created_at_ms < 0) {
        throw new IdentityStructureError(`Invalid created_at_ms in workspace_bootstraps row '${b.workspace_id}'.`);
      }
      if (!Number.isInteger(b.updated_at_ms) || b.updated_at_ms < 0) {
        throw new IdentityStructureError(`Invalid updated_at_ms in workspace_bootstraps row '${b.workspace_id}'.`);
      }
      if (!validBootstrapStates.has(b.state)) {
        throw new IdentityStructureError(`Invalid workspace_bootstraps state '${b.state}' in row '${b.workspace_id}'.`);
      }
      if (b.last_attempt_id !== null) {
        if (typeof b.last_attempt_id !== "string" || b.last_attempt_id.trim().length === 0) {
          throw new IdentityStructureError(`Invalid last_attempt_id in workspace_bootstraps row '${b.workspace_id}'.`);
        }
      }
      if (b.last_base_commit_sha !== null) {
        if (typeof b.last_base_commit_sha !== "string" || !commitShaRegex.test(b.last_base_commit_sha)) {
          throw new IdentityStructureError(`Invalid last_base_commit_sha in workspace_bootstraps row '${b.workspace_id}'.`);
        }
      }
      if (b.ready_commit_sha !== null) {
        if (typeof b.ready_commit_sha !== "string" || !commitShaRegex.test(b.ready_commit_sha)) {
          throw new IdentityStructureError(`Invalid ready_commit_sha in workspace_bootstraps row '${b.workspace_id}'.`);
        }
      }
      if (b.ready_at_ms !== null) {
        if (!Number.isInteger(b.ready_at_ms) || b.ready_at_ms < 0) {
          throw new IdentityStructureError(`Invalid ready_at_ms in workspace_bootstraps row '${b.workspace_id}'.`);
        }
      }

      if (b.state === "READY") {
        if (b.ready_commit_sha === null || b.ready_at_ms === null) {
          throw new IdentityStructureError(
            `workspace_bootstraps in READY state requires ready_commit_sha and ready_at_ms in row '${b.workspace_id}'.`,
          );
        }
        if (b.last_error_kind !== null || b.last_error_code !== null || b.last_error_message !== null) {
          throw new IdentityStructureError(
            `workspace_bootstraps in READY state cannot have failure fields in row '${b.workspace_id}'.`,
          );
        }
      } else if (b.state === "PENDING" || b.state === "APPLYING") {
        if (b.ready_commit_sha !== null || b.ready_at_ms !== null) {
          throw new IdentityStructureError(
            `workspace_bootstraps in ${b.state} state cannot have ready_commit_sha or ready_at_ms in row '${b.workspace_id}'.`,
          );
        }
        if (b.last_error_kind !== null || b.last_error_code !== null || b.last_error_message !== null) {
          throw new IdentityStructureError(
            `workspace_bootstraps in ${b.state} state cannot have failure fields in row '${b.workspace_id}'.`,
          );
        }
      } else if (b.state === "RETRYABLE_FAILURE" || b.state === "MANUAL_RECOVERY") {
        if (b.ready_commit_sha !== null || b.ready_at_ms !== null) {
          throw new IdentityStructureError(
            `workspace_bootstraps in failure state cannot have ready_commit_sha or ready_at_ms in row '${b.workspace_id}'.`,
          );
        }
        const expectedKind = b.state === "RETRYABLE_FAILURE" ? "retryable" : "manual";
        if (b.last_error_kind !== expectedKind) {
          throw new IdentityStructureError(
            `workspace_bootstraps in state '${b.state}' requires last_error_kind '${expectedKind}', found '${b.last_error_kind}' in row '${b.workspace_id}'.`,
          );
        }
        if (typeof b.last_error_code !== "string" || b.last_error_code.trim().length === 0) {
          throw new IdentityStructureError(
            `workspace_bootstraps in failure state requires non-empty last_error_code in row '${b.workspace_id}'.`,
          );
        }
        if (typeof b.last_error_message !== "string" || b.last_error_message.trim().length === 0) {
          throw new IdentityStructureError(
            `workspace_bootstraps in failure state requires non-empty last_error_message in row '${b.workspace_id}'.`,
          );
        }
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
    const normalizeSql = (s: string) =>
      s
        .replace(/\s+/g, " ")
        .replace(/\s*\(\s*/g, "(")
        .replace(/\s*\)\s*/g, ")")
        .replace(/\s*,\s*/g, ",")
        .trim()
        .toLowerCase();
    const normalizedWhere = normalizeSql(whereClause);
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
      const sqlNorm = normalizeSql(master?.sql ?? "");
      if (sqlNorm.includes(`where ${normalizedWhere}`)) {
        return;
      }
    }
    throw new IdentityStructureError(
      `Identity table '${table}' must have a partial UNIQUE index over (${columns.join(", ")}) WHERE ${whereClause}.`,
    );
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
        case 5:
          IdentityStore.migrateV5ToV6(db);
          break;
        case 6:
          IdentityStore.migrateV6ToV7(db);
          break;
        case 7:
          IdentityStore.migrateV7ToV8(db);
          break;
        case 8:
          IdentityStore.migrateV8ToV9(db);
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

  static migrateV5ToV6(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
      if (Number(versionRow.user_version) !== 5) {
        throw new IdentityStructureError("migrateV5ToV6 requires user_version = 5.");
      }

      for (const table of [
        "users",
        "workspaces",
        "api_keys",
        "external_identities",
        "workspace_memberships",
        "github_installations",
        "github_installation_users",
        "github_repository_bindings",
      ] as const) {
        const row = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;",
        ).get(table) as { name: string } | undefined;
        if (!row) {
          throw new IdentityStructureError(`Cannot migrate to v6: missing required v5 table '${table}'.`);
        }
      }

      db.exec(`
        CREATE TABLE workspace_bootstraps (
          workspace_id TEXT PRIMARY KEY NOT NULL,
          bootstrap_version INTEGER NOT NULL,
          state TEXT NOT NULL,
          attempt_count INTEGER NOT NULL,
          last_attempt_id TEXT,
          last_base_commit_sha TEXT,
          ready_commit_sha TEXT,
          last_error_kind TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          ready_at_ms INTEGER,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
        );

        CREATE INDEX idx_workspace_bootstraps_state ON workspace_bootstraps(state);

        INSERT INTO workspace_bootstraps (
          workspace_id, bootstrap_version, state, attempt_count,
          last_attempt_id, last_base_commit_sha, ready_commit_sha,
          last_error_kind, last_error_code, last_error_message,
          created_at_ms, updated_at_ms, ready_at_ms
        )
        SELECT
          workspace_id, 1, 'PENDING', 0,
          NULL, NULL, NULL,
          NULL, NULL, NULL,
          created_at_ms, updated_at_ms, NULL
        FROM github_repository_bindings;

        PRAGMA user_version = 6;
      `);
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        /* ignore */
      }
      if (error instanceof IdentityStructureError) throw error;
      throw new IdentityStructureError(`Failed to migrate identity database from version 5 to 6: ${error}`);
    }
  }

  static migrateV6ToV7(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
      if (Number(versionRow.user_version) !== 6) {
        throw new IdentityStructureError("migrateV6ToV7 requires user_version = 6.");
      }

      for (const table of [
        "users",
        "workspaces",
        "api_keys",
        "external_identities",
        "workspace_memberships",
        "github_installations",
        "github_installation_users",
        "github_repository_bindings",
        "workspace_bootstraps",
      ] as const) {
        const row = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;",
        ).get(table) as { name: string } | undefined;
        if (!row) {
          throw new IdentityStructureError(`Cannot migrate to v7: missing required v6 table '${table}'.`);
        }
      }

      db.exec(`
        CREATE TABLE onboarding_flows (
          id TEXT PRIMARY KEY NOT NULL,
          user_id TEXT NOT NULL,
          provider_subject TEXT NOT NULL,
          mode TEXT NOT NULL,
          desired_repository_name TEXT,
          installation_row_id TEXT,
          repository_id TEXT,
          workspace_id TEXT,
          state TEXT NOT NULL,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (installation_row_id) REFERENCES github_installations(id) ON DELETE SET NULL,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
        );

        CREATE INDEX idx_onboarding_flows_user ON onboarding_flows(user_id);
        CREATE INDEX idx_onboarding_flows_state ON onboarding_flows(state);
        CREATE UNIQUE INDEX idx_onboarding_one_active_per_user
        ON onboarding_flows(user_id)
        WHERE state IN (
          'AWAITING_REPOSITORY_CHOICE',
          'AWAITING_GITHUB_ACCESS',
          'PROVISIONING',
          'READY_TO_RESUME',
          'RECOVERY_REQUIRED'
        );

        PRAGMA user_version = 7;
      `);
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        /* ignore */
      }
      if (error instanceof IdentityStructureError) throw error;
      throw new IdentityStructureError(`Failed to migrate identity database from version 6 to 7: ${error}`);
    }
  }

  static migrateV7ToV8(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
      if (Number(versionRow.user_version) !== 7) {
        throw new IdentityStructureError("migrateV7ToV8 requires user_version = 7.");
      }

      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'onboarding_flows';",
      ).get() as { name: string } | undefined;
      if (!row) {
        throw new IdentityStructureError("Cannot migrate to v8: missing required v7 table 'onboarding_flows'.");
      }

      db.exec(`
        ALTER TABLE onboarding_flows ADD COLUMN host_oauth_request_id TEXT;

        DROP INDEX IF EXISTS idx_onboarding_one_active_per_user;

        CREATE UNIQUE INDEX idx_onboarding_one_active_per_user
        ON onboarding_flows(user_id)
        WHERE state IN (
          'AWAITING_REPOSITORY_CHOICE',
          'AWAITING_GITHUB_ACCESS',
          'PROVISIONING',
          'AWAITING_REPOSITORY_RESTRICTION',
          'READY_TO_RESUME',
          'RECOVERY_REQUIRED'
        );

        PRAGMA user_version = 8;
      `);
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        /* ignore */
      }
      if (error instanceof IdentityStructureError) throw error;
      throw new IdentityStructureError(`Failed to migrate identity database from version 7 to 8: ${error}`);
    }
  }

  static migrateV8ToV9(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
      if (Number(versionRow.user_version) !== 8) {
        throw new IdentityStructureError("migrateV8ToV9 requires user_version = 8.");
      }

      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'github_repository_bindings';",
      ).get() as { name: string } | undefined;
      if (!row) {
        throw new IdentityStructureError("Cannot migrate to v9: missing required v8 table 'github_repository_bindings'.");
      }

      db.exec(`
        ALTER TABLE github_repository_bindings ADD COLUMN access_scope_verified_at_ms INTEGER;

        PRAGMA user_version = 9;
      `);
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        /* ignore */
      }
      if (error instanceof IdentityStructureError) throw error;
      throw new IdentityStructureError(`Failed to migrate identity database from version 8 to 9: ${error}`);
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

  listWorkspaceMembershipsForUser(userId: string): Array<{
    id: string;
    workspace_id: string;
    user_id: string;
    role: string;
    created_at: number;
  }> {
    return this.withDb((db) => {
      const rows = db.prepare(
        "SELECT id, workspace_id, user_id, role, created_at FROM workspace_memberships WHERE user_id = ? ORDER BY created_at ASC, workspace_id ASC;",
      ).all(userId) as Array<{ id: string; workspace_id: string; user_id: string; role: string; created_at: number }>;
      return rows;
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

  findWorkspaceById(workspaceId: string): {
    id: string;
    owner_user_id: string;
    remote_url: string;
    branch: string;
    created_at: number;
  } | null {
    return this.withDb((db) => {
      const row = db.prepare(
        "SELECT id, owner_user_id, remote_url, branch, created_at FROM workspaces WHERE id = ? LIMIT 1;",
      ).get(workspaceId) as
        | { id: string; owner_user_id: string; remote_url: string; branch: string; created_at: number }
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
        SELECT id, workspace_id, github_repository_id, github_installation_row_id, owner_account_id, owner_login, repository_name, full_name, branch, created_at_ms, updated_at_ms, access_scope_verified_at_ms
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
        SELECT id, workspace_id, github_repository_id, github_installation_row_id, owner_account_id, owner_login, repository_name, full_name, branch, created_at_ms, updated_at_ms, access_scope_verified_at_ms
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
        SELECT id, workspace_id, github_repository_id, github_installation_row_id, owner_account_id, owner_login, repository_name, full_name, branch, created_at_ms, updated_at_ms, access_scope_verified_at_ms
        FROM github_repository_bindings
        WHERE id = ?
        LIMIT 1;
      `).get(id);
      return (row as unknown as GitHubRepositoryBindingRecord) ?? null;
    });
  }

  updateRepositoryBindingMetadata(
    githubRepositoryId: string,
    metadata: {
      ownerLogin?: string;
      repositoryName?: string;
      fullName?: string;
      branch?: string;
    },
  ): boolean {
    return this.withDb((db) => {
      const nowMs = Date.now();
      const existing = this.findRepositoryBindingByGitHubRepoId(githubRepositoryId);
      if (!existing) return false;

      const ownerLogin = metadata.ownerLogin ?? existing.owner_login;
      const repositoryName = metadata.repositoryName ?? existing.repository_name;
      const fullName = metadata.fullName ?? existing.full_name;
      const branch = metadata.branch ?? existing.branch;

      const res = db.prepare(`
        UPDATE github_repository_bindings
        SET owner_login = ?,
            repository_name = ?,
            full_name = ?,
            branch = ?,
            updated_at_ms = ?
        WHERE github_repository_id = ?;
      `).run(ownerLogin, repositoryName, fullName, branch, nowMs, githubRepositoryId);

      return Number(res.changes) > 0;
    });
  }

  /**
   * Atomically reconciles repository metadata in both github_repository_bindings
   * and workspaces (remote_url) within a single immediate transaction.
   */
  reconcileRepositoryMetadataById(params: {
    githubRepositoryId: string;
    ownerLogin: string;
    repositoryName: string;
    fullName: string;
    nowMs?: number;
  }): { binding: GitHubRepositoryBindingRecord; workspaceRemoteUrl: string } {
    const now = params.nowMs ?? Date.now();
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const bindingRow = db.prepare(
          "SELECT * FROM github_repository_bindings WHERE github_repository_id = ? LIMIT 1;",
        ).get(params.githubRepositoryId) as any;
        if (!bindingRow) {
          throw new IdentityError(
            `Cannot reconcile repository metadata: repository binding for github repo id '${params.githubRepositoryId}' not found`,
          );
        }

        const newRemoteUrl = `https://github.com/${params.fullName}.git`;

        db.prepare(`
          UPDATE github_repository_bindings
          SET owner_login = ?,
              repository_name = ?,
              full_name = ?,
              updated_at_ms = ?
          WHERE github_repository_id = ?;
        `).run(
          params.ownerLogin,
          params.repositoryName,
          params.fullName,
          now,
          params.githubRepositoryId,
        );

        db.prepare(`
          UPDATE workspaces
          SET remote_url = ?
          WHERE id = ?;
        `).run(newRemoteUrl, bindingRow.workspace_id);

        db.exec("COMMIT;");

        const updatedBinding = this.findRepositoryBindingByGitHubRepoId(params.githubRepositoryId)!;
        return { binding: updatedBinding, workspaceRemoteUrl: newRemoteUrl };
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        throw error;
      }
    });
  }

  /**
   * Authoritative helper for checking whether a workspace is ready for Host access.
   * If the workspace is GitHub-managed:
   * 1. access_scope_verified_at_ms MUST NOT be null (least privilege verified).
   * 2. bootstrap record must exist and be in READY state.
   * If the workspace has a bootstrap record (or is GitHub-managed), bootstrap must be READY.
   */
  isWorkspaceReadyForHost(workspaceId: string): boolean {
    return this.withDb((db) => {
      const bindingRow = db.prepare(
        "SELECT access_scope_verified_at_ms FROM github_repository_bindings WHERE workspace_id = ? LIMIT 1;",
      ).get(workspaceId) as { access_scope_verified_at_ms: number | null } | undefined;
      const bootstrapRow = db.prepare(
        "SELECT state FROM workspace_bootstraps WHERE workspace_id = ? LIMIT 1;",
      ).get(workspaceId) as { state: string } | undefined;

      // If workspace is GitHub-managed, access scope MUST have been verified
      if (bindingRow) {
        if (bindingRow.access_scope_verified_at_ms == null) {
          return false;
        }
      }

      if (bindingRow || bootstrapRow) {
        return bootstrapRow !== undefined && bootstrapRow.state === "READY";
      }
      const wsRow = db.prepare("SELECT id FROM workspaces WHERE id = ? LIMIT 1;").get(workspaceId);
      return Boolean(wsRow);
    });
  }

  /**
   * Dedicated method to record that the repository binding's access scope
   * has been verified as restricted to this single repository.
   */
  markRepositoryBindingScopeVerified(workspaceId: string, verifiedAtMs?: number): void {
    const now = verifiedAtMs ?? Date.now();
    this.withDb((db) => {
      const res = db.prepare(`
        UPDATE github_repository_bindings
        SET access_scope_verified_at_ms = ?,
            updated_at_ms = ?
        WHERE workspace_id = ?;
      `).run(now, now, workspaceId);
      if (Number(res.changes) === 0) {
        throw new IdentityError(
          `Cannot mark repository binding scope verified: binding for workspace '${workspaceId}' not found.`,
        );
      }
    });
  }

  /**
   * Dedicated method to clear the access scope verification of a repository binding,
   * indicating that access restriction must be re-verified.
   */
  clearRepositoryBindingScopeVerified(workspaceId: string): void {
    const now = Date.now();
    this.withDb((db) => {
      db.prepare(`
        UPDATE github_repository_bindings
        SET access_scope_verified_at_ms = NULL,
            updated_at_ms = ?
        WHERE workspace_id = ?;
      `).run(now, workspaceId);
    });
  }

  listRepositoryBindingsForInstallation(installationRowId: string): GitHubRepositoryBindingRecord[] {
    return this.withDb((db) => {
      return db.prepare(`
        SELECT id, workspace_id, github_repository_id, github_installation_row_id, owner_account_id, owner_login, repository_name, full_name, branch, created_at_ms, updated_at_ms, access_scope_verified_at_ms
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
    bootstrap: WorkspaceBootstrapRecord;
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
            branch, created_at_ms, updated_at_ms, access_scope_verified_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
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
          input.accessScopeVerifiedAtMs ?? null,
        );

        db.prepare(`
          INSERT INTO workspace_bootstraps (
            workspace_id, bootstrap_version, state, attempt_count,
            last_attempt_id, last_base_commit_sha, ready_commit_sha,
            last_error_kind, last_error_code, last_error_message,
            created_at_ms, updated_at_ms, ready_at_ms
          ) VALUES (?, 1, 'PENDING', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL);
        `).run(workspaceId, nowMs, nowMs);

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
            access_scope_verified_at_ms: input.accessScopeVerifiedAtMs ?? null,
          },
          bootstrap: {
            workspace_id: workspaceId,
            bootstrap_version: 1,
            state: "PENDING",
            attempt_count: 0,
            last_attempt_id: null,
            last_base_commit_sha: null,
            ready_commit_sha: null,
            last_error_kind: null,
            last_error_code: null,
            last_error_message: null,
            created_at_ms: nowMs,
            updated_at_ms: nowMs,
            ready_at_ms: null,
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


  findWorkspaceBootstrapByWorkspaceId(workspaceId: string): WorkspaceBootstrapRecord | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT workspace_id, bootstrap_version, state, attempt_count,
               last_attempt_id, last_base_commit_sha, ready_commit_sha,
               last_error_kind, last_error_code, last_error_message,
               created_at_ms, updated_at_ms, ready_at_ms
        FROM workspace_bootstraps
        WHERE workspace_id = ?
        LIMIT 1;
      `).get(workspaceId);
      return (row as unknown as WorkspaceBootstrapRecord) ?? null;
    });
  }

  getWorkspaceBootstrap(workspaceId: string): WorkspaceBootstrapRecord | null {
    return this.findWorkspaceBootstrapByWorkspaceId(workspaceId);
  }

  beginWorkspaceBootstrapAttempt(workspaceId: string): {
    attemptId: string;
    bootstrap: WorkspaceBootstrapRecord;
  } {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const row = db.prepare(`
          SELECT workspace_id, bootstrap_version, state, attempt_count,
                 last_attempt_id, last_base_commit_sha, ready_commit_sha,
                 last_error_kind, last_error_code, last_error_message,
                 created_at_ms, updated_at_ms, ready_at_ms
          FROM workspace_bootstraps
          WHERE workspace_id = ?
          LIMIT 1;
        `).get(workspaceId) as WorkspaceBootstrapRecord | undefined;

        if (!row) {
          throw new IdentityStructureError(`No workspace bootstrap row found for workspace '${workspaceId}'.`);
        }

        const attemptId = `wba_${crypto.randomUUID()}`;
        const nowMs = Date.now();
        const nextAttemptCount = row.attempt_count + 1;

        db.prepare(`
          UPDATE workspace_bootstraps
          SET state = 'APPLYING',
              attempt_count = ?,
              last_attempt_id = ?,
              ready_commit_sha = NULL,
              ready_at_ms = NULL,
              last_error_kind = NULL,
              last_error_code = NULL,
              last_error_message = NULL,
              updated_at_ms = ?
          WHERE workspace_id = ?;
        `).run(nextAttemptCount, attemptId, nowMs, workspaceId);

        db.exec("COMMIT;");
        return {
          attemptId,
          bootstrap: {
            workspace_id: workspaceId,
            bootstrap_version: row.bootstrap_version,
            state: "APPLYING",
            attempt_count: nextAttemptCount,
            last_attempt_id: attemptId,
            last_base_commit_sha: row.last_base_commit_sha,
            ready_commit_sha: null,
            last_error_kind: null,
            last_error_code: null,
            last_error_message: null,
            created_at_ms: row.created_at_ms,
            updated_at_ms: nowMs,
            ready_at_ms: null,
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
          `Failed to begin workspace bootstrap attempt: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  markWorkspaceBootstrapReady(
    workspaceId: string,
    attemptId: string,
    input: { readyCommitSha: string; baseCommitSha?: string | null },
  ): WorkspaceBootstrapRecord {
    const readySha = normalizeSha(input.readyCommitSha);
    const baseSha = input.baseCommitSha ? normalizeSha(input.baseCommitSha) : null;

    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const row = db.prepare(`
          SELECT workspace_id, bootstrap_version, state, attempt_count,
                 last_attempt_id, last_base_commit_sha, ready_commit_sha,
                 last_error_kind, last_error_code, last_error_message,
                 created_at_ms, updated_at_ms, ready_at_ms
          FROM workspace_bootstraps
          WHERE workspace_id = ?
          LIMIT 1;
        `).get(workspaceId) as WorkspaceBootstrapRecord | undefined;

        if (!row) {
          throw new IdentityStructureError(`No workspace bootstrap row found for workspace '${workspaceId}'.`);
        }

        if (row.last_attempt_id !== attemptId || row.state !== "APPLYING") {
          throw new IdentityConflictError(
            `Stale bootstrap attempt '${attemptId}'; current attempt is '${row.last_attempt_id}' (state: ${row.state}).`,
          );
        }

        const nowMs = Date.now();
        const effectiveBaseSha = baseSha ?? row.last_base_commit_sha;

        const updateRes = db.prepare(`
          UPDATE workspace_bootstraps
          SET state = 'READY',
              ready_commit_sha = ?,
              ready_at_ms = ?,
              last_base_commit_sha = ?,
              last_error_kind = NULL,
              last_error_code = NULL,
              last_error_message = NULL,
              updated_at_ms = ?
          WHERE workspace_id = ? AND last_attempt_id = ? AND state = 'APPLYING';
        `).run(readySha, nowMs, effectiveBaseSha, nowMs, workspaceId, attemptId);

        if (Number(updateRes.changes) !== 1) {
          throw new IdentityConflictError(
            `Concurrent update conflict while marking workspace '${workspaceId}' ready for attempt '${attemptId}'.`,
          );
        }

        db.exec("COMMIT;");
        return {
          workspace_id: workspaceId,
          bootstrap_version: row.bootstrap_version,
          state: "READY",
          attempt_count: row.attempt_count,
          last_attempt_id: attemptId,
          last_base_commit_sha: effectiveBaseSha,
          ready_commit_sha: readySha,
          last_error_kind: null,
          last_error_code: null,
          last_error_message: null,
          created_at_ms: row.created_at_ms,
          updated_at_ms: nowMs,
          ready_at_ms: nowMs,
        };
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        if (error instanceof IdentityError) throw error;
        throw new IdentityDbUnavailable(
          `Failed to mark workspace bootstrap ready: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  markWorkspaceBootstrapRetryableFailure(
    workspaceId: string,
    attemptId: string,
    error: { code: string; message: string; baseCommitSha?: string | null },
  ): WorkspaceBootstrapRecord {
    const baseSha = error.baseCommitSha ? normalizeSha(error.baseCommitSha) : null;
    const safeCode = sanitizeErrorCode(error.code);
    const safeMessage = sanitizeErrorMessage(error.message);

    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const row = db.prepare(`
          SELECT workspace_id, bootstrap_version, state, attempt_count,
                 last_attempt_id, last_base_commit_sha, ready_commit_sha,
                 last_error_kind, last_error_code, last_error_message,
                 created_at_ms, updated_at_ms, ready_at_ms
          FROM workspace_bootstraps
          WHERE workspace_id = ?
          LIMIT 1;
        `).get(workspaceId) as WorkspaceBootstrapRecord | undefined;

        if (!row) {
          throw new IdentityStructureError(`No workspace bootstrap row found for workspace '${workspaceId}'.`);
        }

        if (row.last_attempt_id !== attemptId || row.state !== "APPLYING") {
          throw new IdentityConflictError(
            `Stale bootstrap attempt '${attemptId}'; current attempt is '${row.last_attempt_id}' (state: ${row.state}).`,
          );
        }

        const nowMs = Date.now();
        const effectiveBaseSha = baseSha ?? row.last_base_commit_sha;

        const updateRes = db.prepare(`
          UPDATE workspace_bootstraps
          SET state = 'RETRYABLE_FAILURE',
              last_error_kind = 'retryable',
              last_error_code = ?,
              last_error_message = ?,
              last_base_commit_sha = ?,
              ready_commit_sha = NULL,
              ready_at_ms = NULL,
              updated_at_ms = ?
          WHERE workspace_id = ? AND last_attempt_id = ? AND state = 'APPLYING';
        `).run(safeCode, safeMessage, effectiveBaseSha, nowMs, workspaceId, attemptId);

        if (Number(updateRes.changes) !== 1) {
          throw new IdentityConflictError(
            `Concurrent update conflict while marking workspace '${workspaceId}' retryable failure for attempt '${attemptId}'.`,
          );
        }

        db.exec("COMMIT;");
        return {
          workspace_id: workspaceId,
          bootstrap_version: row.bootstrap_version,
          state: "RETRYABLE_FAILURE",
          attempt_count: row.attempt_count,
          last_attempt_id: attemptId,
          last_base_commit_sha: effectiveBaseSha,
          ready_commit_sha: null,
          last_error_kind: "retryable",
          last_error_code: safeCode,
          last_error_message: safeMessage,
          created_at_ms: row.created_at_ms,
          updated_at_ms: nowMs,
          ready_at_ms: null,
        };
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        if (error instanceof IdentityError) throw error;
        throw new IdentityDbUnavailable(
          `Failed to mark workspace bootstrap retryable failure: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  markWorkspaceBootstrapManualRecovery(
    workspaceId: string,
    attemptId: string,
    error: { code: string; message: string; baseCommitSha?: string | null },
  ): WorkspaceBootstrapRecord {
    const baseSha = error.baseCommitSha ? normalizeSha(error.baseCommitSha) : null;
    const safeCode = sanitizeErrorCode(error.code);
    const safeMessage = sanitizeErrorMessage(error.message);

    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const row = db.prepare(`
          SELECT workspace_id, bootstrap_version, state, attempt_count,
                 last_attempt_id, last_base_commit_sha, ready_commit_sha,
                 last_error_kind, last_error_code, last_error_message,
                 created_at_ms, updated_at_ms, ready_at_ms
          FROM workspace_bootstraps
          WHERE workspace_id = ?
          LIMIT 1;
        `).get(workspaceId) as WorkspaceBootstrapRecord | undefined;

        if (!row) {
          throw new IdentityStructureError(`No workspace bootstrap row found for workspace '${workspaceId}'.`);
        }

        if (row.last_attempt_id !== attemptId || row.state !== "APPLYING") {
          throw new IdentityConflictError(
            `Stale bootstrap attempt '${attemptId}'; current attempt is '${row.last_attempt_id}' (state: ${row.state}).`,
          );
        }

        const nowMs = Date.now();
        const effectiveBaseSha = baseSha ?? row.last_base_commit_sha;

        const updateRes = db.prepare(`
          UPDATE workspace_bootstraps
          SET state = 'MANUAL_RECOVERY',
              last_error_kind = 'manual',
              last_error_code = ?,
              last_error_message = ?,
              last_base_commit_sha = ?,
              ready_commit_sha = NULL,
              ready_at_ms = NULL,
              updated_at_ms = ?
          WHERE workspace_id = ? AND last_attempt_id = ? AND state = 'APPLYING';
        `).run(safeCode, safeMessage, effectiveBaseSha, nowMs, workspaceId, attemptId);

        if (Number(updateRes.changes) !== 1) {
          throw new IdentityConflictError(
            `Concurrent update conflict while marking workspace '${workspaceId}' manual recovery for attempt '${attemptId}'.`,
          );
        }

        db.exec("COMMIT;");
        return {
          workspace_id: workspaceId,
          bootstrap_version: row.bootstrap_version,
          state: "MANUAL_RECOVERY",
          attempt_count: row.attempt_count,
          last_attempt_id: attemptId,
          last_base_commit_sha: effectiveBaseSha,
          ready_commit_sha: null,
          last_error_kind: "manual",
          last_error_code: safeCode,
          last_error_message: safeMessage,
          created_at_ms: row.created_at_ms,
          updated_at_ms: nowMs,
          ready_at_ms: null,
        };
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        if (error instanceof IdentityError) throw error;
        throw new IdentityDbUnavailable(
          `Failed to mark workspace bootstrap manual recovery: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sanitizeErrorMessage(msg: string): string {
  let cleaned = String(msg)
    .replace(/ghp_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/ghs_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/token\s+[^\s]+/gi, "token [REDACTED]")
    .replace(/https:\/\/[^@/\s]+@/g, "https://[REDACTED]@");
  if (cleaned.length > 500) {
    cleaned = cleaned.slice(0, 497) + "...";
  }
  return cleaned;
}

function sanitizeErrorCode(code: string): string {
  const cleaned = String(code).trim().replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase();
  return cleaned.slice(0, 64) || "UNKNOWN_ERROR";
}

const COMMIT_HEX_REGEX = /^[0-9a-fA-F]{40,64}$/;
function normalizeSha(sha: string): string {
  const trimmed = sha.trim();
  if (!COMMIT_HEX_REGEX.test(trimmed)) {
    throw new IdentityStructureError(`Invalid commit SHA format '${sha}'; expected 40-64 hex characters.`);
  }
  return trimmed.toLowerCase();
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
