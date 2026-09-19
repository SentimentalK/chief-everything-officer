import express, { type Request, type Response, type Router } from "express";
import type { OnboardingService } from "./service.js";
import type { UserSessionManager } from "../auth/user-session.js";
import type { IdentityStore } from "../identity/store.js";
import type { OAuthService } from "../oauth/service.js";
import type { GitHubInstallationService } from "../github/installation-service.js";
import type { GitHubRepositoryService } from "../github/repository-service.js";

export interface OnboardingRouterOptions {
  onboardingService: OnboardingService;
  sessionManager: UserSessionManager;
  identityStore: IdentityStore;
  installationService: GitHubInstallationService;
  repositoryService: GitHubRepositoryService;
  oauthService?: OAuthService | null;
  getOAuthService?: () => OAuthService | null | undefined;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderOnboardingPage(input: {
  title: string;
  subtitle: string;
  flowId: string;
  defaultRepoName: string;
  oauthRequest?: string;
  errorMessage?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(input.title)} - Chief Everything Officer</title>
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
      padding: 28px 24px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    }
    .header { text-align: center; margin-bottom: 24px; }
    .header h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; color: #ffffff; }
    .header p { font-size: 13px; color: #a1a1a1; line-height: 1.5; }
    .error-box {
      background: #3b1818;
      border: 1px solid #782020;
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 12px;
      color: #fca5a5;
      margin-bottom: 20px;
      line-height: 1.4;
    }
    .form-group { margin-bottom: 20px; }
    label { display: block; font-size: 13px; font-weight: 500; color: #cccccc; margin-bottom: 6px; }
    input[type="text"] {
      width: 100%;
      padding: 10px 12px;
      background: #1a1a1a;
      border: 1px solid #333333;
      border-radius: 6px;
      color: #ffffff;
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type="text"]:focus { border-color: #666666; }
    .hint { font-size: 12px; color: #888888; margin-top: 6px; }
    button {
      width: 100%;
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      border-radius: 6px;
      cursor: pointer;
      border: none;
      background-color: #ededed;
      color: #000000;
      transition: background-color 0.15s ease;
    }
    button:hover { background-color: #ffffff; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.subtitle)}</p>
    </div>

    ${input.errorMessage ? `<div class="error-box">${escapeHtml(input.errorMessage)}</div>` : ""}

    <form method="POST" action="/onboarding/repository-choice">
      <input type="hidden" name="flow_id" value="${escapeHtml(input.flowId)}" />
      ${input.oauthRequest ? `<input type="hidden" name="oauth_request" value="${escapeHtml(input.oauthRequest)}" />` : ""}

      <div class="form-group">
        <label for="repo_name">Repository name</label>
        <input
          type="text"
          id="repo_name"
          name="repository_name"
          value="${escapeHtml(input.defaultRepoName)}"
          required
          autofocus
        />
        <p class="hint">This repository will be private on your GitHub account.</p>
      </div>

      <button type="submit">Create my CEO workspace</button>
    </form>
  </div>
</body>
</html>`;
}

function renderSecurityRestrictionPage(input: {
  flowId: string;
  repositoryFullName?: string;
  installationSettingsUrl?: string;
  oauthRequest?: string;
  errorMessage?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Restrict GitHub Access - Chief Everything Officer</title>
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
      max-width: 480px;
      background-color: #121212;
      border: 1px solid #262626;
      border-radius: 12px;
      padding: 28px 24px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    }
    .header { text-align: center; margin-bottom: 20px; }
    .header h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; color: #ffffff; }
    .header p { font-size: 13px; color: #a1a1a1; line-height: 1.5; }
    .repo-badge {
      background: #1a1a1a;
      border: 1px solid #333333;
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 20px;
      font-size: 13px;
    }
    .repo-badge .label { color: #888888; font-size: 12px; margin-bottom: 4px; }
    .repo-badge .name { font-family: monospace; color: #34d399; font-weight: 600; }
    .security-box {
      background: #181c24;
      border: 1px solid #2a3b5c;
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 20px;
      font-size: 13px;
      line-height: 1.5;
      color: #cbd5e1;
    }
    .security-box strong { color: #ffffff; }
    .security-box ol { margin-left: 18px; margin-top: 8px; margin-bottom: 8px; }
    .security-box li { margin-bottom: 4px; }
    .error-box {
      background: #3b1818;
      border: 1px solid #782020;
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 12px;
      color: #fca5a5;
      margin-bottom: 20px;
      line-height: 1.4;
    }
    a.btn-secondary {
      display: block;
      width: 100%;
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      text-align: center;
      border-radius: 6px;
      text-decoration: none;
      background-color: #262626;
      color: #ffffff;
      margin-bottom: 12px;
      transition: background-color 0.15s ease;
    }
    a.btn-secondary:hover { background-color: #333333; }
    button.btn-primary {
      width: 100%;
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      border-radius: 6px;
      cursor: pointer;
      border: none;
      background-color: #ededed;
      color: #000000;
      transition: background-color 0.15s ease;
    }
    button.btn-primary:hover { background-color: #ffffff; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>Your CEO repository is ready</h1>
      <p>A private GitHub repository was created for your personal CEO workspace.</p>
    </div>

    ${input.repositoryFullName ? `
      <div class="repo-badge">
        <div class="label">Repository created:</div>
        <div class="name">${escapeHtml(input.repositoryFullName)}</div>
      </div>
    ` : ""}

    <div class="security-box">
      <strong>Security step required:</strong>
      <p style="margin-top: 6px;">GitHub temporarily granted CEO access to all repositories so CEO could create your workspace repository.</p>
      <p style="margin-top: 6px;">Before continuing, you must restrict CEO's access to only this new repository:</p>
      <ol>
        <li>Click <strong>Open GitHub Access Settings</strong> below</li>
        <li>Select <strong>Only select repositories</strong></li>
        <li>Choose <strong>${input.repositoryFullName ? escapeHtml(input.repositoryFullName.split("/")[1] || "personal-vault") : "personal-vault"}</strong></li>
        <li>Click <strong>Save</strong> and return here</li>
      </ol>
    </div>

    ${input.errorMessage ? `<div class="error-box">${escapeHtml(input.errorMessage)}</div>` : ""}

    ${input.installationSettingsUrl ? `
      <a href="${escapeHtml(input.installationSettingsUrl)}" class="btn-secondary">
        Open GitHub Access Settings
      </a>
    ` : ""}

    <form method="POST" action="/onboarding/verify-repository-access">
      <input type="hidden" name="flow_id" value="${escapeHtml(input.flowId)}" />
      ${input.oauthRequest ? `<input type="hidden" name="oauth_request" value="${escapeHtml(input.oauthRequest)}" />` : ""}
      <button type="submit" class="btn-primary">Check access & continue</button>
    </form>
  </div>
</body>
</html>`;
}

function renderCompletionPage(input: {
  title: string;
  message: string;
  resumeUrl?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(input.title)} - Chief Everything Officer</title>
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
      padding: 28px 24px;
      text-align: center;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    }
    .success-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      background: #064e3b;
      color: #34d399;
      border-radius: 50%;
      margin-bottom: 16px;
      font-size: 20px;
    }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; color: #ffffff; }
    p { font-size: 13px; color: #a1a1a1; line-height: 1.5; margin-bottom: 24px; }
    a.btn {
      display: inline-block;
      width: 100%;
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      border-radius: 6px;
      text-decoration: none;
      background-color: #ededed;
      color: #000000;
      transition: background-color 0.15s ease;
    }
    a.btn:hover { background-color: #ffffff; }
  </style>
</head>
<body>
  <div class="card">
    <div class="success-badge">✓</div>
    <h1>${escapeHtml(input.title)}</h1>
    <p>${escapeHtml(input.message)}</p>
    ${input.resumeUrl ? `<a href="${escapeHtml(input.resumeUrl)}" class="btn">Continue to Application</a>` : ""}
  </div>
</body>
</html>`;
}

function renderRecoveryPage(input: {
  flowId?: string;
  workspaceId?: string;
  errorCode: string;
  errorMessage: string;
  oauthRequest?: string;
  defaultRepoName?: string;
}): string {
  const isConflict = input.errorCode === "REPOSITORY_NAME_CONFLICT";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Setup Incomplete - Chief Everything Officer</title>
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
      padding: 28px 24px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    }
    .header { text-align: center; margin-bottom: 20px; }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 6px; color: #f87171; }
    p { font-size: 13px; color: #a1a1a1; line-height: 1.5; }
    .box { background: #1a1a1a; border: 1px solid #333333; border-radius: 8px; padding: 14px; margin-bottom: 20px; font-size: 13px; color: #e5e5e5; }
    .form-group { margin-bottom: 20px; }
    label { display: block; font-size: 13px; font-weight: 500; color: #cccccc; margin-bottom: 6px; }
    input[type="text"] {
      width: 100%;
      padding: 10px 12px;
      background: #1a1a1a;
      border: 1px solid #333333;
      border-radius: 6px;
      color: #ffffff;
      font-size: 14px;
      outline: none;
    }
    button {
      width: 100%;
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      border-radius: 6px;
      cursor: pointer;
      border: none;
      background-color: #ededed;
      color: #000000;
      transition: background-color 0.15s ease;
    }
    button:hover { background-color: #ffffff; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>Setup Notice</h1>
      <p>Your workspace setup requires attention before continuing</p>
    </div>

    <div class="box">
      ${escapeHtml(input.errorMessage)}
    </div>

    ${
      isConflict
        ? `<form method="POST" action="/onboarding/repository-choice">
             ${input.flowId ? `<input type="hidden" name="flow_id" value="${escapeHtml(input.flowId)}" />` : ""}
             ${input.oauthRequest ? `<input type="hidden" name="oauth_request" value="${escapeHtml(input.oauthRequest)}" />` : ""}
             <div class="form-group">
               <label for="repo_name">Choose an alternative repository name</label>
               <input
                 type="text"
                 id="repo_name"
                 name="repository_name"
                 value="${escapeHtml(input.defaultRepoName || "personal-vault-2")}"
                 required
                 autofocus
               />
             </div>
             <button type="submit">Retry with new name</button>
           </form>`
        : `<form method="POST" action="/onboarding/retry">
             ${input.flowId ? `<input type="hidden" name="flow_id" value="${escapeHtml(input.flowId)}" />` : ""}
             ${input.workspaceId ? `<input type="hidden" name="workspace_id" value="${escapeHtml(input.workspaceId)}" />` : ""}
             ${input.oauthRequest ? `<input type="hidden" name="oauth_request" value="${escapeHtml(input.oauthRequest)}" />` : ""}
             <button type="submit">Retry Setup</button>
           </form>`
    }
  </div>
</body>
</html>`;
}

export function createOnboardingRouter(options: OnboardingRouterOptions): Router {
  const {
    onboardingService,
    sessionManager,
    identityStore,
    installationService,
    repositoryService,
  } = options;

  const resolveOAuthService = (): OAuthService | null | undefined => {
    if (typeof options.getOAuthService === "function") {
      return options.getOAuthService();
    }
    return options.oauthService;
  };

  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  router.use(express.json());

  // 1. GET /onboarding
  router.get("/", async (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    const oauthRequest = typeof req.query.oauth_request === "string" ? req.query.oauth_request : undefined;

    if (!session || !identityStore.isUserActive(session.userId)) {
      const loginTarget = oauthRequest
        ? `/login?oauth_request=${encodeURIComponent(oauthRequest)}`
        : "/login";
      res.redirect(302, loginTarget);
      return;
    }

    if (session.provider !== "github" || !session.providerSubject) {
      res.status(403).send("GitHub identity required for CEO workspace onboarding");
      return;
    }

    // Invariant: Flow-first routing! Always inspect active flow BEFORE checking memberships.
    const flow = onboardingService.getOrCreateActiveFlow(session.userId, session.providerSubject);

    if (flow.state === "AWAITING_REPOSITORY_RESTRICTION") {
      const target = oauthRequest
        ? `/onboarding/security?flow=${encodeURIComponent(flow.id)}&oauth_request=${encodeURIComponent(oauthRequest)}`
        : `/onboarding/security?flow=${encodeURIComponent(flow.id)}`;
      res.redirect(302, target);
      return;
    }

    if (flow.state === "READY_TO_RESUME") {
      const target = oauthRequest
        ? `/onboarding/complete?flow=${encodeURIComponent(flow.id)}&oauth_request=${encodeURIComponent(oauthRequest)}`
        : `/onboarding/complete?flow=${encodeURIComponent(flow.id)}`;
      res.redirect(302, target);
      return;
    }

    if (flow.state === "RECOVERY_REQUIRED") {
      const target = oauthRequest
        ? `/onboarding/recovery?flow=${encodeURIComponent(flow.id)}&oauth_request=${encodeURIComponent(oauthRequest)}`
        : `/onboarding/recovery?flow=${encodeURIComponent(flow.id)}`;
      res.redirect(302, target);
      return;
    }

    // Only if flow is NOT active or completed, check existing memberships
    const memberships = identityStore.listWorkspaceMembershipsForUser(session.userId);
    if (memberships.length > 0 && (flow.state as string) === "COMPLETED") {
      const target = oauthRequest
        ? `/onboarding/complete?oauth_request=${encodeURIComponent(oauthRequest)}`
        : "/onboarding/complete";
      res.redirect(302, target);
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(
      renderOnboardingPage({
        title: "Set up your CEO workspace",
        subtitle: "CEO will create a private GitHub repository named `personal-vault`. GitHub temporarily requires broad repository access before creating it, after which CEO will require restricting access.",
        flowId: flow.id,
        defaultRepoName: flow.desired_repository_name || "personal-vault",
        oauthRequest,
        errorMessage: flow.last_error_message || undefined,
      }),
    );
  });

function buildInstallationSettingsUrl(accountType: string, accountLogin: string, githubInstallationId: string): string {
  if (accountType && accountType.toLowerCase() === "organization") {
    return `https://github.com/organizations/${encodeURIComponent(accountLogin)}/settings/installations/${encodeURIComponent(githubInstallationId)}`;
  }
  return `https://github.com/settings/installations/${encodeURIComponent(githubInstallationId)}`;
}

  // GET /onboarding/security
  router.get("/security", async (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    const flowId = typeof req.query.flow === "string" ? req.query.flow : "";
    const oauthRequest = typeof req.query.oauth_request === "string" ? req.query.oauth_request : undefined;

    if (!session || !identityStore.isUserActive(session.userId)) {
      res.redirect(302, "/login");
      return;
    }

    const flow = onboardingService.storeInstance.getFlow(flowId);
    if (!flow || flow.user_id !== session.userId) {
      res.redirect(302, "/onboarding");
      return;
    }

    if (flow.state !== "AWAITING_REPOSITORY_RESTRICTION") {
      res.redirect(302, `/onboarding${oauthRequest ? `?oauth_request=${encodeURIComponent(oauthRequest)}` : ""}`);
      return;
    }

    let repoFullName: string | undefined;
    if (flow.repository_id) {
      const binding = identityStore.findRepositoryBindingByGitHubRepoId(flow.repository_id);
      if (binding) {
        repoFullName = binding.full_name;
      }
    }

    let installationSettingsUrl: string | undefined;
    if (flow.installation_row_id) {
      const inst = identityStore.findGitHubInstallationByRowId(flow.installation_row_id);
      if (inst) {
        installationSettingsUrl = buildInstallationSettingsUrl(
          inst.account_type,
          inst.account_login,
          inst.github_installation_id,
        );
      }
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(
      renderSecurityRestrictionPage({
        flowId: flow.id,
        repositoryFullName: repoFullName,
        installationSettingsUrl,
        oauthRequest: flow.host_oauth_request_id || oauthRequest,
        errorMessage: flow.last_error_message || undefined,
      }),
    );
  });

  // POST /onboarding/verify-repository-access
  router.post("/verify-repository-access", async (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    const body = req.body || {};
    const flowId = typeof body.flow_id === "string" ? body.flow_id : "";
    const oauthRequest = typeof body.oauth_request === "string" ? body.oauth_request : undefined;

    if (!session || !identityStore.isUserActive(session.userId)) {
      res.status(401).redirect("/login");
      return;
    }

    try {
      const result = await onboardingService.verifyRepositoryAccessAndBootstrap(flowId, session.userId);
      if (result.success && result.status === "READY") {
        res.redirect(302, `/onboarding/complete?flow=${encodeURIComponent(flowId)}`);
        return;
      }

      if (!result.success) {
        const flow = onboardingService.storeInstance.getFlow(flowId);
        let repoFullName: string | undefined;
        let installationSettingsUrl: string | undefined;
        if (flow?.repository_id) {
          const binding = identityStore.findRepositoryBindingByGitHubRepoId(flow.repository_id);
          repoFullName = binding?.full_name;
        }
        if (flow?.installation_row_id) {
          const inst = identityStore.findGitHubInstallationByRowId(flow.installation_row_id);
          if (inst) {
            installationSettingsUrl = buildInstallationSettingsUrl(
              inst.account_type,
              inst.account_login,
              inst.github_installation_id,
            );
          }
        }

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.status(400).send(
          renderSecurityRestrictionPage({
            flowId,
            repositoryFullName: repoFullName,
            installationSettingsUrl,
            oauthRequest: flow?.host_oauth_request_id || oauthRequest,
            errorMessage: result.message,
          }),
        );
        return;
      }

      // If bootstrap succeeded but ended up in recovery
      res.redirect(302, `/onboarding/recovery?flow=${encodeURIComponent(flowId)}${oauthRequest ? `&oauth_request=${encodeURIComponent(oauthRequest)}` : ""}`);
    } catch (error: any) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(400).send(
        renderSecurityRestrictionPage({
          flowId,
          oauthRequest,
          errorMessage: error?.message || String(error),
        }),
      );
    }
  });

  // 2. POST /onboarding/repository-choice
  router.post("/repository-choice", async (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    const body = req.body || {};
    const flowId = typeof body.flow_id === "string" ? body.flow_id : "";
    const repositoryName = typeof body.repository_name === "string" ? body.repository_name : "";
    const oauthRequest = typeof body.oauth_request === "string" ? body.oauth_request : undefined;

    if (!session || !identityStore.isUserActive(session.userId)) {
      res.status(401).redirect("/login");
      return;
    }

    try {
      onboardingService.submitRepositoryChoice(flowId, session.userId, repositoryName);

      // Check installation state
      const instState = await onboardingService.resolveInstallationState(flowId, session.userId);

      if (instState.status === "NEED_INSTALL") {
        const installUrl = installationService.createInstallRedirect(
          session.userId,
          session.providerSubject || "",
          { onboardingFlowId: flowId, oauthRequest },
        );
        res.redirect(302, installUrl);
        return;
      }

      // Live installation exists: initiate GitHub user authorization to obtain grant
      const { authorizationUrl } = repositoryService.createAuthorizationRedirect({
        sessionId: session.sessionId,
        userId: session.userId,
        providerSubject: session.providerSubject || "",
        installationId: instState.installation.github_installation_id,
        onboardingFlowId: flowId,
        oauthRequest,
      });

      res.redirect(302, authorizationUrl);
    } catch (error: any) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(400).send(
        renderOnboardingPage({
          title: "Set up your CEO workspace",
          subtitle: "CEO stores your personal data in a private GitHub repository that you own.",
          flowId,
          defaultRepoName: repositoryName || "personal-vault",
          oauthRequest,
          errorMessage: error?.message || String(error),
        }),
      );
    }
  });

  // 3. GET /onboarding/recovery
  router.get("/recovery", async (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    const flowId = typeof req.query.flow === "string" ? req.query.flow : "";
    const workspaceId = typeof req.query.workspace_id === "string" ? req.query.workspace_id : "";
    const oauthRequest = typeof req.query.oauth_request === "string" ? req.query.oauth_request : undefined;

    if (!session || !identityStore.isUserActive(session.userId)) {
      res.redirect(302, "/login");
      return;
    }

    if (workspaceId) {
      const memberships = identityStore.listWorkspaceMembershipsForUser(session.userId);
      if (!memberships.some((m) => m.workspace_id === workspaceId)) {
        res.status(403).send("Access denied");
        return;
      }
      const bootStatus = await onboardingService.bootstrapServiceInstance.getProvisioningStatus(workspaceId).catch(() => null);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(
        renderRecoveryPage({
          workspaceId,
          errorCode: bootStatus?.status || "BOOTSTRAP_INCOMPLETE",
          errorMessage: bootStatus?.bootstrap?.last_error_message || "Workspace bootstrap is not ready yet.",
          oauthRequest,
        }),
      );
      return;
    }

    const flow = onboardingService.storeInstance.getFlow(flowId);
    if (!flow || flow.user_id !== session.userId) {
      res.redirect(302, "/onboarding");
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(
      renderRecoveryPage({
        flowId: flow.id,
        errorCode: flow.last_error_code || "RECOVERY_REQUIRED",
        errorMessage: flow.last_error_message || "An error occurred during workspace setup.",
        oauthRequest,
        defaultRepoName: flow.desired_repository_name ? `${flow.desired_repository_name}-2` : "personal-vault-2",
      }),
    );
  });

  // 4. POST /onboarding/retry
  router.post("/retry", async (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    const body = req.body || {};
    const flowId = typeof body.flow_id === "string" ? body.flow_id : "";
    const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : "";
    const oauthRequest = typeof body.oauth_request === "string" ? body.oauth_request : undefined;

    if (!session || !identityStore.isUserActive(session.userId)) {
      res.redirect(302, "/login");
      return;
    }

    if (workspaceId) {
      const memberships = identityStore.listWorkspaceMembershipsForUser(session.userId);
      if (!memberships.some((m) => m.workspace_id === workspaceId)) {
        res.status(403).send("Access denied");
        return;
      }
      try {
        await onboardingService.bootstrapServiceInstance.bootstrapWorkspace(workspaceId);
        const target = oauthRequest
          ? `/onboarding/complete?oauth_request=${encodeURIComponent(oauthRequest)}`
          : `/onboarding/complete`;
        res.redirect(302, target);
      } catch (error: any) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.status(500).send(
          renderRecoveryPage({
            workspaceId,
            errorCode: "BOOTSTRAP_FAILED",
            errorMessage: error?.message || String(error),
            oauthRequest,
          }),
        );
      }
      return;
    }

    const flow = onboardingService.storeInstance.getFlow(flowId);
    if (!flow || flow.user_id !== session.userId) {
      res.redirect(302, "/onboarding");
      return;
    }

    try {
      if (flow.workspace_id) {
        await onboardingService.retryBootstrap(flowId, session.userId);
      }
      const target = oauthRequest
        ? `/onboarding/complete?flow=${encodeURIComponent(flowId)}&oauth_request=${encodeURIComponent(oauthRequest)}`
        : `/onboarding/complete?flow=${encodeURIComponent(flowId)}`;
      res.redirect(302, target);
    } catch (error: any) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(500).send(
        renderRecoveryPage({
          flowId,
          errorCode: flow.last_error_code || "BOOTSTRAP_FAILED",
          errorMessage: error?.message || String(error),
          oauthRequest,
        }),
      );
    }
  });

  // 5. GET /onboarding/complete
  router.get("/complete", (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    const flowId = typeof req.query.flow === "string" ? req.query.flow : undefined;
    let flow = flowId ? onboardingService.storeInstance.getFlow(flowId) : null;

    if (flow && session && flow.user_id === session.userId && flow.state === "READY_TO_RESUME") {
      flow = onboardingService.storeInstance.updateFlow(flowId!, {
        state: "COMPLETED",
      });
    }

    // Authoritative OAuth request resolution: server-side flow binding takes precedence over query
    const effectiveOauthRequestId = flow?.host_oauth_request_id || (typeof req.query.oauth_request === "string" ? req.query.oauth_request : undefined);

    const oauth = resolveOAuthService();
    let validAuthRequest = false;
    if (effectiveOauthRequestId && oauth) {
      validAuthRequest = Boolean(oauth.getAuthorizationRequest(effectiveOauthRequestId));
    }

    if (validAuthRequest && effectiveOauthRequestId) {
      // Resume Host OAuth immediately
      res.redirect(302, `/authorize/resume?request=${encodeURIComponent(effectiveOauthRequestId)}`);
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(
      renderCompletionPage({
        title: "Your CEO workspace is ready!",
        message: effectiveOauthRequestId
          ? "Your workspace is ready. The original Host authorization request has expired. Please return to your Host application (ChatGPT, Gemini, Grok) and connect CEO again."
          : "Your workspace has been successfully created and configured.",
      }),
    );
  });

  return router;
}
