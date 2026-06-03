-- Persist gear-affix data on the rotating-stock tables so items bought from
-- the shop or smithy carry the same affixes / unique / set tag as monster
-- drops do. Without these columns, shop refreshes still surface ItemRolls
-- with affixes but the data dies at insert and the buyer ends up with a
-- bland legacy item. Mirrors the columns added to `inventory` in 0063.
--
-- tower_rest_stock lives in the quest scene JSON (no SQL table), so its
-- affix fields ride through the existing JSON column — no migration needed
-- for that surface; only the runtime LootOption shape changed.
ALTER TABLE shop_stock ADD COLUMN item_level INTEGER NULL;
ALTER TABLE shop_stock ADD COLUMN affixes TEXT NULL;
ALTER TABLE shop_stock ADD COLUMN unique_id TEXT NULL;
ALTER TABLE shop_stock ADD COLUMN set_id TEXT NULL;

ALTER TABLE smithy_stock ADD COLUMN item_level INTEGER NULL;
ALTER TABLE smithy_stock ADD COLUMN affixes TEXT NULL;
ALTER TABLE smithy_stock ADD COLUMN unique_id TEXT NULL;
ALTER TABLE smithy_stock ADD COLUMN set_id TEXT NULL;

-- Backfill item_level from power for legacy rows so price / level_req math
-- stays consistent with the inventory normalization in rowToItem.
UPDATE shop_stock   SET item_level = power WHERE item_level IS NULL;
UPDATE smithy_stock SET item_level = power WHERE item_level IS NULL;
