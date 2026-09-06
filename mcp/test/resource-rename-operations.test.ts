import { rm, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CeoWorkspace } from "../src/workspace.js";
import { ResourceService } from "../src/resource/service.js";
import { ResourceRetrievalService } from "../src/resource/retrieval.js";
import { fixture } from "./helpers.js";
import { parseMetaMarkdown } from "../src/resource/meta.js";
import type { UrlMetadataResolver, ResolveOutcome } from "../src/resource/resolver-client.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class MockResolver implements UrlMetadataResolver {
  public customHandler?: (url: string) => Promise<ResolveOutcome> | ResolveOutcome;

  async resolve(url: string): Promise<ResolveOutcome> {
    if (this.customHandler) {
      return this.customHandler(url);
    }
    return { status: "disabled" };
  }
}

describe("PROJECT-023 Resource Rename Operations & Physical Renaming", () => {
  it("executes rename followed by upsert_summary within the same apply call writing to renamed dir", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);

    const cap = await service.capture({
      source: { type: "file_descriptor", filename: "initial.pdf" },
      display_name: "Original Name",
    });

    const resourceId = (cap.resource as any).resource_id;
    const baseCommit = cap.commit as string;

    const applyRes = await service.apply({
      resource_id: resourceId,
      base_commit: baseCommit,
      summary: "Rename and add summary",
      operations: [
        {
          op: "rename",
          display_name: "Renamed Document",
        },
        {
          op: "upsert_summary",
          provenance: "host_semantic",
          content: "# Summary of Renamed Document\n\nContent here.",
        },
      ],
    });

    expect(applyRes.ok).toBe(true);
    expect(applyRes.renamed).toBe(true);
    expect(applyRes.old_path).toBe("resources/Original Name");
    expect(applyRes.new_path).toBe("resources/Renamed Document");

    const changedFiles = applyRes.changed_files as string[];
    expect(changedFiles).toContain("resources/Renamed Document/meta.md");
    expect(changedFiles).toContain("resources/Renamed Document/summary.md");
    await expect(readFile(path.join(item.config.repoDir, "resources/Original Name/meta.md"))).rejects.toThrow();

    // Verify summary file exists in new directory
    const summaryPath = path.join(item.config.repoDir, "resources/Renamed Document/summary.md");
    const summaryContent = await readFile(summaryPath, "utf8");
    expect(summaryContent).toContain("# Summary of Renamed Document");
  });

  it("executes upsert_summary followed by rename: summary is preserved and moved into new directory", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);

    const cap = await service.capture({
      source: { type: "file_descriptor", filename: "test.pdf" },
      display_name: "Old Directory",
    });

    const resourceId = (cap.resource as any).resource_id;
    const baseCommit = cap.commit as string;

    const applyRes = await service.apply({
      resource_id: resourceId,
      base_commit: baseCommit,
      summary: "Add summary then rename",
      operations: [
        {
          op: "upsert_summary",
          provenance: "host_semantic",
          content: "# Summary created before rename",
        },
        {
          op: "rename",
          display_name: "New Directory",
        },
      ],
    });

    expect(applyRes.ok).toBe(true);
    expect(applyRes.renamed).toBe(true);
    expect(applyRes.new_path).toBe("resources/New Directory");

    const summaryPath = path.join(item.config.repoDir, "resources/New Directory/summary.md");
    const summaryContent = await readFile(summaryPath, "utf8");
    expect(summaryContent).toContain("# Summary created before rename");
  });

  it("repeated rename to the same display name returns renamed: false and avoids collision suffix", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);

    const cap = await service.capture({
      source: { type: "file_descriptor", filename: "doc.pdf" },
      display_name: "Stable Label",
    });

    const resourceId = (cap.resource as any).resource_id;
    let baseCommit = cap.commit as string;

    // Apply rename to the same label
    const applyRes = await service.apply({
      resource_id: resourceId,
      base_commit: baseCommit,
      summary: "No-op rename",
      operations: [
        {
          op: "rename",
          display_name: "Stable Label",
        },
        {
          op: "patch_topics",
          add: ["verified"],
        },
      ],
    });

    expect(applyRes.ok).toBe(true);
    expect(applyRes.renamed).toBe(false);
    expect(applyRes.old_path).toBe("resources/Stable Label");
    expect(applyRes.new_path).toBe("resources/Stable Label");

    const changedFiles = applyRes.changed_files as string[];
    expect(changedFiles).toContain("resources/Stable Label/meta.md");
    // No Stable Label-2 created!
    expect(changedFiles.some((f) => f.includes("Stable Label-2"))).toBe(false);
  });

  it("rename colliding with an existing resource directory allocates -2 suffix", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);

    // Create resource 1 with "Target Name"
    await service.capture({
      source: { type: "file_descriptor", filename: "doc1.pdf" },
      display_name: "Target Name",
    });

    // Create resource 2 with "Other Name"
    const cap2 = await service.capture({
      source: { type: "file_descriptor", filename: "doc2.pdf" },
      display_name: "Other Name",
    });

    const resourceId2 = (cap2.resource as any).resource_id;
    const baseCommit2 = cap2.commit as string;

    // Rename resource 2 to "Target Name" (collides with resource 1)
    const applyRes = await service.apply({
      resource_id: resourceId2,
      base_commit: baseCommit2,
      summary: "Rename resource 2 to colliding Target Name",
      operations: [
        {
          op: "rename",
          display_name: "Target Name",
        },
      ],
    });

    expect(applyRes.ok).toBe(true);
    expect(applyRes.renamed).toBe(true);
    expect(applyRes.new_path).toBe("resources/Target Name-2");
    expect((applyRes.resource as any).display_name).toBe("Target Name");
  });

  it("source asset remains readable after directory rename", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);
    const retrieval = new ResourceRetrievalService(workspace, item.config);

    const pdfBuffer = Buffer.from("%PDF-1.4 sample content", "utf8");
    const cap = await service.capture({
      source: {
        type: "file_inline",
        filename: "invoice.pdf",
        mime_type: "application/pdf",
        data_base64: pdfBuffer.toString("base64"),
      },
      display_name: "Original Invoice",
    });

    const resourceId = (cap.resource as any).resource_id;
    const baseCommit = cap.commit as string;

    // Rename
    const applyRes = await service.apply({
      resource_id: resourceId,
      base_commit: baseCommit,
      summary: "Rename invoice",
      operations: [
        {
          op: "rename",
          display_name: "Archived 2026 Invoice",
        },
      ],
    });

    expect(applyRes.renamed).toBe(true);

    // Read source via retrieval service
    const sourceView = await retrieval.get({ resource_id: resourceId, view: "source" });
    expect(sourceView.available).toBe(true);
    expect(sourceView.asset_ref).toBe("source/original.pdf");
    expect(sourceView.relative_path).toBe("resources/Archived 2026 Invoice");

    // Read stored binary asset on disk at new renamed path
    const diskAsset = await readFile(path.join(item.config.repoDir, sourceView.relative_path as string, sourceView.asset_ref as string));
    expect(diskAsset.toString("base64")).toBe(pdfBuffer.toString("base64"));
  });

  it("fallback naming automatically upgrades on revisit when resolver provides title", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();
    // First attempt: resolver is unavailable (no title available)
    mockResolver.customHandler = () => ({
      status: "unavailable",
      code: "timeout",
      attempted_at: "2026-09-06T10:00:00.000Z",
      fields_resolved: [],
      latency_ms: 10,
    });

    const service = new ResourceService(workspace, item.config, mockResolver);

    // Initial capture with no display_name: falls back to deterministic fallback
    const cap1 = await service.capture({
      source: { type: "url", url: "https://www.youtube.com/watch?v=upgrade123" },
    });

    const resource1 = cap1.resource as any;
    expect(resource1.naming_source).toBe("fallback");
    expect(resource1.display_name).toBe("upgrade123");
    expect(resource1.relative_path).toBe("resources/upgrade123");

    // Check meta.md on disk
    const metaPath1 = path.join(item.config.repoDir, "resources/upgrade123/meta.md");
    const doc1 = parseMetaMarkdown(await readFile(metaPath1, "utf8"));
    expect(doc1.meta.naming_source).toBe("fallback");

    // Second attempt: resolver now resolves successfully with title
    mockResolver.customHandler = () => ({
      status: "resolved",
      attempted_at: "2026-09-06T10:05:00.000Z",
      fields_resolved: ["title", "source_id"],
      metadata: {
        schema_version: 1,
        source_type: "youtube",
        source_url: "https://www.youtube.com/watch?v=upgrade123",
        source_id: "upgrade123",
        title: "Deep Learning Breakthrough 2026",
        captured_at: "2026-09-06T10:05:00.000Z",
      },
      diagnostics: {
        strategy: "youtube_oembed",
        fetch_status: "ok",
      },
      latency_ms: 10,
    });

    const cap2 = await service.capture({
      source: { type: "url", url: "https://www.youtube.com/watch?v=upgrade123" },
    });

    const resource2 = cap2.resource as any;
    expect(resource2.is_revisit).toBe(true);
    // Automatic upgrade because naming_source was "fallback"
    expect(resource2.naming_source).toBe("title");
    expect(resource2.display_name).toBe("Deep Learning Breakthrough 2026");
    expect(resource2.relative_path).toBe("resources/Deep Learning Breakthrough 2026");

    // Verify old directory is gone and new directory has meta.md
    const newMetaPath = path.join(item.config.repoDir, "resources/Deep Learning Breakthrough 2026/meta.md");
    const doc2 = parseMetaMarkdown(await readFile(newMetaPath, "utf8"));
    expect(doc2.meta.naming_source).toBe("title");
    expect(doc2.meta.display_name).toBe("Deep Learning Breakthrough 2026");
    expect(doc2.meta.title).toBe("Deep Learning Breakthrough 2026");
  });
});
