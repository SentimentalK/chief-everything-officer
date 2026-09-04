import React from "react";
import { ChevronDown, ChevronRight, CheckCircle2, AlertCircle, Clock, GitCommit } from "lucide-react";
import type { TraceSummary } from "../api";
import { formatBytes, formatTime } from "../lib/utils";

interface TraceItemProps {
  trace: TraceSummary;
  isSelected: boolean;
  onSelect: () => void;
}

export const TraceItem: React.FC<TraceItemProps> = ({ trace, isSelected, onSelect }) => {
  const isError = trace.status === "error";
  const isWrite = trace.tool_name === "apply_change_set";

  const getToolBadgeClass = (tool: string) => {
    switch (tool) {
      case "policy_read":
        return "bg-purple-950/60 text-purple-300 border-purple-800/50";
      case "apply_change_set":
        return "bg-amber-950/60 text-amber-300 border-amber-800/50";
      case "workspace_status":
        return "bg-sky-950/60 text-sky-300 border-sky-800/50";
      case "search_text":
        return "bg-emerald-950/60 text-emerald-300 border-emerald-800/50";
      default:
        return "bg-neutral-800 text-neutral-300 border-neutral-700";
    }
  };

  return (
    <div
      onClick={onSelect}
      className={`group cursor-pointer rounded-lg border transition-all duration-150 ${
        isSelected
          ? "border-neutral-500 bg-neutral-900/90 shadow-md"
          : "border-neutral-800/80 bg-neutral-950 hover:border-neutral-700 hover:bg-neutral-900/50"
      }`}
    >
      <div className="p-3.5 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs font-medium text-neutral-400">
              {formatTime(trace.timestamp_ms)}
            </span>

            <span
              className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-mono font-medium border ${getToolBadgeClass(
                trace.tool_name
              )}`}
            >
              {trace.tool_name}
            </span>

            {isError ? (
              <span className="inline-flex items-center gap-1 rounded bg-red-950/60 px-2 py-0.5 text-[11px] font-medium text-red-300 border border-red-800/50">
                <AlertCircle className="h-3 w-3" />
                error
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded bg-emerald-950/40 px-2 py-0.5 text-[11px] font-medium text-emerald-400 border border-emerald-800/40">
                <CheckCircle2 className="h-3 w-3" />
                ok
              </span>
            )}

            {trace.operation_request_id && (
              <span className="text-[10px] font-mono text-neutral-500 truncate max-w-[120px]" title={trace.operation_request_id}>
                {trace.operation_request_id.slice(0, 8)}...
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <span className="flex items-center gap-1 font-mono">
              <Clock className="h-3 w-3 text-neutral-500" />
              {trace.latency_ms}ms
            </span>
            {isSelected ? (
              <ChevronDown className="h-4 w-4 text-neutral-300" />
            ) : (
              <ChevronRight className="h-4 w-4 text-neutral-500 group-hover:text-neutral-300" />
            )}
          </div>
        </div>

        {/* Metrics Row */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-400 font-mono">
          <div>
            <span className="text-neutral-500">In: </span>
            <span>{formatBytes(trace.input_bytes)}</span>
            <span className="text-neutral-500"> ({trace.input_tokens_est} tok)</span>
          </div>

          <div className="text-neutral-600">→</div>

          <div>
            <span className="text-neutral-500">Out: </span>
            <span>{formatBytes(trace.output_bytes)}</span>
            <span className="text-neutral-500"> ({trace.output_tokens_est} tok)</span>
          </div>

          <div className="ml-auto text-neutral-400">
            <span className="text-neutral-500">Total: </span>
            <span className="text-neutral-200 font-semibold">{trace.total_tokens_est}</span>
            <span className="text-neutral-500"> tokens est</span>
          </div>
        </div>

        {/* Write metadata row if apply_change_set */}
        {isWrite && (trace.affected_paths || trace.resulting_commit) && (
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-neutral-800/60 text-xs font-mono text-neutral-400">
            {trace.affected_paths && trace.affected_paths.length > 0 && (
              <div className="flex items-center gap-1 truncate max-w-md">
                <span className="text-neutral-500">Paths:</span>
                <span className="text-amber-200/90 truncate">
                  {trace.affected_paths.join(", ")}
                </span>
              </div>
            )}
            {trace.resulting_commit && (
              <div className="flex items-center gap-1 ml-auto text-neutral-300">
                <GitCommit className="h-3 w-3 text-neutral-500" />
                <span className="text-neutral-300">{trace.resulting_commit.slice(0, 7)}</span>
              </div>
            )}
          </div>
        )}

        {/* Error message row if failed */}
        {isError && trace.error_message && (
          <div className="rounded bg-red-950/30 p-2 text-xs font-mono text-red-300 border border-red-900/30 break-all">
            {trace.error_message}
          </div>
        )}
      </div>
    </div>
  );
};
