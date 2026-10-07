import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("./app.js", import.meta.url), "utf8");
const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const serviceWorker = await readFile(new URL("./sw.js", import.meta.url), "utf8");
assert.match(app, /signInWithOtp\(\{ email, options: \{ shouldCreateUser: false/);
assert.match(app, /If this email is eligible, a sign-in link is on its way/);
assert.match(app, /attemptSync\(\)\.catch\(\(\) => \{\}\)/);
assert.match(html, /id="owner-login"/);
assert.match(serviceWorker, /lifting-shell-v7/);
assert.doesNotMatch(app + html, /ALLOWED_USER_ID|NOTION_TOKEN/i);
console.log("owner login static checks passed");
