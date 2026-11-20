// What every other module in db/ starts from: the Worker's bindings, a
// player, the character and inventory rows as D1 holds them, and the
// statements that put a new item into a pack.

import type { Stats } from "@gantt-quest/core";
import type { ItemDef, ItemKind, Rarity, Slot } from "@gantt-quest/world";
import type { HarborRoom } from "../harbor-room";
import type { HutRoom } from "../hut-room";
import type { PubRoom } from "../pub-room";
import type { ZoneRoom } from "../zone-room";

export interface Env {
  DB: D1Database;
  AI?: Ai;
  ASSETS: Fetcher;
  HARBOR_ROOM: DurableObjectNamespace<HarborRoom>;
  HUT_ROOM: DurableObjectNamespace<HutRoom>;
  PUB_ROOM: DurableObjectNamespace<PubRoom>;
  ZONE_ROOM: DurableObjectNamespace<ZoneRoom>;
  /** "mock" replaces Workers AI with a scripted stand-in. */
  AI_MODE?: string;
  /** Email Sending binding. Without it (and MAIL_FROM_ADDRESS) sign-in codes go to the log. */
  EMAIL?: SendEmail;
  MAIL_FROM_ADDRESS?: string;
  MAIL_FROM_NAME?: string;
  /** Secret: comma-separated emails allowed into the admin side. Unset means nobody is an admin. */
  ADMIN_EMAILS?: string;
  /** "dev" on local and staging: the client shows the dev toolbox and its seeding routes answer (dev.ts). Production leaves it out. */
  ENVIRONMENT?: string;
}

export interface Player {
  id: string;
  name: string;
  /** Null for a guest: the account exists only in this browser's cookie. */
  email: string | null;
}

export interface CharacterRow {
  player_id: string;
  /** Earned by filling the Catch Book. */
  title?: string | null;
  name: string;
  class_id: string;
  status: "draft" | "active";
  level: number;
  xp: number;
  str: number;
  int_stat: number;
  vit: number;
  agi: number;
  dex: number;
  unspent_points: number;
  gold: number;
  /** JSON list of the class abilities chosen for the hero's slots (parse with parseAbilityLoadout). */
  ability_loadout: string;
  /** JSON Appearance (appearance.ts), or null if they never chose one. */
  appearance?: string | null;
}

export interface InventoryRow {
  id: number;
  kind: ItemKind;
  ref: string;
  name: string;
  rarity: Rarity;
  slot: Slot;
  power: number;
  level_req: number;
  icon: string;
  stat_bonus_json: string;
  equipped: number;
  /** The container at home it is kept in, or null while it is worn or carried. */
  stored_in: number | null;
  /** Steps of work done at the smithy, already counted in `power`. */
  upgrades: number;
  /** 1 while worn but not drawn on the hero. */
  hidden: number;
}

export function rowToItem(row: InventoryRow): ItemDef {
  return {
    kind: row.kind,
    ref: row.ref,
    name: row.name,
    rarity: row.rarity,
    slot: row.slot,
    power: row.power,
    statBonus: JSON.parse(row.stat_bonus_json) as Partial<Stats>,
    levelReq: row.level_req,
    icon: row.icon,
    ...(row.upgrades ? { upgrades: row.upgrades } : {}),
    ...(row.hidden ? { hidden: true } : {}),
  };
}

export function insertItem(db: D1Database, playerId: string, item: ItemDef, equipped: boolean, storedIn: number | null = null): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, power, level_req, icon, stat_bonus_json, equipped, stored_in, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(playerId, item.kind, item.ref, item.name, item.rarity, item.slot, item.power, item.levelReq, item.icon, JSON.stringify(item.statBonus), equipped ? 1 : 0, storedIn, Date.now());
}

/**
 * A new unequipped item into the pack, but only if the statement before it
 * in the batch changed a row. Put the pack's room check in that statement
 * (see `buyShopItem`): this one does not look at the limit.
 */
export function paidItemStatement(db: D1Database, playerId: string, item: ItemDef): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, power, level_req, icon, stat_bonus_json, equipped, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ? WHERE changes() > 0",
    )
    .bind(playerId, item.kind, item.ref, item.name, item.rarity, item.slot, item.power, item.levelReq, item.icon, JSON.stringify(item.statBonus), Date.now());
}

export async function getItem(db: D1Database, playerId: string, itemId: number): Promise<InventoryRow | null> {
  return db.prepare("SELECT * FROM inventory WHERE id = ? AND player_id = ? AND stored_in IS NULL").bind(itemId, playerId).first<InventoryRow>();
}

export const now = () => Date.now();

export const statsOf = (c: CharacterRow): Stats => ({ str: c.str, int_stat: c.int_stat, vit: c.vit, agi: c.agi, dex: c.dex });
