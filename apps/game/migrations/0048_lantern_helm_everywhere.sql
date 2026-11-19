-- The rest of the Lighthouse Paladin's old starter hats become the Lantern Helm (0047_lantern_helm.sql did those
-- a Paladin holds): one lying in a crew's town chest, or one a crewmate of another class took out of it. A starter
-- hat is named for its class when it is made (packages/world/src/gear.ts, starterGarb), so the name tells them apart.
UPDATE town_gear
SET name = 'Lantern Helm',
    icon = 'lantern-helm'
WHERE ref = 'garb_hat' AND name = 'Lighthouse Paladin Hat';

UPDATE inventory
SET name = 'Lantern Helm',
    icon = 'lantern-helm'
WHERE ref = 'garb_hat' AND name = 'Lighthouse Paladin Hat';
