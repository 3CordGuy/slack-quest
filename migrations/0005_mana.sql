-- Mana for class signature abilities. Starts at 1/1; refills between quests + on
-- level-up; grows by +1 every 5 levels and via magic-type loot items.

ALTER TABLE characters ADD COLUMN mana     INTEGER NOT NULL DEFAULT 1;
ALTER TABLE characters ADD COLUMN max_mana INTEGER NOT NULL DEFAULT 1;
