# Supabase setup

The public PWA is local-first. Supabase supplies optional email-link sign-in and a private queue destination; the Edge Function is the only component that receives Notion credentials.

## Dashboard steps

1. In the Supabase project, open **SQL Editor** and run `migrations/202609170001_lifting_log.sql`, followed by `migrations/202609170002_owner_lockdown.sql`, then `migrations/202610070001_durable_notion_queue.sql`.
2. In that same SQL Editor, insert your one authorized Supabase Auth user into the private allowlist. Replace the placeholder with the UUID shown for your account under **Authentication → Users**, then run:

   ```sql
   insert into private.lifting_authorized_users (user_id)
   values ('YOUR-SUPABASE-AUTH-USER-UUID-HERE'::uuid)
   on conflict (user_id) do nothing;
   ```

   This is the only manual SQL step that contains your personal UUID. It is stored in the private Supabase database, not in GitHub, browser code, or a public migration.
3. In **Authentication → Providers/Configuration**, keep **Allow new users to sign up** disabled. That dashboard setting prevents new accounts; the database policies and Edge Function check below are complementary safeguards, not replacements for it.
4. Open **Authentication → URL Configuration**. Add the final GitHub Pages URL (for example, `https://YOUR-ACCOUNT.github.io/YOUR-REPO/`) as a **Redirect URL**. Add the same origin to the function's `ALLOWED_ORIGINS` value, without a trailing slash if that is how the browser reports it.
5. Deploy `sync-notion` and `notion-worker` with the Supabase CLI or dashboard. The browser call returns `202` only after Supabase has durably accepted the session and sets; it does not wait for Notion.
6. Add these function secrets. Values are private and must never be committed:

   - `SUPABASE_SERVICE_ROLE_KEY`
   - `NOTION_TOKEN`
   - `NOTION_WORKOUT_SESSIONS_DATA_SOURCE_ID`
   - `NOTION_EXERCISE_LOGS_DATA_SOURCE_ID`
   - `ALLOWED_ORIGINS` (a comma-separated exact list of your GitHub Pages origin(s))
   - `ALLOWED_USER_ID` (the Supabase Auth user ID of the one authorized owner)
   - `NOTION_WORKER_SECRET` (a long random server-only bearer secret)
   - `NOTION_WORKER_BATCH_SIZE` (optional, bounded to 1–100; default 10)

`ALLOWED_USER_ID` is required and must match the same Auth user UUID inserted into the private allowlist. It is stored only as an Edge Function secret and in the private database; it must not appear in GitHub or public client code. If it is missing or malformed, the function returns a configuration error (503) and writes nothing. If a different signed-in account calls it, the function returns 403 before reading or writing workout rows or calling Notion. The app's email-link request also uses `shouldCreateUser: false` and gives a neutral message, but do not treat client behavior as authorization.

The Notion integration must be granted access to the two history data sources. Do not put the token, IDs, worker secret, or service key in `docs/`, logs, or browser config. Codex's Notion MCP connection does not authorize this deployed app.

## Scheduling, retry, and reconciliation

Invoke `notion-worker` from a trusted scheduler every few minutes with `Authorization: Bearer $NOTION_WORKER_SECRET`. It rejects missing or incorrect credentials and fails closed when required secrets are absent. A bounded batch claims rows with row locks, continues after individual failures, retries failed rows after five minutes, and reclaims stale processing claims after 15 minutes.

Manual run: `curl -X POST "$SUPABASE_URL/functions/v1/notion-worker" -H "Authorization: Bearer $NOTION_WORKER_SECRET"`. To retry a failed session, use an administrative SQL process to set `notion_sync_status = 'pending'`, `notion_sync_next_attempt_at = now()`, and clear `notion_sync_error`; never grant this to the browser.

Crash-window reconciliation uses stable Supabase session IDs and set IDs. Before creating a page, the worker queries Notion for that ID; after creation it records each page ID immediately. A crash between those operations is reconciled on the next attempt instead of duplicating pages. Inspect `workout_sessions.notion_sync_status`, `notion_sync_attempts`, `notion_sync_error`, and `exercise_logs.notion_page_id` when diagnosing a run.

The function maps the created data sources exactly: Workout Sessions use `Session`, `Completed At`, `Routine`, `Supabase Session ID`, `Started At`, and `Notes`; Exercise Logs create one page per set using `Exercise`, `Workout Session`, `Set`, `Weight`, `Reps`, `Completed`, `Routine`, and `Supabase Set ID`. The exercise page relation points to the newly-created session page. The app's stable local IDs are stored in Supabase and the session's Notion page ID is recorded to make successful retries idempotent.

## Ownership changes

To transfer ownership safely:

1. Add the new user's UUID to the private allowlist with the same `insert` command above.
2. Change the Edge Function's `ALLOWED_USER_ID` secret to the new UUID and redeploy the function.
3. Remove the old user's UUID from the allowlist in Supabase SQL Editor:

   ```sql
   delete from private.lifting_authorized_users
   where user_id = 'OLD-SUPABASE-AUTH-USER-UUID-HERE'::uuid;
   ```

To remove access entirely, first clear or replace `ALLOWED_USER_ID` and redeploy the function (so it fails closed), then delete the user's row from `private.lifting_authorized_users`. Keep the Supabase dashboard's public-signup setting disabled throughout. Never put an owner ID in `docs/config.js`, other browser code, or public UI text; changing documentation alone does not enforce ownership.
