import crypto from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import type { AccountProvisioner } from "../identity/provisioner.js";
import { IdentityConflictError } from "../identity/store.js";
import type { UserSessionManager } from "./user-session.js";
import { normalizeDeviceUserCode } from "../connector/enrollment-store.js";

export interface GitHubAuthRouterOptions {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  provisioner: AccountProvisioner;
  sessionManager: UserSessionManager;
  fetchFn?: typeof fetch;
}

export type AllowedNextPath = "/audit" | "/login";

export type GitHubAuthContinuation =
  | { kind: "host_oauth"; requestId: string }
  | { kind: "connector_enrollment"; userCode: string }
  | { kind: "product"; path: AllowedNextPath }
  | null;

interface PendingOAuthState {
  codeVerifier: string;
  expiresAt: number;
  continuation: GitHubAuthContinuation;
}

function parseAllowedNext(raw: unknown): AllowedNextPath | undefined {
  return raw === "/audit" || raw === "/login" ? raw : undefined;
}

const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function validateGitHubProfile(githubUser: { id: unknown; login: unknown }): {
  providerSubject: string;
  providerLogin: string;
} | null {
  if (typeof githubUser.id !== "number" || !Number.isSafeInteger(githubUser.id) || githubUser.id <= 0) {
    return null;
  }
  if (typeof githubUser.login !== "string" || githubUser.login.trim().length === 0) {
    return null;
  }
  return {
    providerSubject: String(githubUser.id),
    providerLogin: githubUser.login,
  };
}

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
  router.get("/", (req: Request, res: Response) => {
    cleanupStates();

    const rawOauthRequest = typeof req.query.oauth_request === "string" ? req.query.oauth_request.trim() : undefined;
    const rawConnectorEnrollment = typeof req.query.connector_enrollment === "string" ? req.query.connector_enrollment.trim() : undefined;
    const rawNext = typeof req.query.next === "string" ? req.query.next.trim() : undefined;

    let continuationCount = 0;
    if (rawOauthRequest && rawOauthRequest.length > 0) continuationCount++;
    if (rawConnectorEnrollment && rawConnectorEnrollment.length > 0) continuationCount++;
    if (rawNext && rawNext.length > 0) continuationCount++;

    if (continuationCount > 1) {
      res.status(400).json({ error: "ambiguous_auth_continuation" });
      return;
    }

    let continuation: GitHubAuthContinuation = null;
    if (rawConnectorEnrollment && rawConnectorEnrollment.length > 0) {
      try {
        const userCode = normalizeDeviceUserCode(rawConnectorEnrollment);
        continuation = { kind: "connector_enrollment", userCode };
      } catch {
        res.status(400).json({ error: "invalid_connector_enrollment" });
        return;
      }
    } else if (rawOauthRequest && rawOauthRequest.length > 0) {
      continuation = { kind: "host_oauth", requestId: rawOauthRequest };
    } else if (rawNext) {
      const next = parseAllowedNext(rawNext);
      if (next) {
        continuation = { kind: "product", path: next };
      }
    }

    const state = crypto.randomBytes(32).toString("hex");
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    pendingStates.set(state, {
      codeVerifier,
      expiresAt: Date.now() + STATE_TTL_MS,
      continuation,
    });

    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
    authorizeUrl.searchParams.set("scope", "user:email");
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

      const githubUser = (await userRes.json()) as { id: unknown; login: unknown; email?: unknown };
      const profile = validateGitHubProfile(githubUser);
      if (!profile) {
        res.redirect(302, "/login?error=invalid_user_response");
        return;
      }

      // 2b. Fetch verified primary email (best-effort; gracefully falls back to profile email, or null -> CEO bot)
      let providerEmail: string | null = null;
      try {
        const emailsRes = await fetchClient("https://api.github.com/user/emails", {
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "CEO-Server",
          },
        });
        if (emailsRes.ok) {
          const emails = (await emailsRes.json()) as Array<{
            email?: unknown;
            primary?: unknown;
            verified?: unknown;
          }>;
          if (Array.isArray(emails)) {
            const primaryVerified = emails.find((e) => e.primary === true && e.verified === true);
            if (primaryVerified && typeof primaryVerified.email === "string" && primaryVerified.email.trim().length > 0) {
              providerEmail = primaryVerified.email.trim();
            }
          }
        }
      } catch {
        // Non-blocking: failure to fetch /user/emails gracefully falls back
      }

      if (!providerEmail && typeof githubUser.email === "string" && githubUser.email.trim().length > 0) {
        providerEmail = githubUser.email.trim();
      }

      // Discard accessToken immediately (do not persist)

      // 3. Resolve or create CEO user from external identity
      const result = provisioner.resolveOrCreate(
        "github",
        profile.providerSubject,
        profile.providerLogin,
        providerEmail,
      );

      // 4. Create CEO product session & set cookie
      const session = sessionManager.createSession({
        userId: result.userId,
        provider: "github",
        providerSubject: profile.providerSubject,
        providerLogin: profile.providerLogin,
      });

      sessionManager.setCookie(res, session.sessionId);
      if (pending.continuation?.kind === "host_oauth") {
        res.redirect(302, `/authorize/resume?request=${encodeURIComponent(pending.continuation.requestId)}`);
        return;
      }
      if (pending.continuation?.kind === "connector_enrollment") {
        res.redirect(302, `/connector/enroll?user_code=${encodeURIComponent(pending.continuation.userCode)}`);
        return;
      }
      if (pending.continuation?.kind === "product") {
        res.redirect(302, pending.continuation.path);
        return;
      }
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
