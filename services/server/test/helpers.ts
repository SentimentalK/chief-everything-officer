import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../src/config.js";
import type { WorkspaceConfig } from "../src/git.js";
import type { AuthIdentity } from "../src/identity/store.js";
import {
  IdentityStore,
  newId,
  provisionEmptyControlPlaneDatabase,
  sha256Hex,
} from "../src/identity/store.js";
import { IdentityService } from "../src/identity/service.js";

export type TestConfig = Config & WorkspaceConfig & { mcpApiKey: string };

export interface SeededIdentity {
  user_id: string;
  workspace_id: string;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

export async function fixture(options: { tempRoot?: string } = {}): Promise<{ root: string; remote: string; config: TestConfig }> {
  const base = options.tempRoot ?? os.tmpdir();
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "ceo-mcp-test-"));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const dataRoot = path.join(root, "data");
  await mkdir(remote);
  git(remote, "init", "--bare", "--initial-branch=main");
  await mkdir(seed);
  git(seed, "init", "--initial-branch=main");
  await mkdir(path.join(seed, "tasks"));
  await mkdir(path.join(seed, "inbox"));
  await writeFile(path.join(seed, "TODO.md"), "# TODO\n\n- Original\n");
  await writeFile(path.join(seed, "SYSTEM.md"), "# System\n");
  await writeFile(path.join(seed, "JOURNAL.md"), "# Journal\n");
  await writeFile(path.join(seed, "tasks", "TEST-001.md"), "# TEST-001\n");
  await writeFile(path.join(seed, "inbox", "测试文章.md"), "# 测试文章\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "seed");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  const config: TestConfig = {
    dataRoot,
    repoDir: path.join(dataRoot, "repo"),
    txnDir: path.join(dataRoot, "txns"),
    stateDir: path.join(dataRoot, "state"),
    branch: "main",
    remoteUrl: remote,
    port: 3000,
    bindHost: "127.0.0.1",
    gitAuthorName: "CEO State MCP Test",
    gitAuthorEmail: "ceo-test@example.com",
    gitCommitterName: "CEO State MCP Committer",
    gitCommitterEmail: "ceo-committer@example.com",
    mcpApiKey: "test-mcp-api-key",
    allowedHosts: ["localhost", "127.0.0.1"],
    allowedOrigins: [],
    protocolAllowedOrigins: [],
    auditDir: path.join(dataRoot, "audit"),
    auditDbPath: path.join(dataRoot, "audit", "ceo-trace.sqlite"),
    identityDbPath: path.join(dataRoot, "identity", "identity.sqlite"),
    contentResolverTimeoutMs: 5000,
    oauthEnabled: false,
    oauthDbPath: path.join(dataRoot, "identity", "oauth.sqlite"),
    oauthDcrEnabled: false,
    oauthDcrDbPath: path.join(dataRoot, "identity", "oauth-dcr.sqlite"),
    githubAppEnabled: false,
  };
  return { root, remote, config };
}

/**
 * Test fixture: empty control-plane schema plus one production-valid
 * user / workspace / owner membership / API key. Inserts via a raw
 * `node:sqlite` connection, then validates with IdentityStore.open.
 */
export function seedIdentity(
  config: Config & { remoteUrl?: string; branch?: string; mcpApiKey?: string },
  apiKey = config.mcpApiKey ?? "test-mcp-api-key",
): SeededIdentity {
  const dbPath = config.identityDbPath;
  provisionEmptyControlPlaneDatabase(dbPath);

  const userId = newId("usr");
  const workspaceId = newId("ws");
  const membershipId = newId("wsm");
  const apiKeyId = newId("ak");
  const nowMs = Date.now();
  const remoteUrl = config.remoteUrl ?? "dummy-remote";
  const branch = config.branch ?? "main";

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES (?, ?, NULL);").run(userId, nowMs);
      db.prepare(
        "INSERT INTO workspaces (id, owner_user_id, remote_url, branch, created_at) VALUES (?, ?, ?, ?, ?);",
      ).run(workspaceId, userId, remoteUrl, branch, nowMs);
      db.prepare(
        "INSERT INTO workspace_memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?);",
      ).run(membershipId, workspaceId, userId, nowMs);
      db.prepare(
        "INSERT INTO api_keys (id, user_id, key_digest, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL);",
      ).run(apiKeyId, userId, sha256Hex(apiKey), nowMs);
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        /* ignore */
      }
      throw error;
    }
  } finally {
    db.close();
  }

  const store = IdentityStore.open(dbPath);
  store.close();
  return { user_id: userId, workspace_id: workspaceId };
}

/** Seeds an identity DB and opens a runtime IdentityService for it. */
export function createIdentityService(
  config: Config & { remoteUrl?: string; branch?: string; mcpApiKey?: string },
  apiKey = config.mcpApiKey ?? "test-mcp-api-key",
): IdentityService {
  seedIdentity(config, apiKey);
  return IdentityService.open(config.identityDbPath);
}

/** Resolve request-scoped identity for a seeded API key. */
export function requestIdentity(service: IdentityService, apiKey: string): AuthIdentity {
  const credential = service.authenticateApiKey(apiKey);
  if (!credential) {
    throw new Error("test fixture: API key did not authenticate");
  }
  return service.resolveRequestIdentity(credential);
}
