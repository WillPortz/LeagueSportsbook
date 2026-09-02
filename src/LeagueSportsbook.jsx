import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  Check, X, Lock, Trophy, Plus, ChevronLeft, ChevronRight, ChevronDown, Users, User, ScrollText,
  Zap, RefreshCw, Link2, AlertTriangle, CalendarDays, TrendingUp, Swords, Coins, Skull,
} from "lucide-react";
import * as realLeaguesApi from "./lib/leaguesApi.js";
import * as realMembersApi from "./lib/membersApi.js";
import * as realBetsApi from "./lib/betsApi.js";
import * as realPoolApi from "./lib/poolApi.js";
import * as realSurvivorApi from "./lib/survivorApi.js";
import { demoLeaguesApi, demoMembersApi, demoBetsApi, demoPoolApi, demoSurvivorApi } from "./lib/demoApi.js";
import { DEMO_WEEK_CACHE, DEMO_PLAYERS, DEMO_PLAYOFF_TEAMS } from "./lib/demoData.js";
import { signOut, updateLastActiveLeague } from "./lib/auth.js";
import ClaimManagerScreen from "./components/ClaimManagerScreen.jsx";

const BUILD_STAMP = "DEV";
const REGULAR_SEASON_WEEKS = 18;
const PROJECTIONS_POLL_MS = 60000;

function resolveRegularSeasonSchedule(nflState, leagueData) {
  const season = Number(
    leagueData?.season
    || nflState?.league_season
    || nflState?.season
    || new Date().getFullYear(),
  );
  const nflType = nflState?.season_type || "regular";
  const leg = Number(leagueData?.settings?.leg) || 0;
  const status = leagueData?.status || "";

  let currentWeek = 1;
  if (status === "in_season" && leg >= 1) {
    currentWeek = Math.min(REGULAR_SEASON_WEEKS, leg);
  } else if (nflType === "regular") {
    currentWeek = Math.min(REGULAR_SEASON_WEEKS, Math.max(1, Number(nflState?.week) || 1));
  } else if (nflType === "post") {
    currentWeek = Math.min(REGULAR_SEASON_WEEKS, Math.max(1, Number(nflState?.week) || REGULAR_SEASON_WEEKS));
  }

  return {
    season,
    currentWeek,
    nflSeasonType: nflType,
    isRegularSeason: nflType === "regular" || (status === "in_season" && leg >= 1),
  };
}

function clampWeekToSeason(week, currentWeek) {
  const w = Number(week);
  if (!Number.isFinite(w) || w < 1) return currentWeek;
  return Math.min(currentWeek, Math.max(1, w));
}

function buildMembers(rosters, users) {
  const userMap = Object.fromEntries(users.map((u) => [u.user_id, u]));
  return rosters
    .filter((r) => r.owner_id)
    .map((r) => {
      const user = userMap[r.owner_id] || {};
      const teamName = user.metadata?.team_name;
      const displayName = user.display_name || `Manager ${r.roster_id}`;
      const wins = r.settings?.wins || 0;
      const losses = r.settings?.losses || 0;
      const ties = r.settings?.ties || 0;
      const gamesPlayed = wins + losses + ties;
      return {
        id: String(r.owner_id),
        rosterId: String(r.roster_id),
        name: teamName || displayName,
        displayName,
        teamName: teamName || null,
        seasonPts: r.settings?.fpts || 0,
        wins,
        losses,
        gamesPlayed,
        starters: (r.starters || []).filter((id) => id && id !== "0"),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}


function americanOdds(prob) {
  const p = Math.min(0.92, Math.max(0.08, prob));
  if (p >= 0.5) return Math.round(-100 * p / (1 - p));
  return Math.round(100 * (1 - p) / p);
}

function formatOdds(odds) {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function payoutFromOdds(stake, odds) {
  if (odds > 0) return Math.round(stake * odds / 100);
  return Math.round(stake * 100 / Math.abs(odds));
}

// Converts a "win $ratio for every $1 staked" ratio (1 = even money/1:1, 2 = 2:1, 0.5 = 1:2, ...)
// into the equivalent American odds, so custom spread payouts reuse the same odds/payout
// machinery (formatOdds, payoutFromOdds) as every other market in the app.
function oddsFromRatio(ratio) {
  const r = Number(ratio) > 0 ? Number(ratio) : 1;
  return r >= 1 ? Math.round(r * 100) : -Math.round(100 / r);
}

function winProbFromSpread(spread) {
  return 1 / (1 + Math.exp(-spread / 7));
}

// Ranks a field of candidates by score (higher = more likely to be the picked outcome) and
// assigns each a probability via geometric decay — a simple "favorite most likely" heuristic,
// not a precise simulation. Ties split the weight evenly (an all-tied field, e.g. everyone at
// 0-0 in week 1, comes out exactly uniform). Negate `score` beforehand for "least likely" markets.
function rankFieldOdds(candidates) {
  if (!candidates.length) return [];
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const decay = 0.65;
  const raw = sorted.map((_, i) => Math.pow(decay, i));
  const weightByIndex = new Array(sorted.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j].score === sorted[i].score) j += 1;
    const avg = raw.slice(i, j).reduce((sum, w) => sum + w, 0) / (j - i);
    for (let k = i; k < j; k += 1) weightByIndex[k] = avg;
    i = j;
  }
  const total = weightByIndex.reduce((sum, w) => sum + w, 0);
  return sorted.map((c, idx) => ({ ...c, prob: weightByIndex[idx] / total }));
}

function liveStarters(member, weekData) {
  const live = (weekData?.[member?.rosterId]?.starters || []).filter((id) => id && id !== "0");
  return live.length ? live : (member?.starters || []);
}

function liveRoster(member, weekData) {
  const live = (weekData?.[member?.rosterId]?.players || []).filter((id) => id && id !== "0");
  return live.length ? live : (member?.starters || []);
}

// `.starters` stays the true starting lineup (projections/lineup totals depend on it staying
// accurate); `.roster` is the full roster — starters plus bench — for display/picking purposes.
function withLiveStarters(members, weekData) {
  return members.map((m) => ({
    ...m,
    starters: liveStarters(m, weekData),
    roster: liveRoster(m, weekData),
  }));
}

function getWeekPairs(weekData, members) {
  const byMatchup = {};
  members.forEach((m) => {
    const row = weekData[m.rosterId];
    if (!row?.matchup_id) return;
    if (!byMatchup[row.matchup_id]) byMatchup[row.matchup_id] = [];
    byMatchup[row.matchup_id].push(m);
  });
  const pairs = [];
  Object.values(byMatchup).forEach((group) => {
    if (group.length === 2) pairs.push(group);
  });
  return pairs;
}

const PLAYER_CACHE_KEY = "sleeper-players-pick-v1";
const SLEEPER_PROJ_CACHE_KEY = "sleeper-proj-v3";

function resolveProjectionSeason(nflState, leagueData) {
  const nflSeason = Number(nflState?.league_season || nflState?.season);
  const leagueSeason = Number(leagueData?.season);
  const status = leagueData?.status || "";

  if (status === "in_season" && leagueSeason) {
    return leagueSeason;
  }
  if (nflSeason) return nflSeason;
  return leagueSeason || new Date().getFullYear();
}

function getLeagueScoring(leagueData) {
  const rec = Number(leagueData?.scoring_settings?.rec ?? 1);
  if (rec >= 1) return { field: "pts_ppr", label: "PPR" };
  if (rec >= 0.5) return { field: "pts_half_ppr", label: "Half PPR" };
  return { field: "pts_std", label: "Standard" };
}

const SCORING_META_KEY = /^(pos_limit_|playoff_|bench_|draft_|waiver_|trade_|daily_|disable_|num_|type_)/;

function usesCustomScoring(scoringSettings) {
  if (!scoringSettings) return false;
  if (scoringSettings.pass_td != null && scoringSettings.pass_td !== 4) return true;
  if (scoringSettings.pass_int != null && scoringSettings.pass_int !== -2) return true;
  return Object.entries(scoringSettings).some(([key, weight]) => (
    typeof weight === "number"
    && weight !== 0
    && (key.startsWith("bonus_") || key.startsWith("idp_") || key.startsWith("def_"))
  ));
}

function calculateFantasyPts(stats, scoringSettings) {
  if (!stats || !scoringSettings) return null;
  let total = 0;
  let used = false;
  Object.entries(scoringSettings).forEach(([key, weight]) => {
    if (SCORING_META_KEY.test(key)) return;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight === 0) return;
    const statVal = stats[key];
    if (statVal == null || typeof statVal !== "number") return;
    total += statVal * weight;
    used = true;
  });
  if (!used) return null;
  return Math.round(total * 100) / 100;
}

function projectionPointsFromSleeper(stats, scoringField, scoringSettings) {
  if (!stats) return null;
  if (usesCustomScoring(scoringSettings)) {
    const custom = calculateFantasyPts(stats, scoringSettings);
    if (custom != null) return custom;
  }
  if (stats[scoringField] != null) return Number(stats[scoringField]);
  return calculateFantasyPts(stats, scoringSettings);
}

function formatProj(proj) {
  if (proj == null) return "—";
  const rounded = Math.round(proj * 100) / 100;
  return Number.isInteger(rounded) ? rounded.toFixed(1) : rounded.toFixed(2);
}

function sleeperProj(playerId, projections) {
  const proj = projections[playerId];
  if (proj == null || Number.isNaN(Number(proj))) return null;
  return Number(proj);
}

function betLineFromProj(proj) {
  if (proj == null) return null;
  return Math.round(proj * 100) / 100;
}

async function fetchSleeperProjections(
  week,
  season,
  playerIds,
  seasonType = "regular",
  scoringField = "pts_ppr",
  scoringSettings = null,
  force = false,
) {
  const ids = [...new Set(playerIds.filter(Boolean))];
  if (!ids.length) return {};

  const scoringKey = scoringSettings
    ? Object.entries(scoringSettings).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join("|")
    : scoringField;
  const cacheKey = `${season}-${week}-${seasonType}-${scoringKey}`;
  let cache = {};
  try {
    cache = JSON.parse(localStorage.getItem(SLEEPER_PROJ_CACHE_KEY) || "{}");
  } catch {
    cache = {};
  }
  const weekCache = { ...(cache[cacheKey] || {}) };
  // `force` bypasses the cache-hit check entirely — a cached projection never expires on its
  // own otherwise, so a background/manual refresh would silently keep serving stale numbers.
  const missing = force ? ids : ids.filter((id) => weekCache[id] == null);

  if (missing.length) {
    const res = await fetch(
      `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=${seasonType}`,
    );
    if (!res.ok) throw new Error("sleeper projections");
    const rows = await res.json();
    const byPlayer = {};
    (rows || []).forEach((row) => {
      if (row?.player_id == null || !row?.stats) return;
      const pts = projectionPointsFromSleeper(row.stats, scoringField, scoringSettings);
      if (pts != null) byPlayer[String(row.player_id)] = pts;
    });
    // A forced refresh is authoritative: if Sleeper no longer lists a player at all (dropped
    // from the feed rather than given an explicit 0 — e.g. ruled out), clear the stale number
    // instead of leaving it behind.
    ids.forEach((id) => {
      const pts = byPlayer[String(id)];
      if (pts != null) weekCache[id] = pts;
      else if (force) delete weekCache[id];
    });
    cache[cacheKey] = weekCache;
    try {
      localStorage.setItem(SLEEPER_PROJ_CACHE_KEY, JSON.stringify(cache));
    } catch {
      // quota — in-memory only
    }
  }

  return weekCache;
}

function playerLabel(players, playerId) {
  return players[playerId]?.name || `Player ${playerId}`;
}

function findStarterByPos(member, players, pos) {
  return (member.starters || []).find((pid) => players[pid]?.position === pos);
}

function getFeaturedStarters(member, players) {
  const starters = member.starters || [];
  const featured = [];
  ["QB", "RB", "WR", "TE"].forEach((pos) => {
    const pid = starters.find((id) => players[id]?.position === pos);
    if (pid) featured.push(pid);
  });
  if (featured.length < 3) {
    starters.forEach((pid) => {
      if (featured.length >= 4) return;
      if (!featured.includes(pid) && players[pid]) featured.push(pid);
    });
  }
  return featured.slice(0, 4);
}

function sumLineupProjections(member, projections, starters = null) {
  const ids = starters || member.starters || [];
  let hasProj = false;
  const total = ids.reduce((sum, pid) => {
    const proj = sleeperProj(pid, projections);
    if (proj == null) return sum;
    hasProj = true;
    return sum + proj;
  }, 0);
  if (!hasProj) return null;
  return Math.round(total * 10) / 10;
}

function generateWeeklyBoardOfferings(members, week, weekData, projections, scoringLabel = "Sleeper") {
  if (!members.length) return [];

  const offerings = [];
  const pairs = Object.keys(weekData).length > 0
    ? getWeekPairs(weekData, members)
    : [];

  // Head-to-head matchup (moneyline)
  pairs.forEach(([a, b]) => {
    const projA = sumLineupProjections(a, projections);
    const projB = sumLineupProjections(b, projections);
    if (projA == null || projB == null) return;
    const probA = winProbFromSpread(projA - projB);
    offerings.push({
      id: `h2h-${week}-${a.id}-${b.id}`,
      kind: "lineup_ml",
      type: "matchup",
      week,
      title: `${a.name} vs ${b.name}`,
      subtitle: `Week ${week} · Sleeper ${scoringLabel} proj ${formatProj(projA)} vs ${formatProj(projB)}`,
      memberA: a.id,
      memberB: b.id,
      fantasyTeamIds: [a.id, b.id],
      sides: [
        { key: "a", memberId: a.id, label: a.name, odds: americanOdds(probA) },
        { key: "b", memberId: b.id, label: b.name, odds: americanOdds(1 - probA) },
      ],
    });
  });

  // Weekly High / Low Score — pick one manager out of the whole field
  const scored = members
    .map((m) => ({ id: m.id, name: m.name, score: sumLineupProjections(m, projections) }))
    .filter((r) => r.score != null);
  if (scored.length > 1) {
    rankFieldOdds(scored).forEach((r) => {
      offerings.push({
        id: `weekly-high-${week}-${r.id}`,
        kind: "weekly_high",
        type: "matchup",
        week,
        title: `${r.name} — Weekly High Score`,
        subtitle: `Week ${week} · proj ${formatProj(r.score)} pts`,
        subjectId: r.id,
        fantasyTeamIds: [r.id],
        sides: [{ key: "pick", label: `${r.name} has the high score`, odds: americanOdds(r.prob) }],
      });
    });
    rankFieldOdds(scored.map((r) => ({ ...r, score: -r.score }))).forEach((r) => {
      offerings.push({
        id: `weekly-low-${week}-${r.id}`,
        kind: "weekly_low",
        type: "matchup",
        week,
        title: `${r.name} — Weekly Low Score`,
        subtitle: `Week ${week} · proj ${formatProj(-r.score)} pts`,
        subjectId: r.id,
        fantasyTeamIds: [r.id],
        sides: [{ key: "pick", label: `${r.name} has the low score`, odds: americanOdds(r.prob) }],
      });
    });
  }

  // Biggest Blowout / Closest Matchup — pick one real pairing out of the whole field
  const pairMargins = pairs
    .map(([a, b]) => {
      const projA = sumLineupProjections(a, projections);
      const projB = sumLineupProjections(b, projections);
      if (projA == null || projB == null) return null;
      return { a, b, projA, projB, margin: Math.abs(projA - projB) };
    })
    .filter(Boolean);
  if (pairMargins.length > 1) {
    rankFieldOdds(pairMargins.map((r) => ({ id: `${r.a.id}-${r.b.id}`, score: r.margin, ref: r }))).forEach((r) => {
      const { a, b, projA, projB } = r.ref;
      offerings.push({
        id: `blowout-${week}-${a.id}-${b.id}`,
        kind: "weekly_blowout",
        type: "matchup",
        week,
        title: `${a.name} vs ${b.name} — Biggest Blowout`,
        subtitle: `Week ${week} · proj margin ${formatProj(r.score)} (${formatProj(projA)} vs ${formatProj(projB)})`,
        subjectId: a.id,
        matchupPeerId: b.id,
        fantasyTeamIds: [a.id, b.id],
        sides: [{ key: "pick", label: `${a.name} / ${b.name} is the biggest blowout`, odds: americanOdds(r.prob) }],
      });
    });
    rankFieldOdds(pairMargins.map((r) => ({ id: `${r.a.id}-${r.b.id}`, score: -r.margin, ref: r }))).forEach((r) => {
      const { a, b, projA, projB } = r.ref;
      offerings.push({
        id: `closest-${week}-${a.id}-${b.id}`,
        kind: "weekly_closest",
        type: "matchup",
        week,
        title: `${a.name} vs ${b.name} — Closest Matchup`,
        subtitle: `Week ${week} · proj margin ${formatProj(-r.score)} (${formatProj(projA)} vs ${formatProj(projB)})`,
        subjectId: a.id,
        matchupPeerId: b.id,
        fantasyTeamIds: [a.id, b.id],
        sides: [{ key: "pick", label: `${a.name} / ${b.name} is the closest matchup`, odds: americanOdds(r.prob) }],
      });
    });
  }

  return offerings;
}

function rankSuffix(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

function generateSeasonBoardOfferings(members, playoffTeams, weekCache = {}, currentWeek = 1) {
  if (members.length < 2) return [];

  const offerings = [];
  const composite = members.map((m) => ({ id: m.id, name: m.name, score: (m.wins || 0) + (m.seasonPts || 0) / 10000 }));

  rankFieldOdds(composite).forEach((r) => {
    offerings.push({
      id: `season-champion-${r.id}`,
      kind: "season_champion",
      type: "season",
      title: `${r.name} — League Champion`,
      subtitle: "Odds based on current record",
      subjectId: r.id,
      fantasyTeamIds: [r.id],
      sides: [{ key: "pick", label: `${r.name} wins the league`, odds: americanOdds(r.prob) }],
    });
  });

  rankFieldOdds(composite).forEach((r) => {
    offerings.push({
      id: `season-wins-${r.id}`,
      kind: "season_wins",
      type: "season",
      title: `${r.name} — Most Regular-Season Wins`,
      subtitle: "Odds based on current record",
      subjectId: r.id,
      fantasyTeamIds: [r.id],
      sides: [{ key: "pick", label: `${r.name} has the most wins`, odds: americanOdds(r.prob) }],
    });
  });

  const points = members.map((m) => ({ id: m.id, name: m.name, score: m.seasonPts || 0 }));
  rankFieldOdds(points).forEach((r) => {
    offerings.push({
      id: `season-points-${r.id}`,
      kind: "season_points",
      type: "season",
      title: `${r.name} — Most Total Points`,
      subtitle: `Season points so far: ${formatProj(r.score)}`,
      subjectId: r.id,
      fantasyTeamIds: [r.id],
      sides: [{ key: "pick", label: `${r.name} scores the most total points`, odds: americanOdds(r.prob) }],
    });
  });

  rankFieldOdds(composite.map((r) => ({ ...r, score: -r.score }))).forEach((r) => {
    offerings.push({
      id: `season-last-${r.id}`,
      kind: "season_last",
      type: "season",
      title: `${r.name} — Last Place`,
      subtitle: "Odds based on current record",
      subjectId: r.id,
      fantasyTeamIds: [r.id],
      sides: [{ key: "pick", label: `${r.name} finishes last`, odds: americanOdds(r.prob) }],
    });
  });

  const cutoff = playoffTeams || Math.ceil(members.length / 2);
  const rankedComposite = [...composite].sort((a, b) => b.score - a.score);
  // Average rank across tie groups (1-based) so an all-tied field — e.g. week 1, everyone 0-0 —
  // gives every manager the same fair make-probability instead of an arbitrary sort-order artifact.
  const avgRankById = new Map();
  {
    let i = 0;
    while (i < rankedComposite.length) {
      let j = i;
      while (j < rankedComposite.length && rankedComposite[j].score === rankedComposite[i].score) j += 1;
      const avgRank = (i + 1 + j) / 2;
      for (let k = i; k < j; k += 1) avgRankById.set(rankedComposite[k].id, avgRank);
      i = j;
    }
  }
  rankedComposite.forEach((r) => {
    const rank = avgRankById.get(r.id);
    const probMake = 1 / (1 + Math.exp((rank - cutoff - 0.5) / 1.2));
    const rankLabel = Number.isInteger(rank) ? `${rank}${rankSuffix(rank)}` : `~${Math.round(rank)}${rankSuffix(Math.round(rank))}`;
    offerings.push({
      id: `season-playoffs-${r.id}`,
      kind: "season_playoffs",
      type: "season",
      title: `${r.name} — Make the Playoffs`,
      subtitle: `Top ${cutoff} make it · currently ${rankLabel}`,
      subjectId: r.id,
      fantasyTeamIds: [r.id],
      sides: [
        { key: "make", pick: "over", label: `${r.name} makes the playoffs`, odds: americanOdds(probMake) },
        { key: "miss", pick: "under", label: `${r.name} misses the playoffs`, odds: americanOdds(1 - probMake) },
      ],
    });
  });

  const avgPoints = members.map((m) => ({ id: m.id, name: m.name, score: m.gamesPlayed ? m.seasonPts / m.gamesPlayed : 0 }));
  rankFieldOdds(avgPoints).forEach((r) => {
    offerings.push({
      id: `season-avg-points-${r.id}`,
      kind: "season_avg_points",
      type: "season",
      title: `${r.name} — Manager of the Year`,
      subtitle: `Points per game so far: ${formatProj(r.score)}`,
      subjectId: r.id,
      fantasyTeamIds: [r.id],
      sides: [{ key: "pick", label: `${r.name} has the best points-per-game average`, odds: americanOdds(r.prob) }],
    });
  });

  // Best/worst single week so far — reuses weeks already sitting in weekCache, no new fetching.
  const weekNums = Object.keys(weekCache).map(Number).filter((w) => w <= currentWeek);

  const bestWeekScores = members.map((m) => {
    let best = null;
    weekNums.forEach((w) => {
      const weekData = weekCache[w]?.matchups;
      if (!weekData) return;
      const pts = lineupFantasyPts(weekData, m.rosterId, m.starters);
      if (pts == null) return;
      if (best == null || pts > best) best = pts;
    });
    return { id: m.id, name: m.name, score: best ?? 0 };
  });
  rankFieldOdds(bestWeekScores).forEach((r) => {
    offerings.push({
      id: `season-best-week-${r.id}`,
      kind: "season_best_week",
      type: "season",
      title: `${r.name} — Highest Single-Week Score`,
      subtitle: `Best week so far: ${formatProj(r.score)}`,
      subjectId: r.id,
      fantasyTeamIds: [r.id],
      sides: [{ key: "pick", label: `${r.name} has the highest single-week score`, odds: americanOdds(r.prob) }],
    });
  });

  const worstWeekScores = members.map((m) => {
    let worst = null;
    weekNums.forEach((w) => {
      const weekData = weekCache[w]?.matchups;
      const projections = weekCache[w]?.projections;
      if (!weekData || !projections) return;
      const actual = lineupFantasyPts(weekData, m.rosterId, m.starters);
      const proj = sumLineupProjections(m, projections);
      if (actual == null || proj == null) return;
      const diff = actual - proj;
      if (worst == null || diff < worst) worst = diff;
    });
    return { id: m.id, name: m.name, score: worst ?? 0 };
  });
  rankFieldOdds(worstWeekScores.map((r) => ({ ...r, score: -r.score }))).forEach((r) => {
    const missBy = -r.score;
    offerings.push({
      id: `season-worst-week-${r.id}`,
      kind: "season_worst_week",
      type: "season",
      title: `${r.name} — Biggest Single-Week Bust`,
      subtitle: `Worst miss so far: ${formatProj(missBy)} vs projection`,
      subjectId: r.id,
      fantasyTeamIds: [r.id],
      sides: [{ key: "pick", label: `${r.name} has the biggest single-week bust`, odds: americanOdds(r.prob) }],
    });
  });

  return offerings;
}

function lineupFantasyPts(weekData, rosterId, starters) {
  const row = weekData[rosterId];
  if (!row?.players_points) return null;
  return (starters || []).reduce((sum, pid) => sum + (row.players_points[pid] || 0), 0);
}

function getPlayerPts(weekData, members, playerId) {
  for (const m of members) {
    const row = weekData[m.rosterId];
    if (row?.players_points && playerId in row.players_points) {
      return row.players_points[playerId];
    }
  }
  return null;
}

// ---------- Weekly League Pool: a bank of questions, graded from actual (not projected) results.
// Each week shows a random 9-question subset (see pickWeeklyQuestions) so the set varies instead
// of repeating identically every week — gradePoolWeek still grades the full bank unconditionally.
const POOL_QUESTIONS = [
  { key: "weekly_high", prompt: "Who will score the most fantasy points this week?" },
  { key: "weekly_low", prompt: "Who will score the fewest fantasy points this week?" },
  { key: "matchup_winner", prompt: "Pick anyone who will win their matchup." },
  { key: "biggest_blowout", prompt: "Whose matchup will be the biggest blowout?" },
  { key: "closest_matchup", prompt: "Whose matchup will be the closest?" },
  { key: "highest_player", prompt: "Which manager will have the highest-scoring player?" },
  { key: "lowest_player", prompt: "Which manager will have the lowest-scoring starter?" },
  { key: "most_bench", prompt: "Which manager will get the most points from their bench?" },
  { key: "best_overperform", prompt: "Which manager will beat their projection by the most?" },
  { key: "worst_overperform", prompt: "Which manager will miss their projection by the most?" },
  { key: "biggest_upset", prompt: "Which manager will pull off the biggest upset?" },
  { key: "highest_qb", prompt: "Which manager will start the highest-scoring QB?" },
  { key: "highest_rb", prompt: "Which manager will start the highest-scoring RB?" },
  { key: "highest_wr", prompt: "Which manager will start the highest-scoring WR?" },
  { key: "most_consistent", prompt: "Which manager will land closest to their projection?" },
];

// Deterministic per (leagueId, week) so every league member sees the identical rotating subset —
// a client-random shuffle would desync the leaderboard between accounts viewing the same week.
function mulberry32(seed) {
  let a = seed;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

function pickWeeklyQuestions(leagueId, week, count = 9) {
  const rand = mulberry32(hashSeed(`${leagueId}-${week}`));
  const pool = [...POOL_QUESTIONS];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

function poolLineupActual(weekData, member) {
  return lineupFantasyPts(weekData, member.rosterId, member.starters);
}

function poolBenchActual(weekData, member) {
  const row = weekData[member.rosterId];
  if (!row?.players_points) return null;
  const starterSet = new Set(member.starters || []);
  const bench = (row.players || []).filter((pid) => !starterSet.has(pid));
  return bench.reduce((sum, pid) => sum + (row.players_points[pid] || 0), 0);
}

// Picks the best (dir=1) or worst (dir=-1) scoring member(s), ties all counting as correct.
function poolPickExtreme(entries, dir) {
  const valid = entries.filter((e) => e.score != null);
  if (!valid.length) return { winners: new Set(), best: null };
  const best = dir === 1
    ? Math.max(...valid.map((e) => e.score))
    : Math.min(...valid.map((e) => e.score));
  const winners = new Set(valid.filter((e) => Math.abs(e.score - best) < 1e-6).map((e) => e.id));
  return { winners, best };
}

// Shared by the Pool and Survivor tabs: a week's picks lock once it's in the past, or once any
// team already shows real points for it (games underway) — the same heuristic used everywhere
// else in this app for "has this week actually started," since Sleeper doesn't expose kickoff
// timestamps directly.
function weekPicksLocked(week, currentWk, weekData) {
  return week < currentWk || Object.values(weekData).some((row) => Number(row?.points) > 0);
}

function gradeMatchupWinners(members, weekData) {
  const winners = new Set();
  getWeekPairs(weekData, members).forEach(([a, b]) => {
    const ptsA = poolLineupActual(weekData, a);
    const ptsB = poolLineupActual(weekData, b);
    if (ptsA == null || ptsB == null || ptsA === ptsB) return;
    winners.add(ptsA > ptsB ? a.id : b.id);
  });
  return { winners };
}

// Survivor Pool grading — reuses gradeMatchupWinners week by week rather than duplicating the
// matchup-winner logic. picksByWeek: { [week]: { [memberId]: pickMemberId } }. A member with no
// pick for a week is left alone (not eliminated) rather than assumed wrong — they just haven't
// played that week yet (or joined the pool late), same "absence isn't a claim" stance the rest
// of grading takes.
function computeSurvivorStatus(members, picksByWeek, currentWk, weekCache) {
  const status = {};
  members.forEach((m) => { status[m.id] = { alive: true, eliminatedWeek: null }; });
  for (let w = 1; w <= currentWk; w += 1) {
    const weekData = weekCache[w]?.matchups;
    if (!weekData || !Object.keys(weekData).length) continue;
    if (!weekPicksLocked(w, currentWk, weekData)) continue; // don't grade a week that hasn't started
    const { winners } = gradeMatchupWinners(members, weekData);
    const weekPicks = picksByWeek[w] || {};
    members.forEach((m) => {
      const entry = status[m.id];
      if (!entry.alive) return;
      const pick = weekPicks[m.id];
      if (!pick) return;
      if (!winners.has(pick)) {
        entry.alive = false;
        entry.eliminatedWeek = w;
      }
    });
  }
  return status;
}

function gradeMatchupMargin(members, weekData, dir) {
  const margins = getWeekPairs(weekData, members)
    .map(([a, b]) => {
      const ptsA = poolLineupActual(weekData, a);
      const ptsB = poolLineupActual(weekData, b);
      if (ptsA == null || ptsB == null) return null;
      return { a, b, margin: Math.abs(ptsA - ptsB) };
    })
    .filter(Boolean);
  if (!margins.length) return { winners: new Set(), best: null };
  const best = dir === 1
    ? Math.max(...margins.map((m) => m.margin))
    : Math.min(...margins.map((m) => m.margin));
  const winners = new Set();
  margins.forEach((m) => {
    if (Math.abs(m.margin - best) < 1e-6) { winners.add(m.a.id); winners.add(m.b.id); }
  });
  return { winners, best };
}

// dir=1 picks the highest-scoring player league-wide, dir=-1 the lowest; `players` + `position`
// narrow it to one position (e.g. "QB") — omit `position` for "any player."
function gradeExtremePlayer(members, weekData, dir, players = null, position = null) {
  const matches = (pid) => !position || players?.[pid]?.position === position;
  let best = null;
  members.forEach((m) => {
    const row = weekData[m.rosterId];
    if (!row?.players_points) return;
    (row.players || []).forEach((pid) => {
      if (!matches(pid)) return;
      const pts = row.players_points[pid];
      if (pts == null) return;
      if (best == null || (dir === 1 ? pts > best : pts < best)) best = pts;
    });
  });
  if (best == null) return { winners: new Set(), best: null };
  const winners = new Set();
  members.forEach((m) => {
    const row = weekData[m.rosterId];
    if (!row?.players_points) return;
    (row.players || []).forEach((pid) => {
      if (!matches(pid)) return;
      if (row.players_points[pid] === best) winners.add(m.id);
    });
  });
  return { winners, best };
}

function gradeBiggestUpset(members, weekData, projections) {
  let worstProb = null;
  let winnerId = null;
  getWeekPairs(weekData, members).forEach(([a, b]) => {
    const ptsA = poolLineupActual(weekData, a);
    const ptsB = poolLineupActual(weekData, b);
    if (ptsA == null || ptsB == null || ptsA === ptsB) return;
    const projA = sumLineupProjections(a, projections);
    const projB = sumLineupProjections(b, projections);
    if (projA == null || projB == null) return;
    const probA = winProbFromSpread(projA - projB);
    const actualWinner = ptsA > ptsB ? a : b;
    const winnerProb = actualWinner.id === a.id ? probA : 1 - probA;
    if (worstProb == null || winnerProb < worstProb) { worstProb = winnerProb; winnerId = actualWinner.id; }
  });
  return { winners: winnerId ? new Set([winnerId]) : new Set(), best: worstProb };
}

// Composes every grader in the bank into { [questionKey]: { winners: Set<memberId>, best } },
// unconditionally — the weekly-subset selection only affects what's shown, not what's graded.
// Empty weekData (week hasn't started) naturally yields empty winner sets for every question.
function gradePoolWeek(members, weekData, projections, players = {}) {
  return {
    weekly_high: poolPickExtreme(members.map((m) => ({ id: m.id, score: poolLineupActual(weekData, m) })), 1),
    weekly_low: poolPickExtreme(members.map((m) => ({ id: m.id, score: poolLineupActual(weekData, m) })), -1),
    matchup_winner: gradeMatchupWinners(members, weekData),
    biggest_blowout: gradeMatchupMargin(members, weekData, 1),
    closest_matchup: gradeMatchupMargin(members, weekData, -1),
    highest_player: gradeExtremePlayer(members, weekData, 1),
    lowest_player: gradeExtremePlayer(members, weekData, -1),
    most_bench: poolPickExtreme(members.map((m) => ({ id: m.id, score: poolBenchActual(weekData, m) })), 1),
    best_overperform: poolPickExtreme(members.map((m) => {
      const actual = poolLineupActual(weekData, m);
      const proj = sumLineupProjections(m, projections);
      return { id: m.id, score: actual != null && proj != null ? actual - proj : null };
    }), 1),
    worst_overperform: poolPickExtreme(members.map((m) => {
      const actual = poolLineupActual(weekData, m);
      const proj = sumLineupProjections(m, projections);
      return { id: m.id, score: actual != null && proj != null ? actual - proj : null };
    }), -1),
    biggest_upset: gradeBiggestUpset(members, weekData, projections),
    highest_qb: gradeExtremePlayer(members, weekData, 1, players, "QB"),
    highest_rb: gradeExtremePlayer(members, weekData, 1, players, "RB"),
    highest_wr: gradeExtremePlayer(members, weekData, 1, players, "WR"),
    most_consistent: poolPickExtreme(members.map((m) => {
      const actual = poolLineupActual(weekData, m);
      const proj = sumLineupProjections(m, projections);
      return { id: m.id, score: actual != null && proj != null ? Math.abs(actual - proj) : null };
    }), -1),
  };
}

async function fetchPlayerInfo(playerIds) {
  const unique = [...new Set(playerIds.filter(Boolean))];
  let cached = {};
  try {
    cached = JSON.parse(localStorage.getItem(PLAYER_CACHE_KEY) || "{}");
  } catch {
    cached = {};
  }
  const missing = unique.filter((id) => !cached[id]);
  if (missing.length > 0) {
    const res = await fetch("https://api.sleeper.app/v1/players/nfl");
    if (!res.ok) throw new Error("players");
    const all = await res.json();
    unique.forEach((id) => {
      const p = all[id];
      if (p) {
        cached[id] = {
          name: p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim(),
          position: p.position || "?",
          team: p.team || null,
        };
      }
    });
    try {
      localStorage.setItem(PLAYER_CACHE_KEY, JSON.stringify(cached));
    } catch {
      // quota — in-memory only
    }
  }
  return cached;
}

function getMatchupOpponent(viewerId, members, weekData) {
  const pairs = getWeekPairs(weekData, members);
  const pair = pairs.find(([a, b]) => a.id === viewerId || b.id === viewerId);
  if (!pair) return null;
  return pair[0].id === viewerId ? pair[1] : pair[0];
}

function buildMatchupOfferings(me, opp, week, players, projections, scoringLabel = "Sleeper") {
  if (!me || !opp) return [];
  const offerings = [];
  const projMe = sumLineupProjections(me, projections);
  const projOpp = sumLineupProjections(opp, projections);
  if (projMe != null && projOpp != null) {
    const spread = projMe - projOpp;
    const probMe = winProbFromSpread(spread);

    offerings.push({
      id: `lineup-ml-${week}-${me.id}-${opp.id}`,
      kind: "lineup_ml",
      type: "matchup",
      week,
      title: `${me.name} vs ${opp.name} — lineup pts`,
      subtitle: `Week ${week} · Sleeper ${scoringLabel} proj ${formatProj(projMe)} vs ${formatProj(projOpp)}`,
      memberA: me.id,
      memberB: opp.id,
      counterpartyId: opp.id,
      sides: [
        { key: "a", memberId: me.id, label: `${me.name} (${formatProj(projMe)})`, odds: americanOdds(probMe) },
        { key: "b", memberId: opp.id, label: `${opp.name} (${formatProj(projOpp)})`, odds: americanOdds(1 - probMe) },
      ],
    });
  }

  ["QB", "RB", "WR", "TE"].forEach((pos) => {
    const pidMe = findStarterByPos(me, players, pos);
    const pidOpp = findStarterByPos(opp, players, pos);
    if (!pidMe || !pidOpp) return;
    const lineMe = sleeperProj(pidMe, projections);
    const lineOpp = sleeperProj(pidOpp, projections);
    if (lineMe == null || lineOpp == null) return;
    const prob = winProbFromSpread(lineMe - lineOpp);
    offerings.push({
      id: `ph2h-${week}-${pidMe}-${pidOpp}`,
      kind: "player_h2h",
      type: "prop",
      week,
      title: `${playerLabel(players, pidMe)} vs ${playerLabel(players, pidOpp)}`,
      subtitle: `Week ${week} · ${pos} H2H · Sleeper ${formatProj(lineMe)} vs ${formatProj(lineOpp)}`,
      playerIdA: pidMe,
      playerIdB: pidOpp,
      memberA: me.id,
      memberB: opp.id,
      counterpartyId: opp.id,
      position: pos,
      sides: [
        { key: "a", playerId: pidMe, memberId: me.id, label: playerLabel(players, pidMe), odds: americanOdds(prob) },
        { key: "b", playerId: pidOpp, memberId: opp.id, label: playerLabel(players, pidOpp), odds: americanOdds(1 - prob) },
      ],
    });
  });

  [me, opp].forEach((member) => {
    getFeaturedStarters(member, players).forEach((pid) => {
      const p = players[pid];
      if (!p) return;
      const rawProj = sleeperProj(pid, projections);
      const line = betLineFromProj(rawProj);
      if (line == null) return;
      const counterparty = member.id === me.id ? opp.id : me.id;
      offerings.push({
        id: `pou-${week}-${pid}`,
        kind: "player_ou",
        type: "prop",
        week,
        title: `${p.name} O/U ${formatProj(line)} fantasy pts`,
        subtitle: `${member.name} · Sleeper ${scoringLabel} proj ${formatProj(rawProj)}`,
        playerId: pid,
        ownerId: member.id,
        counterpartyId: counterparty,
        line,
        sides: [
          { key: "over", label: `Over ${formatProj(line)}`, odds: -110, pick: "over" },
          { key: "under", label: `Under ${formatProj(line)}`, odds: -110, pick: "under" },
        ],
      });
    });
  });

  return offerings;
}

function starterRows(member, players, projections, weekData) {
  const starterIds = member?.starters || [];
  const startingSet = new Set(starterIds);
  const benchIds = (member?.roster || []).filter((pid) => !startingSet.has(pid));
  const row = weekData[member.rosterId];
  return [...starterIds, ...benchIds].map((pid) => {
    const p = players[pid] || { name: `Player ${pid}`, position: "?", team: null };
    const actual = row?.players_points?.[pid];
    return {
      pid,
      name: p.name,
      position: p.position,
      team: p.team,
      proj: sleeperProj(pid, projections),
      actual: actual != null ? actual : null,
      isStarter: startingSet.has(pid),
    };
  });
}

function buildCustomH2hOffering(viewerId, myPlayerId, oppMemberId, oppPlayerId, week, players, projections, members) {
  if (!viewerId || !myPlayerId || !oppMemberId || !oppPlayerId || oppMemberId === viewerId) return null;
  const opp = members.find((m) => m.id === oppMemberId);
  const myP = players[myPlayerId];
  const oppP = players[oppPlayerId];
  if (!myP || !oppP) return null;
  const lineA = sleeperProj(myPlayerId, projections);
  const lineB = sleeperProj(oppPlayerId, projections);
  if (lineA == null || lineB == null) return null;
  const prob = winProbFromSpread(lineA - lineB);
  return {
    id: `custom-h2h-${week}-${myPlayerId}-${oppPlayerId}`,
    kind: "player_h2h",
    type: "prop",
    week,
    title: `${myP.name} vs ${oppP.name}`,
    subtitle: `Player battle · ${opp?.name || "Opponent"} · Week ${week}`,
    playerIdA: myPlayerId,
    playerIdB: oppPlayerId,
    memberA: viewerId,
    memberB: oppMemberId,
    counterpartyId: oppMemberId,
    custom: true,
    sides: [
      {
        key: "a",
        playerId: myPlayerId,
        memberId: viewerId,
        label: myP.name,
        sublabel: `${myP.position} · ${formatProj(lineA)} Sleeper proj`,
        odds: americanOdds(prob),
      },
      {
        key: "b",
        playerId: oppPlayerId,
        memberId: oppMemberId,
        label: oppP.name,
        sublabel: `${oppP.position} · ${formatProj(lineB)} Sleeper proj`,
        odds: americanOdds(1 - prob),
      },
    ],
  };
}

// Builds an O/U market for any single player on the fly — used when someone taps just one
// roster player (starter or bench) in the Matchup tab, rather than only the pre-featured
// starters that already have a market built for them.
function buildSinglePlayerOuOffering(pid, ownerId, counterpartyId, week, players, projections) {
  const p = players[pid];
  if (!p) return null;
  const rawProj = sleeperProj(pid, projections);
  const line = betLineFromProj(rawProj);
  if (line == null) return null;
  return {
    id: `pou-${week}-${pid}`,
    kind: "player_ou",
    type: "prop",
    week,
    title: `${p.name} O/U ${formatProj(line)} fantasy pts`,
    subtitle: `${p.position}${p.team ? ` · ${p.team}` : ""} · Sleeper proj ${formatProj(rawProj)}`,
    playerId: pid,
    ownerId,
    counterpartyId,
    line,
    sides: [
      { key: "over", label: `Over ${formatProj(line)}`, odds: -110, pick: "over" },
      { key: "under", label: `Under ${formatProj(line)}`, odds: -110, pick: "under" },
    ],
  };
}

function starterPickOptions(member, players, projections, positionFilter = "all") {
  const roster = member?.roster?.length ? member.roster : (member?.starters || []);
  return roster
    .filter((pid) => {
      if (!players[pid]) return false;
      if (positionFilter === "all") return true;
      return players[pid].position === positionFilter;
    })
    .map((pid) => {
      const p = players[pid];
      return {
        id: pid,
        name: p.name,
        position: p.position,
        team: p.team,
        proj: sleeperProj(pid, projections),
      };
    });
}

function findPlayerOwner(members, pid) {
  if (!pid) return null;
  return members.find((m) => (m.roster?.length ? m.roster : m.starters || []).includes(pid)) || null;
}

const WEEKLY_BOARD_GROUPS = [
  { kind: "lineup_ml", title: "Head-to-Head Matchup", subtitle: "Who wins this week" },
  { kind: "weekly_high", title: "Weekly High Score", subtitle: "Pick the week's top scorer" },
  { kind: "weekly_low", title: "Weekly Low Score", subtitle: "Pick the week's bottom scorer" },
  { kind: "weekly_blowout", title: "Biggest Blowout", subtitle: "Pick the widest margin of the week" },
  { kind: "weekly_closest", title: "Closest Matchup", subtitle: "Pick the tightest margin of the week" },
];

const SEASON_BOARD_GROUPS = [
  { kind: "season_champion", title: "League Champion", subtitle: "Who wins it all" },
  { kind: "season_playoffs", title: "Make/Miss Playoffs", subtitle: "Per-manager, either side" },
  { kind: "season_wins", title: "Most Regular-Season Wins", subtitle: "Best record after week 18" },
  { kind: "season_points", title: "Most Total Points", subtitle: "Highest season point total" },
  { kind: "season_last", title: "Last Place", subtitle: "Bottom of the standings" },
  { kind: "season_avg_points", title: "Manager of the Year", subtitle: "Best points-per-game average" },
  { kind: "season_best_week", title: "Highest Single-Week Score", subtitle: "Best week of the season so far" },
  { kind: "season_worst_week", title: "Biggest Single-Week Bust", subtitle: "Worst miss vs projection so far" },
];

function groupBoardOfferingsByKind(offerings, groupDefs) {
  return groupDefs
    .map((g) => ({ ...g, id: g.kind, markets: offerings.filter((o) => o.kind === g.kind) }))
    .filter((g) => g.markets.length > 0);
}

function offeringInvolvesMember(offering, memberId) {
  if (memberId === "all") return true;
  const ids = offering.fantasyTeamIds
    || [offering.subjectId, offering.matchupPeerId, offering.memberA, offering.memberB].filter(Boolean);
  return ids.includes(memberId);
}

const TYPE_LABEL = {
  matchup: "Matchup",
  prop: "Player Prop",
  season: "Season Future",
  proposition: "League Prop",
};

const BOARD_KIND_LABEL = {
  lineup_ml: "Matchup",
  lineup_spread: "Matchup",
  lineup_ou: "Point Total",
  player_ou: "Player Prop",
  player_h2h: "Player vs Player",
  weekly_high: "Weekly High Score",
  weekly_low: "Weekly Low Score",
  weekly_blowout: "Biggest Blowout",
  weekly_closest: "Closest Matchup",
  season_champion: "League Champion",
  season_playoffs: "Make/Miss Playoffs",
  season_wins: "Most Wins",
  season_points: "Most Points",
  season_last: "Last Place",
  season_avg_points: "Manager of the Year",
  season_best_week: "Highest Single-Week Score",
  season_worst_week: "Biggest Single-Week Bust",
};

function ticketTypeLabel(bet) {
  return BOARD_KIND_LABEL[bet.boardKind] || TYPE_LABEL[bet.type];
}

// board_kinds that are a single "will X be the outcome" proposition (one candidate, one side) —
// share the same opponent-resolution + bet-object shape in placeBoardBet.
const SINGLE_PICK_BOARD_KINDS = [
  "weekly_high", "weekly_low", "season_champion", "season_wins", "season_points", "season_last",
  "season_avg_points", "season_best_week", "season_worst_week",
];

const AUTO_GRADABLE = { matchup: true, prop: true, season: false, proposition: false };

function computeLedger(betList, members, weekFilter = null) {
  const net = {};
  members.forEach((m) => (net[m.id] = {}));

  const settled = betList.filter((b) => {
    if (b.status !== "settled" || !b.result) return false;
    if (weekFilter === null) return true;
    return Number(b.week) === weekFilter;
  });

  settled.forEach((b) => {
    const winner = b.result === "creator" ? b.creator : b.opponent;
    const loser = b.result === "creator" ? b.opponent : b.creator;
    net[loser][winner] = (net[loser][winner] || 0) + b.stake;
  });

  const pairs = [];
  members.forEach((a, i) => {
    members.forEach((b, j) => {
      if (i >= j) return;
      const diff = (net[a.id][b.id] || 0) - (net[b.id][a.id] || 0);
      if (diff !== 0) {
        pairs.push({ from: diff > 0 ? a.id : b.id, to: diff > 0 ? b.id : a.id, amount: Math.abs(diff) });
      }
    });
  });

  const totals = {};
  members.forEach((m) => (totals[m.id] = 0));
  pairs.forEach((p) => { totals[p.from] -= p.amount; totals[p.to] += p.amount; });

  return { pairs, totals, settled };
}

const isWeeklyBet = (type) => type !== "season";

const STATUS_STYLE = {
  pending: { label: "PENDING", color: "#8a6d1f", rotate: -8 },
  accepted: { label: "ON THE BOARD", color: "#3a6b52", rotate: -6 },
  locked: { label: "LOCKED", color: "#7a3b3b", rotate: -10 },
  settled: { label: "GRADED", color: "#4b4b4b", rotate: -6 },
  cancelled: { label: "CANCELLED", color: "#7a3b3b", rotate: -8 },
  void: { label: "VOID", color: "#5b5b7a", rotate: -7 },
};

// One small accent per bet type, applied over .sb-ticket-type's default background — same
// dark/desaturated felt-ticket palette, just enough hue difference to tell types apart at a glance.
const TICKET_ACCENT = {
  lineup_ml: "#1f4a37",
  lineup_spread: "#1f4a37",
  lineup_ou: "#4a3a12",
  player_ou: "#3b2f52",
  player_h2h: "#5a2530",
};

function ticketAccentStyle(bet) {
  const bg = TICKET_ACCENT[bet.boardKind];
  return bg ? { background: bg } : undefined;
}

// Same dark/desaturated felt-ticket palette as TICKET_ACCENT, cycled deterministically per manager.
const AVATAR_PALETTE = ["#1f4a37", "#4a3a12", "#3b2f52", "#5a2530", "#2c4a6b", "#3a6b52", "#7a3b3b", "#5b5b7a"];

function applyBetPatch(prev, payload, ownerIdByDbId, betsApiModule) {
  const { eventType, new: newRow, old: oldRow } = payload;
  if (eventType === "DELETE") {
    return prev.filter((b) => b.id !== oldRow.id);
  }
  const mapped = betsApiModule.dbRowToBet(newRow, ownerIdByDbId);
  const idx = prev.findIndex((b) => b.id === mapped.id);
  if (idx === -1) return [mapped, ...prev];
  const next = prev.slice();
  next[idx] = mapped;
  return next;
}

function applyMemberPatch(prev, payload, membersApiModule) {
  const { eventType, new: newRow, old: oldRow } = payload;
  if (eventType === "DELETE") {
    return prev.filter((m) => m.dbId !== oldRow.id);
  }
  const mapped = membersApiModule.dbRowToMember(newRow);
  const idx = prev.findIndex((m) => m.dbId === mapped.dbId);
  if (idx === -1) return [...prev, mapped];
  const next = prev.slice();
  next[idx] = mapped;
  return next;
}

function applyPoolPatch(prev, payload, ownerIdByDbId, mapRow) {
  const { eventType, new: newRow, old: oldRow } = payload;
  if (eventType === "DELETE") {
    return prev.filter((r) => r.id !== oldRow.id);
  }
  const mapped = mapRow(newRow, ownerIdByDbId);
  const idx = prev.findIndex((r) => r.id === mapped.id);
  if (idx === -1) return [...prev, mapped];
  const next = prev.slice();
  next[idx] = mapped;
  return next;
}

export default function LeagueSportsbook({ session, demo = false, onExitDemo }) {
  const leaguesApi = demo ? demoLeaguesApi : realLeaguesApi;
  const membersApi = demo ? demoMembersApi : realMembersApi;
  const betsApi = demo ? demoBetsApi : realBetsApi;
  const poolApi = demo ? demoPoolApi : realPoolApi;
  const survivorApi = demo ? demoSurvivorApi : realSurvivorApi;

  const [league, setLeague] = useState({
    linked: false,
    dbId: null,
    leagueId: "",
    leagueName: "",
    loading: false,
    error: null,
    week: 1,
    season: new Date().getFullYear(),
    nflSeasonType: "regular",
    scoringField: "pts_ppr",
    scoringLabel: "PPR",
    projectionSeason: new Date().getFullYear(),
    poolEntryFee: 5,
    survivorEntryFee: 5,
    ownerId: null,
    subscriptionStatus: "active",
    inputId: "",
  });
  const [members, setMembers] = useState([]);
  const [bets, setBets] = useState([]);
  const [poolEntries, setPoolEntries] = useState([]);
  const [poolPicks, setPoolPicks] = useState([]);
  const [myPoolDraft, setMyPoolDraft] = useState({});
  const [poolSaving, setPoolSaving] = useState(false);
  const [poolError, setPoolError] = useState(null);
  const [survivorEntries, setSurvivorEntries] = useState([]);
  const [survivorPicks, setSurvivorPicks] = useState([]);
  const [mySurvivorDraft, setMySurvivorDraft] = useState("");
  const [survivorSaving, setSurvivorSaving] = useState(false);
  const [survivorError, setSurvivorError] = useState(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [tab, setTab] = useState("slips");
  const [showForm, setShowForm] = useState(false);
  const [betErrors, setBetErrors] = useState({});
  const [myLeagues, setMyLeagues] = useState([]);
  const [leaguePickerOpen, setLeaguePickerOpen] = useState(false);
  const [addingLeague, setAddingLeague] = useState(false);
  const [addLeagueId, setAddLeagueId] = useState("");
  const [addLeagueError, setAddLeagueError] = useState(null);
  const [addLeagueLoading, setAddLeagueLoading] = useState(false);

  const viewer = useMemo(
    () => members.find((m) => m.userId === session.user.id)?.id || "",
    [members, session.user.id],
  );

  const defaultOpponent = members.find((m) => m.id !== viewer)?.id || "";

  const [form, setForm] = useState({
    type: "matchup", title: "", stake: 10, week: 1,
    playerId: "", line: "", creatorSide: "over",
  });
  const [ledgerView, setLedgerView] = useState("weekly");
  const [selectedWeek, setSelectedWeek] = useState(1);

  const [weekCache, setWeekCache] = useState({});
  const weekCacheRef = useRef({});
  const loadingWeeksRef = useRef(new Set());
  const [players, setPlayers] = useState({});
  const [boardFantasyTeam, setBoardFantasyTeam] = useState("all");
  const [playoffTeams, setPlayoffTeams] = useState(null);
  const [globalStake, setGlobalStake] = useState(10);
  const [betSlipPick, setBetSlipPick] = useState(null);
  const [collapsedBoardGroups, setCollapsedBoardGroups] = useState(() => new Set());
  const [customH2H, setCustomH2H] = useState({ myPlayerId: "", oppMemberId: "", oppPlayerId: "" });
  const [customMatchPos, setCustomMatchPos] = useState(true);
  const [matchupPlayerPick, setMatchupPlayerPick] = useState({ my: "", opp: "" });

  // ---------- Create Side Bet builder ----------
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderCategory, setBuilderCategory] = useState(null); // 'matchup' | 'total' | 'prop' | 'battle' | null
  const [matchupBuilder, setMatchupBuilder] = useState({ opponent: "", format: "moneyline", spreadLine: "", spreadRatio: "" });
  const [totalBuilder, setTotalBuilder] = useState({ subjectId: "", line: "" });
  const [propBuilder, setPropBuilder] = useState({ playerId: "", line: "" });

  const nameOf = useCallback(
    (id) => members.find((m) => m.id === id)?.name || id,
    [members],
  );

  const rosterIdFor = useCallback(
    (memberId) => members.find((m) => m.id === memberId)?.rosterId,
    [members],
  );

  // Deterministic per-manager color + initials circle — no new Sleeper data, just a small visual
  // anchor next to a name wherever managers are listed (ticket parties, Pool/Survivor/League lists).
  const avatarColorFor = useCallback((id) => {
    let hash = 0;
    for (let i = 0; i < String(id).length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
  }, []);

  const renderAvatar = useCallback((memberId) => {
    const name = nameOf(memberId);
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
    return (
      <span className="sb-avatar" style={{ background: avatarColorFor(memberId) }}>{initials}</span>
    );
  }, [nameOf, avatarColorFor]);

  const leagueReady = league.linked && members.length > 0 && !!viewer;

  const dbIdByOwnerId = useMemo(
    () => Object.fromEntries(members.map((m) => [m.id, m.dbId])),
    [members],
  );
  const ownerIdByDbId = useMemo(
    () => Object.fromEntries(members.map((m) => [m.dbId, m.id])),
    [members],
  );
  const ownerIdByDbIdRef = useRef({});
  useEffect(() => { ownerIdByDbIdRef.current = ownerIdByDbId; }, [ownerIdByDbId]);

  // Applies a raw `leagues` DB row (as returned by findMyMemberships/connectLeague/upsertLeague)
  // to the active `league` state — shared by bootstrap, switchLeague, and adding a new league,
  // so "which league's details are showing" always comes from one place.
  const applyLeagueRow = useCallback((leagueRow) => {
    setLeague((s) => ({
      ...s,
      linked: true,
      dbId: leagueRow.id,
      leagueId: leagueRow.sleeper_league_id,
      leagueName: leagueRow.name,
      week: leagueRow.current_week,
      season: leagueRow.season,
      nflSeasonType: leagueRow.nfl_season_type,
      scoringField: leagueRow.scoring_field,
      scoringLabel: leagueRow.scoring_label,
      projectionSeason: leagueRow.projection_season,
      poolEntryFee: Number(leagueRow.pool_entry_fee) || 5,
      survivorEntryFee: Number(leagueRow.survivor_entry_fee) || 5,
      ownerId: leagueRow.owner_id,
      subscriptionStatus: leagueRow.subscription_status || "active",
      inputId: leagueRow.sleeper_league_id,
      loading: false,
      error: null,
    }));
    setSelectedWeek(leagueRow.current_week);
    setForm((f) => ({ ...f, week: leagueRow.current_week }));
  }, []);

  // Switches which of the account's leagues is active. Clears every league-scoped piece of
  // state up front so a slower-loading new league can never show under the old league's label,
  // and never mixes with it — weekCache included, since it used to be keyed by week number
  // alone and could otherwise leak one league's matchup data into another's identical week.
  const switchLeague = useCallback(async (leagueDbId) => {
    if (!leagueDbId || leagueDbId === league.dbId) {
      setLeaguePickerOpen(false);
      return;
    }
    const leagueRow = myLeagues.find((l) => l.id === leagueDbId);
    if (!leagueRow) return;
    setLeaguePickerOpen(false);
    setBets([]);
    setPoolEntries([]);
    setPoolPicks([]);
    weekCacheRef.current = {};
    setWeekCache({});
    // Fetch members BEFORE flipping league.dbId — dbIdByOwnerId/ownerIdByDbId (and the bets
    // fetch effect that depends on league.dbId) derive from `members`, so setting dbId first
    // would fire that effect against a still-empty owner-id map and map every bet's
    // creator/opponent to null until the next unrelated re-render happened to fix it.
    let memberRows = [];
    try {
      memberRows = await membersApi.fetchMembers(leagueDbId);
    } catch {
      // best-effort — the members realtime effect will retry once league.dbId is set below
    }
    setMembers(memberRows);
    applyLeagueRow(leagueRow);
    updateLastActiveLeague(leagueDbId).catch(() => {});
  }, [league.dbId, myLeagues, membersApi, applyLeagueRow]);

  // ---------- bootstrap: which league(s) does this account already belong to? ----------
  useEffect(() => {
    let cancelled = false;
    membersApi.findMyMemberships(session.user.id)
      .then(async (rows) => {
        if (cancelled) return;
        if (!rows.length) {
          setBootstrapping(false);
          return;
        }
        const leagueRows = rows.map((r) => r.leagues);
        setMyLeagues(leagueRows);
        const lastActiveId = session.user.user_metadata?.last_active_league_id;
        const activeRow = leagueRows.find((l) => l.id === lastActiveId) || leagueRows[0];
        // Fetch members before setting league.dbId — see the matching comment in switchLeague.
        const memberRows = await membersApi.fetchMembers(activeRow.id);
        if (cancelled) return;
        setMembers(memberRows);
        applyLeagueRow(activeRow);
        setBootstrapping(false);
      })
      .catch(() => setBootstrapping(false));
    return () => { cancelled = true; };
  }, [session.user.id]);

  // ---------- demo mode: seed week data locally instead of fetching from Sleeper ----------
  useEffect(() => {
    if (!demo) return;
    weekCacheRef.current = DEMO_WEEK_CACHE;
    setWeekCache(DEMO_WEEK_CACHE);
    setPlayers(DEMO_PLAYERS);
    setPlayoffTeams(DEMO_PLAYOFF_TEAMS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);


  const fetchLeagueData = useCallback(async (leagueId) => {
    const id = leagueId.trim();
    const [leagueRes, rostersRes, usersRes, stateRes] = await Promise.all([
      fetch(`https://api.sleeper.app/v1/league/${id}`),
      fetch(`https://api.sleeper.app/v1/league/${id}/rosters`),
      fetch(`https://api.sleeper.app/v1/league/${id}/users`),
      fetch("https://api.sleeper.app/v1/state/nfl"),
    ]);
    if (!leagueRes.ok || !rostersRes.ok || !usersRes.ok) throw new Error("bad response");
    const leagueData = await leagueRes.json();
    const rosters = await rostersRes.json();
    const users = await usersRes.json();
    const nflState = stateRes.ok ? await stateRes.json() : null;
    if (!Array.isArray(rosters) || rosters.length === 0) throw new Error("empty");
    const builtMembers = buildMembers(rosters, users);
    if (builtMembers.length === 0) throw new Error("empty");
    const schedule = resolveRegularSeasonSchedule(nflState, leagueData);
    const scoring = getLeagueScoring(leagueData);
    const projectionSeason = resolveProjectionSeason(nflState, leagueData);
    return {
      leagueName: leagueData.name || "Your League",
      members: builtMembers,
      week: schedule.currentWeek,
      season: schedule.season,
      projectionSeason,
      nflSeasonType: schedule.nflSeasonType,
      scoringField: scoring.field,
      scoringLabel: scoring.label,
    };
  }, []);

  // Also used to add a *second* (or third...) league to an already-linked account — the only
  // difference from first-time linking is that here there's existing league-scoped state to
  // clear first, so the new league can't show up blended with the old one even momentarily.
  const connectLeague = useCallback(async (leagueId, { isAdditional = false } = {}) => {
    if (demo || !leagueId.trim()) return;
    setLeague((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetchLeagueData(leagueId);
      const leagueRow = await leaguesApi.upsertLeague(leagueId.trim(), {
        name: data.leagueName,
        season: data.season,
        nfl_season_type: data.nflSeasonType,
        scoring_field: data.scoringField,
        scoring_label: data.scoringLabel,
        projection_season: data.projectionSeason,
        current_week: data.week,
      });
      const memberRows = await membersApi.syncMembersFromSleeper(leagueRow.id, data.members);
      // Only now that the new league's own data is in hand do we touch any existing league's
      // state — clearing earlier (before knowing this would succeed) would leave the current
      // league's members/bets wiped with nothing to restore them if the connect attempt failed.
      if (isAdditional) {
        setBets([]);
        setPoolEntries([]);
        setPoolPicks([]);
        weekCacheRef.current = {};
        setWeekCache({});
      }
      setMembers(memberRows);
      setLeague((s) => ({
        ...s,
        linked: true,
        dbId: leagueRow.id,
        leagueId: leagueId.trim(),
        leagueName: data.leagueName,
        week: data.week,
        season: data.season,
        projectionSeason: data.projectionSeason,
        nflSeasonType: data.nflSeasonType,
        scoringField: data.scoringField,
        scoringLabel: data.scoringLabel,
        poolEntryFee: Number(leagueRow.pool_entry_fee) || 5,
        ownerId: leagueRow.owner_id,
        subscriptionStatus: leagueRow.subscription_status || "active",
        loading: false,
        error: null,
        inputId: leagueId.trim(),
      }));
      setMyLeagues((prev) => (
        prev.some((l) => l.id === leagueRow.id) ? prev : [...prev, leagueRow]
      ));
      setSelectedWeek(data.week);
      setForm((f) => ({ ...f, week: data.week }));
      updateLastActiveLeague(leagueRow.id).catch(() => {});
      setAddingLeague(false);
      setAddLeagueId("");
      setAddLeagueError(null);
    } catch {
      if (isAdditional) {
        setAddLeagueError("Couldn't load that league. Double-check the Sleeper league ID.");
        setLeague((s) => ({ ...s, loading: false, error: null }));
      } else {
        setLeague((s) => ({
          ...s,
          loading: false,
          error: "Couldn't load that league. Double-check the Sleeper league ID.",
        }));
      }
    }
  }, [fetchLeagueData]);

  const handleClaim = useCallback(async (memberDbId) => {
    await membersApi.claimMember(memberDbId, session.user.id);
    const rows = await membersApi.fetchMembers(league.dbId);
    setMembers(rows);
  }, [session.user.id, league.dbId]);

  const refreshLeague = useCallback(async () => {
    if (demo || !league.leagueId || !league.dbId) return;
    setLeague((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetchLeagueData(league.leagueId);
      const leagueRow = await leaguesApi.upsertLeague(league.leagueId, {
        name: data.leagueName,
        season: data.season,
        nfl_season_type: data.nflSeasonType,
        scoring_field: data.scoringField,
        scoring_label: data.scoringLabel,
        projection_season: data.projectionSeason,
        current_week: data.week,
      });
      const memberRows = await membersApi.syncMembersFromSleeper(leagueRow.id, data.members);
      setMembers(memberRows);
      setLeague((s) => ({
        ...s,
        dbId: leagueRow.id,
        leagueName: data.leagueName,
        week: data.week,
        season: data.season,
        projectionSeason: data.projectionSeason,
        nflSeasonType: data.nflSeasonType,
        scoringField: data.scoringField,
        scoringLabel: data.scoringLabel,
        ownerId: leagueRow.owner_id,
        subscriptionStatus: leagueRow.subscription_status || "active",
        loading: false,
        error: null,
      }));
      setSelectedWeek((w) => clampWeekToSeason(w, data.week));
    } catch {
      setLeague((s) => ({
        ...s,
        loading: false,
        error: "Couldn't refresh league data. Try again in a moment.",
      }));
    }
  }, [fetchLeagueData, league.leagueId, league.dbId]);

  const disconnectLeague = useCallback(async () => {
    if (demo) {
      onExitDemo?.();
      return;
    }
    if (!window.confirm("Sign out of this device? Nobody else's data is affected.")) return;
    await signOut();
  }, [demo, onExitDemo]);

  useEffect(() => {
    if (league.dbId) refreshLeague();
    // only re-sync roster names once we know which league this session belongs to
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [league.dbId]);

  // ---------- shared bets/members sync (Supabase Realtime) ----------
  useEffect(() => {
    if (!league.dbId) return;
    let cancelled = false;
    betsApi.fetchBets(league.dbId, ownerIdByDbIdRef.current).then((rows) => {
      if (!cancelled) setBets(rows);
    });
    const offBets = betsApi.subscribeToBets(league.dbId, (payload) => {
      setBets((prev) => applyBetPatch(prev, payload, ownerIdByDbIdRef.current, betsApi));
    });
    const offMembers = membersApi.subscribeToMembers(league.dbId, (payload) => {
      setMembers((prev) => applyMemberPatch(prev, payload, membersApi));
    });
    return () => {
      cancelled = true;
      offBets();
      offMembers();
    };
  }, [league.dbId]);

  // ---------- weekly league pool sync (Supabase Realtime) ----------
  useEffect(() => {
    if (!league.dbId) return;
    let cancelled = false;
    poolApi.fetchEntries(league.dbId, ownerIdByDbIdRef.current).then((rows) => {
      if (!cancelled) setPoolEntries(rows);
    });
    poolApi.fetchPicks(league.dbId, ownerIdByDbIdRef.current).then((rows) => {
      if (!cancelled) setPoolPicks(rows);
    });
    const offEntries = poolApi.subscribeToEntries(league.dbId, (payload) => {
      setPoolEntries((prev) => applyPoolPatch(prev, payload, ownerIdByDbIdRef.current, poolApi.dbRowToEntry));
    });
    const offPicks = poolApi.subscribeToPicks(league.dbId, (payload) => {
      setPoolPicks((prev) => applyPoolPatch(prev, payload, ownerIdByDbIdRef.current, poolApi.dbRowToPick));
    });
    return () => {
      cancelled = true;
      offEntries();
      offPicks();
    };
  }, [league.dbId]);

  // ---------- survivor pool sync (Supabase Realtime) ----------
  useEffect(() => {
    if (!league.dbId) return;
    let cancelled = false;
    survivorApi.fetchEntries(league.dbId, ownerIdByDbIdRef.current).then((rows) => {
      if (!cancelled) setSurvivorEntries(rows);
    });
    survivorApi.fetchPicks(league.dbId, ownerIdByDbIdRef.current).then((rows) => {
      if (!cancelled) setSurvivorPicks(rows);
    });
    const offEntries = survivorApi.subscribeToEntries(league.dbId, (payload) => {
      setSurvivorEntries((prev) => applyPoolPatch(prev, payload, ownerIdByDbIdRef.current, survivorApi.dbRowToEntry));
    });
    const offPicks = survivorApi.subscribeToPicks(league.dbId, (payload) => {
      setSurvivorPicks((prev) => applyPoolPatch(prev, payload, ownerIdByDbIdRef.current, survivorApi.dbRowToPick));
    });
    return () => {
      cancelled = true;
      offEntries();
      offPicks();
    };
  }, [league.dbId]);

  // ---------- proactively void bets the moment a player's projection drops to 0 ----------
  // Runs on every bets/weekCache change (i.e. every poll), not just when someone clicks
  // Auto-grade — a bet can be voided before its player's game even starts. Naturally
  // idempotent: once a bet is void it no longer matches the pending/accepted/locked filter.
  useEffect(() => {
    if (!leagueReady) return;
    bets.forEach((b) => {
      if (!["pending", "accepted", "locked"].includes(b.status)) return;
      const projections = weekCache[Number(b.week)]?.projections;
      if (!projections) return;
      // Sleeper often drops a ruled-out player from the feed entirely rather than sending an
      // explicit 0 — once this week's projections have loaded at all, no entry for the player
      // means the same thing as a 0: they're not projected to play.
      const zeroed = (pid) => {
        if (!pid) return false;
        const p = sleeperProj(pid, projections);
        return p === 0 || p === null;
      };
      const shouldVoid = (b.playerIdA && b.playerIdB)
        ? (zeroed(b.playerIdA) || zeroed(b.playerIdB))
        : zeroed(b.playerId);
      if (shouldVoid) {
        betsApi.updateBetStatus(b.id, { status: "void" }).catch(() => {});
      }
    });
  }, [bets, weekCache, leagueReady, betsApi]);

  const loadWeekData = useCallback(async (weekNum, { force = false, showSpinner = false } = {}) => {
    if (!league.leagueId) return false;
    const wk = Math.min(REGULAR_SEASON_WEEKS, Math.max(1, Number(weekNum) || 1));
    if (demo) return Boolean(weekCacheRef.current[wk]);

    if (!force && weekCacheRef.current[wk]) return true;
    if (loadingWeeksRef.current.has(wk)) {
      return new Promise((resolve) => {
        const started = Date.now();
        const wait = () => {
          if (weekCacheRef.current[wk]) {
            resolve(true);
            return;
          }
          if (!loadingWeeksRef.current.has(wk) || Date.now() - started > 30000) {
            resolve(false);
            return;
          }
          setTimeout(wait, 100);
        };
        wait();
      });
    }

    loadingWeeksRef.current.add(wk);
    if (showSpinner) setLeague((s) => ({ ...s, loading: true, error: null }));

    try {
      const [currentRes, stateRes, leagueRes] = await Promise.all([
        fetch(`https://api.sleeper.app/v1/league/${league.leagueId}/matchups/${wk}`),
        fetch("https://api.sleeper.app/v1/state/nfl"),
        fetch(`https://api.sleeper.app/v1/league/${league.leagueId}`),
      ]);
      if (!currentRes.ok) throw new Error("bad response");
      const current = await currentRes.json();
      const nflState = stateRes.ok ? await stateRes.json() : null;
      const leagueData = leagueRes.ok ? await leagueRes.json() : null;
      const schedule = resolveRegularSeasonSchedule(nflState, leagueData);
      const scoring = getLeagueScoring(leagueData);
      const projectionSeason = resolveProjectionSeason(nflState, leagueData);
      const map = {};
      current.forEach((row) => { map[row.roster_id] = row; });

      const matchupRosterIds = [...new Set(
        current.flatMap((row) => (row.players?.length ? row.players : row.starters || []).filter((id) => id && id !== "0")),
      )];
      const rosterIds = matchupRosterIds.length
        ? matchupRosterIds
        : members.flatMap((m) => m.starters || []);
      const playerInfo = await fetchPlayerInfo(rosterIds);
      const projections = await fetchSleeperProjections(
        wk,
        projectionSeason,
        rosterIds,
        "regular",
        scoring.field,
        leagueData?.scoring_settings || null,
        force,
      );

      const entry = { matchups: map, projections };
      weekCacheRef.current = { ...weekCacheRef.current, [wk]: entry };
      setWeekCache((prev) => ({ ...prev, [wk]: entry }));
      setPlayers(playerInfo);
      setPlayoffTeams(Number(leagueData?.settings?.playoff_teams) || null);
      setLeague((s) => ({
        ...s,
        loading: showSpinner ? false : s.loading,
        season: Number(leagueData?.season) || schedule.season,
        projectionSeason,
        week: schedule.currentWeek,
        nflSeasonType: schedule.nflSeasonType,
        scoringField: scoring.field,
        scoringLabel: scoring.label,
        error: null,
      }));
      if (showSpinner) {
        setSelectedWeek((sel) => clampWeekToSeason(sel, schedule.currentWeek));
      }
      return true;
    } catch {
      if (showSpinner) {
        setLeague((s) => ({
          ...s,
          loading: false,
          error: "Couldn't load Sleeper data for that week. Try again in a moment.",
        }));
      }
      return false;
    } finally {
      loadingWeeksRef.current.delete(wk);
    }
  }, [league.leagueId, members]);

  const prefetchSeasonWeeks = useCallback(async (throughWeek, { force = false } = {}) => {
    const end = Math.min(REGULAR_SEASON_WEEKS, Math.max(1, Number(throughWeek) || 1));
    for (let w = 1; w <= end; w++) {
      if (!force && weekCacheRef.current[w]) continue;
      await loadWeekData(w, { force });
    }
  }, [loadWeekData]);

  // ---------- ledger ----------
  const ledger = useMemo(() => computeLedger(bets, members), [bets, members]);

  const currentWeek = Number(league.week) || 1;

  const seasonWeeks = useMemo(
    () => Array.from({ length: currentWeek }, (_, i) => currentWeek - i),
    [currentWeek],
  );

  const activeWeek = useMemo(() => {
    return clampWeekToSeason(selectedWeek, currentWeek);
  }, [selectedWeek, currentWeek]);

  const weekNavIndex = seasonWeeks.indexOf(activeWeek);
  const goOlderWeek = () => {
    if (weekNavIndex < seasonWeeks.length - 1) setSelectedWeek(seasonWeeks[weekNavIndex + 1]);
  };
  const goNewerWeek = () => {
    if (weekNavIndex > 0) setSelectedWeek(seasonWeeks[weekNavIndex - 1]);
  };

  const renderWeekNav = (extra = null) => (
    <div className="sb-slips-header">
      <div className="sb-week-nav" style={{ marginBottom: 0 }}>
        <button type="button" disabled={weekNavIndex >= seasonWeeks.length - 1} onClick={goOlderWeek}>
          <ChevronLeft size={16} />
        </button>
        <select
          className="sb-week-select"
          value={activeWeek}
          onChange={(e) => setSelectedWeek(Number(e.target.value))}
          aria-label="Select week"
        >
          {Array.from({ length: currentWeek }, (_, i) => i + 1).map((w) => (
            <option key={w} value={w}>Week {w}</option>
          ))}
        </select>
        <button type="button" disabled={weekNavIndex <= 0} onClick={goNewerWeek}>
          <ChevronRight size={16} />
        </button>
      </div>
      {extra}
    </div>
  );

  const matchupWeek = currentWeek;

  const activeWeekData = weekCache[activeWeek]?.matchups ?? {};
  const activeProjections = weekCache[activeWeek]?.projections ?? {};
  const matchupWeekData = weekCache[matchupWeek]?.matchups ?? {};
  const matchupProjections = weekCache[matchupWeek]?.projections ?? {};

  const loadedWeekCount = useMemo(
    () => Object.keys(weekCache).filter((w) => Number(w) <= currentWeek).length,
    [weekCache, currentWeek],
  );

  // ---------- weekly league pool ----------
  const poolWeekEntries = useMemo(() => poolEntries.filter((e) => e.week === activeWeek), [poolEntries, activeWeek]);
  const poolWeekPicks = useMemo(() => poolPicks.filter((p) => p.week === activeWeek), [poolPicks, activeWeek]);
  const myPoolEntry = poolWeekEntries.find((e) => e.memberId === viewer) || null;
  const myPoolPicks = useMemo(
    () => Object.fromEntries(poolWeekPicks.filter((p) => p.memberId === viewer).map((p) => [p.questionKey, p.pickMemberId])),
    [poolWeekPicks, viewer],
  );
  const weekQuestions = useMemo(
    () => pickWeeklyQuestions(league.dbId, activeWeek),
    [league.dbId, activeWeek],
  );
  const iHaveSubmitted = weekQuestions.every((q) => myPoolPicks[q.key]);
  const poolLocked = weekPicksLocked(activeWeek, currentWeek, activeWeekData);
  const canSeePoolPicks = iHaveSubmitted || poolLocked;
  const poolGrading = useMemo(
    () => gradePoolWeek(members, activeWeekData, activeProjections, players),
    [members, activeWeekData, activeProjections, players],
  );
  const poolPot = poolWeekEntries.filter((e) => e.paid).length * (Number(league.poolEntryFee) || 5);
  const poolLeaderboard = useMemo(() => {
    const byMember = {};
    poolWeekPicks.forEach((p) => {
      if (!byMember[p.memberId]) byMember[p.memberId] = {};
      byMember[p.memberId][p.questionKey] = p.pickMemberId;
    });
    return Object.entries(byMember)
      .map(([memberId, picks]) => {
        const score = weekQuestions.reduce((sum, q) => (
          sum + (poolGrading[q.key]?.winners?.has(picks[q.key]) ? 1 : 0)
        ), 0);
        return { memberId, score, submitted: weekQuestions.every((q) => picks[q.key]) };
      })
      .filter((r) => r.submitted)
      .sort((a, b) => b.score - a.score);
  }, [poolWeekPicks, poolGrading, weekQuestions]);

  useEffect(() => {
    setMyPoolDraft(myPoolPicks);
    // only reset the draft when the viewer switches weeks, not on every realtime pick update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWeek, viewer]);

  async function submitMyPoolPicks() {
    if (!weekQuestions.every((q) => myPoolDraft[q.key])) {
      setPoolError("Answer all nine questions before submitting.");
      return;
    }
    setPoolSaving(true);
    setPoolError(null);
    try {
      const picksByQuestionDbId = Object.fromEntries(
        Object.entries(myPoolDraft).map(([key, ownerId]) => [key, dbIdByOwnerId[ownerId]]),
      );
      await poolApi.submitPicks(league.dbId, activeWeek, dbIdByOwnerId[viewer], picksByQuestionDbId);
    } catch (err) {
      setPoolError(err.message || "Couldn't save your picks — try again.");
    } finally {
      setPoolSaving(false);
    }
  }

  async function togglePoolPaid() {
    if (!myPoolEntry) return;
    try {
      await poolApi.setPaid(myPoolEntry.id, !myPoolEntry.paid);
    } catch {
      // best-effort — the toggle will just not flip visually
    }
  }

  const renderPoolTab = () => (
    <div>
      {renderWeekNav()}
      <div className="sb-board sb-pool-strip">
        <h3>Week {activeWeek} Pool</h3>
        <p className="sb-note">
          ${league.poolEntryFee || 5} to enter · {poolWeekEntries.filter((e) => e.paid).length} paid in ·
          pot is ${poolPot}. Nine questions about your league's actual results this week — most correct wins the pot.
        </p>
        {myPoolEntry && (
          <button type="button" className={`sb-btn ${myPoolEntry.paid ? "sb-btn-accept" : "sb-btn-submit"}`} onClick={togglePoolPaid}>
            {myPoolEntry.paid ? <Check size={12} /> : <Coins size={12} />} {myPoolEntry.paid ? "You're paid in" : "Mark yourself paid"}
          </button>
        )}
      </div>

      <div className="sb-board">
        <h3>{iHaveSubmitted ? "Your Picks" : "Make Your Picks"}</h3>
        {poolLocked && !iHaveSubmitted && (
          <div className="sb-empty">This week's pool has already started — picks are locked.</div>
        )}
        {(!poolLocked || iHaveSubmitted) && (
          <>
            {weekQuestions.map((q) => (
              <div className="sb-pool-question" key={q.key}>
                <label>{q.prompt}</label>
                <select
                  value={myPoolDraft[q.key] || ""}
                  disabled={poolLocked}
                  onChange={(e) => setMyPoolDraft((d) => ({ ...d, [q.key]: e.target.value }))}
                >
                  <option value="">Select a manager…</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                {canSeePoolPicks && poolGrading[q.key]?.winners?.size > 0 && (
                  <span className={`sb-pool-grade ${poolGrading[q.key].winners.has(myPoolDraft[q.key]) ? "correct" : "wrong"}`}>
                    {poolGrading[q.key].winners.has(myPoolDraft[q.key]) ? <Check size={12} /> : <X size={12} />}
                    {[...poolGrading[q.key].winners].map(nameOf).join(", ")}
                  </span>
                )}
              </div>
            ))}
            {poolError && <div className="sb-error-banner"><AlertTriangle size={12} /> {poolError}</div>}
            {!poolLocked && (
              <div className="sb-form-actions">
                <button type="button" className="sb-btn sb-btn-submit" onClick={submitMyPoolPicks} disabled={poolSaving}>
                  {poolSaving ? "Saving…" : iHaveSubmitted ? "Update Picks" : "Submit Picks"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {canSeePoolPicks && poolLeaderboard.length > 0 && (
        <div className="sb-board">
          <h3>Leaderboard</h3>
          {poolLeaderboard.map((r, i) => (
            <div className="sb-owe-row" key={r.memberId}>
              <span style={{ display: "flex", alignItems: "center", gap: "0.35rem", color: i === 0 ? "var(--gold-bright)" : "inherit" }}>
                {i === 0 && <Trophy size={12} />}{renderAvatar(r.memberId)}{nameOf(r.memberId)}
              </span>
              <span style={{ marginLeft: "auto" }}>{r.score} / {weekQuestions.length}</span>
            </div>
          ))}
        </div>
      )}
      {!canSeePoolPicks && (
        <div className="sb-empty">Submit your own picks to see everyone else's and the live leaderboard.</div>
      )}
    </div>
  );

  // ---------- survivor pool ----------
  const survivorPicksByWeek = useMemo(() => {
    const byWeek = {};
    survivorPicks.forEach((p) => {
      if (!byWeek[p.week]) byWeek[p.week] = {};
      byWeek[p.week][p.memberId] = p.pickMemberId;
    });
    return byWeek;
  }, [survivorPicks]);

  const survivorStatus = useMemo(
    () => computeSurvivorStatus(members, survivorPicksByWeek, currentWeek, weekCache),
    [members, survivorPicksByWeek, currentWeek, weekCache],
  );

  const mySurvivorEntry = survivorEntries.find((e) => e.memberId === viewer) || null;
  const myStatus = survivorStatus[viewer] || { alive: true, eliminatedWeek: null };
  const mySurvivorPick = survivorPicksByWeek[activeWeek]?.[viewer] || "";
  const survivorLocked = weekPicksLocked(activeWeek, currentWeek, activeWeekData);
  const iHaveSubmittedSurvivor = !!mySurvivorPick;
  const canSeeSurvivorWeekPicks = iHaveSubmittedSurvivor || survivorLocked;
  const survivorWeekPicks = useMemo(
    () => survivorPicks.filter((p) => p.week === activeWeek),
    [survivorPicks, activeWeek],
  );
  const survivorUsedIds = useMemo(() => new Set(
    survivorPicks.filter((p) => p.memberId === viewer && p.week !== activeWeek).map((p) => p.pickMemberId),
  ), [survivorPicks, viewer, activeWeek]);
  const survivorPot = survivorEntries.filter((e) => e.paid).length * (Number(league.survivorEntryFee) || 5);
  const survivorLeaderboard = useMemo(() => {
    const alive = [];
    const eliminated = [];
    members.forEach((m) => {
      const s = survivorStatus[m.id] || { alive: true, eliminatedWeek: null };
      (s.alive ? alive : eliminated).push({ memberId: m.id, ...s });
    });
    eliminated.sort((a, b) => (b.eliminatedWeek || 0) - (a.eliminatedWeek || 0));
    return { alive, eliminated };
  }, [members, survivorStatus]);

  useEffect(() => {
    setMySurvivorDraft(mySurvivorPick);
    // only reset the draft when the viewer switches weeks, not on every realtime pick update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWeek, viewer]);

  async function submitMySurvivorPick() {
    if (!mySurvivorDraft) {
      setSurvivorError("Pick a manager before submitting.");
      return;
    }
    setSurvivorSaving(true);
    setSurvivorError(null);
    try {
      await survivorApi.submitPick(league.dbId, activeWeek, dbIdByOwnerId[viewer], dbIdByOwnerId[mySurvivorDraft]);
    } catch (err) {
      setSurvivorError(err.message || "Couldn't save your pick — try again.");
    } finally {
      setSurvivorSaving(false);
    }
  }

  async function toggleSurvivorPaid() {
    if (!mySurvivorEntry) return;
    try {
      await survivorApi.setPaid(mySurvivorEntry.id, !mySurvivorEntry.paid);
    } catch {
      // best-effort — the toggle will just not flip visually
    }
  }

  const renderSurvivorTab = () => (
    <div>
      {renderWeekNav()}
      <div className="sb-board sb-pool-strip">
        <h3>Survivor Pool</h3>
        <p className="sb-note">
          ${league.survivorEntryFee || 5} to enter · {survivorEntries.filter((e) => e.paid).length} paid in ·
          pot is ${survivorPot}. Pick one manager each week you think wins their real Sleeper matchup — pick
          wrong, or reuse a manager you've already picked, and you're out. Last one standing takes the pot.
        </p>
        {mySurvivorEntry && (
          <button type="button" className={`sb-btn ${mySurvivorEntry.paid ? "sb-btn-accept" : "sb-btn-submit"}`} onClick={toggleSurvivorPaid}>
            {mySurvivorEntry.paid ? <Check size={12} /> : <Coins size={12} />} {mySurvivorEntry.paid ? "You're paid in" : "Mark yourself paid"}
          </button>
        )}
      </div>

      <div className="sb-board">
        <h3>Week {activeWeek} Pick</h3>
        {!myStatus.alive && (
          <div className="sb-empty">You were eliminated in Week {myStatus.eliminatedWeek}.</div>
        )}
        {myStatus.alive && survivorLocked && !iHaveSubmittedSurvivor && (
          <div className="sb-empty">This week's survivor picks have already started — picks are locked.</div>
        )}
        {myStatus.alive && (!survivorLocked || iHaveSubmittedSurvivor) && (
          <>
            <div className="sb-pool-question">
              <label>Who wins their matchup this week?</label>
              <select
                value={mySurvivorDraft}
                disabled={survivorLocked}
                onChange={(e) => setMySurvivorDraft(e.target.value)}
              >
                <option value="">Select a manager…</option>
                {members.filter((m) => !survivorUsedIds.has(m.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            {survivorError && <div className="sb-error-banner"><AlertTriangle size={12} /> {survivorError}</div>}
            {!survivorLocked && (
              <div className="sb-form-actions">
                <button type="button" className="sb-btn sb-btn-submit" onClick={submitMySurvivorPick} disabled={survivorSaving}>
                  {survivorSaving ? "Saving…" : iHaveSubmittedSurvivor ? "Update Pick" : "Submit Pick"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {canSeeSurvivorWeekPicks && survivorWeekPicks.length > 0 && (
        <div className="sb-board">
          <h3>This Week's Picks</h3>
          {survivorWeekPicks.map((p) => (
            <div className="sb-owe-row" key={p.id}>
              <span>{nameOf(p.memberId)}</span>
              <span style={{ marginLeft: "auto" }}>{nameOf(p.pickMemberId)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="sb-board">
        <h3>Standings</h3>
        <div className="sb-note">Alive</div>
        {survivorLeaderboard.alive.length === 0 && <div className="sb-empty">Nobody's alive.</div>}
        {survivorLeaderboard.alive.map((r) => (
          <div className="sb-owe-row" key={r.memberId}>
            <span style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>{renderAvatar(r.memberId)}{nameOf(r.memberId)}</span>
          </div>
        ))}
        {survivorLeaderboard.eliminated.length > 0 && (
          <>
            <div className="sb-note" style={{ marginTop: "0.6rem" }}>Eliminated</div>
            {survivorLeaderboard.eliminated.map((r) => (
              <div className="sb-owe-row" key={r.memberId} style={{ opacity: 0.6 }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>{renderAvatar(r.memberId)}{nameOf(r.memberId)}</span>
                <span style={{ marginLeft: "auto" }}>Wk {r.eliminatedWeek}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );

  useEffect(() => {
    if (demo) return;
    weekCacheRef.current = {};
    setWeekCache({});
    // league.dbId included so switching leagues always clears week data even when two leagues
    // share the same season/scoring (switchLeague already clears it directly too — this is a
    // defense-in-depth backstop, not the only thing preventing one league's week data from
    // showing under another's label).
  }, [demo, league.dbId, league.scoringField, league.season, league.projectionSeason]);

  useEffect(() => {
    if (!leagueReady || !league.leagueId) return;
    prefetchSeasonWeeks(currentWeek);
  }, [leagueReady, league.leagueId, currentWeek, prefetchSeasonWeeks]);

  useEffect(() => {
    if (!leagueReady || !league.leagueId) return;
    const viewWeek = tab === "matchup" ? matchupWeek : activeWeek;
    loadWeekData(viewWeek, { showSpinner: true });
  }, [leagueReady, league.leagueId, activeWeek, matchupWeek, tab, loadWeekData]);

  // ---------- keep the current week's player/team projections & live scores fresh ----------
  // Sleeper updates these throughout the week (injury news, lineup locks, in-game stats), so
  // silently re-fetch on an interval instead of only ever showing what was cached on first load.
  useEffect(() => {
    if (demo || !leagueReady || !league.leagueId) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      loadWeekData(currentWeek, { force: true });
    }, PROJECTIONS_POLL_MS);
    return () => clearInterval(interval);
  }, [demo, leagueReady, league.leagueId, currentWeek, loadWeekData]);

  const weekBets = useMemo(
    () => bets.filter((b) => Number(b.week) === activeWeek),
    [bets, activeWeek],
  );

  const seasonBets = useMemo(
    () => bets.filter((b) => b.week == null || b.week === ""),
    [bets],
  );

  const weeklyLedger = useMemo(() => computeLedger(bets, members, activeWeek), [bets, members, activeWeek]);

  // Sleeper's per-week matchup data reflects a manager's current lineup even before kickoff,
  // so prefer it over the roster snapshot taken at connect/refresh time — otherwise a lineup
  // change in Sleeper wouldn't show up here until someone hits "Refresh league".
  const activeWeekMembers = useMemo(
    () => withLiveStarters(members, activeWeekData),
    [members, activeWeekData],
  );
  const matchupWeekMembers = useMemo(
    () => withLiveStarters(members, matchupWeekData),
    [members, matchupWeekData],
  );

  const weeklyBoardOfferings = useMemo(
    () => generateWeeklyBoardOfferings(
      activeWeekMembers,
      activeWeek,
      activeWeekData,
      activeProjections,
      league.scoringLabel,
    ),
    [activeWeekMembers, activeWeek, activeWeekData, activeProjections, league.scoringLabel],
  );

  const seasonBoardOfferings = useMemo(
    () => generateSeasonBoardOfferings(members, playoffTeams, weekCache, currentWeek),
    [members, playoffTeams, weekCache, currentWeek],
  );

  const filteredWeeklyBoardOfferings = useMemo(
    () => weeklyBoardOfferings.filter((o) => offeringInvolvesMember(o, boardFantasyTeam)),
    [weeklyBoardOfferings, boardFantasyTeam],
  );

  const filteredSeasonBoardOfferings = useMemo(
    () => seasonBoardOfferings.filter((o) => offeringInvolvesMember(o, boardFantasyTeam)),
    [seasonBoardOfferings, boardFantasyTeam],
  );

  const weeklyBoardEvents = useMemo(
    () => groupBoardOfferingsByKind(filteredWeeklyBoardOfferings, WEEKLY_BOARD_GROUPS),
    [filteredWeeklyBoardOfferings],
  );

  const seasonBoardEvents = useMemo(
    () => groupBoardOfferingsByKind(filteredSeasonBoardOfferings, SEASON_BOARD_GROUPS),
    [filteredSeasonBoardOfferings],
  );

  const viewerMember = useMemo(
    () => matchupWeekMembers.find((m) => m.id === viewer) || null,
    [matchupWeekMembers, viewer],
  );

  const matchupDataReady = !!weekCache[matchupWeek];

  const matchupOpponent = useMemo(() => {
    if (!matchupDataReady || !viewer) return null;
    return getMatchupOpponent(viewer, matchupWeekMembers, matchupWeekData);
  }, [matchupDataReady, viewer, matchupWeekMembers, matchupWeekData]);

  const matchupOfferings = useMemo(() => {
    if (!viewerMember || !matchupOpponent || !matchupDataReady) return [];
    return buildMatchupOfferings(
      viewerMember,
      matchupOpponent,
      matchupWeek,
      players,
      matchupProjections,
      league.scoringLabel,
    );
  }, [viewerMember, matchupOpponent, matchupWeek, players, matchupProjections, matchupDataReady, league.scoringLabel]);

  const myStarterRows = useMemo(
    () => (viewerMember && matchupDataReady
      ? starterRows(viewerMember, players, matchupProjections, matchupWeekData)
      : []),
    [viewerMember, players, matchupProjections, matchupWeekData, matchupDataReady],
  );

  const oppStarterRows = useMemo(
    () => (matchupOpponent && matchupDataReady
      ? starterRows(matchupOpponent, players, matchupProjections, matchupWeekData)
      : []),
    [matchupOpponent, players, matchupProjections, matchupWeekData, matchupDataReady],
  );

  const myLineupProj = viewerMember ? (sumLineupProjections(viewerMember, matchupProjections) ?? 0) : 0;
  const oppLineupProj = matchupOpponent ? (sumLineupProjections(matchupOpponent, matchupProjections) ?? 0) : 0;

  const boardViewerMember = useMemo(
    () => activeWeekMembers.find((m) => m.id === viewer) || null,
    [activeWeekMembers, viewer],
  );

  const myStarterPicks = useMemo(
    () => starterPickOptions(boardViewerMember, players, activeProjections),
    [boardViewerMember, players, activeProjections],
  );

  const customOppMember = useMemo(
    () => activeWeekMembers.find((m) => m.id === customH2H.oppMemberId) || null,
    [activeWeekMembers, customH2H.oppMemberId],
  );

  const myPlayerMeta = players[customH2H.myPlayerId];
  const oppPosFilter = customMatchPos && myPlayerMeta?.position ? myPlayerMeta.position : "all";

  const oppStarterPicks = useMemo(
    () => starterPickOptions(customOppMember, players, activeProjections, oppPosFilter),
    [customOppMember, players, activeProjections, oppPosFilter],
  );

  const customH2hOffering = useMemo(
    () => buildCustomH2hOffering(
      viewer,
      customH2H.myPlayerId,
      customH2H.oppMemberId,
      customH2H.oppPlayerId,
      activeWeek,
      players,
      activeProjections,
      members,
    ),
    [viewer, customH2H, activeWeek, players, activeProjections, members],
  );

  const matchupBetOffering = useMemo(() => {
    const { my, opp } = matchupPlayerPick;
    if (my && opp && matchupOpponent) {
      return buildCustomH2hOffering(
        viewer,
        my,
        matchupOpponent.id,
        opp,
        matchupWeek,
        players,
        matchupProjections,
        members,
      );
    }
    const singleId = my || opp;
    if (!singleId || !matchupOpponent) return null;
    const ownerId = my ? viewer : matchupOpponent.id;
    const counterpartyId = my ? matchupOpponent.id : viewer;
    return buildSinglePlayerOuOffering(singleId, ownerId, counterpartyId, matchupWeek, players, matchupProjections);
  }, [
    matchupPlayerPick,
    matchupOpponent,
    viewer,
    matchupWeek,
    players,
    matchupProjections,
  ]);

  useEffect(() => {
    setMatchupPlayerPick({ my: "", opp: "" });
    setBetSlipPick(null);
  }, [tab, matchupWeek, matchupOpponent?.id]);

  const handleMatchupPlayerClick = (pid, isYou) => {
    setBetSlipPick(null);
    setMatchupPlayerPick((prev) => {
      if (isYou) {
        const my = prev.my === pid ? "" : pid;
        return { my, opp: prev.opp };
      }
      const opp = prev.opp === pid ? "" : pid;
      return { my: prev.my, opp };
    });
  };

  const boardStake = () => Number(globalStake) || 10;

  const selectBetPick = (offering, side) => {
    setBetSlipPick({ offering, side });
  };

  const renderMarketRow = (o) => (
    <div className="dk-market" key={o.id}>
      <div className="dk-market-head">
        <div className="dk-market-title">{o.title}</div>
        <div className="dk-market-meta">{o.subtitle}</div>
      </div>
      <div className="dk-odds-row">
        {o.sides.map((side) => {
          const selected = betSlipPick?.offering?.id === o.id && betSlipPick?.side?.key === side.key;
          return (
            <button
              type="button"
              key={side.key}
              className={`dk-odds-btn${selected ? " selected" : ""}`}
              onClick={() => selectBetPick(o, side)}
            >
              <span className="dk-odds-label">{side.label}</span>
              {side.sublabel && <span className="dk-odds-sublabel">{side.sublabel}</span>}
              {side.pick && <span className="dk-odds-sublabel">{(side.displaySide || side.pick) === "over" ? "Over" : "Under"}</span>}
              <span className="dk-odds-value">{formatOdds(side.odds)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const renderEventCard = (title, subtitle, markets, keyId = title) => (
    <div className="dk-event" key={keyId}>
      <div className="dk-event-header">
        <div className="dk-event-title">{title}</div>
        {subtitle && <div className="dk-event-sub">{subtitle}</div>}
      </div>
      <div className="dk-event-markets">{markets}</div>
    </div>
  );

  const toggleBoardGroup = (id) => {
    setCollapsedBoardGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const renderCollapsibleEventCard = (ev) => {
    const collapsed = collapsedBoardGroups.has(ev.id);
    return (
      <div className="dk-event" key={ev.id}>
        <button type="button" className="dk-event-header dk-event-header-toggle" onClick={() => toggleBoardGroup(ev.id)}>
          <div>
            <div className="dk-event-title">{ev.title}</div>
            {ev.subtitle && <div className="dk-event-sub">{ev.subtitle}</div>}
          </div>
          <ChevronRight size={18} className={`dk-event-chevron${collapsed ? "" : " expanded"}`} />
        </button>
        {!collapsed && <div className="dk-event-markets">{ev.markets.map(renderMarketRow)}</div>}
      </div>
    );
  };

  const renderBetSlipBar = () => {
    if (!betSlipPick) return null;
    const { offering, side } = betSlipPick;
    const stake = boardStake();
    const toWin = payoutFromOdds(stake, side.odds);
    return (
      <div className="dk-betslip">
        <div className="dk-betslip-inner">
          <div className="dk-betslip-pick">
            <div className="dk-betslip-label">Bet slip</div>
            <div className="dk-betslip-title">{offering.title}</div>
            <div className="dk-betslip-detail">{side.label} · {formatOdds(side.odds)}</div>
          </div>
          <div className="dk-betslip-actions">
            <div className="dk-betslip-stake-wrap">
              <label>Wager</label>
              <input
                type="number"
                min="1"
                className="dk-betslip-stake"
                value={globalStake}
                onChange={(e) => setGlobalStake(e.target.value)}
              />
            </div>
            <div className="dk-betslip-payout">
              <span>Pays</span>
              <strong>${toWin}</strong>
            </div>
            <button type="button" className="dk-betslip-place" onClick={() => placeBoardBet(offering, side)}>
              Place Bet · ${stake}
            </button>
            <button type="button" className="dk-betslip-clear" onClick={() => setBetSlipPick(null)} aria-label="Clear">
              <X size={16} />
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderStarterColumn = (member, rows, totalProj, isYou) => {
    const selectedId = isYou ? matchupPlayerPick.my : matchupPlayerPick.opp;
    return (
      <div className={`sb-matchup-team${isYou ? " you" : ""}`}>
        <h4>{member.name}{isYou ? " (You)" : ""}</h4>
        <div className="sb-matchup-total">
          Upcoming Sleeper {league.scoringLabel} proj: <strong>{formatProj(totalProj)}</strong>
          {matchupWeekData[member.rosterId]?.points != null && (
            <> · Actual: <strong>{matchupWeekData[member.rosterId].points}</strong></>
          )}
        </div>
        {rows.map((row) => (
          <button
            type="button"
            className={`sb-matchup-player${row.isStarter ? "" : " bench"}${selectedId === row.pid ? " selected" : ""}`}
            key={row.pid}
            onClick={() => handleMatchupPlayerClick(row.pid, isYou)}
            title={isYou ? "Tap to bet this player" : "Tap to bet against this player"}
          >
            <span className="sb-matchup-pos">{row.position}</span>
            <div>
              <div className="sb-matchup-name">
                {row.name}
                {!row.isStarter && <span className="sb-matchup-bench-tag">BN</span>}
              </div>
              {row.team && <div className="sb-matchup-meta">{row.team}</div>}
            </div>
            <span className="sb-matchup-proj" title={`Sleeper ${league.scoringLabel} projection`}>{formatProj(row.proj)}</span>
            <span className="sb-matchup-actual" title="Actual points">{row.actual != null ? row.actual.toFixed(1) : "—"}</span>
          </button>
        ))}
      </div>
    );
  };

  function placeBoardBet(offering, side) {
    const stake = boardStake();
    if (stake < 1) return;

    let title = offering.title;
    const bet = {
      type: offering.type,
      title,
      creator: viewer,
      // Matchup/Player-vs-Player offerings that carry a specific counterparty (the Matchup tab,
      // and the Matchup/Player-vs-Player Create Side Bet builders) go straight to that person —
      // everything else (the Board tab's generic lines on matchups you're not part of) stays open
      // for any league member to accept.
      opponent: offering.counterpartyId ?? null,
      stake,
      status: "pending",
      result: null,
      boardLineId: offering.id,
      boardKind: offering.kind,
      odds: side.odds,
      toWin: payoutFromOdds(stake, side.odds),
      ...(offering.type !== "season" ? { week: offering.week } : {}),
    };

    if (offering.kind === "lineup_ml") {
      bet.pickMemberId = side.memberId;
      bet.matchupPeerId = side.memberId === offering.memberA ? offering.memberB : offering.memberA;
      title = `${nameOf(side.memberId)} lineup beats ${nameOf(bet.matchupPeerId)} @ ${formatOdds(side.odds)} (Week ${offering.week})`;
      bet.title = title;
    } else if (offering.kind === "lineup_spread") {
      bet.subjectId = side.subjectId;
      bet.matchupPeerId = side.peerId;
      bet.line = side.signedLine;
      bet.creatorSide = "over";
      title = `${side.label} covers @ ${formatOdds(side.odds)} (Week ${offering.week})`;
      bet.title = title;
    } else if (offering.kind === "player_ou") {
      bet.playerId = offering.playerId;
      bet.line = offering.line;
      bet.creatorSide = side.pick;
      bet.ownerId = offering.ownerId;
      title = `${playerLabel(players, offering.playerId)} ${side.pick === "over" ? "Over" : "Under"} ${offering.line} pts @ ${formatOdds(side.odds)}`;
      bet.title = title;
    } else if (offering.kind === "lineup_ou") {
      bet.line = offering.line;
      bet.creatorSide = side.pick;
      bet.subjectId = offering.subjectId;
      title = `${nameOf(offering.subjectId)} lineup ${side.pick === "over" ? "Over" : "Under"} ${offering.line} pts @ ${formatOdds(side.odds)}`;
      bet.title = title;
    } else if (offering.kind === "player_h2h") {
      bet.playerIdA = offering.playerIdA;
      bet.playerIdB = offering.playerIdB;
      bet.pickPlayerId = side.playerId;
      title = `${playerLabel(players, side.playerId)} beats ${playerLabel(players, side.playerId === offering.playerIdA ? offering.playerIdB : offering.playerIdA)} @ ${formatOdds(side.odds)}`;
      bet.title = title;
    } else if (SINGLE_PICK_BOARD_KINDS.includes(offering.kind)) {
      bet.subjectId = offering.subjectId;
      title = `${side.label} @ ${formatOdds(side.odds)}`;
      bet.title = title;
    } else if (offering.kind === "weekly_blowout" || offering.kind === "weekly_closest") {
      bet.subjectId = offering.subjectId;
      bet.matchupPeerId = offering.matchupPeerId;
      title = `${side.label} @ ${formatOdds(side.odds)} (Week ${offering.week})`;
      bet.title = title;
    } else if (offering.kind === "season_playoffs") {
      bet.subjectId = offering.subjectId;
      bet.creatorSide = side.pick;
      title = `${side.label} @ ${formatOdds(side.odds)}`;
      bet.title = title;
    }

    betsApi.insertBet(league.dbId, bet, dbIdByOwnerId).catch((err) => {
      window.alert(err.message || "Couldn't place that bet — try again.");
    });
    setBetSlipPick(null);
    setTab("slips");
    setSelectedWeek(offering.week ?? activeWeek);
  }

  function openBuilderCategory(cat) {
    const oppDefault = matchupOpponent?.id || defaultOpponent;
    if (cat === "matchup") setMatchupBuilder((f) => ({ ...f, opponent: f.opponent || oppDefault }));
    if (cat === "total") setTotalBuilder((f) => ({ ...f, subjectId: f.subjectId || viewer }));
    setBuilderCategory(cat);
  }

  const renderBuilderBack = (label) => (
    <button type="button" className="sb-builder-back" onClick={() => setBuilderCategory(null)}>
      <ChevronLeft size={16} /> {label}
    </button>
  );

  function renderBuilderCategoryPicker() {
    return (
      <>
        <h3>Create Side Bet</h3>
        <p className="sb-note" style={{ color: "#6b6144" }}>
          Rosters, projections, and scores come straight from Sleeper — just pick numbers and sides.
        </p>
        <div className="sb-builder-categories">
          <button type="button" className="sb-builder-category-btn" onClick={() => openBuilderCategory("matchup")}>
            <Swords size={20} />
            <span className="sb-builder-category-title">Matchup</span>
            <span className="sb-builder-category-sub">Who wins — moneyline or spread</span>
          </button>
          <button type="button" className="sb-builder-category-btn" onClick={() => openBuilderCategory("total")}>
            <TrendingUp size={20} />
            <span className="sb-builder-category-title">Point Total</span>
            <span className="sb-builder-category-sub">Over/under on a team's score</span>
          </button>
          <button type="button" className="sb-builder-category-btn" onClick={() => openBuilderCategory("prop")}>
            <User size={20} />
            <span className="sb-builder-category-title">Player Prop</span>
            <span className="sb-builder-category-sub">Over/under on one player</span>
          </button>
          <button type="button" className="sb-builder-category-btn" onClick={() => openBuilderCategory("battle")}>
            <Users size={20} />
            <span className="sb-builder-category-title">Player vs Player</span>
            <span className="sb-builder-category-sub">Whose player scores more</span>
          </button>
        </div>
        <div className="sb-form-actions" style={{ marginTop: "0.85rem" }}>
          <button type="button" className="sb-btn sb-btn-cancel" onClick={() => { setBuilderOpen(false); setShowForm(true); }}>
            Need something else? Write a custom slip
          </button>
          <button type="button" className="sb-btn sb-btn-cancel" onClick={() => setBuilderOpen(false)}>Cancel</button>
        </div>
      </>
    );
  }

  function renderMatchupBuilder() {
    const oppMember = activeWeekMembers.find((m) => m.id === matchupBuilder.opponent) || null;
    const myProj = sumLineupProjections(boardViewerMember, activeProjections) ?? 0;
    const oppProj = oppMember ? (sumLineupProjections(oppMember, activeProjections) ?? 0) : 0;
    const probMe = winProbFromSpread(myProj - oppProj);
    const favoriteIsMe = myProj >= oppProj;
    const defaultSpread = Math.round(Math.abs(myProj - oppProj) * 2) / 2 || 0.5;
    const spreadLine = Number(matchupBuilder.spreadLine) || defaultSpread;
    const spreadRatio = Number(matchupBuilder.spreadRatio) > 0 ? Number(matchupBuilder.spreadRatio) : 1;
    const spreadOdds = oddsFromRatio(spreadRatio);

    let offering = null;
    if (oppMember) {
      if (matchupBuilder.format === "moneyline") {
        offering = {
          id: `builder-ml-${activeWeek}-${viewer}-${oppMember.id}`,
          kind: "lineup_ml", type: "matchup", week: activeWeek,
          title: `${nameOf(viewer)} vs ${oppMember.name} — moneyline`,
          subtitle: `Week ${activeWeek} · proj ${formatProj(myProj)} vs ${formatProj(oppProj)}`,
          memberA: viewer, memberB: oppMember.id,
          counterpartyId: oppMember.id,
          sides: [
            { key: "a", memberId: viewer, label: nameOf(viewer), odds: americanOdds(probMe) },
            { key: "b", memberId: oppMember.id, label: oppMember.name, odds: americanOdds(1 - probMe) },
          ],
        };
      } else {
        // Alternate-spread style: either team can be picked laying points (-X) or getting
        // points (+X), regardless of which one Sleeper's projections actually favor — a friend
        // can bet "the underdog by -2" if they disagree with the projection. Each side just
        // asks "does this team's own margin beat this signed threshold", which is exactly what
        // autoGrade's existing lineup_spread math already computes (subject's pts − peer's pts
        // vs. line) — a negative line for the "+X" buttons is all that's needed, no grading
        // changes required. creatorSide is always "over" since every button is phrased as a
        // direct claim ("this team covers this number"), never its negation.
        offering = {
          id: `builder-spread-${activeWeek}-${viewer}-${oppMember.id}`,
          kind: "lineup_spread", type: "matchup", week: activeWeek,
          title: `${nameOf(viewer)} vs ${oppMember.name} — spread`,
          subtitle: `Week ${activeWeek} · proj ${formatProj(myProj)} vs ${formatProj(oppProj)}`,
          counterpartyId: oppMember.id,
          sides: [
            { key: "me-minus", memberId: viewer, label: `${nameOf(viewer)} -${formatProj(spreadLine)}`, subjectId: viewer, peerId: oppMember.id, signedLine: spreadLine, odds: spreadOdds },
            { key: "me-plus", memberId: viewer, label: `${nameOf(viewer)} +${formatProj(spreadLine)}`, subjectId: viewer, peerId: oppMember.id, signedLine: -spreadLine, odds: spreadOdds },
            { key: "opp-minus", memberId: oppMember.id, label: `${oppMember.name} -${formatProj(spreadLine)}`, subjectId: oppMember.id, peerId: viewer, signedLine: spreadLine, odds: spreadOdds },
            { key: "opp-plus", memberId: oppMember.id, label: `${oppMember.name} +${formatProj(spreadLine)}`, subjectId: oppMember.id, peerId: viewer, signedLine: -spreadLine, odds: spreadOdds },
          ],
        };
      }
    }

    return (
      <>
        {renderBuilderBack("Matchup")}
        <div className="sb-form-row">
          <div className="sb-field">
            <label>Opponent</label>
            <select value={matchupBuilder.opponent} onChange={(e) => setMatchupBuilder((f) => ({ ...f, opponent: e.target.value }))}>
              <option value="">Select a manager…</option>
              {members.filter((m) => m.id !== viewer).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>
        {oppMember && (
          <>
            {matchupBuilder.format === "moneyline" ? (
              <p className="sb-note" style={{ color: "#6b6144" }}>
                Projected: {nameOf(viewer)} {formatProj(myProj)} · {oppMember.name} {formatProj(oppProj)} · {nameOf(viewer)} win probability {Math.round(probMe * 100)}%
              </p>
            ) : (
              <p className="sb-note" style={{ color: "#6b6144" }}>
                Projected: {nameOf(viewer)} {formatProj(myProj)} · {oppMember.name} {formatProj(oppProj)} · projected spread{" "}
                {nameOf(favoriteIsMe ? viewer : oppMember.id)} -{formatProj(defaultSpread)}
              </p>
            )}
            <div className="sb-format-toggle">
              <button type="button" className={matchupBuilder.format === "moneyline" ? "active" : ""} onClick={() => setMatchupBuilder((f) => ({ ...f, format: "moneyline" }))}>Moneyline</button>
              <button type="button" className={matchupBuilder.format === "spread" ? "active" : ""} onClick={() => setMatchupBuilder((f) => ({ ...f, format: "spread" }))}>Custom Spread</button>
            </div>
            {matchupBuilder.format === "spread" && (
              <div className="sb-form-row">
                <div className="sb-field" style={{ maxWidth: 140 }}>
                  <label>Spread (pts)</label>
                  <input type="number" min="0.5" step="0.5" value={matchupBuilder.spreadLine || defaultSpread}
                    onChange={(e) => setMatchupBuilder((f) => ({ ...f, spreadLine: e.target.value }))} />
                </div>
                <div className="sb-field" style={{ maxWidth: 140 }}>
                  <label>Payout ratio</label>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                    <input type="number" min="0.1" step="0.1" value={matchupBuilder.spreadRatio || spreadRatio}
                      onChange={(e) => setMatchupBuilder((f) => ({ ...f, spreadRatio: e.target.value }))} />
                    <span style={{ color: "#6b6144" }}>: 1 ({formatOdds(spreadOdds)})</span>
                  </div>
                </div>
              </div>
            )}
            {offering && renderMarketRow(offering)}
          </>
        )}
      </>
    );
  }

  function renderTotalBuilder() {
    const subjMember = activeWeekMembers.find((m) => m.id === totalBuilder.subjectId) || boardViewerMember;
    const subjProj = subjMember ? (sumLineupProjections(subjMember, activeProjections) ?? 0) : 0;
    const defaultLine = betLineFromProj(subjProj) ?? 0;
    const line = totalBuilder.line !== "" ? Number(totalBuilder.line) : defaultLine;

    const offering = subjMember ? {
      id: `builder-total-${activeWeek}-${subjMember.id}`,
      kind: "lineup_ou", type: "prop", week: activeWeek,
      title: `${subjMember.name} lineup O/U ${formatProj(line)} fantasy pts`,
      subtitle: `Week ${activeWeek} · projected ${formatProj(subjProj)}`,
      subjectId: subjMember.id,
      line,
      sides: [
        { key: "over", label: `Over ${formatProj(line)}`, pick: "over", odds: -110 },
        { key: "under", label: `Under ${formatProj(line)}`, pick: "under", odds: -110 },
      ],
    } : null;

    return (
      <>
        {renderBuilderBack("Point Total")}
        <div className="sb-form-row">
          <div className="sb-field">
            <label>Team</label>
            <select value={totalBuilder.subjectId} onChange={(e) => setTotalBuilder((f) => ({ ...f, subjectId: e.target.value, line: "" }))}>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div className="sb-field" style={{ maxWidth: 120 }}>
            <label>Line</label>
            <input type="number" step="0.5" value={totalBuilder.line || (subjMember ? defaultLine : "")}
              onChange={(e) => setTotalBuilder((f) => ({ ...f, line: e.target.value }))} />
          </div>
        </div>
        {subjMember && (
          <p className="sb-note" style={{ color: "#6b6144" }}>
            {subjMember.name}&rsquo;s live Sleeper projection: {formatProj(subjProj)} pts
          </p>
        )}
        {offering && renderMarketRow(offering)}
      </>
    );
  }

  function renderPropBuilder() {
    const ownerMember = findPlayerOwner(activeWeekMembers, propBuilder.playerId);
    const proj = propBuilder.playerId ? sleeperProj(propBuilder.playerId, activeProjections) : null;
    const defaultLine = betLineFromProj(proj) ?? 0;
    const line = propBuilder.line !== "" ? Number(propBuilder.line) : defaultLine;

    let offering = null;
    if (propBuilder.playerId) {
      offering = buildSinglePlayerOuOffering(propBuilder.playerId, ownerMember?.id || null, null, activeWeek, players, activeProjections);
      if (offering) offering.line = line;
    }

    return (
      <>
        {renderBuilderBack("Player Prop")}
        <div className="sb-form-row">
          <div className="sb-field">
            <label>Player</label>
            <select value={propBuilder.playerId} onChange={(e) => {
              setPropBuilder((f) => ({ ...f, playerId: e.target.value, line: "" }));
            }}>
              <option value="">Select a player…</option>
              {activeWeekMembers.map((m) => (
                <optgroup key={m.id} label={m.name}>
                  {(m.roster?.length ? m.roster : m.starters || [])
                    .filter((pid) => players[pid])
                    .map((pid) => (
                      <option key={pid} value={pid}>{players[pid].name} ({players[pid].position})</option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="sb-field" style={{ maxWidth: 120 }}>
            <label>Line</label>
            <input type="number" step="0.5" value={propBuilder.line || (propBuilder.playerId ? defaultLine : "")}
              onChange={(e) => setPropBuilder((f) => ({ ...f, line: e.target.value }))} />
          </div>
        </div>
        {ownerMember && (
          <p className="sb-note" style={{ color: "#6b6144" }}>
            Owned by {ownerMember.name} · Sleeper projection {formatProj(proj)} pts
          </p>
        )}
        {offering && renderMarketRow(offering)}
      </>
    );
  }

  function renderBattleBuilder() {
    return (
      <>
        {renderBuilderBack("Player vs Player")}
        <label className="dk-custom-toggle">
          <input
            type="checkbox"
            checked={customMatchPos}
            onChange={(e) => {
              setCustomMatchPos(e.target.checked);
              setCustomH2H((h) => ({ ...h, oppPlayerId: "" }));
            }}
          />
          Match same position only
        </label>
        <div className="dk-custom-row">
          <div className="dk-custom-field">
            <label>Your player</label>
            <select
              value={customH2H.myPlayerId}
              onChange={(e) => setCustomH2H((h) => ({ ...h, myPlayerId: e.target.value, oppPlayerId: "" }))}
            >
              <option value="">Select your player…</option>
              {myStarterPicks.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.position}) · {formatProj(p.proj)} proj</option>
              ))}
            </select>
            <div className="dk-player-chips">
              {myStarterPicks.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`dk-player-chip${customH2H.myPlayerId === p.id ? " active" : ""}`}
                  onClick={() => setCustomH2H((h) => ({ ...h, myPlayerId: p.id, oppPlayerId: "" }))}
                >
                  {p.position} {p.name}
                </button>
              ))}
            </div>
          </div>
          <div className="dk-custom-field">
            <label>Opponent&rsquo;s team</label>
            <select
              value={customH2H.oppMemberId}
              onChange={(e) => setCustomH2H((h) => ({ ...h, oppMemberId: e.target.value, oppPlayerId: "" }))}
            >
              <option value="">Select fantasy team…</option>
              {members.filter((m) => m.id !== viewer).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>
        {customH2H.oppMemberId && (
          <div className="dk-custom-field">
            <label>Their player{customMatchPos && myPlayerMeta?.position ? ` (${myPlayerMeta.position})` : ""}</label>
            <select
              value={customH2H.oppPlayerId}
              onChange={(e) => setCustomH2H((h) => ({ ...h, oppPlayerId: e.target.value }))}
            >
              <option value="">Select their player…</option>
              {oppStarterPicks.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.position}) · {formatProj(p.proj)} proj</option>
              ))}
            </select>
            <div className="dk-player-chips">
              {oppStarterPicks.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`dk-player-chip${customH2H.oppPlayerId === p.id ? " active" : ""}`}
                  onClick={() => setCustomH2H((h) => ({ ...h, oppPlayerId: p.id }))}
                >
                  {p.position} {p.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {customH2hOffering ? (
          <div style={{ marginTop: "0.75rem" }}>
            {renderMarketRow(customH2hOffering)}
          </div>
        ) : (
          <p className="sb-note" style={{ color: "#7ea08f", margin: "0.5rem 0 0" }}>
            Pick both players to see odds and place your battle bet.
          </p>
        )}
      </>
    );
  }

  const viewerStatement = useMemo(() => {
    const owes = weeklyLedger.pairs.filter((p) => p.from === viewer);
    const owed = weeklyLedger.pairs.filter((p) => p.to === viewer);
    return { owes, owed, net: weeklyLedger.totals[viewer] || 0 };
  }, [weeklyLedger, viewer]);

  async function advance(betId, action) {
    setBetErrors((e) => ({ ...e, [betId]: null }));
    const patch = {
      accept: { status: "accepted" },
      decline: { status: "declined" },
      cancel: { status: "cancelled" },
      lock: { status: "locked" },
      "grade-creator": { status: "settled", result: "creator" },
      "grade-opponent": { status: "settled", result: "opponent" },
    }[action];
    if (!patch) return;
    try {
      await betsApi.updateBetStatus(betId, patch);
    } catch (err) {
      setBetErrors((e) => ({ ...e, [betId]: err.message || "Couldn't update that bet — try again." }));
    }
  }

  async function acceptOpenBet(betId) {
    setBetErrors((e) => ({ ...e, [betId]: null }));
    try {
      await betsApi.updateBetStatus(betId, { status: "accepted", opponent: dbIdByOwnerId[viewer] });
    } catch (err) {
      setBetErrors((e) => ({ ...e, [betId]: err.message || "Couldn't accept that bet — try again." }));
    }
  }

  async function autoGrade(bet) {
    setBetErrors((e) => ({ ...e, [bet.id]: null }));
    const wk = Number(bet.week) || currentWeek;
    const loaded = await loadWeekData(wk);
    const weekData = weekCacheRef.current[wk]?.matchups ?? {};
    if (!loaded || !Object.keys(weekData).length) {
      setBetErrors((e) => ({
        ...e,
        [bet.id]: `Couldn't load week ${wk} scores from Sleeper — try again in a moment.`,
      }));
      return;
    }

    async function settle(patch) {
      try {
        await betsApi.updateBetStatus(bet.id, { status: "settled", ...patch });
      } catch (err) {
        setBetErrors((e) => ({ ...e, [bet.id]: err.message || "Couldn't save the grade — try again." }));
      }
    }

    async function voidBet() {
      try {
        await betsApi.updateBetStatus(bet.id, { status: "void" });
      } catch (err) {
        setBetErrors((e) => ({ ...e, [bet.id]: err.message || "Couldn't void this bet — try again." }));
      }
    }

    if (bet.type === "matchup") {
      if (bet.boardKind === "lineup_spread" && bet.subjectId && bet.matchupPeerId) {
        const fav = members.find((m) => m.id === bet.subjectId);
        const dog = members.find((m) => m.id === bet.matchupPeerId);
        if (!fav || !dog) {
          setBetErrors((e) => ({ ...e, [bet.id]: "Couldn't find both managers in this league." }));
          return;
        }
        const favPts = lineupFantasyPts(weekData, fav.rosterId, fav.starters);
        const dogPts = lineupFantasyPts(weekData, dog.rosterId, dog.starters);
        if (favPts == null || dogPts == null) {
          setBetErrors((e) => ({ ...e, [bet.id]: `Week ${wk} scores aren't available yet.` }));
          return;
        }
        const margin = favPts - dogPts;
        const over = margin > Number(bet.line);
        const creatorWins = (bet.creatorSide === "over" && over) || (bet.creatorSide === "under" && !over);
        await settle({ result: creatorWins ? "creator" : "opponent", actual: margin });
        return;
      }

      if (bet.boardKind === "weekly_high" || bet.boardKind === "weekly_low") {
        const scored = members
          .map((m) => ({ id: m.id, pts: lineupFantasyPts(weekData, m.rosterId, m.starters) }))
          .filter((r) => r.pts != null);
        if (!scored.length) {
          setBetErrors((e) => ({ ...e, [bet.id]: `Week ${wk} scores aren't available yet.` }));
          return;
        }
        const target = bet.boardKind === "weekly_high"
          ? Math.max(...scored.map((r) => r.pts))
          : Math.min(...scored.map((r) => r.pts));
        const winners = scored.filter((r) => r.pts === target).map((r) => r.id);
        if (winners.length > 1) {
          setBetErrors((e) => ({ ...e, [bet.id]: `Tied at ${target} pts among ${winners.length} teams — grade manually (push?).` }));
          return;
        }
        const creatorWins = winners[0] === bet.subjectId;
        await settle({ result: creatorWins ? "creator" : "opponent", actual: target });
        return;
      }

      if (bet.boardKind === "weekly_blowout" || bet.boardKind === "weekly_closest") {
        const weekPairs = getWeekPairs(weekData, members);
        const margins = weekPairs
          .map(([a, b]) => {
            const ptsA = lineupFantasyPts(weekData, a.rosterId, a.starters);
            const ptsB = lineupFantasyPts(weekData, b.rosterId, b.starters);
            if (ptsA == null || ptsB == null) return null;
            return { aId: a.id, bId: b.id, margin: Math.abs(ptsA - ptsB) };
          })
          .filter(Boolean);
        if (!margins.length) {
          setBetErrors((e) => ({ ...e, [bet.id]: `Week ${wk} scores aren't available yet.` }));
          return;
        }
        const target = bet.boardKind === "weekly_blowout"
          ? Math.max(...margins.map((r) => r.margin))
          : Math.min(...margins.map((r) => r.margin));
        const winners = margins.filter((r) => r.margin === target);
        if (winners.length > 1) {
          setBetErrors((e) => ({ ...e, [bet.id]: `Tied at a ${target}-pt margin among ${winners.length} matchups — grade manually (push?).` }));
          return;
        }
        const w = winners[0];
        const pairMatches = (w.aId === bet.subjectId && w.bId === bet.matchupPeerId)
          || (w.bId === bet.subjectId && w.aId === bet.matchupPeerId);
        await settle({ result: pairMatches ? "creator" : "opponent", actual: target });
        return;
      }

      const rA = rosterIdFor(bet.creator);
      const rB = rosterIdFor(bet.opponent);
      if (!rA || !rB) {
        setBetErrors((e) => ({ ...e, [bet.id]: "Couldn't find both managers in this league." }));
        return;
      }

      if (bet.pickMemberId && bet.matchupPeerId) {
        const mPick = members.find((m) => m.id === bet.pickMemberId);
        const mPeer = members.find((m) => m.id === bet.matchupPeerId);
        if (!mPick || !mPeer) {
          setBetErrors((e) => ({ ...e, [bet.id]: "Couldn't find both managers in this league." }));
          return;
        }
        const ptsPick = lineupFantasyPts(weekData, mPick.rosterId, mPick.starters);
        const ptsPeer = lineupFantasyPts(weekData, mPeer.rosterId, mPeer.starters);
        if (ptsPick == null || ptsPeer == null) {
          setBetErrors((e) => ({ ...e, [bet.id]: `Week ${wk} scores aren't available yet.` }));
          return;
        }
        if (ptsPick === ptsPeer) {
          setBetErrors((e) => ({ ...e, [bet.id]: `Tied at ${ptsPick} lineup pts — grade manually (push?).` }));
          return;
        }
        const pickWins = bet.pickMemberId === mPick.id ? ptsPick > ptsPeer : ptsPeer > ptsPick;
        await settle({ result: pickWins ? "creator" : "opponent", actual: ptsPick });
        return;
      }

      const dataA = weekData[rA];
      const dataB = weekData[rB];
      if (!dataA || !dataB) {
        setBetErrors((e) => ({ ...e, [bet.id]: `Week ${wk} scores aren't available yet.` }));
        return;
      }
      const result = dataA.points > dataB.points ? "creator"
        : dataA.points < dataB.points ? "opponent" : null;
      if (result === null) {
        setBetErrors((e) => ({ ...e, [bet.id]: `Tied at ${dataA.points} pts — grade manually (push?).` }));
        return;
      }
      await settle({ result });
      return;
    }

    if (bet.type === "prop") {
      if (bet.boardKind === "player_h2h" && bet.playerIdA && bet.playerIdB) {
        const ptsA = getPlayerPts(weekData, members, bet.playerIdA);
        const ptsB = getPlayerPts(weekData, members, bet.playerIdB);
        if (ptsA == null || ptsB == null) {
          if (wk < currentWeek) {
            await voidBet();
            return;
          }
          setBetErrors((e) => ({ ...e, [bet.id]: `Week ${wk} scores aren't available yet.` }));
          return;
        }
        if (ptsA === ptsB) {
          setBetErrors((e) => ({ ...e, [bet.id]: `Tied at ${ptsA} pts — grade manually (push?).` }));
          return;
        }
        const pickWins = bet.pickPlayerId === bet.playerIdA ? ptsA > ptsB : ptsB > ptsA;
        await settle({ result: pickWins ? "creator" : "opponent", actual: ptsA });
        return;
      }

      if (bet.boardKind === "lineup_ou" && bet.subjectId && bet.line !== "" && bet.line !== undefined) {
        const member = members.find((m) => m.id === bet.subjectId);
        if (!member) return;
        const actual = lineupFantasyPts(weekData, member.rosterId, member.starters);
        if (actual == null) {
          setBetErrors((e) => ({ ...e, [bet.id]: `Week ${wk} scores aren't available yet.` }));
          return;
        }
        const over = actual > Number(bet.line);
        const creatorWins = (bet.creatorSide === "over" && over) || (bet.creatorSide === "under" && !over);
        await settle({ result: creatorWins ? "creator" : "opponent", actual });
        return;
      }

      if (bet.subjectId && bet.line !== "" && bet.line !== undefined && !bet.playerId) {
        const rosterId = rosterIdFor(bet.subjectId);
        const data = weekData[rosterId];
        if (!data) {
          setBetErrors((e) => ({ ...e, [bet.id]: `Week ${wk} scores aren't available yet.` }));
          return;
        }
        const actual = data.points;
        const over = actual > Number(bet.line);
        const creatorWins = (bet.creatorSide === "over" && over) || (bet.creatorSide === "under" && !over);
        await settle({ result: creatorWins ? "creator" : "opponent", actual });
        return;
      }
      if (!bet.playerId || bet.line === "" || bet.line === undefined) {
        setBetErrors((e) => ({ ...e, [bet.id]: "This slip needs a Sleeper player ID and line — edit it to add one." }));
        return;
      }
      const row = Object.values(weekData).find((r) => r.players_points && bet.playerId in r.players_points);
      if (!row) {
        if (wk < currentWeek) {
          await voidBet();
          return;
        }
        setBetErrors((e) => ({ ...e, [bet.id]: `Week ${wk} scores aren't available yet.` }));
        return;
      }
      const actual = row.players_points[bet.playerId];
      const over = actual > Number(bet.line);
      const creatorWins = (bet.creatorSide === "over" && over) || (bet.creatorSide === "under" && !over);
      await settle({ result: creatorWins ? "creator" : "opponent", actual });
      return;
    }

    setBetErrors((e) => ({ ...e, [bet.id]: "This bet type isn't stat-based — grade it manually." }));
  }

  function submitBet(e) {
    e.preventDefault();
    if (!form.title.trim()) return;
    const newBet = {
      type: form.type,
      title: form.title.trim(), creator: viewer, opponent: null,
      stake: Number(form.stake) || 0, status: "pending", result: null,
      ...(isWeeklyBet(form.type) ? { week: Number(form.week) || Number(league.week) || 1 } : {}),
      ...(form.type === "prop"
        ? { playerId: form.playerId.trim(), line: form.line, creatorSide: form.creatorSide }
        : {}),
    };
    betsApi.insertBet(league.dbId, newBet, dbIdByOwnerId).catch((err) => {
      window.alert(err.message || "Couldn't post that slip — try again.");
    });
    setForm({
      type: "matchup", title: "", stake: 10,
      week: activeWeek,
      playerId: "", line: "", creatorSide: "over",
    });
    setShowForm(false);
    setTab("slips");
    setSelectedWeek(newBet.week ?? activeWeek);
  }

  function renderBetSlip(b) {
    const s = STATUS_STYLE[b.status] || STATUS_STYLE.pending;
    const isViewerCreator = b.creator === viewer;
    const isOpen = b.opponent == null;
    const canAcceptOpen = b.status === "pending" && isOpen && !isViewerCreator;
    const isViewerOpponent = b.opponent === viewer && b.status === "pending";
    const canAuto = AUTO_GRADABLE[b.type] && b.status === "locked";
    return (
      <div className="sb-ticket" key={b.id}>
        <div className="sb-stamp" style={{ color: s.color, transform: `rotate(${s.rotate}deg)` }}>{s.label}</div>
        <div className="sb-ticket-top">
          <div>
            <div className="sb-ticket-num">TICKET NO. {b.ticket}</div>
            <div className="sb-ticket-type" style={ticketAccentStyle(b)}>{ticketTypeLabel(b)}{b.week ? ` · Wk ${b.week}` : ""}</div>
            <div className="sb-ticket-title">{b.title}</div>
            <div className="sb-ticket-parties">
              {renderAvatar(b.creator)} {nameOf(b.creator)} <span style={{ opacity: 0.5 }}>vs</span>{" "}
              {b.opponent ? (<>{renderAvatar(b.opponent)} {nameOf(b.opponent)}</>) : "Open"}
            </div>
            {b.odds != null && (
              <div className="sb-ticket-odds">
                {formatOdds(b.odds)} · win ${b.toWin ?? payoutFromOdds(b.stake, b.odds)}
              </div>
            )}
          </div>
          <div className="sb-ticket-stake"><span>stake</span>${b.stake}</div>
        </div>

        <div className="sb-ticket-perf" />

        {b.status === "settled" ? (
          <div className="sb-result-line">
            <b>{nameOf(b.result === "creator" ? b.creator : b.opponent)}</b> won the slip —{" "}
            {nameOf(b.result === "creator" ? b.opponent : b.creator)} pays ${b.stake}
            {b.actual !== undefined ? ` (actual: ${b.actual} pts)` : ""}.
          </div>
        ) : b.status === "declined" ? (
          <div className="sb-result-line">Declined — no money moves.</div>
        ) : b.status === "cancelled" ? (
          <div className="sb-result-line">Cancelled by {nameOf(b.creator)} — no money moves.</div>
        ) : b.status === "void" ? (
          <div className="sb-result-line">Voided — a player in this bet didn't play. No money moves.</div>
        ) : (
          <>
            <div className="sb-ticket-actions">
              {b.status === "pending" && canAcceptOpen && (
                <button className="sb-btn sb-btn-accept" onClick={() => acceptOpenBet(b.id)}><Check size={12} /> Accept this bet</button>
              )}
              {b.status === "pending" && isViewerOpponent && (
                <>
                  <button className="sb-btn sb-btn-accept" onClick={() => advance(b.id, "accept")}><Check size={12} /> Accept</button>
                  <button className="sb-btn sb-btn-decline" onClick={() => advance(b.id, "decline")}><X size={12} /> Decline</button>
                </>
              )}
              {b.status === "pending" && isViewerCreator && (
                <>
                  <span className="sb-result-line">{isOpen ? "Open — waiting for someone to accept." : `Waiting on ${nameOf(b.opponent)} to accept.`}</span>
                  <button className="sb-btn sb-btn-decline" onClick={() => advance(b.id, "cancel")}><X size={12} /> Cancel</button>
                </>
              )}
              {b.status === "pending" && !isViewerCreator && !isOpen && !isViewerOpponent && (
                <span className="sb-result-line">Waiting on {nameOf(b.opponent)} to accept.</span>
              )}
              {b.status === "accepted" && (
                <button className="sb-btn sb-btn-lock" onClick={() => advance(b.id, "lock")}><Lock size={12} /> Lock at kickoff</button>
              )}
              {b.status === "locked" && (
                <>
                  {canAuto && (
                    <button className="sb-btn sb-btn-auto" onClick={() => autoGrade(b)}>
                      <Zap size={12} /> Auto-grade
                    </button>
                  )}
                  <span className="sb-result-line" style={{ margin: "0 0.1rem" }}>or by hand:</span>
                  <button className="sb-btn sb-btn-grade" onClick={() => advance(b.id, "grade-creator")}><Trophy size={12} /> {nameOf(b.creator)} won</button>
                  <button className="sb-btn sb-btn-grade" onClick={() => advance(b.id, "grade-opponent")}><Trophy size={12} /> {nameOf(b.opponent)} won</button>
                </>
              )}
            </div>
            {betErrors[b.id] && (
              <div className="sb-bet-error"><AlertTriangle size={12} /> {betErrors[b.id]}</div>
            )}
          </>
        )}
      </div>
    );
  }

  const weekSlipSummary = useMemo(() => {
    const open = weekBets.filter((b) => !["settled", "declined", "cancelled", "void"].includes(b.status));
    return {
      total: weekBets.length,
      open: open.length,
      stake: open.reduce((sum, b) => sum + b.stake, 0),
    };
  }, [weekBets]);

  if (bootstrapping) return <div className="sb-root" />;

  return (
    <div className="sb-root">
      {!league.linked && (
        <div className="sb-setup">
          <div className="sb-setup-card">
            <h2>Link Your League</h2>
            <p>
              Connect your Sleeper league to pull in every manager automatically.
              Your league is shared with everyone who joins it — bets and balances are the same for the whole group.
            </p>
            <div className="sb-field" style={{ color: "var(--paper)" }}>
              <label style={{ color: "#a9c4b6" }}>Sleeper league ID</label>
              <input
                type="text"
                placeholder="e.g. 987654321012345678"
                value={league.inputId}
                onChange={(e) => setLeague((s) => ({ ...s, inputId: e.target.value, error: null }))}
                style={{ background: "#0e211b", color: "var(--paper)", borderColor: "var(--line)" }}
              />
            </div>
            <p className="sb-note" style={{ marginTop: "-0.35rem" }}>
              Find it in the Sleeper app URL or league settings.
            </p>
            <div className="sb-form-actions">
              <button
                className="sb-btn sb-btn-submit"
                onClick={() => connectLeague(league.inputId)}
                disabled={league.loading || !league.inputId.trim()}
              >
                <Link2 size={12} /> {league.loading ? "Connecting…" : "Connect league"}
              </button>
            </div>
            {league.error && (
              <div className="sb-error-banner" style={{ marginTop: "0.75rem" }}>
                <AlertTriangle size={12} /> {league.error}
              </div>
            )}
            <button type="button" className="sb-signout-link" onClick={disconnectLeague}>
              Sign out
            </button>
          </div>
        </div>
      )}

      {league.linked && !viewer && (
        <ClaimManagerScreen
          leagueName={league.leagueName}
          members={members}
          onClaim={handleClaim}
          onSignOut={disconnectLeague}
          onBack={myLeagues.length > 1
            ? () => switchLeague(myLeagues.find((l) => l.id !== league.dbId)?.id)
            : null}
        />
      )}

      {leagueReady && (
        <>
      <div className="sb-marquee">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="sb-marquee-title sb-display">
              League Sportsbook
              {demo && <span className="sb-demo-badge">Demo Mode</span>}
            </div>
            <div className="sb-marquee-sub">
              {league.leagueName} · {league.projectionSeason} NFL · Week {currentWeek}
              {league.nflSeasonType && league.nflSeasonType !== "regular" ? ` · NFL ${league.nflSeasonType}` : ""}
              {" · "}{league.scoringLabel}
              {" · "}{BUILD_STAMP}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!demo && (
              <div className="sb-league-picker">
                <button
                  type="button"
                  className="sb-viewer-select sb-league-picker-btn"
                  onClick={() => setLeaguePickerOpen((o) => !o)}
                >
                  {league.leagueName} <ChevronDown size={12} />
                </button>
                {leaguePickerOpen && (
                  <div className="sb-league-picker-menu">
                    {myLeagues.map((l) => (
                      <button
                        type="button"
                        key={l.id}
                        className={`sb-league-picker-item${l.id === league.dbId ? " active" : ""}`}
                        onClick={() => switchLeague(l.id)}
                      >
                        {l.name}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="sb-league-picker-item sb-league-picker-add"
                      onClick={() => { setLeaguePickerOpen(false); setAddingLeague(true); }}
                    >
                      <Plus size={12} /> Add another league
                    </button>
                  </div>
                )}
              </div>
            )}
            <Users size={14} color="#a9c4b6" />
            <span className="sb-marquee-sub" style={{ color: "#a9c4b6" }}>viewing as</span>
            <span className="sb-viewer-select">{nameOf(viewer)}</span>
          </div>
        </div>
      </div>

      {addingLeague && (
        <div className="sb-setup" style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.5)" }}>
          <div className="sb-setup-card">
            <h2>Add Another League</h2>
            <p>
              Connect another Sleeper league to this account — your existing league and its bets
              stay exactly as they are.
            </p>
            <div className="sb-field" style={{ color: "var(--paper)" }}>
              <label style={{ color: "#a9c4b6" }}>Sleeper league ID</label>
              <input
                type="text"
                placeholder="e.g. 987654321012345678"
                value={addLeagueId}
                onChange={(e) => { setAddLeagueId(e.target.value); setAddLeagueError(null); }}
                style={{ background: "#0e211b", color: "var(--paper)", borderColor: "var(--line)" }}
              />
            </div>
            <div className="sb-form-actions">
              <button
                className="sb-btn sb-btn-submit"
                onClick={async () => {
                  setAddLeagueLoading(true);
                  await connectLeague(addLeagueId, { isAdditional: true });
                  setAddLeagueLoading(false);
                }}
                disabled={addLeagueLoading || !addLeagueId.trim()}
              >
                <Link2 size={12} /> {addLeagueLoading ? "Connecting…" : "Connect league"}
              </button>
              <button
                type="button"
                className="sb-btn sb-btn-cancel"
                style={{ color: "#a9c4b6", borderColor: "var(--line)" }}
                onClick={() => { setAddingLeague(false); setAddLeagueId(""); setAddLeagueError(null); }}
              >
                Cancel
              </button>
            </div>
            {addLeagueError && (
              <div className="sb-error-banner" style={{ marginTop: "0.75rem" }}>
                <AlertTriangle size={12} /> {addLeagueError}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="sb-tabs">
        <button className={`sb-tab ${tab === "board" ? "active" : ""}`} onClick={() => setTab("board")}>
          <TrendingUp size={16} /> Board
        </button>
        <button className={`sb-tab ${tab === "matchup" ? "active" : ""}`} onClick={() => setTab("matchup")}>
          <Swords size={16} /> Matchup
        </button>
        <button className={`sb-tab ${tab === "slips" ? "active" : ""}`} onClick={() => setTab("slips")}>
          <ScrollText size={16} /> Bet Slips
        </button>
        <span className="sb-tab-divider" aria-hidden="true" />
        <button className={`sb-tab ${tab === "pool" ? "active" : ""}`} onClick={() => setTab("pool")}>
          <Coins size={16} /> Pool
        </button>
        <button className={`sb-tab ${tab === "survivor" ? "active" : ""}`} onClick={() => setTab("survivor")}>
          <Skull size={16} /> Survivor
        </button>
        <span className="sb-tab-divider" aria-hidden="true" />
        <button className={`sb-tab ${tab === "ledger" ? "active" : ""}`} onClick={() => setTab("ledger")}>
          <Trophy size={16} /> Ledger
        </button>
        <button className={`sb-tab ${tab === "sync" ? "active" : ""}`} onClick={() => setTab("sync")}>
          <Link2 size={16} /> League
        </button>
        {["board", "matchup", "slips"].includes(tab) && (
          <button className="sb-newbet-btn" onClick={() => {
            setShowForm(false);
            setBuilderCategory(null);
            setBuilderOpen((s) => !s);
          }}>
            <Plus size={13} /> Create Side Bet
          </button>
        )}
      </div>

      <div className="sb-content">
        {builderOpen && (
          <div className="sb-form-panel">
            {builderCategory === null && renderBuilderCategoryPicker()}
            {builderCategory === "matchup" && renderMatchupBuilder()}
            {builderCategory === "total" && renderTotalBuilder()}
            {builderCategory === "prop" && renderPropBuilder()}
            {builderCategory === "battle" && renderBattleBuilder()}
          </div>
        )}

        {showForm && (
          <div className="sb-form-panel">
            <h3>Custom Slip</h3>
            <form onSubmit={submitBet}>
              <div className="sb-form-row">
                <div className="sb-field">
                  <label>Bet type</label>
                  <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                    <option value="matchup">Matchup</option>
                    <option value="prop">Player Prop</option>
                    <option value="season">Season Future</option>
                    <option value="proposition">League Prop</option>
                  </select>
                </div>
                <div className="sb-field" style={{ maxWidth: 110 }}>
                  <label>Stake ($)</label>
                  <input type="number" min="1" value={form.stake} onChange={(e) => setForm({ ...form, stake: e.target.value })} />
                </div>
                {isWeeklyBet(form.type) && (
                  <div className="sb-field" style={{ maxWidth: 90 }}>
                    <label>Week</label>
                    <input type="number" min="1" max={currentWeek} value={form.week}
                      onChange={(e) => setForm({ ...form, week: e.target.value })} />
                  </div>
                )}
              </div>

              <div className="sb-field">
                <label>Terms — what settles this bet</label>
                <input type="text" placeholder='e.g. "My RB1 outscores yours this week"'
                  value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </div>

              {form.type === "prop" && (
                <div className="sb-form-row">
                  <div className="sb-field">
                    <label>Sleeper player ID</label>
                    <input type="text" placeholder="e.g. 4046" value={form.playerId}
                      onChange={(e) => setForm({ ...form, playerId: e.target.value })} />
                  </div>
                  <div className="sb-field" style={{ maxWidth: 110 }}>
                    <label>Line</label>
                    <input type="number" step="0.5" placeholder="18.5" value={form.line}
                      onChange={(e) => setForm({ ...form, line: e.target.value })} />
                  </div>
                  <div className="sb-field" style={{ maxWidth: 140 }}>
                    <label>You take</label>
                    <select value={form.creatorSide} onChange={(e) => setForm({ ...form, creatorSide: e.target.value })}>
                      <option value="over">Over</option>
                      <option value="under">Under</option>
                    </select>
                  </div>
                </div>
              )}
              {form.type === "prop" && (
                <p className="sb-note" style={{ color: "#6b6144", marginTop: "-0.4rem" }}>
                  Fill in the player ID and line to make this slip auto-gradable from Sleeper. Leave blank to grade it by hand instead.
                </p>
              )}

              <div className="sb-form-actions">
                <button type="submit" className="sb-btn sb-btn-submit">Post slip</button>
                <button type="button" className="sb-btn sb-btn-cancel" onClick={() => setShowForm(false)}>Cancel</button>
              </div>
            </form>
          </div>
        )}

        {tab === "board" && (
          <div>
            {renderWeekNav(
              <button className="sb-btn sb-btn-auto" onClick={() => loadWeekData(activeWeek, { force: true, showSpinner: true })} disabled={league.loading}>
                <RefreshCw size={12} /> {league.loading ? "Loading…" : "Refresh lines"}
              </button>,
            )}

            <p className="sb-note" style={{ marginBottom: "0.85rem", color: "#7ea08f" }}>
              Tap a line to add it to your bet slip. Projections are from Sleeper ({league.projectionSeason} week {activeWeek}, {league.scoringLabel} scoring).
            </p>

            <div className="sb-board-filters" style={{ marginBottom: "0.85rem" }}>
              <div className="sb-board-filter">
                <label>Fantasy team</label>
                <select value={boardFantasyTeam} onChange={(e) => setBoardFantasyTeam(e.target.value)}>
                  <option value="all">All teams</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="sb-board-section">
              <h3>Weekly Bets</h3>
              {weeklyBoardEvents.length === 0 ? (
                <div className="sb-board">
                  <div className="sb-empty">
                    {league.loading
                      ? "Loading Sleeper projections and matchup lines…"
                      : "No weekly lines yet — refresh league on the League tab, then hit Refresh lines here."}
                  </div>
                </div>
              ) : (
                weeklyBoardEvents.map(renderCollapsibleEventCard)
              )}
            </div>

            <div className="sb-board-section">
              <h3>Season Bets</h3>
              {seasonBoardEvents.length === 0 ? (
                <div className="sb-board">
                  <div className="sb-empty">No season lines yet — connect your league to see these.</div>
                </div>
              ) : (
                seasonBoardEvents.map(renderCollapsibleEventCard)
              )}
            </div>
          </div>
        )}

        {tab === "matchup" && (
          <div>
            <div className="sb-matchup-header">
              <div>
                <h3 className="sb-display" style={{ fontSize: "1.5rem", color: "var(--gold-bright)", margin: 0 }}>
                  Week {matchupWeek} Matchup
                </h3>
                <p className="sb-note" style={{ margin: "0.35rem 0 0", color: "#7ea08f" }}>
                  Tap a starter for their O/U line, or pick one from each side for a head-to-head bet.
                </p>
              </div>
              <button className="sb-btn sb-btn-auto" onClick={() => loadWeekData(matchupWeek, { force: true, showSpinner: true })} disabled={league.loading}>
                <RefreshCw size={12} /> {league.loading ? "Loading…" : "Refresh"}
              </button>
            </div>

            {league.loading && !matchupDataReady ? (
              <div className="sb-board">
                <div className="sb-empty">Loading your matchup and Sleeper {league.scoringLabel} projections…</div>
              </div>
            ) : !matchupOpponent ? (
              <div className="sb-board">
                <div className="sb-empty">
                  No fantasy matchup found for week {matchupWeek}. Refresh league data or check back when the schedule is set.
                </div>
              </div>
            ) : (
              <>
                <div className="sb-matchup-scoreboard">
                  {renderStarterColumn(viewerMember, myStarterRows, myLineupProj, true)}
                  <div className="sb-matchup-vs">VS</div>
                  {renderStarterColumn(matchupOpponent, oppStarterRows, oppLineupProj, false)}
                </div>

                {matchupBetOffering && (
                  <div className="dk-event" style={{ marginBottom: "1rem" }}>
                    <div className="dk-event-header">
                      <div className="dk-event-title">
                        {matchupPlayerPick.my && matchupPlayerPick.opp
                          ? "Player Battle"
                          : "Player Prop"}
                      </div>
                      <div className="dk-event-sub">
                        {matchupPlayerPick.my && matchupPlayerPick.opp
                          ? "Your pick vs opponent — tap a side to bet"
                          : "Tap Over or Under to add to your bet slip"}
                      </div>
                    </div>
                    <div className="dk-event-markets">
                      {renderMarketRow(matchupBetOffering)}
                    </div>
                  </div>
                )}

                <div className="dk-event" style={{ marginTop: "0.5rem" }}>
                  <div className="dk-event-header">
                    <div className="dk-event-title">Bet This Matchup</div>
                    <div className="dk-event-sub">vs {matchupOpponent.name} · Week {matchupWeek}</div>
                  </div>
                  <div className="dk-event-markets">
                    {matchupOfferings.length === 0 ? (
                      <div className="sb-empty" style={{ padding: "1rem" }}>No bet lines available yet.</div>
                    ) : (
                      matchupOfferings.map(renderMarketRow)
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {tab === "pool" && renderPoolTab()}

        {tab === "survivor" && renderSurvivorTab()}

        {tab === "slips" && (
          <div>
            {renderWeekNav(
              <div className="sb-slips-summary">
                {weekSlipSummary.total === 0
                  ? "No slips this week"
                  : `${weekSlipSummary.total} slip${weekSlipSummary.total !== 1 ? "s" : ""} · ${weekSlipSummary.open} open · $${weekSlipSummary.stake} on the board`}
              </div>,
            )}

            {weekBets.length === 0 ? (
              <div className="sb-board">
                <div className="sb-empty">No bet slips for week {activeWeek} yet. Post one with the Create Side Bet button.</div>
              </div>
            ) : (
              weekBets.map(renderBetSlip)
            )}

            {seasonBets.length > 0 && (
              <div className="sb-season-section">
                <h3>Season Board</h3>
                <p className="sb-note">Long-running futures that aren&rsquo;t tied to a single week.</p>
                {seasonBets.map(renderBetSlip)}
              </div>
            )}
          </div>
        )}

        {tab === "ledger" && (
          <div>
            <div className="sb-ledger-toggle">
              <button className={ledgerView === "weekly" ? "active" : ""} onClick={() => setLedgerView("weekly")}>
                <CalendarDays size={12} style={{ display: "inline", verticalAlign: "-2px", marginRight: "0.3rem" }} />
                Weekly Statement
              </button>
              <button className={ledgerView === "season" ? "active" : ""} onClick={() => setLedgerView("season")}>
                <Trophy size={12} style={{ display: "inline", verticalAlign: "-2px", marginRight: "0.3rem" }} />
                Season Totals
              </button>
            </div>

            {ledgerView === "weekly" && (
              <>
                {renderWeekNav()}

                <div className="sb-statement-personal">
                  <h4>{nameOf(viewer)}&rsquo;s Week {activeWeek} Statement</h4>
                  {viewerStatement.net === 0 && viewerStatement.owes.length === 0 && viewerStatement.owed.length === 0 ? (
                    <div className="sb-statement-line">No settled action this week — you&rsquo;re even.</div>
                  ) : (
                    <>
                      <div className="sb-statement-line" style={{ marginBottom: "0.35rem" }}>
                        Net this week:{" "}
                        <span style={{ color: viewerStatement.net >= 0 ? "#9ad6b3" : "#e0949a", fontWeight: 600 }}>
                          {viewerStatement.net >= 0 ? "+" : "-"}${Math.abs(viewerStatement.net)}
                        </span>
                      </div>
                      {viewerStatement.owed.map((p, i) => (
                        <div className="sb-statement-line" key={`owed-${i}`}>
                          <span style={{ color: "#9ad6b3" }}>{nameOf(p.from)}</span> owes you{" "}
                          <span style={{ color: "var(--gold-bright)" }}>${p.amount}</span>
                        </div>
                      ))}
                      {viewerStatement.owes.map((p, i) => (
                        <div className="sb-statement-line" key={`owes-${i}`}>
                          You owe <span style={{ color: "#e0949a" }}>{nameOf(p.to)}</span>{" "}
                          <span style={{ color: "var(--gold-bright)" }}>${p.amount}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>

                <div className="sb-board">
                  <h3>Week {activeWeek} Settlements</h3>
                  <p className="sb-note">Who pays whom for slips graded this week — settle up before the next slate.</p>
                  {weeklyLedger.pairs.length === 0 ? (
                    <div className="sb-empty">No graded slips for week {activeWeek} yet.</div>
                  ) : (
                    weeklyLedger.pairs.map((p, i) => (
                      <div className="sb-owe-row" key={i}>
                        <span style={{ color: "#e0949a" }}>{nameOf(p.from)}</span>
                        <span style={{ opacity: 0.6 }}>owes</span>
                        <span style={{ color: "#9ad6b3" }}>{nameOf(p.to)}</span>
                        <span style={{ marginLeft: "auto", color: "var(--gold-bright)" }}>${p.amount}</span>
                      </div>
                    ))
                  )}
                </div>

                <div className="sb-board">
                  <h3>Week {activeWeek} Standings</h3>
                  {members.slice().sort((a, b) => weeklyLedger.totals[b.id] - weeklyLedger.totals[a.id]).map((m) => (
                    <div className="sb-standing-row" key={m.id}>
                      <span className="sb-standing-name">{m.name}</span>
                      <span style={{ color: weeklyLedger.totals[m.id] >= 0 ? "#9ad6b3" : "#e0949a" }}>
                        {weeklyLedger.totals[m.id] === 0 ? "even" : `${weeklyLedger.totals[m.id] >= 0 ? "+" : "-"}$${Math.abs(weeklyLedger.totals[m.id])}`}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="sb-board">
                  <h3>Graded Slips — Week {activeWeek}</h3>
                  {weeklyLedger.settled.length === 0 ? (
                    <div className="sb-empty">Nothing graded yet for this week.</div>
                  ) : (
                    weeklyLedger.settled.map((b) => {
                      const winner = b.result === "creator" ? b.creator : b.opponent;
                      const loser = b.result === "creator" ? b.opponent : b.creator;
                      return (
                        <div className="sb-activity-row" key={b.id}>
                          <div>
                            <div className="sb-activity-title">{b.title}</div>
                            <div className="sb-activity-meta">
                              {nameOf(b.creator)} vs {nameOf(b.opponent)} &middot; ticket #{b.ticket}
                            </div>
                          </div>
                          <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                            <div style={{ color: "#9ad6b3" }}>{nameOf(winner)} +${b.stake}</div>
                            <div style={{ color: "#e0949a", fontSize: "0.68rem" }}>{nameOf(loser)} pays</div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            )}

            {ledgerView === "season" && (
              <>
                <div className="sb-board">
                  <h3>Season Standings (net $)</h3>
                  <p className="sb-note">Running total across all graded slips, including season futures when they settle.</p>
                  {(() => {
                    const sorted = members.slice().sort((a, b) => ledger.totals[b.id] - ledger.totals[a.id]);
                    const podium = sorted.slice(0, 3);
                    const rest = sorted.slice(3);
                    return (
                      <>
                        {podium.length > 0 && (
                          <div className="sb-podium">
                            {[1, 0, 2].filter((i) => podium[i]).map((i) => {
                              const m = podium[i];
                              return (
                                <div className={`sb-podium-spot sb-podium-${i + 1}`} key={m.id}>
                                  <div className="sb-podium-rank">{i + 1}</div>
                                  {renderAvatar(m.id)}
                                  <div className="sb-podium-name">{m.name}</div>
                                  <div className="sb-podium-amount" style={{ color: ledger.totals[m.id] >= 0 ? "#9ad6b3" : "#e0949a" }}>
                                    {ledger.totals[m.id] >= 0 ? "+" : "-"}${Math.abs(ledger.totals[m.id])}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {rest.map((m) => (
                          <div className="sb-standing-row" key={m.id}>
                            <span className="sb-standing-name" style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                              {renderAvatar(m.id)}{m.name}
                            </span>
                            <span style={{ color: ledger.totals[m.id] >= 0 ? "#9ad6b3" : "#e0949a" }}>
                              {ledger.totals[m.id] >= 0 ? "+" : "-"}${Math.abs(ledger.totals[m.id])}
                            </span>
                          </div>
                        ))}
                      </>
                    );
                  })()}
                </div>
                <div className="sb-board">
                  <h3>Season Settlements</h3>
                  {ledger.pairs.length === 0 ? (
                    <div className="sb-empty">Nothing outstanding — grade some slips to see balances settle here.</div>
                  ) : (
                    ledger.pairs.map((p, i) => (
                      <div className="sb-owe-row" key={i}>
                        <span style={{ color: "#e0949a" }}>{nameOf(p.from)}</span>
                        <span style={{ opacity: 0.6 }}>owes</span>
                        <span style={{ color: "#9ad6b3" }}>{nameOf(p.to)}</span>
                        <span style={{ marginLeft: "auto", color: "var(--gold-bright)" }}>${p.amount}</span>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {tab === "sync" && (
          <div>
            <div className="sb-board">
              <h3>
                {league.leagueName}
                {league.ownerId && session.user.id === league.ownerId && (
                  <span className="sb-league-badge" style={{ marginLeft: "0.6rem", verticalAlign: "middle" }}>
                    You're the league owner
                  </span>
                )}
              </h3>
              {demo ? (
                <p className="sb-note">This is a demo league — nothing here is saved, and no real Sleeper or account data is used.</p>
              ) : (
                <p className="sb-note">
                  Linked to Sleeper league <span className="sb-mono">{league.leagueId}</span>.
                  Scores and projections for weeks 1–{currentWeek} load automatically
                  {loadedWeekCount < currentWeek ? ` (${loadedWeekCount} of ${currentWeek} ready…)` : "."}
                </p>
              )}
              <div className="sb-form-actions">
                {!demo && (
                  <button
                    className="sb-btn sb-btn-submit"
                    onClick={async () => {
                      await refreshLeague();
                      await prefetchSeasonWeeks(currentWeek, { force: true });
                    }}
                    disabled={league.loading}
                  >
                    <RefreshCw size={12} /> {league.loading ? "Syncing…" : "Refresh league"}
                  </button>
                )}
                <button className="sb-btn sb-btn-decline" onClick={disconnectLeague}>
                  {demo ? "Exit Demo" : "Sign out"}
                </button>
              </div>
              {league.error && <div className="sb-error-banner"><AlertTriangle size={12} /> {league.error}</div>}
            </div>

            <div className="sb-board">
              <h3>Weekly League Pool</h3>
              <p className="sb-note">Default entry fee everyone antes up each week. Editing this only changes future weeks.</p>
              <div className="sb-pool-question" style={{ borderBottom: "none", padding: 0 }}>
                <label>Entry fee ($)</label>
                <select
                  value={String(league.poolEntryFee || 5)}
                  onChange={async (e) => {
                    const fee = Number(e.target.value);
                    setLeague((s) => ({ ...s, poolEntryFee: fee }));
                    try {
                      await leaguesApi.upsertLeague(league.leagueId, { pool_entry_fee: fee });
                    } catch {
                      // best-effort — worst case the fee display reverts on next refresh
                    }
                  }}
                >
                  {[5, 10, 15, 20, 25].map((v) => <option key={v} value={v}>${v}</option>)}
                </select>
              </div>
            </div>

            <div className="sb-board">
              <h3>Survivor Pool</h3>
              <p className="sb-note">Default entry fee everyone antes up for the season. Editing this only changes new entries.</p>
              <div className="sb-pool-question" style={{ borderBottom: "none", padding: 0 }}>
                <label>Entry fee ($)</label>
                <select
                  value={String(league.survivorEntryFee || 5)}
                  onChange={async (e) => {
                    const fee = Number(e.target.value);
                    setLeague((s) => ({ ...s, survivorEntryFee: fee }));
                    try {
                      await leaguesApi.upsertLeague(league.leagueId, { survivor_entry_fee: fee });
                    } catch {
                      // best-effort — worst case the fee display reverts on next refresh
                    }
                  }}
                >
                  {[5, 10, 15, 20, 25].map((v) => <option key={v} value={v}>${v}</option>)}
                </select>
              </div>
            </div>

            <div className="sb-board">
              <h3>League Managers</h3>
              <p className="sb-note">Rosters pulled from Sleeper — used for auto-grading matchup bets.</p>
              {members.map((m) => (
                <div className="sb-sync-row" key={m.id}>
                  <span className="sb-standing-name" style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                    {renderAvatar(m.id)}{m.name}
                  </span>
                  {m.teamName && (
                    <span className="sb-mono" style={{ fontSize: "0.68rem", color: "#7ea08f" }}>{m.displayName}</span>
                  )}
                  {weekCache[currentWeek]?.matchups?.[m.rosterId] && (
                    <span className="sb-week-points">
                      {weekCache[currentWeek].matchups[m.rosterId].points} pts (wk {currentWeek})
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
        </>
      )}
      {renderBetSlipBar()}
    </div>
  );
}
