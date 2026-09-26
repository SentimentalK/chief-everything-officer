import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import path from "node:path";
import * as z from "zod/v4";
import { CeoError, safeError } from "./errors.js";
import { LIMITS } from "./limits.js";
import type { ChangeOperation, CeoWorkspace } from "./workspace.js";
import type { ProductPolicy } from "./product-policy.js";
import { resolveEffectivePolicy } from "./policy-resolver.js";
import type { AuditStore } from "./audit.js";
import type { WorkspaceIdentity } from "./identity/store.js";
import { BUILD_INFO } from "./build-info.js";
import { ResourceService } from "./resource/service.js";
import { ResourceRetrievalService } from "./resource/retrieval.js";
import { parseMetaMarkdown } from "./resource/meta.js";
import { resolveResourceLocationAtSnapshot } from "./resource/locator.js";
import { isAllowedResourceSourcePath } from "./resource/security.js";
import { getTreeEntry, readBlobUtf8, runGitBuffer } from "./git.js";
import {
  type UrlMetadataResolver,
  type ContentResolverConfig,
  createContentResolverClient,
} from "./resource/resolver-client.js";
import type {
  ResourceApplyInput,
  ResourceCaptureInput,
  ResourceDeleteInput,
  ResourceGetInput,
  ResourceSearchInput,
} from "./resource/types.js";
import { registerConnectorJobTools } from "./jobs/v2-tools.js";
import { installJobToolValidationAuditInterceptor } from "./jobs/tool-audit.js";
import type { JobCoordinatorV2 } from "./jobs/v2-service.js";
import type { ConnectorControlStore } from "./connector/control-store.js";
import type { IdentityStore } from "./identity/store.js";

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
  workspaceId: string,
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
      if (!(error instanceof CeoError)) {
        console.error(
          `[CEO MCP] unhandled error in tool '${toolName}':`,
          error instanceof Error ? error.stack || error.message : error,
        );
      }
      rawResult = safeError(error);
      res = result(rawResult, true);
      errorMessage = error instanceof Error
        ? error.message
        : (typeof (rawResult as Record<string, unknown>).message === "string"
            ? ((rawResult as Record<string, unknown>).message as string)
            : String(error));
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
        } else if (toolName === "resource_capture" || toolName === "resource_apply" || toolName === "resource_delete") {
          if (rawResult && Array.isArray(rawResult.changed_files)) {
            affectedPaths = rawResult.changed_files as string[];
          }
          if (rawResult && typeof rawResult.commit === "string") {
            resultingCommit = rawResult.commit as string;
          }
        }

        auditStore.recordTrace({
          workspace_id: workspaceId,
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

const RESOURCE_TIMESTAMP_DESCRIPTION =
  "ISO-8601 timestamp with REQUIRED timezone (YYYY-MM-DDTHH:mm:ssZ or ±HH:mm; optional 1–3 fractional-second digits). Bounds are inclusive and compare against the resource's first_captured_at.";

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
  basis: z.enum(["metadata", "source_content"]).describe("Summary basis: 'metadata' (只依据标题、简介等元数据) or 'source_content' (确实读取了来源内容，不要求保存原文件). Required."),
  content: z.string().min(1).describe("Summary text body (non-empty)"),
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
const renameOp = z.object({
  op: z.literal("rename"),
  display_name: z.string().min(1).max(160).describe("New semantic display name for this Resource. Updates display_name and renames physical directory. Use clean human-readable title, default to user language, without artificial file extensions or hyphenated topics slugs."),
});

const resourceCaptureInitialOperationSchema = z.discriminatedUnion("op", [
  attachSourceAssetOp,
  upsertEvidenceOp,
  upsertContentOp,
  upsertSummaryOp,
  appendInteractionOp,
  patchTopicsOp,
]);

const resourceApplyOperationSchema = z.discriminatedUnion("op", [
  attachSourceAssetOp,
  upsertEvidenceOp,
  upsertContentOp,
  upsertSummaryOp,
  appendInteractionOp,
  patchTopicsOp,
  renameOp,
]);

export function createMcpServer(
  workspace: CeoWorkspace,
  productPolicy: ProductPolicy,
  options: {
    auditStore?: AuditStore;
    resolverClient?: UrlMetadataResolver;
    identity?: WorkspaceIdentity;
    connectorJobs?: {
      coordinator: JobCoordinatorV2 | null;
      controlStore: ConnectorControlStore;
      identityStore: IdentityStore;
    };
    resourceService?: ResourceService;
  } = {},
): McpServer {
  const { auditStore, identity, connectorJobs } = options;
  const workspaceId = identity?.workspace_id ?? "unknown";
  const trace = <T>(toolName: string, op: (input: T) => Promise<Record<string, unknown>>) =>
    tracedHandler(auditStore, workspaceId, toolName, op);

  const resolverClient =
    options.resolverClient ??
    ("contentResolverUrl" in (workspace.config as unknown as Record<string, unknown>)
      ? createContentResolverClient(workspace.config as unknown as ContentResolverConfig)
      : createContentResolverClient());
  const resourceService =
    options.resourceService ??
    new ResourceService(workspace, { resolverClient });
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
  }, trace("workspace_status", async () => {
    const status = await workspace.workspaceStatus();
    return {
      version: BUILD_INFO.version,
      build: BUILD_INFO.build,
      ...(identity ? { user_id: identity.user_id, workspace_id: identity.workspace_id } : {}),
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
  }, trace("list_files", async ({ prefix, recursive, limit }: { prefix: string; recursive: boolean; limit: number }) =>
    await workspace.listFiles(prefix, recursive, limit)));

  // 3. read_files
  server.registerTool("read_files", {
    title: "Read CEO files",
    description:
      `Use this to read up to ${LIMITS.maxFilesPerRead} related CEO Markdown files in one call and obtain the base commit and blob OIDs needed for safe writes. ` +
      "缺失的 `tasks/<filename>.md` 会尝试匹配唯一的 `archive/<year>/<filename>.md`。返回的 `path` 是实际路径，后续写入使用该路径和对应 blob OID。批量读取失败时没有返回任何正文；修正失败路径后重新读取完整批次。",
    inputSchema: { paths: z.array(z.string()).min(1).max(LIMITS.maxFilesPerRead) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, trace("read_files", async ({ paths }: { paths: string[] }) => await workspace.readFiles(paths)));

  // 4. search_text
  server.registerTool("search_text", {
    title: "Search CEO text",
    description:
      "Use this for literal text search inside allowed CEO Markdown files. Regular expressions are not supported. 默认搜索普通 State Markdown 和 Resource interactions；来源 metadata、摘要、正文及 evidence 不在默认范围。查找资料使用 resource_search，读取资料使用 resource_get；明确指定 prefixes 可按需定向搜索。",
    inputSchema: {
      query: z.string().min(1).max(LIMITS.maxSearchQueryBytes),
      prefixes: z.array(z.string()).max(LIMITS.maxFilesPerRead).optional().default([]),
      limit: z.number().int().min(1).max(200).optional().default(100),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, trace("search_text", async ({ query, prefixes, limit }: { query: string; prefixes: string[]; limit: number }) =>
    await workspace.searchText(query, prefixes, limit)));

  // 5. apply_change_set
  server.registerTool("apply_change_set", {
    title: "Apply an atomic CEO change set",
    description:
      "Use this for generic CEO State/workspace Markdown updates outside Resource semantic storage. This tool cannot mutate resources/**. Use resource_capture to create Resources, resource_apply to modify them, and resource_delete to delete them. The server checks optimistic concurrency, creates one commit, fast-forward pushes main, and verifies the result. Never use it with a stale base commit.",
    inputSchema: {
      request_id: z.uuid().optional().describe("Stable UUID for retry-safe idempotency; reuse it when retrying the identical request"),
      base_commit: z.string().regex(/^[0-9a-f]{40,64}$/),
      summary: z.string().min(1).max(120),
      operations: z.array(changeOperationSchema).min(1).max(LIMITS.maxOperationsPerTransaction),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, trace("apply_change_set", async (input: { request_id?: string; base_commit: string; summary: string; operations: ChangeOperation[] }) =>
    await workspace.applyChangeSet(input)));

  // 6. policy_read
  server.registerTool("policy_read", {
    title: "Read CEO effective policy",
    description: "Read CEO effective policy for a semantic area (e.g. 'tasks', 'personal', 'journal', 'decision', 'resources', 'well-being'). Runtime policy and workspace policy composition is resolved by the backend. The returned content is the policy the model should follow. Returns NO_DEFAULT_POLICY when neither runtime nor workspace policy is defined.",
    inputSchema: {
      name: z.string().min(1).max(64).describe("Policy document name to look up, e.g. 'tasks', 'personal', 'journal', 'decision', 'resources', 'well-being'"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, trace("policy_read", async ({ name }: { name: string }) => resolveEffectivePolicy(productPolicy, workspace, name)));

  // 7. resource_capture
  server.registerTool("resource_capture", {
    title: "Capture external resource into CEO",
    description:
      "Primary tool for saving, remembering, capturing, or importing an external URL/artifact into CEO. Use this directly when the user asks to save/remember an external source. New resources are always initially saved under a stable ID directory ('resources/res-...'). Do not browse resources/, inspect old Resource files, read Resource design documents, or manually construct Resource metadata. The server handles normalization, dedupe, deterministic resolver enrichment, Resource identity, validation, and persistence. Do not pre-search for duplicates before capture; resource_capture performs dedupe server-side. After capture, inspect the returned metadata/receipt; if sufficient context exists, invoke resource_apply with op 'rename' to give the resource a clean, concise, retrieval-friendly semantic display name (default to user language). 新资源仅收藏、命名时保持 CAPTURED；已有资源 rename 不改变阶段。重复 capture 可刷新同一资源；检查命名来源，信息足够时继续 rename。",
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
      initial_operations: z.array(resourceCaptureInitialOperationSchema).optional().describe("Initial semantic artifacts or document attachments to save with this capture"),
      state_changes: z.array(changeOperationSchema).max(LIMITS.maxOperationsPerTransaction).optional().describe("Justified State consequences (Personal, Tasks, Journal) to commit atomically in the same transaction"),
      summary: z.string().max(120).optional().describe("Git commit summary for the save transaction"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, trace("resource_capture", async (input: ResourceCaptureInput) =>
    await resourceService.capture(input)));

  // 8. resource_apply
  server.registerTool("resource_apply", {
    title: "Apply updates to a CEO resource",
    description:
      "Use this to modify an existing CEO Resource after its resource_id is known. Use typed Resource operations for evidence, content, summary, interactions, topics, source assets, and rename (to move the physical directory from res-<uuid> to a clean, retrieval-friendly semantic display name). Do not modify Resource artifacts through generic apply_change_set. To permanently delete a resource, use resource_delete. 新资源仅收藏、命名时保持 CAPTURED；已有资源 rename 不改变阶段。rename 同步展示名与实际目录；相同目标可以成功返回无变化。",
    inputSchema: {
      request_id: z.uuid().optional().describe("Stable UUID for retry-safe idempotency"),
      resource_id: z.string().regex(/^res-[0-9a-f-]{36}$/i).describe("Target resource ID (res-<uuid>)"),
      base_commit: z.string().regex(/^[0-9a-f]{40,64}$/).describe("Base commit hash verified by reader"),
      summary: z.string().min(1).max(120).describe("Git commit summary describing the update"),
      operations: z.array(resourceApplyOperationSchema).min(1).max(20).describe("List of resource operations to apply atomically"),
      state_changes: z.array(changeOperationSchema).max(LIMITS.maxOperationsPerTransaction).optional().describe("Justified State consequences (Personal, Tasks, Journal) to commit atomically in the same transaction"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, trace("resource_apply", async (input: ResourceApplyInput) =>
    await resourceService.apply(input)));

  // 9. resource_search
  server.registerTool("resource_search", {
    title: "Search CEO resources",
    description:
      "Use resource_search to FIND resources for user retrieval/discovery. Filters by query, topics, stage, platform, kind, and date. Returns lightweight resource summary cards without dumping full bodies. Do not call resource_search merely to check whether a source already exists before resource_capture; capture performs dedupe itself. 用 naming_source=id 查找尚未语义命名的资源，stage 不用于判断命名是否完成。",
    inputSchema: {
      query: z.string().max(512).optional().describe("Text query matching title, note, topics, or reference"),
      topics: z.array(z.string()).optional().describe("Filter resources containing any of these topics"),
      resource_kind: z.enum(["document", "video", "audio", "image", "webpage", "dataset", "code", "message", "other"]).optional(),
      source_type: z.enum(["url", "file", "external_ref"]).optional(),
      platform: z.string().optional(),
      captured_from: z.string().optional().describe(RESOURCE_TIMESTAMP_DESCRIPTION),
      captured_to: z.string().optional().describe(RESOURCE_TIMESTAMP_DESCRIPTION),
      stage: z.enum(["CAPTURED", "EXTRACTED", "NORMALIZED", "READY_FOR_DISCUSSION", "DISCUSSED"]).optional(),
      naming_source: z.enum(["id", "explicit"]).optional().describe("Filter by naming source: 'id' selects resources not yet semantically named"),
      sort: z.enum(["newest", "oldest"]).optional().default("newest"),
      limit: z.number().int().min(1).max(100).optional().default(20),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, trace("resource_search", async (input: ResourceSearchInput) =>
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
  }, trace("resource_get", async (input: ResourceGetInput) =>
    await resourceRetrieval.get(input)));

  // 11. resource_delete
  server.registerTool("resource_delete", {
    title: "Delete a CEO resource",
    description:
      "Permanently delete an existing CEO Resource and all its owned artifacts from current workspace state. This includes its metadata, summary, content, evidence, interactions, source assets, and directory. Requires an explicit user request or instruction to remove/destroy the resource. The server verifies optimistic concurrency via base_commit, executes atomic deletion, fast-forward pushes main, and returns a deletion receipt. Never delete resources via apply_change_set or filesystem manipulation.",
    inputSchema: {
      request_id: z.uuid().optional().describe("Stable UUID for retry-safe idempotency"),
      resource_id: z.string().regex(/^res-[0-9a-f-]{36}$/i).describe("Target resource ID (res-<uuid>)"),
      base_commit: z.string().regex(/^[0-9a-f]{40,64}$/).describe("Base commit hash verified by reader"),
      summary: z.string().min(1).max(120).describe("Git commit summary describing the deletion"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, trace("resource_delete", async (input: ResourceDeleteInput) =>
    await resourceService.delete(input)));

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
      const snapshot = await workspace.captureReadSnapshot();
      const location = await resolveResourceLocationAtSnapshot(
        workspace.config,
        workspace.config.repoDir,
        snapshot,
        resId,
      );
      if (!location) {
        throw new Error(`Resource '${resId}' not found.`);
      }
      const metaPath = path.posix.join(location.location.relative_path, "meta.md");
      const metaEntry = await getTreeEntry(
        workspace.config,
        workspace.config.repoDir,
        snapshot.commit,
        metaPath,
      );
      if (!metaEntry || metaEntry.type !== "blob") {
        throw new Error(`Resource '${resId}' meta.md not found.`);
      }
      const metaContent = await readBlobUtf8(
        workspace.config,
        workspace.config.repoDir,
        metaEntry.oid,
        metaPath,
      );
      const { meta } = parseMetaMarkdown(metaContent);
      if (!meta.asset_ref) {
        throw new Error(`Resource '${resId}' does not have a stored source asset.`);
      }
      if (!isAllowedResourceSourcePath(meta.asset_ref)) {
        throw new Error(`Resource '${resId}' source asset path is invalid.`);
      }
      const sourceFilePath = path.posix.join(location.location.relative_path, meta.asset_ref);
      const assetEntry = await getTreeEntry(
        workspace.config,
        workspace.config.repoDir,
        snapshot.commit,
        sourceFilePath,
      );
      if (!assetEntry || assetEntry.type !== "blob") {
        throw new Error(`Resource '${resId}' source asset not found.`);
      }
      const { stdout: data } = await runGitBuffer(
        workspace.config,
        workspace.config.repoDir,
        ["cat-file", "blob", assetEntry.oid],
      );
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

  // Connector V2 Job tools (Target discovery & Host Job coordination).
  if (connectorJobs && identity) {
    registerConnectorJobTools(server, {
      coordinator: connectorJobs.coordinator,
      controlStore: connectorJobs.controlStore,
      identityStore: connectorJobs.identityStore,
      scope: { user_id: identity.user_id, workspace_id: identity.workspace_id },
      auditStore: auditStore ?? null,
    });
  }

  if (identity && connectorJobs) {
    installJobToolValidationAuditInterceptor(server, auditStore ?? null, {
      user_id: identity.user_id,
      workspace_id: identity.workspace_id,
    });
  }

  return server;
}
