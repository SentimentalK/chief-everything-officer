import yaml from "yaml";
import type {
  MetadataAttemptRecord,
  MetadataAttemptStatus,
  NamingSource,
  ResourceMeta,
  ResourceStage,
} from "./types.js";
import { CeoError } from "../errors.js";

export interface ParsedMetaDocument {
  meta: ResourceMeta;
  heading: string | null;
  capture_note: string | null;
  capture_history: string[];
}

export function parseMetaMarkdown(content: string): ParsedMetaDocument {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    throw new CeoError("INVALID_META", "meta.md does not contain valid YAML frontmatter.");
  }

  const frontmatterRaw = match[1] ?? "";
  const body = match[2] || "";

  let parsed: unknown;
  try {
    parsed = yaml.parse(frontmatterRaw);
  } catch (err) {
    throw new CeoError("INVALID_META", `Failed to parse YAML frontmatter: ${String(err)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new CeoError("INVALID_META", "Parsed frontmatter is not an object.");
  }

  const raw = parsed as Record<string, unknown>;

  const rawDisplayName = raw.display_name != null ? String(raw.display_name).trim() : "";
  const rawTitle = raw.title != null ? String(raw.title).trim() : null;
  const rawOriginalName = raw.original_name != null ? String(raw.original_name).trim() : null;
  const rawPlatformId = raw.platform_id != null ? String(raw.platform_id).trim() : null;
  const rawResourceId = String(raw.resource_id ?? "");

  const displayName = rawDisplayName || rawTitle || rawOriginalName || rawPlatformId || "Untitled Resource";

  const validNamingSources = new Set(["explicit", "title", "fallback"]);
  const namingSource: NamingSource =
    typeof raw.naming_source === "string" && validNamingSources.has(raw.naming_source)
      ? (raw.naming_source as NamingSource)
      : "fallback";

  const sourceAliases = Array.isArray(raw.source_aliases)
    ? raw.source_aliases.map(String)
    : [];

  let lastMetadataAttempt: MetadataAttemptRecord | null = null;
  if (raw.last_metadata_attempt && typeof raw.last_metadata_attempt === "object") {
    const lma = raw.last_metadata_attempt as Record<string, unknown>;
    const statusStr = String(lma.status || "unavailable");
    const validStatuses = new Set(["resolved", "unavailable", "unsupported", "disabled"]);
    const status = validStatuses.has(statusStr)
      ? (statusStr as MetadataAttemptStatus)
      : "unavailable";

    lastMetadataAttempt = {
      attempted_at: String(lma.attempted_at || new Date().toISOString()),
      status,
      code: lma.code != null ? String(lma.code) : null,
      fields_resolved: Array.isArray(lma.fields_resolved) ? lma.fields_resolved.map(String) : [],
      strategy: lma.strategy != null ? String(lma.strategy) : null,
      http_status: typeof lma.http_status === "number" ? lma.http_status : null,
      request_id: lma.request_id != null ? String(lma.request_id) : null,
    };
  }

  const meta: ResourceMeta = {
    schema_version: 1,
    resource_id: rawResourceId,
    display_name: displayName,
    naming_source: namingSource,
    source_aliases: sourceAliases,
    last_metadata_attempt: lastMetadataAttempt,
    resource_kind: (raw.resource_kind as ResourceMeta["resource_kind"]) ?? "other",
    source_type: (raw.source_type as ResourceMeta["source_type"]) ?? "url",
    source_identity: raw.source_identity != null ? String(raw.source_identity) : null,
    source_ref: raw.source_ref != null ? String(raw.source_ref) : null,
    canonical_ref: raw.canonical_ref != null ? String(raw.canonical_ref) : null,
    platform: raw.platform != null ? String(raw.platform) : null,
    platform_id: rawPlatformId,
    original_name: rawOriginalName,
    media_type: raw.media_type != null ? String(raw.media_type) : null,
    format: raw.format != null ? String(raw.format) : null,
    asset_ref: raw.asset_ref != null ? String(raw.asset_ref) : null,
    source_hash: raw.source_hash != null ? String(raw.source_hash) : null,
    title: rawTitle,
    author: raw.author != null ? String(raw.author) : null,
    published_at: raw.published_at != null ? String(raw.published_at) : null,
    first_captured_at: String(raw.first_captured_at ?? new Date().toISOString()),
    language: raw.language != null ? String(raw.language) : null,
    topics: Array.isArray(raw.topics) ? raw.topics.map(String) : [],
    metadata_method: (raw.metadata_method as ResourceMeta["metadata_method"]) ?? null,
    metadata_fetched_at: raw.metadata_fetched_at != null ? String(raw.metadata_fetched_at) : null,
    capture_surface: String(raw.capture_surface ?? "mcp"),
  };

  // Parse presentation heading from '# Heading' (never overwrites deterministic source meta.title)
  let heading: string | null = null;
  const headingMatch = body.match(/^#\s+(.+)$/m);
  if (headingMatch && headingMatch[1]) {
    heading = headingMatch[1].trim();
  }

  // Parse Capture Note
  let capture_note: string | null = null;
  const noteMatch = body.match(/##\s+Capture Note\r?\n([\s\S]*?)(?=\r?\n##|$)/);
  if (noteMatch && noteMatch[1]) {
    const noteText = noteMatch[1].trim();
    if (noteText) capture_note = noteText;
  }

  // Parse Capture History
  const capture_history: string[] = [];
  const historyMatch = body.match(/##\s+Capture History\r?\n([\s\S]*?)(?=\r?\n##|$)/);
  if (historyMatch && historyMatch[1]) {
    const lines = historyMatch[1].split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        capture_history.push(trimmed.slice(2).trim());
      }
    }
  }

  return { meta, heading, capture_note, capture_history };
}

export function formatMetaMarkdown(
  meta: ResourceMeta,
  captureNote?: string | null,
  captureHistory: string[] = [],
): string {
  const frontmatterData: Record<string, unknown> = {
    schema_version: 1,
    resource_id: meta.resource_id,
    display_name: meta.display_name,
    naming_source: meta.naming_source,
    source_aliases: meta.source_aliases ?? [],
    last_metadata_attempt: meta.last_metadata_attempt ?? null,
    resource_kind: meta.resource_kind,
    source_type: meta.source_type,
    source_identity: meta.source_identity,
    source_ref: meta.source_ref,
    canonical_ref: meta.canonical_ref,
    platform: meta.platform,
    platform_id: meta.platform_id,
    original_name: meta.original_name,
    media_type: meta.media_type,
    format: meta.format,
    asset_ref: meta.asset_ref,
    source_hash: meta.source_hash,
    title: meta.title,
    author: meta.author,
    published_at: meta.published_at,
    first_captured_at: meta.first_captured_at,
    language: meta.language,
    topics: meta.topics ?? [],
    metadata_method: meta.metadata_method,
    metadata_fetched_at: meta.metadata_fetched_at,
    capture_surface: meta.capture_surface ?? "mcp",
  };

  const yamlStr = yaml.stringify(frontmatterData, {
    nullStr: "null",
  });

  const heading = meta.display_name || meta.title || meta.original_name || meta.canonical_ref || meta.resource_id;

  let doc = `---\n${yamlStr}---\n\n# ${heading}\n\n## Capture Note\n\n`;
  doc += (captureNote && captureNote.trim()) ? `${captureNote.trim()}\n\n` : `\n`;
  doc += `## Capture History\n\n`;

  if (captureHistory.length > 0) {
    for (const entry of captureHistory) {
      doc += `- ${entry}\n`;
    }
  } else {
    doc += `- ${meta.first_captured_at} — first_capture\n`;
  }

  return doc;
}

export function deriveResourceStage(
  existingArtifacts: Set<string>,
  interactionsContent?: string | null,
): ResourceStage {
  if (existingArtifacts.has("interactions.md")) {
    const content = (interactionsContent || "").trim();
    // Check if interactions has actual recorded episode (e.g. beyond just header)
    if (content.length > 0 && /##\s+|-\s+\d{4}/.test(content)) {
      return "DISCUSSED";
    }
  }
  if (existingArtifacts.has("summary.md")) {
    return "READY_FOR_DISCUSSION";
  }
  if (existingArtifacts.has("content.md")) {
    return "NORMALIZED";
  }
  if (existingArtifacts.has("evidence.md")) {
    return "EXTRACTED";
  }
  return "CAPTURED";
}
