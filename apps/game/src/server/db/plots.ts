// A plot in a crew's Harbor in D1: the ground a hut stands on, bought for
// gold, and the resource bin on it that is filled to raise the shack.

import { PLOT_PRICE, RESOURCE_KINDS, RESOURCE_LABEL, SHACK_COST, binDeposit, binNeeds, type Resources } from "@gantt-quest/world";
import { getHut } from "./huts";

/**
 * A player's plot and, while their shack is still to be raised, what is in the
 * resource bin on it. `bin` is null once the shack stands.
 */
export async function homeOf(db: D1Database, playerId: string): Promise<{ plot: number | null; bin: Resources | null }> {
  const row = await db.prepare("SELECT plot, bin_json FROM huts WHERE player_id = ?").bind(playerId).first<{ plot: number | null; bin_json: string | null }>();
  return { plot: row?.plot ?? null, bin: row?.plot != null && row.bin_json !== null ? parseBin(row.bin_json) : null };
}

/** True if the player has a plot with a shack standing on it: a hut to walk into and rest in. */
export async function hasShack(db: D1Database, playerId: string): Promise<boolean> {
  const home = await homeOf(db, playerId);
  return home.plot !== null && home.bin === null;
}

export function parseBin(json: string): Resources {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const out: Resources = {};
    for (const k of RESOURCE_KINDS) {
      const n = Math.floor(Number(raw?.[k] ?? 0));
      if (n > 0) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Put materials into the resource bin on the player's plot: as much of each
 * kind as they hold, up to what the shack still needs. Once the bin is full
 * the shack goes up. Each kind moves in a pair of statements, the second
 * running only if the first took the materials, and the bin is checked again
 * inside them so two requests at once cannot overfill it.
 */
export async function fillBin(db: D1Database, playerId: string): Promise<string | { put: Resources; bin: Resources | null }> {
  const [home, hut] = await Promise.all([homeOf(db, playerId), getHut(db, playerId)]);
  if (home.plot === null) return "You have no plot to build on.";
  if (home.bin === null) return "Your shack is already standing.";
  const put = binDeposit(home.bin, hut.resources);
  const kinds = RESOURCE_KINDS.filter((k) => (put[k] ?? 0) > 0);
  if (kinds.length === 0) {
    const need = binNeeds(home.bin);
    return `The bin still wants ${RESOURCE_KINDS.filter((k) => need[k]).map((k) => `${need[k]} ${RESOURCE_LABEL[k].toLowerCase()}`).join(" and ")}, and you have none to put in.`;
  }
  const inBin = (k: string) => `COALESCE(json_extract(bin_json, '$.${k}'), 0)`;
  const statements = kinds.flatMap((k) => [
    db
      .prepare(
        `UPDATE resources SET qty = qty - ?2 WHERE player_id = ?1 AND kind = '${k}' AND qty >= ?2
         AND EXISTS (SELECT 1 FROM huts WHERE player_id = ?1 AND plot IS NOT NULL AND bin_json IS NOT NULL AND ${inBin(k)} + ?2 <= ?3)`,
      )
      .bind(playerId, put[k], SHACK_COST[k] ?? 0),
    db.prepare(`UPDATE huts SET bin_json = json_set(bin_json, '$.${k}', ${inBin(k)} + ?2) WHERE player_id = ?1 AND changes() > 0`).bind(playerId, put[k]),
  ]);
  const full = RESOURCE_KINDS.filter((k) => (SHACK_COST[k] ?? 0) > 0).map((k) => `${inBin(k)} >= ${Math.floor(SHACK_COST[k]!)}`);
  statements.push(db.prepare(`UPDATE huts SET bin_json = NULL WHERE player_id = ?1 AND bin_json IS NOT NULL AND ${full.join(" AND ")}`).bind(playerId));
  const res = await db.batch(statements);
  const moved: Resources = {};
  kinds.forEach((k, i) => {
    if (res[i * 2 + 1].meta.changes > 0) moved[k] = put[k];
  });
  if (Object.keys(moved).length === 0) return "The bin or your materials changed just now. Try again.";
  return { put: moved, bin: (await homeOf(db, playerId)).bin };
}

/** The plot a player owns in their crew's Harbor, or null. */
export async function plotOf(db: D1Database, playerId: string): Promise<number | null> {
  const row = await db.prepare("SELECT plot FROM huts WHERE player_id = ?").bind(playerId).first<{ plot: number | null }>();
  return row?.plot ?? null;
}

/**
 * Buy a plot in the crew's Harbor. One plot a player, one player a plot. The
 * gold only moves if the plot is still free and the buyer has none, and the
 * plot is only written if the gold moved.
 */
export async function buyPlot(db: D1Database, crewId: string, playerId: string, plot: number, plots: number): Promise<string | null> {
  if (!Number.isInteger(plot) || plot < 0 || plot >= plots) return "There is no such plot.";
  const [paid] = await db.batch([
    db
      .prepare(
        `UPDATE characters SET gold = gold - ?1 WHERE player_id = ?2 AND status = 'active' AND gold >= ?1
         AND NOT EXISTS (SELECT 1 FROM huts WHERE player_id = ?2 AND plot IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM huts h JOIN crew_members m ON m.player_id = h.player_id WHERE m.crew_id = ?3 AND h.plot = ?4)`,
      )
      .bind(PLOT_PRICE, playerId, crewId, plot),
    // New ground has only a resource bin on it; the shack goes up once the bin is filled.
    db
      .prepare("INSERT INTO huts (player_id, tier, plot, bin_json) SELECT ?1, 1, ?2, '{}' WHERE changes() > 0 ON CONFLICT (player_id) DO UPDATE SET plot = excluded.plot, bin_json = '{}'")
      .bind(playerId, plot),
  ]);
  if (paid.meta.changes > 0) return null;
  if ((await plotOf(db, playerId)) !== null) return "You already own a plot.";
  const taken = await db.prepare("SELECT 1 FROM huts h JOIN crew_members m ON m.player_id = h.player_id WHERE m.crew_id = ? AND h.plot = ?").bind(crewId, plot).first();
  return taken ? "Someone has already bought that plot." : `A plot costs ${PLOT_PRICE} gold.`;
}
