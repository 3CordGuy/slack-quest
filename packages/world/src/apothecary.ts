// The apothecary: a Harbor crew project that turns what is gathered into
// things to carry. Two kinds: the potions, flasks and bombs a hero drinks or
// throws on a map, which go into the pack and are kept until they are used
// (FLASK_RECIPES, at the foot of this file); and brews for the next voyage.
//
// A hero carries a small brew bag: at most one of each brew. Like food and
// drink from the pub, a brew is used up when that hero's next voyage sails.
// This file holds the recipes, the check a brew must pass, and what a bag
// adds to a hero. The server stores the bag and spends the materials.

import { addedSlots, carryProblem, type CarryState } from "./carry";
import type { Perk, ResourceKind, Resources } from "./hut";
import { THROWABLES, THROWABLE_KINDS } from "./zone/kit";
import type { Throwable } from "./zone/types";

/** The project id the apothecary is built under (see PROJECTS). */
export const APOTHECARY_PROJECT = "apothecary";

export interface BrewDef {
  id: string;
  name: string;
  blurb: string;
  recipe: Resources;
  /** What it adds on the next voyage. */
  buff: Perk;
}

export const BREWS: BrewDef[] = [
  { id: "healing", name: "Healing Draught", blurb: "Bitter, green, and better than bleeding.", recipe: { herbs: 3 }, buff: { potions: 1 } },
  { id: "focus", name: "Focus Tonic", blurb: "A sharp tea that keeps the mind on the job.", recipe: { herbs: 2, mushrooms: 2 }, buff: { focus: 1 } },
  { id: "stoneskin", name: "Stoneskin Salve", blurb: "Rubbed in before a fight. Smells of cellar.", recipe: { mushrooms: 3, bone: 1 }, buff: { maxHp: 4 } },
];

export const brewById = (id: string): BrewDef | undefined => BREWS.find((b) => b.id === id);

/** The brews a bag really holds: known ids, each at most once, in catalogue order. */
export function brewBag(ids: readonly string[] | undefined): string[] {
  const held = new Set(ids ?? []);
  return BREWS.filter((b) => held.has(b.id)).map((b) => b.id);
}

/** What a brew bag adds to a hero. Unknown ids count for nothing and a repeated one counts once. */
export function brewBuff(ids: readonly string[] | undefined): Required<Perk> {
  const total: Required<Perk> = { focus: 0, potions: 0, maxHp: 0, xpPct: 0 };
  for (const id of brewBag(ids)) {
    const def = brewById(id)!;
    for (const key of Object.keys(total) as (keyof Perk)[]) total[key] += def.buff[key] ?? 0;
  }
  return total;
}

/**
 * Why a hero cannot brew this now, or null if they can. The server runs it
 * against what it read; the batch that spends the materials checks the
 * holdings and the bag again.
 */
export function brewProblem(brewId: string, ctx: { built: boolean; bag: readonly string[]; resources: Resources }): string | null {
  const def = brewById(brewId);
  if (!def) return "No such brew.";
  if (!ctx.built) return "The crew has not built the apothecary yet.";
  if (ctx.bag.includes(def.id)) return `You already carry a ${def.name}. It is used up on your next voyage.`;
  for (const [kind, qty] of Object.entries(def.recipe) as [ResourceKind, number][]) {
    if ((ctx.resources[kind] ?? 0) < qty) return `A ${def.name} takes ${recipeText(def.recipe)}.`;
  }
  return null;
}

/** "2 herbs, 2 mushrooms". */
export function recipeText(recipe: Resources): string {
  return Object.entries(recipe)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
}

// ---------- for the pack: potions, flasks and bombs ----------

/**
 * What each thing a hero drinks or throws on a map takes to make (zone/kit.ts says what each does).
 * They are made one at a time, as many as there are materials and room in the pack for.
 */
export const FLASK_RECIPES: Record<Throwable, Resources> = {
  healing: { herbs: 3 },
  // Cave slime does most of the work: one of it and a mushroom.
  poison: { slime: 1, mushrooms: 1 },
  fire: { wood: 2, copper: 1 },
  oil: { bone: 2 },
  water: { fur: 1 },
  acid: { slime: 2, bone: 1 },
  slime: { slime: 2 },
  torch: { wood: 1, fur: 1 },
};

/** How many one making gives: torches come two at a time, everything else one. */
export const flaskYield = (kind: Throwable): number => (kind === "torch" ? 2 : 1);

/**
 * Why a hero cannot make one of these now, or null if they can. `carried` is what their pack holds of
 * each already, and `carry` how full the pack is: the first of a kind needs a square of its own.
 */
export function flaskProblem(
  kind: string,
  ctx: { built: boolean; resources: Resources; carried: Partial<Record<Throwable, number>>; carry: Pick<CarryState, "carried" | "limit"> | null },
): string | null {
  const k = THROWABLE_KINDS.find((t) => t === kind);
  if (!k) return "The apothecary does not make that.";
  if (!ctx.built) return "The crew has not built the apothecary yet.";
  const recipe = FLASK_RECIPES[k];
  for (const [res, qty] of Object.entries(recipe) as [ResourceKind, number][]) {
    if ((ctx.resources[res] ?? 0) < qty) return `${THROWABLES[k].name}: that takes ${recipeText(recipe)}.`;
  }
  return ctx.carry ? carryProblem(ctx.carry, addedSlots(ctx.carried[k] ?? 0, flaskYield(k))) : null;
}
