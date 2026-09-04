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
import { AuditStore, createAuditRouter } from "../src/audit.js";
import { LifeOSWorkspace } from "../src/workspace.js";
import { loadProductPolicy } from "../src/product-policy.js";
import { createMcpServer } from "../src/mcp.js";
import { fixture } from "./helpers.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";

const cleanupDirs: string[] = [];
const cleanupServers: HttpServer[] = [];
const cleanupStores: AuditStore[] = [];

afterEach(async () => {
  for (const s of cleanupServers.splice(0)) {
    s.closeAllConnections?.();
    s.closeIdleConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
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
    const inputJson = JSON.stringify({ name: "router" });
    const outputJson = JSON.stringify({ content: [{ type: "text", text: "policy markdown" }] });

    store.recordTrace({
      timestamp_ms: now,
      tool_name: "policy_read",
      status: "success",
      input_json: inputJson,
      output_json: outputJson,
      latency_ms: 12,
    });

    const summaries = store.listSummaries();
    expect(summaries.length).toBe(1);
    const s = summaries[0]!;
    expect(s.tool_name).toBe("policy_read");
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
    const detail = store.getDetail(s.id);
    expect(detail).not.toBeNull();
    expect(detail!.input_json).toBe(inputJson);
    expect(detail!.output_json).toBe(outputJson);
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
        timestamp_ms: Date.now(),
        tool_name: "test_tool",
        status: "success",
        input_json: "{}",
        output_json: "{}",
        latency_ms: 5,
      });
    }).not.toThrow();
  });

  it("captures tool invocations at MCP handler boundary", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new LifeOSWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();

    const auditTmpDir = await mkdtemp(path.join(os.tmpdir(), "ceo-audit-test-"));
    cleanupDirs.push(auditTmpDir);
    const auditStore = new AuditStore(path.join(auditTmpDir, "ceo-trace.sqlite"));
    cleanupStores.push(auditStore);

    const mcpHandler = createMcpHandler(() => createMcpServer(workspace, policy, auditStore), { legacy: "reject" });
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
    await client.callTool({ name: "policy_read", arguments: { name: "router" } });

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

    const traces = auditStore.listSummaries();
    expect(traces.length).toBe(3);

    const writeTrace = traces.find((t) => t.tool_name === "apply_change_set");
    expect(writeTrace).toBeDefined();
    expect(writeTrace!.status).toBe("success");
    expect(writeTrace!.operation_request_id).toBe(requestId);
    expect(writeTrace!.affected_paths).toEqual(["tasks/AUDIT-TEST.md"]);
    expect(writeTrace!.resulting_commit).toBeTruthy();

    const policyTrace = traces.find((t) => t.tool_name === "policy_read");
    expect(policyTrace).toBeDefined();
    expect(policyTrace!.status).toBe("success");

    const policyDetail = auditStore.getDetail(policyTrace!.id);
    expect(policyDetail).toBeDefined();
    expect(JSON.parse(policyDetail!.input_json)).toEqual({ name: "router" });
    const parsedOutput = JSON.parse(policyDetail!.output_json);
    expect(parsedOutput.structuredContent.name).toBe("router");
  });

  it("never records API key or auth secrets in trace database", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new LifeOSWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();

    const auditTmpDir = await mkdtemp(path.join(os.tmpdir(), "ceo-audit-test-"));
    cleanupDirs.push(auditTmpDir);
    const dbPath = path.join(auditTmpDir, "ceo-trace.sqlite");
    const auditStore = new AuditStore(dbPath);
    cleanupStores.push(auditStore);

    const testApiKey = "secret-mcp-api-key-test-999";
    const mcpHandler = createMcpHandler(() => createMcpServer(workspace, policy, auditStore), { legacy: "reject" });
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

    const app = express();
    app.use(createAuditRouter({ auditStore, apiKey }));

    const server = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    cleanupServers.push(server);
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    return { baseUrl, auditStore, apiKey };
  }

  it("enforces authentication on /api/audit/traces", async () => {
    const { baseUrl } = await setupTestApp();

    const res = await fetch(`${baseUrl}/api/audit/traces`);
    expect(res.status).toBe(401);
  });

  it("handles login, session status, authenticated query, detail, and logout lifecycle", async () => {
    const { baseUrl, auditStore, apiKey } = await setupTestApp();

    // Seed a trace
    auditStore.recordTrace({
      timestamp_ms: Date.now(),
      tool_name: "list_files",
      status: "success",
      input_json: JSON.stringify({ pattern: "tasks/*.md" }),
      output_json: JSON.stringify({ files: ["tasks/001.md"] }),
      latency_ms: 8,
    });

    // 1. Initially unauthenticated
    const checkUnauth = await fetch(`${baseUrl}/api/audit/session`);
    expect(checkUnauth.status).toBe(200);
    const checkUnauthBody = await checkUnauth.json();
    expect(checkUnauthBody).toEqual({ authenticated: false });

    // 2. Login with bad token -> 401
    const badLogin = await fetch(`${baseUrl}/api/audit/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    expect(badLogin.status).toBe(401);

    // 3. Login with correct token -> 200 and Set-Cookie
    const goodLogin = await fetch(`${baseUrl}/api/audit/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: apiKey }),
    });
    expect(goodLogin.status).toBe(200);
    const cookieHeader = goodLogin.headers.get("set-cookie");
    expect(cookieHeader).toBeTruthy();
    expect(cookieHeader).toContain("ceo_audit_session=");
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite=Strict");

    const sessionCookie = cookieHeader!.split(";")[0]!;

    // 4. Check authenticated session status
    const checkAuth = await fetch(`${baseUrl}/api/audit/session`, {
      headers: { Cookie: sessionCookie },
    });
    expect(checkAuth.status).toBe(200);
    const checkAuthBody = await checkAuth.json();
    expect(checkAuthBody).toEqual({ authenticated: true });

    // 5. Query trace summaries
    const tracesRes = await fetch(`${baseUrl}/api/audit/traces`, {
      headers: { Cookie: sessionCookie },
    });
    expect(tracesRes.status).toBe(200);
    const tracesBody = await tracesRes.json();
    expect(tracesBody.ok).toBe(true);
    expect(tracesBody.traces.length).toBe(1);
    const traceId = tracesBody.traces[0].id;

    // 6. Query trace detail
    const detailRes = await fetch(`${baseUrl}/api/audit/traces/${traceId}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.ok).toBe(true);
    expect(detailBody.trace.tool_name).toBe("list_files");
    expect(JSON.parse(detailBody.trace.input_json)).toEqual({ pattern: "tasks/*.md" });

    // 7. Also verify direct Bearer auth works
    const bearerRes = await fetch(`${baseUrl}/api/audit/traces`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(bearerRes.status).toBe(200);

    // 8. Logout
    const logoutRes = await fetch(`${baseUrl}/api/audit/session`, {
      method: "DELETE",
      headers: { Cookie: sessionCookie },
    });
    expect(logoutRes.status).toBe(200);
    const logoutCookie = logoutRes.headers.get("set-cookie");
    expect(logoutCookie).toContain("Max-Age=0");

    // 9. Session is now invalidated
    const checkAfterLogout = await fetch(`${baseUrl}/api/audit/session`, {
      headers: { Cookie: sessionCookie },
    });
    const checkAfterLogoutBody = await checkAfterLogout.json();
    expect(checkAfterLogoutBody).toEqual({ authenticated: false });

    // 10. Traces endpoint rejects invalidated session
    const tracesAfterLogout = await fetch(`${baseUrl}/api/audit/traces`, {
      headers: { Cookie: sessionCookie },
    });
    expect(tracesAfterLogout.status).toBe(401);
  });
});
