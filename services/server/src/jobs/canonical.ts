import canonicalize from "canonicalize";
import { createHash } from "node:crypto";

/**
 * Computes RFC 8785 (JSON Canonicalization Scheme - JCS) SHA-256 digest.
 * Guaranteed to match the Rust serde_json_canonicalizer output.
 */
export function computeCanonicalSha256(payload: unknown): string {
  const canonicalJson = canonicalize(payload);
  if (typeof canonicalJson !== "string") {
    throw new Error("CANONICALIZATION_FAILED: payload could not be canonicalized");
  }
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

export const CEO_JOB_RESULT_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/**
 * Derives a deterministic RFC 4122 UUIDv5 from a string and namespace.
 */
export function deriveDeterministicUuid(
  name: string,
  namespace = CEO_JOB_RESULT_NAMESPACE,
): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const nameBytes = Buffer.from(name, "utf8");
  const hash = createHash("sha1").update(Buffer.concat([nsBytes, nameBytes])).digest();

  // Set version to 5 (0101)
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  // Set variant to RFC 4122 (10xx)
  hash[8] = (hash[8]! & 0x3f) | 0x80;

  const hex = hash.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

