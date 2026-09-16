import { describe, expect, it, afterEach } from "vitest";
import crypto from "node:crypto";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  IdentityStore,
  provisionEmptyIdentityDatabase,
  sha256Hex,
} from "../src/identity/store.js";
import { UserSessionManager } from "../src/auth/user-session.js";
import { GitHubAppClient } from "../src/github/app-client.js";
import {
  WorkspaceBootstrapService,
} from "../src/github/bootstrap-service.js";
import {
  GitHubRepositoryService,
} from "../src/github/repository-service.js";
import {
  createWorkspaceProvisioningRouter,
} from "../src/github/router.js";
import packageJson from "../package.json" with { type: "json" };
import packageLockJson from "../package-lock.json" with { type: "json" };

const cleanupDirs: string[] = [];
const cleanupStores: IdentityStore[] = [];

afterEach(async () => {
  for (const s of cleanupStores.splice(0)) s.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function generateTestRsaKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey, publicKey };
}

interface TestContext {
  dir: string;
  dbPath: string;
  store: IdentityStore;
  sessionManager: UserSessionManager;
  sessionId: string;
  rsaKeys: { privateKey: string; publicKey: string };
  clientId: string;
  clientSecret: string;
  userId: string;
  providerSubject: string;
  installationRowId: string;
  installationId: string;
  workspaceId: string;
  repoId: string;
  ownerLogin: string;
  repoName: string;
  branch: string;
}

interface MockGitState {
  repoExists: boolean;
  repoPrivate: boolean;
  repoArchived: boolean;
  repoDisabled: boolean;
  repoId: number;
  ownerLogin: string;
  repoName: string;
  branch: string;
  appPermissions: { contents?: string; administration?: string };
  appSuspended: boolean;
  commits: Map<string, { tree: string; parents: string[]; message: string }>;
  trees: Map<string, Array<{ path: string; mode: string; type: string; sha: string; content?: string }>>;
  branchRefSha: string | null; // null if empty repo
  // Tracking calls
  treeCreations: Array<{ base_tree?: string; tree: Array<{ path: string; mode: string; type: string; content?: string }> }>;
  commitCreations: Array<{ tree: string; parents: string[]; message: string }>;
  refUpdates: Array<{ sha: string; force: boolean }>;
  refCreations: Array<{ ref: string; sha: string }>;
  // Injected fault flags
  failTreeCreateStatus?: number;
  failCommitCreateStatus?: number;
  failRefUpdateStatus?: number;
  failRefCreateStatus?: number;
  failGetRefStatus?: number;
  failPostWriteVerification?: boolean;
}

function createMockGitFetch(state: MockGitState) {
  const nextSha = () => crypto.randomBytes(20).toString("hex");

  return async (urlStr: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(urlStr));
    const pathname = url.pathname;
    const method = (init?.method || "GET").toUpperCase();
    const bodyStr = init?.body ? String(init.body) : "";

    // App installation details
    if (pathname.startsWith("/app/installations/")) {
      const instMatch = pathname.match(/^\/app\/installations\/([^/]+)/);
      const instId = instMatch && !isNaN(Number(instMatch[1])) ? Number(instMatch[1]) : 5555;
      if (pathname.endsWith("/access_tokens")) {
        return new Response(JSON.stringify({ token: "ghs_mock_installation_token", expires_at: "2099-01-01T00:00:00Z" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      const accountId = state.ownerLogin === "user2" ? 22222 : state.ownerLogin === "user3" ? 33333 : 999;
      return new Response(
        JSON.stringify({
          id: instId,
          account: { id: accountId, login: state.ownerLogin, type: "User" },
          permissions: state.appPermissions,
          suspended_at: state.appSuspended ? "2026-01-01T00:00:00Z" : null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Repository details
    const repoMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/);
    if (repoMatch) {
      if (!state.repoExists) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      const accountId = state.ownerLogin === "user2" ? 22222 : state.ownerLogin === "user3" ? 33333 : 999;
      return new Response(
        JSON.stringify({
          id: state.repoId,
          name: state.repoName,
          full_name: `${state.ownerLogin}/${state.repoName}`,
          owner: { id: accountId, login: state.ownerLogin },
          private: state.repoPrivate,
          archived: state.repoArchived,
          disabled: state.repoDisabled,
          default_branch: state.branch,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Branch ref GET: /repos/:owner/:repo/git/ref/heads/:branch or /git/refs/heads/:branch
    const refMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs?\/heads\/(.+)$/);
    if (refMatch && method === "GET") {
      if (state.failGetRefStatus) {
        return new Response(JSON.stringify({ message: "Error" }), { status: state.failGetRefStatus });
      }
      if (state.branchRefSha === null) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      return new Response(
        JSON.stringify({
          ref: `refs/heads/${state.branch}`,
          object: { sha: state.branchRefSha, type: "commit" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Commit GET: /repos/:owner/:repo/git/commits/:sha
    const commitMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/commits\/(.+)$/);
    if (commitMatch && method === "GET") {
      const commitSha = commitMatch[3];
      const commit = state.commits.get(commitSha);
      if (!commit) {
        return new Response(JSON.stringify({ message: "Commit not found" }), { status: 404 });
      }
      return new Response(
        JSON.stringify({
          sha: commitSha,
          tree: { sha: commit.tree },
          parents: commit.parents.map((p) => ({ sha: p })),
          message: commit.message,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Tree GET: /repos/:owner/:repo/git/trees/:sha
    const treeMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/(.+)$/);
    if (treeMatch && method === "GET") {
      const treeSha = treeMatch[3];
      const items = state.trees.get(treeSha);
      if (!items) {
        return new Response(JSON.stringify({ message: "Tree not found" }), { status: 404 });
      }
      if (state.failPostWriteVerification) {
        // Return tree missing canonical anchors
        return new Response(JSON.stringify({ sha: treeSha, tree: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          sha: treeSha,
          tree: items.map((it) => ({
            path: it.path,
            mode: it.mode,
            type: it.type,
            sha: it.sha,
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Tree POST: /repos/:owner/:repo/git/trees
    if (pathname.endsWith("/git/trees") && method === "POST") {
      if (state.failTreeCreateStatus) {
        return new Response(JSON.stringify({ message: "Tree create failed" }), { status: state.failTreeCreateStatus });
      }
      const parsed = JSON.parse(bodyStr);
      state.treeCreations.push(parsed);

      const newTreeSha = nextSha();
      let combinedItems: Array<{ path: string; mode: string; type: string; sha: string; content?: string }> = [];

      if (parsed.base_tree) {
        const baseItems = state.trees.get(parsed.base_tree) || [];
        combinedItems = [...baseItems];
      }

      for (const entry of parsed.tree) {
        const idx = combinedItems.findIndex((x) => x.path === entry.path);
        const item = {
          path: entry.path,
          mode: entry.mode,
          type: entry.type,
          sha: nextSha(),
          content: entry.content,
        };
        if (idx >= 0) {
          combinedItems[idx] = item;
        } else {
          combinedItems.push(item);
        }
      }

      state.trees.set(newTreeSha, combinedItems);
      return new Response(JSON.stringify({ sha: newTreeSha, tree: combinedItems }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Commit POST: /repos/:owner/:repo/git/commits
    if (pathname.endsWith("/git/commits") && method === "POST") {
      if (state.failCommitCreateStatus) {
        return new Response(JSON.stringify({ message: "Commit create failed" }), { status: state.failCommitCreateStatus });
      }
      const parsed = JSON.parse(bodyStr);
      state.commitCreations.push(parsed);

      const newCommitSha = nextSha();
      state.commits.set(newCommitSha, {
        tree: parsed.tree,
        parents: parsed.parents || [],
        message: parsed.message,
      });

      return new Response(
        JSON.stringify({
          sha: newCommitSha,
          tree: { sha: parsed.tree },
          parents: (parsed.parents || []).map((p: string) => ({ sha: p })),
          message: parsed.message,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }

    // Ref PATCH: /repos/:owner/:repo/git/refs/heads/:branch
    if (pathname.includes("/git/refs/heads/") && method === "PATCH") {
      const parsed = JSON.parse(bodyStr);
      state.refUpdates.push(parsed);

      if (state.failRefUpdateStatus) {
        return new Response(JSON.stringify({ message: "Ref update conflict" }), { status: state.failRefUpdateStatus });
      }
      state.branchRefSha = parsed.sha;

      return new Response(
        JSON.stringify({
          ref: `refs/heads/${state.branch}`,
          object: { sha: parsed.sha, type: "commit" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Ref POST: /repos/:owner/:repo/git/refs
    if (pathname.endsWith("/git/refs") && method === "POST") {
      const parsed = JSON.parse(bodyStr);
      state.refCreations.push(parsed);

      if (state.failRefCreateStatus) {
        return new Response(JSON.stringify({ message: "Ref create conflict" }), { status: state.failRefCreateStatus });
      }
      state.branchRefSha = parsed.sha;

      return new Response(
        JSON.stringify({
          ref: parsed.ref,
          object: { sha: parsed.sha, type: "commit" },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ message: `Mock unhandled ${method} ${pathname}` }), { status: 404 });
  };
}

async function createBootstrapTestContext(): Promise<TestContext> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-bootstrap-test-"));
  cleanupDirs.push(dir);
  const dbPath = path.join(dir, "identity.sqlite");

  const ident = provisionEmptyIdentityDatabase(dbPath, {
    remoteUrl: "git@example.com:test/repo.git",
    branch: "main",
    apiKeyDigest: sha256Hex("test-key"),
  });

  const store = IdentityStore.open(dbPath);
  cleanupStores.push(store);

  const providerSubject = "999";
  const extUser = store.resolveOrCreateExternalUser({
    provider: "github",
    providerSubject,
    providerLogin: "dev-owner",
  });
  const userId = extUser.user_id;

  const rsaKeys = generateTestRsaKeyPair();
  const clientId = "Iv1.test_client_id";
  const clientSecret = "test_client_secret";

  const inst = store.upsertGitHubInstallationWithUser({
    githubAppId: "10",
    githubInstallationId: "5555",
    accountId: "999",
    accountLogin: "dev-owner",
    accountType: "User",
    repositorySelection: "all",
    userId,
    rawPayload: { id: 5555 },
  });

  const sessionManager = new UserSessionManager({ sessionTtlMs: 3600000 });
  const session = sessionManager.createSession({
    userId,
    provider: "github",
    providerSubject,
    providerLogin: "dev-owner",
  });

  const repoId = "88888";
  const ownerLogin = "dev-owner";
  const repoName = "ceo-canonical";
  const branch = "main";

  // Create bound workspace
  const bound = store.createWorkspaceWithRepositoryBinding({
    userId,
    installationRowId: inst.installation.id,
    githubRepositoryId: repoId,
    ownerAccountId: "999",
    ownerLogin,
    repositoryName: repoName,
    fullName: `${ownerLogin}/${repoName}`,
    branch,
  });

  return {
    dir,
    dbPath,
    store,
    sessionManager,
    sessionId: session.sessionId,
    rsaKeys,
    clientId,
    clientSecret,
    userId,
    providerSubject,
    installationRowId: inst.installation.id,
    installationId: "5555",
    workspaceId: bound.workspace.id,
    repoId,
    ownerLogin,
    repoName,
    branch,
  };
}

describe("Step 3.6B: Workspace Bootstrap Lifecycle & GitHub Engine", () => {
  it("I. bootstraps an empty repository from scratch", async () => {
    const ctx = await createBootstrapTestContext();
    const gitState: MockGitState = {
      repoExists: true,
      repoPrivate: true,
      repoArchived: false,
      repoDisabled: false,
      repoId: Number(ctx.repoId),
      ownerLogin: ctx.ownerLogin,
      repoName: ctx.repoName,
      branch: ctx.branch,
      appPermissions: { contents: "write" },
      appSuspended: false,
      commits: new Map(),
      trees: new Map(),
      branchRefSha: null, // empty repository
      treeCreations: [],
      commitCreations: [],
      refUpdates: [],
      refCreations: [],
    };

    const fetchFn = createMockGitFetch(gitState);
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    const result = await service.bootstrapWorkspace(ctx.workspaceId);

    expect(result.status).toBe("READY");
    expect(result.bootstrap.state).toBe("READY");
    expect(result.bootstrap.attempt_count).toBe(1);
    expect(result.bootstrap.ready_commit_sha).toBeTruthy();
    expect(result.bootstrap.last_base_commit_sha).toBeNull();
    expect(result.bootstrap.last_error_code).toBeNull();

    // Verify git API actions
    expect(gitState.treeCreations.length).toBe(1);
    expect(gitState.treeCreations[0].tree.map((x) => x.path).sort()).toEqual(["JOURNAL.md", "README.md", "SYSTEM.md"]);
    expect(gitState.commitCreations.length).toBe(1);
    expect(gitState.commitCreations[0].parents).toEqual([]);
    expect(gitState.refCreations.length).toBe(1);
    expect(gitState.refCreations[0].ref).toBe("refs/heads/main");
  });

  it("J. additive bootstrap preserving existing user repository content", async () => {
    const ctx = await createBootstrapTestContext();
    const existingTreeSha = "1".repeat(40);
    const existingCommitSha = "2".repeat(40);

    const gitState: MockGitState = {
      repoExists: true,
      repoPrivate: true,
      repoArchived: false,
      repoDisabled: false,
      repoId: Number(ctx.repoId),
      ownerLogin: ctx.ownerLogin,
      repoName: ctx.repoName,
      branch: ctx.branch,
      appPermissions: { contents: "write" },
      appSuspended: false,
      commits: new Map([[existingCommitSha, { tree: existingTreeSha, parents: [], message: "Initial user commit" }]]),
      trees: new Map([[existingTreeSha, [{ path: "app.ts", mode: "100644", type: "blob", sha: "3".repeat(40) }]]]),
      branchRefSha: existingCommitSha,
      treeCreations: [],
      commitCreations: [],
      refUpdates: [],
      refCreations: [],
    };

    const fetchFn = createMockGitFetch(gitState);
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    const result = await service.bootstrapWorkspace(ctx.workspaceId);

    expect(result.status).toBe("READY");
    expect(result.bootstrap.state).toBe("READY");
    expect(result.bootstrap.attempt_count).toBe(1);
    expect(result.bootstrap.last_base_commit_sha).toBe(existingCommitSha);
    expect(result.bootstrap.ready_commit_sha).toBeTruthy();

    // Verify additive tree creation with base_tree
    expect(gitState.treeCreations.length).toBe(1);
    expect(gitState.treeCreations[0].base_tree).toBe(existingTreeSha);
    expect(gitState.commitCreations.length).toBe(1);
    expect(gitState.commitCreations[0].parents).toEqual([existingCommitSha]);
    expect(gitState.refUpdates.length).toBe(1);
    expect(gitState.refUpdates[0].force).toBe(false);

    // Verify existing file app.ts was preserved in resulting tree
    const finalTreeSha = gitState.commits.get(result.bootstrap.ready_commit_sha!)!.tree;
    const finalTree = gitState.trees.get(finalTreeSha)!;
    expect(finalTree.find((x) => x.path === "app.ts")).toBeTruthy();
    expect(finalTree.find((x) => x.path === "README.md")).toBeTruthy();
  });

  it("K. preserves existing anchor content and only adds missing files", async () => {
    const ctx = await createBootstrapTestContext();
    const existingTreeSha = "3".repeat(40);
    const existingCommitSha = "4".repeat(40);
    const customReadmeContent = "# My Custom Product README";

    const gitState: MockGitState = {
      repoExists: true,
      repoPrivate: true,
      repoArchived: false,
      repoDisabled: false,
      repoId: Number(ctx.repoId),
      ownerLogin: ctx.ownerLogin,
      repoName: ctx.repoName,
      branch: ctx.branch,
      appPermissions: { contents: "write" },
      appSuspended: false,
      commits: new Map([[existingCommitSha, { tree: existingTreeSha, parents: [], message: "Custom readme" }]]),
      trees: new Map([
        [
          existingTreeSha,
          [{ path: "README.md", mode: "100644", type: "blob", sha: "5".repeat(40), content: customReadmeContent }],
        ],
      ]),
      branchRefSha: existingCommitSha,
      treeCreations: [],
      commitCreations: [],
      refUpdates: [],
      refCreations: [],
    };

    const fetchFn = createMockGitFetch(gitState);
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    const result = await service.bootstrapWorkspace(ctx.workspaceId);

    expect(result.status).toBe("READY");
    // Only SYSTEM.md and JOURNAL.md were missing and added
    expect(gitState.treeCreations.length).toBe(1);
    expect(gitState.treeCreations[0].tree.map((x) => x.path).sort()).toEqual(["JOURNAL.md", "SYSTEM.md"]);

    const finalTree = gitState.trees.get(gitState.commits.get(result.bootstrap.ready_commit_sha!)!.tree)!;
    const readmeEntry = finalTree.find((x) => x.path === "README.md");
    expect(readmeEntry?.content).toBe(customReadmeContent);
  });

  it("L. idempotent no-op when all 3 canonical anchors are already present", async () => {
    const ctx = await createBootstrapTestContext();
    const existingTreeSha = "5".repeat(40);
    const existingCommitSha = "6".repeat(40);

    const gitState: MockGitState = {
      repoExists: true,
      repoPrivate: true,
      repoArchived: false,
      repoDisabled: false,
      repoId: Number(ctx.repoId),
      ownerLogin: ctx.ownerLogin,
      repoName: ctx.repoName,
      branch: ctx.branch,
      appPermissions: { contents: "write" },
      appSuspended: false,
      commits: new Map([[existingCommitSha, { tree: existingTreeSha, parents: [], message: "All anchors" }]]),
      trees: new Map([
        [
          existingTreeSha,
          [
            { path: "README.md", mode: "100644", type: "blob", sha: "7".repeat(40) },
            { path: "SYSTEM.md", mode: "100644", type: "blob", sha: "8".repeat(40) },
            { path: "JOURNAL.md", mode: "100644", type: "blob", sha: "9".repeat(40) },
          ],
        ],
      ]),
      branchRefSha: existingCommitSha,
      treeCreations: [],
      commitCreations: [],
      refUpdates: [],
      refCreations: [],
    };

    const fetchFn = createMockGitFetch(gitState);
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    const result = await service.bootstrapWorkspace(ctx.workspaceId);

    expect(result.status).toBe("READY");
    expect(result.bootstrap.state).toBe("READY");
    expect(result.bootstrap.ready_commit_sha).toBe(existingCommitSha);
    // Zero mutations
    expect(gitState.treeCreations.length).toBe(0);
    expect(gitState.commitCreations.length).toBe(0);
    expect(gitState.refUpdates.length).toBe(0);
  });

  it("M. crash reconciliation to READY on retry without duplicate commit", async () => {
    const ctx = await createBootstrapTestContext();
    // Simulate first attempt failing / interrupted right after ref was updated on GitHub
    const existingCommitSha = "7".repeat(40);
    const existingTreeSha = "8".repeat(40);

    const gitState: MockGitState = {
      repoExists: true,
      repoPrivate: true,
      repoArchived: false,
      repoDisabled: false,
      repoId: Number(ctx.repoId),
      ownerLogin: ctx.ownerLogin,
      repoName: ctx.repoName,
      branch: ctx.branch,
      appPermissions: { contents: "write" },
      appSuspended: false,
      commits: new Map([[existingCommitSha, { tree: existingTreeSha, parents: [], message: "Bootstrap commit" }]]),
      trees: new Map([
        [
          existingTreeSha,
          [
            { path: "README.md", mode: "100644", type: "blob", sha: "1".repeat(40) },
            { path: "SYSTEM.md", mode: "100644", type: "blob", sha: "2".repeat(40) },
            { path: "JOURNAL.md", mode: "100644", type: "blob", sha: "3".repeat(40) },
          ],
        ],
      ]),
      branchRefSha: existingCommitSha,
      treeCreations: [],
      commitCreations: [],
      refUpdates: [],
      refCreations: [],
    };

    const fetchFn = createMockGitFetch(gitState);
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    // Local DB is still PENDING
    const initialStatus = await service.getProvisioningStatus(ctx.workspaceId);
    expect(initialStatus.status).toBe("PROVISIONING");
    expect(initialStatus.bootstrap.state).toBe("PENDING");

    // Retry call
    const result = await service.bootstrapWorkspace(ctx.workspaceId);
    expect(result.status).toBe("READY");
    expect(result.bootstrap.state).toBe("READY");
    expect(result.bootstrap.ready_commit_sha).toBe(existingCommitSha);
    // No redundant commit created
    expect(gitState.commitCreations.length).toBe(0);
  });

  it("N. directory or non-regular blob conflict transitions to MANUAL_RECOVERY (BRANCH_CONFLICT_OBJECT)", async () => {
    const ctx = await createBootstrapTestContext();
    const existingTreeSha = "9".repeat(40);
    const existingCommitSha = "a".repeat(40);

    const gitState: MockGitState = {
      repoExists: true,
      repoPrivate: true,
      repoArchived: false,
      repoDisabled: false,
      repoId: Number(ctx.repoId),
      ownerLogin: ctx.ownerLogin,
      repoName: ctx.repoName,
      branch: ctx.branch,
      appPermissions: { contents: "write" },
      appSuspended: false,
      commits: new Map([[existingCommitSha, { tree: existingTreeSha, parents: [], message: "Bad tree" }]]),
      trees: new Map([
        [
          existingTreeSha,
          // README.md is a tree (directory) instead of a blob
          [{ path: "README.md", mode: "040000", type: "tree", sha: "b".repeat(40) }],
        ],
      ]),
      branchRefSha: existingCommitSha,
      treeCreations: [],
      commitCreations: [],
      refUpdates: [],
      refCreations: [],
    };

    const fetchFn = createMockGitFetch(gitState);
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    const result = await service.bootstrapWorkspace(ctx.workspaceId);

    expect(result.status).toBe("MANUAL_RECOVERY");
    expect(result.bootstrap.state).toBe("MANUAL_RECOVERY");
    expect(result.bootstrap.last_error_kind).toBe("manual");
    expect(result.bootstrap.last_error_code).toBe("BRANCH_CONFLICT_OBJECT");
    expect(result.bootstrap.last_error_message).toContain("conflicts with existing non-regular object");
  });

  it("O. concurrent ref race (409/422 on PATCH ref) transitions to RETRYABLE_FAILURE STALE_REMOTE without force", async () => {
    const ctx = await createBootstrapTestContext();
    const existingTreeSha = "b".repeat(40);
    const existingCommitSha = "c".repeat(40);

    const gitState: MockGitState = {
      repoExists: true,
      repoPrivate: true,
      repoArchived: false,
      repoDisabled: false,
      repoId: Number(ctx.repoId),
      ownerLogin: ctx.ownerLogin,
      repoName: ctx.repoName,
      branch: ctx.branch,
      appPermissions: { contents: "write" },
      appSuspended: false,
      commits: new Map([[existingCommitSha, { tree: existingTreeSha, parents: [], message: "Initial" }]]),
      trees: new Map([[existingTreeSha, [{ path: "other.txt", mode: "100644", type: "blob", sha: "d".repeat(40) }]]]),
      branchRefSha: existingCommitSha,
      treeCreations: [],
      commitCreations: [],
      refUpdates: [],
      refCreations: [],
      failRefUpdateStatus: 409, // remote moved concurrently!
    };

    const fetchFn = createMockGitFetch(gitState);
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    const result = await service.bootstrapWorkspace(ctx.workspaceId);

    expect(result.status).toBe("RETRYABLE_FAILURE");
    expect(result.bootstrap.state).toBe("RETRYABLE_FAILURE");
    expect(result.bootstrap.last_error_kind).toBe("retryable");
    expect(result.bootstrap.last_error_code).toBe("STALE_REMOTE");
    expect(gitState.refUpdates.length).toBe(1);
    expect(gitState.refUpdates[0].force).toBe(false);
  });

  it("P. empty repo concurrent create ref race (422) transitions to RETRYABLE_FAILURE STALE_REMOTE", async () => {
    const ctx = await createBootstrapTestContext();
    const gitState: MockGitState = {
      repoExists: true,
      repoPrivate: true,
      repoArchived: false,
      repoDisabled: false,
      repoId: Number(ctx.repoId),
      ownerLogin: ctx.ownerLogin,
      repoName: ctx.repoName,
      branch: ctx.branch,
      appPermissions: { contents: "write" },
      appSuspended: false,
      commits: new Map(),
      trees: new Map(),
      branchRefSha: null,
      treeCreations: [],
      commitCreations: [],
      refUpdates: [],
      refCreations: [],
      failRefCreateStatus: 422, // ref already exists
    };

    const fetchFn = createMockGitFetch(gitState);
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    const result = await service.bootstrapWorkspace(ctx.workspaceId);

    expect(result.status).toBe("RETRYABLE_FAILURE");
    expect(result.bootstrap.state).toBe("RETRYABLE_FAILURE");
    expect(result.bootstrap.last_error_code).toBe("STALE_REMOTE");
  });

  it("Q. revoked/missing installation or permissions or repo mismatch -> MANUAL_RECOVERY", async () => {
    const ctx = await createBootstrapTestContext();
    // Case 1: Missing contents: write permission
    const gitState: MockGitState = {
      repoExists: true,
      repoPrivate: true,
      repoArchived: false,
      repoDisabled: false,
      repoId: Number(ctx.repoId),
      ownerLogin: ctx.ownerLogin,
      repoName: ctx.repoName,
      branch: ctx.branch,
      appPermissions: { contents: "read" }, // write is missing
      appSuspended: false,
      commits: new Map(),
      trees: new Map(),
      branchRefSha: null,
      treeCreations: [],
      commitCreations: [],
      refUpdates: [],
      refCreations: [],
    };

    const fetchFn = createMockGitFetch(gitState);
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    const result = await service.bootstrapWorkspace(ctx.workspaceId);
    expect(result.status).toBe("MANUAL_RECOVERY");
    expect(result.bootstrap.last_error_code).toBe("CONTENTS_WRITE_REQUIRED");

    // Case 2: Repo ID mismatch
    gitState.appPermissions = { contents: "write" };
    gitState.repoId = 9999999; // mismatch
    const result2 = await service.bootstrapWorkspace(ctx.workspaceId);
    expect(result2.status).toBe("MANUAL_RECOVERY");
    expect(result2.bootstrap.last_error_code).toBe("REPOSITORY_IDENTITY_MISMATCH");
  });

  it("R. rate limit (429) or 5xx error -> RETRYABLE_FAILURE", async () => {
    const ctx = await createBootstrapTestContext();
    const gitState: MockGitState = {
      repoExists: true,
      repoPrivate: true,
      repoArchived: false,
      repoDisabled: false,
      repoId: Number(ctx.repoId),
      ownerLogin: ctx.ownerLogin,
      repoName: ctx.repoName,
      branch: ctx.branch,
      appPermissions: { contents: "write" },
      appSuspended: false,
      commits: new Map(),
      trees: new Map(),
      branchRefSha: null,
      treeCreations: [],
      commitCreations: [],
      refUpdates: [],
      refCreations: [],
      failTreeCreateStatus: 429,
    };

    const fetchFn = createMockGitFetch(gitState);
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    const result = await service.bootstrapWorkspace(ctx.workspaceId);
    expect(result.status).toBe("RETRYABLE_FAILURE");
    expect(result.bootstrap.last_error_code).toBe("GITHUB_RATE_LIMITED");
  });

  it("S. post-write live verification failure -> RETRYABLE_FAILURE", async () => {
    const ctx = await createBootstrapTestContext();
    const gitState: MockGitState = {
      repoExists: true,
      repoPrivate: true,
      repoArchived: false,
      repoDisabled: false,
      repoId: Number(ctx.repoId),
      ownerLogin: ctx.ownerLogin,
      repoName: ctx.repoName,
      branch: ctx.branch,
      appPermissions: { contents: "write" },
      appSuspended: false,
      commits: new Map(),
      trees: new Map(),
      branchRefSha: null,
      treeCreations: [],
      commitCreations: [],
      refUpdates: [],
      refCreations: [],
      failPostWriteVerification: true,
    };

    const fetchFn = createMockGitFetch(gitState);
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    const result = await service.bootstrapWorkspace(ctx.workspaceId);
    expect(result.status).toBe("RETRYABLE_FAILURE");
    expect(result.bootstrap.last_error_code).toBe("POST_WRITE_VERIFICATION_FAILED");
  });

  it("T. installation tokens and secrets are never leaked in error messages or DB records", async () => {
    const ctx = await createBootstrapTestContext();
    const secretToken = "ghs_SECRET_TOKEN_1234567890abcdef";

    // Call store methods with message containing secret
    const { attemptId } = ctx.store.beginWorkspaceBootstrapAttempt(ctx.workspaceId);
    const updated = ctx.store.markWorkspaceBootstrapRetryableFailure(ctx.workspaceId, attemptId, {
      code: "NETWORK_ERROR",
      message: `Failed to fetch using token ${secretToken} and Authorization: Bearer ${secretToken}`,
    });

    expect(updated.last_error_message).not.toContain(secretToken);
    expect(updated.last_error_message).toContain("[REDACTED]");

    const row = ctx.store.findWorkspaceBootstrapByWorkspaceId(ctx.workspaceId);
    expect(row?.last_error_message).not.toContain(secretToken);
  });

  it("U. control-plane provisioning routes enforce auth, owner access, and operations", async () => {
    const ctx = await createBootstrapTestContext();
    const gitState: MockGitState = {
      repoExists: true,
      repoPrivate: true,
      repoArchived: false,
      repoDisabled: false,
      repoId: Number(ctx.repoId),
      ownerLogin: ctx.ownerLogin,
      repoName: ctx.repoName,
      branch: ctx.branch,
      appPermissions: { contents: "write" },
      appSuspended: false,
      commits: new Map(),
      trees: new Map(),
      branchRefSha: null,
      treeCreations: [],
      commitCreations: [],
      refUpdates: [],
      refCreations: [],
    };

    const fetchFn = createMockGitFetch(gitState);
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const bootstrapService = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    const app = express();
    app.use(express.json());
    app.use(
      "/api/workspaces",
      createWorkspaceProvisioningRouter({
        bootstrapService,
        sessionManager: ctx.sessionManager,
        store: ctx.store,
      }),
    );

    // Another user who does not own the workspace
    const otherExtUser = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "44444",
      providerLogin: "other_user",
    });
    const otherSession = ctx.sessionManager.createSession({
      userId: otherExtUser.user_id,
      provider: "github",
      providerSubject: "44444",
      providerLogin: "other_user",
    });

    const invoke = async (method: string, url: string, sessionCookie?: string) => {
      return new Promise<{ status: number; body: any }>((resolve) => {
        const parsedUrl = new URL(url, "http://localhost");
        const queryObj: Record<string, string> = {};
        for (const [k, v] of parsedUrl.searchParams.entries()) {
          queryObj[k] = v;
        }

        const req = {
          method,
          url,
          originalUrl: url,
          headers: {
            ...(sessionCookie ? { cookie: `ceo_user_session=${sessionCookie}` } : {}),
            accept: "application/json",
            "content-type": "application/json",
          },
          body: {},
          params: {},
          query: queryObj,
        } as any;

        let resStatus = 200;
        const resHeaders: Record<string, string> = {};
        const res = {
          status: (s: number) => {
            resStatus = s;
            return res;
          },
          setHeader: (k: string, v: string) => {
            resHeaders[k.toLowerCase()] = v;
          },
          getHeader: (k: string) => resHeaders[k.toLowerCase()],
          json: (data: any) => {
            resolve({ status: resStatus, body: data });
          },
        } as any;

        app(req, res, () => {
          resolve({ status: 404, body: {} });
        });
      });
    };

    // 1. GET unauthenticated -> 401
    const unauth = await invoke("GET", `/api/workspaces/${ctx.workspaceId}/provisioning`);
    expect(unauth.status).toBe(401);

    // 2. GET non-owner -> 403
    const forbidden = await invoke("GET", `/api/workspaces/${ctx.workspaceId}/provisioning`, otherSession.sessionId);
    expect(forbidden.status).toBe(403);

    // 3. GET unknown workspace -> 404
    const notFound = await invoke("GET", `/api/workspaces/ws_non_existent/provisioning`, ctx.sessionId);
    expect(notFound.status).toBe(404);

    // 4. GET owner -> 200 with provisioning status
    const ok = await invoke("GET", `/api/workspaces/${ctx.workspaceId}/provisioning`, ctx.sessionId);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("PROVISIONING");
    expect(ok.body.workspace.id).toBe(ctx.workspaceId);

    // 5. POST retry unauthenticated -> 401
    const retryUnauth = await invoke("POST", `/api/workspaces/${ctx.workspaceId}/bootstrap/retry`);
    expect(retryUnauth.status).toBe(401);

    // 6. POST retry non-owner -> 403
    const retryForbidden = await invoke("POST", `/api/workspaces/${ctx.workspaceId}/bootstrap/retry`, otherSession.sessionId);
    expect(retryForbidden.status).toBe(403);

    // 7. POST retry owner -> 200 and transitions to READY
    const retryOk = await invoke("POST", `/api/workspaces/${ctx.workspaceId}/bootstrap/retry`, ctx.sessionId);
    expect(retryOk.status).toBe(200);
    expect(retryOk.body.status).toBe("READY");
    expect(retryOk.body.bootstrap.state).toBe("READY");
  });

  it("V. importRepository integrates bootstrapService and returns READY status", async () => {
    const ctx = await createBootstrapTestContext();
    // User without workspace
    const user2 = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "22222",
      providerLogin: "user2",
    });
    const session2 = ctx.sessionManager.createSession({
      userId: user2.user_id,
      provider: "github",
      providerSubject: "22222",
      providerLogin: "user2",
    });

    const inst2 = ctx.store.upsertGitHubInstallationWithUser({
      githubAppId: "10",
      githubInstallationId: "6666",
      accountId: "22222",
      accountLogin: "user2",
      accountType: "User",
      repositorySelection: "all",
      userId: user2.user_id,
      rawPayload: { id: 6666 },
    });

    const gitState: MockGitState = {
      repoExists: true,
      repoPrivate: true,
      repoArchived: false,
      repoDisabled: false,
      repoId: 77777,
      ownerLogin: "user2",
      repoName: "my-existing-repo",
      branch: "main",
      appPermissions: { contents: "write" },
      appSuspended: false,
      commits: new Map(),
      trees: new Map(),
      branchRefSha: null,
      treeCreations: [],
      commitCreations: [],
      refUpdates: [],
      refCreations: [],
    };

    const fetchFn = createMockGitFetch(gitState);
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const bootstrapService = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: "http://localhost/callback",
      fetchFn: async (url, init) => {
        const u = new URL(String(url));
        if (u.pathname.includes("oauth/access_token")) {
          return new Response(JSON.stringify({ access_token: "mock_user_token" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.pathname === "/user") {
          return new Response(JSON.stringify({ id: 22222, login: "user2" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.pathname === "/user/installations") {
          return new Response(
            JSON.stringify({
              total_count: 1,
              installations: [{ id: 6666, app_id: 10, account: { id: 22222, login: "user2", type: "User" } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (u.pathname.includes("/repositories")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              repositories: [
                {
                  id: 77777,
                  name: "my-existing-repo",
                  full_name: "user2/my-existing-repo",
                  owner: { id: 22222, login: "user2" },
                  private: true,
                  archived: false,
                  disabled: false,
                  default_branch: "main",
                  permissions: { admin: true, push: true, pull: true },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return fetchFn(url, init);
      },
      bootstrapService,
    });

    const start = repoService.createAuthorizationRedirect({
      sessionId: session2.sessionId,
      userId: user2.user_id,
      providerSubject: "22222",
      installationId: "6666",
    });

    const cb = await repoService.handleOAuthCallback({
      state: start.state,
      code: "code",
      currentSessionId: session2.sessionId,
      currentUserId: user2.user_id,
      currentProviderSubject: "22222",
    });

    const imported = await repoService.importRepository(
      cb.grant,
      session2.sessionId,
      user2.user_id,
      "22222",
      "77777",
    );

    expect(imported.status).toBe("READY");
    expect(imported.bootstrap.state).toBe("READY");
    expect(imported.bootstrap.ready_commit_sha).toBeTruthy();
  });

  it("W. createRepository with bootstrap failure returns HTTP 201 without deleting repo", async () => {
    const ctx = await createBootstrapTestContext();
    const user3 = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "33333",
      providerLogin: "user3",
    });
    const session3 = ctx.sessionManager.createSession({
      userId: user3.user_id,
      provider: "github",
      providerSubject: "33333",
      providerLogin: "user3",
    });

    ctx.store.upsertGitHubInstallationWithUser({
      githubAppId: "10",
      githubInstallationId: "7777",
      accountId: "33333",
      accountLogin: "user3",
      accountType: "User",
      repositorySelection: "all",
      userId: user3.user_id,
      rawPayload: { id: 7777 },
    });

    const gitState: MockGitState = {
      repoExists: true,
      repoPrivate: true,
      repoArchived: false,
      repoDisabled: false,
      repoId: 88889,
      ownerLogin: "user3",
      repoName: "new-repo",
      branch: "main",
      appPermissions: { contents: "write", administration: "write" },
      appSuspended: false,
      commits: new Map(),
      trees: new Map(),
      branchRefSha: null,
      treeCreations: [],
      commitCreations: [],
      refUpdates: [],
      refCreations: [],
      failTreeCreateStatus: 429, // bootstrap will fail with RETRYABLE_FAILURE
    };

    const fetchFn = createMockGitFetch(gitState);
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const bootstrapService = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: "http://localhost/callback",
      fetchFn: async (url, init) => {
        const u = new URL(String(url));
        if (u.pathname.includes("oauth/access_token")) {
          return new Response(JSON.stringify({ access_token: "mock_user_token" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.pathname === "/user") {
          return new Response(JSON.stringify({ id: 33333, login: "user3" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.pathname === "/user/installations") {
          return new Response(
            JSON.stringify({
              total_count: 1,
              installations: [{ id: 7777, app_id: 10, account: { id: 33333, login: "user3", type: "User" } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (u.pathname === "/user/repos" && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              id: 88889,
              name: "new-repo",
              full_name: "user3/new-repo",
              owner: { id: 33333, login: "user3" },
              private: true,
              archived: false,
              disabled: false,
              default_branch: "main",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return fetchFn(url, init);
      },
      bootstrapService,
    });

    const start = repoService.createAuthorizationRedirect({
      sessionId: session3.sessionId,
      userId: user3.user_id,
      providerSubject: "33333",
      installationId: "7777",
    });

    const cb = await repoService.handleOAuthCallback({
      state: start.state,
      code: "code",
      currentSessionId: session3.sessionId,
      currentUserId: user3.user_id,
      currentProviderSubject: "33333",
    });

    const createdResult = await repoService.createRepository(
      cb.grant,
      session3.sessionId,
      user3.user_id,
      "33333",
      { name: "new-repo" },
    );

    // Workspace and repository binding were preserved and created
    expect(createdResult.workspace.id).toMatch(/^ws_/);
    expect(createdResult.binding.github_repository_id).toBe("88889");
    // Bootstrap failed retryably, status reflects RETRYABLE_FAILURE
    expect(createdResult.status).toBe("RETRYABLE_FAILURE");
    expect(createdResult.bootstrap.state).toBe("RETRYABLE_FAILURE");
    expect(createdResult.bootstrap.last_error_code).toBe("GITHUB_RATE_LIMITED");
  });

  it("X. legacy dogfood startup without bootstrap row remains healthy", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-dogfood-test-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "identity.sqlite");

    // Provision legacy database with unbound initial workspace
    const ident = provisionEmptyIdentityDatabase(dbPath, {
      remoteUrl: "git@example.com:test/repo.git",
      branch: "main",
      apiKeyDigest: sha256Hex("test-key"),
    });

    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    // Initial dogfood workspace has no repo binding and no bootstrap row
    const binding = store.findRepositoryBindingByWorkspaceId(ident.workspace_id);
    expect(binding).toBeNull();

    const bootstrap = store.findWorkspaceBootstrapByWorkspaceId(ident.workspace_id);
    expect(bootstrap).toBeNull();

    // Verify workspace and owner access still function seamlessly
    expect(store.hasWorkspaceAccess(ident.workspace_id, ident.user_id)).toBe(true);
    const ws = store.findWorkspaceById(ident.workspace_id);
    expect(ws?.id).toBe(ident.workspace_id);
  });

  it("Z. package versions are 0.3.9", () => {
    expect(packageJson.version).toBe("0.3.9");
    expect(packageLockJson.version).toBe("0.3.9");
    expect(packageLockJson.packages[""].version).toBe("0.3.9");
  });
});
