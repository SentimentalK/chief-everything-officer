import { describe, it, expect, afterEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { rm, mkdtemp } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { IdentityService } from "../src/identity/service.js";
import { IDENTITY_DDL, IDENTITY_DB_USER_VERSION } from "../src/identity/store.js";
import { WorkspaceRuntimeRegistry } from "../src/runtime/registry.js";
import type { WorkspaceRuntime, WorkspaceRuntimeConfig } from "../src/runtime/types.js";
import { CeoWorkspace } from "../src/workspace.js";
import { createMcpServer } from "../src/mcp.js";
import { loadProductPolicy } from "../src/product-policy.js";
import { createRouteAwareJsonParser, MCP_MAX_REQUEST_BYTES } from "../src/http/body-parsers.js";
import { createProtocolCorsMiddleware } from "../src/http/protocol-cors.js";
import { createHostGuard } from "../src/auth.js";
import { LIMITS } from "../src/limits.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

const KiB = 1024;
const MiB = 1024 * 1024;
const BROWSER_ORIGIN = "https://gemini.google.com";
const TEST_BEARER = "key_transport";

/**
 * Test-only identity injector standing in for the production OAuth resource
 * middleware (covered separately by mcp.oauth-auth.test.ts), so this suite can
 * focus on the /mcp transport envelope contract.
 */
function createTestAuthMiddleware(
  tokens: Record<string, { user_id: string; workspace_id: string }>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    const identity = tokens[auth.substring(7)];
    if (!identity) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    res.locals.identity = identity;
    next();
  };
}

describe("PROJECT-036: MCP Large Atomic Change-Set Transport", () => {
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

  /**
   * Assembles an Express app with the exact /mcp middleware and parser wiring
   * as server.ts: host guard + protocol CORS, then the route-aware JSON
   * parser (production module, not a copy), then the per-request MCP handler
   * over a real workspace runtime with a real git upstream.
   */
  async function setupTransportApp() {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ceo-transport-test-"));
    cleanupDirs.push(rootDir);

    const dbPath = path.join(rootDir, "identity.sqlite");
    const dataRoot = path.join(rootDir, "data");
    fs.mkdirSync(dataRoot, { recursive: true });

    const upstream = path.join(rootDir, "upstream.git");
    await createGitRepo(upstream, "main");

    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(IDENTITY_DDL);
    db.exec(`PRAGMA user_version = ${IDENTITY_DB_USER_VERSION};`);

    const now = 1000000;
    db.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES (?, ?, NULL);").run("usr_transport", now);
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?);").run(
      "ws_transport",
      "usr_transport",
      upstream,
      "main",
      now,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES (?, ?, ?, ?, ?);").run(
      "wsm_transport",
      "ws_transport",
      "usr_transport",
      "owner",
      now,
    );
    db.prepare(`
      INSERT INTO github_installations (
        id, github_installation_id, github_app_id, account_id, account_login,
        account_type, repository_selection, suspended_at_ms, created_at_ms, updated_at_ms
      ) VALUES ('ghi_transport', '77777', '1', '1', 'org-transport', 'User', 'selected', NULL, ?, ?);
    `).run(now, now);
    db.prepare(`
      INSERT INTO github_repository_bindings (
        id, workspace_id, github_repository_id, github_installation_row_id,
        owner_account_id, owner_login, repository_name, full_name,
        branch, access_scope_verified_at_ms, created_at_ms, updated_at_ms
      ) VALUES ('grb_transport', 'ws_transport', '99003', 'ghi_transport', '1', 'org-transport', 'repo-transport', 'org-transport/repo-transport', 'main', ?, ?, ?);
    `).run(now, now, now);
    db.prepare(`
      INSERT INTO workspace_bootstraps (
        workspace_id, bootstrap_version, state, attempt_count,
        last_attempt_id, last_base_commit_sha, ready_commit_sha,
        created_at_ms, updated_at_ms, ready_at_ms
      ) VALUES ('ws_transport', 1, 'READY', 1, 'att_t', '${"0".repeat(40)}', '${"a".repeat(40)}', ?, ?, ?);
    `).run(now, now, now);
    db.close();

    const identityService = IdentityService.open(dbPath);
    cleanupServices.push(identityService);

    const runtimeRegistry = new WorkspaceRuntimeRegistry({
      store: identityService.storeInstance,
      dataRoot,
      gitCommitter: {
        name: "CEO Bot",
        email: "bot@ceo.dev",
      },
      credentialProviderFactory: () => ({
        getCredential: async () => ({ kind: "none" }),
      }),
      workspaceFactory: (cfg: WorkspaceRuntimeConfig) =>
        new CeoWorkspace({ ...cfg, remoteUrl: upstream }),
    });

    const productPolicy = await loadProductPolicy();

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
      } catch {
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32050, message: "Workspace runtime unavailable" },
          id: null,
        });
      }
    };

    const app = express();
    const protocolCors = createProtocolCorsMiddleware([BROWSER_ORIGIN]);
    // Production order (server.ts): host guard + protocol CORS before the parser.
    app.use("/mcp", createHostGuard(["localhost", "127.0.0.1"]), protocolCors);
    // Production route-aware parser: /mcp large cap, connector result path
    // skipped, ordinary routes default 100 KiB.
    app.use(createRouteAwareJsonParser());
    // Ordinary JSON route replica for the default-limit assertion.
    app.post("/api/echo", (_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    });
    // Connector managed-result route replica: owns its own route-scoped 3 MiB
    // parser (mirrors src/jobs/v2-router.ts).
    app.post(
      "/api/connector/jobs/:job_id/result",
      express.json({ limit: 3 * MiB }),
      (_req: Request, res: Response) => {
        res.status(200).json({ ok: true });
      },
    );
    app.all(
      "/mcp",
      createTestAuthMiddleware({
        [TEST_BEARER]: { user_id: "usr_transport", workspace_id: "ws_transport" },
      }),
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
    return { baseUrl: `http://127.0.0.1:${port}` };
  }

  async function connectClient(baseUrl: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TEST_BEARER}` } },
    });
    const client = new Client(
      { name: "transport-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
    return client;
  }

  it(
    "executes a real JSON-RPC apply_change_set larger than 100 KiB atomically in one tool call",
    async () => {
      const { baseUrl } = await setupTransportApp();
      const client = await connectClient(baseUrl);

      const status = await client.callTool({ name: "workspace_status" });
      const baseCommit = (status.structuredContent as { local_commit: string }).local_commit;

      // 300 KiB of content: far above the old 100 KiB transport cap, far below
      // the 2 MiB logical write contract.
      const content = "x".repeat(300 * KiB);
      const applyRes = await client.callTool({
        name: "apply_change_set",
        arguments: {
          base_commit: baseCommit,
          summary: "Transport oversize test",
          operations: [
            { op: "create", path: "tasks/transport-big.md", content },
          ],
        },
      });
      expect(applyRes.isError).toBeFalsy();
      const receipt = applyRes.structuredContent as { commit: string };
      expect(typeof receipt.commit).toBe("string");
      expect(receipt.commit).not.toBe(baseCommit);

      // The file is committed to the workspace in that single transaction.
      const list = await client.callTool({
        name: "list_files",
        arguments: { prefix: "tasks/" },
      });
      expect(list.isError).toBeFalsy();
      const files = (list.structuredContent as { files: Array<{ path: string }> }).files;
      expect(files.some((f) => f.path === "tasks/transport-big.md")).toBe(true);

      // Exactly one commit: HEAD moved from base to the new commit.
      const statusAfter = await client.callTool({ name: "workspace_status" });
      expect((statusAfter.structuredContent as { local_commit: string }).local_commit).toBe(receipt.commit);

      await client.close();
    },
    60_000,
  );

  it(
    "accepts a near-maximum legal transaction (~2 MiB) without transport rejection",
    async () => {
      const { baseUrl } = await setupTransportApp();
      const client = await connectClient(baseUrl);

      const status = await client.callTool({ name: "workspace_status" });
      const baseCommit = (status.structuredContent as { local_commit: string }).local_commit;

      // Just under the logical 2 MiB per-transaction/per-file cap.
      const content = "x".repeat(LIMITS.maxTotalWriteBytes - 128 * KiB);
      const applyRes = await client.callTool({
        name: "apply_change_set",
        arguments: {
          base_commit: baseCommit,
          summary: "Near-max legal transaction",
          operations: [
            { op: "create", path: "tasks/near-max.md", content },
          ],
        },
      });
      expect(applyRes.isError).toBeFalsy();

      await client.close();
    },
    60_000,
  );

  it(
    "accepts a worst-case JSON-escaped near-max transaction (control characters, ~12 MiB wire size)",
    async () => {
      const { baseUrl } = await setupTransportApp();
      const client = await connectClient(baseUrl);

      const status = await client.callTool({ name: "workspace_status" });
      const baseCommit = (status.structuredContent as { local_commit: string }).local_commit;

      // Control characters serialize as 6-byte \uXXXX sequences: the worst-case
      // JSON escaping expansion. Decoded size stays under the logical 2 MiB
      // cap, but the wire body is ~12 MiB — within MCP_MAX_REQUEST_BYTES.
      const content = "\u0001".repeat(LIMITS.maxTotalWriteBytes - 128 * KiB);
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(LIMITS.maxFileWriteBytes);
      const applyRes = await client.callTool({
        name: "apply_change_set",
        arguments: {
          base_commit: baseCommit,
          summary: "Worst-case escaped transaction",
          operations: [
            { op: "create", path: "tasks/escaped-max.md", content },
          ],
        },
      });
      expect(applyRes.isError).toBeFalsy();

      await client.close();
    },
    120_000,
  );

  it("returns HTTP 413 for a /mcp request body above the explicit MCP transport cap", async () => {
    const { baseUrl } = await setupTransportApp();

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_BEARER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 1,
        params: {
          name: "apply_change_set",
          arguments: {
            base_commit: "0".repeat(40),
            summary: "Oversize",
            operations: [
              { op: "create", path: "tasks/oversize.md", content: "x".repeat(MCP_MAX_REQUEST_BYTES) },
            ],
          },
        },
      }),
    });
    expect(res.status).toBe(413);
  }, 60_000);

  it(
    "rejects a logical >2 MiB write at the workspace layer after transport accepts it",
    async () => {
      const { baseUrl } = await setupTransportApp();
      const client = await connectClient(baseUrl);

      const status = await client.callTool({ name: "workspace_status" });
      const baseCommit = (status.structuredContent as { local_commit: string }).local_commit;

      // 2.5 MiB of content: fits the MCP transport envelope (~2.6 MiB wire) but
      // exceeds the workspace logical maxFileWriteBytes/maxTotalWriteBytes.
      const content = "x".repeat(2 * MiB + 512 * KiB);
      const applyRes = await client.callTool({
        name: "apply_change_set",
        arguments: {
          base_commit: baseCommit,
          summary: "Logically oversized",
          operations: [
            { op: "create", path: "tasks/too-big.md", content },
          ],
        },
      });

      // Business-layer rejection: the tool executed and returned a tool error,
      // it was not an HTTP 413 transport rejection.
      expect(applyRes.isError).toBe(true);
      const text = JSON.stringify(applyRes);
      expect(text).toContain("2 MiB");
      expect(text).not.toContain("PayloadTooLarge");

      await client.close();
    },
    60_000,
  );

  it("keeps ordinary JSON routes at the Express default 100 KiB limit", async () => {
    const { baseUrl } = await setupTransportApp();

    const small = await fetch(`${baseUrl}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(KiB) }),
    });
    expect(small.status).toBe(200);

    const big = await fetch(`${baseUrl}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(150 * KiB) }),
    });
    expect(big.status).toBe(413);
  });

  it("keeps protocol CORS headers visible on /mcp parser errors (400 malformed, 413 oversized)", async () => {
    const { baseUrl } = await setupTransportApp();

    const malformed = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Origin: BROWSER_ORIGIN,
        Authorization: `Bearer ${TEST_BEARER}`,
        "Content-Type": "application/json",
      },
      body: "{not-json",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("access-control-allow-origin")).toBe(BROWSER_ORIGIN);
    expect(malformed.headers.get("vary")).toContain("Origin");

    const oversized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Origin: BROWSER_ORIGIN,
        Authorization: `Bearer ${TEST_BEARER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 1,
        params: {
          name: "apply_change_set",
          arguments: {
            base_commit: "0".repeat(40),
            summary: "Oversize",
            operations: [
              { op: "create", path: "tasks/oversize.md", content: "x".repeat(MCP_MAX_REQUEST_BYTES) },
            ],
          },
        },
      }),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("access-control-allow-origin")).toBe(BROWSER_ORIGIN);
    expect(oversized.headers.get("vary")).toContain("Origin");
  }, 60_000);

  it("leaves the Connector managed-result path to its own route-scoped 3 MiB parser", async () => {
    const { baseUrl } = await setupTransportApp();

    // 200 KiB: above the ordinary 100 KiB parser limit, below the route's
    // 3 MiB limit. The route-aware parser must skip this path so the route's
    // own parser can accept it.
    const okRes = await fetch(`${baseUrl}/api/connector/jobs/job_1/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(200 * KiB) }),
    });
    expect(okRes.status).toBe(200);

    // Above the route-scoped 3 MiB parser limit: still bounded.
    const tooBig = await fetch(`${baseUrl}/api/connector/jobs/job_1/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(3 * MiB + 64 * KiB) }),
    });
    expect(tooBig.status).toBe(413);
  });
});