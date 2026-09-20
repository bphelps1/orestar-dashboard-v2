-- ============================================================================
-- Plan designations: who to call for a donor, and which lobbyists are
-- "Partners" of a caucus.
--
-- Three additions to the attribution model in 016:
--
--   donor_contacts     — the people to call for a donor, a primary and any
--                        number of others. A contact is usually a lobbyist
--                        already on file, but a donor's own government-affairs
--                        staffer is often not on Capitol Club at all, so the
--                        name/email/phone are stored on the row and the
--                        lobbyist link is optional.
--   lobbyist_partners  — the 2024 lobby list's "PARTNER" tier, which is not a
--                        property of the lobbyist but of the relationship: a
--                        firm can be a partner of the House Democrats and
--                        nothing to the Senate Republicans. Keyed by chamber
--                        and party for that reason.
--   donor_lobbyists    — recreated so an admin's explicit "file this donor
--                        under X" beats a client lead. Without this, an
--                        organization listed under two spellings on Capitol
--                        Club (OSEA) can produce two primaries for one donor.
-- ============================================================================

-- Fields an admin has edited by hand. The weekly Capitol Club scrape rewrites a
-- member's contact card wholesale, which silently undid any correction made
-- here; a field named in this array is now left alone until the edit is
-- reverted at /admin/lobbyists.
alter table lobbyists add column if not exists manual_fields text[] not null default '{}';

create table if not exists donor_contacts (
  contact_id   bigint generated always as identity primary key,
  donor_id     text   not null,
  -- Set when the contact is someone already on file; their details still live
  -- on this row so a contact survives the lobbyist being removed.
  lobbyist_id  bigint references lobbyists(lobbyist_id) on delete set null,
  name         text   not null,
  title        text,
  email        text,
  phone        text,
  is_primary   boolean not null default false,
  sort_order   int    not null default 0,
  notes        text,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_donor_contacts_donor on donor_contacts (donor_id);
-- One primary per donor; the app clears the old one in the same save.
create unique index if not exists idx_donor_contacts_primary
  on donor_contacts (donor_id) where is_primary;

-- A lobbyist's partner standing with one caucus. No row means "not a partner".
create table if not exists lobbyist_partners (
  lobbyist_id  bigint not null references lobbyists(lobbyist_id) on delete cascade,
  chamber      text   not null,          -- 'house' | 'senate'
  party        text   not null,          -- 'D' | 'R'
  notes        text,
  set_by       text,
  set_at       timestamptz not null default now(),
  primary key (lobbyist_id, chamber, party),
  constraint lobbyist_partners_chamber_check check (chamber in ('house', 'senate')),
  constraint lobbyist_partners_party_check   check (party in ('D', 'R'))
);

-- ── Combined attribution (replaces the view in 016) ─────────────────────────
-- One row per (donor, lobbyist). status is the strongest non-rejected status
-- among the paths that reach the pair; any direct rejection vetoes the pair.
--
-- is_primary marks who a plan should list the donor under, in this order:
--   1. a direct link marked primary — an admin's choice at /admin/lobbyists,
--      or the tracker's "Lobbyist 1";
--   2. the client's lead (lobbyist_clients.is_lead);
--   3. whoever a confirmed direct link already chose for another donor of the
--      same client, so a union filed under one lobbyist keeps its other donor
--      records there rather than under whichever lobbyist sorts first.
-- An explicit direct primary suppresses 2 and 3 entirely: one donor, one
-- primary, even when the client is listed under two spellings.
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
         not exists (select 1 from donor_lobbyist_links pri
                     where pri.donor_id = c.donor_id and pri.is_primary
                       and pri.status <> 'rejected')
         and (lc.is_lead or (
           not exists (select 1 from lobbyist_clients x
                       where x.client_key = c.client_key and x.is_lead and x.active)
           and exists (select 1 from client_leads cl
                       where cl.client_key = c.client_key and cl.lobbyist_id = lc.lobbyist_id)))
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
alter table donor_contacts    enable row level security;
alter table lobbyist_partners enable row level security;

do $$
declare t text;
begin
  foreach t in array array['donor_contacts', 'lobbyist_partners']
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
