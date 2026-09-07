import express, { type Request, type Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { loadProductPolicy } from "./product-policy.js";
import { CeoWorkspace } from "./workspace.js";
import { createHostGuard, createOriginGuard, createIdentityAuthMiddleware } from "./auth.js";
import { IdentityService } from "./identity/service.js";
import { AuditStore, createAuditRouter } from "./audit.js";
import { BUILD_INFO } from "./build-info.js";
import { openJobBridge } from "./jobs/bridge.js";
import { resolveResourceLocation } from "./resource/locator.js";

function fatal(prefix: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${prefix}: ${message}\n`);
  process.exit(1);
}

// ---- Configuration ----
const config = loadConfig();

// ---- Identity layer (authoritative, required, fail-fast) ----
// Identity DB must already exist (created by `dist/identity/cli.js init`).
// The service runs the full check + optional key-rotation sequence; any
// mismatch, missing/corrupt DB, or disabled/binding error aborts startup.
let identityService: IdentityService;
try {
  identityService = IdentityService.open(
    {
      remoteUrl: config.remoteUrl,
      branch: config.branch,
      envApiKey: config.mcpApiKey,
    },
    config.identityDbPath,
  );
} catch (error) {
  fatal("identity", error);
}

// ---- Git workspace ----
const workspace = new CeoWorkspace(config);
const productPolicy = await loadProductPolicy();
await workspace.initialize();

const auditStore = new AuditStore(config.auditDbPath);

const app = createMcpExpressApp({ host: config.bindHost });
app.use(express.json());

// Probes
app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true, version: BUILD_INFO.version, build: BUILD_INFO.build });
});
app.get("/readyz", (_req, res) => {
  const ready = workspace.readiness === "READY";
  res.status(ready ? 200 : 503).json({
    ok: ready,
    state: workspace.readiness,
    version: BUILD_INFO.version,
    build: BUILD_INFO.build,
  });
});

// Read-only identity endpoint: which user/workspace this key connects to.
app.get(
  "/api/identity",
  createHostGuard(config.allowedHosts),
  createOriginGuard(config.allowedOrigins),
  createIdentityAuthMiddleware(identityService),
  (_req: Request, res: Response) => {
    res.status(200).json({
      user_id: identityService.workspaceIdentityValue.user_id,
      workspace_id: identityService.workspaceIdentityValue.workspace_id,
      deployment_mode: "single_user",
    });
  },
);

// Audit routes (login, session + query endpoints) reuse the same identity layer.
app.use(
  createAuditRouter({
    auditStore,
    identityService,
  }),
);

// Fixed workspace identity for the MCP tools (no api_key_id). Authentication is
// enforced at the /mcp boundary by the identity middleware per request.
const workspaceIdentity = identityService.workspaceIdentityValue;

// Optional worker-bridge job layer (disabled unless configured). Resource
// existence for new tasks is checked against the single-user repo contents.
const jobBridge = openJobBridge({
  bridgeEnabled: config.bridgeEnabled,
  redisUrl: config.redisUrl,
}, async (_scope, resourceId) => {
  const loc = await resolveResourceLocation(workspace.config.repoDir, resourceId);
  return loc !== null;
});

// MCP handler (dedicated to /mcp)
const mcpHandler = createMcpHandler(
  () => createMcpServer(workspace, productPolicy, {
    auditStore,
    identity: workspaceIdentity,
    jobs: { service: jobBridge.service },
  }),
  { legacy: "reject" },
);
const nodeHandler = toNodeHandler(mcpHandler);

app.all(
  "/mcp",
  createHostGuard(config.allowedHosts),
  createOriginGuard(config.allowedOrigins),
  createIdentityAuthMiddleware(identityService),
  (req: Request, res: Response) => {
    void nodeHandler(req, res, req.body);
  },
);

const listener = app.listen(config.port, config.bindHost, () => {
  process.stdout.write(`CEO MCP listening on http://${config.bindHost}:${config.port}/mcp\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    auditStore.close();
    identityService.close();
    void jobBridge.dispose();
    listener.close(() => process.exit(0));
  });
}
