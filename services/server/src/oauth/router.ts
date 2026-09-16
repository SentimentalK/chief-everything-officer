import express, { type Request, type Response, type Router } from "express";
import { OAuthService, OAuthServerError } from "./service.js";
import { UserSessionManager } from "../auth/user-session.js";
import type { AuthorizationRequestRecord } from "./store.js";

export interface OAuthRouterOptions {
  oauthService: OAuthService;
  sessionManager: UserSessionManager;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderConsentHtml(request: AuthorizationRequestRecord, nonce: string): string {
  const isLocalhost =
    request.redirect_uri.startsWith("http://localhost") ||
    request.redirect_uri.startsWith("http://127.0.0.1") ||
    request.redirect_uri.startsWith("http://[::1]");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize Application - Chief Everything Officer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #000000;
      color: #ededed;
      display: flex;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }
    .card {
      width: 100%;
      max-width: 440px;
      background-color: #121212;
      border: 1px solid #262626;
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    }
    .header { text-align: center; margin-bottom: 24px; }
    .header h1 { font-size: 20px; font-weight: 600; margin-bottom: 6px; color: #ffffff; }
    .header p { font-size: 13px; color: #a1a1a1; }
    .app-box {
      background: #1a1a1a;
      border: 1px solid #333333;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
    }
    .app-name { font-size: 16px; font-weight: 600; color: #ffffff; margin-bottom: 4px; }
    .app-meta { font-size: 12px; color: #888888; word-break: break-all; margin-top: 4px; }
    .warning-box {
      background: #3b2800;
      border: 1px solid #784900;
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 12px;
      color: #ffd280;
      margin-bottom: 20px;
      line-height: 1.4;
    }
    .scope-list {
      margin-bottom: 24px;
      font-size: 13px;
    }
    .scope-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 8px;
      color: #cccccc;
    }
    .scope-check { color: #10b981; font-weight: bold; }
    .actions { display: flex; gap: 12px; }
    button {
      flex: 1;
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      border-radius: 6px;
      cursor: pointer;
      border: none;
      transition: background 0.15s ease;
    }
    .btn-approve {
      background-color: #ededed;
      color: #000000;
    }
    .btn-approve:hover { background-color: #ffffff; }
    .btn-deny {
      background-color: #262626;
      color: #ededed;
      border: 1px solid #404040;
    }
    .btn-deny:hover { background-color: #333333; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>Authorization Request</h1>
      <p>An application is requesting access to your CEO workspace</p>
    </div>

    <div class="app-box">
      <div class="app-name">${escapeHtml(request.client_name)}</div>
      <div class="app-meta">Client ID: ${escapeHtml(request.client_id)}</div>
      <div class="app-meta">Redirect: ${escapeHtml(request.redirect_uri)}</div>
    </div>

    ${
      isLocalhost
        ? `<div class="warning-box">
             <strong>Notice:</strong> This client will redirect to a local machine address (<code>localhost</code>). Only authorize if you started this client locally.
           </div>`
        : ""
    }

    <div class="scope-list">
      <div class="scope-item">
        <span class="scope-check">✓</span>
        <span>Access MCP tools on your behalf (<code>${escapeHtml(request.scope)}</code>)</span>
      </div>
    </div>

    <form method="POST" action="/authorize/decision">
      <input type="hidden" name="request_id" value="${escapeHtml(request.id)}" />
      <input type="hidden" name="consent_nonce" value="${escapeHtml(nonce)}" />
      <div class="actions">
        <button type="submit" name="decision" value="deny" class="btn-deny">Cancel</button>
        <button type="submit" name="decision" value="approve" class="btn-approve">Authorize</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

function renderErrorHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)} - Chief Everything Officer</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #000; color: #ededed; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 1rem; }
    .card { max-width: 420px; width: 100%; background: #121212; border: 1px solid #262626; border-radius: 12px; padding: 24px; text-align: center; }
    h1 { color: #f87171; font-size: 18px; margin-bottom: 8px; }
    p { color: #a1a1a1; font-size: 13px; line-height: 1.5; }
    a { display: inline-block; margin-top: 16px; color: #ededed; font-size: 13px; text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <a href="/login">Return to Login</a>
  </div>
</body>
</html>`;
}

function sendJson(res: Response, body: unknown): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(200).json(body);
}

function getProtectedResourceMetadata(oauthService: OAuthService): Record<string, unknown> {
  return {
    resource: oauthService.canonicalResource,
    authorization_servers: [oauthService.publicOrigin],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/SentimentalK/chief-everything-officer",
  };
}

export function createOAuthRouter(options: OAuthRouterOptions): Router {
  const { oauthService, sessionManager } = options;
  const router = express.Router();

  // RFC 8414 Authorization Server Metadata (canonical for issuer origin)
  router.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
    sendJson(res, oauthService.getAuthorizationServerMetadata());
  });
  // Compatibility alias for path-aware discovery of the /mcp resource. Issuer stays the origin.
  router.get("/.well-known/oauth-authorization-server/mcp", (_req: Request, res: Response) => {
    sendJson(res, oauthService.getAuthorizationServerMetadata());
  });

  // RFC 9728 Protected Resource Metadata (root alias kept for backwards compatibility)
  router.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
    sendJson(res, getProtectedResourceMetadata(oauthService));
  });
  // Canonical RFC 9728 URL for resource https://<origin>/mcp
  router.get("/.well-known/oauth-protected-resource/mcp", (_req: Request, res: Response) => {
    sendJson(res, getProtectedResourceMetadata(oauthService));
  });

  // 3. GET /authorize
  router.get("/authorize", async (req: Request, res: Response) => {
    const clientId = typeof req.query.client_id === "string" ? req.query.client_id : "";
    const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
    const responseType = typeof req.query.response_type === "string" ? req.query.response_type : "";
    const scope = typeof req.query.scope === "string" ? req.query.scope : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const codeChallenge = typeof req.query.code_challenge === "string" ? req.query.code_challenge : "";
    const codeChallengeMethod = typeof req.query.code_challenge_method === "string" ? req.query.code_challenge_method : "";
    const resource = typeof req.query.resource === "string" ? req.query.resource : undefined;

    if (!clientId || !redirectUri) {
      res.status(400).send(renderErrorHtml("Invalid Request", "client_id and redirect_uri are required"));
      return;
    }

    try {
      const { request } = await oauthService.initiateAuthorizationRequest({
        clientId,
        redirectUri,
        responseType,
        scope,
        state,
        codeChallenge,
        codeChallengeMethod,
        resource,
      });

      const session = sessionManager.getSession(req);
      if (!session) {
        // Not logged in: redirect to login with oauth_request parameter
        res.redirect(302, `/login?oauth_request=${encodeURIComponent(request.id)}`);
        return;
      }

      // Logged in: generate consent nonce and render consent screen
      const nonce = oauthService.createConsentNonce(request.id);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(renderConsentHtml(request, nonce));
    } catch (err: any) {
      if (err instanceof OAuthServerError) {
        process.stderr.write(`oauth: /authorize error for client '${clientId}': ${err.message}\n`);
        res.status(err.statusCode).send(renderErrorHtml("Authorization Error", err.errorDescription || err.errorCode));
        return;
      }
      process.stderr.write(`oauth: unexpected error in /authorize for client '${clientId}': ${err?.stack || err}\n`);
      res.status(500).send(renderErrorHtml("Server Error", "An unexpected error occurred"));
    }
  });

  // 4. GET /authorize/resume
  router.get("/authorize/resume", (req: Request, res: Response) => {
    const requestId = typeof req.query.request === "string" ? req.query.request : "";
    if (!requestId) {
      res.status(400).send(renderErrorHtml("Invalid Request", "Missing request parameter"));
      return;
    }

    const session = sessionManager.getSession(req);
    if (!session) {
      res.redirect(302, `/login?oauth_request=${encodeURIComponent(requestId)}`);
      return;
    }

    const request = oauthService.getAuthorizationRequest(requestId);
    if (!request) {
      res.status(400).send(
        renderErrorHtml("Request Expired", "The authorization request has expired or is invalid. Please start again.")
      );
      return;
    }

    const nonce = oauthService.createConsentNonce(request.id);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(renderConsentHtml(request, nonce));
  });

  // 5. POST /authorize/decision
  router.post(
    "/authorize/decision",
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      const session = sessionManager.getSession(req);
      if (!session) {
        res.status(401).send(renderErrorHtml("Unauthorized", "Session expired. Please sign in again."));
        return;
      }

      const body = (req.body && typeof req.body === "object") ? req.body : {};
      const { request_id, consent_nonce, decision } = body;
      if (!request_id || !consent_nonce || !decision) {
        res.status(400).send(renderErrorHtml("Invalid Request", "Missing decision parameters"));
        return;
      }

      try {
        if (decision === "approve") {
          const outcome = oauthService.approveConsent(request_id, consent_nonce, session.userId);
          const redirectUrl = new URL(outcome.redirectUri);
          redirectUrl.searchParams.set("code", outcome.code);
          redirectUrl.searchParams.set("iss", oauthService.publicOrigin);
          if (outcome.state) {
            redirectUrl.searchParams.set("state", outcome.state);
          }
          res.redirect(302, redirectUrl.toString());
        } else {
          const outcome = oauthService.denyConsent(request_id, consent_nonce);
          const redirectUrl = new URL(outcome.redirectUri);
          redirectUrl.searchParams.set("error", "access_denied");
          redirectUrl.searchParams.set("error_description", "The user denied the authorization request");
          redirectUrl.searchParams.set("iss", oauthService.publicOrigin);
          if (outcome.state) {
            redirectUrl.searchParams.set("state", outcome.state);
          }
          res.redirect(302, redirectUrl.toString());
        }
      } catch (err: any) {
        if (err instanceof OAuthServerError) {
          res.status(err.statusCode).send(renderErrorHtml("Authorization Error", err.errorDescription || err.errorCode));
          return;
        }
        res.status(500).send(renderErrorHtml("Server Error", "An error occurred while processing your decision"));
      }
    }
  );

  // 6. POST /token
  router.post(
    "/token",
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");

      const body = (req.body && typeof req.body === "object") ? req.body : {};
      const {
        grant_type,
        client_id,
        code,
        redirect_uri,
        code_verifier,
        refresh_token,
        scope,
        resource,
      } = body;

      try {
        if (grant_type === "authorization_code") {
          const tokens = oauthService.exchangeAuthorizationCode({
            clientId: client_id,
            redirectUri: redirect_uri,
            code,
            codeVerifier: code_verifier,
            resource: typeof resource === "string" ? resource : undefined,
          });
          res.status(200).json(tokens);
          return;
        }

        if (grant_type === "refresh_token") {
          const tokens = oauthService.refreshTokens({
            clientId: client_id,
            refreshToken: refresh_token,
            scope: typeof scope === "string" ? scope : undefined,
            resource: typeof resource === "string" ? resource : undefined,
          });
          res.status(200).json(tokens);
          return;
        }

        res.status(400).json({
          error: "unsupported_grant_type",
          error_description: "Supported grant types: authorization_code, refresh_token",
        });
      } catch (err: any) {
        if (err instanceof OAuthServerError) {
          res.status(err.statusCode).json({
            error: err.errorCode,
            error_description: err.errorDescription,
          });
          return;
        }
        res.status(500).json({
          error: "server_error",
          error_description: "Internal server error",
        });
      }
    }
  );

  return router;
}
