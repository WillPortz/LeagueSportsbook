import { useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { signIn, signUp } from "../lib/auth.js";

export default function AuthScreen({ onDemo }) {
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [signedUp, setSignedUp] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (mode === "signup") {
        const { error: err } = await signUp(email.trim(), password);
        if (err) throw err;
        setSignedUp(true);
      } else {
        const { error: err } = await signIn(email.trim(), password);
        if (err) throw err;
      }
    } catch (err) {
      setError(err.message || "Something went wrong — try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="sb-root">
      <div className="sb-setup">
        <div className="sb-setup-card">
          <h2>League Sportsbook</h2>
          <p>
            {mode === "signup"
              ? "Create your account to join your league's book."
              : "Sign in to see your bets and the shared ledger."}
          </p>

          {signedUp ? (
            <div className="sb-result-line" style={{ color: "#9ad6b3" }}>
              <Check size={12} /> Account created — check your email to confirm, then sign in.
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <div className="sb-field" style={{ color: "var(--paper)" }}>
                <label style={{ color: "#a9c4b6" }}>Email</label>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{ background: "#0e211b", color: "var(--paper)", borderColor: "var(--line)" }}
                />
              </div>
              <div className="sb-field" style={{ color: "var(--paper)" }}>
                <label style={{ color: "#a9c4b6" }}>Password</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={{ background: "#0e211b", color: "var(--paper)", borderColor: "var(--line)" }}
                />
              </div>

              {error && (
                <div className="sb-error-banner">
                  <AlertTriangle size={12} /> {error}
                </div>
              )}

              <div className="sb-form-actions">
                <button type="submit" className="sb-btn sb-btn-submit" disabled={loading}>
                  {loading ? "Please wait…" : mode === "signup" ? "Sign up" : "Sign in"}
                </button>
                <button
                  type="button"
                  className="sb-btn sb-btn-cancel"
                  style={{ color: "#a9c4b6", borderColor: "var(--line)" }}
                  onClick={() => {
                    setMode((m) => (m === "signup" ? "signin" : "signup"));
                    setError(null);
                  }}
                >
                  {mode === "signup" ? "Have an account? Sign in" : "New here? Sign up"}
                </button>
              </div>
            </form>
          )}

          <div className="sb-demo-cta">
            <span className="sb-demo-cta-divider">or</span>
            <button type="button" className="sb-btn sb-btn-demo" onClick={onDemo}>
              Try the demo →
            </button>
            <p className="sb-demo-cta-note">
              No account, no Sleeper league — jump straight into a fake league to look around.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
