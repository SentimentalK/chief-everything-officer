import path from "node:path";
import { access, readFile, readdir } from "node:fs/promises";
import type { CeoWorkspace } from "../workspace.js";
import type { Config } from "../config.js";
import { CeoError } from "../errors.js";
import type {
  ResourceCard,
  ResourceGetInput,
  ResourceGetView,
  ResourceSearchInput,
  ResourceStage,
} from "./types.js";
import {
  deriveResourceStage,
  parseMetaMarkdown,
} from "./meta.js";
import { parseSummaryDocument } from "./summary.js";
import { parseResourceTimestamp } from "./timestamps.js";
import {
  enumerateResources,
  resolveResourceLocation,
} from "./locator.js";

export class ResourceRetrievalService {
  constructor(
    private readonly workspace: CeoWorkspace,
    private readonly config: Config,
  ) {}

  async search(input: ResourceSearchInput = {}): Promise<Record<string, unknown>> {
    // Validate date-range params before entering the workspace (mirrors how
    // searchText validates its query up front): malformed bounds are rejected
    // even when the repository has no resources, and no sync happens for a
    // bad request.
    const fromMs =
      input.captured_from !== undefined ? parseResourceTimestamp(input.captured_from, "captured_from") : undefined;
    const toMs =
      input.captured_to !== undefined ? parseResourceTimestamp(input.captured_to, "captured_to") : undefined;
    if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
      throw new CeoError("VALIDATION_FAILED", "captured_from must not be later than captured_to.", {
        captured_from: input.captured_from,
        captured_to: input.captured_to,
      });
    }

    return await this.workspace.withReadyWorkspace(async (base) => {
      const all = await enumerateResources(this.config.repoDir);

      const entries: Array<{ card: ResourceCard; capturedMs: number }> = [];

      for (const item of all) {
        const { meta, doc, location } = item;
        const { capture_note } = doc;

        // Filter: naming_source (exact match; runs before artifact reads and stage derivation)
        if (input.naming_source && meta.naming_source !== input.naming_source) continue;

        // Parse first_captured_at once per candidate (never before the
        // naming_source filter, so filtered-out resources are not touched).
        // An invalid value is a hard error naming the resource and its
        // meta.md — never skipped or guessed.
        const metaPath = path.posix.join(location.relative_path, "meta.md");
        const capturedMs = parseResourceTimestamp(
          meta.first_captured_at,
          `first_captured_at for resource '${meta.resource_id}' (${metaPath})`,
        );

        // Filter: date range (inclusive bounds on the parsed instant)
        if (fromMs !== undefined && capturedMs < fromMs) continue;
        if (toMs !== undefined && capturedMs > toMs) continue;

        const resDir = path.join(this.config.repoDir, location.relative_path);

        // Check artifact existence
        const dirFiles: string[] = await readdir(resDir).catch(() => []);
        const artifactSet = new Set(dirFiles);

        let interactionsText: string | null = null;
        if (artifactSet.has("interactions.md")) {
          interactionsText = await readFile(path.join(resDir, "interactions.md"), "utf8").catch(() => null);
        }

        let summaryText: string | null = null;
        const summaryPath = path.join(resDir, "summary.md");
        if (artifactSet.has("summary.md")) {
          summaryText = await readFile(summaryPath, "utf8");
        }

        const stage = deriveResourceStage(artifactSet, interactionsText, summaryText, summaryPath);
        const sourceAssetAvailable = dirFiles.includes("source");

        // Filter: stage
        if (input.stage && stage !== input.stage) continue;

        // Filter: resource_kind
        if (input.resource_kind && meta.resource_kind !== input.resource_kind) continue;

        // Filter: source_type
        if (input.source_type && meta.source_type !== input.source_type) continue;

        // Filter: platform
        if (input.platform && meta.platform?.toLowerCase() !== input.platform.toLowerCase()) continue;

        // Filter: topics
        if (input.topics && input.topics.length > 0) {
          const hasTopic = input.topics.some((reqTopic) =>
            meta.topics.some((t) => t.toLowerCase() === reqTopic.toLowerCase()),
          );
          if (!hasTopic) continue;
        }

        // Filter: query (matches display_name, title, note, ref, name, id, topics)
        if (input.query && input.query.trim()) {
          const q = input.query.trim().toLowerCase();
          const matchDisplayName = meta.display_name?.toLowerCase().includes(q);
          const matchTitle = meta.title?.toLowerCase().includes(q);
          const matchNote = capture_note?.toLowerCase().includes(q);
          const matchRef = meta.canonical_ref?.toLowerCase().includes(q) || meta.source_ref?.toLowerCase().includes(q);
          const matchName = meta.original_name?.toLowerCase().includes(q);
          const matchId = meta.source_identity?.toLowerCase().includes(q);
          const matchTopics = meta.topics.some((t) => t.toLowerCase().includes(q));

          if (!matchDisplayName && !matchTitle && !matchNote && !matchRef && !matchName && !matchId && !matchTopics) {
            continue;
          }
        }

        entries.push({
          card: {
            resource_id: meta.resource_id,
            display_name: meta.display_name,
            naming_source: meta.naming_source,
            relative_path: location.relative_path,
            title: meta.title,
            stage,
            resource_kind: meta.resource_kind,
            source_type: meta.source_type,
            source_identity: meta.source_identity,
            canonical_ref: meta.canonical_ref,
            platform: meta.platform,
            topics: meta.topics,
            first_captured_at: meta.first_captured_at,
            source_asset_available: sourceAssetAvailable,
            capture_note,
            original_name: meta.original_name,
          },
          capturedMs,
        });
      }

      // Sort on the parsed instant; ties resolve by resource_id ascending via a
      // fixed code-unit comparison (resource_ids are ASCII "res-<uuid>", so < / >
      // is deterministic). Never localeCompare.
      const sortOrder = input.sort ?? "newest";
      entries.sort((a, b) => {
        if (a.capturedMs !== b.capturedMs) {
          return sortOrder === "newest" ? b.capturedMs - a.capturedMs : a.capturedMs - b.capturedMs;
        }
        return a.card.resource_id < b.card.resource_id ? -1 : a.card.resource_id > b.card.resource_id ? 1 : 0;
      });

      const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
      const results = entries.slice(0, limit).map((entry) => entry.card);

      return {
        ok: true,
        base_commit: base,
        count: results.length,
        total: entries.length,
        results,
      };
    });
  }

  async get(input: ResourceGetInput): Promise<Record<string, unknown>> {
    return await this.workspace.withReadyWorkspace(async (base) => {
      const location = await resolveResourceLocation(this.config.repoDir, input.resource_id);
      if (!location) {
        throw new CeoError("NOT_FOUND", `Resource '${input.resource_id}' does not exist.`, {
          resource_id: input.resource_id,
        });
      }

      const resDir = path.join(this.config.repoDir, location.relative_path);
      const metaPath = path.join(resDir, "meta.md");

      const metaContent = await readFile(metaPath, "utf8").catch(() => null);
      if (!metaContent) {
        throw new CeoError("NOT_FOUND", `Resource '${input.resource_id}' meta.md not found.`, {
          resource_id: input.resource_id,
        });
      }

      const doc = parseMetaMarkdown(metaContent);
      const { meta, heading, capture_note, capture_history } = doc;

      const dirFiles: string[] = await readdir(resDir).catch(() => []);
      const artifactSet = new Set(dirFiles);

      let interactionsText: string | null = null;
      if (artifactSet.has("interactions.md")) {
        interactionsText = await readFile(path.join(resDir, "interactions.md"), "utf8").catch(() => null);
      }

      let summaryText: string | null = null;
      const summaryPath = path.join(resDir, "summary.md");
      if (artifactSet.has("summary.md")) {
        summaryText = await readFile(summaryPath, "utf8");
      }

      const derivedStage = deriveResourceStage(artifactSet, interactionsText, summaryText, summaryPath);
      const sourceAssetAvailable = dirFiles.includes("source");

      const availableViews: ResourceGetView[] = ["metadata"];
      if (artifactSet.has("summary.md")) availableViews.push("summary");
      if (artifactSet.has("content.md")) availableViews.push("content");
      if (artifactSet.has("evidence.md")) availableViews.push("evidence");
      if (artifactSet.has("interactions.md")) availableViews.push("interactions");
      if (sourceAssetAvailable) availableViews.push("source");

      const requestedView = input.view ?? "metadata";

      const commonHeader = {
        ok: true,
        base_commit: base,
        resource_id: input.resource_id,
        display_name: meta.display_name,
        relative_path: location.relative_path,
        derived_stage: derivedStage,
        available_views: availableViews,
        source_asset_available: sourceAssetAvailable,
      };

      if (requestedView === "metadata") {
        return {
          ...commonHeader,
          view: "metadata",
          metadata: meta,
          display_name: meta.display_name,
          naming_source: meta.naming_source,
          relative_path: location.relative_path,
          title: meta.title,
          heading,
          capture_note,
          capture_history,
        };
      }

      if (requestedView === "source") {
        if (!sourceAssetAvailable || !meta.asset_ref) {
          return {
            ...commonHeader,
            view: "source",
            available: false,
            status: "NOT_AVAILABLE",
          };
        }
        return {
          ...commonHeader,
          view: "source",
          available: true,
          uri: `ceo-resource://${input.resource_id}/source`,
          asset_ref: meta.asset_ref,
          media_type: meta.media_type,
          format: meta.format,
          original_name: meta.original_name,
          source_hash: meta.source_hash,
        };
      }

      // Text views: summary, content, evidence, interactions
      const fileName = `${requestedView}.md`;
      if (!artifactSet.has(fileName)) {
        return {
          ...commonHeader,
          view: requestedView,
          available: false,
          status: "NOT_AVAILABLE",
        };
      }

      let text = await readFile(path.join(resDir, fileName), "utf8");

      // Section filtering for content.md
      if (requestedView === "content" && input.section_ids && input.section_ids.length > 0) {
        text = filterContentSections(text, input.section_ids);
      }

      const lines = text.split("\n");
      const totalLines = lines.length;
      const startLine = Math.max(input.start_line ?? 1, 1);
      const lineCount = input.line_count ?? 200;

      const sliceStartIndex = startLine - 1;
      const sliceEndIndex = Math.min(sliceStartIndex + lineCount, totalLines);
      const paginatedContent = lines.slice(sliceStartIndex, sliceEndIndex).join("\n");
      const truncated = sliceEndIndex < totalLines;

      let parsedSummaryMeta: { provenance?: string; basis?: string } = {};
      if (requestedView === "summary") {
        const parsed = parseSummaryDocument(text, path.join(resDir, fileName));
        parsedSummaryMeta = {
          provenance: parsed.provenance,
          basis: parsed.basis,
        };
      }

      return {
        ...commonHeader,
        view: requestedView,
        available: true,
        content: paginatedContent,
        start_line: startLine,
        line_count: sliceEndIndex - sliceStartIndex,
        total_lines: totalLines,
        truncated,
        ...(truncated ? { next_start_line: sliceEndIndex + 1 } : {}),
        ...parsedSummaryMeta,
      };
    });
  }
}

function filterContentSections(fullContent: string, sectionIds: string[]): string {
  const normalizedIds = new Set(sectionIds.map((s) => s.toUpperCase()));
  const lines = fullContent.split("\n");
  const extractedSections: string[] = [];

  let currentSectionId: string | null = null;
  let currentSectionLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+([A-Za-z0-9_-]+)/);
    if (headingMatch && headingMatch[1]) {
      if (currentSectionId && normalizedIds.has(currentSectionId)) {
        extractedSections.push(currentSectionLines.join("\n"));
      }
      currentSectionId = headingMatch[1].toUpperCase();
      currentSectionLines = [line];
    } else {
      if (currentSectionLines.length > 0) {
        currentSectionLines.push(line);
      }
    }
  }

  if (currentSectionId && normalizedIds.has(currentSectionId)) {
    extractedSections.push(currentSectionLines.join("\n"));
  }

  if (extractedSections.length === 0) {
    return `<!-- No matching sections found for IDs: ${sectionIds.join(", ")} -->`;
  }

  return extractedSections.join("\n\n");
}
