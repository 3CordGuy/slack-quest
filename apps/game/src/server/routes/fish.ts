// Fish once caught: the icebox and the trophy chest, selling them, the
// Catch Book, the pub's wall and a fish hung at home.

import { catchBook, hangAtHome, mountInPub, pubWall, unmountInPub } from "../catchbook";
import { fishStock, moveFish, sellFish } from "../fishmarket";
import type { GameApp } from "./shared";

export function fishRoutes(app: GameApp): void {
  // ---------- fish: the icebox, the trophy chest, and selling them ----------

  app.get("/api/fish", async (c) => c.json(await fishStock(c.env.DB, c.get("player").id)));

  // Sell kept fish to the fishmonger ("market") or Old Tam ("tam"). The server prices every one.
  app.post("/api/fish/sell", async (c) => {
    const body = await c.req.json<{ ids?: unknown; to?: unknown }>().catch(() => ({}) as { ids?: unknown; to?: unknown });
    const result = await sellFish(c.env.DB, c.get("player").id, body.ids, body.to);
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
  });

  // Move a kept fish between the icebox and the trophy chest.
  app.post("/api/fish/move", async (c) => {
    const body = await c.req.json<{ id?: unknown; to?: unknown }>().catch(() => ({}) as { id?: unknown; to?: unknown });
    const result = await moveFish(c.env.DB, c.get("player").id, body.id, body.to);
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
  });

  // The Catch Book, the crew's records and the pub wall, and hanging fish at home.
  app.get("/api/fish/book", async (c) => c.json(await catchBook(c.env.DB, c.get("player").id)));
  app.get("/api/fish/wall", async (c) => {
    const result = await pubWall(c.env.DB, c.get("player").id);
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
  });
  app.post("/api/fish/wall", async (c) => {
    const body = await c.req.json<{ fishId?: unknown; down?: boolean }>().catch(() => ({}) as { fishId?: unknown; down?: boolean });
    const id = c.get("player").id;
    const result = body.down ? await unmountInPub(c.env.DB, id, body.fishId) : await mountInPub(c.env.DB, id, body.fishId);
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
  });
  app.post("/api/fish/hang", async (c) => {
    const body = await c.req.json<{ furnishingId?: unknown; fishId?: unknown }>().catch(() => ({}) as { furnishingId?: unknown; fishId?: unknown });
    const result = await hangAtHome(c.env, c.get("player").id, body.furnishingId, body.fishId ?? null);
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
  });
}
