-- My Camp: real-time gathering, camp upgrades, and crafting hooks.
--
-- The camp replaces the bottom "Outskirts" entry on the ward as the hub for
-- everything done outside town walls (hunt + gathering). Resources flow back
-- into the smithy (forge / reinforce) and apothecary (brew / concentrate).
--
-- gathering_tasks: one row per started gather. yield_json stays NULL until the
-- expires_at timestamp passes — at that point the next status/claim request
-- rolls and persists the yield (deterministic by task id, so even a parallel
-- writer lands the same result). claimed_at flips when the player collects.
--
-- camp_upgrades: per-character set of built upgrade keys. v1 only buildable
-- key is `worker_tent_1` (unlocks gather slot 2). Future upgrades reuse the
-- table without schema change.
--
-- inventory.potency_stacks: extends an apothecary concentrate count onto each
-- potion row (0..2). Powers the apothecary "Concentrate" action which boosts
-- existing potions instead of brewing new ones.
--
-- Resources (ores / herbs / fish) are stored in the existing inventory table
-- using a new item_type='resource' (enforced in code, not in the schema). The
-- existing qty column stacks them; addResource() upserts by (character_id,
-- item_name).
--
-- Sharpens cap raise (3 → 6) is enforced in code (worker.ts), not in the
-- schema. Slots 4-6 require ore inputs (Smithy Reinforce).

CREATE TABLE gathering_tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL REFERENCES characters(slack_user_id) ON DELETE CASCADE,
  node         TEXT NOT NULL,         -- 'mine' | 'forage' | 'fish'
  tier         TEXT NOT NULL,         -- 'quick' | 'standard' | 'deep'
  worker_slot  INTEGER NOT NULL,      -- 1 = main character, 2+ = worker tent
  started_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  yield_json   TEXT,                  -- rolled lazily once expires_at <= now
  claimed_at   INTEGER                -- null until collected
);
CREATE INDEX idx_gathering_tasks_active ON gathering_tasks(character_id, claimed_at);

CREATE TABLE camp_upgrades (
  character_id TEXT NOT NULL REFERENCES characters(slack_user_id) ON DELETE CASCADE,
  upgrade_key  TEXT NOT NULL,         -- v1: 'worker_tent_1'
  built_at     INTEGER NOT NULL,
  PRIMARY KEY (character_id, upgrade_key)
);

ALTER TABLE inventory ADD COLUMN potency_stacks INTEGER NOT NULL DEFAULT 0;
