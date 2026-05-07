// D1 query helpers. Raw prepared statements — no ORM.

export interface Character {
  slack_user_id: string;
  slack_team_id: string;
  name: string;
  class: string;
  level: number;
  xp: number;
  hp: number;
  max_hp: number;
  gold: number;
  scars: string[];
  downed_until: number | null;
  created_at: number;
  last_active: number;
}

interface CharacterRow extends Omit<Character, "scars"> {
  scars: string;
}

function rowToCharacter(row: CharacterRow): Character {
  return { ...row, scars: JSON.parse(row.scars) as string[] };
}

export async function getCharacter(db: D1Database, userId: string): Promise<Character | null> {
  const row = await db
    .prepare("SELECT * FROM characters WHERE slack_user_id = ?")
    .bind(userId)
    .first<CharacterRow>();
  return row ? rowToCharacter(row) : null;
}

export interface CreateCharacterInput {
  slack_user_id: string;
  slack_team_id: string;
  name: string;
  class: string;
  hp: number;
  max_hp: number;
}

export async function createCharacter(
  db: D1Database,
  input: CreateCharacterInput,
): Promise<Character> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO characters
       (slack_user_id, slack_team_id, name, class, level, xp, hp, max_hp, gold, scars, created_at, last_active)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?, 10, '[]', ?, ?)`,
    )
    .bind(
      input.slack_user_id,
      input.slack_team_id,
      input.name,
      input.class,
      input.hp,
      input.max_hp,
      now,
      now,
    )
    .run();
  const row = await getCharacter(db, input.slack_user_id);
  if (!row) throw new Error("Failed to read back created character");
  return row;
}

export interface SceneJson {
  monster_name: string;
  monster_hp: number;
  monster_max_hp: number;
  tier: number;
  scene: string;
}

export interface ActiveQuest {
  id: number;
  channel_id: string;
  thread_ts: string;
  elite: boolean;
  scene: SceneJson;
}

interface QuestRow {
  id: number;
  channel_id: string;
  thread_ts: string;
  elite: number;
  scene_json: string;
}

// Returns the active quest for a character, with scene data loaded.
export async function getActiveQuestForCharacter(
  db: D1Database,
  userId: string,
): Promise<ActiveQuest | null> {
  const row = await db
    .prepare(
      `SELECT q.id, q.thread_ts, q.channel_id, q.elite, q.scene_json
       FROM quests q
       JOIN quest_party qp ON qp.quest_id = q.id
       WHERE qp.character_id = ? AND q.status = 'active'
       LIMIT 1`,
    )
    .bind(userId)
    .first<QuestRow>();
  if (!row) return null;
  return {
    id: row.id,
    channel_id: row.channel_id,
    thread_ts: row.thread_ts,
    elite: row.elite === 1,
    scene: JSON.parse(row.scene_json) as SceneJson,
  };
}

export async function createQuest(
  db: D1Database,
  args: {
    channel_id: string;
    thread_ts: string;
    elite: boolean;
    scene: SceneJson;
    created_by: string;
  },
): Promise<number> {
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO quests (channel_id, thread_ts, status, elite, scene_json, created_by, created_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?)`,
    )
    .bind(
      args.channel_id,
      args.thread_ts,
      args.elite ? 1 : 0,
      JSON.stringify(args.scene),
      args.created_by,
      now,
    )
    .run();
  const questId = result.meta.last_row_id;
  await db
    .prepare("INSERT INTO quest_party (quest_id, character_id, joined_at) VALUES (?, ?, ?)")
    .bind(questId, args.created_by, now)
    .run();
  return questId;
}

export async function updateMonsterHp(
  db: D1Database,
  questId: number,
  scene: SceneJson,
  newHp: number,
): Promise<void> {
  const next = { ...scene, monster_hp: Math.max(0, newHp) };
  await db
    .prepare("UPDATE quests SET scene_json = ? WHERE id = ?")
    .bind(JSON.stringify(next), questId)
    .run();
}

export async function setCharacterHp(
  db: D1Database,
  userId: string,
  hp: number,
): Promise<void> {
  await db
    .prepare("UPDATE characters SET hp = ?, last_active = ? WHERE slack_user_id = ?")
    .bind(Math.max(0, hp), Date.now(), userId)
    .run();
}

export async function markQuestStatus(
  db: D1Database,
  questId: number,
  status: "completed" | "failed",
): Promise<void> {
  await db
    .prepare("UPDATE quests SET status = ?, completed_at = ? WHERE id = ?")
    .bind(status, Date.now(), questId)
    .run();
}

export async function appendLog(
  db: D1Database,
  questId: number,
  actor: string,
  action: string,
  outcome: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO quest_log (quest_id, actor, action, outcome, ts) VALUES (?, ?, ?, ?, ?)")
    .bind(questId, actor, action, outcome, Date.now())
    .run();
}

// Awards XP and gold; applies any level-ups and returns the deltas.
export async function awardSpoils(
  db: D1Database,
  character: Character,
  xp: number,
  gold: number,
  hpRollPerLevel: () => number,
  xpForLevel: (level: number) => number,
): Promise<{ levelsGained: number; newLevel: number; newMaxHp: number; newHp: number }> {
  let level = character.level;
  let maxHp = character.max_hp;
  const totalXp = character.xp + xp;
  let levelsGained = 0;
  while (totalXp >= xpForLevel(level + 1)) {
    level += 1;
    levelsGained += 1;
    maxHp += hpRollPerLevel();
  }
  const newHp = levelsGained > 0 ? maxHp : character.hp;
  await db
    .prepare(
      `UPDATE characters
       SET xp = ?, gold = gold + ?, level = ?, max_hp = ?, hp = ?, last_active = ?
       WHERE slack_user_id = ?`,
    )
    .bind(totalXp, gold, level, maxHp, newHp, Date.now(), character.slack_user_id)
    .run();
  return { levelsGained, newLevel: level, newMaxHp: maxHp, newHp };
}

// Soft death: 25% gold loss, 1 random item drop, downed timer, +1 scar.
// Returns what was lost so callers can narrate it.
export async function applySoftDeath(
  db: D1Database,
  character: Character,
  scar: string,
  cooldownMs: number,
): Promise<{ goldLost: number; itemLost: string | null }> {
  const goldLost = Math.floor(character.gold * 0.25);
  const remainingGold = character.gold - goldLost;
  const downedUntil = Date.now() + cooldownMs;
  const newScars = [...character.scars, scar];

  const itemRow = await db
    .prepare(
      `SELECT id, item_name FROM inventory
       WHERE character_id = ? ORDER BY RANDOM() LIMIT 1`,
    )
    .bind(character.slack_user_id)
    .first<{ id: number; item_name: string }>();

  if (itemRow) {
    await db.prepare("DELETE FROM inventory WHERE id = ?").bind(itemRow.id).run();
  }

  await db
    .prepare(
      `UPDATE characters
       SET hp = max_hp, gold = ?, scars = ?, downed_until = ?, last_active = ?
       WHERE slack_user_id = ?`,
    )
    .bind(remainingGold, JSON.stringify(newScars), downedUntil, Date.now(), character.slack_user_id)
    .run();

  return { goldLost, itemLost: itemRow?.item_name ?? null };
}

// Perma-death. quests.created_by uses ON DELETE SET NULL (see 0002 migration), so
// historical quests survive their creator. Inventory + quest_party cascade as expected.
export async function deleteCharacter(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM characters WHERE slack_user_id = ?").bind(userId).run();
}

// Find the most recent active quest in a channel (used by /dnd join).
export async function getActiveQuestInChannel(
  db: D1Database,
  channelId: string,
): Promise<ActiveQuest | null> {
  const row = await db
    .prepare(
      `SELECT id, channel_id, thread_ts, elite, scene_json
       FROM quests
       WHERE channel_id = ? AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(channelId)
    .first<QuestRow>();
  if (!row) return null;
  return {
    id: row.id,
    channel_id: row.channel_id,
    thread_ts: row.thread_ts,
    elite: row.elite === 1,
    scene: JSON.parse(row.scene_json) as SceneJson,
  };
}

// Returns true if the character was newly inserted; false if they were already a member.
export async function joinQuest(
  db: D1Database,
  questId: number,
  userId: string,
): Promise<boolean> {
  const existing = await db
    .prepare("SELECT 1 FROM quest_party WHERE quest_id = ? AND character_id = ?")
    .bind(questId, userId)
    .first();
  if (existing) return false;
  await db
    .prepare("INSERT INTO quest_party (quest_id, character_id, joined_at) VALUES (?, ?, ?)")
    .bind(questId, userId, Date.now())
    .run();
  return true;
}

export async function getQuestParty(
  db: D1Database,
  questId: number,
): Promise<Character[]> {
  const result = await db
    .prepare(
      `SELECT c.* FROM characters c
       JOIN quest_party qp ON qp.character_id = c.slack_user_id
       WHERE qp.quest_id = ?
       ORDER BY qp.joined_at ASC`,
    )
    .bind(questId)
    .all<CharacterRow>();
  return (result.results ?? []).map(rowToCharacter);
}

// A "fighter" is a party member who can still act: alive HP and not on a cooldown'd downed timer.
export function isFighter(c: Character): boolean {
  return c.hp > 0 && (!c.downed_until || c.downed_until <= Date.now());
}

// Returns ms remaining on the per-character action cooldown for this quest, or 0 if ready.
export async function cooldownRemaining(
  db: D1Database,
  questId: number,
  userId: string,
  cooldownMs: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT MAX(ts) AS last_ts FROM quest_log
       WHERE quest_id = ? AND actor = ? AND action IN ('attack', 'cast', 'flee')`,
    )
    .bind(questId, userId)
    .first<{ last_ts: number | null }>();
  const last = row?.last_ts ?? 0;
  const elapsed = Date.now() - last;
  return Math.max(0, cooldownMs - elapsed);
}

// Bumps monster HP by a multiplier of current max — used when a new player joins
// mid-quest to keep the encounter from being instantly trivialized.
export async function scaleMonsterForJoin(
  db: D1Database,
  questId: number,
  scene: SceneJson,
  ratio: number,
): Promise<SceneJson> {
  const bumpMax = Math.max(1, Math.floor(scene.monster_max_hp * ratio));
  const next: SceneJson = {
    ...scene,
    monster_hp: scene.monster_hp + bumpMax,
    monster_max_hp: scene.monster_max_hp + bumpMax,
  };
  await db
    .prepare("UPDATE quests SET scene_json = ? WHERE id = ?")
    .bind(JSON.stringify(next), questId)
    .run();
  return next;
}

export interface LeaderboardEntry {
  slack_user_id: string;
  name: string;
  class: string;
  level: number;
  xp: number;
  gold: number;
  scars_count: number;
}

export async function getLeaderboard(
  db: D1Database,
  limit: number,
): Promise<LeaderboardEntry[]> {
  const result = await db
    .prepare(
      `SELECT slack_user_id, name, class, level, xp, gold, scars
       FROM characters
       ORDER BY level DESC, xp DESC, gold DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ slack_user_id: string; name: string; class: string; level: number; xp: number; gold: number; scars: string }>();
  return (result.results ?? []).map((r) => ({
    slack_user_id: r.slack_user_id,
    name: r.name,
    class: r.class,
    level: r.level,
    xp: r.xp,
    gold: r.gold,
    scars_count: (JSON.parse(r.scars) as string[]).length,
  }));
}
