import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
assert.match(source, /const text = String\(v \?\? ""\)\.trim\(\); if \(!text\) return null;/);
assert.match(source, /if \(reps !== null\) props\.Reps = \{ number: reps \};/);
assert.match(await readFile(new URL("../../migrations/202610070001_durable_notion_queue.sql", import.meta.url), "utf8"), /grant execute on function public\.claim_lifting_notion_sessions\(integer, interval\) to service_role;/);
console.log("worker static checks passed");
