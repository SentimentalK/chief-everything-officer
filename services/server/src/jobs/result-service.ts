import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import {
  parseResultRequest,
  canonicalResultPayloadDigest,
  type WorkerResultRequest,
} from "./result-schema.js";
import {
  JOB_ID_RE,
  WORKER_ID_RE,
  ATTEMPT_ID_RE,
  utcIsoFromMs,
} from "./schema.js";
import type { RedisJobStore } from "./redis-store.js";
import type { ResourceService } from "../resource/service.js";
import {
  JobError,
  type JobAuthScope,
  type JobService,
  type JobErrorCode,
} from "./service.js";

export interface ResultSuccess {
  ok: true;
  job_id: string;
  attempt_id: string;
  result_received: true;
  resource_id: string;
  commit: string;
  received_at: string;
  replayed: boolean;
}

export type ResultOutcome =
  | ResultSuccess
  | { ok: false; code: JobErrorCode; message: string; reason?: string | null };

function hashClaimToken(claimToken: string): string {
  return createHash("sha256").update(claimToken, "utf8").digest("hex");
}

function logResultLine(fields: Record<string, unknown>): void {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  process.stderr.write(`job-result ${JSON.stringify(out)}\n`);
}

function safeBodyIds(body: unknown): { worker_id: string | null; attempt_id: string | null } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const workerId = typeof b.worker_id === "string" && WORKER_ID_RE.test(b.worker_id) ? b.worker_id : null;
  const attemptId = typeof b.attempt_id === "string" && ATTEMPT_ID_RE.test(b.attempt_id) ? b.attempt_id : null;
  return { worker_id: workerId, attempt_id: attemptId };
}

function scopeFrom(res: Response): JobAuthScope | null {
  const identity = res.locals?.identity;
  if (identity && typeof identity === "object") {
    const { user_id, workspace_id } = identity as { user_id?: unknown; workspace_id?: unknown };
    if (typeof user_id === "string" && typeof workspace_id === "string") {
      return { user_id, workspace_id };
    }
  }
  return null;
}

function jobIdFrom(req: Request): string | null {
  const raw = req.params?.job_id;
  return typeof raw === "string" && JOB_ID_RE.test(raw) ? raw : null;
}

export type ResourceServiceResolver = (scope: JobAuthScope) => Promise<ResourceService>;

export async function handleWorkerResult(
  scope: JobAuthScope,
  jobId: string,
  rawBody: unknown,
  deps: { store: RedisJobStore; resourceResolver: ResourceServiceResolver },
): Promise<ResultSuccess> {
  const parsed = parseResultRequest(rawBody);
  if (!parsed.ok) {
    throw new JobError("INVALID_INPUT", parsed.issue, { reason: parsed.reason });
  }
  const req: WorkerResultRequest = parsed.value;
  const tokenSha = hashClaimToken(req.claim_token);
  const payloadDigest = canonicalResultPayloadDigest(req.payload);

  // 1. Inspect assignment in Redis to verify identity & authorization prechecks
  const inspectRes = await deps.store.inspectAssignment(scope, jobId);
  if (!inspectRes.ok) {
    const code = inspectRes.code as JobErrorCode;
    throw new JobError(code, "Failed to inspect assignment.", { reason: inspectRes.reason });
  }

  const job = inspectRes.record;
  if (job.result_target !== "resource") {
    throw new JobError("REPORT_CONFLICT", "Result not expected for this job.", {
      reason: "RESULT_NOT_EXPECTED",
    });
  }

  if (!job.resource_id) {
    throw new JobError("QUEUE_UNAVAILABLE", "Job record missing resource_id.", {
      reason: "CORRUPT_RECORD",
    });
  }

  const ex = job.execution;
  if (
    !ex ||
    ex.worker_id !== req.worker_id ||
    ex.attempt_id !== req.attempt_id ||
    ex.claim_token_sha256 !== tokenSha
  ) {
    throw new JobError("ASSIGNMENT_MISMATCH", "Assignment credentials mismatch.");
  }

  // Resolve ResourceService for this request/scope
  let resolvedResourceService: ResourceService;
  try {
    resolvedResourceService = await deps.resourceResolver(scope);
  } catch (error) {
    throw new JobError("QUEUE_UNAVAILABLE", "Workspace runtime unavailable for result recording.", {
      reason: "RUNTIME_UNAVAILABLE",
    });
  }

  // 2. Canonical Git Resource commit FIRST
  const gitReceipt = await resolvedResourceService.applyWorkerResult({
    requestId: req.attempt_id,
    resourceId: job.resource_id,
    jobId,
    payload: req.payload,
    payloadDigest,
  });

  // 3. Redis job.result receipt SECOND (atomic Lua operation)
  const redisRes = await deps.store.resultAssignment(scope, jobId, {
    worker_id: req.worker_id,
    attempt_id: req.attempt_id,
    claim_token_sha256: tokenSha,
    result: {
      target: "resource",
      payload_sha256: payloadDigest,
      resource_id: job.resource_id,
      commit: gitReceipt.commit,
    },
  });

  if (!redisRes.ok) {
    const code = redisRes.code as JobErrorCode;
    throw new JobError(code, "Failed to record result receipt in queue.", {
      reason: redisRes.reason,
    });
  }

  const stored = redisRes.record.result;
  if (!stored) {
    throw new JobError("QUEUE_UNAVAILABLE", "Result receipt did not persist.", {
      reason: "CORRUPT_RECORD",
    });
  }

  return {
    ok: true,
    job_id: redisRes.record.job_id,
    attempt_id: stored.attempt_id,
    result_received: true,
    resource_id: stored.resource_id,
    commit: stored.commit,
    received_at: utcIsoFromMs(stored.received_at_ms),
    replayed: gitReceipt.replayed || redisRes.replayed,
  };
}

const RESULT_STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  JOB_NOT_FOUND: 404,
  JOB_EXPIRED: 409,
  JOB_ALREADY_CLAIMED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  JOB_NOT_CLAIMED: 409,
  ASSIGNMENT_MISMATCH: 409,
  WORKSPACE_MISMATCH: 409,
  REPORT_CONFLICT: 409,
  RESULT_CONFLICT: 409,
  JOB_FINISHED: 409,
  BRIDGE_DISABLED: 503,
  QUEUE_UNAVAILABLE: 503,
};

export function createJobResultHandler(
  jobService: JobService | null,
  resourceResolver: ResourceServiceResolver,
) {
  return async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    const started = Date.now();
    const jobId = jobIdFrom(req);
    const scope = scopeFrom(res);
    const ids = safeBodyIds(req.body);
    const uid = scope?.user_id ?? null;
    const wsid = scope?.workspace_id ?? null;

    if (!jobId) {
      logResultLine({
        event: "result",
        error_code: "INVALID_INPUT",
        reason: "INVALID_JOB_ID",
        latency_ms: Date.now() - started,
      });
      res.status(400).json({ ok: false, code: "INVALID_INPUT", message: "job_id must be a job-<uuid>" });
      return;
    }

    if (!scope) {
      logResultLine({
        event: "result",
        job_id: jobId,
        error_code: "INVALID_INPUT",
        reason: "MISSING_IDENTITY",
        latency_ms: Date.now() - started,
      });
      res.status(400).json({ ok: false, code: "INVALID_INPUT", message: "Missing identity context." });
      return;
    }

    if (!jobService) {
      logResultLine({
        event: "result",
        job_id: jobId,
        error_code: "BRIDGE_DISABLED",
        latency_ms: Date.now() - started,
      });
      res.status(503).json({
        ok: false,
        code: "BRIDGE_DISABLED",
        message: "Job submission is disabled on this deployment.",
      });
      return;
    }

    try {
      const result = await handleWorkerResult(scope, jobId, req.body, {
        store: jobService.store,
        resourceResolver,
      });

      logResultLine({
        event: "result",
        job_id: jobId,
        worker_id: ids.worker_id,
        attempt_id: ids.attempt_id,
        user_id: uid,
        workspace_id: wsid,
        resource_id: result.resource_id,
        commit: result.commit,
        replayed: result.replayed,
        latency_ms: Date.now() - started,
      });

      res.status(200).json({
        ok: true,
        job_id: result.job_id,
        attempt_id: result.attempt_id,
        result_received: true,
        resource_id: result.resource_id,
        commit: result.commit,
        received_at: result.received_at,
        replayed: result.replayed,
      });
    } catch (e) {
      const error = e as { code?: unknown; message?: unknown; details?: { reason?: unknown } };
      const code = (typeof error.code === "string" ? error.code : "QUEUE_UNAVAILABLE") as string;
      const message = typeof error.message === "string" ? error.message : "Result handling failed.";
      const reasonRaw = error.details?.reason;
      const reason = typeof reasonRaw === "string" ? reasonRaw : null;

      logResultLine({
        event: "result",
        job_id: jobId,
        worker_id: ids.worker_id,
        attempt_id: ids.attempt_id,
        user_id: uid,
        workspace_id: wsid,
        error_code: code,
        reason,
        latency_ms: Date.now() - started,
      });

      const status = RESULT_STATUS[code] ?? 400;
      const body: Record<string, unknown> = { ok: false, code, message };
      if (reason) body.details = { reason };
      res.status(status).json(body);
    }
  };
}
