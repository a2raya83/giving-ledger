-- Giving Ledger — Supabase schema. Run once in the SQL editor of a new Supabase project.
-- Model: a household owns the ledger; people are granted access to a household.
--   owner  — everything, including inviting and removing people
--   member — add, edit and delete entries and receipts
--   viewer — read-only (an accountant)

create extension if not exists pgcrypto;

-- ---------- tables ----------
create table if not exists public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 120),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- Plan structure lives on the household, so invited members never pay separately.
  -- beta: free during the beta · active: paid · past_due / canceled: read-only (records and exports stay available)
  plan           text not null default 'household' check (plan in ('household')),
  plan_status    text not null default 'beta' check (plan_status in ('beta','active','past_due','canceled')),
  plan_renews_at timestamptz,
  canceled_at    timestamptz
);
alter table public.households add column if not exists plan text not null default 'household';
alter table public.households add column if not exists plan_status text not null default 'beta';
alter table public.households add column if not exists plan_renews_at timestamptz;
alter table public.households add column if not exists canceled_at timestamptz;

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('owner','member','viewer')),
  joined_at    timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists public.invitations (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  email        text not null,
  role         text not null default 'member' check (role in ('member','viewer')),
  token        text not null unique default encode(gen_random_bytes(24), 'hex'),
  invited_by   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '14 days',
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id)
);

-- One row per donation. The body is the same JSON the browser version stores, so the rules engine
-- and forms are unchanged. version is bumped on every write; a stale write is rejected (conflict).
create table if not exists public.entries (
  id           text not null,
  household_id uuid not null references public.households(id) on delete cascade,
  body         jsonb not null,
  version      integer not null default 1,
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid(),
  primary key (household_id, id)
);
create index if not exists entries_household_idx on public.entries(household_id);

create table if not exists public.receipts (
  id           text not null,
  household_id uuid not null references public.households(id) on delete cascade,
  entry_id     text,
  name         text not null,
  type         text not null default '',
  size         integer not null default 0,
  path         text not null,                     -- storage object: <household_id>/<receipt id>
  source_id    text,                              -- original id when copied from a device ledger (makes migration retries idempotent)
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  primary key (household_id, id)
);
create index if not exists receipts_household_idx on public.receipts(household_id);
alter table public.receipts add column if not exists source_id text;
create unique index if not exists receipts_source_idx on public.receipts(household_id, source_id) where source_id is not null;

-- ---------- helpers (security definer so policies don't recurse) ----------
create or replace function public.is_member(p_household uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.household_members m where m.household_id = p_household and m.user_id = auth.uid());
$$;
-- Writing needs a writer role AND a household whose plan allows changes. A canceled or past-due
-- household stays readable and exportable (retention), but nothing new can be added.
create or replace function public.can_write(p_household uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.household_members m join public.households h on h.id = m.household_id
    where m.household_id = p_household and m.user_id = auth.uid() and m.role in ('owner','member')
      and h.plan_status in ('beta','active'));
$$;
create or replace function public.is_owner(p_household uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.household_members m where m.household_id = p_household and m.user_id = auth.uid() and m.role = 'owner');
$$;

-- Create a household and make the caller its owner, in one transaction.
create or replace function public.create_household(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.households(name, created_by) values (p_name, auth.uid()) returning id into hid;
  insert into public.household_members(household_id, user_id, role) values (hid, auth.uid(), 'owner');
  return hid;
end $$;

-- Accept an invitation: the signed-in user's email must match the invitation.
create or replace function public.accept_invitation(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare inv public.invitations%rowtype; my_email text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select lower(email) into my_email from auth.users where id = auth.uid();
  select * into inv from public.invitations where token = p_token;
  if inv.id is null then raise exception 'This invitation link is not valid.'; end if;
  if inv.accepted_at is not null then raise exception 'This invitation was already used.'; end if;
  if inv.expires_at < now() then raise exception 'This invitation has expired. Ask for a new one.'; end if;
  if lower(inv.email) <> my_email then raise exception 'This invitation was sent to %, but you are signed in as %.', inv.email, my_email; end if;
  insert into public.household_members(household_id, user_id, role) values (inv.household_id, auth.uid(), inv.role)
    on conflict (household_id, user_id) do update set role = excluded.role;
  update public.invitations set accepted_at = now(), accepted_by = auth.uid() where id = inv.id;
  return inv.household_id;
end $$;

-- Member list with emails (emails live in auth.users, which clients can't read directly).
create or replace function public.household_member_list(p_household uuid)
returns table (user_id uuid, email text, role text, joined_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text, m.role, m.joined_at
  from public.household_members m join auth.users u on u.id = m.user_id
  where m.household_id = p_household and public.is_member(p_household);
$$;

-- ---------- row-level security ----------
alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.invitations enable row level security;
alter table public.entries enable row level security;
alter table public.receipts enable row level security;

drop policy if exists hh_select on public.households;
create policy hh_select on public.households for select using (public.is_member(id));
drop policy if exists hh_update on public.households;
create policy hh_update on public.households for update using (public.is_owner(id))
  with check (public.is_owner(id));
-- Billing fields change only through a server-side process (a payment webhook with the service key),
-- never from the browser: this trigger rejects client-side edits to them.
create or replace function public.protect_plan_fields() returns trigger language plpgsql as $$
begin
  if auth.role() = 'authenticated' and (new.plan is distinct from old.plan or new.plan_status is distinct from old.plan_status
      or new.plan_renews_at is distinct from old.plan_renews_at or new.canceled_at is distinct from old.canceled_at) then
    raise exception 'plan fields can only be changed by the billing process';
  end if;
  return new;
end $$;
drop trigger if exists households_protect_plan on public.households;
create trigger households_protect_plan before update on public.households for each row execute function public.protect_plan_fields();
drop policy if exists hh_delete on public.households;
create policy hh_delete on public.households for delete using (public.is_owner(id));
-- inserts happen only through create_household()

drop policy if exists mem_select on public.household_members;
create policy mem_select on public.household_members for select using (public.is_member(household_id));
drop policy if exists mem_delete on public.household_members;
create policy mem_delete on public.household_members for delete using (public.is_owner(household_id) or user_id = auth.uid());
drop policy if exists mem_update on public.household_members;
create policy mem_update on public.household_members for update using (public.is_owner(household_id));
-- inserts happen only through create_household() and accept_invitation()

drop policy if exists inv_select on public.invitations;
create policy inv_select on public.invitations for select using (public.is_owner(household_id));
drop policy if exists inv_insert on public.invitations;
create policy inv_insert on public.invitations for insert with check (public.is_owner(household_id));
drop policy if exists inv_delete on public.invitations;
create policy inv_delete on public.invitations for delete using (public.is_owner(household_id));

drop policy if exists ent_select on public.entries;
create policy ent_select on public.entries for select using (public.is_member(household_id));
drop policy if exists ent_write on public.entries;
create policy ent_write on public.entries for insert with check (public.can_write(household_id));
drop policy if exists ent_update on public.entries;
create policy ent_update on public.entries for update using (public.can_write(household_id));
drop policy if exists ent_delete on public.entries;
create policy ent_delete on public.entries for delete using (public.can_write(household_id));

drop policy if exists rec_select on public.receipts;
create policy rec_select on public.receipts for select using (public.is_member(household_id));
drop policy if exists rec_write on public.receipts;
create policy rec_write on public.receipts for insert with check (public.can_write(household_id));
drop policy if exists rec_update on public.receipts;
create policy rec_update on public.receipts for update using (public.can_write(household_id));
drop policy if exists rec_delete on public.receipts;
create policy rec_delete on public.receipts for delete using (public.can_write(household_id));

-- keep updated_at / updated_by fresh
create or replace function public.touch_entry() returns trigger language plpgsql as $$
begin new.updated_at = now(); new.updated_by = auth.uid(); return new; end $$;
drop trigger if exists entries_touch on public.entries;
create trigger entries_touch before update on public.entries for each row execute function public.touch_entry();

-- ---------- private receipt storage ----------
insert into storage.buckets (id, name, public, file_size_limit)
  values ('receipts', 'receipts', false, 26214400)
  on conflict (id) do update set public = false, file_size_limit = 26214400;

-- Object path is <household_id>/<receipt id>; access follows household membership.
drop policy if exists receipts_read on storage.objects;
create policy receipts_read on storage.objects for select
  using (bucket_id = 'receipts' and public.is_member((split_part(name, '/', 1))::uuid));
drop policy if exists receipts_insert on storage.objects;
create policy receipts_insert on storage.objects for insert
  with check (bucket_id = 'receipts' and public.can_write((split_part(name, '/', 1))::uuid));
drop policy if exists receipts_delete on storage.objects;
create policy receipts_delete on storage.objects for delete
  using (bucket_id = 'receipts' and public.can_write((split_part(name, '/', 1))::uuid));

-- ---------- realtime (live updates between devices) ----------
do $$ begin
  begin alter publication supabase_realtime add table public.entries; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.receipts; exception when duplicate_object then null; end;
end $$;
