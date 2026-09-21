import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CeoError } from "../src/errors.js";
import { CeoWorkspace } from "../src/workspace.js";
import { WorkspaceRuntimeRegistry } from "../src/runtime/registry.js";
import { IdentityStore, provisionEmptyControlPlaneDatabase, newId } from "../src/identity/store.js";
import { fixture, git } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Multi-User Git Commit Attribution & Provenance", () => {
  it("isolates Git Author per workspace and keeps CEO bot as Committer", async () => {
    const itemA = await fixture();
    cleanup.push(itemA.root);

    const workspaceA = new CeoWorkspace({
      ...itemA.config,
      gitAuthorName: "user-alice",
      gitAuthorEmail: "alice@example.com",
      gitCommitterName: "CEO State MCP",
      gitCommitterEmail: "ceo-mcp@users.noreply.github.com",
    });
    await workspaceA.initialize();

    const readA = await workspaceA.readFiles(["TODO.md"]);
    const todoA = (readA.files as any[]).find((f) => f.path === "TODO.md")!;
    const resA = await workspaceA.applyChangeSet({
      request_id: randomUUID(),
      base_commit: readA.base_commit as string,
      summary: "Alice update",
      operations: [
        { op: "replace", path: "TODO.md", expected_blob_oid: todoA.blob_oid, content: "# TODO\n\n- Alice\n" },
      ],
    });

    // Check commit author & committer in Workspace A
    const logA = git(itemA.remote, "log", "-1", "--format=%an|%ae|%cn|%ce", resA.commit);
    expect(logA).toBe("user-alice|alice@example.com|CEO State MCP|ceo-mcp@users.noreply.github.com");

    const itemB = await fixture();
    cleanup.push(itemB.root);

    const workspaceB = new CeoWorkspace({
      ...itemB.config,
      gitAuthorName: "user-bob",
      gitAuthorEmail: "bob@example.com",
      gitCommitterName: "CEO State MCP",
      gitCommitterEmail: "ceo-mcp@users.noreply.github.com",
    });
    await workspaceB.initialize();

    const readB = await workspaceB.readFiles(["TODO.md"]);
    const todoB = (readB.files as any[]).find((f) => f.path === "TODO.md")!;
    const resB = await workspaceB.applyChangeSet({
      request_id: randomUUID(),
      base_commit: readB.base_commit as string,
      summary: "Bob update",
      operations: [
        { op: "replace", path: "TODO.md", expected_blob_oid: todoB.blob_oid, content: "# TODO\n\n- Bob\n" },
      ],
    });

    // Check commit author & committer in Workspace B
    const logB = git(itemB.remote, "log", "-1", "--format=%an|%ae|%cn|%ce", resB.commit);
    expect(logB).toBe("user-bob|bob@example.com|CEO State MCP|ceo-mcp@users.noreply.github.com");

    // Cross-contamination verification: Alice never appears in B, Bob never appears in A
    const allLogsA = git(itemA.remote, "log", "--format=%an|%ae");
    expect(allLogsA).not.toContain("bob");
    const allLogsB = git(itemB.remote, "log", "--format=%an|%ae");
    expect(allLogsB).not.toContain("alice");
  });

  it("completely ignores legacy CEO_GIT_AUTHOR_NAME and CEO_GIT_AUTHOR_EMAIL env vars", async () => {
    const oldEnvName = process.env.CEO_GIT_AUTHOR_NAME;
    const oldEnvEmail = process.env.CEO_GIT_AUTHOR_EMAIL;

    try {
      process.env.CEO_GIT_AUTHOR_NAME = "Global Spoofed Human";
      process.env.CEO_GIT_AUTHOR_EMAIL = "spoofed@global.org";

      const item = await fixture();
      cleanup.push(item.root);

      const workspace = new CeoWorkspace({
        ...item.config,
        gitAuthorName: "real-owner",
        gitAuthorEmail: "real-owner@domain.com",
        gitCommitterName: "CEO State MCP",
        gitCommitterEmail: "ceo-mcp@users.noreply.github.com",
      });
      await workspace.initialize();

      const read = await workspace.readFiles(["TODO.md"]);
      const todo = (read.files as any[]).find((f) => f.path === "TODO.md")!;
      const res = await workspace.applyChangeSet({
        request_id: randomUUID(),
        base_commit: read.base_commit as string,
        summary: "Verify env ignored",
        operations: [
          { op: "replace", path: "TODO.md", expected_blob_oid: todo.blob_oid, content: "# TODO\n\n- Genuine\n" },
        ],
      });

      const log = git(item.remote, "log", "-1", "--format=%an|%ae", res.commit);
      expect(log).toBe("real-owner|real-owner@domain.com");
      expect(log).not.toContain("Spoofed");
    } finally {
      if (oldEnvName === undefined) delete process.env.CEO_GIT_AUTHOR_NAME;
      else process.env.CEO_GIT_AUTHOR_NAME = oldEnvName;
      if (oldEnvEmail === undefined) delete process.env.CEO_GIT_AUTHOR_EMAIL;
      else process.env.CEO_GIT_AUTHOR_EMAIL = oldEnvEmail;
    }
  });

  it("fails fast at WorkspaceRuntimeRegistry initialization when owner GitHub identity is incomplete (INVALID_WORKSPACE_STATE)", async () => {
    const item = await fixture();
    cleanup.push(item.root);

    const dbPath = path.join(item.root, "identity.db");
    provisionEmptyControlPlaneDatabase(dbPath);
    const store = IdentityStore.open(dbPath);

    // Seed raw DB row with missing provider_email
    const raw = new DatabaseSync(dbPath);
    const userId = newId("usr");
    const extId = newId("ext");
    const now = Date.now();
    raw.prepare("INSERT INTO users (id, created_at, disabled_at, is_admin) VALUES (?, ?, NULL, 0);").run(userId, now);
    raw.prepare(
      "INSERT INTO external_identities (id, provider, provider_subject, user_id, provider_login, provider_email, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, NULL, ?, ?);"
    ).run(extId, "github", "111222", userId, "github-user-no-email", now, now);
    raw.close();

    const inst = store.upsertGitHubInstallationWithUser({
      githubInstallationId: "123456",
      githubAppId: "12345",
      accountId: "999",
      accountLogin: "github-user-no-email",
      accountType: "User",
      repositorySelection: "selected",
      userId,
    });
    const bound = store.createWorkspaceWithRepositoryBinding({
      userId,
      installationRowId: inst.installation.id,
      githubRepositoryId: "999999",
      ownerAccountId: "999",
      ownerLogin: "github-user-no-email",
      repositoryName: "test-repo",
      fullName: "github-user-no-email/test-repo",
      branch: "main",
      accessScopeVerifiedAtMs: Date.now(),
    });
    const workspaceId = bound.workspace.id;

    // Mark bootstrap as READY
    const rawUpdate = new DatabaseSync(dbPath);
    rawUpdate.prepare("UPDATE workspace_bootstraps SET state = 'READY' WHERE workspace_id = ?;").run(workspaceId);
    rawUpdate.close();

    const registry = new WorkspaceRuntimeRegistry({
      dataRoot: item.config.dataRoot,
      store,
      gitCommitter: {
        name: "CEO State MCP",
        email: "ceo-mcp@users.noreply.github.com",
      },
      credentialProviderFactory: () => ({
        getCredential: async () => ({ username: "x-access-token", token: "dummy" }),
      }),
    });

    // Fails fast at runtime init
    await expect(registry.get(workspaceId)).rejects.toMatchObject({
      code: "INVALID_WORKSPACE_STATE",
    });
  });

  it("WorkspaceRuntimeRegistry initializes successfully and sets owner as author when identity is complete", async () => {
    const item = await fixture();
    cleanup.push(item.root);

    const dbPath = path.join(item.root, "identity.db");
    provisionEmptyControlPlaneDatabase(dbPath);
    const store = IdentityStore.open(dbPath);

    const extUser = store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "333444",
      providerLogin: "valid-owner",
      providerEmail: "valid-owner@example.com",
    });

    const inst = store.upsertGitHubInstallationWithUser({
      githubInstallationId: "234567",
      githubAppId: "12345",
      accountId: "888",
      accountLogin: "valid-owner",
      accountType: "User",
      repositorySelection: "selected",
      userId: extUser.user_id,
    });
    const bound = store.createWorkspaceWithRepositoryBinding({
      userId: extUser.user_id,
      installationRowId: inst.installation.id,
      githubRepositoryId: "888888",
      ownerAccountId: "888",
      ownerLogin: "valid-owner",
      repositoryName: "valid-repo",
      fullName: "valid-owner/valid-repo",
      branch: "main",
      accessScopeVerifiedAtMs: Date.now(),
    });
    const workspaceId = bound.workspace.id;

    // Mark bootstrap as READY
    const rawReady = new DatabaseSync(dbPath);
    rawReady.prepare("UPDATE workspace_bootstraps SET state = 'READY' WHERE workspace_id = ?;").run(workspaceId);
    rawReady.close();

    const wsRepoDir = path.join(item.config.dataRoot, "workspaces", workspaceId, "repo");
    git(item.root, "clone", item.remote, wsRepoDir);

    const registry = new WorkspaceRuntimeRegistry({
      dataRoot: item.config.dataRoot,
      store,
      gitCommitter: {
        name: "CEO State MCP",
        email: "ceo-mcp@users.noreply.github.com",
      },
      credentialProviderFactory: () => ({
        getCredential: async () => ({ username: "x-access-token", token: "dummy" }),
      }),
      workspaceFactory: (cfg) => new CeoWorkspace({ ...cfg, remoteUrl: item.remote }),
    });

    const runtime = await registry.get(workspaceId);
    expect(runtime).toBeDefined();

    // Verify read
    const read = await runtime.workspace.readFiles(["TODO.md"]);
    expect(read.files.length).toBe(1);

    // Verify write attributes to valid-owner
    const todo = (read.files as any[])[0];
    const res = await runtime.workspace.applyChangeSet({
      request_id: randomUUID(),
      base_commit: read.base_commit as string,
      summary: "Registry commit test",
      operations: [
        { op: "replace", path: "TODO.md", expected_blob_oid: todo.blob_oid, content: "# TODO\n- Updated by owner\n" },
      ],
    });

    const log = git(wsRepoDir, "log", "-1", "--format=%an|%ae|%cn|%ce", res.commit as string);
    expect(log).toBe("valid-owner|valid-owner@example.com|CEO State MCP|ceo-mcp@users.noreply.github.com");
  });
});
