import { describe, it, expect } from "vitest";
import {
  JOBS_V2_SCHEMA_VERSION,
  ATTEMPT_V1_SCHEMA_VERSION,
  STREAM_V2_SCHEMA_VERSION,
  KEY_STREAM_V2,
  jobKeyV2,
  jobAttemptsKeyV1,
  attemptKeyV1,
  requestKeyV2,
  businessDigestV2,
  parseJobRecordV2,
  serializeJobRecordV2,
  parseAttemptRecordV1,
  serializeAttemptRecordV1,
  parseStreamEntryV2,
  serializeStreamEntryV2,
  V2SchemaError,
  type JobRecordV2,
  type AttemptRecordV1,
} from "../src/jobs/v2-schema.js";

describe("Redis V2 Coordination Schema", () => {
  it("generates correct key namespaces including 1:N attempt ZSET", () => {
    expect(KEY_STREAM_V2).toBe("ceo:jobs:v2");
    expect(jobKeyV2("job-123")).toBe("ceo:job:v2:job-123");
    expect(jobAttemptsKeyV1("job-123")).toBe("ceo:job:v2:job-123:attempts");
    expect(attemptKeyV1("att-456")).toBe("ceo:attempt:v1:att-456");
    expect(requestKeyV2("usr_a", "ws_b", "req_c")).toBe("ceo:request:v2:usr_a:ws_b:req_c");
  });

  describe("JobRecordV2 serialization & state invariants", () => {
    const validJob: JobRecordV2 = {
      schema_version: JOBS_V2_SCHEMA_VERSION,
      job_id: "job-00000000-0000-0000-0000-000000000001",
      request_id: "req-00000000-0000-0000-0000-000000000001",
      user_id: "usr_alice",
      workspace_id: "ws_alpha",
      target_id: "tgt_omega",
      prompt: "Implement connector schema",
      acceptance: "Schema version 12 passes tests",
      resource_id: null,
      execution_timeout_seconds: 3600,
      result_target: "none",
      request_digest: "0123456789abcdef".repeat(4),
      status: "queued",
      stream_entry_id: "1720000000000-0",
      latest_attempt_id: null,
      created_at_ms: 1000,
      claim_deadline_ms: 2000,
    };

    it("round-trips a valid queued job", () => {
      const serialized = serializeJobRecordV2(validJob);
      const parsed = parseJobRecordV2(serialized);
      expect(parsed).toEqual(validJob);
    });

    it("enforces preparing state invariants", () => {
      const preparingJob: JobRecordV2 = {
        ...validJob,
        status: "preparing",
        stream_entry_id: null,
        latest_attempt_id: null,
      };
      expect(parseJobRecordV2(preparingJob)).toEqual(preparingJob);

      // Illegal: preparing with stream_entry_id
      expect(() =>
        parseJobRecordV2({ ...preparingJob, stream_entry_id: "123-0" }),
      ).toThrow(V2SchemaError);
    });

    it("enforces queued state invariants", () => {
      // Illegal: queued without stream_entry_id
      expect(() =>
        parseJobRecordV2({ ...validJob, status: "queued", stream_entry_id: null }),
      ).toThrow(V2SchemaError);

      // Illegal: queued with latest_attempt_id
      expect(() =>
        parseJobRecordV2({ ...validJob, status: "queued", latest_attempt_id: "att_1" }),
      ).toThrow(V2SchemaError);
    });

    it("enforces active state invariants", () => {
      const activeJob: JobRecordV2 = {
        ...validJob,
        status: "active",
        stream_entry_id: "1720000000000-0",
        latest_attempt_id: "att_1",
      };
      expect(parseJobRecordV2(activeJob)).toEqual(activeJob);

      // Illegal: active without latest_attempt_id
      expect(() =>
        parseJobRecordV2({ ...activeJob, latest_attempt_id: null }),
      ).toThrow(V2SchemaError);
    });

    it("rejects forbidden legacy fields", () => {
      expect(() =>
        parseJobRecordV2({ ...validJob, workspace_ref: "tools" }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseJobRecordV2({ ...validJob, worker_id: "wrk-123" }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseJobRecordV2({ ...validJob, execution: { worker_id: "wrk-123" } }),
      ).toThrow(V2SchemaError);
    });

    it("rejects unsupported schema version", () => {
      expect(() =>
        parseJobRecordV2({ ...validJob, schema_version: 5 }),
      ).toThrow(V2SchemaError);
    });
  });

  describe("AttemptRecordV1 serialization & phase invariants", () => {
    const validAttempt: AttemptRecordV1 = {
      schema_version: ATTEMPT_V1_SCHEMA_VERSION,
      attempt_id: "att_001",
      job_id: "job_001",
      user_id: "usr_alice",
      workspace_id: "ws_alpha",
      target_id: "tgt_omega",
      device_id: "dev_omen",
      target_binding_id: "dtb_main",
      claim_token_sha256: "c".repeat(64),
      phase: "claimed",
      claimed_at_ms: 1000,
      started_at_ms: null,
    };

    it("round-trips claimed and running attempts", () => {
      const serialized = serializeAttemptRecordV1(validAttempt);
      expect(parseAttemptRecordV1(serialized)).toEqual(validAttempt);

      const runningAttempt: AttemptRecordV1 = {
        ...validAttempt,
        phase: "running",
        started_at_ms: 1500,
      };
      expect(parseAttemptRecordV1(runningAttempt)).toEqual(runningAttempt);
    });

    it("requires report on terminal attempt, while result remains optional", () => {
      const mockReport = {
        status: "COMPLETED" as const,
        summary: "Done",
        duration_ms: 500,
        completed_at_iso: new Date().toISOString(),
      };

      // Terminal with report but NO result is valid! (execution completion != business result)
      const terminalNoResult: AttemptRecordV1 = {
        ...validAttempt,
        phase: "terminal",
        started_at_ms: 1500,
        report: mockReport,
      };
      expect(parseAttemptRecordV1(terminalNoResult)).toEqual(terminalNoResult);

      // Terminal without report is rejected
      expect(() =>
        parseAttemptRecordV1({ ...validAttempt, phase: "terminal" }),
      ).toThrow(V2SchemaError);

      // Claimed/running with report is rejected
      expect(() =>
        parseAttemptRecordV1({ ...validAttempt, phase: "claimed", report: mockReport }),
      ).toThrow(V2SchemaError);
    });
  });

  describe("businessDigestV2", () => {
    it("is stable regardless of parameter authoring order and uses target_id", () => {
      const d1 = businessDigestV2({
        target_id: "tgt_alpha",
        prompt: "Task A",
        acceptance: "Criteria B",
        resource_id: null,
        execution_timeout_seconds: 3600,
        result_target: "none",
      });

      const d2 = businessDigestV2({
        acceptance: "Criteria B",
        result_target: "none",
        prompt: "Task A",
        execution_timeout_seconds: 3600,
        target_id: "tgt_alpha",
        resource_id: null,
      });

      expect(d1).toBe(d2);
      expect(d1).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("JobStreamEntryV2", () => {
    it("serializes and parses clean stream entries without payload data", () => {
      const entry = {
        schema_version: STREAM_V2_SCHEMA_VERSION,
        job_id: "job-1",
        user_id: "usr_alice",
        workspace_id: "ws_alpha",
        target_id: "tgt_omega",
        created_at_ms: 1720000000000,
      };

      const fields = serializeStreamEntryV2(entry);
      expect(fields.job_id).toBe("job-1");
      expect(fields).not.toHaveProperty("prompt");

      const parsed = parseStreamEntryV2(fields);
      expect(parsed).toEqual(entry);
    });
  });
});
