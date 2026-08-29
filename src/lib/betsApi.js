import { supabase } from "./supabase.js";

function ownerId(dbId, ownerIdByDbId) {
  if (!dbId) return null;
  return ownerIdByDbId[dbId] ?? null;
}

export function dbRowToBet(row, ownerIdByDbId) {
  return {
    id: row.id,
    ticket: row.ticket,
    type: row.type,
    title: row.title,
    creator: ownerId(row.creator, ownerIdByDbId),
    opponent: ownerId(row.opponent, ownerIdByDbId),
    stake: Number(row.stake),
    status: row.status,
    result: row.result,
    week: row.week,
    odds: row.odds,
    toWin: row.to_win,
    boardLineId: row.board_line_id,
    boardKind: row.board_kind,
    playerId: row.player_id,
    playerIdA: row.player_id_a,
    playerIdB: row.player_id_b,
    line: row.line,
    creatorSide: row.creator_side,
    subjectId: ownerId(row.subject_id, ownerIdByDbId),
    pickMemberId: ownerId(row.pick_member_id, ownerIdByDbId),
    matchupPeerId: ownerId(row.matchup_peer_id, ownerIdByDbId),
    pickPlayerId: row.pick_player_id,
    ownerId: ownerId(row.owner_id, ownerIdByDbId),
    actual: row.actual,
  };
}

export async function fetchBets(leagueId, ownerIdByDbId) {
  const { data, error } = await supabase
    .from("bets")
    .select("*")
    .eq("league_id", leagueId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data.map((r) => dbRowToBet(r, ownerIdByDbId));
}

export function subscribeToBets(leagueId, onChange) {
  const channel = supabase
    .channel(`bets-${leagueId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "bets", filter: `league_id=eq.${leagueId}` },
      onChange,
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

export async function insertBet(leagueId, bet, dbIdByOwnerId) {
  const row = {
    league_id: leagueId,
    type: bet.type,
    title: bet.title,
    creator: dbIdByOwnerId[bet.creator],
    opponent: dbIdByOwnerId[bet.opponent],
    stake: bet.stake,
    week: bet.week ?? null,
    odds: bet.odds ?? null,
    to_win: bet.toWin ?? null,
    board_line_id: bet.boardLineId ?? null,
    board_kind: bet.boardKind ?? null,
    player_id: bet.playerId || null,
    player_id_a: bet.playerIdA || null,
    player_id_b: bet.playerIdB || null,
    line: bet.line === "" || bet.line == null ? null : Number(bet.line),
    creator_side: bet.creatorSide || null,
    subject_id: bet.subjectId ? dbIdByOwnerId[bet.subjectId] : null,
    pick_member_id: bet.pickMemberId ? dbIdByOwnerId[bet.pickMemberId] : null,
    matchup_peer_id: bet.matchupPeerId ? dbIdByOwnerId[bet.matchupPeerId] : null,
    pick_player_id: bet.pickPlayerId || null,
    owner_id: bet.ownerId ? dbIdByOwnerId[bet.ownerId] : null,
  };
  const { error } = await supabase.from("bets").insert(row);
  if (error) throw error;
}

export async function updateBetStatus(betDbId, patch) {
  const { error } = await supabase.from("bets").update(patch).eq("id", betDbId);
  if (error) throw error;
}
