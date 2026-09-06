import { rm, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CeoWorkspace } from "../src/workspace.js";
import { ResourceService } from "../src/resource/service.js";
import { fixture } from "./helpers.js";
import { parseMetaMarkdown } from "../src/resource/meta.js";
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

describe("PROJECT-023 Resource Identity Deduplication & Out-of-Order Attempt Skipping", () => {
  it("rejects capture with DUPLICATE_RESOURCE when URL platform_id conflicts with resolver source_id", async () => {
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
        source_url: "https://www.youtube.com/watch?v=realVideo111",
        source_id: "mismatchId99", // Mismatch with URL platform_id "realVideo111"
        title: "Conflict Title",
        captured_at: "2026-09-06T12:00:00Z",
      },
      fields_resolved: ["title", "source_id"],
      diagnostics: { strategy: "youtube_oembed", fetch_status: "ok" },
      latency_ms: 10,
    });

    const service = new ResourceService(workspace, item.config, mockResolver);

    await expect(
      service.capture({
        source: { type: "url", url: "https://www.youtube.com/watch?v=realVideo111" },
      }),
    ).rejects.toThrow(CeoError);

    try {
      await service.capture({
        source: { type: "url", url: "https://www.youtube.com/watch?v=realVideo111" },
      });
    } catch (err: any) {
      expect(err.code).toBe("DUPLICATE_RESOURCE");
      expect(err.message).toContain("Provider ID conflict");
    }
  });

  it("skips stale out-of-order resolution attempt and sets applied: false, skip_reason: stale_attempt", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();
    const service = new ResourceService(workspace, item.config, mockResolver);

    // 1. First capture at T2 (newer): 12:00:00
    mockResolver.customHandler = () => ({
      status: "resolved",
      attempted_at: "2026-09-06T12:00:00.000Z",
      fields_resolved: ["title", "author"],
      metadata: {
        schema_version: 1,
        source_type: "youtube",
        source_url: "https://www.youtube.com/watch?v=staleTest",
        source_id: "staleTest",
        title: "Newer Title (T2)",
        author: "Author T2",
        captured_at: "2026-09-06T12:00:00.000Z",
      },
      diagnostics: { strategy: "youtube_oembed", fetch_status: "ok" },
      latency_ms: 10,
    });

    const cap1 = await service.capture({
      source: { type: "url", url: "https://www.youtube.com/watch?v=staleTest" },
    });

    expect(cap1.ok).toBe(true);
    expect(cap1.metadata_enrichment).toMatchObject({
      status: "resolved",
      applied: true,
    });

    const resourceId = (cap1.resource as any).resource_id;
    const metaPath = path.join(item.config.repoDir, (cap1.resource as any).relative_path, "meta.md");
    const doc1 = parseMetaMarkdown(await readFile(metaPath, "utf8"));
    expect(doc1.meta.title).toBe("Newer Title (T2)");
    expect(doc1.meta.last_metadata_attempt?.attempted_at).toBe("2026-09-06T12:00:00.000Z");

    // 2. Second capture arriving late with an older attempted_at T1: 11:30:00 (< 12:00:00)
    // with different title and user note
    mockResolver.customHandler = () => ({
      status: "resolved",
      attempted_at: "2026-09-06T11:30:00.000Z",
      fields_resolved: ["title"],
      metadata: {
        schema_version: 1,
        source_type: "youtube",
        source_url: "https://www.youtube.com/watch?v=staleTest",
        source_id: "staleTest",
        title: "Stale Older Title (T1)",
        captured_at: "2026-09-06T11:30:00.000Z",
      },
      diagnostics: { strategy: "youtube_oembed", fetch_status: "ok" },
      latency_ms: 10,
    });

    const cap2 = await service.capture({
      source: { type: "url", url: "https://www.youtube.com/watch?v=staleTest" },
      note: "User note from late revisit",
      topics: ["user-topic"],
    });

    expect(cap2.ok).toBe(true);
    // Enrichment receipt flags skipped stale attempt!
    expect(cap2.metadata_enrichment).toMatchObject({
      status: "resolved",
      applied: false,
      skip_reason: "stale_attempt",
    });

    // Verify meta.md on disk:
    // Stale resolver title was NOT applied; T2 title and attempt record were preserved!
    const doc2 = parseMetaMarkdown(await readFile(metaPath, "utf8"));
    expect(doc2.meta.title).toBe("Newer Title (T2)");
    expect(doc2.meta.last_metadata_attempt?.attempted_at).toBe("2026-09-06T12:00:00.000Z");

    // But user-provided semantic additions (topics, note) WERE applied!
    expect(doc2.meta.topics).toContain("user-topic");
    expect(doc2.capture_history.some((h) => h.includes("User note from late revisit"))).toBe(true);
  });

  it("supports symmetrical multi-key deduplication matching via source_aliases", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const mockResolver = new MockResolver();
    const service = new ResourceService(workspace, item.config, mockResolver);

    // Initial capture with YouTube short URL
    const cap1 = await service.capture({
      source: { type: "url", url: "https://youtu.be/dQw4w9WgXcQ?feature=share" },
      display_name: "Multi-Key Dedupe Test",
    });

    expect(cap1.ok).toBe(true);
    const resId1 = (cap1.resource as any).resource_id;

    // Capture with desktop watch URL for same video
    const cap2 = await service.capture({
      source: { type: "url", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s" },
      note: "Referenced via desktop link",
    });

    expect(cap2.ok).toBe(true);
    const resId2 = (cap2.resource as any).resource_id;
    // Exactly deduped to the same resource ID!
    expect(resId2).toBe(resId1);
    expect((cap2.resource as any).is_revisit).toBe(true);
  });
});
