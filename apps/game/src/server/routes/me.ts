// /api/me: everything a client loads about its own player when it starts,
// and again whenever something of theirs has changed.

import { consumablesOf } from "../consumables";
import { isAdmin } from "../content";
import { carryState, crewFor, ensureLook, getCharacter, getInventory } from "../db";
import { isDev } from "../dev";
import { harborXpFor } from "../harbor-xp";
import { lodestonesOf } from "../lodestones";
import { seenRelease } from "../releases";
import type { GameApp } from "./shared";

export function meRoutes(app: GameApp): void {
  app.get("/api/me", async (c) => {
    const player = c.get("player");
    const read = () =>
      Promise.all([
        getCharacter(c.env.DB, player.id),
        getInventory(c.env.DB, player.id),
        crewFor(c.env.DB, player.id),
        carryState(c.env.DB, player.id),
        harborXpFor(c.env.DB, player.id),
        seenRelease(c.env.DB, player.id),
        c.env.DB.prepare("SELECT kind, qty FROM resources WHERE player_id = ? AND qty > 0").bind(player.id).all<{ kind: string; qty: number }>(),
        consumablesOf(c.env.DB, player.id),
        lodestonesOf(c.env.DB, player.id),
      ]);
    let all = await read();
    // A hero from before looks came in is given their class's look and starting clothes the first time they
    // come in (see ensureLook). Whether that is still to do shows in the character just read, so nobody else
    // waits on a question about it; for the one it is done for, everything is read again with the clothes on.
    if (all[0]?.status === "active" && all[0].appearance == null && (await ensureLook(c.env.DB, player.id))) all = await read();
    const [character, inventory, crew, carry, harborXp, seen, held, consumables, lodestones] = all;
    // `materials` is what is in the pack, in stacks beside the gear; `consumables` the potions and flasks there with
    // them, and `lodestones` the stones that open a place on the atlas.
    const materials = Object.fromEntries(held.results.map((r) => [r.kind, r.qty]));
    // `inventory` is what the hero has with them; what is in storage at home is only listed inside their hut.
    // `isAdmin` only decides whether the client shows the admin link: every admin route checks again.
    // `seenRelease` is the newest release whose notes they have read on the notice board.
    // `devTools` shows the dev toolbox (ENVIRONMENT is "dev" on local and staging): the /api/dev routes (routes/dev.ts) answer only then.
    return c.json({ player, character, inventory, materials, consumables, lodestones, crew, carry, harborXp, seenRelease: seen, isAdmin: isAdmin(c.env, player), devTools: isDev(c.env) });
  });
}
