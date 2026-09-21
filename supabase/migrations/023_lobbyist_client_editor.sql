-- An admin removal applies to the relationship across every import source.
create table if not exists public.lobbyist_client_exclusions (
 lobbyist_id bigint not null references public.lobbyists(lobbyist_id) on delete cascade,
 client_key text not null,
 removed_at timestamptz not null default now(),
 primary key(lobbyist_id,client_key)
);
alter table public.lobbyist_client_exclusions enable row level security;
drop policy if exists "Authenticated read" on public.lobbyist_client_exclusions;
create policy "Authenticated read" on public.lobbyist_client_exclusions for select to authenticated using(true);
drop policy if exists "Reviewer write" on public.lobbyist_client_exclusions;
create policy "Reviewer write" on public.lobbyist_client_exclusions for all to authenticated
 using(exists(select 1 from public.user_roles where user_id=auth.uid() and role in ('admin','reviewer')))
 with check(exists(select 1 from public.user_roles where user_id=auth.uid() and role in ('admin','reviewer')));
grant select,insert,update,delete on public.lobbyist_client_exclusions to authenticated,service_role;

create or replace function public.enforce_client_exclusion()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if exists(select 1 from lobbyist_client_exclusions e
   where e.lobbyist_id=new.lobbyist_id and e.client_key=new.client_key) then
  new.active:=false; new.is_lead:=false;
 end if;
 return new;
end;
$$;
revoke all on function public.enforce_client_exclusion() from public;
drop trigger if exists enforce_client_exclusion on public.lobbyist_clients;
create trigger enforce_client_exclusion before insert or update on public.lobbyist_clients
 for each row execute function public.enforce_client_exclusion();

create or replace function public.edit_lobbyist_client(
 p_lobbyist_id bigint,p_client_key text,p_active boolean,p_client_name text default null
) returns setof public.lobbyist_clients
language plpgsql security invoker set search_path=public,pg_temp as $$
declare label text;
begin
 if not exists(select 1 from user_roles where user_id=auth.uid() and role in ('admin','reviewer')) then
  raise exception 'Only admins and reviewers can edit clients' using errcode='42501';
 end if;
 if nullif(btrim(p_client_key),'') is null or p_active is null then
  raise exception 'A client and action are required';
 end if;
 -- Serialize edits to this lobbyist; both exclusion and source rows commit together.
 perform 1 from lobbyists where lobbyist_id=p_lobbyist_id for update;
 if not found then raise exception 'Lobbyist not found'; end if;
 select client_name into label from lobbyist_clients
  where lobbyist_id=p_lobbyist_id and client_key=p_client_key order by active desc,source limit 1;
 label:=coalesce(nullif(btrim(p_client_name),''),label);
 if label is null then raise exception 'Client name is required'; end if;
 if p_active then
  delete from lobbyist_client_exclusions where lobbyist_id=p_lobbyist_id and client_key=p_client_key;
  insert into lobbyist_clients(lobbyist_id,client_key,client_name,source,active,is_lead)
   values(p_lobbyist_id,p_client_key,label,'manual',true,false)
   on conflict(lobbyist_id,client_key,source) do update set active=true,client_name=excluded.client_name;
 else
  insert into lobbyist_client_exclusions(lobbyist_id,client_key) values(p_lobbyist_id,p_client_key)
   on conflict(lobbyist_id,client_key) do update set removed_at=now();
  update lobbyist_clients set active=false,is_lead=false
   where lobbyist_id=p_lobbyist_id and client_key=p_client_key;
 end if;
 return query select * from lobbyist_clients where lobbyist_id=p_lobbyist_id and client_key=p_client_key;
end;
$$;
revoke all on function public.edit_lobbyist_client(bigint,text,boolean,text) from public;
grant execute on function public.edit_lobbyist_client(bigint,text,boolean,text) to authenticated;
notify pgrst,'reload schema';
