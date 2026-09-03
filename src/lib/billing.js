// PLACEHOLDER billing module — no real payment processor is wired in anywhere. Every function
// here is a mock: subscribeLeague "succeeds" instantly and just remembers the result in
// localStorage, scoped to this browser. Nothing here talks to Stripe, Apple/Google IAP, or any
// backend, and nothing in the rest of the app reads getLeagueBillingStatus to gate access.
//
// This file is the seam to replace when real billing gets built. The important thing is that
// SUBSCRIBING and CHECKING STATUS are already their own functions with a processor-agnostic
// signature (leagueId + plan in, a status out) — BillingScreen.jsx never touches localStorage or
// any processor SDK directly, it only calls these two functions. That split matters because the
// real implementation will very likely differ by platform: a web checkout can call out to a
// server that creates a Stripe Checkout session, but a native iOS/Android build generally can't
// use Stripe directly for a digital subscription — Apple/Google require their own in-app
// purchase systems instead. Swapping either or both of those in later means rewriting the guts
// of this one file; nothing about BillingScreen.jsx or its call sites should need to change.

const STORAGE_PREFIX = "sidelines_mock_billing_";

// Single placeholder plan for now — one purchase per league, covers every member in it. Price/
// cadence are illustrative only, easy to tweak here without touching any UI code.
export const PLAN = {
  id: "league-season-pass",
  name: "League Season Pass",
  price: 49,
  currency: "USD",
  interval: "season",
  features: [
    "Covers every manager in your league — nobody else pays individually",
    "Full access to Board, Matchup, and Bet Slips wagering",
    "Weekly Pool and Survivor Pool included",
    "Shared Ledger and season-long standings",
  ],
};

function storageKey(leagueId) {
  return `${STORAGE_PREFIX}${leagueId}`;
}

// Mock "checkout" — resolves after a short delay to feel like a real request, then marks the
// league subscribed in localStorage. Always succeeds; there is no failure path to mock since no
// real payment info is ever collected.
export async function subscribeLeague(leagueId, plan = PLAN) {
  await new Promise((resolve) => setTimeout(resolve, 600));
  try {
    localStorage.setItem(storageKey(leagueId), JSON.stringify({
      planId: plan.id,
      subscribedAt: new Date().toISOString(),
    }));
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) — the success state still shows
    // for this session, it just won't persist across a reload. Harmless for a mock.
  }
  return { ok: true };
}

export function getLeagueBillingStatus(leagueId) {
  try {
    const raw = localStorage.getItem(storageKey(leagueId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearLeagueBillingStatus(leagueId) {
  try {
    localStorage.removeItem(storageKey(leagueId));
  } catch {
    // no-op
  }
}
