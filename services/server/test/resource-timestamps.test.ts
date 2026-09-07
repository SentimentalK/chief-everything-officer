import { describe, expect, it } from "vitest";
import { parseResourceTimestamp } from "../src/resource/timestamps.js";

function expectValidationError(value: string, context?: string): void {
  expect(() => parseResourceTimestamp(value, context)).toThrowError(
    expect.objectContaining({ code: "VALIDATION_FAILED" }),
  );
}

describe("parseResourceTimestamp (strict ISO-8601)", () => {
  it("parses full-second Z and UTC forms to epoch milliseconds", () => {
    expect(parseResourceTimestamp("1970-01-01T00:00:00Z")).toBe(0);
    expect(parseResourceTimestamp("2024-01-01T00:00:00Z")).toBe(Date.UTC(2024, 0, 1));
    expect(parseResourceTimestamp("2024-06-15T12:30:45Z")).toBe(Date.UTC(2024, 5, 15, 12, 30, 45));
  });

  it("accepts fractional seconds with 1-3 digits (.1 == .100 == 100ms)", () => {
    expect(parseResourceTimestamp("2024-01-01T00:00:00.1Z")).toBe(Date.UTC(2024, 0, 1) + 100);
    expect(parseResourceTimestamp("2024-01-01T00:00:00.100Z")).toBe(Date.UTC(2024, 0, 1) + 100);
    expect(parseResourceTimestamp("2024-01-01T00:00:00.1Z")).toBe(
      parseResourceTimestamp("2024-01-01T00:00:00.100Z"),
    );
    expect(parseResourceTimestamp("2024-01-01T00:00:00.12Z")).toBe(Date.UTC(2024, 0, 1) + 120);
    expect(parseResourceTimestamp("2024-01-01T00:00:00.123Z")).toBe(Date.UTC(2024, 0, 1) + 123);
    expect(parseResourceTimestamp("2024-01-01T00:00:00.0Z")).toBe(Date.UTC(2024, 0, 1));
    expectValidationError("2024-01-01T00:00:00.0000Z"); // 4 fractional digits not accepted
  });

  it("treats identical instants expressed as Z / +HH:mm / -HH:mm equally", () => {
    const instant = Date.UTC(2024, 0, 1); // 2024-01-01T00:00:00Z
    expect(parseResourceTimestamp("2024-01-01T00:00:00Z")).toBe(instant);
    expect(parseResourceTimestamp("2024-01-01T01:00:00+01:00")).toBe(instant);
    expect(parseResourceTimestamp("2023-12-31T19:00:00-05:00")).toBe(instant);

    // Non-midnight, fractional, non-whole-hour offset:
    // 2024-06-15T12:30:45.500-03:30 == 2024-06-15T16:00:45.500Z
    expect(parseResourceTimestamp("2024-06-15T12:30:45.500-03:30")).toBe(
      Date.UTC(2024, 5, 15, 16, 0, 45, 500),
    );
  });

  it("accepts valid leap days and rejects invalid ones", () => {
    expect(parseResourceTimestamp("2024-02-29T00:00:00Z")).toBe(Date.UTC(2024, 1, 29));
    expect(parseResourceTimestamp("2000-02-29T00:00:00Z")).toBe(Date.UTC(2000, 1, 29));
    expectValidationError("2023-02-29T00:00:00Z");
    expectValidationError("1900-02-29T00:00:00Z"); // divisible by 100, not 400
  });

  it("rejects invalid month/day/hour/minute/second/offset components", () => {
    expectValidationError("2024-13-01T00:00:00Z"); // month 13
    expectValidationError("2024-00-01T00:00:00Z"); // month 00
    expectValidationError("2024-04-31T00:00:00Z"); // April has 30 days
    expectValidationError("2024-02-30T00:00:00Z"); // Feb has 28 days in 2024
    expectValidationError("2024-01-01T24:00:00Z"); // hour 24
    expectValidationError("2024-01-01T23:59:60Z"); // leap second not accepted
    expectValidationError("2024-01-01T23:60:00Z"); // minute 60
    expectValidationError("2024-01-01T00:00:00+24:00"); // offset hour 24
    expectValidationError("2024-01-01T00:00:00+23:60"); // offset minute 60
  });

  it("requires a timezone and rejects lowercase, whitespace, and truncated forms", () => {
    expectValidationError("2024-01-01T00:00:00"); // no timezone
    expectValidationError("2024-01-01t00:00:00z"); // lowercase t/z
    expectValidationError("2024-01-01 00:00:00Z"); // space instead of T
    expectValidationError("2024-01-01T00:00:00 Z"); // space before Z
    expectValidationError(" 2024-01-01T00:00:00Z"); // leading whitespace
    expectValidationError("2024-01-01T00:00:00Z "); // trailing whitespace
    expectValidationError("2024-01-01T00:00Z"); // missing seconds
    expectValidationError("2024-01-01T00:00:0Z"); // single-digit second
    expectValidationError("2024-01-01T00:00:00"); // no TZ at all
    expectValidationError("2024-01-01T00:00:00ZZ"); // doubled Z
  });

  it("rejects trailing newlines that a bare ^...$ regex would accept", () => {
    // JS $ matches just before a final newline; the length guard must reject.
    expectValidationError("2024-01-01T00:00:00Z\n");
    expectValidationError("2024-01-01T00:00:00Z\r\n");
    expectValidationError("2024-01-01T00:00:00.123+01:00\n");
    expectValidationError("2024-01-01T00:00:00Z\n\n");
  });

  it("handles years 0-99 without the Date.UTC 1900 mapping", () => {
    const ms = parseResourceTimestamp("0099-01-01T00:00:00Z");
    expect(new Date(ms).getUTCFullYear()).toBe(99);
    expect(ms).toBe(-59042995200000);
    // Date.UTC(99, ...) would map to year 1999; make sure we did not use it.
    expect(ms).not.toBe(Date.UTC(99, 0, 1));
    // Leading zeros required: an unpadded year is malformed.
    expectValidationError("99-01-01T00:00:00Z");
  });

  it("includes the context label in the error message and details", () => {
    try {
      parseResourceTimestamp("not-a-timestamp", "captured_from");
      expect.unreachable("expected a throw");
    } catch (err) {
      const e = err as { code: string; message: string; details: Record<string, unknown> };
      expect(e.code).toBe("VALIDATION_FAILED");
      expect(e.message).toContain("captured_from");
      expect(e.message).toContain("not-a-timestamp");
      expect(e.details.value).toBe("not-a-timestamp");
      expect(e.details.context).toBe("captured_from");
    }
  });
});
