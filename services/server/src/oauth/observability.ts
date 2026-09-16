import { createHash } from "node:crypto";

export type OAuthClientKind = "dcr" | "cimd" | "unknown";

export function classifyOAuthClientKind(clientId: string | undefined | null): OAuthClientKind {
  if (!clientId) return "unknown";
  if (clientId.startsWith("dcr_")) return "dcr";
  return "cimd";
}

export function oauthClientRef(clientId: string | undefined | null): string | undefined {
  if (!clientId) return undefined;
  return createHash("sha256").update(clientId).digest("hex").slice(0, 12);
}

export function oauthRedirectHost(redirectUri: string | undefined | null): string | undefined {
  if (!redirectUri) return undefined;
  try {
    return new URL(redirectUri).host;
  } catch {
    return "invalid";
  }
}

function sanitizeField(value: string): string {
  return value.replace(/[\s\r\n]+/g, "_").slice(0, 200);
}

export function formatOAuthFlowLog(
  prefix: string,
  fields: Record<string, string | number | undefined>,
): string {
  const parts = [prefix];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === "") continue;
    parts.push(`${key}=${sanitizeField(String(value))}`);
  }
  return `${parts.join(" ")}\n`;
}

export function writeOAuthFlowLog(
  prefix: string,
  fields: Record<string, string | number | undefined>,
): void {
  process.stderr.write(formatOAuthFlowLog(prefix, fields));
}
