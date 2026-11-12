// The galley: a Harbor crew project that provisions the ship.
//
// Unlike the apothecary's brews, which each hero carries for themself, the
// galley cooks into one larder the whole crew shares. Anyone in the crew can
// cook into it; when the crew's next ship sails the whole larder goes aboard
// and is emptied. Ship's stores lengthen the doom clock as the voyage opens;
// chowder stays in the hold, and any hero resting at the landing eats a bowl
// to come back to full HP and focus. Chowder left uneaten is lost with the
// voyage. This file holds the dishes, their caps, the check a cook must pass
// and what a larder does for a voyage. The server stores the larder.

import type { ResourceKind, Resources } from "./hut";

/** The project id the galley is built under (see PROJECTS). */
export const GALLEY_PROJECT = "galley";

export type DishId = "chowder" | "stores";

export interface DishDef {
  id: DishId;
  name: string;
  /** Plural, for counts: "3 chowders". */
  plural: string;
  blurb: string;
  recipe: Resources;
  /** Most the larder can hold of this dish. */
  cap: number;
  /** What it does on the voyage, in words. */
  effect: string;
}

export const DISHES: DishDef[] = [
  {
    id: "chowder",
    name: "Fish Chowder",
    plural: "chowders",
    blurb: "Fish bones boiled down with herbs, kept hot in the hold.",
    recipe: { bone: 2, herbs: 2 },
    cap: 4,
    effect: "A hero resting at the landing eats one: back to full HP and focus.",
  },
  {
    id: "stores",
    name: "Ship's Stores",
    plural: "stores",
    blurb: "Hard tack and dried mushrooms, packed tight in hides.",
    recipe: { fur: 2, mushrooms: 3 },
    cap: 2,
    effect: "One more day on the doom clock.",
  },
];

/** HP the landing gives without chowder. A hero this short or less, with focus full, rests without eating. */
export const LANDING_REST_HP = 6;

export const dishById = (id: string): DishDef | undefined => DISHES.find((d) => d.id === id);

/** A crew's larder: how many of each dish it holds. */
export type Larder = Record<DishId, number>;

/** What a larder really holds: whole numbers, never below nothing or above each dish's cap. Anything else counts for nothing. */
export function cleanLarder(raw: unknown): Larder {
  const src = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out = {} as Larder;
  for (const d of DISHES) {
    const n = src[d.id];
    out[d.id] = typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(d.cap, Math.floor(n))) : 0;
  }
  return out;
}

/**
 * Why a crewmate cannot cook this now, or null if they can. The server runs
 * it against what it read; the batch that spends the materials checks the
 * holdings and the larder's room again.
 */
export function cookProblem(dishId: string, ctx: { built: boolean; larder: Partial<Larder>; resources: Resources }): string | null {
  const def = dishById(dishId);
  if (!def) return "No such dish.";
  if (!ctx.built) return "The crew has not built the galley yet.";
  if ((ctx.larder[def.id] ?? 0) >= def.cap) return `The larder already holds ${def.cap} ${def.plural}, as many as it takes.`;
  for (const [kind, qty] of Object.entries(def.recipe) as [ResourceKind, number][]) {
    if ((ctx.resources[kind] ?? 0) < qty) return `${def.name} takes ${dishRecipeText(def.recipe)}.`;
  }
  return null;
}

/** "2 bone, 2 herbs". */
export function dishRecipeText(recipe: Resources): string {
  return Object.entries(recipe)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 chowders and 2 days of stores", or "" for an empty larder. */
export function larderText(larder: Partial<Larder> | undefined): string {
  const l = cleanLarder(larder);
  return [l.chowder ? count(l.chowder, "chowder", "chowders") : "", l.stores ? count(l.stores, "day of stores", "days of stores") : ""].filter(Boolean).join(" and ");
}

export interface GalleyBoon {
  /** Days the stores add to the doom clock. */
  doomDays: number;
  /** Chowder carried in the hold for the voyage. */
  chowder: number;
  /** Said once as the voyage opens, or null for an empty larder. */
  line: string | null;
}

/** What a larder taken aboard does for a voyage. */
export function galleyBoon(larder: unknown): GalleyBoon {
  const l = cleanLarder(larder);
  const text = larderText(l);
  return { doomDays: l.stores, chowder: l.chowder, line: text ? `The galley stocked the hold: ${text}.` : null };
}

/**
 * Whether a hero resting at the landing should eat a chowder: only when there
 * is one, and the plain rest would leave them short of HP or focus.
 */
export function eatsChowder(hero: { hp: number; maxHp: number; focus: number; maxFocus: number }, chowder: number): boolean {
  if (chowder <= 0) return false;
  return hero.maxHp - hero.hp > LANDING_REST_HP || hero.focus < hero.maxFocus;
}
