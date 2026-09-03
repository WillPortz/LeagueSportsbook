import { useEffect, useState } from "react";
import { getSession, onAuthChange } from "./lib/auth.js";
import { DEMO_USER_ID } from "./lib/demoData.js";
import AuthScreen from "./components/AuthScreen.jsx";
import SideLines from "./SideLines.jsx";

const DEMO_SESSION = { user: { id: DEMO_USER_ID } };

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    getSession().then((s) => {
      setSession(s);
      setLoading(false);
    });
    const { data: sub } = onAuthChange(setSession);
    return () => sub.subscription.unsubscribe();
  }, []);

  if (loading) return <div className="sb-root" />;
  if (demo) return <SideLines demo session={DEMO_SESSION} onExitDemo={() => setDemo(false)} />;
  if (!session) return <AuthScreen onDemo={() => setDemo(true)} />;
  return <SideLines session={session} />;
}
