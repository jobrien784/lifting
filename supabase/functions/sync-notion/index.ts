import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const notionToken = Deno.env.get("NOTION_TOKEN") ?? "";
const sessionsDataSourceId = Deno.env.get("NOTION_WORKOUT_SESSIONS_DATA_SOURCE_ID") ?? "";
const logsDataSourceId = Deno.env.get("NOTION_EXERCISE_LOGS_DATA_SOURCE_ID") ?? "";
const allowedUserId = (Deno.env.get("ALLOWED_USER_ID") ?? "").trim().toLowerCase();
const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function corsHeaders(request: Request) {
  const origin = request.headers.get("Origin");
  const headers: Record<string, string> = { "Vary": "Origin", "Content-Type": "application/json" };
  if (origin && allowedOrigins.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  headers["Access-Control-Allow-Headers"] = "authorization, x-client-info, apikey, content-type";
  headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
  return headers;
}
function response(request: Request, body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: corsHeaders(request) }); }
function required(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`); return value.trim(); }
function assertSessionShape(session: any) {
  required(session?.id, "session.id"); required(session?.routineId, "session.routineId"); required(session?.routineName, "session.routineName");
  required(session?.startedAt, "session.startedAt"); required(session?.finishedAt, "session.finishedAt"); required(session?.workoutDate, "session.workoutDate");
  if (!Array.isArray(session?.exercises)) throw new Error("session.exercises must be an array");
}

async function notionCreatePage(dataSourceId: string, properties: Record<string, unknown>, children: unknown[] = []) {
  const result = await fetch("https://api.notion.com/v1/pages", { method: "POST", headers: { Authorization: `Bearer ${notionToken}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" }, body: JSON.stringify({ parent: { data_source_id: dataSourceId }, properties, children }) });
  if (!result.ok) throw new Error(`Notion rejected a page (${result.status})`);
  return result.json();
}
function titleProperty(value: string) { return { title: [{ type: "text", text: { content: value.slice(0, 2000) } }] }; }
function richTextProperty(value: string) { return value ? { rich_text: [{ type: "text", text: { content: value.slice(0, 2000) } }] } : { rich_text: [] }; }
function dateProperty(value: string) { return { date: { start: value } }; }
function selectProperty(value: string) { return { select: { name: value } }; }
function numericValue(value: unknown): number | null { const text = String(value ?? "").trim(); if (!text) return null; const number = Number(text); return Number.isFinite(number) ? number : null; }

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== "POST") return response(request, { error: "POST required" }, 405);
  if (!allowedOrigins.length) return response(request, { error: "ALLOWED_ORIGINS is not configured" }, 503);
  if (!allowedUserId || !uuidPattern.test(allowedUserId)) return response(request, { error: "Sync authorization is not configured" }, 503);
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return response(request, { error: "Authentication required" }, 401);
  if (!supabaseUrl || !serviceRoleKey) return response(request, { error: "Supabase server configuration is incomplete" }, 503);
  if (!notionToken || !sessionsDataSourceId || !logsDataSourceId) return response(request, { error: "Notion sync is not configured. Set NOTION_TOKEN, NOTION_WORKOUT_SESSIONS_DATA_SOURCE_ID, and NOTION_EXERCISE_LOGS_DATA_SOURCE_ID." }, 503);
  try {
    const admin = createClient(supabaseUrl, serviceRoleKey);
    const token = authorization.slice("Bearer ".length);
    const { data: { user }, error: userError } = await admin.auth.getUser(token);
    if (userError || !user) return response(request, { error: "Invalid session" }, 401);
    if (user.id.toLowerCase() !== allowedUserId) return response(request, { error: "Sync is not available for this account" }, 403);
    const payload = await request.json(); const session = payload?.session; assertSessionShape(session);
    const { data: existingSession, error: ownershipError } = await admin.from("workout_sessions").select("user_id").eq("id", session.id).maybeSingle();
    if (ownershipError) throw new Error(`Ownership check failed: ${ownershipError.message}`);
    if (existingSession && existingSession.user_id !== user.id) return response(request, { error: "Session belongs to another account" }, 403);
    const { data: syncState, error: syncStateError } = await admin.from("workout_sessions").select("notion_page_id").eq("id", session.id).maybeSingle();
    if (syncStateError) throw new Error(`Sync state check failed: ${syncStateError.message}`);
    if (syncState?.notion_page_id) return response(request, { ok: true, sessionId: session.id, alreadySynced: true });
    const sessionRow = { id: session.id, user_id: user.id, routine_id: session.routineId, routine_name: session.routineName, workout_date: session.workoutDate, started_at: session.startedAt, finished_at: session.finishedAt, created_at: new Date().toISOString() };
    const { error: insertError } = await admin.from("workout_sessions").upsert(sessionRow, { onConflict: "id", ignoreDuplicates: true });
    if (insertError) throw new Error(`Session database write failed: ${insertError.message}`);
    const rows: Record<string, unknown>[] = [];
    for (const exercise of session.exercises) {
      required(exercise?.exerciseId, "exercise.exerciseId"); required(exercise?.name, "exercise.name");
      if (!Array.isArray(exercise?.sets)) throw new Error("exercise.sets must be an array");
      exercise.sets.forEach((set: any, index: number) => rows.push({ id: `${session.id}:${exercise.exerciseId}:${index + 1}`, session_id: session.id, user_id: user.id, exercise_id: exercise.exerciseId, exercise_name: exercise.name, set_number: index + 1, weight: set.weight ?? null, reps: set.reps == null ? null : String(set.reps), completed: Boolean(set.done), created_at: new Date().toISOString() }));
    }
    if (rows.length) { const { error: logError } = await admin.from("exercise_logs").upsert(rows, { onConflict: "id", ignoreDuplicates: true }); if (logError) throw new Error(`Exercise database write failed: ${logError.message}`); }
    const summary = session.exercises.map((exercise: any) => `${exercise.name}: ${exercise.sets.map((set: any) => `${set.reps || "—"} reps @ ${set.weight || "—"}`).join(", ")}`).join("\n");
    const sessionPage = await notionCreatePage(sessionsDataSourceId, {
      Session: titleProperty(`${session.routineName} — ${session.workoutDate}`),
      "Completed At": dateProperty(session.finishedAt),
      Routine: selectProperty(session.routineName),
      "Supabase Session ID": richTextProperty(session.id),
      "Started At": dateProperty(session.startedAt),
      Notes: richTextProperty(summary)
    });
    for (const exercise of session.exercises) {
      for (const [index, set] of exercise.sets.entries()) {
        const setId = `${session.id}:${exercise.exerciseId}:${index + 1}`;
        const properties: Record<string, unknown> = {
          Exercise: titleProperty(exercise.name),
          "Workout Session": { relation: [{ id: sessionPage.id }] },
          Set: { number: index + 1 },
          Weight: richTextProperty(String(set.weight ?? "")),
          Completed: { checkbox: Boolean(set.done) },
          Routine: selectProperty(session.routineName),
          "Supabase Set ID": richTextProperty(setId)
        };
        const reps = numericValue(set.reps);
        if (reps !== null) properties.Reps = { number: reps };
        await notionCreatePage(logsDataSourceId, properties);
      }
    }
    const { error: markSyncedError } = await admin.from("workout_sessions").update({ notion_page_id: sessionPage.id, notion_synced_at: new Date().toISOString() }).eq("id", session.id).eq("user_id", user.id);
    if (markSyncedError) throw new Error(`Sync state update failed: ${markSyncedError.message}`);
    return response(request, { ok: true, sessionId: session.id });
  } catch (error) { return response(request, { error: error instanceof Error ? error.message : "Sync failed" }, 400); }
});
