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
}
