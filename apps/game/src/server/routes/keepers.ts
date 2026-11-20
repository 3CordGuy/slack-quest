// The keepers' rooms: the apothecary (making flasks, and the shelf), the smithy
// (work on gear, and the rack), haggling with either of them, and the galley,
// where there is only the room.

import { announceXp } from "../harbor-xp";
import { apothecaryView, brewFlask, buyFromKeeper, galleyView, haggle, smithItem, smithyView } from "../workshops";
import type { GameApp } from "./shared";

export function keeperRoutes(app: GameApp): void {
  // ---------- the apothecary and the smithy ----------

  // The apothecary's shelf as this hero sees it today, what they carry of each flask, and the materials they could make more with.
  app.get("/api/apothecary", async (c) => c.json(await apothecaryView(c.env.DB, c.get("player").id)));

  // Make one potion, flask or bomb for the pack. The recipe is the catalogue's; the client names only the kind.
  app.post("/api/apothecary/flask", async (c) => {
    const player = c.get("player");
    const body = await c.req.json<{ kind?: unknown }>().catch(() => ({}) as { kind?: unknown });
    const result = await brewFlask(c.env.DB, player.id, String(body.kind ?? ""));
    if (typeof result === "string") return c.json({ error: result }, 409);
    if (result.xp) c.executionCtx.waitUntil(announceXp(c.env, player.id, result.xp));
    return c.json({ ...(await apothecaryView(c.env.DB, player.id)), xp: result.xp });
  });

  // The weapons and armour this hero has with them, and what the next step on each would cost.
  app.get("/api/smithy", async (c) => c.json(await smithyView(c.env.DB, c.get("player").id)));

  // Sharpen a weapon or reinforce armour by one step. The price is the catalogue's, for the step the item is on.
  app.post("/api/smithy/work", async (c) => {
    const player = c.get("player");
    const body = await c.req.json<{ itemId?: unknown }>().catch(() => ({}) as { itemId?: unknown });
    const result = await smithItem(c.env.DB, player.id, body.itemId);
    if (typeof result === "string") return c.json({ error: result }, 409);
    if (result.xp) c.executionCtx.waitUntil(announceXp(c.env, player.id, result.xp));
    return c.json({ ...(await smithyView(c.env.DB, player.id)), worked: result.name, xp: result.xp });
  });

  // Buy something ready-made off the apothecary's shelf, or off the smith's rack. The client names only the
  // entry; the price is the day's for this customer, after any haggling.
  app.post("/api/apothecary/buy", async (c) => {
    const player = c.get("player");
    const body = await c.req.json<{ key?: unknown }>().catch(() => ({}) as { key?: unknown });
    const result = await buyFromKeeper(c.env.DB, player.id, "apothecary", body.key);
    if (typeof result === "string") return c.json({ error: result }, 409);
    return c.json({ ...(await apothecaryView(c.env.DB, player.id)), got: result.got });
  });

  app.post("/api/smithy/buy", async (c) => {
    const player = c.get("player");
    const body = await c.req.json<{ key?: unknown }>().catch(() => ({}) as { key?: unknown });
    const result = await buyFromKeeper(c.env.DB, player.id, "smithy", body.key);
    if (typeof result === "string") return c.json({ error: result }, 409);
    return c.json({ ...(await smithyView(c.env.DB, player.id)), got: result.got });
  });

  // Ask a keeper to take something off a price: one try a day for each thing. The server rolls for it.
  app.post("/api/keeper/haggle", async (c) => {
    const body = await c.req.json<{ shop?: unknown; key?: unknown; ask?: unknown }>().catch(() => ({}) as { shop?: unknown; key?: unknown; ask?: unknown });
    const result = await haggle(c.env.DB, c.get("player").id, body.shop, body.key, body.ask);
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
  });

  // ---------- the galley ----------

  // Whether this player's crew has built the galley. The cook sells and makes nothing, so there is nothing else to say.
  app.get("/api/galley", async (c) => c.json(await galleyView(c.env.DB, c.get("player").id)));
}
