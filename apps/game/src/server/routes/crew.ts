// Crews: founding, joining and leaving one, and the socket into the
// crew's Harbor.

import { MAX_CREW } from "@gantt-quest/world";
import { createCrew, crewFor, getCharacter, joinCrew, leaveCrew, refreshHarbor } from "../db";
import type { GameApp } from "./shared";

export function crewRoutes(app: GameApp): void {
  // ---------- crews and the shared Harbor ----------

  app.post("/api/crew", async (c) => {
    const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
    const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
    if (name.length < 2 || name.length > 30) return c.json({ error: "Crew name must be 2 to 30 characters." }, 400);
    return c.json({ crew: await createCrew(c.env.DB, c.get("player").id, name) });
  });

  app.post("/api/crew/join", async (c) => {
    const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
    const code = String(body.code ?? "").toUpperCase();
    const before = await crewFor(c.env.DB, c.get("player").id);
    const crew = /^[A-Z]{6}$/.test(code) ? await joinCrew(c.env.DB, c.get("player").id, code, MAX_CREW) : null;
    if (!crew) return c.json({ error: "No crew with that code, or it is full." }, 404);
    if (before && before.id !== crew.id) c.executionCtx.waitUntil(refreshHarbor(c.env, before.id));
    return c.json({ crew });
  });

  app.post("/api/crew/leave", async (c) => {
    const crew = await crewFor(c.env.DB, c.get("player").id);
    await leaveCrew(c.env.DB, c.get("player").id);
    c.executionCtx.waitUntil(refreshHarbor(c.env, crew?.id ?? null));
    return c.json({ ok: true });
  });

  app.get("/api/crew/ws", async (c) => {
    const player = c.get("player");
    const [crew, character] = await Promise.all([crewFor(c.env.DB, player.id), getCharacter(c.env.DB, player.id)]);
    if (!crew) return c.text("You are not in a crew.", 403);
    if (character?.status !== "active") return c.text("Create a character first.", 409);
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-crew-id", crew.id);
    headers.set("x-player-id", player.id);
    headers.set("x-player-name", encodeURIComponent(character.name));
    headers.set("x-player-class", character.class_id);
    headers.set("x-player-level", String(character.level));
    return c.env.HARBOR_ROOM.get(c.env.HARBOR_ROOM.idFromName(crew.id)).fetch(new Request(c.req.url, { headers }));
  });
}
