// The atlas: a crew's chart of landfalls, setting out for one, and the
// muster that asks the crew to set out together.

import { chartFor, openNode, scoutNode } from "../atlas";
import { crewFor, getCharacter, refreshHarbor, type Env } from "../db";
import { harborParty, type GameApp } from "./shared";

/** Ask the crew's Harbor room about its muster. */
async function musterRoom(env: Env, crewId: string, path: "" | "/call" | "/answer", body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await env.HARBOR_ROOM.get(env.HARBOR_ROOM.idFromName(crewId)).fetch(`https://harbor/muster${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-crew-id": crewId, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({ error: "The Harbor did not answer." }))) as Record<string, unknown> };
}

export function atlasRoutes(app: GameApp): void {
  // ---------- the atlas: a crew's chart of landfalls ----------

  // The crew's chart: the Harbor, what they have cleared, what is open to them, the fog beyond, and who is out on what.
  app.get("/api/atlas", async (c) => {
    const crew = await crewFor(c.env.DB, c.get("player").id);
    if (!crew) return c.json({ error: "You are not in a crew." }, 403);
    return c.json(await chartFor(c.env.DB, crew.id));
  });

  // Set out for a place: the map the crew is already fighting through there, or a fresh one, sized (like a cave)
  // for whoever of the crew is in the Harbor now. The client names only the node (what is on it is the chart's) and
  // the lodestone put into its slot, which comes out of the asker's own pack.
  app.post("/api/atlas/open", async (c) => {
    const player = c.get("player");
    const [crew, character] = await Promise.all([crewFor(c.env.DB, player.id), getCharacter(c.env.DB, player.id)]);
    if (!crew) return c.json({ error: "You are not in a crew." }, 403);
    if (character?.status !== "active") return c.json({ error: "Create a character first." }, 409);
    const body = await c.req.json<{ node?: unknown; stone?: unknown }>().catch(() => ({}) as { node?: unknown; stone?: unknown });
    const went = await openNode(c.env.DB, crew.id, player.id, body.node, (await harborParty(c.env, crew.id, player.id)).length, body.stone);
    if ("error" in went) return c.json({ error: went.error }, went.status);
    // Crewmates looking at the chart see that someone has put in there.
    if (went.fresh) c.executionCtx.waitUntil(refreshHarbor(c.env, crew.id));
    return c.json(went);
  });

  // ---------- the muster: setting out together ----------

  // The crew's muster, if one is on (or ended a moment ago): for whoever is looking at the atlas, which has no socket.
  app.get("/api/atlas/muster", async (c) => {
    const crew = await crewFor(c.env.DB, c.get("player").id);
    if (!crew) return c.json({ error: "You are not in a crew." }, 403);
    const { json } = await musterRoom(c.env, crew.id, "");
    return c.json({ muster: json.muster ?? null });
  });

  // Set out for a place, asking the crew first. Where a map is already being fought through there, that is its code
  // and nobody is asked. With nobody else in town the map is made at once. Otherwise a muster is called: everyone in
  // town is asked, and the map is made when it starts (the Harbor room does that, and spends the stone then).
  app.post("/api/atlas/muster", async (c) => {
    const player = c.get("player");
    const [crew, character] = await Promise.all([crewFor(c.env.DB, player.id), getCharacter(c.env.DB, player.id)]);
    if (!crew) return c.json({ error: "You are not in a crew." }, 403);
    if (character?.status !== "active") return c.json({ error: "Create a character first." }, 409);
    const body = await c.req.json<{ node?: unknown; stone?: unknown }>().catch(() => ({}) as { node?: unknown; stone?: unknown });
    const seen = await scoutNode(c.env.DB, crew.id, body.node, body.stone);
    if ("error" in seen) return c.json({ error: seen.error }, seen.status);
    if ("live" in seen) return c.json({ code: seen.live, fresh: false });
    const called = await musterRoom(c.env, crew.id, "/call", { by: { id: player.id, name: character.name }, to: seen, stone: body.stone });
    if (called.json.alone) {
      const went = await openNode(c.env.DB, crew.id, player.id, body.node, 1, body.stone);
      if ("error" in went) return c.json({ error: went.error }, went.status);
      if (went.fresh) c.executionCtx.waitUntil(refreshHarbor(c.env, crew.id));
      return c.json(went);
    }
    return c.json(called.json, called.status as 200 | 400 | 409);
  });

  // Answer the crew's muster: "ready" or "no" from anyone in the crew, "start" or "cancel" from whoever called it.
  app.post("/api/atlas/muster/answer", async (c) => {
    const player = c.get("player");
    const [crew, character] = await Promise.all([crewFor(c.env.DB, player.id), getCharacter(c.env.DB, player.id)]);
    if (!crew) return c.json({ error: "You are not in a crew." }, 403);
    if (character?.status !== "active") return c.json({ error: "Create a character first." }, 409);
    const body = await c.req.json<{ answer?: unknown }>().catch(() => ({}) as { answer?: unknown });
    const said = await musterRoom(c.env, crew.id, "/answer", { who: { id: player.id, name: character.name }, answer: body.answer });
    return c.json(said.json, said.status as 200 | 400 | 409);
  });
}
