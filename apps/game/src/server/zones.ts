// Zones in D1: the row a ZoneRoom loads its map from and saves it back to.
// D1 is the system of record, as for voyages: the room's copy is a cache.

import type { ZoneOptions, ZoneState } from "@gantt-quest/world";

export interface ZoneRow {
  code: string;
  seed: string;
  options_json: string;
  state_json: string | null;
}

/** Make a zone's row and return its code: four letters, no vowels, so codes never spell anything. */
export async function createZoneRow(db: D1Database, playerId: string, options: ZoneOptions, seed: string): Promise<string> {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ";
  const now = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
    try {
      await db
        .prepare("INSERT INTO zones (code, seed, options_json, status, created_by, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?)")
        .bind(code, seed, JSON.stringify(options), playerId, now, now)
        .run();
      return code;
    } catch {
      // Code collision; try another.
    }
  }
  throw new Error("could not allocate a zone code");
}

export async function getZoneRow(db: D1Database, code: string): Promise<ZoneRow | null> {
  return db.prepare("SELECT code, seed, options_json, state_json FROM zones WHERE code = ?").bind(code).first<ZoneRow>();
}

/** Presence older than this is taken for a room that went away without saying so. */
const PRESENCE_STALE_MS = 12 * 60 * 60_000;

// Presence is a courtesy to the roster, never a reason for a zone or the Harbor to fail: if it cannot be
// written or read (a database that has not had migration 0035 yet), that is logged and everything carries on.
const unwritten = (what: string) => (err: unknown) => console.warn(`zones:presence-${what}-failed`, { err: err instanceof Error ? err.message : String(err) });

/** A player is on this zone, in a fight or not. */
export async function setPresence(db: D1Database, playerId: string, code: string, fighting: boolean): Promise<void> {
  await db
    .prepare("INSERT INTO zone_presence (player_id, code, fighting, seen_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(player_id) DO UPDATE SET code = ?2, fighting = ?3, seen_at = ?4")
    .bind(playerId, code, fighting ? 1 : 0, Date.now())
    .run()
    .catch(unwritten("set"));
}

/** A player has left a zone (`code` given: only if that is still the one they are down as being on), or turned up somewhere else. */
export async function clearPresence(db: D1Database, playerId: string, code?: string): Promise<void> {
  const gone = code ? db.prepare("DELETE FROM zone_presence WHERE player_id = ? AND code = ?").bind(playerId, code) : db.prepare("DELETE FROM zone_presence WHERE player_id = ?").bind(playerId);
  await gone.run().catch(unwritten("clear"));
}

/** Who of a crew is out on a zone, by player id. Nobody, if presence cannot be read. */
export async function crewPresence(db: D1Database, crewId: string): Promise<Map<string, { code: string; fighting: boolean }>> {
  const rows = await db
    .prepare("SELECT p.player_id AS id, p.code, p.fighting FROM zone_presence p JOIN crew_members m ON m.player_id = p.player_id WHERE m.crew_id = ? AND p.seen_at > ?")
    .bind(crewId, Date.now() - PRESENCE_STALE_MS)
    .all<{ id: string; code: string; fighting: number }>()
    .then((r) => r.results, (err) => (unwritten("read")(err), []));
  return new Map(rows.map((p) => [p.id, { code: p.code, fighting: !!p.fighting }]));
}

export interface CrewPlace {
  id: string;
  name: string;
  classId: string;
  level: number;
  /** The zone they are on, or null if they are not on one (in the Harbor, or away). */
  zone: { code: string; fighting: boolean } | null;
}

/** Everyone in a crew and where they are, for the roster shown on a zone. */
export async function crewPlaces(db: D1Database, crewId: string): Promise<CrewPlace[]> {
  const [members, away] = await Promise.all([
    db
      .prepare("SELECT m.player_id AS id, c.name, c.class_id AS classId, c.level FROM crew_members m JOIN characters c ON c.player_id = m.player_id AND c.status = 'active' WHERE m.crew_id = ? ORDER BY m.joined_at, m.player_id")
      .bind(crewId)
      .all<{ id: string; name: string; classId: string; level: number }>(),
    crewPresence(db, crewId),
  ]);
  return members.results.map((m) => ({ ...m, zone: away.get(m.id) ?? null }));
}

export function saveZoneStatement(db: D1Database, state: ZoneState): D1PreparedStatement {
  return db.prepare("UPDATE zones SET state_json = ?, status = ?, updated_at = ? WHERE code = ?").bind(JSON.stringify(state), state.encounter ? "fight" : "open", Date.now(), state.code);
}
