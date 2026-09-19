-- ============================================================================
-- Lobbyist ↔ donor attribution.
--
-- A fundraising plan is worked lobbyist by lobbyist: "Amanda Dalton — ask the
-- Grocery PAC for $1,100, Foresight for $1,000". ORESTAR never says who
-- lobbies for a donor, so the link is assembled from three sources and a
-- human confirms it:
--
--   1. Capitol Club (oregoncapitolclub.org) — each lobbyist's contact card and
--      the clients they list. Scraped by scraper/fetch_capitol_club.py.
--   2. ORESTAR "Persons Associated with Committee" — the treasurer,
--      correspondence recipient and directors of each donor committee.
--      Scraped by scraper/fetch_committee_persons.py. An exact email/name hit
--      (Sean Kolmer runs the Oregon Hospital PAC) or a shared private email
--      domain (@seiu503.org) ties a committee to a lobbyist.
--   3. Name matching of every non-individual donor since 2021 against the
--      Capitol Club client names ("The Kroger Co." ↔ "Kroger").
--
-- Two link tables, because the two facts age differently:
--   donor_client_links   — "this donor IS this client". Durable: survives the
--                          client changing lobbyists.
--   donor_lobbyist_links — direct "this lobbyist handles this donor"
--                          (committee contacts, the fundraising tracker,
--                          manual entries), and per-pair rejections.
-- donor_lobbyists (view) joins them: client links fan out to every lobbyist
-- currently listing that client, and a direct 'rejected' row vetoes a pair.
--
-- status: 'suggested' (machine) → 'confirmed' | 'rejected' (human). The
-- matcher never overwrites a human decision.
--
-- Lobbyist phone numbers and addresses are published by Capitol Club, but the
-- plan built on top of them is not public: every table here is readable only
-- when signed in, and writable only by admins/reviewers (or the service role).
-- ============================================================================

create table if not exists lobbyists (
  lobbyist_id      bigint generated always as identity primary key,
  kind             text not null default 'person',   -- 'person' | 'firm'
  name             text not null,                     -- "Sean Kolmer" / "Tonkon Torp"
  first_name       text,
  last_name        text,
  affiliation      text,          -- Capitol Club's first address line: "SVP, CFM Advocates"
  firm             text,
  email            text,
  phone            text,
  phone_alt        text,
  address          text,
  city             text,
  state            text,
  zip              text,
  category         text,          -- Capitol Club: Association | Independent | Corporate
  preferred_contact text,
  cc_id            text unique,   -- Capitol Club profile element id, e.g. "user-784"
  on_capitol_club  boolean not null default false,
  cc_last_seen     date,
  -- Other spellings used to refer to this lobbyist in the fundraising sheets:
  -- "DALTON, AMANDA", "OXLEY & ASSOCIATES", "PAC WEST".
  aliases          text[] not null default '{}',
  source           text not null default 'manual',   -- 'capitol_club' | 'manual' | 'sheet_2024' | 'tracker'
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint lobbyists_kind_check check (kind in ('person', 'firm'))
);

create index if not exists idx_lobbyists_email on lobbyists (lower(email));
create index if not exists idx_lobbyists_name on lobbyists (lower(name));

create table if not exists lobbyist_clients (
  lobbyist_id  bigint not null references lobbyists(lobbyist_id) on delete cascade,
  client_key   text not null,     -- normalized client name (scraper/lobby_match.norm_org)
  client_name  text not null,
  industries   text[] not null default '{}',
  source       text not null default 'capitol_club',  -- 'capitol_club' | 'sheet_2024' | 'manual'
  -- False once Capitol Club stops listing the pair; kept so the history of who
  -- used to represent a client is still visible to the reviewer.
  active       boolean not null default true,
  last_seen    date,
  primary key (lobbyist_id, client_key, source)
);

create index if not exists idx_lobbyist_clients_key on lobbyist_clients (client_key);

-- One row per person on a committee's Statement of Organization.
create table if not exists committee_persons (
  filer_id        text not null,
  role            text not null,   -- 'treasurer' | 'correspondence' | 'director' | 'candidate'
  seq             int  not null default 0,
  name            text not null,
  address         text,
  phone           text,
  email           text,
  occupation      text,
  employer        text,
  effective_from  text,
  effective_to    text,
  scraped_at      timestamptz not null default now(),
  primary key (filer_id, role, seq)
);

create index if not exists idx_committee_persons_email on committee_persons (lower(email));

-- Which committees have been scraped, including those with nobody listed, so
-- an empty result is an answer rather than a reason to scrape again.
create table if not exists committee_persons_scrapes (
  filer_id        text primary key,
  committee_name  text,
  persons         int not null default 0,
  statement_from  text,
  status          text not null default 'ok',   -- 'ok' | 'not_found'
  scraped_at      timestamptz not null default now()
);

-- The compiled donor list the matcher works from: every non-individual donor
-- that gave since 2021, with each name variant the dashboard shows for it
-- (the Recommend page keys donors by canonical name, not donor_id).
create table if not exists lobby_donor_pool (
  donor_id      text primary key,
  display_name  text not null,
  book_type     text,
  committee_id  text,
  names         text[] not null default '{}',
  address       text,
  city          text,
  state         text,
  total_since_2021 numeric not null default 0,
  gifts         int not null default 0,
  recipients    int not null default 0,
  last_date     date,
  refreshed_at  timestamptz not null default now()
);

create index if not exists idx_lobby_pool_name_trgm on lobby_donor_pool using gin (display_name gin_trgm_ops);
create index if not exists idx_lobby_pool_names on lobby_donor_pool using gin (names);

create table if not exists donor_client_links (
  donor_id     text not null,
  client_key   text not null,
  client_name  text not null,
  method       text not null,       -- 'name_exact' | 'name_fuzzy' | 'committee_contact' | 'reviewed' | 'manual'
  score        numeric,
  evidence     jsonb not null default '[]',
  status       text not null default 'suggested',
  decided_by   text,
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (donor_id, client_key),
  constraint donor_client_links_status_check check (status in ('suggested', 'confirmed', 'rejected'))
);

create index if not exists idx_dcl_client on donor_client_links (client_key);
create index if not exists idx_dcl_status on donor_client_links (status);

create table if not exists donor_lobbyist_links (
  donor_id     text not null,
  lobbyist_id  bigint not null references lobbyists(lobbyist_id) on delete cascade,
  method       text not null,   -- 'email_exact' | 'name_exact' | 'email_domain' | 'director' | 'tracker' | 'sheet_2024' | 'manual'
  score        numeric,
  evidence     jsonb not null default '[]',
  status       text not null default 'suggested',
  is_primary   boolean not null default false,
  decided_by   text,
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (donor_id, lobbyist_id),
  constraint donor_lobbyist_links_status_check check (status in ('suggested', 'confirmed', 'rejected'))
);

create index if not exists idx_dll_lobbyist on donor_lobbyist_links (lobbyist_id);
create index if not exists idx_dll_status on donor_lobbyist_links (status);

-- ── Combined attribution ────────────────────────────────────────────────────
-- One row per (donor, lobbyist). status is the strongest non-rejected status
-- among the paths that reach the pair; any direct rejection vetoes the pair.
--
-- is_primary marks who a plan should list the donor under. A direct link can
-- carry it (the tracker's "Lobbyist 1"). For a donor reached through a
-- client, the client's lead is whoever a confirmed direct link already chose
-- for another donor of that client. A union can appear as two donor records
-- ("United Food and Commercial Workers Union Local 555", "UFCW Local 555");
-- once one is filed under a lobbyist, the other follows rather than landing
-- under whichever of the client's lobbyists sorts first.
create or replace view donor_lobbyists with (security_invoker = true) as
with client_leads as (
  select c.client_key, d.lobbyist_id
  from donor_client_links c
  join donor_lobbyist_links d on d.donor_id = c.donor_id and d.status = 'confirmed'
  join lobbyist_clients lc on lc.client_key = c.client_key
                          and lc.lobbyist_id = d.lobbyist_id and lc.active
  where c.status <> 'rejected'
  group by c.client_key, d.lobbyist_id
),
paths as (
  select l.donor_id, l.lobbyist_id, l.status, l.method, l.score,
         null::text as client_name, l.is_primary
  from donor_lobbyist_links l
  where l.status <> 'rejected'
  union all
  select c.donor_id, lc.lobbyist_id, c.status, 'client:' || c.method, c.score,
         c.client_name,
         exists (select 1 from client_leads cl
                 where cl.client_key = c.client_key and cl.lobbyist_id = lc.lobbyist_id)
  from donor_client_links c
  join lobbyist_clients lc on lc.client_key = c.client_key and lc.active
  where c.status <> 'rejected'
)
select p.donor_id,
       p.lobbyist_id,
       case when bool_or(p.status = 'confirmed') then 'confirmed' else 'suggested' end as status,
       array_agg(distinct p.method) as methods,
       array_remove(array_agg(distinct p.client_name), null) as client_names,
       max(p.score) as score,
       bool_or(p.is_primary) as is_primary
from paths p
where not exists (
  select 1 from donor_lobbyist_links r
  where r.donor_id = p.donor_id and r.lobbyist_id = p.lobbyist_id and r.status = 'rejected'
)
group by p.donor_id, p.lobbyist_id;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table lobbyists                 enable row level security;
alter table lobbyist_clients          enable row level security;
alter table committee_persons         enable row level security;
alter table committee_persons_scrapes enable row level security;
alter table lobby_donor_pool          enable row level security;
alter table donor_client_links        enable row level security;
alter table donor_lobbyist_links      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['lobbyists', 'lobbyist_clients', 'committee_persons',
                           'committee_persons_scrapes', 'lobby_donor_pool',
                           'donor_client_links', 'donor_lobbyist_links']
  loop
    execute format('drop policy if exists "Authenticated read" on %I', t);
    execute format('create policy "Authenticated read" on %I for select to authenticated using (true)', t);
    execute format('drop policy if exists "Reviewer write" on %I', t);
    execute format($p$create policy "Reviewer write" on %I for all to authenticated
      using (exists (select 1 from user_roles where user_id = auth.uid() and role in ('admin', 'reviewer')))
      with check (exists (select 1 from user_roles where user_id = auth.uid() and role in ('admin', 'reviewer')))$p$, t);
  end loop;
end $$;

grant select on donor_lobbyists to authenticated;
