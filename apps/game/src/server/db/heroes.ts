// A hero as others are shown them, read from D1: what the rooms and maps
// need to know to draw and fight one (heroInitFor), and the sheet a crewmate
// opens on a click (publicHero).

import { gearSheet, parseAbilityLoadout, parseAppearance, type HeroInit, type PublicHero } from "@gantt-quest/world";
import { getCharacter } from "./characters";
import { getInventory } from "./inventory";
import { rowToItem, statsOf } from "./rows";

/** What the rooms and maps need to know about a character: who they are, their stats and what they wear. */
export async function heroInitFor(db: D1Database, playerId: string): Promise<HeroInit | null> {
  // Both are read by the player's id, so they are asked for together.
  const [c, inventory] = await Promise.all([getCharacter(db, playerId), getInventory(db, playerId)]);
  if (!c || c.status !== "active") return null;
  const worn = inventory.filter((i) => i.equipped).map(rowToItem);
  const gear = gearSheet(c.class_id, worn);
  const appearance = parseAppearance(c.appearance ?? null);
  return {
    id: c.player_id,
    name: c.name,
    classId: c.class_id,
    level: c.level,
    xp: c.xp,
    unspent: c.unspent_points,
    base: statsOf(c),
    abilityLoadout: parseAbilityLoadout(c.ability_loadout),
    ...gear,
    // Their chosen look travels with what they wear, so they are drawn as themselves wherever they are drawn.
    outfit: appearance ? { ...gear.outfit, appearance } : gear.outfit,
  };
}

/**
 * A hero as their crewmates see them: the sheet that opens on clicking them.
 * Null unless the viewer is that hero or shares their crew. Only game facts
 * leave here.
 */
export async function publicHero(db: D1Database, viewerId: string, heroId: string): Promise<PublicHero | null> {
  if (viewerId !== heroId) {
    const known = await db
      .prepare("SELECT 1 AS ok FROM crew_members a JOIN crew_members b ON a.crew_id = b.crew_id WHERE a.player_id = ?1 AND b.player_id = ?2")
      .bind(viewerId, heroId)
      .first<{ ok: number }>();
    if (!known) return null;
  }
  const [hero, inventory] = await Promise.all([heroInitFor(db, heroId), getInventory(db, heroId)]);
  if (!hero) return null;
  return {
    id: hero.id,
    name: hero.name,
    classId: hero.classId,
    level: hero.level,
    xp: hero.xp,
    base: hero.base,
    bonus: hero.bonus,
    weaponPower: hero.weaponPower,
    armor: hero.armor,
    gear: inventory.filter((i) => i.equipped).map(rowToItem),
    appearance: hero.outfit?.appearance,
  };
}
