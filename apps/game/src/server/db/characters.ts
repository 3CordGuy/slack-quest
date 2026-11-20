// Characters in D1: reading one, creating it (name, draft, confirm,
// re-roll), how it looks, and the abilities and stat points picked
// as it levels.

import type { StatKey, Stats } from "@gantt-quest/core";
import {
  DEFAULT_APPEARANCE,
  HAIR_COLORS,
  SKIN_TONES,
  abilitySlotError,
  heroClass,
  parseAbilityLoadout,
  parseAppearance,
  starterGarb,
  weaponItem,
  withAbilityInSlot,
  type AbilityPools,
  type Appearance,
} from "@gantt-quest/world";
import { LOOKS } from "../../client/render/looks";
import { kitStatements } from "../consumables";
import { onAZone } from "../zones";
import { insertItem, now, type CharacterRow } from "./rows";

const STAT_COLUMNS: StatKey[] = ["str", "int_stat", "vit", "agi", "dex"];

export async function getCharacter(db: D1Database, playerId: string): Promise<CharacterRow | null> {
  return db.prepare("SELECT * FROM characters WHERE player_id = ?").bind(playerId).first<CharacterRow>();
}

/** A hero name as typed, tidied (runs of spaces made one), or null when it is not 2 to 20 characters. */
export function cleanHeroName(raw: unknown): string | null {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim();
  return name.length >= 2 && name.length <= 20 ? name : null;
}

/**
 * Rename a confirmed hero. Refused (with the reason) when another player's hero already has the name, any case;
 * their own hero may change only its capitals.
 */
export async function renameCharacter(db: D1Database, playerId: string, name: string): Promise<string | null> {
  const taken = await db.prepare("SELECT 1 FROM characters WHERE name = ?1 COLLATE NOCASE AND player_id != ?2 LIMIT 1").bind(name, playerId).first();
  if (taken) return "Another hero already goes by that name.";
  const res = await db.prepare("UPDATE characters SET name = ? WHERE player_id = ? AND status = 'active'").bind(name, playerId).run();
  return res.meta.changes > 0 ? null : "No hero to rename.";
}

/** Create or overwrite the player's draft character with freshly rolled stats. */
export async function saveDraft(db: D1Database, playerId: string, name: string, classId: string, stats: Stats): Promise<void> {
  await db
    .prepare(
      `INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, created_at)
       VALUES (?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(player_id) DO UPDATE SET name = ?2, class_id = ?3, str = ?4, int_stat = ?5, vit = ?6, agi = ?7, dex = ?8
       WHERE characters.status = 'draft'`,
    )
    .bind(playerId, name, classId, stats.str, stats.int_stat, stats.vit, stats.agi, stats.dex, now())
    .run();
}

/** Lock in the draft and hand out the class's starting weapon. */
export async function confirmCharacter(db: D1Database, playerId: string): Promise<boolean> {
  const c = await getCharacter(db, playerId);
  if (!c || c.status !== "draft") return false;
  const cls = heroClass(c.class_id);
  if (!cls) return false;
  const weapon = weaponItem(cls.weapons[0]);
  // A hero who chose how they look starts in their class's clothes as items they can take off.
  const garb = parseAppearance(c.appearance ?? null) ? starterGarb(c.class_id) : [];
  await db.batch([
    db.prepare("UPDATE characters SET status = 'active' WHERE player_id = ?").bind(playerId),
    insertItem(db, playerId, weapon, true),
    ...garb.map((item) => insertItem(db, playerId, item, true)),
    // And the potions and flasks every hero starts out with.
    ...kitStatements(db, playerId),
  ]);
  return true;
}

/**
 * Set how a hero looks (draft or active). Every field is checked against its presets. False if there is no
 * hero. A hero already out in the world who has never had their starting clothes is given them too (see
 * dressInGarb); a draft gets them when it is confirmed.
 */
export async function saveAppearance(db: D1Database, playerId: string, raw: unknown): Promise<boolean> {
  const appearance = parseAppearance(raw);
  if (!appearance) return false;
  const row = await db
    .prepare("UPDATE characters SET appearance = ? WHERE player_id = ? RETURNING class_id, status")
    .bind(JSON.stringify(appearance), playerId)
    .first<{ class_id: string; status: string }>();
  if (!row) return false;
  if (row.status === "active") await dressInGarb(db, playerId, row.class_id);
  return true;
}

/**
 * The look a hero who never chose one is given: their class's own skin and hair (the nearest of the presets),
 * the usual everything else. They can change any of it from their hero sheet.
 */
export function classAppearance(classId: string): Appearance {
  const look = LOOKS[classId];
  const nearest = (hex: string | undefined, list: readonly string[]) => {
    if (!hex) return list[0];
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [r, g, b] = rgb(hex);
    let best = list[0];
    let gap = Infinity;
    for (const c of list) {
      const [cr, cg, cb] = rgb(c);
      const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
      if (d < gap) [best, gap] = [c, d];
    }
    return best;
  };
  return { ...DEFAULT_APPEARANCE, skin: nearest(look?.skin, SKIN_TONES), hair: nearest(look?.hair, HAIR_COLORS) };
}

/**
 * Give an active hero who has never chosen a look their class's (classAppearance), and their starting
 * clothes. Done once, the first time they are loaded after looks came in; true if it was done now.
 */
export async function ensureLook(db: D1Database, playerId: string): Promise<boolean> {
  const c = await db.prepare("SELECT class_id FROM characters WHERE player_id = ? AND status = 'active' AND appearance IS NULL").bind(playerId).first<{ class_id: string }>();
  if (!c) return false;
  const res = await db
    .prepare("UPDATE characters SET appearance = ? WHERE player_id = ? AND status = 'active' AND appearance IS NULL")
    .bind(JSON.stringify(classAppearance(c.class_id)), playerId)
    .run();
  if (!res.meta.changes) return false;
  await dressInGarb(db, playerId, c.class_id);
  return true;
}

/**
 * Starting clothes for a hero who was out in the world before there were any: each piece they do not
 * already have, put on in its slot if that slot is empty. A slot with armor in it gets nothing (so nothing
 * they wear is moved and their pack is not filled); they go bare there if they take the armor off.
 */
export async function dressInGarb(db: D1Database, playerId: string, classId: string): Promise<void> {
  const now = Date.now();
  await db.batch(
    starterGarb(classId).map((item) =>
      db
        .prepare(
          `INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, power, level_req, icon, stat_bonus_json, equipped, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11
           WHERE NOT EXISTS (SELECT 1 FROM inventory WHERE player_id = ?1 AND slot = ?6 AND equipped = 1)
             AND NOT EXISTS (SELECT 1 FROM inventory WHERE player_id = ?1 AND ref = ?3)`,
        )
        .bind(playerId, item.kind, item.ref, item.name, item.rarity, item.slot, item.power, item.levelReq, item.icon, JSON.stringify(item.statBonus), now),
    ),
  );
}

/** Re-roll: the character and everything it owns is discarded. */
export async function deleteCharacter(db: D1Database, playerId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM inventory WHERE player_id = ?").bind(playerId),
    db.prepare("DELETE FROM characters WHERE player_id = ?").bind(playerId),
  ]);
}

/**
 * Put a class ability in one of the hero's slots, or (`null`) empty it. Null on success, else why not.
 * Only in the Harbor: a hero out on a zone keeps the loadout they walked out with.
 */
export async function setAbilitySlot(db: D1Database, playerId: string, slot: number, abilityId: string | null, pools?: AbilityPools): Promise<string | null> {
  const c = await getCharacter(db, playerId);
  if (!c || c.status !== "active") return "No character.";
  const error = abilitySlotError(c.class_id, c.level, slot, abilityId, pools);
  if (error) return error;
  if (await onAZone(db, playerId)) return "Abilities can only be changed in the Harbor.";
  const next = JSON.stringify(withAbilityInSlot(parseAbilityLoadout(c.ability_loadout), slot, abilityId));
  // Only if the loadout is still what was read, so two quick clicks can't both land.
  const res = await db
    .prepare("UPDATE characters SET ability_loadout = ? WHERE player_id = ? AND status = 'active' AND ability_loadout = ?")
    .bind(next, playerId, c.ability_loadout)
    .run();
  return res.meta.changes > 0 ? null : "Try again.";
}

export async function spendPoint(db: D1Database, playerId: string, stat: string): Promise<boolean> {
  if (!STAT_COLUMNS.includes(stat as StatKey)) return false;
  // `stat` is checked against the fixed column list above before being inlined.
  const res = await db
    .prepare(`UPDATE characters SET ${stat} = ${stat} + 1, unspent_points = unspent_points - 1 WHERE player_id = ? AND status = 'active' AND unspent_points > 0`)
    .bind(playerId)
    .run();
  return res.meta.changes > 0;
}
