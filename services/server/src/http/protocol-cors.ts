import type { NextFunction, Request, RequestHandler, Response } from "express";

const ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const ALLOW_HEADERS = [
  "Authorization",
  "Content-Type",
  "MCP-Protocol-Version",
  "Mcp-Session-Id",
  "Last-Event-ID",
  "Mcp-Method",
  "Mcp-Name",
].join(", ");
const EXPOSE_HEADERS = "WWW-Authenticate, Mcp-Session-Id";

function applyCorsHeaders(res: Response, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Expose-Headers", EXPOSE_HEADERS);
}

/**
 * Browser MCP/OAuth protocol Origin policy.
 *
 * Missing Origin: server-to-server, allow with no CORS headers.
 * Exact allowlisted Origin: allow and echo CORS.
 * Anything else: 403.
 *
 * OPTIONS short-circuits with 204 so preflight never reaches Bearer auth.
 */
export function createProtocolCorsMiddleware(allowedOrigins: string[]): RequestHandler {
  const originSet = new Set(allowedOrigins);

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (!origin) {
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
      return;
    }

    if (!originSet.has(origin)) {
      process.stderr.write(`origin: rejected origin=${origin}\n`);
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Forbidden" },
        id: null,
      });
      return;
    }

    applyCorsHeaders(res, origin);
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", ALLOW_METHODS);
      res.setHeader("Access-Control-Allow-Headers", ALLOW_HEADERS);
      res.status(204).end();
      return;
    }

    next();
  };
}
