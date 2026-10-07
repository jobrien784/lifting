import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("./app.js", import.meta.url), "utf8");
const serviceWorker = await readFile(new URL("./sw.js", import.meta.url), "utf8");
assert.match(app, /async function backfillSyncQueue\(\)/);
assert.match(app, /const queuedIds = new Set\(queued\.map\(\(item\) => item\.id\)\)/);
assert.match(app, /if \(!queuedIds\.has\(session\.id\)\) await dbPut\(STORES\.queue/);
assert.match(app, /await loadState\(\); await backfillSyncQueue\(\); renderAll\(\); initAuth\(\)/);
assert.match(serviceWorker, /lifting-shell-v6/);
console.log("local history backfill static checks passed");
