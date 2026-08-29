import { useEffect, useState } from "react";
import { getSession, onAuthChange } from "./lib/auth.js";
import AuthScreen from "./components/AuthScreen.jsx";
import LeagueSportsbook from "./LeagueSportsbook.jsx";

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSession().then((s) => {
      setSession(s);
      setLoading(false);
    });
    const { data: sub } = onAuthChange(setSession);
    return () => sub.subscription.unsubscribe();
  }, []);

  if (loading) return <div className="sb-root" />;
  if (!session) return <AuthScreen />;
  return <LeagueSportsbook session={session} />;
}
