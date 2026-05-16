-- Add level requirement to all equippable items.
-- Formula: ceil(power / 3) -- power 1-3 → L1, 4-6 → L2, 7-9 → L3, etc.
-- Items with zero/null power (consumables, stat-only rings) keep the default of 1.
ALTER TABLE inventory ADD COLUMN level_req INTEGER NOT NULL DEFAULT 1;
UPDATE inventory SET level_req = MAX(1, CAST((power + 2) / 3 AS INTEGER)) WHERE power IS NOT NULL AND power > 0;
