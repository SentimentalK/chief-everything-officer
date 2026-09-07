import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { IdentityService, AuthIdentity } from "./identity/service.js";
import { WorkspaceAccessDeniedError } from "./identity/service.js";
import { IdentityDbUnavailable } from "./identity/store.js";

declare global {
  namespace Express {
    interface Locals {
      identity?: AuthIdentity;
    }
  }
}

/**
 * Single unified bearer credential entry point. Every protected route (/mcp,
 * /api/audit/traces bearer, /api/identity) resolves identity here.
 *
 * Status contract (single deployment workspace):
 *   - missing / wrong / revoked key, or disabled user  -> 401
 *   - authenticated but bound to a different workspace -> 403
 *   - identity database unavailable on a live request  -> 503
 *
 * Identity is never taken from the body, query, or X-User-ID.
 */
export function createIdentityAuthMiddleware(identityService: IdentityService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    let identity: AuthIdentity;
    try {
      const token = readBearer(req);
      if (token === null) {
        rejectMissingBearer(res);
        return;
      }
      const result = identityService.authenticateApiKey(token);
      if (result === null) {
        res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
        return;
      }
      identity = result;
    } catch (error) {
      if (error instanceof IdentityDbUnavailable) {
        process.stderr.write(`auth: identity database unavailable: ${error.message}\n`);
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32050, message: "Identity service unavailable" },
          id: null,
        });
        return;
      }
      res.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32050, message: "Identity service unavailable" },
        id: null,
      });
      return;
    }

    // Confirm the authenticated identity is authorized for the workspace this
    // deployment currently serves before letting the request proceed.
    try {
      identityService.assertWorkspaceAccess(identity);
    } catch (error) {
      if (error instanceof WorkspaceAccessDeniedError) {
        process.stderr.write(`auth: rejected workspace binding\n`);
        res.status(403).json({
          jsonrpc: "2.0",
          error: { code: -32003, message: "Forbidden: workspace not owned" },
          id: null,
        });
        return;
      }
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      });
      return;
    }

    res.locals.identity = identity;
    next();
  };
}

function readBearer(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.substring(7);
  if (!token) return null;
  return token;
}

function rejectMissingBearer(res: Response): void {
  process.stderr.write("auth: rejected reason=missing_or_invalid_scheme\n");
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  return;
}

export function createHostGuard(allowedHosts: string[]): RequestHandler {
  const hostSet = new Set(allowedHosts);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!hostSet.has(req.hostname)) {
      res.status(421).json({ jsonrpc: "2.0", error: { code: -32000, message: "Misdirected request" }, id: null });
      return;
    }
    next();
  };
}

export function createOriginGuard(allowedOrigins: string[]): RequestHandler {
  const originSet = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    if (!originSet.has(origin)) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden" }, id: null });
      return;
    }
    next();
  };
}
