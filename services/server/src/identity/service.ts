import {
  type AuthIdentity,
  type CredentialIdentity,
  type WorkspaceIdentity,
  IdentityStore,
  IdentityError,
  IdentityStructureError,
  sha256Hex,
  provisionEmptyIdentityDatabase,
} from "./store.js";

/**
 * Runtime identity layer. Encapsulates the process-scoped startup sequence
 * and per-request credential checks. Each request keeps its own credential source
 * (digest for Bearer, id+user for cookies) while authorizing against the process's
 * explicitly selected transitional runtime workspace.
 */
export type { AuthIdentity, CredentialIdentity, WorkspaceIdentity };

/**
 * Raised when an authenticated identity resolves to a user/workspace other than
 * the one this deployment currently serves. HTTP maps this to 403.
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

  /** The underlying IdentityStore instance. */
  get storeInstance(): IdentityStore {
    return this.store;
  }

  /**
   * One-time initialization orchestration (drives `cli init`). Atomic on a
   * fresh path: create + validate + seed. On an existing DB: validate the
   * configured runtime workspace and configured env key only. It NEVER rotates
   * a key; rotation is exclusive to server startup ({@link IdentityService.open}).
   * Extra unrelated database rows are tolerated.
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
      const scoped = store.loadScopedWorkspaceBinding(options.remoteUrl, options.branch);
      const digest = sha256Hex(options.envApiKey);
      const keyRow = store.findKeyByDigest(digest);
      if (!keyRow || keyRow.user_id !== scoped.user.id || keyRow.revoked_at != null) {
        throw new Error(
          `Identity is already initialized under a different active key. Rotate the key by starting the server (startup synchronizes it); re-running init only verifies the existing binding and does not rotate.`,
        );
      }
      return { userId: scoped.user.id, workspaceId: scoped.workspace.id, created: false };
    } finally {
      store.close();
    }
  }

  /**
   * Runs the process-scoped startup/validation sequence against an existing
   * identity database. Selects the single runtime workspace matching CEO_REMOTE + CEO_BRANCH,
   * verifies owner exists and is enabled, and synchronizes MCP_API_KEY scoped
   * to that selected owner only. Unrelated users/workspaces/credentials are tolerated.
   * Any failure throws and aborts boot. Does NOT create the database.
   */
  static open(options: IdentityOpenOptions, dbPath: string): IdentityService {
    const store = IdentityStore.open(dbPath);
    try {
      const scoped = store.loadScopedWorkspaceBinding(options.remoteUrl, options.branch);

      const envDigest = sha256Hex(options.envApiKey);
      const keyRow = store.findKeyByDigest(envDigest);

      if (keyRow) {
        if (keyRow.revoked_at != null) {
          throw new IdentityStructureError(
            "The configured MCP_API_KEY matches a previously revoked key. A replaced key is created fresh; revoked credentials are not revived.",
          );
        }
        if (keyRow.user_id !== scoped.user.id) {
          throw new IdentityStructureError(
            `The configured MCP_API_KEY is already bound to another user ('${keyRow.user_id}'). Cannot rebind credentials across users.`,
          );
        }
        // Active credential already owned by selected workspace owner: startup succeeds.
        return new IdentityService(store, { user_id: scoped.user.id, workspace_id: scoped.workspace.id });
      }

      // Env key is unknown: inspect active keys for the selected owner.
      const activeKeys = store.getActiveKeysForUser(scoped.user.id);
      if (activeKeys.length === 0) {
        throw new IdentityStructureError(
          `User '${scoped.user.id}' has no active API keys to rotate.`,
        );
      }
      if (activeKeys.length > 1) {
        throw new IdentityStructureError(
          `Ambiguous key rotation: user '${scoped.user.id}' has multiple active keys (${activeKeys.length}). Cannot determine which key to rotate to the configured MCP_API_KEY.`,
        );
      }

      const expectedKey = activeKeys[0]!;
      // Owner has exactly 1 active key: rotate it atomically inside the store.
      store.rotateUserKeyToDigest(scoped.user.id, expectedKey.id, envDigest);
      return new IdentityService(store, { user_id: scoped.user.id, workspace_id: scoped.workspace.id });
    } catch (error) {
      store.close();
      throw error;
    }
  }

  /**
   * Authenticates a raw bearer token. Returns CredentialIdentity, or null when
   * the credential is unknown/revoked or the user is disabled.
   * Does NOT guess or attach any workspace.
   */
  authenticateApiKey(rawToken: string): CredentialIdentity | null {
    if (typeof rawToken !== "string" || rawToken.length === 0) return null;
    return this.store.authenticateCredentialByDigest(sha256Hex(rawToken));
  }

  /**
   * Re-derives an identity from a known api_key_id + user_id (used by cookie sessions).
   * Authenticates the credential in the DB first without selecting an arbitrary workspace,
   * then applies runtime workspace authorization explicitly. Returns a fresh AuthIdentity,
   * or null if the key was revoked / user disabled / user lacks access to this deployment's workspace.
   * Throws IdentityDbUnavailable on runtime DB faults.
   */
  revalidateAndOwnership(identity: { api_key_id: string; user_id: string }): AuthIdentity | null {
    const cred = this.store.resolveCredentialByKey(identity.api_key_id, identity.user_id);
    if (!cred) return null;
    if (!this.holdsWorkspace(cred)) return null;
    return {
      user_id: cred.user_id,
      api_key_id: cred.api_key_id,
      workspace_id: this.workspaceIdentity.workspace_id,
    };
  }

  /** @deprecated use revalidateAndOwnership */
  revalidate(identity: { api_key_id: string; user_id: string }): boolean {
    return this.revalidateAndOwnership(identity) !== null;
  }

  /**
   * Confirms whether an authenticated identity is authorized for the served runtime workspace
   * based on workspace membership for the selected runtime workspace.
   */
  holdsWorkspace(identity: CredentialIdentity | AuthIdentity): boolean {
    if ("workspace_id" in identity && identity.workspace_id !== this.workspaceIdentity.workspace_id) {
      return false;
    }
    return this.store.hasWorkspaceAccess(this.workspaceIdentity.workspace_id, identity.user_id);
  }

  /**
   * Authorizes an authenticated identity against the served runtime workspace.
   * Produces the request AuthIdentity scoped to the current runtime workspace,
   * or throws WorkspaceAccessDeniedError if the user lacks workspace access.
   */
  assertWorkspaceAccess(identity: CredentialIdentity | AuthIdentity): AuthIdentity {
    if ("workspace_id" in identity && identity.workspace_id !== this.workspaceIdentity.workspace_id) {
      throw new WorkspaceAccessDeniedError(
        `Authenticated identity is bound to workspace '${identity.workspace_id}' but this deployment serves '${this.workspaceIdentity.workspace_id}'.`,
      );
    }
    if (!this.store.hasWorkspaceAccess(this.workspaceIdentity.workspace_id, identity.user_id)) {
      throw new WorkspaceAccessDeniedError(
        `Authenticated user '${identity.user_id}' workspace access denied for '${this.workspaceIdentity.workspace_id}'.`,
      );
    }
    return {
      user_id: identity.user_id,
      api_key_id: identity.api_key_id,
      workspace_id: this.workspaceIdentity.workspace_id,
    };
  }

  close(): void {
    this.store.close();
  }
}
