import https from "node:https";
import http from "node:http";
import dns from "node:dns/promises";
import net from "node:net";

export class ClientMetadataError extends Error {
  constructor(message: string, public readonly code: string = "invalid_client_metadata") {
    super(message);
    this.name = "ClientMetadataError";
  }
}

export interface ClientMetadata {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
  logo_uri?: string;
  client_uri?: string;
}

export interface ClientMetadataResolverOptions {
  dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  allowPrivateIpsForTest?: boolean;
  allowHttpForTest?: boolean;
  cacheTtlMs?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

const CACHE_TTL_DEFAULT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_RESPONSE_BYTES_DEFAULT = 32 * 1024; // 32 KiB
const FETCH_TIMEOUT_DEFAULT_MS = 3000; // 3 seconds

const metadataCache = new Map<string, { metadata: ClientMetadata; expiresAt: number }>();

export function clearClientMetadataCache(): void {
  metadataCache.clear();
}

/**
 * Checks whether an IPv4 or IPv6 address is private, loopback, link-local, multicast, or reserved.
 */
export function isPrivateOrSpecialIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) {
    return true; // Not a valid IP
  }

  if (family === 4) {
    const parts = ip.split(".").map((p) => parseInt(p, 10));
    if (parts.length !== 4 || parts.some(isNaN)) return true;
    const o0 = parts[0]!;
    const o1 = parts[1]!;
    const o2 = parts[2]!;
    const o3 = parts[3]!;

    // 0.0.0.0/8
    if (o0 === 0) return true;
    // 10.0.0.0/8
    if (o0 === 10) return true;
    // 100.64.0.0/10 (Carrier-Grade NAT)
    if (o0 === 100 && o1 >= 64 && o1 <= 127) return true;
    // 127.0.0.0/8 (Loopback)
    if (o0 === 127) return true;
    // 169.254.0.0/16 (Link-Local)
    if (o0 === 169 && o1 === 254) return true;
    // 172.16.0.0/12
    if (o0 === 172 && o1 >= 16 && o1 <= 31) return true;
    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (o0 === 192 && o1 === 0 && o2 === 0) return true;
    // 192.0.2.0/24 (TEST-NET-1)
    if (o0 === 192 && o1 === 0 && o2 === 2) return true;
    // 192.88.99.0/24 (6to4 Relay Anycast)
    if (o0 === 192 && o1 === 88 && o2 === 99) return true;
    // 192.168.0.0/16
    if (o0 === 192 && o1 === 168) return true;
    // 198.18.0.0/15 (Benchmarking)
    if (o0 === 198 && o1 >= 18 && o1 <= 19) return true;
    // 198.51.100.0/24 (TEST-NET-2)
    if (o0 === 198 && o1 === 51 && o2 === 100) return true;
    // 203.0.113.0/24 (TEST-NET-3)
    if (o0 === 203 && o1 === 0 && o2 === 113) return true;
    // 224.0.0.0/4 (Multicast) + 240.0.0.0/4 (Reserved)
    if (o0 >= 224) return true;

    return false;
  }

  // IPv6
  const normalized = ip.toLowerCase();

  // IPv4-mapped IPv6 address (::ffff:x.x.x.x or ::ffff:hex:hex)
  if (normalized.startsWith("::ffff:")) {
    const rest = normalized.slice(7);
    if (net.isIPv4(rest)) {
      return isPrivateOrSpecialIp(rest);
    }
  }

  // Loopback ::1
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  // Unspecified ::
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;
  // Link-local unicast fe80::/10
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }
  // Unique Local Address fc00::/7 (fc00:: - fdff::)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  // Multicast ff00::/8
  if (normalized.startsWith("ff")) {
    return true;
  }
  // Documentation 2001:db8::/32
  if (normalized.startsWith("2001:db8") || normalized.startsWith("2001:0db8")) {
    return true;
  }

  return false;
}

/**
 * Validates the syntax of a CIMD Client ID URL.
 */
export function validateClientIdUrl(clientId: string, allowHttpForTest = false): URL {
  // Check raw input for dot-segments (/./ or /../) before URL normalization resolves them
  const pathAndQuery = clientId.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+/, "");
  if (/\/\.\.?(?=\/|$)/.test(pathAndQuery)) {
    throw new ClientMetadataError("Client ID URL path must not contain dot-segments", "invalid_client_id_dot_segments");
  }

  let parsed: URL;
  try {
    parsed = new URL(clientId);
  } catch {
    throw new ClientMetadataError("Client ID must be a valid URL", "invalid_client_id_url");
  }

  if (allowHttpForTest) {
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ClientMetadataError("Client ID URL scheme must be https or http (test)", "invalid_client_id_scheme");
    }
  } else {
    if (parsed.protocol !== "https:") {
      throw new ClientMetadataError("Client ID URL scheme must be https", "invalid_client_id_scheme");
    }
  }

  // Must not have username or password
  if (parsed.username || parsed.password) {
    throw new ClientMetadataError("Client ID URL must not contain credentials", "invalid_client_id_credentials");
  }

  // Must not have query search or fragment hash
  if (parsed.search) {
    throw new ClientMetadataError("Client ID URL must not contain query parameters", "invalid_client_id_query");
  }
  if (parsed.hash) {
    throw new ClientMetadataError("Client ID URL must not contain fragments", "invalid_client_id_fragment");
  }

  // Hostname cannot be empty or an IP literal
  if (!parsed.hostname) {
    throw new ClientMetadataError("Client ID URL must contain a valid hostname", "invalid_client_id_hostname");
  }
  if (!allowHttpForTest && net.isIP(parsed.hostname) !== 0) {
    throw new ClientMetadataError("Client ID URL hostname must not be an IP literal", "invalid_client_id_ip_literal");
  }

  // Path must not be empty or root "/"
  const pathname = parsed.pathname;
  if (!pathname || pathname === "/" || pathname === "") {
    throw new ClientMetadataError("Client ID URL must have a non-root path", "invalid_client_id_path");
  }

  // Path segments must not contain "." or ".."
  const segments = pathname.split("/");
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      throw new ClientMetadataError("Client ID URL path must not contain dot-segments", "invalid_client_id_dot_segments");
    }
  }

  return parsed;
}

/**
 * Resolves and validates a Client ID Metadata Document (CIMD).
 * Employs DNS pre-validation, connection pinning, size limit, and strict schema validation.
 */
export async function resolveClientMetadata(
  clientId: string,
  options: ClientMetadataResolverOptions = {}
): Promise<ClientMetadata> {
  const allowHttp = options.allowHttpForTest ?? false;
  const allowPrivate = options.allowPrivateIpsForTest ?? false;
  const cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_DEFAULT_MS;
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES_DEFAULT;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_DEFAULT_MS;

  // 1. Check in-memory cache
  const cached = metadataCache.get(clientId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.metadata;
  }

  // 2. Validate URL syntax
  const parsedUrl = validateClientIdUrl(clientId, allowHttp);
  const hostname = parsedUrl.hostname;

  // 3. DNS resolution & IP validation
  const lookupFn = options.dnsLookup ?? ((host: string) => dns.lookup(host, { all: true }));
  let resolvedAddresses: Array<{ address: string; family: number }>;
  try {
    resolvedAddresses = await lookupFn(hostname);
  } catch (err: any) {
    throw new ClientMetadataError(`DNS resolution failed for ${hostname}: ${err.message}`, "dns_resolution_failed");
  }

  if (!resolvedAddresses || resolvedAddresses.length === 0) {
    throw new ClientMetadataError(`No DNS records found for ${hostname}`, "dns_no_records");
  }

  if (!allowPrivate) {
    for (const addr of resolvedAddresses) {
      if (isPrivateOrSpecialIp(addr.address)) {
        throw new ClientMetadataError(
          `Resolved address ${addr.address} for host ${hostname} is private or restricted`,
          "ssrf_disallowed_address"
        );
      }
    }
  }

  // 4. Fetch document with connection pinning
  // Agent lookup hook pins to the pre-validated addresses, preventing DNS rebinding/TOCTOU
  const pinnedAddresses = [...resolvedAddresses];
  const customLookup = (
    _host: string,
    lookupOpts: any,
    cb: (err: Error | null, addressOrList?: any, family?: number) => void
  ) => {
    if (typeof lookupOpts === "function") {
      cb = lookupOpts;
      lookupOpts = {};
    }
    if (lookupOpts && lookupOpts.all) {
      cb(null, pinnedAddresses);
    } else {
      const first = pinnedAddresses[0];
      if (!first) {
        cb(new Error("No pinned address available"));
      } else {
        cb(null, first.address, first.family);
      }
    }
  };

  const isHttps = parsedUrl.protocol === "https:";
  const agent = isHttps
    ? new https.Agent({ lookup: customLookup, keepAlive: false })
    : new http.Agent({ lookup: customLookup, keepAlive: false });

  const rawBody = await new Promise<string>((resolve, reject) => {
    const reqOptions: http.RequestOptions = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      agent,
      headers: {
        Accept: "application/json",
        "User-Agent": "CEO-OAuth-CIMD/1.0",
        Host: parsedUrl.host,
      },
      timeout: timeoutMs,
    };

    const clientModule = isHttps ? https : http;
    const req = clientModule.request(reqOptions, (res) => {
      // Reject any redirects (3xx)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        req.destroy();
        return reject(new ClientMetadataError("Redirects are not permitted for CIMD", "redirect_prohibited"));
      }

      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new ClientMetadataError(`CIMD endpoint returned HTTP ${res.statusCode}`, "http_error"));
      }

      const contentType = res.headers["content-type"] || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        req.destroy();
        return reject(
          new ClientMetadataError(
            `Invalid Content-Type for CIMD: expected application/json, got ${contentType}`,
            "invalid_content_type"
          )
        );
      }

      let totalBytes = 0;
      const chunks: Buffer[] = [];

      res.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          req.destroy();
          return reject(
            new ClientMetadataError(
              `CIMD response exceeded maximum allowed size of ${maxBytes} bytes`,
              "payload_too_large"
            )
          );
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });

      res.on("error", (err) => reject(new ClientMetadataError(`Network error reading CIMD: ${err.message}`, "network_error")));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new ClientMetadataError(`CIMD fetch timed out after ${timeoutMs}ms`, "timeout"));
    });

    req.on("error", (err) => {
      reject(new ClientMetadataError(`CIMD connection failed: ${err.message}`, "network_error"));
    });

    req.end();
  });

  // 5. Parse JSON & Validate Schema
  let parsedJson: any;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    throw new ClientMetadataError("CIMD document is not valid JSON", "invalid_json");
  }

  if (!parsedJson || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
    throw new ClientMetadataError("CIMD document must be a JSON object", "invalid_schema");
  }

  // Exact byte match of client_id
  if (parsedJson.client_id !== clientId) {
    throw new ClientMetadataError(
      `CIMD client_id "${parsedJson.client_id}" does not match requested client_id "${clientId}"`,
      "client_id_mismatch"
    );
  }

  // redirect_uris must be a non-empty array of valid URI strings
  if (!Array.isArray(parsedJson.redirect_uris) || parsedJson.redirect_uris.length === 0) {
    throw new ClientMetadataError("CIMD redirect_uris must be a non-empty array", "invalid_redirect_uris");
  }

  for (const uri of parsedJson.redirect_uris) {
    if (typeof uri !== "string" || !uri) {
      throw new ClientMetadataError("Each redirect_uri must be a non-empty string", "invalid_redirect_uri");
    }
    let parsedUri: URL;
    try {
      parsedUri = new URL(uri);
    } catch {
      throw new ClientMetadataError(`Invalid redirect_uri format: ${uri}`, "invalid_redirect_uri");
    }
    if (parsedUri.hash) {
      throw new ClientMetadataError(`redirect_uri must not contain a fragment: ${uri}`, "invalid_redirect_uri");
    }
    // Loopback redirects may use http scheme (RFC 8252)
    const isLoopback = parsedUri.hostname === "localhost" || parsedUri.hostname === "127.0.0.1" || parsedUri.hostname === "[::1]";
    if (parsedUri.protocol === "http:" && !isLoopback && !allowHttp) {
      throw new ClientMetadataError(`Non-loopback redirect_uri must use https: ${uri}`, "invalid_redirect_uri");
    }
  }

  // grant_types if present must include "authorization_code"
  if (parsedJson.grant_types !== undefined) {
    if (!Array.isArray(parsedJson.grant_types) || !parsedJson.grant_types.includes("authorization_code")) {
      throw new ClientMetadataError("CIMD grant_types must include authorization_code", "unsupported_grant_type");
    }
  }

  // response_types if present must include "code"
  if (parsedJson.response_types !== undefined) {
    if (!Array.isArray(parsedJson.response_types) || !parsedJson.response_types.includes("code")) {
      throw new ClientMetadataError("CIMD response_types must include code", "unsupported_response_type");
    }
  }

  // token_endpoint_auth_method must be absent or "none" (public client)
  if (
    parsedJson.token_endpoint_auth_method !== undefined &&
    parsedJson.token_endpoint_auth_method !== "none"
  ) {
    throw new ClientMetadataError(
      `Unsupported token_endpoint_auth_method: ${parsedJson.token_endpoint_auth_method}. Only 'none' is supported.`,
      "unsupported_auth_method"
    );
  }

  const clientName = typeof parsedJson.client_name === "string" && parsedJson.client_name.trim()
    ? parsedJson.client_name.trim()
    : hostname;

  const metadata: ClientMetadata = {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: parsedJson.redirect_uris,
    grant_types: parsedJson.grant_types,
    response_types: parsedJson.response_types,
    token_endpoint_auth_method: parsedJson.token_endpoint_auth_method,
    scope: typeof parsedJson.scope === "string" ? parsedJson.scope : undefined,
    logo_uri: typeof parsedJson.logo_uri === "string" ? parsedJson.logo_uri : undefined,
    client_uri: typeof parsedJson.client_uri === "string" ? parsedJson.client_uri : undefined,
  };

  // Cache valid metadata
  metadataCache.set(clientId, {
    metadata,
    expiresAt: now + cacheTtlMs,
  });

  return metadata;
}
