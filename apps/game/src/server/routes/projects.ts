// Harbor projects: the crew's shared works, and giving toward one.

import { crewFor, refreshHarbor } from "../db";
import { announceXp } from "../harbor-xp";
import { contribute, crewWorks, projectStock } from "../projects";
import type { GameApp } from "./shared";

export function projectRoutes(app: GameApp): void {
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
    if (result.xp) c.executionCtx.waitUntil(announceXp(c.env, player.id, result.xp));
    const [works, stock] = await Promise.all([crewWorks(c.env.DB, crew.id), projectStock(c.env.DB, player.id)]);
    return c.json({ works, stock, completed: result.completed, xp: result.xp });
  });
}
