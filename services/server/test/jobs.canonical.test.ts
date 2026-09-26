import { describe, it, expect } from "vitest";
import { computeCanonicalSha256 } from "../src/jobs/canonical.js";

describe("Cross-Language RFC 8785 Canonical Digest (JCS)", () => {
  it("computes exact SHA-256 matching Rust serde_json_canonicalizer for ManagedResultEnvelope", () => {
    // Note: intentionally disordered keys to verify canonicalization
    const payloadDisordered = {
      summary: "Update resource title and content",
      schema_version: 1,
      operations: [
        {
          content: "New resolved body",
          op: "upsert_content",
        },
        {
          display_name: "New Resource Title",
          op: "rename",
        },
      ],
      resource_id: "res-33333333-3333-3333-3333-333333333333",
      attempt_id: "att_22222222-2222-2222-2222-222222222222",
      job_id: "job-11111111-1111-1111-1111-111111111111",
    };

    const digest = computeCanonicalSha256(payloadDisordered);

    // EXACT expected hash from Rust serde_json_canonicalizer in managed_result.rs
    expect(digest).toBe("404a4afe34a4729475ffae07d577d195ca36374eba39ee2e271a9b72b2a41685");
  });
});
