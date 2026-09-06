import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import {
  type ContentMetadataV1,
  type Diagnostics,
  resolutionOutcomeSchema,
} from "./resolver-contract.js";

export type ResolveOutcome =
  | {
      status: "resolved";
      metadata: ContentMetadataV1;
      fields_resolved: string[];
      diagnostics: Diagnostics;
      latency_ms: number;
      attempted_at: string;
      request_id: string;
    }
  | {
      status: "unavailable";
      code: string;
      fields_resolved: string[];
      diagnostics?: Diagnostics | null;
      latency_ms: number;
      attempted_at: string;
      request_id: string;
    }
  | {
      status: "unsupported";
      code: "unsupported_url";
      fields_resolved: string[];
      latency_ms: number;
      attempted_at: string;
      request_id: string;
    }
  | {
      status: "disabled";
      attempted_at: string;
    };

export interface UrlMetadataResolver {
  resolve(url: string, requestId?: string): Promise<ResolveOutcome>;
}

export class HttpContentResolverClient implements UrlMetadataResolver {
  private readonly endpoint: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number = 5000,
  ) {
    this.endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/resolve`;
  }

  async resolve(url: string, requestId?: string): Promise<ResolveOutcome> {
    const attempted_at = new Date().toISOString();
    const reqId = requestId && /^[A-Za-z0-9_-]{1,64}$/.test(requestId) ? requestId : randomUUID();
    const start = performance.now();
    let res: Response;

    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
          "X-Request-ID": reqId,
        },
        body: JSON.stringify({
          schema_version: 1,
          url,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: unknown) {
      const latency_ms = Math.round(performance.now() - start);
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        return {
          status: "unavailable",
          code: "timeout",
          fields_resolved: [],
          diagnostics: null,
          latency_ms,
          attempted_at,
          request_id: reqId,
        };
      }
      return {
        status: "unavailable",
        code: "network_error",
        fields_resolved: [],
        diagnostics: null,
        latency_ms,
        attempted_at,
        request_id: reqId,
      };
    }

    const latency_ms = Math.round(performance.now() - start);

    if (res.status === 200) {
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        return {
          status: "unavailable",
          code: "contract_error",
          fields_resolved: [],
          diagnostics: null,
          latency_ms,
          attempted_at,
          request_id: reqId,
        };
      }

      const parsed = resolutionOutcomeSchema.safeParse(data);
      if (!parsed.success) {
        return {
          status: "unavailable",
          code: "contract_error",
          fields_resolved: [],
          diagnostics: null,
          latency_ms,
          attempted_at,
          request_id: reqId,
        };
      }

      const outcome = parsed.data;
      if (outcome.status === "resolved") {
        return {
          status: "resolved",
          metadata: outcome.metadata,
          fields_resolved: outcome.fields_resolved,
          diagnostics: outcome.diagnostics,
          latency_ms,
          attempted_at,
          request_id: reqId,
        };
      }

      return {
        status: "unavailable",
        code: outcome.diagnostics.code || "upstream_unavailable",
        fields_resolved: outcome.fields_resolved,
        diagnostics: outcome.diagnostics,
        latency_ms,
        attempted_at,
        request_id: reqId,
      };
    }

    let detailCode: string | null = null;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object") {
        const raw = body as Record<string, unknown>;
        if (raw.detail && typeof raw.detail === "object" && !Array.isArray(raw.detail)) {
          detailCode = ((raw.detail as Record<string, unknown>).code as string) || null;
        } else if (typeof raw.detail === "string") {
          detailCode = raw.detail;
        }
      }
    } catch {
      // Ignore JSON parse failure on error responses
    }

    if (res.status === 400) {
      if (detailCode === "invalid_url" || detailCode === "unsupported_url") {
        return {
          status: "unsupported",
          code: "unsupported_url",
          fields_resolved: [],
          latency_ms,
          attempted_at,
          request_id: reqId,
        };
      }
      return {
        status: "unavailable",
        code: "contract_error",
        fields_resolved: [],
        diagnostics: null,
        latency_ms,
        attempted_at,
        request_id: reqId,
      };
    }

    if (res.status === 401) {
      return {
        status: "unavailable",
        code: "auth_failed",
        fields_resolved: [],
        diagnostics: null,
        latency_ms,
        attempted_at,
        request_id: reqId,
      };
    }

    if (res.status === 502) {
      return {
        status: "unavailable",
        code: "resolve_failed",
        fields_resolved: [],
        diagnostics: null,
        latency_ms,
        attempted_at,
        request_id: reqId,
      };
    }

    return {
      status: "unavailable",
      code: detailCode || "service_error",
      fields_resolved: [],
      diagnostics: null,
      latency_ms,
      attempted_at,
      request_id: reqId,
    };
  }
}

export class DisabledContentResolverClient implements UrlMetadataResolver {
  async resolve(_url: string): Promise<ResolveOutcome> {
    return {
      status: "disabled",
      attempted_at: new Date().toISOString(),
    };
  }
}

export function createContentResolverClient(config: Config): UrlMetadataResolver {
  if (config.contentResolverUrl && config.contentResolverToken) {
    return new HttpContentResolverClient(
      config.contentResolverUrl,
      config.contentResolverToken,
      config.contentResolverTimeoutMs,
    );
  }
  return new DisabledContentResolverClient();
}
