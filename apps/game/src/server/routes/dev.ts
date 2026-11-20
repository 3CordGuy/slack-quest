// The dev toolbox's routes, all under /api/dev: a map to try fights in,
// seeding for your own hero (server/dev.ts), and the atlas's shortcuts.
// The check at the top refuses every one of them outside a development
// deployment.

import { makeRng, rollStone, zoneOptions } from "@gantt-quest/world";
import { chartFor, devClearNode, devResetChart } from "../atlas";
import { crewFor, getCharacter, refreshHarbor } from "../db";
import { isDev, seedGear, seedGold, seedMaterial } from "../dev";
import { gainStone } from "../lodestones";
import { createZoneRow } from "../zones";
import type { GameApp } from "./shared";

export function devRoutes(app: GameApp): void {
  // ---------- the dev toolbox ----------

  // Seeding for whoever is testing: gold, gear and materials for your own hero
  // (server/dev.ts). Only on a development deployment; in production these
  // routes do not exist.
  app.use("/api/dev/*", async (c, next) => {
    if (!isDev(c.env)) return c.json({ error: "not found" }, 404);
    return next();
  });

  // A zone to try fights in: a map made from the options sent (anything missing takes its default),
  // sized for the level of whoever asks unless told otherwise. Returns its code and the seed it was made from.
  app.post("/api/dev/zone", async (c) => {
    const player = c.get("player");
    const character = await getCharacter(c.env.DB, player.id);
    if (character?.status !== "active") return c.json({ error: "Create a character first." }, 409);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const options = zoneOptions({ level: character.level, ...body });
    const seed = typeof body.seed === "string" && body.seed.trim() ? body.seed.trim().slice(0, 40) : crypto.randomUUID().slice(0, 8);
    return c.json({ code: await createZoneRow(c.env.DB, player.id, options, seed), seed });
  });

  app.post("/api/dev/gold", async (c) => {
    const body = await c.req.json<{ amount?: unknown }>().catch(() => ({}) as { amount?: unknown });
    const result = await seedGold(c.env.DB, c.get("player").id, body.amount);
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
  });

  app.post("/api/dev/gear", async (c) => {
    const body = await c.req.json<{ ref?: unknown; rarity?: unknown; level?: unknown }>().catch(() => ({}) as { ref?: unknown; rarity?: unknown; level?: unknown });
    const result = await seedGear(c.env.DB, c.get("player").id, body);
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
  });

  app.post("/api/dev/material", async (c) => {
    const body = await c.req.json<{ kind?: unknown; qty?: unknown }>().catch(() => ({}) as { kind?: unknown; qty?: unknown });
    const result = await seedMaterial(c.env.DB, c.get("player").id, body.kind, body.qty);
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
  });

  // For whoever is testing: clear a landfall without fighting for it, or wipe the chart back to the Harbor.
  app.post("/api/dev/atlas", async (c) => {
    const crew = await crewFor(c.env.DB, c.get("player").id);
    if (!crew) return c.json({ error: "You are not in a crew." }, 403);
    const body = await c.req.json<{ op?: unknown; node?: unknown }>().catch(() => ({}) as { op?: unknown; node?: unknown });
    if (body.op === "reset") await devResetChart(c.env.DB, crew.id);
    // A lodestone as one is found a good way out, into the asker's own pack.
    else if (body.op === "stone") await gainStone(c.env.DB, c.get("player").id, rollStone(makeRng(Math.floor(Math.random() * 2 ** 31)), 4 + Math.floor(Math.random() * 8))).run();
    else if (body.op === "clear") {
      const problem = await devClearNode(c.env.DB, crew.id, body.node);
      if (problem) return c.json({ error: problem }, 409);
    } else return c.json({ error: "No such tool." }, 400);
    c.executionCtx.waitUntil(refreshHarbor(c.env, crew.id));
    return c.json(await chartFor(c.env.DB, crew.id));
  });
}
