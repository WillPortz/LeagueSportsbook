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
