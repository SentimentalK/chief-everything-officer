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
  type JobStreamEntryV2,
} from "../src/jobs/v2-schema.js";
import {
  type PersistedExecutionReport,
  type PersistedJobResult,
  validatePersistedExecutionReport,
  validatePersistedJobResult,
  ExecutionContractError,
} from "../src/jobs/execution-contract.js";

describe("Redis V2 Coordination Schema", () => {
  it("generates correct key namespaces including 1:N attempt ZSET", () => {
    expect(KEY_STREAM_V2).toBe("ceo:jobs:v2");
    expect(jobKeyV2("job-123")).toBe("ceo:job:v2:job-123");
    expect(jobAttemptsKeyV1("job-123")).toBe("ceo:job:v2:job-123:attempts");
    expect(attemptKeyV1("att-456")).toBe("ceo:attempt:v1:att-456");
    expect(requestKeyV2("usr_a", "ws_b", "req_c")).toBe("ceo:request:v2:usr_a:ws_b:req_c");
  });

  const validJob: JobRecordV2 = {
    schema_version: JOBS_V2_SCHEMA_VERSION,
    job_id: "job-00000000-0000-0000-0000-000000000001",
    request_id: "req-00000000-0000-0000-0000-000000000001",
    user_id: "usr_alice",
    workspace_id: "ws_alpha",
    target_id: "tgt_00000000-0000-0000-0000-000000000001",
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

  const validAttempt: AttemptRecordV1 = {
    schema_version: ATTEMPT_V1_SCHEMA_VERSION,
    attempt_id: "att_00000000-0000-0000-0000-000000000001",
    job_id: "job-00000000-0000-0000-0000-000000000001",
    user_id: "usr_alice",
    workspace_id: "ws_alpha",
    target_id: "tgt_00000000-0000-0000-0000-000000000001",
    device_id: "dev_00000000-0000-0000-0000-000000000001",
    target_binding_id: "dtb_00000000-0000-0000-0000-000000000001",
    claim_token_sha256: "c".repeat(64),
    phase: "claimed",
    claimed_at_ms: 1000,
    started_at_ms: null,
  };

  const validReport: PersistedExecutionReport = {
    schema_version: 2,
    execution_status: "COMPLETED",
    business_outcome: "UNVERIFIED",
    task_dispatched: true,
    finished_at_ms: 2000,
    duration_ms: 500,
    executor: {
      type: "local-worker",
      version: "1.0.0",
    },
    receipt_sha256: "a".repeat(64),
    error: null,
    received_at_ms: 2100,
  };

  const validResult: PersistedJobResult = {
    target: "resource",
    attempt_id: validAttempt.attempt_id,
    payload_sha256: "b".repeat(64),
    resource_id: "res-00000000-0000-0000-0000-000000000001",
    commit: "c0ffee1234567890",
    received_at_ms: 2200,
  };

  describe("JobRecordV2 validation & state invariants", () => {
    it("round-trips a valid queued job", () => {
      const serialized = serializeJobRecordV2(validJob);
      const parsed = parseJobRecordV2(serialized);
      expect(parsed).toEqual(validJob);
    });

    it("round-trips a valid job with result_target=resource and valid resource_id", () => {
      const resJob: JobRecordV2 = {
        ...validJob,
        result_target: "resource",
        resource_id: "res-00000000-0000-0000-0000-000000000001",
      };
      const serialized = serializeJobRecordV2(resJob);
      expect(parseJobRecordV2(serialized)).toEqual(resJob);
    });

    it("rejects result_target=resource without resource_id", () => {
      expect(() =>
        parseJobRecordV2({ ...validJob, result_target: "resource", resource_id: null }),
      ).toThrow(V2SchemaError);
    });

    it("rejects result_target=none with resource_id set", () => {
      expect(() =>
        parseJobRecordV2({
          ...validJob,
          result_target: "none",
          resource_id: "res-00000000-0000-0000-0000-000000000001",
        }),
      ).toThrow(V2SchemaError);
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

      // Illegal: preparing with latest_attempt_id
      expect(() =>
        parseJobRecordV2({
          ...preparingJob,
          latest_attempt_id: "att_00000000-0000-0000-0000-000000000001",
        }),
      ).toThrow(V2SchemaError);
    });

    it("enforces queued state invariants", () => {
      // Illegal: queued without stream_entry_id
      expect(() =>
        parseJobRecordV2({ ...validJob, status: "queued", stream_entry_id: null }),
      ).toThrow(V2SchemaError);

      // Illegal: queued with latest_attempt_id
      expect(() =>
        parseJobRecordV2({
          ...validJob,
          status: "queued",
          latest_attempt_id: "att_00000000-0000-0000-0000-000000000001",
        }),
      ).toThrow(V2SchemaError);
    });

    it("enforces active state invariants", () => {
      const activeJob: JobRecordV2 = {
        ...validJob,
        status: "active",
        stream_entry_id: "1720000000000-0",
        latest_attempt_id: "att_00000000-0000-0000-0000-000000000001",
      };
      expect(parseJobRecordV2(activeJob)).toEqual(activeJob);

      // Illegal: active without latest_attempt_id
      expect(() =>
        parseJobRecordV2({ ...activeJob, latest_attempt_id: null }),
      ).toThrow(V2SchemaError);

      // Illegal: active without stream_entry_id
      expect(() =>
        parseJobRecordV2({ ...activeJob, stream_entry_id: null }),
      ).toThrow(V2SchemaError);
    });

    it("enforces terminal state invariants", () => {
      const terminalJob: JobRecordV2 = {
        ...validJob,
        status: "terminal",
        stream_entry_id: "1720000000000-0",
        latest_attempt_id: "att_00000000-0000-0000-0000-000000000001",
      };
      expect(parseJobRecordV2(terminalJob)).toEqual(terminalJob);

      // Illegal: terminal without latest_attempt_id
      expect(() =>
        parseJobRecordV2({ ...terminalJob, latest_attempt_id: null }),
      ).toThrow(V2SchemaError);

      // Illegal: terminal without stream_entry_id
      expect(() =>
        parseJobRecordV2({ ...terminalJob, stream_entry_id: null }),
      ).toThrow(V2SchemaError);
    });

    it("rejects unknown extra fields and forbidden legacy fields", () => {
      expect(() =>
        parseJobRecordV2({ ...validJob, workspace_ref: "tools" }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseJobRecordV2({ ...validJob, worker_id: "wrk-123" }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseJobRecordV2({ ...validJob, execution: { worker_id: "wrk-123" } }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseJobRecordV2({ ...validJob, report: validReport }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseJobRecordV2({ ...validJob, result: validResult }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseJobRecordV2({ ...validJob, arbitrary_extra_field: "disallowed" }),
      ).toThrow(V2SchemaError);
    });

    it("rejects bad ID and digest formats", () => {
      expect(() =>
        parseJobRecordV2({ ...validJob, target_id: "not-a-tgt-id" }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseJobRecordV2({ ...validJob, job_id: "not-a-job-id" }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseJobRecordV2({ ...validJob, request_digest: "not-64-hex" }),
      ).toThrow(V2SchemaError);

      // Uppercase hex in request_digest rejected
      expect(() =>
        parseJobRecordV2({ ...validJob, request_digest: "A".repeat(64) }),
      ).toThrow(V2SchemaError);
    });

    it("rejects timeout out of policy bounds [60, 7200]", () => {
      expect(() =>
        parseJobRecordV2({ ...validJob, execution_timeout_seconds: 30 }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseJobRecordV2({ ...validJob, execution_timeout_seconds: 7201 }),
      ).toThrow(V2SchemaError);
    });

    it("rejects prompt and acceptance byte limit overflows", () => {
      expect(() =>
        parseJobRecordV2({ ...validJob, prompt: "x".repeat(64 * 1024 + 1) }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseJobRecordV2({ ...validJob, acceptance: "y".repeat(8 * 1024 + 1) }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseJobRecordV2({ ...validJob, prompt: "   " }),
      ).toThrow(V2SchemaError);
    });

    it("rejects invalid JSON on parse", () => {
      expect(() => parseJobRecordV2("{ malformed json")).toThrow(V2SchemaError);
    });

    it("rejects serialization of invalid job record", () => {
      expect(() =>
        serializeJobRecordV2({ ...validJob, prompt: "" }),
      ).toThrow(V2SchemaError);
    });
  });

  describe("AttemptRecordV1 serialization & phase invariants", () => {
    it("round-trips claimed attempt", () => {
      const serialized = serializeAttemptRecordV1(validAttempt);
      expect(parseAttemptRecordV1(serialized)).toEqual(validAttempt);
    });

    it("round-trips running attempt", () => {
      const runningAttempt: AttemptRecordV1 = {
        ...validAttempt,
        phase: "running",
        started_at_ms: 1500,
      };
      const serialized = serializeAttemptRecordV1(runningAttempt);
      expect(parseAttemptRecordV1(serialized)).toEqual(runningAttempt);
    });

    it("round-trips terminal attempt with real execution report (no result)", () => {
      const terminalAttempt: AttemptRecordV1 = {
        ...validAttempt,
        phase: "terminal",
        started_at_ms: 1500,
        report: validReport,
      };
      const serialized = serializeAttemptRecordV1(terminalAttempt);
      expect(parseAttemptRecordV1(serialized)).toEqual(terminalAttempt);
    });

    it("round-trips terminal attempt with real execution report AND valid result", () => {
      const terminalWithResult: AttemptRecordV1 = {
        ...validAttempt,
        phase: "terminal",
        started_at_ms: 1500,
        report: validReport,
        result: validResult,
      };
      const serialized = serializeAttemptRecordV1(terminalWithResult);
      expect(parseAttemptRecordV1(serialized)).toEqual(terminalWithResult);
    });

    it("rejects claimed attempt with started_at_ms or result", () => {
      expect(() =>
        parseAttemptRecordV1({ ...validAttempt, phase: "claimed", started_at_ms: 1200 }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseAttemptRecordV1({ ...validAttempt, phase: "claimed", result: validResult }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseAttemptRecordV1({ ...validAttempt, phase: "claimed", report: validReport }),
      ).toThrow(V2SchemaError);
    });

    it("rejects running attempt with started_at_ms=null or with report/result", () => {
      expect(() =>
        parseAttemptRecordV1({ ...validAttempt, phase: "running", started_at_ms: null }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseAttemptRecordV1({
          ...validAttempt,
          phase: "running",
          started_at_ms: 1500,
          report: validReport,
        }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseAttemptRecordV1({
          ...validAttempt,
          phase: "running",
          started_at_ms: 1500,
          result: validResult,
        }),
      ).toThrow(V2SchemaError);
    });

    it("rejects started_at_ms < claimed_at_ms", () => {
      expect(() =>
        parseAttemptRecordV1({
          ...validAttempt,
          phase: "running",
          claimed_at_ms: 2000,
          started_at_ms: 1500,
        }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseAttemptRecordV1({
          ...validAttempt,
          phase: "terminal",
          claimed_at_ms: 2000,
          started_at_ms: 1500,
          report: validReport,
        }),
      ).toThrow(V2SchemaError);
    });

    it("rejects terminal attempt without report or with invalid report", () => {
      // Terminal without report
      expect(() =>
        parseAttemptRecordV1({
          ...validAttempt,
          phase: "terminal",
          started_at_ms: 1500,
        }),
      ).toThrow(V2SchemaError);

      // Terminal with fake/unstructured report (the hole from before)
      expect(() =>
        parseAttemptRecordV1({
          ...validAttempt,
          phase: "terminal",
          started_at_ms: 1500,
          report: { status: "COMPLETED", summary: "Done" },
        }),
      ).toThrow(V2SchemaError);

      // Terminal with report violating business invariants (non-completed without error)
      expect(() =>
        parseAttemptRecordV1({
          ...validAttempt,
          phase: "terminal",
          started_at_ms: 1500,
          report: {
            ...validReport,
            execution_status: "FAILED",
            error: null,
          },
        }),
      ).toThrow(V2SchemaError);

      // Terminal with report violating business invariants (completed with error)
      expect(() =>
        parseAttemptRecordV1({
          ...validAttempt,
          phase: "terminal",
          started_at_ms: 1500,
          report: {
            ...validReport,
            execution_status: "COMPLETED",
            error: { stage: "build", code: "ERR", message: "fail" },
          },
        }),
      ).toThrow(V2SchemaError);
    });

    it("rejects terminal attempt with malformed result or result for another attempt", () => {
      // Malformed result
      expect(() =>
        parseAttemptRecordV1({
          ...validAttempt,
          phase: "terminal",
          started_at_ms: 1500,
          report: validReport,
          result: { target: "invalid_target" },
        }),
      ).toThrow(V2SchemaError);

      // Result for another attempt_id
      expect(() =>
        parseAttemptRecordV1({
          ...validAttempt,
          phase: "terminal",
          started_at_ms: 1500,
          report: validReport,
          result: {
            ...validResult,
            attempt_id: "att_99999999-9999-9999-9999-999999999999",
          },
        }),
      ).toThrow(V2SchemaError);
    });

    it("rejects unknown extra fields and bad identifiers", () => {
      expect(() =>
        parseAttemptRecordV1({ ...validAttempt, workspace_ref: "repo" }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseAttemptRecordV1({ ...validAttempt, worker_id: "wrk-123" }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseAttemptRecordV1({ ...validAttempt, extra_field: "bad" }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseAttemptRecordV1({ ...validAttempt, claim_token_sha256: "not-64-hex" }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseAttemptRecordV1({ ...validAttempt, target_id: "bad_target" }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseAttemptRecordV1({ ...validAttempt, device_id: "bad_device" }),
      ).toThrow(V2SchemaError);

      expect(() =>
        parseAttemptRecordV1({ ...validAttempt, target_binding_id: "bad_binding" }),
      ).toThrow(V2SchemaError);
    });

    it("rejects serialization of invalid attempt record", () => {
      expect(() =>
        serializeAttemptRecordV1({ ...validAttempt, phase: "running", started_at_ms: null }),
      ).toThrow(V2SchemaError);
    });

    it("rejects invalid JSON string on attempt parse", () => {
      expect(() => parseAttemptRecordV1("{ bad json")).toThrow(V2SchemaError);
    });
  });

  describe("JobStreamEntryV2", () => {
    const validEntry: JobStreamEntryV2 = {
      schema_version: STREAM_V2_SCHEMA_VERSION,
      job_id: "job-00000000-0000-0000-0000-000000000001",
      user_id: "usr_alice",
      workspace_id: "ws_alpha",
      target_id: "tgt_00000000-0000-0000-0000-000000000001",
      created_at_ms: 1720000000000,
    };

    it("serializes and parses clean stream entries without payload data", () => {
      const fields = serializeStreamEntryV2(validEntry);
      expect(fields.job_id).toBe(validEntry.job_id);
      expect(fields).not.toHaveProperty("prompt");

      const parsed = parseStreamEntryV2(fields);
      expect(parsed).toEqual(validEntry);
    });

    it("rejects unknown fields on stream entry", () => {
      expect(() =>
        serializeStreamEntryV2({ ...validEntry, prompt: "sneak_in" }),
      ).toThrow(V2SchemaError);
    });

    it("rejects invalid ID format on stream entry", () => {
      expect(() =>
        serializeStreamEntryV2({ ...validEntry, target_id: "invalid_target" }),
      ).toThrow(V2SchemaError);
    });
  });

  describe("execution-contract runtime validators", () => {
    it("validates genuine PersistedExecutionReport and rejects invalid shapes", () => {
      expect(validatePersistedExecutionReport(validReport)).toEqual(validReport);

      expect(() =>
        validatePersistedExecutionReport({
          status: "COMPLETED",
        }),
      ).toThrow(ExecutionContractError);
    });

    it("validates genuine PersistedJobResult and rejects invalid shapes", () => {
      expect(validatePersistedJobResult(validResult)).toEqual(validResult);

      expect(() =>
        validatePersistedJobResult({
          target: "wrong",
          attempt_id: "att_001",
        }),
      ).toThrow(ExecutionContractError);

      expect(() =>
        validatePersistedJobResult({
          ...validResult,
          payload_sha256: "not-64-hex",
        }),
      ).toThrow(ExecutionContractError);
    });
  });

  describe("businessDigestV2", () => {
    it("is stable regardless of parameter authoring order and uses target_id", () => {
      const d1 = businessDigestV2({
        target_id: "tgt_00000000-0000-0000-0000-000000000001",
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
        target_id: "tgt_00000000-0000-0000-0000-000000000001",
        resource_id: null,
      });

      expect(d1).toBe(d2);
      expect(d1).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
