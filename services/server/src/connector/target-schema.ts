import { normalizeTargetAlias, V1_VALID_TARGET_KINDS, type V1ExecutionTargetKind, type ExecutionTargetRecord, type DeviceTargetBindingRecord } from "./control-store.js";

export const TARGET_ERROR_CODES = {
  INVALID_REQUEST: "INVALID_REQUEST",
  WORKSPACE_NOT_FOUND: "WORKSPACE_NOT_FOUND",
  WORKSPACE_ACCESS_DENIED: "WORKSPACE_ACCESS_DENIED",
  TARGET_CREATE_FORBIDDEN: "TARGET_CREATE_FORBIDDEN",
  TARGET_NOT_FOUND: "TARGET_NOT_FOUND",
  TARGET_DISABLED: "TARGET_DISABLED",
  TARGET_ALIAS_CONFLICT: "TARGET_ALIAS_CONFLICT",
  TARGET_REPOSITORY_NOT_FOUND: "TARGET_REPOSITORY_NOT_FOUND",
  DEVICE_NOT_ELIGIBLE: "DEVICE_NOT_ELIGIBLE",
  IDENTITY_UNAVAILABLE: "IDENTITY_UNAVAILABLE",
} as const;

export type TargetErrorCode = (typeof TARGET_ERROR_CODES)[keyof typeof TARGET_ERROR_CODES];

export class TargetValidationError extends Error {
  constructor(message: string, public readonly code: TargetErrorCode = TARGET_ERROR_CODES.INVALID_REQUEST) {
    super(message);
    this.name = "TargetValidationError";
  }
}

export interface RegisterTargetInput {
  workspace_id: string;
  alias: string;
  display_name: string;
  kind: V1ExecutionTargetKind;
  repository?: {
    source: "workspace_repository";
  } | null;
}

export interface ParsedRegisterTargetInput {
  workspaceId: string;
  alias: string;
  displayName: string;
  kind: V1ExecutionTargetKind;
  repositorySource: "workspace_repository" | null;
}

const ALLOWED_REGISTER_TARGET_KEYS = new Set([
  "workspace_id",
  "alias",
  "display_name",
  "kind",
  "repository",
]);

const ALLOWED_REPOSITORY_KEYS = new Set(["source"]);

/**
 * Validates and strictly parses a register target request.
 * Rejects unknown or disallowed keys with INVALID_REQUEST.
 */
export function parseRegisterTargetInput(raw: unknown): ParsedRegisterTargetInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TargetValidationError("Request body must be a JSON object.", TARGET_ERROR_CODES.INVALID_REQUEST);
  }

  const record = raw as Record<string, unknown>;

  // Strict unknown key check
  for (const key of Object.keys(record)) {
    if (!ALLOWED_REGISTER_TARGET_KEYS.has(key)) {
      throw new TargetValidationError(`Unexpected field '${key}' in register request.`, TARGET_ERROR_CODES.INVALID_REQUEST);
    }
  }

  const workspaceIdRaw = record.workspace_id;
  if (typeof workspaceIdRaw !== "string" || workspaceIdRaw.trim().length === 0) {
    throw new TargetValidationError("workspace_id must be a non-empty string.", TARGET_ERROR_CODES.INVALID_REQUEST);
  }
  const workspaceId = workspaceIdRaw.trim();

  const aliasRaw = record.alias;
  if (typeof aliasRaw !== "string" || aliasRaw.trim().length === 0) {
    throw new TargetValidationError("alias must be a non-empty string.", TARGET_ERROR_CODES.INVALID_REQUEST);
  }
  let alias: string;
  try {
    alias = normalizeTargetAlias(aliasRaw);
  } catch (err) {
    throw new TargetValidationError(
      err instanceof Error ? err.message : "Invalid target alias.",
      TARGET_ERROR_CODES.INVALID_REQUEST,
    );
  }

  const displayNameRaw = record.display_name;
  if (typeof displayNameRaw !== "string") {
    throw new TargetValidationError("display_name must be a string.", TARGET_ERROR_CODES.INVALID_REQUEST);
  }
  const displayName = displayNameRaw.trim();
  if (displayName.length < 1 || displayName.length > 128) {
    throw new TargetValidationError("display_name must be between 1 and 128 characters.", TARGET_ERROR_CODES.INVALID_REQUEST);
  }

  const kindRaw = record.kind;
  if (typeof kindRaw !== "string") {
    throw new TargetValidationError("kind must be a string.", TARGET_ERROR_CODES.INVALID_REQUEST);
  }
  const kind = kindRaw.trim() as V1ExecutionTargetKind;
  if (!V1_VALID_TARGET_KINDS.includes(kind)) {
    throw new TargetValidationError(
      `Invalid kind '${kindRaw}'; must be one of: ${V1_VALID_TARGET_KINDS.join(", ")}.`,
      TARGET_ERROR_CODES.INVALID_REQUEST,
    );
  }

  let repositorySource: "workspace_repository" | null = null;
  const repoRaw = record.repository;
  if (repoRaw !== undefined && repoRaw !== null) {
    if (typeof repoRaw !== "object" || Array.isArray(repoRaw)) {
      throw new TargetValidationError("repository must be an object or null.", TARGET_ERROR_CODES.INVALID_REQUEST);
    }
    const repoRecord = repoRaw as Record<string, unknown>;
    for (const key of Object.keys(repoRecord)) {
      if (!ALLOWED_REPOSITORY_KEYS.has(key)) {
        throw new TargetValidationError(`Unexpected field '${key}' in repository object.`, TARGET_ERROR_CODES.INVALID_REQUEST);
      }
    }

    if (repoRecord.source !== "workspace_repository") {
      throw new TargetValidationError(
        "repository.source must be 'workspace_repository'.",
        TARGET_ERROR_CODES.INVALID_REQUEST,
      );
    }

    if (kind === "general_automation") {
      throw new TargetValidationError(
        "general_automation targets cannot have repository configured.",
        TARGET_ERROR_CODES.INVALID_REQUEST,
      );
    }

    repositorySource = "workspace_repository";
  }

  return {
    workspaceId,
    alias,
    displayName,
    kind,
    repositorySource,
  };
}

export interface ConnectorTargetProjection {
  id: string;
  workspace_id: string;
  alias: string;
  display_name: string;
  kind: string;
  repository: {
    provider: string;
    external_id: string;
    full_name: string;
  } | null;
  disabled: boolean;
}

export interface ConnectorTargetItem {
  target: ConnectorTargetProjection;
  this_device_binding: {
    id: string;
    enabled: boolean;
  } | null;
  active_binding_count: number;
}

export function toConnectorTargetProjection(
  target: ExecutionTargetRecord,
  thisBinding: DeviceTargetBindingRecord | null,
  activeBindingCount: number,
): ConnectorTargetItem {
  const hasRepo =
    target.repository_provider !== null &&
    target.repository_external_id !== null &&
    target.repository_full_name !== null;

  return {
    target: {
      id: target.id,
      workspace_id: target.workspace_id,
      alias: target.alias,
      display_name: target.display_name,
      kind: target.kind,
      repository: hasRepo
        ? {
            provider: target.repository_provider!,
            external_id: target.repository_external_id!,
            full_name: target.repository_full_name!,
          }
        : null,
      disabled: target.disabled_at_ms !== null,
    },
    this_device_binding: thisBinding
      ? {
          id: thisBinding.id,
          enabled: thisBinding.disabled_at_ms === null,
        }
      : null,
    active_binding_count: activeBindingCount,
  };
}
