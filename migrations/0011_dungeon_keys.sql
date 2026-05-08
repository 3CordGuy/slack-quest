-- Per-character tiered dungeon keys. Persist across quests.
ALTER TABLE characters ADD COLUMN keys_bronze INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN keys_silver INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN keys_gold INTEGER NOT NULL DEFAULT 0;
