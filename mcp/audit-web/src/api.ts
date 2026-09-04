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
  latency_ms: number;
  affected_paths: string[] | null;
  resulting_commit: string | null;
}

export interface TraceDetail extends TraceSummary {
  input_json: string;
  output_json: string;
}

export async function checkSession(): Promise<boolean> {
  try {
    const res = await fetch("/api/audit/session", { credentials: "include" });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data.authenticated);
  } catch {
    return false;
  }
}

export async function login(token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/audit/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error || "Authentication failed" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.traces || [];
}

export async function fetchTraceDetail(id: number): Promise<TraceDetail> {
  const res = await fetch(`/api/audit/traces/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.trace;
}
