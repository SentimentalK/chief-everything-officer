import { createHash } from "node:crypto";
import type { RedisRunner } from "../../src/jobs/redis-runner.js";

export function createFakeRedisRunner(): RedisRunner {
  const strings = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  const streams = new Map<string, Array<{ id: string; fields: Record<string, string | number> }>>();
  const scriptMap = new Map<string, string>();
  let streamSeq = 0;

  function sha(s: string): string {
    return createHash("sha1").update(s, "utf8").digest("hex");
  }

  return {
    ready: () => true,
    async get(key: string) {
      return strings.get(key) ?? null;
    },
    async set(key: string, value: string) {
      strings.set(key, value);
    },
    async xaddStream(key: string, payload: Record<string, string | number>) {
      const id = `${Date.now()}-${++streamSeq}`;
      const stream = streams.get(key) ?? [];
      stream.push({ id, fields: payload });
      streams.set(key, stream);
      return id;
    },
    async xlen(key: string) {
      return streams.get(key)?.length ?? 0;
    },
    async xrange(key: string, afterExclusive: string, count: number) {
      const stream = streams.get(key) ?? [];
      const out: Array<[string, string[]]> = [];
      let foundAfter = !afterExclusive;
      for (const entry of stream) {
        if (!foundAfter) {
          if (entry.id === afterExclusive) foundAfter = true;
          continue;
        }
        const flat: string[] = [];
        for (const [k, v] of Object.entries(entry.fields)) {
          flat.push(k, String(v));
        }
        out.push([entry.id, flat]);
        if (out.length >= count) break;
      }
      return out;
    },
    async xrevrange(key: string, beforeExclusive: string | null, count: number) {
      const stream = streams.get(key) ?? [];
      const out: Array<[string, string[]]> = [];
      let foundBefore = !beforeExclusive;
      for (let i = stream.length - 1; i >= 0; i--) {
        const entry = stream[i];
        if (!foundBefore) {
          if (entry.id === beforeExclusive) {
            foundBefore = true;
          }
          continue;
        }
        const flat: string[] = [];
        for (const [k, v] of Object.entries(entry.fields)) {
          flat.push(k, String(v));
        }
        out.push([entry.id, flat]);
        if (out.length >= count) break;
      }
      return out;
    },
    async scriptLoad(script: string) {
      const s = sha(script);
      scriptMap.set(s, script);
      return s;
    },
    async scriptExists(shaKey: string) {
      return scriptMap.has(shaKey);
    },
    async flush() {
      strings.clear();
      zsets.clear();
      streams.clear();
    },
    async zrangeWithScores(key: string, start: number, stop: number) {
      const zset = zsets.get(key);
      if (!zset) return [];
      const entries = Array.from(zset.entries())
        .map(([member, score]) => ({ member, score }))
        .sort((a, b) => a.score - b.score);
      const end = stop < 0 ? entries.length + stop + 1 : stop + 1;
      return entries.slice(start, end);
    },
    async zrem(key: string, ...members: string[]) {
      const zset = zsets.get(key);
      if (!zset) return 0;
      let removed = 0;
      for (const m of members) {
        if (zset.delete(m)) removed++;
      }
      if (zset.size === 0) {
        zsets.delete(key);
      }
      return removed;
    },
    async zadd(key: string, score: number, member: string) {
      let zset = zsets.get(key);
      if (!zset) {
        zset = new Map();
        zsets.set(key, zset);
      }
      zset.set(member, score);
      return 1;
    },
    async evalsha(shaKey: string, keyCount: number, keys: string[], args: string[]) {
      const script = scriptMap.get(shaKey);
      if (!script) {
        const err = new Error("NOSCRIPT No matching script");
        (err as unknown as { code: string }).code = "NOSCRIPT";
        throw err;
      }

      // Check script identity by matching distinctive patterns in the script
      if (script.includes("WRONGTYPE_REQ_KEY")) {
        // V2_CREATE_JOB_SCRIPT
        // Keys: [reqKey, jobKey, streamKey, targetQueueKey]
        // Args: [jobId, userId, workspaceId, targetId, createdAtMs, claimDeadlineMs, requestDigest, serializedJobJson, requestId]
        const [reqKey, jobKey, streamKey, targetQueueKey] = keys;
        const [jobId, userId, workspaceId, targetId, createdAtMs, claimDeadlineMs, requestDigest, serializedJobJson, requestId] = args;

        const reqVal = strings.get(reqKey);
        if (reqVal) {
          return JSON.stringify({ status: "existing_request", job_id: reqVal });
        }

        // New job collision check
        if (strings.has(jobKey)) {
          return JSON.stringify({ error: "JOB_ID_COLLISION" });
        }

        let prep: any;
        try {
          prep = JSON.parse(serializedJobJson);
        } catch {
          return JSON.stringify({ error: "MALFORMED_JOB_RECORD" });
        }

        strings.set(reqKey, jobId);
        prep.status = "preparing";
        strings.set(jobKey, JSON.stringify(prep));

        const entryId = `${Date.now()}-${++streamSeq}`;
        const stream = streams.get(streamKey) ?? [];
        stream.push({
          id: entryId,
          fields: {
            schema_version: 2,
            job_id: jobId,
            user_id: userId,
            workspace_id: workspaceId,
            target_id: targetId,
            created_at_ms: createdAtMs,
          },
        });
        streams.set(streamKey, stream);

        let tq = zsets.get(targetQueueKey);
        if (!tq) {
          tq = new Map();
          zsets.set(targetQueueKey, tq);
        }
        tq.set(jobId, Number(createdAtMs));

        prep.status = "queued";
        prep.stream_entry_id = entryId;
        strings.set(jobKey, JSON.stringify(prep));

        return JSON.stringify({ status: "created", job_id: jobId, stream_entry_id: entryId });
      }

      if (script.includes("WRONGTYPE_JOB_ATTEMPTS")) {
        // V2_CLAIM_JOB_SCRIPT
        // Keys: [jobKey, targetQueueKey, attemptsKey, attemptKey]
        // Args: [jobId, expectedWorkspaceId, expectedTargetId, deviceId, targetBindingId, attemptId, claimTokenSha256, isReplayOnly]
        const [jobKey, targetQueueKey, attemptsKey, attemptKey] = keys;
        const [jobId, expectedWorkspaceId, expectedTargetId, deviceId, targetBindingId, attemptId, claimTokenSha256, isReplayOnly] = args;

        const nowMs = Date.now();
        const jobRaw = strings.get(jobKey);
        if (!jobRaw) return JSON.stringify({ error: "JOB_NOT_FOUND" });

        let job: any;
        try {
          job = JSON.parse(jobRaw);
        } catch {
          return JSON.stringify({ error: "MALFORMED_JOB_RECORD" });
        }

        if (job.job_id !== jobId || job.workspace_id !== expectedWorkspaceId || job.target_id !== expectedTargetId) {
          return JSON.stringify({ error: "JOB_NOT_FOUND" });
        }

        // Replay check
        if (job.latest_attempt_id === attemptId) {
          const attRaw = strings.get(attemptKey);
          if (!attRaw) return JSON.stringify({ error: "CORRUPT_ATTEMPT_RECORD" });
          let attempt: any;
          try {
            attempt = JSON.parse(attRaw);
          } catch {
            return JSON.stringify({ error: "CORRUPT_ATTEMPT_RECORD" });
          }
          if (
            attempt.attempt_id !== attemptId ||
            attempt.job_id !== jobId ||
            attempt.workspace_id !== expectedWorkspaceId ||
            attempt.target_id !== expectedTargetId ||
            attempt.device_id !== deviceId ||
            attempt.claim_token_sha256 !== claimTokenSha256
          ) {
            return JSON.stringify({ error: "IDEMPOTENCY_CONFLICT" });
          }
          if (attempt.phase === "claimed" || attempt.phase === "running") {
            return JSON.stringify({ status: "replayed", attempt, server_time_ms: nowMs });
          }
          if (attempt.phase === "terminal") {
            return JSON.stringify({ error: "JOB_FINISHED" });
          }
          return JSON.stringify({ error: "IDEMPOTENCY_CONFLICT" });
        }

        if (isReplayOnly === "1") {
          return JSON.stringify({ error: "NOT_OWNER_REPLAY" });
        }

        if (job.status !== "queued") {
          return JSON.stringify({ error: "JOB_ALREADY_CLAIMED" });
        }

        if (job.claim_deadline_ms && job.claim_deadline_ms > 0 && nowMs >= job.claim_deadline_ms) {
          const tq = zsets.get(targetQueueKey);
          if (tq) {
            tq.delete(jobId);
            if (tq.size === 0) zsets.delete(targetQueueKey);
          }
          return JSON.stringify({ error: "JOB_EXPIRED" });
        }

        if (strings.has(attemptKey)) {
          return JSON.stringify({ error: "ATTEMPT_ID_COLLISION" });
        }

        const attempt = {
          schema_version: 1,
          attempt_id: attemptId,
          job_id: job.job_id,
          user_id: job.user_id,
          workspace_id: job.workspace_id,
          target_id: job.target_id,
          device_id: deviceId,
          target_binding_id: targetBindingId,
          claim_token_sha256: claimTokenSha256,
          phase: "claimed",
          claimed_at_ms: nowMs,
          started_at_ms: null,
        };

        strings.set(attemptKey, JSON.stringify(attempt));

        let atts = zsets.get(attemptsKey);
        if (!atts) {
          atts = new Map();
          zsets.set(attemptsKey, atts);
        }
        atts.set(attemptId, nowMs);

        job.status = "active";
        job.latest_attempt_id = attemptId;
        strings.set(jobKey, JSON.stringify(job));

        const tq = zsets.get(targetQueueKey);
        if (tq) {
          tq.delete(jobId);
          if (tq.size === 0) zsets.delete(targetQueueKey);
        }

        return JSON.stringify({ status: "claimed", attempt, server_time_ms: nowMs });
      }

      if (script.includes("JOB_NOT_ACTIVE")) {
        // V2_START_JOB_SCRIPT
        // Keys: [jobKey, attemptKey]
        // Args: [attemptId, deviceId, claimTokenSha256]
        const [jobKey, attemptKey] = keys;
        const [attemptId, deviceId, claimTokenSha256] = args;
        const nowMs = Date.now();

        const jobRaw = strings.get(jobKey);
        if (!jobRaw) return JSON.stringify({ error: "JOB_NOT_FOUND" });
        const job = JSON.parse(jobRaw);

        const attRaw = strings.get(attemptKey);
        if (!attRaw) return JSON.stringify({ error: "ATTEMPT_NOT_FOUND" });
        const attempt = JSON.parse(attRaw);

        if (
          attempt.schema_version !== 1 ||
          typeof attempt.claimed_at_ms !== "number" ||
          typeof attempt.target_binding_id !== "string" ||
          !attempt.target_binding_id ||
          typeof attempt.claim_token_sha256 !== "string" ||
          attempt.claim_token_sha256.length !== 64
        ) {
          return JSON.stringify({ error: "CORRUPT_ATTEMPT_RECORD" });
        }
        if (attempt.phase === "claimed" && (attempt.started_at_ms !== null && attempt.started_at_ms !== undefined)) {
          return JSON.stringify({ error: "CORRUPT_ATTEMPT_RECORD" });
        }
        if (attempt.phase === "running" && typeof attempt.started_at_ms !== "number") {
          return JSON.stringify({ error: "CORRUPT_ATTEMPT_RECORD" });
        }

        if (job.status !== "active" || job.latest_attempt_id !== attemptId) {
          return JSON.stringify({ error: "JOB_NOT_ACTIVE" });
        }
        if (
          attempt.attempt_id !== attemptId ||
          attempt.job_id !== job.job_id ||
          attempt.workspace_id !== job.workspace_id ||
          attempt.target_id !== job.target_id ||
          attempt.device_id !== deviceId ||
          attempt.claim_token_sha256 !== claimTokenSha256
        ) {
          return JSON.stringify({ error: "IDENTITY_MISMATCH" });
        }

        if (attempt.phase === "running") {
          return JSON.stringify({ status: "replayed", attempt, server_time_ms: nowMs });
        }
        if (attempt.phase !== "claimed") {
          return JSON.stringify({ error: "INVALID_ATTEMPT_PHASE", phase: attempt.phase });
        }

        attempt.phase = "running";
        attempt.started_at_ms = nowMs;
        strings.set(attemptKey, JSON.stringify(attempt));

        return JSON.stringify({ status: "started", attempt, server_time_ms: nowMs });
      }

      if (script.includes("ATTEMPT_MISMATCH") || script.includes("INVALID_REPORT_SCHEMA_VERSION")) {
        // V2_REPORT_JOB_SCRIPT
        // Keys: [jobKey, attemptKey]
        // Args: [attemptId, deviceId, claimTokenSha256, serializedReportJson]
        const [jobKey, attemptKey] = keys;
        const [attemptId, deviceId, claimTokenSha256, serializedReportJson] = args;
        const nowMs = Date.now();

        const jobRaw = strings.get(jobKey);
        if (!jobRaw) return JSON.stringify({ error: "JOB_NOT_FOUND" });
        const job = JSON.parse(jobRaw);

        const attRaw = strings.get(attemptKey);
        if (!attRaw) return JSON.stringify({ error: "ATTEMPT_NOT_FOUND" });
        const attempt = JSON.parse(attRaw);

        if (
          attempt.schema_version !== 1 ||
          typeof attempt.claimed_at_ms !== "number" ||
          typeof attempt.target_binding_id !== "string" ||
          !attempt.target_binding_id ||
          typeof attempt.claim_token_sha256 !== "string" ||
          attempt.claim_token_sha256.length !== 64
        ) {
          return JSON.stringify({ error: "CORRUPT_ATTEMPT_RECORD" });
        }
        if (attempt.phase === "claimed" && (attempt.started_at_ms !== null && attempt.started_at_ms !== undefined)) {
          return JSON.stringify({ error: "CORRUPT_ATTEMPT_RECORD" });
        }
        if (attempt.phase === "running" && typeof attempt.started_at_ms !== "number") {
          return JSON.stringify({ error: "CORRUPT_ATTEMPT_RECORD" });
        }

        if (job.latest_attempt_id !== attemptId) {
          return JSON.stringify({ error: "ATTEMPT_MISMATCH" });
        }
        if (job.status !== "active" && job.status !== "terminal") {
          return JSON.stringify({ error: "INVALID_JOB_STATUS", status: job.status });
        }
        if (
          attempt.attempt_id !== attemptId ||
          attempt.job_id !== job.job_id ||
          attempt.workspace_id !== job.workspace_id ||
          attempt.target_id !== job.target_id ||
          attempt.device_id !== deviceId ||
          attempt.claim_token_sha256 !== claimTokenSha256
        ) {
          return JSON.stringify({ error: "IDENTITY_MISMATCH" });
        }

        let rep: any;
        try {
          rep = JSON.parse(serializedReportJson);
        } catch {
          return JSON.stringify({ error: "MALFORMED_REPORT" });
        }

        if (rep.schema_version !== 2) {
          return JSON.stringify({ error: "INVALID_REPORT_SCHEMA_VERSION" });
        }

        if (typeof rep.finished_at_ms !== "number" || rep.finished_at_ms < 0) {
          return JSON.stringify({ error: "INVALID_REPORT_FINISHED_AT" });
        }
        if (typeof rep.duration_ms !== "number" || rep.duration_ms < 0) {
          return JSON.stringify({ error: "INVALID_REPORT_DURATION" });
        }
        if (typeof rep.receipt_sha256 !== "string" || rep.receipt_sha256.length !== 64) {
          return JSON.stringify({ error: "INVALID_REPORT_RECEIPT_SHA256" });
        }
        if (!rep.executor || typeof rep.executor.type !== "string" || typeof rep.executor.version !== "string") {
          return JSON.stringify({ error: "INVALID_REPORT_EXECUTOR" });
        }
        if (rep.execution_status !== "COMPLETED") {
          if (!rep.error || typeof rep.error.stage !== "string" || typeof rep.error.code !== "string" || typeof rep.error.message !== "string") {
            return JSON.stringify({ error: "INVALID_REPORT_ERROR_SHAPE" });
          }
        }

        if (attempt.phase === "terminal") {
          const ar = attempt.report;
          if (!ar) return JSON.stringify({ error: "CORRUPT_ATTEMPT_RECORD" });
          const errorMatch =
            (ar.error === null && rep.error === null) ||
            (ar.error &&
              rep.error &&
              ar.error.stage === rep.error.stage &&
              ar.error.code === rep.error.code &&
              ar.error.message === rep.error.message);
          const executorMatch =
            ar.executor?.type === rep.executor?.type && ar.executor?.version === rep.executor?.version;

          const semMatch =
            ar.schema_version === rep.schema_version &&
            ar.execution_status === rep.execution_status &&
            ar.business_outcome === rep.business_outcome &&
            ar.task_dispatched === rep.task_dispatched &&
            ar.finished_at_ms === rep.finished_at_ms &&
            ar.duration_ms === rep.duration_ms &&
            ar.receipt_sha256 === rep.receipt_sha256 &&
            executorMatch &&
            errorMatch;

          if (semMatch) {
            return JSON.stringify({ status: "replayed", server_time_ms: nowMs });
          }
          return JSON.stringify({ error: "REPORT_CONFLICT" });
        }

        if (job.status !== "active") {
          return JSON.stringify({ error: "INVALID_JOB_STATUS", status: job.status });
        }

        if (!rep.task_dispatched) {
          if (attempt.phase !== "claimed" && attempt.phase !== "running") {
            return JSON.stringify({ error: "INVALID_ATTEMPT_PHASE", phase: attempt.phase });
          }
        } else {
          if (attempt.phase !== "running" || attempt.started_at_ms === null) {
            return JSON.stringify({ error: "DISPATCHED_REPORT_REQUIRES_RUNNING" });
          }
        }

        rep.received_at_ms = nowMs;
        attempt.phase = "terminal";
        attempt.report = rep;
        job.status = "terminal";

        strings.set(attemptKey, JSON.stringify(attempt));
        strings.set(jobKey, JSON.stringify(job));

        return JSON.stringify({ status: "reported", server_time_ms: nowMs });
      }

      throw new Error(`Unknown script in fake runner: ${script}`);
    },
  };
}
