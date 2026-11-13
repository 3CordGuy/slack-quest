// The Catch Book, the crew's records, and fish hung on walls: in the crew's
// pub (record fish only, by the one who caught them) and at home (any fish
// from the trophy chest, on a Mounted Fish).

import { FISH, PUB_MOUNT_SLOTS, TROPHY_SLOTS, type BookPage } from "@gantt-quest/world";
import { crewFor, refreshHut, type Env } from "./db";

export interface BookEntry {
  species: string;
  caught: number;
  lost: number;
  grams: number;
  mm: number;
  specimen: boolean;
  firstAt: number | null;
}

export interface CrewRecord {
  species: string;
  grams: number;
  mm: number;
  fishId: string | null;
  playerId: string;
  name: string;
  caughtAt: number;
  /** It is the asking player's. */
  mine?: boolean;
}

export interface CatchBook {
  entries: BookEntry[];
  /** Pages already rewarded ("book" once the whole of it is). */
  claimed: (BookPage | "book")[];
  title: string | null;
  /** The crew's record for each kind, if the player is in a crew. */
  records: CrewRecord[];
}

export interface PubWall {
  records: CrewRecord[];
  mounts: { slot: number; fishId: string; species: string; grams: number; mm: number; playerId: string; name: string }[];
  slots: number;
}

async function crewRecords(db: D1Database, crewId: string): Promise<CrewRecord[]> {
  const rows = await db
    .prepare(
      `SELECT r.species, r.grams, r.mm, r.fish_id AS fishId, r.player_id AS playerId, COALESCE(c.name, '?') AS name, r.caught_at AS caughtAt
       FROM fish_records r LEFT JOIN characters c ON c.player_id = r.player_id WHERE r.crew_id = ? ORDER BY r.caught_at DESC`,
    )
    .bind(crewId)
    .all<CrewRecord>();
  return rows.results.filter((r) => FISH[r.species]);
}

export async function catchBook(db: D1Database, playerId: string): Promise<CatchBook> {
  const crew = await crewFor(db, playerId);
  const [entries, claimed, character, records] = await Promise.all([
    db.prepare("SELECT species, caught, lost, grams, mm, specimen, first_at AS firstAt FROM fish_bests WHERE player_id = ?").bind(playerId).all<Omit<BookEntry, "specimen"> & { specimen: number }>(),
    db.prepare("SELECT page FROM book_rewards WHERE player_id = ?").bind(playerId).all<{ page: BookPage | "book" }>(),
    db.prepare("SELECT title FROM characters WHERE player_id = ?").bind(playerId).first<{ title: string | null }>(),
    crew ? crewRecords(db, crew.id) : Promise.resolve([]),
  ]);
  return {
    entries: entries.results.filter((e) => FISH[e.species]).map((e) => ({ ...e, specimen: !!e.specimen })),
    claimed: claimed.results.map((r) => r.page),
    title: character?.title ?? null,
    records: records.map((r) => ({ ...r, mine: r.playerId === playerId })),
  };
}

export async function pubWall(db: D1Database, playerId: string): Promise<PubWall | string> {
  const crew = await crewFor(db, playerId);
  if (!crew) return "The pub is for crews. Join one first.";
  const [records, mounts] = await Promise.all([
    crewRecords(db, crew.id),
    db
      .prepare(
        `SELECT m.slot, m.fish_id AS fishId, m.species, f.grams, f.mm, m.player_id AS playerId, COALESCE(c.name, '?') AS name
         FROM pub_mounts m JOIN fish f ON f.id = m.fish_id LEFT JOIN characters c ON c.player_id = m.player_id WHERE m.crew_id = ? ORDER BY m.slot`,
      )
      .bind(crew.id)
      .all<PubWall["mounts"][number]>(),
  ]);
  return { records, mounts: mounts.results, slots: PUB_MOUNT_SLOTS };
}

/** Hang a crew record fish on the pub wall. Only its catcher can, and only while it is the record. */
export async function mountInPub(db: D1Database, playerId: string, fishId: unknown): Promise<PubWall | string> {
  const crew = await crewFor(db, playerId);
  if (!crew) return "The pub is for crews. Join one first.";
  if (typeof fishId !== "string") return "Which fish?";
  const fish = await db.prepare("SELECT species, place FROM fish WHERE id = ? AND player_id = ?").bind(fishId, playerId).first<{ species: string; place: string }>();
  if (!fish || (fish.place !== "icebox" && fish.place !== "trophy")) return "That fish is not yours to hang.";
  const record = await db.prepare("SELECT fish_id FROM fish_records WHERE crew_id = ? AND species = ?").bind(crew.id, fish.species).first<{ fish_id: string | null }>();
  if (record?.fish_id !== fishId) return "Only the crew's record fish goes on the pub wall.";
  const used = await db.prepare("SELECT slot FROM pub_mounts WHERE crew_id = ?").bind(crew.id).all<{ slot: number }>();
  const taken = new Set(used.results.map((r) => r.slot));
  const slot = Array.from({ length: PUB_MOUNT_SLOTS }, (_, i) => i).find((i) => !taken.has(i));
  if (slot === undefined) return "The wall is full. A record has to be beaten, or taken down, first.";
  // The slot and the one-per-kind index decide races: a second request finds the slot or the kind taken.
  const res = await db.batch([
    db.prepare("INSERT OR IGNORE INTO pub_mounts (crew_id, slot, fish_id, species, player_id) VALUES (?, ?, ?, ?, ?)").bind(crew.id, slot, fishId, fish.species, playerId),
    db.prepare("UPDATE fish SET place = 'pub' WHERE id = ? AND player_id = ? AND changes() > 0").bind(fishId, playerId),
  ]);
  if (res[0].meta.changes === 0) return "That spot was just taken. Try again.";
  return pubWall(db, playerId);
}

/** Take your fish down off the pub wall, back into the trophy chest. */
export async function unmountInPub(db: D1Database, playerId: string, fishId: unknown): Promise<PubWall | string> {
  const crew = await crewFor(db, playerId);
  if (!crew) return "The pub is for crews. Join one first.";
  if (typeof fishId !== "string") return "Which fish?";
  const res = await db.batch([
    db.prepare("DELETE FROM pub_mounts WHERE crew_id = ? AND fish_id = ? AND player_id = ?").bind(crew.id, fishId, playerId),
    db.prepare("UPDATE fish SET place = 'trophy' WHERE id = ? AND player_id = ? AND changes() > 0").bind(fishId, playerId),
  ]);
  if (res[0].meta.changes === 0) return "That is not yours to take down.";
  return pubWall(db, playerId);
}

/**
 * Hang a fish from the trophy chest on a Mounted Fish at home, or (`fishId`
 * null) take it down again. Whatever hung there before goes back in the chest.
 */
export async function hangAtHome(env: Env, playerId: string, furnishingId: unknown, fishId: unknown): Promise<{ ok: true } | string> {
  const db = env.DB;
  const id = Number(furnishingId);
  if (!Number.isInteger(id)) return "Which mount?";
  const mount = await db.prepare("SELECT def_id AS defId, meta_json AS meta FROM furnishings WHERE id = ? AND player_id = ?").bind(id, playerId).first<{ defId: string; meta: string | null }>();
  if (!mount || mount.defId !== "mounted_fish") return "That is not a mount for a fish.";
  const was = (JSON.parse(mount.meta || "{}") as { fish?: { id: string } }).fish?.id ?? null;
  const statements: D1PreparedStatement[] = [];
  if (fishId === null) {
    if (!was) return { ok: true };
    const chest = await db.prepare("SELECT COUNT(*) AS n FROM fish WHERE player_id = ? AND place = 'trophy'").bind(playerId).first<{ n: number }>();
    if ((chest?.n ?? 0) >= TROPHY_SLOTS) return "The trophy chest is full. Make room in it first.";
    statements.push(db.prepare("UPDATE furnishings SET meta_json = '{}' WHERE id = ? AND player_id = ?").bind(id, playerId));
  } else {
    if (typeof fishId !== "string") return "Which fish?";
    const fish = await db.prepare("SELECT species, grams, mm FROM fish WHERE id = ? AND player_id = ? AND place = 'trophy'").bind(fishId, playerId).first<{ species: string; grams: number; mm: number }>();
    if (!fish) return "Only a fish from your trophy chest can be mounted.";
    statements.push(
      db.prepare("UPDATE fish SET place = 'hut', furnishing_id = ?1 WHERE id = ?2 AND player_id = ?3 AND place = 'trophy'").bind(id, fishId, playerId),
      db.prepare("UPDATE furnishings SET meta_json = ?1 WHERE id = ?2 AND player_id = ?3 AND changes() > 0").bind(JSON.stringify({ fish: { id: fishId, species: fish.species, grams: fish.grams, mm: fish.mm } }), id, playerId),
    );
  }
  // What hung there before goes back in the chest (only if this change went through).
  if (was) statements.push(db.prepare("UPDATE fish SET place = 'trophy', furnishing_id = NULL WHERE id = ? AND player_id = ? AND place = 'hut' AND changes() > 0").bind(was, playerId));
  const res = await db.batch(statements);
  if (res[0].meta.changes === 0) return "That has already changed. Try again.";
  await refreshHut(env, playerId);
  return { ok: true };
}
