import crypto from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import type { AccountProvisioner } from "../identity/provisioner.js";
import { IdentityConflictError } from "../identity/store.js";
import type { UserSessionManager } from "./user-session.js";

export interface GitHubAuthRouterOptions {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  provisioner: AccountProvisioner;
  sessionManager: UserSessionManager;
  fetchFn?: typeof fetch;
}

interface PendingOAuthState {
  codeVerifier: string;
  expiresAt: number;
}

const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function createGitHubAuthRouter(options: GitHubAuthRouterOptions): Router {
  const { clientId, clientSecret, callbackUrl, provisioner, sessionManager } = options;
  const fetchClient = options.fetchFn ?? fetch;
  const router = express.Router();

  const pendingStates = new Map<string, PendingOAuthState>();

  function cleanupStates(): void {
    if (pendingStates.size > 200) {
      const now = Date.now();
      for (const [s, stateData] of pendingStates.entries()) {
        if (now > stateData.expiresAt) {
          pendingStates.delete(s);
        }
      }
    }
  }

  // GET /auth/github (mounted at /auth/github, so path is "/")
  router.get("/", (_req: Request, res: Response) => {
    cleanupStates();

    const state = crypto.randomBytes(32).toString("hex");
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    pendingStates.set(state, {
      codeVerifier,
      expiresAt: Date.now() + STATE_TTL_MS,
    });

    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    res.redirect(302, authorizeUrl.toString());
  });

  // GET /auth/github/callback
  router.get("/callback", async (req: Request, res: Response) => {
    cleanupStates();

    if (req.query.error) {
      const errorMsg = String(req.query.error_description || req.query.error);
      res.redirect(302, `/login?error=${encodeURIComponent(errorMsg)}`);
      return;
    }

    const state = typeof req.query.state === "string" ? req.query.state : null;
    const code = typeof req.query.code === "string" ? req.query.code : null;

    if (!state || !code) {
      res.redirect(302, "/login?error=missing_code_or_state");
      return;
    }

    const pending = pendingStates.get(state);
    if (!pending) {
      res.redirect(302, "/login?error=invalid_or_expired_state");
      return;
    }
    pendingStates.delete(state);

    if (Date.now() > pending.expiresAt) {
      res.redirect(302, "/login?error=state_expired");
      return;
    }

    try {
      // 1. Exchange code + code_verifier for token
      const tokenRes = await fetchClient("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: pending.codeVerifier,
          redirect_uri: callbackUrl,
        }),
      });

      if (!tokenRes.ok) {
        res.redirect(302, `/login?error=token_exchange_http_${tokenRes.status}`);
        return;
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };

      if (tokenData.error || !tokenData.access_token) {
        const msg = tokenData.error_description || tokenData.error || "token_exchange_failed";
        res.redirect(302, `/login?error=${encodeURIComponent(msg)}`);
        return;
      }

      const accessToken = tokenData.access_token;

      // 2. Fetch user profile
      const userRes = await fetchClient("https://api.github.com/user", {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "CEO-Server",
        },
      });

      if (!userRes.ok) {
        res.redirect(302, `/login?error=user_fetch_http_${userRes.status}`);
        return;
      }

      const githubUser = (await userRes.json()) as { id: number; login: string };
      if (!githubUser.id || !githubUser.login) {
        res.redirect(302, "/login?error=invalid_user_response");
        return;
      }

      // Discard accessToken immediately (do not persist)

      // 3. Resolve or bind external identity
      const result = provisioner.resolveOrBind(
        "github",
        String(githubUser.id),
        githubUser.login,
      );

      // 4. Create CEO product session & set cookie
      const session = sessionManager.createSession({
        userId: result.userId,
        workspaceId: result.workspaceId,
        provider: "github",
        providerSubject: String(githubUser.id),
        providerLogin: githubUser.login,
      });

      sessionManager.setCookie(res, session.sessionId);
      res.redirect(302, "/login");
    } catch (error) {
      if (error instanceof IdentityConflictError) {
        res.redirect(302, `/login?error=${encodeURIComponent(error.message)}`);
        return;
      }
      res.redirect(302, `/login?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
    }
  });

  return router;
}
