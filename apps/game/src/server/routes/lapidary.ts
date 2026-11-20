// The Lapidary: a plain lodestone cut, the stones worked at her bench,
// and gems sold to her.

import { getCharacter } from "../db";
import { sellGems } from "../lapidary";
import { attuneStone, cutStone, fuseStones, lodestonesOf, rerollStone, temperStone } from "../lodestones";
import type { GameApp } from "./shared";

export function lapidaryRoutes(app: GameApp): void {
  // ---------- the Lapidary: lodestones cut and worked, gems bought (the keeper inside does all three) ----------

  // Cut a plain lodestone from stone and iron, into the pack: the way out for someone with none. (One that
  // carries anything is only ever found.)
  app.post("/api/atlas/cut", async (c) => {
    const player = c.get("player");
    const character = await getCharacter(c.env.DB, player.id);
    if (character?.status !== "active") return c.json({ error: "Create a character first." }, 409);
    const problem = await cutStone(c.env.DB, player.id);
    return problem ? c.json({ error: problem }, 409) : c.json({ lodestones: await lodestonesOf(c.env.DB, player.id) });
  });

  // The lapidary's bench: fuse three stones into one that carries more, attune a stone to one more thing, temper
  // one thing a stone carries up a rank, or reroll what a stone carries. All out of the asker's own pack. Answers with the stone made and the pack's stones.
  app.post("/api/atlas/bench", async (c) => {
    const player = c.get("player");
    const character = await getCharacter(c.env.DB, player.id);
    if (character?.status !== "active") return c.json({ error: "Create a character first." }, 409);
    const body = await c.req.json<{ op?: unknown; stones?: unknown; stone?: unknown; mod?: unknown }>().catch(() => ({}) as { op?: unknown; stones?: unknown; stone?: unknown; mod?: unknown });
    const done =
      body.op === "fuse" ? await fuseStones(c.env.DB, player.id, body.stones)
      : body.op === "attune" ? await attuneStone(c.env.DB, player.id, body.stone, body.mod)
      : body.op === "temper" ? await temperStone(c.env.DB, player.id, body.stone, body.mod)
      : body.op === "reroll" ? await rerollStone(c.env.DB, player.id, body.stone)
      : "There is no such work at the bench.";
    if (typeof done === "string") return c.json({ error: done }, 409);
    return c.json({ made: done.made, lodestones: await lodestonesOf(c.env.DB, player.id) });
  });

  // Sell gems out of the pack to the lapidary, at her price.
  app.post("/api/lapidary/gems/sell", async (c) => {
    const body = await c.req.json<{ qty?: unknown }>().catch(() => ({}) as { qty?: unknown });
    const result = await sellGems(c.env.DB, c.get("player").id, body.qty);
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json({ gold: result });
  });
}
