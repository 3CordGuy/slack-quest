// The smithy: a Harbor crew project where gear is worked on between voyages.
//
// A weapon can be sharpened and a piece of armour reinforced, one step at a
// time, each step adding 1 to its power, up to SMITHY_MAX_STEPS. Each step
// costs more than the last. The upgrade lives on the item, so it goes with
// it through trades and shows in its name ("Anchor Mace +2").

import type { ItemDef } from "./gear";
import type { Resources } from "./hut";

/** The project id the smithy is built under (see PROJECTS). */
export const SMITHY_PROJECT = "smithy";

/** The most steps any one item can take. */
export const SMITHY_MAX_STEPS = 3;

export interface SmithyCost {
  gold: number;
  resources: Resources;
}

export type SmithyWork = "sharpen" | "reinforce";

/** What the smithy does to this kind of item, or null if it does nothing (trinkets). */
export function smithyWork(item: Pick<ItemDef, "kind">): SmithyWork | null {
  return item.kind === "weapon" ? "sharpen" : item.kind === "armor" ? "reinforce" : null;
}

/**
 * The cost of taking an item from `steps` to `steps + 1`, or null once it is
 * at the cap or for an item the smithy cannot work. Weapons take iron and
 * gold; armour takes iron and copper.
 */
export function smithyCost(item: Pick<ItemDef, "kind">, steps: number): SmithyCost | null {
  const work = smithyWork(item);
  const n = Math.floor(steps) + 1;
  if (!work || n < 1 || n > SMITHY_MAX_STEPS) return null;
  return work === "sharpen" ? { gold: 40 * n, resources: { iron: 3 * n } } : { gold: 0, resources: { iron: 2 * n, copper: 2 * n } };
}

/** Why this item cannot take its next step now, or null if it can. */
export function smithyProblem(
  item: Pick<ItemDef, "kind" | "name"> & { upgrades?: number },
  ctx: { built: boolean; gold: number; resources: Resources },
): string | null {
  if (!ctx.built) return "The crew has not built the smithy yet.";
  const work = smithyWork(item);
  if (!work) return "The smith only works weapons and armour.";
  const steps = item.upgrades ?? 0;
  const cost = smithyCost(item, steps);
  if (!cost) return `${item.name} is as good as the smith can make it.`;
  if (ctx.gold < cost.gold) return `That takes ${cost.gold} gold.`;
  for (const [kind, qty] of Object.entries(cost.resources) as [keyof Resources, number][]) {
    if ((ctx.resources[kind] ?? 0) < qty) return `That takes ${qty} ${kind}.`;
  }
  return null;
}

/** The name with its upgrade: "Anchor Mace +2". */
export function upgradedName(name: string, upgrades: number | undefined): string {
  return upgrades && upgrades > 0 ? `${name} +${upgrades}` : name;
}
