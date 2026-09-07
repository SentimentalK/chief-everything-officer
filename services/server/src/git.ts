import { spawn } from "node:child_process";
import type { Config } from "./config.js";
import { CeoError } from "./errors.js";

export interface CommandResult { stdout: string; stderr: string; }

function gitPrefix(config: Config): string[] {
  const prefix = ["-c", "core.quotepath=false"];
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

export async function runGit(config: Config, cwd: string, args: string[], allowFailure = false): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", [...gitPrefix(config), ...args], {
      cwd,
      shell: false,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: config.gitAuthorName,
        GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
        GIT_COMMITTER_NAME: config.gitCommitterName,
        GIT_COMMITTER_EMAIL: config.gitCommitterEmail,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || allowFailure) resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
      else reject(new Error(`git ${args[0] ?? "command"} failed with exit code ${code}`));
    });
  });
}

export async function resolveRef(config: Config, cwd: string, ref: string): Promise<string> {
  return (await runGit(config, cwd, ["rev-parse", "--verify", ref])).stdout;
}

export async function blobOid(config: Config, cwd: string, ref: string, filePath: string): Promise<string | null> {
  const result = await runGit(config, cwd, ["ls-tree", ref, "--", filePath], true);
  if (!result.stdout) return null;
  const match = result.stdout.match(/^\d+\s+blob\s+([0-9a-f]{40,64})\t/);
  return match?.[1] ?? null;
}

export async function assertExpectedBlob(
  config: Config,
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
