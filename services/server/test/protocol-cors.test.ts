import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { OAuthStore } from "../src/oauth/store.js";
import { seedIdentity } from "./helpers.js";
import { IdentityService } from "../src/identity/service.js";
import { OAuthService } from "../src/oauth/service.js";
import { createOAuthRouter } from "../src/oauth/router.js";
import { createMcpAuthMiddleware, createOriginGuard } from "../src/auth.js";
import { UserSessionManager } from "../src/auth/user-session.js";
import {
  CimdClientResolver,
  CompositeClientResolver,
} from "../src/oauth/client-resolver.js";
import { DcrStore } from "../src/oauth/dcr/store.js";
import { DcrClientResolver, DcrService } from "../src/oauth/dcr/service.js";
import { createDcrRouter } from "../src/oauth/dcr/router.js";
import { createProtocolCorsMiddleware } from "../src/http/protocol-cors.js";

const BROWSER_ORIGIN = "https://gemini.google.com";
const EVIL_ORIGIN = "https://evil.example";
const LOOPBACK = "http://127.0.0.1:54321/oauth/callback";

const cleanupDirs: string[] = [];
const cleanupOAuthStores: OAuthStore[] = [];
const cleanupDcrStores: DcrStore[] = [];
const cleanupIdentServices: IdentityService[] = [];

afterEach(async () => {
  for (const st of cleanupOAuthStores.splice(0)) st.close();
  for (const st of cleanupDcrStores.splice(0)) st.close();
  for (const st of cleanupIdentServices.splice(0)) st.close();
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupBrowserProtocolApp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-protocol-cors-"));
  cleanupDirs.push(dir);

  const identDbPath = path.join(dir, "identity.sqlite");
  const ident = seedIdentity({ identityDbPath: identDbPath, remoteUrl: "git@example.com:test/repo.git", branch: "main" }, "test-key");
  const identityService = IdentityService.open(identDbPath);
  cleanupIdentServices.push(identityService);

  const oauthStore = new OAuthStore(path.join(dir, "oauth.sqlite"));
  cleanupOAuthStores.push(oauthStore);
  const dcrStore = new DcrStore(path.join(dir, "oauth-dcr.sqlite"));
  cleanupDcrStores.push(dcrStore);
  const dcrService = new DcrService(dcrStore);

  const publicOrigin = "https://ceo.sentimentalk.com";
  const sessionManager = new UserSessionManager({ secureCookies: false });
  const oauthService = new OAuthService(oauthStore, identityService.storeInstance, {
    publicOrigin,
    workspaceId: ident.workspace_id,
    clientResolver: new CompositeClientResolver({
      cimd: new CimdClientResolver(),
      dcr: new DcrClientResolver(dcrService),
    }),
    registrationEndpoint: `${publicOrigin}/register`,
  });

  const protocolCors = createProtocolCorsMiddleware([BROWSER_ORIGIN]);
  const app = express();
  app.use("/mcp", protocolCors);
  app.use("/.well-known", protocolCors);
  app.use("/register", protocolCors);
  app.use("/token", protocolCors);
  app.use(express.json());
  app.use(createDcrRouter({ dcrService }));
  app.use(createOAuthRouter({ oauthService, sessionManager }));
  app.all("/mcp", createMcpAuthMiddleware(identityService, oauthService), (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.get(
    "/api/worker/jobs",
    createOriginGuard([]),
    (_req, res) => {
      res.status(200).json({ ok: true });
    },
  );

  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("Browser MCP protocol CORS", () => {
  it("allows server-to-server /mcp with no Origin and does not emit CORS headers", async () => {
    const env = await setupBrowserProtocolApp();
    try {
      const res = await fetch(`${env.baseUrl}/mcp`);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await env.close();
    }
  });

  it("echoes an allowlisted Origin on /mcp 401 and exposes WWW-Authenticate", async () => {
    const env = await setupBrowserProtocolApp();
    try {
      const res = await fetch(`${env.baseUrl}/mcp`, {
        headers: { Origin: BROWSER_ORIGIN },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
      expect(res.headers.get("access-control-allow-origin")).toBe(BROWSER_ORIGIN);
      expect(res.headers.get("vary")).toContain("Origin");
      expect(res.headers.get("access-control-expose-headers")?.toLowerCase()).toContain(
        "www-authenticate",
      );
      expect(res.headers.get("access-control-expose-headers")?.toLowerCase()).toContain(
        "mcp-session-id",
      );
    } finally {
      await env.close();
    }
  });

  it("rejects unknown Origin on /mcp with 403 and no CORS allow origin", async () => {
    const env = await setupBrowserProtocolApp();
    try {
      const res = await fetch(`${env.baseUrl}/mcp`, {
        headers: { Origin: EVIL_ORIGIN },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await env.close();
    }
  });

  it("answers OPTIONS /mcp for an allowlisted Origin with 204 and never 401", async () => {
    const env = await setupBrowserProtocolApp();
    try {
      const res = await fetch(`${env.baseUrl}/mcp`, {
        method: "OPTIONS",
        headers: {
          Origin: BROWSER_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type,mcp-protocol-version",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(BROWSER_ORIGIN);
      const methods = res.headers.get("access-control-allow-methods") ?? "";
      expect(methods).toContain("GET");
      expect(methods).toContain("POST");
      expect(methods).toContain("DELETE");
      expect(methods).toContain("OPTIONS");
      const allowHeaders = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
      expect(allowHeaders).toContain("authorization");
      expect(allowHeaders).toContain("mcp-protocol-version");
      expect(allowHeaders).toContain("mcp-method");
      expect(allowHeaders).toContain("mcp-name");
    } finally {
      await env.close();
    }
  });

  it("rejects OPTIONS /mcp from an unknown Origin with 403", async () => {
    const env = await setupBrowserProtocolApp();
    try {
      const res = await fetch(`${env.baseUrl}/mcp`, {
        method: "OPTIONS",
        headers: { Origin: EVIL_ORIGIN, "Access-Control-Request-Method": "POST" },
      });
      expect(res.status).toBe(403);
    } finally {
      await env.close();
    }
  });

  it("makes OAuth discovery readable cross-origin", async () => {
    const env = await setupBrowserProtocolApp();
    try {
      const res = await fetch(`${env.baseUrl}/.well-known/oauth-authorization-server`, {
        headers: { Origin: BROWSER_ORIGIN },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(BROWSER_ORIGIN);
      const body = (await res.json()) as { registration_endpoint?: string };
      expect(body.registration_endpoint).toBe("https://ceo.sentimentalk.com/register");
    } finally {
      await env.close();
    }
  });

  it("answers OPTIONS /register and OPTIONS /token for allowlisted Origin", async () => {
    const env = await setupBrowserProtocolApp();
    try {
      for (const pathName of ["/register", "/token"]) {
        const res = await fetch(`${env.baseUrl}${pathName}`, {
          method: "OPTIONS",
          headers: {
            Origin: BROWSER_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
          },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe(BROWSER_ORIGIN);
        expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
          "authorization",
        );
      }
    } finally {
      await env.close();
    }
  });

  it("returns CORS headers on successful POST /register from an allowlisted Origin", async () => {
    const env = await setupBrowserProtocolApp();
    try {
      const res = await fetch(`${env.baseUrl}/register`, {
        method: "POST",
        headers: {
          Origin: BROWSER_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ redirect_uris: [LOOPBACK], application_type: "native" }),
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("access-control-allow-origin")).toBe(BROWSER_ORIGIN);
      const body = (await res.json()) as { client_id: string; client_secret?: string };
      expect(body.client_id).toMatch(/^dcr_/);
      expect(body.client_secret).toBeUndefined();
    } finally {
      await env.close();
    }
  });

  it("keeps product APIs on ALLOWED_ORIGINS and does not add protocol CORS", async () => {
    const env = await setupBrowserProtocolApp();
    try {
      const res = await fetch(`${env.baseUrl}/api/worker/jobs`, {
        headers: { Origin: BROWSER_ORIGIN },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await env.close();
    }
  });

  it("does not advertise CORS on /authorize", async () => {
    const env = await setupBrowserProtocolApp();
    try {
      const res = await fetch(
        `${env.baseUrl}/authorize?client_id=x&redirect_uri=https://example.com/cb`,
        { headers: { Origin: BROWSER_ORIGIN } },
      );
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await env.close();
    }
  });

  it("attaches CORS headers before the JSON parser so malformed bodies remain readable", async () => {
    const env = await setupBrowserProtocolApp();
    try {
      const res = await fetch(`${env.baseUrl}/register`, {
        method: "POST",
        headers: {
          Origin: BROWSER_ORIGIN,
          "Content-Type": "application/json",
        },
        body: "{not-json",
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("access-control-allow-origin")).toBe(BROWSER_ORIGIN);
    } finally {
      await env.close();
    }
  });
});
