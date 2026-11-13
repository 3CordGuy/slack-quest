// Closing a fishing sitting in D1: the stamina it spends, the fish it keeps,
// the Catch Book and the crew's records.
//
// Every statement is conditional on the claim the closing statement writes,
// so a sitting closed twice (two requests racing, or an idle close beside a
// step) is paid, and charged, once.

import {
  CREW_RECORD_XP,
  FISH,
  NEW_SPECIES_XP,
  RESOURCE_KINDS,
  gatherDay,
  GATHER_DAILY_OUTINGS,
  sittingGold,
  sittingItems,
  sittingMaterials,
  sittingXp,
  type CaughtFish,
  type GatherState,
  type Resources,
} from "@gantt-quest/world";
import { crewFor } from "./db";
import { prepareXp, xpOutcome, type XpResult } from "./harbor-xp";

/** What a closed sitting gave, for the client to show. */
export interface SittingPaid {
  paid: Resources;
  gold: number;
  /** The catches kept as items, with the ids they were stored under. */
  fish: (CaughtFish & { id: string })[];
  /** Species caught for the first time, and the crew records set. */
  newSpecies: string[];
  records: string[];
  xp?: XpResult;
}

/** The heaviest kept catch of each species. */
function heaviest(items: (CaughtFish & { id: string })[]): Map<string, CaughtFish & { id: string }> {
  const best = new Map<string, CaughtFish & { id: string }>();
  for (const f of items) if ((best.get(f.species)?.grams ?? -1) < f.grams) best.set(f.species, f);
  return best;
}

/**
 * Close a sitting that has ended (`next.status` is no longer active): clear
 * the outing, spend the day's stamina, and write what it caught. Returns null
 * if the outing had already been closed or played by another request.
 */
export async function closeSitting(db: D1Database, playerId: string, before: string, next: GatherState): Promise<SittingPaid | null> {
  const s = next.sitting!;
  const now = Date.now();
  const claim = crypto.randomUUID();
  const guard = `EXISTS (SELECT 1 FROM gathering WHERE player_id = ?1 AND claim = '${claim}')`;
  // Every catch landed, each kept item with the id it is stored under.
  const kept = new Set(sittingItems(s.landed));
  const landed = s.landed.filter((f) => f.kept !== undefined).map((f) => ({ ...f, id: kept.has(f) ? (crypto.randomUUID() as string) : null }));
  const items = landed.filter((f): f is CaughtFish & { id: string } => f.id !== null);
  const paid = sittingMaterials(s.landed);
  const gold = sittingGold(s.landed);

  // What was new: species never caught before, and crew records beaten.
  const crew = await crewFor(db, playerId);
  const species = [...new Set(landed.map((f) => f.species))];
  const [known, records] = await Promise.all([
    species.length
      ? db.prepare(`SELECT species FROM fish_bests WHERE player_id = ? AND caught > 0 AND species IN (${species.map(() => "?").join(",")})`).bind(playerId, ...species).all<{ species: string }>()
      : null,
    crew && items.length ? db.prepare("SELECT species, grams FROM fish_records WHERE crew_id = ?").bind(crew.id).all<{ species: string; grams: number }>() : null,
  ]);
  const caughtBefore = new Set((known?.results ?? []).map((r) => r.species));
  const newSpecies = species.filter((id) => !caughtBefore.has(id));
  const recordFor = new Map((records?.results ?? []).map((r) => [r.species, r.grams]));
  const best = heaviest(items);
  const beaten = crew ? [...best.values()].filter((f) => FISH[f.species].kind !== "haul" && f.grams > (recordFor.get(f.species) ?? 0)) : [];

  const xp = await prepareXp(db, playerId, sittingXp(next), { bonus: newSpecies.length * NEW_SPECIES_XP + beaten.length * CREW_RECORD_XP });
  const today = gatherDay(now);
  const statements: D1PreparedStatement[] = [
    // The sitting ends, and only now spends its stamina.
    db
      .prepare(
        `UPDATE gathering SET session_json = NULL, claim = ?1,
           used = CASE WHEN day = ?4 THEN MIN(used + 1, ?5) ELSE 1 END, day = ?4
         WHERE player_id = ?2 AND session_json = ?3`,
      )
      .bind(claim, playerId, before, today, GATHER_DAILY_OUTINGS),
    ...RESOURCE_KINDS.filter((kind) => paid[kind]).map((kind) =>
      db
        .prepare(`INSERT INTO resources (player_id, kind, qty) SELECT ?1, ?2, ?3 WHERE ${guard} ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + ?3`)
        .bind(playerId, kind, paid[kind]!),
    ),
    ...(gold > 0 ? [db.prepare(`UPDATE characters SET gold = gold + ?2 WHERE player_id = ?1 AND ${guard}`).bind(playerId, gold)] : []),
    ...items.map((f) =>
      db
        .prepare(`INSERT INTO fish (id, player_id, species, grams, mm, specimen, spot, caught_at) SELECT ?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8 WHERE ${guard}`)
        .bind(playerId, f.id, f.species, f.grams, f.mm, f.specimen ? 1 : 0, f.spot, f.at),
    ),
    // The Catch Book: every catch landed counts, kept or thrown back; the heaviest is the best.
    ...landed.map((f) =>
      db
        .prepare(
          `INSERT INTO fish_bests (player_id, species, grams, mm, fish_id, first_at, best_at, caught, lost, specimen)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6, 1, 0, ?7 WHERE ${guard}
           ON CONFLICT(player_id, species) DO UPDATE SET
             caught = caught + 1,
             first_at = COALESCE(first_at, excluded.first_at),
             specimen = MAX(specimen, excluded.specimen),
             fish_id = CASE WHEN excluded.grams > grams THEN excluded.fish_id ELSE fish_id END,
             mm = CASE WHEN excluded.grams > grams THEN excluded.mm ELSE mm END,
             best_at = CASE WHEN excluded.grams > grams THEN excluded.best_at ELSE best_at END,
             grams = MAX(grams, excluded.grams)`,
        )
        .bind(playerId, f.species, f.grams, f.mm, f.id, f.at, f.specimen ? 1 : 0),
    ),
    ...s.lost.map((id) =>
      db
        .prepare(
          `INSERT INTO fish_bests (player_id, species, lost) SELECT ?1, ?2, 1 WHERE ${guard}
           ON CONFLICT(player_id, species) DO UPDATE SET lost = lost + 1`,
        )
        .bind(playerId, id),
    ),
    ...beaten.map((f) =>
      db
        .prepare(
          `INSERT INTO fish_records (crew_id, species, grams, mm, fish_id, player_id, caught_at)
           SELECT ?3, ?2, ?4, ?5, ?6, ?1, ?7 WHERE ${guard}
           ON CONFLICT(crew_id, species) DO UPDATE SET
             grams = excluded.grams, mm = excluded.mm, fish_id = excluded.fish_id, player_id = excluded.player_id, caught_at = excluded.caught_at
           WHERE excluded.grams > fish_records.grams`,
        )
        .bind(playerId, f.species, crew!.id, f.grams, f.mm, f.id, f.at),
    ),
    ...(xp?.statements(guard) ?? []),
  ];
  const results = await db.batch(statements);
  if (results[0].meta.changes === 0) return null;
  return { paid, gold, fish: items, newSpecies, records: beaten.map((f) => f.species), xp: xpOutcome(xp, results) };
}
