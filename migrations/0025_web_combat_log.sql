-- Persisted combat event log. The DO appends every broadcast event here so a
-- client navigating Back and back into CombatPage can replay scrollback.
-- Bounded to the most recent ~200 events at write time (capped in JS) — it's
-- a UI nicety, not an audit trail.

ALTER TABLE web_combat_state ADD COLUMN log_json TEXT NOT NULL DEFAULT '[]';
