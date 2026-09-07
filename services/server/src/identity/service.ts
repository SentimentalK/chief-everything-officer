import {
  type AuthIdentity,
  type WorkspaceIdentity,
  IdentityStore,
  IdentityError,
  IdentityStructureError,
  IdentityDbUnavailable,
  sha256Hex,
} from "./store.js";

/**
 * Runtime identity layer. Encapsulates the fixed startup sequence and the
 * per-request credential check. Imported error types facilitate distinguishing
 * startup failures (structure/binding) from runtime availability faults.
 */
export type { AuthIdentity, WorkspaceIdentity };
export { IdentityStructureError, IdentityDbUnavailable };

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
   * Runs the fixed startup/validation sequence against an already-existing
   * identity database. Order:
   *   validateRuntimeShape (single user/workspace/active key, structure)
   *   -> verify stored remote/branch/owner match current config
   *   -> verify user is enabled
   *   -> rotate to env key if needed (revoke old active, bind same user)
   *
   * Any failure throws and aborts boot. Does NOT create the database.
   */
  static open(options: IdentityOpenOptions, dbPath: string): IdentityService {
    const store = IdentityStore.open(dbPath);
    try {
      store.validateRuntimeShape();

      // Remote/branch must match on EVERY start, not just the second `init`.
      const binding = store.workspaceBinding();
      if (binding.remote_url !== options.remoteUrl) {
        throw new Error(
          `Identity workspace remote ('${binding.remote_url}') does not match CEO_REMOTE ('${options.remoteUrl}'). ` +
            "Refusing to reuse the existing user identity for a different repository.",
        );
      }
      if (binding.branch !== options.branch) {
        throw new Error(
          `Identity workspace branch ('${binding.branch}') does not match CEO_BRANCH ('${options.branch}').`,
        );
      }

      const envDigest = sha256Hex(options.envApiKey);
      const active = store.activeKeyRow();
      if (active.key_digest === envDigest) {
        // Key unchanged.
        return new IdentityService(store, store.workspaceIdentity());
      }

      // Key differs: must be a rotation of the active key, not a re-activation
      // of a previously revoked credential.
      if (store.isRevokedDigest(envDigest)) {
        throw new Error(
          "The configured MCP_API_KEY matches a previously revoked key. " +
            "A replaced key is created fresh; revoked credentials are not revived.",
        );
      }

      // Rotate: revoke the current active key and bind the new digest to the
      // same, still-enabled user. ActiveKeyRow already verifies user enabled.
      store.rotateToDigest(envDigest);

      return new IdentityService(store, store.workspaceIdentity());
    } catch (error) {
      store.close();
      throw error;
    }
  }

  /**
   * Authenticates a raw bearer token. Returns the request AuthIdentity, or null
   * when the credential is unknown/revoked/user-disabled. Ownership of the
   * served workspace is already enforced by the schema join; the service-layer
   * 403 check is applied by callers comparing to workspaceIdentityValue.
   */
  authenticateApiKey(rawToken: string): AuthIdentity | null {
    if (typeof rawToken !== "string" || rawToken.length === 0) return null;
    return this.store.authenticateByDigest(sha256Hex(rawToken));
  }

  /**
   * Confirms an AuthIdentity is authorized for the workspace this deployment
   * serves. Throws WorkspaceAccessDeniedError when it targets another one.
   */
  assertWorkspaceAccess(identity: AuthIdentity): void {
    if (identity.workspace_id !== this.workspaceIdentity.workspace_id) {
      throw new WorkspaceAccessDeniedError(
        `Authenticated identity is bound to workspace '${identity.workspace_id}' but this deployment serves '${this.workspaceIdentity.workspace_id}'.`,
      );
    }
  }

  /** Re-validates a previously authenticated identity (used by session reuse). */
  revalidate(identity: AuthIdentity): boolean {
    return this.store.revalidateKey(identity.api_key_id, identity.user_id);
  }

  close(): void {
    this.store.close();
  }
}
