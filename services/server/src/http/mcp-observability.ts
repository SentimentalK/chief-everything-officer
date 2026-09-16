import type { Request, Response } from "express";
import { writeOAuthFlowLog } from "../oauth/observability.js";

const RPC_METHOD_MAX = 80;

export function extractMcpRpcMethod(body: unknown): string | undefined {
  if (Array.isArray(body)) {
    if (body.length === 0) return "batch";
    const methods = body
      .map((item) => (item && typeof item === "object" && typeof (item as { method?: unknown }).method === "string"
        ? (item as { method: string }).method
        : undefined))
      .filter((method): method is string => Boolean(method));
    const only = methods[0];
    if (methods.length === 1 && only) return clipRpcMethod(only);
    return "batch";
  }
  if (body && typeof body === "object" && typeof (body as { method?: unknown }).method === "string") {
    return clipRpcMethod((body as { method: string }).method);
  }
  return undefined;
}

export function classifyMcpUserAgent(userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;
  const lower = userAgent.toLowerCase();
  if (lower === "google" || lower.startsWith("google/") || lower.startsWith("google ")) return "google";
  if (lower.includes("openauth")) return "openauth";
  if (lower.includes("mozilla")) return "mozilla";
  return "other";
}

function clipRpcMethod(method: string): string {
  return method.slice(0, RPC_METHOD_MAX);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) return value[0].trim();
  return undefined;
}

export function attachMcpProtocolLog(req: Request, res: Response): void {
  const rpcMethod = extractMcpRpcMethod(req.body);
  writeOAuthFlowLog("mcp: request", {
    method: req.method,
    rpc_method: rpcMethod,
    protocol_version: headerValue(req.headers["mcp-protocol-version"]),
    ua: classifyMcpUserAgent(headerValue(req.headers["user-agent"])),
  });
  res.on("finish", () => {
    writeOAuthFlowLog("mcp: response", {
      method: req.method,
      rpc_method: rpcMethod,
      status: res.statusCode,
    });
  });
}
