// A hero as a fighter. The voyage (world.ts) and the Harbor's sparring ring
// both build their combatants here, so a practice bout plays exactly like
// the real thing.

import type { Stats } from "@gantt-quest/core";
import type { Combatant } from "./battle";
import { statPct } from "./check";
import { WEAPONS, heroClass } from "./content";
import { loadoutOf, outfitOf, type ItemDef, type Outfit } from "./gear";
import { addStats, maxFocusFor, maxHpFor } from "./progression";

/** The parts of a hero that decide how they fight. A `HeroInit` or a `Hero` satisfies this. */
export interface HeroSheet {
  id: string;
  name: string;
  classId: string;
  level: number;
  /** Base stats, without gear. */
  base: Stats;
  /** Sum of equipped gear bonuses. */
  bonus: Partial<Stats>;
  weapon: string;
  weaponPower: number;
  armor: number;
  outfit?: Outfit;
}

/** What a fight wears down. */
export interface Vitals {
  hp: number;
  maxHp: number;
  focus: number;
  maxFocus: number;
  potions: number;
}

/** What equipped items contribute to a hero. With no weapon in hand, the class's starting weapon is used. */
export function gearSheet(classId: string, worn: ItemDef[]): Pick<HeroSheet, "bonus" | "weapon" | "weaponPower" | "armor" | "outfit"> {
  const loadout = loadoutOf(worn);
  return {
    bonus: loadout.bonus,
    weapon: loadout.weapon ?? heroClass(classId)?.weapons[0] ?? "",
    weaponPower: loadout.weaponPower,
    armor: loadout.armor,
    outfit: outfitOf(worn),
  };
}

/** A rested hero: full HP and focus and one potion. How a hero boards a ship, and how every sparring bout starts. */
export function freshVitals(sheet: Pick<HeroSheet, "base" | "bonus" | "level">): Vitals {
  const maxHp = maxHpFor(addStats(sheet.base, sheet.bonus), sheet.level);
  const maxFocus = maxFocusFor(sheet.level);
  return { hp: maxHp, maxHp, focus: maxFocus, maxFocus, potions: 1 };
}

/** The hero as a combatant. Pass the hero's current `vitals` mid-voyage; without them the hero is rested. */
export function heroCombatant(sheet: HeroSheet, vitals: Pick<Vitals, "hp" | "maxHp" | "focus" | "potions"> = freshVitals(sheet)): Combatant {
  const stats = addStats(sheet.base, sheet.bonus);
  return {
    id: sheet.id,
    side: "hero",
    name: sheet.name,
    kind: sheet.classId,
    level: sheet.level,
    hp: vitals.hp,
    maxHp: vitals.maxHp,
    pct: { str: statPct(stats.str), int_stat: statPct(stats.int_stat), vit: statPct(stats.vit), agi: statPct(stats.agi), dex: statPct(stats.dex) },
    outfit: sheet.outfit,
    power: sheet.weaponPower ?? 0,
    armor: sheet.armor ?? 0,
    speed: statPct(stats.agi),
    focus: vitals.focus,
    potions: vitals.potions,
    abilities: WEAPONS[sheet.weapon]?.abilities ?? [],
    effects: [],
    down: false,
  };
}
