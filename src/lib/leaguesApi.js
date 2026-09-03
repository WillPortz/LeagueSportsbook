import { supabase } from "./supabase.js";

export async function upsertLeague(sleeperLeagueId, fields) {
  const { data, error } = await supabase
    .from("leagues")
    .upsert({ sleeper_league_id: sleeperLeagueId, ...fields }, { onConflict: "sleeper_league_id" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Permanently deletes the league and, via schema.sql's on-delete-cascade foreign keys, every
// member, bet, pool/survivor entry and pick tied to it — for every manager in the league, not
// just the caller. RLS (leagues_delete) restricts this to the league's owner_id; PostgREST
// doesn't turn an RLS-blocked delete into an error by itself (it just matches zero rows), so
// this chains .select() and throws explicitly when nothing came back — a non-owner (or a
// leagueId that's already gone) gets a clear failure instead of a silent no-op.
export async function deleteLeague(leagueId) {
  const { data, error } = await supabase.from("leagues").delete().eq("id", leagueId).select();
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error("Couldn't delete that league — you may not be its owner.");
  }
}
