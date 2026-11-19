-- The Paladin's Breakwater Greatsword is a Breakwater Cutlass now, and the Rogue's Twin Gutting Knives are a pair
-- of dirks (same weapons, same abilities, same refs). Saved ones take the new pictures, and the greatsword its new
-- name; each keeps its rarity word and any smithy "+N".
UPDATE inventory
SET icon = 'cutlass',
    name = REPLACE(name, 'Breakwater Greatsword', 'Breakwater Cutlass')
WHERE kind = 'weapon' AND ref = 'greatsword';

UPDATE inventory SET icon = 'dirks' WHERE kind = 'weapon' AND ref = 'daggers';

-- The same for any kept in a crew's town chest (0042_town_chest.sql), which holds gear as `inventory` does.
UPDATE town_gear
SET icon = 'cutlass',
    name = REPLACE(name, 'Breakwater Greatsword', 'Breakwater Cutlass')
WHERE kind = 'weapon' AND ref = 'greatsword';

UPDATE town_gear SET icon = 'dirks' WHERE kind = 'weapon' AND ref = 'daggers';
