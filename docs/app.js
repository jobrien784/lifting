/* Lifting Log: local-first workout state with optional Supabase sync. */
(function () {
  "use strict";

  const DB_NAME = "lifting-log-v1";
  const DB_VERSION = 1;
  const STORES = { meta: "meta", drafts: "drafts", sessions: "sessions", queue: "queue" };
  const config = window.liftingConfig || {};
  const state = { routines: null, meta: { nextIndex: 0 }, draft: null, sessions: [], confirmFinish: false, supabase: null, user: null };
  let dbPromise;
  let draftSaveTimer;
  let toastTimer;

  const $ = (selector) => document.querySelector(selector);
  const escapeText = (value) => String(value ?? "").replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
  const show = (element, visible) => element.classList.toggle("hidden", !visible);
  const routineAt = () => state.routines.routines[state.meta.nextIndex % state.routines.routines.length];

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        Object.values(STORES).forEach((store) => { if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: "id" }); });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function dbGet(store, id) {
    const db = await openDb();
    return new Promise((resolve, reject) => { const request = db.transaction(store).objectStore(store).get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  }
  async function dbAll(store) {
    const db = await openDb();
    return new Promise((resolve, reject) => { const request = db.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error); });
  }
  async function dbPut(store, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => { const request = db.transaction(store, "readwrite").objectStore(store).put(value); request.onsuccess = () => resolve(value); request.onerror = () => reject(request.error); });
  }
  async function dbDelete(store, id) {
    const db = await openDb();
    return new Promise((resolve, reject) => { const request = db.transaction(store, "readwrite").objectStore(store).delete(id); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
  }

  function easternParts(date) {
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date).reduce((result, part) => { result[part.type] = part.value; return result; }, {});
  }
  function easternDate(date = new Date()) { const p = easternParts(date); return `${p.year}-${p.month}-${p.day}`; }
  function displayDate(iso) { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date(iso)); }
  function displayTime(iso) { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(iso)); }
  function uid(prefix) { return `${prefix}-${Date.now()}-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`; }
  function notify(message) { const toast = $("#toast"); toast.textContent = message; toast.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 3000); }

  function setNetworkStatus() { $("#network-status").classList.toggle("online", navigator.onLine); $("#network-status").title = navigator.onLine ? "Online" : "Offline — local mode"; }
  function setSyncMessage(message) { $("#sync-status").textContent = message || ""; }

  async function loadState() {
    state.meta = (await dbGet(STORES.meta, "app")) || { id: "app", nextIndex: 0 };
    state.draft = await dbGet(STORES.drafts, "active");
    state.sessions = (await dbAll(STORES.sessions)).sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt));
  }

  function findRoutine(id) { return state.routines.routines.find((routine) => routine.id === id); }
  function previousForExercise(exerciseId) {
    for (const session of state.sessions) { const item = session.exercises.find((exercise) => exercise.exerciseId === exerciseId); if (item && item.sets.some((set) => set.done)) return item; }
    return null;
  }
  function completedPriorSet(exerciseId, setIndex) {
    const prior = previousForExercise(exerciseId);
    return prior ? prior.sets.filter((set) => set.done)[setIndex] : null;
  }
  function priorOrDefault(value, fallback) { return value !== null && value !== undefined && value !== "" ? value : fallback; }
  function makeDraft(routine) {
    return { id: "active", sessionId: uid("session"), routineId: routine.id, startedAt: new Date().toISOString(), workoutDate: easternDate(), exercises: routine.exercises.map((exercise) => ({ exerciseId: exercise.id, name: exercise.name, sets: Array.from({ length: exercise.sets }, (_, index) => { const prior = completedPriorSet(exercise.id, index); return { id: uid("set"), weight: priorOrDefault(prior && prior.weight, exercise.defaultWeight ?? ""), reps: priorOrDefault(prior && prior.reps, exercise.reps), done: false }; }) })) };
  }
  function scheduleDraftSave() { clearTimeout(draftSaveTimer); draftSaveTimer = setTimeout(() => dbPut(STORES.drafts, state.draft).catch(() => notify("Could not save locally")), 120); }

  function renderNext() {
    const routine = routineAt();
    $("#rotation-badge").textContent = `${state.meta.nextIndex + 1} / ${state.routines.sequence.length}`;
    $("#next-card").innerHTML = `<div><h3>${escapeText(routine.name)}</h3><p class="routine-meta">${routine.exercises.length} exercises · ${routine.exercises.reduce((sum, exercise) => sum + exercise.sets, 0)} working sets</p></div><button id="start-workout" class="button primary" type="button">${state.draft ? "Resume" : "Start workout"}</button>`;
    $("#start-workout").addEventListener("click", startOrResume);
  }

  function renderActive() {
    const container = $("#active-workout");
    if (!state.draft) { show(container, false); return; }
    const routine = findRoutine(state.draft.routineId);
    show(container, true);
    const cards = state.draft.exercises.map((item) => {
      const template = routine.exercises.find((exercise) => exercise.id === item.exerciseId) || { reps: "", defaultWeight: null };
      const prior = previousForExercise(item.exerciseId);
      const priorText = prior ? `Last time: ${prior.sets.filter((set) => set.done).map((set) => `${set.reps || "—"} reps @ ${set.weight || "—"}`).join(" · ")}` : "";
      const rows = item.sets.map((set, index) => `<div class="set-row"><span class="set-number">${index + 1}</span><input data-field="weight" data-exercise="${escapeText(item.exerciseId)}" data-set="${escapeText(set.id)}" value="${escapeText(set.weight)}" placeholder="Weight" aria-label="${escapeText(item.name)} set ${index + 1} weight"><input data-field="reps" data-exercise="${escapeText(item.exerciseId)}" data-set="${escapeText(set.id)}" value="${escapeText(set.reps)}" inputmode="numeric" placeholder="Reps" aria-label="${escapeText(item.name)} set ${index + 1} reps"><input class="done-check" data-field="done" data-exercise="${escapeText(item.exerciseId)}" data-set="${escapeText(set.id)}" type="checkbox" ${set.done ? "checked" : ""} aria-label="Complete ${escapeText(item.name)} set ${index + 1}"><button class="remove-set" data-action="remove-set" data-exercise="${escapeText(item.exerciseId)}" data-set="${escapeText(set.id)}" type="button" aria-label="Remove set">×</button></div>`).join("");
      return `<article class="exercise-card"><h3>${escapeText(item.name)}</h3><p class="prescription">Target: ${escapeText(template.sets)} × ${escapeText(template.reps)}${template.defaultWeight ? ` @ ${escapeText(template.defaultWeight)}` : ""}</p><div class="set-labels"><span>Set</span><span>Weight</span><span>Reps</span><span>Done</span></div>${rows}<div class="exercise-actions"><button class="add-set" data-action="add-set" data-exercise="${escapeText(item.exerciseId)}" type="button">+ Add set</button></div>${priorText ? `<p class="prior">${escapeText(priorText)}</p>` : ""}</article>`;
    }).join("");
    container.innerHTML = `<div class="active-header"><div><p class="eyebrow">In progress</p><h2>${escapeText(routine.name)}</h2><p class="active-date">Started ${escapeText(displayTime(state.draft.startedAt))} · ${escapeText(state.draft.workoutDate)}</p></div><button id="cancel-workout" class="text-button" type="button">Discard</button></div>${cards}<div class="finish-area"><p id="finish-copy">When you finish, this session is saved as a permanent workout record and the rotation advances.</p><button id="finish-workout" class="button primary" type="button">Finish workout</button></div>`;
    container.querySelectorAll("[data-field]").forEach((input) => input.addEventListener("input", updateSet));
    container.querySelectorAll("[data-field=done]").forEach((input) => input.addEventListener("change", updateSet));
    container.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", handleSetAction));
    $("#finish-workout").addEventListener("click", finishWorkout);
    $("#cancel-workout").addEventListener("click", discardWorkout);
    if (state.confirmFinish) { $("#finish-copy").textContent = "Tap Finish again to confirm. This cannot be undone."; $("#finish-copy").classList.add("confirm-text"); $("#finish-workout").textContent = "Confirm & finish"; }
  }

  async function updateSet(event) {
    const input = event.currentTarget;
    const item = state.draft.exercises.find((exercise) => exercise.exerciseId === input.dataset.exercise);
    const set = item && item.sets.find((candidate) => candidate.id === input.dataset.set);
    if (!set) return;
    set[input.dataset.field] = input.type === "checkbox" ? input.checked : input.value;
    scheduleDraftSave();
  }
  async function handleSetAction(event) {
    const button = event.currentTarget;
    const item = state.draft.exercises.find((exercise) => exercise.exerciseId === button.dataset.exercise);
    if (!item) return;
    if (button.dataset.action === "add-set") { const template = findRoutine(state.draft.routineId).exercises.find((exercise) => exercise.id === item.exerciseId); const prior = completedPriorSet(item.exerciseId, item.sets.length); item.sets.push({ id: uid("set"), weight: priorOrDefault(prior && prior.weight, template.defaultWeight ?? ""), reps: priorOrDefault(prior && prior.reps, template.reps), done: false }); }
    if (button.dataset.action === "remove-set" && item.sets.length > 1) item.sets = item.sets.filter((set) => set.id !== button.dataset.set);
    await dbPut(STORES.drafts, state.draft); state.confirmFinish = false; renderActive();
  }
  async function startOrResume() { if (!state.draft) { state.draft = makeDraft(routineAt()); await dbPut(STORES.drafts, state.draft); } state.confirmFinish = false; renderNext(); renderActive(); window.scrollTo({ top: 0, behavior: "smooth" }); }
  async function discardWorkout() { if (!window.confirm("Discard this in-progress workout?")) return; await dbDelete(STORES.drafts, "active"); state.draft = null; state.confirmFinish = false; renderNext(); renderActive(); notify("Workout discarded"); }

  async function finishWorkout() {
    if (!state.confirmFinish) { state.confirmFinish = true; renderActive(); return; }
    const completed = { id: state.draft.sessionId, routineId: state.draft.routineId, routineName: findRoutine(state.draft.routineId).name, startedAt: state.draft.startedAt, finishedAt: new Date().toISOString(), workoutDate: state.draft.workoutDate, exercises: state.draft.exercises.map((exercise) => ({ exerciseId: exercise.exerciseId, name: exercise.name, sets: exercise.sets.map((set) => ({ weight: set.weight, reps: set.reps, done: Boolean(set.done) })) })) };
    await dbPut(STORES.sessions, completed); await dbDelete(STORES.drafts, "active"); state.sessions.unshift(completed); state.meta.nextIndex = (state.meta.nextIndex + 1) % state.routines.sequence.length; state.meta.id = "app"; await dbPut(STORES.meta, state.meta); state.draft = null; state.confirmFinish = false; renderAll(); notify(`Finished ${completed.routineName}`); queueForSync(completed).catch(() => {});
  }

  function renderHistory(target = "#recent-history", limit = 3) {
    const container = $(target); const entries = state.sessions.slice(0, limit);
    if (!entries.length) { container.innerHTML = `<div class="empty">No completed workouts yet. Your first finished session will appear here.</div>`; return; }
    container.innerHTML = entries.map((session) => `<button class="history-item" data-session="${escapeText(session.id)}" type="button"><span><strong>${escapeText(session.routineName)}</strong><small>${escapeText(displayDate(session.finishedAt))} · ${session.exercises.reduce((sum, exercise) => sum + exercise.sets.filter((set) => set.done).length, 0)} completed sets</small></span><span class="arrow">→</span></button>`).join("");
    container.querySelectorAll("[data-session]").forEach((button) => button.addEventListener("click", () => showSession(button.dataset.session)));
  }
  function showSession(id) {
    const session = state.sessions.find((item) => item.id === id); if (!session) return;
    const lines = session.exercises.map((exercise) => `<li><strong>${escapeText(exercise.name)}</strong><br>${exercise.sets.map((set) => `${escapeText(set.reps || "—")} reps @ ${escapeText(set.weight || "—")}${set.done ? "" : " (not completed)"}`).join(" · ")}</li>`).join("");
    $("#history-list").innerHTML = `<div class="panel"><p class="eyebrow">${escapeText(session.routineName)}</p><h3>${escapeText(displayDate(session.finishedAt))} · ${escapeText(displayTime(session.finishedAt))}</h3><ul class="session-detail">${lines}</ul><button id="back-from-session" class="text-button" type="button">← All history</button></div>`;
    $("#back-from-session").addEventListener("click", () => { renderHistory("#history-list", state.sessions.length); });
  }

  function switchView(viewId) { ["workout-view", "history-view", "settings-view"].forEach((id) => show(document.getElementById(id), id === viewId)); document.querySelectorAll(".nav-button").forEach((button) => button.classList.toggle("active", button.dataset.view === viewId)); window.scrollTo({ top: 0, behavior: "smooth" }); if (viewId === "history-view") renderHistory("#history-list", state.sessions.length); }
  function renderAll() { renderNext(); renderActive(); renderHistory(); }

  async function queueForSync(session) { const item = { id: session.id, session, status: "pending", attempts: 0, queuedAt: new Date().toISOString() }; await dbPut(STORES.queue, item); setSyncMessage("A completed session is waiting to upload."); attemptSync().catch(() => {}); }
  async function attemptSync() {
    const pending = (await dbAll(STORES.queue)).filter((item) => item.status !== "synced");
    if (!pending.length) { setSyncMessage(state.user ? "All completed sessions are backed up in Supabase; Notion sync runs in the background." : "Cloud backup is inactive; workouts stay on this device."); return; }
    if (!state.user || !state.supabase) { setSyncMessage(`${pending.length} session${pending.length === 1 ? "" : "s"} saved on this device; cloud backup is inactive.`); return; }
    if (!navigator.onLine) { setSyncMessage(`${pending.length} session${pending.length === 1 ? "" : "s"} waiting to upload.`); return; }
    const { data } = await state.supabase.auth.getSession(); const token = data && data.session && data.session.access_token;
    if (!token) return;
    for (const item of pending) {
      try { const response = await fetch(`${config.supabaseUrl}/functions/v1/sync-notion`, { method: "POST", headers: { "Content-Type": "application/json", apikey: config.supabasePublishableKey, Authorization: `Bearer ${token}` }, body: JSON.stringify({ session: item.session }) }); if (!response.ok) throw new Error(`Upload failed (${response.status})`); await dbPut(STORES.queue, { ...item, status: "synced", syncedAt: new Date().toISOString() }); } catch (error) { await dbPut(STORES.queue, { ...item, attempts: item.attempts + 1, lastError: error.message }); break; }
    }
    const left = (await dbAll(STORES.queue)).filter((item) => item.status !== "synced").length; setSyncMessage(left ? `${left} session${left === 1 ? "" : "s"} waiting to upload.` : "All completed sessions are backed up in Supabase; Notion sync runs in the background.");
  }

  function initAuth() {
    const canUseSupabase = window.supabase && config.supabaseUrl && config.supabasePublishableKey;
    if (!canUseSupabase) { attemptSync().catch(() => {}); return; }
    state.supabase = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    state.supabase.auth.getSession().then(({ data }) => updateAuth(data && data.session ? data.session.user : null));
    state.supabase.auth.onAuthStateChange((_event, session) => updateAuth(session ? session.user : null));
  }
  function updateAuth(user) { state.user = user; show($("#signed-in"), Boolean(user)); show($("#signed-out"), !user); $("#signed-in-email").textContent = user ? `Signed in as ${user.email}` : ""; setSyncMessage("Checking sync queue…"); attemptSync().catch(() => {}); }

  async function requestOwnerLogin(event) {
    event.preventDefault(); const form = event.currentTarget; const message = $("#login-message"); const email = $("#owner-email").value.trim(); if (!email || !state.supabase) return;
    const button = form.querySelector("button[type=submit]"); button.disabled = true; message.textContent = "Sending a sign-in link…";
    try { const { error } = await state.supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: window.location.href } }); if (error) throw error; message.textContent = "If this email is eligible, a sign-in link is on its way. Check your inbox."; form.reset(); } catch (_error) { message.textContent = "If this email is eligible, a sign-in link is on its way. Check your inbox."; } finally { button.disabled = false; }
  }

  async function resetRotation() {
    const button = $("#reset-rotation"); if (button.dataset.confirm !== "yes") { button.dataset.confirm = "yes"; button.textContent = "Tap again to confirm"; $("#reset-message").textContent = "This changes only the next workout; completed history is kept."; setTimeout(() => { button.dataset.confirm = ""; button.textContent = "Reset to Push A"; }, 4000); return; }
    state.meta.nextIndex = 0; await dbPut(STORES.meta, { id: "app", nextIndex: 0 }); button.dataset.confirm = ""; button.textContent = "Reset to Push A"; $("#reset-message").textContent = "Rotation reset. Push A is next."; renderAll();
  }

  function bindEvents() {
    window.addEventListener("online", () => { setNetworkStatus(); attemptSync().catch(() => {}); }); window.addEventListener("offline", setNetworkStatus); setNetworkStatus();
    $("#owner-login").addEventListener("submit", requestOwnerLogin); $("#sign-out").addEventListener("click", () => { if (state.supabase && window.confirm("Sign out? Cloud backup will stop. Your workout history will remain on this device.")) state.supabase.auth.signOut(); });
    $("#show-history").addEventListener("click", () => switchView("history-view")); $("#back-to-workout").addEventListener("click", () => switchView("workout-view")); $("#settings-button").addEventListener("click", () => switchView("settings-view")); $("#close-settings").addEventListener("click", () => switchView("workout-view")); $("#reset-rotation").addEventListener("click", resetRotation); document.querySelectorAll(".nav-button").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  }
  async function init() { bindEvents(); try { const response = await fetch("./routines.json"); state.routines = await response.json(); await loadState(); renderAll(); initAuth(); if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {}); } catch (error) { $("#next-card").innerHTML = `<p class="muted">Could not load routines. ${escapeText(error.message)}</p>`; } }
  init();
})();
