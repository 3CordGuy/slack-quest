// Trading between crewmates.
//
// A trade is a table two players stand at. Each lays out their own side of
// it: unequipped gear, gold and hut materials. Each then accepts what they
// see. When both have accepted, everything on the table changes hands at
// once. Changing either side takes both acceptances back, so nobody agrees
// to one thing and gets another. A trade where one side is left empty is a
// gift.
//
// This file holds a side's shape, the reading of an untrusted request into
// that shape, and the checks a side must pass. The server stores the trade
// and moves the goods; it runs these same checks again, on fresh holdings,
// when the trade is settled.

import { PACK_CELLS, PACK_COLS, PACK_ROWS, stackSlots } from "./carry";
import { RESOURCE_KINDS, RESOURCE_LABEL, type ResourceKind, type Resources } from "./hut";

/** A side of the table is a grid like the pack: what is laid on it has to fit in these squares. */
export const TRADE_COLS = PACK_COLS;
export const TRADE_ROWS = PACK_ROWS;
export const TRADE_CELLS = PACK_CELLS;
/** Most gold on one side of a trade. */
export const TRADE_MAX_GOLD = 1_000_000;
/** Most of one material on one side of a trade. */
export const TRADE_MAX_QTY = 9_999;
/** A trade nobody settles lapses after this long. */
export const TRADE_TTL_MS = 15 * 60_000;

/** Gold and materials. */
export interface TradeGoods {
  gold: number;
  resources: Resources;
}

/** What one player has laid on the table. `items` are inventory row ids. */
export interface TradeSide extends TradeGoods {
  items: number[];
}

export const emptySide = (): TradeSide => ({ items: [], gold: 0, resources: {} });

/** True if nothing is laid on this side. */
export const sideIsEmpty = (side: TradeSide) => side.items.length === 0 && side.gold === 0 && RESOURCE_KINDS.every((k) => !side.resources[k]);

/** What a player has to trade with, as the checks need to know it. */
export interface TradeHoldings {
  gold: number;
  resources: Resources;
  /** Every item the player owns, worn or not. `cells` is the squares of its footprint (one, if not said). */
  items: { id: number; equipped: boolean; name?: string; /** In the storage chest at home, out of reach until taken out there. */ stored?: boolean; cells?: number }[];
}

/** "30 gold, 2 wood", in the catalogue's order; "" for nothing. */
export function tradeGoodsText(goods: TradeGoods): string {
  return [
    ...(goods.gold > 0 ? [`${goods.gold} gold`] : []),
    ...RESOURCE_KINDS.filter((k) => goods.resources[k]).map((k) => `${goods.resources[k]} ${RESOURCE_LABEL[k].toLowerCase()}`),
  ].join(", ");
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isAmount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * Read a request body into a side of a trade. Anything that is not a whole
 * positive amount of a known thing is refused rather than rounded or dropped,
 * so what is stored is exactly what was sent. The materials come out in the
 * catalogue's order, so the same side always reads the same. Returns the
 * side, or why not.
 */
export function readTradeSide(raw: unknown): { ok: true; side: TradeSide } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (raw === undefined || raw === null) return { ok: true, side: emptySide() };
  if (!isRecord(raw)) return fail("That offer is not readable.");
  const stray = Object.keys(raw).find((k) => !["items", "gold", "resources"].includes(k));
  if (stray) return fail(`Only gear, gold and hut materials can change hands, not "${stray}".`);
  const side = emptySide();
  if (raw.gold !== undefined && raw.gold !== 0) {
    if (!isAmount(raw.gold)) return fail("Gold must be a whole number above zero.");
    side.gold = raw.gold;
  }
  if (raw.resources !== undefined && raw.resources !== null) {
    if (!isRecord(raw.resources)) return fail("That offer is not readable.");
    const unknown = Object.keys(raw.resources).find((k) => !RESOURCE_KINDS.includes(k as ResourceKind));
    if (unknown) return fail(`"${unknown}" is not something that can be traded.`);
    for (const kind of RESOURCE_KINDS) {
      const qty = raw.resources[kind];
      if (qty === 0 || qty === undefined) continue;
      if (!isAmount(qty)) return fail(`${RESOURCE_LABEL[kind]} must be a whole number above zero.`);
      side.resources[kind] = qty;
    }
  }
  if (raw.items !== undefined && raw.items !== null) {
    if (!Array.isArray(raw.items)) return fail("The items in the offer are not readable.");
    for (const id of raw.items) {
      if (!isAmount(id) || !Number.isSafeInteger(id)) return fail("The items in the offer are not readable.");
      side.items.push(id);
    }
  }
  return { ok: true, side };
}

/** The squares a side takes up on the table: each piece of gear by its footprint, a square a stack of material. */
export function sideCells(side: TradeSide, holdings: Pick<TradeHoldings, "items">): number {
  let cells = 0;
  for (const id of side.items) cells += holdings.items.find((i) => i.id === id)?.cells ?? 1;
  for (const kind of RESOURCE_KINDS) cells += stackSlots(side.resources[kind] ?? 0);
  return cells;
}

/** "You do not have" / "Mira does not have". */
const lacks = (who: string) => (who === "You" ? "You do not have" : `${who} does not have`);

/**
 * Why this side cannot stand, or null if it can: its own shape (whole
 * positive amounts, caps, nothing twice, no more than the table holds) and
 * then that the player really has it to give: the items are theirs, carried
 * and not worn, and they hold the gold and the materials. `who` is how the
 * player is named in the message; "You" reads naturally for whoever is told.
 */
export function sideProblem(side: TradeSide, holdings: TradeHoldings, who = "You"): string | null {
  const you = who === "You";
  if (side.gold !== 0 && !isAmount(side.gold)) return "Gold must be a whole number above zero.";
  if (side.gold > TRADE_MAX_GOLD) return `No more than ${TRADE_MAX_GOLD} gold in one trade.`;
  for (const [kind, qty] of Object.entries(side.resources)) {
    if (!RESOURCE_KINDS.includes(kind as ResourceKind)) return `"${kind}" is not something that can be traded.`;
    if (qty === 0 || qty === undefined) continue;
    if (!isAmount(qty)) return `${RESOURCE_LABEL[kind as ResourceKind]} must be a whole number above zero.`;
    if (qty > TRADE_MAX_QTY) return `No more than ${TRADE_MAX_QTY} ${RESOURCE_LABEL[kind as ResourceKind].toLowerCase()} in one trade.`;
  }
  const { items } = side;
  if (items.some((id) => !isAmount(id))) return "The items in the offer are not readable.";
  if (new Set(items).size !== items.length) return "The same item is in the offer twice.";
  for (const id of items) {
    const held = holdings.items.find((i) => i.id === id);
    if (!held) return you ? "You no longer have one of those items." : `${who} no longer has one of those items.`;
    if (held.stored) return you ? `${held.name ?? "That item"} is in storage at home. Take it out there first.` : `${who} has put ${held.name ?? "one of those items"} in storage.`;
    if (held.equipped) return you ? `Unequip ${held.name ?? "that item"} first.` : `${who} is wearing ${held.name ?? "one of those items"} now.`;
  }
  if (sideCells(side, holdings) > TRADE_CELLS) return `That is more than fits on the table: ${TRADE_COLS} × ${TRADE_ROWS} squares a side.`;
  if (side.gold > holdings.gold) return `${lacks(who)} ${side.gold} gold.`;
  for (const kind of RESOURCE_KINDS) {
    const qty = side.resources[kind] ?? 0;
    if (qty > (holdings.resources[kind] ?? 0)) return `${lacks(who)} ${qty} ${RESOURCE_LABEL[kind].toLowerCase()}.`;
  }
  return null;
}

/** One side as it bears on a pack: the squares of its gear, and its materials. */
export interface TradeLoad {
  cells: number;
  resources: Resources;
}

/**
 * Why a player's pack cannot take what the trade brings them, or null if it
 * can. What they hand over makes room first. `held` is the materials in
 * their pack now. A trade that leaves the pack no fuller than it was always
 * goes through, even from a pack already over its limit.
 */
export function tradeRoomProblem(pack: { carried: number; limit: number }, held: Resources, out: TradeLoad, coming: TradeLoad, who = "You"): string | null {
  let after = pack.carried - out.cells + coming.cells;
  for (const kind of RESOURCE_KINDS) {
    const has = held[kind] ?? 0;
    after += stackSlots(Math.max(0, has - (out.resources[kind] ?? 0) + (coming.resources[kind] ?? 0))) - stackSlots(has);
  }
  if (after <= pack.limit || after <= pack.carried) return null;
  const would = `this trade would leave it holding ${after} of ${pack.limit} squares.`;
  return who === "You" ? `Your pack is full: ${would} Make room first.` : `${who}'s pack is full: ${would}`;
}
