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
import { constants } from "node:fs";
import type { Config } from "./config.js";
import { CeoError } from "./errors.js";
import { assertExpectedBlob, blobOid, resolveRef, runGit } from "./git.js";
import { LIMITS } from "./limits.js";
import {
  assertContentSize,
  assertNoSymlink,
  isAllowedTrackedPath,
  validateArchive,
  validatePath,
} from "./policy.js";

export type WorkspaceState = "RECOVERING" | "READY" | "PUSH_PENDING" | "BLOCKED" | "NOT_READY";

export type ChangeOperation =
  | { op: "create"; path: string; content: string }
  | { op: "replace"; path: string; expected_blob_oid: string; content: string }
  | { op: "append"; path: string; expected_blob_oid: string; content: string }
  | { op: "archive"; path: string; expected_blob_oid: string; target: string };

interface PendingTransaction {
  request_id: string;
  base_commit: string;
  commit: string;
  worktree: string;
  changed_files: string[];
  diff_stat: string;
}

interface CompletedTransaction extends PendingTransaction {
  pushed_at: string;
}

export class CeoWorkspace {
  private state: WorkspaceState = "RECOVERING";
  private lastPushAt: string | null = null;
  private readonly lockDir: string;
  private readonly pendingPath: string;
  private readonly completedDir: string;

  constructor(public readonly config: Config) {
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
    await this.withLock(async () => {
      await this.ensureRepository();
      await this.recoverPending();
      await this.syncCleanWorkspace();
      this.state = "READY";
    });
  }

  async workspaceStatus(): Promise<Record<string, unknown>> {
    return await this.withLock(async () => {
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

  async listFiles(prefix = "", limit = 200): Promise<Record<string, unknown>> {
    return await this.withReadyWorkspace(async (base) => {
      if (prefix && (prefix.includes("..") || prefix.includes("\\") || path.posix.isAbsolute(prefix))) {
        throw new CeoError("INVALID_PATH", "Prefix must be a safe repository-relative path.", { prefix });
      }
      const result = await runGit(this.config, this.config.repoDir, ["ls-tree", "-r", "-l", base]);
      const files = result.stdout.split("\n").filter(Boolean).flatMap((line) => {
        const match = line.match(/^\d+\s+blob\s+([0-9a-f]{40,64})\s+(\d+)\t(.+)$/);
        if (!match) return [];
        const [, oid, bytes, filePath] = match;
        if (!oid || !bytes || !filePath || !isAllowedTrackedPath(filePath) || !filePath.startsWith(prefix)) return [];
        return [{ path: filePath, blob_oid: oid, bytes: Number(bytes) }];
      });
      return {
        ok: true,
        request_id: randomUUID(),
        workspace_state: "READY",
        base_commit: base,
        files: files.slice(0, limit),
        truncated: files.length > limit,
      };
    });
  }

  async readFiles(paths: string[]): Promise<Record<string, unknown>> {
    if (paths.length === 0 || paths.length > LIMITS.maxFilesPerRead) {
      throw new CeoError("VALIDATION_FAILED", `Read between 1 and ${LIMITS.maxFilesPerRead} files.`);
    }
    return await this.withReadyWorkspace(async (base) => {
      let total = 0;
      const files = [];
      for (const candidate of paths) {
        const filePath = validatePath(candidate);
        await assertNoSymlink(this.config.repoDir, filePath);
        const absolute = path.join(this.config.repoDir, filePath);
        const info = await stat(absolute).catch(() => null);
        if (!info?.isFile()) throw new CeoError("INVALID_PATH", "Requested path is not a regular file.", { path: filePath });
        if (info.size > LIMITS.maxFileWriteBytes) throw new CeoError("VALIDATION_FAILED", `File size (${Math.round(info.size / 1024)} KiB) exceeds max single-file limit (${Math.round(LIMITS.maxFileWriteBytes / (1024 * 1024))} MiB).`, { path: filePath });
        total += info.size;
        if (total > LIMITS.maxReadResponseBytes) throw new CeoError("VALIDATION_FAILED", `Total response size exceeds response budget of ${Math.round(LIMITS.maxReadResponseBytes / (1024 * 1024))} MiB.`);
        const content = await this.readUtf8(absolute, filePath);
        const oid = await blobOid(this.config, this.config.repoDir, base, filePath);
        files.push({ path: filePath, blob_oid: oid, content });
      }
      return { ok: true, request_id: randomUUID(), workspace_state: "READY", base_commit: base, files };
    });
  }

  async searchText(query: string, prefixes: string[], limit: number): Promise<Record<string, unknown>> {
    if (!query || Buffer.byteLength(query, "utf8") > 512) {
      throw new CeoError("VALIDATION_FAILED", "Search query must contain 1 to 512 UTF-8 bytes.");
    }
    return await this.withReadyWorkspace(async (base) => {
      const listed = await this.listTrackedFiles(base);
      const safePrefixes = prefixes.length ? prefixes : [""];
      for (const prefix of safePrefixes) {
        if (prefix.includes("..") || prefix.includes("\\") || path.posix.isAbsolute(prefix)) {
          throw new CeoError("INVALID_PATH", "Search prefix is invalid.", { prefix });
        }
      }
      const matches: Array<{ path: string; line: number; snippet: string }> = [];
      for (const filePath of listed) {
        if (!safePrefixes.some((prefix) => filePath.startsWith(prefix))) continue;
        await assertNoSymlink(this.config.repoDir, filePath);
        const content = await this.readUtf8(path.join(this.config.repoDir, filePath), filePath);
        for (const [index, line] of content.split("\n").entries()) {
          if (line.includes(query)) {
            matches.push({ path: filePath, line: index + 1, snippet: line.slice(0, 300) });
            if (matches.length >= limit) {
              return { ok: true, request_id: randomUUID(), workspace_state: "READY", base_commit: base, matches, truncated: true };
            }
          }
        }
      }
      return { ok: true, request_id: randomUUID(), workspace_state: "READY", base_commit: base, matches, truncated: false };
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

    return await this.withLock(async () => {
      const completed = await this.readCompleted(requestId);
      if (completed) return this.completedResult(completed);
      await this.recoverPending();
      if (await this.readPending()) throw new CeoError("PUSH_PENDING", "A previous commit is awaiting push verification.");
      await this.syncCleanWorkspace();
      const remote = await resolveRef(this.config, this.config.repoDir, `origin/${this.config.branch}`);
      if (remote !== input.base_commit) {
        throw new CeoError("STALE_REVISION", "origin/main changed since the files were read.", {
          expected: input.base_commit,
          remote_head: remote,
        });
      }

      this.validateOperations(input.operations);
      const worktree = path.join(this.config.txnDir, requestId);
      await rm(worktree, { recursive: true, force: true });
      await runGit(this.config, this.config.repoDir, ["worktree", "add", "--detach", worktree, input.base_commit]);
      let committed = false;
      try {
        await this.applyOperations(worktree, input.base_commit, input.operations);
        const changed = await this.validateDiff(worktree);
        await runGit(this.config, worktree, ["add", "-A"]);
        await runGit(this.config, worktree, ["diff", "--cached", "--check"]);
        await runGit(this.config, worktree, ["commit", "-m", `CEO: ${input.summary.trim()}`]);
        committed = true;
        const commit = await resolveRef(this.config, worktree, "HEAD");
        const diffStat = (await runGit(this.config, worktree, ["show", "--stat", "--format=", "HEAD"])).stdout;
        const pending: PendingTransaction = {
          request_id: requestId,
          base_commit: input.base_commit,
          commit,
          worktree,
          changed_files: changed,
          diff_stat: diffStat,
        };
        await this.writePending(pending);
        await runGit(this.config, this.config.repoDir, ["fetch", "origin", this.config.branch]);
        const latest = await resolveRef(this.config, this.config.repoDir, `origin/${this.config.branch}`);
        if (latest !== input.base_commit) {
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

  private async withReadyWorkspace<T>(operation: (base: string) => Promise<T>): Promise<T> {
    return await this.withLock(async () => {
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

  private validateOperations(operations: ChangeOperation[]): void {
    let total = 0;
    const touched = new Set<string>();
    for (const operation of operations) {
      const source = validatePath(operation.path);
      const paths = operation.op === "archive" ? [source, validatePath(operation.target)] : [source];
      if (operation.op === "archive") validateArchive(source, operation.target);
      if (operation.op === "append" && source !== "JOURNAL.md") {
        throw new CeoError("INVALID_OPERATION", "Append is only allowed for JOURNAL.md.");
      }
      if ("content" in operation) total += assertContentSize(operation.content);
      for (const filePath of paths) {
        if (touched.has(filePath)) throw new CeoError("INVALID_OPERATION", "A path may be changed only once per transaction.", { path: filePath });
        touched.add(filePath);
      }
    }
    if (total > LIMITS.maxTotalWriteBytes) throw new CeoError("VALIDATION_FAILED", `Transaction content exceeds ${Math.round(LIMITS.maxTotalWriteBytes / (1024 * 1024))} MiB.`);
  }

  private async applyOperations(worktree: string, base: string, operations: ChangeOperation[]): Promise<void> {
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
      } else {
        const target = validatePath(operation.target);
        await assertExpectedBlob(this.config, worktree, base, filePath, operation.expected_blob_oid);
        await assertNoSymlink(worktree, target);
        const targetAbsolute = path.join(worktree, target);
        const exists = await access(targetAbsolute).then(() => true).catch(() => false);
        if (exists) throw new CeoError("INVALID_OPERATION", "Archive target already exists.", { target });
        await mkdir(path.dirname(targetAbsolute), { recursive: true });
        await rename(absolute, targetAbsolute);
      }
    }
  }

  private async validateDiff(worktree: string): Promise<string[]> {
    const tracked = (await runGit(this.config, worktree, ["diff", "--name-only", "-z"])).stdout
      .split("\0").filter(Boolean);
    const untracked = (await runGit(this.config, worktree, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout
      .split("\0").filter(Boolean);
    const changed = [...tracked, ...untracked];
    if (changed.length === 0) throw new CeoError("VALIDATION_FAILED", "Change set produces no file changes.");
    for (const filePath of changed) validatePath(filePath);
    return [...new Set(changed)].sort();
  }

  private async listTrackedFiles(base: string): Promise<string[]> {
    const result = await runGit(this.config, this.config.repoDir, ["ls-tree", "-r", "--name-only", base]);
    return result.stdout.split("\n").filter(isAllowedTrackedPath);
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
    const completed: CompletedTransaction = { ...pending, pushed_at: this.lastPushAt };
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
      pushed: true,
      changed_files: completed.changed_files,
      diff_stat: completed.diff_stat,
      pushed_at: completed.pushed_at,
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

  private async readUtf8(filePath: string, displayPath: string): Promise<string> {
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

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    try {
      await mkdir(this.lockDir);
      await writeFile(path.join(this.lockDir, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CeoError("NOT_READY", "Another workspace operation currently holds the lock.");
      }
      throw error;
    }
    try { return await operation(); }
    finally { await rm(this.lockDir, { recursive: true, force: true }); }
  }

  private async removeStaleLock(): Promise<void> {
    const owner = await this.readJson<{ pid?: number }>(path.join(this.lockDir, "owner.json"));
    if (!owner?.pid) {
      await rm(this.lockDir, { recursive: true, force: true });
      return;
    }
    try { process.kill(owner.pid, 0); }
    catch { await rm(this.lockDir, { recursive: true, force: true }); }
  }
}
