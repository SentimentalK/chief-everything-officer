import express from "express";
import type { RequestHandler } from "express";
import { LIMITS } from "../limits.js";

/**
 * Worst-case wire expansion caused by JSON string escaping.
 *
 * JSON.stringify serializes control characters U+0000..U001F (1 decoded byte)
 * as six-byte `\uXXXX` sequences. No other escape expands more: `\\`, `\"` and
 * the short escapes (`\n`, `\t`, ...) are 2 bytes, and multi-byte UTF-8
 * characters expand at most 2x (`\uXXXX` per 3-byte BMP character). 6x is
 * therefore the true worst case per decoded byte of file content.
 */
const JSON_ESCAPE_WORST_CASE_EXPANSION = 6;

/**
 * Envelope headroom on top of the escaped write content: JSON-RPC/MCP framing
 * (jsonrpc/method/id/params) plus up to LIMITS.maxOperationsPerTransaction
 * operation objects with their op/path/summary fields. Real framing is a few
 * KiB at most; 64 KiB is a round budget that keeps the transport cap
 * independent of schema-detail churn.
 */
const MCP_FRAMING_HEADROOM_BYTES = 64 * 1024;

/**
 * Maximum HTTP body size accepted on the /mcp MCP endpoint.
 *
 * The workspace business contract allows one atomic apply_change_set request
 * to carry up to LIMITS.maxTotalWriteBytes (2 MiB) of decoded file content
 * (LIMITS.maxOperationsPerTransaction operations, each within
 * LIMITS.maxFileWriteBytes). Before workspace validation runs, that content
 * travels inside a JSON string, where worst-case escaping can expand it to
 * 12 MiB on the wire. This cap is derived from that contract plus the framing
 * headroom so a fully legal transaction is never transport-rejected with
 * HTTP 413. Base64 inline captures (4/3 expansion of a 2 MiB file ≈ 2.7 MiB)
 * also fit comfortably.
 *
 * Transport capacity is NOT write authorization: workspace-level
 * maxTotalWriteBytes / maxFileWriteBytes limits still reject oversized writes
 * at the business layer after transport accepts the request.
 */
export const MCP_MAX_REQUEST_BYTES =
  LIMITS.maxTotalWriteBytes * JSON_ESCAPE_WORST_CASE_EXPANSION + MCP_FRAMING_HEADROOM_BYTES;

const MCP_PATH = /^\/mcp\/?$/;
const CONNECTOR_MANAGED_RESULT_PATH = /^\/api\/connector\/jobs\/[^/]+\/result$/;

/**
 * Route-aware JSON body parser:
 * - /mcp gets an explicit larger limit (MCP_MAX_REQUEST_BYTES) sized for the
 *   2 MiB atomic change-set contract plus envelope/escaping overhead.
 * - /api/connector/jobs/:job_id/result is skipped; that route owns its own
 *   route-scoped 3 MiB parser (see src/jobs/v2-router.ts).
 * - Every other JSON route keeps Express's default 100 KiB limit.
 */
export function createRouteAwareJsonParser(): RequestHandler {
  const mcpJsonParser = express.json({ limit: MCP_MAX_REQUEST_BYTES });
  const ordinaryJsonParser = express.json(); // Express default: 100 KiB
  return (req, res, next) => {
    if (MCP_PATH.test(req.path)) {
      mcpJsonParser(req, res, next);
      return;
    }
    if (CONNECTOR_MANAGED_RESULT_PATH.test(req.path)) {
      next();
      return;
    }
    ordinaryJsonParser(req, res, next);
  };
}