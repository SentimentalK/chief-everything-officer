import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

app.post("/mcp", createHostGuard(config.allowedHosts), createOriginGuard(config.allowedOrigins), createAuthMiddleware(config.mcpApiKey), async (req, res) => {
  const server = createMcpServer(workspace);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  } finally {
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});
app.delete("/mcp", (_req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

const listener = app.listen(config.port, config.bindHost, () => {
  process.stdout.write(`LifeOS MCP listening on http://${config.bindHost}:${config.port}/mcp\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    listener.close(() => process.exit(0));
  });
}
