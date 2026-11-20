// The town chest: the one store a crew shares, in tabs, and every way of
// reaching into it.

import { crewFor } from "../db";
import { chestBuyTab, chestColorTab, chestFor, chestMoveTab, chestPutGear, chestPutStack, chestRenameTab, chestTakeGear, chestTakeStack } from "../townchest";
import type { GameApp } from "./shared";

export function chestRoutes(app: GameApp): void {
  // ---------- the town chest: one store the crew shares, in tabs ----------

  app.get("/api/chest", async (c) => {
    const crew = await crewFor(c.env.DB, c.get("player").id);
    if (!crew) return c.json({ error: "You are not in a crew." }, 403);
    return c.json(await chestFor(c.env.DB, crew.id));
  });

  // Reach into the chest: a piece of gear in (`stow`) or out (`unstow`), some of a stack in (`put`) or out
  // (`take`), another tab bought for the crew (`tab`), or a tab named again (`rename`), given a colour (`color`)
  // or moved among the others (`move`). Each answers with the chest as it now is.
  app.post("/api/chest/:move{stow|unstow|put|take|tab|rename|color|move}", async (c) => {
    const player = c.get("player");
    const crew = await crewFor(c.env.DB, player.id);
    if (!crew) return c.json({ error: "You are not in a crew." }, 403);
    type Body = { tab?: unknown; item?: unknown; kind?: unknown; qty?: unknown; name?: unknown; color?: unknown; to?: unknown };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    const move = c.req.param("move");
    const problem =
      move === "stow" ? await chestPutGear(c.env.DB, crew.id, player.id, body.tab, body.item)
      : move === "unstow" ? await chestTakeGear(c.env.DB, crew.id, player.id, body.item)
      : move === "put" ? await chestPutStack(c.env.DB, crew.id, player.id, body.tab, body.kind, body.qty)
      : move === "take" ? await chestTakeStack(c.env.DB, crew.id, player.id, body.tab, body.kind, body.qty)
      : move === "tab" ? await chestBuyTab(c.env.DB, crew.id, player.id, body.name)
      : move === "rename" ? await chestRenameTab(c.env.DB, crew.id, body.tab, body.name)
      : move === "color" ? await chestColorTab(c.env.DB, crew.id, body.tab, body.color)
      : await chestMoveTab(c.env.DB, crew.id, body.tab, body.to);
    if (problem) return c.json({ error: problem }, 409);
    return c.json(await chestFor(c.env.DB, crew.id));
  });
}
