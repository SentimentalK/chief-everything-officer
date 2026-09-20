import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { fixture } from "./helpers.js";
import { CeoWorkspace } from "../src/workspace.js";
import { loadProductPolicy } from "../src/product-policy.js";
import { createMcpServer } from "../src/mcp.js";
import { WORKSPACE_EXTENSION_BANNER } from "../src/policy-resolver.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Rule Precedence Contract — Dynamic Black-Box Lifecycle", () => {
  it("dynamically reflects runtime-only -> extend -> override -> delete through pure MCP operations", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);

    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const productPolicy = await loadProductPolicy();

    const mcpHandler = createMcpHandler(() => createMcpServer(workspace, productPolicy), { legacy: "reject" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => mcpHandler.fetch(new Request(url, init)),
    });

    const client = new Client(
      { name: "precedence-contract-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);

    // 1. Initial State: No workspace rule exists for decision -> policy_read returns runtime only
    const initialPolicyRes = await client.callTool({
      name: "policy_read",
      arguments: { name: "decision" },
    });
    expect(initialPolicyRes.isError).toBeFalsy();
    const initialData = initialPolicyRes.structuredContent as any;
    expect(initialData.ok).toBe(true);
    expect(initialData.name).toBe("decision");
    expect(initialData.status).toBe("FOUND");
    expect(initialData.resolution).toEqual({
      strategy: "runtime_only",
      runtime_policy: true,
      workspace_policy: false,
    });
    const runtimeDecisionContent = initialData.content;
    expect(runtimeDecisionContent).toBeTruthy();

    // Get current base commit from workspace_status
    const statusRes = await client.callTool({ name: "workspace_status" });
    expect(statusRes.isError).toBeFalsy();
    let baseCommit = (statusRes.structuredContent as any).local_commit;

    // 2. CREATE rules/decision.md with mode: extend via apply_change_set
    const extensionBody = "## Custom Decision Dimensions\n\nAll decisions must record trade-off [EXT_12345].";
    const extendRuleContent = `---\nmode: extend\n---\n\n${extensionBody}\n`;

    const createRes = await client.callTool({
      name: "apply_change_set",
      arguments: {
        base_commit: baseCommit,
        summary: "create rules/decision.md with mode: extend",
        operations: [
          {
            op: "create",
            path: "rules/decision.md",
            content: extendRuleContent,
          },
        ],
      },
    });
    expect(createRes.isError).toBeFalsy();
    baseCommit = (createRes.structuredContent as any).commit;

    // Verify policy_read immediately resolves to runtime + extension
    const extendPolicyRes = await client.callTool({
      name: "policy_read",
      arguments: { name: "decision" },
    });
    expect(extendPolicyRes.isError).toBeFalsy();
    const extendData = extendPolicyRes.structuredContent as any;
    expect(extendData.ok).toBe(true);
    expect(extendData.status).toBe("FOUND");
    expect(extendData.resolution).toEqual({
      strategy: "runtime_plus_workspace",
      workspace_mode: "extend",
      runtime_policy: true,
      workspace_policy: true,
    });
    expect(extendData.content).toContain(runtimeDecisionContent);
    expect(extendData.content).toContain(WORKSPACE_EXTENSION_BANNER);
    expect(extendData.content).toContain(extensionBody);
    const runtimeIdx = extendData.content.indexOf(runtimeDecisionContent);
    const extIdx = extendData.content.indexOf(extensionBody);
    expect(runtimeIdx).toBeLessThan(extIdx);

    // 3. REPLACE rules/decision.md with mode: override via apply_change_set
    const readRes1 = await client.callTool({
      name: "read_files",
      arguments: { paths: ["rules/decision.md"] },
    });
    expect(readRes1.isError).toBeFalsy();
    const blobOid1 = (readRes1.structuredContent as any).files[0].blob_oid;

    const overrideBody = "# Custom Decision Rules\n\nEntirely custom decision precedent [OVERRIDE_12345].";
    const overrideRuleContent = `---\nmode: override\n---\n\n${overrideBody}\n`;

    const replaceRes = await client.callTool({
      name: "apply_change_set",
      arguments: {
        base_commit: baseCommit,
        summary: "replace rules/decision.md with mode: override",
        operations: [
          {
            op: "replace",
            path: "rules/decision.md",
            expected_blob_oid: blobOid1,
            content: overrideRuleContent,
          },
        ],
      },
    });
    expect(replaceRes.isError).toBeFalsy();
    baseCommit = (replaceRes.structuredContent as any).commit;

    // Verify policy_read immediately resolves to workspace override only
    const overridePolicyRes = await client.callTool({
      name: "policy_read",
      arguments: { name: "decision" },
    });
    expect(overridePolicyRes.isError).toBeFalsy();
    const overrideData = overridePolicyRes.structuredContent as any;
    expect(overrideData.ok).toBe(true);
    expect(overrideData.status).toBe("FOUND");
    expect(overrideData.content).toBe(overrideBody);
    expect(overrideData.resolution).toEqual({
      strategy: "workspace_only",
      workspace_mode: "override",
      runtime_policy: true,
      workspace_policy: true,
    });
    expect(overrideData.content).not.toContain(runtimeDecisionContent);

    // 4. DELETE rules/decision.md via apply_change_set
    const readRes2 = await client.callTool({
      name: "read_files",
      arguments: { paths: ["rules/decision.md"] },
    });
    expect(readRes2.isError).toBeFalsy();
    const blobOid2 = (readRes2.structuredContent as any).files[0].blob_oid;

    const deleteRes = await client.callTool({
      name: "apply_change_set",
      arguments: {
        base_commit: baseCommit,
        summary: "delete rules/decision.md",
        operations: [
          {
            op: "delete",
            path: "rules/decision.md",
            expected_blob_oid: blobOid2,
          },
        ],
      },
    });
    expect(deleteRes.isError).toBeFalsy();

    // Verify policy_read dynamically reverts to runtime only without stale cache
    const revertedPolicyRes = await client.callTool({
      name: "policy_read",
      arguments: { name: "decision" },
    });
    expect(revertedPolicyRes.isError).toBeFalsy();
    const revertedData = revertedPolicyRes.structuredContent as any;
    expect(revertedData.ok).toBe(true);
    expect(revertedData.status).toBe("FOUND");
    expect(revertedData.content).toBe(runtimeDecisionContent);
    expect(revertedData.resolution).toEqual({
      strategy: "runtime_only",
      runtime_policy: true,
      workspace_policy: false,
    });

    await client.close();
  });

  it("rejects invalid rules/*.md writes at transaction time with VALIDATION_FAILED and maintains atomic cleanliness", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);

    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const productPolicy = await loadProductPolicy();

    const mcpHandler = createMcpHandler(() => createMcpServer(workspace, productPolicy), { legacy: "reject" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => mcpHandler.fetch(new Request(url, init)),
    });

    const client = new Client(
      { name: "rule-validation-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);

    const statusRes = await client.callTool({ name: "workspace_status" });
    const initialBase = (statusRes.structuredContent as any).local_commit;

    // 1. Missing frontmatter
    const missingFmRes = await client.callTool({
      name: "apply_change_set",
      arguments: {
        base_commit: initialBase,
        summary: "create rule with missing frontmatter",
        operations: [{ op: "create", path: "rules/tasks.md", content: "# Tasks Rule\nNo frontmatter\n" }],
      },
    });
    expect(missingFmRes.isError).toBe(true);
    expect((missingFmRes.content[0] as any).text).toContain("VALIDATION_FAILED");
    expect((missingFmRes.content[0] as any).text).toContain("MISSING_FRONTMATTER");

    // 2. Malformed frontmatter delimiters
    const malformedDelimRes = await client.callTool({
      name: "apply_change_set",
      arguments: {
        base_commit: initialBase,
        summary: "create rule with malformed delimiter",
        operations: [{ op: "create", path: "rules/tasks.md", content: "---\nmode: extend\n# Unclosed frontmatter" }],
      },
    });
    expect(malformedDelimRes.isError).toBe(true);
    expect((malformedDelimRes.content[0] as any).text).toContain("VALIDATION_FAILED");
    expect((malformedDelimRes.content[0] as any).text).toContain("MALFORMED_FRONTMATTER_DELIMITER");

    // 3. Malformed YAML
    const malformedYamlRes = await client.callTool({
      name: "apply_change_set",
      arguments: {
        base_commit: initialBase,
        summary: "create rule with malformed yaml",
        operations: [{ op: "create", path: "rules/tasks.md", content: "---\nmode: [unclosed\n---\n\n# Body\n" }],
      },
    });
    expect(malformedYamlRes.isError).toBe(true);
    expect((malformedYamlRes.content[0] as any).text).toContain("VALIDATION_FAILED");
    expect((malformedYamlRes.content[0] as any).text).toContain("MALFORMED_YAML");

    // 4. Unsupported mode
    const unsupportedModeRes = await client.callTool({
      name: "apply_change_set",
      arguments: {
        base_commit: initialBase,
        summary: "create rule with unsupported mode",
        operations: [{ op: "create", path: "rules/tasks.md", content: "---\nmode: merge\n---\n\n# Body\n" }],
      },
    });
    expect(unsupportedModeRes.isError).toBe(true);
    expect((unsupportedModeRes.content[0] as any).text).toContain("VALIDATION_FAILED");
    expect((unsupportedModeRes.content[0] as any).text).toContain("UNSUPPORTED_MODE");

    // 5. Empty body
    const emptyBodyRes = await client.callTool({
      name: "apply_change_set",
      arguments: {
        base_commit: initialBase,
        summary: "create rule with empty body",
        operations: [{ op: "create", path: "rules/tasks.md", content: "---\nmode: extend\n---\n   \n" }],
      },
    });
    expect(emptyBodyRes.isError).toBe(true);
    expect((emptyBodyRes.content[0] as any).text).toContain("VALIDATION_FAILED");
    expect((emptyBodyRes.content[0] as any).text).toContain("EMPTY_POLICY_BODY");

    // Verify atomicity: local_commit unchanged, workspace clean
    const statusAfterFailures = await client.callTool({ name: "workspace_status" });
    expect((statusAfterFailures.structuredContent as any).local_commit).toBe(initialBase);
    expect((statusAfterFailures.structuredContent as any).clean).toBe(true);

    // 6. Valid write with the original base_commit succeeds
    const validRes = await client.callTool({
      name: "apply_change_set",
      arguments: {
        base_commit: initialBase,
        summary: "create valid extend rule",
        operations: [{ op: "create", path: "rules/tasks.md", content: "---\nmode: extend\n---\n\n# Valid Task Rules\n" }],
      },
    });
    expect(validRes.isError).toBeFalsy();
    expect((validRes.structuredContent as any).ok).toBe(true);

    await client.close();
  });

  it("allows normal non-rule Markdown writes without frontmatter to proceed unaffected", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);

    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const productPolicy = await loadProductPolicy();

    const mcpHandler = createMcpHandler(() => createMcpServer(workspace, productPolicy), { legacy: "reject" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => mcpHandler.fetch(new Request(url, init)),
    });

    const client = new Client(
      { name: "normal-write-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);

    const statusRes = await client.callTool({ name: "workspace_status" });
    const baseCommit = (statusRes.structuredContent as any).local_commit;

    // Normal markdown without frontmatter in tasks/ and notes/ must succeed
    const normalRes = await client.callTool({
      name: "apply_change_set",
      arguments: {
        base_commit: baseCommit,
        summary: "create normal markdown without frontmatter",
        operations: [
          {
            op: "create",
            path: "tasks/task-001.md",
            content: "# Just a regular task\n- [ ] do the laundry\n- [x] drink water\n",
          },
          {
            op: "create",
            path: "notes/random.md",
            content: "Plain unformatted note text with no YAML frontmatter whatsoever.\n",
          },
        ],
      },
    });

    expect(normalRes.isError).toBeFalsy();
    expect((normalRes.structuredContent as any).ok).toBe(true);
    expect((normalRes.structuredContent as any).changed_files).toEqual(
      expect.arrayContaining(["tasks/task-001.md", "notes/random.md"]),
    );

    await client.close();
  });
});
