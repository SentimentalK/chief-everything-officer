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
  | "ACCESS_DENIED"
  | "NOT_READY"
  | "NOT_FOUND"
  | "DUPLICATE_RESOURCE"
  | "INVALID_SOURCE_ASSET"
  | "INVALID_META"
  | "INVALID_RESOURCE_ID"
  | "RESOURCE_API_REQUIRED"
  | "RESOURCE_NAME_CONFLICT"
  | "RESOURCE_NOT_ACQUIRABLE"
  | "RESOURCE_RUNTIME_TARGET_NOT_CONFIGURED"
  | "RESOURCE_RUNTIME_TARGET_UNAVAILABLE"
  | "RESULT_CONFLICT"
  | "CORRUPTION"
  | "INTERNAL_ERROR";

export class CeoError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CeoError";
  }
}

export function safeError(error: unknown): {
  ok: false;
  code: ErrorCode;
  message: string;
  details: Record<string, unknown>;
} {
  if (error instanceof CeoError) {
    return { ok: false, code: error.code, message: error.message, details: error.details };
  }
  if (
    error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "JobValidationError" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      message: (error as { message: string }).message,
      details: {},
    };
  }
  return {
    ok: false,
    code: "INTERNAL_ERROR",
    message: "The CEO workspace operation failed.",
    details: {},
  };
}
