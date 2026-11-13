// Huts: what can be owned, crafted and placed in one, and what it gives.
//
// This file is the shared vocabulary for the hut work: resource kinds, the
// furnishings catalogue, hut sizes, and the perks a furnished hut grants.
// Rules that act on a hut (room layout, placement, crafting) build on it.

export const RESOURCE_KINDS = ["wood", "stone", "iron", "copper", "fur", "bone", "herbs", "mushrooms", "gem"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export type Resources = Partial<Record<ResourceKind, number>>;

export const RESOURCE_LABEL: Record<ResourceKind, string> = {
  wood: "Wood",
  stone: "Stone",
  iron: "Iron",
  copper: "Copper",
  fur: "Fur",
  bone: "Bone",
  herbs: "Herbs",
  mushrooms: "Mushrooms",
  gem: "Gems",
};

/** Add `more` into `into`, returning `into`. Zero and negative results are dropped. */
export function addResources(into: Resources, more: Resources): Resources {
  for (const kind of RESOURCE_KINDS) {
    const n = (into[kind] ?? 0) + (more[kind] ?? 0);
    if (n > 0) into[kind] = n;
    else delete into[kind];
  }
  return into;
}

/** True if `have` covers every amount in `cost`. */
export function canAfford(have: Resources, cost: Resources): boolean {
  return RESOURCE_KINDS.every((k) => (have[k] ?? 0) >= (cost[k] ?? 0));
}

// ---------- perks ----------

/** What a furnished hut gives its owner at the start of a voyage. */
export interface Perk {
  /** Extra starting (and maximum) focus. */
  focus?: number;
  /** Extra starting potions. */
  potions?: number;
  maxHp?: number;
  /** Bonus XP, in percent. */
  xpPct?: number;
}

/** The most a hut can give, however it is furnished. Kept small on purpose. */
export const PERK_CAPS: Required<Perk> = { focus: 1, potions: 1, maxHp: 4, xpPct: 5 };

const PERK_KEYS = Object.keys(PERK_CAPS) as (keyof Perk)[];

/** A perk with every field present, whole, and held between zero and its cap. */
export function capPerks(perk: Perk | undefined): Required<Perk> {
  const out = { focus: 0, potions: 0, maxHp: 0, xpPct: 0 };
  for (const key of PERK_KEYS) {
    const n = Math.floor(Number(perk?.[key] ?? 0));
    out[key] = Number.isFinite(n) ? Math.max(0, Math.min(PERK_CAPS[key], n)) : 0;
  }
  return out;
}

/** XP after a hut's bonus. The bonus is rounded to the nearest point, so a small bonus on a small award may add nothing. */
export function xpWithBonus(xp: number, xpPct: number): number {
  return xp + Math.round((xp * capPerks({ xpPct }).xpPct) / 100);
}

// ---------- catalogue ----------

/**
 * A flat top that small things can be stood on, in the piece's own space
 * (facing 0, +z toward the camera): a w by d rectangle at height y, centred
 * on (x, z).
 */
export interface Surface {
  y: number;
  w: number;
  d: number;
  x?: number;
  z?: number;
}

/**
 * What a piece of floor furniture covers, in its own space (facing 0, +z
 * toward the camera): a w by d rectangle centred on (x, z), or with `round` a
 * circle w across. Two pieces may share a hex as long as these do not overlap.
 *
 * A footprint may be bigger than a hex. A long piece is anchored on the hex it
 * is placed on and reaches across its neighbours the way it is turned: a
 * footprint about two hexes long, centred half a hex-width to the right
 * (`x` = √3/2), covers its own hex and the one to its right at facing 0.
 */
export interface Footprint {
  w: number;
  d: number;
  x?: number;
  z?: number;
  round?: boolean;
}

/** A wall piece's face: w wide and h tall, centred on where it hangs. */
export interface Mount {
  w: number;
  h: number;
}

export interface FurnishingDef {
  id: string;
  name: string;
  kind: "furniture" | "trophy";
  /**
   * "small" things (a candle, a mug) go anywhere inside a hex, at any angle,
   * several to a hex, and can stand on a surface. They do not block walking.
   * Everything else stands anywhere inside its hex, at any angle, as long as
   * its `footprint` stays in the room and clear of other pieces.
   */
  size?: "small";
  /** Floor furniture: what it covers. Without one it is taken to fill most of its hex. */
  footprint?: Footprint;
  /**
   * Floor decor (a rug): laid flat on the floor, so it is walked over and
   * other furniture and small things stand on top of it. Flat pieces still
   * keep clear of each other.
   */
  flat?: boolean;
  /** Somewhere to sleep: clicking it rests the owner (see hutroom.ts, useOf). */
  bed?: boolean;
  /** Only sold or crafted once the hut is at least this tier (a piece too big for a Shack). */
  minTier?: number;
  /** It hangs on a wall rather than standing on the floor (see hutroom.ts, wallPlaceProblem). */
  mount?: Mount;
  /** Its top takes small things (in its own space; for a wall piece, from where it hangs). */
  surface?: Surface;
  /** It gives off light in the room. "fire" also throws shadows. */
  light?: "fire" | "candle" | "lamp";
  /** It holds things: this many slots for decorations, gear and stacks of materials. */
  storage?: number;
  /** Key for the client's model of it. */
  model: string;
  blurb: string;
  /** Gold price at the market stall, if it is sold there. */
  price?: number;
  /** Resources to craft it, if it can be crafted. */
  recipe?: Resources;
  /** Crafting needs its blueprint to have been learned first. */
  needsBlueprint?: boolean;
  perk?: Perk;
}

/** Half the distance between the middles of two neighbouring hexes: where a two-hex piece's middle sits from its anchor. */
const HALF_HEX = Math.sqrt(3) / 2;

export const FURNISHINGS: Record<string, FurnishingDef> = {
  table: { id: "table", name: "Plank Table", kind: "furniture", footprint: { w: 1.0, d: 0.7 }, model: "table", blurb: "Somewhere to put things down.", price: 30, recipe: { wood: 6 }, surface: { y: 0.5, w: 0.96, d: 0.66 } },
  chair: { id: "chair", name: "Stool", kind: "furniture", footprint: { w: 0.48, d: 0.48, round: true }, model: "chair", blurb: "Three legs and no back.", price: 15, recipe: { wood: 3 } },
  rug: { id: "rug", name: "Fur Rug", kind: "furniture", footprint: { w: 1.2, d: 0.98, z: 0.09 }, flat: true, model: "rug", blurb: "Warm underfoot.", price: 35, recipe: { fur: 4 } },
  lantern: { id: "lantern", name: "Copper Lantern", kind: "furniture", footprint: { w: 0.4, d: 0.4, round: true }, model: "lantern", blurb: "Keeps the corners lit.", price: 40, recipe: { copper: 3, wood: 1 }, light: "lamp" },
  banner: { id: "banner", name: "Crew Banner", kind: "furniture", footprint: { w: 0.7, d: 0.36 }, model: "banner", blurb: "Your crew's colours.", price: 45, recipe: { fur: 2, wood: 2 } },
  bed: { id: "bed", name: "Bunk", kind: "furniture", bed: true, footprint: { w: 0.84, d: 1.3, z: -0.02 }, model: "bed", blurb: "A proper night's sleep before sailing. +1 focus.", recipe: { wood: 8, fur: 4 }, needsBlueprint: true, perk: { focus: 1 } },
  chest: { id: "chest", name: "Sea Chest", kind: "furniture", footprint: { w: 0.79, d: 0.56 }, model: "chest", blurb: "Room for a spare bottle. +1 potion. Holds 12 things.", recipe: { wood: 6, iron: 3 }, needsBlueprint: true, perk: { potions: 1 }, storage: 12, surface: { y: 0.48, w: 0.74, d: 0.5 } },
  hearth: { id: "hearth", name: "Stone Hearth", kind: "furniture", footprint: { w: 1.2, d: 0.72 }, model: "hearth", blurb: "A hot meal before the voyage. +4 max HP.", recipe: { stone: 10, iron: 2 }, needsBlueprint: true, perk: { maxHp: 4 }, light: "fire" },
  bookshelf: { id: "bookshelf", name: "Bookshelf", kind: "furniture", footprint: { w: 0.95, d: 0.34, z: -0.1 }, model: "bookshelf", blurb: "Other people's mistakes, written down. +2% XP.", recipe: { wood: 8, bone: 2 }, needsBlueprint: true, perk: { xpPct: 2 } },
  workbench: { id: "workbench", name: "Workbench", kind: "furniture", footprint: { w: 1.15, d: 0.6 }, model: "workbench", blurb: "Where the next thing gets made.", recipe: { wood: 6, iron: 4 }, needsBlueprint: true, surface: { y: 0.6, w: 1.1, d: 0.56 } },
  // Every home gets one, free, standing in the room: where gear the hero cannot carry waits (carry.ts).
  // Never sold or crafted, and it gives no perk. A container like the others, and moved like any piece.
  storage_chest: { id: "storage_chest", name: "Storage Chest", kind: "furniture", footprint: { w: 0.58, d: 0.45 }, model: "small_chest", blurb: "Every home's own chest, for the gear you cannot carry. Holds 10 things.", storage: 10, surface: { y: 0.42, w: 0.54, d: 0.4 } },
  weapon_rack: { id: "weapon_rack", name: "Weapon Rack", kind: "furniture", footprint: { w: 1.0, d: 0.22, z: -0.08 }, model: "weapon_rack", blurb: "Everything in reach.", recipe: { wood: 4, iron: 4, copper: 2 }, needsBlueprint: true },

  // ---- more furniture: tops to put things on, and places to keep things ----
  desk: { id: "desk", name: "Writing Desk", kind: "furniture", footprint: { w: 1.1, d: 0.56 }, model: "desk", blurb: "A wide top and a drawer that sticks.", price: 40, recipe: { wood: 7 }, surface: { y: 0.62, w: 1.06, d: 0.52 } },
  side_table: { id: "side_table", name: "Side Table", kind: "furniture", footprint: { w: 0.56, d: 0.52 }, model: "side_table", blurb: "Just big enough for a candle and a mug.", price: 18, recipe: { wood: 3 }, surface: { y: 0.55, w: 0.52, d: 0.48 } },
  dresser: { id: "dresser", name: "Dresser", kind: "furniture", footprint: { w: 1.04, d: 0.52, z: -0.1 }, model: "dresser", blurb: "Three drawers and a top for odds and ends. Holds 12 things.", price: 60, recipe: { wood: 8, iron: 1 }, storage: 12, surface: { y: 0.84, w: 0.98, d: 0.46, z: -0.1 } },
  cupboard: { id: "cupboard", name: "Tall Cupboard", kind: "furniture", footprint: { w: 0.96, d: 0.48, z: -0.12 }, model: "cupboard", blurb: "Floor to rafters. Holds 20 things.", recipe: { wood: 10, iron: 2 }, needsBlueprint: true, storage: 20, surface: { y: 1.52, w: 0.86, d: 0.42, z: -0.12 } },
  crate: { id: "crate", name: "Storage Crate", kind: "furniture", footprint: { w: 0.7, d: 0.7 }, model: "crate", blurb: "Nailed shut, then not. Holds 8 things.", price: 12, recipe: { wood: 3 }, storage: 8, surface: { y: 0.56, w: 0.66, d: 0.66 } },
  barrel: { id: "barrel", name: "Barrel", kind: "furniture", footprint: { w: 0.58, d: 0.58, round: true }, model: "barrel", blurb: "Smells faintly of fish. Holds 6 things.", price: 16, recipe: { wood: 4, iron: 1 }, storage: 6, surface: { y: 0.78, w: 0.42, d: 0.42 } },
  fireplace: { id: "fireplace", name: "Great Fireplace", kind: "furniture", footprint: { w: 1.7, d: 0.8 }, model: "fireplace", blurb: "A roaring fire and a mantel for your treasures.", recipe: { stone: 14, iron: 3 }, needsBlueprint: true, light: "fire", surface: { y: 1.06, w: 1.5, d: 0.24, z: 0.24 } },

  // ---- big pieces: anchored on one hex and reaching across the next (see Footprint) ----
  long_table: { id: "long_table", name: "Long Table", kind: "furniture", footprint: { w: 2.5, d: 0.76, x: HALF_HEX }, model: "long_table", blurb: "Seats the whole crew, if they squeeze. Two hexes long.", price: 70, recipe: { wood: 12 }, surface: { y: 0.5, w: 2.44, d: 0.7, x: HALF_HEX } },
  long_bench: { id: "long_bench", name: "Long Bench", kind: "furniture", footprint: { w: 2.3, d: 0.42, x: HALF_HEX }, model: "long_bench", blurb: "For sitting along a long table. Two hexes long.", price: 30, recipe: { wood: 6 } },
  runner_rug: { id: "runner_rug", name: "Sailcloth Runner", kind: "furniture", flat: true, footprint: { w: 4.6, d: 1.0, x: 2 * HALF_HEX }, model: "runner_rug", blurb: "An old sail, striped and hemmed. Three hexes long; furniture stands on it.", price: 55, recipe: { fur: 6 } },
  round_rug: { id: "round_rug", name: "Braided Rug", kind: "furniture", flat: true, footprint: { w: 2.7, d: 2.7, x: HALF_HEX, z: 0.5, round: true }, model: "round_rug", blurb: "Rope and rags, braided round. Covers three hexes; furniture stands on it.", price: 65, recipe: { fur: 7, herbs: 2 } },
  four_poster: { id: "four_poster", name: "Four-Poster Bed", kind: "furniture", bed: true, minTier: 2, footprint: { w: 2.4, d: 1.1, x: HALF_HEX }, model: "four_poster", blurb: "Curtains, a canopy and room to stretch out. Two hexes long. +1 focus.", recipe: { wood: 14, fur: 6 }, perk: { focus: 1 } },
  great_bookcase: { id: "great_bookcase", name: "Great Bookcase", kind: "furniture", minTier: 2, footprint: { w: 2.4, d: 0.5, x: HALF_HEX, z: -0.1 }, model: "great_bookcase", blurb: "A wall of books and a ladder to reach them. Two hexes long. +1% XP.", recipe: { wood: 14, bone: 3 }, perk: { xpPct: 1 }, surface: { y: 1.62, w: 2.36, d: 0.36, x: HALF_HEX, z: -0.15 } },

  // ---- small things: anywhere in a hex, at any angle, or on a surface ----
  candle: { id: "candle", name: "Tallow Candle", kind: "furniture", size: "small", model: "candle", blurb: "A small, steady flame.", price: 5, recipe: { fur: 1 }, light: "candle" },
  candelabra: { id: "candelabra", name: "Candelabra", kind: "furniture", size: "small", model: "candelabra", blurb: "Three candles on a copper stem.", price: 25, recipe: { copper: 2, fur: 1 }, light: "candle" },
  hand_lantern: { id: "hand_lantern", name: "Hand Lantern", kind: "furniture", size: "small", model: "hand_lantern", blurb: "A little lantern to set on a table.", price: 20, recipe: { copper: 2, wood: 1 }, light: "lamp" },
  mug: { id: "mug", name: "Tankard", kind: "furniture", size: "small", model: "mug", blurb: "Never quite empty.", price: 4, recipe: { wood: 1 } },
  bottle: { id: "bottle", name: "Green Bottle", kind: "furniture", size: "small", model: "bottle", blurb: "Something from the pub, saved for later.", price: 6 },
  plate: { id: "plate", name: "Bread and Cheese", kind: "furniture", size: "small", model: "plate", blurb: "On a clay plate. Do not eat the plate.", price: 8, recipe: { stone: 1, herbs: 1 } },
  books: { id: "books", name: "Stack of Books", kind: "furniture", size: "small", model: "books", blurb: "Read some of them.", price: 12, recipe: { wood: 1, fur: 1 } },
  potted_herb: { id: "potted_herb", name: "Potted Herb", kind: "furniture", size: "small", model: "potted_herb", blurb: "Grows a little every time you look away.", recipe: { stone: 1, herbs: 2 } },
  mushroom_jar: { id: "mushroom_jar", name: "Jar of Mushrooms", kind: "furniture", size: "small", model: "mushroom_jar", blurb: "Pickled. Probably.", recipe: { stone: 1, mushrooms: 2 } },
  skull: { id: "skull", name: "Old Skull", kind: "furniture", size: "small", model: "skull", blurb: "Nobody remembers whose.", recipe: { bone: 2 } },
  sea_chart: { id: "sea_chart", name: "Sea Chart", kind: "furniture", size: "small", model: "sea_chart", blurb: "Half the islands on it are wrong.", price: 15, recipe: { fur: 1, copper: 1 } },
  hourglass: { id: "hourglass", name: "Hourglass", kind: "furniture", size: "small", model: "hourglass", blurb: "For timing things that do not matter.", recipe: { copper: 1, stone: 1 } },
  writing_set: { id: "writing_set", name: "Ink and Quill", kind: "furniture", size: "small", model: "writing_set", blurb: "For the voyage log.", price: 10, recipe: { bone: 1, copper: 1 } },
  coin_pile: { id: "coin_pile", name: "Pile of Coins", kind: "furniture", size: "small", model: "coin_pile", blurb: "For show, not for spending.", price: 30 },

  // ---- on the walls: hung on the back or side walls, at any height and anywhere along a face ----
  wall_shelf: { id: "wall_shelf", name: "Wall Shelf", kind: "furniture", mount: { w: 0.8, h: 0.3 }, model: "wall_shelf", blurb: "A plank on two brackets, for small things to stand on.", price: 15, recipe: { wood: 3 }, surface: { y: 0.13, w: 0.76, d: 0.22, z: 0.13 } },
  painting: { id: "painting", name: "Seascape", kind: "furniture", mount: { w: 0.62, h: 0.46 }, model: "painting", blurb: "Somebody's idea of a calm sea.", price: 35 },
  wall_chart: { id: "wall_chart", name: "Chart of the Isles", kind: "furniture", mount: { w: 0.66, h: 0.48 }, model: "wall_chart", blurb: "Pinned up where everyone can argue over it.", price: 30, recipe: { fur: 2, copper: 1 } },
  sconce: { id: "sconce", name: "Iron Sconce", kind: "furniture", mount: { w: 0.22, h: 0.42 }, model: "sconce", blurb: "A candle held out from the wall.", price: 15, recipe: { iron: 1, fur: 1 }, light: "candle" },
  wall_lantern: { id: "wall_lantern", name: "Hanging Lantern", kind: "furniture", mount: { w: 0.26, h: 0.5 }, model: "wall_lantern", blurb: "A lantern on an iron arm.", price: 25, recipe: { copper: 2, iron: 1 }, light: "lamp" },
  ship_wheel: { id: "ship_wheel", name: "Ship's Wheel", kind: "furniture", mount: { w: 0.72, h: 0.72 }, model: "ship_wheel", blurb: "From a ship that will not be needing it.", price: 50, recipe: { wood: 6, iron: 1 } },
  crossed_blades: { id: "crossed_blades", name: "Crossed Cutlasses", kind: "furniture", mount: { w: 0.72, h: 0.52 }, model: "crossed_blades", blurb: "Hung up, for now.", recipe: { iron: 4, wood: 1 } },
  mounted_fish: { id: "mounted_fish", name: "Mounted Fish", kind: "furniture", mount: { w: 0.62, h: 0.34 }, model: "mounted_fish", blurb: "It was this big. Bigger, really.", price: 40, recipe: { bone: 1, wood: 2 } },

  // Far goods: never at the stall and never crafted. Only a traveling salesman carries them (see salesman.ts).
  globe: { id: "globe", name: "Sea Globe", kind: "furniture", footprint: { w: 0.56, d: 0.56, round: true }, model: "globe", blurb: "Some of the coastlines are guesses. +1% XP.", perk: { xpPct: 1 } },
  ship_bottle: { id: "ship_bottle", name: "Ship in a Bottle", kind: "furniture", footprint: { w: 0.74, d: 0.36 }, model: "ship_bottle", blurb: "Nobody knows how it got in there." },
  shell_chimes: { id: "shell_chimes", name: "Shell Chimes", kind: "furniture", footprint: { w: 0.66, d: 0.36 }, model: "shell_chimes", blurb: "They ring when the wind is from the sea." },
  // Trophies come only from finishing a story, one kind per story shape.
  trophy_relic: { id: "trophy_relic", name: "Recovered Relic", kind: "trophy", footprint: { w: 0.84, d: 0.84, round: true }, model: "trophy_relic", blurb: "A replica of what was won back. +1% XP.", perk: { xpPct: 1 } },
  trophy_token: { id: "trophy_token", name: "Keepsake of Thanks", kind: "trophy", footprint: { w: 0.84, d: 0.84, round: true }, model: "trophy_token", blurb: "Given by someone brought home. +1% XP.", perk: { xpPct: 1 } },
  trophy_pelt: { id: "trophy_pelt", name: "Beast's Pelt", kind: "trophy", footprint: { w: 0.84, d: 0.84, round: true }, model: "trophy_pelt", blurb: "It is bigger than it looked in the dark. +1% XP.", perk: { xpPct: 1 } },
  trophy_core: { id: "trophy_core", name: "Guardian's Core", kind: "trophy", footprint: { w: 0.84, d: 0.84, round: true }, model: "trophy_core", blurb: "Still faintly warm. +1% XP.", perk: { xpPct: 1 } },
};

/** The free storage chest every home has. */
export const STORAGE_CHEST = "storage_chest";

/** Which trophy each story shape awards, by frame id. */
export const TROPHY_FOR_FRAME: Record<string, string> = {
  stolen_relic: "trophy_relic",
  rescue: "trophy_token",
  beast_hunt: "trophy_pelt",
  broken_relic: "trophy_core",
  // A share of the hoard, and the island's thanks for lifting its curse.
  rival_crew: "trophy_relic",
  lift_curse: "trophy_token",
};

/** Blueprints every player knows from the start. Others are found or bought. */
export const STARTER_BLUEPRINTS: string[] = Object.values(FURNISHINGS).filter((f) => f.recipe && !f.needsBlueprint).map((f) => f.id);

export interface HutTier {
  tier: number;
  name: string;
  /** Floor size of the room, in hexes. */
  cols: number;
  rows: number;
  /** Cost to move up to this tier from the one below. */
  gold: number;
  resources: Resources;
}

export const HUT_TIERS: HutTier[] = [
  { tier: 1, name: "Shack", cols: 5, rows: 4, gold: 0, resources: {} },
  { tier: 2, name: "Cottage", cols: 6, rows: 5, gold: 150, resources: { wood: 20, stone: 10 } },
  { tier: 3, name: "Lodge", cols: 8, rows: 6, gold: 400, resources: { wood: 40, stone: 30, iron: 10 } },
];

/**
 * A gem from the quarry. Rare (a good thirty seconds at the face finds one or
 * two, a poor one none), so it is worth a few herbs' worth more than a meal:
 * selling the gems from a lucky day's outings buys a pub meal or two.
 */
export const STALL_GEM_PRICE = 12;

/**
 * Materials the market stall buys, and what it pays for each piece: what
 * islanders forage, and gems from the quarry. The stall has no use for
 * timber or ore.
 *
 * 3 gold is pitched at what the Apothecary's brews are worth at pub prices:
 * a Focus Tonic's 4 pieces sell for 12 against Spiced Rum's 14 for the same
 * focus, a Stoneskin Salve's 3 mushrooms for 9 against Fish Stew's 12 for the
 * same HP. Brewing is never worse than selling and buying the pub's version,
 * and a Healing Draught (a potion, which nobody sells) is better. The herbalist
 * salesman pays 5 to 7 a piece, so the stall stays the everyday floor.
 */
export const STALL_BUYS: Partial<Record<ResourceKind, number>> = { herbs: 3, mushrooms: 3, gem: STALL_GEM_PRICE };

/** Why `qty` of `kind` cannot be sold to the stall by someone holding `have`, or null if it can. */
export function sellMaterialProblem(kind: unknown, qty: unknown, have: Resources): string | null {
  const k = RESOURCE_KINDS.find((r) => r === kind);
  if (!k || STALL_BUYS[k] === undefined) return "The stall does not buy that.";
  if (typeof qty !== "number" || !Number.isSafeInteger(qty) || qty < 1) return "Sell at least one.";
  if ((have[k] ?? 0) < qty) return `You only have ${have[k] ?? 0} ${RESOURCE_LABEL[k].toLowerCase()}.`;
  return null;
}

/** What a plot of land in the Harbor costs. A hut can only be built, entered or furnished once its owner has one. */
export const PLOT_PRICE = 120;

// ---------- raising the shack ----------
//
// A bought plot is bare ground with a resource bin on it. The owner fills the
// bin a little at a time, from what they gather; when it holds everything the
// shack needs, the shack goes up and the hut can be entered.

/** What goes into the bin before a shack stands on a new plot. */
export const SHACK_COST: Resources = { wood: 10, stone: 6 };

/** What the bin still needs, by kind. Empty once it is full. */
export function binNeeds(bin: Resources): Resources {
  const out: Resources = {};
  for (const k of RESOURCE_KINDS) {
    const n = (SHACK_COST[k] ?? 0) - Math.max(0, Math.floor(bin[k] ?? 0));
    if (n > 0) out[k] = n;
  }
  return out;
}

/** True once the bin holds everything the shack needs. */
export function binFull(bin: Resources): boolean {
  return Object.keys(binNeeds(bin)).length === 0;
}

/** How full the bin is, from 0 to 1, counting every piece the same. */
export function binFill(bin: Resources): number {
  const total = RESOURCE_KINDS.reduce((n, k) => n + (SHACK_COST[k] ?? 0), 0);
  const need = RESOURCE_KINDS.reduce((n, k) => n + (binNeeds(bin)[k] ?? 0), 0);
  return total === 0 ? 1 : (total - need) / total;
}

/** What goes into the bin from `have` right now: as much of each kind as is held, up to what is still needed. */
export function binDeposit(bin: Resources, have: Resources): Resources {
  const out: Resources = {};
  const needs = binNeeds(bin);
  for (const k of RESOURCE_KINDS) {
    const n = Math.min(needs[k] ?? 0, Math.max(0, Math.floor(have[k] ?? 0)));
    if (n > 0) out[k] = n;
  }
  return out;
}

// ---------- what a player owns ----------

/**
 * One owned furnishing. `q`/`r` are null while it is in storage (or inside a
 * container, `inId`).
 *
 * On the floor, a piece has an offset (`x`/`z`) from the middle of its hex
 * and a turn: `facing` sixths plus `angle` radians (pieces placed before free
 * turning only have a facing; new turns are kept whole in `angle`). A small
 * thing standing on a surface (`onId`) is offset from the middle of that
 * piece in its own turned frame, and its `q`/`r` are its support's.
 *
 * A wall piece (`mount` in the catalogue) has `q`/`r` on the wall hex it
 * hangs on, `facing` for which side of that hex (toward the room's floor),
 * `x` along that side and `y` up from the floor.
 */
export interface Furnishing {
  id: number;
  defId: string;
  /** Display name. For a trophy this names the story it came from. */
  label: string;
  q: number | null;
  r: number | null;
  /** 0 to 5: which way it faces, in sixths of a turn. A wall piece: which side of its wall hex. */
  facing: number;
  /** Offset from the middle of its hex (or its support's top), in world units. A wall piece: `x` along its wall. */
  x: number;
  z: number;
  /** A wall piece's height above the floor, to its middle. 0 for everything else. */
  y: number;
  /** Turn in radians, on top of `facing`. */
  angle: number;
  /** The furnishing it stands on, or null. */
  onId: number | null;
  /** The container it is kept in, or null. */
  inId: number | null;
}

/** A stack of materials kept in a container. */
export interface StashedStack {
  containerId: number;
  kind: ResourceKind;
  qty: number;
}

/** A piece of gear kept in a container. */
export interface StowedGear {
  itemId: number;
  containerId: number;
  name: string;
  icon: string;
  slot: string;
  rarity: string;
}

/** Everything about a player's hut and what they could put in it. */
export interface HutSummary {
  tier: number;
  resources: Resources;
  blueprints: string[];
  furnishings: Furnishing[];
  /** Materials and gear kept in the hut's containers. */
  stash: StashedStack[];
  stowed: StowedGear[];
}

/** The perks from the furnishings that are actually placed, held to the caps. */
export function hutPerks(furnishings: Pick<Furnishing, "defId" | "q">[]): Required<Perk> {
  const total: Required<Perk> = { focus: 0, potions: 0, maxHp: 0, xpPct: 0 };
  for (const f of furnishings) {
    if (f.q === null) continue;
    const perk = FURNISHINGS[f.defId]?.perk;
    if (!perk) continue;
    for (const key of PERK_KEYS) total[key] = Math.min(PERK_CAPS[key], total[key] + (perk[key] ?? 0));
  }
  return total;
}

// ---------- spending: crafting, the stall, and a bigger hut ----------

/** "6 wood, 3 iron" for the kinds in `cost` that `have` falls short on, or "" if it covers them all. */
function shortfall(have: Resources, cost: Resources): string {
  return RESOURCE_KINDS.filter((k) => (have[k] ?? 0) < (cost[k] ?? 0))
    .map((k) => `${(cost[k] ?? 0) - (have[k] ?? 0)} more ${RESOURCE_LABEL[k].toLowerCase()}`)
    .join(", ");
}

/** Why a hut of `tier` is too small for `def`, or null. Without a tier nothing is checked (catalogue listings). */
function tierProblem(def: FurnishingDef, tier: number | undefined): string | null {
  if (tier === undefined || !def.minTier || tier >= def.minTier) return null;
  const needed = HUT_TIERS.find((t) => t.tier === def.minTier);
  return `That needs a bigger hut${needed ? `: a ${needed.name}` : ""}.`;
}

/**
 * Why this player cannot craft `defId`, or null if they can. They need its
 * blueprint (starter blueprints are known to everyone), its materials, and a
 * hut of at least its `minTier` (the server always passes `tier`).
 */
export function craftProblem(defId: string, blueprints: string[], resources: Resources, tier?: number): string | null {
  const def = Object.hasOwn(FURNISHINGS, defId) ? FURNISHINGS[defId] : undefined;
  if (!def) return "There is no such furnishing.";
  if (!def.recipe) return "That cannot be crafted.";
  if (def.needsBlueprint && !blueprints.includes(defId)) return "You have not found that blueprint yet.";
  const small = tierProblem(def, tier);
  if (small) return small;
  const short = shortfall(resources, def.recipe);
  return short ? `You need ${short}.` : null;
}

/** The furnishings the market stall sells for gold, in catalogue order. */
export const STALL_FURNITURE: FurnishingDef[] = Object.values(FURNISHINGS).filter((f) => f.price !== undefined);

/** Why this player cannot buy `defId` at the stall, or null if they can. The price is the catalogue's; `tier` is their hut's (see craftProblem). */
export function buyFurnitureProblem(defId: string, gold: number, tier?: number): string | null {
  const def = Object.hasOwn(FURNISHINGS, defId) ? FURNISHINGS[defId] : undefined;
  if (!def || def.price === undefined) return "The stall does not sell that.";
  const small = tierProblem(def, tier);
  if (small) return small;
  return gold < def.price ? "Not enough gold." : null;
}

/** The tier above this one, with what it costs, or null at the top. */
export function nextHutTier(tier: number): HutTier | null {
  return HUT_TIERS.find((t) => t.tier === tier + 1) ?? null;
}

/** Why a hut of this tier cannot be made bigger with what the player holds, or null if it can. */
export function upgradeProblem(tier: number, gold: number, resources: Resources): string | null {
  const next = nextHutTier(tier);
  if (!next) return "Your hut is as big as huts get.";
  const short = [gold < next.gold ? `${next.gold - gold} more gold` : "", shortfall(resources, next.resources)].filter(Boolean).join(", ");
  return short ? `You need ${short}.` : null;
}
