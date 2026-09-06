import * as z from "zod/v4";

/**
 * Content Resolver V1 Wire Contract Response Schema.
 * Validates responses from POST /v1/resolve.
 */
export const contentMetadataV1Schema = z.object({
  schema_version: z.literal(1),
  source_type: z.string().min(1),
  source_url: z.string().min(1),
  canonical_url: z.string().nullish(),
  source_id: z.string().nullish(),
  title: z.string().nullish(),
  creator: z.string().nullish(),
  published_at: z.string().nullish(),
  language: z.string().nullish(),
  captured_at: z.string().nullish(),
}).passthrough();

export type ContentMetadataV1 = z.infer<typeof contentMetadataV1Schema>;

/**
 * Content Resolver V1 Wire Contract Error Schema.
 */
export const resolverErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string().optional(),
  }),
}).passthrough();

export type ResolverErrorResponse = z.infer<typeof resolverErrorResponseSchema>;
