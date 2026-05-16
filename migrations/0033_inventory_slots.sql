-- Phase 2: expand inventory from 2 equip slots to 8.
--
-- slot: which equipment slot this item occupies when equipped.
--   main_hand = weapon (backfilled here), body = armor (backfilled here),
--   off_hand / helmet / pants / boots / ring / amulet = new in Phase 2.
-- stat_bonus: JSON object, e.g. {"int_stat":2}. Summed into primary
--   stats before derivation when STATS_V2 is enabled.
-- item_subtype: free-form sub-classification. Currently only used for
--   'shield' (off_hand slot) so equip validation can distinguish
--   shields from future dual-wield weapons (Phase 5).
ALTER TABLE inventory ADD COLUMN slot TEXT;
ALTER TABLE inventory ADD COLUMN stat_bonus TEXT;
ALTER TABLE inventory ADD COLUMN item_subtype TEXT;

-- Backfill existing items into their natural slots.
UPDATE inventory SET slot = 'main_hand' WHERE item_type = 'weapon';
UPDATE inventory SET slot = 'body'      WHERE item_type = 'armor';

-- New slot-based equip lookup. Replaces the (character_id, item_type, equipped)
-- index for equipped queries once all items carry a slot value.
CREATE INDEX idx_inventory_slot ON inventory(character_id, slot, equipped);
