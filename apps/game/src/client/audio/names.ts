// Every name the game asks the audio engine for, most specific first.
//
// The engine plays the first name in a list that the manifest has files for,
// so you can start with one general sound ("impact") and add specific ones
// ("impact.firebolt") whenever you like, without touching code. `soundNames()`
// lists every name the game can ask for; a test checks the manifest against it,
// so a misspelt event is caught rather than silently never playing.

import { ABILITIES, ENEMIES, RARITIES, RESOURCE_KINDS, TRAITS, WEAPONS, type Biome, type EffectKind, type ForageKind, type WorldEvent } from "@gantt-quest/world";
import { slug } from "./select";

/** How an attack travels, which the renderer already decides for its effects. */
export type AttackStyle = "melee" | "ranged" | "magic";
export const ATTACK_STYLES: AttackStyle[] = ["melee", "ranged", "magic"];

/** Someone in a fight: a hero (kind is their class) or an enemy (kind is the enemy's kind). */
export interface Fighter {
  side: "hero" | "enemy";
  kind: string;
}

const BIOMES: Record<Biome, true> = { plains: true, forest: true, hills: true, water: true, dock: true, cobble: true, mud: true, rampart: true, floor: true, wall: true, cave: true, rock: true, gate: true, fog: true };
const EFFECTS: Record<EffectKind, true> = { bleeding: true, burning: true, stunned: true, guarded: true, taunting: true, slowed: true, hasted: true, glitched: true, exposed: true };
const FORAGE: Record<ForageKind, true> = { berries: true, wood: true, bones: true, treasure: true, wolves: true };

const voice = (f: Fighter, what: "attack" | "hurt" | "down") =>
  f.side === "enemy" ? [`enemy.${f.kind}.${what}`, `enemy.${what}`] : [`hero.${f.kind}.${what}`, `hero.${what}`];

export const FISHING_SOUNDS = ["cast", "plop", "nibble", "plunge", "bite", "splash", "snap", "reel", "land"] as const;
export type FishingSound = (typeof FISHING_SOUNDS)[number];

export const soundName = {
  /** A foot landing, by the ground under it. */
  footstep: (biome: string) => [`footstep.${biome}`, "footstep"],
  /** An attack setting off: the swing, the draw, the cast. `ability` is its display name. */
  attack: (ability: string, style: AttackStyle) => [`attack.${slug(ability)}`, `attack.${style}`, "attack"],
  /** The attacker's voice as it attacks. */
  attackVoice: (f: Fighter) => voice(f, "attack"),
  /** A blow landing. */
  impact: (ability: string, style: AttackStyle) => [`impact.${slug(ability)}`, `impact.${style}`, "impact"],
  /** Laid over the impact when the roll was perfect. */
  crit: () => ["impact.crit"],
  /** The target's voice as it is hit. */
  hurt: (f: Fighter) => voice(f, "hurt"),
  miss: (ability: string, style: AttackStyle) => [`miss.${slug(ability)}`, `miss.${style}`, "miss"],
  heal: (ability: string) => [`heal.${slug(ability)}`, "heal"],
  healFailed: () => ["heal.fail"],
  /** Damage over time ticking (bleeding, burning). */
  tick: (effect: string) => [`tick.${effect}`, "tick"],
  /** An effect taking hold. */
  effect: (effect: string) => [`effect.${effect}`, "effect"],
  down: (f: Fighter) => [...voice(f, "down"), "down"],
  flee: (ok: boolean) => [ok ? "flee.ok" : "flee.fail", "flee"],
  trait: (name: string) => [`trait.${slug(name)}`, "trait"],
  yourTurn: () => ["turn.yours"],
  /** A boss's first appearance in a fight. */
  boss: () => ["stinger.boss", "stinger.battle_start"],
  levelUp: () => ["level_up"],
  /** A lightning strike and its thunder, in a storm. The flash on screen follows the take that plays. */
  thunder: () => ["weather.thunder"],
  /** Felling: the axe biting a trunk or a log (by how well a split was struck), and a tree coming down. */
  chop: (grade: "perfect" | "good" | "miss") => [`gather.chop.${grade}`, "gather.chop"],
  fall: (what: "timber") => [`gather.${what}`],
  /** The quarry: the pick striking (a full charge is heavy), a rock giving way, and what it gave. */
  pick: (heavy: boolean) => (heavy ? ["gather.pick.heavy", "gather.pick"] : ["gather.pick"]),
  rockBreak: () => ["gather.rock"],
  /** Fishing: the cast, the float landing, a nibble, the bite, a fish jumping, the line snapping, reeling it in, landing it. */
  fishing: (what: FishingSound) => [`gather.fish.${what}`],
  find: (what: "ore" | "gem") => [`gather.${what}`],

  /**
   * Something that happened on a voyage. Rewards and finds sound only for the
   * hero they belong to (`you`); null when this event makes no sound.
   */
  world(ev: WorldEvent, you: string): string[] | null {
    const mine = "heroId" in ev && ev.heroId === you;
    switch (ev.t) {
      case "battle_start":
        return ev.heroes.includes(you) ? ["stinger.battle_start"] : null;
      case "battle_end":
        return ev.status === "victory" ? ["stinger.victory"] : ev.status === "defeat" ? ["stinger.defeat"] : ev.status === "fled" ? ["stinger.fled"] : null;
      case "ended":
        return [ev.outcome === "victory" ? "stinger.voyage_won" : "stinger.voyage_lost"];
      case "ambush":
        return mine ? ["stinger.ambush"] : null;
      case "turn_start":
        return mine ? ["turn.yours"] : null;
      case "loot":
        return mine ? [`loot.${ev.item.rarity}`, "loot"] : null;
      case "key_item":
        return mine ? ["key_item", "loot"] : null;
      case "gold":
        return mine && ev.amount > 0 ? ["gold"] : null;
      case "pickup":
        return mine ? [`pickup.${ev.find}`, "pickup"] : null;
      case "forage":
        return mine ? [`forage.${ev.kind}`, "forage"] : null;
      case "search":
        return mine ? [ev.found ? "search.found" : "search.empty"] : null;
      case "rest":
        return mine ? ["rest"] : null;
      case "poi_revealed":
        return ["discover"];
      default:
        return null;
    }
  },
};

/** Every name the game can ask for. */
export function soundNames(): Set<string> {
  const names = new Set<string>();
  const add = (list: string[] | null) => list?.forEach((n) => names.add(n));
  const attacks = [...Object.values(ABILITIES).map((a) => a.name), ...Object.values(ENEMIES).flatMap((e) => e.attacks.map((a) => a.name))];
  const fighters: Fighter[] = [
    ...[...new Set(Object.values(WEAPONS).map((w) => w.classId))].map((kind) => ({ side: "hero" as const, kind })),
    ...Object.keys(ENEMIES).map((kind) => ({ side: "enemy" as const, kind })),
  ];
  for (const biome of Object.keys(BIOMES)) add(soundName.footstep(biome));
  for (const style of ATTACK_STYLES) {
    for (const a of attacks) {
      add(soundName.attack(a, style));
      add(soundName.impact(a, style));
      add(soundName.miss(a, style));
    }
  }
  // Heals come from abilities, and from traits and the druid's Deep Roots.
  for (const a of [...attacks, ...TRAITS.map((t) => t.name), "Deep Roots"]) add(soundName.heal(a));
  for (const f of fighters) {
    add(soundName.attackVoice(f));
    add(soundName.hurt(f));
    add(soundName.down(f));
  }
  for (const e of Object.keys(EFFECTS)) {
    add(soundName.tick(e));
    add(soundName.effect(e));
  }
  for (const t of TRAITS) add(soundName.trait(t.name));
  [soundName.crit(), soundName.healFailed(), soundName.flee(true), soundName.flee(false), soundName.yourTurn(), soundName.levelUp(), soundName.thunder()].forEach(add);
  add(["stinger.boss", "stinger.battle_start", "stinger.victory", "stinger.defeat", "stinger.fled", "stinger.voyage_won", "stinger.voyage_lost", "stinger.ambush"]);
  add(["loot", ...RARITIES.map((r) => `loot.${r}`), "key_item", "gold", "pickup", ...RESOURCE_KINDS.map((k) => `pickup.${k}`)]);
  for (const g of ["perfect", "good", "miss"] as const) add(soundName.chop(g));
  add(soundName.fall("timber"));
  [soundName.pick(true), soundName.rockBreak(), soundName.find("ore"), soundName.find("gem")].forEach(add);
  for (const f of FISHING_SOUNDS) add(soundName.fishing(f));
  add(["forage", ...Object.keys(FORAGE).map((k) => `forage.${k}`), "search.found", "search.empty", "rest", "discover"]);
  return names;
}
