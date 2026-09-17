-- Lifting Log owner lockdown.
--
-- This migration binds ordinary authenticated access to the one approved
-- account. The approved account is entered separately into the private
-- allowlist after this migration is applied. The Edge Function continues to
-- use the service role, which is not subject to these RLS policies.
--
-- Ownership transfer: remove the old row and insert the new account in
-- private.lifting_authorized_users, then update the Edge Function's
-- ALLOWED_USER_ID secret. Do not put the UUID in browser configuration,
-- public UI text, or a migration committed to the public repository.

alter table public.workout_sessions enable row level security;
alter table public.exercise_logs enable row level security;

-- Remove broad table privileges before granting only the append/read surface
-- needed by an authorized authenticated client. The service role retains its
-- existing administrative access.
revoke all on table public.workout_sessions, public.exercise_logs from anon, authenticated;
grant select, insert on table public.workout_sessions, public.exercise_logs to authenticated;

-- Keep the allowlist and its checker outside the exposed public schema. The
-- authenticated role receives only the narrowly-scoped privileges needed for
-- RLS evaluation; it cannot read or write the allowlist directly.
create schema if not exists private;
create table if not exists private.lifting_authorized_users (
  user_id uuid primary key references auth.users(id) on delete cascade
);
revoke all on schema private from public, anon, authenticated;
revoke all on table private.lifting_authorized_users from public, anon, authenticated;
grant usage on schema private to authenticated;

create or replace function private.is_lifting_authorized()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, private
as $$
  select exists (
    select 1
    from private.lifting_authorized_users
    where user_id = (select auth.uid())
  );
$$;
revoke all on function private.is_lifting_authorized() from public, anon, authenticated;
grant execute on function private.is_lifting_authorized() to authenticated;

-- Remove every prior policy on these tables so an older generic policy cannot
-- continue to authorize a different authenticated user.
do $$
declare
  policy_record record;
begin
  for policy_record in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('workout_sessions', 'exercise_logs')
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policy_record.policyname,
      policy_record.schemaname,
      policy_record.tablename
    );
  end loop;
end;
$$;

create policy "Approved owner can read sessions"
  on public.workout_sessions
  for select
  to authenticated
  using (
    private.is_lifting_authorized()
    and user_id = auth.uid()
  );

create policy "Approved owner can insert sessions"
  on public.workout_sessions
  for insert
  to authenticated
  with check (
    private.is_lifting_authorized()
    and user_id = auth.uid()
  );

create policy "Approved owner can read exercise logs"
  on public.exercise_logs
  for select
  to authenticated
  using (
    private.is_lifting_authorized()
    and user_id = auth.uid()
  );

create policy "Approved owner can insert exercise logs"
  on public.exercise_logs
  for insert
  to authenticated
  with check (
    private.is_lifting_authorized()
    and user_id = auth.uid()
  );

-- Append-only for ordinary authenticated clients. No update/delete policy is
-- defined, and these privileges are explicitly revoked as defense in depth.
revoke update, delete, truncate, references, trigger on table public.workout_sessions, public.exercise_logs from anon, authenticated;
