import { randomUUID } from "node:crypto";
import path from "node:path";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import {
  type ChangeOperation,
  type CeoWorkspace,
  assertNoResourceMutations,
} from "../workspace.js";
import type { Config } from "../config.js";
import { CeoError } from "../errors.js";
import { resolveRef } from "../git.js";
import type {
  ResourceApplyInput,
  ResourceApplyOperation,
  ResourceCaptureInput,
  ResourceId,
  ResourceKind,
  ResourceMeta,
  ResourceStage,
  SourceType,
} from "./types.js";
import {
  computeFileIdentity,
  generateResourceId,
  normalizeUrlSource,
} from "./identity.js";
import {
  getCanonicalSourcePath,
  validateSourceAsset,
} from "./security.js";
import {
  deriveResourceStage,
  formatMetaMarkdown,
  parseMetaMarkdown,
  type ParsedMetaDocument,
} from "./meta.js";
import {
  type UrlMetadataResolver,
  createContentResolverClient,
} from "./resolver-client.js";
import {
  type ResolvedMetadataSeed,
  applyResolverRevisitUpdates,
  buildResolvedMetadataSeed,
  derivePreferredIdentity,
} from "./resolver-mapping.js";
import type { ContentMetadataV1 } from "./resolver-contract.js";

export class ResourceService {
  private readonly resolverClient: UrlMetadataResolver;

  constructor(
    private readonly workspace: CeoWorkspace,
    private readonly config: Config,
    resolverClient?: UrlMetadataResolver,
  ) {
    this.resolverClient = resolverClient ?? createContentResolverClient(config);
  }

  async capture(input: ResourceCaptureInput): Promise<Record<string, unknown>> {
    const requestId = input.request_id ?? randomUUID();
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
      throw new CeoError("VALIDATION_FAILED", "request_id must be a UUID.");
    }

    // Return completed transaction if already processed (replay-safe idempotency)
    const cached = await this.workspace.isRequestCompleted(requestId);
    if (cached) {
      return cached;
    }

    // Assert no Resource mutations in state_changes before any resolver/network work
    if (input.state_changes && input.state_changes.length > 0) {
      assertNoResourceMutations(input.state_changes, "state_changes");
    }

    // Determine normalized source properties
    let baselineIdentity: string | null = null;
    let preferredIdentity: string | null = null;
    let sourceType: SourceType = "url";
    let resourceKind: ResourceKind = "other";
    let canonicalRef: string | null = null;
    let sourceRef: string | null = null;
    let platform: string | null = null;
    let platformId: string | null = null;
    let originalName: string | null = null;
    let mediaType: string | null = null;
    let format: string | null = null;
    let sourceHash: string | null = null;
    let sourceAssetBuffer: Buffer | null = null;
    let sourceAssetExt: string | null = null;
    let enrichmentReceipt: Record<string, unknown> = { status: "disabled" };
    let metadataSeed: ResolvedMetadataSeed | null = null;
    let resolvedMetadata: ContentMetadataV1 | null = null;

    if (input.source.type === "url") {
      const norm = normalizeUrlSource(input.source.url);
      baselineIdentity = norm.source_identity;
      sourceType = "url";
      sourceRef = input.source.url;

      // Synchronous metadata resolution OUTSIDE atomic Git transaction
      const outcome = await this.resolverClient.resolve(input.source.url);
      if (outcome.status === "resolved") {
        resolvedMetadata = outcome.metadata;
        enrichmentReceipt = { status: "resolved" };
      } else if (outcome.status === "unsupported") {
        enrichmentReceipt = { status: "unsupported", code: outcome.code };
      } else if (outcome.status === "unavailable") {
        enrichmentReceipt = { status: "unavailable", code: outcome.code };
      } else {
        enrichmentReceipt = { status: "disabled" };
      }

      preferredIdentity = derivePreferredIdentity(baselineIdentity, resolvedMetadata);
      metadataSeed = buildResolvedMetadataSeed(norm, resolvedMetadata);
      resourceKind = metadataSeed.resource_kind;
      canonicalRef = metadataSeed.canonical_ref;
      platform = metadataSeed.platform;
      platformId = metadataSeed.platform_id;
    } else if (input.source.type === "file_descriptor") {
      sourceType = "file";
      resourceKind = "document";
      baselineIdentity = null;
      preferredIdentity = null;
      canonicalRef = null;
      sourceRef = input.source.host_ref ?? null;
      originalName = path.basename(input.source.filename);
      platform = null;
      platformId = null;
    } else if (input.source.type === "file_inline") {
      sourceAssetBuffer = Buffer.from(input.source.data_base64, "base64");
      const asset = validateSourceAsset(
        input.source.filename,
        input.source.mime_type,
        sourceAssetBuffer,
      );
      sourceAssetExt = asset.ext;
      mediaType = asset.media_type;
      format = asset.format;
      originalName = path.basename(input.source.filename);

      const idInfo = computeFileIdentity(sourceAssetBuffer);
      baselineIdentity = idInfo.source_identity;
      preferredIdentity = idInfo.source_identity;
      sourceHash = idInfo.source_hash;
      sourceType = "file";
      resourceKind = "document";
      canonicalRef = null;
      sourceRef = null;
      platform = null;
      platformId = null;
    } else if (input.source.type === "external_ref") {
      sourceType = "external_ref";
      baselineIdentity = `${input.source.provider}:${input.source.ref}`;
      preferredIdentity = baselineIdentity;
      canonicalRef = input.source.canonical_ref ?? null;
      sourceRef = input.source.ref;
      platform = input.source.provider;
      platformId = input.source.ref;
      resourceKind = "other";
    }

    const currentBase = await this.workspace.withReadyWorkspace(async (base) => base);
    let capturedResourceReceipt: Record<string, unknown> | null = null;

    return await this.workspace.withAtomicWorkspaceTransaction({
      requestId,
      baseCommit: currentBase,
      commitMessage: `CEO: ${input.summary?.trim() || `Capture resource`}`,
      allowResourceSourceFiles: true,
      allowEmpty: true,
      operationResultProducer: (_changedFiles) => {
        return {
          resource: capturedResourceReceipt,
          metadata_enrichment: enrichmentReceipt,
        };
      },
      mutator: async (worktree, worktreeMatcher) => {
        let resourceId: string;
        let isRevisit = false;
        let meta!: ResourceMeta;
        let captureHistory: string[] = [];
        let captureNote: string | null = input.note ?? null;
        let hasSemanticChange = false;

        // Deduplication
        if (input.source.type === "url" && preferredIdentity && baselineIdentity) {
          const byPreferred = await this.findResourceByIdentity(worktree, preferredIdentity);
          let byBaseline: { meta: ResourceMeta; doc: ParsedMetaDocument } | null = null;
          if (preferredIdentity !== baselineIdentity) {
            byBaseline = await this.findResourceByIdentity(worktree, baselineIdentity);
          }

          if (byPreferred && byBaseline && byPreferred.meta.resource_id !== byBaseline.meta.resource_id) {
            throw new CeoError(
              "DUPLICATE_RESOURCE",
              "Identity conflict: preferred identity and baseline identity match different resources.",
              {
                preferred_resource_id: byPreferred.meta.resource_id,
                baseline_resource_id: byBaseline.meta.resource_id,
              },
            );
          }

          const existing = byPreferred ?? byBaseline;
          if (existing) {
            isRevisit = true;
            resourceId = existing.meta.resource_id;
            meta = existing.meta;
            captureHistory = [...existing.doc.capture_history];
            captureNote = input.note ?? existing.doc.capture_note;

            // Revisit note
            if (input.note && input.note.trim() && input.note.trim() !== existing.doc.capture_note) {
              captureHistory.push(`${new Date().toISOString()} — revisit — ${input.note.trim()}`);
              hasSemanticChange = true;
            }

            // Topics union
            if (input.topics && input.topics.length > 0) {
              const prevSet = new Set(meta.topics);
              const combined = [...new Set([...meta.topics, ...input.topics])];
              if (combined.length > prevSet.size) {
                meta.topics = combined;
                hasSemanticChange = true;
              }
            }

            // Resolver revisit update (non-erasure)
            const metadataChanged = applyResolverRevisitUpdates(meta, resolvedMetadata);
            if (metadataChanged) {
              hasSemanticChange = true;
            }
          } else {
            resourceId = generateResourceId();
            hasSemanticChange = true;
          }
        } else if (preferredIdentity !== null) {
          const existing = await this.findResourceByIdentity(worktree, preferredIdentity);
          if (existing) {
            isRevisit = true;
            resourceId = existing.meta.resource_id;
            meta = existing.meta;
            captureHistory = [...existing.doc.capture_history];
            captureNote = input.note ?? existing.doc.capture_note;

            if (input.note && input.note.trim() && input.note.trim() !== existing.doc.capture_note) {
              captureHistory.push(`${new Date().toISOString()} — revisit — ${input.note.trim()}`);
              hasSemanticChange = true;
            }

            if (input.topics && input.topics.length > 0) {
              const prevSet = new Set(meta.topics);
              const combined = [...new Set([...meta.topics, ...input.topics])];
              if (combined.length > prevSet.size) {
                meta.topics = combined;
                hasSemanticChange = true;
              }
            }
          } else {
            resourceId = generateResourceId();
            hasSemanticChange = true;
          }
        } else {
          // Provisional file descriptor
          resourceId = generateResourceId();
          hasSemanticChange = true;
        }

        const resDir = path.join(worktree, "resources", resourceId);

        if (!isRevisit) {
          meta = {
            schema_version: 1,
            resource_id: resourceId,
            resource_kind: resourceKind,
            source_type: sourceType,
            source_identity: preferredIdentity,
            source_ref: sourceRef,
            canonical_ref: canonicalRef,
            platform,
            platform_id: platformId,
            original_name: originalName,
            media_type: mediaType,
            format,
            asset_ref: sourceAssetBuffer && sourceAssetExt ? `source/original${sourceAssetExt}` : null,
            source_hash: sourceHash,
            title: metadataSeed ? metadataSeed.title : null,
            author: metadataSeed ? metadataSeed.author : null,
            published_at: metadataSeed ? metadataSeed.published_at : null,
            first_captured_at: new Date().toISOString(),
            language: metadataSeed ? metadataSeed.language : null,
            topics: input.topics ? [...input.topics] : [],
            metadata_method: metadataSeed ? metadataSeed.metadata_method : (input.source.type === "url" ? null : "user_provided"),
            metadata_fetched_at: metadataSeed ? metadataSeed.metadata_fetched_at : null,
            capture_surface: "mcp",
          };

          captureHistory = [`${meta.first_captured_at} — first_capture`];
          if (input.note && input.note.trim()) {
            captureHistory[0] += ` — ${input.note.trim()}`;
          }

          await mkdir(resDir, { recursive: true });

          // Save source asset if provided
          if (sourceAssetBuffer && sourceAssetExt) {
            const sourceDir = path.join(resDir, "source");
            await mkdir(sourceDir, { recursive: true });
            await writeFile(path.join(sourceDir, `original${sourceAssetExt}`), sourceAssetBuffer);
          }
        }

        // Apply initial operations if provided
        if (input.initial_operations && input.initial_operations.length > 0) {
          await this.executeResourceOperations(worktree, resourceId, meta, input.initial_operations);
          hasSemanticChange = true;
        }

        // Write meta.md only if semantic changes exist (or on first capture)
        if (hasSemanticChange) {
          const metaMarkdown = formatMetaMarkdown(meta!, captureNote, captureHistory);
          await writeFile(path.join(resDir, "meta.md"), metaMarkdown, "utf8");
        }

        // Apply optional state_changes atomically
        if (input.state_changes && input.state_changes.length > 0) {
          this.workspace.validateOperations(input.state_changes, worktreeMatcher);
          await this.workspace.applyOperations(worktree, currentBase, input.state_changes);
        }

        // Calculate stage
        const dirFiles = await readdir(resDir).catch(() => []);
        const artifactSet = new Set(dirFiles);
        let interactionsText: string | null = null;
        if (artifactSet.has("interactions.md")) {
          interactionsText = await readFile(path.join(resDir, "interactions.md"), "utf8").catch(() => null);
        }
        const stage = deriveResourceStage(artifactSet, interactionsText);

        capturedResourceReceipt = {
          resource_id: resourceId,
          is_revisit: isRevisit,
          source_identity: meta.source_identity,
          title: meta.title,
          platform: meta.platform,
          resource_kind: meta.resource_kind,
          stage,
        };
      },
    });
  }

  async apply(input: ResourceApplyInput): Promise<Record<string, unknown>> {
    const requestId = input.request_id ?? randomUUID();
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
      throw new CeoError("VALIDATION_FAILED", "request_id must be a UUID.");
    }
    if (!input.resource_id || !/^res-[0-9a-f-]{36}$/i.test(input.resource_id)) {
      throw new CeoError("VALIDATION_FAILED", "Invalid resource_id format.", {
        resource_id: input.resource_id,
      });
    }
    if (input.operations.length === 0) {
      throw new CeoError("VALIDATION_FAILED", "At least one operation is required.");
    }

    if (input.state_changes && input.state_changes.length > 0) {
      assertNoResourceMutations(input.state_changes, "state_changes");
    }

    return await this.workspace.withAtomicWorkspaceTransaction({
      requestId,
      baseCommit: input.base_commit,
      commitMessage: `CEO: ${input.summary.trim()}`,
      allowResourceSourceFiles: true,
      mutator: async (worktree, worktreeMatcher) => {
        const resDir = path.join(worktree, "resources", input.resource_id);
        const metaPath = path.join(resDir, "meta.md");

        const exists = await access(metaPath).then(() => true).catch(() => false);
        if (!exists) {
          throw new CeoError("NOT_FOUND", `Resource '${input.resource_id}' does not exist.`, {
            resource_id: input.resource_id,
          });
        }

        const metaContent = await readFile(metaPath, "utf8");
        const doc = parseMetaMarkdown(metaContent);
        const meta = doc.meta;

        await this.executeResourceOperations(worktree, input.resource_id, meta, input.operations);

        // Update meta.md
        const metaMarkdown = formatMetaMarkdown(meta, doc.capture_note, doc.capture_history);
        await writeFile(metaPath, metaMarkdown, "utf8");

        // Apply optional state changes
        if (input.state_changes && input.state_changes.length > 0) {
          this.workspace.validateOperations(input.state_changes, worktreeMatcher);
          await this.workspace.applyOperations(worktree, input.base_commit, input.state_changes);
        }
      },
    });
  }

  private async executeResourceOperations(
    worktree: string,
    resourceId: string,
    meta: ResourceMeta,
    operations: ResourceApplyOperation[],
  ): Promise<void> {
    const resDir = path.join(worktree, "resources", resourceId);

    for (const op of operations) {
      if (op.op === "attach_source_asset") {
        const buf = Buffer.from(op.data_base64, "base64");
        const asset = validateSourceAsset(op.filename, op.mime_type, buf);
        const idInfo = computeFileIdentity(buf);

        // Late identity collision check: search if any other resource has identical hash
        const colliding = await this.findResourceByHash(worktree, idInfo.source_hash, resourceId);
        if (colliding) {
          throw new CeoError(
            "DUPLICATE_RESOURCE",
            `File asset matches existing resource '${colliding}'. Automatic merge is not supported.`,
            { collision_resource_id: colliding, source_hash: idInfo.source_hash },
          );
        }

        const sourceDir = path.join(resDir, "source");
        await mkdir(sourceDir, { recursive: true });
        await writeFile(path.join(sourceDir, `original${asset.ext}`), buf);

        // Update meta fields
        meta.asset_ref = `source/original${asset.ext}`;
        meta.source_hash = idInfo.source_hash;
        meta.media_type = asset.media_type;
        meta.format = asset.format;
        meta.original_name = path.basename(op.filename);
        if (meta.source_identity === null) {
          meta.source_identity = idInfo.source_identity;
        }
      } else if (op.op === "upsert_evidence") {
        if (op.provenance === ("host_semantic" as string)) {
          throw new CeoError(
            "INVALID_OPERATION",
            "upsert_evidence rejects host_semantic provenance. Evidence requires host_exact, trusted_adapter, or worker.",
          );
        }
        await writeFile(path.join(resDir, "evidence.md"), op.content, "utf8");
      } else if (op.op === "upsert_content") {
        if (op.provenance === ("host_semantic" as string)) {
          throw new CeoError("INVALID_OPERATION", "upsert_content rejects host_semantic provenance.");
        }
        await writeFile(path.join(resDir, "content.md"), op.content, "utf8");
      } else if (op.op === "upsert_summary") {
        await writeFile(path.join(resDir, "summary.md"), op.content, "utf8");
      } else if (op.op === "append_interaction") {
        const interactionPath = path.join(resDir, "interactions.md");
        const interactionExists = await access(interactionPath).then(() => true).catch(() => false);
        const timestamp = new Date().toISOString();
        let formattedEntry = `\n## ${timestamp} (${op.provenance})\n\n${op.entry.trim()}\n`;
        if (!interactionExists) {
          formattedEntry = `# Interactions — ${resourceId}\n${formattedEntry}`;
          await writeFile(interactionPath, formattedEntry, "utf8");
        } else {
          const current = await readFile(interactionPath, "utf8");
          await writeFile(interactionPath, current + formattedEntry, "utf8");
        }
      } else if (op.op === "patch_topics") {
        if (op.set) {
          meta.topics = [...new Set(op.set)];
        }
        if (op.add) {
          meta.topics = [...new Set([...meta.topics, ...op.add])];
        }
        if (op.remove) {
          meta.topics = meta.topics.filter((t) => !op.remove!.includes(t));
        }
      }
    }
  }

  private async findResourceByIdentity(
    worktree: string,
    sourceIdentity: string,
  ): Promise<{ meta: ResourceMeta; doc: ParsedMetaDocument } | null> {
    const resourcesRoot = path.join(worktree, "resources");
    const entries = await readdir(resourcesRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("res-")) continue;
      const metaPath = path.join(resourcesRoot, entry.name, "meta.md");
      const metaContent = await readFile(metaPath, "utf8").catch(() => null);
      if (!metaContent) continue;
      try {
        const doc = parseMetaMarkdown(metaContent);
        if (doc.meta.source_identity === sourceIdentity) {
          return { meta: doc.meta, doc };
        }
      } catch {}
    }
    return null;
  }

  private async findResourceByHash(
    worktree: string,
    hash: string,
    excludeResourceId?: string,
  ): Promise<string | null> {
    const resourcesRoot = path.join(worktree, "resources");
    const entries = await readdir(resourcesRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("res-")) continue;
      if (entry.name === excludeResourceId) continue;
      const metaPath = path.join(resourcesRoot, entry.name, "meta.md");
      const metaContent = await readFile(metaPath, "utf8").catch(() => null);
      if (!metaContent) continue;
      try {
        const doc = parseMetaMarkdown(metaContent);
        if (doc.meta.source_hash === hash) {
          return entry.name;
        }
      } catch {}
    }
    return null;
  }
}
