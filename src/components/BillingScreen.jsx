import { useState } from "react";
import { Check, X, ArrowRight, ShieldCheck, Lock, Users } from "lucide-react";
import { PLAN, startCheckout } from "../lib/billing.js";

// Pricing/checkout page — for-show only right now. No real payment processor is wired in; see
// src/lib/billing.js for the startCheckout() seam this screen calls. Nothing here gates access
// to anything else in the app — closing this overlay always returns to a fully-usable league.
//
// Framed as buying access to SideLines for the league (an organizing tool), not as placing a
// wager — the pricing copy stays deliberately clear of "bet"/"odds"-style language even though
// the product itself tracks side bets.
export default function BillingScreen({ leagueName, demo, leagueId, onBack }) {
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutResult, setCheckoutResult] = useState(null);

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
        <button type="button" className="sb-billing-close" onClick={onBack} aria-label="Close">
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

        <button type="button" className="sb-signout-link" onClick={onBack}>
          Back to my league
        </button>
      </div>
    </div>
  );
}
