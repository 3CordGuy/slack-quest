-- The Warden's signature weapon is a Boarding Pike now, not a Lamp Hook (the class is no longer about the
-- lighthouse). Saved ones are renamed: the weapon, its name and its icon.
UPDATE inventory
SET ref = 'boarding_pike',
    icon = 'boarding-pike',
    name = REPLACE(name, 'Lamp Hook', 'Boarding Pike')
WHERE kind = 'weapon' AND ref = 'lamp_hook';

-- The same for any kept in a crew's town chest (0042_town_chest.sql), which holds gear as `inventory` does.
UPDATE town_gear
SET ref = 'boarding_pike',
    icon = 'boarding-pike',
    name = REPLACE(name, 'Lamp Hook', 'Boarding Pike')
WHERE kind = 'weapon' AND ref = 'lamp_hook';
