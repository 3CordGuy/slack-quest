// Crews in D1: founding, joining and leaving one, and the board everyone
// in its Harbor is shown (who is in it and where, its works, the maps it has
// open).

import { atlasNodeById, type HarborBoard } from "@gantt-quest/world";
import { crewWorks } from "../projects";
import { crewPresence } from "../zones";
import { parseBin } from "./plots";
import { now, type Env } from "./rows";

// ---------- crews and the Harbor ----------

export interface Crew {
  id: string;
  name: string;
}

function randomCode(length: number): string {
  // No vowels, so codes never spell anything.
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ";
  return [...crypto.getRandomValues(new Uint8Array(length))].map((b) => alphabet[b % alphabet.length]).join("");
}

export async function crewFor(db: D1Database, playerId: string): Promise<Crew | null> {
  return db
    .prepare("SELECT c.id, c.name FROM crew_members m JOIN crews c ON c.id = m.crew_id WHERE m.player_id = ?")
    .bind(playerId)
    .first<Crew>();
}

export async function getCrew(db: D1Database, crewId: string): Promise<Crew | null> {
  return db.prepare("SELECT id, name FROM crews WHERE id = ?").bind(crewId).first<Crew>();
}

/** Found a crew and make the founder its first member. Leaves any crew they were in. */
export async function createCrew(db: D1Database, playerId: string, name: string): Promise<Crew> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = randomCode(6);
    try {
      await db.batch([
        db.prepare("INSERT INTO crews (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").bind(id, name, playerId, now()),
        db.prepare("DELETE FROM crew_members WHERE player_id = ?").bind(playerId),
        db.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES (?, ?, ?)").bind(id, playerId, now()),
      ]);
      return { id, name };
    } catch {
      // Code collision; try another.
    }
  }
  throw new Error("could not allocate a crew code");
}

/** Join a crew by its invite code, leaving any other crew. Returns null if there is no such crew or it is full. */
export async function joinCrew(db: D1Database, playerId: string, crewId: string, maxMembers: number): Promise<Crew | null> {
  const crew = await getCrew(db, crewId);
  if (!crew) return null;
  const count = await db.prepare("SELECT COUNT(*) AS n FROM crew_members WHERE crew_id = ? AND player_id != ?").bind(crewId, playerId).first<{ n: number }>();
  if ((count?.n ?? 0) >= maxMembers) return null;
  await db.batch([
    db.prepare("DELETE FROM crew_members WHERE player_id = ?").bind(playerId),
    // Moving to another crew leaves the old Harbor's plot behind.
    db.prepare("UPDATE huts SET plot = NULL WHERE player_id = ? AND NOT EXISTS (SELECT 1 FROM crew_members WHERE player_id = ?1 AND crew_id = ?2)").bind(playerId, crewId),
    db.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES (?, ?, ?)").bind(crewId, playerId, now()),
  ]);
  return crew;
}

export async function leaveCrew(db: D1Database, playerId: string): Promise<void> {
  // A plot is land in one crew's Harbor: leaving the crew gives it up. The hut's contents stay with the player.
  await db.batch([
    db.prepare("DELETE FROM crew_members WHERE player_id = ?").bind(playerId),
    db.prepare("UPDATE huts SET plot = NULL WHERE player_id = ?").bind(playerId),
  ]);
}

/** How long a map nobody has walked on still counts as open: as long as the atlas itself keeps a map (zones.ts CAVE_IDLE_MS). */
const OPEN_MAP_MS = 12 * 60 * 60_000;

/** What everyone in a Harbor is told about its crew: who is in it and where, its works and the maps it has open. */
export async function harborBoard(db: D1Database, crewId: string): Promise<HarborBoard> {
  // None of these needs another's answer, so they are all asked for together.
  const [works, members, zoneOf, open] = await Promise.all([
    crewWorks(db, crewId),
    db
      .prepare(
        `SELECT m.player_id AS id, c.name, c.class_id AS classId, c.level, COALESCE(h.tier, 1) AS hutTier, h.plot AS plot, h.bin_json AS bin
         FROM crew_members m JOIN characters c ON c.player_id = m.player_id AND c.status = 'active'
         LEFT JOIN huts h ON h.player_id = m.player_id
         WHERE m.crew_id = ? ORDER BY m.joined_at, m.player_id`,
      )
      .bind(crewId)
      .all<{ id: string; name: string; classId: string; level: number; hutTier: number; plot: number | null; bin: string | null }>(),
    // Who is out on a zone, and whether they are fighting there.
    crewPresence(db, crewId),
    // The maps the crew has open out through the waygate: made for a place on its atlas, not cleared, and walked on
    // lately (as long as the atlas itself keeps a map: zones.ts CAVE_IDLE_MS). The crew's id is its chart's seed.
    db
      .prepare("SELECT code, node FROM zones WHERE kind = 'atlas' AND crew_id = ?1 AND status != 'cleared' AND updated_at > ?2 ORDER BY updated_at DESC LIMIT 6")
      .bind(crewId, now() - OPEN_MAP_MS)
      .all<{ code: string; node: string | null }>(),
  ]);

  // Members whose shack is not up yet carry what is in its bin, so the site can be drawn filling up.
  const roster = members.results.map(({ bin, ...m }) => ({ ...m, ...(m.plot !== null && bin !== null ? { bin: parseBin(bin) } : {}), ...(zoneOf.has(m.id) ? { zone: zoneOf.get(m.id) } : {}) }));
  const maps = open.results.map((z) => ({ code: z.code, node: z.node ?? "", place: (z.node ? atlasNodeById(crewId, z.node)?.name : null) ?? "a landfall" }));
  return { members: roster, works,...(maps.length > 0 ? { maps } : {}) };
}

/** Ask a crew's Harbor to re-read its notice board and tell everyone present. Never throws. */
export async function refreshHarbor(env: Env, crewId: string | null): Promise<void> {
  if (!crewId) return;
  try {
    await env.HARBOR_ROOM.get(env.HARBOR_ROOM.idFromName(crewId)).fetch("https://harbor/refresh", { headers: { "x-crew-id": crewId } });
  } catch (err) {
    console.warn("harbor:refresh-failed", { err: err instanceof Error ? err.message : String(err) });
  }
}
