import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { fixture, git } from "./helpers.js";
import { CeoWorkspace } from "../src/workspace.js";
import { loadProductPolicy } from "../src/product-policy.js";
import { createMcpServer } from "../src/mcp.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Rule Precedence Contract", () => {
  it("verifies contract availability: divergent workspace rule overrides runtime default", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);

    // Seed a divergent workspace rule: rules/tasks.md
    const seedRulesDir = path.join(item.root, "seed", "rules");
    await mkdir(seedRulesDir, { recursive: true });
    const divergentContent = "# Custom Tasks Rule\n\nExplicit workspace override: all tasks require status [URGENT].\n";
    await writeFile(path.join(seedRulesDir, "tasks.md"), divergentContent);
    git(path.join(item.root, "seed"), "add", "-A");
    git(path.join(item.root, "seed"), "commit", "-m", "add divergent workspace rule");
    git(path.join(item.root, "seed"), "push", "origin", "main");

    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();

    const mcpHandler = createMcpHandler(() => createMcpServer(workspace, policy), { legacy: "reject" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => mcpHandler.fetch(new Request(url, init)),
    });

    const client = new Client(
      { name: "precedence-test-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);

    // 1. Workspace rule is available and readable via read_files
    const readRes = await client.callTool({
      name: "read_files",
      arguments: { paths: ["rules/tasks.md"] },
    });
    expect(readRes.isError).toBeFalsy();
    const readStructured = readRes.structuredContent as { files: Array<{ path: string; content: string }> };
    expect(readStructured.files).toHaveLength(1);
    expect(readStructured.files[0]!.path).toBe("rules/tasks.md");
    expect(readStructured.files[0]!.content).toBe(divergentContent);

    // 2. Runtime default policy is available via policy_read and clearly differs from the workspace override
    const policyRes = await client.callTool({
      name: "policy_read",
      arguments: { name: "tasks" },
    });
    expect(policyRes.isError).toBeFalsy();
    const policyStructured = policyRes.structuredContent as { name: string; status: string; content: string };
    expect(policyStructured.name).toBe("tasks");
    expect(policyStructured.status).toBe("FOUND");
    expect(policyStructured.content).not.toBe(divergentContent);
    expect(policyStructured.content).toContain("# Task Rule");

    // 3. Verify bootstrap explicitly documents the precedence hierarchy:
    // Workspace rule > Runtime default policy
    expect(policy.bootstrap).toContain("Workspace rule");
    expect(policy.bootstrap).toContain("Runtime default policy");
    const workspaceRuleIndex = policy.bootstrap.indexOf("Workspace rule");
    const runtimeDefaultIndex = policy.bootstrap.indexOf("Runtime default policy");
    expect(workspaceRuleIndex).toBeGreaterThan(-1);
    expect(runtimeDefaultIndex).toBeGreaterThan(workspaceRuleIndex);
  });
});
