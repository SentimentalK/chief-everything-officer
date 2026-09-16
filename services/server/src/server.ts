import fs from "node:fs";
import express, { type Request, type Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { loadProductPolicy } from "./product-policy.js";
import { CeoWorkspace } from "./workspace.js";
import {
  createHostGuard,
  createOriginGuard,
  createIdentityAuthMiddleware,
  createMcpAuthMiddleware,
} from "./auth.js";
import { IdentityService } from "./identity/service.js";
import { IdentityAccountProvisioner } from "./identity/provisioner.js";
import { UserSessionManager } from "./auth/user-session.js";
import { createGitHubAuthRouter } from "./auth/github.js";
import { createUserRouter } from "./auth/user-router.js";
import { GitHubAppClient } from "./github/app-client.js";
import { GitHubInstallationService } from "./github/installation-service.js";
import { GitHubRepositoryService } from "./github/repository-service.js";
import { WorkspaceBootstrapService } from "./github/bootstrap-service.js";
import {
  createGitHubAppAuthRouter,
  createGitHubInstallationsApiRouter,
  createGitHubRepositoryAuthorizationsRouter,
  createWorkspaceProvisioningRouter,
} from "./github/router.js";
import { AuditStore, createAuditRouter } from "./audit.js";
import { BUILD_INFO } from "./build-info.js";
import { openJobBridge } from "./jobs/bridge.js";
import { createJobAssignmentRouter } from "./jobs/router.js";
import { resolveResourceLocation } from "./resource/locator.js";

function fatal(prefix: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${prefix}: ${message}\n`);
  process.exit(1);
}

// ---- Configuration ----
const config = loadConfig();

// ---- Identity layer (authoritative, required, fail-fast) ----
// Identity DB must already exist (created by `dist/identity/cli.js init`).
// The service selects the configured runtime workspace and performs optional
// scoped key rotation; any mismatch, corrupt DB, or disabled owner aborts startup.
let identityService: IdentityService;
try {
  identityService = IdentityService.open(
    {
      remoteUrl: config.remoteUrl,
      branch: config.branch,
      envApiKey: config.mcpApiKey,
    },
    config.identityDbPath,
  );
} catch (error) {
  fatal("identity", error);
}

// ---- Git workspace ----
const workspace = new CeoWorkspace(config);
const productPolicy = await loadProductPolicy();
await workspace.initialize();

import { ResourceService } from "./resource/service.js";
import { createJobResultHandler } from "./jobs/result-service.js";

const auditStore = new AuditStore(config.auditDbPath);

// Shared single ResourceService instance for both MCP tools and Worker result ingress
const resourceService = new ResourceService(workspace, config);

// Fixed workspace identity for the MCP tools (no api_key_id). Authentication is
// enforced at the /mcp boundary by the identity middleware per request.
const workspaceIdentity = identityService.workspaceIdentityValue;

// CEO Product User provisioner and session manager (independent from Audit auth)
const userProvisioner = new IdentityAccountProvisioner(identityService.storeInstance);
const isSecureOrigin = config.publicOrigin
  ? config.publicOrigin.startsWith("https://")
  : false;
const userSessionManager = new UserSessionManager({
  secureCookies: isSecureOrigin,
});

// Optional worker-bridge job layer (disabled unless configured). Resource
// existence for new tasks is checked against repo contents.
const jobBridge = openJobBridge({
  bridgeEnabled: config.bridgeEnabled,
  redisUrl: config.redisUrl,
}, async (_scope, resourceId) => {
  const loc = await resolveResourceLocation(workspace.config.repoDir, resourceId);
  return loc !== null;
});

const app = createMcpExpressApp({ host: config.bindHost });

// Managed result route FIRST with dedicated 9 MiB body limit:
// Host -> Origin -> Identity -> 9mb parser -> resultHandler
app.post(
  "/api/worker/jobs/:job_id/result",
  createHostGuard(config.allowedHosts),
  createOriginGuard(config.allowedOrigins),
  createIdentityAuthMiddleware(identityService),
  express.json({ limit: "9mb" }),
  createJobResultHandler(jobBridge.service, resourceService),
);

// Ordinary JSON body parser for subsequent routes (default 100 KiB)
app.use(express.json());

// Probes
app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true, version: BUILD_INFO.version, build: BUILD_INFO.build });
});
app.get("/readyz", (_req, res) => {
  const ready = workspace.readiness === "READY";
  res.status(ready ? 200 : 503).json({
    ok: ready,
    state: workspace.readiness,
    version: BUILD_INFO.version,
    build: BUILD_INFO.build,
  });
});

// Read-only identity endpoint: which user/workspace this key connects to.
app.get(
  "/api/identity",
  createHostGuard(config.allowedHosts),
  createOriginGuard(config.allowedOrigins),
  createIdentityAuthMiddleware(identityService),
  (_req: Request, res: Response) => {
    res.status(200).json({
      user_id: identityService.workspaceIdentityValue.user_id,
      workspace_id: identityService.workspaceIdentityValue.workspace_id,
      deployment_mode: "single_workspace_runtime",
    });
  },
);

// Audit routes (login, session + query endpoints) reuse the same identity layer.
app.use(
  createAuditRouter({
    auditStore,
    identityService,
  }),
);

// Product user session router (independent from Audit session)
app.use(
  "/api/user",
  createUserRouter({
    store: identityService.storeInstance,
    sessionManager: userSessionManager,
  }),
);

// GitHub OAuth authorization router (when configured)
if (config.githubClientId && config.githubClientSecret) {
  const defaultCallback = config.publicOrigin
    ? `${config.publicOrigin.replace(/\/+$/, "")}/auth/github/callback`
    : `http://${config.bindHost}:${config.port}/auth/github/callback`;
  const callbackUrl = config.githubCallbackUrl || defaultCallback;

  app.use(
    "/auth/github",
    createGitHubAuthRouter({
      clientId: config.githubClientId,
      clientSecret: config.githubClientSecret,
      callbackUrl,
      provisioner: userProvisioner,
      sessionManager: userSessionManager,
    }),
  );
}

// GitHub App authorization & installation capability (when enabled)
if (config.githubAppEnabled) {
  const defaultAppCallback = config.publicOrigin
    ? `${config.publicOrigin.replace(/\/+$/, "")}/auth/github-app/callback`
    : `http://${config.bindHost}:${config.port}/auth/github-app/callback`;
  const appCallbackUrl = config.githubAppCallbackUrl || defaultAppCallback;

  let privateKey: string;
  try {
    privateKey = fs.readFileSync(config.githubAppPrivateKeyPath!, "utf8");
  } catch (error) {
    fatal("github-app", error);
  }

  let appClient: GitHubAppClient;
  try {
    appClient = new GitHubAppClient({
      clientId: config.githubAppClientId!,
      privateKey,
    });
  } catch (error) {
    fatal("github-app", error);
  }

  const installationService = new GitHubInstallationService({
    appClient,
    store: identityService.storeInstance,
    clientId: config.githubAppClientId!,
    clientSecret: config.githubAppClientSecret!,
    slug: config.githubAppSlug!,
    callbackUrl: appCallbackUrl,
  });

  const defaultRepoCallback = config.publicOrigin
    ? `${config.publicOrigin.replace(/\/+$/, "")}/auth/github-app/repository/callback`
    : `http://${config.bindHost}:${config.port}/auth/github-app/repository/callback`;
  const repoCallbackUrl = defaultRepoCallback;

  const bootstrapService = new WorkspaceBootstrapService({
    appClient,
    store: identityService.storeInstance,
  });

  const repositoryService = new GitHubRepositoryService({
    appClient,
    store: identityService.storeInstance,
    clientId: config.githubAppClientId!,
    clientSecret: config.githubAppClientSecret!,
    callbackUrl: repoCallbackUrl,
    sessionManager: userSessionManager,
    bootstrapService,
  });

  app.use(
    "/auth/github-app",
    createGitHubAppAuthRouter({
      installationService,
      repositoryService,
      sessionManager: userSessionManager,
      store: identityService.storeInstance,
    }),
  );

  app.use(
    "/api/github/installations",
    createGitHubInstallationsApiRouter({
      installationService,
      sessionManager: userSessionManager,
      store: identityService.storeInstance,
    }),
  );

  app.use(
    "/api/github/repository-authorizations",
    createGitHubRepositoryAuthorizationsRouter({
      repositoryService,
      sessionManager: userSessionManager,
      store: identityService.storeInstance,
    }),
  );

  app.use(
    "/api/workspaces",
    createWorkspaceProvisioningRouter({
      bootstrapService,
      sessionManager: userSessionManager,
      store: identityService.storeInstance,
    }),
  );
}

// OAuth 2.1 Authorization Server (when enabled)
import { OAuthStore } from "./oauth/store.js";
import { OAuthService } from "./oauth/service.js";
import { createOAuthRouter } from "./oauth/router.js";

let oauthStore: OAuthStore | null = null;
let oauthService: OAuthService | null = null;

if (config.oauthEnabled) {
  const publicOrigin = config.publicOrigin!;
  oauthStore = new OAuthStore(config.oauthDbPath);
  oauthService = new OAuthService(oauthStore, identityService.storeInstance, {
    publicOrigin,
    workspaceId: workspaceIdentity.workspace_id,
  });

  app.use(
    createOAuthRouter({
      oauthService,
      sessionManager: userSessionManager,
    }),
  );
}

// Worker assignment endpoints: Host -> Origin -> Identity -> router ->
// JobService. Identity scope is taken from the authenticated locals only.
app.use(
  "/api/worker/jobs",
  createHostGuard(config.allowedHosts),
  createOriginGuard(config.allowedOrigins),
  createIdentityAuthMiddleware(identityService),
  createJobAssignmentRouter(jobBridge.service),
);

// MCP handler (dedicated to /mcp)
const mcpHandler = createMcpHandler(
  () => createMcpServer(workspace, productPolicy, {
    auditStore,
    identity: workspaceIdentity,
    jobs: { service: jobBridge.service },
    resourceService,
  }),
  { legacy: "reject" },
);
const nodeHandler = toNodeHandler(mcpHandler);

app.all(
  "/mcp",
  createHostGuard(config.allowedHosts),
  createOriginGuard(config.allowedOrigins),
  config.oauthEnabled && oauthService
    ? createMcpAuthMiddleware(identityService, oauthService)
    : createIdentityAuthMiddleware(identityService),
  (req: Request, res: Response) => {
    void nodeHandler(req, res, req.body);
  },
);

const listener = app.listen(config.port, config.bindHost, () => {
  process.stdout.write(`CEO MCP listening on http://${config.bindHost}:${config.port}/mcp\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    auditStore.close();
    oauthStore?.close();
    identityService.close();
    void jobBridge.dispose();
    listener.close(() => process.exit(0));
  });
}
