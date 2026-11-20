// The Lapidary in D1 (packages/world/src/lapidary.ts): what its keeper does
// that is not work on a lodestone. Cutting and working lodestones is in
// lodestones.ts; here she buys gems.

import { GEM_PRICE, sellGemsProblem } from "@gantt-quest/world";
import { getCharacter, getHut } from "./db";

/**
 * Sell gems from the pack to the lapidary. Returns the gold paid, or why not. The price is the catalogue's;
 * the gems and the gold move in one batch, and the gold only if the gems were there to take.
 */
export async function sellGems(db: D1Database, playerId: string, qty: unknown): Promise<number | string> {
  const [c, hut] = await Promise.all([getCharacter(db, playerId), getHut(db, playerId)]);
  if (c?.status !== "active") return "Create a character first.";
  const problem = sellGemsProblem(qty, hut.resources);
  if (problem) return problem;
  const n = qty as number;
  const gold = GEM_PRICE * n;
  const [taken] = await db.batch([
    db.prepare("UPDATE resources SET qty = qty - ?2 WHERE player_id = ?1 AND kind = 'gem' AND qty >= ?2").bind(playerId, n),
    db.prepare("UPDATE characters SET gold = gold + ?2 WHERE player_id = ?1 AND status = 'active' AND changes() > 0").bind(playerId, gold),
  ]);
  return taken.meta.changes > 0 ? gold : "You no longer have that many.";
}
