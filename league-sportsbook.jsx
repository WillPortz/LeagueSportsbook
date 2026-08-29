import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  Check, X, Lock, Trophy, Plus, ChevronLeft, ChevronRight, Users, ScrollText,
  Zap, RefreshCw, Link2, AlertTriangle, CalendarDays, TrendingUp, Swords,
} from "lucide-react";

const STORAGE_KEY = "league-book-v1";
const BUILD_STAMP = "DEV";
const REGULAR_SEASON_WEEKS = 18;

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

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveStored(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore quota errors
  }
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

function winProbFromSpread(spread) {
  return 1 / (1 + Math.exp(-spread / 7));
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
  const missing = ids.filter((id) => weekCache[id] == null);

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
    ids.forEach((id) => {
      const pts = byPlayer[String(id)];
      if (pts != null) weekCache[id] = pts;
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

function generateBoardOfferings(members, week, weekData, players, projections, scoringLabel = "Sleeper") {
  if (!members.length || !Object.keys(players).length) return [];

  const offerings = [];
  const pairs = Object.keys(weekData).length > 0
    ? getWeekPairs(weekData, members)
    : [];

  members.forEach((m) => {
    getFeaturedStarters(m, players).forEach((pid) => {
      const p = players[pid];
      if (!p) return;
      const rawProj = sleeperProj(pid, projections);
      const line = betLineFromProj(rawProj);
      if (line == null) return;
      offerings.push({
        id: `pou-${week}-${pid}`,
        kind: "player_ou",
        category: "props",
        type: "prop",
        week,
        title: `${p.name} O/U ${formatProj(line)} fantasy pts`,
        subtitle: `${m.name} · ${p.position}${p.team ? ` · ${p.team}` : ""} · Sleeper ${scoringLabel} proj ${formatProj(rawProj)}`,
        playerId: pid,
        ownerId: m.id,
        fantasyTeamId: m.id,
        position: p.position,
        nflTeam: p.team || null,
        line,
        sides: [
          { key: "over", label: `Over ${formatProj(line)}`, odds: -110, pick: "over" },
          { key: "under", label: `Under ${formatProj(line)}`, odds: -110, pick: "under" },
        ],
      });
    });
  });

  members.forEach((m) => {
    const line = sumLineupProjections(m, projections);
    if (line == null) return;
    offerings.push({
      id: `lineup-${week}-${m.id}`,
      kind: "lineup_ou",
      category: "lineups",
      type: "prop",
      week,
      title: `${m.name} lineup O/U ${formatProj(line)} fantasy pts`,
      subtitle: `Week ${week} · Sleeper ${scoringLabel} starter projections`,
      subjectId: m.id,
      fantasyTeamId: m.id,
      line,
      sides: [
        { key: "over", label: `Over ${formatProj(line)}`, odds: -115, pick: "over" },
        { key: "under", label: `Under ${formatProj(line)}`, odds: -105, pick: "under" },
      ],
    });
  });

  pairs.forEach(([a, b]) => {
    const projA = sumLineupProjections(a, projections);
    const projB = sumLineupProjections(b, projections);
    if (projA == null || projB == null) return;
    const spread = projA - projB;
    const probA = winProbFromSpread(spread);

    offerings.push({
      id: `lineup-ml-${week}-${a.id}-${b.id}`,
      kind: "lineup_ml",
      category: "matchups",
      type: "matchup",
      week,
      title: `${a.name} vs ${b.name} — lineup pts`,
      subtitle: `Week ${week} · Sleeper ${scoringLabel} proj ${formatProj(projA)} vs ${formatProj(projB)}`,
      memberA: a.id,
      memberB: b.id,
      fantasyTeamIds: [a.id, b.id],
      sides: [
        { key: "a", memberId: a.id, label: a.name, odds: americanOdds(probA) },
        { key: "b", memberId: b.id, label: b.name, odds: americanOdds(1 - probA) },
      ],
    });

    const matchups = [
      { pos: "QB", label: "QB" },
      { pos: "RB", label: "RB" },
      { pos: "WR", label: "WR" },
    ];
    matchups.forEach(({ pos, label }) => {
      const pidA = findStarterByPos(a, players, pos);
      const pidB = findStarterByPos(b, players, pos);
      if (!pidA || !pidB) return;
      const lineA = sleeperProj(pidA, projections);
      const lineB = sleeperProj(pidB, projections);
      if (lineA == null || lineB == null) return;
      const prob = winProbFromSpread(lineA - lineB);
      offerings.push({
        id: `ph2h-${week}-${pidA}-${pidB}`,
        kind: "player_h2h",
        category: "matchups",
        type: "prop",
        week,
        title: `${playerLabel(players, pidA)} vs ${playerLabel(players, pidB)}`,
        subtitle: `Week ${week} · ${label} H2H · Sleeper ${formatProj(lineA)} vs ${formatProj(lineB)}`,
        playerIdA: pidA,
        playerIdB: pidB,
        memberA: a.id,
        memberB: b.id,
        fantasyTeamIds: [a.id, b.id],
        position: pos,
        sides: [
          { key: "a", playerId: pidA, memberId: a.id, label: playerLabel(players, pidA), odds: americanOdds(prob) },
          { key: "b", playerId: pidB, memberId: b.id, label: playerLabel(players, pidB), odds: americanOdds(1 - prob) },
        ],
      });
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
  return (member?.starters || []).map((pid) => {
    const p = players[pid] || { name: `Player ${pid}`, position: "?", team: null };
    const row = weekData[member.rosterId];
    const actual = row?.players_points?.[pid];
    return {
      pid,
      name: p.name,
      position: p.position,
      team: p.team,
      proj: sleeperProj(pid, projections),
      actual: actual != null ? actual : null,
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

function starterPickOptions(member, players, projections, positionFilter = "all") {
  return (member?.starters || [])
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

function groupBoardEvents(offerings, members) {
  const events = [];
  const teamMap = {};
  offerings.filter((o) => o.kind === "player_ou").forEach((o) => {
    const tid = o.fantasyTeamId || o.ownerId || "other";
    if (!teamMap[tid]) teamMap[tid] = [];
    teamMap[tid].push(o);
  });
  Object.entries(teamMap).forEach(([tid, markets]) => {
    const team = members.find((m) => m.id === tid);
    events.push({
      id: `team-${tid}`,
      title: team?.name || "Team",
      subtitle: "Player fantasy points · Sleeper",
      markets,
    });
  });
  const lineups = offerings.filter((o) => o.kind === "lineup_ou");
  if (lineups.length) {
    events.push({
      id: "lineups",
      title: "Lineup Totals",
      subtitle: "Combined starter projections",
      markets: lineups,
    });
  }
  const matchups = offerings.filter((o) => o.kind === "lineup_ml" || o.kind === "player_h2h");
  if (matchups.length) {
    events.push({
      id: "matchups",
      title: "Head-to-Head Markets",
      subtitle: "Lineup & position battles",
      markets: matchups,
    });
  }
  return events;
}

function filterBoardOfferings(offerings, { category, fantasyTeam, position, nflTeam }) {
  if (category === "battles") return [];
  return offerings.filter((o) => {
    if (category !== "all" && o.category !== category) return false;
    if (fantasyTeam !== "all") {
      const ids = o.fantasyTeamIds || (o.fantasyTeamId ? [o.fantasyTeamId] : []);
      if (!ids.includes(fantasyTeam)) return false;
    }
    if (position !== "all") {
      if (!o.position || o.position !== position) return false;
    }
    if (nflTeam !== "all") {
      if (!o.nflTeam || o.nflTeam !== nflTeam) return false;
    }
    return true;
  });
}

const TYPE_LABEL = {
  matchup: "Matchup",
  prop: "Player Prop",
  season: "Season Future",
  proposition: "League Prop",
};

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

let TICKET_SEQ = 1001;

const STATUS_STYLE = {
  pending: { label: "PENDING", color: "#8a6d1f", rotate: -8 },
  accepted: { label: "ON THE BOARD", color: "#3a6b52", rotate: -6 },
  locked: { label: "LOCKED", color: "#7a3b3b", rotate: -10 },
  settled: { label: "GRADED", color: "#4b4b4b", rotate: -6 },
};

export default function LeagueSportsbook() {
  const stored = useMemo(() => (typeof window !== "undefined" ? loadStored() : null), []);

  const [league, setLeague] = useState({
    linked: !!(stored?.leagueId && stored?.viewerId),
    leagueId: stored?.leagueId || "",
    leagueName: stored?.leagueName || "",
    loading: false,
    error: null,
    week: stored?.week || 1,
    season: stored?.season || new Date().getFullYear(),
    nflSeasonType: stored?.nflSeasonType || "regular",
    scoringField: stored?.scoringField || "pts_ppr",
    scoringLabel: stored?.scoringLabel || "PPR",
    projectionSeason: stored?.projectionSeason || stored?.season || new Date().getFullYear(),
    inputId: stored?.leagueId || "",
  });
  const [members, setMembers] = useState(stored?.members || []);
  const [bets, setBets] = useState(stored?.bets || []);
  const [ticketSeq, setTicketSeq] = useState(stored?.ticketSeq || TICKET_SEQ);
  const [tab, setTab] = useState("slips");
  const [viewer, setViewer] = useState(stored?.viewerId || "");
  const [setupViewer, setSetupViewer] = useState(stored?.viewerId || "");
  const [showForm, setShowForm] = useState(false);
  const [betErrors, setBetErrors] = useState({});

  const defaultOpponent = members.find((m) => m.id !== viewer)?.id || "";

  const [form, setForm] = useState({
    type: "matchup", title: "", opponent: defaultOpponent, stake: 10, week: stored?.week || 1,
    playerId: "", line: "", creatorSide: "over",
  });
  const [ledgerView, setLedgerView] = useState("weekly");
  const [selectedWeek, setSelectedWeek] = useState(
    stored?.selectedWeek || stored?.week || 1,
  );

  const [weekCache, setWeekCache] = useState({});
  const weekCacheRef = useRef({});
  const loadingWeeksRef = useRef(new Set());
  const [players, setPlayers] = useState({});
  const [boardCategory, setBoardCategory] = useState("all");
  const [boardFantasyTeam, setBoardFantasyTeam] = useState("all");
  const [boardPosition, setBoardPosition] = useState("all");
  const [boardNflTeam, setBoardNflTeam] = useState("all");
  const [globalStake, setGlobalStake] = useState(10);
  const [betSlipPick, setBetSlipPick] = useState(null);
  const [customH2H, setCustomH2H] = useState({ myPlayerId: "", oppMemberId: "", oppPlayerId: "" });
  const [customMatchPos, setCustomMatchPos] = useState(true);
  const [matchupPlayerPick, setMatchupPlayerPick] = useState({ my: "", opp: "" });

  const nameOf = useCallback(
    (id) => members.find((m) => m.id === id)?.name || id,
    [members],
  );

  const rosterIdFor = useCallback(
    (memberId) => members.find((m) => m.id === memberId)?.rosterId,
    [members],
  );

  const leagueReady = league.linked && members.length > 0 && viewer;

  useEffect(() => {
    if (!league.linked) return;
    saveStored({
      leagueId: league.leagueId,
      leagueName: league.leagueName,
      members,
      viewerId: viewer,
      bets,
      ticketSeq,
      selectedWeek,
      week: league.week,
      season: league.season,
      nflSeasonType: league.nflSeasonType,
      scoringField: league.scoringField,
      scoringLabel: league.scoringLabel,
      projectionSeason: league.projectionSeason,
    });
  }, [league.linked, league.leagueId, league.leagueName, league.week, league.season, league.nflSeasonType, league.scoringField, league.scoringLabel, league.projectionSeason, members, viewer, bets, ticketSeq, selectedWeek]);

  useEffect(() => {
    if (defaultOpponent && !members.some((m) => m.id === form.opponent && m.id !== viewer)) {
      setForm((f) => ({ ...f, opponent: defaultOpponent }));
    }
  }, [defaultOpponent, viewer, members, form.opponent]);

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

  const connectLeague = useCallback(async (leagueId) => {
    if (!leagueId.trim()) return;
    setLeague((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetchLeagueData(leagueId);
      setMembers(data.members);
      setLeague((s) => ({
        ...s,
        linked: false,
        leagueId: leagueId.trim(),
        leagueName: data.leagueName,
        week: data.week,
        season: data.season,
        projectionSeason: data.projectionSeason,
        nflSeasonType: data.nflSeasonType,
        scoringField: data.scoringField,
        scoringLabel: data.scoringLabel,
        loading: false,
        error: null,
        inputId: leagueId.trim(),
      }));
      setSelectedWeek(data.week);
      setForm((f) => ({ ...f, week: data.week }));
      setSetupViewer((prev) => prev || data.members[0]?.id || "");
    } catch {
      setLeague((s) => ({
        ...s,
        loading: false,
        error: "Couldn't load that league. Double-check the Sleeper league ID.",
      }));
    }
  }, [fetchLeagueData]);

  const finishSetup = useCallback(() => {
    if (!setupViewer) return;
    setViewer(setupViewer);
    setLeague((s) => ({ ...s, linked: true }));
    setTab("slips");
  }, [setupViewer]);

  const refreshLeague = useCallback(async () => {
    if (!league.leagueId) return;
    setLeague((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetchLeagueData(league.leagueId);
      setMembers(data.members);
      setLeague((s) => ({
        ...s,
        leagueName: data.leagueName,
        week: data.week,
        season: data.season,
        projectionSeason: data.projectionSeason,
        nflSeasonType: data.nflSeasonType,
        scoringField: data.scoringField,
        scoringLabel: data.scoringLabel,
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
  }, [fetchLeagueData, league.leagueId]);

  const disconnectLeague = useCallback(() => {
    if (!window.confirm("Disconnect this league? All local bets and balances will be cleared.")) return;
    localStorage.removeItem(STORAGE_KEY);
    setLeague({
      linked: false,
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
      inputId: "",
    });
    setMembers([]);
    setBets([]);
    setViewer("");
    setSetupViewer("");
    setTicketSeq(TICKET_SEQ);
    setWeekCache({});
    weekCacheRef.current = {};
    loadingWeeksRef.current.clear();
    setPlayers({});
    setBoardCategory("all");
    setBoardFantasyTeam("all");
    setBoardPosition("all");
    setBoardNflTeam("all");
    setGlobalStake(10);
    setBetSlipPick(null);
    setCustomH2H({ myPlayerId: "", oppMemberId: "", oppPlayerId: "" });
    setTab("slips");
  }, []);

  useEffect(() => {
    if (league.linked && league.leagueId) refreshLeague();
    // only refresh roster names on first load of a linked league
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadWeekData = useCallback(async (weekNum, { force = false, showSpinner = false } = {}) => {
    if (!league.leagueId) return false;
    const wk = Math.min(REGULAR_SEASON_WEEKS, Math.max(1, Number(weekNum) || 1));

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

      const matchupStarterIds = [...new Set(
        current.flatMap((row) => (row.starters || []).filter((id) => id && id !== "0")),
      )];
      const starterIds = matchupStarterIds.length
        ? matchupStarterIds
        : members.flatMap((m) => m.starters || []);
      const playerInfo = await fetchPlayerInfo(starterIds);
      const projections = await fetchSleeperProjections(
        wk,
        projectionSeason,
        starterIds,
        "regular",
        scoring.field,
        leagueData?.scoring_settings || null,
      );

      const entry = { matchups: map, projections };
      weekCacheRef.current = { ...weekCacheRef.current, [wk]: entry };
      setWeekCache((prev) => ({ ...prev, [wk]: entry }));
      setPlayers(playerInfo);
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

  useEffect(() => {
    weekCacheRef.current = {};
    setWeekCache({});
  }, [league.scoringField, league.season, league.projectionSeason]);

  useEffect(() => {
    if (!leagueReady || !league.leagueId) return;
    prefetchSeasonWeeks(currentWeek);
  }, [leagueReady, league.leagueId, currentWeek, prefetchSeasonWeeks]);

  useEffect(() => {
    if (!leagueReady || !league.leagueId) return;
    const viewWeek = tab === "matchup" ? matchupWeek : activeWeek;
    loadWeekData(viewWeek, { showSpinner: true });
  }, [leagueReady, league.leagueId, activeWeek, matchupWeek, tab, loadWeekData]);

  const weekBets = useMemo(
    () => bets.filter((b) => Number(b.week) === activeWeek),
    [bets, activeWeek],
  );
  const seasonBets = useMemo(
    () => bets.filter((b) => b.week == null || b.week === ""),
    [bets],
  );

  const weeklyLedger = useMemo(() => computeLedger(bets, members, activeWeek), [bets, members, activeWeek]);

  const boardOfferings = useMemo(
    () => generateBoardOfferings(
      members,
      activeWeek,
      activeWeekData,
      players,
      activeProjections,
      league.scoringLabel,
    ),
    [members, activeWeek, activeWeekData, players, activeProjections, league.scoringLabel],
  );

  const boardNflTeams = useMemo(() => {
    const teams = new Set();
    Object.values(players).forEach((p) => { if (p.team) teams.add(p.team); });
    return [...teams].sort();
  }, [players]);

  const filteredBoardOfferings = useMemo(
    () => filterBoardOfferings(boardOfferings, {
      category: boardCategory,
      fantasyTeam: boardFantasyTeam,
      position: boardPosition,
      nflTeam: boardNflTeam,
    }),
    [boardOfferings, boardCategory, boardFantasyTeam, boardPosition, boardNflTeam],
  );

  const boardEvents = useMemo(
    () => groupBoardEvents(filteredBoardOfferings, members),
    [filteredBoardOfferings, members],
  );

  const viewerMember = useMemo(
    () => members.find((m) => m.id === viewer) || null,
    [members, viewer],
  );

  const matchupDataReady = !!weekCache[matchupWeek];

  const matchupOpponent = useMemo(() => {
    if (!matchupDataReady || !viewer) return null;
    return getMatchupOpponent(viewer, members, matchupWeekData);
  }, [matchupDataReady, viewer, members, matchupWeekData]);

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

  const myStarterPicks = useMemo(
    () => starterPickOptions(viewerMember, players, activeProjections),
    [viewerMember, players, activeProjections],
  );

  const customOppMember = useMemo(
    () => members.find((m) => m.id === customH2H.oppMemberId) || null,
    [members, customH2H.oppMemberId],
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
    if (!singleId) return null;
    return matchupOfferings.find((o) => o.kind === "player_ou" && o.playerId === singleId) || null;
  }, [
    matchupPlayerPick,
    matchupOpponent,
    viewer,
    matchupWeek,
    players,
    matchupProjections,
    members,
    matchupOfferings,
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
    const disabled = side.memberId === viewer
      && (offering.kind === "lineup_ml" || offering.kind === "player_h2h");
    if (disabled) return;
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
          const disabled = side.memberId === viewer
            && (o.kind === "lineup_ml" || o.kind === "player_h2h");
          const selected = betSlipPick?.offering?.id === o.id && betSlipPick?.side?.key === side.key;
          return (
            <button
              type="button"
              key={side.key}
              className={`dk-odds-btn${selected ? " selected" : ""}`}
              disabled={disabled}
              onClick={() => selectBetPick(o, side)}
            >
              <span className="dk-odds-label">{side.label}</span>
              {side.sublabel && <span className="dk-odds-sublabel">{side.sublabel}</span>}
              {side.pick && <span className="dk-odds-sublabel">{side.pick === "over" ? "Over" : "Under"}</span>}
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
            className={`sb-matchup-player${selectedId === row.pid ? " selected" : ""}`}
            key={row.pid}
            onClick={() => handleMatchupPlayerClick(row.pid, isYou)}
            title={isYou ? "Tap to bet this player" : "Tap to bet against this player"}
          >
            <span className="sb-matchup-pos">{row.position}</span>
            <div>
              <div className="sb-matchup-name">{row.name}</div>
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

    let opponent = "";
    let title = offering.title;
    const bet = {
      id: "b" + Date.now(),
      ticket: ticketSeq,
      type: offering.type,
      title,
      creator: viewer,
      opponent: "",
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
      opponent = side.memberId === offering.memberA ? offering.memberB : offering.memberA;
      if (opponent === viewer) {
        window.alert("Pick the other side — you can't bet against yourself.");
        return;
      }
      bet.opponent = opponent;
      bet.pickMemberId = side.memberId;
      bet.matchupPeerId = side.memberId === offering.memberA ? offering.memberB : offering.memberA;
      title = `${nameOf(side.memberId)} lineup beats ${nameOf(opponent)} @ ${formatOdds(side.odds)} (Week ${offering.week})`;
      bet.title = title;
    } else if (offering.kind === "player_ou") {
      opponent = offering.counterpartyId
        || members.find((m) => m.id !== viewer && m.id !== offering.ownerId)?.id
        || members.find((m) => m.id !== viewer)?.id;
      if (!opponent) return;
      bet.opponent = opponent;
      bet.playerId = offering.playerId;
      bet.line = offering.line;
      bet.creatorSide = side.pick;
      bet.ownerId = offering.ownerId;
      title = `${playerLabel(players, offering.playerId)} ${side.pick === "over" ? "Over" : "Under"} ${offering.line} pts @ ${formatOdds(side.odds)}`;
      bet.title = title;
    } else if (offering.kind === "lineup_ou") {
      opponent = members.find((m) => m.id !== viewer && m.id !== offering.subjectId)?.id
        || members.find((m) => m.id !== viewer)?.id;
      if (!opponent) return;
      bet.opponent = opponent;
      bet.line = offering.line;
      bet.creatorSide = side.pick;
      bet.subjectId = offering.subjectId;
      title = `${nameOf(offering.subjectId)} lineup ${side.pick === "over" ? "Over" : "Under"} ${offering.line} pts @ ${formatOdds(side.odds)}`;
      bet.title = title;
    } else if (offering.kind === "player_h2h") {
      opponent = side.memberId === offering.memberA ? offering.memberB : offering.memberA;
      if (opponent === viewer) {
        window.alert("Pick the other side — you can't bet against yourself.");
        return;
      }
      bet.opponent = opponent;
      bet.playerIdA = offering.playerIdA;
      bet.playerIdB = offering.playerIdB;
      bet.pickPlayerId = side.playerId;
      title = `${playerLabel(players, side.playerId)} beats ${playerLabel(players, side.playerId === offering.playerIdA ? offering.playerIdB : offering.playerIdA)} @ ${formatOdds(side.odds)}`;
      bet.title = title;
    }

    if (!bet.opponent) return;

    setBets((prev) => [bet, ...prev]);
    setTicketSeq((n) => n + 1);
    setBetSlipPick(null);
    setTab("slips");
    setSelectedWeek(offering.week ?? activeWeek);
  }

  const viewerStatement = useMemo(() => {
    const owes = weeklyLedger.pairs.filter((p) => p.from === viewer);
    const owed = weeklyLedger.pairs.filter((p) => p.to === viewer);
    return { owes, owed, net: weeklyLedger.totals[viewer] || 0 };
  }, [weeklyLedger, viewer]);

  function advance(betId, action) {
    setBetErrors((e) => ({ ...e, [betId]: null }));
    setBets((prev) => prev.map((b) => {
      if (b.id !== betId) return b;
      if (action === "accept") return { ...b, status: "accepted" };
      if (action === "decline") return { ...b, status: "declined" };
      if (action === "lock") return { ...b, status: "locked" };
      if (action === "grade-creator") return { ...b, status: "settled", result: "creator" };
      if (action === "grade-opponent") return { ...b, status: "settled", result: "opponent" };
      return b;
    }));
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

    if (bet.type === "matchup") {
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
        setBets((prev) => prev.map((b) => b.id === bet.id
          ? { ...b, status: "settled", result: pickWins ? "creator" : "opponent", actual: ptsPick }
          : b));
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
      setBets((prev) => prev.map((b) => b.id === bet.id ? { ...b, status: "settled", result } : b));
      return;
    }

    if (bet.type === "prop") {
      if (bet.boardKind === "player_h2h" && bet.playerIdA && bet.playerIdB) {
        const ptsA = getPlayerPts(weekData, members, bet.playerIdA);
        const ptsB = getPlayerPts(weekData, members, bet.playerIdB);
        if (ptsA == null || ptsB == null) {
          setBetErrors((e) => ({ ...e, [bet.id]: `Week ${wk} scores aren't available yet.` }));
          return;
        }
        if (ptsA === ptsB) {
          setBetErrors((e) => ({ ...e, [bet.id]: `Tied at ${ptsA} pts — grade manually (push?).` }));
          return;
        }
        const pickWins = bet.pickPlayerId === bet.playerIdA ? ptsA > ptsB : ptsB > ptsA;
        setBets((prev) => prev.map((b) => b.id === bet.id
          ? { ...b, status: "settled", result: pickWins ? "creator" : "opponent", actual: ptsA }
          : b));
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
        setBets((prev) => prev.map((b) => b.id === bet.id
          ? { ...b, status: "settled", result: creatorWins ? "creator" : "opponent", actual }
          : b));
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
        setBets((prev) => prev.map((b) => b.id === bet.id
          ? { ...b, status: "settled", result: creatorWins ? "creator" : "opponent", actual }
          : b));
        return;
      }
      if (!bet.playerId || bet.line === "" || bet.line === undefined) {
        setBetErrors((e) => ({ ...e, [bet.id]: "This slip needs a Sleeper player ID and line — edit it to add one." }));
        return;
      }
      const row = Object.values(weekData).find((r) => r.players_points && bet.playerId in r.players_points);
      if (!row) {
        setBetErrors((e) => ({ ...e, [bet.id]: `Week ${wk} scores aren't available yet.` }));
        return;
      }
      const actual = row.players_points[bet.playerId];
      const over = actual > Number(bet.line);
      const creatorWins = (bet.creatorSide === "over" && over) || (bet.creatorSide === "under" && !over);
      setBets((prev) => prev.map((b) => b.id === bet.id
        ? { ...b, status: "settled", result: creatorWins ? "creator" : "opponent", actual }
        : b));
      return;
    }

    setBetErrors((e) => ({ ...e, [bet.id]: "This bet type isn't stat-based — grade it manually." }));
  }

  function submitBet(e) {
    e.preventDefault();
    if (!form.title.trim()) return;
    const newBet = {
      id: "b" + Date.now(), ticket: ticketSeq, type: form.type,
      title: form.title.trim(), creator: viewer, opponent: form.opponent,
      stake: Number(form.stake) || 0, status: "pending", result: null,
      ...(isWeeklyBet(form.type) ? { week: Number(form.week) || Number(league.week) || 1 } : {}),
      ...(form.type === "prop"
        ? { playerId: form.playerId.trim(), line: form.line, creatorSide: form.creatorSide }
        : {}),
    };
    setBets((prev) => [newBet, ...prev]);
    setTicketSeq((n) => n + 1);
    setForm({
      type: "matchup", title: "", opponent: defaultOpponent, stake: 10,
      week: activeWeek,
      playerId: "", line: "", creatorSide: "over",
    });
    setShowForm(false);
    setTab("slips");
    setSelectedWeek(newBet.week ?? activeWeek);
  }

  function renderBetSlip(b) {
    const s = STATUS_STYLE[b.status] || STATUS_STYLE.pending;
    const isViewerOpponent = b.opponent === viewer && b.status === "pending";
    const canAuto = AUTO_GRADABLE[b.type] && b.status === "locked";
    return (
      <div className="sb-ticket" key={b.id}>
        <div className="sb-stamp" style={{ color: s.color, transform: `rotate(${s.rotate}deg)` }}>{s.label}</div>
        <div className="sb-ticket-top">
          <div>
            <div className="sb-ticket-num">TICKET NO. {b.ticket}</div>
            <div className="sb-ticket-type">{TYPE_LABEL[b.type]}{b.week ? ` · Wk ${b.week}` : ""}</div>
            <div className="sb-ticket-title">{b.title}</div>
            <div className="sb-ticket-parties">{nameOf(b.creator)} <span style={{ opacity: 0.5 }}>vs</span> {nameOf(b.opponent)}</div>
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
        ) : (
          <>
            <div className="sb-ticket-actions">
              {b.status === "pending" && isViewerOpponent && (
                <>
                  <button className="sb-btn sb-btn-accept" onClick={() => advance(b.id, "accept")}><Check size={12} /> Accept</button>
                  <button className="sb-btn sb-btn-decline" onClick={() => advance(b.id, "decline")}><X size={12} /> Decline</button>
                </>
              )}
              {b.status === "pending" && !isViewerOpponent && (
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
    const open = weekBets.filter((b) => b.status !== "settled" && b.status !== "declined");
    return {
      total: weekBets.length,
      open: open.length,
      stake: open.reduce((sum, b) => sum + b.stake, 0),
    };
  }, [weekBets]);

  return (
    <div className="sb-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap');

        .sb-root {
          --felt: #163229; --felt-dark: #102520;
          --paper: #f2e8d2; --ink: #23281f;
          --gold: #c9a227; --gold-bright: #e0bc4a;
          --red: #a6373c; --green: #3f6b52; --line: #3f6657;
          font-family: 'Inter', sans-serif;
          background: var(--felt);
          background-image:
            radial-gradient(circle at 20% 10%, rgba(255,255,255,0.03), transparent 40%),
            radial-gradient(circle at 80% 80%, rgba(255,255,255,0.03), transparent 40%);
          color: var(--paper);
          min-height: 100%;
          padding-bottom: 5.5rem;
        }
        .sb-display { font-family: 'Bebas Neue', sans-serif; letter-spacing: 0.03em; }
        .sb-mono { font-family: 'IBM Plex Mono', monospace; }

        .sb-marquee { border-bottom: 2px solid var(--line); background: linear-gradient(180deg, var(--felt-dark), var(--felt)); padding: 1.1rem 1.25rem 1rem; }
        .sb-marquee-title { font-size: 2rem; line-height: 1; color: var(--gold-bright); text-shadow: 0 1px 0 rgba(0,0,0,0.4); }
        .sb-marquee-sub { font-family: 'IBM Plex Mono', monospace; font-size: 0.7rem; letter-spacing: 0.12em; color: #a9c4b6; text-transform: uppercase; }

        .sb-viewer-select { background: var(--felt-dark); border: 1px solid var(--line); color: var(--paper); font-family: 'IBM Plex Mono', monospace; font-size: 0.75rem; padding: 0.4rem 0.6rem; border-radius: 3px; }

        .sb-tabs { display: flex; gap: 0.3rem; padding: 0.9rem 1.25rem 0; flex-wrap: wrap; }
        .sb-tab { font-family: 'Bebas Neue', sans-serif; font-size: 1.1rem; letter-spacing: 0.04em; padding: 0.5rem 1.1rem 0.6rem; color: #a9c4b6; background: transparent; border: none; border-bottom: 3px solid transparent; cursor: pointer; display: flex; align-items: center; gap: 0.4rem; }
        .sb-tab.active { color: var(--gold-bright); border-bottom-color: var(--gold); }

        .sb-newbet-btn { margin-left: auto; font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; background: var(--gold); color: #241d05; border: none; padding: 0.5rem 0.8rem; border-radius: 3px; display: flex; align-items: center; gap: 0.35rem; cursor: pointer; font-weight: 600; }
        .sb-newbet-btn:hover { background: var(--gold-bright); }

        .sb-content { padding: 1.25rem; max-width: 880px; margin: 0 auto; }

        .sb-ticket { position: relative; background: var(--paper); color: var(--ink); border-radius: 4px; padding: 1.1rem 1.2rem 1rem; margin-bottom: 1.4rem; box-shadow: 0 6px 14px rgba(0,0,0,0.28); }
        .sb-ticket::before, .sb-ticket::after { content: ""; position: absolute; top: 50%; transform: translateY(-50%); width: 20px; height: 20px; background: var(--felt); border-radius: 50%; }
        .sb-ticket::before { left: -10px; } .sb-ticket::after { right: -10px; }
        .sb-ticket-perf { border-top: 2px dashed #cdbf9c; margin: 0.7rem 0; }
        .sb-ticket-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.75rem; }
        .sb-ticket-num { font-family: 'IBM Plex Mono', monospace; font-size: 0.68rem; color: #8a7c55; letter-spacing: 0.08em; }
        .sb-ticket-type { display: inline-block; font-family: 'IBM Plex Mono', monospace; font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase; background: var(--felt); color: var(--gold-bright); padding: 0.15rem 0.5rem; border-radius: 2px; margin-bottom: 0.35rem; }
        .sb-ticket-title { font-family: 'Bebas Neue', sans-serif; font-size: 1.35rem; line-height: 1.15; letter-spacing: 0.01em; }
        .sb-ticket-parties { font-family: 'IBM Plex Mono', monospace; font-size: 0.78rem; color: #5a5340; margin-top: 0.3rem; }
        .sb-ticket-stake { font-family: 'Bebas Neue', sans-serif; font-size: 1.6rem; color: var(--green); text-align: right; white-space: nowrap; }
        .sb-ticket-stake span { display: block; font-family: 'IBM Plex Mono', monospace; font-size: 0.6rem; color: #8a7c55; letter-spacing: 0.1em; }

        .sb-stamp { position: absolute; top: 0.9rem; right: 1.1rem; font-family: 'Bebas Neue', sans-serif; font-size: 0.85rem; letter-spacing: 0.12em; padding: 0.15rem 0.5rem; border: 2px solid currentColor; border-radius: 3px; opacity: 0.85; pointer-events: none; }

        .sb-ticket-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-top: 0.6rem; }
        .sb-btn { font-family: 'IBM Plex Mono', monospace; font-size: 0.68rem; letter-spacing: 0.05em; text-transform: uppercase; padding: 0.4rem 0.65rem; border-radius: 3px; border: 1px solid transparent; cursor: pointer; display: flex; align-items: center; gap: 0.3rem; font-weight: 600; }
        .sb-btn-accept { background: var(--green); color: #eef7ef; }
        .sb-btn-decline { background: transparent; color: var(--red); border-color: var(--red); }
        .sb-btn-lock { background: var(--ink); color: var(--paper); }
        .sb-btn-grade { background: transparent; color: var(--ink); border-color: #8a7c55; }
        .sb-btn-auto { background: var(--gold); color: #241d05; }
        .sb-btn:hover { filter: brightness(1.08); }
        .sb-btn:disabled { opacity: 0.5; cursor: default; }

        .sb-result-line { font-family: 'IBM Plex Mono', monospace; font-size: 0.75rem; color: #5a5340; margin-top: 0.5rem; }
        .sb-result-line b { color: var(--green); }
        .sb-bet-error { font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: var(--red); margin-top: 0.4rem; display: flex; align-items: center; gap: 0.3rem; }

        .sb-board { background: var(--felt-dark); border: 1px solid var(--line); border-radius: 6px; padding: 1.1rem 1.2rem; margin-bottom: 1.5rem; }
        .sb-board h3 { font-family: 'Bebas Neue', sans-serif; font-size: 1.2rem; color: var(--gold-bright); letter-spacing: 0.05em; margin: 0 0 0.75rem; }
        .sb-board p.sb-note { font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: #7ea08f; margin: -0.4rem 0 0.9rem; line-height: 1.5; }
        .sb-standing-row { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid var(--line); font-family: 'IBM Plex Mono', monospace; font-size: 0.85rem; }
        .sb-standing-row:last-child { border-bottom: none; }
        .sb-standing-name { font-family: 'Inter', sans-serif; font-weight: 600; }
        .sb-owe-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.55rem 0; border-bottom: 1px solid var(--line); font-family: 'IBM Plex Mono', monospace; font-size: 0.82rem; }
        .sb-owe-row:last-child { border-bottom: none; }
        .sb-empty { font-family: 'IBM Plex Mono', monospace; font-size: 0.8rem; color: #7ea08f; padding: 0.5rem 0; }

        .sb-form-panel { background: var(--paper); color: var(--ink); border-radius: 6px; padding: 1.1rem 1.2rem; margin-bottom: 1.5rem; }
        .sb-form-panel h3 { font-family: 'Bebas Neue', sans-serif; font-size: 1.3rem; margin: 0 0 0.75rem; }
        .sb-field { margin-bottom: 0.75rem; }
        .sb-field label { display: block; font-family: 'IBM Plex Mono', monospace; font-size: 0.65rem; letter-spacing: 0.08em; text-transform: uppercase; color: #6b6144; margin-bottom: 0.25rem; }
        .sb-field input, .sb-field select { width: 100%; padding: 0.5rem 0.6rem; border: 1px solid #c9bb95; border-radius: 3px; font-family: 'Inter', sans-serif; font-size: 0.85rem; background: #fbf6ea; color: var(--ink); }
        .sb-form-row { display: flex; gap: 0.75rem; flex-wrap: wrap; }
        .sb-form-row > .sb-field { flex: 1; min-width: 120px; }
        .sb-form-actions { display: flex; gap: 0.6rem; margin-top: 0.4rem; }
        .sb-btn-submit { background: var(--green); color: #eef7ef; }
        .sb-btn-cancel { background: transparent; color: #6b6144; border-color: #c9bb95; }

        .sb-sync-row { display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid var(--line); }
        .sb-sync-row:last-child { border-bottom: none; }
        .sb-sync-select { background: var(--paper); color: var(--ink); border: 1px solid #c9bb95; border-radius: 3px; font-family: 'IBM Plex Mono', monospace; font-size: 0.75rem; padding: 0.3rem 0.5rem; }
        .sb-error-banner { font-family: 'IBM Plex Mono', monospace; font-size: 0.75rem; color: #e0949a; margin-top: 0.5rem; display: flex; gap: 0.4rem; align-items: center; }
        .sb-week-points { font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: #9ad6b3; }

        .sb-ledger-toggle { display: flex; gap: 0.35rem; margin-bottom: 1rem; }
        .sb-ledger-toggle button { font-family: 'IBM Plex Mono', monospace; font-size: 0.68rem; letter-spacing: 0.06em; text-transform: uppercase; padding: 0.45rem 0.75rem; border-radius: 3px; border: 1px solid var(--line); background: transparent; color: #a9c4b6; cursor: pointer; }
        .sb-ledger-toggle button.active { background: var(--gold); color: #241d05; border-color: var(--gold); font-weight: 600; }

        .sb-week-nav { display: flex; align-items: center; justify-content: center; gap: 0.75rem; margin-bottom: 1rem; }
        .sb-week-nav button { background: var(--felt); border: 1px solid var(--line); color: var(--paper); border-radius: 3px; padding: 0.35rem 0.45rem; cursor: pointer; display: flex; align-items: center; }
        .sb-week-nav button:disabled { opacity: 0.35; cursor: default; }
        .sb-week-nav-label { font-family: 'Bebas Neue', sans-serif; font-size: 1.5rem; letter-spacing: 0.04em; color: var(--gold-bright); min-width: 8rem; text-align: center; }
        .sb-week-select { padding: 0.35rem 0.5rem; border: 1px solid var(--line); border-radius: 4px; background: var(--paper); color: var(--ink); font-family: 'Inter', sans-serif; font-size: 0.82rem; min-width: 6.5rem; }

        .sb-statement-header { font-family: 'IBM Plex Mono', monospace; font-size: 0.68rem; letter-spacing: 0.1em; text-transform: uppercase; color: #7ea08f; margin-bottom: 0.75rem; }
        .sb-statement-personal { background: rgba(201, 162, 39, 0.08); border: 1px solid rgba(201, 162, 39, 0.35); border-radius: 4px; padding: 0.85rem 1rem; margin-bottom: 1rem; }
        .sb-statement-personal h4 { font-family: 'Bebas Neue', sans-serif; font-size: 1.05rem; color: var(--gold-bright); margin: 0 0 0.5rem; letter-spacing: 0.04em; }
        .sb-statement-line { font-family: 'IBM Plex Mono', monospace; font-size: 0.78rem; padding: 0.25rem 0; color: #c8ddd2; }
        .sb-activity-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.75rem; padding: 0.55rem 0; border-bottom: 1px solid var(--line); font-family: 'IBM Plex Mono', monospace; font-size: 0.75rem; }
        .sb-activity-row:last-child { border-bottom: none; }
        .sb-activity-title { font-family: 'Inter', sans-serif; font-weight: 500; font-size: 0.82rem; color: var(--paper); margin-bottom: 0.15rem; }
        .sb-activity-meta { color: #7ea08f; font-size: 0.68rem; }
        .sb-slips-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1rem; }
        .sb-slips-summary { font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: #7ea08f; letter-spacing: 0.04em; }
        .sb-season-section { margin-top: 2rem; padding-top: 1.25rem; border-top: 1px solid var(--line); }
        .sb-season-section h3 { font-family: 'Bebas Neue', sans-serif; font-size: 1.2rem; color: var(--gold-bright); letter-spacing: 0.05em; margin: 0 0 0.35rem; }
        .sb-season-section .sb-note { margin-bottom: 1rem; }

        .sb-setup { max-width: 520px; margin: 3rem auto; padding: 0 1.25rem; }
        .sb-setup-card { background: var(--felt-dark); border: 1px solid var(--line); border-radius: 8px; padding: 1.5rem 1.4rem; box-shadow: 0 8px 24px rgba(0,0,0,0.25); }
        .sb-setup-card h2 { font-family: 'Bebas Neue', sans-serif; font-size: 2rem; color: var(--gold-bright); margin: 0 0 0.35rem; letter-spacing: 0.04em; }
        .sb-setup-card p { font-family: 'IBM Plex Mono', monospace; font-size: 0.75rem; color: #7ea08f; line-height: 1.6; margin: 0 0 1.1rem; }
        .sb-setup-members { display: flex; flex-direction: column; gap: 0.35rem; margin: 0.75rem 0 1rem; max-height: 220px; overflow-y: auto; }
        .sb-setup-member { display: flex; align-items: center; gap: 0.5rem; padding: 0.45rem 0.55rem; border-radius: 4px; border: 1px solid var(--line); font-family: 'Inter', sans-serif; font-size: 0.85rem; }
        .sb-setup-member span.sub { font-family: 'IBM Plex Mono', monospace; font-size: 0.65rem; color: #7ea08f; }
        .sb-league-badge { font-family: 'IBM Plex Mono', monospace; font-size: 0.65rem; letter-spacing: 0.08em; text-transform: uppercase; color: #9ad6b3; background: rgba(154,214,179,0.1); border: 1px solid rgba(154,214,179,0.25); padding: 0.2rem 0.5rem; border-radius: 3px; }

        .sb-ticket-odds { font-family: 'IBM Plex Mono', monospace; font-size: 0.68rem; color: #8a7c55; margin-top: 0.25rem; }

        .sb-board-line { background: var(--felt-dark); border: 1px solid var(--line); border-radius: 6px; padding: 0.9rem 1rem; margin-bottom: 0.75rem; }
        .sb-board-line-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.75rem; margin-bottom: 0.65rem; }
        .sb-board-line-title { font-family: 'Bebas Neue', sans-serif; font-size: 1.15rem; color: var(--paper); letter-spacing: 0.02em; line-height: 1.15; }
        .sb-board-line-sub { font-family: 'IBM Plex Mono', monospace; font-size: 0.65rem; color: #7ea08f; letter-spacing: 0.06em; text-transform: uppercase; margin-top: 0.2rem; }
        .sb-board-sides { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
        .sb-board-side { display: flex; align-items: center; gap: 0.45rem; background: var(--paper); color: var(--ink); border-radius: 4px; padding: 0.35rem 0.45rem 0.35rem 0.55rem; }
        .sb-board-side-label { font-family: 'Inter', sans-serif; font-size: 0.78rem; font-weight: 500; }
        .sb-board-odds { font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; font-weight: 600; color: var(--green); min-width: 2.8rem; }
        .sb-board-stake { width: 3.2rem; padding: 0.3rem 0.35rem; border: 1px solid #c9bb95; border-radius: 3px; font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; background: #fbf6ea; color: var(--ink); }
        .sb-board-take { font-family: 'IBM Plex Mono', monospace; font-size: 0.62rem; letter-spacing: 0.05em; text-transform: uppercase; padding: 0.35rem 0.5rem; border-radius: 3px; border: none; background: var(--gold); color: #241d05; cursor: pointer; font-weight: 600; }
        .sb-board-take:disabled { opacity: 0.4; cursor: default; }
        .sb-board-section { margin-bottom: 1.5rem; }
        .sb-board-section h3 { font-family: 'Bebas Neue', sans-serif; font-size: 1.15rem; color: var(--gold-bright); letter-spacing: 0.05em; margin: 0 0 0.65rem; }
        .sb-board-filters { display: flex; flex-wrap: wrap; gap: 0.65rem 1rem; align-items: flex-end; background: var(--felt-dark); border: 1px solid var(--line); border-radius: 6px; padding: 0.85rem 1rem; margin-bottom: 1rem; }
        .sb-board-filter { display: flex; flex-direction: column; gap: 0.25rem; min-width: 7.5rem; }
        .sb-board-filter label { font-family: 'IBM Plex Mono', monospace; font-size: 0.58rem; letter-spacing: 0.08em; text-transform: uppercase; color: #7ea08f; }
        .sb-board-filter select { padding: 0.35rem 0.45rem; border: 1px solid var(--line); border-radius: 4px; background: var(--paper); color: var(--ink); font-family: 'Inter', sans-serif; font-size: 0.78rem; min-width: 7.5rem; }
        .sb-board-filter-pills { display: flex; flex-wrap: wrap; gap: 0.35rem; }
        .sb-board-pill { font-family: 'IBM Plex Mono', monospace; font-size: 0.62rem; letter-spacing: 0.04em; text-transform: uppercase; padding: 0.3rem 0.55rem; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: #9ab5a8; cursor: pointer; }
        .sb-board-pill.active { background: var(--gold); color: #241d05; border-color: var(--gold); font-weight: 600; }
        .sb-board-count { font-family: 'IBM Plex Mono', monospace; font-size: 0.68rem; color: #7ea08f; margin-left: auto; align-self: center; }

        .dk-event { background: var(--felt-dark); border-radius: 8px; margin-bottom: 0.85rem; overflow: hidden; border: 1px solid var(--line); }
        .dk-event-header { padding: 0.85rem 1rem; border-bottom: 1px solid var(--line); background: rgba(0,0,0,0.15); }
        .dk-event-title { font-family: 'Bebas Neue', sans-serif; font-size: 1.05rem; font-weight: 400; color: var(--gold-bright); letter-spacing: 0.04em; }
        .dk-event-sub { font-family: 'IBM Plex Mono', monospace; font-size: 0.68rem; color: #7ea08f; margin-top: 0.15rem; }
        .dk-event-markets { padding: 0.35rem 0; }
        .dk-market { padding: 0.65rem 1rem; border-bottom: 1px solid var(--line); }
        .dk-market:last-child { border-bottom: none; }
        .dk-market-head { margin-bottom: 0.55rem; }
        .dk-market-title { font-family: 'Inter', sans-serif; font-size: 0.85rem; font-weight: 600; color: var(--paper); line-height: 1.3; }
        .dk-market-meta { font-family: 'IBM Plex Mono', monospace; font-size: 0.65rem; color: #7ea08f; margin-top: 0.15rem; }
        .dk-odds-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.45rem; }
        .dk-odds-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.1rem; min-height: 3.4rem; padding: 0.45rem 0.5rem; border-radius: 6px; border: 1px solid var(--line); background: rgba(0,0,0,0.2); color: var(--paper); cursor: pointer; transition: border-color 0.15s, background 0.15s; }
        .dk-odds-btn:hover:not(:disabled) { border-color: var(--gold); background: rgba(201, 162, 39, 0.08); }
        .dk-odds-btn.selected { border-color: var(--gold); background: rgba(201, 162, 39, 0.15); box-shadow: inset 0 0 0 1px var(--gold); }
        .dk-odds-btn:disabled { opacity: 0.35; cursor: default; }
        .dk-odds-label { font-size: 0.72rem; font-weight: 600; text-align: center; line-height: 1.2; }
        .dk-odds-sublabel { font-size: 0.62rem; color: #7ea08f; }
        .dk-odds-value { font-family: 'IBM Plex Mono', monospace; font-size: 0.88rem; font-weight: 700; color: var(--gold-bright); margin-top: 0.1rem; }

        .dk-betslip { position: fixed; left: 0; right: 0; bottom: 0; z-index: 100; background: var(--felt-dark); border-top: 2px solid var(--line); box-shadow: 0 -8px 24px rgba(0,0,0,0.35); }
        .dk-betslip-inner { max-width: 880px; margin: 0 auto; padding: 0.75rem 1.25rem; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
        .dk-betslip-pick { flex: 1; min-width: 140px; }
        .dk-betslip-label { font-family: 'IBM Plex Mono', monospace; font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gold-bright); }
        .dk-betslip-title { font-size: 0.82rem; font-weight: 600; color: var(--paper); margin-top: 0.1rem; }
        .dk-betslip-detail { font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: #7ea08f; }
        .dk-betslip-actions { display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap; }
        .dk-betslip-stake-wrap { display: flex; flex-direction: column; gap: 0.15rem; }
        .dk-betslip-stake-wrap label { font-family: 'IBM Plex Mono', monospace; font-size: 0.6rem; color: #7ea08f; text-transform: uppercase; }
        .dk-betslip-stake { width: 4.5rem; padding: 0.4rem 0.45rem; border-radius: 4px; border: 1px solid #c9bb95; background: #fbf6ea; color: var(--ink); font-size: 0.85rem; font-weight: 600; }
        .dk-betslip-payout { display: flex; flex-direction: column; font-family: 'IBM Plex Mono', monospace; font-size: 0.62rem; color: #7ea08f; }
        .dk-betslip-payout strong { font-size: 0.95rem; color: var(--gold-bright); }
        .dk-betslip-place { padding: 0.65rem 1.1rem; border-radius: 4px; border: none; background: var(--gold); color: #241d05; font-family: 'IBM Plex Mono', monospace; font-size: 0.75rem; font-weight: 700; cursor: pointer; white-space: nowrap; text-transform: uppercase; letter-spacing: 0.04em; }
        .dk-betslip-place:hover { background: var(--gold-bright); }
        .dk-betslip-clear { padding: 0.45rem; border-radius: 4px; border: 1px solid var(--line); background: transparent; color: #7ea08f; cursor: pointer; display: flex; align-items: center; }

        .dk-custom-builder { padding: 0.85rem 1rem 1rem; }
        .dk-custom-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.65rem; margin-bottom: 0.75rem; }
        @media (max-width: 560px) { .dk-custom-row { grid-template-columns: 1fr; } }
        .dk-custom-field label { display: block; font-family: 'IBM Plex Mono', monospace; font-size: 0.65rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #7ea08f; margin-bottom: 0.3rem; }
        .dk-custom-field select { width: 100%; padding: 0.5rem 0.55rem; border-radius: 4px; border: 1px solid var(--line); background: rgba(0,0,0,0.2); color: var(--paper); font-size: 0.82rem; }
        .dk-player-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.35rem; }
        .dk-player-chip { padding: 0.35rem 0.55rem; border-radius: 999px; border: 1px solid var(--line); background: rgba(0,0,0,0.15); color: #c8ddd2; font-size: 0.72rem; cursor: pointer; }
        .dk-player-chip.active { border-color: var(--gold); background: rgba(201, 162, 39, 0.15); color: var(--paper); font-weight: 600; }
        .dk-custom-toggle { display: flex; align-items: center; gap: 0.4rem; font-size: 0.75rem; color: #a9c4b6; margin-bottom: 0.75rem; cursor: pointer; }
        .dk-sport-chips { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 1rem; }
        .dk-sport-chip { padding: 0.35rem 0.7rem; border-radius: 999px; font-size: 0.72rem; font-weight: 600; background: rgba(0,0,0,0.15); border: 1px solid var(--line); color: #a9c4b6; cursor: pointer; }
        .dk-sport-chip.active { background: var(--gold); color: #241d05; border-color: var(--gold); }
        .sb-board-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 0.75rem; }
        .sb-matchup-header { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap; }
        .sb-matchup-scoreboard { display: grid; grid-template-columns: 1fr auto 1fr; gap: 0.75rem; align-items: stretch; margin-bottom: 1.25rem; }
        .sb-matchup-team { background: var(--felt-dark); border: 1px solid var(--line); border-radius: 6px; padding: 0.85rem 1rem; }
        .sb-matchup-team.you { border-color: var(--gold); }
        .sb-matchup-team h4 { font-family: 'Bebas Neue', sans-serif; font-size: 1.2rem; color: var(--gold-bright); margin: 0 0 0.35rem; letter-spacing: 0.03em; }
        .sb-matchup-total { font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: #9ad6b3; margin-bottom: 0.65rem; }
        .sb-matchup-vs { font-family: 'Bebas Neue', sans-serif; font-size: 1.4rem; color: #7ea08f; display: flex; align-items: center; justify-content: center; }
        .sb-matchup-player { display: grid; grid-template-columns: 2.2rem 1fr auto auto; gap: 0.35rem 0.5rem; align-items: center; padding: 0.35rem 0.4rem; border-top: 1px solid rgba(63,102,87,0.45); font-size: 0.78rem; width: 100%; border-left: none; border-right: none; border-bottom: none; background: transparent; color: inherit; font-family: inherit; text-align: left; cursor: pointer; border-radius: 4px; transition: background 0.12s, outline 0.12s; }
        .sb-matchup-player:first-of-type { border-top: none; }
        .sb-matchup-player:hover { background: rgba(255,255,255,0.04); }
        .sb-matchup-player.selected { background: rgba(201, 162, 39, 0.12); outline: 1px solid var(--gold); }
        .sb-matchup-pos { font-family: 'IBM Plex Mono', monospace; font-size: 0.62rem; color: #7ea08f; }
        .sb-matchup-name { font-weight: 500; }
        .sb-matchup-meta { font-family: 'IBM Plex Mono', monospace; font-size: 0.62rem; color: #7ea08f; }
        .sb-matchup-proj { font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: #c9e8d4; min-width: 2.8rem; text-align: right; }
        .sb-matchup-actual { font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: var(--gold-bright); min-width: 2.8rem; text-align: right; }
        .sb-matchup-bets h3 { font-family: 'Bebas Neue', sans-serif; font-size: 1.15rem; color: var(--gold-bright); letter-spacing: 0.05em; margin: 0 0 0.65rem; }
      `}</style>

      {!leagueReady && (
        <div className="sb-setup">
          <div className="sb-setup-card">
            <h2>Link Your League</h2>
            {members.length === 0 ? (
              <>
                <p>
                  Connect your Sleeper league to pull in every manager automatically.
                  Your league stays linked all season — bets, balances, and rosters are saved on this device.
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
                  Find it in the Sleeper app URL or league settings. No login required.
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
              </>
            ) : (
              <>
                <p>
                  <span className="sb-league-badge">Connected</span>
                  {" "}{league.leagueName} &middot; {members.length} managers
                </p>
                <div className="sb-field" style={{ color: "var(--paper)" }}>
                  <label style={{ color: "#a9c4b6" }}>Who are you?</label>
                  <select
                    className="sb-viewer-select"
                    style={{ width: "100%", padding: "0.55rem 0.6rem" }}
                    value={setupViewer}
                    onChange={(e) => setSetupViewer(e.target.value)}
                  >
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}{m.teamName ? ` (${m.displayName})` : ""}</option>
                    ))}
                  </select>
                </div>
                <div className="sb-setup-members">
                  {members.map((m) => (
                    <div className="sb-setup-member" key={m.id}>
                      <Users size={14} color="#7ea08f" />
                      <div>
                        <div>{m.name}</div>
                        {m.teamName && <span className="sub">{m.displayName}</span>}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="sb-form-actions">
                  <button className="sb-btn sb-btn-submit" onClick={finishSetup} disabled={!setupViewer}>
                    <Check size={12} /> Enter the book
                  </button>
                  <button
                    className="sb-btn sb-btn-cancel"
                    style={{ color: "#a9c4b6", borderColor: "var(--line)" }}
                    onClick={() => { setMembers([]); setLeague((s) => ({ ...s, inputId: "", error: null })); }}
                  >
                    Back
                  </button>
                </div>
              </>
            )}
            {league.error && (
              <div className="sb-error-banner" style={{ marginTop: "0.75rem" }}>
                <AlertTriangle size={12} /> {league.error}
              </div>
            )}
          </div>
        </div>
      )}

      {leagueReady && (
        <>
      <div className="sb-marquee">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="sb-marquee-title sb-display">League Sportsbook</div>
            <div className="sb-marquee-sub">
              {league.leagueName} · {league.projectionSeason} NFL · Week {currentWeek}
              {league.nflSeasonType && league.nflSeasonType !== "regular" ? ` · NFL ${league.nflSeasonType}` : ""}
              {" · "}{league.scoringLabel}
              {" · "}{BUILD_STAMP}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Users size={14} color="#a9c4b6" />
            <span className="sb-marquee-sub" style={{ color: "#a9c4b6" }}>viewing as</span>
            <select className="sb-viewer-select" value={viewer} onChange={(e) => setViewer(e.target.value)}>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>
      </div>

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
        <button className={`sb-tab ${tab === "ledger" ? "active" : ""}`} onClick={() => setTab("ledger")}>
          <Trophy size={16} /> Ledger
        </button>
        <button className={`sb-tab ${tab === "sync" ? "active" : ""}`} onClick={() => setTab("sync")}>
          <Link2 size={16} /> League
        </button>
        <button className="sb-newbet-btn" onClick={() => {
          if (!showForm) setForm((f) => ({ ...f, week: activeWeek }));
          setShowForm((s) => !s);
        }}>
          <Plus size={13} /> New Bet
        </button>
      </div>

      <div className="sb-content">
        {showForm && (
          <div className="sb-form-panel">
            <h3>Write a Slip</h3>
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
                <div className="sb-field">
                  <label>Against</label>
                  <select value={form.opponent} onChange={(e) => setForm({ ...form, opponent: e.target.value })}>
                    {members.filter((m) => m.id !== viewer).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
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

            <div className="dk-sport-chips">
              {[
                { id: "all", label: "All Markets" },
                { id: "props", label: "Player Props" },
                { id: "lineups", label: "Lineups" },
                { id: "matchups", label: "H2H" },
                { id: "battles", label: "Player Battles" },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`dk-sport-chip${boardCategory === opt.id ? " active" : ""}`}
                  onClick={() => setBoardCategory(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>

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
              <div className="sb-board-filter">
                <label>Position</label>
                <select value={boardPosition} onChange={(e) => setBoardPosition(e.target.value)}>
                  <option value="all">All positions</option>
                  {["QB", "RB", "WR", "TE"].map((pos) => (
                    <option key={pos} value={pos}>{pos}</option>
                  ))}
                </select>
              </div>
              {boardNflTeams.length > 0 && boardCategory !== "battles" && (
                <div className="sb-board-filter">
                  <label>NFL team</label>
                  <select value={boardNflTeam} onChange={(e) => setBoardNflTeam(e.target.value)}>
                    <option value="all">All NFL teams</option>
                    {boardNflTeams.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {boardCategory === "battles" && (
              <div className="dk-event" style={{ marginBottom: "1rem" }}>
                <div className="dk-event-header">
                  <div className="dk-event-title">Build a Player Battle</div>
                  <div className="dk-event-sub">Your starter vs any starter on another fantasy team — e.g. your WR1 vs their WR1</div>
                </div>
                <div className="dk-custom-builder">
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
                        onChange={(e) => setCustomH2H((h) => ({
                          ...h,
                          myPlayerId: e.target.value,
                          oppPlayerId: "",
                        }))}
                      >
                        <option value="">Select your starter…</option>
                        {myStarterPicks.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.position}) · {formatProj(p.proj)} proj
                          </option>
                        ))}
                      </select>
                      <div className="dk-player-chips">
                        {myStarterPicks.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            className={`dk-player-chip${customH2H.myPlayerId === p.id ? " active" : ""}`}
                            onClick={() => setCustomH2H((h) => ({
                              ...h,
                              myPlayerId: p.id,
                              oppPlayerId: "",
                            }))}
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
                        onChange={(e) => setCustomH2H((h) => ({
                          ...h,
                          oppMemberId: e.target.value,
                          oppPlayerId: "",
                        }))}
                      >
                        <option value="">Select fantasy team…</option>
                        {members.filter((m) => m.id !== viewer).map((m) => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
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
                        <option value="">Select their starter…</option>
                        {oppStarterPicks.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.position}) · {formatProj(p.proj)} proj
                          </option>
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
                </div>
              </div>
            )}

            {boardCategory !== "battles" && (() => {
              const hasLines = boardOfferings.length > 0;
              const hasFiltered = filteredBoardOfferings.length > 0;
              return (
                <>
                  {!hasLines && (
                    <div className="sb-board">
                      <div className="sb-empty">
                        {league.loading
                          ? "Loading Sleeper projections and matchup lines…"
                          : "No lines yet — refresh league on the League tab, then hit Refresh lines here."}
                      </div>
                    </div>
                  )}
                  {hasLines && !hasFiltered && (
                    <div className="sb-board">
                      <div className="sb-empty">No lines match your filters.</div>
                    </div>
                  )}
                  {boardEvents.map((ev) => renderEventCard(
                    ev.title,
                    ev.subtitle,
                    ev.markets.map(renderMarketRow),
                    ev.id,
                  ))}
                </>
              );
            })()}
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
                <div className="sb-empty">No bet slips for week {activeWeek} yet. Post one with the + New Bet button.</div>
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
                  {members.slice().sort((a, b) => ledger.totals[b.id] - ledger.totals[a.id]).map((m) => (
                    <div className="sb-standing-row" key={m.id}>
                      <span className="sb-standing-name">{m.name}</span>
                      <span style={{ color: ledger.totals[m.id] >= 0 ? "#9ad6b3" : "#e0949a" }}>
                        {ledger.totals[m.id] >= 0 ? "+" : "-"}${Math.abs(ledger.totals[m.id])}
                      </span>
                    </div>
                  ))}
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
              <h3>{league.leagueName}</h3>
              <p className="sb-note">
                Linked to Sleeper league <span className="sb-mono">{league.leagueId}</span>.
                Scores and projections for weeks 1–{currentWeek} load automatically
                {loadedWeekCount < currentWeek ? ` (${loadedWeekCount} of ${currentWeek} ready…)` : "."}
              </p>
              <div className="sb-form-actions">
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
                <button className="sb-btn sb-btn-decline" onClick={disconnectLeague}>
                  Disconnect
                </button>
              </div>
              {league.error && <div className="sb-error-banner"><AlertTriangle size={12} /> {league.error}</div>}
            </div>

            <div className="sb-board">
              <h3>League Managers</h3>
              <p className="sb-note">Rosters pulled from Sleeper — used for auto-grading matchup bets.</p>
              {members.map((m) => (
                <div className="sb-sync-row" key={m.id}>
                  <span className="sb-standing-name">{m.name}</span>
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
