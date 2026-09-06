import { rm, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CeoWorkspace } from "../src/workspace.js";
import { ResourceService } from "../src/resource/service.js";
import { fixture } from "./helpers.js";
import { CeoError } from "../src/errors.js";
import { parseMetaMarkdown } from "../src/resource/meta.js";
import type {
  ResolveOutcome,
  UrlMetadataResolver,
} from "../src/resource/resolver-client.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class MockResolver implements UrlMetadataResolver {
  public callCount = 0;
  public lastResolvedUrl: string | null = null;
  public customHandler?: (url: string) => Promise<ResolveOutcome> | ResolveOutcome;

  async resolve(url: string): Promise<ResolveOutcome> {
    this.callCount++;
    this.lastResolvedUrl = url;
    if (this.customHandler) {
      return await this.customHandler(url);
    }
    return { status: "disabled" };
  }
}

describe("Resource Resolver Integration V0", () => {
  it("synchronously resolves trusted metadata before transaction and maps stable fields", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();
    mockResolver.customHandler = (url) => ({
      status: "resolved",
      metadata: {
        schema_version: 1,
        source_type: "youtube",
        source_url: url,
        canonical_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        source_id: "dQw4w9WgXcQ",
        title: "Never Gonna Give You Up",
        creator: "Rick Astley",
        published_at: "2009-10-25T06:57:33Z",
        language: "en",
        captured_at: "2026-09-05T12:00:00Z",
        duration_seconds: 213,
      },
      latency_ms: 12,
    });

    const service = new ResourceService(workspace, item.config, mockResolver);

    const capture = await service.capture({
      source: { type: "url", url: "https://youtu.be/dQw4w9WgXcQ?si=tracking123" },
      note: "Iconic video",
      topics: ["music"],
    });

    expect(mockResolver.callCount).toBe(1);
    expect(mockResolver.lastResolvedUrl).toBe("https://youtu.be/dQw4w9WgXcQ?si=tracking123");

    expect(capture.ok).toBe(true);
    expect(capture.metadata_enrichment).toEqual({ status: "resolved" });

    const resource = capture.resource as Record<string, unknown>;
    expect(resource.resource_id).toMatch(/^res-[0-9a-f-]{36}$/);
    expect(resource.is_revisit).toBe(false);
    expect(resource.title).toBe("Never Gonna Give You Up");
    expect(resource.platform).toBe("youtube");
    expect(resource.resource_kind).toBe("video");
    expect(resource.stage).toBe("CAPTURED");

    // Check meta.md on disk
    const metaPath = path.join(item.config.repoDir, "resources", resource.resource_id as string, "meta.md");
    const metaContent = await readFile(metaPath, "utf8");
    const parsed = parseMetaMarkdown(metaContent);

    expect(parsed.meta.source_identity).toBe("youtube:dQw4w9WgXcQ");
    expect(parsed.meta.platform).toBe("youtube");
    expect(parsed.meta.platform_id).toBe("dQw4w9WgXcQ");
    expect(parsed.meta.title).toBe("Never Gonna Give You Up");
    expect(parsed.meta.author).toBe("Rick Astley");
    expect(parsed.meta.published_at).toBe("2009-10-25T06:57:33Z");
    expect(parsed.meta.language).toBe("en");
    expect(parsed.meta.resource_kind).toBe("video");
    expect(parsed.meta.metadata_method).toBe("deterministic_adapter");
    expect(parsed.meta.metadata_fetched_at).toBe("2026-09-05T12:00:00Z");
    // Volatile / unpersisted fields must NOT be in frontmatter
    expect(metaContent).not.toContain("duration_seconds");
  });

  it("handles unsupported URL gracefully: captures resource with metadata_method=null", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();
    mockResolver.customHandler = () => ({
      status: "unsupported",
      code: "unsupported_url",
      latency_ms: 5,
    });

    const service = new ResourceService(workspace, item.config, mockResolver);

    const capture = await service.capture({
      source: { type: "url", url: "https://example.com/unsupported-article" },
      note: "Reading notes",
    });

    expect(capture.ok).toBe(true);
    expect(capture.metadata_enrichment).toEqual({ status: "unsupported", code: "unsupported_url" });

    const resource = capture.resource as Record<string, unknown>;
    expect(resource.title).toBeNull();
    expect(resource.resource_kind).toBe("webpage");

    const metaPath = path.join(item.config.repoDir, "resources", resource.resource_id as string, "meta.md");
    const parsed = parseMetaMarkdown(await readFile(metaPath, "utf8"));

    expect(parsed.meta.title).toBeNull();
    expect(parsed.meta.author).toBeNull();
    expect(parsed.meta.metadata_method).toBeNull();
    expect(parsed.meta.metadata_fetched_at).toBeNull();
  });

  it("handles resolver unavailable (timeout/502) without blocking capture", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();
    mockResolver.customHandler = () => ({
      status: "unavailable",
      code: "timeout",
      latency_ms: 5000,
    });

    const service = new ResourceService(workspace, item.config, mockResolver);

    const capture = await service.capture({
      source: { type: "url", url: "https://example.com/slow-endpoint" },
      note: "Saved during resolver timeout",
    });

    expect(capture.ok).toBe(true);
    expect(capture.metadata_enrichment).toEqual({ status: "unavailable", code: "timeout" });

    const resource = capture.resource as Record<string, unknown>;
    expect(resource.title).toBeNull();
    expect(resource.resource_id).toBeDefined();

    const metaPath = path.join(item.config.repoDir, "resources", resource.resource_id as string, "meta.md");
    const parsed = parseMetaMarkdown(await readFile(metaPath, "utf8"));
    expect(parsed.meta.metadata_method).toBeNull();
  });

  it("handles disabled resolver without blocking capture", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();
    mockResolver.customHandler = () => ({ status: "disabled" });

    const service = new ResourceService(workspace, item.config, mockResolver);

    const capture = await service.capture({
      source: { type: "url", url: "https://example.com/disabled-resolver" },
    });

    expect(capture.ok).toBe(true);
    expect(capture.metadata_enrichment).toEqual({ status: "disabled" });
    const resource = capture.resource as Record<string, unknown>;
    expect(resource.title).toBeNull();
  });

  it("derives preferred identity from trusted provider (e.g. Weixin)", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();
    mockResolver.customHandler = (url) => ({
      status: "resolved",
      metadata: {
        schema_version: 1,
        source_type: "weixin",
        source_url: url,
        canonical_url: "https://mp.weixin.qq.com/s/ABC123456",
        source_id: "ABC123456",
        title: "Weixin Article Title",
        creator: "Weixin Author",
        published_at: "2026-09-01T08:00:00Z",
        language: "zh",
      },
      latency_ms: 10,
    });

    const service = new ResourceService(workspace, item.config, mockResolver);

    const capture = await service.capture({
      source: { type: "url", url: "https://mp.weixin.qq.com/s?__biz=Mzg=...&sn=foo#rd" },
    });

    const resource = capture.resource as Record<string, unknown>;
    expect(resource.source_identity).toBe("weixin:ABC123456");
    expect(resource.platform).toBe("weixin");
    expect(resource.resource_kind).toBe("video");

    const metaPath = path.join(item.config.repoDir, "resources", resource.resource_id as string, "meta.md");
    const parsed = parseMetaMarkdown(await readFile(metaPath, "utf8"));
    expect(parsed.meta.source_identity).toBe("weixin:ABC123456");
    expect(parsed.meta.platform_id).toBe("ABC123456");
  });

  it("falls back to baseline identity when resolver source_id or source_type is invalid", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();
    mockResolver.customHandler = (url) => ({
      status: "resolved",
      metadata: {
        schema_version: 1,
        source_type: "invalid provider with spaces!!",
        source_url: url,
        source_id: "id_with_control_\x00_char",
        title: "Valid Title",
      },
      latency_ms: 10,
    });

    const service = new ResourceService(workspace, item.config, mockResolver);

    const capture = await service.capture({
      source: { type: "url", url: "https://example.com/item" },
    });

    const resource = capture.resource as Record<string, unknown>;
    // Preferred identity rejected because of invalid provider/id; fallback to baseline
    expect(resource.source_identity).toBe("web:https://example.com/item");
    // But valid non-identity title is preserved!
    expect(resource.title).toBe("Valid Title");
  });

  it("dedupes using legacy baseline identity when capturing same URL with resolver preferred identity", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();

    // 1. First capture: resolver is disabled, saved with baseline web: identity
    mockResolver.customHandler = () => ({ status: "disabled" });
    const service1 = new ResourceService(workspace, item.config, mockResolver);

    const capture1 = await service1.capture({
      source: { type: "url", url: "https://example.com/video/123" },
      note: "Initial capture without resolver",
    });
    const resource1 = capture1.resource as Record<string, unknown>;
    expect(resource1.source_identity).toBe("web:https://example.com/video/123");

    // 2. Revisit with resolver enabled returning provider identity (custom:123)
    mockResolver.customHandler = (url) => ({
      status: "resolved",
      metadata: {
        schema_version: 1,
        source_type: "custom",
        source_url: url,
        source_id: "123",
        title: "Enriched Custom Title",
      },
      latency_ms: 8,
    });

    const capture2 = await service1.capture({
      source: { type: "url", url: "https://example.com/video/123" },
      note: "Revisit with resolver",
    });

    const resource2 = capture2.resource as Record<string, unknown>;
    expect(resource2.resource_id).toBe(resource1.resource_id);
    expect(resource2.is_revisit).toBe(true);
    // CRITICAL: source_identity is immutable! Keep old web:...
    expect(resource2.source_identity).toBe("web:https://example.com/video/123");
    // Metadata is enriched
    expect(resource2.title).toBe("Enriched Custom Title");

    const metaPath = path.join(item.config.repoDir, "resources", resource1.resource_id as string, "meta.md");
    const parsed = parseMetaMarkdown(await readFile(metaPath, "utf8"));
    expect(parsed.meta.source_identity).toBe("web:https://example.com/video/123");
    expect(parsed.meta.title).toBe("Enriched Custom Title");
  });

  it("detects identity conflict between preferred and baseline identities and throws DUPLICATE_RESOURCE", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();
    const service = new ResourceService(workspace, item.config, mockResolver);

    // Create Resource A with baseline web:https://example.com/split
    mockResolver.customHandler = () => ({ status: "disabled" });
    await service.capture({
      source: { type: "url", url: "https://example.com/split" },
    });

    // Create Resource B with external_ref provider:split-id
    await service.capture({
      source: { type: "external_ref", provider: "provider", ref: "split-id" },
    });

    // Now capture URL with resolver returning source_type=provider, source_id=split-id
    // This creates preferred_identity=provider:split-id (Resource B)
    // while baseline_identity=web:https://example.com/split (Resource A)
    mockResolver.customHandler = () => ({
      status: "resolved",
      metadata: {
        schema_version: 1,
        source_type: "provider",
        source_url: "https://example.com/split",
        source_id: "split-id",
      },
      latency_ms: 10,
    });

    await expect(
      service.capture({
        source: { type: "url", url: "https://example.com/split" },
      }),
    ).rejects.toThrow("Identity conflict: preferred identity and baseline identity match different resources.");
  });

  it("revisit non-erasure: resolver null does not erase existing non-null metadata", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();

    // First capture: returns full metadata
    mockResolver.customHandler = (url) => ({
      status: "resolved",
      metadata: {
        schema_version: 1,
        source_type: "youtube",
        source_url: url,
        source_id: "vid123",
        title: "Solid Title",
        creator: "Known Author",
        published_at: "2025-01-01T00:00:00Z",
      },
      latency_ms: 10,
    });

    const service = new ResourceService(workspace, item.config, mockResolver);
    const cap1 = await service.capture({
      source: { type: "url", url: "https://www.youtube.com/watch?v=vid123" },
    });
    const resourceId = (cap1.resource as Record<string, unknown>).resource_id as string;

    // Second capture: resolver returns null for author & published_at
    mockResolver.customHandler = (url) => ({
      status: "resolved",
      metadata: {
        schema_version: 1,
        source_type: "youtube",
        source_url: url,
        source_id: "vid123",
        title: "Updated Title",
        creator: null,
        published_at: null,
      },
      latency_ms: 10,
    });

    const cap2 = await service.capture({
      source: { type: "url", url: "https://www.youtube.com/watch?v=vid123" },
    });

    expect((cap2.resource as Record<string, unknown>).title).toBe("Updated Title");

    const metaPath = path.join(item.config.repoDir, "resources", resourceId, "meta.md");
    const parsed = parseMetaMarkdown(await readFile(metaPath, "utf8"));
    expect(parsed.meta.title).toBe("Updated Title");
    // Existing non-null author and published_at were NOT erased!
    expect(parsed.meta.author).toBe("Known Author");
    expect(parsed.meta.published_at).toBe("2025-01-01T00:00:00Z");
  });

  it("no-op revisit: identical capture does not create meaningless Git commits or timestamp churn", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();
    mockResolver.customHandler = (url) => ({
      status: "resolved",
      metadata: {
        schema_version: 1,
        source_type: "youtube",
        source_url: url,
        source_id: "static123",
        title: "Static Video",
        creator: "Creator",
        captured_at: "2026-09-05T12:00:00Z",
      },
      latency_ms: 10,
    });

    const service = new ResourceService(workspace, item.config, mockResolver);

    // Initial capture
    const cap1 = await service.capture({
      source: { type: "url", url: "https://www.youtube.com/watch?v=static123" },
      note: "Stable note",
    });
    const commit1 = cap1.commit as string;
    expect(cap1.changed_files).toHaveLength(1);

    const resourceId = (cap1.resource as Record<string, unknown>).resource_id as string;
    const metaPath = path.join(item.config.repoDir, "resources", resourceId, "meta.md");
    const meta1 = await readFile(metaPath, "utf8");

    // Identical revisit: same URL, same note, same metadata
    const cap2 = await service.capture({
      source: { type: "url", url: "https://www.youtube.com/watch?v=static123" },
      note: "Stable note",
    });

    expect(cap2.ok).toBe(true);
    expect(cap2.changed_files).toHaveLength(0);
    expect(cap2.pushed).toBe(false);
    expect(cap2.commit).toBe(commit1);

    const meta2 = await readFile(metaPath, "utf8");
    // meta.md content is identical byte-for-byte; zero timestamp churn!
    expect(meta2).toBe(meta1);
  });

  it("replay-safe idempotency: retrying identical request_id returns cached result without re-resolving", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();
    mockResolver.customHandler = (url) => ({
      status: "resolved",
      metadata: {
        schema_version: 1,
        source_type: "youtube",
        source_url: url,
        source_id: "replay123",
        title: "Replay Video",
      },
      latency_ms: 10,
    });

    const service = new ResourceService(workspace, item.config, mockResolver);

    const requestId = "11111111-2222-3333-4444-555555555555";
    const cap1 = await service.capture({
      request_id: requestId,
      source: { type: "url", url: "https://www.youtube.com/watch?v=replay123" },
    });

    expect(mockResolver.callCount).toBe(1);

    // Replay with identical request_id
    const cap2 = await service.capture({
      request_id: requestId,
      source: { type: "url", url: "https://www.youtube.com/watch?v=replay123" },
    });

    // Resolver was NOT invoked again!
    expect(mockResolver.callCount).toBe(1);
    expect(cap2.commit).toBe(cap1.commit);
    expect(cap2.resource).toEqual(cap1.resource);
    expect(cap2.metadata_enrichment).toEqual(cap1.metadata_enrichment);
  });
});
