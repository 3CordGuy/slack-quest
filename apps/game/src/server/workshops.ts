// The apothecary and the smithy in D1: a hero's brew bag, brewing, and
// working gear at the forge.
//
// The rules (recipes, costs, the +3 cap) live in packages/world/src/apothecary.ts
// and smithy.ts. Each purchase here is one batch built on `spendStatements`:
// the gold and materials are taken, and the brew or the upgrade is written,
// together or not at all. The checks are made again inside the batch, so two
// requests at once cannot both pay for the same thing.

import {
  APOTHECARY_PROJECT,
  SMITHY_PROJECT,
  brewBag,
  brewById,
  brewProblem,
  smithyCost,
  smithyProblem,
  smithyWork,
  upgradedName,
  type ItemKind,
  type Resources,
  type Slot,
  type SmithyCost,
  HARBOR_XP,
} from "@gantt-quest/world";
import { prepareXp, xpOutcome, type XpResult } from "./harbor-xp";
import { crewFor, spendStatements } from "./db";
import { builtProjectIds, projectStock } from "./projects";

async function crewBuilt(db: D1Database, playerId: string, projectId: string): Promise<boolean> {
  const crew = await crewFor(db, playerId);
  return !!crew && (await builtProjectIds(db, crew.id)).includes(projectId);
}

async function holdings(db: D1Database, playerId: string): Promise<{ gold: number; resources: Resources }> {
  const { gold = 0, ...resources } = await projectStock(db, playerId);
  return { gold, resources };
}

// ---------- the apothecary ----------

/** The brews a hero carries, at most one of each, in catalogue order. */
export async function brewBagOf(db: D1Database, playerId: string): Promise<string[]> {
  const rows = await db.prepare("SELECT brew_id FROM brews WHERE player_id = ?").bind(playerId).all<{ brew_id: string }>();
  return brewBag(rows.results.map((r) => r.brew_id));
}

export interface ApothecaryView {
  built: boolean;
  bag: string[];
  resources: Resources;
}

export async function apothecaryView(db: D1Database, playerId: string): Promise<ApothecaryView> {
  const [built, bag, held] = await Promise.all([crewBuilt(db, playerId, APOTHECARY_PROJECT), brewBagOf(db, playerId), holdings(db, playerId)]);
  return { built, bag, resources: held.resources };
}

/** Brew one thing into the bag. Returns an error message, or null once it is in the bag. */
export async function brew(db: D1Database, playerId: string, brewId: string): Promise<string | { xp?: XpResult }> {
  const view = await apothecaryView(db, playerId);
  const problem = brewProblem(brewId, view);
  if (problem) return problem;
  const def = brewById(brewId)!;
  // The bag is checked again inside the batch: a second brew of the same kind spends nothing.
  const notCarried = `NOT EXISTS (SELECT 1 FROM brews WHERE player_id = ?1 AND brew_id = '${def.id}')`;
  const spend = spendStatements(db, playerId, 0, def.recipe, notCarried);
  const xp = await prepareXp(db, playerId, HARBOR_XP.brew);
  const res = await db.batch([
    ...spend,
    db.prepare("INSERT INTO brews (player_id, brew_id, brewed_at) SELECT ?1, ?2, ?3 WHERE changes() > 0").bind(playerId, def.id, Date.now()),
    ...(xp?.statements() ?? []),
  ]);
  return res[spend.length].meta.changes > 0 ? { xp: xpOutcome(xp, res) } : "You no longer have what that takes, or it is already in your bag.";
}

/** A voyage has sailed: the brews each hero took aboard are used up. Brews made since boarding stay in the bag. */
export async function clearBrews(db: D1Database, heroes: { id: string; brews?: string[] }[]): Promise<void> {
  const stmts = heroes
    .filter((h) => h.brews && h.brews.length > 0)
    .map((h) => db.prepare(`DELETE FROM brews WHERE player_id = ? AND brew_id IN (${h.brews!.map(() => "?").join(",")})`).bind(h.id, ...h.brews!));
  if (stmts.length > 0) await db.batch(stmts);
}

// ---------- the smithy ----------

export interface SmithyItem {
  id: number;
  name: string;
  kind: ItemKind;
  slot: Slot;
  power: number;
  upgrades: number;
  equipped: boolean;
  /** What the next step costs, or null at the cap. */
  cost: SmithyCost | null;
}

export interface SmithyView {
  built: boolean;
  gold: number;
  resources: Resources;
  /** Weapons and armour worn or carried. Gear in the storage chest is left at home. */
  items: SmithyItem[];
}

type SmithyRow = { id: number; name: string; kind: ItemKind; slot: Slot; power: number; upgrades: number; equipped: number };

export async function smithyView(db: D1Database, playerId: string): Promise<SmithyView> {
  const [built, held, rows] = await Promise.all([
    crewBuilt(db, playerId, SMITHY_PROJECT),
    holdings(db, playerId),
    db
      .prepare("SELECT id, name, kind, slot, power, upgrades, equipped FROM inventory WHERE player_id = ? AND stored_in IS NULL AND kind IN ('weapon', 'armor') ORDER BY equipped DESC, id")
      .bind(playerId)
      .all<SmithyRow>(),
  ]);
  return {
    built,
    ...held,
    items: rows.results.map((r) => ({ ...r, equipped: !!r.equipped, cost: smithyCost(r, r.upgrades) })),
  };
}

/**
 * Take one item one step further at the forge. Returns an error message, or
 * the item's new name. The price comes from the catalogue, for the step the
 * item is on; the batch only goes through if the item is still on that step.
 */
export async function smithItem(db: D1Database, playerId: string, itemId: unknown): Promise<string | { name: string; xp?: XpResult }> {
  const id = typeof itemId === "number" && Number.isSafeInteger(itemId) && itemId > 0 ? itemId : null;
  if (id === null) return "No such item.";
  const view = await smithyView(db, playerId);
  const item = view.items.find((i) => i.id === id);
  if (!item) return view.built ? "Bring the item with you: worn or in your pack." : "The crew has not built the smithy yet.";
  const problem = smithyProblem(item, view);
  if (problem) return problem;
  if (!smithyWork(item)) return "The smith only works weapons and armour.";
  const cost = item.cost!;
  const stillOnThisStep = `(SELECT upgrades FROM inventory WHERE id = ${id} AND player_id = ?1 AND stored_in IS NULL AND kind IN ('weapon', 'armor')) = ${Math.floor(item.upgrades)}`;
  const spend = spendStatements(db, playerId, cost.gold, cost.resources, stillOnThisStep);
  const xp = await prepareXp(db, playerId, HARBOR_XP.smith);
  const res = await db.batch([
    ...spend,
    db.prepare("UPDATE inventory SET upgrades = upgrades + 1, power = power + 1 WHERE id = ?1 AND player_id = ?2 AND changes() > 0").bind(id, playerId),
    ...(xp?.statements() ?? []),
  ]);
  return res[spend.length].meta.changes > 0 ? { name: upgradedName(item.name, item.upgrades + 1), xp: xpOutcome(xp, res) } : "You no longer have what that costs.";
}
