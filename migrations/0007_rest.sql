-- /sq rest cooldown tracking. Between-quest HP restore on a 10-minute cadence.
-- Nullable: a brand-new character has never rested.

ALTER TABLE characters ADD COLUMN last_rest_at INTEGER;
