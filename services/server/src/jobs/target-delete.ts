import {
  ConnectorControlStore,
  ConnectorNotFoundError,
  ConnectorPermissionError,
} from "../connector/control-store.js";
import type { IdentityStore } from "../identity/store.js";
import {
  RedisJobStoreV2,
} from "./v2-store.js";
import {
  parseDeleteFenceStartedMs,
  TARGET_DELETE_FENCE_TTL_MS,
} from "./v2-schema.js";

/**
 * Workspace-level Project deletion (PROJECT-039).
 *
 * One server-side contract owns the full destructive sequence so a Connector
 * can never assemble an unsafe multi-call race:
 *
 *   1. ACQUIRE a short-lived per-target Redis delete fence (SET NX PX).
 *      While the fence is fresh, the create/claim Lua scripts refuse to
 *      create or claim work for the target — closing the submit/claim race
 *      against quiescence verification.
 *   2. VERIFY quiescence authoritatively from the Job store's durable stream:
 *      EVERY historical Job for the target is loaded and classified. Any
 *      preparing / live-queued / claimed / running Job blocks deletion. Only
 *      expired-unclaimed (queued past claim deadline; provably unexecutable)
 *      jobs are pruned from the target queue without blocking.
 *   3. DELETE the execution_targets row physically (SQLite BEGIN IMMEDIATE;
 *      FK cascades remove device_target_bindings and
 *      workspace_execution_defaults). Historical Job/Attempt records in the
 *      Job store are never touched.
 *   4. RELEASE the fence (compare-and-delete on the caller's token).
 *
 * Concurrency / failure semantics:
 * - A concurrent duplicate delete either sees the row already gone
 *   (`already_deleted`, deterministic) or hits the fresh fence held by the
 *   in-flight delete (`TargetDeleteInProgressError`, 409). Never resurrects.
 * - If quiescence fails, the row is NOT deleted and the fence is released.
 * - If the operation fails between fencing and physical deletion, the fence
 *   is released in `finally`, leaving the Target enabled and usable — never
 *   a permanent tombstone. If the process dies before release, the fence
 *   self-heals: scripts ignore it after the TTL and a retrying delete takes
 *   it over.
 */

export const TARGET_DELETE_STREAM_SCAN_BATCH = 128;

export interface NonTerminalJobEvidence {
  preparing: string[];
  queued: string[];
  claimed: string[];
  running: string[];
}

export class TargetDeleteBlockedError extends Error {
  constructor(
    public readonly targetId: string,
    public readonly evidence: NonTerminalJobEvidence,
  ) {
    super(
      `ExecutionTarget '${targetId}' still has non-terminal jobs ` +
        `(preparing: ${evidence.preparing.length}, queued: ${evidence.queued.length}, ` +
        `claimed: ${evidence.claimed.length}, running: ${evidence.running.length}); ` +
        "cancel or complete them before deleting the project.",
    );
    this.name = "TargetDeleteBlockedError";
  }
}

export class TargetDeleteInProgressError extends Error {
  constructor(public readonly targetId: string) {
    super(
      `A project deletion for ExecutionTarget '${targetId}' is already in progress; retry shortly.`,
    );
    this.name = "TargetDeleteInProgressError";
  }
}

export interface TargetDeleteOutcome {
  outcome: "deleted" | "already_deleted";
  target_id: string;
  /** Number of historical (terminal) Job records left in the Job store. */
  terminal_job_count: number;
}

export class TargetDeleteCoordinator {
  constructor(
    private readonly deps: {
      controlStore: ConnectorControlStore;
      jobStore: RedisJobStoreV2;
      identityStore: IdentityStore;
      nowMs?: () => number;
    },
  ) {}

  get controlStore(): ConnectorControlStore {
    return this.deps.controlStore;
  }

  /**
   * Device-authorized entry point: the invoking device's user must be an
   * active owner member of the target's workspace (masked as not-found for
   * foreign/missing targets, matching bind/unbind/rename). Delegates to the
   * fenced critical section afterwards.
   */
  async deleteTargetForDevice(input: {
    deviceId: string;
    targetId: string;
    actorUserId: string;
  }): Promise<TargetDeleteOutcome> {
    const target = this.deps.controlStore.getExecutionTarget(input.targetId);
    if (!target) {
      throw new ConnectorNotFoundError(`ExecutionTarget '${input.targetId}' not found.`);
    }

    // Mask cross-workspace access as not-found, matching bind/unbind.
    const membership = this.deps.identityStore.findWorkspaceMembership(
      target.workspace_id,
      input.actorUserId,
    );
    if (!membership) {
      throw new ConnectorNotFoundError(`ExecutionTarget '${input.targetId}' not found.`);
    }
    if (membership.role !== "owner") {
      throw new ConnectorPermissionError("Only workspace owners can delete execution targets.");
    }

    return this.deleteTargetInternal(target.id);
  }

  /**
   * The fenced critical section: fence -> authoritative non-terminal check ->
   * physical row delete -> fence release. Composed from exported steps so
   * tests can interleave concurrent submissions/claims against the real
   * fence semantics.
   */
  async deleteTargetInternal(targetId: string): Promise<TargetDeleteOutcome> {
    const token = `${Date.now()}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
    const acquired = await this.deps.jobStore.acquireTargetDeleteFence(targetId, token);
    if (!acquired) {
      return this.handleContendedFence(targetId, token);
    }

    try {
      const quiescence = await this.verifyTargetQuiescence(targetId, token);
      if (!quiescence.quiescent) {
        throw new TargetDeleteBlockedError(targetId, quiescence.evidence);
      }

      const deleted = this.deps.controlStore.deleteExecutionTargetRow(targetId);
      if (!deleted) {
        // The row vanished between fence acquisition and physical deletion
        // (e.g. a stale-fence takeover completed first): deterministic
        // already-gone outcome, no resurrection.
        return { outcome: "already_deleted", target_id: targetId, terminal_job_count: quiescence.terminalJobs };
      }
      return { outcome: "deleted", target_id: targetId, terminal_job_count: quiescence.terminalJobs };
    } finally {
      // Rollback/unfence on ANY failure path (blocked quiescence, store error,
      // thrown exception) and normal release on success. If the process dies
      // before this runs, the fence self-heals via its TTL and delete retries
      // take it over — never a permanent unusable tombstone.
      await this.deps.jobStore.releaseTargetDeleteFence(targetId, token).catch(() => undefined);
    }
  }

  /**
   * Fence acquisition lost the NX race. Deterministic outcomes only:
   * - row already gone -> already_deleted (idempotent replay);
   * - fence held by a FRESH in-flight delete -> 409 TargetDeleteInProgressError;
   * - fence is STALE (crashed operation) -> take it over and proceed.
   */
  private async handleContendedFence(
    targetId: string,
    token: string,
  ): Promise<TargetDeleteOutcome> {
    const target = this.deps.controlStore.getExecutionTarget(targetId);
    if (!target) {
      return { outcome: "already_deleted", target_id: targetId, terminal_job_count: 0 };
    }

    const fenceValue = await this.deps.jobStore.getTargetDeleteFence(targetId);
    const fenceStartedMs = fenceValue !== null ? parseDeleteFenceStartedMs(fenceValue) : 0;
    const age = Date.now() - fenceStartedMs;
    if (fenceValue !== null && age >= 0 && age < TARGET_DELETE_FENCE_TTL_MS) {
      throw new TargetDeleteInProgressError(targetId);
    }

    const tookOver = await this.deps.jobStore.takeoverStaleTargetDeleteFence(targetId, token);
    if (!tookOver) {
      // The stale fence expired between our read and takeover: fall back to a
      // plain acquisition; if that also loses, surface the in-progress error.
      const acquired = await this.deps.jobStore.acquireTargetDeleteFence(targetId, token);
      if (!acquired) {
        throw new TargetDeleteInProgressError(targetId);
      }
      return this.runFencedDelete(targetId, token);
    }
    return this.runFencedDelete(targetId, token);
  }

  /** Fence is already held by `token`: verify quiescence then delete. */
  private async runFencedDelete(targetId: string, token: string): Promise<TargetDeleteOutcome> {
    try {
      const quiescence = await this.verifyTargetQuiescence(targetId, token);
      if (!quiescence.quiescent) {
        throw new TargetDeleteBlockedError(targetId, quiescence.evidence);
      }
      const deleted = this.deps.controlStore.deleteExecutionTargetRow(targetId);
      if (!deleted) {
        return { outcome: "already_deleted", target_id: targetId, terminal_job_count: quiescence.terminalJobs };
      }
      return { outcome: "deleted", target_id: targetId, terminal_job_count: quiescence.terminalJobs };
    } finally {
      await this.deps.jobStore.releaseTargetDeleteFence(targetId, token).catch(() => undefined);
    }
  }

  /**
   * Authoritative quiescence verification. MUST run while the caller holds
   * the fresh fence. Scans the complete durable job stream, classifies every
   * Job belonging to the target, and prunes provably-dead expired-unclaimed
   * queue entries. Returns evidence whenever any non-terminal Job blocks
   * deletion.
   */
  async verifyTargetQuiescence(
    targetId: string,
    fenceToken: string,
  ): Promise<{
    quiescent: boolean;
    terminalJobs: number;
    evidence: NonTerminalJobEvidence;
  }> {
    const nowMs = this.deps.nowMs?.() ?? Date.now();
    const evidence: NonTerminalJobEvidence = { preparing: [], queued: [], claimed: [], running: [] };
    let terminalJobs = 0;
    const expiredQueuedIds: string[] = [];
    let cursor: string | null = null;

    while (true) {
      const batch = await this.deps.jobStore.scanJobStream(cursor, TARGET_DELETE_STREAM_SCAN_BATCH);
      if (batch.length === 0) break;

      for (const entry of batch) {
        if (entry.fields["target_id"] !== targetId) continue;
        const jobId = entry.fields["job_id"];
        if (!jobId) continue;

        const job = await this.deps.jobStore.getJob(jobId);
        if (!job) continue; // stream entry without a durable record: nothing executable

        if (job.status === "preparing") {
          evidence.preparing.push(job.job_id);
        } else if (job.status === "queued") {
          if (job.claim_deadline_ms > 0 && nowMs >= job.claim_deadline_ms) {
            // Expired-unclaimed: can never be claimed (claim script rejects
            // past the deadline); prune the dead queue entry but keep the
            // historical record.
            expiredQueuedIds.push(job.job_id);
          } else {
            evidence.queued.push(job.job_id);
          }
        } else if (job.status === "active") {
          const attempt = job.latest_attempt_id
            ? await this.deps.jobStore.getAttempt(job.latest_attempt_id)
            : null;
          if (attempt && attempt.phase === "running") {
            evidence.running.push(job.job_id);
          } else {
            evidence.claimed.push(job.job_id);
          }
        } else if (job.status === "terminal") {
          terminalJobs++;
        }
      }

      cursor = batch[batch.length - 1]!.id;
      // Keep the fence alive across slow scans so the barrier cannot expire
      // mid-verification.
      await this.deps.jobStore.touchTargetDeleteFence(targetId, fenceToken);

      if (batch.length < TARGET_DELETE_STREAM_SCAN_BATCH) break;
    }

    if (expiredQueuedIds.length > 0) {
      await this.deps.jobStore
        .pruneTargetQueue(targetId, ...expiredQueuedIds)
        .catch(() => 0);
    }

    const blocked =
      evidence.preparing.length + evidence.queued.length + evidence.claimed.length + evidence.running.length;
    return { quiescent: blocked === 0, terminalJobs, evidence };
  }
}
