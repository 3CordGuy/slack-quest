// Giving and trading between crewmates.
//
// One player offers another unequipped gear, gold and hut materials, and may
// ask for gold and materials in return. An offer that asks for nothing is a
// gift. This file holds the offer's shape, the reading of an untrusted
// request into that shape, and the checks an offer must pass. The server
// stores offers and moves the goods; it runs these same checks again, on
// fresh holdings, when the offer is accepted.

import { RESOURCE_KINDS, RESOURCE_LABEL, type ResourceKind, type Resources } from "./hut";

/** Most items one offer can carry. */
export const TRADE_MAX_ITEMS = 8;
/** Most gold on one side of an offer. */
export const TRADE_MAX_GOLD = 1_000_000;
/** Most of one material on one side of an offer. */
export const TRADE_MAX_QTY = 9_999;
/** An offer nobody answers lapses after this long. */
export const TRADE_TTL_MS = 15 * 60_000;

/** Gold and materials: what either side of an offer can hold. */
export interface TradeGoods {
  gold: number;
  resources: Resources;
}

export interface TradeOffer {
  /** The crewmate the offer is made to. */
  to: string;
  /** What the proposer hands over. `items` are inventory row ids. */
  give: TradeGoods & { items: number[] };
  /** What the proposer wants back. Nothing asked makes the offer a gift. */
  ask: TradeGoods;
}

/** What a player has to trade with, as the checks need to know it. */
export interface TradeHoldings {
  gold: number;
  resources: Resources;
  /** Every item the player owns, worn or not. */
  items: { id: number; equipped: boolean; name?: string }[];
}

const isEmpty = (goods: TradeGoods) => goods.gold === 0 && RESOURCE_KINDS.every((k) => !goods.resources[k]);

/** True if the offer asks for nothing in return. */
export const isGift = (offer: TradeOffer) => isEmpty(offer.ask);

/** "30 gold, 2 wood", in the catalogue's order; "" for nothing. */
export function tradeGoodsText(goods: TradeGoods): string {
  return [
    ...(goods.gold > 0 ? [`${goods.gold} gold`] : []),
    ...RESOURCE_KINDS.filter((k) => goods.resources[k]).map((k) => `${goods.resources[k]} ${RESOURCE_LABEL[k].toLowerCase()}`),
  ].join(", ");
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isAmount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

function readGoods(raw: unknown, side: string, allowed: readonly string[]): TradeGoods | string {
  if (raw === undefined || raw === null) return { gold: 0, resources: {} };
  if (!isRecord(raw)) return `The ${side} side of the offer is not readable.`;
  const stray = Object.keys(raw).find((k) => !allowed.includes(k));
  if (stray) return `Only gear, gold and hut materials can change hands, not "${stray}".`;
  const goods: TradeGoods = { gold: 0, resources: {} };
  if (raw.gold !== undefined && raw.gold !== 0) {
    if (!isAmount(raw.gold)) return "Gold must be a whole number above zero.";
    goods.gold = raw.gold;
  }
  if (raw.resources !== undefined && raw.resources !== null) {
    if (!isRecord(raw.resources)) return `The ${side} side of the offer is not readable.`;
    for (const [kind, qty] of Object.entries(raw.resources)) {
      if (!RESOURCE_KINDS.includes(kind as ResourceKind)) return `"${kind}" is not something that can be traded.`;
      if (qty === 0 || qty === undefined) continue;
      if (!isAmount(qty)) return `${RESOURCE_LABEL[kind as ResourceKind]} must be a whole number above zero.`;
      goods.resources[kind as ResourceKind] = qty;
    }
  }
  return goods;
}

/**
 * Read a request body into an offer. Anything that is not a whole positive
 * amount of a known thing is refused rather than rounded or dropped, so what
 * is stored is exactly what was sent. Returns the offer, or why not.
 */
export function readTradeOffer(raw: unknown): { ok: true; offer: TradeOffer } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!isRecord(raw)) return fail("That offer is not readable.");
  if (typeof raw.to !== "string" || raw.to.length === 0 || raw.to.length > 64) return fail("Name the crewmate the offer is for.");
  const give = readGoods(raw.give, "giving", ["items", "gold", "resources"]);
  if (typeof give === "string") return fail(give);
  // Asking for particular items of the other player's is not supported.
  const ask = readGoods(raw.ask, "asking", ["gold", "resources"]);
  if (typeof ask === "string") return fail(ask.includes('"items"') ? "You can ask for gold and materials, not for particular items." : ask);
  const rawItems = isRecord(raw.give) ? raw.give.items : undefined;
  const items: number[] = [];
  if (rawItems !== undefined && rawItems !== null) {
    if (!Array.isArray(rawItems)) return fail("The items in the offer are not readable.");
    for (const id of rawItems) {
      if (!isAmount(id) || !Number.isSafeInteger(id)) return fail("The items in the offer are not readable.");
      items.push(id);
    }
  }
  return { ok: true, offer: { to: raw.to, give: { ...give, items }, ask } };
}

function goodsProblem(goods: TradeGoods): string | null {
  if (goods.gold !== 0 && !isAmount(goods.gold)) return "Gold must be a whole number above zero.";
  if (goods.gold > TRADE_MAX_GOLD) return `No more than ${TRADE_MAX_GOLD} gold in one offer.`;
  for (const [kind, qty] of Object.entries(goods.resources)) {
    if (!RESOURCE_KINDS.includes(kind as ResourceKind)) return `"${kind}" is not something that can be traded.`;
    if (qty === 0 || qty === undefined) continue;
    if (!isAmount(qty)) return `${RESOURCE_LABEL[kind as ResourceKind]} must be a whole number above zero.`;
    if (qty > TRADE_MAX_QTY) return `No more than ${TRADE_MAX_QTY} ${RESOURCE_LABEL[kind as ResourceKind].toLowerCase()} in one offer.`;
  }
  return null;
}

/** "You do not have" / "Mira does not have". */
const lacks = (who: string) => (who === "You" ? "You do not have" : `${who} does not have`);

function shortOf(goods: TradeGoods, holdings: TradeHoldings, who: string): string | null {
  if (goods.gold > holdings.gold) return `${lacks(who)} ${goods.gold} gold.`;
  for (const kind of RESOURCE_KINDS) {
    const qty = goods.resources[kind] ?? 0;
    if (qty > (holdings.resources[kind] ?? 0)) return `${lacks(who)} ${qty} ${RESOURCE_LABEL[kind].toLowerCase()}.`;
  }
  return null;
}

export interface TradeContext {
  /** The player making the offer. */
  from: string;
  /** What the proposer holds right now. */
  giver: TradeHoldings;
  /** What the other player holds right now. Left out when proposing: they may yet come by what is asked. */
  taker?: TradeHoldings;
  /** How each side is named in a message. "You" reads naturally for whoever is being told. */
  giverName?: string;
  takerName?: string;
}

/**
 * Why this offer cannot stand, or null if it can. Checks the offer's own
 * shape (whole positive amounts, caps, no self-trade, nothing on both sides,
 * something actually given) and then that each side holds what it promises:
 * the proposer's items are theirs and not worn, and both have the gold and
 * materials.
 */
export function tradeProblem(offer: TradeOffer, ctx: TradeContext): string | null {
  const giverName = ctx.giverName ?? "You";
  const takerName = ctx.takerName ?? "They";
  if (offer.to === ctx.from) return "You cannot trade with yourself.";
  const bad = goodsProblem(offer.give) ?? goodsProblem(offer.ask);
  if (bad) return bad;
  const { items } = offer.give;
  if (items.some((id) => !isAmount(id))) return "The items in the offer are not readable.";
  if (new Set(items).size !== items.length) return "The same item is in the offer twice.";
  if (items.length > TRADE_MAX_ITEMS) return `No more than ${TRADE_MAX_ITEMS} items in one offer.`;
  if (items.length === 0 && isEmpty(offer.give)) return "Put something in the offer first.";
  if (offer.give.gold > 0 && offer.ask.gold > 0) return "Gold cannot be on both sides of a trade.";
  const both = RESOURCE_KINDS.find((k) => offer.give.resources[k] && offer.ask.resources[k]);
  if (both) return `${RESOURCE_LABEL[both]} cannot be on both sides of a trade.`;

  for (const id of items) {
    const held = ctx.giver.items.find((i) => i.id === id);
    if (!held) return giverName === "You" ? "You no longer have one of those items." : `${giverName} no longer has one of those items.`;
    if (held.equipped) return giverName === "You" ? `Unequip ${held.name ?? "that item"} first.` : `${giverName} is wearing ${held.name ?? "one of those items"} now.`;
  }
  return shortOf(offer.give, ctx.giver, giverName) ?? (ctx.taker ? shortOf(offer.ask, ctx.taker, takerName) : null);
}
