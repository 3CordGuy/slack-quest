-- Phase 2 follow-up: add slot and stat_bonus to shop_stock so rings,
-- amulets, boots, helmets, and pants survive the insert and reach inventory
-- on purchase. Previously only weapon_range was stored; the new columns
-- mirror the inventory table.
ALTER TABLE shop_stock ADD COLUMN slot TEXT;
ALTER TABLE shop_stock ADD COLUMN stat_bonus TEXT;
ALTER TABLE shop_stock ADD COLUMN item_subtype TEXT;
