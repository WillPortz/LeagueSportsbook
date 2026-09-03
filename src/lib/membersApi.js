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

// Shared by both providers — the members table's sleeper_owner_id/roster_id columns hold ESPN's
// team-id equivalents too (see the comment above the table in schema.sql), so there's exactly
// one upsert implementation regardless of which provider built `builtMembers`.
async function syncMembers(leagueId, builtMembers) {
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

export function syncMembersFromSleeper(leagueId, builtMembers) {
  return syncMembers(leagueId, builtMembers);
}

export function syncMembersFromEspn(leagueId, builtMembers) {
  return syncMembers(leagueId, builtMembers);
}

export async function fetchMembers(leagueId) {
  const { data, error } = await supabase.from("members").select("*").eq("league_id", leagueId);
  if (error) throw error;
  return data.map(dbRowToMember);
}

// Finds every league (if any) this account has already claimed a manager slot in, so the app
// can skip straight past "Link Your League" on repeat visits and offer a switcher when there's
// more than one. The partial unique index in supabase/schema.sql (league_id, user_id) only
// stops claiming two slots in the *same* league — nothing stops one account from having claimed
// rows across many leagues, so this can safely return more than one row.
export async function findMyMemberships(userId) {
  const { data, error } = await supabase
    .from("members")
    .select("*, leagues(*)")
    .eq("user_id", userId);
  if (error) throw error;
  return data || [];
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
