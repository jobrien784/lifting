import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const notionToken = Deno.env.get("NOTION_TOKEN") ?? "";
const sessionsDataSourceId = Deno.env.get("NOTION_WORKOUT_SESSIONS_DATA_SOURCE_ID") ?? "";
const logsDataSourceId = Deno.env.get("NOTION_EXERCISE_LOGS_DATA_SOURCE_ID") ?? "";
const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);

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
function titleProperty(value: string) { return { title: [{ type: "text", text: { content: value } }] }; }
function richTextProperty(value: string) { return { rich_text: [{ type: "text", text: { content: value.slice(0, 2000) } }] }; }

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== "POST") return response(request, { error: "POST required" }, 405);
  if (!allowedOrigins.length) return response(request, { error: "ALLOWED_ORIGINS is not configured" }, 503);
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return response(request, { error: "Authentication required" }, 401);
  if (!supabaseUrl || !serviceRoleKey) return response(request, { error: "Supabase server configuration is incomplete" }, 503);
  if (!notionToken || !sessionsDataSourceId || !logsDataSourceId) return response(request, { error: "Notion sync is not configured. Set NOTION_TOKEN, NOTION_WORKOUT_SESSIONS_DATA_SOURCE_ID, and NOTION_EXERCISE_LOGS_DATA_SOURCE_ID." }, 503);
  try {
    const admin = createClient(supabaseUrl, serviceRoleKey);
    const token = authorization.slice("Bearer ".length);
    const { data: { user }, error: userError } = await admin.auth.getUser(token);
    if (userError || !user) return response(request, { error: "Invalid session" }, 401);
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
    // These property names are intentionally simple defaults. Adjust them in this
    // function if the two Notion data sources use different property names.
    const summary = session.exercises.map((exercise: any) => `${exercise.name}: ${exercise.sets.map((set: any) => `${set.reps || "—"} reps @ ${set.weight || "—"}`).join(", ")}`).join("\n");
    const sessionPage = await notionCreatePage(sessionsDataSourceId, { Name: titleProperty(`${session.routineName} — ${session.workoutDate}`), Date: { date: { start: session.workoutDate } }, Notes: richTextProperty(summary) });
    for (const exercise of session.exercises) {
      const details = exercise.sets.map((set: any, index: number) => `Set ${index + 1}: ${set.reps || "—"} reps @ ${set.weight || "—"}${set.done ? "" : " (not completed)"}`).join("\n");
      await notionCreatePage(logsDataSourceId, { Name: titleProperty(`${session.routineName} — ${exercise.name}`), Date: { date: { start: session.workoutDate } }, Details: richTextProperty(details), "Workout Session": { relation: [{ id: sessionPage.id }] } });
    }
    const { error: markSyncedError } = await admin.from("workout_sessions").update({ notion_page_id: sessionPage.id, notion_synced_at: new Date().toISOString() }).eq("id", session.id).eq("user_id", user.id);
    if (markSyncedError) throw new Error(`Sync state update failed: ${markSyncedError.message}`);
    return response(request, { ok: true, sessionId: session.id });
  } catch (error) { return response(request, { error: error instanceof Error ? error.message : "Sync failed" }, 400); }
});
