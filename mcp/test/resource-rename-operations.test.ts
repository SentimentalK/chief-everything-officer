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
    });

    const resourceId = (cap.resource as any).resource_id;
    const baseCommit = cap.commit as string;
    expect((cap.resource as any).naming_source).toBe("id");
    expect((cap.resource as any).relative_path).toBe(`resources/${resourceId}`);

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
    expect(applyRes.old_path).toBe(`resources/${resourceId}`);
    expect(applyRes.new_path).toBe("resources/Renamed Document");

    const changedFiles = applyRes.changed_files as string[];
    expect(changedFiles).toContain("resources/Renamed Document/meta.md");
    expect(changedFiles).toContain("resources/Renamed Document/summary.md");
    await expect(readFile(path.join(item.config.repoDir, `resources/${resourceId}/meta.md`))).rejects.toThrow();

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
    expect(applyRes.old_path).toBe(`resources/${resourceId}`);
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
    });

    const resourceId = (cap.resource as any).resource_id;
    let baseCommit = cap.commit as string;

    // First rename: moves from ID to Stable Label
    const applyRes1 = await service.apply({
      resource_id: resourceId,
      base_commit: baseCommit,
      summary: "Initial rename",
      operations: [
        {
          op: "rename",
          display_name: "Stable Label",
        },
      ],
    });
    expect(applyRes1.renamed).toBe(true);
    expect(applyRes1.new_path).toBe("resources/Stable Label");
    baseCommit = applyRes1.commit as string;

    // Second rename: to the same label (no-op)
    const applyRes2 = await service.apply({
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

    expect(applyRes2.ok).toBe(true);
    expect(applyRes2.renamed).toBe(false);
    expect(applyRes2.old_path).toBe("resources/Stable Label");
    expect(applyRes2.new_path).toBe("resources/Stable Label");

    const changedFiles = applyRes2.changed_files as string[];
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

    // Create resource 1 and rename to "Target Name"
    const cap1 = await service.capture({
      source: { type: "file_descriptor", filename: "doc1.pdf" },
    });
    await service.apply({
      resource_id: (cap1.resource as any).resource_id,
      base_commit: cap1.commit as string,
      summary: "Rename resource 1 to Target Name",
      operations: [{ op: "rename", display_name: "Target Name" }],
    });

    // Create resource 2
    const cap2 = await service.capture({
      source: { type: "file_descriptor", filename: "doc2.pdf" },
    });

    const resourceId2 = (cap2.resource as any).resource_id;
    const baseCommit2 = cap2.commit as string;

    // Rename resource 2 to "Target Name" (collides with resource 1 directory)
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

  it("revisit never auto-renames directory even when resolver provides title; AI explicit rename moves directory", async () => {
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

    // Initial capture: always saves to ID directory
    const cap1 = await service.capture({
      source: { type: "url", url: "https://www.youtube.com/watch?v=upgrade123" },
    });

    const resource1 = cap1.resource as any;
    const resId = resource1.resource_id;
    expect(resource1.naming_source).toBe("id");
    expect(resource1.display_name).toBe(resId);
    expect(resource1.relative_path).toBe(`resources/${resId}`);

    // Check meta.md on disk
    const metaPath1 = path.join(item.config.repoDir, `resources/${resId}/meta.md`);
    const doc1 = parseMetaMarkdown(await readFile(metaPath1, "utf8"));
    expect(doc1.meta.naming_source).toBe("id");
    expect(doc1.meta.display_name).toBe(resId);

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
    // NEVER auto-rename: preserves ID name and ID directory
    expect(resource2.naming_source).toBe("id");
    expect(resource2.display_name).toBe(resId);
    expect(resource2.relative_path).toBe(`resources/${resId}`);
    expect(resource2.title).toBe("Deep Learning Breakthrough 2026");

    // Disk meta.md has updated title but preserved ID directory
    const doc2 = parseMetaMarkdown(await readFile(metaPath1, "utf8"));
    expect(doc2.meta.naming_source).toBe("id");
    expect(doc2.meta.display_name).toBe(resId);
    expect(doc2.meta.title).toBe("Deep Learning Breakthrough 2026");

    // Now AI performs explicit rename using resource_apply
    const renameRes = await service.apply({
      resource_id: resId,
      base_commit: cap2.commit as string,
      summary: "AI rename based on resolved title",
      operations: [
        {
          op: "rename",
          display_name: "Deep Learning Breakthrough 2026",
        },
      ],
    });

    expect(renameRes.renamed).toBe(true);
    expect(renameRes.old_path).toBe(`resources/${resId}`);
    expect(renameRes.new_path).toBe("resources/Deep Learning Breakthrough 2026");

    // Verify old ID directory is gone and new directory has meta.md
    await expect(readFile(metaPath1)).rejects.toThrow();
    const newMetaPath = path.join(item.config.repoDir, "resources/Deep Learning Breakthrough 2026/meta.md");
    const doc3 = parseMetaMarkdown(await readFile(newMetaPath, "utf8"));
    expect(doc3.meta.naming_source).toBe("explicit");
    expect(doc3.meta.display_name).toBe("Deep Learning Breakthrough 2026");
    expect(doc3.meta.title).toBe("Deep Learning Breakthrough 2026");
  });
});
