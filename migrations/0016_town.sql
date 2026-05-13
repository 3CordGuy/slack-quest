-- Town map + Pub. Per-channel hub space between quests.
--
-- town_state: one row per channel. JSON blob carries the AI-generated town
-- name, bartender + regulars (with their pre-baked multi-choice dialog trees),
-- and the daily special drink id. Refreshes on a daily cadence; the town
-- NAME refreshes weekly (separate timestamp inside state_json) so the place
-- feels persistent while the people/specials rotate.
--
-- npc_payloads_claimed: per-player tracking of which dialog-tree reward
-- branches a player has already cashed in today. Prevents re-walking a tree
-- to repeat-farm a payload. Keyed by (channel, user, npc); refresh_date
-- pinned to the day the tree was generated so a fresh tree resets claims.
--
-- drink_buff_json: single active drink buff on characters. One active at a
-- time — drinking a second drink replaces the first (no stacking). Buff
-- decrements on quest actions; pub time doesn't tick. Cleared at quest end.

CREATE TABLE town_state (
  channel_id TEXT PRIMARY KEY,
  refreshed_at INTEGER NOT NULL,
  state_json TEXT NOT NULL
);

CREATE TABLE npc_payloads_claimed (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  npc_id TEXT NOT NULL,
  refresh_date INTEGER NOT NULL,
  claimed_paths_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id, npc_id)
);

ALTER TABLE characters ADD COLUMN drink_buff_json TEXT;
