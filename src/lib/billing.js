// PLACEHOLDER billing module — no real payment processor is wired in anywhere, and this
// deliberately does not simulate one completing. startCheckout() is the seam: once a real
// processor exists, this is the one function to rewrite — BillingScreen.jsx just calls it and
// reacts to whether checkout is connected, nothing UI-side should need to change.
//
// Why the signature looks the way it does: a web checkout would create a Stripe Checkout Session
// server-side and redirect the browser to its returned URL. A native iOS/Android build generally
// can't use Stripe directly for a digital subscription — Apple/Google require their own in-app
// purchase systems instead. Keeping "start checkout for this league" as one processor-agnostic
// call (leagueId + plan in, a result out) means that split happens inside this file later,
// not across the UI.

// Single placeholder plan for now — one purchase per league, covers every member in it. Price/
// copy are illustrative only, easy to tweak here without touching any UI code.
export const PLAN = {
  id: "league-pass",
  name: "League Pass",
  price: 24.99,
  currency: "USD",
  interval: "season",
  features: [
    "Create your fantasy league",
    "Invite your entire league for free",
    "Track side bets automatically",
    "Keep a running “who owes who” ledger",
    "Keep your league history",
  ],
};

// No processor is connected yet, so this always resolves { connected: false } rather than
// faking a completed purchase — BillingScreen shows an honest "checkout isn't live yet" state.
// Once Stripe (or a native IAP flow) is wired up, this becomes an async call that either
// redirects the browser to a real Checkout Session URL or kicks off the platform purchase flow,
// resolving { connected: true } (or throwing) instead.
export async function startCheckout(leagueId, plan = PLAN) {
  return { connected: false, leagueId, planId: plan.id };
}
