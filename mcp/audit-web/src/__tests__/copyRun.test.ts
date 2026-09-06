import { describe, it, expect, vi } from "vitest";
import { formatRunMarkdown, copyRunToClipboard } from "../lib/copyRun";
import type { TraceRun } from "../lib/groupTraces";
import type { TraceDetail, TraceSummary } from "../api";

describe("copyRun", () => {
  const baseTime = 1700000000000;

  const mockSummary1: TraceSummary = {
    id: 10,
    timestamp_ms: baseTime,
    tool_name: "workspace_status",
    status: "success",
    error_message: null,
    operation_request_id: "req-1",
    input_bytes: 10,
    output_bytes: 50,
    input_chars: 10,
    output_chars: 50,
    input_tokens_est: 2,
    output_tokens_est: 10,
    total_tokens_est: 12,
    latency_ms: 50,
    affected_paths: null,
    resulting_commit: null,
  };

  const mockSummary2: TraceSummary = {
    id: 11,
    timestamp_ms: baseTime + 1000,
    tool_name: "apply_change_set",
    status: "error",
    error_message: "conflict in file",
    operation_request_id: "req-2",
    input_bytes: 40,
    output_bytes: 80,
    input_chars: 40,
    output_chars: 80,
    input_tokens_est: 8,
    output_tokens_est: 16,
    total_tokens_est: 24,
    latency_ms: 120,
    affected_paths: ["tasks/001.md"],
    resulting_commit: "abcdef1",
  };

  const mockRun: TraceRun = {
    id: "run-10-11",
    start_timestamp_ms: baseTime,
    end_timestamp_ms: baseTime + 1120,
    traces: [mockSummary1, mockSummary2],
  };

  const mockDetails: Record<number, TraceDetail> = {
    10: {
      ...mockSummary1,
      input_json: JSON.stringify({ verbose: false }),
      output_json: JSON.stringify({ clean: true }),
    },
    11: {
      ...mockSummary2,
      input_json: JSON.stringify({ path: "tasks/001.md" }),
      output_json: JSON.stringify({ error: "conflict" }),
    },
  };

  it("formats full Markdown document from Run details", async () => {
    const fetchDetailMock = vi.fn().mockImplementation(async (id: number) => {
      return mockDetails[id];
    });

    const markdown = await formatRunMarkdown(mockRun, fetchDetailMock);

    // Verify all traces were fetched
    expect(fetchDetailMock).toHaveBeenCalledWith(10);
    expect(fetchDetailMock).toHaveBeenCalledWith(11);

    // Header checks
    expect(markdown).toContain("# CEO Audit Run");
    expect(markdown).toContain("Tool Calls: 2");
    expect(markdown).toContain("Errors: 1");

    // Tool summary checks
    expect(markdown).toContain("## Tool Summary");
    expect(markdown).toContain("- workspace_status × 1");
    expect(markdown).toContain("- apply_change_set × 1");

    // Trace 01
    expect(markdown).toContain("## 01 — workspace_status");
    expect(markdown).toContain("Trace ID: 10");
    expect(markdown).toContain("Latency: 50ms");
    expect(markdown).toContain('"verbose": false');
    expect(markdown).toContain('"clean": true');

    // Trace 02
    expect(markdown).toContain("## 02 — apply_change_set");
    expect(markdown).toContain("Trace ID: 11");
    expect(markdown).toContain("Status: error");
    expect(markdown).toContain("Error: conflict in file");
    expect(markdown).toContain("Affected Paths: tasks/001.md");
    expect(markdown).toContain("Resulting Commit: abcdef1");
    expect(markdown).toContain('"path": "tasks/001.md"');
  });

  it("rejects and does not export partial markdown if any detail fetch fails", async () => {
    const fetchDetailMock = vi.fn().mockImplementation(async (id: number) => {
      if (id === 11) throw new Error("Network failure");
      return mockDetails[id];
    });

    await expect(formatRunMarkdown(mockRun, fetchDetailMock)).rejects.toThrow("Network failure");
  });

  it("copies markdown to clipboard successfully", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });

    const fetchDetailMock = vi.fn().mockImplementation(async (id: number) => {
      return mockDetails[id];
    });

    await copyRunToClipboard(mockRun, fetchDetailMock);

    expect(writeTextMock).toHaveBeenCalled();
    const copiedText = writeTextMock.mock.calls[0][0];
    expect(copiedText).toContain("# CEO Audit Run");
    expect(copiedText).toContain("workspace_status");
  });
});
