-- Persistent crystal mana bonus, separate from the INT+level formula.
-- bumpMaxMana now increments this column instead of max_mana directly.
-- awardSpoils recalculates max_mana = deriveMaxMana + mana_bonus so
-- level-ups no longer erase crystal progress.
-- Default 0 — all existing characters start with no crystal bonus.

ALTER TABLE characters ADD COLUMN mana_bonus INTEGER NOT NULL DEFAULT 0;
