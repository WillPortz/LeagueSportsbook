// Drop-in replacements for leaguesApi.js / membersApi.js / betsApi.js used only in Demo Mode.
// Same function signatures as the real modules, backed by in-memory state instead of Supabase,
// so LeagueSportsbook.jsx's call sites don't need to know which one they're talking to.

import {
  DEMO_USER_ID, DEMO_LEAGUE_DB_ID, DEMO_SLEEPER_LEAGUE_ID, DEMO_CURRENT_WEEK, DEMO_SEASON,
  DEMO_MEMBERS, DEMO_SEED_BETS, otherManagerId,
} from "./demoData.js";

const DEMO_LEAGUE_ROW = {
  id: DEMO_LEAGUE_DB_ID,
  sleeper_league_id: DEMO_SLEEPER_LEAGUE_ID,
  name: "Demo League",
  season: DEMO_SEASON,
  nfl_season_type: "regular",
  scoring_field: "pts_ppr",
  scoring_label: "PPR",
  projection_season: DEMO_SEASON,
  current_week: DEMO_CURRENT_WEEK,
};

function makePubSub() {
  const listeners = new Set();
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    notify(payload) {
      listeners.forEach((cb) => cb(payload));
    },
  };
}

let memberRows = DEMO_MEMBERS.map((m) => ({ ...m }));
let betRows = DEMO_SEED_BETS.map((b) => ({ ...b }));
const memberBus = makePubSub();
const betBus = makePubSub();

export const demoLeaguesApi = {
  async upsertLeague() {
    return DEMO_LEAGUE_ROW;
  },
};

export const demoMembersApi = {
  dbRowToMember(row) {
    return row;
  },
  async syncMembersFromSleeper() {
    return memberRows;
  },
  async fetchMembers() {
    return memberRows.map((m) => ({ ...m }));
  },
  async findMyMembership(userId) {
    if (userId !== DEMO_USER_ID) return null;
    return { leagues: DEMO_LEAGUE_ROW };
  },
  async claimMember(memberDbId) {
    const row = memberRows.find((m) => m.dbId === memberDbId);
    return row ? { ...row } : null;
  },
  subscribeToMembers(_leagueId, onChange) {
    return memberBus.subscribe(onChange);
  },
};

function payoutFromOdds(stake, odds) {
  if (odds > 0) return Math.round(stake * odds / 100);
  return Math.round(stake * 100 / Math.abs(odds));
}

let demoTicketSeq = 2000;

export const demoBetsApi = {
  dbRowToBet(row) {
    return row;
  },
  async fetchBets() {
    return betRows.map((b) => ({ ...b }));
  },
  subscribeToBets(_leagueId, onChange) {
    return betBus.subscribe(onChange);
  },
  async insertBet(_leagueId, bet) {
    demoTicketSeq += 1;
    const row = {
      id: `demo-bet-${demoTicketSeq}`,
      ticket: demoTicketSeq,
      status: "pending",
      result: null,
      actual: null,
      ...bet,
      toWin: bet.toWin ?? (bet.odds != null ? payoutFromOdds(bet.stake, bet.odds) : null),
    };
    betRows = [row, ...betRows];
    betBus.notify({ eventType: "INSERT", new: row, old: null });

    if (!row.opponent) {
      const delay = 1500 + Math.random() * 1500;
      setTimeout(() => {
        const current = betRows.find((b) => b.id === row.id);
        if (!current || current.status !== "pending" || current.opponent) return;
        const acceptedRow = { ...current, status: "accepted", opponent: otherManagerId(current.creator) };
        betRows = betRows.map((b) => (b.id === row.id ? acceptedRow : b));
        betBus.notify({ eventType: "UPDATE", new: acceptedRow, old: current });
      }, delay);
    }
  },
  async updateBetStatus(betDbId, patch) {
    const old = betRows.find((b) => b.id === betDbId);
    if (!old) return;
    const updated = { ...old, ...patch };
    betRows = betRows.map((b) => (b.id === betDbId ? updated : b));
    betBus.notify({ eventType: "UPDATE", new: updated, old });
  },
};
