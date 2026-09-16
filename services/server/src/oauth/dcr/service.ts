import crypto from "node:crypto";
import type { ClientMetadata } from "../client-metadata.js";
import {
  OAuthClientResolutionError,
  type OAuthClientResolver,
  isDcrClientId,
} from "../client-resolver.js";
import {
  DcrStore,
  DcrStoreConflictError,
  DcrStoreUnavailable,
} from "./store.js";

export class DcrRegistrationError extends Error {
  constructor(
    public readonly errorCode:
      | "invalid_redirect_uri"
      | "invalid_client_metadata"
      | "invalid_software_statement"
      | "server_error",
    public readonly errorDescription: string,
    public readonly statusCode: number = 400,
  ) {
    super(errorDescription);
    this.name = "DcrRegistrationError";
  }
}

export interface DcrRegistrationResponse {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  application_type?: "native" | "web";
  scope?: string;
}

interface NormalizedDcrMetadata {
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  application_type?: "native" | "web";
  scope?: string;
}

const DEFAULT_CLIENT_NAME = "Dynamic MCP Client";
const MAX_CLIENT_NAME_CHARS = 200;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_CHARS = 2048;
const INSERT_ATTEMPTS = 3;

const UNSUPPORTED_FIELDS = new Set([
  "client_secret",
  "client_id",
  "jwks",
  "jwks_uri",
  "request_uris",
  "sector_identifier_uri",
]);

const ALLOWED_SCOPES = new Set(["mcp", "offline_access"]);

// RFC 7591 default when grant_types is omitted.
const RFC_DEFAULT_GRANT_TYPES = ["authorization_code"];
// RFC 7591 default when response_types is omitted.
const RFC_DEFAULT_RESPONSE_TYPES = ["code"];

function unicodeLength(value: string): number {
  return [...value].length;
}

function generateDcrClientId(): string {
  return `dcr_${crypto.randomBytes(32).toString("base64url")}`;
}

function isLoopbackHttpHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function validateRedirectUri(uri: string): void {
  if (uri.length > MAX_REDIRECT_URI_CHARS) {
    throw new DcrRegistrationError(
      "invalid_redirect_uri",
      `Each redirect_uri must be at most ${MAX_REDIRECT_URI_CHARS} characters`,
    );
  }
  if (uri.includes("*")) {
    throw new DcrRegistrationError("invalid_redirect_uri", "redirect_uris must not contain wildcards");
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new DcrRegistrationError("invalid_redirect_uri", `Invalid redirect_uri: ${uri}`);
  }

  if (parsed.hash) {
    throw new DcrRegistrationError("invalid_redirect_uri", "redirect_uris must not contain fragments");
  }

  if (parsed.protocol === "https:") {
    return;
  }

  if (parsed.protocol === "http:" && isLoopbackHttpHostname(parsed.hostname)) {
    return;
  }

  if (parsed.protocol === "http:") {
    throw new DcrRegistrationError(
      "invalid_redirect_uri",
      "Plaintext HTTP redirect_uris are only allowed for loopback hosts",
    );
  }

  throw new DcrRegistrationError(
    "invalid_redirect_uri",
    "Custom URI schemes are not supported by this registration endpoint",
  );
}

function sameStringSet(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const remaining = new Map<string, number>();
  for (const value of expected) {
    remaining.set(value, (remaining.get(value) ?? 0) + 1);
  }
  for (const value of actual) {
    const count = remaining.get(value);
    if (!count) return false;
    if (count === 1) remaining.delete(value);
    else remaining.set(value, count - 1);
  }
  return remaining.size === 0;
}

function normalizeGrantTypes(raw: unknown): string[] {
  if (raw === undefined) {
    return [...RFC_DEFAULT_GRANT_TYPES];
  }
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new DcrRegistrationError("invalid_client_metadata", "grant_types must be an array of strings");
  }
  const unique = [...new Set(raw)];
  const authCodeOnly = ["authorization_code"];
  const authCodeAndRefresh = ["authorization_code", "refresh_token"];
  if (sameStringSet(unique, authCodeOnly)) return authCodeOnly;
  if (sameStringSet(unique, authCodeAndRefresh)) return authCodeAndRefresh;
  throw new DcrRegistrationError(
    "invalid_client_metadata",
    "grant_types must be [\"authorization_code\"] or [\"authorization_code\", \"refresh_token\"]",
  );
}

function normalizeResponseTypes(raw: unknown): string[] {
  if (raw === undefined) {
    return [...RFC_DEFAULT_RESPONSE_TYPES];
  }
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new DcrRegistrationError("invalid_client_metadata", "response_types must be an array of strings");
  }
  const unique = [...new Set(raw)];
  if (sameStringSet(unique, ["code"])) return ["code"];
  throw new DcrRegistrationError("invalid_client_metadata", "Only response_types [\"code\"] is supported");
}

function normalizeAuthMethod(raw: unknown): "none" {
  // CEO public-client profile override: RFC 7591 defaults omitted
  // token_endpoint_auth_method to client_secret_basic. CEO does not adopt that
  // default because this endpoint only registers public PKCE clients.
  if (raw === undefined || raw === "none") {
    return "none";
  }
  if (typeof raw !== "string") {
    throw new DcrRegistrationError(
      "invalid_client_metadata",
      "token_endpoint_auth_method must be a string",
    );
  }
  throw new DcrRegistrationError(
    "invalid_client_metadata",
    `Unsupported token_endpoint_auth_method: ${raw}`,
  );
}

function normalizeClientName(raw: unknown): string {
  if (raw === undefined || raw === "") {
    return DEFAULT_CLIENT_NAME;
  }
  if (typeof raw !== "string") {
    throw new DcrRegistrationError("invalid_client_metadata", "client_name must be a string");
  }
  if (unicodeLength(raw) > MAX_CLIENT_NAME_CHARS) {
    throw new DcrRegistrationError(
      "invalid_client_metadata",
      `client_name must be at most ${MAX_CLIENT_NAME_CHARS} characters`,
    );
  }
  return raw;
}

function normalizeApplicationType(raw: unknown): "native" | "web" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "native" || raw === "web") return raw;
  throw new DcrRegistrationError(
    "invalid_client_metadata",
    "application_type must be \"native\" or \"web\"",
  );
}

function normalizeScope(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new DcrRegistrationError("invalid_client_metadata", "scope must be a string");
  }
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (!ALLOWED_SCOPES.has(token)) {
      throw new DcrRegistrationError("invalid_client_metadata", `Unsupported scope: ${token}`);
    }
  }
  return tokens.join(" ");
}

function normalizeRedirectUris(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new DcrRegistrationError("invalid_redirect_uri", "redirect_uris is required");
  }
  if (raw.length > MAX_REDIRECT_URIS) {
    throw new DcrRegistrationError(
      "invalid_redirect_uri",
      `At most ${MAX_REDIRECT_URIS} redirect_uris are allowed`,
    );
  }
  if (raw.some((item) => typeof item !== "string")) {
    throw new DcrRegistrationError("invalid_redirect_uri", "redirect_uris must be an array of strings");
  }
  const uris = raw as string[];
  if (new Set(uris).size !== uris.length) {
    throw new DcrRegistrationError("invalid_redirect_uri", "redirect_uris must not contain duplicates");
  }
  for (const uri of uris) {
    validateRedirectUri(uri);
  }
  return uris;
}

function normalizeMetadata(input: Record<string, unknown>): NormalizedDcrMetadata {
  if ("software_statement" in input) {
    throw new DcrRegistrationError(
      "invalid_software_statement",
      "Software statements are not supported by this registration endpoint",
    );
  }
  for (const field of UNSUPPORTED_FIELDS) {
    if (field in input) {
      throw new DcrRegistrationError(
        "invalid_client_metadata",
        `${field} is not supported by this registration endpoint`,
      );
    }
  }

  const metadata: NormalizedDcrMetadata = {
    client_name: normalizeClientName(input.client_name),
    redirect_uris: normalizeRedirectUris(input.redirect_uris),
    grant_types: normalizeGrantTypes(input.grant_types),
    response_types: normalizeResponseTypes(input.response_types),
    token_endpoint_auth_method: normalizeAuthMethod(input.token_endpoint_auth_method),
  };
  const applicationType = normalizeApplicationType(input.application_type);
  if (applicationType) metadata.application_type = applicationType;
  const scope = normalizeScope(input.scope);
  if (scope) metadata.scope = scope;
  return metadata;
}

function toRegistrationResponse(
  clientId: string,
  issuedAtS: number,
  metadata: NormalizedDcrMetadata,
): DcrRegistrationResponse {
  return {
    client_id: clientId,
    client_id_issued_at: issuedAtS,
    ...metadata,
  };
}

function parseStoredMetadata(metadataJson: string): NormalizedDcrMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    throw new OAuthClientResolutionError("invalid_client", "Unknown OAuth client");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OAuthClientResolutionError("invalid_client", "Unknown OAuth client");
  }
  try {
    return normalizeMetadata(parsed as Record<string, unknown>);
  } catch {
    throw new OAuthClientResolutionError("invalid_client", "Unknown OAuth client");
  }
}

function toClientMetadata(clientId: string, metadata: NormalizedDcrMetadata): ClientMetadata {
  return {
    client_id: clientId,
    client_name: metadata.client_name,
    redirect_uris: metadata.redirect_uris,
    grant_types: metadata.grant_types,
    response_types: metadata.response_types,
    token_endpoint_auth_method: metadata.token_endpoint_auth_method,
    ...(metadata.scope ? { scope: metadata.scope } : {}),
  };
}

export class DcrService {
  constructor(private readonly store: DcrStore) {}

  register(input: unknown): DcrRegistrationResponse {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new DcrRegistrationError("invalid_client_metadata", "Registration request must be a JSON object");
    }

    const metadata = normalizeMetadata(input as Record<string, unknown>);
    const metadataJson = JSON.stringify(metadata);

    for (let attempt = 0; attempt < INSERT_ATTEMPTS; attempt++) {
      const clientId = generateDcrClientId();
      const createdAtMs = Date.now();
      const issuedAtS = Math.floor(createdAtMs / 1000);
      try {
        this.store.insertClient(clientId, metadataJson, issuedAtS, createdAtMs);
        return toRegistrationResponse(clientId, issuedAtS, metadata);
      } catch (error) {
        if (error instanceof DcrStoreConflictError && attempt < INSERT_ATTEMPTS - 1) {
          continue;
        }
        if (error instanceof DcrStoreUnavailable) {
          throw new DcrRegistrationError(
            "server_error",
            "Dynamic client registration temporarily unavailable",
            503,
          );
        }
        if (error instanceof DcrStoreConflictError) {
          throw new DcrRegistrationError("server_error", "Failed to allocate a unique client_id", 500);
        }
        throw error;
      }
    }

    throw new DcrRegistrationError("server_error", "Failed to allocate a unique client_id", 500);
  }

  resolve(clientId: string): ClientMetadata {
    if (!isDcrClientId(clientId)) {
      throw new OAuthClientResolutionError("invalid_client", "Unknown OAuth client");
    }

    let record;
    try {
      record = this.store.getClient(clientId);
    } catch (error) {
      if (error instanceof DcrStoreUnavailable) {
        throw new OAuthClientResolutionError(
          "unavailable",
          "Dynamic client registration temporarily unavailable",
        );
      }
      throw error;
    }

    if (!record) {
      throw new OAuthClientResolutionError("invalid_client", "Unknown OAuth client");
    }

    try {
      const metadata = parseStoredMetadata(record.metadata_json);
      return toClientMetadata(clientId, metadata);
    } catch (error) {
      if (error instanceof OAuthClientResolutionError) {
        process.stderr.write(`oauth-dcr: corrupt client record client_id=${clientId}\n`);
        throw error;
      }
      throw error;
    }
  }
}

export class DcrClientResolver implements OAuthClientResolver {
  constructor(private readonly service: DcrService) {}

  async resolve(clientId: string): Promise<ClientMetadata> {
    return this.service.resolve(clientId);
  }
}
