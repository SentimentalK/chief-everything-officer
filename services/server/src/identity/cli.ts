import { loadConfig } from "../config.js";
import { IdentityStore, provisionEmptyControlPlaneDatabase } from "./store.js";

const USAGE = `Usage: node dist/identity/cli.js <init|grant-admin|revoke-admin> [user_id]`;

function fail(message: string): never {
  process.stderr.write(`identity: ${message}\n`);
  process.exit(1);
}

function main(): void {
  const command = process.argv[2];
  if (command !== "init" && command !== "grant-admin" && command !== "revoke-admin") {
    fail(USAGE);
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (command === "init") {
    try {
      provisionEmptyControlPlaneDatabase(config.identityDbPath);
      process.stdout.write(
        [
          `identity: control-plane database initialized at ${config.identityDbPath}`,
          `  deployment_mode: multi_workspace_runtime`,
          ``,
        ].join("\n"),
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  const userId = process.argv[3];
  if (!userId) {
    fail(USAGE);
  }

  let store: IdentityStore;
  try {
    store = IdentityStore.open(config.identityDbPath);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  try {
    if (command === "grant-admin") {
      store.grantAdmin(userId);
      process.stdout.write(`identity: granted admin to ${userId}\n`);
    } else {
      store.revokeAdmin(userId);
      process.stdout.write(`identity: revoked admin from ${userId}\n`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    store.close();
  }
}

main();
