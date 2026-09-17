-- Lifting Log private sync schema.
-- The browser stores first; the sync function inserts immutable records here.
create extension if not exists pgcrypto;

create table if not exists public.workout_sessions (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  routine_id text not null,
  routine_name text not null,
  workout_date date not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  created_at timestamptz not null,
  notion_page_id text,
  notion_synced_at timestamptz,
  constraint workout_sessions_finished_after_start check (finished_at >= started_at),
  constraint workout_sessions_created_by_app check (created_at is not null)
);

create table if not exists public.exercise_logs (
  id text primary key,
  session_id text not null references public.workout_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  exercise_id text not null,
  exercise_name text not null,
  set_number integer not null check (set_number > 0),
  weight text,
  reps text,
  completed boolean not null,
  created_at timestamptz not null
);

create index if not exists workout_sessions_user_finished_idx on public.workout_sessions(user_id, finished_at desc);
create index if not exists exercise_logs_user_session_idx on public.exercise_logs(user_id, session_id);

create or replace function public.ensure_exercise_session_owner()
returns trigger language plpgsql security invoker as $$
begin
  if not exists (select 1 from public.workout_sessions where id = new.session_id and user_id = new.user_id) then
    raise exception 'exercise log owner does not match session owner';
  end if;
  return new;
end;
$$;
drop trigger if exists exercise_log_owner_check on public.exercise_logs;
create trigger exercise_log_owner_check before insert on public.exercise_logs for each row execute function public.ensure_exercise_session_owner();

alter table public.workout_sessions enable row level security;
alter table public.exercise_logs enable row level security;

drop policy if exists "Users can read their own sessions" on public.workout_sessions;
create policy "Users can read their own sessions" on public.workout_sessions for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users can insert their own sessions" on public.workout_sessions;
create policy "Users can insert their own sessions" on public.workout_sessions for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "Users can read their own exercise logs" on public.exercise_logs;
create policy "Users can read their own exercise logs" on public.exercise_logs for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users can insert their own exercise logs" on public.exercise_logs;
create policy "Users can insert their own exercise logs" on public.exercise_logs for insert to authenticated with check (auth.uid() = user_id);

-- No update/delete policies are defined. The service role used by the function
-- can insert idempotently, while normal authenticated clients cannot mutate history.
revoke update, delete on public.workout_sessions from anon, authenticated;
revoke update, delete on public.exercise_logs from anon, authenticated;
