-- The Paladin's Ballast Flail is a Chainshot Flail now, three small cannon balls on three chains (same weapon, same
-- abilities, same ref and icon). Saved ones keep their rarity word and any smithy "+N"; only the base name inside
-- each stored one changes.
UPDATE inventory
SET name = REPLACE(name, 'Ballast Flail', 'Chainshot Flail')
WHERE kind = 'weapon' AND ref = 'ballast_flail' AND name LIKE '%Ballast Flail%';

-- The same for any kept in a crew's town chest (0042_town_chest.sql), which holds gear as `inventory` does.
UPDATE town_gear
SET name = REPLACE(name, 'Ballast Flail', 'Chainshot Flail')
WHERE kind = 'weapon' AND ref = 'ballast_flail' AND name LIKE '%Ballast Flail%';
