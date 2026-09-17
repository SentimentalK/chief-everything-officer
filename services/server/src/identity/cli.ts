import { loadConfig } from "../config.js";
import { provisionEmptyControlPlaneDatabase } from "./store.js";

const USAGE = `Usage: node dist/identity/cli.js init`;

function fail(message: string): never {
  process.stderr.write(`identity: ${message}\n`);
  process.exit(1);
}

function main(): void {
  if (process.argv[2] !== "init") {
    fail(USAGE);
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

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
}

main();
