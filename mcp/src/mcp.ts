import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { safeError } from "./errors.js";
import { LIMITS } from "./limits.js";
import type { ChangeOperation, CeoWorkspace } from "./workspace.js";
import { type ProductPolicy, getPolicy } from "./product-policy.js";
import type { AuditStore } from "./audit.js";
import { BUILD_INFO } from "./build-info.js";

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
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
        }

        auditStore.recordTrace({
          timestamp_ms,
          tool_name: toolName,
          status,
          error_message: errorMessage,
          operation_request_id: operationRequestId,
          input_json: JSON.stringify(input ?? {}),
          output_json: JSON.stringify(res),
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

export function createMcpServer(
  workspace: CeoWorkspace,
  productPolicy: ProductPolicy,
  auditStore?: AuditStore,
): McpServer {
  const server = new McpServer(
    { name: "ceo-state-mcp", version: BUILD_INFO.version },
    {
      instructions: productPolicy.bootstrap,
    },
  );

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

  server.registerTool("list_files", {
    title: "List CEO files",
    description: "Use this to discover allowed CEO Markdown files. It never exposes code, secrets, or Git metadata.",
    inputSchema: {
      prefix: z.string().max(240).optional().default(""),
      limit: z.number().int().min(1).max(500).optional().default(LIMITS.maxSearchResults),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, tracedHandler(auditStore, "list_files", async ({ prefix, limit }: { prefix: string; limit: number }) => await workspace.listFiles(prefix, limit)));

  server.registerTool("read_files", {
    title: "Read CEO files",
    description: `Use this to read up to ${LIMITS.maxFilesPerRead} related CEO Markdown files in one call and obtain the base commit and blob OIDs needed for safe writes.`,
    inputSchema: { paths: z.array(z.string()).min(1).max(LIMITS.maxFilesPerRead) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, tracedHandler(auditStore, "read_files", async ({ paths }: { paths: string[] }) => await workspace.readFiles(paths)));

  server.registerTool("search_text", {
    title: "Search CEO text",
    description: "Use this for literal text search inside allowed CEO Markdown files. Regular expressions are not supported.",
    inputSchema: {
      query: z.string().min(1).max(LIMITS.maxSearchQueryBytes),
      prefixes: z.array(z.string()).max(LIMITS.maxFilesPerRead).optional().default([]),
      limit: z.number().int().min(1).max(200).optional().default(100),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, tracedHandler(auditStore, "search_text", async ({ query, prefixes, limit }: { query: string; prefixes: string[]; limit: number }) =>
    await workspace.searchText(query, prefixes, limit)));

  server.registerTool("apply_change_set", {
    title: "Apply an atomic CEO change set",
    description:
      "Use this once for one complete CEO update. The server checks optimistic concurrency, edits safe Markdown outside runtime- or workspace-excluded paths, creates one commit, fast-forward pushes main, and verifies the result. Never use it with a stale base commit.",
    inputSchema: {
      request_id: z.uuid().optional().describe("Stable UUID for retry-safe idempotency; reuse it when retrying the identical request"),
      base_commit: z.string().regex(/^[0-9a-f]{40,64}$/),
      summary: z.string().min(1).max(120),
      operations: z.array(z.discriminatedUnion("op", [createOperation, replaceOperation, appendOperation, deleteOperation, moveOperation])).min(1).max(LIMITS.maxOperationsPerTransaction),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, tracedHandler(auditStore, "apply_change_set", async (input: { request_id?: string; base_commit: string; summary: string; operations: ChangeOperation[] }) =>
    await workspace.applyChangeSet(input)));

  server.registerTool("policy_read", {
    title: "Read CEO runtime product policy",
    description: "Use this to read runtime-owned default policy documents (e.g. 'tasks', 'personal', 'journal'). Does not read user workspace files. Returns NO_DEFAULT_POLICY for unknown areas.",
    inputSchema: {
      name: z.string().min(1).max(64).describe("Policy document name to look up in runtime defaults, e.g. 'tasks', 'personal', 'journal'"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, tracedHandler(auditStore, "policy_read", async ({ name }: { name: string }) => getPolicy(productPolicy, name)));

  return server;
}
