-- Long rest cooldown — once per 24 hours, restores full HP. Short rest reuses the
-- existing last_rest_at column. Two independent timers so they don't share state.

ALTER TABLE characters ADD COLUMN last_long_rest_at INTEGER;
