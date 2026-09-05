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
  const dataRoot = path.resolve(env.CEO_DATA_ROOT ?? "/data");
  const port = Number.parseInt(env.PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  const bindHost = env.BIND_HOST ?? "127.0.0.1";
  const mcpApiKey = env.MCP_API_KEY;
  
  if (bindHost !== "127.0.0.1" && bindHost !== "::1" && !mcpApiKey) {
    throw new Error("MCP_API_KEY is required when binding to a non-loopback address");
  }

  const remoteUrl = env.CEO_REMOTE?.trim();
  if (!remoteUrl) {
    throw new Error("CEO_REMOTE is required");
  }

  const allowedHosts = env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(",").map(s => s.trim()).filter(Boolean) : ["localhost", "127.0.0.1"];
  const allowedOrigins = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean) : [];

  return {
    dataRoot,
    repoDir: path.join(dataRoot, "repo"),
    txnDir: path.join(dataRoot, "txns"),
    stateDir: path.join(dataRoot, "state"),
    branch: env.CEO_BRANCH ?? "main",
    remoteUrl,
    port,
    bindHost,
    gitAuthorName: env.CEO_GIT_AUTHOR_NAME ?? "CEO State MCP",
    gitAuthorEmail: env.CEO_GIT_AUTHOR_EMAIL ?? "ceo-mcp@users.noreply.github.com",
    ...(env.CEO_SSH_KEY_PATH ? { sshKeyPath: env.CEO_SSH_KEY_PATH } : {}),
    ...(env.CEO_KNOWN_HOSTS_PATH ? { knownHostsPath: env.CEO_KNOWN_HOSTS_PATH } : {}),
    ...(mcpApiKey ? { mcpApiKey } : {}),
    allowedHosts,
    allowedOrigins,
    auditDir: path.join(dataRoot, "audit"),
    auditDbPath: env.CEO_AUDIT_DB_PATH ?? path.join(dataRoot, "audit", "ceo-trace.sqlite"),
  };
}
