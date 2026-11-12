// Every piece of game content that has a player-facing name, keyed by a
// stable kind and id. The admin side uses it to list what can be renamed
// and to check that an override names something real. Display only: the
// rules keep using ids and never read from here.

import { ABILITIES, EFFECT_INFO, ENEMIES, HERO_CLASSES, WEAPONS } from "./content";
import { GEAR_BASES } from "./gear";
import { FURNISHINGS, RESOURCE_LABEL } from "./hut";
import { PROJECTS } from "./projects";
import { PUB_MENU } from "./pub";

export const CATALOGUE_KINDS = ["class", "ability", "weapon", "gear", "enemy", "furnishing", "resource", "pub", "project", "effect"] as const;
export type CatalogueKind = (typeof CATALOGUE_KINDS)[number];

/** The default (code) name and blurb for one entry. */
export interface CatalogueEntry {
  name: string;
  blurb?: string;
}

const index = <T>(items: Iterable<T>, id: (t: T) => string, entry: (t: T) => CatalogueEntry): Record<string, CatalogueEntry> =>
  Object.fromEntries([...items].map((t) => [id(t), entry(t)]));

export const CATALOGUE: Record<CatalogueKind, Record<string, CatalogueEntry>> = {
  class: index(HERO_CLASSES, (c) => c.id, (c) => ({ name: c.name, blurb: c.blurb })),
  ability: index(Object.values(ABILITIES), (a) => a.id, (a) => ({ name: a.name, blurb: a.blurb })),
  weapon: index(Object.values(WEAPONS), (w) => w.id, (w) => ({ name: w.name })),
  gear: index(GEAR_BASES, (b) => b.ref, (b) => ({ name: b.name })),
  enemy: index(Object.values(ENEMIES), (e) => e.kind, (e) => ({ name: e.name })),
  furnishing: index(Object.values(FURNISHINGS), (f) => f.id, (f) => ({ name: f.name, blurb: f.blurb })),
  resource: index(Object.entries(RESOURCE_LABEL), ([k]) => k, ([, label]) => ({ name: label })),
  pub: index(PUB_MENU, (p) => p.id, (p) => ({ name: p.name, blurb: p.blurb })),
  project: index(PROJECTS, (p) => p.id, (p) => ({ name: p.name, blurb: p.blurb })),
  effect: index(Object.entries(EFFECT_INFO), ([k]) => k, ([, e]) => ({ name: e.name, blurb: e.blurb })),
};

export const isCatalogueKind = (k: string): k is CatalogueKind => (CATALOGUE_KINDS as readonly string[]).includes(k);
