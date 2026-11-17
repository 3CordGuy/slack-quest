// Lodestones in D1 (packages/world/src/lodestone.ts): a hero's own, carried
// in the pack. They are kept with what there is to drink or throw (the
// `consumables` table: a kind and how many), each kind of stone its own
// kind of item, so they stack, take a square of the pack a stack, and are
// counted toward what the pack holds like anything else in it (carriedSql
// in db.ts). Nothing here reads them as something to drink or throw:
// `consumablesOf` passes over any kind it does not know.

import {
  PLAIN_STONE_COST,
  STONE_ITEM,
  addedSlots,
  attuneCost,
  attuneProblem,
  attuned,
  cleanStone,
  fuse,
  fuseProblem,
  makeRng,
  reroll,
  rerollCost,
  rerollProblem,
  stoneItem,
  stoneKey,
  stoneOfItem,
  type Lodestone,
  type ZoneModId,
} from "@gantt-quest/world";
import { carryState, packHasRoomSql, spendStatements } from "./db";

export interface HeldStone {
  stone: Lodestone;
  qty: number;
}

/** The lodestones in a hero's pack: each kind they hold and how many, the ones that carry most first. */
export async function lodestonesOf(db: D1Database, playerId: string): Promise<HeldStone[]> {
  const rows = await db
    .prepare("SELECT kind, qty FROM consumables WHERE player_id = ?1 AND qty > 0 AND (kind = ?2 OR kind LIKE ?3)")
    .bind(playerId, STONE_ITEM, `${STONE_ITEM}:%`)
    .all<{ kind: string; qty: number }>();
  return rows.results
    .flatMap((r) => {
      const stone = stoneOfItem(r.kind);
      return stone ? [{ stone, qty: r.qty }] : [];
    })
    .sort((a, b) => b.stone.length - a.stone.length || stoneKey(a.stone).localeCompare(stoneKey(b.stone)));
}

/** A statement that puts a lodestone in a hero's pack: one found in a bounty. */
export function gainStone(db: D1Database, playerId: string, stone: Lodestone): D1PreparedStatement {
  return db.prepare("INSERT INTO consumables (player_id, kind, qty) VALUES (?1, ?2, 1) ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + 1").bind(playerId, stoneItem(stone));
}

/** Take one lodestone out of a hero's pack. False if they hold none like it. */
export async function spendStone(db: D1Database, playerId: string, stone: Lodestone): Promise<boolean> {
  const res = await db.prepare("UPDATE consumables SET qty = qty - 1 WHERE player_id = ?1 AND kind = ?2 AND qty >= 1").bind(playerId, stoneItem(stone)).run();
  return res.meta.changes > 0;
}

/**
 * Cut a plain lodestone from stone and iron, into the pack. The materials are taken and the stone gained in
 * one batch, which checks again that the materials are there and (for the first of a stack, which takes a
 * square) that the pack has the room. Returns why not, or null once it is in the pack.
 */
export async function cutStone(db: D1Database, playerId: string): Promise<string | null> {
  const [carry, held] = await Promise.all([carryState(db, playerId), lodestonesOf(db, playerId)]);
  const plain = held.find((h) => h.stone.length === 0)?.qty ?? 0;
  const squares = addedSlots(plain, 1);
  const spend = spendStatements(db, playerId, 0, PLAIN_STONE_COST, squares > 0 && carry ? packHasRoomSql(carry.limit, squares) : "1");
  const res = await db.batch([
    ...spend,
    db.prepare("INSERT INTO consumables (player_id, kind, qty) SELECT ?1, ?2, 1 WHERE changes() > 0 ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + 1").bind(playerId, STONE_ITEM),
  ]);
  return res[spend.length].meta.changes > 0 ? null : "You have not the stone and iron for it, or the room in your pack.";
}

// ---------- the bench: working the stones in a pack into others (packages/world/src/stonecraft.ts) ----------

const dice = () => makeRng(Math.floor(Math.random() * 2 ** 31));
const NO_LONGER = "You no longer have what that takes, or the room in your pack for what it makes.";

/**
 * What a piece of bench work needs to know of the pack: how many of each kind of stone it holds, and the
 * SQL (true or false, for player ?1) that says the stones to be used are still there and the pack will have
 * room for the stone made. `used` is how many of each kind of stone go in (as items); `made` what comes out.
 * The kinds are written into the SQL as text, and are only ever ones `stoneItem` made of a clean stone.
 */
async function benchGuard(db: D1Database, playerId: string, used: Map<string, number>, made: Lodestone): Promise<string> {
  const [carry, held] = await Promise.all([carryState(db, playerId), lodestonesOf(db, playerId)]);
  const have = (kind: string) => held.find((h) => stoneItem(h.stone) === kind)?.qty ?? 0;
  // The squares the stone made will take, less the ones emptied by what is used.
  const freed = [...used].filter(([kind, n]) => have(kind) === n).length;
  const squares = addedSlots(have(stoneItem(made)) - (used.get(stoneItem(made)) ?? 0), 1) - freed;
  const holds = [...used].map(([kind, n]) => `COALESCE((SELECT qty FROM consumables WHERE player_id = ?1 AND kind = '${kind}'), 0) >= ${n}`);
  return [...holds, squares > 0 && carry ? packHasRoomSql(carry.limit, squares) : "1"].join(" AND ");
}

/** Statements that take the stones used out of the pack and put the one made into it, each only if the statement before it did something. */
function benchSwap(db: D1Database, playerId: string, used: Map<string, number>, made: Lodestone): D1PreparedStatement[] {
  return [
    ...[...used].map(([kind, n]) => db.prepare(`UPDATE consumables SET qty = qty - ${n} WHERE player_id = ?1 AND kind = '${kind}' AND changes() > 0`).bind(playerId)),
    db.prepare("INSERT INTO consumables (player_id, kind, qty) SELECT ?1, ?2, 1 WHERE changes() > 0 ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + 1").bind(playerId, stoneItem(made)),
  ];
}

/** Fuse three lodestones from the pack into one that carries one more thing. Returns why not, or the stone made. */
export async function fuseStones(db: D1Database, playerId: string, raw: unknown): Promise<string | { made: Lodestone }> {
  const stones = (Array.isArray(raw) ? raw : []).map(cleanStone);
  if (stones.some((s) => !s)) return "That is no lodestone.";
  const problem = fuseProblem(stones as Lodestone[]);
  if (problem) return problem;
  const used = new Map<string, number>();
  for (const s of stones as Lodestone[]) used.set(stoneItem(s), (used.get(stoneItem(s)) ?? 0) + 1);
  const made = fuse(dice(), stones as Lodestone[]);
  // Nothing is paid but the stones: the guard rides on a statement that changes nothing of the hero's.
  const guard = db.prepare(`UPDATE characters SET gold = gold WHERE player_id = ?1 AND status = 'active' AND ${await benchGuard(db, playerId, used, made)}`).bind(playerId);
  const res = await db.batch([guard, ...benchSwap(db, playerId, used, made)]);
  return res[res.length - 1].meta.changes > 0 ? { made } : NO_LONGER;
}

/** Add a chosen modifier to a lodestone from the pack, for gold and that modifier's material. Returns why not, or the stone made. */
export async function attuneStone(db: D1Database, playerId: string, raw: unknown, mod: unknown): Promise<string | { made: Lodestone }> {
  const stone = cleanStone(raw);
  if (!stone) return "That is no lodestone.";
  const problem = attuneProblem(stone, mod);
  if (problem) return problem;
  const made = attuned(stone, mod as ZoneModId);
  const cost = attuneCost(stone, mod as ZoneModId);
  const used = new Map([[stoneItem(stone), 1]]);
  const spend = spendStatements(db, playerId, cost.gold, cost.resources, await benchGuard(db, playerId, used, made));
  const res = await db.batch([...spend, ...benchSwap(db, playerId, used, made)]);
  return res[res.length - 1].meta.changes > 0 ? { made } : NO_LONGER;
}

/** For gold, change what a lodestone from the pack carries for as many other things. Returns why not, or the stone made. */
export async function rerollStone(db: D1Database, playerId: string, raw: unknown): Promise<string | { made: Lodestone }> {
  const stone = cleanStone(raw);
  if (!stone) return "That is no lodestone.";
  const problem = rerollProblem(stone);
  if (problem) return problem;
  const made = reroll(dice(), stone);
  const used = new Map([[stoneItem(stone), 1]]);
  const spend = spendStatements(db, playerId, rerollCost(stone), {}, await benchGuard(db, playerId, used, made));
  const res = await db.batch([...spend, ...benchSwap(db, playerId, used, made)]);
  return res[res.length - 1].meta.changes > 0 ? { made } : NO_LONGER;
}
