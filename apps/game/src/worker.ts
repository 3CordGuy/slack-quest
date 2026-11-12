// Worker entry for the overworld game: the Harbor's HTTP API (accounts,
// characters, inventory, launching a voyage) and the WebSocket route into
// each voyage's RunRoom Durable Object.

import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HERO_CLASSES, MAX_CREW, makeRng, rollStartingStats } from "@gantt-quest/world";
import {
  buyShopItem,
  confirmCharacter,
  createCrew,
  createGuest,
  createRun,
  crewFor,
  deleteCharacter,
  equipItem,
  getCharacter,
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

app.post("/api/auth/guest", async (c) => {
  const { player, token } = await createGuest(c.env.DB, "Guest");
  setCookie(c, cookieName(c), token, { httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return c.json({ player });
});

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/auth/guest") return next();
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
