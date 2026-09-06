import type { TraceSummary } from "../api";

export const RUN_IDLE_GAP_MS = 5 * 60 * 1000; // 5 minutes

export interface TraceRun {
  id: string;
  start_timestamp_ms: number;
  end_timestamp_ms: number;
  traces: TraceSummary[];
}

export interface RunStats {
  totalCalls: number;
  durationMs: number;
  durationFormatted: string;
  distinctTools: number;
  errorCount: number;
  toolFrequencies: { tool: string; count: number }[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalProtocolTokens: number;
  totalSemanticTokens: number;
  hasWrites: boolean;
  resultingCommits: string[];
  affectedPaths: string[];
}

function createRun(trace: TraceSummary): TraceRun {
  return {
    id: `run-${trace.id}-${trace.id}`,
    start_timestamp_ms: trace.timestamp_ms,
    end_timestamp_ms: trace.timestamp_ms + trace.latency_ms,
    traces: [trace],
  };
}

/**
 * Group traces into Runs using a temporal idle-gap heuristic.
 *
 * Consecutive traces with an idle gap <= idleGapMs belong to the same Run.
 * The idle gap is measured from the current Run's latest known activity end:
 * gap = trace.timestamp_ms - current.end_timestamp_ms
 *
 * Input traces may arrive in any order; they are sorted ascending by timestamp_ms.
 * Output runs are returned newest-first; traces within each Run are chronological (oldest-first).
 */
export function groupTracesIntoRuns(
  traces: TraceSummary[],
  idleGapMs = RUN_IDLE_GAP_MS
): TraceRun[] {
  if (traces.length === 0) return [];

  const sorted = [...traces].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const runs: TraceRun[] = [];

  for (const trace of sorted) {
    const current = runs[runs.length - 1];
    if (!current) {
      runs.push(createRun(trace));
      continue;
    }

    const gap = trace.timestamp_ms - current.end_timestamp_ms;
    if (gap <= idleGapMs) {
      current.traces.push(trace);
      current.end_timestamp_ms = Math.max(
        current.end_timestamp_ms,
        trace.timestamp_ms + trace.latency_ms
      );
      current.id = `run-${current.traces[0].id}-${trace.id}`;
    } else {
      runs.push(createRun(trace));
    }
  }

  // Display resulting Runs newest-first; traces within each Run are in chronological order
  return runs.reverse();
}

export function formatRunDuration(startMs: number, endMs: number): string {
  const diffMs = Math.max(0, endMs - startMs);
  if (diffMs < 1000) return "<1s";
  const totalSeconds = Math.round(diffMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (remainingSeconds === 0) return `${minutes}m`;
  return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
}

export function computeRunStats(run: TraceRun): RunStats {
  const totalCalls = run.traces.length;
  const durationMs = Math.max(0, run.end_timestamp_ms - run.start_timestamp_ms);
  const durationFormatted = formatRunDuration(run.start_timestamp_ms, run.end_timestamp_ms);

  const freqMap = new Map<string, number>();
  for (const t of run.traces) {
    freqMap.set(t.tool_name, (freqMap.get(t.tool_name) || 0) + 1);
  }
  const toolFrequencies = Array.from(freqMap.entries()).map(([tool, count]) => ({
    tool,
    count,
  }));
  const distinctTools = toolFrequencies.length;

  let errorCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalProtocolTokens = 0;
  let totalSemanticTokens = 0;
  let hasWrites = false;
  const commitsSet = new Set<string>();
  const pathsSet = new Set<string>();

  for (const t of run.traces) {
    if (t.status === "error") errorCount++;
    totalInputTokens += t.input_tokens_est || 0;
    totalOutputTokens += t.output_tokens_est || 0;
    totalProtocolTokens += t.total_tokens_est || 0;

    const semOut =
      t.semantic_output_tokens_est != null
        ? t.semantic_output_tokens_est
        : t.output_tokens_est || 0;
    totalSemanticTokens += (t.input_tokens_est || 0) + semOut;

    if (t.resulting_commit) commitsSet.add(t.resulting_commit);
    if (t.affected_paths) {
      for (const p of t.affected_paths) pathsSet.add(p);
    }
    if (
      t.tool_name === "apply_change_set" ||
      t.resulting_commit ||
      (t.affected_paths && t.affected_paths.length > 0)
    ) {
      hasWrites = true;
    }
  }

  return {
    totalCalls,
    durationMs,
    durationFormatted,
    distinctTools,
    errorCount,
    toolFrequencies,
    totalInputTokens,
    totalOutputTokens,
    totalProtocolTokens,
    totalSemanticTokens,
    hasWrites,
    resultingCommits: Array.from(commitsSet),
    affectedPaths: Array.from(pathsSet),
  };
}
