export type ErrorCode =
  | "STALE_REVISION"
  | "BLOB_MISMATCH"
  | "INVALID_PATH"
  | "INVALID_OPERATION"
  | "VALIDATION_FAILED"
  | "WORKSPACE_DIRTY"
  | "PUSH_PENDING"
  | "WORKSPACE_DIVERGED"
  | "PUSHED_LOCAL_REPAIR_NEEDED"
  | "NOT_READY"
  | "INTERNAL_ERROR";

export class LifeOSError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "LifeOSError";
  }
}

export function safeError(error: unknown): {
  ok: false;
  code: ErrorCode;
  message: string;
  details: Record<string, unknown>;
} {
  if (error instanceof LifeOSError) {
    return { ok: false, code: error.code, message: error.message, details: error.details };
  }
  return {
    ok: false,
    code: "INTERNAL_ERROR",
    message: "The LifeOS workspace operation failed.",
    details: {},
  };
}
