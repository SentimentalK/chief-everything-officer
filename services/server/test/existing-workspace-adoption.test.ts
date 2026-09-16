import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  IdentityConflictError,
  IdentityStore,
  IdentityStructureError,
  provisionEmptyIdentityDatabase,
  sha256Hex,
} from "../src/identity/store.js";
import { GitHubAppClient } from "../src/github/app-client.js";
import { WorkspaceBootstrapService } from "../src/github/bootstrap-service.js";
import {
  ExistingWorkspaceAdoptionError,
  ExistingWorkspaceAdoptionService,
  formatAdoptionPlan,
  parseMigrateExistingWorkspaceArgs,
  type ExistingWorkspaceAdoptionCliInput,
} from "../src/github/existing-workspace-adoption.js";
import packageJson from "../package.json" with { type: "json" };
import packageLockJson from "../package-lock.json" with { type: "json" };

const cleanupDirs: string[] = [];
const cleanupStores: IdentityStore[] = [];

afterEach(async () => {
  for (const s of cleanupStores.splice(0)) s.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function countTable(dbPath: string, table: string): number {
  const raw = new DatabaseSync(dbPath);
  const row = raw.prepare(`SELECT COUNT(*) AS c FROM ${table};`).get() as { c: number };
  raw.close();
  return Number(row.c);
}

function generateTestRsaKeyPair(): { privateKey: string } {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey };
}

interface GitWriteState {
  treeCreations: unknown[];
  commitCreations: unknown[];
  refUpdates: unknown[];
  contentsPuts: unknown[];
}

interface MockRepoState extends GitWriteState {
  repoPrivate: boolean;
  repoArchived: boolean;
  repoDisabled: boolean;
  repoId: number;
  ownerAccountId: number;
  ownerLogin: string;
  repoName: string;
  branch: string;
  contentsWrite: boolean;
  appSuspended: boolean;
  installationHttpStatus?: number;
  repoHttpStatus?: number;
  missingBranch?: boolean;
  treeItems: Array<{ path: string; mode: string; type: string; sha: string }>;
  headSha: string;
  treeSha: string;
  failBootstrapAfterPreflight?: boolean;
}

function createAdoptionFetch(state: MockRepoState): typeof fetch {
  let repoGets = 0;
  return (async (urlStr: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(urlStr));
    const pathname = url.pathname;
    const method = (init?.method || "GET").toUpperCase();

    if (pathname.startsWith("/app/installations/")) {
      if (state.installationHttpStatus && state.installationHttpStatus !== 200 && !pathname.endsWith("/access_tokens")) {
        return new Response(JSON.stringify({ message: "installation error" }), { status: state.installationHttpStatus });
      }
      if (pathname.endsWith("/access_tokens")) {
        return new Response(JSON.stringify({ token: "ghs_mock_installation_token", expires_at: "2099-01-01T00:00:00Z" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      const instMatch = pathname.match(/^\/app\/installations\/([^/]+)/);
      const instId = Number(instMatch?.[1] ?? 5555);
      return new Response(
        JSON.stringify({
          id: instId,
          permissions: state.contentsWrite ? { contents: "write" } : { contents: "read" },
          suspended_at: state.appSuspended ? "2026-01-01T00:00:00Z" : null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const repoMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/);
    if (repoMatch && method === "GET") {
      repoGets += 1;
      if (state.failBootstrapAfterPreflight && repoGets > 1) {
        return new Response(JSON.stringify({ message: "rate limited" }), { status: 429 });
      }
      if (state.repoHttpStatus && state.repoHttpStatus !== 200) {
        return new Response(JSON.stringify({ message: "repo error" }), { status: state.repoHttpStatus });
      }
      return new Response(
        JSON.stringify({
          id: state.repoId,
          name: state.repoName,
          full_name: `${state.ownerLogin}/${state.repoName}`,
          owner: { id: state.ownerAccountId, login: state.ownerLogin },
          private: state.repoPrivate,
          archived: state.repoArchived,
          disabled: state.repoDisabled,
          default_branch: state.branch,
          size: 100,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const refMatch = pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs?\/heads\/.+$/);
    if (refMatch && method === "GET") {
      if (state.missingBranch) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      return new Response(
        JSON.stringify({ ref: `refs/heads/${state.branch}`, object: { sha: state.headSha, type: "commit" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (pathname.includes("/git/refs/heads/") && method === "PATCH") {
      state.refUpdates.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ object: { sha: "written" } }), { status: 200 });
    }

    if (pathname.includes("/git/commits/") && method === "GET") {
      return new Response(
        JSON.stringify({ sha: state.headSha, tree: { sha: state.treeSha }, parents: [], message: "head" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (pathname.endsWith("/git/commits") && method === "POST") {
      state.commitCreations.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ sha: "c".repeat(40) }), { status: 201 });
    }

    if (pathname.includes("/git/trees/") && method === "GET") {
      return new Response(JSON.stringify({ sha: state.treeSha, tree: state.treeItems }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (pathname.endsWith("/git/trees") && method === "POST") {
      state.treeCreations.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ sha: "t".repeat(40) }), { status: 201 });
    }

    if (pathname.includes("/contents/") && method === "PUT") {
      state.contentsPuts.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ commit: { sha: "put" } }), { status: 201 });
    }

    return new Response(JSON.stringify({ message: `unhandled ${method} ${pathname}` }), { status: 404 });
  }) as typeof fetch;
}

async function createLegacyWorkspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-adopt-test-"));
  cleanupDirs.push(dir);
  const dbPath = path.join(dir, "identity.sqlite");
  const remoteUrl = "git@github.com:SentimentalK/LifeOS.git";
  const ident = provisionEmptyIdentityDatabase(dbPath, {
    remoteUrl,
    branch: "main",
    apiKeyDigest: sha256Hex("legacy-key"),
  });
  const store = IdentityStore.open(dbPath);
  cleanupStores.push(store);
  const inst = store.upsertGitHubInstallationWithUser({
    githubInstallationId: "5555",
    githubAppId: "10",
    accountId: "40360455",
    accountLogin: "SentimentalK",
    accountType: "User",
    repositorySelection: "selected",
    userId: ident.user_id,
  });
  return { dir, dbPath, store, ident, inst, remoteUrl };
}

function storeAdoptInput(
  ctx: Awaited<ReturnType<typeof createLegacyWorkspace>>,
  overrides: Partial<Parameters<IdentityStore["adoptExistingWorkspaceRepository"]>[0]> = {},
) {
  return {
    workspaceId: ctx.ident.workspace_id,
    expectedOwnerUserId: ctx.ident.user_id,
    githubInstallationRowId: ctx.inst.installation.id,
    githubRepositoryId: "1127467992",
    ownerAccountId: "40360455",
    ownerLogin: "SentimentalK",
    repositoryName: "LifeOS",
    fullName: "SentimentalK/LifeOS",
    branch: "main",
    expectedExistingRemoteUrl: ctx.remoteUrl,
    ...overrides,
  };
}

function cliInput(
  ctx: Awaited<ReturnType<typeof createLegacyWorkspace>>,
  overrides: Partial<ExistingWorkspaceAdoptionCliInput> = {},
): ExistingWorkspaceAdoptionCliInput {
  return {
    workspaceId: ctx.ident.workspace_id,
    expectedOwnerUserId: ctx.ident.user_id,
    installationId: "5555",
    githubRepositoryId: "1127467992",
    ownerAccountId: "40360455",
    ownerLogin: "SentimentalK",
    repositoryName: "LifeOS",
    branch: "main",
    expectedExistingRemoteUrl: ctx.remoteUrl,
    apply: false,
    expectExistingAnchors: false,
    expectNoRepoWrite: false,
    ...overrides,
  };
}

function lifeOsGitState(overrides: Partial<MockRepoState> = {}): MockRepoState {
  return {
    repoPrivate: true,
    repoArchived: false,
    repoDisabled: false,
    repoId: 1127467992,
    ownerAccountId: 40360455,
    ownerLogin: "SentimentalK",
    repoName: "LifeOS",
    branch: "main",
    contentsWrite: true,
    appSuspended: false,
    treeItems: [
      { path: "README.md", mode: "100644", type: "blob", sha: "a".repeat(40) },
      { path: "SYSTEM.md", mode: "100644", type: "blob", sha: "b".repeat(40) },
      { path: "JOURNAL.md", mode: "100644", type: "blob", sha: "c".repeat(40) },
    ],
    headSha: "d".repeat(40),
    treeSha: "e".repeat(40),
    treeCreations: [],
    commitCreations: [],
    refUpdates: [],
    contentsPuts: [],
    ...overrides,
  };
}

function makeService(store: IdentityStore, git: MockRepoState) {
  const fetchFn = createAdoptionFetch(git);
  const keys = generateTestRsaKeyPair();
  const appClient = new GitHubAppClient({ clientId: "Iv1.test", privateKey: keys.privateKey, fetchFn });
  const bootstrapService = new WorkspaceBootstrapService({ appClient, store, fetchFn });
  const adoption = new ExistingWorkspaceAdoptionService({ store, appClient, bootstrapService, fetchFn });
  return { adoption, fetchFn };
}

describe("Step 3.7 existing workspace adoption — store", () => {
  it("A. first adoption inserts only binding + PENDING bootstrap and preserves IDs/remote", async () => {
    const ctx = await createLegacyWorkspace();
    const before = {
      users: countTable(ctx.dbPath, "users"),
      workspaces: countTable(ctx.dbPath, "workspaces"),
      memberships: countTable(ctx.dbPath, "workspace_memberships"),
      keys: countTable(ctx.dbPath, "api_keys"),
      ext: countTable(ctx.dbPath, "external_identities"),
      inst: countTable(ctx.dbPath, "github_installations"),
      instUsers: countTable(ctx.dbPath, "github_installation_users"),
    };

    const result = ctx.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx));
    expect(result.outcome).toBe("CREATED");
    expect(result.binding.workspace_id).toBe(ctx.ident.workspace_id);
    expect(result.binding.github_repository_id).toBe("1127467992");
    expect(result.binding.owner_account_id).toBe("40360455");
    expect(result.binding.owner_login).toBe("SentimentalK");
    expect(result.binding.repository_name).toBe("LifeOS");
    expect(result.binding.full_name).toBe("SentimentalK/LifeOS");
    expect(result.binding.branch).toBe("main");
    expect(result.bootstrap.state).toBe("PENDING");
    expect(result.bootstrap.bootstrap_version).toBe(1);
    expect(result.bootstrap.attempt_count).toBe(0);
    expect(result.workspace.id).toBe(ctx.ident.workspace_id);
    expect(result.workspace.remote_url).toBe("git@github.com:SentimentalK/LifeOS.git");
    expect(result.membership.user_id).toBe(ctx.ident.user_id);

    expect(countTable(ctx.dbPath, "users")).toBe(before.users);
    expect(countTable(ctx.dbPath, "workspaces")).toBe(before.workspaces);
    expect(countTable(ctx.dbPath, "workspace_memberships")).toBe(before.memberships);
    expect(countTable(ctx.dbPath, "api_keys")).toBe(before.keys);
    expect(countTable(ctx.dbPath, "external_identities")).toBe(before.ext);
    expect(countTable(ctx.dbPath, "github_installations")).toBe(before.inst);
    expect(countTable(ctx.dbPath, "github_installation_users")).toBe(before.instUsers);
    expect(countTable(ctx.dbPath, "github_repository_bindings")).toBe(1);
    expect(countTable(ctx.dbPath, "workspace_bootstraps")).toBe(1);

    const ws = ctx.store.findWorkspaceById(ctx.ident.workspace_id);
    expect(ws?.remote_url).toBe("git@github.com:SentimentalK/LifeOS.git");
  });

  it("B. exact rerun is ALREADY_ADOPTED with no new rows and no lifecycle reset", async () => {
    const ctx = await createLegacyWorkspace();
    const first = ctx.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx));
    const { attemptId } = ctx.store.beginWorkspaceBootstrapAttempt(ctx.ident.workspace_id);
    ctx.store.markWorkspaceBootstrapReady(ctx.ident.workspace_id, attemptId, {
      readyCommitSha: "a".repeat(40),
    });
    const ready = ctx.store.findWorkspaceBootstrapByWorkspaceId(ctx.ident.workspace_id)!;
    expect(ready.state).toBe("READY");

    const second = ctx.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx));
    expect(second.outcome).toBe("ALREADY_ADOPTED");
    expect(second.binding.id).toBe(first.binding.id);
    expect(countTable(ctx.dbPath, "github_repository_bindings")).toBe(1);
    expect(countTable(ctx.dbPath, "workspace_bootstraps")).toBe(1);
    const after = ctx.store.findWorkspaceBootstrapByWorkspaceId(ctx.ident.workspace_id)!;
    expect(after.state).toBe("READY");
    expect(after.attempt_count).toBe(ready.attempt_count);
    expect(after.ready_commit_sha).toBe(ready.ready_commit_sha);
  });

  it("C. conflicts reject without mutation", async () => {
    const ctx = await createLegacyWorkspace();
    const otherUser = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "222",
      providerLogin: "other",
    });
    const inst2 = ctx.store.upsertGitHubInstallationWithUser({
      githubInstallationId: "7777",
      githubAppId: "10",
      accountId: "222",
      accountLogin: "other",
      accountType: "User",
      repositorySelection: "all",
      userId: otherUser.user_id,
    });
    const created = ctx.store.createWorkspaceWithRepositoryBinding({
      userId: otherUser.user_id,
      installationRowId: inst2.installation.id,
      githubRepositoryId: "888888",
      ownerAccountId: "222",
      ownerLogin: "other",
      repositoryName: "tmp",
      fullName: "other/tmp",
      branch: "main",
    });
    expect(() =>
      ctx.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx, { githubRepositoryId: "888888" })),
    ).toThrow(/already bound/);
    expect(ctx.store.findRepositoryBindingByWorkspaceId(ctx.ident.workspace_id)).toBeNull();
    expect(created.workspace.id).not.toBe(ctx.ident.workspace_id);

    const first = ctx.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx));
    ctx.store.upsertGitHubInstallationWithUser({
      githubInstallationId: "7777",
      githubAppId: "10",
      accountId: "222",
      accountLogin: "other",
      accountType: "User",
      repositorySelection: "all",
      userId: ctx.ident.user_id,
    });
    const inst2ForOwner = ctx.store.findGitHubInstallationById("7777")!;
    expect(() =>
      ctx.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx, { githubRepositoryId: "999999" })),
    ).toThrow(IdentityConflictError);
    expect(() =>
      ctx.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx, { ownerAccountId: "1" })),
    ).toThrow(IdentityConflictError);
    expect(() =>
      ctx.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx, { branch: "develop" })),
    ).toThrow(IdentityConflictError);
    expect(() =>
      ctx.store.adoptExistingWorkspaceRepository(
        storeAdoptInput(ctx, { githubInstallationRowId: inst2ForOwner.id }),
      ),
    ).toThrow(IdentityConflictError);
    expect(ctx.store.findRepositoryBindingByWorkspaceId(ctx.ident.workspace_id)!.id).toBe(first.binding.id);
  });

  it("D. existing workspace invariants reject without mutation", async () => {
    const ctx = await createLegacyWorkspace();
    const raw = new DatabaseSync(ctx.dbPath);

    expect(() =>
      ctx.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx, { expectedExistingRemoteUrl: "https://github.com/SentimentalK/LifeOS.git" })),
    ).toThrow(/remote_url/);

    raw.prepare("UPDATE users SET disabled_at = ? WHERE id = ?;").run(Date.now(), ctx.ident.user_id);
    expect(() => ctx.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx))).toThrow(/disabled/);
    raw.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?;").run(ctx.ident.user_id);

    raw.prepare("DELETE FROM github_installation_users;").run();
    expect(() => ctx.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx))).toThrow(/verified association/);
    raw.close();

    expect(countTable(ctx.dbPath, "github_repository_bindings")).toBe(0);
    expect(countTable(ctx.dbPath, "workspace_bootstraps")).toBe(0);

    const ctx2 = await createLegacyWorkspace();
    const raw2 = new DatabaseSync(ctx2.dbPath);
    raw2.prepare("DELETE FROM workspace_memberships;").run();
    expect(() => ctx2.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx2))).toThrow(/owner membership/);
    raw2.exec("UPDATE workspaces SET owner_user_id = owner_user_id;");
    raw2.close();
  });

  it("D2. shadow mismatch and partial binding/bootstrap states are invariant failures", async () => {
    const ctx = await createLegacyWorkspace();
    const other = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "9",
      providerLogin: "x",
    });
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("UPDATE workspaces SET owner_user_id = ?;").run(other.user_id);
    expect(() => ctx.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx))).toThrow(IdentityStructureError);
    raw.prepare("UPDATE workspaces SET owner_user_id = ?;").run(ctx.ident.user_id);

    raw.prepare(`
      INSERT INTO github_repository_bindings (
        id, workspace_id, github_repository_id, github_installation_row_id,
        owner_account_id, owner_login, repository_name, full_name, branch, created_at_ms, updated_at_ms
      ) VALUES ('grb_partial', ?, '1127467992', ?, '40360455', 'SentimentalK', 'LifeOS', 'SentimentalK/LifeOS', 'main', 1, 1);
    `).run(ctx.ident.workspace_id, ctx.inst.installation.id);
    expect(() => ctx.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx))).toThrow(/no bootstrap row/);
    raw.prepare("DELETE FROM github_repository_bindings;").run();
    raw.prepare(`
      INSERT INTO workspace_bootstraps (
        workspace_id, bootstrap_version, state, attempt_count, created_at_ms, updated_at_ms
      ) VALUES (?, 1, 'PENDING', 0, 1, 1);
    `).run(ctx.ident.workspace_id);
    expect(() => ctx.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx))).toThrow(/no repository binding/);
    raw.close();
  });

  it("E. forced DB failure rolls back to 0 binding and 0 bootstrap", async () => {
    const ctx = await createLegacyWorkspace();
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec(`
      CREATE TRIGGER trg_abort_adopt BEFORE INSERT ON github_repository_bindings
      BEGIN SELECT RAISE(ABORT, 'forced adoption failure'); END;
    `);
    raw.close();

    expect(() => ctx.store.adoptExistingWorkspaceRepository(storeAdoptInput(ctx))).toThrow(/forced adoption failure|adopt existing/);
    expect(countTable(ctx.dbPath, "github_repository_bindings")).toBe(0);
    expect(countTable(ctx.dbPath, "workspace_bootstraps")).toBe(0);
    expect(ctx.store.findWorkspaceById(ctx.ident.workspace_id)?.id).toBe(ctx.ident.workspace_id);
  });
});

describe("Step 3.7 existing workspace adoption — GitHub/CLI gates", () => {
  it("F. dry-run performs 0 DB writes and 0 Git writes", async () => {
    const ctx = await createLegacyWorkspace();
    const git = lifeOsGitState();
    const { adoption } = makeService(ctx.store, git);
    const plan = await adoption.plan(cliInput(ctx, { expectExistingAnchors: true, expectNoRepoWrite: true }));
    expect(plan.action).toBe("CREATE_ADOPTION");
    expect(plan.remoteUrl).toBe("git@github.com:SentimentalK/LifeOS.git");
    expect(plan.anchors?.map((a) => `${a.path} ${a.status}`)).toEqual([
      "README.md OK",
      "SYSTEM.md OK",
      "JOURNAL.md OK",
    ]);
    expect(formatAdoptionPlan(plan)).toContain("CREATE_ADOPTION");
    expect(formatAdoptionPlan(plan)).not.toContain("ghs_");
    expect(countTable(ctx.dbPath, "github_repository_bindings")).toBe(0);
    expect(countTable(ctx.dbPath, "workspace_bootstraps")).toBe(0);
    expect(git.treeCreations).toEqual([]);
    expect(git.commitCreations).toEqual([]);
    expect(git.refUpdates).toEqual([]);
    expect(git.contentsPuts).toEqual([]);
    await expect(adoption.apply(cliInput(ctx))).rejects.toThrow(/pass --apply/);
  });

  it("G. GitHub verification rejects unsafe or mismatched repositories", async () => {
    const ctx = await createLegacyWorkspace();

    const cases: Array<[Partial<MockRepoState>, string | RegExp]> = [
      [{ repoId: 1 }, /Repository ID mismatch/],
      [{ ownerAccountId: 1 }, /owner account ID mismatch/],
      [{ repoPrivate: false }, /not private/],
      [{ repoArchived: true }, /archived/],
      [{ repoDisabled: true }, /disabled/],
      [{ missingBranch: true }, /does not exist or is not readable/],
      [{ contentsWrite: false }, /Contents: write/],
      [{ installationHttpStatus: 404 }, /inaccessible|HTTP 404/],
    ];

    for (const [override, match] of cases) {
      const git = lifeOsGitState(override);
      const { adoption } = makeService(ctx.store, git);
      await expect(adoption.plan(cliInput(ctx))).rejects.toThrow(match);
      expect(countTable(ctx.dbPath, "github_repository_bindings")).toBe(0);
    }
  });

  it("H. --expect-existing-anchors rejects missing or non-regular files before DB adoption", async () => {
    const ctx = await createLegacyWorkspace();
    const missing = lifeOsGitState({
      treeItems: [
        { path: "SYSTEM.md", mode: "100644", type: "blob", sha: "b".repeat(40) },
        { path: "JOURNAL.md", mode: "100644", type: "blob", sha: "c".repeat(40) },
      ],
    });
    const { adoption: a1 } = makeService(ctx.store, missing);
    await expect(a1.plan(cliInput(ctx, { expectExistingAnchors: true }))).rejects.toThrow(/README.md/);
    expect(countTable(ctx.dbPath, "github_repository_bindings")).toBe(0);

    const symlink = lifeOsGitState({
      treeItems: [
        { path: "README.md", mode: "120000", type: "blob", sha: "a".repeat(40) },
        { path: "SYSTEM.md", mode: "100644", type: "blob", sha: "b".repeat(40) },
        { path: "JOURNAL.md", mode: "100644", type: "blob", sha: "c".repeat(40) },
      ],
    });
    const { adoption: a2 } = makeService(ctx.store, symlink);
    await expect(a2.apply(cliInput(ctx, { apply: true, expectExistingAnchors: true }))).rejects.toThrow(/not a regular file/);
    expect(countTable(ctx.dbPath, "github_repository_bindings")).toBe(0);

    const submodule = lifeOsGitState({
      treeItems: [
        { path: "README.md", mode: "160000", type: "commit", sha: "a".repeat(40) },
        { path: "SYSTEM.md", mode: "100644", type: "blob", sha: "b".repeat(40) },
        { path: "JOURNAL.md", mode: "100644", type: "blob", sha: "c".repeat(40) },
      ],
    });
    const { adoption: a3 } = makeService(ctx.store, submodule);
    await expect(a3.apply(cliInput(ctx, { apply: true, expectExistingAnchors: true }))).rejects.toThrow(/not a regular file/);
    expect(countTable(ctx.dbPath, "github_repository_bindings")).toBe(0);
  });

  it("I. LifeOS-style happy path reaches READY with zero Git content/ref writes", async () => {
    const ctx = await createLegacyWorkspace();
    const git = lifeOsGitState();
    const { adoption } = makeService(ctx.store, git);
    const result = await adoption.apply(
      cliInput(ctx, { apply: true, expectExistingAnchors: true, expectNoRepoWrite: true }),
    );
    expect(result.action).toBe("CREATE_ADOPTION");
    expect(result.bootstrap.state).toBe("READY");
    expect(result.db.workspace.id).toBe(ctx.ident.workspace_id);
    expect(result.db.workspace.remote_url).toBe("git@github.com:SentimentalK/LifeOS.git");
    expect(result.gitSnapshotAfter?.headSha).toBe("d".repeat(40));
    expect(git.treeCreations).toEqual([]);
    expect(git.commitCreations).toEqual([]);
    expect(git.refUpdates).toEqual([]);
    expect(git.contentsPuts).toEqual([]);
  });

  it("J. bootstrap failure preserves workspace/binding/failure state and creates no replacements", async () => {
    const ctx = await createLegacyWorkspace();
    const git = lifeOsGitState({
      treeItems: [{ path: "app.ts", mode: "100644", type: "blob", sha: "1".repeat(40) }],
      failBootstrapAfterPreflight: true,
    });
    const { adoption } = makeService(ctx.store, git);
    const usersBefore = countTable(ctx.dbPath, "users");
    const workspacesBefore = countTable(ctx.dbPath, "workspaces");
    const keysBefore = countTable(ctx.dbPath, "api_keys");

    await expect(adoption.apply(cliInput(ctx, { apply: true }))).rejects.toThrow(ExistingWorkspaceAdoptionError);
    expect(countTable(ctx.dbPath, "users")).toBe(usersBefore);
    expect(countTable(ctx.dbPath, "workspaces")).toBe(workspacesBefore);
    expect(countTable(ctx.dbPath, "api_keys")).toBe(keysBefore);
    expect(ctx.store.findWorkspaceById(ctx.ident.workspace_id)?.id).toBe(ctx.ident.workspace_id);
    expect(ctx.store.findRepositoryBindingByWorkspaceId(ctx.ident.workspace_id)?.github_repository_id).toBe("1127467992");
    const boot = ctx.store.findWorkspaceBootstrapByWorkspaceId(ctx.ident.workspace_id);
    expect(boot).not.toBeNull();
    expect(boot!.state === "RETRYABLE_FAILURE" || boot!.state === "MANUAL_RECOVERY").toBe(true);
  });

  it("parses CLI flags and defaults to dry-run", () => {
    const parsed = parseMigrateExistingWorkspaceArgs([
      "--workspace-id",
      "ws_1",
      "--expected-user-id",
      "usr_1",
      "--installation-id",
      "5555",
      "--repo-id",
      "1127467992",
      "--owner-account-id",
      "40360455",
      "--owner",
      "SentimentalK",
      "--repo",
      "LifeOS",
      "--branch",
      "main",
      "--expected-remote",
      "git@github.com:SentimentalK/LifeOS.git",
      "--expect-existing-anchors",
      "--expect-no-repo-write",
    ]);
    expect(parsed.apply).toBe(false);
    expect(parsed.expectExistingAnchors).toBe(true);
    expect(parsed.expectNoRepoWrite).toBe(true);
    expect(parsed.expectedExistingRemoteUrl).toBe("git@github.com:SentimentalK/LifeOS.git");
  });

  it("package versions are 0.3.10", () => {
    expect(packageJson.version).toBe("0.3.10");
    expect(packageLockJson.version).toBe("0.3.10");
    expect(packageLockJson.packages[""].version).toBe("0.3.10");
  });
});
