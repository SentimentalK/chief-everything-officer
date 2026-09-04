import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { loadProductPolicy } from "./product-policy.js";
import { CeoWorkspace } from "./workspace.js";
import { createAuthMiddleware, createHostGuard, createOriginGuard } from "./auth.js";
import { AuditStore, createAuditRouter } from "./audit.js";

const config = loadConfig();
const workspace = new CeoWorkspace(config);
await workspace.initialize();
const productPolicy = await loadProductPolicy();
const auditStore = new AuditStore(config.auditDbPath);

const app = createMcpExpressApp({ host: config.bindHost });
app.use(express.json());

// Probes
app.get("/healthz", (_req, res) => { res.status(200).json({ ok: true }); });
app.get("/readyz", (_req, res) => {
  const ready = workspace.readiness === "READY";
  res.status(ready ? 200 : 503).json({ ok: ready, state: workspace.readiness });
});

// Audit routes
const currentDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const candidates = [
  path.resolve(currentDir, "../audit-web/dist"),
  path.resolve(currentDir, "../audit-web"),
  path.resolve(currentDir, "audit-web/dist"),
  path.resolve(currentDir, "audit-web"),
  "/app/audit-web",
];
const auditWebDir = candidates.find((dir) => fs.existsSync(dir) && fs.existsSync(path.join(dir, "index.html")));

app.use(createAuditRouter({
  auditStore,
  apiKey: config.mcpApiKey,
  auditWebDir,
}));

// MCP handler (dedicated to /mcp - UNCHANGED)
const mcpHandler = createMcpHandler(() => createMcpServer(workspace, productPolicy, auditStore), {
  legacy: "reject",
});
const nodeHandler = toNodeHandler(mcpHandler);

app.all(
  "/mcp",
  createHostGuard(config.allowedHosts),
  createOriginGuard(config.allowedOrigins),
  createAuthMiddleware(config.mcpApiKey),
  (req, res) => {
    void nodeHandler(req, res, req.body);
  },
);

const listener = app.listen(config.port, config.bindHost, () => {
  process.stdout.write(`CEO State MCP listening on http://${config.bindHost}:${config.port}/mcp\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    auditStore.close();
    listener.close(() => process.exit(0));
  });
}
