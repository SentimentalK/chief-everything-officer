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
    return await this.workspace.withReadyWorkspace(async (base) => {
      const all = await enumerateResources(this.config.repoDir);

      const cards: ResourceCard[] = [];

      for (const item of all) {
        const { meta, doc, location } = item;
        const { capture_note } = doc;
        const resDir = path.join(this.config.repoDir, location.relative_path);

        // Check artifact existence
        const dirFiles: string[] = await readdir(resDir).catch(() => []);
        const artifactSet = new Set(dirFiles);

        let interactionsText: string | null = null;
        if (artifactSet.has("interactions.md")) {
          interactionsText = await readFile(path.join(resDir, "interactions.md"), "utf8").catch(() => null);
        }

        const stage = deriveResourceStage(artifactSet, interactionsText);
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

        // Filter: date range
        if (input.captured_from && meta.first_captured_at < input.captured_from) continue;
        if (input.captured_to && meta.first_captured_at > input.captured_to) continue;

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

        cards.push({
          resource_id: meta.resource_id,
          display_name: meta.display_name,
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
        });
      }

      // Sort
      const sortOrder = input.sort ?? "newest";
      cards.sort((a, b) => {
        if (sortOrder === "newest") {
          return b.first_captured_at.localeCompare(a.first_captured_at);
        }
        return a.first_captured_at.localeCompare(b.first_captured_at);
      });

      const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
      const results = cards.slice(0, limit);

      return {
        ok: true,
        base_commit: base,
        count: results.length,
        total: cards.length,
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

      const derivedStage = deriveResourceStage(artifactSet, interactionsText);
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
