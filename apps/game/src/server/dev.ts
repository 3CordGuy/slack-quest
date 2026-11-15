// The dev toolbox's seeding (client/DevToolbox.tsx): gold, gear and materials
// handed straight to your own hero, to set up whatever you are testing.
//
// These are the only things the server does differently on a development
// deployment. The worker mounts their routes under /api/dev and refuses every
// one of them unless its ENVIRONMENT var is "dev" (local and staging), so in
// production they do not exist. Each acts on the signed-in player alone.
//
// Each returns what it did, or a sentence saying why it did not.

import { RARITIES, RESOURCE_KINDS, RESOURCE_LABEL, addedSlots, carryProblem, itemCells, itemOfRef, makeRng, type ItemDef, type Rarity, type ResourceKind } from "@gantt-quest/world";
import { carryState, getCharacter, insertItem, resourceStatements, type Env } from "./db";

/** Whether this deployment hands out the dev toolbox and answers its routes. */
export const isDev = (env: Pick<Env, "ENVIRONMENT">) => env.ENVIRONMENT === "dev";

/** The most gold, or of one material, a single press can add or take. */
export const SEED_MAX = 1_000_000;
/** The highest level a seeded piece of gear can be made at. */
export const SEED_LEVEL_MAX = 50;

const whole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
const NO_HERO = "Create a character first.";

/** Add gold to the hero's purse, or take it with a negative amount (never below nothing). Returns the purse afterwards. */
export async function seedGold(db: D1Database, playerId: string, amount: unknown): Promise<{ gold: number } | string> {
  if (!whole(amount) || amount === 0 || Math.abs(amount) > SEED_MAX) return `Give a whole amount of gold, up to ${SEED_MAX.toLocaleString("en")} either way.`;
  const res = await db.prepare("UPDATE characters SET gold = MAX(0, gold + ?2) WHERE player_id = ?1 AND status = 'active'").bind(playerId, amount).run();
  if (res.meta.changes === 0) return NO_HERO;
  return { gold: (await getCharacter(db, playerId))!.gold };
}

/**
 * Put one piece of gear in the hero's pack: `ref` is a weapon or a base, and
 * the stat points for its rarity are rolled as a drop's would be. `level`
 * defaults to the hero's own. Refused, like a purchase, if the pack has no room.
 */
export async function seedGear(db: D1Database, playerId: string, want: { ref?: unknown; rarity?: unknown; level?: unknown }): Promise<{ item: ItemDef } | string> {
  const [c, carry] = await Promise.all([getCharacter(db, playerId), carryState(db, playerId)]);
  if (c?.status !== "active" || !carry) return NO_HERO;
  const rarity = want.rarity === undefined ? "common" : want.rarity;
  if (!RARITIES.includes(rarity as Rarity)) return "No such rarity.";
  const level = want.level === undefined ? c.level : want.level;
  if (!whole(level) || level < 1 || level > SEED_LEVEL_MAX) return `Give a level from 1 to ${SEED_LEVEL_MAX}.`;
  const item = typeof want.ref === "string" ? itemOfRef(makeRng(crypto.getRandomValues(new Uint32Array(1))[0]), c.class_id, want.ref, rarity as Rarity, level) : undefined;
  if (!item) return "No such piece of gear.";
  const full = carryProblem(carry, itemCells(item));
  if (full) return full;
  await insertItem(db, playerId, item, false).run();
  return { item };
}

/** Add some of one material to the hero's pack, or take it with a negative amount. Refused if the new stacks would not fit. Returns how much they hold afterwards. */
export async function seedMaterial(db: D1Database, playerId: string, kind: unknown, qty: unknown): Promise<{ kind: ResourceKind; qty: number } | string> {
  if (!RESOURCE_KINDS.includes(kind as ResourceKind)) return "No such material.";
  if (!whole(qty) || qty === 0 || Math.abs(qty) > SEED_MAX) return `Give a whole amount, up to ${SEED_MAX.toLocaleString("en")} either way.`;
  const k = kind as ResourceKind;
  const held = () => db.prepare("SELECT qty FROM resources WHERE player_id = ? AND kind = ?").bind(playerId, k).first<{ qty: number }>();
  const [c, carry, had] = await Promise.all([getCharacter(db, playerId), carryState(db, playerId), held()]);
  if (c?.status !== "active" || !carry) return NO_HERO;
  if (qty < 0 && !had?.qty) return `You have no ${RESOURCE_LABEL[k].toLowerCase()} to take.`;
  const full = qty > 0 ? carryProblem(carry, addedSlots(had?.qty ?? 0, qty)) : null;
  if (full) return full;
  await db.batch(resourceStatements(db, playerId, { [k]: qty }));
  return { kind: k, qty: (await held())?.qty ?? 0 };
}
