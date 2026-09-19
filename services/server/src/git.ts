import { spawn } from "node:child_process";
import { CeoError } from "./errors.js";
import { LIMITS } from "./limits.js";

export interface CommandResult { stdout: string; stderr: string; }

export interface GitCredential {
  username: string;
  token: string;
}

export interface GitCredentialProvider {
  getCredential(): Promise<GitCredential>;
}

export interface GitExecutionConfig {
  gitAuthorName: string;
  gitAuthorEmail: string;
  gitCommitterName: string;
  gitCommitterEmail: string;
  sshKeyPath?: string | null;
  knownHostsPath?: string | null;
  credentialProvider?: GitCredentialProvider | null;
}

export interface WorkspaceConfig extends GitExecutionConfig {
  dataRoot: string;
  repoDir: string;
  txnDir: string;
  stateDir: string;
  remoteUrl: string;
  branch: string;
}

export function redactSecrets(text: string, secrets: Array<string | undefined | null> = []): string {
  if (!text) return "";
  let cleaned = String(text);
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      cleaned = cleaned.replaceAll(secret, "[REDACTED]");
    }
  }
  // Generic token pattern redaction as defense in depth
  cleaned = cleaned
    .replace(/ghs_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/ghp_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/token\s+[^\s]+/gi, "token [REDACTED]")
    .replace(/https:\/\/[^@/\s]+@/g, "https://[REDACTED]@");
  return cleaned;
}

export function validateGitAuthMode(config: GitExecutionConfig): void {
  const hasSshKey = Boolean(config.sshKeyPath);
  const hasKnownHosts = Boolean(config.knownHostsPath);
  const hasSsh = hasSshKey || hasKnownHosts;
  const hasCredentialProvider = Boolean(config.credentialProvider);

  if (hasSsh && hasCredentialProvider) {
    throw new Error("Git configuration error: sshKeyPath and credentialProvider are mutually exclusive.");
  }

  if ((hasSshKey && !hasKnownHosts) || (!hasSshKey && hasKnownHosts)) {
    throw new Error(
      "Git configuration error: sshKeyPath and knownHostsPath must both be provided for SSH authentication.",
    );
  }
}

function gitPrefix(config: GitExecutionConfig, credential?: GitCredential): string[] {
  const prefix = [
    "-c",
    "core.quotepath=false",
    "-c",
    "core.whitespace=-trailing-space,-blank-at-eol,-blank-at-eof",
  ];

  if (config.sshKeyPath && config.knownHostsPath) {
    const command = [
      "ssh",
      "-i", config.sshKeyPath,
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${config.knownHostsPath}`,
    ].join(" ");
    prefix.push("-c", `core.sshCommand=${command}`);
    return prefix;
  }

  if (credential) {
    prefix.push(
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=!f() { echo "username=${credential.username}"; echo "password=$CEO_GIT_TOKEN"; }; f`,
    );
  }

  return prefix;
}

export async function runGit(
  config: GitExecutionConfig,
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<CommandResult> {
  validateGitAuthMode(config);

  let credential: GitCredential | undefined;
  if (config.credentialProvider) {
    credential = await config.credentialProvider.getCredential();
  }

  const prefix = gitPrefix(config, credential);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: config.gitAuthorName,
    GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
    GIT_COMMITTER_NAME: config.gitCommitterName,
    GIT_COMMITTER_EMAIL: config.gitCommitterEmail,
  };

  if (credential?.token) {
    env.CEO_GIT_TOKEN = credential.token;
  }

  return await new Promise((resolve, reject) => {
    const child = spawn("git", [...prefix, ...args], {
      cwd,
      shell: false,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      const sanitized = redactSecrets(err.message, [credential?.token]);
      reject(new Error(sanitized));
    });
    child.on("close", (code) => {
      const safeStdout = redactSecrets(stdout.trimEnd(), [credential?.token]);
      const safeStderr = redactSecrets(stderr.trimEnd(), [credential?.token]);
      if (code === 0 || allowFailure) {
        resolve({ stdout: safeStdout, stderr: safeStderr });
      } else {
        const commandName = redactSecrets(args[0] ?? "command", [credential?.token]);
        const details = safeStderr || safeStdout;
        const rawErrorMsg = details
          ? `git ${commandName} failed with exit code ${code}: ${details}`
          : `git ${commandName} failed with exit code ${code}`;
        const errorMsg = redactSecrets(rawErrorMsg, [credential?.token]);
        reject(new Error(errorMsg));
      }
    });
  });
}

export async function resolveRef(config: GitExecutionConfig, cwd: string, ref: string): Promise<string> {
  return (await runGit(config, cwd, ["rev-parse", "--verify", ref])).stdout;
}

export async function blobOid(config: GitExecutionConfig, cwd: string, ref: string, filePath: string): Promise<string | null> {
  const result = await runGit(config, cwd, ["ls-tree", ref, "--", filePath], true);
  if (!result.stdout) return null;
  const match = result.stdout.match(/^\d+\s+blob\s+([0-9a-f]{40,64})\t/);
  return match?.[1] ?? null;
}

export async function assertExpectedBlob(
  config: GitExecutionConfig,
  cwd: string,
  ref: string,
  filePath: string,
  expected: string,
): Promise<void> {
  const actual = await blobOid(config, cwd, ref, filePath);
  if (actual !== expected) {
    throw new CeoError("BLOB_MISMATCH", "The file changed since it was read.", {
      path: filePath,
      expected_blob_oid: expected,
      actual_blob_oid: actual,
    });
  }
}

export interface CommandResultBuffer {
  stdout: Buffer;
  stderr: string;
}

export async function runGitBuffer(
  config: GitExecutionConfig,
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<CommandResultBuffer> {
  validateGitAuthMode(config);

  let credential: GitCredential | undefined;
  if (config.credentialProvider) {
    credential = await config.credentialProvider.getCredential();
  }

  const prefix = gitPrefix(config, credential);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: config.gitAuthorName,
    GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
    GIT_COMMITTER_NAME: config.gitCommitterName,
    GIT_COMMITTER_EMAIL: config.gitCommitterEmail,
  };

  if (credential?.token) {
    env.CEO_GIT_TOKEN = credential.token;
  }

  return await new Promise((resolve, reject) => {
    const child = spawn("git", [...prefix, ...args], {
      cwd,
      shell: false,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      const sanitized = redactSecrets(err.message, [credential?.token]);
      reject(new Error(sanitized));
    });
    child.on("close", (code) => {
      const stdoutBuf = Buffer.concat(stdoutChunks);
      const safeStderr = redactSecrets(stderr.trimEnd(), [credential?.token]);
      if (code === 0 || allowFailure) {
        resolve({ stdout: stdoutBuf, stderr: safeStderr });
      } else {
        const commandName = redactSecrets(args[0] ?? "command", [credential?.token]);
        const details = safeStderr || redactSecrets(stdoutBuf.toString("utf8", 0, 1000).trimEnd(), [credential?.token]);
        const rawErrorMsg = details
          ? `git ${commandName} failed with exit code ${code}: ${details}`
          : `git ${commandName} failed with exit code ${code}`;
        const errorMsg = redactSecrets(rawErrorMsg, [credential?.token]);
        reject(new Error(errorMsg));
      }
    });
  });
}

export interface GitTreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  oid: string;
  bytes?: number;
  path: string;
}

export function parseLsTreeLine(line: string): GitTreeEntry | null {
  const match = line.match(/^([0-7]+)\s+(blob|tree|commit)\s+([0-9a-f]{40,64})\s+([0-9]+|-)\t([\s\S]+)$/);
  if (!match) return null;
  return {
    mode: match[1]!,
    type: match[2] as "blob" | "tree" | "commit",
    oid: match[3]!,
    bytes: match[4] !== "-" ? Number(match[4]) : undefined,
    path: match[5]!,
  };
}

export async function getTreeEntry(
  config: GitExecutionConfig,
  cwd: string,
  commit: string,
  relativePath: string,
): Promise<GitTreeEntry | null> {
  const result = await runGit(config, cwd, ["ls-tree", "-l", "-z", commit, "--", relativePath], true);
  if (!result.stdout) return null;
  for (const part of result.stdout.split("\0")) {
    if (!part) continue;
    const entry = parseLsTreeLine(part);
    if (entry && entry.path === relativePath) {
      return entry;
    }
  }
  return null;
}

export async function listTreeEntries(
  config: GitExecutionConfig,
  cwd: string,
  commit: string,
  prefix?: string,
): Promise<GitTreeEntry[]> {
  const args = ["ls-tree", "-r", "-l", "-z", commit];
  if (prefix) {
    args.push("--", prefix);
  }
  const result = await runGit(config, cwd, args, true);
  if (!result.stdout) return [];
  const entries: GitTreeEntry[] = [];
  for (const part of result.stdout.split("\0")) {
    if (!part) continue;
    const entry = parseLsTreeLine(part);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

export async function readBlobUtf8(
  config: GitExecutionConfig,
  cwd: string,
  oid: string,
  displayPath?: string,
): Promise<string> {
  const result = await runGitBuffer(config, cwd, ["cat-file", "blob", oid]);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    throw new CeoError("VALIDATION_FAILED", "CEO content must be valid UTF-8.", {
      path: displayPath ?? oid,
    });
  }
}

export async function readFileAtCommit(
  config: GitExecutionConfig,
  cwd: string,
  commit: string,
  relativePath: string,
): Promise<{ path: string; blob_oid: string; bytes: number; content: string } | null> {
  const entry = await getTreeEntry(config, cwd, commit, relativePath);
  if (!entry) return null;
  if (entry.mode === "120000") {
    throw new CeoError("INVALID_PATH", "Symlinks are forbidden in CEO content paths.", { path: relativePath });
  }
  if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
    throw new CeoError("INVALID_PATH", "Requested path is not a regular file.", { path: relativePath });
  }
  if (entry.bytes !== undefined && entry.bytes > LIMITS.maxFileWriteBytes) {
    throw new CeoError(
      "VALIDATION_FAILED",
      `File size (${Math.round(entry.bytes / 1024)} KiB) exceeds max single-file limit (${Math.round(LIMITS.maxFileWriteBytes / (1024 * 1024))} MiB).`,
      { path: relativePath },
    );
  }
  const content = await readBlobUtf8(config, cwd, entry.oid, relativePath);
  return {
    path: relativePath,
    blob_oid: entry.oid,
    bytes: entry.bytes ?? Buffer.byteLength(content, "utf8"),
    content,
  };
}

