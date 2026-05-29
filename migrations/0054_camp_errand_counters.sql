-- Cumulative counters for camp / smithy / errand achievements + the
-- "rested gather" bonus signal.
--
-- The achievement system needs lifetime counts that survive item churn
-- (inventory gets sold/used) and tier mix. The cheapest way to track
-- that without rewriting the gather/errand pipelines is a small set of
-- integer columns on `characters`. Per-row increments stay atomic and
-- writes happen at well-defined claim sites.

ALTER TABLE characters ADD COLUMN camp_ore_mined        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN camp_herbs_foraged    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN camp_fish_caught      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN camp_deep_claimed     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN smithy_crafts         INTEGER NOT NULL DEFAULT 0;

ALTER TABLE characters ADD COLUMN errands_completed     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN errands_courier       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN errands_procure       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN errands_investigate   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN errands_mercy         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN errands_long          INTEGER NOT NULL DEFAULT 0;

-- Drives the "rested gather" +50% bonus: when a claim's timestamp is more
-- than 24h after the previous claim, the next yield rolls with the
-- bonus. Null means "no claim yet" — first claim never triggers the
-- bonus (it's meant to reward returning players, not first-time use).
ALTER TABLE characters ADD COLUMN last_gather_claimed_at INTEGER;
