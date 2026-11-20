// The apothecary and the smithy in D1: making potions and flasks for the
// pack, working gear at the forge, and what the two keepers sell from their
// own stock for gold, with the prices a customer talked them down to (the
// foot of this file). The galley has only its room: whether it is built.
//
// The rules (recipes, costs, the +3 cap) live in packages/world/src/apothecary.ts
// and smithy.ts. Each purchase here is one batch built on `spendStatements`:
// the gold and materials are taken, and the flask or the upgrade is written,
// together or not at all. The checks are made again inside the batch, so two
// requests at once cannot both pay for the same thing.

import {
  APOTHECARY_PROJECT,
  FLASK_RECIPES,
  GALLEY_PROJECT,
  KEEPER_PLACES,
  flaskYield,
  SHELF_DAILY,
  SHELF_PRICES,
  SMITHY_PROJECT,
  THROWABLES,
  THROWABLE_KINDS,
  addedSlots,
  carryProblem,
  flaskProblem,
  forgeKey,
  forgeStock,
  gatherDay,
  haggleAsk,
  haggleChances,
  haggleLine,
  haggleOutcome,
  haggledPrice,
  isKeeperShop,
  itemCells,
  shelfKey,
  smithyCost,
  smithyProblem,
  smithyWork,
  upgradedName,
  workKey,
  type Deal,
  type HaggleAsk,
  type ItemDef,
  type ItemKind,
  type KeeperShop,
  type Rarity,
  type Resources,
  type Slot,
  type SmithyCost,
  type CarryState,
  type Throwable,
  HARBOR_XP,
} from "@gantt-quest/world";
import { consumablesOf, type Consumables } from "./consumables";
import { prepareXp, xpOutcome, type XpResult } from "./harbor-xp";
import { carryState, crewFor, getCharacter, packHasRoomSql, paidItemStatement, spendStatements } from "./db";
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

export interface ApothecaryView {
  built: boolean;
  gold: number;
  resources: Resources;
  /** The potions, flasks and bombs already in the pack, and how full the pack is: the first of a kind needs a square. */
  carried: Consumables;
  carry: CarryState | null;
  /** What the apothecary sells ready-made, for gold. */
  wares: KeeperWare[];
  /** The chance, in percent, that he agrees to each ask from this hero. */
  chances: Record<HaggleAsk, number>;
}

export async function apothecaryView(db: D1Database, playerId: string): Promise<ApothecaryView> {
  const day = dealDay();
  const [built, held, carried, carry, c, deals] = await Promise.all([
    crewBuilt(db, playerId, APOTHECARY_PROJECT),
    holdings(db, playerId),
    consumablesOf(db, playerId),
    carryState(db, playerId),
    getCharacter(db, playerId),
    dealsOf(db, playerId, "apothecary", day),
  ]);
  const wares = THROWABLE_KINDS.map((kind): KeeperWare => {
    const key = shelfKey(kind);
    const row = deals.get(key);
    const qty = flaskYield(kind);
    const price = haggledPrice(SHELF_PRICES[kind], row?.pct ?? 0);
    const left = Math.max(0, SHELF_DAILY - (row?.bought ?? 0));
    const problem = !built ? "The crew has not built the apothecary yet."
      : left <= 0 ? `That is all the ${THROWABLES[kind].name.toLowerCase()}s he will sell you today.`
      : held.gold < price ? "Not enough gold."
      : carry ? carryProblem(carry, addedSlots(carried[kind] ?? 0, qty)) : null;
    return { key, goods: { kind: "flask", flask: kind, qty }, list: SHELF_PRICES[kind], price, deal: dealOf(row), left, problem };
  });
  return { built, gold: held.gold, resources: held.resources, carried, carry, wares, chances: haggleChances(c?.class_id ?? "") };
}

/**
 * Make one potion, flask or bomb and put it in the pack. Returns an error message, or what it earned.
 * The materials are taken and the pack gains one in a single batch, which checks again that the
 * materials are there and (for the first of a kind, which takes a square) that the pack has the room.
 */
export async function brewFlask(db: D1Database, playerId: string, kind: string): Promise<string | { xp?: XpResult }> {
  const view = await apothecaryView(db, playerId);
  const problem = flaskProblem(kind, view);
  if (problem) return problem;
  const k = kind as Throwable;
  const made = flaskYield(k);
  const squares = addedSlots(view.carried[k] ?? 0, made);
  const spend = spendStatements(db, playerId, 0, FLASK_RECIPES[k], squares > 0 && view.carry ? packHasRoomSql(view.carry.limit, squares) : "1");
  const xp = await prepareXp(db, playerId, HARBOR_XP.brew);
  const res = await db.batch([
    ...spend,
    db.prepare("INSERT INTO consumables (player_id, kind, qty) SELECT ?1, ?2, ?3 WHERE changes() > 0 ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + ?3").bind(playerId, k, made),
    ...(xp?.statements() ?? []),
  ]);
  return res[spend.length].meta.changes > 0 ? { xp: xpOutcome(xp, res) } : "You no longer have what that takes, or the room in your pack for it.";
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
  /** For the item's pixel icon in the list. */
  icon: string;
  rarity: Rarity;
  /** What the next step costs, or null at the cap. The gold is what it comes to today, after any haggling. */
  cost: SmithyCost | null;
  /** The gold the next step is listed at, before any haggling: 0 for armour, which takes none. */
  listGold: number;
  /** What was asked off the smith's work on this item today, and what came of it. Null if nothing was. */
  deal: Deal | null;
}

export interface SmithyView {
  built: boolean;
  gold: number;
  resources: Resources;
  /** Weapons and armour worn or carried. Gear in the storage chest is left at home. */
  items: SmithyItem[];
  /** What the smith has made to sell, for gold. */
  wares: KeeperWare[];
  /** The chance, in percent, that she agrees to each ask from this hero. */
  chances: Record<HaggleAsk, number>;
}

type SmithyRow = { id: number; name: string; kind: ItemKind; slot: Slot; power: number; upgrades: number; equipped: number; icon: string; rarity: Rarity };

export async function smithyView(db: D1Database, playerId: string): Promise<SmithyView> {
  const day = dealDay();
  const [built, held, rows, c, carry, deals] = await Promise.all([
    crewBuilt(db, playerId, SMITHY_PROJECT),
    holdings(db, playerId),
    db
      .prepare("SELECT id, name, kind, slot, power, upgrades, equipped, icon, rarity FROM inventory WHERE player_id = ? AND stored_in IS NULL AND kind IN ('weapon', 'armor') ORDER BY equipped DESC, id")
      .bind(playerId)
      .all<SmithyRow>(),
    getCharacter(db, playerId),
    carryState(db, playerId),
    dealsOf(db, playerId, "smithy", day),
  ]);
  // The rack is the customer's own for the day, like the stall's stock: derived again whenever it is needed.
  const rack = c?.status === "active" ? forgeStock(`${playerId}|${day}`, c.class_id, c.level) : [];
  const wares = rack.map((e): KeeperWare => {
    const key = forgeKey(e.index);
    const row = deals.get(key);
    const price = haggledPrice(e.price, row?.pct ?? 0);
    const left = (row?.bought ?? 0) > 0 ? 0 : 1;
    const problem = !built ? "The crew has not built the smithy yet."
      : left <= 0 ? "Sold."
      : held.gold < price ? "Not enough gold."
      : carry ? carryProblem(carry, itemCells(e.item)) : null;
    return { key, goods: { kind: "item", item: e.item }, list: e.price, price, deal: dealOf(row), left, problem };
  });
  return {
    built,
    ...held,
    items: rows.results.map((r) => {
      const deal = dealOf(deals.get(workKey(r.id)));
      return { ...r, equipped: !!r.equipped, cost: smithyCost(r, r.upgrades, deal?.pct ?? 0), listGold: smithyCost(r, r.upgrades)?.gold ?? 0, deal };
    }),
    wares,
    chances: haggleChances(c?.class_id ?? ""),
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

// ---------- the galley ----------

/** The galley as someone standing in it sees it: only whether their crew has built it. The cook sells and makes nothing. */
export interface GalleyView {
  built: boolean;
}

export async function galleyView(db: D1Database, playerId: string): Promise<GalleyView> {
  return { built: await crewBuilt(db, playerId, GALLEY_PROJECT) };
}

// ---------- the keepers: their own stock, and haggling ----------

/** One thing a keeper sells from their own stock, as one customer sees it today. */
export interface KeeperWare {
  /** What it is bought and haggled over by: "flask:healing", "gear:2". */
  key: string;
  goods: { kind: "flask"; flask: Throwable; qty: number } | { kind: "item"; item: ItemDef };
  /** The price on the shelf. */
  list: number;
  /** What it costs this customer today, after any haggling. */
  price: number;
  /** What they asked off it today and what came of it, or null if they have not haggled over it. */
  deal: Deal | null;
  /** How many more of it they may buy today. */
  left: number;
  /** Why it cannot be bought now, or null if it can. */
  problem: string | null;
}

interface DealRow {
  ask: HaggleAsk | null;
  pct: number;
  bought: number;
}

/** The day a keeper's prices and limits are for: the UTC date, as for gathering. */
const dealDay = () => gatherDay(Date.now());

const dealOf = (row: DealRow | undefined): Deal | null => (row?.ask ? { ask: row.ask, pct: row.pct } : null);

/** What this player haggled over and bought at a shop today, by entry. */
async function dealsOf(db: D1Database, playerId: string, shop: KeeperShop, day: string): Promise<Map<string, DealRow>> {
  const rows = await db
    .prepare("SELECT entry, ask, pct, bought FROM keeper_deals WHERE player_id = ? AND shop = ? AND day = ?")
    .bind(playerId, shop, day)
    .all<{ entry: string; ask: string | null; pct: number; bought: number }>();
  return new Map(rows.results.map((r) => [r.entry, { ask: haggleAsk(r.ask)?.id ?? null, pct: r.pct, bought: r.bought }]));
}

const keeperView = (db: D1Database, playerId: string, shop: KeeperShop) =>
  shop === "apothecary" ? apothecaryView(db, playerId) : smithyView(db, playerId);

/**
 * Buy one thing from a keeper's own stock. Returns an error message, or what was had. The price is the
 * day's for this customer (the list price, less anything they talked off it), never the request's. The
 * gold goes, the day's count goes up and the thing arrives in one batch, which checks the gold, the
 * daily limit and the room in the pack again.
 */
export async function buyFromKeeper(db: D1Database, playerId: string, shop: KeeperShop, key: unknown): Promise<string | { got: string }> {
  const day = dealDay();
  const view = await keeperView(db, playerId, shop);
  const ware = view.wares.find((w) => w.key === key);
  if (!ware) return `${KEEPER_PLACES[shop].keeper.trade.replace(/^t/, "T")} has nothing like that.`;
  if (ware.problem) return ware.problem;
  const { goods } = ware;
  // Inlined into the spend, so only what the catalogue and the clock made: never the request's own text.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^[a-z]+:[a-z0-9_]+$/.test(ware.key)) return "Not today.";
  const limit = goods.kind === "flask" ? SHELF_DAILY : 1;
  const notSoldOut = `COALESCE((SELECT bought FROM keeper_deals WHERE player_id = ?1 AND shop = '${shop}' AND day = '${day}' AND entry = '${ware.key}'), 0) < ${limit}`;
  const counted = db
    .prepare("INSERT INTO keeper_deals (player_id, shop, day, entry, bought) SELECT ?1, ?2, ?3, ?4, 1 WHERE changes() > 0 ON CONFLICT(player_id, shop, day, entry) DO UPDATE SET bought = bought + 1")
    .bind(playerId, shop, day, ware.key);

  const carry = shop === "apothecary" ? (view as ApothecaryView).carry : await carryState(db, playerId);
  const cells = goods.kind === "flask" ? addedSlots((view as ApothecaryView).carried[goods.flask] ?? 0, goods.qty) : itemCells(goods.item);
  const spend = spendStatements(db, playerId, ware.price, {}, `${notSoldOut} AND ${cells > 0 && carry ? packHasRoomSql(carry.limit, cells) : "1"}`);
  const res = await db.batch([
    ...spend,
    counted,
    goods.kind === "flask"
      ? db.prepare("INSERT INTO consumables (player_id, kind, qty) SELECT ?1, ?2, ?3 WHERE changes() > 0 ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + ?3").bind(playerId, goods.flask, goods.qty)
      : paidItemStatement(db, playerId, goods.item),
  ]);
  if (res[res.length - 1].meta.changes === 0) return "You no longer have the gold for that, or the room in your pack, or it has gone.";
  return { got: goods.kind === "flask" ? `${THROWABLES[goods.flask].name}${goods.qty > 1 ? ` × ${goods.qty}` : ""}` : goods.item.name };
}

export interface HaggleResult {
  deal: Deal;
  won: boolean;
  /** What the keeper says to it. */
  line: string;
  /** The price before, and the price for the rest of today. */
  list: number;
  price: number;
}

/**
 * Ask a keeper to take something off a price. One try a day for each thing they sell or do for gold;
 * the answer is kept either way. `roll` (0 up to 100) is the luck of it: the dice, unless a test names it.
 * Returns an error message, or how it came out.
 */
export async function haggle(db: D1Database, playerId: string, shop: unknown, key: unknown, ask: unknown, roll = Math.random() * 100): Promise<string | HaggleResult> {
  if (!isKeeperShop(shop)) return "There is nobody there to haggle with.";
  const asked = haggleAsk(ask);
  if (!asked) return "Ask for what, exactly?";
  const c = await getCharacter(db, playerId);
  if (c?.status !== "active") return "Create a character first.";
  const day = dealDay();
  const view = await keeperView(db, playerId, shop);
  if (!view.built) return `The crew has not built ${KEEPER_PLACES[shop].title.toLowerCase()} yet.`;

  // What is being haggled over: something on the shelf or the rack, or the smith's work on one item.
  const ware = view.wares.find((w) => w.key === key);
  const work = shop === "smithy" ? (view as SmithyView).items.find((i) => workKey(i.id) === key) : undefined;
  let list: number;
  let already: Deal | null;
  if (ware) {
    if (ware.left <= 0) return "There is none of that left to haggle over today.";
    list = ware.list;
    already = ware.deal;
  } else if (work) {
    if (!work.cost) return `${work.name} is as good as the smith can make it.`;
    if (work.listGold <= 0) return "Reinforcing takes iron and copper, not gold. There is no price to talk down.";
    list = work.listGold;
    already = work.deal;
  } else {
    return "There is nothing like that to haggle over.";
  }
  const had = "You have had your say on that today. Try again tomorrow.";
  if (already) return had;

  const deal = haggleOutcome(asked.id, c.class_id, roll);
  const entry = ware ? ware.key : workKey(work!.id);
  const res = await db.batch([
    // Yesterday's prices are no use to anyone.
    db.prepare("DELETE FROM keeper_deals WHERE player_id = ? AND day < ?").bind(playerId, day),
    // A row may be there already from a purchase; an answer already given is never changed.
    db
      .prepare(
        "INSERT INTO keeper_deals (player_id, shop, day, entry, ask, pct) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(player_id, shop, day, entry) DO UPDATE SET ask = excluded.ask, pct = excluded.pct WHERE keeper_deals.ask IS NULL",
      )
      .bind(playerId, shop, day, entry, deal.ask, deal.pct),
  ]);
  if (res[1].meta.changes === 0) return had;
  return { deal, won: deal.pct > 0, line: haggleLine(shop, deal, Math.floor(roll)), list, price: haggledPrice(list, deal.pct) };
}
