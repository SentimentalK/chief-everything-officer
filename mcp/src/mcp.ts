import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";
import { safeError } from "./errors.js";
import { LIMITS } from "./limits.js";
import type { ChangeOperation, CeoWorkspace } from "./workspace.js";
import { type ProductPolicy, getPolicy } from "./product-policy.js";
import type { AuditStore } from "./audit.js";
import { BUILD_INFO } from "./build-info.js";
import { ResourceService } from "./resource/service.js";
import { ResourceRetrievalService } from "./resource/retrieval.js";
import { parseMetaMarkdown } from "./resource/meta.js";
import {
  type UrlMetadataResolver,
  createContentResolverClient,
} from "./resource/resolver-client.js";
import type {
  ResourceApplyInput,
  ResourceCaptureInput,
  ResourceGetInput,
  ResourceSearchInput,
} from "./resource/types.js";

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function sanitizeForAudit(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeForAudit);
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === "data_base64" && typeof v === "string") {
      copy[k] = `[omitted base64 payload: ${v.length} chars]`;
    } else {
      copy[k] = sanitizeForAudit(v);
    }
  }
  return copy;
}

function tracedHandler<T>(
  auditStore: AuditStore | undefined,
  toolName: string,
  operation: (input: T) => Promise<Record<string, unknown>>,
) {
  return async (input: T) => {
    const timestamp_ms = Date.now();
    const start = performance.now();
    let res: ReturnType<typeof result>;
    let status: "success" | "error" = "success";
    let errorMessage: string | null = null;
    let rawResult: Record<string, unknown>;

    try {
      rawResult = await operation(input);
      res = result(rawResult);
    } catch (error) {
      status = "error";
      rawResult = safeError(error);
      res = result(rawResult, true);
      errorMessage = typeof (rawResult as Record<string, unknown>).message === "string"
        ? ((rawResult as Record<string, unknown>).message as string)
        : String(error);
    }

    const latency_ms = Math.round(performance.now() - start);

    if (auditStore) {
      try {
        let operationRequestId: string | null = null;
        if (rawResult && typeof rawResult.request_id === "string") {
          operationRequestId = rawResult.request_id;
        } else if (input && typeof (input as Record<string, unknown>).request_id === "string") {
          operationRequestId = (input as Record<string, unknown>).request_id as string;
        }

        let affectedPaths: string[] | null = null;
        let resultingCommit: string | null = null;

        if (toolName === "apply_change_set") {
          const changeInput = input as { operations?: ChangeOperation[] };
          if (changeInput && Array.isArray(changeInput.operations)) {
            affectedPaths = changeInput.operations.map((op) => {
              if (op.op === "move") return `${op.path} -> ${op.target}`;
              if (op.op === "delete") return `${op.path} (deleted)`;
              return op.path;
            });
          }
          if (rawResult && typeof rawResult.commit === "string") {
            resultingCommit = rawResult.commit as string;
          }
        } else if (toolName === "resource_capture" || toolName === "resource_apply") {
          if (rawResult && Array.isArray(rawResult.changed_files)) {
            affectedPaths = rawResult.changed_files as string[];
          }
          if (rawResult && typeof rawResult.commit === "string") {
            resultingCommit = rawResult.commit as string;
          }
        }

        auditStore.recordTrace({
          timestamp_ms,
          tool_name: toolName,
          status,
          error_message: errorMessage,
          operation_request_id: operationRequestId,
          input_json: JSON.stringify(sanitizeForAudit(input) ?? {}),
          output_json: JSON.stringify(res),
          semantic_output_json: JSON.stringify(rawResult),
          latency_ms,
          affected_paths: affectedPaths,
          resulting_commit: resultingCommit,
        });
      } catch (auditErr) {
        process.stderr.write(`audit: wrapper failed to dispatch trace: ${auditErr}\n`);
      }
    }

    return res;
  };
}

const createOperation = z.object({
  op: z.literal("create"),
  path: z.string().describe("Allowed CEO Markdown path that does not yet exist"),
  content: z.string().describe("Complete UTF-8 file content"),
});
const replaceOperation = z.object({
  op: z.literal("replace"),
  path: z.string().describe("Allowed CEO Markdown path to replace"),
  expected_blob_oid: z.string().regex(/^[0-9a-f]{40,64}$/),
  content: z.string().describe("Complete replacement UTF-8 content"),
});
const appendOperation = z.object({
  op: z.literal("append"),
  path: z.string().describe("Allowed CEO Markdown path to append to"),
  expected_blob_oid: z.string().regex(/^[0-9a-f]{40,64}$/),
  content: z.string().describe("Text to append verbatim"),
});
const deleteOperation = z.object({
  op: z.literal("delete"),
  path: z.string().describe("Allowed CEO Markdown path to delete"),
  expected_blob_oid: z.string().regex(/^[0-9a-f]{40,64}$/),
});
const moveOperation = z.object({
  op: z.literal("move"),
  path: z.string().describe("Source CEO Markdown path"),
  expected_blob_oid: z.string().regex(/^[0-9a-f]{40,64}$/),
  target: z.string().describe("Destination CEO Markdown path"),
});

const changeOperationSchema = z.discriminatedUnion("op", [
  createOperation,
  replaceOperation,
  appendOperation,
  deleteOperation,
  moveOperation,
]);

const attachSourceAssetOp = z.object({
  op: z.literal("attach_source_asset"),
  filename: z.string().min(1),
  mime_type: z.string().min(1),
  data_base64: z.string().min(1),
});
const upsertEvidenceOp = z.object({
  op: z.literal("upsert_evidence"),
  provenance: z.enum(["host_exact", "trusted_adapter", "worker"]),
  content: z.string(),
});
const upsertContentOp = z.object({
  op: z.literal("upsert_content"),
  provenance: z.enum(["host_exact", "trusted_adapter", "worker"]),
  content: z.string(),
});
const upsertSummaryOp = z.object({
  op: z.literal("upsert_summary"),
  provenance: z.enum(["host_exact", "host_semantic", "trusted_adapter", "worker"]),
  content: z.string(),
});
const appendInteractionOp = z.object({
  op: z.literal("append_interaction"),
  provenance: z.enum(["host_exact", "host_semantic", "trusted_adapter", "worker"]),
  entry: z.string().min(1),
});
const patchTopicsOp = z.object({
  op: z.literal("patch_topics"),
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
  set: z.array(z.string()).optional(),
});

const resourceApplyOperationSchema = z.discriminatedUnion("op", [
  attachSourceAssetOp,
  upsertEvidenceOp,
  upsertContentOp,
  upsertSummaryOp,
  appendInteractionOp,
  patchTopicsOp,
]);

export function createMcpServer(
  workspace: CeoWorkspace,
  productPolicy: ProductPolicy,
  auditStore?: AuditStore,
  resolverClient?: UrlMetadataResolver,
): McpServer {
  const resourceService = new ResourceService(
    workspace,
    workspace.config,
    resolverClient ?? createContentResolverClient(workspace.config),
  );
  const resourceRetrieval = new ResourceRetrievalService(workspace, workspace.config);

  const server = new McpServer(
    { name: "ceo-mcp", version: BUILD_INFO.version },
    {
      instructions: productPolicy.bootstrap,
    },
  );

  // 1. workspace_status
  server.registerTool("workspace_status", {
    title: "CEO workspace status",
    description: "Use this to verify that the CEO Git workspace is clean, synchronized, and ready before a workflow.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, tracedHandler(auditStore, "workspace_status", async () => {
    const status = await workspace.workspaceStatus();
    return {
      version: BUILD_INFO.version,
      build: BUILD_INFO.build,
      ...status,
    };
  }));

  // 2. list_files
  server.registerTool("list_files", {
    title: "List CEO files",
    description: "Use this to discover allowed CEO Markdown files. Prefer the narrowest known directory prefix. Unscoped listing is for workspace discovery when the relevant area is unknown or ambiguous.",
    inputSchema: {
      prefix: z
        .string()
        .max(240)
        .optional()
        .default("")
        .describe(
          'Directory scope to browse, for example "tasks/" or "inbox/game/". This is not a filename-prefix search. If you know a literal filename fragment, ticket ID, or keyword but not the exact path, prefer search_text scoped to the relevant area.',
        ),
      recursive: z.boolean().optional().default(false),
      limit: z.number().int().min(1).max(500).optional().default(LIMITS.maxSearchResults),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, tracedHandler(auditStore, "list_files", async ({ prefix, recursive, limit }: { prefix: string; recursive: boolean; limit: number }) =>
    await workspace.listFiles(prefix, recursive, limit)));

  // 3. read_files
  server.registerTool("read_files", {
    title: "Read CEO files",
    description: `Use this to read up to ${LIMITS.maxFilesPerRead} related CEO Markdown files in one call and obtain the base commit and blob OIDs needed for safe writes.`,
    inputSchema: { paths: z.array(z.string()).min(1).max(LIMITS.maxFilesPerRead) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, tracedHandler(auditStore, "read_files", async ({ paths }: { paths: string[] }) => await workspace.readFiles(paths)));

  // 4. search_text
  server.registerTool("search_text", {
    title: "Search CEO text",
    description: "Use this for literal text search inside allowed CEO Markdown files. Regular expressions are not supported. Excludes resources/ by default unless explicitly scoped.",
    inputSchema: {
      query: z.string().min(1).max(LIMITS.maxSearchQueryBytes),
      prefixes: z.array(z.string()).max(LIMITS.maxFilesPerRead).optional().default([]),
      limit: z.number().int().min(1).max(200).optional().default(100),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, tracedHandler(auditStore, "search_text", async ({ query, prefixes, limit }: { query: string; prefixes: string[]; limit: number }) =>
    await workspace.searchText(query, prefixes, limit)));

  // 5. apply_change_set
  server.registerTool("apply_change_set", {
    title: "Apply an atomic CEO change set",
    description:
      "Use this for generic CEO State/workspace Markdown updates outside Resource semantic storage. This tool cannot mutate resources/**. Use resource_capture for new Resources or resource_apply for existing Resources. The server checks optimistic concurrency, creates one commit, fast-forward pushes main, and verifies the result. Never use it with a stale base commit.",
    inputSchema: {
      request_id: z.uuid().optional().describe("Stable UUID for retry-safe idempotency; reuse it when retrying the identical request"),
      base_commit: z.string().regex(/^[0-9a-f]{40,64}$/),
      summary: z.string().min(1).max(120),
      operations: z.array(changeOperationSchema).min(1).max(LIMITS.maxOperationsPerTransaction),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, tracedHandler(auditStore, "apply_change_set", async (input: { request_id?: string; base_commit: string; summary: string; operations: ChangeOperation[] }) =>
    await workspace.applyChangeSet(input)));

  // 6. policy_read
  server.registerTool("policy_read", {
    title: "Read CEO runtime product policy",
    description: "Use this to read runtime-owned default policy documents (e.g. 'tasks', 'personal', 'journal', 'resources'). Does not read user workspace files. Returns NO_DEFAULT_POLICY for unknown areas.",
    inputSchema: {
      name: z.string().min(1).max(64).describe("Policy document name to look up in runtime defaults, e.g. 'tasks', 'personal', 'journal', 'resources'"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, tracedHandler(auditStore, "policy_read", async ({ name }: { name: string }) => getPolicy(productPolicy, name)));

  // 7. resource_capture
  server.registerTool("resource_capture", {
    title: "Capture external resource into CEO",
    description:
      "Primary tool for saving, remembering, capturing, or importing an external URL/artifact into CEO. Use this directly when the user asks to save/remember an external source. Do not first browse resources/, inspect old Resource files, read Resource design documents, or manually construct Resource metadata. The server handles source normalization, dedupe, deterministic resolver enrichment, Resource identity, validation, and persistence. Do not pre-search for duplicates before capture; resource_capture performs dedupe server-side.",
    inputSchema: {
      request_id: z.uuid().optional().describe("Stable UUID for retry-safe idempotency"),
      source: z.discriminatedUnion("type", [
        z.object({ type: z.literal("url"), url: z.string() }),
        z.object({ type: z.literal("file_descriptor"), filename: z.string().min(1), mime_type: z.string().nullish(), host_ref: z.string().nullish() }),
        z.object({ type: z.literal("file_inline"), filename: z.string().min(1), mime_type: z.string().min(1), data_base64: z.string().min(1) }),
        z.object({ type: z.literal("external_ref"), provider: z.string().min(1), ref: z.string().min(1), canonical_ref: z.string().nullish() }),
      ]),
      note: z.string().max(2000).optional().describe("User-oriented reason or context for capturing this resource"),
      topics: z.array(z.string().max(60)).max(20).optional().describe("Semantic topic tags for routing and retrieval"),
      initial_operations: z.array(resourceApplyOperationSchema).optional().describe("Initial semantic artifacts or document attachments to save with this capture"),
      state_changes: z.array(changeOperationSchema).max(LIMITS.maxOperationsPerTransaction).optional().describe("Justified State consequences (Personal, Tasks, Journal) to commit atomically in the same transaction"),
      summary: z.string().max(120).optional().describe("Git commit summary for the save transaction"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, tracedHandler(auditStore, "resource_capture", async (input: ResourceCaptureInput) =>
    await resourceService.capture(input)));

  // 8. resource_apply
  server.registerTool("resource_apply", {
    title: "Apply updates to a CEO resource",
    description:
      "Use this to modify an existing CEO Resource after its resource_id is known. Use typed Resource operations for evidence, content, summary, interactions, topics, and source assets. Do not modify Resource artifacts through generic apply_change_set.",
    inputSchema: {
      request_id: z.uuid().optional().describe("Stable UUID for retry-safe idempotency"),
      resource_id: z.string().regex(/^res-[0-9a-f-]{36}$/i).describe("Target resource ID (res-<uuid>)"),
      base_commit: z.string().regex(/^[0-9a-f]{40,64}$/).describe("Base commit hash verified by reader"),
      summary: z.string().min(1).max(120).describe("Git commit summary describing the update"),
      operations: z.array(resourceApplyOperationSchema).min(1).max(20).describe("List of resource operations to apply atomically"),
      state_changes: z.array(changeOperationSchema).max(LIMITS.maxOperationsPerTransaction).optional().describe("Justified State consequences (Personal, Tasks, Journal) to commit atomically in the same transaction"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, tracedHandler(auditStore, "resource_apply", async (input: ResourceApplyInput) =>
    await resourceService.apply(input)));

  // 9. resource_search
  server.registerTool("resource_search", {
    title: "Search CEO resources",
    description:
      "Use resource_search to FIND resources for user retrieval/discovery. Filters by query, topics, stage, platform, kind, and date. Returns lightweight resource summary cards without dumping full bodies. Do not call resource_search merely to check whether a source already exists before resource_capture; capture performs dedupe itself.",
    inputSchema: {
      query: z.string().max(512).optional().describe("Text query matching title, note, topics, or reference"),
      topics: z.array(z.string()).optional().describe("Filter resources containing any of these topics"),
      resource_kind: z.enum(["document", "video", "audio", "image", "webpage", "dataset", "code", "message", "other"]).optional(),
      source_type: z.enum(["url", "file", "external_ref"]).optional(),
      platform: z.string().optional(),
      captured_from: z.string().optional().describe("ISO-8601 start timestamp"),
      captured_to: z.string().optional().describe("ISO-8601 end timestamp"),
      stage: z.enum(["CAPTURED", "EXTRACTED", "NORMALIZED", "READY_FOR_DISCUSSION", "DISCUSSED"]).optional(),
      sort: z.enum(["newest", "oldest"]).optional().default("newest"),
      limit: z.number().int().min(1).max(100).optional().default(20),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, tracedHandler(auditStore, "resource_search", async (input: ResourceSearchInput) =>
    await resourceRetrieval.search(input)));

  // 10. resource_get
  server.registerTool("resource_get", {
    title: "Get CEO resource view",
    description:
      "Use this to inspect a specific Resource's metadata, summary, content, evidence, interactions, or source asset reference. Supports section-based extraction and bounded line pagination.",
    inputSchema: {
      resource_id: z.string().regex(/^res-[0-9a-f-]{36}$/i).describe("Resource ID to read (res-<uuid>)"),
      view: z.enum(["metadata", "summary", "content", "evidence", "interactions", "source"]).optional().default("metadata").describe("Specific artifact or view to inspect"),
      section_ids: z.array(z.string()).optional().describe("Specific section IDs (e.g. ['S001', 'S002']) to filter when reading content"),
      start_line: z.number().int().min(1).optional().default(1).describe("1-indexed starting line for bounded reading"),
      line_count: z.number().int().min(1).max(500).optional().default(200).describe("Number of lines to read"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, tracedHandler(auditStore, "resource_get", async (input: ResourceGetInput) =>
    await resourceRetrieval.get(input)));

  // Register MCP Resource endpoint for source document binary retrieval
  server.registerResource(
    "resource-source",
    new ResourceTemplate("ceo-resource://{resource_id}/source", { list: undefined }),
    {
      title: "CEO Resource Source Asset",
      description: "Read stored original document source asset for a CEO Resource.",
    },
    async (uri, { resource_id }) => {
      const resId = String(resource_id);
      if (!/^res-[0-9a-f-]{36}$/i.test(resId)) {
        throw new Error(`Invalid resource_id format: ${resId}`);
      }
      const metaPath = path.join(workspace.config.repoDir, "resources", resId, "meta.md");
      const metaContent = await readFile(metaPath, "utf8").catch(() => null);
      if (!metaContent) {
        throw new Error(`Resource '${resId}' not found.`);
      }
      const { meta } = parseMetaMarkdown(metaContent);
      if (!meta.asset_ref) {
        throw new Error(`Resource '${resId}' does not have a stored source asset.`);
      }
      const sourceFilePath = path.join(workspace.config.repoDir, "resources", resId, meta.asset_ref);
      const data = await readFile(sourceFilePath);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: meta.media_type || "application/octet-stream",
            blob: data.toString("base64"),
          },
        ],
      };
    },
  );

  return server;
}
