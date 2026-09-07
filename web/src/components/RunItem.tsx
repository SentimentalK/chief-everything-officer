import React, { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Loader2,
  AlertCircle,
  GitCommit,
  HelpCircle,
} from "lucide-react";
import { type TraceRun, computeRunStats } from "../lib/groupTraces";
import { copyRunToClipboard } from "../lib/copyRun";
import { formatTime } from "../lib/utils";
import { TraceItem } from "./TraceItem";

interface RunItemProps {
  run: TraceRun;
  selectedId: number | null;
  onSelectTrace: (id: number | null) => void;
  defaultExpanded?: boolean;
}

export const RunItem: React.FC<RunItemProps> = ({
  run,
  selectedId,
  onSelectTrace,
  defaultExpanded = false,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const stats = computeRunStats(run);

  const handleToggle = () => {
    setIsExpanded((prev) => !prev);
  };

  const handleCopyAll = async (e: React.MouseEvent) => {
    // CRITICAL: Prevent header click from toggling expand/collapse
    e.stopPropagation();

    if (copyState === "copying") return;

    setCopyState("copying");
    setErrorMessage(null);

    try {
      await copyRunToClipboard(run);
      setCopyState("copied");
      setTimeout(() => {
        setCopyState("idle");
      }, 2000);
    } catch (err) {
      setCopyState("error");
      setErrorMessage("Failed to load complete Run details.");
    }
  };

  const formatTokens = (tokens: number): string => {
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(1)}k`;
    }
    return String(tokens);
  };

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
      case "resource_capture":
      case "resource_get":
      case "resource_list":
        return "bg-cyan-950/60 text-cyan-300 border-cyan-800/50";
      default:
        return "bg-neutral-900 text-neutral-300 border-neutral-800";
    }
  };

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/90 overflow-hidden shadow-sm transition">
      {/* Clickable Run Header */}
      <div
        onClick={handleToggle}
        className="cursor-pointer p-4 hover:bg-neutral-900/40 transition select-none flex flex-col gap-3"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 flex-wrap">
            <button
              type="button"
              className="text-neutral-400 hover:text-neutral-200 transition focus:outline-none"
              aria-label={isExpanded ? "Collapse Run" : "Expand Run"}
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 text-neutral-300" />
              ) : (
                <ChevronRight className="h-4 w-4 text-neutral-400" />
              )}
            </button>

            <span className="font-mono text-xs font-semibold text-neutral-200">
              {formatTime(run.start_timestamp_ms)} → {formatTime(run.end_timestamp_ms)}
            </span>

            <span className="text-neutral-600 font-mono text-xs">•</span>

            <span className="text-xs text-neutral-400 font-medium flex items-center gap-1.5">
              <span>{stats.totalCalls} {stats.totalCalls === 1 ? "call" : "calls"}</span>
              <span>·</span>
              <span className="font-mono">{stats.durationFormatted}</span>
              <span>·</span>
              <span>{stats.distinctTools} {stats.distinctTools === 1 ? "tool" : "tools"}</span>
              {stats.errorCount > 0 && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1 text-red-400 font-mono">
                    <AlertCircle className="h-3 w-3" />
                    {stats.errorCount} {stats.errorCount === 1 ? "error" : "errors"}
                  </span>
                </>
              )}
            </span>

            <div
              className="cursor-help inline-flex items-center text-neutral-500 hover:text-neutral-400"
              title="Grouped by MCP activity time. V0 uses a 5-minute idle gap and may combine concurrent conversations."
              onClick={(e) => e.stopPropagation()}
            >
              <HelpCircle className="h-3 w-3" />
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Copy All Button */}
            <button
              onClick={handleCopyAll}
              disabled={copyState === "copying"}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition ${
                copyState === "copied"
                  ? "bg-emerald-950/80 text-emerald-300 border-emerald-700/60"
                  : copyState === "error"
                  ? "bg-red-950/80 text-red-300 border-red-700/60"
                  : "bg-neutral-900 border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
              } disabled:opacity-50`}
              title="Copy complete run details as Markdown"
            >
              {copyState === "copying" ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" />
                  <span>Copying...</span>
                </>
              ) : copyState === "copied" ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Copied ✓</span>
                </>
              ) : copyState === "error" ? (
                <>
                  <AlertCircle className="h-3.5 w-3.5 text-red-400" />
                  <span>Copy Failed</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy All</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Tool Frequency Pills in first-appearance order */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {stats.toolFrequencies.map(({ tool, count }) => (
            <span
              key={tool}
              className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-mono font-medium border ${getToolBadgeClass(
                tool
              )}`}
            >
              {tool} <span className="opacity-70 ml-1">×{count}</span>
            </span>
          ))}
        </div>

        {/* Tokens & Write Indicators */}
        <div className="flex items-center justify-between text-xs font-mono text-neutral-500 pt-1 border-t border-neutral-900 flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <span>
              Semantic{" "}
              <span className="text-neutral-300">
                ~{formatTokens(stats.totalSemanticTokens)}
              </span>{" "}
              tok
            </span>
            <span>•</span>
            <span>
              Protocol{" "}
              <span className="text-neutral-300">
                ~{formatTokens(stats.totalProtocolTokens)}
              </span>{" "}
              tok
            </span>
          </div>

          {stats.hasWrites && (
            <div className="flex items-center gap-2 text-neutral-400">
              {stats.affectedPaths.length > 0 && (
                <span className="text-amber-300/80 truncate max-w-xs">
                  {stats.affectedPaths.length} path{stats.affectedPaths.length > 1 ? "s" : ""}
                </span>
              )}
              {stats.resultingCommits.map((commit) => (
                <span key={commit} className="inline-flex items-center gap-1 text-neutral-300">
                  <GitCommit className="h-3 w-3 text-neutral-500" />
                  <span>{commit.slice(0, 7)}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {errorMessage && (
          <div
            className="rounded bg-red-950/40 p-2 text-xs font-mono text-red-300 border border-red-900/50 flex items-center gap-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}
      </div>

      {/* Expanded Traces List (Chronological Order) */}
      {isExpanded && (
        <div className="border-t border-neutral-800 bg-neutral-950/60 p-3 space-y-2">
          {run.traces.map((trace, idx) => (
            <TraceItem
              key={trace.id}
              trace={trace}
              stepIndex={idx + 1}
              isSelected={selectedId === trace.id}
              onSelect={() => onSelectTrace(selectedId === trace.id ? null : trace.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
