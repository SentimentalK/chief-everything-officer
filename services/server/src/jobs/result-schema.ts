import { createHash } from "node:crypto";
import * as z from "zod/v4";
import {
  WORKER_ID_RE,
  ATTEMPT_ID_RE,
  CLAIM_TOKEN_RE,
  isWhitespaceOnly,
  utf8ByteLength,
  type ParseOutcome,
} from "./schema.js";

export const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const MAX_RESULT_CONTENT_BYTES = 8 * 1024 * 1024; // 8 MiB
export const MAX_RESULT_METADATA_STR_BYTES = 1024;
export const MAX_RESULT_LANGUAGE_BYTES = 64;
export const MAX_RESULT_METHOD_BYTES = 128;

export const workerResultMetadataSchema = z
  .object({
    title: z
      .string()
      .min(1, "title must be non-empty")
      .refine((s) => !isWhitespaceOnly(s), "title must not be whitespace-only")
      .refine(
        (s) => utf8ByteLength(s) <= MAX_RESULT_METADATA_STR_BYTES,
        "title exceeds 1 KiB",
      )
      .optional(),
    author: z
      .string()
      .min(1, "author must be non-empty")
      .refine((s) => !isWhitespaceOnly(s), "author must not be whitespace-only")
      .refine(
        (s) => utf8ByteLength(s) <= MAX_RESULT_METADATA_STR_BYTES,
        "author exceeds 1 KiB",
      )
      .optional(),
    published_at: z
      .string()
      .regex(RFC3339_RE, "published_at must be RFC3339")
      .optional(),
    language: z
      .string()
      .min(1, "language must be non-empty")
      .refine((s) => !isWhitespaceOnly(s), "language must not be whitespace-only")
      .refine(
        (s) => utf8ByteLength(s) <= MAX_RESULT_LANGUAGE_BYTES,
        "language exceeds 64 bytes",
      )
      .optional(),
  })
  .strict();

export type WorkerResultMetadata = z.infer<typeof workerResultMetadataSchema>;

export const workerResultExtractionSchema = z
  .object({
    method: z
      .string()
      .min(1, "method must be non-empty")
      .refine((s) => !isWhitespaceOnly(s), "method must not be whitespace-only")
      .refine(
        (s) => utf8ByteLength(s) <= MAX_RESULT_METHOD_BYTES,
        "method exceeds 128 bytes",
      ),
    extracted_at: z
      .string()
      .regex(RFC3339_RE, "extracted_at must be RFC3339"),
  })
  .strict();

export type WorkerResultExtraction = z.infer<typeof workerResultExtractionSchema>;

export const workerResultPayloadSchema = z
  .object({
    content: z
      .string()
      .min(1, "content must be non-empty")
      .refine((s) => !isWhitespaceOnly(s), "content must not be whitespace-only")
      .refine(
        (s) => utf8ByteLength(s) <= MAX_RESULT_CONTENT_BYTES,
        "content exceeds 8 MiB",
      ),
    metadata: workerResultMetadataSchema.optional(),
    extraction: workerResultExtractionSchema.optional(),
  })
  .strict();

export type WorkerResultPayload = z.infer<typeof workerResultPayloadSchema>;

export const workerResultRequestSchema = z
  .object({
    worker_id: z.string().regex(WORKER_ID_RE, "worker_id must be a wrk-<uuid>"),
    attempt_id: z.string().regex(ATTEMPT_ID_RE, "attempt_id must be a UUID"),
    claim_token: z.string().regex(CLAIM_TOKEN_RE, "claim_token must be 64 lowercase hex chars"),
    payload: workerResultPayloadSchema,
  })
  .strict();

export type WorkerResultRequest = z.infer<typeof workerResultRequestSchema>;

export function parseResultRequest(raw: unknown): ParseOutcome<WorkerResultRequest> {
  const parsed = workerResultRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const issue = first ? first.message : "validation failed";
    return { ok: false, issue, reason: "INVALID_INPUT" };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Deterministic canonical SHA-256 digest over normalized payload keys.
 */
export function canonicalResultPayloadDigest(payload: WorkerResultPayload): string {
  const norm: Record<string, unknown> = {
    content: payload.content,
  };

  if (payload.extraction) {
    norm.extraction = {
      extracted_at: payload.extraction.extracted_at,
      method: payload.extraction.method,
    };
  }

  if (payload.metadata) {
    const m: Record<string, string> = {};
    if (payload.metadata.author !== undefined) m.author = payload.metadata.author;
    if (payload.metadata.language !== undefined) m.language = payload.metadata.language;
    if (payload.metadata.published_at !== undefined) m.published_at = payload.metadata.published_at;
    if (payload.metadata.title !== undefined) m.title = payload.metadata.title;
    norm.metadata = m;
  }

  const json = JSON.stringify(norm);
  return createHash("sha256").update(json, "utf8").digest("hex");
}
