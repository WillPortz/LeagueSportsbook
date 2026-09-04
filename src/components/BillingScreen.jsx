import { useState } from "react";
import { Check, X, ArrowRight, ShieldCheck, Lock, Users } from "lucide-react";
import { PLAN, startCheckout } from "../lib/billing.js";

// Pricing/checkout page — for-show only right now. No real payment processor is wired in; see
// src/lib/billing.js for the startCheckout() seam this screen calls. Nothing here gates access
// to anything else in the app — every exit (X, "Skip for now", "Back to my league") leads to a
// fully-usable league. They all require the confirmation phrase first, though, so leaving isn't
// a stray single click.
//
// Framed as buying access to SideLines for the league (an organizing tool), not as placing a
// wager — the pricing copy stays deliberately clear of "bet"/"odds"-style language even though
// the product itself tracks side bets.
export default function BillingScreen({ leagueName, demo, leagueId, onBack }) {
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutResult, setCheckoutResult] = useState(null);
  const [skipConfirmText, setSkipConfirmText] = useState("");
  const skipConfirmed = skipConfirmText.trim().toLowerCase() === "sidelines";

  async function handleCheckout() {
    setCheckingOut(true);
    try {
      const result = await startCheckout(leagueId, PLAN);
      setCheckoutResult(result);
    } finally {
      setCheckingOut(false);
    }
  }

  return (
    <div className="sb-billing-overlay">
      <div className="sb-billing-card">
        <button
          type="button"
          className="sb-billing-close"
          onClick={onBack}
          disabled={!skipConfirmed}
          aria-label="Close"
        >
          <X size={18} />
        </button>

        {/* 1. What am I buying */}
        <div className="sb-billing-kicker">League Pass</div>
        <h2 className="sb-billing-headline">Get SideLines for your whole league</h2>
        <p className="sb-billing-sub">
          One payment unlocks SideLines for every manager in {leagueName || "your league"} — nobody
          else pays a thing.
        </p>

        {/* 2. How much */}
        <div className="sb-billing-price-row">
          <div className="sb-billing-price">
            <span className="sb-billing-amount">${PLAN.price.toFixed(2)}</span>
            <span className="sb-billing-interval">/ {PLAN.interval}</span>
          </div>
          <span className="sb-billing-free-badge">
            <Users size={12} /> Free for everyone else in your league
          </span>
        </div>

        {/* 3. What do I get */}
        <ul className="sb-billing-features">
          {PLAN.features.map((f) => (
            <li key={f}><Check size={14} /> {f}</li>
          ))}
        </ul>

        {/* 4. Continue to checkout */}
        <button
          type="button"
          className="sb-billing-cta"
          onClick={handleCheckout}
          disabled={checkingOut}
        >
          {checkingOut ? (
            "One moment…"
          ) : (
            <>${PLAN.price.toFixed(2)} — Continue to Checkout <ArrowRight size={18} /></>
          )}
        </button>

        {checkoutResult && !checkoutResult.connected && (
          <p className="sb-billing-notice">
            Checkout isn't connected yet — this will take you to a real payment page once it's live.
          </p>
        )}

        {/* Bypass — payments aren't live yet, so this is the real way through for now. Every exit
            on this screen (X up top, this button, "Back to my league" below) stays disabled until
            this matches, so there's no frictionless way past it. The phrase is deliberately not
            shown anywhere — an aria-label (not a visible <label>) covers accessibility instead —
            so this is a genuine deliberate step, not a hint-and-click. */}
        <div className="sb-billing-skip-confirm">
          <input
            id="sb-billing-skip-input"
            type="text"
            className="sb-billing-skip-input"
            value={skipConfirmText}
            onChange={(e) => setSkipConfirmText(e.target.value)}
            aria-label="Confirmation phrase to skip for now"
            autoComplete="off"
          />
          <button
            type="button"
            className="sb-billing-skip"
            onClick={onBack}
            disabled={!skipConfirmed}
          >
            Skip for now
          </button>
        </div>
        <p className="sb-billing-skip-note">
          Payments aren't live yet — you'll have full access either way.
        </p>

        <div className="sb-billing-reassurance">
          <div className="sb-billing-reassurance-title">Simple. Secure. No hidden fees.</div>
          <p>
            You're paying for access to SideLines — SideLines never holds or transfers your
            league's wager money.
          </p>
        </div>

        <div className="sb-billing-trust">
          <div className="sb-billing-trust-item">
            <ShieldCheck size={16} />
            <div>
              <div className="sb-billing-trust-heading">Built for your league.</div>
              <p>SideLines keeps your league's side bets organized so nobody has to remember who owes who.</p>
            </div>
          </div>
          <div className="sb-billing-trust-item">
            <Lock size={16} />
            <div>
              <div className="sb-billing-trust-heading">No money transfers through SideLines.</div>
              <p>SideLines tracks your league's bets and balances. Payments between league members happen separately.</p>
            </div>
          </div>
        </div>

        {demo && (
          <p className="sb-billing-demo-note">Preview page — this is a demo league, nothing here is real.</p>
        )}

        <button
          type="button"
          className="sb-signout-link"
          onClick={onBack}
          disabled={!skipConfirmed}
        >
          Back to my league
        </button>
      </div>
    </div>
  );
}
