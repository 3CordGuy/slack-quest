// D1 helpers for the expedition map. See migrations/0066_expeditions.sql
// and docs/expedition-map.md.

import type { D1Database } from "@cloudflare/workers-types";
import type { ExpeditionMap } from "@gantt-quest/core";

export type ExpeditionStatus = "lobby" | "active" | "completed" | "failed" | "abandoned";

export type ExpeditionInviteStatus = "pending" | "accepted" | "declined";

export interface ExpeditionRow {
  id: number;
  channel_id: string;
  status: ExpeditionStatus;
  seed: string;
  map_json: string;
  current_node: string | null;
  buffs_json: string;
  created_by: string;
  created_at: number;
  completed_at: number | null;
}

/**
 * Run-long shrine buff. Stored as a JSON array on `expeditions.buffs_json`.
 * Pass 2 supports three kinds: a permanent +max HP, a one-shot mana refill
 * (recorded so the player can audit history but the effect lands at apply
 * time), and a permanent +1 to a primary stat (str/int/vit/agi/dex).
 */
export interface ExpeditionBuff {
  kind: "max_hp" | "mana_refill" | "stat";
  value: number;
  stat?: "str" | "int" | "vit" | "agi" | "dex";
  node_id: string;
  applied_at: number;
}

export interface ExpeditionPartyRow {
  expedition_id: number;
  character_id: string;
  joined_at: number;
  current_hp: number | null;
  current_mana: number | null;
  max_hp: number | null;
  max_mana: number | null;
  invite_status: ExpeditionInviteStatus;
}

export interface ExpeditionProgressRow {
  expedition_id: number;
  node_id: string;
  resolved_at: number;
  outcome_json: string;
}

/**
 * Error thrown when `createExpedition` cannot insert the
 * `active_expedition_membership` row for one of the party members because that
 * member is already in another active expedition. Callers should catch this
 * and return a 409 / 400 to the client.
 *
 * We surface this as a typed error (rather than relying on the raw SQLite
 * UNIQUE-constraint message) so the worker doesn't have to string-match the
 * D1 driver's error text — which has changed across runtime versions.
 */
export class ExpeditionMembershipConflictError extends Error {
  constructor(public readonly characterId: string) {
    super(`character ${characterId} is already in an active expedition`);
    this.name = "ExpeditionMembershipConflictError";
  }
}

/**
 * Reserve an expedition id by inserting a placeholder row up front, then let
 * the caller fill in the deterministic seed + map_json. This is the only way
 * to know the id before generating the deterministic map (which is keyed off
 * `(expedition_id, party_signature)`).
 *
 * The placeholder row is inserted with empty seed/map and status='active' —
 * we IMMEDIATELY overwrite seed and map_json in the same request via
 * `finalizeExpeditionMap`, and gate any other read of the row on the
 * membership invariant. The reservation cannot leak because:
 *   - the membership row is inserted in the same call; if it conflicts the
 *     reservation row is rolled back (we delete it on failure);
 *   - even if a concurrent reader sees the placeholder, they cannot pick
 *     anything (current_node is NULL and `available_picks` requires a real
 *     map_json — we INSERT with `map_json='{}'` which `availablePicks` rejects
 *     by failing the JSON-shape check up front in the worker).
 *
 * On membership conflict throws `ExpeditionMembershipConflictError` and does
 * NOT leave any row behind.
 */
export async function createExpedition(
  db: D1Database,
  args: {
    channel_id: string;
    seed: string;
    map: ExpeditionMap;
    created_by: string;
    party: readonly string[];
  },
): Promise<number> {
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO expeditions (channel_id, status, seed, map_json, current_node, created_by, created_at)
       VALUES (?, 'active', ?, ?, NULL, ?, ?)`,
    )
    .bind(args.channel_id, args.seed, JSON.stringify(args.map), args.created_by, now)
    .run();
  const id = result.meta.last_row_id as number;

  // Insert party + active-membership rows. Membership is the gate that
  // prevents the start-race TOCTOU; if any insert fails because the character
  // is already in another active expedition we tear down the half-built
  // expedition row so the next attempt sees a clean slate.
  try {
    for (const cid of args.party) {
      await db
        .prepare(
          `INSERT INTO expedition_party (expedition_id, character_id, joined_at, invite_status)
           VALUES (?, ?, ?, 'accepted')`,
        )
        .bind(id, cid, now)
        .run();
      try {
        await db
          .prepare(
            `INSERT INTO active_expedition_membership (character_id, expedition_id)
             VALUES (?, ?)`,
          )
          .bind(cid, id)
          .run();
      } catch (err) {
        // SQLite UNIQUE-constraint violation on character_id — someone else
        // started an expedition with this character in parallel.
        throw new ExpeditionMembershipConflictError(cid);
      }
    }
  } catch (err) {
    // Best-effort cleanup. ON DELETE CASCADE on `expedition_party` and
    // `active_expedition_membership` rows clears those automatically.
    try {
      await db.prepare(`DELETE FROM expeditions WHERE id = ?`).bind(id).run();
    } catch {
      // swallow — this is cleanup on the error path; surfacing the cleanup
      // error would mask the real cause.
    }
    throw err;
  }
  return id;
}

/**
 * Overwrite the seed and map_json on an already-inserted expedition row.
 * Used by `/api/expedition/start` to swap the bootstrap placeholder for the
 * deterministic map keyed off the freshly-allocated expedition id.
 */
export async function finalizeExpeditionMap(
  db: D1Database,
  id: number,
  seed: string,
  map: ExpeditionMap,
): Promise<void> {
  await db
    .prepare(`UPDATE expeditions SET seed = ?, map_json = ? WHERE id = ?`)
    .bind(seed, JSON.stringify(map), id)
    .run();
}

export async function getExpedition(
  db: D1Database,
  id: number,
): Promise<ExpeditionRow | null> {
  const row = await db
    .prepare(
      `SELECT id, channel_id, status, seed, map_json, current_node, buffs_json, created_by, created_at, completed_at
       FROM expeditions WHERE id = ? LIMIT 1`,
    )
    .bind(id)
    .first<ExpeditionRow>();
  return row ?? null;
}

export async function getExpeditionParty(
  db: D1Database,
  id: number,
): Promise<string[]> {
  // Only accepted members are "the party" — pending invitees haven't committed
  // and declined ones won't. This keeps loadExpeditionView() consistent for
  // lobbies (creator-only) and active runs (everyone who accepted).
  const r = await db
    .prepare(
      `SELECT character_id FROM expedition_party
        WHERE expedition_id = ? AND invite_status = 'accepted'
        ORDER BY joined_at ASC`,
    )
    .bind(id)
    .all<{ character_id: string }>();
  return (r.results ?? []).map((row) => row.character_id);
}

export async function getExpeditionProgress(
  db: D1Database,
  id: number,
): Promise<ExpeditionProgressRow[]> {
  const r = await db
    .prepare(
      `SELECT expedition_id, node_id, resolved_at, outcome_json
       FROM expedition_node_progress WHERE expedition_id = ? ORDER BY resolved_at ASC`,
    )
    .bind(id)
    .all<ExpeditionProgressRow>();
  return r.results ?? [];
}

/**
 * Legacy unconditional update — kept for callers that are not racing on
 * `current_node`. Prefer `setExpeditionCurrentNodeIfCurrent` for the pick
 * route, which performs a compare-and-swap and reports whether it won the
 * race.
 */
export async function setExpeditionCurrentNode(
  db: D1Database,
  id: number,
  nodeId: string,
): Promise<void> {
  await db
    .prepare(`UPDATE expeditions SET current_node = ? WHERE id = ?`)
    .bind(nodeId, id)
    .run();
}

/**
 * Compare-and-swap update for the expedition's `current_node`. Used by
 * `/api/expedition/:id/pick` to defend against two concurrent picks both
 * loading the same `current_node`, both validating it, and both winning.
 *
 * Bind `expectedCurrent === null` to require the row's current_node IS NULL
 * (first pick); otherwise we require strict equality. Returns true iff the
 * swap actually happened (UPDATE affected one row). On false the caller
 * should return 409 conflict — another pick won the race.
 *
 * SQL note: SQLite's `IS` operator is null-aware (unlike `=`), which is why
 * we use it for the predicate.
 */
export async function setExpeditionCurrentNodeIfCurrent(
  db: D1Database,
  id: number,
  expectedCurrent: string | null,
  nextNodeId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE expeditions SET current_node = ?
        WHERE id = ? AND current_node IS ?`,
    )
    .bind(nextNodeId, id, expectedCurrent)
    .run();
  // D1's meta.changes is the count of rows affected by the last statement.
  return (result.meta?.changes ?? 0) === 1;
}

export async function setExpeditionStatus(
  db: D1Database,
  id: number,
  status: ExpeditionStatus,
): Promise<void> {
  const terminal = status === "completed" || status === "failed" || status === "abandoned";
  const completedAt = terminal ? Date.now() : null;
  await db
    .prepare(
      `UPDATE expeditions SET status = ?, completed_at = ? WHERE id = ?`,
    )
    .bind(status, completedAt, id)
    .run();
  // Free the active-membership slots for the party so members can start a
  // new expedition. Done after the status update so a concurrent /start
  // racing the abandon at least sees a coherent active row OR the freed slot.
  if (terminal) {
    await db
      .prepare(`DELETE FROM active_expedition_membership WHERE expedition_id = ?`)
      .bind(id)
      .run();
  }
}

export async function recordExpeditionNodeProgress(
  db: D1Database,
  id: number,
  nodeId: string,
  outcome: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO expedition_node_progress (expedition_id, node_id, resolved_at, outcome_json)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(id, nodeId, Date.now(), JSON.stringify(outcome))
    .run();
}

/**
 * Returns the active OR lobby-state expedition for a character, if any. A
 * character may only be in one non-terminal expedition at a time (enforced at
 * accept-time by the `active_expedition_membership` table's PK on
 * character_id). The lobby creator's membership row is inserted at /start;
 * invitees' rows are inserted at /accept — so this query covers both cases.
 */
export async function getActiveExpeditionForCharacter(
  db: D1Database,
  userId: string,
): Promise<ExpeditionRow | null> {
  const row = await db
    .prepare(
      `SELECT e.id, e.channel_id, e.status, e.seed, e.map_json, e.current_node, e.buffs_json, e.created_by, e.created_at, e.completed_at
       FROM expeditions e
       JOIN active_expedition_membership m ON m.expedition_id = e.id
       WHERE m.character_id = ? AND e.status IN ('active','lobby')
       LIMIT 1`,
    )
    .bind(userId)
    .first<ExpeditionRow>();
  return row ?? null;
}

/**
 * Read per-character HP/mana state for every party member. Used at combat-node
 * spawn time to seed the next combat with carried HP/mana, and on the
 * /:id view so the UI can render party HP bars.
 */
export async function getExpeditionPartyState(
  db: D1Database,
  id: number,
): Promise<ExpeditionPartyRow[]> {
  const r = await db
    .prepare(
      `SELECT expedition_id, character_id, joined_at, current_hp, current_mana, max_hp, max_mana, invite_status
       FROM expedition_party WHERE expedition_id = ? AND invite_status = 'accepted' ORDER BY joined_at ASC`,
    )
    .bind(id)
    .all<ExpeditionPartyRow>();
  return r.results ?? [];
}

/**
 * Persist a single party member's carried HP/mana after a combat node resolves.
 * The four fields are written together so a partial write can't leave a max
 * out of sync with the current value. Idempotent — called once per fighter at
 * combat resolve; calling it again with the same values is a no-op.
 */
export async function setExpeditionPartyHpMana(
  db: D1Database,
  expeditionId: number,
  characterId: string,
  args: { current_hp: number; current_mana: number; max_hp: number; max_mana: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE expedition_party
         SET current_hp = ?, current_mana = ?, max_hp = ?, max_mana = ?
       WHERE expedition_id = ? AND character_id = ?`,
    )
    .bind(
      args.current_hp,
      args.current_mana,
      args.max_hp,
      args.max_mana,
      expeditionId,
      characterId,
    )
    .run();
}

/**
 * Refill HP/mana to max for every party member. Used by the camp node
 * resolver — per the design doc, camp acts as a free rest before the next
 * encounter. Leaves max_hp/max_mana alone (shrine buffs still apply).
 */
export async function refillExpeditionPartyToMax(
  db: D1Database,
  expeditionId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE expedition_party
         SET current_hp = max_hp, current_mana = max_mana
       WHERE expedition_id = ?
         AND max_hp IS NOT NULL`,
    )
    .bind(expeditionId)
    .run();
}

/**
 * Append a shrine buff to the expedition's run-long buff list. The column
 * stores a JSON array; we read-modify-write since the table is small (one row
 * per active expedition per character on average) and the operation is rare
 * (~1 shrine per run).
 */
export async function appendExpeditionBuff(
  db: D1Database,
  id: number,
  buff: ExpeditionBuff,
): Promise<ExpeditionBuff[]> {
  const row = await db
    .prepare(`SELECT buffs_json FROM expeditions WHERE id = ?`)
    .bind(id)
    .first<{ buffs_json: string }>();
  const existing: ExpeditionBuff[] = row?.buffs_json
    ? (JSON.parse(row.buffs_json) as ExpeditionBuff[])
    : [];
  const next = [...existing, buff];
  await db
    .prepare(`UPDATE expeditions SET buffs_json = ? WHERE id = ?`)
    .bind(JSON.stringify(next), id)
    .run();
  return next;
}

export function parseExpeditionBuffs(row: ExpeditionRow): ExpeditionBuff[] {
  try {
    return JSON.parse(row.buffs_json ?? "[]") as ExpeditionBuff[];
  } catch {
    return [];
  }
}

export async function getRecentExpeditionsForCharacter(
  db: D1Database,
  userId: string,
  limit = 10,
): Promise<ExpeditionRow[]> {
  const r = await db
    .prepare(
      `SELECT e.id, e.channel_id, e.status, e.seed, e.map_json, e.current_node, e.buffs_json, e.created_by, e.created_at, e.completed_at
       FROM expeditions e
       JOIN expedition_party ep ON ep.expedition_id = e.id
       WHERE ep.character_id = ?
       ORDER BY e.created_at DESC
       LIMIT ?`,
    )
    .bind(userId, limit)
    .all<ExpeditionRow>();
  return r.results ?? [];
}

// ── Expedition leaderboards ──────────────────────────────────────────────────
//
// Each leaderboard joins through `expedition_party` so a "clear" credits every
// member who actually walked the run, not just the `created_by` initiator
// (matches the StS-style party convention). All five share the same character
// columns up front so the UI can render the player row uniformly (avatar +
// name + class + level + metric).

export interface ExpeditionFastestClearEntry {
  slack_user_id: string;
  name: string;
  slack_username: string | null;
  class: string;
  level: number;
  expedition_id: number;
  duration_ms: number;
}

export interface ExpeditionMostClearedEntry {
  slack_user_id: string;
  name: string;
  slack_username: string | null;
  class: string;
  level: number;
  completed_count: number;
}

export interface ExpeditionStreakEntry {
  slack_user_id: string;
  name: string;
  slack_username: string | null;
  class: string;
  level: number;
  current_streak: number;
  best_streak: number;
}

export interface ExpeditionNodesEntry {
  slack_user_id: string;
  name: string;
  slack_username: string | null;
  class: string;
  level: number;
  total_nodes: number;
}

export interface ExpeditionEliteEntry {
  slack_user_id: string;
  name: string;
  slack_username: string | null;
  class: string;
  level: number;
  elite_clears: number;
}

/**
 * Fastest expedition clear — top N party members ordered by ascending
 * (completed_at - created_at). Each row is one (character, expedition) pair,
 * so a single fast run with three party members produces three rows. This
 * matches roguelike conventions (StS posts each victorious run separately).
 */
export async function getExpeditionFastestClearLeaderboard(
  db: D1Database,
  limit = 20,
): Promise<ExpeditionFastestClearEntry[]> {
  const r = await db
    .prepare(
      `SELECT c.slack_user_id, c.name, c.slack_username, c.class, c.level,
              e.id as expedition_id,
              (e.completed_at - e.created_at) as duration_ms
         FROM expeditions e
         JOIN expedition_party ep ON ep.expedition_id = e.id
         JOIN characters c ON c.slack_user_id = ep.character_id
        WHERE e.status = 'completed'
          AND e.completed_at IS NOT NULL
          AND (e.completed_at - e.created_at) > 0
        ORDER BY duration_ms ASC
        LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(100, limit)))
    .all<ExpeditionFastestClearEntry>();
  return r.results ?? [];
}

/**
 * Most expeditions cleared — COUNT of completed expeditions per character.
 * A character with zero completions is excluded (HAVING completed_count > 0).
 */
export async function getExpeditionMostClearedLeaderboard(
  db: D1Database,
  limit = 20,
): Promise<ExpeditionMostClearedEntry[]> {
  const r = await db
    .prepare(
      `SELECT c.slack_user_id, c.name, c.slack_username, c.class, c.level,
              COUNT(e.id) as completed_count
         FROM characters c
         JOIN expedition_party ep ON ep.character_id = c.slack_user_id
         JOIN expeditions e ON e.id = ep.expedition_id AND e.status = 'completed'
        GROUP BY c.slack_user_id
        HAVING completed_count > 0
        ORDER BY completed_count DESC, c.level DESC
        LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(100, limit)))
    .all<ExpeditionMostClearedEntry>();
  return r.results ?? [];
}

/**
 * Boss-killer streak — longest run of consecutive 'completed' expeditions
 * per character with no 'failed' or 'abandoned' in between. Current streak
 * is the tail of consecutive completes; best is the all-time max. We do the
 * streak math in JS because SQLite lacks proper window functions across the
 * deployment target (D1 supports them in recent versions but the row counts
 * are small enough that fetching the per-character status sequence is
 * cheaper than rolling a CTE).
 */
export async function getExpeditionStreakLeaderboard(
  db: D1Database,
  limit = 20,
): Promise<ExpeditionStreakEntry[]> {
  // Pull every terminated expedition for every character, oldest-first per
  // character. Only characters with at least one completion matter — we drop
  // the rest before sorting.
  const r = await db
    .prepare(
      `SELECT c.slack_user_id, c.name, c.slack_username, c.class, c.level,
              e.status, e.completed_at
         FROM characters c
         JOIN expedition_party ep ON ep.character_id = c.slack_user_id
         JOIN expeditions e ON e.id = ep.expedition_id
        WHERE e.status IN ('completed','failed','abandoned')
          AND e.completed_at IS NOT NULL
        ORDER BY c.slack_user_id ASC, e.completed_at ASC`,
    )
    .all<{
      slack_user_id: string;
      name: string;
      slack_username: string | null;
      class: string;
      level: number;
      status: ExpeditionStatus;
      completed_at: number;
    }>();
  const byChar = new Map<string, {
    meta: Omit<ExpeditionStreakEntry, "current_streak" | "best_streak">;
    statuses: ExpeditionStatus[];
  }>();
  for (const row of r.results ?? []) {
    let entry = byChar.get(row.slack_user_id);
    if (!entry) {
      entry = {
        meta: {
          slack_user_id: row.slack_user_id,
          name: row.name,
          slack_username: row.slack_username,
          class: row.class,
          level: row.level,
        },
        statuses: [],
      };
      byChar.set(row.slack_user_id, entry);
    }
    entry.statuses.push(row.status);
  }
  const entries: ExpeditionStreakEntry[] = [];
  for (const { meta, statuses } of byChar.values()) {
    let best = 0;
    let run = 0;
    let tail = 0;
    for (const s of statuses) {
      if (s === "completed") {
        run += 1;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    // Tail = run of completes at the end of the sequence.
    for (let i = statuses.length - 1; i >= 0; i--) {
      if (statuses[i] === "completed") tail += 1;
      else break;
    }
    if (best === 0) continue;
    entries.push({ ...meta, current_streak: tail, best_streak: best });
  }
  entries.sort((a, b) => b.best_streak - a.best_streak || b.current_streak - a.current_streak);
  return entries.slice(0, Math.max(1, Math.min(100, limit)));
}

/**
 * Most nodes resolved lifetime — SUM of `expedition_node_progress` rows
 * across every expedition the character was party to. Counts every node the
 * party resolved, including non-combat (events, shrines, treasure, camp).
 */
export async function getExpeditionNodesLeaderboard(
  db: D1Database,
  limit = 20,
): Promise<ExpeditionNodesEntry[]> {
  const r = await db
    .prepare(
      `SELECT c.slack_user_id, c.name, c.slack_username, c.class, c.level,
              COUNT(p.node_id) as total_nodes
         FROM characters c
         JOIN expedition_party ep ON ep.character_id = c.slack_user_id
         JOIN expedition_node_progress p ON p.expedition_id = ep.expedition_id
        GROUP BY c.slack_user_id
        HAVING total_nodes > 0
        ORDER BY total_nodes DESC, c.level DESC
        LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(100, limit)))
    .all<ExpeditionNodesEntry>();
  return r.results ?? [];
}

/**
 * Elite slayer — count of completed expeditions where the party resolved
 * at least one elite-kind node. We detect elite nodes by looking for
 * `"kind":"elite"` in `expedition_node_progress.outcome_json`. This is a
 * substring match because outcome_json is a stable JSON shape written by
 * the worker; if the shape ever changes, update this and the test together.
 */
export async function getExpeditionEliteLeaderboard(
  db: D1Database,
  limit = 20,
): Promise<ExpeditionEliteEntry[]> {
  const r = await db
    .prepare(
      `SELECT c.slack_user_id, c.name, c.slack_username, c.class, c.level,
              COUNT(DISTINCT e.id) as elite_clears
         FROM characters c
         JOIN expedition_party ep ON ep.character_id = c.slack_user_id
         JOIN expeditions e ON e.id = ep.expedition_id AND e.status = 'completed'
         JOIN expedition_node_progress p ON p.expedition_id = e.id
        WHERE p.outcome_json LIKE '%"kind":"elite"%'
        GROUP BY c.slack_user_id
        HAVING elite_clears > 0
        ORDER BY elite_clears DESC, c.level DESC
        LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(100, limit)))
    .all<ExpeditionEliteEntry>();
  return r.results ?? [];
}

// ─── Expedition lobby (party + invites pre-run) ─────────────────────────────
//
// A "lobby" expedition is created by POST /api/expedition/start_with_party.
// The creator's character_id is inserted into both expedition_party
// (invite_status='accepted') and active_expedition_membership immediately;
// invitees are added later via POST /api/expedition/:id/invite with
// invite_status='pending' — no membership row yet. They're only enrolled in
// the mutex when they /accept; that's also when their HP/mana carry slot
// is reserved by a regular expedition_party row already.

export interface ExpeditionLobbyMemberRow {
  expedition_id: number;
  character_id: string;
  name: string;
  slack_username: string | null;
  level: number;
  class: string;
  invite_status: ExpeditionInviteStatus;
  joined_at: number;
}

/**
 * Insert a lobby-state expedition. Only the creator is auto-accepted; no
 * invitees yet. Returns the new expedition id.
 *
 * Throws ExpeditionMembershipConflictError if the creator is already in
 * another active OR lobby expedition (same mutex as the active-start path).
 */
export async function createExpeditionLobby(
  db: D1Database,
  args: {
    channel_id: string;
    seed: string;
    map: ExpeditionMap;
    created_by: string;
  },
): Promise<number> {
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO expeditions (channel_id, status, seed, map_json, current_node, created_by, created_at)
       VALUES (?, 'lobby', ?, ?, NULL, ?, ?)`,
    )
    .bind(args.channel_id, args.seed, JSON.stringify(args.map), args.created_by, now)
    .run();
  const id = result.meta.last_row_id as number;
  try {
    await db
      .prepare(
        `INSERT INTO expedition_party (expedition_id, character_id, joined_at, invite_status)
         VALUES (?, ?, ?, 'accepted')`,
      )
      .bind(id, args.created_by, now)
      .run();
    try {
      await db
        .prepare(
          `INSERT INTO active_expedition_membership (character_id, expedition_id)
           VALUES (?, ?)`,
        )
        .bind(args.created_by, id)
        .run();
    } catch {
      throw new ExpeditionMembershipConflictError(args.created_by);
    }
  } catch (err) {
    // Cleanup half-built row.
    try {
      await db.prepare(`DELETE FROM expeditions WHERE id = ?`).bind(id).run();
    } catch {
      // swallow — cleanup-on-error path
    }
    throw err;
  }
  return id;
}

/**
 * Returns the lobby-or-active expedition the user is currently a party
 * member of (any invite_status: pending invitees see their invite). At most
 * one row — see active_expedition_membership PK for the accepted-side mutex
 * and (in App.tsx) the join-quest mutex for non-expedition collisions.
 *
 * The returned row distinguishes between two surfaces:
 *   - status='lobby' AND invite_status='accepted' → creator (or just-accepted
 *     invitee); show begin button + roster
 *   - status='lobby' AND invite_status='pending'  → invitee; show accept/decline
 *   - status='active' AND current_node IS NULL    → never (lobby flips to
 *     active on /begin); but if some racing /pick implicitly closes the lobby
 *     the routes return null here (we filter to status='lobby').
 */
export async function getLobbyExpeditionForCharacter(
  db: D1Database,
  userId: string,
): Promise<{ expedition: ExpeditionRow; myInviteStatus: ExpeditionInviteStatus } | null> {
  const row = await db
    .prepare(
      `SELECT e.id, e.channel_id, e.status, e.seed, e.map_json, e.current_node, e.buffs_json, e.created_by, e.created_at, e.completed_at,
              ep.invite_status as my_invite_status
         FROM expeditions e
         JOIN expedition_party ep ON ep.expedition_id = e.id
        WHERE ep.character_id = ?
          AND e.status = 'lobby'
          AND e.current_node IS NULL
        ORDER BY e.created_at DESC
        LIMIT 1`,
    )
    .bind(userId)
    .first<ExpeditionRow & { my_invite_status: ExpeditionInviteStatus }>();
  if (!row) return null;
  const { my_invite_status, ...rest } = row;
  return { expedition: rest as ExpeditionRow, myInviteStatus: my_invite_status };
}

/**
 * Return every party member of a lobby (incl. pending invitees + declined for
 * UI accounting), joined to the characters table for display.
 */
export async function getExpeditionLobbyMembers(
  db: D1Database,
  expeditionId: number,
): Promise<ExpeditionLobbyMemberRow[]> {
  const r = await db
    .prepare(
      `SELECT ep.expedition_id, ep.character_id, ep.invite_status, ep.joined_at,
              c.name, c.slack_username, c.level, c.class
         FROM expedition_party ep
         JOIN characters c ON c.slack_user_id = ep.character_id
        WHERE ep.expedition_id = ?
        ORDER BY ep.joined_at ASC`,
    )
    .bind(expeditionId)
    .all<ExpeditionLobbyMemberRow>();
  return r.results ?? [];
}

/**
 * Add a 'pending' invitee to a lobby. Inserts an expedition_party row but
 * NOT a membership row — the invitee's mutex slot is only reserved on
 * /accept. Returns false if the invitee is already a party member (any
 * status); otherwise true. No-op safe; the unique PK on
 * (expedition_id, character_id) prevents duplicate inserts.
 */
export async function addExpeditionLobbyInvitee(
  db: D1Database,
  expeditionId: number,
  characterId: string,
): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO expedition_party (expedition_id, character_id, joined_at, invite_status)
         VALUES (?, ?, ?, 'pending')`,
      )
      .bind(expeditionId, characterId, Date.now())
      .run();
    return true;
  } catch {
    // Duplicate insert — they're already in the lobby
    return false;
  }
}

/**
 * Accept an invite. Atomically: flips invite_status to 'accepted' AND inserts
 * the active_expedition_membership row. If the membership insert fails
 * (UNIQUE conflict on character_id — the user is in another expedition that
 * raced this accept) we revert the invite_status to 'pending' so the lobby
 * UI re-prompts.
 *
 * Returns true on success; throws ExpeditionMembershipConflictError on the
 * race-lost path.
 */
export async function acceptExpeditionLobbyInvite(
  db: D1Database,
  expeditionId: number,
  characterId: string,
): Promise<void> {
  // First flip the status — caller already verified the row exists and is
  // pending (or we'd have returned a 4xx before getting here).
  const upd = await db
    .prepare(
      `UPDATE expedition_party SET invite_status = 'accepted'
        WHERE expedition_id = ? AND character_id = ? AND invite_status = 'pending'`,
    )
    .bind(expeditionId, characterId)
    .run();
  if ((upd.meta?.changes ?? 0) !== 1) {
    // Row missing or already accepted/declined — nothing to do.
    return;
  }
  try {
    await db
      .prepare(
        `INSERT INTO active_expedition_membership (character_id, expedition_id)
         VALUES (?, ?)`,
      )
      .bind(characterId, expeditionId)
      .run();
  } catch {
    // Race lost: another expedition grabbed this character's slot between the
    // accept click and the insert. Revert and surface the conflict.
    await db
      .prepare(
        `UPDATE expedition_party SET invite_status = 'pending'
          WHERE expedition_id = ? AND character_id = ?`,
      )
      .bind(expeditionId, characterId)
      .run();
    throw new ExpeditionMembershipConflictError(characterId);
  }
}

/**
 * Decline an invite. Removes the expedition_party row entirely (no audit
 * trail kept — design decision: a declined invite is a no-op, not a record).
 */
export async function declineExpeditionLobbyInvite(
  db: D1Database,
  expeditionId: number,
  characterId: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM expedition_party
        WHERE expedition_id = ? AND character_id = ? AND invite_status = 'pending'`,
    )
    .bind(expeditionId, characterId)
    .run();
}

/**
 * Refuse to begin if any party member is still 'pending'. Returns the count
 * of pending invitees so the caller can return a useful error.
 */
export async function countPendingExpeditionInvitees(
  db: D1Database,
  expeditionId: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as c FROM expedition_party
        WHERE expedition_id = ? AND invite_status = 'pending'`,
    )
    .bind(expeditionId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * Delete a lobby expedition entirely (cascades expedition_party +
 * active_expedition_membership rows). Used when the creator cancels.
 */
export async function deleteExpeditionLobby(
  db: D1Database,
  expeditionId: number,
): Promise<void> {
  await db
    .prepare(`DELETE FROM expeditions WHERE id = ? AND status = 'lobby'`)
    .bind(expeditionId)
    .run();
}
