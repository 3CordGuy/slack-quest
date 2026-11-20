// The market stall: gear and materials sold to it, the day's stock and
// furniture bought from it. Sending a piece of gear home from the pack is
// here too, beside the other thing done with one.

import { buyFurniture, buyShopItem, getShop, refreshHut, sellFurniture, sellItem, sellMaterial, storeItem } from "../db";
import type { GameApp } from "./shared";

export function stallRoutes(app: GameApp): void {
  // Send an unequipped item to the storage chest at home. Allowed from anywhere; taking it back is only done inside the hut.
  app.post("/api/inventory/store", async (c) => {
    const player = c.get("player");
    const body = await c.req.json<{ itemId?: number }>().catch(() => ({}) as { itemId?: number });
    const error = await storeItem(c.env.DB, player.id, Number(body.itemId));
    if (error) return c.json({ error }, 409);
    // If they are standing in their hut (another tab), the chest there shows it.
    c.executionCtx.waitUntil(refreshHut(c.env, player.id));
    return c.json({ ok: true });
  });

  // ---------- the market stall ----------

  app.post("/api/inventory/sell", async (c) => {
    const body = await c.req.json<{ itemId?: number }>().catch(() => ({}) as { itemId?: number });
    const result = await sellItem(c.env.DB, c.get("player").id, Number(body.itemId));
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json({ gold: result });
  });

  // Sell foraged materials (herbs, mushrooms) to the stall. The price is the catalogue's.
  app.post("/api/shop/materials/sell", async (c) => {
    const body = await c.req.json<{ kind?: unknown; qty?: unknown }>().catch(() => ({}) as { kind?: unknown; qty?: unknown });
    const result = await sellMaterial(c.env.DB, c.get("player").id, body.kind, body.qty);
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

  // Sell a stored piece of furniture back to the stall, for half its stall price.
  app.post("/api/shop/furniture/sell", async (c) => {
    const player = c.get("player");
    const body = await c.req.json<{ furnishingId?: unknown }>().catch(() => ({}) as { furnishingId?: unknown });
    const result = await sellFurniture(c.env.DB, player.id, body.furnishingId);
    if (typeof result === "string") return c.json({ error: result }, 409);
    // Written to D1 above; now the room they are standing in drops the piece from storage.
    await refreshHut(c.env, player.id);
    return c.json({ gold: result });
  });
}
