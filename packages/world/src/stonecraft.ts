// Working lodestones at the bench (lodestone.ts says what a lodestone is):
// four ways to turn the stones a hero has into the ones they want.
//
//   fuse     three stones that carry the same number of things become one
//            that carries one more. What it carries is drawn from what the
//            three carried (at the ranks they had), so far as that goes,
//            and made up beyond that. Three plain ones (which can always be
//            cut) make a stone that carries something: the way from stone
//            and iron to a modifier.
//   attune   add one chosen modifier, at its first rank, to a stone that
//            has room for it, for gold and the material that modifier is
//            made of. The more the stone carries already, and the rarer the
//            modifier, the dearer.
//   temper   raise one thing a stone carries by a rank, for a good deal of
//            gold, more of its material, and gems. The dear way to a better
//            stone: a peril more perilous and better paid, a boon richer.
//   reroll   for gold, a stone that carries something carries something
//            else: as many things, at the ranks it had (so far as the new
//            things have them), and never just what it had. What comes is
//            what comes: it may be worse.
//
// Each uses up what goes in. Whatever comes out is rolled by the server.

import type { Resources } from "./hut";
import { STONE_MODS, type Lodestone } from "./lodestone";
import type { Rng } from "./rng";
import { ZONE_MODS, ZONE_MOD_IDS, modOf, modRanks, modToken, rollMod, type ZoneMod, type ZoneModId } from "./zone/mods";

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
  gilded: { copper: 8, gem: 1 },
  storied: { herbs: 8, gem: 1 },
  laden: { iron: 8, gem: 1 },
  lodebearing: { stone: 10, iron: 6, gem: 2 },
};
const ATTUNE_GOLD = 20;
const TEMPER_GOLD = 60;
const REROLL_GOLD = 30;
/** How many times dearer a modifier is than the commonest: the rarer, the dearer. */
const rarity = (id: ZoneModId) => 10 / ZONE_MODS[id].weight;

const idsOf = (stone: readonly ZoneMod[]): ZoneModId[] => stone.map((m) => modOf(m)!.id);
/** A stone's modifiers in the modifiers' own order. */
const ordered = (mods: readonly ZoneMod[]): Lodestone => ZONE_MOD_IDS.flatMap((id) => mods.filter((m) => modOf(m)!.id === id));
/** Whether a stone that carries `ids` could carry `id` as well: not twice, and one kind of ground at most. */
const fits = (ids: readonly ZoneModId[], id: ZoneModId) => !ids.includes(id) && !(ZONE_MODS[id].hazard && ids.some((o) => ZONE_MODS[o].hazard));
const times = (resources: Resources, n: number): Resources => Object.fromEntries(Object.entries(resources).map(([kind, qty]) => [kind, qty! * n]));

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
  // What went in, each thing once at the highest rank it came at, in a shuffled order; then anything else.
  const best = new Map<ZoneModId, number>();
  for (const mod of stones.flat()) best.set(modOf(mod)!.id, Math.max(best.get(modOf(mod)!.id) ?? 0, modOf(mod)!.rank));
  const pool = [...best.keys()];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const ids: ZoneModId[] = [];
  const out: ZoneMod[] = [];
  for (const id of pool) {
    if (out.length >= want || !fits(ids, id)) continue;
    ids.push(id);
    out.push(modToken(id, best.get(id)!));
  }
  for (let tries = 0; out.length < want && tries < 40; tries++) {
    const mod = rollMod(rng, ZONE_MOD_IDS, 1, (id) => fits(ids, id));
    if (!mod) break;
    ids.push(modOf(mod)!.id);
    out.push(mod);
  }
  return ordered(out);
}

// ---------- attune ----------

/** Why a modifier cannot be added to a stone, or null if it can. */
export function attuneProblem(stone: Lodestone, mod: unknown): string | null {
  if (typeof mod !== "string" || !(mod in ZONE_MODS)) return "There is no such thing to attune it to.";
  if (idsOf(stone).includes(mod as ZoneModId)) return "It carries that already.";
  if (stone.length >= STONE_MODS) return "It carries all a lodestone can.";
  return fits(idsOf(stone), mod as ZoneModId) ? null : "It carries one kind of ground already: a second would not take.";
}

/** What adding a modifier to a stone costs: the modifier's own material and gold (more for the rarer), times one more than the stone carries. */
export function attuneCost(stone: Lodestone, mod: ZoneModId): { gold: number; resources: Resources } {
  const n = stone.length + 1;
  return { gold: Math.round(ATTUNE_GOLD * n * rarity(mod)), resources: times(ATTUNE_MATERIALS[mod], n) };
}

/** A stone with a modifier added, at its first rank. */
export const attuned = (stone: Lodestone, mod: ZoneModId): Lodestone => ordered([...stone, modToken(mod)]);

// ---------- temper ----------

/** Why a thing a stone carries cannot be raised a rank, or null if it can. */
export function temperProblem(stone: Lodestone, mod: unknown): string | null {
  const one = modOf(mod);
  if (!one || !stone.includes(mod as ZoneMod)) return "The stone does not carry that.";
  return one.rank >= modRanks(one.id) ? "That is as much of it as there is." : null;
}

/** What raising a thing a stone carries by a rank costs: gold (more for the rarer, and for the higher rank), more of its material, and gems. */
export function temperCost(mod: ZoneMod): { gold: number; resources: Resources } {
  const { id, rank } = modOf(mod)!;
  const next = rank + 1;
  const resources = times(ATTUNE_MATERIALS[id], next + 1);
  return { gold: Math.round(TEMPER_GOLD * next * rarity(id)), resources: { ...resources, gem: (resources.gem ?? 0) + next } };
}

/** A stone with one of the things it carries raised a rank. */
export const tempered = (stone: Lodestone, mod: ZoneMod): Lodestone => stone.map((m) => (m === mod ? modToken(modOf(mod)!.id, modOf(mod)!.rank + 1) : m));

// ---------- reroll ----------

/** Why a stone cannot be rerolled, or null if it can. */
export const rerollProblem = (stone: Lodestone): string | null => (stone.length === 0 ? "A plain lodestone carries nothing to change." : null);

/** What rerolling a stone costs, in gold: more the more it carries, and the higher the ranks it carries it at. */
export const rerollCost = (stone: Lodestone): number => REROLL_GOLD * stone.reduce((n, m) => n + modOf(m)!.rank, 0);

/** A stone that carries as many things as this one, at the ranks it had so far as the new things have them, and not the same things. */
export function reroll(rng: Rng, stone: Lodestone): Lodestone {
  const ranks = stone.map((m) => modOf(m)!.rank);
  const build = (ids: ZoneModId[]) => ordered(ids.map((id, i) => modToken(id, ranks[i])));
  for (let attempt = 0; attempt < 12; attempt++) {
    const ids: ZoneModId[] = [];
    for (let tries = 0; ids.length < stone.length && tries < 40; tries++) {
      const mod = rollMod(rng, ZONE_MOD_IDS, 1, (id) => fits(ids, id));
      if (mod) ids.push(modOf(mod)!.id);
    }
    const made = build(ids);
    if (made.length === stone.length && made.join("+") !== stone.join("+")) return made;
  }
  // So unlucky as to land on itself every time: swap its first thing for the first that fits.
  const rest = idsOf(stone).slice(1);
  return build([ZONE_MOD_IDS.find((id) => id !== idsOf(stone)[0] && fits(rest, id))!, ...rest]);
}
