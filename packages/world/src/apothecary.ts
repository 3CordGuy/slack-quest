// The apothecary: a Harbor crew project that turns what is gathered into
// things to carry: the potions, flasks and bombs a hero drinks or throws on a
// map, which go into the pack and are kept until they are used. This file
// holds the recipes and the check a making must pass. The server spends the
// materials and fills the pack.

import { addedSlots, carryProblem, type CarryState } from "./carry";
import type { ResourceKind, Resources } from "./hut";
import { THROWABLES, THROWABLE_KINDS } from "./zone/kit";
import type { Throwable } from "./zone/types";

/** The project id the apothecary is built under (see PROJECTS). */
export const APOTHECARY_PROJECT = "apothecary";

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
