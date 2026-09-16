import { describe, expect, it } from "vitest";
import express from "express";
import {
  attachMcpProtocolLog,
  classifyMcpUserAgent,
  extractMcpRpcMethod,
} from "../src/http/mcp-observability.js";

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const orig = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  const fake = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = fake as never;
  try {
    await fn();
  } finally {
    (process.stderr as unknown as { write: typeof orig }).write = orig as never;
  }
  return chunks.join("");
}

describe("MCP protocol observability", () => {
  it("extracts JSON-RPC method without retaining params or tokens", () => {
    expect(extractMcpRpcMethod({ jsonrpc: "2.0", method: "initialize", params: { secret: "nope" }, id: 1 })).toBe(
      "initialize",
    );
    expect(extractMcpRpcMethod({ method: "tools/list" })).toBe("tools/list");
    expect(extractMcpRpcMethod([{ method: "initialize" }, { method: "tools/list" }])).toBe("batch");
    expect(extractMcpRpcMethod(undefined)).toBeUndefined();
  });

  it("classifies Spark-style user agents without logging the raw string", () => {
    expect(classifyMcpUserAgent("Google")).toBe("google");
    expect(classifyMcpUserAgent("OpenAuth")).toBe("openauth");
    expect(classifyMcpUserAgent("Mozilla/5.0 (X11; Linux x86_64) Chrome/151")).toBe("mozilla");
    expect(classifyMcpUserAgent(undefined)).toBeUndefined();
  });

  it("logs authenticated initialize request/response without body secrets", async () => {
    const app = express();
    app.use(express.json());
    app.post("/mcp", (req, res) => {
      attachMcpProtocolLog(req, res);
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32022, message: "Unsupported protocol version" },
        id: 1,
      });
    });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const secret = "ceo_at_must_not_appear_in_mcp_logs";
    try {
      const log = await captureStderr(async () => {
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
            "MCP-Protocol-Version": "2025-03-26",
            "User-Agent": "Google",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-03-26", clientInfo: { name: "Gemini" } },
          }),
        });
        expect(res.status).toBe(400);
      });
      expect(log).toContain("mcp: request method=POST rpc_method=initialize protocol_version=2025-03-26 ua=google");
      expect(log).toContain("mcp: response method=POST rpc_method=initialize status=400");
      expect(log).not.toContain(secret);
      expect(log).not.toContain("Bearer");
      expect(log).not.toContain("protocolVersion");
      expect(log).not.toContain("Gemini");
      expect(log).not.toContain("clientInfo");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
