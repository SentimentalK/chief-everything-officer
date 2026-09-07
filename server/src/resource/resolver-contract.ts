import * as z from "zod/v4";

export const fetchStatusSchema = z.enum(["ok", "blocked", "timeout", "network_error"]);
export type FetchStatus = z.infer<typeof fetchStatusSchema>;

export const diagnosticsSchema = z.object({
  strategy: z.string().min(1),
  fetch_status: fetchStatusSchema,
  http_status: z.number().int().nullish(),
  code: z.string().nullish(),
});

export type Diagnostics = z.infer<typeof diagnosticsSchema>;

export const contentMetadataV1Schema = z.object({
  schema_version: z.literal(1),
  source_type: z.string().min(1),
  source_url: z.string().min(1),
  canonical_url: z.string().nullish(),
  source_id: z.string().nullish(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  creator: z.string().nullish(),
  published_at: z.string().nullish(),
  duration_seconds: z.number().int().nullish(),
  language: z.string().nullish(),
  thumbnail_url: z.string().nullish(),
  view_count: z.unknown().nullish(),
  like_count: z.unknown().nullish(),
  comment_count: z.unknown().nullish(),
  captured_at: z.string().min(1),
  platform_metadata: z.record(z.string(), z.unknown()).nullish(),
});

export type ContentMetadataV1 = z.infer<typeof contentMetadataV1Schema>;

export const resolutionOutcomeSchema = z.object({
  status: z.enum(["resolved", "unavailable"]),
  fields_resolved: z.array(z.string()),
  metadata: contentMetadataV1Schema,
  diagnostics: diagnosticsSchema,
});

export type ResolutionOutcome = z.infer<typeof resolutionOutcomeSchema>;
