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
      const credential = identityService.authenticateApiKey(token);
      if (credential === null) {
        res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
        return;
      }
      try {
        identity = identityService.assertWorkspaceAccess(credential);
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
        throw error;
      }
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

/**
 * Dual-bearer authentication middleware for the /mcp endpoint:
 * Accepts either:
 * 1. Legacy MCP_API_KEY verified against IdentityService.
 * 2. OAuth 2.1 Bearer access token verified against OAuthService (with scope 'mcp'
 *    and matching canonical resource `${publicOrigin}/mcp`).
 *
 * Includes RFC 9728 resource_metadata in WWW-Authenticate 401/403 challenge headers.
 */
import type { OAuthService } from "./oauth/service.js";
import { OAuthStoreUnavailable } from "./oauth/store.js";

export function createMcpAuthMiddleware(
  identityService: IdentityService,
  oauthService: OAuthService | null,
): RequestHandler {
  const resourceMetadataUrl = oauthService
    ? `${oauthService.publicOrigin}/.well-known/oauth-protected-resource`
    : undefined;

  return (req: Request, res: Response, next: NextFunction): void => {
    const token = readBearer(req);
    if (token === null) {
      if (resourceMetadataUrl) {
        res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}", scope="mcp"`);
      }
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: Bearer token required" },
        id: null,
      });
      return;
    }

    // 1. Try legacy MCP_API_KEY
    try {
      const apiKeyResult = identityService.authenticateApiKey(token);
      if (apiKeyResult !== null) {
        try {
          const authIdentity = identityService.assertWorkspaceAccess(apiKeyResult);
          res.locals.identity = authIdentity;
          next();
          return;
        } catch (error) {
          if (error instanceof WorkspaceAccessDeniedError) {
            res.status(403).json({
              jsonrpc: "2.0",
              error: { code: -32003, message: "Forbidden: workspace not owned" },
              id: null,
            });
            return;
          }
          throw error;
        }
      }
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
      throw error;
    }

    // 2. If OAuth is enabled, try OAuth access token
    if (oauthService !== null) {
      try {
        const oauthResult = oauthService.validateAccessToken(token);
        if (oauthResult.valid) {
          res.locals.identity = {
            user_id: oauthResult.user_id,
            workspace_id: oauthResult.workspace_id,
            api_key_id: "oauth",
          };
          next();
          return;
        }

        if (oauthResult.error === "insufficient_scope") {
          res.setHeader(
            "WWW-Authenticate",
            `Bearer error="insufficient_scope", scope="mcp", resource_metadata="${resourceMetadataUrl}"`,
          );
          res.status(403).json({
            jsonrpc: "2.0",
            error: { code: -32003, message: `Forbidden: ${oauthResult.description}` },
            id: null,
          });
          return;
        }

        // Token invalid, expired, revoked, or wrong target resource
        res.setHeader(
          "WWW-Authenticate",
          `Bearer error="invalid_token", error_description="${oauthResult.description}", resource_metadata="${resourceMetadataUrl}", scope="mcp"`,
        );
        res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: `Unauthorized: ${oauthResult.description}` },
          id: null,
        });
        return;
      } catch (error) {
        if (error instanceof OAuthStoreUnavailable || error instanceof IdentityDbUnavailable) {
          res.status(503).json({
            jsonrpc: "2.0",
            error: { code: -32050, message: "Authentication store unavailable" },
            id: null,
          });
          return;
        }
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32050, message: "Authentication service error" },
          id: null,
        });
        return;
      }
    }

    // Neither legacy key nor OAuth
    if (resourceMetadataUrl) {
      res.setHeader("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}", scope="mcp"`);
    }
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
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
