import { supabase } from "./supabase.js";

function ownerId(dbId, ownerIdByDbId) {
  if (!dbId) return null;
  return ownerIdByDbId[dbId] ?? null;
}

export function dbRowToEntry(row, ownerIdByDbId) {
  return {
    id: row.id,
    week: row.week,
    memberId: ownerId(row.member_id, ownerIdByDbId),
    paid: row.paid,
  };
}

export function dbRowToPick(row, ownerIdByDbId) {
  return {
    id: row.id,
    week: row.week,
    memberId: ownerId(row.member_id, ownerIdByDbId),
    questionKey: row.question_key,
    pickMemberId: ownerId(row.pick_member_id, ownerIdByDbId),
  };
}

export async function fetchEntries(leagueId, ownerIdByDbId) {
  const { data, error } = await supabase.from("pool_entries").select("*").eq("league_id", leagueId);
  if (error) throw error;
  return data.map((r) => dbRowToEntry(r, ownerIdByDbId));
}

export async function fetchPicks(leagueId, ownerIdByDbId) {
  const { data, error } = await supabase.from("pool_picks").select("*").eq("league_id", leagueId);
  if (error) throw error;
  return data.map((r) => dbRowToPick(r, ownerIdByDbId));
}

export function subscribeToEntries(leagueId, onChange) {
  const channel = supabase
    .channel(`pool-entries-${leagueId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "pool_entries", filter: `league_id=eq.${leagueId}` },
      onChange,
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

export function subscribeToPicks(leagueId, onChange) {
  const channel = supabase
    .channel(`pool-picks-${leagueId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "pool_picks", filter: `league_id=eq.${leagueId}` },
      onChange,
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// Upserts the entry row (leaving `paid` alone if it already exists) plus all nine picks in one call.
// `week`/`memberDbId`/`picksByQuestion` values are all in owner-id space except memberDbId, which
// the caller already resolves via dbIdByOwnerId (matching insertBet's convention in betsApi.js).
export async function submitPicks(leagueId, week, memberDbId, picksByQuestionDbId) {
  const { error: entryError } = await supabase
    .from("pool_entries")
    .upsert({ league_id: leagueId, week, member_id: memberDbId }, { onConflict: "league_id,week,member_id" });
  if (entryError) throw entryError;

  const rows = Object.entries(picksByQuestionDbId).map(([questionKey, pickMemberDbId]) => ({
    league_id: leagueId,
    week,
    member_id: memberDbId,
    question_key: questionKey,
    pick_member_id: pickMemberDbId,
    updated_at: new Date().toISOString(),
  }));
  const { error: picksError } = await supabase
    .from("pool_picks")
    .upsert(rows, { onConflict: "league_id,week,member_id,question_key" });
  if (picksError) throw picksError;
}

export async function setPaid(entryId, paid) {
  const { error } = await supabase.from("pool_entries").update({ paid }).eq("id", entryId);
  if (error) throw error;
}
