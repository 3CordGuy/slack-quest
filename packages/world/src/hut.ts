// Huts: what can be owned, crafted and placed in one, and what it gives.
//
// This file is the shared vocabulary for the hut work: resource kinds, the
// furnishings catalogue, hut sizes, and the perks a furnished hut grants.
// Rules that act on a hut (room layout, placement, crafting) build on it.

export const RESOURCE_KINDS = ["wood", "stone", "iron", "copper", "fur", "bone", "herbs", "mushrooms"] as const;
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

export interface FurnishingDef {
  id: string;
  name: string;
  kind: "furniture" | "trophy";
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

export const FURNISHINGS: Record<string, FurnishingDef> = {
  table: { id: "table", name: "Plank Table", kind: "furniture", model: "table", blurb: "Somewhere to put things down.", price: 30, recipe: { wood: 6 } },
  chair: { id: "chair", name: "Stool", kind: "furniture", model: "chair", blurb: "Three legs and no back.", price: 15, recipe: { wood: 3 } },
  rug: { id: "rug", name: "Fur Rug", kind: "furniture", model: "rug", blurb: "Warm underfoot.", price: 35, recipe: { fur: 4 } },
  lantern: { id: "lantern", name: "Copper Lantern", kind: "furniture", model: "lantern", blurb: "Keeps the corners lit.", price: 40, recipe: { copper: 3, wood: 1 } },
  banner: { id: "banner", name: "Crew Banner", kind: "furniture", model: "banner", blurb: "Your crew's colours.", price: 45, recipe: { fur: 2, wood: 2 } },
  bed: { id: "bed", name: "Bunk", kind: "furniture", model: "bed", blurb: "A proper night's sleep before sailing. +1 focus.", recipe: { wood: 8, fur: 4 }, needsBlueprint: true, perk: { focus: 1 } },
  chest: { id: "chest", name: "Sea Chest", kind: "furniture", model: "chest", blurb: "Room for a spare bottle. +1 potion.", recipe: { wood: 6, iron: 3 }, needsBlueprint: true, perk: { potions: 1 } },
  hearth: { id: "hearth", name: "Stone Hearth", kind: "furniture", model: "hearth", blurb: "A hot meal before the voyage. +4 max HP.", recipe: { stone: 10, iron: 2 }, needsBlueprint: true, perk: { maxHp: 4 } },
  bookshelf: { id: "bookshelf", name: "Bookshelf", kind: "furniture", model: "bookshelf", blurb: "Other people's mistakes, written down. +2% XP.", recipe: { wood: 8, bone: 2 }, needsBlueprint: true, perk: { xpPct: 2 } },
  workbench: { id: "workbench", name: "Workbench", kind: "furniture", model: "workbench", blurb: "Where the next thing gets made.", recipe: { wood: 6, iron: 4 }, needsBlueprint: true },
  // Every home gets one, free, standing in the room: the storage chest for gear the hero cannot carry (carry.ts).
  // Never sold or crafted, and it gives no perk. It can be moved like any other piece.
  storage_chest: { id: "storage_chest", name: "Storage Chest", kind: "furniture", model: "small_chest", blurb: "Holds the gear you cannot carry. Only you can open it." },
  weapon_rack: { id: "weapon_rack", name: "Weapon Rack", kind: "furniture", model: "weapon_rack", blurb: "Everything in reach.", recipe: { wood: 4, iron: 4, copper: 2 }, needsBlueprint: true },
  // Far goods: never at the stall and never crafted. Only a traveling salesman carries them (see salesman.ts).
  globe: { id: "globe", name: "Sea Globe", kind: "furniture", model: "globe", blurb: "Some of the coastlines are guesses. +1% XP.", perk: { xpPct: 1 } },
  ship_bottle: { id: "ship_bottle", name: "Ship in a Bottle", kind: "furniture", model: "ship_bottle", blurb: "Nobody knows how it got in there." },
  shell_chimes: { id: "shell_chimes", name: "Shell Chimes", kind: "furniture", model: "shell_chimes", blurb: "They ring when the wind is from the sea." },
  // Trophies come only from finishing a story, one kind per story shape.
  trophy_relic: { id: "trophy_relic", name: "Recovered Relic", kind: "trophy", model: "trophy_relic", blurb: "A replica of what was won back. +1% XP.", perk: { xpPct: 1 } },
  trophy_token: { id: "trophy_token", name: "Keepsake of Thanks", kind: "trophy", model: "trophy_token", blurb: "Given by someone brought home. +1% XP.", perk: { xpPct: 1 } },
  trophy_pelt: { id: "trophy_pelt", name: "Beast's Pelt", kind: "trophy", model: "trophy_pelt", blurb: "It is bigger than it looked in the dark. +1% XP.", perk: { xpPct: 1 } },
  trophy_core: { id: "trophy_core", name: "Guardian's Core", kind: "trophy", model: "trophy_core", blurb: "Still faintly warm. +1% XP.", perk: { xpPct: 1 } },
};

/** The free storage chest every home has. */
export const STORAGE_CHEST = "storage_chest";

/** Which trophy each story shape awards, by frame id. */
export const TROPHY_FOR_FRAME: Record<string, string> = {
  stolen_relic: "trophy_relic",
  rescue: "trophy_token",
  beast_hunt: "trophy_pelt",
  broken_relic: "trophy_core",
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
 * Materials the market stall buys, and what it pays for each piece. Only
 * what islanders forage: the stall has no use for timber or ore.
 */
export const STALL_BUYS: Partial<Record<ResourceKind, number>> = { herbs: 3, mushrooms: 3 };

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

/** One owned furnishing. `q`/`r` are null while it is in storage. */
export interface Furnishing {
  id: number;
  defId: string;
  /** Display name. For a trophy this names the story it came from. */
  label: string;
  q: number | null;
  r: number | null;
  /** 0 to 5: which way it faces, in sixths of a turn. */
  facing: number;
}

/** Everything about a player's hut and what they could put in it. */
export interface HutSummary {
  tier: number;
  resources: Resources;
  blueprints: string[];
  furnishings: Furnishing[];
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

/**
 * Why this player cannot craft `defId`, or null if they can. They need its
 * blueprint (starter blueprints are known to everyone) and its materials.
 */
export function craftProblem(defId: string, blueprints: string[], resources: Resources): string | null {
  const def = Object.hasOwn(FURNISHINGS, defId) ? FURNISHINGS[defId] : undefined;
  if (!def) return "There is no such furnishing.";
  if (!def.recipe) return "That cannot be crafted.";
  if (def.needsBlueprint && !blueprints.includes(defId)) return "You have not found that blueprint yet.";
  const short = shortfall(resources, def.recipe);
  return short ? `You need ${short}.` : null;
}

/** The furnishings the market stall sells for gold, in catalogue order. */
export const STALL_FURNITURE: FurnishingDef[] = Object.values(FURNISHINGS).filter((f) => f.price !== undefined);

/** Why this player cannot buy `defId` at the stall, or null if they can. The price is the catalogue's. */
export function buyFurnitureProblem(defId: string, gold: number): string | null {
  const def = Object.hasOwn(FURNISHINGS, defId) ? FURNISHINGS[defId] : undefined;
  if (!def || def.price === undefined) return "The stall does not sell that.";
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
