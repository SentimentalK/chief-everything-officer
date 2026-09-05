import yaml from "yaml";
import type { ResourceMeta, ResourceStage } from "./types.js";
import { CeoError } from "../errors.js";

export interface ParsedMetaDocument {
  meta: ResourceMeta;
  title: string | null;
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

  const meta: ResourceMeta = {
    schema_version: 1,
    resource_id: String(raw.resource_id ?? ""),
    resource_kind: (raw.resource_kind as ResourceMeta["resource_kind"]) ?? "other",
    source_type: (raw.source_type as ResourceMeta["source_type"]) ?? "url",
    source_identity: raw.source_identity != null ? String(raw.source_identity) : null,
    source_ref: raw.source_ref != null ? String(raw.source_ref) : null,
    canonical_ref: raw.canonical_ref != null ? String(raw.canonical_ref) : null,
    platform: raw.platform != null ? String(raw.platform) : null,
    platform_id: raw.platform_id != null ? String(raw.platform_id) : null,
    original_name: raw.original_name != null ? String(raw.original_name) : null,
    media_type: raw.media_type != null ? String(raw.media_type) : null,
    format: raw.format != null ? String(raw.format) : null,
    asset_ref: raw.asset_ref != null ? String(raw.asset_ref) : null,
    source_hash: raw.source_hash != null ? String(raw.source_hash) : null,
    title: raw.title != null ? String(raw.title) : null,
    author: raw.author != null ? String(raw.author) : null,
    published_at: raw.published_at != null ? String(raw.published_at) : null,
    first_captured_at: String(raw.first_captured_at ?? new Date().toISOString()),
    language: raw.language != null ? String(raw.language) : null,
    topics: Array.isArray(raw.topics) ? raw.topics.map(String) : [],
    metadata_method: (raw.metadata_method as ResourceMeta["metadata_method"]) ?? null,
    metadata_fetched_at: raw.metadata_fetched_at != null ? String(raw.metadata_fetched_at) : null,
    capture_surface: String(raw.capture_surface ?? "mcp"),
  };

  // Parse title from '# Title'
  let title: string | null = meta.title;
  const titleMatch = body.match(/^#\s+(.+)$/m);
  if (titleMatch && titleMatch[1]) {
    title = titleMatch[1].trim();
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

  return { meta, title, capture_note, capture_history };
}

export function formatMetaMarkdown(
  meta: ResourceMeta,
  captureNote?: string | null,
  captureHistory: string[] = [],
): string {
  const frontmatterData: Record<string, unknown> = {
    schema_version: 1,
    resource_id: meta.resource_id,
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

  const heading = meta.title || meta.original_name || meta.canonical_ref || meta.resource_id;

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
