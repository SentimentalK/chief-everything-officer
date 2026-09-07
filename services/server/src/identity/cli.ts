import { IdentityStore, provisionEmptyIdentityDatabase, sha256Hex } from "./store.js";
import type { WorkspaceIdentity } from "./store.js";
import fs from "node:fs";
import { loadConfig } from "../config.js";

const USAGE = `Usage: node dist/identity/cli.js init`;

interface InitResult {
  userId: string;
  workspaceId: string;
  created: boolean;
}

function fail(message: string): never {
  process.stderr.write(`identity: ${message}\n`);
  process.exit(1);
}

function banner(): void {
  if (process.argv[2] !== "init") {
    fail(USAGE);
  }
}
function freshSeed(dbPath: string, remoteUrl: string, branch: string, apiKeyDigest: string): WorkspaceIdentity {
  try {
    return provisionEmptyIdentityDatabase(dbPath, { remoteUrl, branch, apiKeyDigest });
  } catch (error) {
    if (error instanceof Error) {
      fail(error.message);
    }
    fail("identity provisioning failed");
  }
}

/**
 * Idempotent init against an existing, valid database. Refuses to rebind an
 * existing user identity to different remote/branch or to revive a disabled
 * user or a revoked credential. Returns the existing (stable) user/workspace.
 */
function reconcileExisting(store: IdentityStore, remoteUrl: string, branch: string, apiKeyDigest: string): InitResult {
  store.validateRuntimeShape();

  const binding = store.workspaceBinding();
  if (binding.remote_url !== remoteUrl) {
    fail(
      `existing identity workspace remote ('${binding.remote_url}') differs from CEO_REMOTE ('${remoteUrl}'). ` +
        "Not rebinding existing production identity to a different repository.",
    );
  }
  if (binding.branch !== branch) {
    fail(
      `existing identity workspace branch ('${binding.branch}') differs from CEO_BRANCH ('${branch}'). ` +
        "Not rebinding existing production identity to a different branch.",
    );
  }

  const snapshot = store.snapshot();
  if (snapshot.user.disabled_at != null) {
    fail(`identity user '${snapshot.user.id}' is disabled; refusing to re-enable it.`);
  }

  const active = snapshot.activeKey;
  if (!active) {
    fail("existing identity database has no active key; refusing to guess.");
  }

  let created = false;
  if (active.key_digest !== apiKeyDigest) {
    if (store.isRevokedDigest(apiKeyDigest)) {
      fail(
        "configured MCP_API_KEY matches a previously revoked key; a replaced key must be created fresh, " +
          "revoked credentials are not revived.",
      );
    }
    // Bind the new key to the same, still-enabled user.
    store.rotateToDigest(apiKeyDigest);
    created = true;
  }

  return {
    userId: snapshot.user.id,
    workspaceId: snapshot.workspace.id,
    created,
  };
}

function runInit(): InitResult {
  const config = loadConfig();
  const dbPath = config.identityDbPath;
  const digest = sha256Hex(config.mcpApiKey);

  if (!fs.existsSync(dbPath)) {
    const id = freshSeed(dbPath, config.remoteUrl, config.branch, digest);
    return { userId: id.user_id, workspaceId: id.workspace_id, created: true };
  }

  // Existing database: validate + reconcile. Does NOT create the file.
  let store: IdentityStore;
  try {
    store = IdentityStore.open(dbPath);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  try {
    return reconcileExisting(store, config.remoteUrl, config.branch, digest);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    store.close();
  }
}

function main(): void {
  banner();
  const result = runInit();
  process.stdout.write(
    [
      `identity: initialization ${result.created ? "completed" : "already-initialized, unchanged"}`,
      `  user_id:      ${result.userId}`,
      `  workspace_id: ${result.workspaceId}`,
      `  deployment_mode: single_user`,
      ``,
    ].join("\n"),
  );
}

main();
