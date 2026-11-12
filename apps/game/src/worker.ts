// Worker entry for the overworld game: the Harbor's HTTP API (accounts,
// characters, inventory, launching a voyage) and the WebSocket route into
// each voyage's RunRoom Durable Object.

import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HERO_CLASSES, MAX_CREW, hutPerks, makeRng, rollStartingStats } from "@gantt-quest/world";
import { sendSignInCode } from "./server/email";
import {
  attachEmail,
  buyShopItem,
  consumeEmailCode,
  createPlayerWithEmail,
  createSession,
  deleteSession,
  issueEmailCode,
  normalizeEmail,
  playerByEmail,
  confirmCharacter,
  createCrew,
  createGuest,
  createRun,
  crewFor,
  deleteCharacter,
  equipItem,
  getCharacter,
  getHut,
  getInventory,
  getRun,
  getShop,
  joinCrew,
  leaveCrew,
  playerForToken,
  refreshHarbor,
  saveDraft,
  sellItem,
  spendPoint,
  unequipItem,
  type Env,
  type Player,
} from "./server/db";

export { HarborRoom } from "./server/harbor-room";
export { HutRoom } from "./server/hut-room";
export { RunRoom } from "./server/run-room";

type App = { Bindings: Env; Variables: { player: Player } };
const app = new Hono<App>();

/**
 * Session cookie name. An optional profile (?p=2 or the x-gq-profile header)
 * gives each browser tab its own guest, which is how two players are tested
 * on one machine.
 */
function cookieName(c: Context<App>): string {
  const profile = (c.req.header("x-gq-profile") ?? c.req.query("p") ?? "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(profile) ? `gq_session_${profile}` : "gq_session";
}

function setSession(c: Context<App>, token: string) {
  setCookie(c, cookieName(c), token, { httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:", path: "/", maxAge: 60 * 60 * 24 * 365 });
}

app.post("/api/auth/guest", async (c) => {
  const { player, token } = await createGuest(c.env.DB, "Guest");
  setSession(c, token);
  return c.json({ player });
});

// ---------- email sign-in ----------

// Send a six-digit code. The reply is the same whether or not the address has an account.
app.post("/api/auth/email/request", async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: "That does not look like an email address." }, 400);
  const code = await issueEmailCode(c.env.DB, email);
  if (code === "wait") return c.json({ error: "A code was just sent. Give it half a minute before asking again." }, 429);
  if (!(await sendSignInCode(c.env, email, code))) return c.json({ error: "The email could not be sent. Try again shortly." }, 502);
  return c.json({ ok: true });
});

// Check the code, then either sign in to the account that owns the address,
// or attach the address to the guest who asked, keeping everything they have.
app.post("/api/auth/email/verify", async (c) => {
  const body = await c.req.json<{ email?: string; code?: string }>().catch(() => ({}) as { email?: string; code?: string });
  const email = normalizeEmail(body.email);
  const code = String(body.code ?? "").replace(/\D/g, "");
  if (!email || code.length !== 6) return c.json({ error: "Enter the six-digit code from the email." }, 400);
  if (!(await consumeEmailCode(c.env.DB, email, code))) return c.json({ error: "That code is wrong or has expired. Ask for a new one." }, 401);

  const token = getCookie(c, cookieName(c));
  const current = token ? await playerForToken(c.env.DB, token) : null;
  const owner = await playerByEmail(c.env.DB, email);

  if (owner) {
    if (current?.id === owner.id) return c.json({ outcome: "already" });
    // An account already has this address: switch to it. Whatever guest was here stays behind.
    if (token) await deleteSession(c.env.DB, token);
    setSession(c, await createSession(c.env.DB, owner.id));
    return c.json({ outcome: "signed_in" });
  }
  if (current && !current.email && (await attachEmail(c.env.DB, current.id, email))) return c.json({ outcome: "linked" });
  // No guest to keep (or it already has another address): start a fresh account for this one.
  const player = await createPlayerWithEmail(c.env.DB, email);
  if (token) await deleteSession(c.env.DB, token);
  setSession(c, await createSession(c.env.DB, player.id));
  return c.json({ outcome: "created" });
});

app.post("/api/auth/signout", async (c) => {
  const token = getCookie(c, cookieName(c));
  if (token) await deleteSession(c.env.DB, token);
  deleteCookie(c, cookieName(c), { path: "/" });
  return c.json({ ok: true });
});

app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/")) return next();
  const token = getCookie(c, cookieName(c));
  const player = token ? await playerForToken(c.env.DB, token) : null;
  if (!player) return c.json({ error: "not signed in" }, 401);
  c.set("player", player);
  return next();
});

app.get("/api/me", async (c) => {
  const player = c.get("player");
  const [character, inventory, crew] = await Promise.all([
    getCharacter(c.env.DB, player.id),
    getInventory(c.env.DB, player.id),
    crewFor(c.env.DB, player.id),
  ]);
  return c.json({ player, character, inventory, crew });
});

// Roll (or re-roll) starting stats for a character that is still a draft.
app.post("/api/character/roll", async (c) => {
  const player = c.get("player");
  const body = await c.req.json<{ classId?: string; name?: string }>().catch(() => ({}) as { classId?: string; name?: string });
  const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 20) return c.json({ error: "Name must be 2 to 20 characters." }, 400);
  if (!HERO_CLASSES.some((k) => k.id === body.classId)) return c.json({ error: "Unknown class." }, 400);
  const existing = await getCharacter(c.env.DB, player.id);
  if (existing?.status === "active") return c.json({ error: "You already have a character." }, 409);
  const rng = makeRng(crypto.getRandomValues(new Uint32Array(1))[0]);
  await saveDraft(c.env.DB, player.id, name, body.classId!, rollStartingStats(rng, body.classId!));
  return c.json({ character: await getCharacter(c.env.DB, player.id) });
});

app.post("/api/character/confirm", async (c) => {
  const ok = await confirmCharacter(c.env.DB, c.get("player").id);
  return ok ? c.json({ ok }) : c.json({ error: "Nothing to confirm." }, 409);
});

// Discards the character and all its gear; the player starts creation again.
app.post("/api/character/reroll", async (c) => {
  const player = c.get("player");
  await deleteCharacter(c.env.DB, player.id);
  // Their hut and roster entry disappear until the new character is confirmed.
  c.executionCtx.waitUntil(crewFor(c.env.DB, player.id).then((crew) => refreshHarbor(c.env, crew?.id ?? null)));
  return c.json({ ok: true });
});

app.post("/api/character/spend", async (c) => {
  const body = await c.req.json<{ stat?: string }>().catch(() => ({}) as { stat?: string });
  const ok = await spendPoint(c.env.DB, c.get("player").id, String(body.stat));
  return ok ? c.json({ ok }) : c.json({ error: "No points to spend." }, 409);
});

app.post("/api/character/equip", async (c) => {
  const body = await c.req.json<{ itemId?: number }>().catch(() => ({}) as { itemId?: number });
  const error = await equipItem(c.env.DB, c.get("player").id, Number(body.itemId));
  return error ? c.json({ error }, 409) : c.json({ ok: true });
});

app.post("/api/character/unequip", async (c) => {
  const body = await c.req.json<{ itemId?: number }>().catch(() => ({}) as { itemId?: number });
  const error = await unequipItem(c.env.DB, c.get("player").id, Number(body.itemId));
  return error ? c.json({ error }, 409) : c.json({ ok: true });
});

// ---------- the market stall ----------

app.post("/api/inventory/sell", async (c) => {
  const body = await c.req.json<{ itemId?: number }>().catch(() => ({}) as { itemId?: number });
  const result = await sellItem(c.env.DB, c.get("player").id, Number(body.itemId));
  return typeof result === "string" ? c.json({ error: result }, 409) : c.json({ gold: result });
});

app.get("/api/shop", async (c) => {
  const shop = await getShop(c.env.DB, c.get("player").id);
  return shop ? c.json(shop) : c.json({ error: "Create a character first." }, 409);
});

app.post("/api/shop/buy", async (c) => {
  const body = await c.req.json<{ index?: number }>().catch(() => ({}) as { index?: number });
  const error = await buyShopItem(c.env.DB, c.get("player").id, Number(body.index));
  return error ? c.json({ error }, 409) : c.json({ ok: true });
});

// ---------- huts ----------

// Everything the player owns for their hut, and the perks it currently gives.
app.get("/api/hut", async (c) => {
  const hut = await getHut(c.env.DB, c.get("player").id);
  return c.json({ ...hut, perks: hutPerks(hut.furnishings) });
});

// ---------- crews and the shared Harbor ----------

app.post("/api/crew", async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 30) return c.json({ error: "Crew name must be 2 to 30 characters." }, 400);
  return c.json({ crew: await createCrew(c.env.DB, c.get("player").id, name) });
});

app.post("/api/crew/join", async (c) => {
  const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
  const code = String(body.code ?? "").toUpperCase();
  const before = await crewFor(c.env.DB, c.get("player").id);
  const crew = /^[A-Z]{6}$/.test(code) ? await joinCrew(c.env.DB, c.get("player").id, code, MAX_CREW) : null;
  if (!crew) return c.json({ error: "No crew with that code, or it is full." }, 404);
  if (before && before.id !== crew.id) c.executionCtx.waitUntil(refreshHarbor(c.env, before.id));
  return c.json({ crew });
});

app.post("/api/crew/leave", async (c) => {
  const crew = await crewFor(c.env.DB, c.get("player").id);
  await leaveCrew(c.env.DB, c.get("player").id);
  c.executionCtx.waitUntil(refreshHarbor(c.env, crew?.id ?? null));
  return c.json({ ok: true });
});

app.get("/api/crew/ws", async (c) => {
  const player = c.get("player");
  const [crew, character] = await Promise.all([crewFor(c.env.DB, player.id), getCharacter(c.env.DB, player.id)]);
  if (!crew) return c.text("You are not in a crew.", 403);
  if (character?.status !== "active") return c.text("Create a character first.", 409);
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-crew-id", crew.id);
  headers.set("x-player-id", player.id);
  headers.set("x-player-name", encodeURIComponent(character.name));
  headers.set("x-player-class", character.class_id);
  headers.set("x-player-level", String(character.level));
  return c.env.HARBOR_ROOM.get(c.env.HARBOR_ROOM.idFromName(crew.id)).fetch(new Request(c.req.url, { headers }));
});

// Launch a voyage: allocates a run code and moors the ship at the crew's Harbor.
// The island is generated from the run's seed.
app.post("/api/run", async (c) => {
  const player = c.get("player");
  const [character, crew] = await Promise.all([getCharacter(c.env.DB, player.id), crewFor(c.env.DB, player.id)]);
  if (character?.status !== "active") return c.json({ error: "Create a character first." }, 409);
  const code = await createRun(c.env.DB, player.id, crew?.id ?? null);
  c.executionCtx.waitUntil(refreshHarbor(c.env, crew?.id ?? null));
  return c.json({ code });
});

app.get("/api/run/:code/ws", async (c) => {
  const code = c.req.param("code").toUpperCase();
  if (!(await getRun(c.env.DB, code))) return c.text("No ship with that code.", 404);
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-run-code", code);
  headers.set("x-player-id", c.get("player").id);
  const stub = c.env.RUN_ROOM.get(c.env.RUN_ROOM.idFromName(code));
  return stub.fetch(new Request(c.req.url, { headers }));
});

export default app;
