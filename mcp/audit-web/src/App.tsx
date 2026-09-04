import React, { useEffect, useState } from "react";
import { checkSession } from "./api";
import { LoginView } from "./components/LoginView";
import { ConsoleView } from "./components/ConsoleView";
import { Loader2 } from "lucide-react";

export const App: React.FC = () => {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    checkSession().then((isAuth) => setAuthenticated(isAuth));
  }, []);

  if (authenticated === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <Loader2 className="h-6 w-6 animate-spin text-neutral-400" />
      </div>
    );
  }

  if (!authenticated) {
    return <LoginView onSuccess={() => setAuthenticated(true)} />;
  }

  return <ConsoleView onLogout={() => setAuthenticated(false)} />;
};

export default App;
