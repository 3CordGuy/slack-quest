-- Fix historical inventory items where rarity is legendary/epic but power
-- was never set (defaulted to 0) or was generated before the power formula
-- existed. Only affects slots that should have non-zero power; pure-stat
-- accessories (boots, ring, amulet) legitimately have power=0 and are excluded.
--
-- Minimum floors match rollPower() at tier 1:
--   legendary weapon/armor: tb+11+1 = 12
--   epic    weapon/armor: tb+8+1  = 9
--   rare    weapon/armor: tb+5+1  = 6
--   uncommon weapon/armor: tb+3+1 = 4
--   common  weapon/armor: tb+1+1  = 2

UPDATE inventory
SET power = 12
WHERE rarity = 'legendary'
  AND power < 12
  AND (slot IN ('body','helmet','pants') OR item_type = 'weapon'
       OR (slot = 'off_hand' AND (item_subtype IS NULL OR item_subtype IN ('shield','gloves'))));

UPDATE inventory
SET power = 9
WHERE rarity = 'epic'
  AND power < 9
  AND (slot IN ('body','helmet','pants') OR item_type = 'weapon'
       OR (slot = 'off_hand' AND (item_subtype IS NULL OR item_subtype IN ('shield','gloves'))));

UPDATE inventory
SET power = 6
WHERE rarity = 'rare'
  AND power < 6
  AND (slot IN ('body','helmet','pants') OR item_type = 'weapon'
       OR (slot = 'off_hand' AND (item_subtype IS NULL OR item_subtype IN ('shield','gloves'))));

UPDATE inventory
SET power = 4
WHERE rarity = 'uncommon'
  AND power < 4
  AND (slot IN ('body','helmet','pants') OR item_type = 'weapon'
       OR (slot = 'off_hand' AND (item_subtype IS NULL OR item_subtype IN ('shield','gloves'))));

UPDATE inventory
SET power = 2
WHERE rarity = 'common'
  AND power < 2
  AND (slot IN ('body','helmet','pants') OR item_type = 'weapon'
       OR (slot = 'off_hand' AND (item_subtype IS NULL OR item_subtype IN ('shield','gloves'))));
