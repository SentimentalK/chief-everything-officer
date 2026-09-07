import type { TraceDetail } from "../api";
import { fetchTraceDetail } from "../api";
import { type TraceRun, computeRunStats } from "./groupTraces";

function formatFullDateTime(timestampMs: number): string {
  const d = new Date(timestampMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const mins = String(d.getMinutes()).padStart(2, "0");
  const secs = String(d.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
}

function formatTraceTime(timestampMs: number): string {
  const d = new Date(timestampMs);
  const hours = String(d.getHours()).padStart(2, "0");
  const mins = String(d.getMinutes()).padStart(2, "0");
  const secs = String(d.getSeconds()).padStart(2, "0");
  return `${hours}:${mins}:${secs}`;
}

function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

/**
 * Fetches all full TraceDetail records for the given Run and formats them as a single Markdown document.
 * If any fetch fails, throws an error so the caller can fail visibly without partial silent exports.
 */
export async function formatRunMarkdown(
  run: TraceRun,
  fetchDetail: (id: number) => Promise<TraceDetail> = fetchTraceDetail
): Promise<string> {
  // Fetch details concurrently
  const details = await Promise.all(run.traces.map((t) => fetchDetail(t.id)));

  // Ensure chronological order (oldest first)
  details.sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  const stats = computeRunStats(run);

  const lines: string[] = [
    "# CEO Audit Run",
    "",
    `Start: ${formatFullDateTime(run.start_timestamp_ms)}`,
    `End: ${formatFullDateTime(run.end_timestamp_ms)}`,
    `Duration: ${stats.durationFormatted}`,
    `Tool Calls: ${stats.totalCalls}`,
    `Errors: ${stats.errorCount}`,
    "",
    "## Tool Summary",
    "",
  ];

  for (const { tool, count } of stats.toolFrequencies) {
    lines.push(`- ${tool} × ${count}`);
  }

  lines.push("", "---");

  const padLength = Math.max(2, String(details.length).length);

  details.forEach((detail, index) => {
    const stepNum = String(index + 1).padStart(padLength, "0");
    lines.push("");
    lines.push(`## ${stepNum} — ${detail.tool_name}`);
    lines.push("");
    lines.push(`Time: ${formatTraceTime(detail.timestamp_ms)}`);
    lines.push(`Status: ${detail.status}`);
    lines.push(`Latency: ${detail.latency_ms}ms`);
    lines.push(`Trace ID: ${detail.id}`);

    if (detail.operation_request_id) {
      lines.push(`Operation Request ID: ${detail.operation_request_id}`);
    }
    if (detail.affected_paths && detail.affected_paths.length > 0) {
      lines.push(`Affected Paths: ${detail.affected_paths.join(", ")}`);
    }
    if (detail.resulting_commit) {
      lines.push(`Resulting Commit: ${detail.resulting_commit}`);
    }
    if (detail.error_message) {
      lines.push(`Error: ${detail.error_message}`);
    }

    lines.push("");
    lines.push("### Input");
    lines.push("");
    lines.push("```json");
    lines.push(formatJson(detail.input_json));
    lines.push("```");
    lines.push("");
    lines.push("### Output");
    lines.push("");
    lines.push("```json");
    lines.push(formatJson(detail.output_json));
    lines.push("```");
    lines.push("");
    lines.push("---");
  });

  return lines.join("\n");
}

export async function copyRunToClipboard(
  run: TraceRun,
  fetchDetail: (id: number) => Promise<TraceDetail> = fetchTraceDetail
): Promise<void> {
  const markdown = await formatRunMarkdown(run, fetchDetail);
  await navigator.clipboard.writeText(markdown);
}
