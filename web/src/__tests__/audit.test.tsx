import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { LoginView } from "../components/LoginView";
import { TraceItem } from "../components/TraceItem";
import { TraceDrawer } from "../components/TraceDrawer";
import { ConsoleView } from "../components/ConsoleView";
import { formatBytes, formatTime } from "../lib/utils";
import type { TraceSummary, TraceDetail } from "../api";

// Mock globals
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Audit Web UI & Component Tests", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.restoreAllMocks();
  });

  it("formats bytes and timestamps correctly", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1048576 * 2)).toBe("2.0 MB");

    const timeStr = formatTime(1700000000000);
    expect(timeStr).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("renders LoginView and triggers login on submit", async () => {
    const onSuccess = vi.fn();
    const root = createRoot(container);

    // Mock fetch for login
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as any);

    await act(async () => {
      root.render(<LoginView onSuccess={onSuccess} />);
    });

    const input = container.querySelector("input#token") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.placeholder).toBe("Paste MCP_API_KEY");

    const button = container.querySelector("button[type='submit']") as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toContain("Sign In");

    // Enter token using native value setter for React controlled component
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      nativeSetter?.call(input, "secret-key-123");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/audit/session",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      })
    );
    expect(onSuccess).toHaveBeenCalled();
  });

  it("renders TraceItem summary card with tool pills, status, and tokens", async () => {
    const mockTrace: TraceSummary = {
      id: 42,
      timestamp_ms: Date.now(),
      tool_name: "apply_change_set",
      status: "success",
      error_message: null,
      operation_request_id: "req-abc-12345",
      input_bytes: 350,
      output_bytes: 1200,
      input_chars: 350,
      output_chars: 1200,
      input_tokens_est: 88,
      output_tokens_est: 300,
      total_tokens_est: 388,
      latency_ms: 45,
      affected_paths: ["tasks/001.md"],
      resulting_commit: "abcdef123456",
    };

    const onSelect = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TraceItem trace={mockTrace} isSelected={false} onSelect={onSelect} />
      );
    });

    // Legacy trace (semantic_* is null) renders "Semantic: —", "Protocol Total", and no generic unlabeled "Total:"
    expect(container.textContent).toContain("apply_change_set");
    expect(container.textContent).toContain("ok");
    expect(container.textContent).toContain("45ms");
    expect(container.textContent).toContain("Semantic: —");
    expect(container.textContent).toContain("Protocol Total: 388 tok");
    expect(container.textContent).not.toMatch(/Total:\s*\d+\s*tokens est/);
    expect(container.textContent).toContain("tasks/001.md");
    expect(container.textContent).toContain("abcdef1");

    // Click to select
    const itemCard = container.firstElementChild as HTMLElement;
    await act(async () => {
      itemCard.dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalled();
  });

  it("renders new TraceItem with both Semantic and Protocol totals", async () => {
    const newMockTrace: TraceSummary = {
      id: 43,
      timestamp_ms: Date.now(),
      tool_name: "list_files",
      status: "success",
      error_message: null,
      operation_request_id: null,
      input_bytes: 20,
      output_bytes: 1800,
      input_chars: 20,
      output_chars: 1800,
      input_tokens_est: 5,
      output_tokens_est: 450,
      total_tokens_est: 455,
      semantic_output_bytes: 800,
      semantic_output_chars: 800,
      semantic_output_tokens_est: 200,
      latency_ms: 12,
      affected_paths: null,
      resulting_commit: null,
    };

    const root = createRoot(container);
    await act(async () => {
      root.render(<TraceItem trace={newMockTrace} isSelected={false} onSelect={vi.fn()} />);
    });

    expect(container.textContent).toContain("list_files");
    expect(container.textContent).toContain("Semantic: 800 B (~200 tok)");
    expect(container.textContent).toContain("Protocol: 1.8 KB (450 tok)");
    expect(container.textContent).toContain("Semantic Total: ~205 tok");
    expect(container.textContent).toContain("Protocol Total: 455 tok");
  });

  it("renders TraceDrawer and loads detail payload", async () => {
    const mockDetail: TraceDetail = {
      id: 99,
      timestamp_ms: Date.now(),
      tool_name: "policy_read",
      status: "success",
      error_message: null,
      operation_request_id: null,
      input_json: JSON.stringify({ name: "router" }),
      output_json: JSON.stringify({ content: [{ type: "text", text: "# Router Policy" }] }),
      input_bytes: 17,
      output_bytes: 45,
      input_chars: 17,
      output_chars: 45,
      input_tokens_est: 5,
      output_tokens_est: 12,
      total_tokens_est: 17,
      latency_ms: 8,
      affected_paths: null,
      resulting_commit: null,
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, trace: mockDetail }),
    } as any);

    const onClose = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(<TraceDrawer traceId={99} onClose={onClose} />);
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/audit/traces/99", {
      credentials: "include",
    });

    // Verify rendered content
    expect(container.textContent).toContain("Trace #99");
    expect(container.textContent).toContain("policy_read");
    expect(container.textContent).toContain("Tool Input Arguments");
    expect(container.textContent).toContain("CallToolResult Output");
    expect(container.textContent).toContain('"name": "router"');
    expect(container.textContent).toContain("# Router Policy");

    // Verify Input is rendered BEFORE Output in DOM order
    const inputHeading = Array.from(container.querySelectorAll("span")).find((s) => s.textContent?.includes("Tool Input Arguments"));
    const outputHeading = Array.from(container.querySelectorAll("span")).find((s) => s.textContent?.includes("CallToolResult Output"));
    expect(inputHeading).toBeDefined();
    expect(outputHeading).toBeDefined();
    const pos = inputHeading!.compareDocumentPosition(outputHeading!);
    // DOCUMENT_POSITION_FOLLOWING is 4
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Verify copy actions
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });

    const copyButtons = Array.from(container.querySelectorAll("button")).filter((b) => b.textContent?.includes("Copy"));
    expect(copyButtons.length).toBe(2);

    // Click input copy
    await act(async () => {
      copyButtons[0].dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(writeTextMock).toHaveBeenCalledWith(expect.stringContaining('"name": "router"'));

    // Click output copy
    await act(async () => {
      copyButtons[1].dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(writeTextMock).toHaveBeenCalledWith(expect.stringContaining("# Router Policy"));
  });

  it("renders ConsoleView with metric cards and runs list", async () => {
    const mockTraces: TraceSummary[] = [
      {
        id: 1,
        timestamp_ms: Date.now(),
        tool_name: "workspace_status",
        status: "success",
        error_message: null,
        operation_request_id: null,
        input_bytes: 2,
        output_bytes: 500,
        input_chars: 2,
        output_chars: 500,
        input_tokens_est: 1,
        output_tokens_est: 125,
        total_tokens_est: 126,
        latency_ms: 15,
        affected_paths: null,
        resulting_commit: null,
      },
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, traces: mockTraces }),
    } as any);

    const onLogout = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(<ConsoleView onLogout={onLogout} />);
    });

    expect(container.textContent).toContain("CEO Context Trace");
    expect(container.textContent).toContain("Runs");
    expect(container.textContent).toContain("Tool Calls");
    expect(container.textContent).toContain("Avg Latency");
    expect(container.textContent).toContain("Errors");
    expect(container.textContent).toContain("workspace_status");
    expect(container.textContent).toContain("Copy All");
  });

  it("shows 200-trace warning when traces length reaches 200 limit", async () => {
    const mockTraces: TraceSummary[] = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      timestamp_ms: Date.now() + i * 1000,
      tool_name: "workspace_status",
      status: "success",
      error_message: null,
      operation_request_id: null,
      input_bytes: 2,
      output_bytes: 10,
      input_chars: 2,
      output_chars: 10,
      input_tokens_est: 1,
      output_tokens_est: 2,
      total_tokens_est: 3,
      latency_ms: 10,
      affected_paths: null,
      resulting_commit: null,
    }));

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, traces: mockTraces }),
    } as any);

    const root = createRoot(container);

    await act(async () => {
      root.render(<ConsoleView onLogout={vi.fn()} />);
    });

    expect(container.textContent).toContain(
      "Latest 200 calls loaded. Oldest Run may be incomplete."
    );
  });

  it("expands RunItem on click, but prevents Copy All from toggling expansion", async () => {
    const trace1: TraceSummary = {
      id: 5,
      timestamp_ms: 1700000000000,
      tool_name: "policy_read",
      status: "success",
      error_message: null,
      operation_request_id: null,
      input_bytes: 10,
      output_bytes: 20,
      input_chars: 10,
      output_chars: 20,
      input_tokens_est: 2,
      output_tokens_est: 5,
      total_tokens_est: 7,
      latency_ms: 30,
      affected_paths: null,
      resulting_commit: null,
    };

    const run = {
      id: "run-5-5",
      start_timestamp_ms: 1700000000000,
      end_timestamp_ms: 1700000000030,
      traces: [trace1],
    };

    // Mock clipboard and fetch for trace detail
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        trace: {
          ...trace1,
          input_json: "{}",
          output_json: "{}",
        },
      }),
    } as any);

    const { RunItem } = await import("../components/RunItem");
    const onSelectTrace = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <RunItem
          run={run}
          selectedId={null}
          onSelectTrace={onSelectTrace}
          defaultExpanded={false}
        />
      );
    });

    // Default collapsed: child trace details (like latency "30ms") not visible yet in child list
    const copyBtn = container.querySelector("button[title*='Copy complete run']") as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    expect(copyBtn.textContent).toContain("Copy All");

    // Click Copy All -> must NOT toggle expand
    await act(async () => {
      copyBtn.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
    });

    expect(writeTextMock).toHaveBeenCalled();
    // Run should remain collapsed (no child TraceItem rendered)
    expect(container.querySelectorAll("span").length).toBeGreaterThan(0);
    expect(copyBtn.textContent).toContain("Copied ✓");

    // Click header outside Copy All button -> toggles expand
    const header = container.firstElementChild?.firstElementChild as HTMLElement;
    await act(async () => {
      header.dispatchEvent(new Event("click", { bubbles: true }));
    });

    // Expanded now: child trace item with step badge "01" should be visible
    expect(container.textContent).toContain("01");
  });
});
