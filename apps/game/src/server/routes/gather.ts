// Gathering: fishing, felling and the quarry (an outing started, and
// each choice in it), and the rest that gives stamina back.

import { hasShack } from "../db";
import { gatherStatus, rest, startOuting, stepOuting } from "../gather";
import { announceXp } from "../harbor-xp";
import { inOwnHut, type GameApp } from "./shared";

export function gatherRoutes(app: GameApp): void {
  // ---------- gathering: fishing, felling and the quarry ----------

  // Stamina left today, the hero's chance at each spot, and any outing in progress.
  app.get("/api/gather", async (c) => {
    const result = await gatherStatus(c.env.DB, c.get("player").id);
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
  });

  app.post("/api/gather/start", async (c) => {
    const body = await c.req.json<{ spot?: string; pier?: string }>().catch(() => ({}) as { spot?: string; pier?: string });
    const result = await startOuting(c.env.DB, c.get("player").id, body.spot, body.pier);
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
  });

  // One choice: push on or bank. The server rolls; the reply is what the player may see.
  app.post("/api/gather/step", async (c) => {
    const body = await c.req.json<{ choice?: unknown }>().catch(() => ({}) as { choice?: unknown });
    const player = c.get("player");
    const result = await stepOuting(c.env.DB, player.id, body.choice);
    if (typeof result === "string") return c.json({ error: result }, 409);
    if (result.xp) c.executionCtx.waitUntil(announceXp(c.env, player.id, result.xp));
    return c.json(result);
  });

  // Rest: on a bedroll in the Harbor, or at home if you have a hut. Gives back gathering stamina, on a cooldown.
  app.post("/api/rest", async (c) => {
    const player = c.get("player");
    const body = await c.req.json<{ place?: unknown }>().catch(() => ({}) as { place?: unknown });
    const place = body.place === "hut" ? "hut" : "bedroll";
    if (place === "hut" && !(await hasShack(c.env.DB, player.id))) return c.json({ error: "You have no hut to rest in yet." }, 409);
    // A rest at home is taken at home: in your own hut, not a crewmate's and not from the Harbor.
    if (place === "hut" && !(await inOwnHut(c.env, player.id))) return c.json({ error: "Walk into your own hut to rest there." }, 409);
    const result = await rest(c.env.DB, player.id, place);
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
  });
}
