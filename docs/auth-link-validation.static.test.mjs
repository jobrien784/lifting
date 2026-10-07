import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("./app.js", import.meta.url), "utf8");
assert.match(app, /link\.protocol !== "https:"/);
assert.match(app, /link\.origin !== project\.origin/);
assert.match(app, /link\.pathname !== "\/auth\/v1\/verify"/);

function isSafeAuthLink(value, appOrigin = "https://lifting.example") {
  try {
    const link = new URL(value); const project = new URL("https://ozbelrgikdhztjsbvevu.supabase.co"); const redirect = link.searchParams.get("redirect_to");
    if (link.protocol !== "https:" || link.origin !== project.origin || link.pathname !== "/auth/v1/verify" || link.username || link.password || !link.searchParams.get("token") || !link.searchParams.get("type")) return false;
    return !redirect || new URL(redirect).origin === appOrigin;
  } catch (_error) { return false; }
}
const good = "https://ozbelrgikdhztjsbvevu.supabase.co/auth/v1/verify?token=opaque&type=magiclink&redirect_to=https%3A%2F%2Flifting.example%2F";
assert.equal(isSafeAuthLink(good), true);
for (const bad of [
  good.replace("https://ozbelrgikdhztjsbvevu.supabase.co", "https://evil.example"),
  good.replace("https:", "http:"),
  good.replace("/auth/v1/verify", "/auth/v1/callback"),
  good.replace("token=opaque", "token="),
  good.replace("redirect_to=https%3A%2F%2Flifting.example%2F", "redirect_to=https%3A%2F%2Fevil.example%2F")
]) assert.equal(isSafeAuthLink(bad), false);
console.log("auth link validation static checks passed");
