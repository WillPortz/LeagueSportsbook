-- SideLines — Supabase schema
-- Run this whole file once in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).

create extension if not exists pgcrypto;

-- ============ leagues ============
create table if not exists leagues (
  id uuid primary key default gen_random_uuid(),
  sleeper_league_id text not null unique,
  name text not null default 'Your League',
  season int not null default extract(year from now())::int,
  nfl_season_type text not null default 'regular',
  scoring_field text not null default 'pts_ppr',
  scoring_label text not null default 'PPR',
  projection_season int not null default extract(year from now())::int,
  current_week int not null default 1,
  ticket_seq int not null default 1000,   -- next ticket number = ticket_seq + 1 (mirrors old TICKET_SEQ=1001)
  pool_entry_fee numeric not null default 5,
  survivor_entry_fee numeric not null default 5,
  -- created_by: immutable record of who originally connected this league. owner_id: the
  -- current commissioner/billing owner — starts the same as created_by but is meant to be
  -- reassignable later (transfer-ownership UI doesn't exist yet, but the column does).
  -- Both default to auth.uid() so a normal insert (via upsertLeague's INSERT branch) sets them
  -- for free; neither is ever included in the app's routine upsert payloads, so later
  -- refreshLeague/connectLeague calls from any member never touch them again.
  created_by uuid references auth.users(id) default auth.uid(),
  owner_id uuid references auth.users(id) default auth.uid(),
  -- subscription_status: per-league plan/billing state. One owner's payment (once that's
  -- built) unlocks the whole league. No enum constraint on purpose: the real payment
  -- integration will likely need states like 'trialing'/'past_due'/'canceled' that aren't
  -- worth guessing at yet.
  subscription_status text not null default 'active',
  created_at timestamptz not null default now()
);

-- ============ members (one row per Sleeper roster/owner in a league) ============
create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  sleeper_owner_id text not null,
  roster_id text not null,
  display_name text,
  team_name text,
  name text not null,               -- team_name || displayName, computed client-side by buildMembers()
  season_pts numeric not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  games_played int not null default 0,
  starters jsonb not null default '[]'::jsonb,
  user_id uuid references auth.users(id),   -- null until claimed
  created_at timestamptz not null default now(),
  unique (league_id, sleeper_owner_id)
);

-- one auth user can claim at most one member slot per league (future multi-league friendly)
create unique index if not exists members_league_user_unique
  on members (league_id, user_id) where user_id is not null;

-- ============ bets ============
create table if not exists bets (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  ticket int,
  type text not null check (type in ('matchup','prop','season','proposition')),
  title text not null,
  creator uuid not null references members(id),
  opponent uuid references members(id),   -- null = open, anyone in the league may accept
  stake numeric not null check (stake > 0),
  status text not null default 'pending'
    check (status in ('pending','accepted','declined','cancelled','locked','settled','void')),
  result text check (result in ('creator','opponent')),
  week int,
  odds int,
  to_win numeric,
  board_line_id text,
  board_kind text,
  player_id text,
  player_id_a text,
  player_id_b text,
  line numeric,
  creator_side text check (creator_side in ('over','under')),
  subject_id uuid references members(id),
  pick_member_id uuid references members(id),
  matchup_peer_id uuid references members(id),
  pick_player_id text,
  owner_id uuid references members(id),   -- bet.ownerId, used by player_ou offerings
  actual numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (creator <> opponent)
);

create index if not exists bets_league_idx   on bets (league_id);
create index if not exists bets_creator_idx  on bets (creator);
create index if not exists bets_opponent_idx on bets (opponent);

-- ============ weekly league pool ============
-- One shared, whole-league trivia pool per week: everyone answers the same nine questions
-- about that week's actual fantasy results; grading happens client-side from data already
-- fetched (weekCache), so these tables only need to hold picks and who's paid in.
create table if not exists pool_entries (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  week int not null,
  member_id uuid not null references members(id),
  paid boolean not null default false,
  created_at timestamptz not null default now(),
  unique (league_id, week, member_id)
);

create table if not exists pool_picks (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  week int not null,
  member_id uuid not null references members(id),       -- whose pick this is
  question_key text not null,
  pick_member_id uuid not null references members(id),  -- who they picked
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (league_id, week, member_id, question_key)
);

create index if not exists pool_entries_league_week_idx on pool_entries (league_id, week);
create index if not exists pool_picks_league_week_idx   on pool_picks (league_id, week);

-- ============ survivor pool ============
-- One pick a week, whole season: pick a manager you think wins their real Sleeper matchup.
-- Wrong once and you're out for good — elimination status is computed client-side from these
-- picks plus the same actual-results data the bets/board grading already uses, not stored here.
create table if not exists survivor_entries (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  member_id uuid not null references members(id),
  paid boolean not null default false,
  created_at timestamptz not null default now(),
  unique (league_id, member_id)
);

create table if not exists survivor_picks (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  week int not null,
  member_id uuid not null references members(id),       -- whose pick this is
  pick_member_id uuid not null references members(id),  -- who they picked to win
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (league_id, week, member_id),          -- one pick per person per week
  unique (league_id, member_id, pick_member_id) -- can't reuse the same manager across the season
);

create index if not exists survivor_picks_league_week_idx on survivor_picks (league_id, week);

-- ============ atomic per-league ticket numbering (replaces client ticketSeq state) ============
create or replace function assign_bet_ticket() returns trigger as $$
declare next_ticket int;
begin
  if NEW.ticket is not null then return NEW; end if;
  update leagues set ticket_seq = ticket_seq + 1 where id = NEW.league_id
    returning ticket_seq into next_ticket;
  NEW.ticket := next_ticket;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists bets_assign_ticket on bets;
create trigger bets_assign_ticket
  before insert on bets
  for each row execute function assign_bet_ticket();

-- ============ claim invariant: one-shot, self-only ============
create or replace function enforce_member_claim() returns trigger as $$
begin
  if OLD.user_id is not null and NEW.user_id is distinct from OLD.user_id then
    raise exception 'This manager slot is already claimed.';
  end if;
  if NEW.user_id is not null and NEW.user_id is distinct from OLD.user_id
     and NEW.user_id <> auth.uid() then
    raise exception 'You can only claim a manager slot for yourself.';
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists members_claim_guard on members;
create trigger members_claim_guard
  before update on members
  for each row execute function enforce_member_claim();

-- ============ bet lifecycle invariant ============
-- opponent is null until someone accepts an open bet — any league member (other than the
-- creator) may claim it for themselves; a bet that already has a set opponent (legacy rows
-- from before open bets, or already-claimed rows) keeps the original opponent-only rules.
create or replace function enforce_bet_transition() returns trigger as $$
declare
  my_member_ids uuid[];
  is_creator boolean;
  is_opponent boolean;
  is_open boolean;
  is_league_member boolean;
begin
  if NEW.league_id <> OLD.league_id or NEW.creator <> OLD.creator
     or NEW.type <> OLD.type or NEW.stake <> OLD.stake then
    raise exception 'These fields cannot be changed after a bet is placed.';
  end if;
  if OLD.opponent is not null and NEW.opponent is distinct from OLD.opponent then
    raise exception 'This bet''s opponent cannot be changed once set.';
  end if;

  select array_agg(id) into my_member_ids
    from members where user_id = auth.uid() and league_id = NEW.league_id;

  is_creator       := OLD.creator  = any(my_member_ids);
  is_opponent      := OLD.opponent is not null and OLD.opponent = any(my_member_ids);
  is_open          := OLD.opponent is null and OLD.status = 'pending';
  is_league_member := coalesce(array_length(my_member_ids, 1), 0) > 0;

  -- voiding (player never plays / projects to 0) is a system correction, not a party decision —
  -- any claimed member of the league may trigger it, whichever browser happens to notice first
  if not (is_creator or is_opponent or is_open or (NEW.status = 'void' and is_league_member)) then
    raise exception 'You are not a party to this bet.';
  end if;

  if OLD.status = 'settled' then
    raise exception 'This bet is already settled.';
  end if;

  if OLD.status = NEW.status and NEW.opponent is not distinct from OLD.opponent then
    NEW.updated_at := now();
    return NEW;
  end if;

  if OLD.status = 'pending' and NEW.status = 'accepted' and OLD.opponent is null then
    if is_creator then
      raise exception 'You cannot accept your own bet.';
    end if;
    if NEW.opponent is null or not (NEW.opponent = any(my_member_ids)) then
      raise exception 'You can only accept a bet for your own claimed manager.';
    end if;
  elsif OLD.status = 'pending' and NEW.status in ('accepted','declined') then
    if not is_opponent then
      raise exception 'Only the opponent can accept or decline a pending bet.';
    end if;
  elsif OLD.status = 'pending' and NEW.status = 'cancelled' then
    if not is_creator then
      raise exception 'Only the creator can cancel a pending bet.';
    end if;
  elsif OLD.status = 'accepted' and NEW.status = 'locked' then
    null; -- either party may lock
  elsif OLD.status = 'locked' and NEW.status = 'settled' then
    if NEW.result is null then
      raise exception 'A result is required to settle a bet.';
    end if;
  elsif OLD.status in ('pending', 'accepted', 'locked') and NEW.status = 'void' then
    null; -- any league member may void once a player in the bet projects to 0 / never plays
  else
    raise exception 'Invalid bet status transition from % to %.', OLD.status, NEW.status;
  end if;

  NEW.updated_at := now();
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists bets_transition_guard on bets;
create trigger bets_transition_guard
  before update on bets
  for each row execute function enforce_bet_transition();

-- ============ RLS ============
alter table leagues      enable row level security;
alter table members      enable row level security;
alter table bets         enable row level security;
alter table pool_entries     enable row level security;
alter table pool_picks       enable row level security;
alter table survivor_entries enable row level security;
alter table survivor_picks   enable row level security;

drop policy if exists leagues_select on leagues;
drop policy if exists leagues_insert on leagues;
drop policy if exists leagues_update on leagues;
drop policy if exists leagues_delete on leagues;
create policy leagues_select on leagues for select using (auth.uid() is not null);
create policy leagues_insert on leagues for insert with check (auth.uid() is not null);
create policy leagues_update on leagues for update using (auth.uid() is not null);
-- deleting a league cascades to every member/bet/pool/survivor row in it (see the on delete
-- cascade foreign keys above) — restricted to the owner, unlike select/update which stay open
-- to any signed-in member, since this destroys shared data for everyone in the league.
create policy leagues_delete on leagues for delete using (owner_id = auth.uid());

drop policy if exists members_select on members;
drop policy if exists members_insert on members;
drop policy if exists members_update on members;
create policy members_select on members for select using (auth.uid() is not null);
create policy members_insert on members for insert with check (auth.uid() is not null);
create policy members_update on members for update
  using (auth.uid() is not null) with check (auth.uid() is not null);

drop policy if exists bets_select on bets;
drop policy if exists bets_insert on bets;
drop policy if exists bets_update on bets;

-- bets: visible only to signed-in users who are claimed members of that league
create policy bets_select on bets for select using (
  exists (select 1 from members m where m.league_id = bets.league_id and m.user_id = auth.uid())
);

-- a bet may only be created by its creator; opponent is either null (open, anyone may accept)
-- or a real member of the league
create policy bets_insert on bets for insert with check (
  exists (select 1 from members m  where m.id = bets.creator  and m.user_id = auth.uid() and m.league_id = bets.league_id)
  and
  (bets.opponent is null or exists (select 1 from members m2 where m2.id = bets.opponent and m2.league_id = bets.league_id))
);

-- the two parties to a bet may always update it; any other claimed member of the same league
-- may also update an open pending bet (to claim/accept it) — exact transition rules live in
-- the trigger above
create policy bets_update on bets for update using (
  exists (
    select 1 from members m
    where m.user_id = auth.uid() and m.league_id = bets.league_id
      and (m.id = bets.creator or m.id = bets.opponent or (bets.opponent is null and bets.status = 'pending'))
  )
);

drop policy if exists pool_entries_select on pool_entries;
drop policy if exists pool_entries_insert on pool_entries;
drop policy if exists pool_entries_update on pool_entries;
drop policy if exists pool_picks_select   on pool_picks;
drop policy if exists pool_picks_insert   on pool_picks;
drop policy if exists pool_picks_update   on pool_picks;

-- pool entries/picks: visible to any claimed member of the league (same as bets — nothing in
-- this app hides data at the RLS layer, only who's allowed to write); writes are restricted to
-- your own member row, since a pool pick has no lifecycle to enforce beyond "it's yours."
create policy pool_entries_select on pool_entries for select using (
  exists (select 1 from members m where m.league_id = pool_entries.league_id and m.user_id = auth.uid())
);
create policy pool_entries_insert on pool_entries for insert with check (
  exists (select 1 from members m where m.id = pool_entries.member_id and m.user_id = auth.uid() and m.league_id = pool_entries.league_id)
);
create policy pool_entries_update on pool_entries for update using (
  exists (select 1 from members m where m.id = pool_entries.member_id and m.user_id = auth.uid())
);

create policy pool_picks_select on pool_picks for select using (
  exists (select 1 from members m where m.league_id = pool_picks.league_id and m.user_id = auth.uid())
);
create policy pool_picks_insert on pool_picks for insert with check (
  exists (select 1 from members m  where m.id = pool_picks.member_id      and m.user_id = auth.uid() and m.league_id = pool_picks.league_id)
  and exists (select 1 from members m2 where m2.id = pool_picks.pick_member_id and m2.league_id = pool_picks.league_id)
);
create policy pool_picks_update on pool_picks for update using (
  exists (select 1 from members m where m.id = pool_picks.member_id and m.user_id = auth.uid())
);

drop policy if exists survivor_entries_select on survivor_entries;
drop policy if exists survivor_entries_insert on survivor_entries;
drop policy if exists survivor_entries_update on survivor_entries;
drop policy if exists survivor_picks_select   on survivor_picks;
drop policy if exists survivor_picks_insert   on survivor_picks;
drop policy if exists survivor_picks_update   on survivor_picks;

create policy survivor_entries_select on survivor_entries for select using (
  exists (select 1 from members m where m.league_id = survivor_entries.league_id and m.user_id = auth.uid())
);
create policy survivor_entries_insert on survivor_entries for insert with check (
  exists (select 1 from members m where m.id = survivor_entries.member_id and m.user_id = auth.uid() and m.league_id = survivor_entries.league_id)
);
create policy survivor_entries_update on survivor_entries for update using (
  exists (select 1 from members m where m.id = survivor_entries.member_id and m.user_id = auth.uid())
);

create policy survivor_picks_select on survivor_picks for select using (
  exists (select 1 from members m where m.league_id = survivor_picks.league_id and m.user_id = auth.uid())
);
create policy survivor_picks_insert on survivor_picks for insert with check (
  exists (select 1 from members m  where m.id = survivor_picks.member_id      and m.user_id = auth.uid() and m.league_id = survivor_picks.league_id)
  and exists (select 1 from members m2 where m2.id = survivor_picks.pick_member_id and m2.league_id = survivor_picks.league_id)
);
create policy survivor_picks_update on survivor_picks for update using (
  exists (select 1 from members m where m.id = survivor_picks.member_id and m.user_id = auth.uid())
);

-- ============ enable realtime ============
alter publication supabase_realtime add table bets, members, pool_entries, pool_picks, survivor_entries, survivor_picks;
