-- The Warden's Bell-Buoy Maul is a Ship's Anchor now, swung upside down (same weapon, same abilities). Saved
-- ones keep their rarity word and any smithy "+N"; only the base name inside each stored one changes.
UPDATE inventory
SET name = REPLACE(name, 'Bell-Buoy Maul', 'Ship''s Anchor')
WHERE kind = 'weapon' AND ref = 'maul' AND name LIKE '%Bell-Buoy Maul%';

-- The same for any kept in a crew's town chest (0042_town_chest.sql), which holds gear as `inventory` does.
UPDATE town_gear
SET name = REPLACE(name, 'Bell-Buoy Maul', 'Ship''s Anchor')
WHERE kind = 'weapon' AND ref = 'maul' AND name LIKE '%Bell-Buoy Maul%';
