import React, { useState } from "react";
import { KeyRound, ShieldCheck, Loader2 } from "lucide-react";
import { login } from "../api";

interface LoginViewProps {
  onSuccess: () => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onSuccess }) => {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;

    setLoading(true);
    setError(null);

    const res = await login(token.trim());
    setLoading(false);

    if (res.ok) {
      onSuccess();
    } else {
      setError(res.error || "Authentication failed. Check your MCP_API_KEY.");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4 bg-black text-white">
      <div className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-900/90 p-6 shadow-2xl backdrop-blur">
        <div className="flex flex-col items-center text-center space-y-2 mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-neutral-800 border border-neutral-700">
            <ShieldCheck className="h-6 w-6 text-neutral-300" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-100">
            CEO Audit Console
          </h1>
          <p className="text-xs text-neutral-400">
            Enter your MCP_API_KEY to access runtime traces
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="token"
              className="text-xs font-medium text-neutral-300 flex items-center gap-1.5"
            >
              <KeyRound className="h-3.5 w-3.5 text-neutral-400" />
              API Key
            </label>
            <input
              id="token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste MCP_API_KEY"
              autoComplete="off"
              autoFocus
              className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 font-mono"
            />
          </div>

          {error && (
            <div className="rounded-md border border-red-900/50 bg-red-950/40 p-2.5 text-xs text-red-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !token.trim()}
            className="flex w-full items-center justify-center rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Verifying...
              </>
            ) : (
              "Sign In"
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
