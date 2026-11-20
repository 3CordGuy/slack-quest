// D1 access for the game. D1 is the system of record for players,
// characters, inventory, crews and huts.
//
// The code is in db/, a module to each of those; this file only passes on
// what they export, so an import from "./db" works from anywhere. A new
// function goes in the module it belongs with and is named in that module's
// line here. The modules in db/ import from each other directly, never from
// this file.

export { insertItem, paidItemStatement, rowToItem, statsOf, type CharacterRow, type Env, type InventoryRow, type Player } from "./db/rows";
export { attachEmail, consumeEmailCode, createGuest, createPlayerWithEmail, createSession, deleteSession, issueEmailCode, normalizeEmail, playerByEmail, playerForToken } from "./db/players";
export {
  classAppearance,
  cleanHeroName,
  confirmCharacter,
  deleteCharacter,
  dressInGarb,
  ensureLook,
  getCharacter,
  renameCharacter,
  saveAppearance,
  saveDraft,
  setAbilitySlot,
  spendPoint,
} from "./db/characters";
export { CELLS_SQL, carriedSql, carryState, equipItem, getInventory, packHasRoomSql, setGearHidden, storeItem, unequipItem } from "./db/inventory";
export { buyShopItem, getShop, sellItem, sellMaterial, type ShopView } from "./db/stall";
export { heroInitFor, publicHero } from "./db/heroes";
export { orderAtPub } from "./db/pub";
export { applyZoneGrant } from "./db/rewards";
export { createCrew, crewFor, getCrew, harborBoard, joinCrew, leaveCrew, refreshHarbor, type Crew } from "./db/crews";
export { buyPlot, fillBin, hasShack, homeOf, plotOf } from "./db/plots";
export { blueprintStatement, furnishingStatement, getHut, refreshHut, resourceStatements } from "./db/huts";
export { containerUsed, stashMaterial, stowGear, unstowGear } from "./db/containers";
export { atHome, buyFurniture, craftFurnishing, paidFurnishingStatement, sellFurniture, spendStatements, upgradeHut } from "./db/spending";
