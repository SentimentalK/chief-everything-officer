import React, { useEffect, useState } from "react";
import { LogOut, ShieldAlert, ShieldCheck } from "lucide-react";
import { checkSession, logout, type AuditSessionState } from "../api";

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

interface LoginViewProps {
  onSuccess: () => void;
  onLogout?: () => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onSuccess, onLogout }) => {
  const [session, setSession] = useState<AuditSessionState | null>(null);

  useEffect(() => {
    checkSession().then((state) => {
      setSession(state);
      if (state.authenticated && state.authorized) {
        onSuccess();
      }
    });
  }, [onSuccess]);

  const handleLogout = async () => {
    await logout();
    setSession({ authenticated: false, authorized: false });
    onLogout?.();
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
            Sign in with GitHub. Audit is limited to admin users.
          </p>
        </div>

        {session?.authenticated && !session.authorized ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-md border border-red-900/50 bg-red-950/40 p-2.5 text-xs text-red-300">
              <ShieldAlert className="h-4 w-4 shrink-0 text-red-400" />
              <span>
                Signed in{session.user?.id ? ` as ${session.user.id}` : ""}, but this account
                is not authorized for Audit.
              </span>
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
          <a
            href="/auth/github?next=/audit"
            className="flex w-full items-center justify-center gap-2 rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 transition hover:bg-neutral-200"
          >
            <GithubIcon className="h-4 w-4" />
            Continue with GitHub
          </a>
        )}
      </div>
    </div>
  );
};
