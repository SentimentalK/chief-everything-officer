import React, { useEffect, useState } from "react";
import { checkSession } from "./api";
import { LoginView } from "./components/LoginView";
import { ConsoleView } from "./components/ConsoleView";
import { UserView } from "./components/UserView";
import { Loader2 } from "lucide-react";

export const App: React.FC = () => {
  const isAuditRoute =
    typeof window !== "undefined" && window.location.pathname.startsWith("/audit");

  if (!isAuditRoute) {
    return <UserView />;
  }

  return <AuditApp />;
};

const AuditApp: React.FC = () => {
  const [authorized, setAuthorized] = useState<boolean | null>(null);

  useEffect(() => {
    checkSession().then((state) => setAuthorized(state.authenticated && state.authorized));
  }, []);

  if (authorized === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <Loader2 className="h-6 w-6 animate-spin text-neutral-400" />
      </div>
    );
  }

  if (!authorized) {
    return <LoginView onSuccess={() => setAuthorized(true)} onLogout={() => setAuthorized(false)} />;
  }

  return <ConsoleView onLogout={() => setAuthorized(false)} />;
};

export default App;

