import { describe, it, expect } from "vitest";
import {
  groupTracesIntoRuns,
  formatRunDuration,
  computeRunStats,
  type TraceRun,
} from "../lib/groupTraces";
import type { TraceSummary } from "../api";

function makeTrace(partial: Partial<TraceSummary> & { id: number; timestamp_ms: number }): TraceSummary {
  return {
    id: partial.id,
    timestamp_ms: partial.timestamp_ms,
    tool_name: partial.tool_name || "test_tool",
    status: partial.status || "success",
    error_message: partial.error_message ?? null,
    operation_request_id: partial.operation_request_id ?? null,
    input_bytes: partial.input_bytes || 10,
    output_bytes: partial.output_bytes || 50,
    input_chars: partial.input_chars || 10,
    output_chars: partial.output_chars || 50,
    input_tokens_est: partial.input_tokens_est || 5,
    output_tokens_est: partial.output_tokens_est || 15,
    total_tokens_est: partial.total_tokens_est || 20,
    latency_ms: partial.latency_ms || 100,
    affected_paths: partial.affected_paths ?? null,
    resulting_commit: partial.resulting_commit ?? null,
    semantic_output_bytes: partial.semantic_output_bytes ?? null,
    semantic_output_chars: partial.semantic_output_chars ?? null,
    semantic_output_tokens_est: partial.semantic_output_tokens_est ?? null,
  };
}

describe("groupTracesIntoRuns", () => {
  const baseTime = 1700000000000;

  it("handles empty traces list", () => {
    expect(groupTracesIntoRuns([])).toEqual([]);
  });

  it("groups consecutive calls under 5 minutes into a single Run", () => {
    // 00:00, 00:03, 00:07 (gap between 00:00 and 00:03 is 3m; gap between 00:03 and 00:07 is 4m)
    const t1 = makeTrace({ id: 1, timestamp_ms: baseTime, latency_ms: 200 });
    const t2 = makeTrace({ id: 2, timestamp_ms: baseTime + 3 * 60 * 1000, latency_ms: 150 });
    const t3 = makeTrace({ id: 3, timestamp_ms: baseTime + 7 * 60 * 1000, latency_ms: 300 });

    const runs = groupTracesIntoRuns([t1, t2, t3]);
    expect(runs.length).toBe(1);
    expect(runs[0].traces.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(runs[0].id).toBe("run-1-3");
    expect(runs[0].start_timestamp_ms).toBe(baseTime);
    expect(runs[0].end_timestamp_ms).toBe(baseTime + 7 * 60 * 1000 + 300);
  });

  it("splits into multiple Runs when idle gap exceeds 5 minutes", () => {
    // 00:00, 00:01, 00:07 (idle gap from end of t2 to t3 is 6m > 5m)
    const t1 = makeTrace({ id: 1, timestamp_ms: baseTime, latency_ms: 100 });
    const t2 = makeTrace({ id: 2, timestamp_ms: baseTime + 1 * 60 * 1000, latency_ms: 100 });
    const t3 = makeTrace({ id: 3, timestamp_ms: baseTime + 7 * 60 * 1000, latency_ms: 100 });

    const runs = groupTracesIntoRuns([t1, t2, t3]);
    expect(runs.length).toBe(2);

    // Presentation order: newest Run first
    expect(runs[0].traces.map((t) => t.id)).toEqual([3]);
    expect(runs[1].traces.map((t) => t.id)).toEqual([1, 2]);
  });

  it("handles overlapping/concurrent calls with long latency (user regression case)", () => {
    // A starts 00:00, latency 10m (ends 00:10)
    // B starts 00:01, latency 1s (ends 00:01:01)
    // C starts 00:07, latency 2s (ends 00:07:02)
    // Gap for C against latest end (00:10) is <= 0 <= 5m -> all three remain in one Run
    const tA = makeTrace({ id: 101, timestamp_ms: baseTime, latency_ms: 10 * 60 * 1000 });
    const tB = makeTrace({ id: 102, timestamp_ms: baseTime + 1 * 60 * 1000, latency_ms: 1000 });
    const tC = makeTrace({ id: 103, timestamp_ms: baseTime + 7 * 60 * 1000, latency_ms: 2000 });

    const runs = groupTracesIntoRuns([tA, tB, tC]);
    expect(runs.length).toBe(1);
    expect(runs[0].traces.map((t) => t.id)).toEqual([101, 102, 103]);
    expect(runs[0].end_timestamp_ms).toBe(baseTime + 10 * 60 * 1000);
  });

  it("correctly handles input traces arriving newest-first", () => {
    const t1 = makeTrace({ id: 1, timestamp_ms: baseTime, latency_ms: 100 });
    const t2 = makeTrace({ id: 2, timestamp_ms: baseTime + 2 * 60 * 1000, latency_ms: 100 });
    const t3 = makeTrace({ id: 3, timestamp_ms: baseTime + 10 * 60 * 1000, latency_ms: 100 });

    // Reverse order input
    const runs = groupTracesIntoRuns([t3, t2, t1]);
    expect(runs.length).toBe(2);
    // Runs newest-first
    expect(runs[0].traces.map((t) => t.id)).toEqual([3]);
    // Traces within Run oldest-first (chronological)
    expect(runs[1].traces.map((t) => t.id)).toEqual([1, 2]);
  });
});

describe("formatRunDuration", () => {
  it("formats various duration ranges properly", () => {
    expect(formatRunDuration(1000, 1500)).toBe("<1s");
    expect(formatRunDuration(1000, 9000)).toBe("8s");
    expect(formatRunDuration(1000, 53000)).toBe("52s");
    expect(formatRunDuration(1000, 1000 + 134 * 1000)).toBe("2m 14s");
    expect(formatRunDuration(1000, 1000 + (18 * 60 + 3) * 1000)).toBe("18m 03s");
    expect(formatRunDuration(1000, 1000 + 120 * 1000)).toBe("2m");
  });
});

describe("computeRunStats", () => {
  it("aggregates tool frequencies in first-appearance order", () => {
    const base = 1700000000000;
    const t1 = makeTrace({ id: 1, timestamp_ms: base, tool_name: "workspace_status" });
    const t2 = makeTrace({ id: 2, timestamp_ms: base + 1000, tool_name: "policy_read" });
    const t3 = makeTrace({ id: 3, timestamp_ms: base + 2000, tool_name: "workspace_status" });
    const t4 = makeTrace({ id: 4, timestamp_ms: base + 3000, tool_name: "search_text" });
    const t5 = makeTrace({ id: 5, timestamp_ms: base + 4000, tool_name: "policy_read", status: "error" });

    const run: TraceRun = {
      id: "run-1-5",
      start_timestamp_ms: base,
      end_timestamp_ms: base + 4100,
      traces: [t1, t2, t3, t4, t5],
    };

    const stats = computeRunStats(run);
    expect(stats.totalCalls).toBe(5);
    expect(stats.distinctTools).toBe(3);
    expect(stats.errorCount).toBe(1);

    // First appearance: workspace_status, then policy_read, then search_text
    expect(stats.toolFrequencies).toEqual([
      { tool: "workspace_status", count: 2 },
      { tool: "policy_read", count: 2 },
      { tool: "search_text", count: 1 },
    ]);
  });

  it("aggregates write actions and commits", () => {
    const base = 1700000000000;
    const t1 = makeTrace({
      id: 1,
      timestamp_ms: base,
      tool_name: "apply_change_set",
      affected_paths: ["tasks/001.md"],
      resulting_commit: "commit-abc",
    });

    const run: TraceRun = {
      id: "run-1-1",
      start_timestamp_ms: base,
      end_timestamp_ms: base + 500,
      traces: [t1],
    };

    const stats = computeRunStats(run);
    expect(stats.hasWrites).toBe(true);
    expect(stats.resultingCommits).toEqual(["commit-abc"]);
    expect(stats.affectedPaths).toEqual(["tasks/001.md"]);
  });
});
