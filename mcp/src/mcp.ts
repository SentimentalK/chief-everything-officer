import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { safeError } from "./errors.js";
import { LIMITS } from "./limits.js";
import type { ChangeOperation, LifeOSWorkspace } from "./workspace.js";

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function handler<T>(operation: (input: T) => Promise<Record<string, unknown>>) {
  return async (input: T) => {
    try { return result(await operation(input)); }
    catch (error) { return result(safeError(error), true); }
  };
}

const createOperation = z.object({
  op: z.literal("create"),
  path: z.string().describe("Allowed LifeOS Markdown path that does not yet exist"),
  content: z.string().describe("Complete UTF-8 file content"),
});
const replaceOperation = z.object({
  op: z.literal("replace"),
  path: z.string(),
  expected_blob_oid: z.string().regex(/^[0-9a-f]{40,64}$/),
  content: z.string().describe("Complete replacement UTF-8 content"),
});
const appendOperation = z.object({
  op: z.literal("append"),
  path: z.literal("JOURNAL.md"),
  expected_blob_oid: z.string().regex(/^[0-9a-f]{40,64}$/),
  content: z.string().describe("Text to append verbatim"),
});
const archiveOperation = z.object({
  op: z.literal("archive"),
  path: z.string().describe("Source tasks/ Markdown path"),
  expected_blob_oid: z.string().regex(/^[0-9a-f]{40,64}$/),
  target: z.string().describe("Destination archive/<path> path"),
});

export function createMcpServer(workspace: LifeOSWorkspace): McpServer {
  const server = new McpServer(
    { name: "lifeos-workspace", version: "0.1.0" },
    {
      instructions:
        "LifeOS is a Git-backed private planning workspace. Read SYSTEM.md, TODO.md, and relevant tickets before writing. Use one apply_change_set per logical update, pass the base commit and blob OIDs returned by read_files, and retry stale revisions only after re-reading.",
    },
  );

  server.registerTool("workspace_status", {
    title: "LifeOS workspace status",
    description: "Use this to verify that the LifeOS Git workspace is clean, synchronized, and ready before a workflow.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, handler(async () => await workspace.workspaceStatus()));

  server.registerTool("list_files", {
    title: "List LifeOS files",
    description: "Use this to discover allowed LifeOS Markdown files. It never exposes code, secrets, or Git metadata.",
    inputSchema: {
      prefix: z.string().max(240).optional().default(""),
      limit: z.number().int().min(1).max(500).optional().default(LIMITS.maxSearchResults),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, handler(async ({ prefix, limit }: { prefix: string; limit: number }) => await workspace.listFiles(prefix, limit)));

  server.registerTool("read_files", {
    title: "Read LifeOS files",
    description: `Use this to read up to ${LIMITS.maxFilesPerRead} related LifeOS Markdown files in one call and obtain the base commit and blob OIDs needed for safe writes.`,
    inputSchema: { paths: z.array(z.string()).min(1).max(LIMITS.maxFilesPerRead) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, handler(async ({ paths }: { paths: string[] }) => await workspace.readFiles(paths)));

  server.registerTool("search_text", {
    title: "Search LifeOS text",
    description: "Use this for literal text search inside allowed LifeOS Markdown files. Regular expressions are not supported.",
    inputSchema: {
      query: z.string().min(1).max(LIMITS.maxSearchQueryBytes),
      prefixes: z.array(z.string()).max(LIMITS.maxFilesPerRead).optional().default([]),
      limit: z.number().int().min(1).max(200).optional().default(100),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, handler(async ({ query, prefixes, limit }: { query: string; prefixes: string[]; limit: number }) =>
    await workspace.searchText(query, prefixes, limit)));

  server.registerTool("apply_change_set", {
    title: "Apply an atomic LifeOS change set",
    description:
      "Use this once for one complete LifeOS update. The server checks optimistic concurrency, edits only allowlisted Markdown, creates one commit, fast-forward pushes main, and verifies the result. Never use it with a stale base commit.",
    inputSchema: {
      request_id: z.uuid().optional().describe("Stable UUID for retry-safe idempotency; reuse it when retrying the identical request"),
      base_commit: z.string().regex(/^[0-9a-f]{40,64}$/),
      summary: z.string().min(1).max(120),
      operations: z.array(z.discriminatedUnion("op", [createOperation, replaceOperation, appendOperation, archiveOperation])).min(1).max(LIMITS.maxOperationsPerTransaction),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, handler(async (input: { request_id?: string; base_commit: string; summary: string; operations: ChangeOperation[] }) =>
    await workspace.applyChangeSet(input)));

  return server;
}
