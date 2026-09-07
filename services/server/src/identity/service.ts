import {
  type AuthIdentity,
  type WorkspaceIdentity,
  IdentityStore,
  IdentityError,
  sha256Hex,
  provisionEmptyIdentityDatabase,
} from "./store.js";

/**
 * Runtime identity layer. Encapsulates the fixed startup sequence and the
 * per-request credential checks. Each request keeps its own credential source
 * (digest for Bearer, id+user for cookies) but shares the same ownership /
 * error mapping.
 */
export type { AuthIdentity, WorkspaceIdentity };

/**
 * Raised when an authenticated identity resolves to a workspace other than the
 * one this deployment currently serves. HTTP maps this to 403.
 */
export class WorkspaceAccessDeniedError extends IdentityError {}

export interface IdentityOpenOptions {
  remoteUrl: string;
  branch: string;
  envApiKey: string;
}

export interface IdentityInitResult {
  userId: string;
  workspaceId: string;
  created: boolean;
}

export class IdentityService {
  private readonly store: IdentityStore;
  private readonly workspaceIdentity: WorkspaceIdentity;

  private constructor(store: IdentityStore, workspaceIdentity: WorkspaceIdentity) {
    this.store = store;
    this.workspaceIdentity = workspaceIdentity;
  }

  /** The stable workspace identity exposed to MCP tools. Never carries api_key_id. */
  get workspaceIdentityValue(): WorkspaceIdentity {
    return this.workspaceIdentity;
  }

  /**
   * One-time initialization orchestration (drives `cli init`). Atomic on a
   * fresh path: create + validate + seed. On an existing DB: validate binding
   * only — verify remote/branch/user and that the stored active key equals the
   * environment key. It NEVER rotates a key; rotation is exclusive to server
   * startup ({@link IdentityService.open}).
   */
  static initialize(options: IdentityOpenOptions, dbPath: string): IdentityInitResult {
    const store = IdentityStore.openIfMissing(dbPath);
    if (!store) {
      const id = provisionEmptyIdentityDatabase(dbPath, {
        remoteUrl: options.remoteUrl,
        branch: options.branch,
        apiKeyDigest: sha256Hex(options.envApiKey),
      });
      return { userId: id.user_id, workspaceId: id.workspace_id, created: true };
    }
    try {
      const binding = store.loadVerifiedBinding();
      ensureBindingMatches(binding, options);
      const digest = sha256Hex(options.envApiKey);
      if (binding.activeKey.key_digest !== digest) {
        throw new Error(
          `Identity is already initialized under a different active key. Rotate the key by starting the server (startup synchronizes it); re-running init only verifies the existing binding and does not rotate.`,
        );
      }
      return { userId: binding.user.id, workspaceId: binding.workspace.id, created: false };
    } finally {
      store.close();
    }
  }

  /**
   * Runs the fixed startup/validation sequence against an already-existing
   * identity database. Verifies the schema contract + single binding, checks
   * remote/branch against config, then (only here) performs key rotation
   * inside a single transaction if the presented env key differs. Any failure
   * throws and aborts boot. Does NOT create the database.
   */
  static open(options: IdentityOpenOptions, dbPath: string): IdentityService {
    const store = IdentityStore.open(dbPath);
    try {
      const binding = store.loadVerifiedBinding();
      ensureBindingMatches(binding, options);

      const envDigest = sha256Hex(options.envApiKey);
      if (binding.activeKey.key_digest === envDigest) {
        return new IdentityService(store, { user_id: binding.user.id, workspace_id: binding.workspace.id });
      }

      // Rotation is the exclusive privilege of startup: revoke the old active
      // key and bind the new digest to the SAME user in one transaction.
      store.rotateActiveToDigest(envDigest);
      return new IdentityService(store, { user_id: binding.user.id, workspace_id: binding.workspace.id });
    } catch (error) {
      store.close();
      throw error;
    }
  }

  /**
   * Authenticates a raw bearer token. Returns the AuthIdentity, or null when
   * the credential is unknown/revoked or the user is disabled. Reads the
   * current workspace ownership from the DB.
   */
  authenticateApiKey(rawToken: string): AuthIdentity | null {
    if (typeof rawToken !== "string" || rawToken.length === 0) return null;
    return this.store.authenticateByDigest(sha256Hex(rawToken));
  }

  /**
   * Re-derives a previously-authenticated identity from the DB by its
   * api_key_id + user_id (used by cookie sessions). Returns a FRESH identity
   * including the current workspace ownership, or null if the key was revoked /
   * user disabled / ownership no longer resolves. Throws IdentityDbUnavailable
   * on runtime DB faults (so callers can emit 503 without deleting the session).
   */
  revalidateAndOwnership(identity: AuthIdentity): AuthIdentity | null {
    return this.store.resolveAuthIdentityByKey(identity.api_key_id, identity.user_id);
  }

  /** @deprecated use revalidateAndOwnership */
  revalidate(identity: AuthIdentity): boolean {
    return this.revalidateAndOwnership(identity) !== null;
  }

  /** Confirms an AuthIdentity belongs to the single served workspace. */
  holdsWorkspace(identity: AuthIdentity): boolean {
    return identity.workspace_id === this.workspaceIdentity.workspace_id;
  }

  /**
   * Confirms an AuthIdentity belongs to the workspace this deployment serves.
   * Throws WorkspaceAccessDeniedError when it targets another one.
   */
  assertWorkspaceAccess(identity: AuthIdentity): void {
    if (identity.workspace_id !== this.workspaceIdentity.workspace_id) {
      throw new WorkspaceAccessDeniedError(
        `Authenticated identity is bound to workspace '${identity.workspace_id}' but this deployment serves '${this.workspaceIdentity.workspace_id}'.`,
      );
    }
  }

  close(): void {
    this.store.close();
  }
}

function ensureBindingMatches(
  binding: { user: { id: string; disabled_at: number | null }; workspace: { id: string; owner_user_id: string; remote_url: string; branch: string } },
  options: IdentityOpenOptions,
): void {
  if (binding.workspace.remote_url !== options.remoteUrl) {
    throw new Error(
      `Identity workspace remote ('${binding.workspace.remote_url}') does not match CEO_REMOTE ('${options.remoteUrl}'). ` +
        "Refusing to reuse the existing user identity for a different repository.",
    );
  }
  if (binding.workspace.branch !== options.branch) {
    throw new Error(
      `Identity workspace branch ('${binding.workspace.branch}') does not match CEO_BRANCH ('${options.branch}').`,
    );
  }
  if (binding.user.disabled_at != null) {
    throw new Error(
      `Identity user '${binding.user.id}' is disabled and cannot be used to start or authorize access.`,
    );
  }
}
