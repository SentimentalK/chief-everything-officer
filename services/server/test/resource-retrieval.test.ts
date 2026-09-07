import { rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CeoWorkspace } from "../src/workspace.js";
import { runGit } from "../src/git.js";
import { ResourceRetrievalService } from "../src/resource/retrieval.js";
import { ResourceService } from "../src/resource/service.js";
import { formatMetaMarkdown } from "../src/resource/meta.js";
import type { ResourceMeta } from "../src/resource/types.js";
import { fixture } from "./helpers.js";

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Hand-written fixtures give each resource a controlled first_captured_at,
// which real captures (runtime toISOString) cannot provide.
function makeMeta(o: {
  resource_id: string;
  first_captured_at: string;
  display_name?: string;
  naming_source?: "id" | "explicit";
}): ResourceMeta {
  return {
    schema_version: 1,
    resource_id: o.resource_id,
    display_name: o.display_name ?? o.resource_id,
    naming_source: o.naming_source ?? "id",
    source_aliases: [],
    last_metadata_attempt: null,
    resource_kind: "document",
    source_type: "url",
    source_identity: `fixture:${o.resource_id}`,
    source_ref: null,
    canonical_ref: null,
    platform: null,
    platform_id: null,
    original_name: null,
    media_type: null,
    format: null,
    asset_ref: null,
    source_hash: null,
    title: null,
    author: null,
    published_at: null,
    first_captured_at: o.first_captured_at,
    language: null,
    topics: [],
    metadata_method: null,
    metadata_fetched_at: null,
    capture_surface: "mcp",
  };
}

async function writeResourceFixture(
  repoDir: string,
  resId: string,
  firstCapturedAt: string,
  overrides?: { display_name?: string; naming_source?: "id" | "explicit" },
): Promise<void> {
  const dir = path.join(repoDir, "resources", resId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "meta.md"),
    formatMetaMarkdown(makeMeta({ resource_id: resId, first_captured_at: firstCapturedAt, ...overrides })),
    "utf8",
  );
}

function resultIds(search: Record<string, unknown>): string[] {
  return (search.results as Array<{ resource_id: string }>).map((r) => r.resource_id);
}

// Deterministic lexicographic order a < b < c (ASCII resource_id).
const RES_A = "res-00000000-0000-4000-8000-00000000000a";
const RES_B = "res-00000000-0000-4000-8000-00000000000b";
const RES_C = "res-00000000-0000-4000-8000-00000000000c";

describe("Resource Retrieval & Progressive Reading", () => {
  it("searches resources using lightweight metadata cards and stage filters", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);
    const retrieval = new ResourceRetrievalService(workspace, item.config);

    // Seed resource A: video (CAPTURED)
    await service.capture({
      source: { type: "url", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
      topics: ["music", "pop"],
      note: "Sample song",
    });

    // Seed resource B: legal document (READY_FOR_DISCUSSION)
    await service.capture({
      source: { type: "file_descriptor", filename: "terms.pdf" },
      topics: ["legal", "contract"],
      note: "Service terms",
      initial_operations: [
        {
          op: "upsert_summary",
          provenance: "host_semantic",
          basis: "source_content",
          content: "# Terms Summary\n\nNo warranty.\n",
        },
      ],
    });

    // 1. Unfiltered search
    const all = await retrieval.search();
    expect(all.count).toBe(2);

    // 2. Filter by topic
    const musicSearch = await retrieval.search({ topics: ["music"] });
    expect(musicSearch.count).toBe(1);
    expect((musicSearch.results as any[])[0].topics).toContain("music");

    // 3. Filter by stage
    const readySearch = await retrieval.search({ stage: "READY_FOR_DISCUSSION" });
    expect(readySearch.count).toBe(1);
    expect((readySearch.results as any[])[0].stage).toBe("READY_FOR_DISCUSSION");

    // 4. Filter by query
    const termsSearch = await retrieval.search({ query: "terms" });
    expect(termsSearch.count).toBe(1);
    expect((termsSearch.results as any[])[0].original_name).toBe("terms.pdf");
  });

  it("retrieves progressive views and section slices in resource_get", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);
    const retrieval = new ResourceRetrievalService(workspace, item.config);

    const pdfBuffer = Buffer.from("%PDF-1.4 sample contract");
    const capture = await service.capture({
      source: {
        type: "file_inline",
        filename: "lease.pdf",
        mime_type: "application/pdf",
        data_base64: pdfBuffer.toString("base64"),
      },
      note: "Apartment lease",
      topics: ["housing", "contract"],
      initial_operations: [
        {
          op: "upsert_content",
          provenance: "host_exact",
          content: [
            "# Apartment Lease",
            "",
            "## S001 Rent and Deposit",
            "Monthly rent is $2500 due on the first of each month.",
            "Security deposit is $2500.",
            "",
            "## S002 Pet Policy",
            "Pets are allowed with written landlord approval.",
            "",
            "## S003 Utilities",
            "Tenant pays electricity and internet.",
          ].join("\n"),
        },
        {
          op: "upsert_summary",
          provenance: "host_semantic",
          basis: "source_content",
          content: "# Lease Summary\n\nRent: $2500/mo. Pets allowed.\n",
        },
      ],
    });

    const resourceId = (capture as any).resource.resource_id;

    // 1. Metadata view
    const metaView = await retrieval.get({ resource_id: resourceId, view: "metadata" });
    expect(metaView.view).toBe("metadata");
    expect(metaView.derived_stage).toBe("READY_FOR_DISCUSSION");
    expect(metaView.source_asset_available).toBe(true);

    // 2. Summary view
    const summaryView = await retrieval.get({ resource_id: resourceId, view: "summary" });
    expect(summaryView.available).toBe(true);
    expect(summaryView.content).toContain("Rent: $2500/mo");
    expect(summaryView.provenance).toBe("host_semantic");
    expect(summaryView.basis).toBe("source_content");

    // 3. Section filtering on content
    const sectionView = await retrieval.get({
      resource_id: resourceId,
      view: "content",
      section_ids: ["S002"],
    });
    expect(sectionView.available).toBe(true);
    expect(sectionView.content).toContain("Pets are allowed with written landlord approval");
    expect(sectionView.content).not.toContain("Monthly rent is $2500");

    // 4. Source view
    const sourceView = await retrieval.get({ resource_id: resourceId, view: "source" });
    expect(sourceView.available).toBe(true);
    expect(sourceView.uri).toBe(`ceo-resource://${resourceId}/source`);

    // 5. Absent view (evidence.md was never created)
    const evidenceView = await retrieval.get({ resource_id: resourceId, view: "evidence" });
    expect(evidenceView.available).toBe(false);
    expect(evidenceView.status).toBe("NOT_AVAILABLE");
  });

  it("filters unnamed resources via naming_source=id with consistent total and limit", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);
    const retrieval = new ResourceRetrievalService(workspace, item.config);

    const capA = await service.capture({ source: { type: "file_descriptor", filename: "a.pdf" } });
    const idA = (capA.resource as any).resource_id;
    const capB = await service.capture({ source: { type: "file_descriptor", filename: "b.pdf" } });
    const idB = (capB.resource as any).resource_id;

    const capC = await service.capture({ source: { type: "file_descriptor", filename: "c.pdf" } });
    const idC = (capC.resource as any).resource_id;
    await service.apply({
      resource_id: idC,
      base_commit: capC.commit as string,
      summary: "Name C",
      operations: [{ op: "rename", display_name: "Named Doc" }],
    });

    // All id-unnamed resources surface with naming_source === "id".
    const unnamed = await retrieval.search({ naming_source: "id" });
    expect(unnamed.count).toBe(2);
    expect(unnamed.total).toBe(2);
    const unnamedIds = (unnamed.results as any[]).map((r) => r.resource_id);
    expect(unnamedIds.sort()).toEqual([idA, idB].sort());
    for (const r of unnamed.results as any[]) {
      expect(r.naming_source).toBe("id");
    }

    const named = await retrieval.search({ naming_source: "explicit" });
    expect(named.count).toBe(1);
    expect((named.results as any[])[0].resource_id).toBe(idC);

    // limit is applied after the filter; total stays the pre-limit count.
    const limited = await retrieval.search({ naming_source: "id", limit: 1 });
    expect(limited.count).toBe(1);
    expect(limited.total).toBe(2);

    // Absent parameter keeps legacy behavior.
    const all = await retrieval.search();
    expect(all.count).toBe(3);
  });

  it("capture -> search naming_source=id -> rename surfaces the same UUID as explicit", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);
    const retrieval = new ResourceRetrievalService(workspace, item.config);

    const cap = await service.capture({
      source: { type: "file_descriptor", filename: "course.pdf" },
    });
    const resource = cap.resource as Record<string, unknown>;
    const resId = resource.resource_id as string;
    expect(resource.naming_source).toBe("id");
    expect(resource.display_name).toBe(resId);

    const found = await retrieval.search({ naming_source: "id" });
    expect(found.count).toBe(1);
    expect((found.results as any[])[0].resource_id).toBe(resId);
    expect((found.results as any[])[0].display_name).toBe(resId);

    await service.apply({
      resource_id: resId,
      base_commit: cap.commit as string,
      summary: "Name the course",
      operations: [{ op: "rename", display_name: "Named Course" }],
    });

    expect((await retrieval.search({ naming_source: "id" })).count).toBe(0);
    const afterRename = await retrieval.search({ query: "Named Course" });
    expect(afterRename.count).toBe(1);
    expect((afterRename.results as any[])[0].resource_id).toBe(resId);
    expect((afterRename.results as any[])[0].naming_source).toBe("explicit");
    expect((afterRename.results as any[])[0].stage).toBe("CAPTURED");
  });

  it("naming_source filter takes effect before reading artifacts of filtered-out resources", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);
    const retrieval = new ResourceRetrievalService(workspace, item.config);

    // Named resource A gets a deliberately corrupt summary.md (no frontmatter):
    // deriveResourceStage would throw VALIDATION_FAILED if A were ever reached.
    const capA = await service.capture({ source: { type: "file_descriptor", filename: "a.pdf" } });
    const idA = (capA.resource as any).resource_id;
    const renA = await service.apply({
      resource_id: idA,
      base_commit: capA.commit as string,
      summary: "Name A",
      operations: [{ op: "rename", display_name: "Corrupt Summary Doc" }],
    });
    await writeFile(
      path.join(item.config.repoDir, "resources/Corrupt Summary Doc/summary.md"),
      "this summary has no YAML frontmatter\n",
      "utf8",
    );
    await runGit(item.config, item.config.repoDir, ["add", "."]);
    await runGit(item.config, item.config.repoDir, ["commit", "-m", "Corrupt A summary"]);
    await runGit(item.config, item.config.repoDir, ["push", "origin", "main"]);

    const capB = await service.capture({ source: { type: "file_descriptor", filename: "b.pdf" } });
    const idB = (capB.resource as any).resource_id;

    // Any search that reaches A's artifacts must fail...
    await expect(retrieval.search({})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // ...but the naming_source=id filter excludes A before its summary is read.
    const unnamed = await retrieval.search({ naming_source: "id" });
    expect(unnamed.count).toBe(1);
    expect((unnamed.results as any[])[0].resource_id).toBe(idB);
  });

  it("filters and sorts on first_captured_at across timezone spellings; bounds are inclusive", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const retrieval = new ResourceRetrievalService(workspace, item.config);

    // All three spellings denote the same instant: 2024-01-01T00:00:00Z.
    await writeResourceFixture(item.config.repoDir, RES_A, "2024-01-01T00:00:00Z");
    await writeResourceFixture(item.config.repoDir, RES_B, "2024-01-01T01:00:00+01:00");
    await writeResourceFixture(item.config.repoDir, RES_C, "2023-12-31T19:00:00-05:00");
    await runGit(item.config, item.config.repoDir, ["add", "."]);
    await runGit(item.config, item.config.repoDir, ["commit", "-m", "seed timezone fixtures"]);
    await runGit(item.config, item.config.repoDir, ["push", "origin", "main"]);

    // Equal instants tie-break by resource_id ascending, for both orders.
    expect(resultIds(await retrieval.search({}))).toEqual([RES_A, RES_B, RES_C]);
    expect(resultIds(await retrieval.search({ sort: "oldest" }))).toEqual([RES_A, RES_B, RES_C]);

    // Inclusive bounds at the shared instant.
    expect((await retrieval.search({ captured_from: "2024-01-01T00:00:00Z" })).count).toBe(3);
    expect((await retrieval.search({ captured_from: "2024-01-01T00:00:00.001Z" })).count).toBe(0);
    expect((await retrieval.search({ captured_to: "2024-01-01T00:00:00Z" })).count).toBe(3);
    expect((await retrieval.search({ captured_to: "2023-12-31T23:59:59.999Z" })).count).toBe(0);

    // The same instant spelled with offsets is an inclusive boundary too.
    expect((await retrieval.search({ captured_from: "2024-01-01T01:00:00+01:00" })).count).toBe(3);
    expect((await retrieval.search({ captured_to: "2023-12-31T19:00:00-05:00" })).count).toBe(3);
  });

  it("treats .1 and .100 as the same instant and resolves ties by resource_id", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const retrieval = new ResourceRetrievalService(workspace, item.config);

    await writeResourceFixture(item.config.repoDir, RES_A, "2024-01-01T00:00:00.1Z"); // 100ms
    await writeResourceFixture(item.config.repoDir, RES_B, "2024-01-01T00:00:00.100Z"); // 100ms (tie with A)
    await writeResourceFixture(item.config.repoDir, RES_C, "2024-01-01T00:00:00.2Z"); // 200ms
    await runGit(item.config, item.config.repoDir, ["add", "."]);
    await runGit(item.config, item.config.repoDir, ["commit", "-m", "seed fractional fixtures"]);
    await runGit(item.config, item.config.repoDir, ["push", "origin", "main"]);

    expect(resultIds(await retrieval.search({}))).toEqual([RES_C, RES_A, RES_B]);
    expect(resultIds(await retrieval.search({ sort: "oldest" }))).toEqual([RES_A, RES_B, RES_C]);
  });

  it("throws VALIDATION_FAILED naming resource_id and meta.md when first_captured_at is invalid (no skipping)", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const retrieval = new ResourceRetrievalService(workspace, item.config);

    const goodId = "res-00000000-0000-4000-8000-0000000000aa";
    const badId = "res-00000000-0000-4000-8000-0000000000bb";
    await writeResourceFixture(item.config.repoDir, goodId, "2024-01-01T00:00:00Z");
    await writeResourceFixture(item.config.repoDir, badId, "not-a-timestamp");
    await runGit(item.config, item.config.repoDir, ["add", "."]);
    await runGit(item.config, item.config.repoDir, ["commit", "-m", "seed bad fixture"]);
    await runGit(item.config, item.config.repoDir, ["push", "origin", "main"]);

    await expect(retrieval.search({})).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining(badId),
      details: { value: "not-a-timestamp" },
    });
  });

  it("rejects malformed captured_from / from>to even on an empty repository", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const retrieval = new ResourceRetrievalService(workspace, item.config);

    // No resources seeded: validation still fires before enumeration.
    await expect(retrieval.search({ captured_from: "2023-02-29T00:00:00Z" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(retrieval.search({ captured_from: "2024-13-01T00:00:00Z" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(
      retrieval.search({
        captured_from: "2024-01-02T00:00:00Z",
        captured_to: "2024-01-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("captured_from must not be later than captured_to"),
    });
  });

  it("combines the naming_source filter (commit-1) with a date range on first_captured_at", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const retrieval = new ResourceRetrievalService(workspace, item.config);

    await writeResourceFixture(item.config.repoDir, RES_A, "2024-01-01T00:00:00Z", { naming_source: "id" });
    await writeResourceFixture(item.config.repoDir, RES_B, "2024-02-01T00:00:00Z", {
      naming_source: "explicit",
      display_name: "Named B",
    });
    await writeResourceFixture(item.config.repoDir, RES_C, "2024-03-01T00:00:00Z", { naming_source: "id" });
    await runGit(item.config, item.config.repoDir, ["add", "."]);
    await runGit(item.config, item.config.repoDir, ["commit", "-m", "seed naming fixtures"]);
    await runGit(item.config, item.config.repoDir, ["push", "origin", "main"]);

    // id resources captured between mid-January and mid-March: only C.
    const combined = await retrieval.search({
      naming_source: "id",
      captured_from: "2024-01-15T00:00:00Z",
      captured_to: "2024-03-15T00:00:00Z",
    });
    expect(combined.count).toBe(1);
    expect(combined.total).toBe(1);
    expect(resultIds(combined)).toEqual([RES_C]);

    const named = await retrieval.search({ naming_source: "explicit" });
    expect(named.count).toBe(1);
    expect((named.results as any[])[0].resource_id).toBe(RES_B);

    expect(resultIds(await retrieval.search({ naming_source: "id", sort: "oldest" }))).toEqual([RES_A, RES_C]);
  });
});
