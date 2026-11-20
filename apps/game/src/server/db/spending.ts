// Spending gold and materials in D1, all or nothing (spendStatements),
// and what a hut's owner spends them on: a furnishing crafted or bought, one
// sold back to the stall, and a bigger hut.

import {
  FURNISHINGS,
  HARBOR_XP,
  HUT_TIERS,
  RESOURCE_KINDS,
  buyFurnitureProblem,
  craftProblem,
  displacedFurnishings,
  furnitureSellPrice,
  nextHutTier,
  sellFurnitureProblem,
  upgradeProblem,
  type HutSummary,
  type Resources,
} from "@gantt-quest/world";
import { prepareXp, xpOutcome, type XpResult } from "../harbor-xp";
import { getCharacter } from "./characters";
import { getHut } from "./huts";
import { usedSql } from "./inventory";
import { now } from "./rows";

// ---------- huts: spending gold and materials ----------

/**
 * Statements that take `gold` and `resources` from a player, all or nothing.
 * The first checks every amount (and `alsoIf`, if given) and takes the gold;
 * each one after it runs only if the one before it changed a row. Follow them
 * with whatever is being paid for, guarded by `changes() > 0` in the same way,
 * and run the lot as one batch: either everything happens or nothing does.
 *
 * Amounts and `alsoIf` are inlined, so they must come from the catalogue,
 * never from a request.
 */
export function spendStatements(db: D1Database, playerId: string, gold: number, resources: Resources, alsoIf = "1"): D1PreparedStatement[] {
  const kinds = RESOURCE_KINDS.filter((k) => (resources[k] ?? 0) > 0);
  const amount = (n: number) => Math.max(0, Math.floor(n));
  const enough = kinds.map((k) => `COALESCE((SELECT qty FROM resources WHERE player_id = ?1 AND kind = '${k}'), 0) >= ${amount(resources[k]!)}`);
  const price = amount(gold);
  return [
    db
      .prepare(`UPDATE characters SET gold = gold - ${price} WHERE player_id = ?1 AND status = 'active' AND gold >= ${price} AND ${["(" + alsoIf + ")", ...enough].join(" AND ")}`)
      .bind(playerId),
    ...kinds.map((k) => db.prepare(`UPDATE resources SET qty = qty - ${amount(resources[k]!)} WHERE player_id = ?1 AND kind = '${k}' AND changes() > 0`).bind(playerId)),
  ];
}

/** What the owner has to build with at home: the pack's materials and everything in the hut's containers. */
export function atHome(hut: Pick<HutSummary, "resources" | "stash">): Resources {
  const all: Resources = { ...hut.resources };
  for (const s of hut.stash) all[s.kind] = (all[s.kind] ?? 0) + s.qty;
  return all;
}

/**
 * Statements that bring out of the hut's containers whatever of `need` the
 * pack is short of, to run ahead of `spendStatements` in the same batch.
 * Each stack only moves if it still held that many; the spend checks the
 * pack again, so a stack that went elsewhere just leaves the cost unpaid.
 */
function drawFromChests(db: D1Database, playerId: string, need: Resources, hut: Pick<HutSummary, "resources" | "stash">): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (const k of RESOURCE_KINDS) {
    let short = (need[k] ?? 0) - (hut.resources[k] ?? 0);
    for (const stack of hut.stash) {
      if (short <= 0) break;
      if (stack.kind !== k || stack.qty <= 0) continue;
      const take = Math.min(stack.qty, short);
      short -= take;
      out.push(
        db.prepare("UPDATE stash SET qty = qty - ?4 WHERE furnishing_id = ?1 AND player_id = ?2 AND kind = ?3 AND qty >= ?4").bind(stack.containerId, playerId, k, take),
        db
          .prepare("INSERT INTO resources (player_id, kind, qty) SELECT ?1, ?2, ?3 WHERE changes() > 0 ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + excluded.qty")
          .bind(playerId, k, take),
      );
    }
  }
  if (out.length) out.push(db.prepare("DELETE FROM stash WHERE player_id = ? AND qty <= 0").bind(playerId));
  return out;
}

/** A new furnishing into storage, but only if the statement before it in the batch changed a row. */
export function paidFurnishingStatement(db: D1Database, playerId: string, defId: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO furnishings (player_id, def_id, label, meta_json, created_at) SELECT ?, ?, ?, '{}', ? WHERE changes() > 0")
    .bind(playerId, defId, FURNISHINGS[defId].name, now());
}

/** Craft a furnishing from materials. Returns an error message, or null once it is in storage. */
export async function craftFurnishing(db: D1Database, playerId: string, defId: string): Promise<string | { xp?: XpResult }> {
  const [c, hut] = await Promise.all([getCharacter(db, playerId), getHut(db, playerId)]);
  if (c?.status !== "active") return "Create a character first.";
  // Crafting is done at home, so what is in the chests counts as well as what is in the pack.
  const problem = craftProblem(defId, hut.blueprints, atHome(hut), hut.tier);
  if (problem) return problem;
  const xp = await prepareXp(db, playerId, HARBOR_XP.craft);
  const recipe = FURNISHINGS[defId].recipe!;
  const made = [...drawFromChests(db, playerId, recipe, hut), ...spendStatements(db, playerId, 0, recipe), paidFurnishingStatement(db, playerId, defId)];
  const res = await db.batch([...made, ...(xp?.statements() ?? [])]);
  // The materials went elsewhere between the check and the batch: nothing was spent.
  return res[made.length - 1].meta.changes > 0 ? { xp: xpOutcome(xp, res) } : "You no longer have the materials for that.";
}

/** Buy a furnishing at the market stall. The price is the catalogue's; the client names only the piece. */
export async function buyFurniture(db: D1Database, playerId: string, defId: string): Promise<string | null> {
  const [c, hut] = await Promise.all([getCharacter(db, playerId), db.prepare("SELECT tier FROM huts WHERE player_id = ?").bind(playerId).first<{ tier: number }>()]);
  if (c?.status !== "active") return "Create a character first.";
  // The biggest pieces wait for a bigger hut (a player with no hut yet has a Shack's worth of room).
  const problem = buyFurnitureProblem(defId, c.gold, hut?.tier ?? 1);
  if (problem) return problem;
  const res = await db.batch([...spendStatements(db, playerId, FURNISHINGS[defId].price!, {}), paidFurnishingStatement(db, playerId, defId)]);
  return res[res.length - 1].meta.changes > 0 ? null : "Not enough gold.";
}

/**
 * Sell a stored piece of furniture back to the market stall, for half what
 * the stall charges for it (furnitureSellPrice). Returns the gold paid, or an
 * error. The piece and the gold move in one batch: the delete re-checks that
 * it is still in storage, empty, with nothing on it or hung on it, and the
 * gold is only paid if the delete went through.
 */
export async function sellFurniture(db: D1Database, playerId: string, furnishingId: unknown): Promise<number | string> {
  const id = Number(furnishingId);
  if (!Number.isSafeInteger(id)) return "You do not own that.";
  const c = await getCharacter(db, playerId);
  if (c?.status !== "active") return "Create a character first.";
  const row = await db
    .prepare(
      `SELECT def_id AS defId, q, in_id AS inId, meta_json AS meta, ${usedSql("?2")} + (SELECT COUNT(*) FROM furnishings WHERE on_id = ?2 AND player_id = ?1) AS used
       FROM furnishings WHERE id = ?2 AND player_id = ?1`,
    )
    .bind(playerId, id)
    .first<{ defId: string; q: number | null; inId: number | null; meta: string | null; used: number }>();
  const fish = row ? ((JSON.parse(row.meta || "{}") as { fish?: unknown }).fish ?? null) : null;
  const problem = sellFurnitureProblem(row ? { defId: row.defId, q: row.q, inId: row.inId, fish } : undefined, row?.used ?? 0);
  if (problem) return problem;
  const gold = furnitureSellPrice(row!.defId)!;
  const [gone] = await db.batch([
    db
      .prepare(
        `DELETE FROM furnishings WHERE id = ?2 AND player_id = ?1 AND q IS NULL AND in_id IS NULL AND def_id = ?3
           AND ${usedSql("?2")} = 0
           AND NOT EXISTS (SELECT 1 FROM furnishings WHERE on_id = ?2 AND player_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM fish WHERE furnishing_id = ?2 AND player_id = ?1)`,
      )
      .bind(playerId, id, row!.defId),
    db.prepare("UPDATE characters SET gold = gold + ?2 WHERE player_id = ?1 AND status = 'active' AND changes() > 0").bind(playerId, gold),
  ]);
  return gone.meta.changes > 0 ? gold : "That has already changed. Try again.";
}

/**
 * Make the player's hut one tier bigger. Returns an error message, or the new
 * tier. Furniture the new room has no place for goes back to storage in the
 * same batch (growing never displaces anything, but the rule is kept here so
 * a change to the room shapes cannot strand a piece inside a wall).
 */
export async function upgradeHut(db: D1Database, playerId: string): Promise<string | { tier: number }> {
  const [c, hut] = await Promise.all([getCharacter(db, playerId), getHut(db, playerId)]);
  if (c?.status !== "active") return "Create a character first.";
  const problem = upgradeProblem(hut.tier, c.gold, atHome(hut));
  if (problem) return problem;
  const next = nextHutTier(hut.tier)!;
  // The tier is checked again inside the batch, so two requests at once cannot both pay.
  const stillThisTier = `COALESCE((SELECT tier FROM huts WHERE player_id = ?1), ${HUT_TIERS[0].tier}) = ${Math.floor(hut.tier)}`;
  const spend = [...drawFromChests(db, playerId, next.resources, hut), ...spendStatements(db, playerId, next.gold, next.resources, stillThisTier)];
  const res = await db.batch([
    ...spend,
    db
      .prepare("INSERT INTO huts (player_id, tier) SELECT ?1, ?2 WHERE changes() > 0 ON CONFLICT(player_id) DO UPDATE SET tier = ?2")
      .bind(playerId, next.tier),
    ...displacedFurnishings(next.tier, hut.furnishings).map((f) =>
      db.prepare("UPDATE furnishings SET q = NULL, r = NULL, on_id = NULL WHERE id = ?1 AND player_id = ?2 AND (SELECT tier FROM huts WHERE player_id = ?2) = ?3").bind(f.id, playerId, next.tier),
    ),
  ]);
  return res[spend.length].meta.changes > 0 ? { tier: next.tier } : "You no longer have what that costs.";
}
