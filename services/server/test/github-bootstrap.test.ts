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
  GitHubWorkspaceProvisioningIncompleteError,
} from "../src/github/repository-service.js";
import {
  createWorkspaceProvisioningRouter,
  createGitHubRepositoryAuthorizationsRouter,
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
  contentsPuts?: Array<{ path: string; message: string; content: string; branch?: string }>;
  branches?: Array<{ name: string; commit?: { sha: string } }>;
  repoSize?: number;
  // Injected fault flags
  failTreeCreateStatus?: number;
  failCommitCreateStatus?: number;
  failRefUpdateStatus?: number;
  failRefCreateStatus?: number;
  failGetRefStatus?: number;
  failContentsStatus?: number;
  failBranchesStatus?: number;
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
          size: state.repoSize !== undefined ? state.repoSize : (state.branchRefSha === null && state.commits.size === 0 ? 0 : 100),
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

    // Branches GET: /repos/:owner/:repo/branches
    const branchesMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/branches$/);
    if (branchesMatch && method === "GET") {
      if (!state.repoExists) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      if (state.failBranchesStatus) {
        return new Response(JSON.stringify({ message: "Branches error" }), { status: state.failBranchesStatus });
      }
      if (state.branches !== undefined) {
        return new Response(JSON.stringify(state.branches), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (state.branchRefSha === null && state.commits.size === 0) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify([
          {
            name: state.branch,
            commit: { sha: state.branchRefSha ?? "head_sha" },
          },
        ]),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Contents PUT: /repos/:owner/:repo/contents/:path
    const contentsMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (contentsMatch && method === "PUT") {
      if (!state.repoExists) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      if (state.failContentsStatus) {
        return new Response(JSON.stringify({ message: "Contents error" }), { status: state.failContentsStatus });
      }
      const filePath = decodeURIComponent(contentsMatch[3]);
      const parsed = JSON.parse(bodyStr);
      state.contentsPuts = state.contentsPuts || [];
      state.contentsPuts.push({ path: filePath, ...parsed });

      const decodedContent = Buffer.from(parsed.content, "base64").toString("utf-8");
      const blobSha = nextSha();
      const treeSha = nextSha();
      const commitSha = nextSha();

      const items = [
        {
          path: filePath,
          mode: "100644",
          type: "blob",
          sha: blobSha,
          content: decodedContent,
        },
      ];
      state.trees.set(treeSha, items);
      state.commits.set(commitSha, {
        tree: treeSha,
        parents: [],
        message: parsed.message,
      });
      state.branchRefSha = commitSha;

      return new Response(
        JSON.stringify({
          content: { name: path.basename(filePath), path: filePath, sha: blobSha },
          commit: { sha: commitSha, message: parsed.message },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }

    // Ref POST: /repos/:owner/:repo/git/refs
    if (pathname.endsWith("/git/refs") && method === "POST") {
      const parsed = JSON.parse(bodyStr);
      state.refCreations.push(parsed);

      if (state.branchRefSha === null && state.commits.size === 0) {
        // GitHub REST docs explicitly state Create a reference cannot create refs in an empty repository!
        return new Response(
          JSON.stringify({
            message: "Git Repository is empty.",
            documentation_url: "https://docs.github.com/rest/git/refs#create-a-reference",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }

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
    // 1. Exactly one manifest anchor (README.md) initialized via Contents PUT
    expect(gitState.contentsPuts?.length).toBe(1);
    expect(gitState.contentsPuts?.[0].path).toBe("README.md");
    // 2. POST /git/refs was NOT called as the first-ref mechanism
    expect(gitState.refCreations.length).toBe(0);
    // 3. Normal reconciliation added the remaining 2 anchors (JOURNAL.md, SYSTEM.md) via additive base_tree
    expect(gitState.treeCreations.length).toBe(1);
    expect(gitState.treeCreations[0].tree.map((x) => x.path).sort()).toEqual(["JOURNAL.md", "SYSTEM.md"]);
    expect(gitState.commitCreations.length).toBe(1);
    expect(gitState.commitCreations[0].parents.length).toBe(1);
    expect(gitState.refUpdates.length).toBe(1);
    expect(gitState.refUpdates[0].force).toBe(false);

    // 4. Resulting tree contains all 3 anchors
    const readyCommit = gitState.commits.get(result.bootstrap.ready_commit_sha!)!;
    const readyTree = gitState.trees.get(readyCommit.tree)!;
    expect(readyTree.map((x) => x.path).sort()).toEqual(["JOURNAL.md", "README.md", "SYSTEM.md"]);
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
      failContentsStatus: 422, // concurrent init race
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

  it("Y1. distinguishes empty repo from missing bound branch (populated repo -> MANUAL_RECOVERY; no writes)", async () => {
    const ctx = await createBootstrapTestContext();
    // Repository is populated with 'develop' branch, but bound branch 'main' does not exist
    const gitState: MockGitState = {
      repoExists: true,
      repoPrivate: true,
      repoArchived: false,
      repoDisabled: false,
      repoId: Number(ctx.repoId),
      ownerLogin: ctx.ownerLogin,
      repoName: ctx.repoName,
      branch: ctx.branch, // "main"
      appPermissions: { contents: "write" },
      appSuspended: false,
      commits: new Map(),
      trees: new Map(),
      branchRefSha: null, // GET /git/ref/heads/main returns 404
      branches: [{ name: "develop", commit: { sha: "d".repeat(40) } }],
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
    expect(result.bootstrap.last_error_code).toBe("BRANCH_UNAVAILABLE");
    expect(result.bootstrap.last_error_kind).toBe("manual");

    // Proves NO writes/mutations occurred
    expect(gitState.contentsPuts?.length ?? 0).toBe(0);
    expect(gitState.treeCreations.length).toBe(0);
    expect(gitState.commitCreations.length).toBe(0);
    expect(gitState.refCreations.length).toBe(0);
    expect(gitState.refUpdates.length).toBe(0);
  });

  it("Y2. branch-created race transitions to RETRYABLE_FAILURE STALE_REMOTE, then reconciles on retry", async () => {
    const ctx = await createBootstrapTestContext();
    // Bound branch ref GET returned 404 initially, but branches check shows the branch was concurrently created
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
      branchRefSha: null, // first check 404
      branches: [{ name: ctx.branch, commit: { sha: "e".repeat(40) } }], // branches check sees branch created
      treeCreations: [],
      commitCreations: [],
      refUpdates: [],
      refCreations: [],
    };

    const fetchFn = createMockGitFetch(gitState);
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    const result = await service.bootstrapWorkspace(ctx.workspaceId);

    expect(result.status).toBe("RETRYABLE_FAILURE");
    expect(result.bootstrap.state).toBe("RETRYABLE_FAILURE");
    expect(result.bootstrap.last_error_code).toBe("STALE_REMOTE");

    // Now branch ref is live with valid tree
    const commitSha = "f".repeat(40);
    const treeSha = "1".repeat(40);
    gitState.commits.set(commitSha, { tree: treeSha, parents: [], message: "Init" });
    gitState.trees.set(treeSha, [
      { path: "README.md", mode: "100644", type: "blob", sha: "2".repeat(40) },
      { path: "SYSTEM.md", mode: "100644", type: "blob", sha: "3".repeat(40) },
      { path: "JOURNAL.md", mode: "100644", type: "blob", sha: "4".repeat(40) },
    ]);
    gitState.branchRefSha = commitSha;

    // Retry should reconcile cleanly
    const retryResult = await service.bootstrapWorkspace(ctx.workspaceId);
    expect(retryResult.status).toBe("READY");
    expect(retryResult.bootstrap.state).toBe("READY");
    expect(retryResult.bootstrap.ready_commit_sha).toBe(commitSha);
  });

  it("Y3. control-plane preflight failures persist durable MANUAL_RECOVERY using attempt CAS", async () => {
    // 1. Missing owner membership
    {
      const ctx = await createBootstrapTestContext();
      // Remove owner membership from DB
      const db = (ctx.store as any).db;
      db.prepare("DELETE FROM workspace_memberships WHERE workspace_id = ?").run(ctx.workspaceId);

      const fetchFn = createMockGitFetch({
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
      });
      const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
      const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

      const res = await service.bootstrapWorkspace(ctx.workspaceId);
      expect(res.status).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.state).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.last_error_code).toBe("INVALID_BINDING");

      // Verify row in DB is durably MANUAL_RECOVERY (not PENDING or APPLYING)
      const persisted = ctx.store.findWorkspaceBootstrapByWorkspaceId(ctx.workspaceId);
      expect(persisted?.state).toBe("MANUAL_RECOVERY");
      expect(persisted?.last_error_code).toBe("INVALID_BINDING");
    }

    // 2. Disabled owner user
    {
      const ctx = await createBootstrapTestContext();
      // Disable the owner user in DB
      const db = (ctx.store as any).db;
      db.prepare("UPDATE users SET disabled_at = unixepoch() WHERE id = ?").run(ctx.userId);

      const fetchFn = createMockGitFetch({
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
      });
      const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
      const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

      const res = await service.bootstrapWorkspace(ctx.workspaceId);
      expect(res.status).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.state).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.last_error_code).toBe("INVALID_BINDING");

      const persisted = ctx.store.findWorkspaceBootstrapByWorkspaceId(ctx.workspaceId);
      expect(persisted?.state).toBe("MANUAL_RECOVERY");
    }

    // 3. Missing installation row in DB
    {
      const ctx = await createBootstrapTestContext();
      const db = (ctx.store as any).db;
      db.exec("PRAGMA foreign_keys = OFF;");
      db.prepare("DELETE FROM github_installations WHERE id = ?").run(ctx.installationRowId);
      db.exec("PRAGMA foreign_keys = ON;");

      const fetchFn = createMockGitFetch({
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
      });
      const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
      const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

      const res = await service.bootstrapWorkspace(ctx.workspaceId);
      expect(res.status).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.state).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.last_error_code).toBe("INSTALLATION_UNAVAILABLE");

      const persisted = ctx.store.findWorkspaceBootstrapByWorkspaceId(ctx.workspaceId);
      expect(persisted?.state).toBe("MANUAL_RECOVERY");
    }

    // 4. Missing github_installation_users association in DB
    {
      const ctx = await createBootstrapTestContext();
      const db = (ctx.store as any).db;
      db.prepare("DELETE FROM github_installation_users WHERE github_installation_row_id = ? AND user_id = ?").run(
        ctx.installationRowId,
        ctx.userId,
      );

      const fetchFn = createMockGitFetch({
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
      });
      const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
      const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

      const res = await service.bootstrapWorkspace(ctx.workspaceId);
      expect(res.status).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.state).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.last_error_code).toBe("INSTALLATION_UNAVAILABLE");

      const persisted = ctx.store.findWorkspaceBootstrapByWorkspaceId(ctx.workspaceId);
      expect(persisted?.state).toBe("MANUAL_RECOVERY");
    }
  });

  it("Y4. live repository metadata validation strictly fails closed", async () => {
    const ctx = await createBootstrapTestContext();

    const makeFetchWithCustomRepo = (customRepoData: Record<string, unknown>) => {
      return async (url: string | URL | Request) => {
        const u = new URL(String(url));
        if (u.pathname.startsWith("/app/installations/")) {
          if (u.pathname.endsWith("/access_tokens")) {
            return new Response(JSON.stringify({ token: "ghs_tok", expires_at: "2099-01-01T00:00:00Z" }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({ id: 5555, account: { id: 999, login: ctx.ownerLogin, type: "User" }, permissions: { contents: "write" } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (u.pathname.match(/^\/repos\/[^/]+\/[^/]+$/)) {
          return new Response(JSON.stringify(customRepoData), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      };
    };

    const validBase = {
      id: Number(ctx.repoId),
      name: ctx.repoName,
      full_name: `${ctx.ownerLogin}/${ctx.repoName}`,
      owner: { id: 999, login: ctx.ownerLogin },
      private: true,
      archived: false,
      disabled: false,
      default_branch: ctx.branch,
    };

    // 1. Malformed boolean (string "false" instead of boolean)
    {
      const fetchFn = makeFetchWithCustomRepo({ ...validBase, private: "false" });
      const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
      const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

      const res = await service.bootstrapWorkspace(ctx.workspaceId);
      expect(res.status).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.last_error_code).toBe("MALFORMED_REPOSITORY_PAYLOAD");
    }

    // 2. Malformed repo ID (negative)
    {
      const fetchFn = makeFetchWithCustomRepo({ ...validBase, id: -100 });
      const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
      const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

      const res = await service.bootstrapWorkspace(ctx.workspaceId);
      expect(res.status).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.last_error_code).toBe("MALFORMED_REPOSITORY_PAYLOAD");
    }

    // 3. Owner ID mismatch with binding
    {
      const fetchFn = makeFetchWithCustomRepo({ ...validBase, owner: { id: 88888, login: ctx.ownerLogin } });
      const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
      const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

      const res = await service.bootstrapWorkspace(ctx.workspaceId);
      expect(res.status).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.last_error_code).toBe("REPOSITORY_IDENTITY_MISMATCH");
    }

    // 4. Repo is not private (public)
    {
      const fetchFn = makeFetchWithCustomRepo({ ...validBase, private: false });
      const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
      const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

      const res = await service.bootstrapWorkspace(ctx.workspaceId);
      expect(res.status).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.last_error_code).toBe("REPOSITORY_UNAVAILABLE");
    }

    // 5. Repo is archived
    {
      const fetchFn = makeFetchWithCustomRepo({ ...validBase, archived: true });
      const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
      const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

      const res = await service.bootstrapWorkspace(ctx.workspaceId);
      expect(res.status).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.last_error_code).toBe("REPOSITORY_UNAVAILABLE");
    }

    // 6. Repo is disabled
    {
      const fetchFn = makeFetchWithCustomRepo({ ...validBase, disabled: true });
      const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
      const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

      const res = await service.bootstrapWorkspace(ctx.workspaceId);
      expect(res.status).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.last_error_code).toBe("REPOSITORY_UNAVAILABLE");
    }
  });

  it("Y5. mid-attempt auth/access loss (401/403) and object 404 map to MANUAL_RECOVERY (REPOSITORY_UNAVAILABLE)", async () => {
    const ctx = await createBootstrapTestContext();
    const existingCommitSha = "c".repeat(40);
    const existingTreeSha = "t".repeat(40);

    // 1. 403 on commit fetch mid-attempt
    {
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
        commits: new Map([[existingCommitSha, { tree: existingTreeSha, parents: [], message: "Existing" }]]),
        trees: new Map(),
        branchRefSha: existingCommitSha,
        treeCreations: [],
        commitCreations: [],
        refUpdates: [],
        refCreations: [],
      };

      const baseFetch = createMockGitFetch(gitState);
      const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(url));
        if (u.pathname.includes("/git/commits/")) {
          return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 });
        }
        return baseFetch(url, init);
      };

      const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
      const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

      const res = await service.bootstrapWorkspace(ctx.workspaceId);
      expect(res.status).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.last_error_code).toBe("REPOSITORY_UNAVAILABLE");
      expect(res.bootstrap.last_error_kind).toBe("manual");
    }

    // 2. Unexpected 404 on commit object
    {
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
        commits: new Map(), // empty map => commit will 404!
        trees: new Map(),
        branchRefSha: existingCommitSha,
        treeCreations: [],
        commitCreations: [],
        refUpdates: [],
        refCreations: [],
      };

      const fetchFn = createMockGitFetch(gitState);
      const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
      const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

      const res = await service.bootstrapWorkspace(ctx.workspaceId);
      expect(res.status).toBe("MANUAL_RECOVERY");
      expect(res.bootstrap.last_error_code).toBe("REPOSITORY_UNAVAILABLE");
    }
  });

  it("Y6. forced store/DB failure during bootstrap raises GitHubWorkspaceProvisioningIncompleteError / HTTP 500 without masking as PROVISIONING", async () => {
    const ctx = await createBootstrapTestContext();
    const user4 = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "55555",
      providerLogin: "user4",
    });
    const session4 = ctx.sessionManager.createSession({
      userId: user4.user_id,
      provider: "github",
      providerSubject: "55555",
      providerLogin: "user4",
    });

    ctx.store.upsertGitHubInstallationWithUser({
      githubAppId: "10",
      githubInstallationId: "8888",
      accountId: "55555",
      accountLogin: "user4",
      accountType: "User",
      repositorySelection: "all",
      userId: user4.user_id,
      rawPayload: { id: 8888 },
    });

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname.includes("oauth/access_token")) {
        const bodyStr = init?.body ? String(init.body) : "";
        const isUser5 = bodyStr.includes("code2");
        return new Response(JSON.stringify({ access_token: isUser5 ? "mock_user5_token" : "mock_user_token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.pathname === "/user") {
        const authHeader = String((init?.headers as any)?.authorization || (init?.headers as any)?.Authorization || "");
        const isUser5 = authHeader.includes("mock_user5_token");
        return new Response(
          JSON.stringify({ id: isUser5 ? 55556 : 55555, login: isUser5 ? "user5" : "user4" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.pathname === "/user/installations") {
        const authHeader = String((init?.headers as any)?.authorization || (init?.headers as any)?.Authorization || "");
        const isUser5 = authHeader.includes("mock_user5_token");
        return new Response(
          JSON.stringify({
            total_count: 1,
            installations: [
              isUser5
                ? { id: 8889, app_id: 10, account: { id: 55556, login: "user5", type: "User" } }
                : { id: 8888, app_id: 10, account: { id: 55555, login: "user4", type: "User" } },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.pathname.includes("/repositories")) {
        return new Response(
          JSON.stringify({
            total_count: 2,
            repositories: [
              {
                id: 99991,
                name: "db-fail-repo",
                full_name: "user4/db-fail-repo",
                owner: { id: 55555, login: "user4" },
                private: true,
                archived: false,
                disabled: false,
                default_branch: "main",
                permissions: { admin: true, push: true, pull: true },
              },
              {
                id: 99992,
                name: "db-fail-repo-2",
                full_name: "user5/db-fail-repo-2",
                owner: { id: 55556, login: "user5" },
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
      if (u.pathname.startsWith("/app/installations/")) {
        if (u.pathname.endsWith("/access_tokens")) {
          return new Response(JSON.stringify({ token: "ghs_mock", expires_at: "2099-01-01T00:00:00Z" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        const isInst8889 = u.pathname.includes("/8889");
        return new Response(
          JSON.stringify({
            id: isInst8889 ? 8889 : 8888,
            account: isInst8889 ? { id: 55556, login: "user5", type: "User" } : { id: 55555, login: "user4", type: "User" },
            permissions: { contents: "write" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.pathname === "/repos/user4/db-fail-repo") {
        return new Response(
          JSON.stringify({
            id: 99991,
            name: "db-fail-repo",
            full_name: "user4/db-fail-repo",
            owner: { id: 55555, login: "user4" },
            private: true,
            archived: false,
            disabled: false,
            default_branch: "main",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.pathname === "/repos/user5/db-fail-repo-2") {
        return new Response(
          JSON.stringify({
            id: 99992,
            name: "db-fail-repo-2",
            full_name: "user5/db-fail-repo-2",
            owner: { id: 55556, login: "user5" },
            private: true,
            archived: false,
            disabled: false,
            default_branch: "main",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    };

    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn: mockFetch });

    // Create a mock bootstrap service whose bootstrapWorkspace throws an unexpected DB / lifecycle error
    const faultyBootstrapService = {
      async bootstrapWorkspace(_workspaceId: string) {
        throw new Error("Simulated fatal SQLite database disk I/O error");
      },
    } as unknown as WorkspaceBootstrapService;

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: "http://localhost/callback",
      fetchFn: mockFetch,
      bootstrapService: faultyBootstrapService,
    });

    const start = repoService.createAuthorizationRedirect({
      sessionId: session4.sessionId,
      userId: user4.user_id,
      providerSubject: "55555",
      installationId: "8888",
    });

    const cb = await repoService.handleOAuthCallback({
      state: start.state,
      code: "code",
      currentSessionId: session4.sessionId,
      currentUserId: user4.user_id,
      currentProviderSubject: "55555",
    });

    // importRepository must throw GitHubWorkspaceProvisioningIncompleteError and NOT return 201 PROVISIONING
    await expect(
      repoService.importRepository(cb.grant, session4.sessionId, user4.user_id, "55555", "99991"),
    ).rejects.toThrow(GitHubWorkspaceProvisioningIncompleteError);

    // Verify router integration maps this to 500 PROVISIONING_INCOMPLETE
    const user5 = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "55556",
      providerLogin: "user5",
    });
    const session5 = ctx.sessionManager.createSession({
      userId: user5.user_id,
      provider: "github",
      providerSubject: "55556",
      providerLogin: "user5",
    });
    ctx.store.upsertGitHubInstallationWithUser({
      githubAppId: "10",
      githubInstallationId: "8889",
      accountId: "55556",
      accountLogin: "user5",
      accountType: "User",
      repositorySelection: "all",
      userId: user5.user_id,
      rawPayload: { id: 8889 },
    });

    const start2 = repoService.createAuthorizationRedirect({
      sessionId: session5.sessionId,
      userId: user5.user_id,
      providerSubject: "55556",
      installationId: "8889",
    });

    const cb2 = await repoService.handleOAuthCallback({
      state: start2.state,
      code: "code2",
      currentSessionId: session5.sessionId,
      currentUserId: user5.user_id,
      currentProviderSubject: "55556",
    });

    const app = express();
    app.use(express.json());
    app.use(
      "/api/github/repository-authorizations",
      createGitHubRepositoryAuthorizationsRouter({
        repositoryService: repoService,
        sessionManager: ctx.sessionManager,
        store: ctx.store,
      }),
    );

    const res = await new Promise<{ status: number; body: any }>((resolve) => {
      const req = {
        method: "POST",
        url: `/api/github/repository-authorizations/${cb2.grant}/workspace`,
        originalUrl: `/api/github/repository-authorizations/${cb2.grant}/workspace`,
        headers: {
          cookie: `ceo_user_session=${session5.sessionId}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: { mode: "import", repository_id: "99992" },
        params: { grant: cb2.grant },
        query: {},
      } as any;
      let resStatus = 200;
      const responseObj = {
        status: (s: number) => {
          resStatus = s;
          return responseObj;
        },
        setHeader: () => {},
        getHeader: () => undefined,
        json: (data: any) => {
          resolve({ status: resStatus, body: data });
        },
      } as any;
      app(req, responseObj, () => {
        resolve({ status: 404, body: {} });
      });
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("PROVISIONING_INCOMPLETE");
    expect(res.body.workspace_id).toBeTruthy();

    // Verify workspace and binding are preserved in DB
    const binding = ctx.store.findRepositoryBindingByWorkspaceId(res.body.workspace_id);
    expect(binding).toBeTruthy();
    expect(binding?.github_repository_id).toBe("99992");
  });

  it("Y7. post-write verification fails closed if repository metadata changes before verify", async () => {
    const ctx = await createBootstrapTestContext();
    let repoCheckCount = 0;

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

    const baseFetch = createMockGitFetch(gitState);
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname === `/repos/${ctx.ownerLogin}/${ctx.repoName}` && (!init?.method || init.method === "GET")) {
        repoCheckCount++;
        if (repoCheckCount > 1) {
          // Repo changed to public during post-write verification!
          return new Response(
            JSON.stringify({
              id: Number(ctx.repoId),
              name: ctx.repoName,
              full_name: `${ctx.ownerLogin}/${ctx.repoName}`,
              owner: { id: 999, login: ctx.ownerLogin },
              private: false, // Made public!
              archived: false,
              disabled: false,
              default_branch: ctx.branch,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      }
      return baseFetch(url, init);
    };

    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey, fetchFn });
    const service = new WorkspaceBootstrapService({ appClient, store: ctx.store, fetchFn });

    const res = await service.bootstrapWorkspace(ctx.workspaceId);
    expect(res.status).toBe("MANUAL_RECOVERY");
    expect(res.bootstrap.state).toBe("MANUAL_RECOVERY");
    expect(res.bootstrap.last_error_code).toBe("REPOSITORY_UNAVAILABLE");
  });

  it("Z. package versions are 0.3.10", () => {
    expect(packageJson.version).toBe("0.3.10");
    expect(packageLockJson.version).toBe("0.3.10");
    expect(packageLockJson.packages[""].version).toBe("0.3.10");
  });
});
