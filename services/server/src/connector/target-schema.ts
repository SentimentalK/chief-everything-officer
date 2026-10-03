import { normalizeRemoteFullName, normalizeTargetAlias, V1_VALID_TARGET_KINDS, type V1ExecutionTargetKind, type ExecutionTargetRecord, type DeviceTargetBindingRecord } from "./control-store.js";

export const TARGET_ERROR_CODES = {
  INVALID_REQUEST: "INVALID_REQUEST",
  WORKSPACE_NOT_FOUND: "WORKSPACE_NOT_FOUND",
  WORKSPACE_ACCESS_DENIED: "WORKSPACE_ACCESS_DENIED",
  TARGET_CREATE_FORBIDDEN: "TARGET_CREATE_FORBIDDEN",
  TARGET_NOT_FOUND: "TARGET_NOT_FOUND",
  TARGET_DISABLED: "TARGET_DISABLED",
  TARGET_ALIAS_CONFLICT: "TARGET_ALIAS_CONFLICT",
  TARGET_REPOSITORY_NOT_FOUND: "TARGET_REPOSITORY_NOT_FOUND",
  TARGET_REPOSITORY_CONFLICT: "TARGET_REPOSITORY_CONFLICT",
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
  repository?: RegisterTargetRepository | null;
}

/**
 * Repository provenance sent by devices:
 * - `workspace_repository`: server derives identity from the workspace's own
 *   GitHub repository binding (legacy flow).
 * - `remote_url`: device-observed Git origin for repository-first
 *   fresh-device Project identity (normalized provider + owner/repo).
 */
export type RegisterTargetRepository = {
  source: "workspace_repository";
} | {
  source: "remote_url";
  provider: string;
  full_name: string;
} | null;

export interface ParsedRegisterTargetInput {
  workspaceId: string;
  alias: string;
  displayName: string;
  kind: V1ExecutionTargetKind;
  repositorySource: "workspace_repository" | "remote_url" | null;
  repositoryProvider: string | null;
  repositoryFullName: string | null;
}

const ALLOWED_REGISTER_TARGET_KEYS = new Set([
  "workspace_id",
  "alias",
  "display_name",
  "kind",
  "repository",
]);

const ALLOWED_REPOSITORY_KEYS = new Set(["source", "provider", "full_name"]);

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

  let repositorySource: "workspace_repository" | "remote_url" | null = null;
  let repositoryProvider: string | null = null;
  let repositoryFullName: string | null = null;
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

    if (repoRecord.source !== "workspace_repository" && repoRecord.source !== "remote_url") {
      throw new TargetValidationError(
        "repository.source must be 'workspace_repository' or 'remote_url'.",
        TARGET_ERROR_CODES.INVALID_REQUEST,
      );
    }

    if (kind === "general_automation") {
      throw new TargetValidationError(
        "general_automation targets cannot have repository configured.",
        TARGET_ERROR_CODES.INVALID_REQUEST,
      );
    }

    if (repoRecord.source === "remote_url") {
      if (typeof repoRecord.provider !== "string" || repoRecord.provider.trim().length === 0 || repoRecord.provider.trim().length > 64) {
        throw new TargetValidationError(
          "repository.provider must be a non-empty string (max 64 characters).",
          TARGET_ERROR_CODES.INVALID_REQUEST,
        );
      }
      if (typeof repoRecord.full_name !== "string" || repoRecord.full_name.trim().length === 0 || repoRecord.full_name.trim().length > 256) {
        throw new TargetValidationError(
          "repository.full_name must be a non-empty string (max 256 characters).",
          TARGET_ERROR_CODES.INVALID_REQUEST,
        );
      }
      repositoryProvider = repoRecord.provider.trim().toLowerCase();
      repositoryFullName = normalizeRemoteFullName(repoRecord.provider.trim().toLowerCase(), repoRecord.full_name.trim());
      if (repositoryFullName === null) {
        throw new TargetValidationError(
          "repository.full_name is not a valid normalized repository name.",
          TARGET_ERROR_CODES.INVALID_REQUEST,
        );
      }
    }

    repositorySource = repoRecord.source as "workspace_repository" | "remote_url";
  }

  return {
    workspaceId,
    alias,
    displayName,
    kind,
    repositorySource,
    repositoryProvider,
    repositoryFullName,
  };
}

export interface ParsedAttachTargetRepositoryInput {
  workspaceId: string;
  targetId: string;
  provider: string;
  fullName: string;
}

/**
 * Validates and strictly parses an attach-repository request body:
 * `{ workspace_id, repository: { source: "remote_url", provider, full_name } }`.
 * The `remote_url` form is the ONLY accepted source: legacy backfill is
 * always driven by a device-observed, locally verified Git origin — never by
 * human names or server-derived workspace bindings.
 */
export function parseAttachTargetRepositoryInput(
  targetId: string,
  raw: unknown,
): ParsedAttachTargetRepositoryInput {
  if (!targetId || typeof targetId !== "string" || targetId.trim().length === 0) {
    throw new TargetValidationError("target_id path parameter must be a non-empty string.", TARGET_ERROR_CODES.INVALID_REQUEST);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TargetValidationError("Request body must be a JSON object.", TARGET_ERROR_CODES.INVALID_REQUEST);
  }

  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("workspace_id") || !keys.includes("repository")) {
    throw new TargetValidationError(
      "Attach-repository request must contain exactly the fields: 'workspace_id' and 'repository'.",
      TARGET_ERROR_CODES.INVALID_REQUEST,
    );
  }

  const workspaceIdRaw = record.workspace_id;
  if (typeof workspaceIdRaw !== "string" || workspaceIdRaw.trim().length === 0) {
    throw new TargetValidationError("workspace_id must be a non-empty string.", TARGET_ERROR_CODES.INVALID_REQUEST);
  }
  const workspaceId = workspaceIdRaw.trim();

  const repoRaw = record.repository;
  if (!repoRaw || typeof repoRaw !== "object" || Array.isArray(repoRaw)) {
    throw new TargetValidationError("repository must be an object.", TARGET_ERROR_CODES.INVALID_REQUEST);
  }
  const repoRecord = repoRaw as Record<string, unknown>;
  for (const key of Object.keys(repoRecord)) {
    if (!ALLOWED_REPOSITORY_KEYS.has(key)) {
      throw new TargetValidationError(`Unexpected field '${key}' in repository object.`, TARGET_ERROR_CODES.INVALID_REQUEST);
    }
  }

  if (repoRecord.source !== "remote_url") {
    throw new TargetValidationError(
      "repository.source must be 'remote_url': legacy backfill only accepts a device-observed Git origin.",
      TARGET_ERROR_CODES.INVALID_REQUEST,
    );
  }

  if (typeof repoRecord.provider !== "string" || repoRecord.provider.trim().length === 0 || repoRecord.provider.trim().length > 64) {
    throw new TargetValidationError(
      "repository.provider must be a non-empty string (max 64 characters).",
      TARGET_ERROR_CODES.INVALID_REQUEST,
    );
  }
  if (typeof repoRecord.full_name !== "string" || repoRecord.full_name.trim().length === 0 || repoRecord.full_name.trim().length > 256) {
    throw new TargetValidationError(
      "repository.full_name must be a non-empty string (max 256 characters).",
      TARGET_ERROR_CODES.INVALID_REQUEST,
    );
  }
  const provider = repoRecord.provider.trim().toLowerCase();
  const fullName = normalizeRemoteFullName(provider, repoRecord.full_name.trim());
  if (!provider || fullName === null) {
    throw new TargetValidationError(
      "repository.full_name is not a valid normalized repository name.",
      TARGET_ERROR_CODES.INVALID_REQUEST,
    );
  }

  return { workspaceId, targetId: targetId.trim(), provider, fullName };
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
  is_default_agent_runtime: boolean;
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
  isDefaultAgentRuntime = false,
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
      is_default_agent_runtime: isDefaultAgentRuntime,
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
