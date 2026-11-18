// Class abilities: each class has a pool of abilities only it can use, and a
// hero carries ABILITY_SLOTS of them into a fight, chosen from the pool. They
// come on top of what the weapon in hand gives (content.ts `abilitiesFor`).
// Pools are data: an entry names an ability in ABILITIES (which must also have
// a TACTICS entry in zone/kit.ts, and a test checks that) and the level it
// opens at. Loadouts are changed in the Harbor, never mid-adventure (the
// server checks; see apps/game db.ts `setAbilitySlot`).

import { ABILITIES } from "./content";

/** How many class abilities a hero carries at once. */
export const ABILITY_SLOTS = 3;

export interface PoolEntry {
  /** An id in ABILITIES. */
  id: string;
  /** The hero level it opens at. Everything is 1 for now. */
  level: number;
}

export type AbilityPools = Record<string, PoolEntry[]>;

/** What each class can choose from, by class id. Classes with no entries have no class abilities yet. */
export const ABILITY_POOLS: AbilityPools = {
  qa_paladin: [
    { id: "beacon_aura", level: 1 },
    { id: "healing_aura", level: 1 },
    { id: "branding_strike", level: 1 },
    { id: "stoke_the_fire", level: 1 },
    { id: "bolster", level: 1 },
    { id: "show_the_way", level: 1 },
  ],
  devops_mage: [
    { id: "soothing_rain", level: 1 },
    { id: "chain_lightning", level: 1 },
    { id: "roar_of_thunder", level: 1 },
    { id: "trade_winds", level: 1 },
    { id: "tidal_wave", level: 1 },
  ],
  refactor_rogue: [
    { id: "smugglers_route", level: 1 },
    { id: "sneak", level: 1 },
    { id: "pickpocket", level: 1 },
    { id: "tactical_retreat", level: 1 },
    { id: "contraband", level: 1 },
  ],
  backend_druid: [
    { id: "coral_field", level: 1 },
    { id: "aqueous_regeneration", level: 1 },
    { id: "coral_armor", level: 1 },
    { id: "revitalizing_splash", level: 1 },
    { id: "summon_sea_turtle", level: 1 },
  ],
  frontend_bard: [
    { id: "lively_shanty", level: 1 },
    { id: "dour_shanty", level: 1 },
    { id: "windgod_shanty", level: 1 },
    { id: "chorus", level: 1 },
    { id: "lead_by_example", level: 1 },
  ],
  staff_sage: [
    { id: "falling_star", level: 1 },
    { id: "constellation", level: 1 },
    { id: "new_moon", level: 1 },
    { id: "chart_a_course", level: 1 },
    { id: "north_star", level: 1 },
  ],
  sre_warden: [
    { id: "against_the_waves", level: 1 },
    { id: "overwhelm", level: 1 },
    { id: "fortify", level: 1 },
    { id: "bulwark_strike", level: 1 },
    { id: "taunt", level: 1 },
  ],
  data_warlock: [],
};

/** A hero's chosen abilities, one per slot, or null for an empty slot. */
export type AbilityLoadout = (string | null)[];

/** A class's pool, in the order it is shown. */
export function poolFor(classId: string, pools: AbilityPools = ABILITY_POOLS): PoolEntry[] {
  return pools[classId] ?? [];
}

/** The pool entries a hero of this level has opened. */
export function unlockedFor(classId: string, level: number, pools: AbilityPools = ABILITY_POOLS): PoolEntry[] {
  return poolFor(classId, pools).filter((e) => e.level <= level);
}

/**
 * Parse a stored loadout into exactly ABILITY_SLOTS slots, dropping anything malformed.
 * Whether an id is still in the class's pool is not decided here: `classAbilitiesOf` does that.
 */
export function parseAbilityLoadout(json: string | null | undefined): AbilityLoadout {
  let raw: unknown;
  try {
    raw = JSON.parse(json ?? "[]");
  } catch {
    raw = [];
  }
  const list = Array.isArray(raw) ? raw : [];
  return Array.from({ length: ABILITY_SLOTS }, (_, i) => (typeof list[i] === "string" && list[i] in ABILITIES ? (list[i] as string) : null));
}

/**
 * The abilities a hero's loadout actually gives: what is in the pool and opened at their level,
 * each once, in slot order. A pick that has since left the pool, or that the hero's level no
 * longer reaches, gives nothing.
 */
export function classAbilitiesOf(classId: string, level: number, loadout: readonly (string | null)[] | undefined, pools: AbilityPools = ABILITY_POOLS): string[] {
  const open = new Set(unlockedFor(classId, level, pools).map((e) => e.id));
  const out: string[] = [];
  for (const id of (loadout ?? []).slice(0, ABILITY_SLOTS)) if (id && open.has(id) && !out.includes(id)) out.push(id);
  return out;
}

/** Why `id` (or nothing, `null`, to empty the slot) can't go in `slot` now, or null if it can. */
export function abilitySlotError(classId: string, level: number, slot: number, id: string | null, pools: AbilityPools = ABILITY_POOLS): string | null {
  if (!Number.isInteger(slot) || slot < 0 || slot >= ABILITY_SLOTS) return "There is no such slot.";
  if (id === null) return null;
  const entry = poolFor(classId, pools).find((e) => e.id === id);
  if (!entry) return "That isn't one of your class's abilities.";
  if (level < entry.level) return `That opens at level ${entry.level}.`;
  return null;
}

/**
 * The loadout with `id` put in `slot` (null empties it). An ability already in another slot
 * trades places with whatever was here, so it is never in two slots at once.
 */
export function withAbilityInSlot(loadout: readonly (string | null)[], slot: number, id: string | null): AbilityLoadout {
  const next = Array.from({ length: ABILITY_SLOTS }, (_, i) => loadout[i] ?? null);
  const was = id === null ? -1 : next.indexOf(id);
  if (was >= 0) next[was] = next[slot];
  next[slot] = id;
  return next;
}

/** What a hero can use in a fight: the weapon's abilities, then the class abilities they have chosen. */
export function withClassAbilities(weaponAbilities: readonly string[], classAbilities: readonly string[] | undefined): string[] {
  return [...new Set([...weaponAbilities, ...(classAbilities ?? [])])];
}
