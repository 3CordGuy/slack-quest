// Working lodestones at the bench (lodestone.ts says what a lodestone is):
// three ways to turn the stones a hero has into the ones they want.
//
//   fuse     three stones that carry the same number of things become one
//            that carries one more. What it carries is drawn from what the
//            three carried, so far as that goes, and made up beyond that.
//            Three plain ones (which can always be cut) make a stone that
//            carries something: the way from stone and iron to a modifier.
//   attune   add one chosen modifier to a stone that has room for it, for
//            gold and the material that modifier is made of. The more the
//            stone carries already, the dearer.
//   reroll   for gold, a stone that carries something carries something
//            else: as many things, and never just what it had.
//
// Each uses up what goes in. Whatever comes out is rolled by the server.

import type { Resources } from "./hut";
import { STONE_MODS, type Lodestone } from "./lodestone";
import type { Rng } from "./rng";
import { ZONE_MODS, ZONE_MOD_IDS, type ZoneModId } from "./zone/mods";

/** How many stones are fused into one. */
export const FUSE_COUNT = 3;

/** What each modifier is made of, for a stone that carries nothing yet. A stone that carries more costs that many times more. */
export const ATTUNE_MATERIALS: Record<ZoneModId, Resources> = {
  tangled: { wood: 12 },
  craggy: { stone: 12 },
  sprawling: { wood: 8, stone: 8 },
  smouldering: { wood: 6, copper: 4 },
  fouled: { mushrooms: 8 },
  slick: { slime: 6 },
  frozen: { copper: 8 },
  hardy: { fur: 8 },
  savage: { bone: 8 },
  swift: { herbs: 6, fur: 3 },
  numerous: { bone: 6, iron: 6 },
};
const ATTUNE_GOLD = 20;
const REROLL_GOLD = 30;

const ordered = (mods: Iterable<ZoneModId>): Lodestone => {
  const has = new Set(mods);
  return ZONE_MOD_IDS.filter((id) => has.has(id));
};
/** Whether a stone that carries `mods` could carry `id` as well: not twice, and one kind of ground at most. */
const fits = (mods: readonly ZoneModId[], id: ZoneModId) => !mods.includes(id) && !(ZONE_MODS[id].hazard && mods.some((o) => ZONE_MODS[o].hazard));

// ---------- fuse ----------

/** Why these stones cannot be fused, or null if they can: three of them, each carrying as much as the others, and less than a stone can. */
export function fuseProblem(stones: readonly Lodestone[]): string | null {
  if (stones.length !== FUSE_COUNT) return `It takes ${FUSE_COUNT} lodestones.`;
  if (stones.some((s) => s.length !== stones[0].length)) return "The three must carry the same number of things.";
  return stones[0].length >= STONE_MODS ? "A lodestone can carry no more than these do." : null;
}

/** The stone three fused stones make: one more thing than each carried, drawn from what they carried so far as that goes. */
export function fuse(rng: Rng, stones: readonly Lodestone[]): Lodestone {
  const want = stones[0].length + 1;
  const out: ZoneModId[] = [];
  // What went in, in a shuffled order, then anything else.
  const pool = [...new Set(stones.flat())];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  for (const id of pool) if (out.length < want && fits(out, id)) out.push(id);
  for (let tries = 0; out.length < want && tries < 40; tries++) {
    const id = rng.pick(ZONE_MOD_IDS);
    if (fits(out, id)) out.push(id);
  }
  return ordered(out);
}

// ---------- attune ----------

/** Why a modifier cannot be added to a stone, or null if it can. */
export function attuneProblem(stone: Lodestone, mod: unknown): string | null {
  if (typeof mod !== "string" || !(mod in ZONE_MODS)) return "There is no such thing to attune it to.";
  if (stone.includes(mod as ZoneModId)) return "It carries that already.";
  if (stone.length >= STONE_MODS) return "It carries all a lodestone can.";
  return fits(stone, mod as ZoneModId) ? null : "It carries one kind of ground already: a second would not take.";
}

/** What adding a modifier to a stone costs: the modifier's own material and some gold, times one more than the stone carries. */
export function attuneCost(stone: Lodestone, mod: ZoneModId): { gold: number; resources: Resources } {
  const times = stone.length + 1;
  return { gold: ATTUNE_GOLD * times, resources: Object.fromEntries(Object.entries(ATTUNE_MATERIALS[mod]).map(([kind, n]) => [kind, n! * times])) };
}

/** A stone with a modifier added. */
export const attuned = (stone: Lodestone, mod: ZoneModId): Lodestone => ordered([...stone, mod]);

// ---------- reroll ----------

/** Why a stone cannot be rerolled, or null if it can. */
export const rerollProblem = (stone: Lodestone): string | null => (stone.length === 0 ? "A plain lodestone carries nothing to change." : null);

/** What rerolling a stone costs, in gold: more the more it carries. */
export const rerollCost = (stone: Lodestone): number => REROLL_GOLD * stone.length;

/** A stone that carries as many things as this one, and not the same things. */
export function reroll(rng: Rng, stone: Lodestone): Lodestone {
  for (let attempt = 0; attempt < 12; attempt++) {
    const out: ZoneModId[] = [];
    for (let tries = 0; out.length < stone.length && tries < 40; tries++) {
      const id = rng.pick(ZONE_MOD_IDS);
      if (fits(out, id)) out.push(id);
    }
    const made = ordered(out);
    if (made.length === stone.length && made.join("+") !== stone.join("+")) return made;
  }
  // So unlucky as to land on itself every time: swap its first thing for the first that fits.
  const rest = stone.slice(1);
  return ordered([...rest, ZONE_MOD_IDS.find((id) => id !== stone[0] && fits(rest, id))!]);
}
