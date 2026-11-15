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

export function saveZoneStatement(db: D1Database, state: ZoneState): D1PreparedStatement {
  return db.prepare("UPDATE zones SET state_json = ?, status = ?, updated_at = ? WHERE code = ?").bind(JSON.stringify(state), state.encounter ? "fight" : "open", Date.now(), state.code);
}
