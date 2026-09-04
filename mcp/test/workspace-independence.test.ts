import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CeoWorkspace } from "../src/workspace.js";
import type { Config } from "../src/config.js";

const exec = promisify(execFile);
const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createFictionalWorkspaceFixture(): Promise<{ config: Config; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ceo-independence-test-"));
  cleanupDirs.push(root);

  const remote = path.join(root, "remote.git");
  const local = path.join(root, "local");
  const initDir = path.join(root, "init");

  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["clone", remote, initDir]);

  await writeFile(
    path.join(initDir, "README.md"),
    "# CEO POC Workspace\n\nFictional user workspace used only for CEO State MCP testing.\n",
    "utf8",
  );

  await mkdir(path.join(initDir, "records"), { recursive: true });
  await writeFile(
    path.join(initDir, "records", "profile.md"),
    "# Profile\n\n- Preferred name: Ada\n- Home city: Kingston, Ontario\n",
    "utf8",
  );

  await mkdir(path.join(initDir, "context"), { recursive: true });
  await writeFile(
    path.join(initDir, "context", "preferences.md"),
    "# Preferences\n\n- Ada prefers concise, step-by-step plans.\n- Ada prefers simple solutions before adding abstractions.\n",
    "utf8",
  );

  await mkdir(path.join(initDir, "tasks"), { recursive: true });
  await writeFile(
    path.join(initDir, "tasks", "TASK-001-home-server.md"),
    "# TASK-001 — Home Server\n\n- Status: ACTIVE\n\n## Goal\n\nSet up a small home server.\n\n## Current State\n\nHardware is available. The operating system has not been chosen.\n\n## Next\n\nChoose the operating system.\n",
    "utf8",
  );

  await writeFile(
    path.join(initDir, "JOURNAL.md"),
    "# Journal\n\n## 2026-09-01\n\nAda started planning a small home server.\n",
    "utf8",
  );

  await exec("git", ["-C", initDir, "config", "user.name", "Test User"]);
  await exec("git", ["-C", initDir, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", initDir, "add", "."]);
  await exec("git", ["-C", initDir, "commit", "-m", "Initial fictional commit"]);
  await exec("git", ["-C", initDir, "branch", "-M", "main"]);
  await exec("git", ["-C", initDir, "push", "origin", "main"]);

  const dataRoot = path.join(root, "data");
  await mkdir(dataRoot, { recursive: true });

  const config: Config = {
    dataRoot,
    repoDir: path.join(dataRoot, "repo"),
    txnDir: path.join(dataRoot, "txns"),
    stateDir: path.join(dataRoot, "state"),
    branch: "main",
    remoteUrl: remote,
    port: 3000,
    bindHost: "127.0.0.1",
    gitAuthorName: "Test User",
    gitAuthorEmail: "test@example.com",
    mcpApiKey: undefined,
    allowedHosts: ["localhost", "127.0.0.1"],
    allowedOrigins: ["http://localhost"],
  };

  return { config, root };
}

describe("Workspace Independence (Zero SYSTEM.md in User Workspace)", () => {
  it("initializes to READY and executes all operations without SYSTEM.md", async () => {
    const { config } = await createFictionalWorkspaceFixture();
    const workspace = new CeoWorkspace(config);
    await workspace.initialize();

    // 1. Verify readiness
    expect(workspace.readiness).toBe("READY");
    const status = await workspace.workspaceStatus();
    expect(status.ok).toBe(true);
    expect(status.workspace_state).toBe("READY");

    // 2. list_files: finds user files, zero SYSTEM.md
    const files = await workspace.listFiles("", 50);
    const filePaths = files.files.map((f) => f.path);
    expect(filePaths).toContain("README.md");
    expect(filePaths).toContain("records/profile.md");
    expect(filePaths).toContain("context/preferences.md");
    expect(filePaths).toContain("tasks/TASK-001-home-server.md");
    expect(filePaths).toContain("JOURNAL.md");
    expect(filePaths).not.toContain("SYSTEM.md");

    // 3. read_files: reads user profile
    const readProfile = await workspace.readFiles(["records/profile.md"]);
    expect(readProfile.files[0].content).toContain("Preferred name: Ada");
    expect(readProfile.files[0].content).toContain("Home city: Kingston, Ontario");
    const baseCommit = readProfile.base_commit;
    const taskPath = "tasks/TASK-001-home-server.md";

    // 4. search_text: finds home server mentions
    const searchRes = await workspace.searchText("home server", [], 50);
    expect(searchRes.matches.length).toBeGreaterThanOrEqual(1);

    // 5. apply_change_set: durable state write persists
    const readTask = await workspace.readFiles([taskPath]);
    const updatedContent = `# TASK-001 — Home Server

- Status: ACTIVE

## Goal

Set up a small home server.

## Current State

Hardware is available. Operating system chosen: Ubuntu.

## Next

Install Ubuntu Server.
`;

    const changeResult = await workspace.applyChangeSet({
      base_commit: readTask.base_commit,
      summary: "Choose Ubuntu as home server OS",
      operations: [
        {
          op: "replace",
          path: taskPath,
          expected_blob_oid: (readTask.files as any[])[0].blob_oid,
          content: updatedContent,
        },
      ],
    });

    expect(changeResult.ok).toBe(true);
    expect(changeResult.commit).toMatch(/^[0-9a-f]{40,64}$/);

    // 6. Verify persistence across subsequent reads
    const reRead = await workspace.readFiles([taskPath]);
    expect(reRead.files[0].content).toContain("Operating system chosen: Ubuntu.");
  });
});
