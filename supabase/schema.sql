-- Momentrip schema (already applied to the Supabase project "soundtrack-credit" as migration momentrip_init).
-- Kept here for reference or for re-creating it in another project (SQL Editor → paste → Run).
create table if not exists public.momentrip_trips (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create table if not exists public.momentrip_logs (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.momentrip_trips enable row level security;
alter table public.momentrip_logs enable row level security;
create policy "own trips read" on public.momentrip_trips for select to authenticated using (user_id = (select auth.uid()));
create policy "own trips insert" on public.momentrip_trips for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own trips update" on public.momentrip_trips for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own trips delete" on public.momentrip_trips for delete to authenticated using (user_id = (select auth.uid()));
create policy "own logs read" on public.momentrip_logs for select to authenticated using (user_id = (select auth.uid()));
create policy "own logs insert" on public.momentrip_logs for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own logs update" on public.momentrip_logs for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own logs delete" on public.momentrip_logs for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.momentrip_trips, public.momentrip_logs from anon;
grant select, insert, update, delete on public.momentrip_trips, public.momentrip_logs to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('momentrip-photos', 'momentrip-photos', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
create policy "momentrip photos read own" on storage.objects for select to authenticated
  using (bucket_id = 'momentrip-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "momentrip photos insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'momentrip-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "momentrip photos update own" on storage.objects for update to authenticated
  using (bucket_id = 'momentrip-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "momentrip photos delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'momentrip-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ===== migration momentrip_prefs_polls (also already applied) =====
create table if not exists public.momentrip_prefs (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.momentrip_prefs enable row level security;
create policy "own prefs read" on public.momentrip_prefs for select to authenticated using (user_id = (select auth.uid()));
create policy "own prefs insert" on public.momentrip_prefs for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own prefs update" on public.momentrip_prefs for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own prefs delete" on public.momentrip_prefs for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.momentrip_prefs from anon;
grant select, insert, update, delete on public.momentrip_prefs to authenticated;

create table if not exists public.momentrip_polls (
  id text primary key check (char_length(id) between 16 and 40),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null check (pg_column_size(data) < 60000),
  created_at timestamptz not null default now()
);
create table if not exists public.momentrip_votes (
  poll_id text not null references public.momentrip_polls(id) on delete cascade,
  voter text not null check (char_length(voter) between 1 and 20),
  choice int not null check (choice between 0 and 2),
  created_at timestamptz not null default now(),
  primary key (poll_id, voter)
);
alter table public.momentrip_polls enable row level security;
alter table public.momentrip_votes enable row level security;
create policy "own polls read" on public.momentrip_polls for select to authenticated using (user_id = (select auth.uid()));
create policy "own polls insert" on public.momentrip_polls for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own polls delete" on public.momentrip_polls for delete to authenticated using (user_id = (select auth.uid()));
create policy "own poll votes read" on public.momentrip_votes for select to authenticated
  using (exists (select 1 from public.momentrip_polls p where p.id = poll_id and p.user_id = (select auth.uid())));
revoke all on public.momentrip_polls, public.momentrip_votes from anon;
grant select, insert, delete on public.momentrip_polls to authenticated;
grant select on public.momentrip_votes to authenticated;
-- voters (no login) only reach polls through these two functions, by the unguessable id
create or replace function public.momentrip_poll_get(p_id text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('data', p.data,
    'votes', coalesce((select jsonb_agg(jsonb_build_object('voter', v.voter, 'choice', v.choice) order by v.created_at)
                       from public.momentrip_votes v where v.poll_id = p.id), '[]'::jsonb))
  from public.momentrip_polls p where p.id = p_id;
$$;
create or replace function public.momentrip_poll_vote(p_id text, p_voter text, p_choice int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v text := btrim(coalesce(p_voter, ''));
begin
  if char_length(v) < 1 or char_length(v) > 20 then raise exception 'bad voter'; end if;
  if p_choice < 0 or p_choice > 2 then raise exception 'bad choice'; end if;
  if not exists (select 1 from public.momentrip_polls where id = p_id) then raise exception 'no poll'; end if;
  if (select count(*) from public.momentrip_votes where poll_id = p_id and voter <> v) >= 40 then raise exception 'too many voters'; end if;
  insert into public.momentrip_votes (poll_id, voter, choice) values (p_id, v, p_choice)
  on conflict (poll_id, voter) do update set choice = excluded.choice, created_at = now();
  return public.momentrip_poll_get(p_id);
end;
$$;
revoke all on function public.momentrip_poll_get(text) from public;
revoke all on function public.momentrip_poll_vote(text, text, int) from public;
grant execute on function public.momentrip_poll_get(text) to anon, authenticated;
grant execute on function public.momentrip_poll_vote(text, text, int) to anon, authenticated;
