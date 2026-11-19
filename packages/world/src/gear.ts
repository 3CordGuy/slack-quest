// Gear: equipment slots, rarities, item generation, armor and prices.
//
// An item is one of three kinds. A weapon goes in the main hand and decides
// which abilities a hero has. Armor (off hand, body, helmet, legs) adds to
// the armor that blunts enemy hits. Trinkets (boots, ring, amulet) only
// carry stat bonuses. Rarity sets how much an item carries; the level it
// dropped at nudges its power.

import { appearanceKey, type Appearance } from "./appearance";
import { LEVELUP_AUTO_ALLOC, type StatKey, type Stats } from "@gantt-quest/core";
import { WEAPONS, heroClass } from "./content";
import { makeRng, seedFromString, type Rng } from "./rng";

export const SLOTS = ["main_hand", "off_hand", "body", "helmet", "legs", "boots", "ring", "amulet"] as const;
export type Slot = (typeof SLOTS)[number];

/** Whether the piece in a slot can be hidden on the hero: worn gear can, what is held in the hands (weapon, shield) cannot. */
export const canHide = (slot: Slot) => slot !== "main_hand" && slot !== "off_hand";

export const SLOT_LABEL: Record<Slot, string> = {
  main_hand: "Main Hand",
  off_hand: "Off Hand",
  body: "Body",
  helmet: "Helmet",
  legs: "Legs",
  boots: "Boots",
  ring: "Ring",
  amulet: "Amulet",
};

/** Icon shown in an empty slot. Names are keys into the client's pixel art (itemArt.ts). */
export const SLOT_ICON: Record<Slot, string> = {
  main_hand: "hand",
  off_hand: "round-shield",
  body: "chest-armor",
  helmet: "heavy-helm",
  legs: "armored-pants",
  boots: "boots",
  ring: "ring",
  amulet: "gem-chain",
};

export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;
export type Rarity = (typeof RARITIES)[number];

/** Same colours as the original game. */
export const RARITY_COLOR: Record<Rarity, string> = {
  common: "#8a8f98",
  uncommon: "#16a34a",
  rare: "#3b82f6",
  epic: "#a855f7",
  legendary: "#f59e0b",
};

export type ItemKind = "weapon" | "armor" | "trinket";

/** A persistent item: written to the player's inventory when it drops or is bought. */
export interface ItemDef {
  kind: ItemKind;
  /** Weapon id (see WEAPONS) or a base id from the tables below. */
  ref: string;
  name: string;
  rarity: Rarity;
  slot: Slot;
  /** Weapons: added to ability damage. Armor: added to the armor total. Trinkets: 0. */
  power: number;
  statBonus: Partial<Stats>;
  /** Hero level needed to equip it. */
  levelReq: number;
  icon: string;
  /** Steps of work at the smithy, each already counted in `power`. Absent or 0 for untouched gear. */
  upgrades?: number;
  /** Worn but not drawn: it still counts for everything, but the hero is shown without it. */
  hidden?: boolean;
}

export const rarityIndex = (r: Rarity) => RARITIES.indexOf(r);
export const statPoints = (item: Pick<ItemDef, "statBonus">) => Object.values(item.statBonus).reduce((a, n) => a + (n ?? 0), 0);

/** The icon each weapon is drawn with (the admin page lists which items share an icon). */
export const WEAPON_ICON: Record<string, string> = {
  mace: "hammer-drop",
  greatsword: "broadsword",
  staff: "wizard-staff",
  tome: "scroll-unfurled",
  daggers: "daggers",
  shortbow: "crossbow",
  root_staff: "root-staff",
  sickle: "sickle",
  lute: "lute",
  flute: "flute",
  accordion: "accordion",
  orb: "orb",
  scepter: "scepter",
  pager_axe: "pager-axe",
  maul: "maul",
  grimoire: "grimoire",
  void_staff: "void-staff",
  // Ship's guns (the models are in the client's gearModels).
  pistol: "pistol",
  blunderbuss: "blunderbuss",
  harpoon_gun: "harpoon-gun",
  // Signature weapons, each with an icon of its own (saved items were moved over by migration 0031).
  ballast_flail: "ballast-flail",
  barometer_rod: "barometer-rod",
  gaff_hook: "gaff-hook",
  coral_staff: "coral-staff",
  ships_bell: "ships-bell",
  astrolabe: "astrolabe",
  boarding_pike: "boarding-pike",
  bilge_chalice: "bilge-chalice",
};

export interface Base {
  ref: string;
  name: string;
  icon: string;
}

const BASES: Record<Exclude<Slot, "main_hand">, Base[]> = {
  off_hand: [
    { ref: "buckler", name: "Barrel-Lid Buckler", icon: "round-shield" },
    { ref: "firewall", name: "Seawall Shield", icon: "shield" },
  ],
  body: [
    { ref: "hauberk", name: "Hauberk of Calm Seas", icon: "chest-armor" },
    { ref: "greatcoat", name: "Oilskin Greatcoat", icon: "chest-armor" },
    // The diving set (with the Diving Helm): riveted iron and brass, as worn on the sea floor.
    { ref: "diving_plate", name: "Diver's Plate", icon: "chest-armor" },
  ],
  helmet: [
    { ref: "hardhat", name: "Diving Helm", icon: "heavy-helm" },
    { ref: "hood", name: "Squall Hood", icon: "hood" },
    { ref: "visor", name: "Spyglass Visor", icon: "brutal-helm" },
  ],
  legs: [
    { ref: "greaves", name: "Deckhand Greaves", icon: "armored-pants" },
    { ref: "trousers", name: "Sailcloth Trousers", icon: "armored-pants" },
    { ref: "diving_legs", name: "Riveted Leggings", icon: "armored-pants" },
  ],
  boots: [
    { ref: "boots", name: "Sea Boots", icon: "boots" },
    { ref: "treads", name: "Gangplank Treads", icon: "boots" },
    { ref: "lead_boots", name: "Lead Boots", icon: "boots" },
  ],
  ring: [
    { ref: "ring", name: "Ring of Steady Tides", icon: "ring" },
    { ref: "bands", name: "Mooring Bands", icon: "linked-rings" },
  ],
  amulet: [
    { ref: "lanyard", name: "Lucky Lanyard", icon: "gem-chain" },
    { ref: "keystone", name: "Lighthouse Key", icon: "key" },
    { ref: "badge", name: "Harbormaster's Badge", icon: "crowned-heart" },
  ],
};

/** Every armor and trinket base, for the content catalogue. Read-only: the rules use BASES. */
export const GEAR_BASES: readonly Base[] = Object.values(BASES).flat();

/**
 * Starting clothes: a class's own hat, tunic, trousers and shoes as items, worn from the first day. They
 * give no armor and never drop or sell in the shop; they are there so a hero can take them off (and be
 * seen in what is under them) or swap them for armor. Drawn in the wearer's class colours.
 */
export const GARB_PREFIX = "garb_";
/** The starter hat's ref. */
export const GARB_HAT = "garb_hat";
const GARB: { slot: "helmet" | "body" | "legs" | "boots"; ref: string; name: string; icon: string }[] = [
  { slot: "helmet", ref: GARB_HAT, name: "Hat", icon: "knit-cap" },
  { slot: "body", ref: "garb_tunic", name: "Tunic", icon: "naval-tunic" },
  { slot: "legs", ref: "garb_trousers", name: "Trousers", icon: "armored-pants" },
  { slot: "boots", ref: "garb_shoes", name: "Shoes", icon: "deck-boots" },
];

/** The class whose own hat is a lantern helm: a steel helm with a little lantern burning on top. */
export const LANTERN_HELM_CLASS = "qa_paladin";
/** The lantern helm's icon: the Lighthouse Paladin's starter hat is saved with it, and it is what makes a hat one. */
export const LANTERN_HELM_ICON = "lantern-helm";

/**
 * Whether a hero is wearing a lantern helm, which lights the dark around them as far as a held torch does and
 * never burns down: the Lighthouse Paladin's starter hat (on whoever has it on: it can be passed on through the
 * crew's chest), or a Paladin's own class hat on a figure with nothing on the head and no look of their own
 * chosen. Any other helmet, or a bare or hidden head, gives no light.
 */
export function wearsLanternHelm(classId: string, outfit: Outfit | undefined): boolean {
  const helmet = outfit?.helmet;
  if (helmet) return helmet.icon === LANTERN_HELM_ICON;
  return classId === LANTERN_HELM_CLASS && !outfit?.appearance;
}

/** A new hero's starting clothes, named for their class ("Lighthouse Paladin Tunic"); the Paladin's hat is their Lantern Helm. */
export function starterGarb(classId: string): ItemDef[] {
  const cls = heroClass(classId);
  const lantern = classId === LANTERN_HELM_CLASS;
  return GARB.map((g) => ({
    kind: kindOfSlot(g.slot),
    ref: g.ref,
    name: lantern && g.ref === GARB_HAT ? "Lantern Helm" : `${cls?.name ?? "Plain"} ${g.name}`,
    rarity: "common",
    slot: g.slot,
    power: 0,
    statBonus: {},
    levelReq: 1,
    icon: lantern && g.ref === GARB_HAT ? LANTERN_HELM_ICON : g.icon,
  }));
}

/** Word put in front of a base name for each rarity: "Fine Anchor Mace". */
export const RARITY_PREFIX: Record<Rarity, string> = { common: "", uncommon: "Sturdy ", rare: "Fine ", epic: "Masterwork ", legendary: "Mythic " };
const ARMOR_BASE: Partial<Record<Slot, number>> = { body: 3, helmet: 2, legs: 2, off_hand: 2 };
const ARMOR_SLOTS: Slot[] = ["off_hand", "body", "helmet", "legs"];
const SLOT_WEIGHT: [Slot, number][] = [
  ["main_hand", 2], ["off_hand", 1], ["body", 2], ["helmet", 1.5], ["legs", 1.5], ["boots", 1], ["ring", 1], ["amulet", 1],
];
const STATS: StatKey[] = ["str", "int_stat", "vit", "agi", "dex"];

export function kindOfSlot(slot: Slot): ItemKind {
  return slot === "main_hand" ? "weapon" : ARMOR_SLOTS.includes(slot) ? "armor" : "trinket";
}

/** `quality` 0..1 shifts the odds toward the rarer tiers. */
export function rollRarity(rng: Rng, quality: number): Rarity {
  const r = rng.next();
  if (r > 0.985 - quality * 0.06) return "legendary";
  if (r > 0.93 - quality * 0.15) return "epic";
  if (r > 0.75 - quality * 0.25) return "rare";
  if (r > 0.45 - quality * 0.25) return "uncommon";
  return "common";
}

/** Weapons with no class: any hero can use them. */
export const SHIPS_GUNS: string[] = Object.values(WEAPONS).filter((w) => !w.classId).map((w) => w.id);
/** The share of weapon drops that are a ship's gun. */
export const GUN_CHANCE = 0.2;

/** A class's weapon as an item. Common ones are the starting kit. */
export function weaponItem(weaponId: string, rarity: Rarity = "common", level = 1, statBonus: Partial<Stats> = {}): ItemDef {
  const w = WEAPONS[weaponId];
  const ri = rarityIndex(rarity);
  return {
    kind: "weapon",
    ref: w.id,
    name: `${RARITY_PREFIX[rarity]}${w.name}`,
    rarity,
    slot: "main_hand",
    power: ri + Math.floor(level / 4),
    statBonus,
    levelReq: ri >= 2 ? Math.max(1, level - 1) : 1,
    icon: WEAPON_ICON[w.id] ?? "broadsword",
  };
}

/**
 * Roll one item for a hero of `classId` at `level`. Weapons are always ones
 * the class can use. Pass `slot` to force where it goes (the shop does, to
 * stock one of everything). `minRarity` lifts anything rolled below it.
 * A weapon can also be a ship's gun, which no class owns, unless `guns` is false (the shop sells only class weapons).
 */
export function rollItem(rng: Rng, classId: string, quality: number, level: number, slot?: Slot, minRarity?: Rarity, guns = true): ItemDef {
  if (!slot) {
    const total = SLOT_WEIGHT.reduce((a, [, w]) => a + w, 0);
    let r = rng.next() * total;
    slot = "amulet";
    for (const [s, w] of SLOT_WEIGHT) {
      r -= w;
      if (r <= 0) {
        slot = s;
        break;
      }
    }
  }
  const rolled = rollRarity(rng, quality);
  // A floor on the rarity lifts the roll without drawing again, so it never changes what follows.
  const rarity = minRarity && rarityIndex(rolled) < rarityIndex(minRarity) ? minRarity : rolled;
  const kind = kindOfSlot(slot);
  const statBonus = rollStatBonus(rng, classId, kind, rarity);

  if (kind === "weapon") {
    // Good loot (lairs and bosses) can also be the class's signature weapon. Same one draw either way.
    const cls = heroClass(classId);
    const own = cls ? (quality >= 0.5 ? [...cls.weapons, cls.signature] : cls.weapons) : Object.keys(WEAPONS);
    // A ship's gun turns up about one weapon drop in five, whatever the class.
    const gun = rng.chance(GUN_CHANCE) && guns;
    const pick = rng.pick(gun ? SHIPS_GUNS : own);
    return weaponItem(pick, rarity, level, statBonus);
  }
  return baseItem(slot as Exclude<Slot, "main_hand">, rng.pick(BASES[slot as Exclude<Slot, "main_hand">]), rarity, level, statBonus);
}

/** The stat points an item of this kind and rarity carries. They lean toward what the class levels up in. */
function rollStatBonus(rng: Rng, classId: string, kind: ItemKind, rarity: Rarity): Partial<Stats> {
  const ri = rarityIndex(rarity);
  const favoured = LEVELUP_AUTO_ALLOC[classId] ?? [];
  const points = kind === "weapon" ? Math.floor(ri / 2) : kind === "armor" ? ri : ri + 1;
  const statBonus: Partial<Stats> = {};
  for (let i = 0; i < points; i++) {
    const stat = favoured.length > 0 && rng.chance(0.5) ? rng.pick(favoured) : rng.pick(STATS);
    statBonus[stat] = (statBonus[stat] ?? 0) + 1;
  }
  return statBonus;
}

/** A piece of armor or a trinket made from one base. */
function baseItem(slot: Exclude<Slot, "main_hand">, base: Base, rarity: Rarity, level: number, statBonus: Partial<Stats>): ItemDef {
  const ri = rarityIndex(rarity);
  const kind = kindOfSlot(slot);
  return {
    kind,
    ref: base.ref,
    name: `${RARITY_PREFIX[rarity]}${base.name}`,
    rarity,
    slot,
    power: kind === "armor" ? ARMOR_BASE[slot]! + ri + Math.floor(level / 3) : 0,
    statBonus,
    levelReq: ri >= 2 ? Math.max(1, level - 1) : 1,
    icon: base.icon,
  };
}

/** The slot a piece of gear goes in, from its ref: a weapon id (content.ts WEAPONS) or an armor or trinket base. Undefined if it is neither. */
export function slotOfRef(ref: string): Slot | undefined {
  if (Object.hasOwn(WEAPONS, ref)) return "main_hand";
  return (Object.keys(BASES) as Exclude<Slot, "main_hand">[]).find((s) => BASES[s].some((b) => b.ref === ref)) ?? GARB.find((g) => g.ref === ref)?.slot;
}

/**
 * One chosen piece of gear, made as a drop would be: `ref` names the weapon
 * or the base, and the stat points for its rarity are rolled for a hero of
 * `classId`. Undefined for a ref that is not gear. For the dev toolbox.
 */
export function itemOfRef(rng: Rng, classId: string, ref: string, rarity: Rarity, level: number): ItemDef | undefined {
  const slot = slotOfRef(ref);
  if (!slot) return undefined;
  const statBonus = rollStatBonus(rng, classId, kindOfSlot(slot), rarity);
  if (slot === "main_hand") return weaponItem(ref, rarity, level, statBonus);
  return baseItem(slot, BASES[slot].find((b) => b.ref === ref)!, rarity, level, statBonus);
}

// ---------- what gear does ----------

export interface Loadout {
  /** Weapon id in the main hand, or null if none is equipped. */
  weapon: string | null;
  weaponPower: number;
  armor: number;
  bonus: Partial<Stats>;
}

/** Add up everything a set of equipped items gives. */
export function loadoutOf(equipped: ItemDef[]): Loadout {
  const out: Loadout = { weapon: null, weaponPower: 0, armor: 0, bonus: {} };
  for (const item of equipped) {
    if (item.kind === "weapon") {
      out.weapon = item.ref;
      out.weaponPower = item.power;
    } else if (item.kind === "armor") {
      out.armor += item.power;
    }
    for (const key of STATS) if (item.statBonus[key]) out.bonus[key] = (out.bonus[key] ?? 0) + item.statBonus[key]!;
  }
  return out;
}

/**
 * What a hero is visibly wearing, slot by slot: enough for a client to draw
 * the items on the hero's sprite, and nothing else. It also carries how the
 * hero chose to look (appearance.ts), so wherever a hero is drawn in their
 * gear they are drawn as themselves.
 */
export type Outfit = Partial<Record<Slot, { icon: string; ref: string; rarity: Rarity }>> & { appearance?: Appearance };

export function outfitOf(equipped: ItemDef[]): Outfit {
  const out: Outfit = {};
  // Hidden gear is worn for what it does, not for how it looks. What is in the hands is always shown.
  for (const item of equipped) if (!(item.hidden && canHide(item.slot))) out[item.slot] = { icon: item.icon, ref: item.ref, rarity: item.rarity };
  return out;
}

/** Stable string for an outfit, for caching whatever is drawn from it. */
export function outfitKey(outfit: Outfit | undefined): string {
  if (!outfit) return "";
  return SLOTS.map((s) => (outfit[s] ? `${outfit[s]!.icon}:${outfit[s]!.rarity[0]}` : "-")).join(",") + (outfit.appearance ? `|${appearanceKey(outfit.appearance)}` : "");
}

/** Damage taken off each enemy hit by this much armor, before the half-the-hit cap. */
export function armorBlock(armor: number): number {
  return Math.floor(armor / 3);
}

/** A hit of `raw` damage against `armor`: armor never blocks more than half, and a hit always does at least 1. */
export function afterArmor(raw: number, armor: number): number {
  if (raw <= 0) return 0;
  return Math.max(1, raw - Math.min(armorBlock(armor), Math.floor(raw / 2)));
}

/** Why a hero cannot equip an item, or null if they can. */
export function equipProblem(item: ItemDef, classId: string, level: number): string | null {
  if (level < item.levelReq) return `Requires level ${item.levelReq}`;
  const only = item.kind === "weapon" ? WEAPONS[item.ref]?.classId : undefined;
  if (only && only !== classId) return `Only a ${heroClass(only)?.name ?? "different class"} can use this`;
  return null;
}

// ---------- prices and the shop ----------

const RARITY_PRICE = [20, 45, 100, 220, 500];

export function itemPrice(item: ItemDef): number {
  return RARITY_PRICE[rarityIndex(item.rarity)] + item.power * 6 + statPoints(item) * 10;
}

/** What the market stall pays for an item. */
export function sellPrice(item: ItemDef): number {
  return Math.floor(itemPrice(item) * 0.3);
}

export interface ShopEntry {
  index: number;
  item: ItemDef;
  price: number;
}

/**
 * The market stall's stock for one player on one day: one item per slot,
 * the last two a level above the buyer. Deterministic in the seed, so the
 * server can re-derive it to check a purchase instead of storing it.
 */
export function shopStock(seed: string, classId: string, level: number): ShopEntry[] {
  const rng = makeRng(seedFromString(`shop|${seed}`));
  return SLOTS.map((slot, index) => {
    const item = rollItem(rng, classId, 0.3, index >= SLOTS.length - 2 ? level + 1 : level, slot, undefined, false);
    return { index, item, price: itemPrice(item) };
  });
}
