// Drop-in replacements for leaguesApi.js / membersApi.js / betsApi.js used only in Demo Mode.
// Same function signatures as the real modules, backed by in-memory state instead of Supabase,
// so LeagueSportsbook.jsx's call sites don't need to know which one they're talking to.

import {
  DEMO_USER_ID, DEMO_LEAGUE_DB_ID, DEMO_SLEEPER_LEAGUE_ID, DEMO_CURRENT_WEEK, DEMO_SEASON,
  DEMO_MEMBERS, DEMO_SEED_BETS, DEMO_SEED_POOL_ENTRIES, DEMO_SEED_POOL_PICKS,
  DEMO_SEED_SURVIVOR_ENTRIES, DEMO_SEED_SURVIVOR_PICKS, otherManagerId,
} from "./demoData.js";

let demoLeagueRow = {
  id: DEMO_LEAGUE_DB_ID,
  sleeper_league_id: DEMO_SLEEPER_LEAGUE_ID,
  name: "Demo League",
  season: DEMO_SEASON,
  nfl_season_type: "regular",
  scoring_field: "pts_ppr",
  scoring_label: "PPR",
  projection_season: DEMO_SEASON,
  current_week: DEMO_CURRENT_WEEK,
  pool_entry_fee: 5,
  survivor_entry_fee: 5,
  created_by: DEMO_USER_ID,
  owner_id: DEMO_USER_ID,
  subscription_status: "active",
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
  async upsertLeague(_sleeperLeagueId, fields = {}) {
    demoLeagueRow = { ...demoLeagueRow, ...fields };
    return demoLeagueRow;
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
  async findMyMemberships(userId) {
    if (userId !== DEMO_USER_ID) return [];
    return [{ leagues: demoLeagueRow }];
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

let poolEntryRows = DEMO_SEED_POOL_ENTRIES.map((e) => ({ ...e }));
let poolPickRows = DEMO_SEED_POOL_PICKS.map((p) => ({ ...p }));
const poolEntryBus = makePubSub();
const poolPickBus = makePubSub();
let demoPoolSeq = 3000;

export const demoPoolApi = {
  dbRowToEntry(row) {
    return row;
  },
  dbRowToPick(row) {
    return row;
  },
  async fetchEntries() {
    return poolEntryRows.map((e) => ({ ...e }));
  },
  async fetchPicks() {
    return poolPickRows.map((p) => ({ ...p }));
  },
  subscribeToEntries(_leagueId, onChange) {
    return poolEntryBus.subscribe(onChange);
  },
  subscribeToPicks(_leagueId, onChange) {
    return poolPickBus.subscribe(onChange);
  },
  async submitPicks(_leagueId, week, memberDbId, picksByQuestion) {
    let entry = poolEntryRows.find((e) => e.week === week && e.memberId === memberDbId);
    if (!entry) {
      demoPoolSeq += 1;
      entry = { id: `demo-pool-entry-${demoPoolSeq}`, week, memberId: memberDbId, paid: false };
      poolEntryRows = [...poolEntryRows, entry];
      poolEntryBus.notify({ eventType: "INSERT", new: entry, old: null });
    }

    Object.entries(picksByQuestion).forEach(([questionKey, pickMemberId]) => {
      const old = poolPickRows.find((p) => p.week === week && p.memberId === memberDbId && p.questionKey === questionKey);
      if (old) {
        const updated = { ...old, pickMemberId };
        poolPickRows = poolPickRows.map((p) => (p.id === old.id ? updated : p));
        poolPickBus.notify({ eventType: "UPDATE", new: updated, old });
      } else {
        demoPoolSeq += 1;
        const row = { id: `demo-pool-pick-${demoPoolSeq}`, week, memberId: memberDbId, questionKey, pickMemberId };
        poolPickRows = [...poolPickRows, row];
        poolPickBus.notify({ eventType: "INSERT", new: row, old: null });
      }
    });
  },
  async setPaid(entryId, paid) {
    const old = poolEntryRows.find((e) => e.id === entryId);
    if (!old) return;
    const updated = { ...old, paid };
    poolEntryRows = poolEntryRows.map((e) => (e.id === entryId ? updated : e));
    poolEntryBus.notify({ eventType: "UPDATE", new: updated, old });
  },
};

let survivorEntryRows = DEMO_SEED_SURVIVOR_ENTRIES.map((e) => ({ ...e }));
let survivorPickRows = DEMO_SEED_SURVIVOR_PICKS.map((p) => ({ ...p }));
const survivorEntryBus = makePubSub();
const survivorPickBus = makePubSub();
let demoSurvivorSeq = 4000;

export const demoSurvivorApi = {
  dbRowToEntry(row) {
    return row;
  },
  dbRowToPick(row) {
    return row;
  },
  async fetchEntries() {
    return survivorEntryRows.map((e) => ({ ...e }));
  },
  async fetchPicks() {
    return survivorPickRows.map((p) => ({ ...p }));
  },
  subscribeToEntries(_leagueId, onChange) {
    return survivorEntryBus.subscribe(onChange);
  },
  subscribeToPicks(_leagueId, onChange) {
    return survivorPickBus.subscribe(onChange);
  },
  async submitPick(_leagueId, week, memberDbId, pickMemberDbId) {
    let entry = survivorEntryRows.find((e) => e.memberId === memberDbId);
    if (!entry) {
      demoSurvivorSeq += 1;
      entry = { id: `demo-survivor-entry-${demoSurvivorSeq}`, memberId: memberDbId, paid: false };
      survivorEntryRows = [...survivorEntryRows, entry];
      survivorEntryBus.notify({ eventType: "INSERT", new: entry, old: null });
    }

    const old = survivorPickRows.find((p) => p.week === week && p.memberId === memberDbId);
    if (old) {
      const updated = { ...old, pickMemberId: pickMemberDbId };
      survivorPickRows = survivorPickRows.map((p) => (p.id === old.id ? updated : p));
      survivorPickBus.notify({ eventType: "UPDATE", new: updated, old });
    } else {
      demoSurvivorSeq += 1;
      const row = { id: `demo-survivor-pick-${demoSurvivorSeq}`, week, memberId: memberDbId, pickMemberId: pickMemberDbId };
      survivorPickRows = [...survivorPickRows, row];
      survivorPickBus.notify({ eventType: "INSERT", new: row, old: null });
    }
  },
  async setPaid(entryId, paid) {
    const old = survivorEntryRows.find((e) => e.id === entryId);
    if (!old) return;
    const updated = { ...old, paid };
    survivorEntryRows = survivorEntryRows.map((e) => (e.id === entryId ? updated : e));
    survivorEntryBus.notify({ eventType: "UPDATE", new: updated, old });
  },
};
