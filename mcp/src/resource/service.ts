import { randomUUID } from "node:crypto";
import path from "node:path";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import {
  type ChangeOperation,
  type CeoWorkspace,
  assertNoResourceMutations,
} from "../workspace.js";
import type { Config } from "../config.js";
import { CeoError } from "../errors.js";
import { resolveRef } from "../git.js";
import type {
  MetadataAttemptRecord,
  MetadataAttemptStatus,
  NamingSource,
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
  validateSourceAsset,
} from "./security.js";
import {
  deriveResourceStage,
  formatMetaMarkdown,
  parseMetaMarkdown,
  type ParsedMetaDocument,
} from "./meta.js";
import {
  type LocatedResource,
  type ResourceLocation,
  findResourceByHash,
  findResourceByIdentity,
  findResourceByUrlOrIdentities,
  resolveResourceLocation,
} from "./locator.js";
import {
  MAX_DISPLAY_NAME_CHARS,
  allocateUniqueDirectoryName,
  cleanDisplayName,
  determineInitialDisplayName,
  toSafeDirectoryName,
} from "./naming.js";
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

export interface ResourceExecutionContext {
  location: ResourceLocation;
  getResDir(): string;
  getMetaPath(): string;
}

export async function applyResourceRename(
  worktree: string,
  ctx: ResourceExecutionContext,
  meta: ResourceMeta,
  newDisplayName: string,
  namingSource: NamingSource,
): Promise<{ renamed: boolean; old_path: string; new_path: string }> {
  const trimmed = cleanDisplayName(newDisplayName);
  if (!trimmed) {
    throw new CeoError("VALIDATION_FAILED", "display_name cannot be empty.");
  }
  const resourcesRoot = path.join(worktree, "resources");
  const allocatedDir = await allocateUniqueDirectoryName(
    resourcesRoot,
    trimmed,
    ctx.location.directory_name,
  );

  const oldRelative = ctx.location.relative_path;
  const newRelative = path.posix.join("resources", allocatedDir);

  if (allocatedDir === ctx.location.directory_name) {
    meta.display_name = trimmed;
    meta.naming_source = namingSource;
    return { renamed: false, old_path: oldRelative, new_path: newRelative };
  }

  const oldAbsolute = ctx.getResDir();
  const newAbsolute = path.join(resourcesRoot, allocatedDir);
  await rename(oldAbsolute, newAbsolute);

  ctx.location.directory_name = allocatedDir;
  ctx.location.relative_path = newRelative;

  meta.display_name = trimmed;
  meta.naming_source = namingSource;

  return { renamed: true, old_path: oldRelative, new_path: newRelative };
}

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
    let currentAttemptRecord: MetadataAttemptRecord | null = null;
    let enrichmentReceipt: Record<string, unknown> = { status: "disabled" };
    let metadataSeed: ResolvedMetadataSeed | null = null;
    let resolvedMetadata: ContentMetadataV1 | null = null;

    if (input.source.type === "url") {
      const norm = normalizeUrlSource(input.source.url);
      baselineIdentity = norm.source_identity;
      sourceType = "url";
      sourceRef = input.source.url;

      // Synchronous metadata resolution OUTSIDE atomic Git transaction
      const outcome = await this.resolverClient.resolve(input.source.url, requestId);

      let enrichmentStatus: MetadataAttemptStatus = outcome.status;
      let enrichmentCode: string | null = null;
      let fieldsResolved: string[] = [];
      let strategy: string | null = null;
      let httpStatus: number | null = null;

      if (outcome.status === "resolved") {
        resolvedMetadata = outcome.metadata;
        fieldsResolved = outcome.fields_resolved ?? [];
        strategy = outcome.diagnostics?.strategy ?? null;
        httpStatus = outcome.diagnostics?.http_status ?? null;
        enrichmentCode = outcome.diagnostics?.code ?? null;
      } else if (outcome.status === "unavailable") {
        fieldsResolved = outcome.fields_resolved ?? [];
        strategy = outcome.diagnostics?.strategy ?? null;
        httpStatus = outcome.diagnostics?.http_status ?? null;
        enrichmentCode = outcome.code;
      } else if (outcome.status === "unsupported") {
        enrichmentCode = outcome.code;
      }

      if (outcome.status !== "disabled") {
        currentAttemptRecord = {
          attempted_at: outcome.attempted_at ?? new Date().toISOString(),
          status: enrichmentStatus,
          code: enrichmentCode,
          fields_resolved: fieldsResolved,
          strategy,
          http_status: httpStatus,
          request_id: requestId,
        };

        enrichmentReceipt = {
          status: currentAttemptRecord.status,
          code: currentAttemptRecord.code,
          fields_resolved: currentAttemptRecord.fields_resolved,
          strategy: currentAttemptRecord.strategy,
          http_status: currentAttemptRecord.http_status,
          request_id: currentAttemptRecord.request_id,
          applied: true,
        };
      } else {
        enrichmentReceipt = {
          status: "disabled",
        };
      }

      // Conflict check: if URL deterministically provided platform_id and resolver returned source_id
      if (norm.platform_id && resolvedMetadata && resolvedMetadata.source_id) {
        if (norm.platform_id.toLowerCase() !== resolvedMetadata.source_id.toLowerCase()) {
          throw new CeoError(
            "DUPLICATE_RESOURCE",
            `Provider ID conflict between input URL platform_id '${norm.platform_id}' and resolver source_id '${resolvedMetadata.source_id}'.`,
            {
              url_platform_id: norm.platform_id,
              resolver_source_id: resolvedMetadata.source_id,
            },
          );
        }
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
        let location!: ResourceLocation;
        let ctx!: ResourceExecutionContext;
        let isStaleAttempt = false;
        let captureHistory: string[] = [];
        let captureNote: string | null = input.note ?? null;
        let hasSemanticChange = false;

        // Deduplication
        if (input.source.type === "url" && preferredIdentity && baselineIdentity) {
          const norm = normalizeUrlSource(input.source.url);
          const existing = await findResourceByUrlOrIdentities(worktree, {
            preferredIdentity,
            baselineIdentity,
            normalizedUrl: norm.canonical_ref,
          });

          if (existing) {
            isRevisit = true;
            location = { ...existing.location };
            resourceId = existing.meta.resource_id;
            meta = existing.meta;
            ctx = {
              location,
              getResDir: () => path.join(worktree, ctx.location.relative_path),
              getMetaPath: () => path.join(ctx.getResDir(), "meta.md"),
            };
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

            // Check stale attempt
            if (
              meta.last_metadata_attempt &&
              currentAttemptRecord &&
              meta.last_metadata_attempt.attempted_at >= currentAttemptRecord.attempted_at
            ) {
              isStaleAttempt = true;
            }

            if (!isStaleAttempt && currentAttemptRecord) {
              // Update aliases
              const aliasSet = new Set(meta.source_aliases || []);
              let aliasChanged = false;
              if (preferredIdentity && preferredIdentity !== meta.source_identity && !aliasSet.has(preferredIdentity)) {
                aliasSet.add(preferredIdentity);
                aliasChanged = true;
              }
              if (baselineIdentity && baselineIdentity !== meta.source_identity && !aliasSet.has(baselineIdentity)) {
                aliasSet.add(baselineIdentity);
                aliasChanged = true;
              }
              if (aliasChanged) {
                meta.source_aliases = Array.from(aliasSet);
                hasSemanticChange = true;
              }

              // Apply metadata updates
              const metadataChanged = applyResolverRevisitUpdates(meta, resolvedMetadata);
              if (metadataChanged) {
                hasSemanticChange = true;
              }

              const attemptStatusChanged =
                !meta.last_metadata_attempt ||
                meta.last_metadata_attempt.status !== currentAttemptRecord.status ||
                meta.last_metadata_attempt.code !== currentAttemptRecord.code;

              if (metadataChanged || attemptStatusChanged || aliasChanged) {
                meta.last_metadata_attempt = { ...currentAttemptRecord };
                hasSemanticChange = true;
              }

              // Naming on revisit
              if (input.display_name && input.display_name.trim()) {
                await applyResourceRename(worktree, ctx, meta, input.display_name, "explicit");
                hasSemanticChange = true;
              } else if (meta.naming_source === "fallback" && resolvedMetadata?.title && resolvedMetadata.title.trim()) {
                await applyResourceRename(worktree, ctx, meta, resolvedMetadata.title, "title");
                hasSemanticChange = true;
              }
            } else {
              // Stale attempt: only apply explicit display_name if provided
              if (input.display_name && input.display_name.trim()) {
                await applyResourceRename(worktree, ctx, meta, input.display_name, "explicit");
                hasSemanticChange = true;
              }
            }
          } else {
            resourceId = generateResourceId();
            hasSemanticChange = true;
          }
        } else if (preferredIdentity !== null) {
          const existing = await findResourceByIdentity(worktree, preferredIdentity);
          if (existing) {
            isRevisit = true;
            location = { ...existing.location };
            resourceId = existing.meta.resource_id;
            meta = existing.meta;
            ctx = {
              location,
              getResDir: () => path.join(worktree, ctx.location.relative_path),
              getMetaPath: () => path.join(ctx.getResDir(), "meta.md"),
            };
            captureHistory = [...existing.doc.capture_history];
            captureNote = input.note ?? existing.doc.capture_note;

            if (input.note && input.note.trim() && input.note.trim() !== existing.doc.capture_note) {
              captureHistory.push(`${new Date().toISOString()} — revisit — ${input.note.trim()}`);
              hasSemanticChange = true;
            }

            if (input.display_name && input.display_name.trim()) {
              await applyResourceRename(worktree, ctx, meta, input.display_name, "explicit");
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

        if (!isRevisit) {
          let initialDisplayName: string;
          let initialNamingSource: NamingSource;
          if (input.display_name && input.display_name.trim()) {
            initialDisplayName = cleanDisplayName(input.display_name);
            initialNamingSource = "explicit";
          } else if (resolvedMetadata?.title && resolvedMetadata.title.trim()) {
            initialDisplayName = cleanDisplayName(resolvedMetadata.title);
            initialNamingSource = "title";
          } else {
            initialDisplayName = determineInitialDisplayName({
              inputDisplayName: input.display_name,
              resolverTitle: metadataSeed ? metadataSeed.title : null,
              source: input.source,
              sourceIdentity: preferredIdentity,
              originalName,
              canonicalRef,
            });
            initialNamingSource = "fallback";
          }

          const resourcesRoot = path.join(worktree, "resources");
          await mkdir(resourcesRoot, { recursive: true });
          const dirName = await allocateUniqueDirectoryName(resourcesRoot, initialDisplayName);
          location = {
            resource_id: resourceId,
            directory_name: dirName,
            relative_path: path.posix.join("resources", dirName),
          };
          ctx = {
            location,
            getResDir: () => path.join(worktree, ctx.location.relative_path),
            getMetaPath: () => path.join(ctx.getResDir(), "meta.md"),
          };
          const resDir = ctx.getResDir();
          await mkdir(resDir, { recursive: true });

          const initialAttemptRecord: MetadataAttemptRecord | null =
            input.source.type === "url" && currentAttemptRecord
              ? { ...currentAttemptRecord }
              : null;

          meta = {
            schema_version: 1,
            resource_id: resourceId,
            display_name: initialDisplayName,
            naming_source: initialNamingSource,
            source_aliases:
              input.source.type === "url" &&
              preferredIdentity &&
              baselineIdentity &&
              preferredIdentity !== baselineIdentity
                ? [baselineIdentity]
                : [],
            last_metadata_attempt: initialAttemptRecord,
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
            asset_ref:
              sourceAssetBuffer && sourceAssetExt
                ? `source/original${sourceAssetExt}`
                : null,
            source_hash: sourceHash,
            title: metadataSeed ? metadataSeed.title : null,
            author: metadataSeed ? metadataSeed.author : null,
            published_at: metadataSeed ? metadataSeed.published_at : null,
            first_captured_at: new Date().toISOString(),
            language: metadataSeed ? metadataSeed.language : null,
            topics: input.topics ? [...input.topics] : [],
            metadata_method: metadataSeed
              ? metadataSeed.metadata_method
              : input.source.type === "url"
                ? null
                : "user_provided",
            metadata_fetched_at: metadataSeed
              ? metadataSeed.metadata_fetched_at
              : null,
            capture_surface: "mcp",
          };

          captureHistory = [`${meta.first_captured_at} — first_capture`];
          if (input.note && input.note.trim()) {
            captureHistory[0] += ` — ${input.note.trim()}`;
          }

          // Save source asset if provided
          if (sourceAssetBuffer && sourceAssetExt) {
            const sourceDir = path.join(resDir, "source");
            await mkdir(sourceDir, { recursive: true });
            await writeFile(path.join(sourceDir, `original${sourceAssetExt}`), sourceAssetBuffer);
          }
        }

        // Apply initial operations if provided
        if (input.initial_operations && input.initial_operations.length > 0) {
          await this.executeResourceOperations(worktree, ctx, meta, input.initial_operations);
          hasSemanticChange = true;
        }

        // Write meta.md only if semantic changes exist (or on first capture)
        if (hasSemanticChange) {
          const metaMarkdown = formatMetaMarkdown(meta!, captureNote, captureHistory);
          await writeFile(ctx.getMetaPath(), metaMarkdown, "utf8");
        }

        // Apply optional state_changes atomically
        if (input.state_changes && input.state_changes.length > 0) {
          this.workspace.validateOperations(input.state_changes, worktreeMatcher);
          await this.workspace.applyOperations(worktree, currentBase, input.state_changes);
        }

        // Calculate stage
        const dirFiles = await readdir(ctx.getResDir()).catch(() => []);
        const artifactSet = new Set(dirFiles);
        let interactionsText: string | null = null;
        if (artifactSet.has("interactions.md")) {
          interactionsText = await readFile(path.join(ctx.getResDir(), "interactions.md"), "utf8").catch(() => null);
        }
        const stage = deriveResourceStage(artifactSet, interactionsText);

        if (enrichmentReceipt.status !== "disabled") {
          enrichmentReceipt = {
            ...enrichmentReceipt,
            applied: !isStaleAttempt,
            ...(isStaleAttempt ? { skip_reason: "stale_attempt" } : {}),
          };
        }

        capturedResourceReceipt = {
          resource_id: resourceId,
          display_name: meta.display_name,
          naming_source: meta.naming_source,
          relative_path: ctx.location.relative_path,
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

    let initialRelativePath = "";
    let appliedResourceReceipt: Record<string, unknown> | null = null;
    let finalCtx: ResourceExecutionContext | null = null;

    return await this.workspace.withAtomicWorkspaceTransaction({
      requestId,
      baseCommit: input.base_commit,
      commitMessage: `CEO: ${input.summary.trim()}`,
      allowResourceSourceFiles: true,
      operationResultProducer: (_changedFiles) => {
        return {
          resource: appliedResourceReceipt,
          renamed: finalCtx ? finalCtx.location.relative_path !== initialRelativePath : false,
          old_path: initialRelativePath,
          new_path: finalCtx ? finalCtx.location.relative_path : initialRelativePath,
        };
      },
      mutator: async (worktree, worktreeMatcher) => {
        const location = await resolveResourceLocation(worktree, input.resource_id);
        if (!location) {
          throw new CeoError("NOT_FOUND", `Resource '${input.resource_id}' does not exist.`, {
            resource_id: input.resource_id,
          });
        }

        initialRelativePath = location.relative_path;

        const ctx: ResourceExecutionContext = {
          location: { ...location },
          getResDir: () => path.join(worktree, ctx.location.relative_path),
          getMetaPath: () => path.join(ctx.getResDir(), "meta.md"),
        };
        finalCtx = ctx;

        const metaContent = await readFile(ctx.getMetaPath(), "utf8").catch(() => null);
        if (!metaContent) {
          throw new CeoError("NOT_FOUND", `Resource '${input.resource_id}' meta.md not found.`, {
            resource_id: input.resource_id,
          });
        }

        const doc = parseMetaMarkdown(metaContent);
        const meta = doc.meta;

        await this.executeResourceOperations(worktree, ctx, meta, input.operations);

        // Update meta.md
        const metaMarkdown = formatMetaMarkdown(meta, doc.capture_note, doc.capture_history);
        await writeFile(ctx.getMetaPath(), metaMarkdown, "utf8");

        // Apply optional state changes
        if (input.state_changes && input.state_changes.length > 0) {
          this.workspace.validateOperations(input.state_changes, worktreeMatcher);
          await this.workspace.applyOperations(worktree, input.base_commit, input.state_changes);
        }

        const dirFiles = await readdir(ctx.getResDir()).catch(() => []);
        const artifactSet = new Set(dirFiles);
        let interactionsText: string | null = null;
        if (artifactSet.has("interactions.md")) {
          interactionsText = await readFile(path.join(ctx.getResDir(), "interactions.md"), "utf8").catch(() => null);
        }
        const stage = deriveResourceStage(artifactSet, interactionsText);

        appliedResourceReceipt = {
          resource_id: meta.resource_id,
          display_name: meta.display_name,
          naming_source: meta.naming_source,
          relative_path: ctx.location.relative_path,
          source_identity: meta.source_identity,
          title: meta.title,
          platform: meta.platform,
          resource_kind: meta.resource_kind,
          stage,
        };
      },
    });
  }

  private async executeResourceOperations(
    worktree: string,
    ctx: ResourceExecutionContext,
    meta: ResourceMeta,
    operations: ResourceApplyOperation[],
  ): Promise<void> {
    for (const op of operations) {
      const resDir = ctx.getResDir();

      if (op.op === "rename") {
        const trimmed = cleanDisplayName(op.display_name);
        if (!trimmed || Array.from(trimmed).length > MAX_DISPLAY_NAME_CHARS) {
          throw new CeoError(
            "VALIDATION_FAILED",
            `display_name must be between 1 and ${MAX_DISPLAY_NAME_CHARS} characters.`,
          );
        }
        await applyResourceRename(worktree, ctx, meta, trimmed, "explicit");
      } else if (op.op === "attach_source_asset") {
        const buf = Buffer.from(op.data_base64, "base64");
        const asset = validateSourceAsset(op.filename, op.mime_type, buf);
        const idInfo = computeFileIdentity(buf);

        // Late identity collision check: search if any other resource has identical hash
        const colliding = await findResourceByHash(worktree, idInfo.source_hash, meta.resource_id);
        if (colliding) {
          throw new CeoError(
            "DUPLICATE_RESOURCE",
            `File asset matches existing resource '${colliding.location.resource_id}'. Automatic merge is not supported.`,
            { collision_resource_id: colliding.location.resource_id, source_hash: idInfo.source_hash },
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
          formattedEntry = `# Interactions — ${meta.resource_id}\n${formattedEntry}`;
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
}
