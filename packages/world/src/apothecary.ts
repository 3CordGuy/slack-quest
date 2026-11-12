// The apothecary: a Harbor crew project that turns herbs and mushrooms into
// brews for the next voyage.
//
// A hero carries a small brew bag: at most one of each brew. Like food and
// drink from the pub, a brew is used up when that hero's next voyage sails.
// This file holds the recipes, the check a brew must pass, and what a bag
// adds to a hero. The server stores the bag and spends the materials.

import type { Perk, ResourceKind, Resources } from "./hut";

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
  { id: "stoneskin", name: "Stoneskin Salve", blurb: "Rubbed in before a fight. Smells of cellar.", recipe: { mushrooms: 3, bone: 1 }, buff: { maxHp: 3 } },
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
