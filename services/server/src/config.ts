import path from "node:path";
import fs from "node:fs";

export interface Config {
  dataRoot: string;
  port: number;
  bindHost: string;
  gitCommitterName: string;
  gitCommitterEmail: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  protocolAllowedOrigins: string[];
  auditDir: string;
  auditDbPath: string;
  identityDbPath: string;
  contentResolverUrl?: string;
  contentResolverToken?: string;
  contentResolverTimeoutMs: number;
  redisUrl?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  githubCallbackUrl?: string;
  publicOrigin?: string;
  oauthEnabled: boolean;
  oauthDbPath: string;
  oauthDcrEnabled: boolean;
  oauthDcrDbPath: string;
  githubAppEnabled: boolean;
  githubAppClientId?: string;
  githubAppClientSecret?: string;
  githubAppSlug?: string;
  githubAppPrivateKeyPath?: string;
  githubAppCallbackUrl?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataRoot = path.resolve(env.CEO_DATA_ROOT ?? "/data");
  const port = Number.parseInt(env.PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  const bindHost = env.BIND_HOST ?? "127.0.0.1";

  const redisUrlRaw = env.CEO_REDIS_URL?.trim();
  if (redisUrlRaw && !/^rediss?:\/\//i.test(redisUrlRaw)) {
    throw new Error("CEO_REDIS_URL must be a redis:// or rediss:// URL");
  }
  const redisUrl = redisUrlRaw || undefined;

  const allowedHosts = env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(",").map(s => s.trim()).filter(Boolean) : ["localhost", "127.0.0.1"];
  const allowedOrigins = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean) : [];
  const protocolAllowedOrigins = env.CEO_PROTOCOL_ALLOWED_ORIGINS
    ? env.CEO_PROTOCOL_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const gitCommitterName = env.CEO_GIT_COMMITTER_NAME ?? "CEO State MCP";
  const gitCommitterEmail = env.CEO_GIT_COMMITTER_EMAIL ?? "ceo-mcp@users.noreply.github.com";

  const contentResolverUrl = env.CONTENT_RESOLVER_URL?.trim() || undefined;
  const contentResolverToken = env.CONTENT_RESOLVER_TOKEN?.trim() || undefined;

  if ((contentResolverUrl && !contentResolverToken) || (!contentResolverUrl && contentResolverToken)) {
    throw new Error("Invalid configuration: CONTENT_RESOLVER_URL and CONTENT_RESOLVER_TOKEN must both be set or both be omitted.");
  }

  let contentResolverTimeoutMs = 5000;
  if (env.CONTENT_RESOLVER_TIMEOUT_MS) {
    const parsedTimeout = Number.parseInt(env.CONTENT_RESOLVER_TIMEOUT_MS, 10);
    if (Number.isInteger(parsedTimeout) && parsedTimeout > 0) {
      contentResolverTimeoutMs = parsedTimeout;
    } else {
      throw new Error("CONTENT_RESOLVER_TIMEOUT_MS must be a positive integer");
    }
  }

  const githubClientId = env.GITHUB_CLIENT_ID?.trim() || env.CEO_GITHUB_CLIENT_ID?.trim() || undefined;
  const githubClientSecret = env.GITHUB_CLIENT_SECRET?.trim() || env.CEO_GITHUB_CLIENT_SECRET?.trim() || undefined;
  const githubCallbackUrl = env.GITHUB_CALLBACK_URL?.trim() || env.CEO_GITHUB_CALLBACK_URL?.trim() || undefined;
  const rawPublicOrigin = env.CEO_PUBLIC_ORIGIN?.trim() || env.PUBLIC_ORIGIN?.trim() || undefined;
  const oauthEnabled = parseBool(env.CEO_OAUTH_ENABLED, false);
  const oauthDcrEnabled = parseBool(env.CEO_OAUTH_DCR_ENABLED, false);
  if (oauthDcrEnabled && !oauthEnabled) {
    throw new Error("CEO_OAUTH_DCR_ENABLED=true requires CEO_OAUTH_ENABLED=true");
  }

  let publicOrigin = rawPublicOrigin;
  if (oauthEnabled) {
    if (!publicOrigin) {
      throw new Error("CEO_PUBLIC_ORIGIN is required when CEO_OAUTH_ENABLED is true");
    }
    let parsed: URL;
    try {
      parsed = new URL(publicOrigin);
    } catch {
      throw new Error(`CEO_PUBLIC_ORIGIN must be a valid URL, got '${publicOrigin}'`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`CEO_PUBLIC_ORIGIN must use https: scheme when CEO_OAUTH_ENABLED is true, got '${publicOrigin}'`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`CEO_PUBLIC_ORIGIN must not contain credentials, got '${publicOrigin}'`);
    }
    if (parsed.pathname !== "/" && parsed.pathname !== "") {
      throw new Error(`CEO_PUBLIC_ORIGIN must be an origin only without path segments, got '${publicOrigin}'`);
    }
    if (parsed.search || parsed.hash) {
      throw new Error(`CEO_PUBLIC_ORIGIN must not contain query or fragment, got '${publicOrigin}'`);
    }
    publicOrigin = parsed.origin;
  }

  const githubAppEnabled = parseBool(env.CEO_GITHUB_APP_ENABLED, false);
  const githubAppClientId = env.CEO_GITHUB_APP_CLIENT_ID?.trim() || undefined;
  const githubAppClientSecret = env.CEO_GITHUB_APP_CLIENT_SECRET?.trim() || undefined;
  const githubAppSlug = env.CEO_GITHUB_APP_SLUG?.trim() || undefined;
  const githubAppPrivateKeyPath = env.CEO_GITHUB_APP_PRIVATE_KEY_PATH?.trim() || undefined;
  const githubAppCallbackUrl = env.CEO_GITHUB_APP_CALLBACK_URL?.trim() || undefined;

  if (githubAppEnabled) {
    if (!githubAppClientId) {
      throw new Error("CEO_GITHUB_APP_CLIENT_ID is required when CEO_GITHUB_APP_ENABLED is true");
    }
    if (!githubAppClientSecret) {
      throw new Error("CEO_GITHUB_APP_CLIENT_SECRET is required when CEO_GITHUB_APP_ENABLED is true");
    }
    if (!githubAppSlug) {
      throw new Error("CEO_GITHUB_APP_SLUG is required when CEO_GITHUB_APP_ENABLED is true");
    }
    if (!githubAppPrivateKeyPath) {
      throw new Error("CEO_GITHUB_APP_PRIVATE_KEY_PATH is required when CEO_GITHUB_APP_ENABLED is true");
    }
    if (!fs.existsSync(githubAppPrivateKeyPath)) {
      throw new Error(`CEO_GITHUB_APP_PRIVATE_KEY_PATH file not found: ${githubAppPrivateKeyPath}`);
    }
  }

  return {
    dataRoot,
    port,
    bindHost,
    gitCommitterName,
    gitCommitterEmail,
    allowedHosts,
    allowedOrigins,
    protocolAllowedOrigins,
    auditDir: path.join(dataRoot, "audit"),
    auditDbPath: env.CEO_AUDIT_DB_PATH ?? path.join(dataRoot, "audit", "ceo-trace.sqlite"),
    identityDbPath: path.join(dataRoot, "identity", "identity.sqlite"),
    ...(contentResolverUrl ? { contentResolverUrl } : {}),
    ...(contentResolverToken ? { contentResolverToken } : {}),
    contentResolverTimeoutMs,
    ...(redisUrl ? { redisUrl } : {}),
    ...(githubClientId ? { githubClientId } : {}),
    ...(githubClientSecret ? { githubClientSecret } : {}),
    ...(githubCallbackUrl ? { githubCallbackUrl } : {}),
    ...(publicOrigin ? { publicOrigin } : {}),
    oauthEnabled,
    oauthDbPath: env.CEO_OAUTH_DB_PATH ?? path.join(dataRoot, "identity", "oauth.sqlite"),
    oauthDcrEnabled,
    oauthDcrDbPath: env.CEO_OAUTH_DCR_DB_PATH ?? path.join(dataRoot, "identity", "oauth-dcr.sqlite"),
    githubAppEnabled,
    ...(githubAppClientId ? { githubAppClientId } : {}),
    ...(githubAppClientSecret ? { githubAppClientSecret } : {}),
    ...(githubAppSlug ? { githubAppSlug } : {}),
    ...(githubAppPrivateKeyPath ? { githubAppPrivateKeyPath } : {}),
    ...(githubAppCallbackUrl ? { githubAppCallbackUrl } : {}),
  };
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}
