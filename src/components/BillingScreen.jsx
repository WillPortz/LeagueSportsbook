import { useState } from "react";
import { Check, X, ShieldCheck, AlertTriangle } from "lucide-react";
import { PLAN, subscribeLeague, getLeagueBillingStatus } from "../lib/billing.js";

// Pricing/checkout page — for-show only right now. No real payment processor is wired in; see
// src/lib/billing.js for the mock "subscribe" call this screen makes. Nothing here gates access
// to anything else in the app — closing this overlay always returns to a fully-usable league,
// subscribed or not.
export default function BillingScreen({ leagueName, ownerName, isOwner, demo, leagueId, onBack }) {
  const [status, setStatus] = useState(() => getLeagueBillingStatus(leagueId));
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubscribe() {
    setSubscribing(true);
    setError(null);
    try {
      await subscribeLeague(leagueId, PLAN);
      setStatus(getLeagueBillingStatus(leagueId));
    } catch {
      setError("Couldn't complete that — try again.");
    } finally {
      setSubscribing(false);
    }
  }

  return (
    <div className="sb-setup sb-billing-overlay">
      <div className="sb-setup-card sb-billing-card">
        <button type="button" className="sb-billing-close" onClick={onBack} aria-label="Close">
          <X size={16} />
        </button>

        <h2>League Season Pass</h2>
        <p>
          One person — the league owner — pays for the whole league. Nobody else in{" "}
          {leagueName} ever pays individually.
        </p>

        {demo && (
          <div className="sb-note" style={{ marginBottom: "1rem" }}>
            This is a preview page — nothing is charged, and nothing in the app is locked behind
            it, subscribed or not.
          </div>
        )}

        <div className="sb-plan-card">
          <div className="sb-plan-price">
            <span className="sb-plan-amount">${PLAN.price}</span>
            <span className="sb-plan-interval">/ {PLAN.interval}</span>
          </div>
          <ul className="sb-plan-features">
            {PLAN.features.map((f) => (
              <li key={f}><Check size={13} /> {f}</li>
            ))}
          </ul>
        </div>

        {status ? (
          <div className="sb-billing-success">
            <ShieldCheck size={18} />
            <div>
              <div className="sb-billing-success-title">You're all set!</div>
              <div className="sb-note" style={{ margin: 0 }}>
                {leagueName} is covered for the season. (This is a mock confirmation — no payment
                was actually processed.)
              </div>
            </div>
          </div>
        ) : isOwner ? (
          <>
            <div className="sb-form-actions">
              <button
                type="button"
                className="sb-btn sb-btn-submit"
                onClick={handleSubscribe}
                disabled={subscribing}
              >
                {subscribing ? "Processing…" : `Pay Now — $${PLAN.price}`}
              </button>
            </div>
            <p className="sb-note" style={{ marginTop: "0.6rem" }}>
              This is a placeholder — clicking Pay Now won't charge anything or ask for real
              payment info.
            </p>
          </>
        ) : (
          <div className="sb-note">
            {ownerName ? `${ownerName} is` : "Your league owner is"} the one who'd cover this —
            you won't be asked to pay individually.
          </div>
        )}

        {error && (
          <div className="sb-error-banner" style={{ marginTop: "0.75rem" }}>
            <AlertTriangle size={12} /> {error}
          </div>
        )}

        <button type="button" className="sb-signout-link" onClick={onBack}>
          Back to my league
        </button>
      </div>
    </div>
  );
}
