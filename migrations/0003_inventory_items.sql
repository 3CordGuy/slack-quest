-- Extend inventory rows with the fields a real loot economy needs.
-- Existing schema has only (id, character_id, item_name, qty, flavor) and is empty in
-- prod (nothing inserts to it today), so adding NOT NULL columns with defaults is safe.

ALTER TABLE inventory ADD COLUMN item_type TEXT NOT NULL DEFAULT 'consumable';
ALTER TABLE inventory ADD COLUMN power     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory ADD COLUMN rarity    TEXT NOT NULL DEFAULT 'common';
ALTER TABLE inventory ADD COLUMN equipped  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_inventory_equipped ON inventory(character_id, item_type, equipped);
