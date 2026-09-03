import { supabase } from "./supabase.js";

// ESPN lineupSlotId values that mean "not in the starting lineup."
const BENCH_SLOT_IDS = new Set([20, 21]); // 20 = Bench, 21 = IR

// A player's defaultPositionId is one of the "pure" positions below (lineupSlotId reuses this
// same numbering but adds flex/bench/IR slot values on top — see BENCH_SLOT_IDS). Matches the
// position strings Sleeper/demo data already use ("DEF" for defense) so highest_qb/highest_rb/
// highest_wr-style position filters behave identically regardless of provider.
const ESPN_POSITION_MAP = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DEF", 17: "K" };

async function invokeEspnProxy(payload) {
  const { data, error } = await supabase.functions.invoke("espn-proxy", { body: payload });
  if (error) {
    let code = "espn_fetch_failed";
    try {
      const body = await error.context?.json();
      if (body?.error) code = body.error;
    } catch {
      // response body wasn't JSON (e.g. a network-level failure) — keep the generic fallback
    }
    const typed = new Error(code);
    typed.code = code;
    throw typed;
  }
  return data;
}

// `credentials` is only ever supplied on a retry after a first attempt comes back
// espn_auth_required — the "try public first" flow lives in the caller (LeagueSportsbook.jsx),
// not here. `leagueDbId`, when the league's already linked (a refresh, not a first-time link),
// lets the Edge Function fall back to previously-stored credentials instead of requiring them
// to be re-entered on every refresh.
export function linkEspnLeague(espnLeagueId, season, credentials = null, leagueDbId = null) {
  return invokeEspnProxy({
    mode: "link",
    espnLeagueId,
    season,
    ...(leagueDbId ? { league_id: leagueDbId } : {}),
    ...(credentials ? { espn_s2: credentials.espn_s2, swid: credentials.swid } : {}),
  });
}

// Single choke point credentials enter storage through, regardless of how they were obtained —
// a typed-in form today, a captured webview session later. Also reused as the "reconnect" call
// when previously-stored cookies expire.
export function setEspnCredentials(leagueDbId, espn_s2, swid) {
  return invokeEspnProxy({ mode: "set_credentials", league_id: leagueDbId, espn_s2, swid });
}

export function fetchEspnWeek(leagueDbId, espnLeagueId, season, week) {
  return invokeEspnProxy({ mode: "week", league_id: leagueDbId, espnLeagueId, season, week });
}

function espnTeamName(team) {
  if (team.name) return team.name;
  const location = team.location || "";
  const nickname = team.nickname || "";
  return `${location} ${nickname}`.trim() || `Team ${team.id}`;
}

function playerIdFromEntry(entry) {
  const player = entry.playerPoolEntry?.player || entry.player;
  return player ? String(player.id) : null;
}

// ESPN embeds full player objects (name, position, pro team) right inside roster/box-score
// entries — no separate player-database fetch needed the way Sleeper's fetchPlayerInfo requires.
// `team` (pro team abbreviation) isn't included: it's display-only everywhere it's read
// (LeagueSportsbook.jsx never filters/matches on it), so it's left null rather than adding a
// 32-team proTeamId lookup table for a cosmetic-only field.
function espnPlayerInfoFromEntry(entry) {
  const player = entry.playerPoolEntry?.player || entry.player;
  if (!player) return null;
  return {
    name: player.fullName || `Player ${player.id}`,
    position: ESPN_POSITION_MAP[player.defaultPositionId] || "?",
    team: null,
  };
}

// Collects player name/position for everyone rostered — called at link/refresh time from
// `teams`, and again per week-fetch from `schedule` (buildWeekDataFromEspn) so a same-week
// waiver pickup not seen at last refresh still gets covered.
export function buildPlayersFromEspn(teams) {
  const players = {};
  (teams || []).forEach((team) => {
    (team.roster?.entries || []).forEach((entry) => {
      const pid = playerIdFromEntry(entry);
      const info = espnPlayerInfoFromEntry(entry);
      if (pid && info) players[pid] = info;
    });
  });
  return players;
}

// Mirrors buildMembers() in LeagueSportsbook.jsx. An ESPN team IS its own roster (no separate
// owner/roster split like Sleeper), so team.id fills both `id` and `rosterId`.
export function buildMembersFromEspn(teams) {
  return (teams || [])
    .map((team) => {
      const record = team.record?.overall || {};
      const wins = record.wins || 0;
      const losses = record.losses || 0;
      const ties = record.ties || 0;
      const name = espnTeamName(team);
      const entries = team.roster?.entries || [];
      const starters = entries
        .filter((e) => !BENCH_SLOT_IDS.has(e.lineupSlotId))
        .map(playerIdFromEntry)
        .filter(Boolean);
      return {
        id: String(team.id),
        rosterId: String(team.id),
        name,
        // ESPN doesn't distinguish a "manager display name" from the team name the way
        // Sleeper's display_name/team_name split does — both point at the same value here.
        displayName: name,
        teamName: name,
        seasonPts: record.pointsFor || 0,
        wins,
        losses,
        gamesPlayed: wins + losses + ties,
        starters,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Mirrors the weekCache[w] = {matchups, projections} construction in loadWeekData. One pass
// over `schedule` (already filtered server-side to the requested week) yields both actual
// points AND projections, since every player's stats[] entry carries both statSourceId variants
// for the same scoringPeriodId — unlike Sleeper, which needs a second, separate fetch. Also
// returns `players` (name/position for everyone in this week's boxscores), merged into the
// app's `players` state alongside buildPlayersFromEspn's link-time pass.
export function buildWeekDataFromEspn(schedule, week) {
  const matchups = {};
  const projections = {};
  const playerInfo = {};

  (schedule || []).forEach((matchup) => {
    const homeId = matchup.home?.teamId;
    const awayId = matchup.away?.teamId;
    // Both sides of a pairing share this id so getWeekPairs (LeagueSportsbook.jsx) groups them
    // correctly — matchupPeriodId alone would group every matchup in the week together instead.
    const matchupId = [homeId, awayId].filter((v) => v != null).sort((a, b) => a - b).join("-");

    ["home", "away"].forEach((side) => {
      const team = matchup[side];
      if (!team || team.teamId == null) return;
      const rosterId = String(team.teamId);
      const entries = team.rosterForCurrentScoringPeriod?.entries || [];
      const players = [];
      const starters = [];
      const players_points = {};

      entries.forEach((entry) => {
        const pid = playerIdFromEntry(entry);
        if (!pid) return;
        players.push(pid);
        if (!BENCH_SLOT_IDS.has(entry.lineupSlotId)) starters.push(pid);

        const info = espnPlayerInfoFromEntry(entry);
        if (info) playerInfo[pid] = info;

        const player = entry.playerPoolEntry?.player || entry.player;
        (player?.stats || []).forEach((stat) => {
          if (stat.scoringPeriodId !== week) return;
          if (stat.statSourceId === 0) players_points[pid] = stat.appliedTotal || 0;
          else if (stat.statSourceId === 1) projections[pid] = stat.appliedTotal || 0;
        });
      });

      matchups[rosterId] = {
        points: team.totalPoints ?? 0,
        players_points,
        players,
        starters,
        matchup_id: matchupId,
      };
    });
  });

  return { matchups, projections, players: playerInfo };
}
