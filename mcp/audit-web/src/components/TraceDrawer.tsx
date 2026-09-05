import React, { useEffect, useState } from "react";
import { X, Copy, Check, Loader2, Code2 } from "lucide-react";
import { fetchTraceDetail, type TraceDetail } from "../api";
import { formatBytes, formatTime } from "../lib/utils";

interface TraceDrawerProps {
  traceId: number;
  onClose: () => void;
}

export const TraceDrawer: React.FC<TraceDrawerProps> = ({ traceId, onClose }) => {
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedInput, setCopiedInput] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchTraceDetail(traceId)
      .then((data) => {
        if (!cancelled) {
          setDetail(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [traceId]);

  const copyToClipboard = async (text: string, isInput: boolean) => {
    try {
      await navigator.clipboard.writeText(text);
      if (isInput) {
        setCopiedInput(true);
        setTimeout(() => setCopiedInput(false), 2000);
      } else {
        setCopiedOutput(true);
        setTimeout(() => setCopiedOutput(false), 2000);
      }
    } catch {}
  };

  const formatJson = (str: string) => {
    try {
      return JSON.stringify(JSON.parse(str), null, 2);
    } catch {
      return str;
    }
  };

  return (
    <div className="flex flex-col h-full bg-neutral-950 border border-neutral-800 rounded-lg overflow-hidden shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900/80 px-4 py-3">
        <div className="flex items-center gap-3">
          <Code2 className="h-4 w-4 text-neutral-400" />
          <div>
            <h3 className="text-sm font-semibold text-neutral-200">
              Trace #{traceId} —{" "}
              <span className="font-mono text-neutral-300">
                {detail?.tool_name || "Loading..."}
              </span>
            </h3>
            {detail && (
              <p className="text-xs text-neutral-400 font-mono">
                {formatTime(detail.timestamp_ms)} • {detail.latency_ms}ms • Total:{" "}
                {detail.total_tokens_est} tokens est
              </p>
            )}
          </div>
        </div>

        <button
          onClick={onClose}
          className="rounded-md p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 p-4 flex flex-col">
        {loading ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-neutral-400" />
          </div>
        ) : error ? (
          <div className="rounded-md border border-red-900/50 bg-red-950/40 p-4 text-xs text-red-300">
            Failed to load trace detail: {error}
          </div>
        ) : detail ? (
          <div className="flex flex-col gap-4 h-full min-h-0">
            {/* Input / Request */}
            <div className="flex flex-col shrink-0 max-h-[28vh] rounded-lg border border-neutral-800 bg-neutral-900/40 overflow-hidden">
              <div className="shrink-0 flex items-center justify-between border-b border-neutral-800/80 bg-neutral-900/90 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-neutral-300 uppercase tracking-wider">
                    Tool Input Arguments
                  </span>
                  <span className="text-[11px] font-mono text-neutral-500">
                    ({formatBytes(detail.input_bytes)} • {detail.input_tokens_est} tok)
                  </span>
                </div>
                <button
                  onClick={() => copyToClipboard(formatJson(detail.input_json), true)}
                  className="inline-flex items-center gap-1 rounded bg-neutral-800 px-2 py-1 text-[11px] font-medium text-neutral-300 hover:bg-neutral-700 transition"
                >
                  {copiedInput ? (
                    <>
                      <Check className="h-3 w-3 text-emerald-400" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="min-h-0 overflow-auto p-3 text-xs font-mono text-neutral-300 bg-neutral-950/70 select-text">
                <code>{formatJson(detail.input_json)}</code>
              </pre>
            </div>

            {/* Output / Response */}
            <div className="flex flex-col flex-1 min-h-0 rounded-lg border border-neutral-800 bg-neutral-900/40 overflow-hidden">
              <div className="shrink-0 flex items-center justify-between border-b border-neutral-800/80 bg-neutral-900/90 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-neutral-300 uppercase tracking-wider">
                    CallToolResult Output
                  </span>
                  <span className="text-[11px] font-mono text-neutral-500">
                    ({formatBytes(detail.output_bytes)} • {detail.output_tokens_est} tok)
                  </span>
                </div>
                <button
                  onClick={() => copyToClipboard(formatJson(detail.output_json), false)}
                  className="inline-flex items-center gap-1 rounded bg-neutral-800 px-2 py-1 text-[11px] font-medium text-neutral-300 hover:bg-neutral-700 transition"
                >
                  {copiedOutput ? (
                    <>
                      <Check className="h-3 w-3 text-emerald-400" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="flex-1 min-h-0 overflow-auto p-3 text-xs font-mono text-neutral-300 bg-neutral-950/70 select-text">
                <code>{formatJson(detail.output_json)}</code>
              </pre>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
