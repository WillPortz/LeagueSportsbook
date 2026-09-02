import { supabase } from "./supabase.js";

function ownerId(dbId, ownerIdByDbId) {
  if (!dbId) return null;
  return ownerIdByDbId[dbId] ?? null;
}

export function dbRowToEntry(row, ownerIdByDbId) {
  return {
    id: row.id,
    memberId: ownerId(row.member_id, ownerIdByDbId),
    paid: row.paid,
  };
}

export function dbRowToPick(row, ownerIdByDbId) {
  return {
    id: row.id,
    week: row.week,
    memberId: ownerId(row.member_id, ownerIdByDbId),
    pickMemberId: ownerId(row.pick_member_id, ownerIdByDbId),
  };
}

export async function fetchEntries(leagueId, ownerIdByDbId) {
  const { data, error } = await supabase.from("survivor_entries").select("*").eq("league_id", leagueId);
  if (error) throw error;
  return data.map((r) => dbRowToEntry(r, ownerIdByDbId));
}

export async function fetchPicks(leagueId, ownerIdByDbId) {
  const { data, error } = await supabase.from("survivor_picks").select("*").eq("league_id", leagueId);
  if (error) throw error;
  return data.map((r) => dbRowToPick(r, ownerIdByDbId));
}

export function subscribeToEntries(leagueId, onChange) {
  const channel = supabase
    .channel(`survivor-entries-${leagueId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "survivor_entries", filter: `league_id=eq.${leagueId}` },
      onChange,
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

export function subscribeToPicks(leagueId, onChange) {
  const channel = supabase
    .channel(`survivor-picks-${leagueId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "survivor_picks", filter: `league_id=eq.${leagueId}` },
      onChange,
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// Upserts the entry row (leaving `paid` alone if it already exists) plus this week's pick.
// `pickMemberDbId` is the manager they're betting will win their real Sleeper matchup that week.
export async function submitPick(leagueId, week, memberDbId, pickMemberDbId) {
  const { error: entryError } = await supabase
    .from("survivor_entries")
    .upsert({ league_id: leagueId, member_id: memberDbId }, { onConflict: "league_id,member_id" });
  if (entryError) throw entryError;

  const { error: pickError } = await supabase
    .from("survivor_picks")
    .upsert(
      { league_id: leagueId, week, member_id: memberDbId, pick_member_id: pickMemberDbId, updated_at: new Date().toISOString() },
      { onConflict: "league_id,week,member_id" },
    );
  if (pickError) throw pickError;
}

export async function setPaid(entryId, paid) {
  const { error } = await supabase.from("survivor_entries").update({ paid }).eq("id", entryId);
  if (error) throw error;
}
