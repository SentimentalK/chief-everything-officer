import fs from "node:fs";
import express, { type Request, type Response, type NextFunction } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { loadProductPolicy } from "./product-policy.js";
import { createProtocolCorsMiddleware } from "./http/protocol-cors.js";
import { attachMcpProtocolLog } from "./http/mcp-observability.js";
import { createJobResultHandler } from "./jobs/result-service.js";
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
import { ConnectorControlStore } from "./connector/control-store.js";
import { DeviceEnrollmentStore } from "./connector/enrollment-store.js";
import { createConnectorRouter } from "./connector/router.js";
import { GitHubAppClient } from "./github/app-client.js";
import { GitHubInstallationService } from "./github/installation-service.js";
import { GitHubRepositoryService } from "./github/repository-service.js";
import { WorkspaceBootstrapService } from "./github/bootstrap-service.js";
import {
  createGitHubAppAuthRouter,
  createGitHubInstallationsApiRouter,
  createWorkspaceProvisioningRouter,
} from "./github/router.js";
import { AuditStore, createAuditRouter } from "./audit.js";
import { BUILD_INFO } from "./build-info.js";
import { openJobBridge } from "./jobs/bridge.js";
import { openNeutralRedisRunner } from "./jobs/redis-runner.js";
import { createJobAssignmentRouter } from "./jobs/router.js";
import type { JobAuthScope } from "./jobs/service.js";
import { RedisJobStoreV2 } from "./jobs/v2-store.js";
import { JobCoordinatorV2 } from "./jobs/v2-service.js";
import { createConnectorJobsRouter } from "./jobs/v2-router.js";
import { resolveResourceLocation } from "./resource/locator.js";
import { WorkspaceRuntimeRegistry } from "./runtime/registry.js";
import type { WorkspaceRuntime } from "./runtime/types.js";

declare global {
  namespace Express {
    interface Locals {
      workspaceRuntime?: WorkspaceRuntime;
    }
  }
}

function fatal(prefix: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${prefix}: ${message}\n`);
  process.exit(1);
}

// ---- Configuration ----
const config = loadConfig();

// ---- Identity layer (authoritative, required, fail-fast) ----
// Identity DB must already exist (created by `dist/identity/cli.js init`).
let identityService: IdentityService;
try {
  identityService = IdentityService.open(config.identityDbPath);
} catch (error) {
  fatal("identity", error);
}

// ---- GitHub App Client (mandatory server capability) ----
if (!config.githubAppEnabled) {
  fatal("github-app", new Error("CEO_GITHUB_APP_ENABLED=true is required to start CEO Server"));
}

let privateKey: string;
try {
  privateKey = fs.readFileSync(config.githubAppPrivateKeyPath!, "utf8");
} catch (error) {
  fatal("github-app", error);
}

let gitHubAppClient: GitHubAppClient;
try {
  gitHubAppClient = new GitHubAppClient({
    clientId: config.githubAppClientId!,
    privateKey,
  });
} catch (error) {
  fatal("github-app", error);
}

// Multi-workspace runtime registry
const runtimeRegistry = new WorkspaceRuntimeRegistry({
  store: identityService.storeInstance,
  dataRoot: config.dataRoot,
  gitCommitter: {
    name: config.gitCommitterName,
    email: config.gitCommitterEmail,
  },
  appClient: gitHubAppClient,
  sharedResourceDependencies: {
    contentResolverUrl: config.contentResolverUrl,
    contentResolverToken: config.contentResolverToken,
    contentResolverTimeoutMs: config.contentResolverTimeoutMs,
  },
});

const productPolicy = await loadProductPolicy();
const auditStore = new AuditStore(config.auditDbPath);

// CEO Product User provisioner and session manager (independent from Audit auth)
const userProvisioner = new IdentityAccountProvisioner(identityService.storeInstance);
const isSecureOrigin = config.publicOrigin
  ? config.publicOrigin.startsWith("https://")
  : false;
const userSessionManager = new UserSessionManager({
  secureCookies: isSecureOrigin,
});

const connectorControlStore = new ConnectorControlStore(identityService.storeInstance);
const deviceEnrollmentStore = new DeviceEnrollmentStore();

// Neutral Redis transport (lifecycle owned by neutral queue infrastructure)
const redisTransport = openNeutralRedisRunner(config.redisUrl);
const redisRunner = redisTransport?.runner ?? null;

// Optional legacy worker-bridge job layer (disabled unless configured). Resource
// existence for new tasks is checked against repo contents of the requested workspace runtime.
const jobBridge = openJobBridge(
  {
    bridgeEnabled: config.bridgeEnabled,
    redisUrl: config.redisUrl,
  },
  async (scope, resourceId) => {
    const runtime = await runtimeRegistry.get(scope.workspace_id);
    const loc = await resolveResourceLocation(runtime.workspace.config.repoDir, resourceId);
    return loc !== null;
  },
  redisRunner,
);

// V2 Connector Job Coordinator (independent of legacy bridgeEnabled, active whenever Redis is configured)
const v2Store = redisRunner ? new RedisJobStoreV2(redisRunner) : null;
const v2Coordinator = v2Store
  ? new JobCoordinatorV2({
      store: v2Store,
      controlStore: connectorControlStore,
      identityStore: identityService.storeInstance,
      resourceExists: async (scope, resourceId) => {
        const runtime = await runtimeRegistry.get(scope.workspaceId);
        const loc = await resolveResourceLocation(runtime.workspace.config.repoDir, resourceId);
        return loc !== null;
      },
    })
  : null;

const app = createMcpExpressApp({ host: config.bindHost });

const protocolCors = createProtocolCorsMiddleware(config.protocolAllowedOrigins);
// Protocol CORS must run before the global JSON parser so browser clients can
// read parser errors (400/413) instead of a CORS/network failure.
app.use("/mcp", createHostGuard(config.allowedHosts), protocolCors);
app.use("/.well-known", protocolCors);
app.use("/register", protocolCors);
app.use("/token", protocolCors);

// Managed result route FIRST with dedicated 9 MiB body limit:
// Host -> Origin -> Identity -> 9mb parser -> resultHandler
const resolveResourceServiceForScope = async (scope: JobAuthScope) => {
  const runtime = await runtimeRegistry.get(scope.workspace_id);
  return runtime.resourceService;
};

app.post(
  "/api/worker/jobs/:job_id/result",
  createHostGuard(config.allowedHosts),
  createOriginGuard(config.allowedOrigins),
  createIdentityAuthMiddleware(identityService),
  express.json({ limit: "9mb" }),
  createJobResultHandler(jobBridge.service, resolveResourceServiceForScope),
);

// Ordinary JSON body parser for subsequent routes (default 100 KiB)
app.use(express.json());

// Probes
app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true, version: BUILD_INFO.version, build: BUILD_INFO.build });
});
app.get("/readyz", (_req, res) => {
  const dbOk = identityService.storeInstance.ping();
  const gitHubAppOk = Boolean(gitHubAppClient);
  const ready = dbOk && gitHubAppOk;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    state: ready ? "READY" : "NOT_READY",
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
    const identity = res.locals.identity!;
    res.status(200).json({
      user_id: identity.user_id,
      workspace_id: identity.workspace_id,
      deployment_mode: "request_scoped_workspace",
    });
  },
);

// Audit routes use the product GitHub user session plus users.is_admin.
app.use(
  createAuditRouter({
    auditStore,
    identityService,
    sessionManager: userSessionManager,
  }),
);

// Product user session router (independent from Audit session)
app.use(
  "/api/user",
  createUserRouter({
    store: identityService.storeInstance,
    sessionManager: userSessionManager,
    controlStore: connectorControlStore,
  }),
);

// Connector trusted-device enrollment & auth router (when publicOrigin is configured)
if (config.publicOrigin) {
  app.use(
    createConnectorRouter({
      controlStore: connectorControlStore,
      enrollmentStore: deviceEnrollmentStore,
      identityStore: identityService.storeInstance,
      sessionManager: userSessionManager,
      publicOrigin: config.publicOrigin,
      hostGuard: createHostGuard(config.allowedHosts),
      originGuard: createOriginGuard(config.allowedOrigins),
    }),
  );
} else {
  process.stdout.write("Connector enrollment router disabled: publicOrigin is not configured\n");
}

if (v2Coordinator) {
  app.use(
    "/api/connector/jobs",
    createHostGuard(config.allowedHosts),
    createOriginGuard(config.allowedOrigins),
    createConnectorJobsRouter(v2Coordinator, connectorControlStore, identityService.storeInstance),
  );
}

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
import { OnboardingStore } from "./onboarding/store.js";
import { OnboardingService } from "./onboarding/service.js";
import { createOnboardingRouter } from "./onboarding/router.js";
import { OAuthStore } from "./oauth/store.js";
import { OAuthService } from "./oauth/service.js";
import { createOAuthRouter } from "./oauth/router.js";
import {
  CimdClientResolver,
  CompositeClientResolver,
  type OAuthClientResolver,
} from "./oauth/client-resolver.js";
import { DcrStore } from "./oauth/dcr/store.js";
import { DcrClientResolver, DcrService } from "./oauth/dcr/service.js";
import { createDcrRouter } from "./oauth/dcr/router.js";

let oauthStore: OAuthStore | null = null;
let oauthService: OAuthService | null = null;
let dcrStore: DcrStore | null = null;
let bootstrapService: WorkspaceBootstrapService | null = null;
let onboardingService: OnboardingService | null = null;

if (config.githubAppEnabled && gitHubAppClient) {
  const defaultAppCallback = config.publicOrigin
    ? `${config.publicOrigin.replace(/\/+$/, "")}/auth/github-app/callback`
    : `http://${config.bindHost}:${config.port}/auth/github-app/callback`;
  const appCallbackUrl = config.githubAppCallbackUrl || defaultAppCallback;

  const installationService = new GitHubInstallationService({
    appClient: gitHubAppClient,
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

  bootstrapService = new WorkspaceBootstrapService({
    appClient: gitHubAppClient,
    store: identityService.storeInstance,
    gitCommitter: {
      name: config.gitCommitterName,
      email: config.gitCommitterEmail,
    },
  });

  const repositoryService = new GitHubRepositoryService({
    appClient: gitHubAppClient,
    store: identityService.storeInstance,
    clientId: config.githubAppClientId!,
    clientSecret: config.githubAppClientSecret!,
    callbackUrl: repoCallbackUrl,
    sessionManager: userSessionManager,
    bootstrapService,
  });

  const onboardingStore = new OnboardingStore(identityService.storeInstance);
  onboardingService = new OnboardingService({
    store: onboardingStore,
    identityStore: identityService.storeInstance,
    installationService,
    repositoryService,
    bootstrapService,
    appClient: gitHubAppClient,
  });

  app.use(
    "/auth/github-app",
    createGitHubAppAuthRouter({
      installationService,
      repositoryService,
      sessionManager: userSessionManager,
      store: identityService.storeInstance,
      onboardingService,
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
    "/api/workspaces",
    createWorkspaceProvisioningRouter({
      bootstrapService,
      sessionManager: userSessionManager,
      store: identityService.storeInstance,
    }),
  );

  app.use(
    "/onboarding",
    createOnboardingRouter({
      onboardingService,
      sessionManager: userSessionManager,
      identityStore: identityService.storeInstance,
      installationService,
      repositoryService,
      getOAuthService: () => oauthService,
    }),
  );
}

// OAuth 2.1 Authorization Server (when enabled)
if (config.oauthEnabled) {
  const publicOrigin = config.publicOrigin!;
  oauthStore = new OAuthStore(config.oauthDbPath);

  const cimdResolver = new CimdClientResolver();
  let dcrResolver: OAuthClientResolver | undefined;
  let dcrService: DcrService | undefined;
  if (config.oauthDcrEnabled) {
    dcrStore = new DcrStore(config.oauthDcrDbPath);
    dcrService = new DcrService(dcrStore);
    dcrResolver = new DcrClientResolver(dcrService);
    app.use(createDcrRouter({ dcrService }));
  }

  const clientResolver = new CompositeClientResolver({
    cimd: cimdResolver,
    dcr: dcrResolver,
  });

  oauthService = new OAuthService(oauthStore, identityService.storeInstance, {
    publicOrigin,
    clientResolver,
    ...(config.oauthDcrEnabled ? { registrationEndpoint: `${publicOrigin}/register` } : {}),
  });

  app.use(
    createOAuthRouter({
      oauthService,
      sessionManager: userSessionManager,
      identityStore: identityService.storeInstance,
      bootstrapService: bootstrapService ?? undefined,
      onboardingService: onboardingService ?? undefined,
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

// MCP workspace runtime resolution middleware (strictly request-scoped, zero fallback)
const workspaceRuntimeMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const identity = res.locals.identity;
  if (!identity || !identity.workspace_id) {
    res.status(403).json({
      jsonrpc: "2.0",
      error: { code: -32003, message: "Forbidden: workspace access denied" },
      id: null,
    });
    return;
  }

  try {
    const runtime = await runtimeRegistry.get(identity.workspace_id);
    res.locals.workspaceRuntime = runtime;
    next();
  } catch (error) {
    process.stderr.write(`runtime: failed to resolve workspace runtime '${identity.workspace_id}': ${error}\n`);
    res.status(503).json({
      jsonrpc: "2.0",
      error: { code: -32050, message: "Workspace runtime unavailable" },
      id: null,
    });
    return;
  }
};

app.all(
  "/mcp",
  createHostGuard(config.allowedHosts),
  config.oauthEnabled && oauthService
    ? createMcpAuthMiddleware(identityService, oauthService)
    : createIdentityAuthMiddleware(identityService),
  workspaceRuntimeMiddleware,
  async (req: Request, res: Response) => {
    attachMcpProtocolLog(req, res);
    const runtime = res.locals.workspaceRuntime!;
    const mcpIdentity = {
      user_id: res.locals.identity!.user_id,
      workspace_id: res.locals.identity!.workspace_id,
    };
    const handler = toNodeHandler(
      createMcpHandler(
        () =>
          createMcpServer(runtime.workspace, productPolicy, {
            auditStore,
            identity: mcpIdentity,
            jobs: { service: jobBridge.service },
            resourceService: runtime.resourceService,
          }),
        // 2025-era hosts still send initialize; this is the SDK's standard fallback.
        { legacy: "stateless" },
      ),
    );
    await handler(req, res, req.body);
  },
);

const listener = app.listen(config.port, config.bindHost, () => {
  process.stdout.write(`CEO MCP listening on http://${config.bindHost}:${config.port}/mcp\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    auditStore.close();
    oauthStore?.close();
    dcrStore?.close();
    identityService.close();
    void jobBridge.dispose();
    if (redisTransport) void redisTransport.dispose();
    listener.close(() => process.exit(0));
  });
}
