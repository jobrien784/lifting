-- Durable, idempotent Notion queue. Apply after 202609170002_owner_lockdown.sql.
alter table public.workout_sessions add column if not exists notion_sync_status text not null default 'pending' check (notion_sync_status in ('pending', 'processing', 'failed', 'synced'));
alter table public.workout_sessions add column if not exists notion_sync_attempts integer not null default 0 check (notion_sync_attempts >= 0);
alter table public.workout_sessions add column if not exists notion_sync_error text;
alter table public.workout_sessions add column if not exists notion_sync_next_attempt_at timestamptz not null default now();
alter table public.workout_sessions add column if not exists notion_sync_claimed_at timestamptz;
alter table public.workout_sessions add column if not exists notion_sync_updated_at timestamptz not null default now();
alter table public.exercise_logs add column if not exists notion_page_id text;
create index if not exists workout_sessions_notion_queue_idx on public.workout_sessions (notion_sync_next_attempt_at, finished_at) where notion_sync_status in ('pending', 'failed');
update public.workout_sessions set notion_sync_status = 'synced', notion_sync_updated_at = coalesce(notion_synced_at, now()) where notion_page_id is not null and notion_sync_status <> 'synced';

create or replace function public.claim_lifting_notion_sessions(p_limit integer, p_stale_after interval default interval '15 minutes') returns setof public.workout_sessions language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  return query with candidates as (select id from public.workout_sessions where (notion_sync_status in ('pending', 'failed') and notion_sync_next_attempt_at <= now()) or (notion_sync_status = 'processing' and notion_sync_claimed_at < now() - p_stale_after) order by finished_at, id for update skip locked limit greatest(1, least(coalesce(p_limit, 10), 100))) update public.workout_sessions s set notion_sync_status = 'processing', notion_sync_attempts = s.notion_sync_attempts + 1, notion_sync_error = null, notion_sync_claimed_at = now(), notion_sync_updated_at = now() from candidates c where s.id = c.id returning s.*;
end; $$;
create or replace function public.complete_lifting_notion_session(p_session_id text, p_page_id text) returns void language sql security definer set search_path = pg_catalog, public as $$ update public.workout_sessions set notion_page_id = p_page_id, notion_synced_at = now(), notion_sync_status = 'synced', notion_sync_error = null, notion_sync_claimed_at = null, notion_sync_updated_at = now() where id = p_session_id; $$;
create or replace function public.fail_lifting_notion_session(p_session_id text, p_error text, p_delay interval) returns void language sql security definer set search_path = pg_catalog, public as $$ update public.workout_sessions set notion_sync_status = 'failed', notion_sync_error = left(coalesce(p_error, 'Unknown worker error'), 4000), notion_sync_next_attempt_at = now() + greatest(p_delay, interval '1 minute'), notion_sync_claimed_at = null, notion_sync_updated_at = now() where id = p_session_id; $$;
revoke all on function public.claim_lifting_notion_sessions(integer, interval) from public, anon, authenticated;
revoke all on function public.complete_lifting_notion_session(text, text) from public, anon, authenticated;
revoke all on function public.fail_lifting_notion_session(text, text, interval) from public, anon, authenticated;
grant execute on function public.claim_lifting_notion_sessions(integer, interval) to service_role;
grant execute on function public.complete_lifting_notion_session(text, text) to service_role;
grant execute on function public.fail_lifting_notion_session(text, text, interval) to service_role;
