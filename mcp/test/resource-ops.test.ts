import { rm, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CeoWorkspace } from "../src/workspace.js";
import { ResourceService } from "../src/resource/service.js";
import { fixture } from "./helpers.js";
import { CeoError } from "../src/errors.js";
import { parseMetaMarkdown } from "../src/resource/meta.js";

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Resource Operations & Atomic Closures", () => {
  it("captures URL resource, dedupes identical URL, and handles revisit cleanly", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);

    // 1. Initial capture
    const capture1 = await service.capture({
      source: { type: "url", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s" },
      note: "Important music video",
      topics: ["music", "pop"],
    });

    expect(capture1.ok).toBe(true);
    expect(capture1.commit).toBeDefined();
    const changedFiles = capture1.changed_files as string[];
    expect(changedFiles.some((f) => f.endsWith("meta.md"))).toBe(true);

    const resourceId = changedFiles.find((f) => f.endsWith("meta.md"))!.split("/")[1]!;

    // 2. Read meta.md
    const metaPath = path.join(item.config.repoDir, "resources", resourceId, "meta.md");
    const metaContent1 = await readFile(metaPath, "utf8");
    const doc1 = parseMetaMarkdown(metaContent1);
    expect(doc1.meta.source_identity).toBe("youtube:dQw4w9WgXcQ");
    expect(doc1.meta.platform).toBe("youtube");
    expect(doc1.meta.topics).toEqual(["music", "pop"]);
    expect(doc1.capture_note).toBe("Important music video");

    // 3. Duplicate capture with the same video under different query param
    const capture2 = await service.capture({
      source: { type: "url", url: "https://youtu.be/dQw4w9WgXcQ?si=tracking123" },
      note: "Shared by friend",
      topics: ["classic"],
    });

    expect(capture2.ok).toBe(true);
    // Verified that it deduped to the exact same resourceId
    const changedFiles2 = capture2.changed_files as string[];
    expect(changedFiles2[0]).toBe(`resources/${resourceId}/meta.md`);

    const metaContent2 = await readFile(metaPath, "utf8");
    const doc2 = parseMetaMarkdown(metaContent2);
    expect(doc2.meta.resource_id).toBe(resourceId);
    expect(doc2.meta.topics).toContain("classic");
    expect(doc2.meta.topics).toContain("music");
    expect(doc2.capture_history.some((h) => h.includes("revisit — Shared by friend"))).toBe(true);
  });

  it("captures provisional file descriptor with source_identity=null and persists semantic memory", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);

    const capture = await service.capture({
      source: {
        type: "file_descriptor",
        filename: "employment-agreement.pdf",
        host_ref: "host-file-ref-1234",
      },
      note: "Contract review session",
      topics: ["legal", "employment"],
      initial_operations: [
        {
          op: "upsert_summary",
          provenance: "host_semantic",
          content: "# Summary\n\n- Non-compete: 1 year\n- Stock options: 4 year vest\n",
        },
        {
          op: "append_interaction",
          provenance: "host_semantic",
          entry: "User confirmed 1 year non-compete is acceptable.",
        },
      ],
    });

    expect(capture.ok).toBe(true);
    const changed = capture.changed_files as string[];
    const resourceId = changed.find((f) => f.endsWith("meta.md"))!.split("/")[1]!;

    const resDir = path.join(item.config.repoDir, "resources", resourceId);
    const metaContent = await readFile(path.join(resDir, "meta.md"), "utf8");
    const doc = parseMetaMarkdown(metaContent);

    // Provisional resource must have source_identity = null
    expect(doc.meta.source_identity).toBeNull();
    expect(doc.meta.original_name).toBe("employment-agreement.pdf");
    expect(doc.meta.source_ref).toBe("host-file-ref-1234");
    expect(doc.meta.asset_ref).toBeNull();

    // Summary and interactions exist
    const summaryText = await readFile(path.join(resDir, "summary.md"), "utf8");
    expect(summaryText).toContain("Non-compete: 1 year");
    const interactionText = await readFile(path.join(resDir, "interactions.md"), "utf8");
    expect(interactionText).toContain("User confirmed 1 year non-compete");
  });

  it("captures file_inline, computes SHA-256, and later attaches asset to provisional resource", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);

    const pdfBuffer = Buffer.from("%PDF-1.4 contract bytes A");
    const pdfBase64 = pdfBuffer.toString("base64");

    // Capture file_inline
    const capture = await service.capture({
      source: {
        type: "file_inline",
        filename: "contract-v1.pdf",
        mime_type: "application/pdf",
        data_base64: pdfBase64,
      },
      note: "Inline contract",
      topics: ["contract"],
    });

    expect(capture.ok).toBe(true);
    const changed = capture.changed_files as string[];
    const resourceId = changed.find((f) => f.endsWith("meta.md"))!.split("/")[1]!;
    expect(changed).toContain(`resources/${resourceId}/source/original.pdf`);

    const resDir = path.join(item.config.repoDir, "resources", resourceId);
    const metaContent = await readFile(path.join(resDir, "meta.md"), "utf8");
    const doc = parseMetaMarkdown(metaContent);

    expect(doc.meta.source_identity).toMatch(/^file:sha256:[0-9a-f]{64}$/);
    expect(doc.meta.source_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(doc.meta.asset_ref).toBe("source/original.pdf");
  });

  it("attaches source asset to provisional resource, rejecting collision if exact hash exists elsewhere", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);

    const pdfBuffer = Buffer.from("%PDF-1.4 shared document content");
    const pdfBase64 = pdfBuffer.toString("base64");

    // 1. First resource with inline file
    const res1 = await service.capture({
      source: {
        type: "file_inline",
        filename: "doc1.pdf",
        mime_type: "application/pdf",
        data_base64: pdfBase64,
      },
      summary: "First resource with doc",
    });
    expect(res1.ok).toBe(true);

    // 2. Second provisional resource without file
    const res2 = await service.capture({
      source: {
        type: "file_descriptor",
        filename: "doc2.pdf",
      },
      summary: "Provisional resource",
    });
    expect(res2.ok).toBe(true);
    const res2Id = (res2.changed_files as string[]).find((f) => f.endsWith("meta.md"))!.split("/")[1]!;

    // 3. Late attach exact same bytes to res2 -> must throw DUPLICATE_RESOURCE!
    const baseCommit = res2.commit as string;
    await expect(
      service.apply({
        resource_id: res2Id,
        base_commit: baseCommit,
        summary: "Attach duplicate document",
        operations: [
          {
            op: "attach_source_asset",
            filename: "doc2.pdf",
            mime_type: "application/pdf",
            data_base64: pdfBase64,
          },
        ],
      }),
    ).rejects.toThrowError(CeoError);
  });

  it("enforces provenance rules on semantic artifacts", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);

    const res = await service.capture({
      source: { type: "url", url: "https://example.com/test-article" },
    });
    const resId = (res.changed_files as string[]).find((f) => f.endsWith("meta.md"))!.split("/")[1]!;
    const baseCommit = res.commit as string;

    // Reject upsert_evidence with host_semantic
    await expect(
      service.apply({
        resource_id: resId,
        base_commit: baseCommit,
        summary: "Illegal evidence provenance",
        operations: [
          {
            op: "upsert_evidence",
            provenance: "host_semantic" as any,
            content: "AI reconstructed transcript",
          },
        ],
      }),
    ).rejects.toThrowError(CeoError);

    // Accept upsert_evidence with host_exact
    const validApply = await service.apply({
      resource_id: resId,
      base_commit: baseCommit,
      summary: "Exact evidence added",
      operations: [
        {
          op: "upsert_evidence",
          provenance: "host_exact",
          content: "Raw platform subtitle track",
        },
        {
          op: "patch_topics",
          add: ["verified"],
        },
      ],
    });

    expect(validApply.ok).toBe(true);
    expect(validApply.changed_files).toContain(`resources/${resId}/evidence.md`);
  });

  it("atomically commits Resource updates and State consequences in a single Git transaction", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const service = new ResourceService(workspace, item.config);

    const capture = await service.capture({
      source: { type: "url", url: "https://example.com/ai-whitepaper" },
      note: "AI agent architecture reading",
      topics: ["ai", "agents"],
      initial_operations: [
        {
          op: "upsert_summary",
          provenance: "host_semantic",
          content: "# AI Whitepaper Summary\n\nKey finding: atomic workspaces ensure reliability.\n",
        },
      ],
      state_changes: [
        {
          op: "create",
          path: "tasks/TASK-AI-01.md",
          content: "# TASK-AI-01: Implement atomic resource plane\n\nDerived from reading whitepaper.\n",
        },
      ],
      summary: "Capture whitepaper and create derived action task",
    });

    expect(capture.ok).toBe(true);
    const changed = capture.changed_files as string[];

    // Both resource artifact and task file are in the SAME commit!
    expect(changed.some((f) => f.startsWith("resources/res-"))).toBe(true);
    expect(changed).toContain("tasks/TASK-AI-01.md");

    const taskContent = await readFile(path.join(item.config.repoDir, "tasks/TASK-AI-01.md"), "utf8");
    expect(taskContent).toContain("TASK-AI-01: Implement atomic resource plane");
  });
});
