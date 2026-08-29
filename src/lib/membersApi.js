import { supabase } from "./supabase.js";

export function dbRowToMember(row) {
  return {
    id: row.sleeper_owner_id,
    dbId: row.id,
    userId: row.user_id,
    rosterId: row.roster_id,
    name: row.name,
    displayName: row.display_name,
    teamName: row.team_name,
    seasonPts: Number(row.season_pts) || 0,
    wins: row.wins,
    losses: row.losses,
    gamesPlayed: row.games_played,
    starters: row.starters || [],
  };
}

export async function syncMembersFromSleeper(leagueId, builtMembers) {
  const rows = builtMembers.map((m) => ({
    league_id: leagueId,
    sleeper_owner_id: m.id,
    roster_id: m.rosterId,
    display_name: m.displayName,
    team_name: m.teamName,
    name: m.name,
    season_pts: m.seasonPts,
    wins: m.wins,
    losses: m.losses,
    games_played: m.gamesPlayed,
    starters: m.starters,
    // user_id intentionally omitted: an upsert must never clobber an existing claim
  }));
  const { data, error } = await supabase
    .from("members")
    .upsert(rows, { onConflict: "league_id,sleeper_owner_id" })
    .select();
  if (error) throw error;
  return data.map(dbRowToMember);
}

export async function fetchMembers(leagueId) {
  const { data, error } = await supabase.from("members").select("*").eq("league_id", leagueId);
  if (error) throw error;
  return data.map(dbRowToMember);
}

// Finds the league (if any) this account has already claimed a manager slot in,
// so the app can skip straight past "Link Your League" on repeat visits.
// Assumes one league per account for now — multi-league support is schema-ready
// (see the partial unique index in supabase/schema.sql) but not built into the UI yet.
export async function findMyMembership(userId) {
  const { data, error } = await supabase
    .from("members")
    .select("*, leagues(*)")
    .eq("user_id", userId)
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

export async function claimMember(memberDbId, userId) {
  const { data, error } = await supabase
    .from("members")
    .update({ user_id: userId })
    .eq("id", memberDbId)
    .is("user_id", null)
    .select()
    .single();
  if (error) throw error;
  return dbRowToMember(data);
}

export function subscribeToMembers(leagueId, onChange) {
  const channel = supabase
    .channel(`members-${leagueId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "members", filter: `league_id=eq.${leagueId}` },
      onChange,
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}
