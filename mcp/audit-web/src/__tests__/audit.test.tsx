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

    expect(container.textContent).toContain("apply_change_set");
    expect(container.textContent).toContain("ok");
    expect(container.textContent).toContain("45ms");
    expect(container.textContent).toContain("388 tokens est");
    expect(container.textContent).toContain("tasks/001.md");
    expect(container.textContent).toContain("abcdef1");

    // Click to select
    const itemCard = container.firstElementChild as HTMLElement;
    await act(async () => {
      itemCard.dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalled();
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

  it("renders ConsoleView with metric cards and trace list", async () => {
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
    expect(container.textContent).toContain("Invocations");
    expect(container.textContent).toContain("workspace_status");
  });
});
