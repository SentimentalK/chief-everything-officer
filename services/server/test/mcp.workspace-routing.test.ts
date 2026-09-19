import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { rm, mkdtemp } from "node:fs/promises";
import express, { type Request, type Response, type NextFunction } from "express";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  IdentityService,
} from "../src/identity/service.js";
import {
  IdentityStore,
  IDENTITY_DDL,
  IDENTITY_DB_USER_VERSION,
  sha256Hex,
} from "../src/identity/store.js";
import { createIdentityAuthMiddleware } from "../src/auth.js";
import { WorkspaceRuntimeRegistry } from "../src/runtime/registry.js";
import type { WorkspaceRuntime, WorkspaceRuntimeConfig } from "../src/runtime/types.js";
import { CeoWorkspace } from "../src/workspace.js";
import { createMcpServer } from "../src/mcp.js";
import { loadProductPolicy } from "../src/product-policy.js";
import { ResourceService } from "../resource/service.js";
import { openJobBridge } from "../src/jobs/bridge.js";
import { createJobResultHandler } from "../src/jobs/result-service.js";
import type { JobAuthScope } from "../src/jobs/service.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

describe("Step 4B.2: Request-scoped MCP & Resource Runtime Routing", () => {
  const cleanupDirs: string[] = [];
  const cleanupServices: IdentityService[] = [];
  const cleanupServers: HttpServer[] = [];

  afterEach(async () => {
    for (const s of cleanupServers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    for (const svc of cleanupServices.splice(0)) svc.close();
    await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createGitRepo(bareDir: string, defaultBranch = "main"): Promise<void> {
    fs.mkdirSync(bareDir, { recursive: true });
    await pexec("git", ["init", "--bare", "-b", defaultBranch, bareDir]);

    // Commit an initial README to the bare repo using a temporary clone
    const tmpClone = await mkdtemp(path.join(os.tmpdir(), "tmp-clone-"));
    try {
      await pexec("git", ["clone", bareDir, tmpClone]);
      await pexec("git", ["config", "user.name", "Test Setup"], { cwd: tmpClone });
      await pexec("git", ["config", "user.email", "setup@test.local"], { cwd: tmpClone });
      fs.writeFileSync(path.join(tmpClone, "README.md"), "# Initial\n", "utf8");
      await pexec("git", ["add", "README.md"], { cwd: tmpClone });
      await pexec("git", ["commit", "-m", "Initial commit"], { cwd: tmpClone });
      await pexec("git", ["push", "origin", defaultBranch], { cwd: tmpClone });
    } finally {
      await rm(tmpClone, { recursive: true, force: true });
    }
  }

  async function setupMultiWorkspaceServer() {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ceo-routing-test-"));
    cleanupDirs.push(rootDir);

    const dbPath = path.join(rootDir, "identity.sqlite");
    const dataRoot = path.join(rootDir, "data");
    fs.mkdirSync(dataRoot, { recursive: true });

    // Create 2 bare upstream git repositories
    const upstream1 = path.join(rootDir, "upstream1.git");
    const upstream2 = path.join(rootDir, "upstream2.git");
    await createGitRepo(upstream1, "main");
    await createGitRepo(upstream2, "main");

    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(IDENTITY_DDL);
    db.exec(`PRAGMA user_version = ${IDENTITY_DB_USER_VERSION};`);

    const now = 1000000;

    // Workspace 1
    db.prepare("INSERT INTO users VALUES (?, ?, NULL);").run("usr_alice", now);
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
      "ws_one",
      "usr_alice",
      upstream1,
      "main",
      now,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES (?, ?, ?, ?, ?);").run(
      "wsm_alice",
      "ws_one",
      "usr_alice",
      "owner",
      now,
    );
    db.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, NULL);").run(
      "ak_alice",
      "usr_alice",
      sha256Hex("key_alice"),
      now,
    );

    // Installation 1
    db.prepare(`
      INSERT INTO github_installations (
        id, github_installation_id, github_app_id, account_id, account_login,
        account_type, repository_selection, suspended_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, '1', '1', ?, 'User', 'selected', NULL, ?, ?);
    `).run("ghi_1", "12345", "org-one", now, now);

    db.prepare(`
      INSERT INTO github_repository_bindings (
        id, workspace_id, github_repository_id, github_installation_row_id,
        owner_account_id, owner_login, repository_name, full_name,
        branch, access_scope_verified_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, '99001', ?, '1', ?, ?, ?, ?, ?, ?, ?);
    `).run("grb_ws_one", "ws_one", "ghi_1", "org-one", "repo-one", "org-one/repo-one", "main", now, now, now);

    db.prepare(`
      INSERT INTO workspace_bootstraps (
        workspace_id, bootstrap_version, state, attempt_count,
        last_attempt_id, last_base_commit_sha, ready_commit_sha,
        created_at_ms, updated_at_ms, ready_at_ms
      ) VALUES (?, 1, 'READY', 1, 'att_1', '0123456789abcdef0123456789abcdef01234567', 'abcdef0123456789abcdef0123456789abcdef01', ?, ?, ?);
    `).run("ws_one", now, now, now);

    // Workspace 2
    db.prepare("INSERT INTO users VALUES (?, ?, NULL);").run("usr_bob", now);
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
      "ws_two",
      "usr_bob",
      upstream2,
      "main",
      now,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES (?, ?, ?, ?, ?);").run(
      "wsm_bob",
      "ws_two",
      "usr_bob",
      "owner",
      now,
    );
    db.prepare("INSERT INTO api_keys VALUES (?, ?, ?, ?, NULL);").run(
      "ak_bob",
      "usr_bob",
      sha256Hex("key_bob"),
      now,
    );

    // Installation 2
    db.prepare(`
      INSERT INTO github_installations (
        id, github_installation_id, github_app_id, account_id, account_login,
        account_type, repository_selection, suspended_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, '1', '1', ?, 'User', 'selected', NULL, ?, ?);
    `).run("ghi_2", "12346", "org-two", now, now);

    db.prepare(`
      INSERT INTO github_repository_bindings (
        id, workspace_id, github_repository_id, github_installation_row_id,
        owner_account_id, owner_login, repository_name, full_name,
        branch, access_scope_verified_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, '99002', ?, '1', ?, ?, ?, ?, ?, ?, ?);
    `).run("grb_ws_two", "ws_two", "ghi_2", "org-two", "repo-two", "org-two/repo-two", "main", now, now, now);

    db.prepare(`
      INSERT INTO workspace_bootstraps (
        workspace_id, bootstrap_version, state, attempt_count,
        last_attempt_id, last_base_commit_sha, ready_commit_sha,
        created_at_ms, updated_at_ms, ready_at_ms
      ) VALUES (?, 1, 'READY', 1, 'att_2', '0123456789abcdef0123456789abcdef01234567', 'abcdef0123456789abcdef0123456789abcdef02', ?, ?, ?);
    `).run("ws_two", now, now, now);

    db.close();

    const identityService = IdentityService.open(dbPath);
    cleanupServices.push(identityService);

    // Workspace factory using local file:// URLs for the upstream bare repos
    const runtimeRegistry = new WorkspaceRuntimeRegistry({
      store: identityService.storeInstance,
      dataRoot,
      gitConfig: {
        gitAuthorName: "CEO Bot",
        gitAuthorEmail: "bot@ceo.dev",
        gitCommitterName: "CEO Bot",
        gitCommitterEmail: "bot@ceo.dev",
      },
      credentialProviderFactory: () => ({
        getCredential: async () => ({ kind: "none" }),
      }),
      workspaceFactory: (cfg: WorkspaceRuntimeConfig) => {
        // Point remoteUrl to our local bare repo
        const upstream = cfg.workspaceId === "ws_one" ? upstream1 : upstream2;
        return new CeoWorkspace({
          ...cfg,
          remoteUrl: upstream,
        });
      },
    });

    const productPolicy = await loadProductPolicy();

    // Setup Express app with the exact middleware and /mcp wiring as server.ts
    const app = express();
    app.use(express.json());

    const workspaceRuntimeMiddleware = async (
      req: Request,
      res: Response,
      next: NextFunction,
    ): Promise<void> => {
      const identity = res.locals.identity;
      if (!identity || !identity.workspace_id) {
        res.status(403).json({
          jsonrpc: "2.0",
          error: { code: -32003, message: "Forbidden: workspace access denied" },
          id: null,
        });
        return;
      }

      try {
        const runtime = await runtimeRegistry.get(identity.workspace_id);
        res.locals.workspaceRuntime = runtime;
        next();
      } catch (error) {
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32050, message: "Workspace runtime unavailable" },
          id: null,
        });
        return;
      }
    };

    app.all(
      "/mcp",
      createIdentityAuthMiddleware(identityService),
      workspaceRuntimeMiddleware,
      async (req: Request, res: Response) => {
        const runtime = res.locals.workspaceRuntime as WorkspaceRuntime;
        const mcpIdentity = {
          user_id: res.locals.identity!.user_id,
          workspace_id: res.locals.identity!.workspace_id,
        };
        const handler = toNodeHandler(
          createMcpHandler(
            () =>
              createMcpServer(runtime.workspace, productPolicy, {
                identity: mcpIdentity,
                resourceService: runtime.resourceService,
              }),
            { legacy: "stateless" },
          ),
        );
        await handler(req, res, req.body);
      },
    );

    const server = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    cleanupServers.push(server);
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    return {
      baseUrl,
      runtimeRegistry,
      identityService,
    };
  }

  it("routes MCP requests to correct workspace runtimes and never leaks api_key_id", async () => {
    const { baseUrl } = await setupMultiWorkspaceServer();

    // 1. Client Alice connects with key_alice (bound to ws_one)
    const transportAlice = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer key_alice" } },
    });
    const clientAlice = new Client(
      { name: "test-alice", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await clientAlice.connect(transportAlice);

    const statusAlice = await clientAlice.callTool({ name: "workspace_status" });
    expect(statusAlice.isError).toBeFalsy();
    const contentAlice = statusAlice.structuredContent as Record<string, unknown>;
    expect(contentAlice.user_id).toBe("usr_alice");
    expect(contentAlice.workspace_id).toBe("ws_one");
    // CRITICAL SECURITY ASSERTION: api_key_id must NEVER be leaked into tool outputs
    expect(contentAlice.api_key_id).toBeUndefined();
    expect(JSON.stringify(contentAlice)).not.toContain("ak_alice");
    expect(JSON.stringify(contentAlice)).not.toContain("key_alice");

    await clientAlice.close();

    // 2. Client Bob connects with key_bob (bound to ws_two)
    const transportBob = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer key_bob" } },
    });
    const clientBob = new Client(
      { name: "test-bob", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await clientBob.connect(transportBob);

    const statusBob = await clientBob.callTool({ name: "workspace_status" });
    expect(statusBob.isError).toBeFalsy();
    const contentBob = statusBob.structuredContent as Record<string, unknown>;
    expect(contentBob.user_id).toBe("usr_bob");
    expect(contentBob.workspace_id).toBe("ws_two");
    expect(contentBob.api_key_id).toBeUndefined();
    expect(JSON.stringify(contentBob)).not.toContain("ak_bob");
    expect(JSON.stringify(contentBob)).not.toContain("key_bob");

    await clientBob.close();
  });

  it("fails 503 with zero fallback if workspace runtime fails to initialize", async () => {
    const { baseUrl, runtimeRegistry } = await setupMultiWorkspaceServer();

    // Force runtime resolution to fail for ws_one
    const origGet = runtimeRegistry.get.bind(runtimeRegistry);
    runtimeRegistry.get = async (wsId: string) => {
      if (wsId === "ws_one") {
        throw new Error("Simulated git checkout failure for ws_one");
      }
      return origGet(wsId);
    };

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer key_alice",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        id: 1,
      }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32050, message: "Workspace runtime unavailable" },
      id: null,
    });
  });

  it("routes MCP file mutations to the correct workspace repository without affecting other workspaces", async () => {
    const { baseUrl } = await setupMultiWorkspaceServer();

    // Alice connects and creates a file in ws_one
    const transportAlice = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer key_alice" } },
    });
    const clientAlice = new Client(
      { name: "test-alice-writer", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await clientAlice.connect(transportAlice);

    const statusRes = await clientAlice.callTool({ name: "workspace_status" });
    const headCommit = (statusRes.structuredContent as { local_commit: string }).local_commit;

    const applyRes = await clientAlice.callTool({
      name: "apply_change_set",
      arguments: {
        base_commit: headCommit,
        summary: "Add Alice task",
        operations: [
          {
            op: "create",
            path: "tasks/alice-task.md",
            content: "# Alice Task\nCreated in workspace one\n",
          },
        ],
      },
    });
    expect(applyRes.isError).toBeFalsy();

    // Alice can see her file
    const listAlice = await clientAlice.callTool({
      name: "list_files",
      arguments: { prefix: "tasks/" },
    });
    expect(listAlice.isError).toBeFalsy();
    const aliceFiles = (listAlice.structuredContent as { files: Array<{ path: string }> }).files;
    expect(aliceFiles.some((f) => f.path === "tasks/alice-task.md")).toBe(true);

    await clientAlice.close();

    // Bob connects to ws_two and checks his workspace
    const transportBob = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer key_bob" } },
    });
    const clientBob = new Client(
      { name: "test-bob-reader", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await clientBob.connect(transportBob);

    const listBob = await clientBob.callTool({
      name: "list_files",
      arguments: { prefix: "tasks/" },
    });
    expect(listBob.isError).toBeFalsy();
    const bobFiles = (listBob.structuredContent as { files: Array<{ path: string }> }).files;
    // CRITICAL ISOLATION ASSERTION: Bob cannot see Alice's file in his repository!
    expect(bobFiles.some((f) => f.path === "tasks/alice-task.md")).toBe(false);

    await clientBob.close();
  });

  it("worker result ingress resolves runtime for target workspace and commits there", async () => {
    const { runtimeRegistry, identityService } = await setupMultiWorkspaceServer();

    // Pre-initialize runtime for ws_two
    const runtimeTwo = await runtimeRegistry.get("ws_two");
    let applyWorkerResultCalledWith: any = null;
    runtimeTwo.resourceService.applyWorkerResult = async (params: any) => {
      applyWorkerResultCalledWith = params;
      return {
        commit: "0123456789abcdef0123456789abcdef01234567",
        replayed: false,
      };
    };

    const workerId = "wrk-00000000-0000-4000-8000-000000000001";
    const attemptId = "00000000-0000-4000-8000-000000000002";
    const claimToken = "a".repeat(64);
    const tokenSha = sha256Hex(claimToken);

    const mockJobStore = {
      inspectAssignment: async (scope: JobAuthScope, jobId: string) => {
        return {
          ok: true,
          record: {
            job_id: jobId,
            result_target: "resource",
            resource_id: "res-test-1",
            execution: {
              worker_id: workerId,
              attempt_id: attemptId,
              claim_token_sha256: tokenSha,
            },
          },
        };
      },
      resultAssignment: async (scope: JobAuthScope, jobId: string, input: any) => {
        return {
          ok: true,
          replayed: false,
          record: {
            job_id: jobId,
            result: {
              attempt_id: input.attempt_id,
              resource_id: input.result.resource_id,
              commit: input.result.commit,
              received_at_ms: Date.now(),
            },
          },
        };
      },
    } as any;

    const mockJobService = { store: mockJobStore } as any;

    const app = express();
    app.use(express.json());

    const resolveResourceService = async (scope: JobAuthScope) => {
      const rt = await runtimeRegistry.get(scope.workspace_id);
      return rt.resourceService;
    };

    app.post(
      "/api/worker/jobs/:job_id/result",
      createIdentityAuthMiddleware(identityService),
      createJobResultHandler(mockJobService, resolveResourceService),
    );

    const server = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    cleanupServers.push(server);
    const port = (server.address() as AddressInfo).port;

    // Send result from Bob (whose key resolves to ws_two)
    const res = await fetch(`http://127.0.0.1:${port}/api/worker/jobs/job-11111111-1111-4111-8111-111111111111/result`, {
      method: "POST",
      headers: {
        Authorization: "Bearer key_bob",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        worker_id: workerId,
        attempt_id: attemptId,
        claim_token: claimToken,
        payload: {
          content: "Extracted article content",
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.commit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(applyWorkerResultCalledWith).not.toBeNull();
    expect(applyWorkerResultCalledWith.resourceId).toBe("res-test-1");
  });
});
