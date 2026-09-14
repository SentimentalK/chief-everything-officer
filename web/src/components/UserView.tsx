import React, { useEffect, useState } from "react";
import { CheckCircle2, LogOut, ShieldAlert, ArrowRight } from "lucide-react";
import { checkUserSession, logoutUser, type UserSessionState } from "../api";

const GithubIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
    <path d="M9 18c-4.51 2-5-2-7-2" />
  </svg>
);

export const UserView: React.FC = () => {
  const [session, setSession] = useState<UserSessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    // Check for error in query string
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    if (err) {
      setErrorMessage(err);
    }

    checkUserSession().then((s) => {
      setSession(s);
      setLoading(false);
    });
  }, []);

  const handleLogout = async () => {
    setLoading(true);
    await logoutUser();
    setSession({ authenticated: false });
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-neutral-400">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-200" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4 bg-black text-white">
      <div className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-900/90 p-6 shadow-2xl backdrop-blur">
        <div className="flex flex-col items-center text-center space-y-2 mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-neutral-800 border border-neutral-700">
            <GithubIcon className="h-6 w-6 text-neutral-200" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-100">
            Chief Everything Officer
          </h1>
          <p className="text-xs text-neutral-400">
            Product User Account & Identity
          </p>
        </div>

        {errorMessage && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-red-900/50 bg-red-950/40 p-2.5 text-xs text-red-300">
            <ShieldAlert className="h-4 w-4 shrink-0 text-red-400" />
            <span>{errorMessage}</span>
          </div>
        )}

        {session?.authenticated && session.user ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-4 space-y-3">
              <div className="flex items-center justify-between text-xs text-neutral-400">
                <span>Signed in with GitHub</span>
                <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Active
                </span>
              </div>

              <div className="border-t border-neutral-800 pt-3">
                <div className="text-sm font-semibold text-neutral-100">
                  @{session.user.provider_login || "unknown"}
                </div>
                <div className="text-xs font-mono text-neutral-400 truncate mt-0.5">
                  {session.user.id}
                </div>
              </div>

              <div className="rounded bg-neutral-900 px-2.5 py-1.5 text-center text-[11px] font-medium text-neutral-300 border border-neutral-800">
                Active CEO User Session
              </div>
            </div>

            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-neutral-700 bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-200 transition hover:bg-neutral-700"
            >
              <LogOut className="h-4 w-4" />
              Sign Out
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <a
              href="/auth/github"
              className="flex w-full items-center justify-center gap-2 rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 transition hover:bg-neutral-200"
            >
              <GithubIcon className="h-4 w-4" />
              Continue with GitHub
            </a>

            <div className="pt-2 text-center">
              <a
                href="/audit"
                className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300 transition"
              >
                Operator Audit Console
                <ArrowRight className="h-3 w-3" />
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
