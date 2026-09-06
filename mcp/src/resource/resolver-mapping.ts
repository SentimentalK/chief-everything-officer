import type { ContentMetadataV1 } from "./resolver-contract.js";
import type { NormalizedUrlResult } from "./identity.js";
import type { ResourceKind, ResourceMeta } from "./types.js";

/**
 * Validates provider token (source_type), e.g. youtube, bilibili, weixin.
 * Must start with alphanumeric, followed by up to 63 alphanumeric, dot, underscore, or hyphen characters.
 */
export function isValidProviderToken(token: string | null | undefined): boolean {
  if (!token || typeof token !== "string") return false;
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(token);
}

/**
 * Validates source_id. Must be non-empty, bounded length (<= 256), and have no control characters.
 */
export function isValidSourceId(id: string | null | undefined): boolean {
  if (!id || typeof id !== "string") return false;
  return id.length > 0 && id.length <= 256 && !/[\x00-\x1f\x7f]/.test(id);
}

/**
 * Validates canonical URL. Must be an absolute http: or https: URL.
 */
export function isValidCanonicalUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Two-stage identity derivation.
 * If trusted resolver returns a valid source_type and stable source_id,
 * returns `<source_type>:<source_id>`. Otherwise falls back to baseline identity.
 */
export function derivePreferredIdentity(
  baselineIdentity: string,
  metadata?: ContentMetadataV1 | null,
): string {
  if (
    metadata &&
    isValidProviderToken(metadata.source_type) &&
    isValidSourceId(metadata.source_id)
  ) {
    return `${metadata.source_type.toLowerCase()}:${metadata.source_id}`;
  }
  return baselineIdentity;
}

export interface ResolvedMetadataSeed {
  canonical_ref: string | null;
  platform: string | null;
  platform_id: string | null;
  title: string | null;
  author: string | null;
  published_at: string | null;
  language: string | null;
  metadata_fetched_at: string | null;
  metadata_method: "deterministic_adapter" | null;
  resource_kind: ResourceKind;
}

/**
 * Builds metadata seed for a URL capture.
 * If resolver successfully returned valid ContentMetadataV1, maps trusted stable fields.
 * If resolver was unavailable/unsupported/disabled, preserves strict nulls.
 */
export function buildResolvedMetadataSeed(
  baseline: NormalizedUrlResult,
  metadata?: ContentMetadataV1 | null,
): ResolvedMetadataSeed {
  if (!metadata) {
    return {
      canonical_ref: baseline.canonical_ref,
      platform: baseline.platform,
      platform_id: baseline.platform_id,
      title: null,
      author: null,
      published_at: null,
      language: null,
      metadata_fetched_at: null,
      metadata_method: null,
      resource_kind: baseline.resource_kind,
    };
  }

  const validPlatform = isValidProviderToken(metadata.source_type)
    ? metadata.source_type.toLowerCase()
    : baseline.platform;

  const validPlatformId = isValidSourceId(metadata.source_id)
    ? metadata.source_id!
    : baseline.platform_id;

  const validCanonicalRef = isValidCanonicalUrl(metadata.canonical_url)
    ? metadata.canonical_url!
    : baseline.canonical_ref;

  return {
    canonical_ref: validCanonicalRef,
    platform: validPlatform,
    platform_id: validPlatformId,
    title: metadata.title?.trim() || null,
    author: metadata.creator?.trim() || null,
    published_at: metadata.published_at?.trim() || null,
    language: metadata.language?.trim() || null,
    metadata_fetched_at: metadata.captured_at?.trim() || new Date().toISOString(),
    metadata_method: "deterministic_adapter",
    resource_kind: "video", // Current content.resolve_url capability resolves media/video sources
  };
}

/**
 * Applies non-erasure revisit update to existing ResourceMeta from resolver metadata.
 * Returns true if any semantic metadata field actually changed.
 */
export function applyResolverRevisitUpdates(
  meta: ResourceMeta,
  metadata?: ContentMetadataV1 | null,
): boolean {
  if (!metadata) return false;

  let changed = false;

  // Title: update if new non-null value differs from existing
  if (metadata.title && metadata.title.trim()) {
    const newTitle = metadata.title.trim();
    if (meta.title !== newTitle) {
      meta.title = newTitle;
      changed = true;
    }
  }

  // Author: update if new non-null value differs from existing
  if (metadata.creator && metadata.creator.trim()) {
    const newAuthor = metadata.creator.trim();
    if (meta.author !== newAuthor) {
      meta.author = newAuthor;
      changed = true;
    }
  }

  // Published at: update if new non-null value differs from existing
  if (metadata.published_at && metadata.published_at.trim()) {
    const newPublishedAt = metadata.published_at.trim();
    if (meta.published_at !== newPublishedAt) {
      meta.published_at = newPublishedAt;
      changed = true;
    }
  }

  // Language: update if new non-null value differs from existing
  if (metadata.language && metadata.language.trim()) {
    const newLanguage = metadata.language.trim();
    if (meta.language !== newLanguage) {
      meta.language = newLanguage;
      changed = true;
    }
  }

  // Canonical ref: update if valid canonical URL and differs
  if (isValidCanonicalUrl(metadata.canonical_url)) {
    const newCanonical = metadata.canonical_url!;
    if (meta.canonical_ref !== newCanonical) {
      meta.canonical_ref = newCanonical;
      changed = true;
    }
  }

  // Platform: update if valid and previously null or generic
  if (isValidProviderToken(metadata.source_type)) {
    const newPlatform = metadata.source_type.toLowerCase();
    if (meta.platform !== newPlatform) {
      meta.platform = newPlatform;
      changed = true;
    }
  }

  // Platform id: update if valid and previously null or differs
  if (isValidSourceId(metadata.source_id)) {
    const newPlatformId = metadata.source_id!;
    if (meta.platform_id !== newPlatformId) {
      meta.platform_id = newPlatformId;
      changed = true;
    }
  }

  // If any semantic metadata changed, update metadata_fetched_at and metadata_method
  if (changed) {
    meta.metadata_method = "deterministic_adapter";
    meta.metadata_fetched_at = metadata.captured_at?.trim() || new Date().toISOString();
  }

  return changed;
}
