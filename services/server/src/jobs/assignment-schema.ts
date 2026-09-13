import type { PersistedJobRecord } from "./schema.js";
import { JOBS_SCHEMA_VERSION } from "./schema.js";

export const ASSIGNMENT_SCHEMA_VERSION = JOBS_SCHEMA_VERSION;

export interface JobAssignment {
  worker_id: string;
  attempt_id: string;
  claim_token_sha256: string;
  phase: "claimed" | "running";
  claimed_at_ms: number;
  started_at_ms: number | null;
}

export interface ExecutionAssignmentView {
  worker_id: string;
  attempt_id: string;
  phase: "claimed" | "running";
  claimed_at: string;
  started_at: string | null;
}

export type AssignmentJobRecord = PersistedJobRecord;

export type AssignmentState =
  | "queued"
  | "expired"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "blocked"
  | "interrupted";

export type AssignmentScriptResult =
  | {
      ok: true;
      record: AssignmentJobRecord;
      server_time_ms: number;
      state: AssignmentState;
      replayed: boolean;
    }
  | {
      ok: false;
      code: string;
      reason: string | null;
    };

export interface ClaimAssignmentInput {
  worker_id: string;
  attempt_id: string;
  workspace_ref: string;
  claim_token_sha256: string;
}

export interface StartAssignmentInput {
  worker_id: string;
  attempt_id: string;
  claim_token_sha256: string;
}

export interface ReportAssignmentInput {
  worker_id: string;
  attempt_id: string;
  claim_token_sha256: string;
  report: {
    schema_version: 2;
    execution_status: string;
    business_outcome: string;
    task_dispatched: boolean;
    finished_at_ms: number;
    duration_ms: number;
    executor: {
      type: string;
      version: string;
    };
    receipt_sha256: string;
    error: { stage: string; code: string; message: string } | null;
  };
}

export type AssignmentOperation = "inspect" | "claim" | "start" | "report";
export const ASSIGNMENT_OPERATIONS = ["inspect", "claim", "start", "report"] as const;
