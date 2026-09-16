import fs from "node:fs";
import { loadConfig } from "./config.js";
import { IdentityStore } from "./identity/store.js";
import { GitHubAppClient } from "./github/app-client.js";
import { WorkspaceBootstrapService } from "./github/bootstrap-service.js";
import {
  ExistingWorkspaceAdoptionError,
  ExistingWorkspaceAdoptionService,
  formatAdoptionPlan,
  parseMigrateExistingWorkspaceArgs,
} from "./github/existing-workspace-adoption.js";

const USAGE = `Usage: node dist/migrate-existing-workspace.js [options]

Operator-only existing-workspace adoption. Defaults to dry-run (zero DB writes, zero Git writes).
Pass --apply to mutate.

Required:
  --workspace-id <id>
  --expected-user-id <id>
  --installation-id <github-installation-id>
  --repo-id <id>
  --owner-account-id <id>
  --owner <login>
  --repo <name>
  --branch <branch>
  --expected-remote <exact-remote-url>

Optional:
  --expect-existing-anchors
  --expect-no-repo-write
  --apply
`;

function fail(message: string, exitCode = 1): never {
  process.stderr.write(`migrate-existing-workspace: ${message}\n`);
  process.exit(exitCode);
}

function redact(text: string): string {
  return text
    .replace(/ghs_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/ghp_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  let cli;
  try {
    cli = parseMigrateExistingWorkspaceArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`${redact(message)}\n\n${USAGE}`);
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (!config.githubAppEnabled) {
    fail("CEO_GITHUB_APP_ENABLED must be true to run existing-workspace adoption.");
  }

  const store = IdentityStore.open(config.identityDbPath);

  try {
    const privateKey = fs.readFileSync(config.githubAppPrivateKeyPath!, "utf8");
    const appClient = new GitHubAppClient({
      clientId: config.githubAppClientId!,
      privateKey,
    });
    const bootstrapService = new WorkspaceBootstrapService({ appClient, store });
    const adoption = new ExistingWorkspaceAdoptionService({
      store,
      appClient,
      bootstrapService,
    });

    const plan = await adoption.plan(cli);
    process.stdout.write(`${formatAdoptionPlan(plan)}\n`);

    if (plan.action === "CONFLICT") {
      fail(plan.reason ?? "Adoption conflict.", 1);
    }

    if (!cli.apply) {
      process.stdout.write("Dry-run only. No DB writes. No Git writes. Re-run with --apply to mutate.\n");
      return;
    }

    const result = await adoption.apply(cli);
    if (result.bootstrap.state !== "READY") {
      fail(
        `Bootstrap state is ${result.bootstrap.state}; migration is not complete.`,
      );
    }
    process.stdout.write(
      [
        "Migration apply complete.",
        `Action: ${result.action}`,
        `Bootstrap: ${result.bootstrap.state}`,
        `Workspace: ${result.db.workspace.id}`,
        `Remote: ${result.db.workspace.remote_url}`,
        `HEAD: ${result.gitSnapshotAfter?.headSha ?? result.bootstrap.ready_commit_sha ?? "(not captured)"}`,
        "",
      ].join("\n"),
    );
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    const exitCode = error instanceof ExistingWorkspaceAdoptionError ? error.exitCode : 1;
    fail(message, exitCode);
  } finally {
    store.close();
  }
}

void main();
