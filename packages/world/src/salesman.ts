// Traveling salesmen: now and then someone off a passing boat takes the
// corner table in the crew's pub for a few hours, with a small, odd stock
// the market stall does not carry.
//
// Nothing schedules them. Who is in, and when the next one is due, follow
// from the wall clock and the crew's id alone, so every crewmate sees the
// same visitor and no Durable Object needs a timer. Their stock follows from
// the same seed (plus the buyer, for the curio dealer's gear), so the server
// re-derives it to check a purchase instead of storing it, as the stall does.

import { FURNISHINGS, RESOURCE_KINDS, RESOURCE_LABEL, canAfford, type Resources } from "./hut";
import { FOUND_BLUEPRINTS } from "./drops";
import { itemPrice, rollItem, type ItemDef } from "./gear";
import { makeRng, seedFromString, type Rng } from "./rng";

// ---------- who they are ----------

export type SalesmanId = "curio" | "plans" | "far" | "herbs";

export interface Salesman {
  id: SalesmanId;
  name: string;
  /** What they are, in a few words: "a curio dealer". */
  trade: string;
  /** What they say when you walk up. */
  greeting: string;
  /** Sprite kind for the renderer (render/sprites.ts). */
  look: string;
}

export const SALESMEN: Salesman[] = [
  { id: "curio", name: "Ilse Marrow", trade: "a curio dealer", greeting: "Every piece here has a story. I charge for the story.", look: "salesman_curio" },
  { id: "plans", name: "Corwin Pell", trade: "a peddler of plans", greeting: "Plans for things you have not built yet. Cheaper than finding them in a cave.", look: "salesman_plans" },
  { id: "far", name: "Saffi Tern", trade: "a trader in far goods", greeting: "All of it from further out than your boats go. Mind the paint, some of it is still drying.", look: "salesman_far" },
  { id: "herbs", name: "Mother Bramble", trade: "a herbalist", greeting: "Bring me what grows in the damp. I pay better than the stall, and I do not haggle.", look: "salesman_herbs" },
];

export const salesman = (id: string): Salesman | undefined => SALESMEN.find((s) => s.id === id);

// ---------- when they come ----------

/** The day is cut into slots this long. A visitor stays for a whole slot. */
export const SALESMAN_SLOT_MS = 6 * 60 * 60_000;
/** The chance that a slot is a visit, before the gap rule. With the gap rule, about five visits a week. */
export const SALESMAN_CHANCE = 0.25;
/** How far ahead `nextSalesmanVisit` looks. */
const LOOKAHEAD_SLOTS = 4 * 7 * 4;

export interface SalesmanVisit {
  /** The slot number: the visit's id, shared by the whole crew. */
  visit: number;
  salesmanId: SalesmanId;
  /** Epoch ms. */
  startsAt: number;
  endsAt: number;
}

const slotRng = (crewId: string, slot: number): Rng => makeRng(seedFromString(`salesman|${crewId}|${slot}`));

/** Whether slot `slot` rolls a visit at all, before the gap rule. */
const rolls = (crewId: string, slot: number) => slotRng(crewId, slot).next() < SALESMAN_CHANCE;

/**
 * The visit in slot `slot`, or null. A slot only holds a visit if the slot
 * before it did not roll one, so there is always at least one empty slot
 * between two visits.
 */
export function salesmanVisitInSlot(crewId: string, slot: number): SalesmanVisit | null {
  if (!crewId || !Number.isSafeInteger(slot)) return null;
  const rng = slotRng(crewId, slot);
  if (rng.next() >= SALESMAN_CHANCE || rolls(crewId, slot - 1)) return null;
  return { visit: slot, salesmanId: rng.pick(SALESMEN).id, startsAt: slot * SALESMAN_SLOT_MS, endsAt: (slot + 1) * SALESMAN_SLOT_MS };
}

/** Who is in the crew's pub at `at` (epoch ms), if anyone. */
export function salesmanVisitAt(crewId: string, at: number): SalesmanVisit | null {
  return salesmanVisitInSlot(crewId, Math.floor(at / SALESMAN_SLOT_MS));
}

/** The next visit to start after `at`, or null if none is due within four weeks. */
export function nextSalesmanVisit(crewId: string, at: number): SalesmanVisit | null {
  const from = Math.floor(at / SALESMAN_SLOT_MS) + 1;
  for (let slot = from; slot < from + LOOKAHEAD_SLOTS; slot++) {
    const v = salesmanVisitInSlot(crewId, slot);
    if (v) return v;
  }
  return null;
}

// ---------- what they sell ----------

/** What the player gets for an entry. */
export type SalesGoods =
  | { kind: "item"; item: ItemDef }
  | { kind: "blueprint"; defId: string }
  | { kind: "furnishing"; defId: string }
  | { kind: "gold"; gold: number };

export interface SalesEntry {
  index: number;
  goods: SalesGoods;
  /** Gold the player pays. */
  price: number;
  /** Materials the player hands over. */
  materials: Resources;
}

/** Far goods: furnishings that only a salesman carries, and what they cost. */
export const FAR_GOODS: Record<string, number> = { globe: 140, ship_bottle: 90, shell_chimes: 70 };

/** A curio costs this much more than the same piece would at the stall. */
export const CURIO_MARKUP = 1.3;

/** What a blueprint costs: dearer the more its piece takes to build. */
export function blueprintPrice(defId: string): number {
  const recipe = FURNISHINGS[defId]?.recipe ?? {};
  return 60 + 4 * Object.values(recipe).reduce((a, n) => a + (n ?? 0), 0);
}

/** `count` different picks from `items`, in a seeded order. */
function some<T>(rng: Rng, items: readonly T[], count: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (pool.length > 0 && out.length < count) out.push(pool.splice(Math.floor(rng.next() * pool.length), 1)[0]);
  return out;
}

/**
 * One visit's stock, as the buyer sees it. Everyone in the crew sees the same
 * stock, except the curio dealer's gear: each player gets pieces of their own,
 * rolled for their class and level. Deterministic in its arguments.
 */
export function salesmanStock(crewId: string, visit: SalesmanVisit, playerId: string, classId: string, level: number): SalesEntry[] {
  const own = visit.salesmanId === "curio" ? `|${playerId}|${classId}` : "";
  const rng = makeRng(seedFromString(`salesman-stock|${crewId}|${visit.visit}|${visit.salesmanId}${own}`));
  const entry = (index: number, goods: SalesGoods, price: number, materials: Resources = {}): SalesEntry => ({ index, goods, price, materials });

  switch (visit.salesmanId) {
    case "curio":
      // Three pieces, none below rare, one of them a level above the buyer.
      return [0, 1, 2].map((index) => {
        const item = rollItem(rng, classId, 0.7, index === 2 ? level + 1 : level, undefined, "rare");
        return entry(index, { kind: "item", item }, Math.round(itemPrice(item) * CURIO_MARKUP));
      });
    case "plans":
      // Blueprints that are otherwise only found on a voyage.
      return some(rng, FOUND_BLUEPRINTS, 3).map((defId, index) => entry(index, { kind: "blueprint", defId }, blueprintPrice(defId)));
    case "far":
      return some(rng, Object.keys(FAR_GOODS), 2).map((defId, index) => entry(index, { kind: "furnishing", defId }, FAR_GOODS[defId]));
    case "herbs": {
      // Bundles of foraged goods, each paid well above the stall's 3 gold a piece.
      const herbs = rng.int(4, 8);
      const mushrooms = rng.int(4, 8);
      const mixed = rng.int(3, 5);
      return [
        entry(0, { kind: "gold", gold: herbs * rng.int(5, 6) }, 0, { herbs }),
        entry(1, { kind: "gold", gold: mushrooms * rng.int(5, 7) }, 0, { mushrooms }),
        entry(2, { kind: "gold", gold: mixed * 2 * 7 }, 0, { herbs: mixed, mushrooms: mixed }),
      ];
    }
  }
}

/** What an entry is called, for a list or a message. */
export function salesGoodsName(goods: SalesGoods): string {
  if (goods.kind === "item") return goods.item.name;
  if (goods.kind === "blueprint") return `Blueprint: ${FURNISHINGS[goods.defId]?.name ?? goods.defId}`;
  if (goods.kind === "furnishing") return FURNISHINGS[goods.defId]?.name ?? goods.defId;
  return `${goods.gold} gold`;
}

/** "5 herbs, 5 mushrooms". */
export function resourcesText(r: Resources): string {
  return RESOURCE_KINDS.filter((k) => (r[k] ?? 0) > 0).map((k) => `${r[k]} ${RESOURCE_LABEL[k].toLowerCase()}`).join(", ");
}

/** What the buyer has that a purchase depends on. */
export interface SalesBuyer {
  gold: number;
  resources: Resources;
  blueprints: string[];
  /** Indexes this player has already bought on this visit. */
  bought: number[];
}

/** Why `buyer` cannot take `entry`, or null if they can. */
export function salesProblem(entry: SalesEntry | undefined, buyer: SalesBuyer): string | null {
  if (!entry) return "There is nothing like that on the table.";
  if (buyer.bought.includes(entry.index)) return "You have had that one already. One each, this visit.";
  if (entry.goods.kind === "blueprint" && buyer.blueprints.includes(entry.goods.defId)) return "You know that blueprint already.";
  if (buyer.gold < entry.price) return "Not enough gold.";
  if (!canAfford(buyer.resources, entry.materials)) {
    const short = RESOURCE_KINDS.filter((k) => (buyer.resources[k] ?? 0) < (entry.materials[k] ?? 0));
    return `You need ${short.map((k) => `${entry.materials[k]} ${RESOURCE_LABEL[k].toLowerCase()}`).join(" and ")}.`;
  }
  return null;
}

// ---------- in words ----------

/** "in 3 hours", "in about a day", "in 2 days": for when the next one is due. */
export function dueIn(ms: number): string {
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  if (hours < 20) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return days <= 1 ? "in about a day" : `in ${days} days`;
}
