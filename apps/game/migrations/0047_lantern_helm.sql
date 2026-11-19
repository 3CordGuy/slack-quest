-- The Lighthouse Paladin's starter hat is their Lantern Helm (packages/world/src/gear.ts, starterGarb): drawn
-- with a lantern burning on top, and lighting the dark round whoever wears it (wearsLanternHelm). The hats
-- Paladins already have were saved as "Lighthouse Paladin Hat" with the knitted cap's icon: they are renamed and
-- given the helm's icon, which is what makes a hat one. A starter hat lying in a crew's town chest has no owner
-- to tell its class by, so it stays as it was.
UPDATE inventory
SET name = 'Lantern Helm',
    icon = 'lantern-helm'
WHERE ref = 'garb_hat'
  AND player_id IN (SELECT player_id FROM characters WHERE class_id = 'qa_paladin');
