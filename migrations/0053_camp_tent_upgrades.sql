-- Camp Build expansion: worker tents 2 & 3, per-tent perks.
--
-- Tent perks (Quickdry Frames / Big Haul / Keen Eye) modify gather duration,
-- yield count, and rare-roll thresholds respectively. We snapshot the active
-- modifiers onto each gathering_tasks row at start time so the lazy
-- yield-roll-on-read stays deterministic (the player can build a new perk
-- mid-task without retroactively rewriting in-flight task math).
--
-- modifiers_json shape: { duration_pct, yield_bonus, rare_bonus_pct }
--   duration_pct:    int >= 0, percent reduction off base tier duration (clamped 0..75)
--   yield_bonus:     int >= 0, added to primary resource qty at roll time
--   rare_bonus_pct:  int >= 0, percent points added to rare-roll thresholds
--
-- All three default to 0 when the column is NULL (legacy rows + tasks
-- started before any perk was built).

ALTER TABLE gathering_tasks ADD COLUMN modifiers_json TEXT;
