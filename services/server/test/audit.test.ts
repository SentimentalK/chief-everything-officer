import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { DatabaseSync } from "node:sqlite";
import { AuditStore, AuditSchemaIncompatibleError, createAuditRouter } from "../src/audit.js";
import { CeoWorkspace } from "../src/workspace.js";
import { loadProductPolicy } from "../src/product-policy.js";
import { createMcpServer } from "../src/mcp.js";
import { fixture, seedIdentity } from "./helpers.js";
import { IdentityService } from "../src/identity/service.js";
import { UserSessionManager } from "../src/auth/user-session.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";

const cleanupDirs: string[] = [];
const cleanupServers: HttpServer[] = [];
const cleanupServices: IdentityService[] = [];
const cleanupStores: AuditStore[] = [];

afterEach(async () => {
  for (const s of cleanupServers.splice(0)) {
    s.closeAllConnections?.();
    s.closeIdleConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const svc of cleanupServices.splice(0)) {
    svc.close();
  }
  for (const store of cleanupStores.splice(0)) {
    store.close();
  }
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AuditStore & Boundary Tracing", () => {
  it("initializes SQLite with WAL mode, correct permissions and schema", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ceo-audit-test-"));
    cleanupDirs.push(tmpDir);
    const dbPath = path.join(tmpDir, "sub", "ceo-trace.sqlite");

    const store = new AuditStore(dbPath);
    cleanupStores.push(store);

    expect(fs.existsSync(dbPath)).toBe(true);
    const dirStat = fs.statSync(path.dirname(dbPath));
    // 0o700 is 448 in decimal
    expect(dirStat.mode & 0o777).toBe(0o700);

    const fileStat = fs.statSync(dbPath);
    // 0o600 is 384 in decimal
    expect(fileStat.mode & 0o777).toBe(0o600);

    // Verify WAL mode directly
    const rawDb = new DatabaseSync(dbPath);
    const pragmaRes = rawDb.prepare("PRAGMA journal_mode;").get() as { journal_mode: string };
    expect(pragmaRes.journal_mode.toLowerCase()).toBe("wal");
    rawDb.close();
  });

  it("records traces, computes byte and token metrics (Math.ceil(chars/4)) correctly", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ceo-audit-test-"));
    cleanupDirs.push(tmpDir);
    const dbPath = path.join(tmpDir, "ceo-trace.sqlite");

    const store = new AuditStore(dbPath);
    cleanupStores.push(store);

    const now = Date.now();
    const inputJson = JSON.stringify({ name: "task" });
    const outputJson = JSON.stringify({ content: [{ type: "text", text: "policy markdown" }] });

    store.recordTrace({
      workspace_id: "ws_test",
      timestamp_ms: now,
      tool_name: "policy_read",
      status: "success",
      input_json: inputJson,
      output_json: outputJson,
      latency_ms: 12,
    });

    const summaries = store.listSummaries("ws_test");
    expect(summaries.length).toBe(1);
    const s = summaries[0]!;
    expect(s.tool_name).toBe("policy_read");
    expect(s.workspace_id).toBe("ws_test");
    expect(s.status).toBe("success");
    expect(s.input_chars).toBe(inputJson.length);
    expect(s.output_chars).toBe(outputJson.length);
    expect(s.input_tokens_est).toBe(Math.ceil(inputJson.length / 4));
    expect(s.output_tokens_est).toBe(Math.ceil(outputJson.length / 4));
    expect(s.total_tokens_est).toBe(s.input_tokens_est + s.output_tokens_est);
    expect(s.latency_ms).toBe(12);
    // Check that summary does NOT include input_json or output_json
    expect((s as any).input_json).toBeUndefined();
    expect((s as any).output_json).toBeUndefined();

    // Check detail
    const detail = store.getDetail("ws_test", s.id);
    expect(detail).not.toBeNull();
    expect(detail!.workspace_id).toBe("ws_test");
    expect(detail!.input_json).toBe(inputJson);
    expect(detail!.output_json).toBe(outputJson);

    // Cross-workspace lookup returns nothing
    expect(store.listSummaries("other_ws")).toEqual([]);
    expect(store.getDetail("other_ws", s.id)).toBeNull();
  });

  it("fails open when database write fails without throwing", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ceo-audit-test-"));
    cleanupDirs.push(tmpDir);
    const dbPath = path.join(tmpDir, "ceo-trace.sqlite");

    const store = new AuditStore(dbPath);
    store.close();

    // Must not throw
    expect(() => {
      store.recordTrace({
        workspace_id: "ws_test",
        timestamp_ms: Date.now(),
        tool_name: "test_tool",
        status: "success",
        input_json: "{}",
        output_json: "{}",
        latency_ms: 5,
      });
    }).not.toThrow();
  });

  it("fails fast at AuditStore initialization if traces table lacks workspace_id", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ceo-audit-incompat-test-"));
    cleanupDirs.push(tmpDir);
    const dbPath = path.join(tmpDir, "incompat-trace.sqlite");

    // Create legacy table without workspace_id
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        input_bytes INTEGER NOT NULL,
        output_bytes INTEGER NOT NULL,
        input_chars INTEGER NOT NULL,
        output_chars INTEGER NOT NULL,
        input_tokens_est INTEGER NOT NULL,
        output_tokens_est INTEGER NOT NULL,
        total_tokens_est INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL
      );
    `);
    legacyDb.close();

    expect(() => new AuditStore(dbPath)).toThrow(AuditSchemaIncompatibleError);
  });

  it("captures tool invocations at MCP handler boundary", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();

    const auditTmpDir = await mkdtemp(path.join(os.tmpdir(), "ceo-audit-test-"));
    cleanupDirs.push(auditTmpDir);
    const auditStore = new AuditStore(path.join(auditTmpDir, "ceo-trace.sqlite"));
    cleanupStores.push(auditStore);

    const mcpIdentity = { user_id: "usr_test", workspace_id: "ws_mcp_test" };
    const mcpHandler = createMcpHandler(
      () => createMcpServer(workspace, policy, { auditStore, identity: mcpIdentity }),
      { legacy: "reject" },
    );
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => mcpHandler.fetch(new Request(url, init)),
    });

    const client = new Client(
      { name: "audit-test-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);

    // Call workspace_status
    const statusRes = await client.callTool({ name: "workspace_status" });
    const headCommit = (statusRes.structuredContent as { local_commit: string }).local_commit;

    // Call policy_read
    await client.callTool({ name: "policy_read", arguments: { name: "tasks" } });

    // Call apply_change_set with valid arguments
    const requestId = randomUUID();
    const applyRes = await client.callTool({
      name: "apply_change_set",
      arguments: {
        request_id: requestId,
        base_commit: headCommit,
        summary: "Audit test change",
        operations: [
          {
            op: "create",
            path: "tasks/AUDIT-TEST.md",
            content: "# Audit Test\n",
          },
        ],
      },
    });
    expect(applyRes.isError).toBeFalsy();

    const traces = auditStore.listSummaries("ws_mcp_test");
    expect(traces.length).toBe(3);

    const writeTrace = traces.find((t) => t.tool_name === "apply_change_set");
    expect(writeTrace).toBeDefined();
    expect(writeTrace!.workspace_id).toBe("ws_mcp_test");
    expect(writeTrace!.status).toBe("success");
    expect(writeTrace!.operation_request_id).toBe(requestId);
    expect(writeTrace!.affected_paths).toEqual(["tasks/AUDIT-TEST.md"]);
    expect(writeTrace!.resulting_commit).toBeTruthy();
    expect(writeTrace!.semantic_output_bytes).not.toBeNull();
    expect(writeTrace!.semantic_output_bytes!).toBeLessThan(writeTrace!.output_bytes);
    expect(writeTrace!.semantic_output_tokens_est!).toBeLessThanOrEqual(writeTrace!.output_tokens_est);

    const policyTrace = traces.find((t) => t.tool_name === "policy_read");
    expect(policyTrace).toBeDefined();
    expect(policyTrace!.workspace_id).toBe("ws_mcp_test");
    expect(policyTrace!.status).toBe("success");
    expect(policyTrace!.semantic_output_bytes).not.toBeNull();
    expect(policyTrace!.semantic_output_bytes!).toBeLessThan(policyTrace!.output_bytes);

    const policyDetail = auditStore.getDetail("ws_mcp_test", policyTrace!.id);
    expect(policyDetail).toBeDefined();
    expect(policyDetail!.workspace_id).toBe("ws_mcp_test");
    expect(JSON.parse(policyDetail!.input_json)).toEqual({ name: "tasks" });
    const parsedOutput = JSON.parse(policyDetail!.output_json);
    expect(parsedOutput.structuredContent.name).toBe("tasks");

    // Other workspace has no traces
    expect(auditStore.listSummaries("other_ws")).toEqual([]);
    expect(auditStore.getDetail("other_ws", policyTrace!.id)).toBeNull();
  });

  it("migrates pre-existing database without semantic columns and preserves null for legacy traces", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ceo-audit-migration-test-"));
    cleanupDirs.push(tmpDir);
    const dbPath = path.join(tmpDir, "legacy-trace.sqlite");

    // Create legacy table with workspace_id but without semantic_output_* columns
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        operation_request_id TEXT,
        input_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        input_bytes INTEGER NOT NULL,
        output_bytes INTEGER NOT NULL,
        input_chars INTEGER NOT NULL,
        output_chars INTEGER NOT NULL,
        input_tokens_est INTEGER NOT NULL,
        output_tokens_est INTEGER NOT NULL,
        total_tokens_est INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        affected_paths_json TEXT,
        resulting_commit TEXT
      );
    `);
    legacyDb.prepare(`
      INSERT INTO traces (
        workspace_id, timestamp_ms, tool_name, status, input_json, output_json,
        input_bytes, output_bytes, input_chars, output_chars,
        input_tokens_est, output_tokens_est, total_tokens_est, latency_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "ws_legacy", Date.now(), "list_files", "success", "{}", "{}",
      2, 2, 2, 2,
      1, 1, 2, 5
    );
    legacyDb.close();

    // Now open via AuditStore
    const store = new AuditStore(dbPath);
    cleanupStores.push(store);

    // Verify columns were added
    const rawDb = new DatabaseSync(dbPath);
    const cols = rawDb.prepare("PRAGMA table_info(traces)").all() as Array<{ name: string }>;
    rawDb.close();
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames.has("semantic_output_bytes")).toBe(true);
    expect(colNames.has("semantic_output_chars")).toBe(true);
    expect(colNames.has("semantic_output_tokens_est")).toBe(true);

    // Verify legacy summary preserves null (strictly null, not 0)
    const summaries = store.listSummaries("ws_legacy");
    expect(summaries.length).toBe(1);
    const legacySummary = summaries[0]!;
    expect(legacySummary.semantic_output_bytes).toBeNull();
    expect(legacySummary.semantic_output_chars).toBeNull();
    expect(legacySummary.semantic_output_tokens_est).toBeNull();

    // Verify legacy detail preserves null
    const legacyDetail = store.getDetail("ws_legacy", legacySummary.id);
    expect(legacyDetail).not.toBeNull();
    expect(legacyDetail!.semantic_output_bytes).toBeNull();
    expect(legacyDetail!.semantic_output_chars).toBeNull();
    expect(legacyDetail!.semantic_output_tokens_est).toBeNull();

    // Record new trace with semantic output and verify it's populated
    store.recordTrace({
      workspace_id: "ws_legacy",
      timestamp_ms: Date.now(),
      tool_name: "read_files",
      status: "success",
      input_json: JSON.stringify({ paths: ["foo.md"] }),
      output_json: JSON.stringify({ content: [{ type: "text", text: "bar" }] }),
      semantic_output_json: JSON.stringify({ files: [{ path: "foo.md", content: "bar" }] }),
      latency_ms: 10,
    });

    const updatedSummaries = store.listSummaries("ws_legacy");
    expect(updatedSummaries.length).toBe(2);
    const newSummary = updatedSummaries[0]!;
    expect(newSummary.semantic_output_bytes).not.toBeNull();
    expect(newSummary.semantic_output_bytes).toBeGreaterThan(0);
    expect(newSummary.semantic_output_chars).toBeGreaterThan(0);
    expect(newSummary.semantic_output_tokens_est).toBeGreaterThan(0);
  });

  it("never records API key or auth secrets in trace database", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();

    const auditTmpDir = await mkdtemp(path.join(os.tmpdir(), "ceo-audit-test-"));
    cleanupDirs.push(auditTmpDir);
    const dbPath = path.join(auditTmpDir, "ceo-trace.sqlite");
    const auditStore = new AuditStore(dbPath);
    cleanupStores.push(auditStore);

    const testApiKey = "secret-mcp-api-key-test-999";
    const mcpIdentity = { user_id: "usr_test", workspace_id: "ws_test" };
    const mcpHandler = createMcpHandler(
      () => createMcpServer(workspace, policy, { auditStore, identity: mcpIdentity }),
      { legacy: "reject" },
    );
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${testApiKey}`);
        return mcpHandler.fetch(new Request(url, { ...init, headers }));
      },
    });

    const client = new Client(
      { name: "audit-test-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
    await client.callTool({ name: "workspace_status" });

    // Inspect SQLite raw content
    const rawDb = new DatabaseSync(dbPath);
    const allRows = rawDb.prepare("SELECT * FROM traces").all() as Record<string, unknown>[];
    rawDb.close();

    expect(allRows.length).toBe(1);
    const jsonDump = JSON.stringify(allRows);
    expect(jsonDump).not.toContain(testApiKey);
  });
});

describe("Audit HTTP API & Session Management", () => {
  async function setupTestApp(apiKey = "test-secret-key") {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ceo-audit-api-test-"));
    cleanupDirs.push(tmpDir);
    const dbPath = path.join(tmpDir, "ceo-trace.sqlite");
    const auditStore = new AuditStore(dbPath);
    cleanupStores.push(auditStore);

    const identityDbPath = path.join(tmpDir, "identity", "identity.sqlite");
    const ident = seedIdentity(
      { identityDbPath, remoteUrl: "dummy-remote", branch: "main" },
      apiKey,
    );
    const service = IdentityService.open(identityDbPath);
    cleanupServices.push(service);

    const sessionManager = new UserSessionManager({ secureCookies: false });
    const app = express();
    app.use(express.json());
    app.use(createAuditRouter({ auditStore, identityService: service, sessionManager }));

    const server = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    cleanupServers.push(server);
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    return { baseUrl, auditStore, apiKey, ident, service, sessionManager };
  }

  function userCookie(
    env: Awaited<ReturnType<typeof setupTestApp>>,
    userId = env.ident.user_id,
    grantAdmin = true,
  ): string {
    if (grantAdmin) {
      env.service.storeInstance.grantAdmin(userId);
    }
    const session = env.sessionManager.createSession({
      userId,
      provider: "github",
      providerSubject: "1",
    });
    return `ceo_user_session=${session.sessionId}`;
  }

  it("returns 403 for a signed-in non-admin user", async () => {
    const env = await setupTestApp();
    env.service.storeInstance.withDb((db) => {
      db.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES ('usr_bob', 2000, NULL);").run();
    });
    const cookie = userCookie(env, "usr_bob", false);

    const res = await fetch(`${env.baseUrl}/api/audit/traces`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toContain("Audit access denied");

    const session = await fetch(`${env.baseUrl}/api/audit/session`, { headers: { Cookie: cookie } });
    expect(await session.json()).toEqual({
      authenticated: true,
      authorized: false,
      user: { id: "usr_bob" },
    });
  });

  it("enforces authentication on /api/audit/traces", async () => {
    const { baseUrl } = await setupTestApp();

    const res = await fetch(`${baseUrl}/api/audit/traces`);
    expect(res.status).toBe(401);
  });

  it("handles admin session query, detail, tenant isolation, and logout", async () => {
    const env = await setupTestApp();
    const myWorkspaceId = env.ident.workspace_id;
    const cookie = userCookie(env);

    env.auditStore.recordTrace({
      workspace_id: myWorkspaceId,
      timestamp_ms: Date.now(),
      tool_name: "list_files",
      status: "success",
      input_json: JSON.stringify({ pattern: "tasks/*.md" }),
      output_json: JSON.stringify({ files: ["tasks/001.md"] }),
      latency_ms: 8,
    });
    env.auditStore.recordTrace({
      workspace_id: "ws_other_tenant",
      timestamp_ms: Date.now(),
      tool_name: "policy_read",
      status: "success",
      input_json: "{}",
      output_json: "{}",
      latency_ms: 5,
    });

    const checkUnauth = await fetch(`${env.baseUrl}/api/audit/session`);
    expect(await checkUnauth.json()).toEqual({ authenticated: false, authorized: false });

    const checkAuth = await fetch(`${env.baseUrl}/api/audit/session`, { headers: { Cookie: cookie } });
    expect(await checkAuth.json()).toEqual({
      authenticated: true,
      authorized: true,
      user: { id: env.ident.user_id },
    });

    const tracesRes = await fetch(`${env.baseUrl}/api/audit/traces`, { headers: { Cookie: cookie } });
    expect(tracesRes.status).toBe(200);
    const tracesBody = await tracesRes.json() as { traces: Array<{ id: number }> };
    expect(tracesBody.traces.length).toBe(1);
    const traceId = tracesBody.traces[0]!.id;

    const detailRes = await fetch(`${env.baseUrl}/api/audit/traces/${traceId}`, { headers: { Cookie: cookie } });
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json() as { trace: { tool_name: string; input_json: string } };
    expect(detailBody.trace.tool_name).toBe("list_files");
    expect(JSON.parse(detailBody.trace.input_json)).toEqual({ pattern: "tasks/*.md" });

    const logoutRes = await fetch(`${env.baseUrl}/api/audit/session`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.headers.getSetCookie().some((c) => c.includes("Max-Age=0"))).toBe(true);

    const checkAfterLogout = await fetch(`${env.baseUrl}/api/audit/session`, { headers: { Cookie: cookie } });
    expect(await checkAfterLogout.json()).toEqual({ authenticated: false, authorized: false });
    expect((await fetch(`${env.baseUrl}/api/audit/traces`, { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("session status stays 200/false without a cookie (even with Bearer)", async () => {
    const { baseUrl, apiKey } = await setupTestApp();

    const noCookie = await fetch(`${baseUrl}/api/audit/session`);
    expect(await noCookie.json()).toEqual({ authenticated: false, authorized: false });

    const withBearer = await fetch(`${baseUrl}/api/audit/session`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(await withBearer.json()).toEqual({ authenticated: false, authorized: false });
  });

  it("returns 503 on identity DB fault without treating it as logout", async () => {
    const env = await setupTestApp();
    const cookie = userCookie(env);
    env.service.close();

    const cookieTraces = await fetch(`${env.baseUrl}/api/audit/traces`, { headers: { Cookie: cookie } });
    expect(cookieTraces.status).toBe(503);

    const cookieStatus = await fetch(`${env.baseUrl}/api/audit/session`, { headers: { Cookie: cookie } });
    expect(cookieStatus.status).toBe(503);
  });

  it("does not serve /audit static frontend or SPA fallback", async () => {
    const { baseUrl } = await setupTestApp();

    const res = await fetch(`${baseUrl}/audit`);
    expect(res.status).toBe(404);

    const subRes = await fetch(`${baseUrl}/audit/subpath`);
    expect(subRes.status).toBe(404);
  });
});
