import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Config } from "../src/config.js";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

export async function fixture(): Promise<{ root: string; remote: string; config: Config }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ceo-mcp-test-"));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const dataRoot = path.join(root, "data");
  await mkdir(remote);
  git(remote, "init", "--bare", "--initial-branch=main");
  await mkdir(seed);
  git(seed, "init", "--initial-branch=main");
  await mkdir(path.join(seed, "tasks"));
  await mkdir(path.join(seed, "inbox"));
  await writeFile(path.join(seed, "TODO.md"), "# TODO\n\n- Original\n");
  await writeFile(path.join(seed, "SYSTEM.md"), "# System\n");
  await writeFile(path.join(seed, "JOURNAL.md"), "# Journal\n");
  await writeFile(path.join(seed, "tasks", "TEST-001.md"), "# TEST-001\n");
  await writeFile(path.join(seed, "inbox", "测试文章.md"), "# 测试文章\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "seed");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  const config: Config = {
    dataRoot,
    repoDir: path.join(dataRoot, "repo"),
    txnDir: path.join(dataRoot, "txns"),
    stateDir: path.join(dataRoot, "state"),
    branch: "main",
    remoteUrl: remote,
    port: 3000,
    bindHost: "127.0.0.1",
    gitAuthorName: "CEO State MCP Test",
    gitAuthorEmail: "ceo-test@example.com",
    mcpApiKey: undefined,
    allowedHosts: ["localhost", "127.0.0.1"],
    allowedOrigins: [],
    auditDir: path.join(dataRoot, "audit"),
    auditDbPath: path.join(dataRoot, "audit", "ceo-trace.sqlite"),
  };
  return { root, remote, config };
}
