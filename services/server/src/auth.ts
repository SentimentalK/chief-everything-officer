import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AuthIdentity } from "./identity/service.js";
import { IdentityDbUnavailable } from "./identity/store.js";

declare global {
  namespace Express {
    interface Locals {
      identity?: AuthIdentity;
    }
  }
}

/**
 * MCP resource-server authentication middleware. `/mcp` is OAuth 2.1 only:
 * a Bearer access token must validate against OAuthService with scope `mcp`
 * and matching canonical resource `${publicOrigin}/mcp`. Legacy DB-backed
 * API keys are no longer accepted and are rejected as invalid tokens.
 *
 * Status contract:
 *   - missing / invalid / expired / revoked / wrong-resource token -> 401
 *     (with RFC 9728 WWW-Authenticate resource_metadata and scope where available)
 *   - valid token without `mcp` scope                            -> 403
 *   - OAuth/identity backing-store failure on a live request     -> 503
 *   - OAuth disabled (CEO_OAUTH_ENABLED=false)                    -> 503 for every
 *     request; /mcp fails closed and never accepts an opaque bearer token.
 *
 * Includes RFC 9728 resource_metadata in WWW-Authenticate 401/403 challenge headers.
 */
import type { OAuthService } from "./oauth/service.js";
import { OAuthStoreUnavailable } from "./oauth/store.js";
import { writeOAuthFlowLog } from "./oauth/observability.js";

export function createMcpAuthMiddleware(oauthService: OAuthService | null): RequestHandler {
  const resourceMetadataUrl = oauthService
    ? `${oauthService.publicOrigin}/.well-known/oauth-protected-resource/mcp`
    : undefined;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Fail closed when OAuth is unavailable: /mcp is explicitly unavailable
    // and no bearer token of any kind is interpreted through the identity store.
    if (oauthService === null) {
      res.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32050, message: "MCP authentication unavailable: OAuth is not enabled" },
        id: null,
      });
      return;
    }

    const token = readBearer(req);
    if (token === null) {
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}", scope="mcp"`);
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: Bearer token required" },
        id: null,
      });
      return;
    }

    try {
      const oauthResult = oauthService.validateAccessToken(token);
      if (oauthResult.valid) {
        writeOAuthFlowLog("mcp-auth:", {
          outcome: "success",
          credential: "oauth",
          user: oauthResult.user_id,
          workspace: oauthResult.workspace_id,
        });
        res.locals.identity = {
          user_id: oauthResult.user_id,
          workspace_id: oauthResult.workspace_id,
        };
        next();
        return;
      }

      if (oauthResult.error === "insufficient_scope") {
        writeOAuthFlowLog("mcp-auth:", {
          outcome: "rejected",
          credential: "oauth",
          reason: "insufficient_scope",
          status: 403,
        });
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

      // Token invalid, expired, revoked, wrong target resource, or a legacy
      // raw API key (which is no longer an MCP credential at all).
      writeOAuthFlowLog("mcp-auth:", {
        outcome: "rejected",
        credential: "oauth",
        reason: oauthResult.error,
        status: 401,
      });
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