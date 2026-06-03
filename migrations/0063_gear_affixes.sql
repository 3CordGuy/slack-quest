-- Gear affix system (design doc: docs/gear-affixes-and-uniques.md).
--
-- Decouples item_level (the magnitude budget) from rarity (the affix slot
-- count) so a great-rolled rare can beat a mediocre epic. Adds a unique
-- effect line on legendaries and a set tag for archetype-themed bonuses.
--
--   item_level — power budget the affix tier roll is anchored to. Backfilled
--                from `power` for legacy rows since that's the v1 anchor
--                formula in deriveItemLevel().
--   affixes    — JSON array of RolledAffix records: [{id, tier, value, stat, label}].
--                Empty array for common items and legacy rows.
--   unique_id  — non-null only on legendary items whose drop rolled into the
--                UNIQUE_REGISTRY. Drives the unique-effect dispatcher in combat.
--   set_id     — non-null only on items tagged with SET_REGISTRY membership.
--                Drives 2/4-piece set bonus activation in the equip aggregator.
ALTER TABLE inventory ADD COLUMN item_level INTEGER NULL;
ALTER TABLE inventory ADD COLUMN affixes TEXT NULL;
ALTER TABLE inventory ADD COLUMN unique_id TEXT NULL;
ALTER TABLE inventory ADD COLUMN set_id TEXT NULL;

-- Backfill item_level for existing rows so legacy items still gate equip
-- correctly and price/tooltip math works without a special-case branch.
UPDATE inventory SET item_level = power WHERE item_level IS NULL;
