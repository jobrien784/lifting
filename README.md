# Lifting Log

An installable, phone-first PWA for the six-workout rotation:

`Push A → Pull A → Legs/Abs A → Push B → Pull B → Legs/Abs B`

The first workout is Push A. The sequence advances only after **Finish workout**. In-progress sessions and completed history are saved locally in IndexedDB, so the app remains useful in a gym with poor reception. When signed in, finished sessions are queued and sent to the Supabase `sync-notion` Edge Function without delaying the Finish action.

## Publish the app

The static site is in `docs/`, ready to use as the GitHub Pages source. In GitHub, open **Settings → Pages**, choose **Deploy from a branch**, select the branch and `/docs` folder, then save. Open the published HTTPS URL in Safari and choose **Share → Add to Home Screen**.

## Supabase, in plain language

The URL and publishable key in `docs/config.js` are browser-safe configuration. The publishable key can be public because Supabase Row Level Security (RLS) is what protects each user's records. Never commit the database password, a `service_role` or `sb_secret_` key, a Notion token, or Notion data-source IDs.

In the Supabase dashboard:

1. Run `supabase/migrations/202609170001_lifting_log.sql`, then `supabase/migrations/202609170002_owner_lockdown.sql`, in **SQL Editor**.
2. Run the private allowlist `insert` command in [`supabase/README.md`](supabase/README.md), replacing its placeholder with your Supabase Auth user UUID. The UUID is entered directly in Supabase and does not belong in GitHub or browser code.
3. Keep **Allow new users to sign up** disabled under Supabase Authentication. This dashboard setting complements the owner-only RLS policies and Edge Function check; it is not a substitute for either one.
4. Add the final GitHub Pages URL under **Authentication → URL Configuration → Redirect URLs**.
5. Deploy the `sync-notion` Edge Function and set the private secrets described in [`supabase/README.md`](supabase/README.md), including the required `ALLOWED_USER_ID` set to the same UUID.
6. Grant the Notion integration access to the two history data sources. The Notion MCP connection used by Codex does not itself authorize this deployed app.

The Edge Function fails closed with a 503 when `ALLOWED_USER_ID` is missing or invalid, and rejects a different signed-in account before any database or Notion write. The browser also requests magic links with `shouldCreateUser: false` and shows a neutral response. Ownership changes are handled in the private allowlist plus an updated `ALLOWED_USER_ID` secret; editing documentation or public client code does not enforce them.

The original six routine templates remain public in `docs/routines.json`; completed workout history is not public. See the Supabase guide for CORS, secrets, and Notion property mapping.
