// Fish kept, and fish sold: the icebox and the trophy chest, the fishmonger
// on the quay and Old Tam at the pub. Prices are worked out here from the
// crew's board (packages/world/src/fishmarket.ts), never taken from the client.

import {
  FISH,
  ICEBOX_G,
  TROPHY_SLOTS,
  fishBoard,
  fishSalePrice,
  iceboxProblem,
  inIcebox,
  trophyProblem,
  type FishBoard,
  type FishBuyer,
  type FishSpot,
  type Vessel,
  bestVessel,
} from "@gantt-quest/world";
import { crewFor } from "./db";

export interface KeptFish {
  id: string;
  species: string;
  grams: number;
  mm: number;
  specimen: boolean;
  spot: FishSpot;
  caughtAt: number;
  place: "icebox" | "trophy";
  /** What each buyer would pay for it right now; null if they will not take it. */
  market: number | null;
  tam: number | null;
}

export interface FishStock {
  icebox: KeptFish[];
  trophy: KeptFish[];
  /** Weight of fish (not treasure) in the icebox, and what it holds. */
  iceboxG: number;
  iceboxCapG: number;
  trophyCap: number;
  board: FishBoard;
  gold: number;
}

interface Row {
  id: string;
  species: string;
  grams: number;
  mm: number;
  specimen: number;
  spot: FishSpot;
  caught_at: number;
  place: "icebox" | "trophy";
}

/** The best boat a player owns (crafted at home, kept at the pier), or null. */
export async function ownedVessel(db: D1Database, playerId: string): Promise<Vessel | null> {
  const rows = await db.prepare("SELECT def_id FROM furnishings WHERE player_id = ? AND def_id IN ('rowboat', 'float_barrel')").bind(playerId).all<{ def_id: string }>();
  return bestVessel(rows.results.map((r) => r.def_id));
}

/** The board a player sees: their crew's, or their own if they have no crew. */
export async function boardFor(db: D1Database, playerId: string, now = Date.now()): Promise<FishBoard> {
  const crew = await crewFor(db, playerId);
  return fishBoard(crew?.id ?? playerId, now);
}

/** The weight of fish already in a player's icebox. */
export async function iceboxGrams(db: D1Database, playerId: string): Promise<number> {
  const rows = await db.prepare("SELECT species, grams FROM fish WHERE player_id = ? AND place = 'icebox'").bind(playerId).all<{ species: string; grams: number }>();
  return rows.results.reduce((a, r) => a + (FISH[r.species] && inIcebox(FISH[r.species]) ? r.grams : 0), 0);
}

export async function fishStock(db: D1Database, playerId: string): Promise<FishStock> {
  const [board, rows, gold] = await Promise.all([
    boardFor(db, playerId),
    db.prepare("SELECT id, species, grams, mm, specimen, spot, caught_at, place FROM fish WHERE player_id = ? AND place IN ('icebox', 'trophy') ORDER BY caught_at DESC").bind(playerId).all<Row>(),
    db.prepare("SELECT gold FROM characters WHERE player_id = ?").bind(playerId).first<{ gold: number }>(),
  ]);
  const kept = rows.results
    .filter((r) => FISH[r.species])
    .map((r): KeptFish => {
      const fish = { species: r.species, grams: r.grams, specimen: !!r.specimen };
      return { id: r.id, species: r.species, grams: r.grams, mm: r.mm, specimen: !!r.specimen, spot: r.spot, caughtAt: r.caught_at, place: r.place, market: fishSalePrice(fish, "market", board), tam: fishSalePrice(fish, "tam", board) };
    });
  const icebox = kept.filter((f) => f.place === "icebox");
  return {
    icebox,
    trophy: kept.filter((f) => f.place === "trophy"),
    iceboxG: icebox.reduce((a, f) => a + (inIcebox(FISH[f.species]) ? f.grams : 0), 0),
    iceboxCapG: ICEBOX_G,
    trophyCap: TROPHY_SLOTS,
    board,
    gold: gold?.gold ?? 0,
  };
}

/**
 * Sell kept fish to a buyer. Each fish is marked sold and paid for in the same
 * statement pair, so a fish sold twice (two requests racing) is paid once.
 */
export async function sellFish(db: D1Database, playerId: string, ids: unknown, to: unknown): Promise<(FishStock & { sold: { id: string; gold: number }[] }) | string> {
  if (to !== "market" && to !== "tam") return "Sell to whom?";
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every((id) => typeof id === "string")) return "Pick the fish to sell.";
  const before = await fishStock(db, playerId);
  const byId = new Map([...before.icebox, ...before.trophy].map((f) => [f.id, f]));
  const selling = [...new Set(ids as string[])].map((id) => byId.get(id));
  if (selling.some((f) => !f)) return "Some of those are not yours to sell.";
  const priced = selling.map((f) => ({ f: f!, gold: f![to] }));
  const refused = priced.find((p) => p.gold === null);
  if (refused) return to === "tam" ? `Old Tam will not take the ${FISH[refused.f.species].name.toLowerCase()}. Try the fishmonger.` : `The fishmonger has no use for the ${FISH[refused.f.species].name.toLowerCase()}.`;
  const results = await db.batch(
    priced.flatMap(({ f, gold }) => [
      db.prepare("UPDATE fish SET place = 'sold' WHERE id = ?1 AND player_id = ?2 AND place IN ('icebox', 'trophy')").bind(f.id, playerId),
      db.prepare("UPDATE characters SET gold = gold + ?2 WHERE player_id = ?1 AND changes() > 0").bind(playerId, gold!),
    ]),
  );
  const sold = priced.filter((_, i) => (results[i * 2].meta.changes ?? 0) > 0).map(({ f, gold }) => ({ id: f.id, gold: gold! }));
  return { ...(await fishStock(db, playerId)), sold };
}

/** Move a kept fish between the icebox and the trophy chest. */
export async function moveFish(db: D1Database, playerId: string, id: unknown, to: unknown): Promise<FishStock | string> {
  if (to !== "trophy" && to !== "icebox") return "Put it where?";
  const stock = await fishStock(db, playerId);
  const fish = [...stock.icebox, ...stock.trophy].find((f) => f.id === id);
  if (!fish) return "That fish is not yours.";
  if (fish.place === to) return stock;
  const problem = to === "trophy" ? trophyProblem(fish, stock.trophy.length) : iceboxProblem(fish, stock.iceboxG);
  if (problem) return problem;
  // Conditional on the chest still having room, so two moves racing cannot overfill it.
  const res = await (to === "trophy"
    ? db
        .prepare("UPDATE fish SET place = 'trophy' WHERE id = ?1 AND player_id = ?2 AND place = 'icebox' AND (SELECT COUNT(*) FROM fish WHERE player_id = ?2 AND place = 'trophy') < ?3")
        .bind(fish.id, playerId, TROPHY_SLOTS)
    : db.prepare("UPDATE fish SET place = 'icebox' WHERE id = ?1 AND player_id = ?2 AND place = 'trophy'").bind(fish.id, playerId)
  ).run();
  if (res.meta.changes === 0) return "That has already moved. Try again.";
  return fishStock(db, playerId);
}

export type { FishBuyer };
