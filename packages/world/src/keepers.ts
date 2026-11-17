// Inside the smithy and the apothecary: a small room each, with the keeper
// who runs it, what they sell from their own stock for gold, and haggling.
//
// The rooms work like the pub's (a fixed room, fixed fittings that are walked
// around) but nobody else is in them: a customer walks about their own copy,
// so there is no Durable Object behind either. What is bought, and what was
// haggled, is checked and kept by the server (apps/game/src/server/keepers.ts).
//
// Haggling is over gold only. A customer may try once a day for each thing a
// keeper sells or does for gold, and picks how much to ask off: the more they
// ask, the less likely the keeper is to agree. A price that was talked down
// holds until the day turns; one that was not holds too, and that is that.

import type { HexGrid, HexPos } from "@gantt-quest/core";
import { itemPrice, rollItem, type ItemDef, type Slot } from "./gear";
import { harborPoi } from "./harbor";
import { buildRoom, hutPath } from "./hutroom";
import type { WorldMap } from "./map";
import { makeRng, seedFromString } from "./rng";
import { THROWABLE_KINDS } from "./zone/kit";
import type { Throwable } from "./zone/types";

export const KEEPER_SHOPS = ["smithy", "apothecary"] as const;
export type KeeperShop = (typeof KEEPER_SHOPS)[number];
export const isKeeperShop = (shop: unknown): shop is KeeperShop => KEEPER_SHOPS.includes(shop as KeeperShop);

// ---------- the rooms ----------

/** Both shops are the same size: a floor 7 by 5, smaller than the pub and about a middling hut. */
export const KEEPER_GRID: HexGrid = { cols: 9, rows: 7 };

/** Offset coordinates (column, row) to the axial coordinates the map uses. */
const at = (col: number, row: number): HexPos => ({ q: col - Math.floor(row / 2), r: row });

export interface Keeper {
  /** The keeper's unit id in the scene. */
  id: string;
  name: string;
  short: string;
  /** What they are, in a few words: "the smith". */
  trade: string;
  /** The look they are drawn with (apps/game/src/client/render/looks.ts). */
  look: string;
  /** Said as a customer walks up. */
  hello: string;
  /** Under their name in their panel. */
  line: string;
}

export interface KeeperFitting {
  id: number;
  model: string;
  q: number;
  r: number;
  facing: number;
}

const fit = (id: number, model: string, col: number, row: number, facing = 0): KeeperFitting => ({ id, model, ...at(col, row), facing });

export interface KeeperPlace {
  shop: KeeperShop;
  /** "The smithy". */
  title: string;
  keeper: Keeper;
  /** Where the keeper stands. Nobody else does. */
  keeperPos: HexPos;
  /** Where a customer stands to deal with them: the hex in front. */
  stand: HexPos;
  /** The furniture. It never moves, and it is walked around. */
  fittings: KeeperFitting[];
}

/** The keeper stands in the middle of the room with their work around them; the customer comes up in front. */
const KEEPER_POS = at(4, 2);
const KEEPER_STAND = at(4, 3);

export const KEEPER_PLACES: Record<KeeperShop, KeeperPlace> = {
  smithy: {
    shop: "smithy",
    title: "The smithy",
    keeper: { id: "keeper:smithy", name: "Greta Ironhand", short: "Greta", trade: "the smith", look: "keeper_smith", hello: "Mind the sparks. What needs an edge?", line: "Good iron costs what it costs. Mostly." },
    keeperPos: KEEPER_POS,
    stand: KEEPER_STAND,
    fittings: [
      // The forge against the back wall behind her, the coal beside it, the anvil at her left hand and the quench at her right.
      fit(1, "forge", 4, 1),
      fit(2, "coal_bin", 3, 1),
      fit(3, "anvil", 3, 2),
      fit(4, "quench_tub", 5, 2),
      // Finished work along the back wall, and the bench and the wheel down the sides.
      fit(5, "weapon_rack", 1, 1),
      fit(6, "armor_stand", 6, 1),
      fit(7, "grindstone", 7, 2),
      fit(8, "workbench", 1, 3),
      fit(9, "crate", 1, 5),
      fit(10, "barrel", 6, 5),
    ],
  },
  apothecary: {
    shop: "apothecary",
    title: "The apothecary",
    keeper: { id: "keeper:apothecary", name: "Ansel Reed", short: "Ansel", trade: "the apothecary", look: "keeper_apothecary", hello: "Don't touch the green ones. What ails you?", line: "Everything on the shelf is fresh. Fresh enough." },
    keeperPos: KEEPER_POS,
    stand: KEEPER_STAND,
    fittings: [
      // Shelves of bottles along the back wall, the cauldron at his left hand and the counter with the scales at his right.
      fit(1, "potion_shelf", 3, 1),
      fit(2, "potion_shelf", 4, 1),
      fit(3, "cauldron", 3, 2),
      fit(4, "shop_counter", 5, 2),
      fit(5, "herb_rack", 1, 1),
      fit(6, "potion_shelf", 6, 1),
      fit(7, "cupboard", 7, 2),
      fit(8, "herb_table", 1, 3),
      fit(9, "barrel", 1, 5),
      fit(10, "crate", 6, 5),
    ],
  },
};

/** A shop's room: the same every time. The hex in front of the keeper is a place to stand, not an obstacle. */
export function keeperRoom(shop: KeeperShop): WorldMap {
  const room = buildRoom(KEEPER_GRID);
  return { ...room, pois: [...room.pois, harborPoi("keeper", "dealer", KEEPER_PLACES[shop].stand)] };
}

/** A walkable route across a shop, or null. The fittings are walked around, and the keeper's spot is theirs alone. */
export function keeperPath(shop: KeeperShop, room: WorldMap, from: HexPos, to: HexPos): HexPos[] | null {
  const place = KEEPER_PLACES[shop];
  return hutPath(room, [...place.fittings, place.keeperPos], from, to);
}

// ---------- haggling ----------

export interface HaggleAskDef {
  id: string;
  /** On the button. */
  label: string;
  /** How much comes off the price if the keeper agrees, in percent. */
  pct: number;
  /** The chance the keeper agrees, in percent, before anything the hero's class adds. */
  chance: number;
}

/** What a customer may ask for, from the safe to the cheeky. */
export const HAGGLE_ASKS = [
  { id: "nudge", label: "Ask a little off", pct: 10, chance: 75 },
  { id: "push", label: "Push for a fifth off", pct: 20, chance: 45 },
  { id: "lowball", label: "Lowball", pct: 35, chance: 20 },
] as const satisfies readonly HaggleAskDef[];
export type HaggleAsk = (typeof HAGGLE_ASKS)[number]["id"];
export const haggleAsk = (id: unknown): (typeof HAGGLE_ASKS)[number] | undefined => HAGGLE_ASKS.find((a) => a.id === id);

/** A price talked down, or not: what was asked, and how much came off (0 if the keeper would not have it). */
export interface Deal {
  ask: HaggleAsk;
  pct: number;
}

/** What a class adds to the chance, in percentage points: the Bard talks best, the Rogue and the Sage well enough. */
const HAGGLE_BONUS: Record<string, number> = { frontend_bard: 10, refactor_rogue: 5, staff_sage: 5 };
export const haggleBonus = (classId: string): number => HAGGLE_BONUS[classId] ?? 0;

/** The chance, in percent, that a keeper agrees to this ask from a hero of this class. Never certain either way. */
export function haggleChance(ask: HaggleAsk, classId: string): number {
  return Math.min(95, Math.max(5, haggleAsk(ask)!.chance + haggleBonus(classId)));
}

/** Every ask's chance for this class, for the buttons. */
export function haggleChances(classId: string): Record<HaggleAsk, number> {
  return Object.fromEntries(HAGGLE_ASKS.map((a) => [a.id, haggleChance(a.id, classId)])) as Record<HaggleAsk, number>;
}

/** A list price with `pct` percent off, rounded in the keeper's favour and never under 1 gold. A price of nothing stays nothing. */
export function haggledPrice(list: number, pct: number): number {
  if (list <= 0) return 0;
  return Math.max(1, Math.ceil((list * (100 - Math.min(100, Math.max(0, pct)))) / 100));
}

/** How a haggle comes out. `roll` is a number from 0 up to (not including) 100: under the chance, the keeper agrees. */
export function haggleOutcome(ask: HaggleAsk, classId: string, roll: number): Deal {
  return { ask, pct: roll < haggleChance(ask, classId) ? haggleAsk(ask)!.pct : 0 };
}

/** What the keeper says to it. `pick` chooses among a few lines (any whole number). */
const HAGGLE_LINES: Record<KeeperShop, { won: Record<HaggleAsk, string[]>; lost: Record<HaggleAsk, string[]> }> = {
  smithy: {
    won: {
      nudge: ["Fine. A little off, for a customer who asks nicely.", "Call it that. Don't tell the others."],
      push: ["Hm. You've a good eye for iron. A fifth off, then.", "You argue like my mother. Done."],
      lowball: ["Ha! Nobody's had the nerve in years. Take it, before I think better of it.", "At that price I'm paying you. Go on, then, just this once."],
    },
    lost: {
      nudge: ["The price is the price.", "Not today. Coal isn't getting cheaper."],
      push: ["A fifth? For this work? No.", "I'd sooner melt it down."],
      lowball: ["Out of the question. And mind your cheek.", "I've thrown people in the quench for less."],
    },
  },
  apothecary: {
    won: {
      nudge: ["Oh, very well. A little off.", "For a regular face, yes."],
      push: ["You drive a bargain. A fifth off, and not a word to anyone.", "Hm. It is nearly past its best. Agreed."],
      lowball: ["…You know, nobody ever asks. All right. All right!", "Daylight robbery. I rather admire it. Take it."],
    },
    lost: {
      nudge: ["I'm afraid not. Those herbs don't pick themselves.", "No, no. The price stands."],
      push: ["A fifth? I have a cauldron to feed.", "Certainly not."],
      lowball: ["I shall pretend I did not hear that.", "At that price you may lick the spoon, and nothing more."],
    },
  },
};

export function haggleLine(shop: KeeperShop, deal: Deal, pick = 0): string {
  const lines = HAGGLE_LINES[shop][deal.pct > 0 ? "won" : "lost"][deal.ask];
  return lines[Math.abs(Math.floor(pick)) % lines.length];
}

// ---------- what the keepers sell ----------

/** How many of each ready-made potion, flask or bomb the apothecary will sell one customer in a day. */
export const SHELF_DAILY = 3;

/**
 * What the apothecary asks for one made up and ready, in gold. Dearer than brewing it yourself from what you
 * gathered (herbs and mushrooms fetch 3 gold apiece at the stall), which is the point of gathering.
 */
export const SHELF_PRICES: Record<Throwable, number> = {
  healing: 28,
  poison: 30,
  fire: 36,
  oil: 22,
  water: 14,
  acid: 44,
  slime: 30,
  torch: 12,
};

/** The key a ready-made flask is bought and haggled over by. */
export const shelfKey = (kind: Throwable) => `flask:${kind}`;
/** The flask a key names, if it names one. */
export function shelfKind(key: unknown): Throwable | undefined {
  return THROWABLE_KINDS.find((k) => shelfKey(k) === key);
}

/** The armour the smith forges, besides a weapon and something for the off hand. Nothing she could not also work on later: no boots, rings or amulets. */
const FORGE_ARMOUR: Slot[] = ["body", "helmet", "legs"];

export interface ForgeEntry {
  index: number;
  item: ItemDef;
  price: number;
}

/** The key a piece on the smith's rack is bought and haggled over by. */
export const forgeKey = (index: number) => `gear:${index}`;

/**
 * What the smith has made for one customer on one day: a weapon for their class, a piece for the off hand, and
 * two pieces of armour, at their level. Deterministic in the seed, like the market stall's stock, so the server
 * re-derives it to check a purchase instead of storing it. Not the same pieces as the stall has that day.
 */
export function forgeStock(seed: string, classId: string, level: number): ForgeEntry[] {
  const rng = makeRng(seedFromString(`forge|${seed}`));
  const first = Math.floor(rng.next() * FORGE_ARMOUR.length);
  const slots: Slot[] = ["main_hand", "off_hand", FORGE_ARMOUR[first], FORGE_ARMOUR[(first + 1 + Math.floor(rng.next() * (FORGE_ARMOUR.length - 1))) % FORGE_ARMOUR.length]];
  return slots.map((slot, index) => {
    const item = rollItem(rng, classId, 0.3, level, slot);
    return { index, item, price: itemPrice(item) };
  });
}

/** The key the smith's work on one item is haggled over by. */
export const workKey = (itemId: number) => `work:${itemId}`;
