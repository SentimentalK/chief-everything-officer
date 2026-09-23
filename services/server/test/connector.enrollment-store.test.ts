import { describe, it, expect, beforeEach } from "vitest";
import {
  DeviceEnrollmentStore,
  normalizeDeviceUserCode,
  DeviceEnrollmentCapacityError,
  DeviceEnrollmentValidationError,
  MAX_ACTIVE_ENROLLMENTS,
} from "../src/connector/enrollment-store.js";

describe("DeviceEnrollmentStore - normalizeDeviceUserCode", () => {
  it("accepts valid Crockford base32 user codes in standard format", () => {
    expect(normalizeDeviceUserCode("2345-6789")).toBe("2345-6789");
    expect(normalizeDeviceUserCode("ABCD-EFGH")).toBe("ABCD-EFGH");
    expect(normalizeDeviceUserCode("JKMN-PQRS")).toBe("JKMN-PQRS");
    expect(normalizeDeviceUserCode("TVWX-YZ23")).toBe("TVWX-YZ23");
  });

  it("normalizes lowercase and removes hyphen when needed", () => {
    expect(normalizeDeviceUserCode("abcd-efgh")).toBe("ABCD-EFGH");
    expect(normalizeDeviceUserCode("abcdefgh")).toBe("ABCD-EFGH");
    expect(normalizeDeviceUserCode("  abcd-efgh  ")).toBe("ABCD-EFGH");
  });

  it("rejects non-strings and malformed formats", () => {
    expect(() => normalizeDeviceUserCode(null)).toThrow(DeviceEnrollmentValidationError);
    expect(() => normalizeDeviceUserCode(12345)).toThrow(DeviceEnrollmentValidationError);
    expect(() => normalizeDeviceUserCode("")).toThrow(DeviceEnrollmentValidationError);
    expect(() => normalizeDeviceUserCode("ABC-DEF")).toThrow(DeviceEnrollmentValidationError);
    expect(() => normalizeDeviceUserCode("ABCDEFGHI")).toThrow(DeviceEnrollmentValidationError);
  });

  it("rejects forbidden non-Crockford characters (0, 1, I, O, L)", () => {
    // 0, 1, I, O, L are explicitly excluded in Crockford alphabet to prevent visual confusion
    expect(() => normalizeDeviceUserCode("ABCD-0FGH")).toThrow(DeviceEnrollmentValidationError);
    expect(() => normalizeDeviceUserCode("ABCD-1FGH")).toThrow(DeviceEnrollmentValidationError);
    expect(() => normalizeDeviceUserCode("ABCD-IFGH")).toThrow(DeviceEnrollmentValidationError);
    expect(() => normalizeDeviceUserCode("ABCD-OFGH")).toThrow(DeviceEnrollmentValidationError);
    expect(() => normalizeDeviceUserCode("ABCD-LFGH")).toThrow(DeviceEnrollmentValidationError);
  });
});

describe("DeviceEnrollmentStore - lifecycle & operations", () => {
  let store: DeviceEnrollmentStore;
  const dummyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  beforeEach(() => {
    store = new DeviceEnrollmentStore();
  });

  it("creates enrollment with reserved IDs, device code, and user code", () => {
    const { enrollment, deviceCode, userCode } = store.createEnrollment({
      displayName: "My Linux PC",
      platform: "linux",
      credentialSecretDigest: dummyDigest,
    });

    expect(enrollment.state).toBe("pending");
    expect(enrollment.display_name).toBe("My Linux PC");
    expect(enrollment.platform).toBe("linux");
    expect(enrollment.reserved_device_id).toMatch(/^dev_[0-9a-f-]{36}$/);
    expect(enrollment.reserved_credential_id).toMatch(/^dcr_[0-9a-f-]{36}$/);
    expect(userCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
    expect(deviceCode.length).toBeGreaterThanOrEqual(43);

    // Retrieve by user code
    const byUserCode = store.findByUserCode(userCode);
    expect(byUserCode?.enrollment_id).toBe(enrollment.enrollment_id);

    // Retrieve by device code digest
    const found = store.findByDeviceCodeDigest(enrollment.device_code_digest);
    expect(found?.enrollment_id).toBe(enrollment.enrollment_id);
  });

  it("manages consent nonce challenge", () => {
    const { enrollment } = store.createEnrollment({
      displayName: "PC",
      platform: "linux",
      credentialSecretDigest: dummyDigest,
    });

    const nonceDigest = "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234";
    store.setConsentNonce(enrollment.enrollment_id, nonceDigest);

    const fetched = store.findByUserCode(enrollment.user_code);
    expect(fetched?.consent_nonce_digest).toBe(nonceDigest);
  });

  it("handles state transitions: approve and markConsumed", () => {
    const { enrollment } = store.createEnrollment({
      displayName: "PC",
      platform: "linux",
      credentialSecretDigest: dummyDigest,
    });

    store.approve(enrollment.enrollment_id, "usr_bob");
    const approved = store.findByUserCode(enrollment.user_code);
    expect(approved?.state).toBe("approved");
    expect(approved?.approved_user_id).toBe("usr_bob");

    // Cannot approve again
    expect(store.approve(enrollment.enrollment_id, "usr_charlie")).toBe(false);

    store.markConsumed(enrollment.enrollment_id);
    const consumed = store.findByUserCode(enrollment.user_code);
    expect(consumed?.state).toBe("consumed");
  });

  it("handles state transitions: deny", () => {
    const { enrollment } = store.createEnrollment({
      displayName: "PC",
      platform: "linux",
      credentialSecretDigest: dummyDigest,
    });

    store.deny(enrollment.enrollment_id);
    const denied = store.findByUserCode(enrollment.user_code);
    expect(denied?.state).toBe("denied");

    expect(store.approve(enrollment.enrollment_id, "usr_bob")).toBe(false);
  });

  it("enforces 2-second rate limit on polling", () => {
    const { enrollment } = store.createEnrollment({
      displayName: "PC",
      platform: "linux",
      credentialSecretDigest: dummyDigest,
    });

    const now = 1000000;
    // First poll -> allowed
    const poll1 = store.checkAndRecordPoll(enrollment.enrollment_id, now);
    expect(poll1.slowDown).toBe(false);

    // Immediate second poll (1s later) -> slowDown
    const poll2 = store.checkAndRecordPoll(enrollment.enrollment_id, now + 1000);
    expect(poll2.slowDown).toBe(true);

    // Poll 2.5s after poll2 -> allowed
    const poll3 = store.checkAndRecordPoll(enrollment.enrollment_id, now + 1000 + 2500);
    expect(poll3.slowDown).toBe(false);
  });

  it("purges expired enrollments and enforces max active capacity", () => {
    const now = 1000000;
    // Create capacity entries
    for (let i = 0; i < MAX_ACTIVE_ENROLLMENTS; i++) {
      store.createEnrollment({
        displayName: `Device ${i}`,
        platform: "linux",
        credentialSecretDigest: dummyDigest,
        nowMs: now,
      });
    }

    // Exceed capacity when none expired -> throws capacity error
    expect(() =>
      store.createEnrollment({
        displayName: "One too many",
        platform: "linux",
        credentialSecretDigest: dummyDigest,
        nowMs: now,
      }),
    ).toThrow(DeviceEnrollmentCapacityError);

    // Advance time past TTL (10 minutes = 600,000 ms)
    const futureTime = now + 600001;
    // Now creating an enrollment purges expired ones and succeeds
    const created = store.createEnrollment({
      displayName: "Fresh device",
      platform: "linux",
      credentialSecretDigest: dummyDigest,
      nowMs: futureTime,
    });
    expect(created.enrollment.display_name).toBe("Fresh device");
  });
});
