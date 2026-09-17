import fs from "node:fs";
import path from "node:path";
import {
  type AuthIdentity,
  type CredentialIdentity,
  type WorkspaceIdentity,
  IdentityStore,
  IdentityError,
  IdentityStructureError,
  provisionEmptyIdentityDatabase,
  sha256Hex,
} from "./store.js";


/**
 * Runtime identity layer. Encapsulates the process-scoped startup sequence
 * and per-request credential checks. Each request keeps its own credential source
 * (digest for Bearer, id+user for cookies) while authorizing against request-scoped workspaces.
 */
export type { AuthIdentity, CredentialIdentity, WorkspaceIdentity };

/**
 * Raised when an authenticated identity cannot access the requested workspace.
 * HTTP maps this to 403.
 */
export class WorkspaceAccessDeniedError extends IdentityError {}
export class WorkspaceSelectionRequiredError extends IdentityError {}
export { IdentityDbUnavailable } from "./store.js";

/**
 * Optional binding for a workspace-scoped IdentityService.
 * When present, the service validates API keys and resolves ownership relative
 * to the bound workspace and its owner user.
 */
interface ScopedBinding {
  workspace_id: string;
  user_id: string;
}

export class IdentityService {
  /**
   * @param store The underlying IdentityStore
   * @param binding Optional workspace/user binding for startup-scoped services.
   *   When absent, resolveRequestIdentity() dynamically discovers the workspace
   *   from the credential's memberships (multi-tenant control-plane path).
   */
  constructor(
    public readonly store: IdentityStore,
    private readonly binding?: ScopedBinding,
  ) {}

  /** The underlying IdentityStore instance. */
  get storeInstance(): IdentityStore {
    return this.store;
  }

  /**
   * Transitional helper: returns the workspace identity bound at startup.
   * Only valid when the service was opened with workspace-binding options.
   * @deprecated Use resolveRequestIdentity(credential) for request-scoped identity instead.
   */
  get workspaceIdentityValue(): WorkspaceIdentity {
    if (this.binding) {
      return { user_id: this.binding.user_id, workspace_id: this.binding.workspace_id };
    }
    // Fallback for bare open(dbPath): use loadVerifiedBinding (asserts exactly 1 user+workspace).
    const b = this.store.loadVerifiedBinding();
    return { user_id: b.user.id, workspace_id: b.workspace.id };
  }

  // ---------------------------------------------------------------------------
  // Static factory methods
  // ---------------------------------------------------------------------------

  /**
   * Opens an existing identity database and validates its schema.
   * Without options: does NOT assume or bind any deployment workspace (control-plane path).
   * With legacy options: validates workspace binding by remoteUrl+branch, performs key lifecycle
   * (rotation if env key differs, validation if already active), fails if owner user is disabled.
   */
  static open(dbPath: string): IdentityService;
  static open(options: { remoteUrl: string; branch: string; envApiKey: string }, dbPath: string): IdentityService;
  static open(
    dbPathOrOptions: string | { remoteUrl: string; branch: string; envApiKey: string },
    maybeDbPath?: string,
  ): IdentityService {
    if (typeof dbPathOrOptions === "string") {
      // Bare open: control-plane path, no binding
      const store = IdentityStore.open(dbPathOrOptions);
      return new IdentityService(store);
    }

    // Workspace-scoped open: legacy startup path
    const options = dbPathOrOptions;
    const dbPath = maybeDbPath as string;
    const store = IdentityStore.open(dbPath);

    // Find the workspace by remoteUrl+branch (throws IdentityStructureError on 0 or >1 matches)
    const scoped = store.loadScopedWorkspaceBinding(options.remoteUrl, options.branch);
    const userId = scoped.user.id;
    const workspaceId = scoped.workspace.id;

    // Perform key lifecycle: check if env key is already active or needs rotation
    const envDigest = sha256Hex(options.envApiKey);
    const existingKey = store.findKeyByDigest(envDigest);

    if (existingKey) {
      if (existingKey.revoked_at != null) {
        store.close();
        throw new IdentityStructureError(
          "The configured MCP_API_KEY matches a previously revoked key. A replaced key is created fresh; revoked credentials are not revived.",
        );
      }
      if (existingKey.user_id !== userId) {
        store.close();
        throw new IdentityStructureError(
          `The configured MCP_API_KEY is already bound to another user ('${existingKey.user_id}'). Cannot rebind credentials across users.`,
        );
      }
      // Key is already active for this user — no rotation needed
    } else {
      // Env key is unknown: rotate from the current active key for this workspace's owner
      const activeKeys = store.getActiveKeysForUser(userId);
      if (activeKeys.length === 0) {
        store.close();
        throw new IdentityStructureError(`User '${userId}' has no active API keys to rotate.`);
      }
      if (activeKeys.length > 1) {
        store.close();
        throw new IdentityStructureError(
          `Ambiguous key rotation: user '${userId}' has multiple active keys (${activeKeys.length}). Cannot choose which key to rotate.`,
        );
      }
      // Rotate: revoke old, insert new
      store.rotateUserKeyToDigest(userId, activeKeys[0]!.id, envDigest);
    }

    return new IdentityService(store, { workspace_id: workspaceId, user_id: userId });
  }

  /**
   * Provision-or-verify: if the database doesn't exist, provisions it and returns `created: true`.
   * If it already exists, validates the workspace binding and key match. Never rotates on init.
   * Throws IdentityStructureError if the existing DB has a different active key.
   */
  static initialize(
    options: { remoteUrl: string; branch: string; envApiKey: string },
    dbPath: string,
  ): { userId: string; workspaceId: string; created: boolean } {
    const resolved = path.resolve(dbPath);

    if (!fs.existsSync(resolved)) {
      // Provision a new database
      const id = provisionEmptyIdentityDatabase(dbPath, {
        remoteUrl: options.remoteUrl,
        branch: options.branch,
        apiKeyDigest: sha256Hex(options.envApiKey),
      });
      return { userId: id.user_id, workspaceId: id.workspace_id, created: true };
    }

    // Validate existing database
    const store = IdentityStore.open(dbPath);
    try {
      const scoped = store.loadScopedWorkspaceBinding(options.remoteUrl, options.branch);
      const userId = scoped.user.id;
      const workspaceId = scoped.workspace.id;

      // Verify the env key matches the current active key (never rotate)
      const envDigest = sha256Hex(options.envApiKey);
      const activeKeys = store.getActiveKeysForUser(userId);
      const activeKey = activeKeys[0];
      if (!activeKey || activeKey.key_digest !== envDigest) {
        throw new IdentityStructureError(
          `Identity database has a different active key for user '${userId}'. init does not rotate — use server startup.`,
        );
      }

      return { userId, workspaceId, created: false };
    } finally {
      store.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Per-request authentication
  // ---------------------------------------------------------------------------

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
   * Resolves the request-scoped workspace AuthIdentity for an authenticated credential.
   * Deterministic rule:
   * - 0 memberships -> throws WorkspaceAccessDeniedError (403)
   * - 1 membership  -> selects and returns AuthIdentity for that workspace
   * - >1 memberships -> throws WorkspaceSelectionRequiredError (403/409)
   */
  resolveRequestIdentity(credential: CredentialIdentity): AuthIdentity {
    const memberships = this.store.listWorkspaceMembershipsForUser(credential.user_id);
    if (memberships.length === 0) {
      throw new WorkspaceAccessDeniedError(
        `Authenticated user '${credential.user_id}' workspace access denied (no accessible workspaces).`,
      );
    }
    if (memberships.length > 1) {
      throw new WorkspaceSelectionRequiredError(
        `Authenticated user '${credential.user_id}' has multiple accessible workspaces (${memberships.length}). Workspace selection required.`,
      );
    }
    return {
      user_id: credential.user_id,
      api_key_id: credential.api_key_id,
      workspace_id: memberships[0]!.workspace_id,
    };
  }

  /**
   * Asserts that the credential has access to this service's bound workspace.
   * If the service has no binding, falls back to resolveRequestIdentity.
   * Throws WorkspaceAccessDeniedError (403) if not authorized.
   * @deprecated Use resolveRequestIdentity for the multi-tenant path.
   */
  assertWorkspaceAccess(credential: CredentialIdentity): AuthIdentity {
    if (!this.binding) {
      return this.resolveRequestIdentity(credential);
    }

    const memberships = this.store.listWorkspaceMembershipsForUser(credential.user_id);
    const match = memberships.find((m) => m.workspace_id === this.binding!.workspace_id);
    if (!match) {
      throw new WorkspaceAccessDeniedError(
        `Authenticated user '${credential.user_id}' does not have access to workspace '${this.binding.workspace_id}'.`,
      );
    }
    return {
      user_id: credential.user_id,
      api_key_id: credential.api_key_id,
      workspace_id: this.binding.workspace_id,
    };
  }

  /**
   * Revalidates a credential: returns true if the key is still active and the user enabled.
   * @deprecated Use resolveRequestIdentity for request-scoped validation.
   */
  revalidate(credential: CredentialIdentity): boolean {
    return this.store.resolveCredentialByKey(credential.api_key_id, credential.user_id) !== null;
  }

  /**
   * Revalidates a credential and returns the ownership AuthIdentity if valid for this
   * service's bound workspace. Returns null if the credential is no longer valid or
   * does not have access to the bound workspace.
   * @deprecated Use resolveRequestIdentity for the modern request-scoped path.
   */
  revalidateAndOwnership(credential: { api_key_id: string; user_id: string }): AuthIdentity | null {
    const resolved = this.store.resolveCredentialByKey(credential.api_key_id, credential.user_id);
    if (!resolved) return null;

    if (this.binding) {
      const memberships = this.store.listWorkspaceMembershipsForUser(credential.user_id);
      const match = memberships.find((m) => m.workspace_id === this.binding!.workspace_id);
      if (!match) return null;
      return { user_id: credential.user_id, api_key_id: credential.api_key_id, workspace_id: this.binding.workspace_id };
    }

    // No binding: try to resolve single membership
    const memberships = this.store.listWorkspaceMembershipsForUser(credential.user_id);
    if (memberships.length !== 1) return null;
    return { user_id: credential.user_id, api_key_id: credential.api_key_id, workspace_id: memberships[0]!.workspace_id };
  }

  close(): void {
    this.store.close();
  }
}
