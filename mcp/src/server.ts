import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { LifeOSWorkspace } from "./workspace.js";
import { createAuthMiddleware, createHostGuard, createOriginGuard } from "./auth.js";

const config = loadConfig();
const workspace = new LifeOSWorkspace(config);
await workspace.initialize();

const app = createMcpExpressApp({ host: config.bindHost });

app.get("/healthz", (_req, res) => { res.status(200).json({ ok: true }); });
app.get("/readyz", (_req, res) => {
  const ready = workspace.readiness === "READY";
  res.status(ready ? 200 : 503).json({ ok: ready, state: workspace.readiness });
});

const mcpHandler = createMcpHandler(() => createMcpServer(workspace), {
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
  process.stdout.write(`LifeOS MCP listening on http://${config.bindHost}:${config.port}/mcp\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    listener.close(() => process.exit(0));
  });
}
