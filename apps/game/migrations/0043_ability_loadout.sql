-- Class abilities: the abilities a hero has chosen from their class's pool for their three slots
-- (packages/world/src/classabilities.ts). A JSON list of three entries, each an ability id or null.
ALTER TABLE characters ADD COLUMN ability_loadout TEXT NOT NULL DEFAULT '[]';
