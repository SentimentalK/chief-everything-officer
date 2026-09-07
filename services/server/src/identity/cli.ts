import { loadConfig } from "../config.js";
import { IdentityService } from "./service.js";

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
    const result = IdentityService.initialize(
      { remoteUrl: config.remoteUrl, branch: config.branch, envApiKey: config.mcpApiKey },
      config.identityDbPath,
    );
    process.stdout.write(
      [
        `identity: initialization ${result.created ? "completed" : "already-initialized, unchanged"}`,
        `  user_id:      ${result.userId}`,
        `  workspace_id: ${result.workspaceId}`,
        `  deployment_mode: single_user`,
        ``,
      ].join("\n"),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main();
