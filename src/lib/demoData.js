// Fully fictional league used by Demo Mode. Nothing here touches Supabase or the Sleeper API —
// it exists so people without an account, a Sleeper league, or access to the real league's data
// can still see a realistic, populated version of the app.

export const DEMO_USER_ID = "demo-user";
export const DEMO_LEAGUE_DB_ID = "demo-league";
export const DEMO_SLEEPER_LEAGUE_ID = "demo";
export const DEMO_CURRENT_WEEK = 9;
export const DEMO_SEASON = 2026;

// ---------- tiny deterministic PRNG (mulberry32) so numbers are varied but stable ----------
function mulberry32(seed) {
  let a = seed;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260830);
const jitter = (base, spread) => Math.round((base + (rand() * 2 - 1) * spread) * 10) / 10;

const MANAGERS = [
  { first: "Will", team: "Grid Iron Giants" },
  { first: "Jake", team: "Jake's Jokers" },
  { first: "Mike", team: "Mic Drop" },
  { first: "Sam", team: "Sam I Am" },
  { first: "Alex", team: "Alexander the Great" },
  { first: "Nick", team: "Nick of Time" },
  { first: "Tyler", team: "Tyler Made" },
  { first: "Ryan", team: "Ryan's Hope" },
  { first: "Matt", team: "Matt's Mafia" },
  { first: "Chris", team: "Chris Cross Applesauce" },
];
// [wins, losses, seasonPts] through week 8 — hand-picked spread so standings/Season Bets have texture
const RECORDS = [
  [7, 1, 1148.4], [6, 2, 1121.9], [6, 2, 1098.2], [5, 3, 1075.6], [5, 3, 1062.1],
  [4, 4, 1040.8], [4, 4, 1029.5], [3, 5, 998.7], [2, 6, 967.3], [1, 7, 931.5],
];

const QBS = ["Patrick Mahomes", "Josh Allen", "Jalen Hurts", "Justin Herbert", "Joe Burrow",
  "Lamar Jackson", "Dak Prescott", "Trevor Lawrence", "Kyler Murray", "C.J. Stroud"];
const RBS = ["Christian McCaffrey", "Bijan Robinson", "Breece Hall", "Jonathan Taylor", "Saquon Barkley",
  "Derrick Henry", "Josh Jacobs", "Kenneth Walker III", "Isiah Pacheco", "De'Von Achane",
  "Rachaad White", "Travis Etienne", "James Cook", "Alvin Kamara", "Aaron Jones",
  "Najee Harris", "Tony Pollard", "Joe Mixon", "Zack Moss", "D'Andre Swift",
  "Javonte Williams", "Rhamondre Stevenson", "Brian Robinson Jr.", "Chuba Hubbard", "Zamir White",
  "Tyjae Spears", "Jerome Ford", "Devin Singletary", "Gus Edwards", "Antonio Gibson"];
const WRS = ["Justin Jefferson", "Ja'Marr Chase", "CeeDee Lamb", "Tyreek Hill", "Amon-Ra St. Brown",
  "A.J. Brown", "Puka Nacua", "Garrett Wilson", "Chris Olave", "DK Metcalf",
  "Davante Adams", "Stefon Diggs", "DeVonta Smith", "Jaylen Waddle", "Drake London",
  "Terry McLaurin", "Mike Evans", "Calvin Ridley", "Brandon Aiyuk", "Nico Collins",
  "Tee Higgins", "Marvin Harrison Jr.", "Malik Nabers", "Rome Odunze", "Jordan Addison",
  "Zay Flowers", "Christian Watson", "Jameson Williams", "Courtland Sutton", "Diontae Johnson"];
const TES = ["Travis Kelce", "Sam LaPorta", "Mark Andrews", "T.J. Hockenson", "Trey McBride",
  "George Kittle", "Kyle Pitts", "Dallas Goedert", "Evan Engram", "David Njoku"];
const KS = ["Justin Tucker", "Harrison Butker", "Brandon Aubrey", "Tyler Bass", "Jake Elliott",
  "Younghoe Koo", "Evan McPherson", "Daniel Carlson", "Chris Boswell", "Cameron Dicker"];
const DEFS = ["49ers D/ST", "Cowboys D/ST", "Ravens D/ST", "Jets D/ST", "Bills D/ST",
  "Steelers D/ST", "Browns D/ST", "Dolphins D/ST", "Saints D/ST", "Eagles D/ST"];

const players = {};
let pidSeq = 0;
function addPlayer(name, position, team) {
  const id = `demo-p${pidSeq++}`;
  players[id] = { name, position, team: team || null };
  return id;
}

const PREV_WEEK = DEMO_CURRENT_WEEK - 1;
const rand2 = mulberry32(19700101);
const jitter2 = (base, spread) => Math.round((base + (rand2() * 2 - 1) * spread) * 10) / 10;

const members = [];
const weekMatchupsCurrent = {};   // this week — pregame, no actuals yet, so pool picks stay open
const weekMatchupsPrev = {};      // last week — fully played, used to demo a graded pool + ledger
const weekProjections = {};

MANAGERS.forEach((m, i) => {
  const id = m.first.toLowerCase();
  const rosterId = String(i + 1);
  const [wins, losses, seasonPts] = RECORDS[i];

  const qbTier = 22, rb1Tier = 16, rb2Tier = 11, wr1Tier = 15, wr2Tier = 10, teTier = 9, flexTier = 9, kTier = 8, defTier = 7;
  const qb = addPlayer(QBS[i], "QB");
  const rb1 = addPlayer(RBS[i * 2], "RB");
  const rb2 = addPlayer(RBS[i * 2 + 1], "RB");
  const wr1 = addPlayer(WRS[i * 2], "WR");
  const wr2 = addPlayer(WRS[i * 2 + 1], "WR");
  const te = addPlayer(TES[i], "TE");
  const flex = i < 5
    ? addPlayer(RBS[20 + i], "RB")
    : addPlayer(WRS[20 + (i - 5)], "WR");
  const k = addPlayer(KS[i], "K");
  const def = addPlayer(DEFS[i], "DEF");
  const bench1 = i < 5
    ? addPlayer(RBS[25 + i], "RB")
    : addPlayer(WRS[25 + (i - 5)], "WR");

  const starters = [qb, rb1, rb2, wr1, wr2, te, flex, k, def];
  const roster = [...starters, bench1];

  const proj = {
    [qb]: jitter(qbTier, 4), [rb1]: jitter(rb1Tier, 4), [rb2]: jitter(rb2Tier, 3.5),
    [wr1]: jitter(wr1Tier, 4), [wr2]: jitter(wr2Tier, 3.5), [te]: jitter(teTier, 3),
    [flex]: jitter(flexTier, 3.5), [k]: jitter(kTier, 2), [def]: jitter(defTier, 2.5),
    [bench1]: jitter(8, 3),
  };
  Object.entries(proj).forEach(([pid, val]) => { weekProjections[pid] = Math.max(1, val); });

  // last week's per-player actuals (real Sleeper matchup rows score every rostered player, not
  // just starters) — this is the only week with results, so it's what the pool leaderboard grades
  const prevActual = {};
  Object.entries(proj).forEach(([pid, val]) => {
    prevActual[pid] = Math.max(0, Math.round(jitter2(val, val * 0.4) * 10) / 10);
  });
  const prevLineupActual = starters.reduce((sum, pid) => sum + prevActual[pid], 0);

  members.push({
    id, dbId: id, userId: m.first === "Will" ? DEMO_USER_ID : null,
    rosterId, name: m.team, displayName: m.first, teamName: m.team,
    seasonPts, wins, losses, gamesPlayed: wins + losses, starters,
  });

  const matchupId = Math.floor(i / 2) + 1;
  weekMatchupsCurrent[rosterId] = {
    roster_id: rosterId, matchup_id: matchupId, starters, players: roster, points: 0,
  };
  weekMatchupsPrev[rosterId] = {
    roster_id: rosterId,
    matchup_id: matchupId,
    starters,
    players: roster,
    points: Math.round(prevLineupActual * 10) / 10,
    players_points: prevActual,
  };
});

export const DEMO_MEMBERS = members;
export const DEMO_PLAYERS = players;
export const DEMO_WEEK_CACHE = {
  [DEMO_CURRENT_WEEK]: { matchups: weekMatchupsCurrent, projections: weekProjections },
  [PREV_WEEK]: { matchups: weekMatchupsPrev, projections: weekProjections },
};
export const DEMO_PLAYOFF_TEAMS = 6;

const byName = Object.fromEntries(members.map((m) => [m.displayName, m]));

// ---------- seed bets, already in the app's UI bet-shape (dbRowToBet output) ----------
let ticketSeq = 1000;
function bet(fields) {
  ticketSeq += 1;
  return {
    id: `demo-bet-${ticketSeq}`,
    ticket: ticketSeq,
    status: "pending",
    result: null,
    odds: null,
    toWin: null,
    boardLineId: null,
    boardKind: null,
    playerId: null,
    playerIdA: null,
    playerIdB: null,
    line: null,
    creatorSide: null,
    subjectId: null,
    pickMemberId: null,
    matchupPeerId: null,
    pickPlayerId: null,
    ownerId: null,
    actual: null,
    ...fields,
  };
}

export const DEMO_SEED_BETS = [
  bet({
    type: "prop", boardKind: "lineup_ou", title: "Grid Iron Giants lineup Over 132.5 pts",
    creator: "will", opponent: null, stake: 10, week: DEMO_CURRENT_WEEK,
    odds: -110, toWin: 9, subjectId: "will", creatorSide: "over", line: 132.5,
  }),
  bet({
    type: "matchup", boardKind: "lineup_ml", title: "Mic Drop vs Grid Iron Giants — lineup pts",
    creator: "mike", opponent: null, stake: 15, week: DEMO_CURRENT_WEEK,
    odds: 120, toWin: 18, matchupPeerId: "will",
  }),
  bet({
    type: "prop", boardKind: "player_h2h", title: "Josh Allen vs Jalen Hurts",
    creator: "jake", opponent: "will", stake: 20, week: DEMO_CURRENT_WEEK,
    odds: -130, toWin: 15,
  }),
  bet({
    type: "matchup", boardKind: "lineup_spread", title: "Sam I Am -3.5 vs Grid Iron Giants",
    creator: "sam", opponent: "will", stake: 10, week: DEMO_CURRENT_WEEK, status: "accepted",
    odds: -110, toWin: 9,
  }),
  bet({
    type: "season", boardKind: "season_champion", title: "Will's team wins the league championship",
    creator: "will", opponent: "tyler", stake: 25, week: null, status: "accepted",
    odds: 650, toWin: 163,
  }),
  bet({
    type: "prop", boardKind: "weekly_high", title: "Grid Iron Giants — Weekly High Score",
    creator: "will", opponent: "ryan", stake: 10, week: 8, status: "settled", result: "creator",
    odds: 300, toWin: 30, pickMemberId: "will",
  }),
  bet({
    type: "matchup", boardKind: "lineup_ml", title: "Chris Cross Applesauce vs Nick of Time — lineup pts",
    creator: "chris", opponent: "nick", stake: 15, week: 8, status: "settled", result: "opponent",
    odds: -105, toWin: 14,
  }),
  bet({
    type: "prop", boardKind: "player_h2h", title: "Justin Jefferson vs Tyreek Hill",
    creator: "matt", opponent: "alex", stake: 10, week: 8, status: "settled", result: "creator",
    odds: 105, toWin: 10,
  }),
];

export function otherManagerId(excludeId) {
  const pool = members.filter((m) => m.id !== excludeId);
  return pool[Math.floor(rand() * pool.length)].id;
}

// ---------- seed weekly pool entries/picks — everyone but the demo viewer has already played ----------
export const POOL_QUESTION_KEYS = [
  "weekly_high", "weekly_low", "matchup_winner", "biggest_blowout", "closest_matchup",
  "highest_player", "most_bench", "best_overperform", "biggest_upset",
];

const poolEntries = [];
const poolPicks = [];
let poolPickSeq = 0;
["jake", "mike", "sam", "alex", "nick", "tyler"].forEach((mid, idx) => {
  poolEntries.push({ id: `demo-pool-entry-${mid}`, week: PREV_WEEK, memberId: mid, paid: idx < 5 });
  POOL_QUESTION_KEYS.forEach((qKey) => {
    poolPickSeq += 1;
    poolPicks.push({
      id: `demo-pool-pick-${poolPickSeq}`,
      week: PREV_WEEK,
      memberId: mid,
      questionKey: qKey,
      pickMemberId: otherManagerId(mid),
    });
  });
});

export const DEMO_SEED_POOL_ENTRIES = poolEntries;
export const DEMO_SEED_POOL_PICKS = poolPicks;

// ---------- seed survivor pool — derive week 8's real winners so picks land genuinely mixed ----------
const prevWeekByMatchup = {};
members.forEach((m) => {
  const row = weekMatchupsPrev[m.rosterId];
  if (!row) return;
  if (!prevWeekByMatchup[row.matchup_id]) prevWeekByMatchup[row.matchup_id] = [];
  prevWeekByMatchup[row.matchup_id].push(m);
});
const prevWeekWinners = new Set();
Object.values(prevWeekByMatchup).forEach((group) => {
  if (group.length !== 2) return;
  const [a, b] = group;
  const ptsA = weekMatchupsPrev[a.rosterId].points;
  const ptsB = weekMatchupsPrev[b.rosterId].points;
  prevWeekWinners.add(ptsA > ptsB ? a.id : b.id);
});

// Hand-picked rather than random so the demo reliably shows a mixed outcome (some survive, some
// don't) instead of leaving it to chance against prevWeekWinners — half pick an actual week-8
// winner (jake/mike/sam survive), half don't (alex/nick/tyler are out).
const SURVIVOR_SEED_PICKS = {
  jake: "alex", mike: "sam", sam: "chris",
  alex: "nick", nick: "tyler", tyler: "jake",
};

const survivorEntries = [];
const survivorPicks = [];
let survivorPickSeq = 0;
["jake", "mike", "sam", "alex", "nick", "tyler"].forEach((mid, idx) => {
  survivorEntries.push({ id: `demo-survivor-entry-${mid}`, memberId: mid, paid: idx < 5 });
  survivorPickSeq += 1;
  survivorPicks.push({
    id: `demo-survivor-pick-${survivorPickSeq}`,
    week: PREV_WEEK,
    memberId: mid,
    pickMemberId: SURVIVOR_SEED_PICKS[mid],
  });
});

export const DEMO_SEED_SURVIVOR_ENTRIES = survivorEntries;
export const DEMO_SEED_SURVIVOR_PICKS = survivorPicks;
export const DEMO_PREV_WEEK_WINNERS = prevWeekWinners; // exported for sanity/debugging only
