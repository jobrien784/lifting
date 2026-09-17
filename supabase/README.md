# Supabase setup

The public PWA is local-first. Supabase supplies optional email-link sign-in and a private queue destination; the Edge Function is the only component that receives Notion credentials.

## Dashboard steps

1. In the Supabase project, open **SQL Editor** and run the migration in `migrations/202609170001_lifting_log.sql`.
2. Open **Authentication → URL Configuration**. Add the final GitHub Pages URL (for example, `https://YOUR-ACCOUNT.github.io/YOUR-REPO/`) as a **Redirect URL**. Add the same origin to the function's `ALLOWED_ORIGINS` value, without a trailing slash if that is how the browser reports it.
3. Deploy the `sync-notion` Edge Function with the Supabase CLI or dashboard.
4. Add these function secrets. Values are private and must never be committed:

   - `SUPABASE_SERVICE_ROLE_KEY`
   - `NOTION_TOKEN`
   - `NOTION_WORKOUT_SESSIONS_DATA_SOURCE_ID`
   - `NOTION_EXERCISE_LOGS_DATA_SOURCE_ID`
   - `ALLOWED_ORIGINS` (a comma-separated exact list of your GitHub Pages origin(s))

The Notion integration must be granted access to the two history data sources. Do not put the token or IDs in `docs/`, GitHub Actions logs, or the browser config. Codex's Notion MCP connection does not authorize this deployed app; the Edge Function uses its own Notion integration token.

The function maps the created data sources exactly: Workout Sessions use `Session`, `Completed At`, `Routine`, `Supabase Session ID`, `Started At`, and `Notes`; Exercise Logs create one page per set using `Exercise`, `Workout Session`, `Set`, `Weight`, `Reps`, `Completed`, `Routine`, and `Supabase Set ID`. The exercise page relation points to the newly-created session page. The app's stable local IDs are stored in Supabase and the session's Notion page ID is recorded to make successful retries idempotent.
