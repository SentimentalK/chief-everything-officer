import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import type { WorkspaceConfig } from "./git.js";
import { CeoError } from "./errors.js";
import {
  assertExpectedBlob,
  blobOid,
  getTreeEntry,
  listTreeEntries,
  readBlobUtf8,
  resolveRef,
  runGit,
  type GitTreeEntry,
} from "./git.js";
import { type CeoIgnoreMatcher, isPathIgnored, parseCeoIgnore } from "./ignore.js";
import { LIMITS } from "./limits.js";
import {
  assertContentSize,
  assertNoSymlink,
  isAllowedTrackedPath,
  validatePath,
} from "./policy.js";
import { isAllowedResourceSourcePath } from "./resource/security.js";

export interface WorkspaceSnapshot {
  commit: string;
  ignoreMatcher: CeoIgnoreMatcher;
}

export type WorkspaceState = "RECOVERING" | "READY" | "PUSH_PENDING" | "BLOCKED" | "NOT_READY";

export type ChangeOperation =
  | { op: "create"; path: string; content: string }
  | { op: "replace"; path: string; expected_blob_oid: string; content: string }
  | { op: "append"; path: string; expected_blob_oid: string; content: string }
  | { op: "delete"; path: string; expected_blob_oid: string }
  | { op: "move"; path: string; expected_blob_oid: string; target: string };

interface PendingTransaction {
  request_id: string;
  base_commit: string;
  commit: string;
  worktree: string;
  changed_files: string[];
  diff_stat: string;
  operation_result?: Record<string, unknown>;
}

interface CompletedTransaction {
  request_id: string;
  base_commit: string;
  commit: string;
  worktree?: string;
  changed_files: string[];
  diff_stat: string;
  pushed_at: string;
  pushed?: boolean;
  operation_result?: Record<string, unknown>;
}

export interface LockOwnerMetadata {
  lockId: string;
  instanceId: string;
  pid: number;
  at: string;
  createdAtMs: number;
}

export const PROCESS_INSTANCE_ID = randomUUID();
export const LOCK_SETUP_GRACE_MS = 5_000;
export const ACTIVE_WORKSPACE_LOCKS = new Map<string, string>();
export const STALE_RECOVERY_BY_LOCK_DIR = new Map<string, Promise<boolean>>();

export function normalizeListPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function isResourcePath(candidate: string): boolean {
  try {
    const normalized = validatePath(candidate);
    return normalized === "resources" || normalized.startsWith("resources/");
  } catch {
    const trimmed = candidate.replace(/\\/g, "/").replace(/^\/+/, "").trim();
    return trimmed === "resources" || trimmed.startsWith("resources/");
  }
}

/**
 * Default search_text scope: every non-resources Markdown file, plus each
 * Resource directory's interactions.md only. meta/summary/content/evidence.md,
 * source/**, and any other resources/** file stay out of the default scope.
 * The regex requires exactly one path segment between resources/ and
 * interactions.md, so nested resources/a/b/interactions.md stays excluded.
 */
function isDefaultSearchPath(filePath: string): boolean {
  if (!filePath.startsWith("resources/")) return true;
  return /^resources\/[^/]+\/interactions\.md$/.test(filePath);
}

/**
 * Archived tasks live under archive/<4-digit year>/<basename>.md, exactly one
 * path segment per year. Deeper nesting and non-4-digit year directories are
 * not valid archive homes and are never considered a fallback target.
 */
const ARCHIVE_ENTRY_RE = /^archive\/(\d{4})\/([^/]+\.md)$/;

/** A `tasks/<filename>.md` reference, exactly one segment under tasks/. */
function isTaskFilePath(filePath: string): boolean {
  return /^tasks\/[^/]+\.md$/.test(filePath);
}

/** Basename of a valid archived entry, or null when the entry is not a task archive file. */
function archiveEntryBasename(entry: string): string | null {
  const match = ARCHIVE_ENTRY_RE.exec(entry);
  return match ? match[2]! : null;
}

/**
 * Maps a raw filesystem error to a closed-union CeoError without leaking the
 * host path. ENOENT is intentionally NOT handled here: callers classify it
 * themselves (missing files drive the archive fallback decision).
 */
export function mapReadFsError(error: unknown, displayPath: string): CeoError {
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case "EACCES":
    case "EPERM":
      return new CeoError("ACCESS_DENIED", "Access to the requested file was denied.", { path: displayPath });
    case "EISDIR":
    case "ENOTDIR":
    case "ELOOP":
      return new CeoError("INVALID_PATH", "Requested path is not a regular file.", { path: displayPath });
    default:
      return new CeoError("INTERNAL_ERROR", "The CEO workspace operation failed.", { path: displayPath, error_code: code ?? "UNKNOWN" });
  }
}

export function assertNoResourceMutations(
  operations: ChangeOperation[],
  context: "apply_change_set" | "state_changes",
): void {
  for (const operation of operations) {
    if (isResourcePath(operation.path)) {
      const details: Record<string, unknown> = {
        path: operation.path,
        op: operation.op,
        context,
      };
      if (operation.op === "move") {
        details.target = operation.target;
      }
      const message =
        context === "apply_change_set"
          ? "Generic apply_change_set cannot mutate resources/**. Use resource_capture for new Resources or resource_apply for existing Resources."
          : "Resource state_changes cannot mutate resources/**. Use typed Resource operations for Resource artifacts.";
      throw new CeoError("RESOURCE_API_REQUIRED", message, details);
    }

    if (operation.op === "move" && isResourcePath(operation.target)) {
      const details: Record<string, unknown> = {
        path: operation.path,
        target: operation.target,
        op: operation.op,
        context,
      };
      const message =
        context === "apply_change_set"
          ? "Generic apply_change_set cannot mutate resources/**. Use resource_capture for new Resources or resource_apply for existing Resources."
          : "Resource state_changes cannot mutate resources/**. Use typed Resource operations for Resource artifacts.";
      throw new CeoError("RESOURCE_API_REQUIRED", message, details);
    }
  }
}

export class CeoWorkspace {
  private state: WorkspaceState = "RECOVERING";
  private lastPushAt: string | null = null;
  private readonly lockDir: string;
  private readonly pendingPath: string;
  private readonly completedDir: string;

  constructor(public readonly config: WorkspaceConfig) {
    this.lockDir = path.join(config.stateDir, "write.lock");
    this.pendingPath = path.join(config.stateDir, "pending.json");
    this.completedDir = path.join(config.stateDir, "completed");
  }

  get readiness(): WorkspaceState { return this.state; }

  async initialize(): Promise<void> {
    this.state = "RECOVERING";
    await mkdir(this.config.dataRoot, { recursive: true });
    await mkdir(this.config.txnDir, { recursive: true });
    await mkdir(this.config.stateDir, { recursive: true });
    await mkdir(this.completedDir, { recursive: true });
    await this.removeStaleLock();
    await this.withExclusiveWorkspaceMutation(async () => {
      await this.ensureRepository();
      await this.recoverPending();
      await this.syncCleanWorkspace();
      this.state = "READY";
    });
  }

  async workspaceStatus(): Promise<Record<string, unknown>> {
    return await this.withExclusiveWorkspaceMutation(async () => {
      await this.recoverPending();
      if (this.state === "BLOCKED") throw new CeoError("WORKSPACE_DIVERGED", "Pending commit diverged from origin/main.");
      await this.syncCleanWorkspace();
      const local = await resolveRef(this.config, this.config.repoDir, "HEAD");
      const remote = await resolveRef(this.config, this.config.repoDir, `origin/${this.config.branch}`);
      const clean = !(await runGit(this.config, this.config.repoDir, ["status", "--porcelain"])).stdout;
      const pending = await this.readPending();
      this.state = pending ? "PUSH_PENDING" : "READY";
      return {
        ok: true,
        request_id: randomUUID(),
        workspace_state: this.state,
        branch: this.config.branch,
        local_commit: local,
        remote_commit: remote,
        clean,
        pending_commit: pending?.commit ?? null,
        last_push_at: this.lastPushAt,
      };
    });
  }

  async captureReadSnapshot(): Promise<WorkspaceSnapshot> {
    if (this.state === "BLOCKED") {
      throw new CeoError("WORKSPACE_DIVERGED", "Workspace requires operator repair.");
    }
    if (this.state !== "READY") {
      throw new CeoError("NOT_READY", `Workspace is in ${this.state} state and not ready for reads.`);
    }
    const gitDir = path.join(this.config.repoDir, ".git");
    const exists = await access(gitDir, constants.F_OK).then(() => true).catch(() => false);
    if (!exists) {
      throw new CeoError("NOT_READY", "Workspace repository is not initialized.");
    }
    const commit = await resolveRef(this.config, this.config.repoDir, "HEAD");
    const ignoreMatcher = await this.loadIgnoreMatcherAtCommit(commit);
    return { commit, ignoreMatcher };
  }

  async loadIgnoreMatcherAtCommit(commit: string): Promise<CeoIgnoreMatcher> {
    try {
      const entry = await this.getSnapshotTreeEntry(commit, ".ceoignore");
      if (!entry) {
        return { exactFiles: new Set(), directoryPrefixes: [] };
      }
      if (entry.type === "tree") {
        throw Object.assign(new Error("EISDIR: illegal operation on a directory, read"), { code: "EISDIR" });
      }
      const content = await this.readBlob(entry.oid, ".ceoignore");
      return parseCeoIgnore(content);
    } catch (error: unknown) {
      if (error instanceof CeoError && error.code === "VALIDATION_FAILED") {
        throw error;
      }
      throw new CeoError(
        "NOT_READY",
        "Failed to read .ceoignore access boundary file.",
        { code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN" },
      );
    }
  }

  protected async getSnapshotTreeEntry(commit: string, entryPath: string): Promise<GitTreeEntry | null> {
    return await getTreeEntry(this.config, this.config.repoDir, commit, entryPath);
  }

  protected async readBlob(oid: string, filePath: string): Promise<string> {
    return await readBlobUtf8(this.config, this.config.repoDir, oid, filePath);
  }

  protected async listSnapshotTreeEntries(commit: string): Promise<GitTreeEntry[]> {
    return await listTreeEntries(this.config, this.config.repoDir, commit);
  }

  private async loadIgnoreMatcher(dir: string = this.config.repoDir): Promise<CeoIgnoreMatcher> {
    try {
      const content = await readFile(path.join(dir, ".ceoignore"), "utf8");
      return parseCeoIgnore(content);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { exactFiles: new Set(), directoryPrefixes: [] };
      }
      throw new CeoError(
        "NOT_READY",
        "Failed to read .ceoignore access boundary file.",
        { code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN" },
      );
    }
  }

  async listFiles(
    prefix = "",
    recursive = false,
    limit = 200,
  ): Promise<Record<string, unknown>> {
    if (prefix && (prefix.includes("..") || prefix.includes("\\") || path.posix.isAbsolute(prefix))) {
      throw new CeoError("INVALID_PATH", "Prefix must be a safe repository-relative path.", { prefix });
    }
    const normalizedPrefix = normalizeListPrefix(prefix);
    const snapshot = await this.captureReadSnapshot();
    const treeEntries = await this.listSnapshotTreeEntries(snapshot.commit);

    type UnifiedEntry =
      | { kind: "directory"; path: string }
      | { kind: "file"; path: string; blob_oid: string; bytes: number };

    const directoryPaths = new Set<string>();
    const rawFiles: Array<{ path: string; blob_oid: string; bytes: number }> = [];

    for (const entry of treeEntries) {
      const filePath = entry.path;
      if (!isAllowedTrackedPath(filePath) || isPathIgnored(snapshot.ignoreMatcher, filePath)) {
        continue;
      }

      if (normalizedPrefix && !filePath.startsWith(normalizedPrefix)) {
        continue;
      }

      if (recursive) {
        rawFiles.push({ path: filePath, blob_oid: entry.oid, bytes: entry.bytes ?? 0 });
      } else {
        const remainder = filePath.slice(normalizedPrefix.length);
        const slashIdx = remainder.indexOf("/");
        if (slashIdx === -1) {
          rawFiles.push({ path: filePath, blob_oid: entry.oid, bytes: entry.bytes ?? 0 });
        } else {
          const subDir = remainder.slice(0, slashIdx);
          const dirPath = `${normalizedPrefix}${subDir}/`;
          directoryPaths.add(dirPath);
        }
      }
    }

    const unifiedEntries: UnifiedEntry[] = [
      ...Array.from(directoryPaths).map((p) => ({ kind: "directory" as const, path: p })),
      ...rawFiles.map((f) => ({ kind: "file" as const, ...f })),
    ];

    unifiedEntries.sort((a, b) => a.path.localeCompare(b.path));

    const truncated = unifiedEntries.length > limit;
    const sliced = truncated ? unifiedEntries.slice(0, limit) : unifiedEntries;

    const directories: string[] = [];
    const files: Array<{ path: string; blob_oid: string; bytes: number }> = [];

    for (const entry of sliced) {
      if (entry.kind === "directory") {
        directories.push(entry.path);
      } else {
        files.push({ path: entry.path, blob_oid: entry.blob_oid, bytes: entry.bytes });
      }
    }

    return {
      ok: true,
      request_id: randomUUID(),
      workspace_state: "READY",
      base_commit: snapshot.commit,
      directories,
      files,
      truncated,
    };
  }

  async readFiles(paths: string[]): Promise<Record<string, unknown>> {
    if (paths.length === 0 || paths.length > LIMITS.maxFilesPerRead) {
      throw new CeoError("VALIDATION_FAILED", `Read between 1 and ${LIMITS.maxFilesPerRead} files.`);
    }
    const snapshot = await this.captureReadSnapshot();
    let archiveIndex: Map<string, string[]> | null = null;
    const getArchiveIndex = async (): Promise<Map<string, string[]>> => {
      if (archiveIndex) return archiveIndex;
      const index = new Map<string, string[]>();
      // listTrackedFiles already excludes .ceoignore'd entries, so restricted
      // archive candidates never reach the index or any error message. This
      // scans the tracked file list at most once per batch.
      for (const entry of await this.listTrackedFiles(snapshot.commit, snapshot.ignoreMatcher)) {
        const basename = archiveEntryBasename(entry);
        if (!basename) continue;
        const list = index.get(basename);
        if (list) list.push(entry);
        else index.set(basename, [entry]);
      }
      archiveIndex = index;
      return index;
    };

    let total = 0;
    const files = [];
    for (const requestedPath of paths) {
      // Tracks the path a raw filesystem or git error was raised against: the
      // original requested path until resolution succeeds, the resolved
      // (possibly archived) path afterwards. Never a host absolute path.
      let displayPath = requestedPath;
      try {
        const resolved = await this.resolveSnapshotReadTarget(snapshot, requestedPath, getArchiveIndex);
        displayPath = resolved.path;
        if (resolved.size > LIMITS.maxFileWriteBytes) {
          throw new CeoError("VALIDATION_FAILED", `File size (${Math.round(resolved.size / 1024)} KiB) exceeds max single-file limit (${Math.round(LIMITS.maxFileWriteBytes / (1024 * 1024))} MiB).`, { path: resolved.path });
        }
        total += resolved.size;
        if (total > LIMITS.maxReadResponseBytes) {
          throw new CeoError("VALIDATION_FAILED", `Total response size exceeds response budget of ${Math.round(LIMITS.maxReadResponseBytes / (1024 * 1024))} MiB.`);
        }
        const content = await this.readBlob(resolved.oid, resolved.path);
        files.push({ requested_path: requestedPath, path: resolved.path, blob_oid: resolved.oid, content });
      } catch (error) {
        throw this.withReadErrorContext(error, paths, requestedPath, displayPath);
      }
    }
    return { ok: true, request_id: randomUUID(), workspace_state: "READY", base_commit: snapshot.commit, files };
  }

  async readOptionalMarkdown(relativePath: string): Promise<{
    path: string;
    blob_oid: string | null;
    content: string;
    base_commit: string;
  } | null> {
    const validatedPath = validatePath(relativePath);
    const snapshot = await this.captureReadSnapshot();
    if (isPathIgnored(snapshot.ignoreMatcher, validatedPath)) {
      throw new CeoError("ACCESS_DENIED", "Requested path is excluded by .ceoignore.", { path: validatedPath });
    }

    const entry = await this.getSnapshotTreeEntry(snapshot.commit, validatedPath);
    if (!entry) return null;

    if (entry.mode === "120000") {
      throw new CeoError("INVALID_PATH", "Symlinks are forbidden in CEO content paths.", { path: validatedPath });
    }
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new CeoError("INVALID_PATH", "Requested path is not a regular file.", { path: validatedPath });
    }
    if (entry.bytes !== undefined && entry.bytes > LIMITS.maxFileWriteBytes) {
      throw new CeoError(
        "VALIDATION_FAILED",
        `File size (${Math.round(entry.bytes / 1024)} KiB) exceeds max single-file limit (${Math.round(LIMITS.maxFileWriteBytes / (1024 * 1024))} MiB).`,
        { path: validatedPath },
      );
    }
    const content = await this.readBlob(entry.oid, validatedPath);
    return {
      path: validatedPath,
      blob_oid: entry.oid,
      content,
      base_commit: snapshot.commit,
    };
  }

  /**
   * Resolves where a requested file is read from in the snapshot commit and
   * returns its actual path, blob OID, and size. When the requested
   * `tasks/<name>.md` does not exist in the snapshot and exactly one tracked
   * `archive/<year>/<name>.md` exists, the archive file is the read target.
   */
  private async resolveSnapshotReadTarget(
    snapshot: WorkspaceSnapshot,
    requestedPath: string,
    getArchiveIndex: () => Promise<Map<string, string[]>>,
  ): Promise<{ path: string; oid: string; size: number }> {
    const filePath = validatePath(requestedPath);
    if (isPathIgnored(snapshot.ignoreMatcher, filePath)) {
      throw new CeoError("ACCESS_DENIED", "Requested path is excluded by .ceoignore.", { path: filePath });
    }

    const original = await this.getSnapshotTreeEntry(snapshot.commit, filePath);
    if (original) {
      if (original.mode === "120000") {
        throw new CeoError("INVALID_PATH", "Symlinks are forbidden in CEO content paths.", { path: filePath });
      }
      if (original.type !== "blob" || (original.mode !== "100644" && original.mode !== "100755")) {
        throw new CeoError("INVALID_PATH", "Requested path is not a regular file.", { path: filePath });
      }
      // The original exists: read it, never consult archive.
      return { path: filePath, oid: original.oid, size: original.bytes ?? 0 };
    }

    // Missing original. Only a single-level tasks/ reference may consult archive.
    if (!isTaskFilePath(filePath)) {
      throw new CeoError("INVALID_PATH", "Requested file was not found. Correct the path and retry the complete batch.", { path: filePath, reason: "NOT_FOUND" });
    }
    const basename = filePath.slice("tasks/".length);
    const candidates = ((await getArchiveIndex()).get(basename) ?? []).slice().sort();
    if (candidates.length === 0) {
      throw new CeoError("INVALID_PATH", "Task file was not found at the requested path or in archive. Correct the path and retry the complete batch.", { path: filePath, reason: "NOT_FOUND" });
    }
    if (candidates.length > 1) {
      throw new CeoError("INVALID_PATH", "Task file exists in multiple archive years. Specify the archive path explicitly and retry the complete batch.", { path: filePath, reason: "AMBIGUOUS_ARCHIVE_MATCH", candidates });
    }
    const actualPath = candidates[0]!;
    const archived = await this.getSnapshotTreeEntry(snapshot.commit, actualPath);
    if (!archived) {
      throw new CeoError("INVALID_PATH", "Requested file was not found. Correct the path and retry the complete batch.", { path: actualPath, reason: "NOT_FOUND" });
    }
    if (archived.mode === "120000") {
      throw new CeoError("INVALID_PATH", "Symlinks are forbidden in CEO content paths.", { path: actualPath });
    }
    if (archived.type !== "blob" || (archived.mode !== "100644" && archived.mode !== "100755")) {
      throw new CeoError("INVALID_PATH", "Requested path is not a regular file.", { path: actualPath });
    }
    return { path: actualPath, oid: archived.oid, size: archived.bytes ?? 0 };
  }

  /**
   * Single enrichment point for read_files batch failures. CeoErrors keep their
   * code/message/details; raw filesystem errors are mapped through
   * mapReadFsError against the path that actually failed; anything else becomes
   * a generic INTERNAL_ERROR. The original user-supplied batch (not a validated
   * prefix) is always echoed as requested_paths alongside the failing entry.
   */
  private withReadErrorContext(error: unknown, requestedPaths: string[], failedRequestedPath: string, displayPath: string): CeoError {
    const mapped = error instanceof CeoError ? error : mapReadFsError(error, displayPath);
    return new CeoError(mapped.code, mapped.message, {
      ...mapped.details,
      requested_paths: [...requestedPaths],
      failed_requested_path: failedRequestedPath,
    });
  }

  async searchText(query: string, prefixes: string[], limit: number): Promise<Record<string, unknown>> {
    if (!query || Buffer.byteLength(query, "utf8") > 512) {
      throw new CeoError("VALIDATION_FAILED", "Search query must contain 1 to 512 UTF-8 bytes.");
    }
    const safePrefixes = prefixes.length ? prefixes : [""];
    for (const prefix of safePrefixes) {
      if (prefix.includes("..") || prefix.includes("\\") || path.posix.isAbsolute(prefix)) {
        throw new CeoError("INVALID_PATH", "Search prefix is invalid.", { prefix });
      }
    }

    const snapshot = await this.captureReadSnapshot();
    const treeEntries = await this.listSnapshotTreeEntries(snapshot.commit);

    const matches: Array<{ path: string; line: number; snippet: string }> = [];
    for (const entry of treeEntries) {
      const filePath = entry.path;
      if (!isAllowedTrackedPath(filePath) || isPathIgnored(snapshot.ignoreMatcher, filePath)) continue;
      if (prefixes.length === 0 && !isDefaultSearchPath(filePath)) continue;
      if (!safePrefixes.some((prefix) => filePath.startsWith(prefix))) continue;
      if (entry.mode === "120000") {
        throw new CeoError("INVALID_PATH", "Symlinks are forbidden in CEO content paths.", { path: filePath });
      }
      if (entry.type !== "blob") continue;

      const content = await this.readBlob(entry.oid, filePath);
      for (const [index, line] of content.split("\n").entries()) {
        if (line.includes(query)) {
          matches.push({ path: filePath, line: index + 1, snippet: line.slice(0, 300) });
          if (matches.length >= limit) {
            return { ok: true, request_id: randomUUID(), workspace_state: "READY", base_commit: snapshot.commit, matches, truncated: true };
          }
        }
      }
    }
    return { ok: true, request_id: randomUUID(), workspace_state: "READY", base_commit: snapshot.commit, matches, truncated: false };
  }

  async isRequestCompleted(requestId: string): Promise<Record<string, unknown> | null> {
    const completed = await this.readCompleted(requestId);
    if (completed) {
      return this.completedResult(completed);
    }
    return null;
  }

  async withAtomicWorkspaceTransaction(input: {
    requestId: string;
    baseCommit: string;
    commitMessage: string;
    allowResourceSourceFiles?: boolean;
    allowEmpty?: boolean;
    operationResultProducer?: (changedFiles: string[]) => Record<string, unknown>;
    mutator: (worktree: string, worktreeMatcher: CeoIgnoreMatcher) => Promise<void>;
  }): Promise<Record<string, unknown>> {
    const {
      requestId,
      baseCommit,
      commitMessage,
      allowResourceSourceFiles = false,
      allowEmpty = false,
      operationResultProducer,
      mutator,
    } = input;
    return await this.withExclusiveWorkspaceMutation(async () => {
      const completed = await this.readCompleted(requestId);
      if (completed) return this.completedResult(completed);
      await this.recoverPending();
      if (await this.readPending()) throw new CeoError("PUSH_PENDING", "A previous commit is awaiting push verification.");
      await this.syncCleanWorkspace();
      const remote = await resolveRef(this.config, this.config.repoDir, `origin/${this.config.branch}`);
      if (remote !== baseCommit) {
        throw new CeoError("STALE_REVISION", "origin/main changed since the files were read.", {
          expected: baseCommit,
          remote_head: remote,
        });
      }

      const worktree = path.join(this.config.txnDir, requestId);
      await rm(worktree, { recursive: true, force: true });
      await runGit(this.config, this.config.repoDir, ["worktree", "add", "--detach", worktree, baseCommit]);
      const worktreeMatcher = await this.loadIgnoreMatcher(worktree);
      let committed = false;
      try {
        await mutator(worktree, worktreeMatcher);
        const changed = await this.validateDiff(worktree, worktreeMatcher, allowResourceSourceFiles, allowEmpty);

        if (changed.length === 0) {
          await this.discardWorktree(worktree);
          const opRes = operationResultProducer ? operationResultProducer([]) : undefined;
          const completedNoop: CompletedTransaction = {
            request_id: requestId,
            base_commit: baseCommit,
            commit: baseCommit,
            changed_files: [],
            diff_stat: "",
            pushed: false,
            pushed_at: new Date().toISOString(),
            ...(opRes ? { operation_result: opRes } : {}),
          };
          await this.writeJson(path.join(this.completedDir, `${requestId}.json`), completedNoop);
          return this.completedResult(completedNoop);
        }

        await runGit(this.config, worktree, ["add", "-A"]);
        try {
          await runGit(this.config, worktree, ["diff", "--cached", "--check"]);
        } catch (err: any) {
          throw new CeoError(
            "VALIDATION_FAILED",
            `Git diff check rejected changes: ${err?.message || err}`,
          );
        }
        await runGit(this.config, worktree, ["commit", "-m", commitMessage]);
        committed = true;
        const commit = await resolveRef(this.config, worktree, "HEAD");
        const diffStat = (await runGit(this.config, worktree, ["show", "--stat", "--format=", "HEAD"])).stdout;
        const opRes = operationResultProducer ? operationResultProducer(changed) : undefined;
        const pending: PendingTransaction = {
          request_id: requestId,
          base_commit: baseCommit,
          commit,
          worktree,
          changed_files: changed,
          diff_stat: diffStat,
          ...(opRes ? { operation_result: opRes } : {}),
        };
        await this.writePending(pending);
        await runGit(this.config, this.config.repoDir, ["fetch", "origin", this.config.branch]);
        const latest = await resolveRef(this.config, this.config.repoDir, `origin/${this.config.branch}`);
        if (latest !== baseCommit) {
          this.state = "BLOCKED";
          throw new CeoError("STALE_REVISION", "origin/main moved during the transaction; the local commit was not pushed.", {
            remote_head: latest,
            pending_commit: commit,
          });
        }
        try {
          await runGit(this.config, worktree, ["push", "origin", `HEAD:refs/heads/${this.config.branch}`]);
        } catch {
          this.state = "PUSH_PENDING";
          throw new CeoError("PUSH_PENDING", "Commit created locally, but push could not be verified.", { commit });
        }
        await this.finalizePending(pending);
        return this.completedResult({ ...pending, pushed_at: this.lastPushAt! });
      } catch (error) {
        if (!committed) await this.discardWorktree(worktree);
        throw error;
      }
    });
  }

  async applyChangeSet(input: {
    request_id?: string;
    base_commit: string;
    summary: string;
    operations: ChangeOperation[];
  }): Promise<Record<string, unknown>> {
    const requestId = input.request_id ?? randomUUID();
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new CeoError("VALIDATION_FAILED", "request_id must be a UUID.");
    if (!input.summary.trim() || input.summary.length > 120 || /[\r\n]/.test(input.summary)) {
      throw new CeoError("VALIDATION_FAILED", "Summary must be a single line of 1 to 120 characters.");
    }
    if (input.operations.length === 0 || input.operations.length > LIMITS.maxOperationsPerTransaction) {
      throw new CeoError("VALIDATION_FAILED", `Apply between 1 and ${LIMITS.maxOperationsPerTransaction} operations.`);
    }

    assertNoResourceMutations(input.operations, "apply_change_set");

    return await this.withAtomicWorkspaceTransaction({
      requestId,
      baseCommit: input.base_commit,
      commitMessage: `CEO: ${input.summary.trim()}`,
      allowResourceSourceFiles: false,
      mutator: async (worktree, worktreeMatcher) => {
        this.validateOperations(input.operations, worktreeMatcher);
        await this.applyOperations(worktree, input.base_commit, input.operations);
      },
    });
  }

  async withReadyWorkspace<T>(operation: (base: string) => Promise<T>): Promise<T> {
    return await this.withExclusiveWorkspaceMutation(async () => {
      await this.recoverPending();
      if (this.state === "BLOCKED") throw new CeoError("WORKSPACE_DIVERGED", "Workspace requires operator repair.");
      await this.syncCleanWorkspace();
      const base = await resolveRef(this.config, this.config.repoDir, "HEAD");
      this.state = "READY";
      return await operation(base);
    });
  }

  private async ensureRepository(): Promise<void> {
    const gitDir = path.join(this.config.repoDir, ".git");
    const exists = await access(gitDir, constants.F_OK).then(() => true).catch(() => false);
    if (!exists) {
      const entries = await readdir(this.config.repoDir).catch(() => []);
      if (entries.length > 0) throw new CeoError("NOT_READY", "Repository directory is non-empty but is not a Git checkout.");
      await mkdir(path.dirname(this.config.repoDir), { recursive: true });
      await runGit(this.config, this.config.dataRoot, ["clone", "--branch", this.config.branch, "--single-branch", this.config.remoteUrl, this.config.repoDir]);
    }
    const origin = (await runGit(this.config, this.config.repoDir, ["remote", "get-url", "origin"])).stdout;
    if (origin !== this.config.remoteUrl) {
      throw new CeoError("NOT_READY", "Git origin does not match the configured CEO repository.");
    }
  }

  private async syncCleanWorkspace(): Promise<void> {
    const dirty = (await runGit(this.config, this.config.repoDir, ["status", "--porcelain"])).stdout;
    if (dirty) throw new CeoError("WORKSPACE_DIRTY", "Main working copy contains uncommitted changes.");
    await runGit(this.config, this.config.repoDir, ["fetch", "origin", this.config.branch]);
    const local = await resolveRef(this.config, this.config.repoDir, "HEAD");
    const remote = await resolveRef(this.config, this.config.repoDir, `origin/${this.config.branch}`);
    if (local === remote) return;
    try {
      await runGit(this.config, this.config.repoDir, ["merge", "--ff-only", remote]);
    } catch {
      this.state = "BLOCKED";
      throw new CeoError("WORKSPACE_DIVERGED", "Local and remote CEO history diverged.", { local, remote });
    }
  }

  validateOperations(operations: ChangeOperation[], matcher: CeoIgnoreMatcher): void {
    let total = 0;
    const touched = new Set<string>();
    for (const operation of operations) {
      const source = validatePath(operation.path);
      if (isPathIgnored(matcher, source)) {
        throw new CeoError("ACCESS_DENIED", "Operation path is excluded by .ceoignore.", { path: source });
      }
      const paths = operation.op === "move" ? [source, validatePath(operation.target)] : [source];
      if (operation.op === "move") {
        const target = validatePath(operation.target);
        if (isPathIgnored(matcher, target)) {
          throw new CeoError("ACCESS_DENIED", "Move target path is excluded by .ceoignore.", { target });
        }
        if (source === target) {
          throw new CeoError("INVALID_OPERATION", "Move source and target cannot be identical.", { source, target });
        }
      }
      if ("content" in operation) total += assertContentSize(operation.content);
      for (const filePath of paths) {
        if (touched.has(filePath)) throw new CeoError("INVALID_OPERATION", "A path may be changed only once per transaction.", { path: filePath });
        touched.add(filePath);
      }
    }
    if (total > LIMITS.maxTotalWriteBytes) throw new CeoError("VALIDATION_FAILED", `Transaction content exceeds ${Math.round(LIMITS.maxTotalWriteBytes / (1024 * 1024))} MiB.`);
  }

  async applyOperations(worktree: string, base: string, operations: ChangeOperation[]): Promise<void> {
    for (const operation of operations) {
      const filePath = validatePath(operation.path);
      await assertNoSymlink(worktree, filePath);
      const absolute = path.join(worktree, filePath);
      if (operation.op === "create") {
        const exists = await access(absolute).then(() => true).catch(() => false);
        if (exists) throw new CeoError("INVALID_OPERATION", "Create target already exists.", { path: filePath });
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, operation.content, { encoding: "utf8", flag: "wx" });
      } else if (operation.op === "replace") {
        await assertExpectedBlob(this.config, worktree, base, filePath, operation.expected_blob_oid);
        await writeFile(absolute, operation.content, "utf8");
      } else if (operation.op === "append") {
        await assertExpectedBlob(this.config, worktree, base, filePath, operation.expected_blob_oid);
        const current = await this.readUtf8(absolute, filePath);
        assertContentSize(current + operation.content);
        await writeFile(absolute, current + operation.content, "utf8");
      } else if (operation.op === "delete") {
        await assertExpectedBlob(this.config, worktree, base, filePath, operation.expected_blob_oid);
        await rm(absolute, { force: true });
      } else if (operation.op === "move") {
        const target = validatePath(operation.target);
        await assertExpectedBlob(this.config, worktree, base, filePath, operation.expected_blob_oid);
        await assertNoSymlink(worktree, target);
        const targetAbsolute = path.join(worktree, target);
        const exists = await access(targetAbsolute).then(() => true).catch(() => false);
        if (exists) throw new CeoError("INVALID_OPERATION", "Move target already exists.", { target });
        await mkdir(path.dirname(targetAbsolute), { recursive: true });
        await rename(absolute, targetAbsolute);
      }
    }
  }

  private async validateDiff(
    worktree: string,
    matcher: CeoIgnoreMatcher,
    allowResourceSourceFiles = false,
    allowEmpty = false,
  ): Promise<string[]> {
    const tracked = (await runGit(this.config, worktree, ["diff", "--name-only", "-z"])).stdout
      .split("\0").filter(Boolean);
    const untracked = (await runGit(this.config, worktree, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout
      .split("\0").filter(Boolean);
    const changed = [...tracked, ...untracked];
    if (changed.length === 0) {
      if (allowEmpty) return [];
      throw new CeoError("VALIDATION_FAILED", "Change set produces no file changes.");
    }
    for (const filePath of changed) {
      if (allowResourceSourceFiles && isAllowedResourceSourcePath(filePath)) {
        // Safe document file in resources/<id>/source/original.<ext>
      } else {
        validatePath(filePath);
      }
      if (isPathIgnored(matcher, filePath)) {
        throw new CeoError("ACCESS_DENIED", "Changed path in diff is excluded by .ceoignore.", { path: filePath });
      }
    }
    return [...new Set(changed)].sort();
  }

  private async listTrackedFiles(base: string, matcher: CeoIgnoreMatcher): Promise<string[]> {
    const result = await runGit(this.config, this.config.repoDir, ["ls-tree", "-r", "--name-only", base]);
    return result.stdout.split("\n").filter((f) => isAllowedTrackedPath(f) && !isPathIgnored(matcher, f));
  }

  private async recoverPending(): Promise<void> {
    const pending = await this.readPending();
    if (!pending) return;
    this.state = "RECOVERING";
    try {
      await runGit(this.config, this.config.repoDir, ["fetch", "origin", this.config.branch]);
    } catch {
      this.state = "PUSH_PENDING";
      throw new CeoError("PUSH_PENDING", "Cannot reach GitHub to recover the pending commit.", { commit: pending.commit });
    }
    const remote = await resolveRef(this.config, this.config.repoDir, `origin/${this.config.branch}`);
    if (remote === pending.commit) {
      await this.finalizePending(pending);
      return;
    }
    try {
      await runGit(this.config, this.config.repoDir, ["merge-base", "--is-ancestor", pending.commit, remote]);
      await this.finalizePending(pending, remote);
      return;
    } catch {
      // Continue classification below.
    }
    if (remote === pending.base_commit) {
      try {
        await runGit(this.config, pending.worktree, ["push", "origin", `HEAD:refs/heads/${this.config.branch}`]);
        await this.finalizePending(pending);
        return;
      } catch {
        this.state = "PUSH_PENDING";
        throw new CeoError("PUSH_PENDING", "Pending commit still cannot be pushed.", { commit: pending.commit });
      }
    }
    this.state = "BLOCKED";
    throw new CeoError("WORKSPACE_DIVERGED", "Remote history moved away from the pending transaction.", {
      pending_commit: pending.commit,
      remote_head: remote,
    });
  }

  private async finalizePending(pending: PendingTransaction, remoteOverride?: string): Promise<void> {
    await runGit(this.config, this.config.repoDir, ["fetch", "origin", this.config.branch]);
    const remote = remoteOverride ?? await resolveRef(this.config, this.config.repoDir, `origin/${this.config.branch}`);
    try {
      await runGit(this.config, this.config.repoDir, ["merge", "--ff-only", remote]);
    } catch {
      this.state = "NOT_READY";
      throw new CeoError("PUSHED_LOCAL_REPAIR_NEEDED", "GitHub accepted the commit, but the local cache could not fast-forward.", {
        commit: pending.commit,
      });
    }
    this.lastPushAt = new Date().toISOString();
    const completed: CompletedTransaction = { ...pending, pushed_at: this.lastPushAt, pushed: true };
    await this.writeJson(path.join(this.completedDir, `${pending.request_id}.json`), completed);
    await rm(this.pendingPath, { force: true });
    await this.discardWorktree(pending.worktree);
    this.state = "READY";
  }

  private completedResult(completed: CompletedTransaction): Record<string, unknown> {
    return {
      ok: true,
      request_id: completed.request_id,
      workspace_state: "READY",
      base_commit: completed.base_commit,
      commit: completed.commit,
      pushed: completed.pushed ?? true,
      changed_files: completed.changed_files,
      diff_stat: completed.diff_stat,
      pushed_at: completed.pushed_at,
      ...(completed.operation_result ? completed.operation_result : {}),
    };
  }

  private async discardWorktree(worktree: string): Promise<void> {
    if (!path.resolve(worktree).startsWith(`${path.resolve(this.config.txnDir)}${path.sep}`)) return;
    await runGit(this.config, this.config.repoDir, ["worktree", "remove", "--force", worktree], true);
    await rm(worktree, { recursive: true, force: true });
    await runGit(this.config, this.config.repoDir, ["worktree", "prune"], true);
  }

  private async readPending(): Promise<PendingTransaction | null> {
    return await this.readJson<PendingTransaction>(this.pendingPath);
  }

  private async writePending(pending: PendingTransaction): Promise<void> {
    await this.writeJson(this.pendingPath, pending);
  }

  private async readCompleted(requestId: string): Promise<CompletedTransaction | null> {
    return await this.readJson<CompletedTransaction>(path.join(this.completedDir, `${requestId}.json`));
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try { return JSON.parse(await readFile(filePath, "utf8")) as T; }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async readUtf8(filePath: string, displayPath: string): Promise<string> {
    const bytes = await readFile(filePath);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new CeoError("VALIDATION_FAILED", "CEO content must be valid UTF-8.", { path: displayPath });
    }
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  }

  protected async createLockDir(): Promise<void> {
    await mkdir(this.lockDir);
  }

  protected async writeOwnerJson(filePath: string, meta: LockOwnerMetadata): Promise<void> {
    await writeFile(filePath, JSON.stringify(meta), { encoding: "utf8", mode: 0o600 });
  }

  async withExclusiveWorkspaceMutation<T>(operation: () => Promise<T>): Promise<T> {
    return await this.acquireAndRunLock(operation, /* allowStaleRetry */ true);
  }

  private async acquireAndRunLock<T>(
    operation: () => Promise<T>,
    allowStaleRetry: boolean,
  ): Promise<T> {
    const lockId = randomUUID();
    let acquired = false;
    let ownerWritten = false;

    try {
      await this.createLockDir();
      acquired = true;

      const ownerMeta: LockOwnerMetadata = {
        lockId,
        instanceId: PROCESS_INSTANCE_ID,
        pid: process.pid,
        at: new Date().toISOString(),
        createdAtMs: Date.now(),
      };
      await this.writeOwnerJson(path.join(this.lockDir, "owner.json"), ownerMeta);
      ownerWritten = true;
      ACTIVE_WORKSPACE_LOCKS.set(this.lockDir, lockId);

      return await operation();
    } catch (error: unknown) {
      if (acquired) {
        // Error occurred inside writeFile or operation. Handled by finally.
        throw error;
      }

      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (allowStaleRetry) {
          const recovered = await this.recoverStaleLockSerialized();
          if (recovered) {
            return await this.acquireAndRunLock(operation, /* allowStaleRetry */ false);
          }
        }

        throw new CeoError(
          "NOT_READY",
          "Another workspace operation currently holds the lock.",
          { reason: "WORKSPACE_BUSY" },
        );
      }

      throw error;
    } finally {
      if (acquired) {
        if (!ownerWritten) {
          // Setup failed before/during owner.json write.
          // Clean up directory unconditionally since this acquisition created it.
          await rm(this.lockDir, { recursive: true, force: true }).catch((err) => {
            console.error(
              `[CEO] workspace_lock_cleanup_failed lockId=${lockId} lockDir=${this.lockDir} error=${err?.message || err}`,
            );
          });
        } else {
          if (ACTIVE_WORKSPACE_LOCKS.get(this.lockDir) === lockId) {
            ACTIVE_WORKSPACE_LOCKS.delete(this.lockDir);
          }
          await this.releaseOwnedLock(lockId);
        }
      }
    }
  }

  private async releaseOwnedLock(lockId: string): Promise<boolean> {
    try {
      const currentOwner = await this.readJson<LockOwnerMetadata>(path.join(this.lockDir, "owner.json"));
      if (currentOwner?.lockId !== lockId) {
        return false;
      }
      await rm(this.lockDir, { recursive: true, force: true });
      return true;
    } catch (err: any) {
      console.error(
        `[CEO] workspace_lock_release_failed lockId=${lockId} lockDir=${this.lockDir} error=${err?.message || err}`,
      );
      return false;
    }
  }

  private async recoverStaleLockSerialized(): Promise<boolean> {
    const existing = STALE_RECOVERY_BY_LOCK_DIR.get(this.lockDir);
    if (existing) {
      return await existing;
    }

    const task = (async () => {
      try {
        const inspection = await this.inspectStaleLock();
        if (!inspection.isStale) {
          return false;
        }
        const reclaimed = await this.reclaimStaleLock(inspection.expectedLockId);
        if (reclaimed) {
          console.warn(
            `[CEO] workspace_lock_reclaimed lockDir=${this.lockDir} lockId=${inspection.expectedLockId ?? "unknown"} reason=${inspection.reason}`,
          );
        }
        return reclaimed;
      } finally {
        STALE_RECOVERY_BY_LOCK_DIR.delete(this.lockDir);
      }
    })();

    STALE_RECOVERY_BY_LOCK_DIR.set(this.lockDir, task);
    return await task;
  }

  private async inspectStaleLock(): Promise<{
    isStale: boolean;
    expectedLockId: string | null;
    reason?: string;
  }> {
    let owner: LockOwnerMetadata | null = null;
    try {
      owner = await this.readJson<LockOwnerMetadata>(path.join(this.lockDir, "owner.json"));
    } catch {
      owner = null;
    }

    // Case A: owner.json missing or invalid
    if (!owner || typeof owner.lockId !== "string") {
      try {
        const lockStat = await stat(this.lockDir);
        const ageMs = Date.now() - lockStat.mtimeMs;
        if (ageMs < LOCK_SETUP_GRACE_MS) {
          // Fresh directory (< 5s), setup may be in progress -> assume busy
          return { isStale: false, expectedLockId: null };
        }
        // Older than setup grace -> orphan stale
        return { isStale: true, expectedLockId: null, reason: "ownerless_orphan" };
      } catch {
        return { isStale: false, expectedLockId: null };
      }
    }

    // Case B: owner belongs to current Node process instance
    if (owner.instanceId === PROCESS_INSTANCE_ID) {
      if (ACTIVE_WORKSPACE_LOCKS.get(this.lockDir) === owner.lockId) {
        return { isStale: false, expectedLockId: owner.lockId };
      }
      // Same process instance, but not actively registered -> stale
      return { isStale: true, expectedLockId: owner.lockId, reason: "same_instance_orphan" };
    }

    // Case C: foreign instance / process (best-effort local check)
    if (typeof owner.pid === "number") {
      try {
        process.kill(owner.pid, 0);
        return { isStale: false, expectedLockId: owner.lockId };
      } catch (err: any) {
        if (err?.code === "ESRCH") {
          return { isStale: true, expectedLockId: owner.lockId, reason: "dead_foreign_pid" };
        }
        return { isStale: false, expectedLockId: owner.lockId };
      }
    }

    return { isStale: false, expectedLockId: null };
  }

  private async reclaimStaleLock(expectedLockId: string | null): Promise<boolean> {
    try {
      if (expectedLockId !== null) {
        const currentOwner = await this.readJson<LockOwnerMetadata>(path.join(this.lockDir, "owner.json"));
        if (currentOwner?.lockId !== expectedLockId) {
          return false;
        }
      } else {
        const currentOwner = await this.readJson<LockOwnerMetadata>(path.join(this.lockDir, "owner.json"));
        if (currentOwner && typeof currentOwner.lockId === "string") {
          return false;
        }
      }

      await rm(this.lockDir, { recursive: true, force: true });
      return true;
    } catch (err: any) {
      console.error(
        `[CEO] workspace_lock_reclaim_failed lockDir=${this.lockDir} expectedLockId=${expectedLockId} error=${err?.message || err}`,
      );
      return false;
    }
  }

  private async removeStaleLock(): Promise<void> {
    await this.recoverStaleLockSerialized();
  }
}
