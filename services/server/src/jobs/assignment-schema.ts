import type { PersistedJobRecord } from "./schema.js";

export const ASSIGNMENT_SCHEMA_VERSION = 2 as const;

export interface JobAssignment {
  worker_id: string;
  attempt_id: string;
  claim_token_sha256: string;
  phase: "claimed" | "running";
  claimed_at_ms: number;
  started_at_ms: number | null;
}

export type AssignmentJobRecord = Omit<PersistedJobRecord, "schema_version" | "execution"> & {
  schema_version: typeof ASSIGNMENT_SCHEMA_VERSION;
  execution?: JobAssignment;
};

export type AssignmentState = "queued" | "expired" | "claimed" | "running";

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

export type AssignmentOperation = "inspect" | "claim" | "start";
export const ASSIGNMENT_OPERATIONS = ["inspect", "claim", "start"] as const;
