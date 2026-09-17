# Lifting Log

An installable, phone-first PWA for the six-workout rotation:

`Push A → Pull A → Legs/Abs A → Push B → Pull B → Legs/Abs B`

The first workout is Push A. The sequence advances only after **Finish workout**. In-progress sessions and completed history are saved locally in IndexedDB, so the app remains useful in a gym with poor reception. When signed in, finished sessions are queued and sent to the Supabase `sync-notion` Edge Function without delaying the Finish action.

## Publish the app

The static site is in `docs/`, ready to use as the GitHub Pages source. In GitHub, open **Settings → Pages**, choose **Deploy from a branch**, select the branch and `/docs` folder, then save. Open the published HTTPS URL in Safari and choose **Share → Add to Home Screen**.

## Supabase, in plain language

The URL and publishable key in `docs/config.js` are browser-safe configuration. The publishable key can be public because Supabase Row Level Security (RLS) is what protects each user's records. Never commit the database password, a `service_role` or `sb_secret_` key, a Notion token, or Notion data-source IDs.

In the Supabase dashboard:

1. Run `supabase/migrations/202609170001_lifting_log.sql` in **SQL Editor**.
2. Add the final GitHub Pages URL under **Authentication → URL Configuration → Redirect URLs**.
3. Deploy the `sync-notion` Edge Function and set the private secrets described in [`supabase/README.md`](supabase/README.md).
4. Grant the Notion integration access to the two history data sources. The Notion MCP connection used by Codex does not itself authorize this deployed app.

The original six routine templates remain public in `docs/routines.json`; completed workout history is not public. See the Supabase guide for CORS, secrets, and Notion property mapping.
