import { IdentityStore, IdentityError, newId } from "../identity/store.js";

export class ConnectorControlError extends IdentityError {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = this.constructor.name;
  }
}
export class ConnectorTargetConflictError extends ConnectorControlError {}
export class ConnectorNotFoundError extends ConnectorControlError {}
export class ConnectorValidationError extends ConnectorControlError {}
export class ConnectorPermissionError extends ConnectorControlError {}
export class ConnectorTargetDisabledError extends ConnectorControlError {}
export class ConnectorTargetRepositoryNotFoundError extends ConnectorControlError {}
export class ConnectorDeviceRevokedError extends ConnectorControlError {}

export const TARGET_ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export const V1_VALID_TARGET_KINDS = ["general_automation", "coding"] as const;
export type V1ExecutionTargetKind = (typeof V1_VALID_TARGET_KINDS)[number];

export interface DeviceRecord {
  id: string;
  user_id: string;
  display_name: string;
  platform: string;
  created_at_ms: number;
  updated_at_ms: number;
  revoked_at_ms: number | null;
}

export interface DeviceCredentialRecord {
  id: string;
  device_id: string;
  secret_digest: string;
  issued_at_ms: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
}

export interface ExecutionTargetRecord {
  id: string;
  workspace_id: string;
  alias: string;
  display_name: string;
  kind: string;
  repository_provider: string | null;
  repository_external_id: string | null;
  repository_full_name: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  disabled_at_ms: number | null;
}

export interface DeviceTargetBindingRecord {
  id: string;
  device_id: string;
  target_id: string;
  created_at_ms: number;
  updated_at_ms: number;
  disabled_at_ms: number | null;
}

export interface EligibleBindingResolution {
  eligible: boolean;
  binding?: DeviceTargetBindingRecord;
  device?: DeviceRecord;
  target?: ExecutionTargetRecord;
  reason?: string;
}

export function normalizeTargetAlias(alias: string): string {
  const normalized = alias.trim().toLowerCase();
  if (!TARGET_ALIAS_RE.test(normalized)) {
    throw new ConnectorValidationError(
      `Target alias '${alias}' is invalid; must match ^[a-z0-9][a-z0-9_-]{0,63}$ (lowercase alphanumeric, hyphen, underscore, 1-64 chars).`,
    );
  }
  return normalized;
}

export class ConnectorControlStore {
  constructor(private readonly identityStore: IdentityStore) {}

  // ---------------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------------

  createDevice(input: {
    userId: string;
    displayName: string;
    platform: string;
    nowMs?: number;
  }): DeviceRecord {
    const trimmedName = input.displayName.trim();
    if (trimmedName.length === 0) {
      throw new ConnectorValidationError("Device display_name must be non-empty.");
    }
    const trimmedPlatform = input.platform.trim().toLowerCase();
    if (trimmedPlatform.length === 0) {
      throw new ConnectorValidationError("Device platform must be non-empty.");
    }

    const now = input.nowMs ?? Date.now();
    const id = newId("dev");

    return this.identityStore.withDb((db) => {
      const user = db.prepare("SELECT id FROM users WHERE id = ? AND disabled_at IS NULL LIMIT 1;").get(input.userId);
      if (!user) {
        throw new ConnectorNotFoundError(`User '${input.userId}' not found or disabled.`);
      }

      db.prepare(`
        INSERT INTO devices (id, user_id, display_name, platform, created_at_ms, updated_at_ms, revoked_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, NULL);
      `).run(id, input.userId, trimmedName, trimmedPlatform, now, now);

      return {
        id,
        user_id: input.userId,
        display_name: trimmedName,
        platform: trimmedPlatform,
        created_at_ms: now,
        updated_at_ms: now,
        revoked_at_ms: null,
      };
    });
  }

  getDevice(deviceId: string): DeviceRecord | null {
    return this.identityStore.withDb((db) => {
      const row = db.prepare(`
        SELECT id, user_id, display_name, platform, created_at_ms, updated_at_ms, revoked_at_ms
        FROM devices
        WHERE id = ?
        LIMIT 1;
      `).get(deviceId) as DeviceRecord | undefined;
      return row ?? null;
    });
  }

  listDevicesForUser(userId: string, options?: { includeRevoked?: boolean }): DeviceRecord[] {
    return this.identityStore.withDb((db) => {
      const sql = options?.includeRevoked
        ? `SELECT id, user_id, display_name, platform, created_at_ms, updated_at_ms, revoked_at_ms
           FROM devices WHERE user_id = ? ORDER BY created_at_ms ASC;`
        : `SELECT id, user_id, display_name, platform, created_at_ms, updated_at_ms, revoked_at_ms
           FROM devices WHERE user_id = ? AND revoked_at_ms IS NULL ORDER BY created_at_ms ASC;`;
      return db.prepare(sql).all(userId) as unknown as DeviceRecord[];
    });
  }

  revokeDevice(deviceId: string, revokedAtMs?: number): boolean {
    const now = revokedAtMs ?? Date.now();
    return this.identityStore.withDb((db) => {
      const res = db.prepare(`
        UPDATE devices
        SET revoked_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND revoked_at_ms IS NULL;
      `).run(now, now, deviceId);
      return Number(res.changes) > 0;
    });
  }

  // ---------------------------------------------------------------------------
  // Device Credentials
  // ---------------------------------------------------------------------------

  createDeviceCredential(input: {
    deviceId: string;
    secretDigest: string;
    issuedAtMs?: number;
    expiresAtMs: number;
  }): DeviceCredentialRecord {
    if (!SHA256_HEX_RE.test(input.secretDigest)) {
      throw new ConnectorValidationError("secret_digest must be a 64-character lowercase hex string.");
    }
    const issuedAt = input.issuedAtMs ?? Date.now();
    if (input.expiresAtMs <= issuedAt) {
      throw new ConnectorValidationError("expires_at_ms must be strictly greater than issued_at_ms.");
    }

    const id = newId("dcr");

    return this.identityStore.withDb((db) => {
      const device = db.prepare("SELECT id, revoked_at_ms FROM devices WHERE id = ? LIMIT 1;").get(input.deviceId) as
        | { id: string; revoked_at_ms: number | null }
        | undefined;
      if (!device) {
        throw new ConnectorNotFoundError(`Device '${input.deviceId}' not found.`);
      }
      if (device.revoked_at_ms !== null) {
        throw new ConnectorValidationError(`Cannot issue credential for revoked device '${input.deviceId}'.`);
      }

      db.prepare(`
        INSERT INTO device_credentials (id, device_id, secret_digest, issued_at_ms, expires_at_ms, revoked_at_ms)
        VALUES (?, ?, ?, ?, ?, NULL);
      `).run(id, input.deviceId, input.secretDigest, issuedAt, input.expiresAtMs);

      return {
        id,
        device_id: input.deviceId,
        secret_digest: input.secretDigest,
        issued_at_ms: issuedAt,
        expires_at_ms: input.expiresAtMs,
        revoked_at_ms: null,
      };
    });
  }

  getDeviceCredential(credentialId: string): DeviceCredentialRecord | null {
    return this.identityStore.withDb((db) => {
      const row = db.prepare(`
        SELECT id, device_id, secret_digest, issued_at_ms, expires_at_ms, revoked_at_ms
        FROM device_credentials
        WHERE id = ?
        LIMIT 1;
      `).get(credentialId) as DeviceCredentialRecord | undefined;
      return row ?? null;
    });
  }

  revokeDeviceCredential(credentialId: string, revokedAtMs?: number): boolean {
    const now = revokedAtMs ?? Date.now();
    return this.identityStore.withDb((db) => {
      const res = db.prepare(`
        UPDATE device_credentials
        SET revoked_at_ms = ?
        WHERE id = ? AND revoked_at_ms IS NULL;
      `).run(now, credentialId);
      return Number(res.changes) > 0;
    });
  }

  finalizeDeviceEnrollment(input: {
    deviceId: string;
    credentialId: string;
    userId: string;
    displayName: string;
    platform: string;
    secretDigest: string;
    issuedAtMs?: number;
    expiresAtMs: number;
  }): { device: DeviceRecord; credential: DeviceCredentialRecord; replayed: boolean } {
    const trimmedName = input.displayName.trim();
    if (trimmedName.length === 0 || trimmedName.length > 128) {
      throw new ConnectorValidationError("Device display_name must be between 1 and 128 characters.");
    }
    const trimmedPlatform = input.platform.trim().toLowerCase();
    if (trimmedPlatform.length === 0 || trimmedPlatform.length > 32) {
      throw new ConnectorValidationError("Device platform must be between 1 and 32 characters.");
    }
    if (!SHA256_HEX_RE.test(input.secretDigest)) {
      throw new ConnectorValidationError("secret_digest must be a 64-character lowercase hex string.");
    }

    const issuedAt = input.issuedAtMs ?? Date.now();
    if (input.expiresAtMs <= issuedAt) {
      throw new ConnectorValidationError("expires_at_ms must be strictly greater than issued_at_ms.");
    }

    return this.identityStore.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const user = db.prepare("SELECT id FROM users WHERE id = ? AND disabled_at IS NULL LIMIT 1;").get(input.userId);
        if (!user) {
          throw new ConnectorNotFoundError(`User '${input.userId}' not found or disabled.`);
        }

        const existingDevice = db.prepare(
          "SELECT id, user_id, display_name, platform, created_at_ms, updated_at_ms, revoked_at_ms FROM devices WHERE id = ? LIMIT 1;",
        ).get(input.deviceId) as DeviceRecord | undefined;

        const existingCredential = db.prepare(
          "SELECT id, device_id, secret_digest, issued_at_ms, expires_at_ms, revoked_at_ms FROM device_credentials WHERE id = ? LIMIT 1;",
        ).get(input.credentialId) as DeviceCredentialRecord | undefined;

        // Case 1: Both exist -> check exact match for idempotent replay
        if (existingDevice && existingCredential) {
          const matches =
            existingDevice.user_id === input.userId &&
            existingDevice.display_name === trimmedName &&
            existingDevice.platform === trimmedPlatform &&
            existingCredential.device_id === input.deviceId &&
            existingCredential.secret_digest === input.secretDigest;

          if (matches) {
            db.exec("COMMIT;");
            return {
              device: existingDevice,
              credential: existingCredential,
              replayed: true,
            };
          }

          throw new ConnectorControlError(
            `Conflict: Device '${input.deviceId}' and/or Credential '${input.credentialId}' already exist with conflicting metadata.`,
            "INTERNAL_CONFLICT",
          );
        }

        // Case 2: One exists and the other does not -> partial state, fail closed
        if (existingDevice || existingCredential) {
          throw new ConnectorControlError(
            `Conflict: Partial existing state for Device '${input.deviceId}' or Credential '${input.credentialId}'.`,
            "INTERNAL_CONFLICT",
          );
        }

        // Case 3: Neither exists -> atomic insert
        db.prepare(`
          INSERT INTO devices (id, user_id, display_name, platform, created_at_ms, updated_at_ms, revoked_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, NULL);
        `).run(input.deviceId, input.userId, trimmedName, trimmedPlatform, issuedAt, issuedAt);

        db.prepare(`
          INSERT INTO device_credentials (id, device_id, secret_digest, issued_at_ms, expires_at_ms, revoked_at_ms)
          VALUES (?, ?, ?, ?, ?, NULL);
        `).run(input.credentialId, input.deviceId, input.secretDigest, issuedAt, input.expiresAtMs);

        db.exec("COMMIT;");

        const device: DeviceRecord = {
          id: input.deviceId,
          user_id: input.userId,
          display_name: trimmedName,
          platform: trimmedPlatform,
          created_at_ms: issuedAt,
          updated_at_ms: issuedAt,
          revoked_at_ms: null,
        };

        const credential: DeviceCredentialRecord = {
          id: input.credentialId,
          device_id: input.deviceId,
          secret_digest: input.secretDigest,
          issued_at_ms: issuedAt,
          expires_at_ms: input.expiresAtMs,
          revoked_at_ms: null,
        };

        return {
          device,
          credential,
          replayed: false,
        };
      } catch (err) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // ignore
        }
        throw err;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Execution Targets
  // ---------------------------------------------------------------------------

  createExecutionTarget(input: {
    workspaceId: string;
    alias: string;
    displayName: string;
    kind: string;
    repositoryProvider?: string | null;
    repositoryExternalId?: string | null;
    repositoryFullName?: string | null;
    nowMs?: number;
  }): ExecutionTargetRecord {
    const normalizedAlias = normalizeTargetAlias(input.alias);
    const trimmedDisplayName = input.displayName.trim();
    if (trimmedDisplayName.length === 0) {
      throw new ConnectorValidationError("ExecutionTarget display_name must be non-empty.");
    }
    const trimmedKind = input.kind.trim();
    if (!V1_VALID_TARGET_KINDS.includes(trimmedKind as V1ExecutionTargetKind)) {
      throw new ConnectorValidationError(
        `ExecutionTarget kind '${trimmedKind}' is invalid for V1; must be one of: ${V1_VALID_TARGET_KINDS.join(", ")}.`,
      );
    }

    const provider = input.repositoryProvider?.trim() || null;
    const externalId = input.repositoryExternalId?.trim() || null;
    const fullName = input.repositoryFullName?.trim() || null;

    const hasProvider = provider !== null;
    const hasExternalId = externalId !== null;
    const hasFullName = fullName !== null;

    if (!((hasProvider && hasExternalId && hasFullName) || (!hasProvider && !hasExternalId && !hasFullName))) {
      throw new ConnectorValidationError(
        "repository_provider, repository_external_id, and repository_full_name must all be present or all be absent.",
      );
    }

    const now = input.nowMs ?? Date.now();
    const id = newId("tgt");

    return this.identityStore.withDb((db) => {
      const ws = db.prepare("SELECT id FROM workspaces WHERE id = ? LIMIT 1;").get(input.workspaceId);
      if (!ws) {
        throw new ConnectorNotFoundError(`Workspace '${input.workspaceId}' not found.`);
      }

      // Check alias uniqueness in workspace
      const existingAlias = db.prepare(
        "SELECT id FROM execution_targets WHERE workspace_id = ? AND alias = ? LIMIT 1;",
      ).get(input.workspaceId, normalizedAlias);
      if (existingAlias) {
        throw new ConnectorTargetConflictError(
          `ExecutionTarget with alias '${normalizedAlias}' already exists in workspace '${input.workspaceId}'.`,
        );
      }

      // Note: multiple targets in the same workspace MAY point to the same repository (e.g. monorepo or test/dev targets).

      db.prepare(`
        INSERT INTO execution_targets (
          id, workspace_id, alias, display_name, kind,
          repository_provider, repository_external_id, repository_full_name,
          created_at_ms, updated_at_ms, disabled_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL);
      `).run(
        id,
        input.workspaceId,
        normalizedAlias,
        trimmedDisplayName,
        trimmedKind,
        provider,
        externalId,
        fullName,
        now,
        now,
      );

      return {
        id,
        workspace_id: input.workspaceId,
        alias: normalizedAlias,
        display_name: trimmedDisplayName,
        kind: trimmedKind,
        repository_provider: provider,
        repository_external_id: externalId,
        repository_full_name: fullName,
        created_at_ms: now,
        updated_at_ms: now,
        disabled_at_ms: null,
      };
    });
  }

  getExecutionTarget(targetId: string): ExecutionTargetRecord | null {
    return this.identityStore.withDb((db) => {
      const row = db.prepare(`
        SELECT id, workspace_id, alias, display_name, kind,
               repository_provider, repository_external_id, repository_full_name,
               created_at_ms, updated_at_ms, disabled_at_ms
        FROM execution_targets
        WHERE id = ?
        LIMIT 1;
      `).get(targetId) as ExecutionTargetRecord | undefined;
      return row ?? null;
    });
  }

  getExecutionTargetByAlias(workspaceId: string, alias: string): ExecutionTargetRecord | null {
    const normalized = normalizeTargetAlias(alias);
    return this.identityStore.withDb((db) => {
      const row = db.prepare(`
        SELECT id, workspace_id, alias, display_name, kind,
               repository_provider, repository_external_id, repository_full_name,
               created_at_ms, updated_at_ms, disabled_at_ms
        FROM execution_targets
        WHERE workspace_id = ? AND alias = ?
        LIMIT 1;
      `).get(workspaceId, normalized) as ExecutionTargetRecord | undefined;
      return row ?? null;
    });
  }

  listExecutionTargetsForWorkspace(
    workspaceId: string,
    options?: { includeDisabled?: boolean },
  ): ExecutionTargetRecord[] {
    return this.identityStore.withDb((db) => {
      const sql = options?.includeDisabled
        ? `SELECT id, workspace_id, alias, display_name, kind,
                  repository_provider, repository_external_id, repository_full_name,
                  created_at_ms, updated_at_ms, disabled_at_ms
           FROM execution_targets WHERE workspace_id = ? ORDER BY alias ASC;`
        : `SELECT id, workspace_id, alias, display_name, kind,
                  repository_provider, repository_external_id, repository_full_name,
                  created_at_ms, updated_at_ms, disabled_at_ms
           FROM execution_targets WHERE workspace_id = ? AND disabled_at_ms IS NULL ORDER BY alias ASC;`;
      return db.prepare(sql).all(workspaceId) as unknown as ExecutionTargetRecord[];
    });
  }

  disableExecutionTarget(targetId: string, disabledAtMs?: number): boolean {
    const now = disabledAtMs ?? Date.now();
    return this.identityStore.withDb((db) => {
      const res = db.prepare(`
        UPDATE execution_targets
        SET disabled_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND disabled_at_ms IS NULL;
      `).run(now, now, targetId);
      return Number(res.changes) > 0;
    });
  }

  enableExecutionTarget(targetId: string, enabledAtMs?: number): boolean {
    const now = enabledAtMs ?? Date.now();
    return this.identityStore.withDb((db) => {
      const res = db.prepare(`
        UPDATE execution_targets
        SET disabled_at_ms = NULL, updated_at_ms = ?
        WHERE id = ? AND disabled_at_ms IS NOT NULL;
      `).run(now, targetId);
      return Number(res.changes) > 0;
    });
  }

  reconcileExecutionTargetRepositoryMetadata(input: {
    provider: string;
    externalId: string;
    fullName: string;
    nowMs?: number;
  }): number {
    const now = input.nowMs ?? Date.now();
    return this.identityStore.withDb((db) => {
      const res = db.prepare(`
        UPDATE execution_targets
        SET repository_full_name = ?, updated_at_ms = ?
        WHERE repository_provider = ?
          AND repository_external_id = ?;
      `).run(input.fullName, now, input.provider, input.externalId);
      return Number(res.changes);
    });
  }

  // ---------------------------------------------------------------------------
  // Device-Target Bindings
  // ---------------------------------------------------------------------------

  upsertDeviceTargetBinding(input: {
    deviceId: string;
    targetId: string;
    nowMs?: number;
  }): DeviceTargetBindingRecord {
    const now = input.nowMs ?? Date.now();
    return this.identityStore.withDb((db) => {
      const device = db.prepare("SELECT id, revoked_at_ms FROM devices WHERE id = ? LIMIT 1;").get(input.deviceId) as
        | { id: string; revoked_at_ms: number | null }
        | undefined;
      if (!device) {
        throw new ConnectorNotFoundError(`Device '${input.deviceId}' not found.`);
      }
      if (device.revoked_at_ms !== null) {
        throw new ConnectorValidationError(`Cannot bind revoked device '${input.deviceId}'.`);
      }

      const target = db.prepare("SELECT id, disabled_at_ms FROM execution_targets WHERE id = ? LIMIT 1;").get(input.targetId) as
        | { id: string; disabled_at_ms: number | null }
        | undefined;
      if (!target) {
        throw new ConnectorNotFoundError(`ExecutionTarget '${input.targetId}' not found.`);
      }
      if (target.disabled_at_ms !== null) {
        throw new ConnectorValidationError(`Cannot bind disabled target '${input.targetId}'.`);
      }

      const existing = db.prepare(`
        SELECT id, device_id, target_id, created_at_ms, updated_at_ms, disabled_at_ms
        FROM device_target_bindings
        WHERE device_id = ? AND target_id = ?
        LIMIT 1;
      `).get(input.deviceId, input.targetId) as DeviceTargetBindingRecord | undefined;

      if (existing) {
        if (existing.disabled_at_ms !== null) {
          db.prepare(`
            UPDATE device_target_bindings
            SET disabled_at_ms = NULL, updated_at_ms = ?
            WHERE id = ?;
          `).run(now, existing.id);
          return {
            ...existing,
            disabled_at_ms: null,
            updated_at_ms: now,
          };
        }
        return existing;
      }

      const id = newId("dtb");
      db.prepare(`
        INSERT INTO device_target_bindings (id, device_id, target_id, created_at_ms, updated_at_ms, disabled_at_ms)
        VALUES (?, ?, ?, ?, ?, NULL);
      `).run(id, input.deviceId, input.targetId, now, now);

      return {
        id,
        device_id: input.deviceId,
        target_id: input.targetId,
        created_at_ms: now,
        updated_at_ms: now,
        disabled_at_ms: null,
      };
    });
  }

  disableDeviceTargetBinding(deviceId: string, targetId: string, disabledAtMs?: number): boolean {
    const now = disabledAtMs ?? Date.now();
    return this.identityStore.withDb((db) => {
      const res = db.prepare(`
        UPDATE device_target_bindings
        SET disabled_at_ms = ?, updated_at_ms = ?
        WHERE device_id = ? AND target_id = ? AND disabled_at_ms IS NULL;
      `).run(now, now, deviceId, targetId);
      return Number(res.changes) > 0;
    });
  }

  listBindingsForDevice(
    deviceId: string,
    options?: { includeDisabled?: boolean },
  ): DeviceTargetBindingRecord[] {
    return this.identityStore.withDb((db) => {
      const sql = options?.includeDisabled
        ? `SELECT id, device_id, target_id, created_at_ms, updated_at_ms, disabled_at_ms
           FROM device_target_bindings WHERE device_id = ? ORDER BY created_at_ms ASC;`
        : `SELECT id, device_id, target_id, created_at_ms, updated_at_ms, disabled_at_ms
           FROM device_target_bindings WHERE device_id = ? AND disabled_at_ms IS NULL ORDER BY created_at_ms ASC;`;
      return db.prepare(sql).all(deviceId) as unknown as DeviceTargetBindingRecord[];
    });
  }

  // ---------------------------------------------------------------------------
  // Eligibility Predicate
  // ---------------------------------------------------------------------------

  resolveEligibleBinding(deviceId: string, targetId: string): EligibleBindingResolution {
    return this.identityStore.withDb((db) => {
      const device = db.prepare(`
        SELECT id, user_id, display_name, platform, created_at_ms, updated_at_ms, revoked_at_ms
        FROM devices
        WHERE id = ?
        LIMIT 1;
      `).get(deviceId) as DeviceRecord | undefined;

      if (!device) {
        return { eligible: false, reason: "Device not found." };
      }
      if (device.revoked_at_ms !== null) {
        return { eligible: false, reason: "Device has been revoked." };
      }

      // Check device owner user is active (not disabled)
      const user = db.prepare("SELECT id, disabled_at FROM users WHERE id = ? LIMIT 1;").get(device.user_id) as
        | { id: string; disabled_at: number | null }
        | undefined;
      if (!user) {
        return { eligible: false, reason: "Device owner user not found." };
      }
      if (user.disabled_at !== null) {
        return { eligible: false, reason: "Device owner user is disabled." };
      }

      const target = db.prepare(`
        SELECT id, workspace_id, alias, display_name, kind,
               repository_provider, repository_external_id, repository_full_name,
               created_at_ms, updated_at_ms, disabled_at_ms
        FROM execution_targets
        WHERE id = ?
        LIMIT 1;
      `).get(targetId) as ExecutionTargetRecord | undefined;

      if (!target) {
        return { eligible: false, reason: "Execution target not found." };
      }
      if (target.disabled_at_ms !== null) {
        return { eligible: false, reason: "Execution target is disabled." };
      }

      const binding = db.prepare(`
        SELECT id, device_id, target_id, created_at_ms, updated_at_ms, disabled_at_ms
        FROM device_target_bindings
        WHERE device_id = ? AND target_id = ?
        LIMIT 1;
      `).get(deviceId, targetId) as DeviceTargetBindingRecord | undefined;

      if (!binding) {
        return { eligible: false, reason: "DeviceTargetBinding does not exist." };
      }
      if (binding.disabled_at_ms !== null) {
        return { eligible: false, reason: "DeviceTargetBinding is disabled." };
      }

      // Check active workspace membership for device's user
      const membership = db.prepare(`
        SELECT id FROM workspace_memberships
        WHERE workspace_id = ? AND user_id = ?
        LIMIT 1;
      `).get(target.workspace_id, device.user_id);

      if (!membership) {
        return { eligible: false, reason: "Device owner is not a member of the target workspace." };
      }

      return {
        eligible: true,
        binding,
        device,
        target,
      };
    });
  }

  listEligibleTargetIdsForDevice(deviceId: string): string[] {
    return this.identityStore.withDb((db) => {
      const rows = db.prepare(`
        SELECT dtb.target_id
        FROM device_target_bindings dtb
        JOIN devices d ON d.id = dtb.device_id
        JOIN users u ON u.id = d.user_id
        JOIN execution_targets et ON et.id = dtb.target_id
        JOIN workspace_memberships wm ON wm.workspace_id = et.workspace_id AND wm.user_id = d.user_id
        WHERE dtb.device_id = ?
          AND dtb.disabled_at_ms IS NULL
          AND d.revoked_at_ms IS NULL
          AND u.disabled_at IS NULL
          AND et.disabled_at_ms IS NULL
        ORDER BY dtb.created_at_ms ASC;
      `).all(deviceId) as Array<{ target_id: string }>;
      return rows.map((r) => r.target_id);
    });
  }

  registerExecutionTargetForDevice(input: {
    deviceId: string;
    workspaceId: string;
    alias: string;
    displayName: string;
    kind: string;
    repositorySource?: "workspace_repository" | null;
    nowMs?: number;
  }): {
    target: ExecutionTargetRecord;
    binding: DeviceTargetBindingRecord;
    targetCreated: boolean;
    bindingCreated: boolean;
    replayed: boolean;
  } {
    const normalizedAlias = normalizeTargetAlias(input.alias);
    const trimmedDisplayName = input.displayName.trim();
    if (trimmedDisplayName.length < 1 || trimmedDisplayName.length > 128) {
      throw new ConnectorValidationError("ExecutionTarget display_name must be between 1 and 128 characters.");
    }
    const trimmedKind = input.kind.trim();
    if (!V1_VALID_TARGET_KINDS.includes(trimmedKind as V1ExecutionTargetKind)) {
      throw new ConnectorValidationError(
        `ExecutionTarget kind '${trimmedKind}' is invalid for V1; must be one of: ${V1_VALID_TARGET_KINDS.join(", ")}.`,
      );
    }

    const now = input.nowMs ?? Date.now();

    return this.identityStore.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const device = db.prepare("SELECT id, user_id, revoked_at_ms FROM devices WHERE id = ? LIMIT 1;").get(input.deviceId) as
          | { id: string; user_id: string; revoked_at_ms: number | null }
          | undefined;
        if (!device) {
          throw new ConnectorNotFoundError(`Device '${input.deviceId}' not found.`);
        }
        if (device.revoked_at_ms !== null) {
          throw new ConnectorDeviceRevokedError(`Cannot register target for revoked device '${input.deviceId}'.`);
        }

        const user = db.prepare("SELECT id, disabled_at FROM users WHERE id = ? LIMIT 1;").get(device.user_id) as
          | { id: string; disabled_at: number | null }
          | undefined;
        if (!user || user.disabled_at !== null) {
          throw new ConnectorPermissionError(`Device owner user '${device.user_id}' is not active.`);
        }

        const ws = db.prepare("SELECT id FROM workspaces WHERE id = ? LIMIT 1;").get(input.workspaceId);
        if (!ws) {
          throw new ConnectorNotFoundError(`Workspace '${input.workspaceId}' not found.`);
        }

        const membership = db.prepare(
          "SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ? LIMIT 1;",
        ).get(input.workspaceId, device.user_id) as { role: string } | undefined;
        if (!membership) {
          throw new ConnectorPermissionError(`User '${device.user_id}' is not a member of workspace '${input.workspaceId}'.`);
        }

        let provider: string | null = null;
        let externalId: string | null = null;
        let fullName: string | null = null;

        if (input.repositorySource === "workspace_repository") {
          const repoBinding = db.prepare(
            "SELECT github_repository_id, full_name FROM github_repository_bindings WHERE workspace_id = ? LIMIT 1;",
          ).get(input.workspaceId) as { github_repository_id: string; full_name: string } | undefined;

          if (!repoBinding) {
            throw new ConnectorTargetRepositoryNotFoundError(
              `Workspace '${input.workspaceId}' has no GitHub repository binding.`,
            );
          }
          provider = "github";
          externalId = repoBinding.github_repository_id;
          fullName = repoBinding.full_name;
        }

        const existingTarget = db.prepare(`
          SELECT id, workspace_id, alias, display_name, kind,
                 repository_provider, repository_external_id, repository_full_name,
                 created_at_ms, updated_at_ms, disabled_at_ms
          FROM execution_targets
          WHERE workspace_id = ? AND alias = ?
          LIMIT 1;
        `).get(input.workspaceId, normalizedAlias) as ExecutionTargetRecord | undefined;

        if (!existingTarget) {
          if (membership.role !== "owner") {
            throw new ConnectorPermissionError("Only workspace owners can create execution targets.");
          }

          const targetId = newId("tgt");
          db.prepare(`
            INSERT INTO execution_targets (
              id, workspace_id, alias, display_name, kind,
              repository_provider, repository_external_id, repository_full_name,
              created_at_ms, updated_at_ms, disabled_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL);
          `).run(targetId, input.workspaceId, normalizedAlias, trimmedDisplayName, trimmedKind, provider, externalId, fullName, now, now);

          const target: ExecutionTargetRecord = {
            id: targetId,
            workspace_id: input.workspaceId,
            alias: normalizedAlias,
            display_name: trimmedDisplayName,
            kind: trimmedKind,
            repository_provider: provider,
            repository_external_id: externalId,
            repository_full_name: fullName,
            created_at_ms: now,
            updated_at_ms: now,
            disabled_at_ms: null,
          };

          const bindingId = newId("dtb");
          db.prepare(`
            INSERT INTO device_target_bindings (id, device_id, target_id, created_at_ms, updated_at_ms, disabled_at_ms)
            VALUES (?, ?, ?, ?, ?, NULL);
          `).run(bindingId, input.deviceId, targetId, now, now);

          const binding: DeviceTargetBindingRecord = {
            id: bindingId,
            device_id: input.deviceId,
            target_id: targetId,
            created_at_ms: now,
            updated_at_ms: now,
            disabled_at_ms: null,
          };

          db.exec("COMMIT;");
          return { target, binding, targetCreated: true, bindingCreated: true, replayed: false };
        }

        // Target exists
        if (existingTarget.disabled_at_ms !== null) {
          throw new ConnectorTargetDisabledError(`Execution target with alias '${normalizedAlias}' is disabled.`);
        }

        const kindMatches = existingTarget.kind === trimmedKind;
        const nameMatches = existingTarget.display_name === trimmedDisplayName;
        const providerMatches = (existingTarget.repository_provider ?? null) === provider;
        const externalIdMatches = (existingTarget.repository_external_id ?? null) === externalId;

        if (!kindMatches || !nameMatches || !providerMatches || !externalIdMatches) {
          throw new ConnectorTargetConflictError(
            `Execution target with alias '${normalizedAlias}' exists but metadata conflicts.`,
          );
        }

        let target = existingTarget;
        if (fullName !== null && existingTarget.repository_full_name !== fullName) {
          db.prepare(`
            UPDATE execution_targets
            SET repository_full_name = ?, updated_at_ms = ?
            WHERE id = ?;
          `).run(fullName, now, existingTarget.id);
          target = {
            ...existingTarget,
            repository_full_name: fullName,
            updated_at_ms: now,
          };
        }

        const existingBinding = db.prepare(`
          SELECT id, device_id, target_id, created_at_ms, updated_at_ms, disabled_at_ms
          FROM device_target_bindings
          WHERE device_id = ? AND target_id = ?
          LIMIT 1;
        `).get(input.deviceId, target.id) as DeviceTargetBindingRecord | undefined;

        let binding: DeviceTargetBindingRecord;
        let bindingCreated = false;
        let replayed = false;

        if (existingBinding) {
          if (existingBinding.disabled_at_ms !== null) {
            db.prepare(`
              UPDATE device_target_bindings
              SET disabled_at_ms = NULL, updated_at_ms = ?
              WHERE id = ?;
            `).run(now, existingBinding.id);
            binding = {
              ...existingBinding,
              disabled_at_ms: null,
              updated_at_ms: now,
            };
            bindingCreated = false;
            replayed = false;
          } else {
            binding = existingBinding;
            bindingCreated = false;
            replayed = true;
          }
        } else {
          const bindingId = newId("dtb");
          db.prepare(`
            INSERT INTO device_target_bindings (id, device_id, target_id, created_at_ms, updated_at_ms, disabled_at_ms)
            VALUES (?, ?, ?, ?, ?, NULL);
          `).run(bindingId, input.deviceId, target.id, now, now);
          binding = {
            id: bindingId,
            device_id: input.deviceId,
            target_id: target.id,
            created_at_ms: now,
            updated_at_ms: now,
            disabled_at_ms: null,
          };
          bindingCreated = true;
          replayed = false;
        }

        db.exec("COMMIT;");
        return { target, binding, targetCreated: false, bindingCreated, replayed };
      } catch (err) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // ignore
        }
        throw err;
      }
    });
  }

  bindTargetForDevice(input: {
    deviceId: string;
    targetId: string;
    nowMs?: number;
  }): { binding: DeviceTargetBindingRecord; replayed: boolean } {
    const now = input.nowMs ?? Date.now();
    return this.identityStore.withDb((db) => {
      const device = db.prepare("SELECT id, user_id, revoked_at_ms FROM devices WHERE id = ? LIMIT 1;").get(input.deviceId) as
        | { id: string; user_id: string; revoked_at_ms: number | null }
        | undefined;
      if (!device) {
        throw new ConnectorNotFoundError(`Device '${input.deviceId}' not found.`);
      }
      if (device.revoked_at_ms !== null) {
        throw new ConnectorDeviceRevokedError(`Cannot bind revoked device '${input.deviceId}'.`);
      }

      const user = db.prepare("SELECT id, disabled_at FROM users WHERE id = ? LIMIT 1;").get(device.user_id) as
        | { id: string; disabled_at: number | null }
        | undefined;
      if (!user || user.disabled_at !== null) {
        throw new ConnectorPermissionError(`Device owner user '${device.user_id}' is not active.`);
      }

      const target = db.prepare(`
        SELECT id, workspace_id, disabled_at_ms
        FROM execution_targets
        WHERE id = ?
        LIMIT 1;
      `).get(input.targetId) as { id: string; workspace_id: string; disabled_at_ms: number | null } | undefined;

      if (!target) {
        throw new ConnectorNotFoundError(`Execution target '${input.targetId}' not found.`);
      }

      const membership = db.prepare(
        "SELECT id FROM workspace_memberships WHERE workspace_id = ? AND user_id = ? LIMIT 1;",
      ).get(target.workspace_id, device.user_id);
      if (!membership) {
        throw new ConnectorNotFoundError(`Execution target '${input.targetId}' not found.`);
      }

      if (target.disabled_at_ms !== null) {
        throw new ConnectorTargetDisabledError(`Execution target '${input.targetId}' is disabled.`);
      }

      const existing = db.prepare(`
        SELECT id, device_id, target_id, created_at_ms, updated_at_ms, disabled_at_ms
        FROM device_target_bindings
        WHERE device_id = ? AND target_id = ?
        LIMIT 1;
      `).get(input.deviceId, input.targetId) as DeviceTargetBindingRecord | undefined;

      if (existing) {
        if (existing.disabled_at_ms !== null) {
          db.prepare(`
            UPDATE device_target_bindings
            SET disabled_at_ms = NULL, updated_at_ms = ?
            WHERE id = ?;
          `).run(now, existing.id);
          return {
            binding: {
              ...existing,
              disabled_at_ms: null,
              updated_at_ms: now,
            },
            replayed: false,
          };
        }
        return { binding: existing, replayed: true };
      }

      const id = newId("dtb");
      db.prepare(`
        INSERT INTO device_target_bindings (id, device_id, target_id, created_at_ms, updated_at_ms, disabled_at_ms)
        VALUES (?, ?, ?, ?, ?, NULL);
      `).run(id, input.deviceId, input.targetId, now, now);

      return {
        binding: {
          id,
          device_id: input.deviceId,
          target_id: input.targetId,
          created_at_ms: now,
          updated_at_ms: now,
          disabled_at_ms: null,
        },
        replayed: false,
      };
    });
  }

  unbindTargetForDevice(input: {
    deviceId: string;
    targetId: string;
    nowMs?: number;
  }): { ok: true } {
    const now = input.nowMs ?? Date.now();
    return this.identityStore.withDb((db) => {
      const device = db.prepare("SELECT id, user_id, revoked_at_ms FROM devices WHERE id = ? LIMIT 1;").get(input.deviceId) as
        | { id: string; user_id: string; revoked_at_ms: number | null }
        | undefined;
      if (!device) {
        throw new ConnectorNotFoundError(`Device '${input.deviceId}' not found.`);
      }
      if (device.revoked_at_ms !== null) {
        throw new ConnectorDeviceRevokedError(`Cannot unbind from revoked device '${input.deviceId}'.`);
      }

      const target = db.prepare(`
        SELECT id, workspace_id
        FROM execution_targets
        WHERE id = ?
        LIMIT 1;
      `).get(input.targetId) as { id: string; workspace_id: string } | undefined;

      if (!target) {
        throw new ConnectorNotFoundError(`Execution target '${input.targetId}' not found.`);
      }

      const membership = db.prepare(
        "SELECT id FROM workspace_memberships WHERE workspace_id = ? AND user_id = ? LIMIT 1;",
      ).get(target.workspace_id, device.user_id);
      if (!membership) {
        throw new ConnectorNotFoundError(`Execution target '${input.targetId}' not found.`);
      }

      db.prepare(`
        UPDATE device_target_bindings
        SET disabled_at_ms = ?, updated_at_ms = ?
        WHERE device_id = ? AND target_id = ? AND disabled_at_ms IS NULL;
      `).run(now, now, input.deviceId, input.targetId);

      return { ok: true };
    });
  }

  listTargetsVisibleToDevice(
    deviceId: string,
    options?: { workspaceId?: string },
  ): Array<{
    target: ExecutionTargetRecord;
    thisBinding: DeviceTargetBindingRecord | null;
    activeBindingCount: number;
  }> {
    return this.identityStore.withDb((db) => {
      const device = db.prepare("SELECT id, user_id, revoked_at_ms FROM devices WHERE id = ? LIMIT 1;").get(deviceId) as
        | { id: string; user_id: string; revoked_at_ms: number | null }
        | undefined;
      if (!device) {
        throw new ConnectorNotFoundError(`Device '${deviceId}' not found.`);
      }
      if (device.revoked_at_ms !== null) {
        throw new ConnectorDeviceRevokedError(`Device '${deviceId}' has been revoked.`);
      }

      const user = db.prepare("SELECT id, disabled_at FROM users WHERE id = ? LIMIT 1;").get(device.user_id) as
        | { id: string; disabled_at: number | null }
        | undefined;
      if (!user || user.disabled_at !== null) {
        throw new ConnectorPermissionError(`Device owner user '${device.user_id}' is not active.`);
      }

      const sql = options?.workspaceId
        ? `SELECT et.id, et.workspace_id, et.alias, et.display_name, et.kind,
                  et.repository_provider, et.repository_external_id, et.repository_full_name,
                  et.created_at_ms, et.updated_at_ms, et.disabled_at_ms
           FROM execution_targets et
           JOIN workspace_memberships wm ON wm.workspace_id = et.workspace_id AND wm.user_id = ?
           WHERE et.workspace_id = ?
           ORDER BY et.created_at_ms ASC;`
        : `SELECT et.id, et.workspace_id, et.alias, et.display_name, et.kind,
                  et.repository_provider, et.repository_external_id, et.repository_full_name,
                  et.created_at_ms, et.updated_at_ms, et.disabled_at_ms
           FROM execution_targets et
           JOIN workspace_memberships wm ON wm.workspace_id = et.workspace_id AND wm.user_id = ?
           ORDER BY et.created_at_ms ASC;`;

      const targets = (
        options?.workspaceId
          ? db.prepare(sql).all(device.user_id, options.workspaceId)
          : db.prepare(sql).all(device.user_id)
      ) as unknown as ExecutionTargetRecord[];

      const bindingStmt = db.prepare(`
        SELECT id, device_id, target_id, created_at_ms, updated_at_ms, disabled_at_ms
        FROM device_target_bindings
        WHERE device_id = ? AND target_id = ?
        LIMIT 1;
      `);

      const countStmt = db.prepare(`
        SELECT COUNT(*) as cnt
        FROM device_target_bindings dtb
        JOIN devices d ON d.id = dtb.device_id
        JOIN users u ON u.id = d.user_id
        JOIN workspace_memberships wm ON wm.workspace_id = ? AND wm.user_id = d.user_id
        WHERE dtb.target_id = ?
          AND dtb.disabled_at_ms IS NULL
          AND d.revoked_at_ms IS NULL
          AND u.disabled_at IS NULL;
      `);

      return targets.map((target) => {
        const thisBinding = (bindingStmt.get(deviceId, target.id) as DeviceTargetBindingRecord | undefined) ?? null;
        const countRow = countStmt.get(target.workspace_id, target.id) as { cnt: number } | undefined;
        return {
          target,
          thisBinding,
          activeBindingCount: countRow?.cnt ?? 0,
        };
      });
    });
  }

  listTargetsForUser(
    userId: string,
    options?: { workspaceId?: string },
  ): Array<{
    target: ExecutionTargetRecord;
    workspaceRole: string;
    activeBindingCount: number;
  }> {
    return this.identityStore.withDb((db) => {
      const user = db.prepare("SELECT id, disabled_at FROM users WHERE id = ? LIMIT 1;").get(userId) as
        | { id: string; disabled_at: number | null }
        | undefined;
      if (!user || user.disabled_at !== null) {
        throw new ConnectorPermissionError(`User '${userId}' is not active.`);
      }

      const sql = options?.workspaceId
        ? `SELECT et.id, et.workspace_id, et.alias, et.display_name, et.kind,
                  et.repository_provider, et.repository_external_id, et.repository_full_name,
                  et.created_at_ms, et.updated_at_ms, et.disabled_at_ms,
                  wm.role as workspace_role
           FROM execution_targets et
           JOIN workspace_memberships wm ON wm.workspace_id = et.workspace_id AND wm.user_id = ?
           WHERE et.workspace_id = ?
           ORDER BY et.created_at_ms ASC;`
        : `SELECT et.id, et.workspace_id, et.alias, et.display_name, et.kind,
                  et.repository_provider, et.repository_external_id, et.repository_full_name,
                  et.created_at_ms, et.updated_at_ms, et.disabled_at_ms,
                  wm.role as workspace_role
           FROM execution_targets et
           JOIN workspace_memberships wm ON wm.workspace_id = et.workspace_id AND wm.user_id = ?
           ORDER BY et.created_at_ms ASC;`;

      const rows = (
        options?.workspaceId
          ? db.prepare(sql).all(userId, options.workspaceId)
          : db.prepare(sql).all(userId)
      ) as unknown as Array<ExecutionTargetRecord & { workspace_role: string }>;

      const countStmt = db.prepare(`
        SELECT COUNT(*) as cnt
        FROM device_target_bindings dtb
        JOIN devices d ON d.id = dtb.device_id
        JOIN users u ON u.id = d.user_id
        JOIN workspace_memberships wm ON wm.workspace_id = ? AND wm.user_id = d.user_id
        WHERE dtb.target_id = ?
          AND dtb.disabled_at_ms IS NULL
          AND d.revoked_at_ms IS NULL
          AND u.disabled_at IS NULL;
      `);

      return rows.map((r) => {
        const { workspace_role, ...target } = r;
        const countRow = countStmt.get(target.workspace_id, target.id) as { cnt: number } | undefined;
        return {
          target,
          workspaceRole: workspace_role,
          activeBindingCount: countRow?.cnt ?? 0,
        };
      });
    });
  }
}
