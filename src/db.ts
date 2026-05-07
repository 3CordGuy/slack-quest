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

// Returns the active quest for a character, if any.
export async function getActiveQuestForCharacter(
  db: D1Database,
  userId: string,
): Promise<{ id: number; thread_ts: string; channel_id: string } | null> {
  return db
    .prepare(
      `SELECT q.id, q.thread_ts, q.channel_id
       FROM quests q
       JOIN quest_party qp ON qp.quest_id = q.id
       WHERE qp.character_id = ? AND q.status = 'active'
       LIMIT 1`,
    )
    .bind(userId)
    .first<{ id: number; thread_ts: string; channel_id: string }>();
}

export interface SceneJson {
  monster_name: string;
  monster_hp: number;
  monster_max_hp: number;
  tier: number;
  scene: string;
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
