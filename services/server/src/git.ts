import { spawn } from "node:child_process";
import { CeoError } from "./errors.js";

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

function gitPrefix(config: GitExecutionConfig, credential?: GitCredential): string[] {
  const prefix = ["-c", "core.quotepath=false"];

  const hasSsh = Boolean(config.sshKeyPath || config.knownHostsPath);
  const hasCredentialProvider = Boolean(config.credentialProvider);
  if (hasSsh && hasCredentialProvider) {
    throw new Error("Git configuration error: sshKeyPath and credentialProvider are mutually exclusive.");
  }

  if (hasSsh) {
    if (!config.sshKeyPath || !config.knownHostsPath) return prefix;
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
        const rawErrorMsg = safeStderr
          ? `git ${commandName} failed with exit code ${code}: ${safeStderr}`
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
