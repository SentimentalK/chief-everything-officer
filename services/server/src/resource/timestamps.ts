import { CeoError } from "../errors.js";

/**
 * Strict ISO-8601 timestamp accepted by resource_search date bounds:
 *   YYYY-MM-DDTHH:mm:ssZ | YYYY-MM-DDTHH:mm:ss.SSSZ
 *   YYYY-MM-DDTHH:mm:ss±HH:mm | YYYY-MM-DDTHH:mm:ss.SSS±HH:mm
 *
 * Query-interface contract only: uppercase T/Z, timezone REQUIRED, no
 * whitespace, seconds always present, fractional seconds 1-3 digits.
 * Storage format is unchanged and no stored data is migrated.
 */
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;
// groups: 1 year, 2 month, 3 day, 4 hour, 5 minute, 6 second,
//         7 fractional (1-3 digits, optional),
//         8 offset sign (only for the ±HH:mm form), 9 offset hour, 10 offset minute

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

function fail(value: string, context: string | undefined, reason: string): never {
  const subject = context !== undefined ? `'${value}' (${context})` : `'${value}'`;
  throw new CeoError(
    "VALIDATION_FAILED",
    `Invalid timestamp ${subject}: ${reason}.`,
    context !== undefined ? { value, context } : { value },
  );
}

/**
 * Parses a strict ISO-8601 timestamp into epoch milliseconds.
 *
 * Throws CeoError VALIDATION_FAILED on malformed input. Components are
 * validated BEFORE any Date construction because the Date setters silently
 * normalize overflow (e.g. 2023-02-29 -> Mar 1). Years 0-99 are handled via
 * setUTCFullYear/setUTCHours rather than Date.UTC(y, ...) (which maps 0-99 to
 * 1900+y). The regex is length-guarded against a trailing newline, which the
 * regex `$` anchor would otherwise accept.
 *
 * @param value   Strict ISO-8601 string (see TIMESTAMP_RE).
 * @param context Optional human-readable label (field name, meta.md path) placed
 *                in the error message and details for diagnosis.
 */
export function parseResourceTimestamp(value: string, context?: string): number {
  if (typeof value !== "string") {
    throw new CeoError("VALIDATION_FAILED", `Invalid timestamp for ${context ?? "value"}: expected a string.`, {
      value,
      ...(context !== undefined ? { context } : {}),
    });
  }

  const g = TIMESTAMP_RE.exec(value);
  // JS `$` matches just before a trailing newline, so a bare ^...$ regex would
  // accept "...Z\n". Reject any input the regex did not consume fully.
  if (!g || g[0].length !== value.length) {
    return fail(
      value,
      context,
      "expected ISO-8601 with a required timezone — YYYY-MM-DDTHH:mm:ssZ, " +
        "YYYY-MM-DDTHH:mm:ss.SSSZ, YYYY-MM-DDTHH:mm:ss±HH:mm, or YYYY-MM-DDTHH:mm:ss.SSS±HH:mm",
    );
  }

  const year = Number(g[1]);
  const month = Number(g[2]);
  const day = Number(g[3]);
  const hour = Number(g[4]);
  const minute = Number(g[5]);
  const second = Number(g[6]);
  const frac = g[7]; // undefined | 1-3 digit fractional second
  const sign = g[8]; // undefined (Z) | "+" | "-"

  // Component validation BEFORE any Date construction.
  if (month < 1 || month > 12) fail(value, context, "month must be 01-12");
  const dim = daysInMonth(year, month);
  if (day < 1 || day > dim) {
    fail(
      value,
      context,
      `day ${String(day).padStart(2, "0")} is not valid for month ${String(month).padStart(2, "0")} in year ${String(year).padStart(4, "0")}`,
    );
  }
  if (hour > 23) fail(value, context, "hour must be 00-23");
  if (minute > 59) fail(value, context, "minute must be 00-59");
  if (second > 59) fail(value, context, "second must be 00-59 (leap second 60 is not accepted)");
  let offsetMs = 0;
  if (sign !== undefined) {
    const offHour = Number(g[9]);
    const offMin = Number(g[10]);
    if (offHour > 23) fail(value, context, "offset hour must be 00-23");
    if (offMin > 59) fail(value, context, "offset minute must be 00-59");
    offsetMs = (offHour * 60 + offMin) * 60000;
  }

  // Fractional seconds 1-3 digits: .1 == 100ms, .12 == 120ms, .123 == 123ms.
  let ms = 0;
  if (frac !== undefined) {
    ms = frac.length === 1 ? Number(frac) * 100 : frac.length === 2 ? Number(frac) * 10 : Number(frac);
  }

  // Build UTC components with object setters (correct for years 0-99, unlike
  // Date.UTC). Ranges already validated, so no overflow normalization occurs.
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, ms);
  let epochMs = utc.getTime();

  // Offset is sign-aware: "+HH:mm" means the wall clock is ahead of UTC =>
  // subtract; "-HH:mm" means behind => add. "Z" contributes nothing.
  if (sign === "+") epochMs -= offsetMs;
  else if (sign === "-") epochMs += offsetMs;

  return epochMs;
}
