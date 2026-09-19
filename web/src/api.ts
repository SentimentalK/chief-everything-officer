export interface TraceSummary {
  id: number;
  timestamp_ms: number;
  tool_name: string;
  status: string;
  error_message: string | null;
  operation_request_id: string | null;
  input_bytes: number;
  output_bytes: number;
  input_chars: number;
  output_chars: number;
  input_tokens_est: number;
  output_tokens_est: number;
  total_tokens_est: number;
  semantic_output_bytes?: number | null;
  semantic_output_chars?: number | null;
  semantic_output_tokens_est?: number | null;
  latency_ms: number;
  affected_paths: string[] | null;
  resulting_commit: string | null;
}

export interface TraceDetail extends TraceSummary {
  input_json: string;
  output_json: string;
}

export interface UserSessionState {
  authenticated: boolean;
  user?: {
    id: string;
    provider: string;
    provider_login?: string | null;
  };
}

export async function checkUserSession(): Promise<UserSessionState> {
  try {
    const res = await fetch("/api/user/session", { credentials: "include" });
    if (!res.ok) return { authenticated: false };
    const data = await res.json();
    return {
      authenticated: Boolean(data.authenticated),
      user: data.user,
    };
  } catch {
    return { authenticated: false };
  }
}

export async function logoutUser(): Promise<void> {
  await fetch("/api/user/session/logout", {
    method: "POST",
    credentials: "include",
  }).catch(() => {});
}

export interface AuditSessionState {
  authenticated: boolean;
  authorized: boolean;
  user?: {
    id: string;
  };
}

export async function checkSession(): Promise<AuditSessionState> {
  try {
    const res = await fetch("/api/audit/session", { credentials: "include" });
    if (!res.ok) return { authenticated: false, authorized: false };
    const data = await res.json();
    return {
      authenticated: Boolean(data.authenticated),
      authorized: Boolean(data.authorized),
      user: data.user,
    };
  } catch {
    return { authenticated: false, authorized: false };
  }
}

export async function logout(): Promise<void> {
  await fetch("/api/audit/session", {
    method: "DELETE",
    credentials: "include",
  }).catch(() => {});
}

export async function fetchTraces(options?: { from?: number; to?: number; limit?: number }): Promise<TraceSummary[]> {
  const params = new URLSearchParams();
  if (options?.from !== undefined) params.set("from", String(options.from));
  if (options?.to !== undefined) params.set("to", String(options.to));
  if (options?.limit !== undefined) params.set("limit", String(options.limit));

  const url = `/api/audit/traces${params.toString() ? `?${params.toString()}` : ""}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    throw new Error(message);
  }
  const data = await res.json();
  return data.traces || [];
}

export async function fetchTraceDetail(id: number): Promise<TraceDetail> {
  const res = await fetch(`/api/audit/traces/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.trace;
}
