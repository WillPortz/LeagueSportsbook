// Proxies ESPN Fantasy Football's private-league API. Browsers can't attach espn_s2/SWID
// cookies to a cross-origin fetch, and ESPN sends no CORS headers for third-party origins
// anyway, so this Edge Function is the only place those cookies ever get used. It's also the
// only code path that can decrypt them, via the espn_cred_get/espn_cred_upsert SQL functions
// (schema.sql), which are revoked from every role but service_role.
//
// Deploy: supabase functions deploy espn-proxy
// Requires one secret beyond the ambient SUPABASE_* vars Supabase injects automatically:
//   supabase secrets set ESPN_CRED_ENC_KEY=<random 32+ byte value>

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const ALLOWED_ORIGINS = new Set([
  "https://league-sportsbook.vercel.app",
  "http://localhost:5173",
]);

// ESPN's fantasy API is known to reject requests with no User-Agent.
const ESPN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function corsHeaders(origin: string | null) {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// Users copy this from devtools; it's sometimes copied with the surrounding curly braces and
// sometimes without, so normalize rather than reject a technically-valid value.
function normalizeSwid(swid: string) {
  const trimmed = swid.trim();
  return trimmed.startsWith("{") ? trimmed : `{${trimmed}}`;
}

async function fetchEspn(
  leaguePath: string,
  params: Record<string, string | string[]>,
  creds?: { espn_s2: string; swid: string },
) {
  const url = new URL(`https://fantasy.espn.com/apis/v3/games/ffl/${leaguePath}`);
  for (const [key, val] of Object.entries(params)) {
    if (Array.isArray(val)) {
      val.forEach((v) => url.searchParams.append(key, v));
    } else {
      url.searchParams.set(key, val);
    }
  }
  // A server-to-server request with a bare User-Agent is missing everything else a real browser
  // always sends — ESPN's edge (likely a WAF/CDN layer, not the application itself) appears to
  // soft-block those even with valid cookies attached (200/202 with an empty body instead of
  // real data or a clean 401/403). Rounding these out to look like an actual browser request.
  const headers: Record<string, string> = {
    "User-Agent": ESPN_UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://fantasy.espn.com/",
    Origin: "https://fantasy.espn.com",
    "x-fantasy-source": "kona",
    "x-fantasy-platform": "kona-PROD-1dc40132dc2070ef47881dc95b633e62cebc9913",
    "x-fantasy-filter": '{"filterActive":null}',
  };
  if (creds) {
    // A stray newline or trailing space from copy-pasting the cookie value breaks the request
    // silently (no error, ESPN just doesn't recognize it) — trim defensively.
    headers["Cookie"] = `espn_s2=${creds.espn_s2.trim()}; SWID=${normalizeSwid(creds.swid)}`;
  }
  return fetch(url.toString(), { headers });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json({ error: "invalid_request" }, 400, origin);
  }

  // TEMPORARY diagnostic, unauthenticated on purpose — hits a neutral echo endpoint with the
  // same Cookie-header construction used against ESPN, to isolate "Deno's fetch silently drops
  // Cookie" from "ESPN/Cloudflare specifically is rejecting this." Remove once the ESPN 202
  // issue is solved; touches no user data or secrets.
  try {
    const peekBody = await req.clone().json();
    if (peekBody?.mode === "debug_echo") {
      const echoRes = await fetch("https://httpbin.org/headers", {
        headers: { "User-Agent": ESPN_UA, Cookie: "espn_s2=debugtest; SWID={DEBUG-TEST}" },
      });
      const echoData = await echoRes.json();
      return json({ echoStatus: echoRes.status, echoHeaders: echoData.headers }, 200, origin);
    }
    // Hits ESPN directly with no cookies at all, from Supabase's actual edge network — tells us
    // whether the 202-empty-body treatment is specific to authenticated/cookie requests or
    // applies to every request from this network regardless of auth.
    if (peekBody?.mode === "debug_espn_raw") {
      const testLeagueId = peekBody.espnLeagueId || "1";
      const testSeason = peekBody.season || 2024;
      const espnRes = await fetchEspn(
        `seasons/${testSeason}/segments/0/leagues/${testLeagueId}`,
        { view: ["mTeam"] },
      );
      const rawText = await espnRes.text();
      return json({
        status: espnRes.status,
        bodyLength: rawText.length,
        bodyPreview: rawText.slice(0, 300),
        responseHeaders: Object.fromEntries(espnRes.headers.entries()),
      }, 200, origin);
    }
  } catch {
    // not JSON / no mode field — fall through to normal handling below
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ENC_KEY = Deno.env.get("ESPN_CRED_ENC_KEY");
  if (!ENC_KEY) {
    return json({ error: "server_misconfigured" }, 500, origin);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "invalid_request" }, 400, origin);
  }

  // Verify the caller's JWT — let supabase-js's getUser() do the verification, no hand-rolled
  // decoding here.
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: "invalid_request" }, 401, origin);
  }
  const uid = userData.user.id;

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_request" }, 400, origin);
  }

  async function assertMember(leagueId: string) {
    const { data, error } = await serviceClient
      .from("members")
      .select("id")
      .eq("league_id", leagueId)
      .eq("user_id", uid)
      .limit(1);
    return !error && !!data && data.length > 0;
  }

  try {
    const mode = body?.mode;

    if (mode === "link") {
      const espnLeagueId = body.espnLeagueId as string | undefined;
      const season = body.season as number | undefined;
      const league_id = body.league_id as string | undefined;
      const espn_s2 = body.espn_s2 as string | undefined;
      const swid = body.swid as string | undefined;
      if (!espnLeagueId || !season) return json({ error: "invalid_request" }, 400, origin);

      // First-time linking has no league_id yet (nothing to check membership against, and
      // nothing stored to fall back to). A refresh of an already-linked league passes league_id
      // so an already-connected private league doesn't need espn_s2/SWID re-entered every time —
      // credsSource distinguishes "you just typed these" from "these were already on file" so
      // a rejection maps to the right error code (retype vs reconnect) below.
      let credsSource: "body" | "stored" | "none" = "none";
      let creds: { espn_s2: string; swid: string } | undefined;
      if (espn_s2 && swid) {
        creds = { espn_s2, swid };
        credsSource = "body";
      } else if (league_id) {
        if (!(await assertMember(league_id))) return json({ error: "not_a_member" }, 403, origin);
        const { data: credRows } = await serviceClient.rpc("espn_cred_get", { p_league_id: league_id, p_key: ENC_KEY });
        const stored = credRows && credRows.length > 0 ? credRows[0] : null;
        if (stored) {
          creds = { espn_s2: stored.espn_s2, swid: stored.swid };
          credsSource = "stored";
        }
      }

      const res = await fetchEspn(
        `seasons/${season}/segments/0/leagues/${espnLeagueId}`,
        { view: ["mTeam", "mRoster", "mSettings"] },
        creds,
      );

      const errorByCredsSource = {
        none: "espn_auth_required",
        body: "espn_invalid_credentials",
        stored: "espn_reconnect_required",
      } as const;

      if (res.status === 401 || res.status === 403) {
        console.log(`espn link: ESPN returned ${res.status} (credsSource=${credsSource})`);
        return json({ error: errorByCredsSource[credsSource] }, 401, origin);
      }
      if (!res.ok) {
        return json({ error: "espn_fetch_failed", status: res.status }, 502, origin);
      }
      // ESPN sometimes returns 200 with an empty (or non-JSON) body for a private league
      // instead of a proper 401/403 — treat that the same as an auth rejection rather than
      // crashing trying to parse nothing as JSON.
      // deno-lint-ignore no-explicit-any
      let data: any = null;
      try {
        const raw = await res.text();
        console.log(`espn link: status=${res.status} bodyLength=${raw.length} credsSource=${credsSource}`);
        data = raw ? JSON.parse(raw) : null;
      } catch (parseErr) {
        console.log(`espn link: body parse failed — ${parseErr}`);
        data = null;
      }
      if (!data || !Array.isArray(data.teams)) {
        console.log(`espn link: no usable teams array (credsSource=${credsSource}) — treating as ${errorByCredsSource[credsSource]}`);
        return json({ error: errorByCredsSource[credsSource] }, 401, origin);
      }
      return json({ teams: data.teams ?? [], settings: data.settings ?? {}, status: data.status ?? {} }, 200, origin);
    }

    if (mode === "set_credentials") {
      const league_id = body.league_id as string | undefined;
      const espn_s2 = body.espn_s2 as string | undefined;
      const swid = body.swid as string | undefined;
      if (!league_id || !espn_s2 || !swid) return json({ error: "invalid_request" }, 400, origin);
      if (!(await assertMember(league_id))) return json({ error: "not_a_member" }, 403, origin);

      const { error } = await serviceClient.rpc("espn_cred_upsert", {
        p_league_id: league_id,
        p_s2: espn_s2,
        p_swid: swid,
        p_key: ENC_KEY,
        p_uid: uid,
      });
      if (error) return json({ error: "server_error" }, 500, origin);
      return json({ ok: true }, 200, origin);
    }

    if (mode === "week") {
      const league_id = body.league_id as string | undefined;
      const espnLeagueId = body.espnLeagueId as string | undefined;
      const season = body.season as number | undefined;
      const week = body.week as number | undefined;
      if (!league_id || !espnLeagueId || !season || !week) return json({ error: "invalid_request" }, 400, origin);
      if (!(await assertMember(league_id))) return json({ error: "not_a_member" }, 403, origin);

      const { data: credRows } = await serviceClient.rpc("espn_cred_get", {
        p_league_id: league_id,
        p_key: ENC_KEY,
      });
      const stored = credRows && credRows.length > 0 ? credRows[0] : null;
      const creds = stored ? { espn_s2: stored.espn_s2, swid: stored.swid } : undefined;

      const res = await fetchEspn(
        `seasons/${season}/segments/0/leagues/${espnLeagueId}`,
        { view: ["mMatchupScore", "mBoxscore"], scoringPeriodId: String(week) },
        creds,
      );

      if (res.status === 401 || res.status === 403) {
        return json({ error: stored ? "espn_reconnect_required" : "espn_auth_required" }, 401, origin);
      }
      if (!res.ok) {
        return json({ error: "espn_fetch_failed", status: res.status }, 502, origin);
      }
      // ESPN sometimes returns 200 with an empty (or non-JSON) body for a private league
      // instead of a proper 401/403 — treat that the same as an auth rejection rather than
      // crashing trying to parse nothing as JSON.
      // deno-lint-ignore no-explicit-any
      let data: any = null;
      try {
        const raw = await res.text();
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = null;
      }
      if (!data || !Array.isArray(data.schedule)) {
        return json({ error: stored ? "espn_reconnect_required" : "espn_auth_required" }, 401, origin);
      }
      // mMatchupScore returns the whole season's schedule, not just the requested week — trim
      // it down here rather than shipping every week over the wire on every poll.
      const schedule = data.schedule.filter((m: { matchupPeriodId?: number }) => m.matchupPeriodId === week);
      return json({ schedule, week, season }, 200, origin);
    }

    return json({ error: "invalid_request" }, 400, origin);
  } catch (err) {
    console.error(err);
    return json({ error: "espn_fetch_failed" }, 502, origin);
  }
});
