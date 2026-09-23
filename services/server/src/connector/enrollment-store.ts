import crypto from "node:crypto";
import { newId } from "../identity/store.js";

export const CROCKFORD_BASE32_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const USER_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export const MAX_ACTIVE_ENROLLMENTS = 1024;
export const DEVICE_ENROLLMENT_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const DEVICE_CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 365 days
export const POLL_INTERVAL_MS = 2000; // 2 seconds

export type DeviceEnrollmentState = "pending" | "approved" | "denied" | "consumed";

export interface DeviceEnrollment {
  enrollment_id: string;
  device_code_digest: string;
  user_code: string;
  reserved_device_id: string;
  reserved_credential_id: string;
  display_name: string;
  platform: string;
  credential_secret_digest: string;
  state: DeviceEnrollmentState;
  approved_user_id?: string;
  consent_nonce_digest?: string;
  created_at_ms: number;
  expires_at_ms: number;
  approved_at_ms?: number;
  consumed_at_ms?: number;
  last_poll_at_ms?: number;
}

export class DeviceEnrollmentError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "DeviceEnrollmentError";
  }
}

export class DeviceEnrollmentCapacityError extends DeviceEnrollmentError {
  constructor(message = "Enrollment capacity exceeded; try again later.") {
    super(message, "CAPACITY_EXCEEDED");
  }
}

export class DeviceEnrollmentValidationError extends DeviceEnrollmentError {
  constructor(message: string) {
    super(message, "INVALID_INPUT");
  }
}

/**
 * Normalizes and validates user code against Crockford base32 alphabet (XXXX-XXXX).
 * Accepts lowercase or missing hyphens if 8 characters.
 */
export function normalizeDeviceUserCode(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new DeviceEnrollmentValidationError("user_code must be a string.");
  }
  let s = raw.trim().toUpperCase();
  if (s.length === 8 && !s.includes("-")) {
    s = `${s.slice(0, 4)}-${s.slice(4)}`;
  }
  if (!USER_CODE_RE.test(s)) {
    throw new DeviceEnrollmentValidationError(
      `Invalid user_code '${raw}'; must match format XXXX-XXXX using alphabet ${CROCKFORD_BASE32_ALPHABET}.`,
    );
  }
  return s;
}

export function generateUserCode(): string {
  const bytes = crypto.randomBytes(8);
  let res = "";
  for (let i = 0; i < 8; i++) {
    res += CROCKFORD_BASE32_ALPHABET[bytes[i]! % CROCKFORD_BASE32_ALPHABET.length];
    if (i === 3) res += "-";
  }
  return res;
}

export function generateDeviceCode(): { code: string; digest: string } {
  const code = crypto.randomBytes(32).toString("base64url");
  const digest = crypto.createHash("sha256").update(code, "utf8").digest("hex");
  return { code, digest };
}

export class DeviceEnrollmentStore {
  private readonly enrollments = new Map<string, DeviceEnrollment>();
  private readonly userCodeIndex = new Map<string, string>();
  private readonly deviceCodeDigestIndex = new Map<string, string>();

  constructor(
    private readonly maxActive: number = MAX_ACTIVE_ENROLLMENTS,
    private readonly defaultTtlMs: number = DEVICE_ENROLLMENT_TTL_MS,
  ) {}

  purgeExpired(nowMs?: number): number {
    const now = nowMs ?? Date.now();
    let purged = 0;
    for (const [id, enr] of this.enrollments.entries()) {
      if (now > enr.expires_at_ms) {
        this.enrollments.delete(id);
        this.userCodeIndex.delete(enr.user_code);
        this.deviceCodeDigestIndex.delete(enr.device_code_digest);
        purged++;
      }
    }
    return purged;
  }

  createEnrollment(input: {
    displayName: string;
    platform: string;
    credentialSecretDigest: string;
    nowMs?: number;
    ttlMs?: number;
  }): {
    enrollment: DeviceEnrollment;
    deviceCode: string;
    userCode: string;
  } {
    const trimmedName = input.displayName.trim();
    if (trimmedName.length === 0 || trimmedName.length > 128) {
      throw new DeviceEnrollmentValidationError("display_name must be between 1 and 128 characters.");
    }

    const trimmedPlatform = input.platform.trim().toLowerCase();
    const validPlatforms = ["linux", "windows", "macos"];
    if (!validPlatforms.includes(trimmedPlatform)) {
      throw new DeviceEnrollmentValidationError(
        `platform must be one of: ${validPlatforms.join(", ")}.`,
      );
    }

    if (!SHA256_HEX_RE.test(input.credentialSecretDigest)) {
      throw new DeviceEnrollmentValidationError(
        "credential_secret_sha256 must be exactly 64 lowercase hex characters.",
      );
    }

    const now = input.nowMs ?? Date.now();
    this.purgeExpired(now);

    if (this.enrollments.size >= this.maxActive) {
      throw new DeviceEnrollmentCapacityError();
    }

    // Generate unique user code
    let userCode = generateUserCode();
    while (this.userCodeIndex.has(userCode)) {
      userCode = generateUserCode();
    }

    const { code: deviceCode, digest: deviceCodeDigest } = generateDeviceCode();

    const enrollmentId = `enr_${crypto.randomUUID()}`;
    const reservedDeviceId = newId("dev");
    const reservedCredentialId = newId("dcr");
    const ttl = input.ttlMs ?? this.defaultTtlMs;
    const expiresAt = now + ttl;

    const enrollment: DeviceEnrollment = {
      enrollment_id: enrollmentId,
      device_code_digest: deviceCodeDigest,
      user_code: userCode,
      reserved_device_id: reservedDeviceId,
      reserved_credential_id: reservedCredentialId,
      display_name: trimmedName,
      platform: trimmedPlatform,
      credential_secret_digest: input.credentialSecretDigest,
      state: "pending",
      created_at_ms: now,
      expires_at_ms: expiresAt,
    };

    this.enrollments.set(enrollmentId, enrollment);
    this.userCodeIndex.set(userCode, enrollmentId);
    this.deviceCodeDigestIndex.set(deviceCodeDigest, enrollmentId);

    return {
      enrollment,
      deviceCode,
      userCode,
    };
  }

  findByUserCode(userCode: string, nowMs?: number): DeviceEnrollment | null {
    const normalized = normalizeDeviceUserCode(userCode);
    const id = this.userCodeIndex.get(normalized);
    if (!id) return null;
    const enr = this.enrollments.get(id);
    if (!enr) return null;
    const now = nowMs ?? Date.now();
    if (now > enr.expires_at_ms) {
      return null;
    }
    return enr;
  }

  findByDeviceCodeDigest(digest: string, nowMs?: number): DeviceEnrollment | null {
    const id = this.deviceCodeDigestIndex.get(digest);
    if (!id) return null;
    const enr = this.enrollments.get(id);
    if (!enr) return null;
    const now = nowMs ?? Date.now();
    if (now > enr.expires_at_ms) {
      return null;
    }
    return enr;
  }

  getEnrollment(enrollmentId: string): DeviceEnrollment | null {
    return this.enrollments.get(enrollmentId) ?? null;
  }

  setConsentNonce(enrollmentId: string, nonceDigest: string): boolean {
    const enr = this.enrollments.get(enrollmentId);
    if (!enr) return false;
    enr.consent_nonce_digest = nonceDigest;
    return true;
  }

  approve(enrollmentId: string, userId: string, nowMs?: number): boolean {
    const enr = this.enrollments.get(enrollmentId);
    if (!enr || enr.state !== "pending") return false;
    const now = nowMs ?? Date.now();
    if (now > enr.expires_at_ms) return false;

    enr.state = "approved";
    enr.approved_user_id = userId;
    enr.approved_at_ms = now;
    return true;
  }

  deny(enrollmentId: string): boolean {
    const enr = this.enrollments.get(enrollmentId);
    if (!enr || enr.state !== "pending") return false;
    enr.state = "denied";
    return true;
  }

  markConsumed(enrollmentId: string, nowMs?: number): boolean {
    const enr = this.enrollments.get(enrollmentId);
    if (!enr) return false;
    enr.state = "consumed";
    enr.consumed_at_ms = nowMs ?? Date.now();
    return true;
  }

  checkAndRecordPoll(enrollmentId: string, nowMs?: number): { slowDown: boolean } {
    const enr = this.enrollments.get(enrollmentId);
    if (!enr) return { slowDown: false };
    const now = nowMs ?? Date.now();

    if (enr.last_poll_at_ms && now - enr.last_poll_at_ms < POLL_INTERVAL_MS) {
      enr.last_poll_at_ms = now;
      return { slowDown: true };
    }
    enr.last_poll_at_ms = now;
    return { slowDown: false };
  }

  size(): number {
    return this.enrollments.size;
  }

  clear(): void {
    this.enrollments.clear();
    this.userCodeIndex.clear();
    this.deviceCodeDigestIndex.clear();
  }
}
