// Per-class AbilityDef[] exports. Talent tree wrappers + types live in
// ./types, ./tree, and ./new_nodes; those are re-exported from the package
// root (packages/core/src/index.ts) to avoid duplicate-export ambiguity here.

export { mageAbilities } from "./mage";
export { paladinAbilities } from "./paladin";
export { druidAbilities } from "./druid";
export { bardAbilities } from "./bard";
export { sageAbilities } from "./sage";
export { rogueAbilities } from "./rogue";
export { wardenAbilities } from "./warden";
export { warlockAbilities } from "./warlock";
