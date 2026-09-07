import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { fixture } from "./helpers.js";
import { CeoWorkspace } from "../src/workspace.js";
import { runGit } from "../src/git.js";
import { randomUUID } from "node:crypto";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Git Identity Attribution", () => {
  it("creates commit with user as Author and CEO State MCP as Committer", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);

    item.config.gitAuthorName = "Xinghan Xu";
    item.config.gitAuthorEmail = "user@example.com";
    item.config.gitCommitterName = "CEO State MCP";
    item.config.gitCommitterEmail = "ceo-mcp@users.noreply.github.com";

    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const status = await workspace.workspaceStatus();
    const result = await workspace.applyChangeSet({
      request_id: randomUUID(),
      base_commit: status.local_commit,
      summary: "Add attributed task",
      operations: [
        {
          op: "create",
          path: "tasks/IDENTITY-001.md",
          content: "# Attribution Test\n",
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.commit).toBeTruthy();

    const showOutput = await runGit(item.config, item.config.repoDir, [
      "show",
      "-s",
      "--format=%an%n%ae%n%cn%n%ce",
      result.commit,
    ]);

    const [authorName, authorEmail, committerName, committerEmail] = showOutput.stdout.split("\n");
    expect(authorName).toBe("Xinghan Xu");
    expect(authorEmail).toBe("user@example.com");
    expect(committerName).toBe("CEO State MCP");
    expect(committerEmail).toBe("ceo-mcp@users.noreply.github.com");
  });

  it("creates commit with CEO State MCP as both Author and Committer when unconfigured", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);

    // Explicitly set default CEO identity
    item.config.gitAuthorName = "CEO State MCP";
    item.config.gitAuthorEmail = "ceo-mcp@users.noreply.github.com";
    item.config.gitCommitterName = "CEO State MCP";
    item.config.gitCommitterEmail = "ceo-mcp@users.noreply.github.com";

    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const status = await workspace.workspaceStatus();
    const result = await workspace.applyChangeSet({
      request_id: randomUUID(),
      base_commit: status.local_commit,
      summary: "Add default task",
      operations: [
        {
          op: "create",
          path: "tasks/DEFAULT-001.md",
          content: "# Default Test\n",
        },
      ],
    });

    expect(result.ok).toBe(true);

    const showOutput = await runGit(item.config, item.config.repoDir, [
      "show",
      "-s",
      "--format=%an%n%ae%n%cn%n%ce",
      result.commit,
    ]);

    const [authorName, authorEmail, committerName, committerEmail] = showOutput.stdout.split("\n");
    expect(authorName).toBe("CEO State MCP");
    expect(authorEmail).toBe("ceo-mcp@users.noreply.github.com");
    expect(committerName).toBe("CEO State MCP");
    expect(committerEmail).toBe("ceo-mcp@users.noreply.github.com");
  });
});
