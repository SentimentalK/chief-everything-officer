import { Router, type Request, type Response, type NextFunction } from "express";
import type { JobService, JobAuthScope, JobErrorCode, LeaseResult } from "./service.js";
import { JOB_ID_RE, WORKER_ID_RE, ATTEMPT_ID_RE } from "./schema.js";

/**
 * Identity-scoped worker lease HTTP endpoints. Mounted behind
 * Host -> Origin -> Identity middlewares (order enforced by server.ts); the
 * ownership scope comes ONLY from res.locals.identity, never from the body,
 * query, or any custom identity header. These are client-protocol endpoints,
 * so no MCP tools are added for claim/start/heartbeat.
 */

const OP_STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  JOB_NOT_FOUND: 404,
  JOB_EXPIRED: 409,
  JOB_ALREADY_CLAIMED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  JOB_NOT_CLAIMED: 409,
  LEASE_MISMATCH: 409,
  LEASE_EXPIRED: 409,
  WORKSPACE_MISMATCH: 409,
  BRIDGE_DISABLED: 503,
  QUEUE_UNAVAILABLE: 503,
};

/** Log only allow-listed fields; never full body/response, tokens, or content. */
function logLine(fields: Record<string, unknown>): void {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  process.stderr.write(`job-lease ${JSON.stringify(out)}\n`);
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

type Errorish = { code: string; message: string; reason?: string | null };

function respondError(res: Response, e: Errorish): void {
  const status = OP_STATUS[e.code] ?? 400;
  const body: Record<string, unknown> = { ok: false, code: e.code, message: e.message };
  if (e.reason) body.details = { reason: e.reason };
  res.status(status).json(body);
}

export function createJobLeaseRouter(service: JobService | null): Router {
  const router = Router();

  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  const handle = (
    op: "claim" | "start" | "heartbeat",
    call: (svc: JobService, scope: JobAuthScope, jobId: string, body: unknown) => Promise<LeaseResult>,
  ) => {
    return async (req: Request, res: Response): Promise<void> => {
      const started = Date.now();
      const jobId = jobIdFrom(req);
      const scope = scopeFrom(res);
      const ids = safeBodyIds(req.body);
      const uid = scope?.user_id ?? null;
      const wsid = scope?.workspace_id ?? null;
      const event = op;

      const finish = (result: LeaseResult | Errorish): void => {
        const latencyMs = Date.now() - started;
        if (typeof (result as LeaseResult).ok === "boolean" && (result as LeaseResult).ok) {
          const ok = result as Extract<LeaseResult, { ok: true }>;
          logLine({
            event,
            job_id: jobId,
            worker_id: ids.worker_id,
            attempt_id: ids.attempt_id,
            user_id: uid,
            workspace_id: wsid,
            state: ok.execution?.phase ?? null,
            latency_ms: latencyMs,
          });
          const payload: Record<string, unknown> = {
            ok: true,
            server_time: ok.server_time,
            execution: ok.execution,
          };
          if (op === "claim") {
            payload.replayed = ok.replayed;
            if (ok.job) payload.job = ok.job;
          } else if (op === "start") {
            payload.replayed = ok.replayed;
          }
          res.status(200).json(payload);
          return;
        }
        const e = result as Errorish;
        const reason = (result as { reason?: string | null }).reason ?? null;
        logLine({
          event,
          job_id: jobId,
          worker_id: ids.worker_id,
          attempt_id: ids.attempt_id,
          user_id: uid,
          workspace_id: wsid,
          error_code: e.code,
          reason,
          latency_ms: latencyMs,
        });
        respondError(res, e);
      };

      if (!jobId) {
        finish({ code: "INVALID_INPUT", message: "job_id must be a job-<uuid>" });
        return;
      }
      if (!scope) {
        finish({ code: "INVALID_INPUT", message: "Missing identity context." });
        return;
      }
      if (!service) {
        finish({ code: "BRIDGE_DISABLED", message: "Job submission is disabled on this deployment." });
        return;
      }

      try {
        const result = await call(service, scope, jobId, req.body);
        finish(result);
      } catch (e) {
        const error = e as { code?: unknown; message?: unknown; details?: { reason?: unknown } };
        const code = (typeof error.code === "string" ? error.code : "QUEUE_UNAVAILABLE") as JobErrorCode;
        const message = typeof error.message === "string" ? error.message : "Queue backend is not available.";
        const reasonRaw = error.details?.reason;
        finish({
          code,
          message,
          reason: typeof reasonRaw === "string" ? reasonRaw : null,
        });
      }
    };
  };

  router.post("/:job_id/claim", handle("claim", (svc, scope, jobId, body) => svc.claim(scope, jobId, body)));
  router.post("/:job_id/start", handle("start", (svc, scope, jobId, body) => svc.start(scope, jobId, body)));
  router.post("/:job_id/heartbeat", handle("heartbeat", (svc, scope, jobId, body) => svc.heartbeat(scope, jobId, body)));

  router.get("/pending", async (req: Request, res: Response) => {
    const started = Date.now();
    const scope = scopeFrom(res);
    const uid = scope?.user_id ?? null;
    const wsid = scope?.workspace_id ?? null;
    const fail = (code: string, message: string, reason?: string | null): void => {
      logLine({
        event: "pending",
        user_id: uid,
        workspace_id: wsid,
        error_code: code,
        reason: reason ?? null,
        latency_ms: Date.now() - started,
      });
      respondError(res, { code, message, reason: reason ?? null });
    };
    if (!scope) {
      fail("INVALID_INPUT", "Missing identity context.");
      return;
    }
    if (!service) {
      fail("BRIDGE_DISABLED", "Job submission is disabled on this deployment.");
      return;
    }
    try {
      const result = await service.pending(scope, req.query);
      logLine({
        event: "pending",
        user_id: uid,
        workspace_id: wsid,
        latency_ms: Date.now() - started,
      });
      res.status(200).json({ ok: true, jobs: result.jobs, next_cursor: result.next_cursor, has_more: result.has_more });
    } catch (e) {
      const error = e as { code?: unknown; message?: unknown; details?: { reason?: unknown } };
      const code = (typeof error.code === "string" ? error.code : "QUEUE_UNAVAILABLE") as string;
      const message = typeof error.message === "string" ? error.message : "Queue backend is not available.";
      const reasonRaw = error.details?.reason;
      fail(code, message, typeof reasonRaw === "string" ? reasonRaw : null);
    }
  });

  return router;
}
