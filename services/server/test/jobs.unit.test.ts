import { describe, expect, it } from "vitest";
import {
  parseSubmit,
  parseJobGet,
  businessDigest,
  CLAIM_TTL_MS,
  DEFAULT_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  unknownFieldCheck,
} from "../src/jobs/schema.js";

const uuid = "123e4567-e89b-12d3-a456-426614174000";
const wsRef = "tools";

function valid(patch: Record<string, unknown> = {}) {
  return {
    request_id: uuid,
    workspace_ref: wsRef,
    prompt: "process the url and return the subtitles",
    acceptance: "non-empty subtitles returned or a reason",
    ...patch,
  };
}

describe("worker submit schema", () => {
  it("defaults timeout to 1800 and treats absent resource_id as null", () => {
    const r = parseSubmit(valid());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.execution_timeout_seconds).toBe(DEFAULT_TIMEOUT_SECONDS);
    expect(r.value.resource_id).toBeNull();
  });

  it("rejects unknown fields (e.g. forged identity)", () => {
    const r = parseSubmit({ ...valid(), user_id: "usr_x", workspace_id: "ws_y" });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toBe("INVALID_INPUT");
  });

  it("rejects a non-UUID request_id", () => {
    const r = parseSubmit(valid({ request_id: "not-a-uuid" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issue).toMatch(/UUID/);
  });

  it("rejects whitespace-only prompt / acceptance", () => {
    expect(parseSubmit(valid({ prompt: "   " })).ok).toBe(false);
    expect(parseSubmit(valid({ acceptance: " \n " })).ok).toBe(false);
  });

  it("rejects out-of-range timeout (no clamping)", () => {
    expect(parseSubmit(valid({ timeout_seconds: MIN_TIMEOUT_SECONDS - 1 })).ok).toBe(false);
    expect(parseSubmit(valid({ timeout_seconds: MAX_TIMEOUT_SECONDS + 1 })).ok).toBe(false);
    expect(parseSubmit(valid({ timeout_seconds: MAX_TIMEOUT_SECONDS })).ok).toBe(true);
    expect(parseSubmit(valid({ timeout_seconds: MIN_TIMEOUT_SECONDS })).ok).toBe(true);
  });

  it("rejects oversized prompt (UTF-8 bytes > 64KiB) and acceptance > 8KiB", () => {
    expect(parseSubmit(valid({ prompt: "a".repeat(64 * 1024 + 1) })).ok).toBe(false);
    expect(parseSubmit(valid({ acceptance: "b".repeat(8 * 1024 + 1) })).ok).toBe(false);
  });

  it("rejects a malformed resource_id and float timeout", () => {
    expect(parseSubmit(valid({ resource_id: "res-nope" })).ok).toBe(false);
    expect(parseSubmit(valid({ timeout_seconds: 900.5 })).ok).toBe(false);
  });
});

describe("worker get schema", () => {
  it("accepts a job-<uuid>", () => {
    const r = parseJobGet({ job_id: `job-${uuid}` });
    expect(r.ok).toBe(true);
  });
  it("rejects obvious bad shape / unknown fields", () => {
    expect(parseJobGet({ job_id: "nope" }).ok).toBe(false);
    expect(parseJobGet({ job_id: `job-${uuid}`, extra: 1 }).ok).toBe(false);
  });
});

describe("business digest", () => {
  const base = {
    workspace_ref: "tools",
    prompt: "translate next",
    acceptance: "> 0 lines",
    resource_id: null as string | null,
    execution_timeout_seconds: 120,
  };
  it("is stable across key-authoring order and excludes request_id/server-time concepts", () => {
    const a = businessDigest({ ...base });
    const b = businessDigest({
      acceptance: base.acceptance,
      execution_timeout_seconds: base.execution_timeout_seconds,
      prompt: base.prompt,
      resource_id: base.resource_id,
      workspace_ref: base.workspace_ref,
    });
    expect(a).toBe(b);
  });
  it("changes when a business field changes", () => {
    expect(businessDigest({ ...base, prompt: "different task" })).not.toBe(businessDigest(base));
  });
});

describe("constants", () => {
  it("keeps a 7-day claim deadline (not a delete TTL) and known timeout bounds", () => {
    void CLAIM_TTL_MS;
    expect(CLAIM_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(MIN_TIMEOUT_SECONDS).toBe(60);
    expect(MAX_TIMEOUT_SECONDS).toBe(7200);
  });
});

describe("unknown field helper", () => {
  it("surfaces unexpected keys", () => {
    expect(unknownFieldCheck({ a: 1, b: 2 }, ["a"])).toEqual(["b"]);
    expect(unknownFieldCheck({ a: 1 }, ["a"])).toEqual([]);
  });
});
