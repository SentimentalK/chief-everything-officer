import { rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CeoWorkspace } from "../src/workspace.js";
import { runGit } from "../src/git.js";
import { ResourceRetrievalService } from "../src/resource/retrieval.js";
import { ResourceService } from "../src/resource/service.js";
import { fixture } from "./helpers.js";

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
});
