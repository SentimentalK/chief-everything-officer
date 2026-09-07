import { rm, mkdir, writeFile, unlink, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { CeoWorkspace } from "../src/workspace.js";
import { createMcpServer } from "../src/mcp.js";
import { loadProductPolicy } from "../src/product-policy.js";
import { runGit } from "../src/git.js";
import { AuditStore } from "../src/audit.js";
import { fixture } from "./helpers.js";

const cleanupDirs: string[] = [];
const closeables: Array<{ close(): Promise<void> | void }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Resource State Isolation, Policy, and Audit Sanitization", () => {
  it("default search_text includes Resource interactions but isolates meta/summary/content/evidence; scoped search and root listing preserved", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();
    const server = createMcpServer(workspace, policy);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const META_KW = "META_ONLY_KEYWORD_XYZ";
    const SUMMARY_KW = "SUMMARY_ONLY_KEYWORD_XYZ";
    const CONTENT_KW = "CONTENT_ONLY_KEYWORD_XYZ";
    const EVIDENCE_KW = "EVIDENCE_ONLY_KEYWORD_XYZ";
    const INTERACTION_KW = "INTERACTION_ONLY_KEYWORD_XYZ";

    // 1. Capture one resource with a unique keyword in every artifact kind.
    await client.callTool({
      name: "resource_capture",
      arguments: {
        source: { type: "file_descriptor", filename: "seed.pdf" },
        note: META_KW,
        topics: ["testing"],
        initial_operations: [
          {
            op: "upsert_summary",
            provenance: "host_semantic",
            basis: "source_content",
            content: `# Exclusive Summary\n\n${SUMMARY_KW}\n`,
          },
          {
            op: "upsert_content",
            provenance: "host_exact",
            content: `# Body\n\n${CONTENT_KW}\n`,
          },
          {
            op: "upsert_evidence",
            provenance: "host_exact",
            content: `# Evidence\n\n${EVIDENCE_KW}\n`,
          },
          {
            op: "append_interaction",
            provenance: "host_exact",
            entry: `User asked about this. ${INTERACTION_KW}`,
          },
        ],
      },
    });

    // 2. Default (prefixes omitted) search_text hits interactions.md only.
    const withoutPrefix = await client.callTool({
      name: "search_text",
      arguments: { query: INTERACTION_KW },
    });
    const interactionMatches = (withoutPrefix.structuredContent as any).matches;
    expect(interactionMatches).toHaveLength(1);
    expect(interactionMatches[0].path).toMatch(/^resources\/[^/]+\/interactions\.md$/);

    // 2b. Omitting prefixes is identical to an explicit empty prefix array at the
    // MCP tool boundary (the schema default collapses the two to one code path).
    const withEmptyPrefixes = await client.callTool({
      name: "search_text",
      arguments: { query: INTERACTION_KW, prefixes: [] },
    });
    expect((withEmptyPrefixes.structuredContent as any).matches).toEqual(interactionMatches);

    // 3. meta/summary/content/evidence stay OUT of the default scope.
    for (const kw of [META_KW, SUMMARY_KW, CONTENT_KW, EVIDENCE_KW]) {
      const res = await client.callTool({ name: "search_text", arguments: { query: kw } });
      expect((res.structuredContent as any).matches).toHaveLength(0);
    }

    // 4. Ordinary State Markdown is still searched by default (seed TODO.md).
    const stateSearch = await client.callTool({ name: "search_text", arguments: { query: "Original" } });
    const stateMatches = (stateSearch.structuredContent as any).matches;
    expect(stateMatches.length).toBeGreaterThan(0);
    expect(stateMatches.every((m: { path: string }) => !m.path.startsWith("resources/"))).toBe(true);

    // 5. Scoped search with prefixes=["resources/"] still reaches Resource artifacts.
    const scopedSummary = await client.callTool({
      name: "search_text",
      arguments: { query: SUMMARY_KW, prefixes: ["resources/"] },
    });
    const summaryMatches = (scopedSummary.structuredContent as any).matches;
    expect(summaryMatches).toHaveLength(1);
    expect(summaryMatches[0].path).toMatch(/^resources\/[^/]+\/summary\.md$/);

    const scopedMeta = await client.callTool({
      name: "search_text",
      arguments: { query: META_KW, prefixes: ["resources/"] },
    });
    const metaMatches = (scopedMeta.structuredContent as any).matches;
    // The capture note lands in both frontmatter and body, so meta.md may match
    // on more than one line — but every hit must be the single resource meta.md.
    expect(metaMatches.length).toBeGreaterThan(0);
    expect(metaMatches.every((m: { path: string }) => m.path.match(/^resources\/[^/]+\/meta\.md$/))).toBe(true);
    expect(new Set(metaMatches.map((m: { path: string }) => m.path)).size).toBe(1);

    // 6. list_files at root still discovers resources/ directory.
    const listRes = await client.callTool({
      name: "list_files",
      arguments: { prefix: "" },
    });
    const dirs = (listRes.structuredContent as any).directories;
    expect(dirs).toContain("resources/");
  });

  it("default scope excludes source artifacts and nested interactions; scoped search finds source Markdown", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const resDir = "res-22222222-2222-4222-8222-222222222222";
    await mkdir(path.join(item.config.repoDir, "resources", resDir, "source"), { recursive: true });
    await writeFile(
      path.join(item.config.repoDir, "resources", resDir, "interactions.md"),
      "INTERACTION_DEFAULT_HIT_KEYWORD\n",
      "utf8",
    );
    await writeFile(
      path.join(item.config.repoDir, "resources", resDir, "source", "original.md"),
      "SOURCE_MARKDOWN_KEYWORD\n",
      "utf8",
    );
    // Deeper nesting than one resource level must stay out of the default scope.
    await mkdir(path.join(item.config.repoDir, "resources", "a", "b"), { recursive: true });
    await writeFile(
      path.join(item.config.repoDir, "resources", "a", "b", "interactions.md"),
      "NESTED_INTERACTION_KEYWORD\n",
      "utf8",
    );
    await runGit(item.config, item.config.repoDir, ["add", "."]);
    await runGit(item.config, item.config.repoDir, ["commit", "-m", "seed default-scope exclusion files"]);
    await runGit(item.config, item.config.repoDir, ["push", "origin", "main"]);

    const interaction = await workspace.searchText("INTERACTION_DEFAULT_HIT_KEYWORD", [], 10);
    expect((interaction.matches as any[]).map((m) => m.path)).toEqual([`resources/${resDir}/interactions.md`]);

    const sourceUnscoped = await workspace.searchText("SOURCE_MARKDOWN_KEYWORD", [], 10);
    expect(sourceUnscoped.matches).toEqual([]);

    const sourceScoped = await workspace.searchText("SOURCE_MARKDOWN_KEYWORD", ["resources/"], 10);
    expect((sourceScoped.matches as any[]).map((m) => m.path)).toEqual([
      `resources/${resDir}/source/original.md`,
    ]);

    const nested = await workspace.searchText("NESTED_INTERACTION_KEYWORD", [], 10);
    expect(nested.matches).toEqual([]);
  });

  it("default search_text does not bypass .ceoignore for interactions.md", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const resDir = "res-33333333-3333-4333-8333-333333333333";
    await mkdir(path.join(item.config.repoDir, "resources", resDir), { recursive: true });
    await writeFile(
      path.join(item.config.repoDir, "resources", resDir, "interactions.md"),
      "IGNORED_INTERACTION_KEYWORD\n",
      "utf8",
    );
    await writeFile(
      path.join(item.config.repoDir, ".ceoignore"),
      `resources/${resDir}/interactions.md\n`,
      "utf8",
    );
    await runGit(item.config, item.config.repoDir, ["add", "."]);
    await runGit(item.config, item.config.repoDir, ["commit", "-m", "add .ceoignore over interactions"]);
    await runGit(item.config, item.config.repoDir, ["push", "origin", "main"]);

    const res = await workspace.searchText("IGNORED_INTERACTION_KEYWORD", [], 10);
    expect(res.matches).toEqual([]);
  });

  it("default search_text rejects a symlinked interactions.md (no access-control bypass)", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const resDir = "res-44444444-4444-4444-8444-444444444444";
    const interactionsPath = path.join(item.config.repoDir, "resources", resDir, "interactions.md");
    await mkdir(path.join(item.config.repoDir, "resources", resDir), { recursive: true });
    await writeFile(interactionsPath, "REAL_INTERACTION_KEYWORD\n", "utf8");
    await runGit(item.config, item.config.repoDir, ["add", "."]);
    await runGit(item.config, item.config.repoDir, ["commit", "-m", "seed real interactions"]);
    await runGit(item.config, item.config.repoDir, ["push", "origin", "main"]);

    // Swap the tracked interactions.md for a symlink pointing outside the repo.
    const outsideTarget = path.join(item.root, "outside-interactions-target.md");
    await writeFile(outsideTarget, "SYMLINK_BYPASS_KEYWORD\n", "utf8");
    await unlink(interactionsPath);
    await symlink(outsideTarget, interactionsPath);
    await runGit(item.config, item.config.repoDir, ["add", "."]);
    await runGit(item.config, item.config.repoDir, ["commit", "-m", "replace interactions with symlink"]);
    await runGit(item.config, item.config.repoDir, ["push", "origin", "main"]);

    // interactions.md is now in default scope, so assertNoSymlink must fire
    // before any content is read — the search cannot silently follow the link.
    await expect(workspace.searchText("REAL_INTERACTION_KEYWORD", [], 10)).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  });

  it("reads runtime policy for resources via policy_read", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();
    const server = createMcpServer(workspace, policy);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const policyCall = await client.callTool({
      name: "policy_read",
      arguments: { name: "resources" },
    });
    expect(policyCall.isError).toBeFalsy();
    const res = policyCall.structuredContent as any;
    expect(res.ok).toBe(true);
    expect(res.status).toBe("FOUND");
    expect(res.content).toContain("# CEO 资源策略 (Resource Policy)");
    expect(res.content).toContain("Markdown 理解是 V0 的核心");
  });

  it("sanitizes data_base64 from audit log while recording affected paths and commit hash", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const policy = await loadProductPolicy();
    const auditStore = new AuditStore(item.config.auditDbPath);
    closeables.push(auditStore);

    const server = createMcpServer(workspace, policy, auditStore);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const secretBase64 = Buffer.from("%PDF-1.4 SECRET_BASE64_BYTES").toString("base64");

    const captureRes = await client.callTool({
      name: "resource_capture",
      arguments: {
        source: {
          type: "file_inline",
          filename: "private.pdf",
          mime_type: "application/pdf",
          data_base64: secretBase64,
        },
        note: "Audit test",
      },
    });

    expect(captureRes.isError).toBeFalsy();
    const commit = (captureRes.structuredContent as any).commit;
    expect(commit).toBeDefined();

    // Query audit trace
    const traces = auditStore.listSummaries({ limit: 10 });
    const captureTrace = traces.find((t) => t.tool_name === "resource_capture");
    expect(captureTrace).toBeDefined();

    // Verify commit and affected paths
    expect(captureTrace!.resulting_commit).toBe(commit);
    expect(captureTrace!.affected_paths!.some((p: string) => p.includes("meta.md"))).toBe(true);
    expect(captureTrace!.affected_paths!.some((p: string) => p.includes("source/original.pdf"))).toBe(true);

    // Verify secretBase64 is NEVER in audit input_json
    const detail = auditStore.getDetail(captureTrace!.id);
    expect(detail!.input_json).not.toContain(secretBase64);
    expect(detail!.input_json).toContain("[omitted base64 payload:");
  });
});
