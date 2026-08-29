-- League Sportsbook — Supabase schema
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
  created_by uuid references auth.users(id),
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
  opponent uuid not null references members(id),
  stake numeric not null check (stake > 0),
  status text not null default 'pending'
    check (status in ('pending','accepted','declined','locked','settled')),
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
create or replace function enforce_bet_transition() returns trigger as $$
declare
  my_member_ids uuid[];
  is_creator boolean;
  is_opponent boolean;
begin
  if NEW.league_id <> OLD.league_id or NEW.creator <> OLD.creator or NEW.opponent <> OLD.opponent
     or NEW.type <> OLD.type or NEW.stake <> OLD.stake then
    raise exception 'These fields cannot be changed after a bet is placed.';
  end if;

  select array_agg(id) into my_member_ids
    from members where user_id = auth.uid() and league_id = NEW.league_id;

  is_creator  := OLD.creator  = any(my_member_ids);
  is_opponent := OLD.opponent = any(my_member_ids);
  if not (is_creator or is_opponent) then
    raise exception 'You are not a party to this bet.';
  end if;

  if OLD.status = 'settled' then
    raise exception 'This bet is already settled.';
  end if;

  if OLD.status = NEW.status then
    NEW.updated_at := now();
    return NEW;
  end if;

  if OLD.status = 'pending' and NEW.status in ('accepted','declined') then
    if not is_opponent then
      raise exception 'Only the opponent can accept or decline a pending bet.';
    end if;
  elsif OLD.status = 'accepted' and NEW.status = 'locked' then
    null; -- either party may lock
  elsif OLD.status = 'locked' and NEW.status = 'settled' then
    if NEW.result is null then
      raise exception 'A result is required to settle a bet.';
    end if;
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
alter table leagues enable row level security;
alter table members enable row level security;
alter table bets    enable row level security;

drop policy if exists leagues_select on leagues;
drop policy if exists leagues_insert on leagues;
drop policy if exists leagues_update on leagues;
create policy leagues_select on leagues for select using (auth.uid() is not null);
create policy leagues_insert on leagues for insert with check (auth.uid() is not null);
create policy leagues_update on leagues for update using (auth.uid() is not null);

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

-- a bet may only be created by its creator, and the opponent must be a real member of the league
create policy bets_insert on bets for insert with check (
  exists (select 1 from members m  where m.id = bets.creator  and m.user_id = auth.uid() and m.league_id = bets.league_id)
  and
  exists (select 1 from members m2 where m2.id = bets.opponent and m2.league_id = bets.league_id)
);

-- only the two parties to a bet may update it at all; exact transition rules live in the trigger above
create policy bets_update on bets for update using (
  exists (
    select 1 from members m
    where m.user_id = auth.uid() and m.league_id = bets.league_id
      and (m.id = bets.creator or m.id = bets.opponent)
  )
);

-- ============ enable realtime ============
alter publication supabase_realtime add table bets, members;
