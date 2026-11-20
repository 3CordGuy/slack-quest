// Zones: going down into the caves, where the crew is and teleporting
// to one of them, and the socket into a map's room.

import { zoneOptions } from "@gantt-quest/world";
import { enterProblem } from "../atlas";
import { crewFor, getCharacter } from "../db";
import { createZoneRow, crewPlaces, crewPlacesOf, getZoneRow, openCave, teleportTo } from "../zones";
import { harborParty, type GameApp } from "./shared";

export function zoneRoutes(app: GameApp): void {
  // Down into the Haunted Caverns: the crew's cave if one is still being fought through, else a fresh one.
  // A fresh cave is pitched for whoever of the crew is in the Harbor now (the asker always counts): as many
  // heroes as are there, up to four, at their average level. Crewmates who come later join by teleport.
  app.post("/api/caves", async (c) => {
    const player = c.get("player");
    const [crew, character] = await Promise.all([crewFor(c.env.DB, player.id), getCharacter(c.env.DB, player.id)]);
    if (!crew) return c.json({ error: "You are not in a crew." }, 403);
    if (character?.status !== "active") return c.json({ error: "Create a character first." }, 409);
    const open = await openCave(c.env.DB, crew.id);
    if (open) return c.json({ code: open, fresh: false });
    const party = await harborParty(c.env, crew.id, player.id);
    const level = party.length > 0 ? party.reduce((sum, m) => sum + m.level, 0) / party.length : character.level;
    // A delve: the caverns' chambers and tunnels, with chests to open and the hoard in the deepest (zone/delve.ts).
    const options = zoneOptions({ size: "medium", biome: "caves", delve: true, threat: 2, party: Math.min(4, Math.max(1, party.length)), level });
    return c.json({ code: await createZoneRow(c.env.DB, player.id, options, crypto.randomUUID().slice(0, 8), "caves", crew.id), fresh: true });
  });

  // Where everyone in the asker's crew is: on which zone, and whether in a fight there. For the roster shown on a zone.
  // Read straight from the asker's id (crewPlacesOf): nobody, for a player in no crew.
  app.get("/api/crew/places", async (c) => c.json({ members: await crewPlacesOf(c.env.DB, c.get("player").id) }));

  // Teleport to a crewmate: says where to go. The zone they are on, if they are on one and not in a
  // fight (nobody drops into a fight); the Harbor (zone null) if they are not out on a zone at all.
  // Not from the middle of a fight of your own: that is left by fleeing it (teleportTo).
  app.post("/api/crew/teleport", async (c) => {
    const body = await c.req.json<{ to?: string }>().catch(() => ({}) as { to?: string });
    const crew = await crewFor(c.env.DB, c.get("player").id);
    const go = teleportTo(crew ? await crewPlaces(c.env.DB, crew.id) : [], c.get("player").id, body.to);
    return "error" in go ? c.json({ error: go.error }, go.status) : c.json(go);
  });

  // A zone's socket. Anyone with a hero and the code can walk in, but a landfall on a crew's chart is that crew's
  // own. Zones are made by /api/caves, /api/atlas/open and the dev route.
  app.get("/api/zone/:code/ws", async (c) => {
    const code = c.req.param("code").toUpperCase();
    const zone = await getZoneRow(c.env.DB, code);
    if (!zone) return c.text("No map with that code.", 404);
    const barred = enterProblem(zone, zone.kind === "atlas" ? ((await crewFor(c.env.DB, c.get("player").id))?.id ?? null) : null);
    if (barred) return c.text(barred, 403);
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-zone-code", code);
    headers.set("x-player-id", c.get("player").id);
    // Arriving by teleport: beside the crewmate teleported to.
    const near = c.req.query("near");
    if (near && near.length <= 64) headers.set("x-zone-near", near);
    else headers.delete("x-zone-near");
    // A client that keeps the map's tiles from its first update asks to be sent them once (zone-room.ts).
    if (c.req.query("lean") === "1") headers.set("x-zone-lean", "1");
    else headers.delete("x-zone-lean");
    return c.env.ZONE_ROOM.get(c.env.ZONE_ROOM.idFromName(code)).fetch(new Request(c.req.url, { headers }));
  });
}
