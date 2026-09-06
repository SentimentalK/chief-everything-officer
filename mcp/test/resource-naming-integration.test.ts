import { rm, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CeoWorkspace } from "../src/workspace.js";
import { runGit } from "../src/git.js";
import { ResourceService } from "../src/resource/service.js";
import { ResourceRetrievalService } from "../src/resource/retrieval.js";
import { fixture } from "./helpers.js";
import { parseMetaMarkdown, formatMetaMarkdown } from "../src/resource/meta.js";
import { enumerateResources, resolveResourceLocation } from "../src/resource/locator.js";
import { CeoError } from "../src/errors.js";
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

describe("CEO Resource Identity & Physical Naming V0 Integration", () => {
  it("captures to ID directory and renames to readable directory name via resource_apply", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();
    mockResolver.customHandler = () => ({
      status: "resolved",
      metadata: {
        schema_version: 1,
        source_type: "youtube",
        source_url: "https://www.youtube.com/watch?v=cuda123",
        source_id: "cuda123",
        title: "Why CUDA Moat is Unbreakable",
      },
      latency_ms: 10,
    });

    const service = new ResourceService(workspace, item.config, mockResolver);

    const cap = await service.capture({
      source: { type: "url", url: "https://www.youtube.com/watch?v=cuda123" },
    });

    expect(cap.ok).toBe(true);
    const resource = cap.resource as Record<string, unknown>;
    const resId = resource.resource_id as string;
    expect(resId).toMatch(/^res-[0-9a-f-]{36}$/);
    expect(resource.display_name).toBe(resId);
    expect(resource.naming_source).toBe("id");
    expect(resource.title).toBe("Why CUDA Moat is Unbreakable");
    expect(cap.changed_files).toContain(`resources/${resId}/meta.md`);

    // AI inspects metadata and calls resource_apply.rename
    const applyRes = await service.apply({
      resource_id: resId,
      base_commit: cap.commit as string,
      summary: "AI semantic rename",
      operations: [
        {
          op: "rename",
          display_name: "CUDA生态与NVIDIA软件护城河",
        },
      ],
    });

    expect(applyRes.ok).toBe(true);
    expect(applyRes.renamed).toBe(true);
    expect(applyRes.old_path).toBe(`resources/${resId}`);
    expect(applyRes.new_path).toBe("resources/CUDA生态与NVIDIA软件护城河");

    // Verify meta.md contents
    const metaPath = path.join(item.config.repoDir, "resources/CUDA生态与NVIDIA软件护城河/meta.md");
    const metaContent = await readFile(metaPath, "utf8");
    const doc = parseMetaMarkdown(metaContent);

    expect(doc.meta.resource_id).toBe(resId);
    expect(doc.meta.display_name).toBe("CUDA生态与NVIDIA软件护城河");
    expect(doc.meta.naming_source).toBe("explicit");
    expect(doc.meta.title).toBe("Why CUDA Moat is Unbreakable");
    expect(doc.heading).toBe("CUDA生态与NVIDIA软件护城河");
  });

  it("handles directory name collisions with deterministic integer suffixes (-2, -3)", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const service = new ResourceService(workspace, item.config);

    // Capture 1: rename to "AI Report"
    const cap1 = await service.capture({
      source: { type: "file_descriptor", filename: "report1.pdf" },
    });
    const id1 = (cap1.resource as any).resource_id;
    const ren1 = await service.apply({
      resource_id: id1,
      base_commit: cap1.commit as string,
      summary: "Rename 1",
      operations: [{ op: "rename", display_name: "AI Report" }],
    });
    expect(ren1.new_path).toBe("resources/AI Report");

    // Capture 2: Collision on same display_name "AI Report"
    const cap2 = await service.capture({
      source: { type: "file_descriptor", filename: "report2.pdf" },
    });
    const id2 = (cap2.resource as any).resource_id;
    const ren2 = await service.apply({
      resource_id: id2,
      base_commit: cap2.commit as string,
      summary: "Rename 2",
      operations: [{ op: "rename", display_name: "AI Report" }],
    });
    expect(ren2.new_path).toBe("resources/AI Report-2");

    // Capture 3: Another collision
    const cap3 = await service.capture({
      source: { type: "file_descriptor", filename: "report3.pdf" },
    });
    const id3 = (cap3.resource as any).resource_id;
    const ren3 = await service.apply({
      resource_id: id3,
      base_commit: cap3.commit as string,
      summary: "Rename 3",
      operations: [{ op: "rename", display_name: "AI Report" }],
    });
    expect(ren3.new_path).toBe("resources/AI Report-3");

    // All three have distinct resource_ids
    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
  });

  it("revisit preserves existing display_name and directory", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();
    mockResolver.customHandler = () => ({
      status: "resolved",
      metadata: {
        schema_version: 1,
        source_type: "youtube",
        source_url: "https://www.youtube.com/watch?v=vid999",
        source_id: "vid999",
        title: "Resolver Title From Web",
      },
      latency_ms: 10,
    });

    const service = new ResourceService(workspace, item.config, mockResolver);

    // 1. First capture saves to ID directory
    const cap1 = await service.capture({
      source: { type: "url", url: "https://www.youtube.com/watch?v=vid999" },
    });
    const resId = (cap1.resource as any).resource_id;

    // AI renames to semantic display_name
    const ren1 = await service.apply({
      resource_id: resId,
      base_commit: cap1.commit as string,
      summary: "Rename to semantic name",
      operations: [{ op: "rename", display_name: "我的专属语义名称" }],
    });
    expect(ren1.new_path).toBe("resources/我的专属语义名称");

    // 2. Revisit: resolver title must NOT overwrite display_name or directory
    const cap2 = await service.capture({
      source: { type: "url", url: "https://www.youtube.com/watch?v=vid999" },
      note: "Second time encountering this video",
    });
    const resource2 = cap2.resource as Record<string, unknown>;
    expect(resource2.is_revisit).toBe(true);
    expect(resource2.display_name).toBe("我的专属语义名称"); // Preserved!
    expect(resource2.relative_path).toBe("resources/我的专属语义名称"); // Preserved!

    // 3. Explicit AI rename updates display_name AND renames directory
    const ren2 = await service.apply({
      resource_id: resId,
      base_commit: cap2.commit as string,
      summary: "Refine name",
      operations: [{ op: "rename", display_name: "更精炼的语义名称" }],
    });
    expect(ren2.new_path).toBe("resources/更精炼的语义名称");
    expect((ren2.resource as any).display_name).toBe("更精炼的语义名称");
  });

  it("resource_apply op:rename updates metadata and renames physical directory", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);

    const cap = await service.capture({
      source: { type: "file_descriptor", filename: "paper.pdf" },
    });
    const resourceId = (cap.resource as any).resource_id;
    const baseCommit = cap.commit as string;

    const applyRes = await service.apply({
      resource_id: resourceId,
      base_commit: baseCommit,
      summary: "Refine display name",
      operations: [
        {
          op: "rename",
          display_name: "Deep Architecture Evolution 2026",
        },
      ],
    });

    expect(applyRes.ok).toBe(true);
    expect(applyRes.renamed).toBe(true);
    expect(applyRes.new_path).toBe("resources/Deep Architecture Evolution 2026");
    expect(applyRes.changed_files).toContain("resources/Deep Architecture Evolution 2026/meta.md");

    // Check meta.md at new directory
    const metaContent = await readFile(path.join(item.config.repoDir, "resources/Deep Architecture Evolution 2026/meta.md"), "utf8");
    const doc = parseMetaMarkdown(metaContent);
    expect(doc.meta.display_name).toBe("Deep Architecture Evolution 2026");
    expect(doc.meta.naming_source).toBe("explicit");
    expect(doc.meta.resource_id).toBe(resourceId);
  });

  it("coexists seamlessly with legacy UUID directory layout (mixed layout compatibility)", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const legacyId = "res-11111111-2222-3333-4444-555555555555";
    const legacyDir = path.join(item.config.repoDir, "resources", legacyId);
    await mkdir(legacyDir, { recursive: true });

    // Legacy meta.md with ID placeholder display_name
    const legacyMetaYaml = `---
schema_version: 1
resource_id: ${legacyId}
display_name: ${legacyId}
naming_source: id
source_aliases: []
last_metadata_attempt: null
resource_kind: document
source_type: file
source_identity: file:legacy-001
source_ref: null
canonical_ref: null
platform: null
platform_id: null
original_name: legacy_document.pdf
media_type: application/pdf
format: pdf
asset_ref: null
source_hash: null
title: Legacy Document Title
author: Legacy Author
published_at: 2024-01-01T00:00:00Z
first_captured_at: 2024-01-01T00:00:00Z
language: en
topics:
  - legacy
metadata_method: null
metadata_fetched_at: null
capture_surface: mcp
---

# Legacy Document Title

## Capture Note

Legacy note
`;
    await writeFile(path.join(legacyDir, "meta.md"), legacyMetaYaml, "utf8");
    await runGit(item.config, item.config.repoDir, ["add", "."]);
    await runGit(item.config, item.config.repoDir, ["commit", "-m", "Add legacy resource"]);
    await runGit(item.config, item.config.repoDir, ["push", "origin", "main"]);

    // Create a new readable-directory resource
    const service = new ResourceService(workspace, item.config);
    const retrieval = new ResourceRetrievalService(workspace, item.config);

    const newCap = await service.capture({
      source: { type: "file_descriptor", filename: "new_file.pdf" },
      topics: ["modern"],
    });
    const newId = (newCap.resource as any).resource_id;
    await service.apply({
      resource_id: newId,
      base_commit: newCap.commit as string,
      summary: "AI rename modern resource",
      operations: [{ op: "rename", display_name: "Modern Readable Resource" }],
    });

    // 1. Test enumerateResources discovers both
    const all = await enumerateResources(item.config.repoDir);
    expect(all).toHaveLength(2);
    expect(all.some((r) => r.location.resource_id === legacyId)).toBe(true);
    expect(all.some((r) => r.location.resource_id === newId)).toBe(true);

    const legacyFound = all.find((r) => r.location.resource_id === legacyId)!;
    expect(legacyFound.meta.display_name).toBe(legacyId);
    expect(legacyFound.meta.title).toBe("Legacy Document Title");

    // 2. Test resource_get on legacy resource
    const legacyGet = await retrieval.get({ resource_id: legacyId, view: "metadata" });
    expect(legacyGet.resource_id).toBe(legacyId);
    expect(legacyGet.display_name).toBe(legacyId);
    expect(legacyGet.title).toBe("Legacy Document Title");

    // 3. Test resource_get on modern resource
    const modernGet = await retrieval.get({ resource_id: newId, view: "metadata" });
    expect(modernGet.resource_id).toBe(newId);
    expect(modernGet.display_name).toBe("Modern Readable Resource");

    // 4. Test resource_search returns display_name and query matches display_name
    const searchRes = await retrieval.search({ query: "Readable" });
    expect(searchRes.count).toBe(1);
    expect((searchRes.results as any[])[0].resource_id).toBe(newId);
    expect((searchRes.results as any[])[0].display_name).toBe("Modern Readable Resource");

    // 5. Test resource_apply on legacy resource
    const baseCommit = (await workspace.workspaceStatus()).local_commit;
    const applyLegacy = await service.apply({
      resource_id: legacyId,
      base_commit: baseCommit,
      summary: "Update legacy topics",
      operations: [{ op: "patch_topics", add: ["upgraded"] }],
    });
    expect(applyLegacy.ok).toBe(true);
    expect(applyLegacy.changed_files).toContain(`resources/${legacyId}/meta.md`);
  });

  it("detects duplicate canonical resource_id across multiple directories and throws CORRUPTION", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const sharedId = "res-99999999-aaaa-bbbb-cccc-dddddddddddd";

    // Directory A
    const dirA = path.join(item.config.repoDir, "resources/FirstFolder");
    await mkdir(dirA, { recursive: true });
    const metaA = formatMetaMarkdown({
      schema_version: 1,
      resource_id: sharedId,
      display_name: "Resource A",
      naming_source: "explicit",
      source_aliases: [],
      last_metadata_attempt: null,
      resource_kind: "document",
      source_type: "file",
      source_identity: "file:1",
      source_ref: null,
      canonical_ref: null,
      platform: null,
      platform_id: null,
      original_name: "a.pdf",
      media_type: null,
      format: null,
      asset_ref: null,
      source_hash: null,
      title: "Title A",
      author: null,
      published_at: null,
      first_captured_at: new Date().toISOString(),
      language: null,
      topics: [],
      metadata_method: null,
      metadata_fetched_at: null,
      capture_surface: "mcp",
    });
    await writeFile(path.join(dirA, "meta.md"), metaA, "utf8");

    // Directory B with the DUPLICATE resource_id
    const dirB = path.join(item.config.repoDir, "resources/SecondFolder");
    await mkdir(dirB, { recursive: true });
    const metaB = formatMetaMarkdown({
      schema_version: 1,
      resource_id: sharedId, // Duplicate!
      display_name: "Resource B",
      naming_source: "explicit",
      source_aliases: [],
      last_metadata_attempt: null,
      resource_kind: "document",
      source_type: "file",
      source_identity: "file:2",
      source_ref: null,
      canonical_ref: null,
      platform: null,
      platform_id: null,
      original_name: "b.pdf",
      media_type: null,
      format: null,
      asset_ref: null,
      source_hash: null,
      title: "Title B",
      author: null,
      published_at: null,
      first_captured_at: new Date().toISOString(),
      language: null,
      topics: [],
      metadata_method: null,
      metadata_fetched_at: null,
      capture_surface: "mcp",
    });
    await writeFile(path.join(dirB, "meta.md"), metaB, "utf8");

    // Both enumerateResources and resolveResourceLocation must detect this corruption
    await expect(enumerateResources(item.config.repoDir)).rejects.toThrowError(CeoError);
    await expect(resolveResourceLocation(item.config.repoDir, sharedId)).rejects.toThrowError(CeoError);
  });
});
