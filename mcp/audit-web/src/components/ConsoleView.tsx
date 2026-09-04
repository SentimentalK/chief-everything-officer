import React, { useEffect, useState, useCallback } from "react";
import { RefreshCw, LogOut, Calendar, Activity, AlertCircle, Database } from "lucide-react";
import { fetchTraces, logout, type TraceSummary } from "../api";
import { TraceItem } from "./TraceItem";
import { TraceDrawer } from "./TraceDrawer";

interface ConsoleViewProps {
  onLogout: () => void;
}

export const ConsoleView: React.FC<ConsoleViewProps> = ({ onLogout }) => {
  const getTodayString = () => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const [dateStr, setDateStr] = useState<string>(getTodayString());
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTraces = useCallback(async (selectedDate: string) => {
    setLoading(true);
    setError(null);

    try {
      const from = new Date(`${selectedDate}T00:00:00`).getTime();
      const to = new Date(`${selectedDate}T23:59:59.999`).getTime();

      const data = await fetchTraces({ from, to, limit: 200 });
      setTraces(data);
      if (selectedId && !data.some((t) => t.id === selectedId)) {
        setSelectedId(null);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    loadTraces(dateStr);
  }, [dateStr, loadTraces]);

  const handleRefresh = () => {
    loadTraces(dateStr);
  };

  const handleToday = () => {
    const today = getTodayString();
    setDateStr(today);
  };

  const handleLogout = async () => {
    await logout();
    onLogout();
  };

  // Metrics summary
  const totalCalls = traces.length;
  const totalTokens = traces.reduce((acc, t) => acc + t.total_tokens_est, 0);
  const errorCount = traces.filter((t) => t.status === "error").length;
  const avgLatency =
    totalCalls > 0
      ? Math.round(traces.reduce((acc, t) => acc + t.latency_ms, 0) / totalCalls)
      : 0;

  return (
    <div className="flex flex-col min-h-screen bg-black text-neutral-100">
      {/* Top Navbar */}
      <header className="sticky top-0 z-20 border-b border-neutral-800 bg-neutral-950/80 backdrop-blur px-4 py-3">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-neutral-900 border border-neutral-800">
              <Activity className="h-4 w-4 text-neutral-300" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-tight text-neutral-100 flex items-center gap-2">
                CEO Context Trace
                <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] font-mono text-neutral-400 border border-neutral-800">
                  V0
                </span>
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Date filter */}
            <div className="flex items-center gap-1.5 bg-neutral-900 border border-neutral-800 rounded-md px-2 py-1 text-xs text-neutral-300">
              <Calendar className="h-3.5 w-3.5 text-neutral-400" />
              <input
                type="date"
                value={dateStr}
                onChange={(e) => setDateStr(e.target.value)}
                className="bg-transparent text-xs text-neutral-200 focus:outline-none font-mono"
              />
            </div>

            <button
              onClick={handleToday}
              className="rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800 transition"
            >
              Today
            </button>

            <button
              onClick={handleRefresh}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800 transition disabled:opacity-50"
              title="Refresh traces"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>

            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-400 hover:text-red-400 hover:border-red-900/50 hover:bg-red-950/20 transition"
              title="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 flex flex-col gap-4">
        {/* Metric Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
            <span className="text-xs text-neutral-500 font-medium">Invocations</span>
            <p className="text-xl font-mono font-semibold text-neutral-200 mt-0.5">
              {totalCalls}
            </p>
          </div>

          <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
            <span className="text-xs text-neutral-500 font-medium">Tokens Est</span>
            <p className="text-xl font-mono font-semibold text-neutral-200 mt-0.5">
              {totalTokens.toLocaleString()}
            </p>
          </div>

          <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
            <span className="text-xs text-neutral-500 font-medium">Avg Latency</span>
            <p className="text-xl font-mono font-semibold text-neutral-200 mt-0.5">
              {avgLatency}ms
            </p>
          </div>

          <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
            <span className="text-xs text-neutral-500 font-medium">Errors</span>
            <p
              className={`text-xl font-mono font-semibold mt-0.5 ${
                errorCount > 0 ? "text-red-400" : "text-neutral-200"
              }`}
            >
              {errorCount}
            </p>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-red-900/50 bg-red-950/40 p-3 text-xs text-red-300 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Content Layout: Split or List */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-[500px]">
          {/* Traces List */}
          <div
            className={`flex flex-col gap-2 ${
              selectedId ? "lg:col-span-5" : "lg:col-span-12"
            }`}
          >
            {traces.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-12 text-center rounded-lg border border-dashed border-neutral-800 bg-neutral-950/40">
                <Database className="h-8 w-8 text-neutral-600 mb-2" />
                <p className="text-sm font-medium text-neutral-400">No traces recorded</p>
                <p className="text-xs text-neutral-500 mt-1 max-w-sm">
                  Invocations from ChatGPT to CEO State MCP will automatically appear here.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {traces.map((trace) => (
                  <TraceItem
                    key={trace.id}
                    trace={trace}
                    isSelected={selectedId === trace.id}
                    onSelect={() =>
                      setSelectedId(selectedId === trace.id ? null : trace.id)
                    }
                  />
                ))}
              </div>
            )}
          </div>

          {/* Drawer / Detail View */}
          {selectedId && (
            <div className="lg:col-span-7 h-[calc(100vh-230px)] sticky top-[72px]">
              <TraceDrawer traceId={selectedId} onClose={() => setSelectedId(null)} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
