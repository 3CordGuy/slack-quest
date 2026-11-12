// Player-facing names and blurbs, with the admin overrides applied. Every
// screen that shows a class, ability, weapon, gear base, furnishing,
// resource, pub item, project, enemy or effect by name reads it from here, so
// a rename on the admin side reaches the whole UI. Display only: the rules
// and the server keep using ids and the code defaults.

import { CATALOGUE, RARITY_PREFIX, upgradedName, type CatalogueKind, type ItemDef, type ProjectCostKind } from "@gantt-quest/world";
import { content } from "./content";

const override = (kind: CatalogueKind, id: string) => content().names[`${kind}:${id}`];

/** The name for a catalogue entry: the override, else the code default, else the id itself. */
export function label(kind: CatalogueKind, id: string): string {
  return override(kind, id)?.name ?? CATALOGUE[kind][id]?.name ?? id;
}

/** The blurb for a catalogue entry, or "" when it has none. */
export function blurb(kind: CatalogueKind, id: string): string {
  return override(kind, id)?.blurb ?? CATALOGUE[kind][id]?.blurb ?? "";
}

/**
 * An item's name. Items keep the name they were made with (rarity word plus
 * base name), so when the base has been renamed it is built again from the
 * ref and rarity; otherwise the stored name stands.
 */
export function itemName(item: Pick<ItemDef, "kind" | "ref" | "rarity" | "name" | "upgrades">): string {
  const kind: CatalogueKind = item.kind === "weapon" ? "weapon" : "gear";
  const renamed = override(kind, item.ref)?.name;
  // Work done at the smithy shows after the name: "Audit Mace +2".
  return upgradedName(renamed ? `${RARITY_PREFIX[item.rarity] ?? ""}${renamed}` : item.name, item.upgrades);
}

/** What a crew project asks for: gold, or a resource by its (possibly renamed) label. */
export const costLabel = (kind: ProjectCostKind): string => (kind === "gold" ? "Gold" : label("resource", kind));
