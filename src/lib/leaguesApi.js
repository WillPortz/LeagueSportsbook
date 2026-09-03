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

// Separate from upsertLeague rather than a shared function with a provider branch: the conflict
// target differs (ESPN reuses the same numeric league id across seasons, so the unique key is
// the pair, not the id alone) and there's no shared logic worth factoring out of a one-line upsert.
export async function upsertEspnLeague(espnLeagueId, season, fields) {
  const { data, error } = await supabase
    .from("leagues")
    .upsert(
      { espn_league_id: espnLeagueId, season, provider: "espn", ...fields },
      { onConflict: "espn_league_id,season" },
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}
