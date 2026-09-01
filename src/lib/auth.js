import { supabase } from "./supabase.js";

export const signUp = (email, password) => supabase.auth.signUp({ email, password });
export const signIn = (email, password) => supabase.auth.signInWithPassword({ email, password });
export const signOut = () => supabase.auth.signOut();

export const onAuthChange = (cb) =>
  supabase.auth.onAuthStateChange((_event, session) => cb(session));

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// Remembers which league to open next time, on the account itself (auth user_metadata) rather
// than the browser, so it follows the user across devices. Best-effort — callers fire this off
// without awaiting/blocking on it.
export const updateLastActiveLeague = (leagueDbId) =>
  supabase.auth.updateUser({ data: { last_active_league_id: leagueDbId } });
