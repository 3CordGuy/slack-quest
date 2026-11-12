// Which combat sound goes with which blow, effect and fall. No Three.js or Web Audio
// here, so the choices can be tested on their own; audio.ts makes the sounds.

import { ABILITIES, type EffectKind } from "@gantt-quest/world";
import type { CombatSound } from "../audio";

/** How a blow sounds: a blade's swish and bite, a blunt thump, an arrow's twang and thunk, or a spell's zap. */
export type BlowKind = "blade" | "blunt" | "arrow" | "spell";

/** Shot from a bow (or a harpoon gun): these fly across as an arrow. Matches what WorldRenderer draws. */
export const ARROW_ABILITIES: ReadonlySet<string> = new Set(["Aimed Shot", "Pin Down", "Volley", "Barbed Arrow"]);

/** Cutting and biting blows, heroes' and enemies'. Anything else done by hand is blunt. */
const BLADE: ReadonlySet<string> = new Set([
  "Cleave", "Quick Stab", "Flurry", "Land the Catch",
  "Slash", "Cheap Shot", "Bite", "Savage Bite", "Pounce", "Sweeping Ruin",
]);

/** Enemy attacks (and the odd strength ability) that are magic rather than a weapon. */
const SPELLS: ReadonlySet<string> = new Set(["Dark Bolt", "Immolate", "Rending Howl", "Lighthouse Beam"]);

const spellByAbility = new Set(Object.values(ABILITIES).filter((a) => a.stat === "int_stat").map((a) => a.name));

export function blowKind(ability: string): BlowKind {
  if (ARROW_ABILITIES.has(ability)) return "arrow";
  if (SPELLS.has(ability) || spellByAbility.has(ability)) return "spell";
  if (BLADE.has(ability)) return "blade";
  return "blunt";
}

/** The sound of a blow landing. */
export function hitSound(kind: BlowKind): CombatSound {
  return kind === "arrow" ? "arrow_hit" : kind === "spell" ? "spell_hit" : kind;
}

/** The sound of a blow that misses: air for a weapon, a fizzle for a spell. */
export function missSound(kind: BlowKind): CombatSound {
  return kind === "spell" ? "fizzle" : "whiff";
}

/** The sound of something being let go across the field, if the blow flies: a bowstring or a casting whoosh. */
export function launchSound(kind: BlowKind): CombatSound | null {
  return kind === "arrow" ? "arrow_loose" : kind === "spell" ? "spell_cast" : null;
}

/** The short tell of an effect landing (or biting again, for the ones that hurt each turn). */
export function effectSound(effect: EffectKind): CombatSound {
  switch (effect) {
    case "bleeding":
      return "bleed";
    case "burning":
      return "burn";
    case "stunned":
      return "stun";
    case "guarded":
    case "taunting":
    case "hasted":
      return "buff";
    default:
      return "debuff";
  }
}
