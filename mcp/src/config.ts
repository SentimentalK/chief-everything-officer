import path from "node:path";

export interface Config {
  dataRoot: string;
  repoDir: string;
  txnDir: string;
  stateDir: string;
  branch: string;
  remoteUrl: string;
  port: number;
  bindHost: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  sshKeyPath?: string;
  knownHostsPath?: string;
  mcpApiKey?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  auditDir: string;
  auditDbPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataRoot = path.resolve(env.LIFEOS_DATA_ROOT ?? "/data");
  const port = Number.parseInt(env.PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  const bindHost = env.BIND_HOST ?? "127.0.0.1";
  const mcpApiKey = env.MCP_API_KEY;
  
  if (bindHost !== "127.0.0.1" && bindHost !== "::1" && !mcpApiKey) {
    throw new Error("MCP_API_KEY is required when binding to a non-loopback address");
  }

  const allowedHosts = env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(",").map(s => s.trim()).filter(Boolean) : ["localhost", "127.0.0.1"];
  const allowedOrigins = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean) : [];

  return {
    dataRoot,
    repoDir: path.join(dataRoot, "repo"),
    txnDir: path.join(dataRoot, "txns"),
    stateDir: path.join(dataRoot, "state"),
    branch: env.LIFEOS_BRANCH ?? "main",
    remoteUrl: env.LIFEOS_REMOTE ?? "git@github.com:SentimentalK/LifeOS.git",
    port,
    bindHost,
    gitAuthorName: env.LIFEOS_GIT_AUTHOR_NAME ?? "LifeOS MCP",
    gitAuthorEmail: env.LIFEOS_GIT_AUTHOR_EMAIL ?? "lifeos-mcp@users.noreply.github.com",
    ...(env.LIFEOS_SSH_KEY_PATH ? { sshKeyPath: env.LIFEOS_SSH_KEY_PATH } : {}),
    ...(env.LIFEOS_KNOWN_HOSTS_PATH ? { knownHostsPath: env.LIFEOS_KNOWN_HOSTS_PATH } : {}),
    ...(mcpApiKey ? { mcpApiKey } : {}),
    allowedHosts,
    allowedOrigins,
    auditDir: path.join(dataRoot, "audit"),
    auditDbPath: env.CEO_AUDIT_DB_PATH ?? path.join(dataRoot, "audit", "ceo-trace.sqlite"),
  };
}
