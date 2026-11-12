// Worker entry for the overworld game: the Harbor's HTTP API (accounts,
// characters, inventory, launching a voyage) and the WebSocket route into
// each voyage's RunRoom Durable Object.

import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HARBOR_PIERS, HARBOR_PLOTS, HERO_CLASSES, MAX_CREW, PUB_MAX_TALK, PUB_MENU, hutPerks, makeRng, pubBuff, rollStartingStats } from "@gantt-quest/world";
import { barkeepReply } from "./server/ai";
import { noticeBoard } from "./server/board";
import { sendSignInCode } from "./server/email";
import {
  attachEmail,
  buyFurniture,
  buyShopItem,
  craftFurnishing,
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
  refreshHut,
  saveDraft,
  sellItem,
  spendPoint,
  unequipItem,
  upgradeHut,
  type Env,
  type Player,
  harborBoard,
  orderAtPub,
  pubOrders,
  buyPlot,
  plotOf,
} from "./server/db";

import { enterHut } from "./server/hut-room";
import { enterPub } from "./server/pub-room";
import { gatherStatus, rest, startOuting, stepOuting } from "./server/gather";
import { builtProjectIds, contribute, crewWorks, projectStock } from "./server/projects";

export { HarborRoom } from "./server/harbor-room";
export { HutRoom } from "./server/hut-room";
export { PubRoom } from "./server/pub-room";
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

// Furniture for gold. Only the piece is named here; the price comes from the catalogue.
app.post("/api/shop/furniture", async (c) => {
  const player = c.get("player");
  const body = await c.req.json<{ defId?: string }>().catch(() => ({}) as { defId?: string });
  const error = await buyFurniture(c.env.DB, player.id, String(body.defId));
  if (error) return c.json({ error }, 409);
  // If they are somehow inside their hut (another tab), its storage list updates.
  c.executionCtx.waitUntil(refreshHut(c.env, player.id));
  return c.json({ ok: true });
});

// ---------- huts ----------

// Everything the player owns for their hut, the perks it currently gives, and the gold they could spend on it.
app.get("/api/hut", async (c) => {
  const player = c.get("player");
  const [hut, character] = await Promise.all([getHut(c.env.DB, player.id), getCharacter(c.env.DB, player.id)]);
  return c.json({ ...hut, perks: hutPerks(hut.furnishings), gold: character?.gold ?? 0 });
});

// Build a furnishing from materials. It lands in storage.
app.post("/api/hut/craft", async (c) => {
  const player = c.get("player");
  const body = await c.req.json<{ defId?: string }>().catch(() => ({}) as { defId?: string });
  const error = await craftFurnishing(c.env.DB, player.id, String(body.defId));
  if (error) return c.json({ error }, 409);
  // Written to D1 above; now the room they are standing in is told.
  await refreshHut(c.env, player.id);
  return c.json({ ok: true });
});

// Make the hut one tier bigger, for the gold and materials in HUT_TIERS.
app.post("/api/hut/upgrade", async (c) => {
  const player = c.get("player");
  const result = await upgradeHut(c.env.DB, player.id);
  if (typeof result === "string") return c.json({ error: result }, 409);
  await refreshHut(c.env, player.id);
  // The building in the Harbor grows too.
  c.executionCtx.waitUntil(crewFor(c.env.DB, player.id).then((crew) => refreshHarbor(c.env, crew?.id ?? null)));
  return c.json(result);
});

// Walk into a hut's room: your own, or a crewmate's.
app.get("/api/hut/:owner/ws", (c) => enterHut(c.env, c.get("player"), c.req.param("owner"), c.req.raw));

// ---------- the pub ----------

app.get("/api/pub/ws", (c) => enterPub(c.env, c.get("player"), c.req.raw));

// What this hero has eaten and drunk, and what it will give them on their next voyage.
app.get("/api/pub", async (c) => {
  const orders = await pubOrders(c.env.DB, c.get("player").id);
  return c.json({ orders, buff: pubBuff(orders) });
});

// Order off the menu. The price is the menu's; a second drink or meal replaces the first.
app.post("/api/pub/order", async (c) => {
  const player = c.get("player");
  const body = await c.req.json<{ itemId?: unknown }>().catch(() => ({}) as { itemId?: unknown });
  const result = await orderAtPub(c.env.DB, player.id, String(body.itemId ?? ""));
  if (typeof result === "string") return c.json({ error: result }, 409);
  const orders = await pubOrders(c.env.DB, player.id);
  return c.json({ orders, buff: pubBuff(orders), rested: result.rested });
});

// A word with the barkeep. He only talks: nothing he says changes anything.
app.post("/api/pub/talk", async (c) => {
  const player = c.get("player");
  const body = await c.req.json<{ text?: unknown }>().catch(() => ({}) as { text?: unknown });
  const text = String(body.text ?? "").replace(/\s+/g, " ").trim().slice(0, PUB_MAX_TALK);
  if (!text) return c.json({ error: "Say something first." }, 400);
  const [character, crew] = await Promise.all([getCharacter(c.env.DB, player.id), crewFor(c.env.DB, player.id)]);
  if (character?.status !== "active" || !crew) return c.json({ error: "The pub is for crews." }, 409);
  const [board, harbor] = await Promise.all([noticeBoard(c.env.DB, crew.id), harborBoard(c.env.DB, crew.id, HARBOR_PIERS.length)]);
  const facts = [
    ...PUB_MENU.map((i) => `On the board: ${i.name}, ${i.price} gold (${i.kind}). ${i.blurb}`),
    "A hero can carry one drink and one meal into their next voyage; they do a little good there and are gone after.",
    "There is a dice table in the pub where crewmates bluff each other for a small stake.",
    ...(board.goal ? [`The crew's goal this week: ${board.goal.text}.`] : []),
    ...harbor.log.slice(0, 3).map((v) => `Recent voyage: "${v.title}" ended in ${v.outcome === "victory" ? "a win" : v.outcome === "defeat" ? "a loss" : v.outcome}, sailed by ${v.crew.join(", ") || "nobody he knows"}.`),
  ];
  return c.json({ say: await barkeepReply(c.env, { hero: character.name, crew: crew.name, text, facts }) });
});

// ---------- the notice board ----------

// The crew's goal for the week and the contracts a hero can take aboard a ship.
app.get("/api/board", async (c) => {
  const crew = await crewFor(c.env.DB, c.get("player").id);
  return c.json(await noticeBoard(c.env.DB, crew?.id ?? null));
});

// ---------- gathering: fishing, felling and the quarry ----------

// Stamina left today, the hero's chance at each spot, and any outing in progress.
app.get("/api/gather", async (c) => {
  const result = await gatherStatus(c.env.DB, c.get("player").id);
  return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
});

app.post("/api/gather/start", async (c) => {
  const body = await c.req.json<{ spot?: string }>().catch(() => ({}) as { spot?: string });
  const result = await startOuting(c.env.DB, c.get("player").id, body.spot);
  return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
});

// One choice: push on or bank. The server rolls; the reply is what the player may see.
app.post("/api/gather/step", async (c) => {
  const body = await c.req.json<{ choice?: unknown }>().catch(() => ({}) as { choice?: unknown });
  const result = await stepOuting(c.env.DB, c.get("player").id, body.choice);
  return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
});

// Rest: on a bedroll in the Harbor, or at home if you have a hut. Gives back gathering stamina, on a cooldown.
app.post("/api/rest", async (c) => {
  const player = c.get("player");
  const body = await c.req.json<{ place?: unknown }>().catch(() => ({}) as { place?: unknown });
  const place = body.place === "hut" ? "hut" : "bedroll";
  if (place === "hut" && (await plotOf(c.env.DB, player.id)) === null) return c.json({ error: "You have no hut to rest in yet." }, 409);
  const result = await rest(c.env.DB, player.id, place);
  return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
});

// Buy a plot of land in the crew's Harbor: the ground a hut stands on.
app.post("/api/hut/plot", async (c) => {
  const player = c.get("player");
  const body = await c.req.json<{ plot?: unknown }>().catch(() => ({}) as { plot?: unknown });
  const crew = await crewFor(c.env.DB, player.id);
  if (!crew) return c.json({ error: "Join a crew first." }, 409);
  const error = await buyPlot(c.env.DB, crew.id, player.id, Number(body.plot), HARBOR_PLOTS.length);
  if (error) return c.json({ error }, 409);
  c.executionCtx.waitUntil(refreshHarbor(c.env, crew.id));
  return c.json({ plot: Number(body.plot) });
});

// ---------- Harbor projects ----------

// The crew's shared projects, and what this player has to give toward them.
app.get("/api/projects", async (c) => {
  const player = c.get("player");
  const crew = await crewFor(c.env.DB, player.id);
  if (!crew) return c.json({ error: "Join a crew first." }, 409);
  const [works, stock] = await Promise.all([crewWorks(c.env.DB, crew.id), projectStock(c.env.DB, player.id)]);
  return c.json({ works, stock });
});

// Give gold or materials toward a project. The server checks the gift; everyone in the Harbor then sees it.
app.post("/api/projects/give", async (c) => {
  const player = c.get("player");
  const body = await c.req.json<{ projectId?: unknown; give?: unknown }>().catch(() => ({}) as { projectId?: unknown; give?: unknown });
  const crew = await crewFor(c.env.DB, player.id);
  if (!crew) return c.json({ error: "Join a crew first." }, 409);
  const result = await contribute(c.env.DB, crew.id, player.id, String(body.projectId ?? ""), body.give);
  if ("error" in result) return c.json({ error: result.error }, 409);
  c.executionCtx.waitUntil(refreshHarbor(c.env, crew.id));
  const [works, stock] = await Promise.all([crewWorks(c.env.DB, crew.id), projectStock(c.env.DB, player.id)]);
  return c.json({ works, stock, completed: result.completed });
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
  // What the crew has built at the Harbor sails with the ship.
  const code = await createRun(c.env.DB, player.id, crew?.id ?? null, await builtProjectIds(c.env.DB, crew?.id ?? null));
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
