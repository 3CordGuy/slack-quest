-- Starting clothes are drawn in the wearer's class look (since #526), but their icons were still the plain knitted
-- cap, navy tunic, greaves and deck boots. Each piece now has its class's own picture, "garb-tunic:staff_sage"
-- (packages/world/src/gear.ts, garbIcon), which new heroes are given from the start.
--
-- First, the old names. Until 2026-11-18 (#494) the Paladin was the Tidewall Paladin and the Warden the Lighthouse
-- Warden, and clothes made then still carry those names: they take their class's name now. An old Paladin hat
-- becomes the Lantern Helm, as 0047 and 0048 made the rest of them.

UPDATE inventory
SET name = 'Lantern Helm',
    icon = 'lantern-helm'
WHERE ref = 'garb_hat' AND name = 'Tidewall Paladin Hat';

UPDATE inventory
SET name = 'Lighthouse Paladin' || substr(name, 17)
WHERE ref IN ('garb_hat', 'garb_tunic', 'garb_trousers', 'garb_shoes') AND name LIKE 'Tidewall Paladin %';

UPDATE inventory
SET name = 'Tidewall Warden' || substr(name, 18)
WHERE ref IN ('garb_hat', 'garb_tunic', 'garb_trousers', 'garb_shoes') AND name LIKE 'Lighthouse Warden %';

UPDATE town_gear
SET name = 'Lantern Helm',
    icon = 'lantern-helm'
WHERE ref = 'garb_hat' AND name = 'Tidewall Paladin Hat';

UPDATE town_gear
SET name = 'Lighthouse Paladin' || substr(name, 17)
WHERE ref IN ('garb_hat', 'garb_tunic', 'garb_trousers', 'garb_shoes') AND name LIKE 'Tidewall Paladin %';

UPDATE town_gear
SET name = 'Tidewall Warden' || substr(name, 18)
WHERE ref IN ('garb_hat', 'garb_tunic', 'garb_trousers', 'garb_shoes') AND name LIKE 'Lighthouse Warden %';

-- Then the pictures. Each piece is named for its class ("Starchart Sage Tunic"), so the name says which picture it
-- gets, whoever holds it now or in whichever crew chest it lies. The Paladin's hat is their Lantern Helm, and keeps
-- its icon.

UPDATE inventory
SET icon = CASE name
  WHEN 'Stormcall Mage Hat' THEN 'garb-hat:devops_mage'
  WHEN 'Smuggler Rogue Hat' THEN 'garb-hat:refactor_rogue'
  WHEN 'Reef Druid Hat' THEN 'garb-hat:backend_druid'
  WHEN 'Shanty Bard Hat' THEN 'garb-hat:frontend_bard'
  WHEN 'Starchart Sage Hat' THEN 'garb-hat:staff_sage'
  WHEN 'Tidewall Warden Hat' THEN 'garb-hat:sre_warden'
  WHEN 'Wreck Warlock Hat' THEN 'garb-hat:data_warlock'
END
WHERE ref = 'garb_hat' AND name IN ('Stormcall Mage Hat', 'Smuggler Rogue Hat', 'Reef Druid Hat', 'Shanty Bard Hat', 'Starchart Sage Hat', 'Tidewall Warden Hat', 'Wreck Warlock Hat');

UPDATE inventory
SET icon = CASE name
  WHEN 'Lighthouse Paladin Tunic' THEN 'garb-tunic:qa_paladin'
  WHEN 'Stormcall Mage Tunic' THEN 'garb-tunic:devops_mage'
  WHEN 'Smuggler Rogue Tunic' THEN 'garb-tunic:refactor_rogue'
  WHEN 'Reef Druid Tunic' THEN 'garb-tunic:backend_druid'
  WHEN 'Shanty Bard Tunic' THEN 'garb-tunic:frontend_bard'
  WHEN 'Starchart Sage Tunic' THEN 'garb-tunic:staff_sage'
  WHEN 'Tidewall Warden Tunic' THEN 'garb-tunic:sre_warden'
  WHEN 'Wreck Warlock Tunic' THEN 'garb-tunic:data_warlock'
END
WHERE ref = 'garb_tunic' AND name IN ('Lighthouse Paladin Tunic', 'Stormcall Mage Tunic', 'Smuggler Rogue Tunic', 'Reef Druid Tunic', 'Shanty Bard Tunic', 'Starchart Sage Tunic', 'Tidewall Warden Tunic', 'Wreck Warlock Tunic');

UPDATE inventory
SET icon = CASE name
  WHEN 'Lighthouse Paladin Trousers' THEN 'garb-trousers:qa_paladin'
  WHEN 'Stormcall Mage Trousers' THEN 'garb-trousers:devops_mage'
  WHEN 'Smuggler Rogue Trousers' THEN 'garb-trousers:refactor_rogue'
  WHEN 'Reef Druid Trousers' THEN 'garb-trousers:backend_druid'
  WHEN 'Shanty Bard Trousers' THEN 'garb-trousers:frontend_bard'
  WHEN 'Starchart Sage Trousers' THEN 'garb-trousers:staff_sage'
  WHEN 'Tidewall Warden Trousers' THEN 'garb-trousers:sre_warden'
  WHEN 'Wreck Warlock Trousers' THEN 'garb-trousers:data_warlock'
END
WHERE ref = 'garb_trousers' AND name IN ('Lighthouse Paladin Trousers', 'Stormcall Mage Trousers', 'Smuggler Rogue Trousers', 'Reef Druid Trousers', 'Shanty Bard Trousers', 'Starchart Sage Trousers', 'Tidewall Warden Trousers', 'Wreck Warlock Trousers');

UPDATE inventory
SET icon = CASE name
  WHEN 'Lighthouse Paladin Shoes' THEN 'garb-shoes:qa_paladin'
  WHEN 'Stormcall Mage Shoes' THEN 'garb-shoes:devops_mage'
  WHEN 'Smuggler Rogue Shoes' THEN 'garb-shoes:refactor_rogue'
  WHEN 'Reef Druid Shoes' THEN 'garb-shoes:backend_druid'
  WHEN 'Shanty Bard Shoes' THEN 'garb-shoes:frontend_bard'
  WHEN 'Starchart Sage Shoes' THEN 'garb-shoes:staff_sage'
  WHEN 'Tidewall Warden Shoes' THEN 'garb-shoes:sre_warden'
  WHEN 'Wreck Warlock Shoes' THEN 'garb-shoes:data_warlock'
END
WHERE ref = 'garb_shoes' AND name IN ('Lighthouse Paladin Shoes', 'Stormcall Mage Shoes', 'Smuggler Rogue Shoes', 'Reef Druid Shoes', 'Shanty Bard Shoes', 'Starchart Sage Shoes', 'Tidewall Warden Shoes', 'Wreck Warlock Shoes');

UPDATE town_gear
SET icon = CASE name
  WHEN 'Stormcall Mage Hat' THEN 'garb-hat:devops_mage'
  WHEN 'Smuggler Rogue Hat' THEN 'garb-hat:refactor_rogue'
  WHEN 'Reef Druid Hat' THEN 'garb-hat:backend_druid'
  WHEN 'Shanty Bard Hat' THEN 'garb-hat:frontend_bard'
  WHEN 'Starchart Sage Hat' THEN 'garb-hat:staff_sage'
  WHEN 'Tidewall Warden Hat' THEN 'garb-hat:sre_warden'
  WHEN 'Wreck Warlock Hat' THEN 'garb-hat:data_warlock'
END
WHERE ref = 'garb_hat' AND name IN ('Stormcall Mage Hat', 'Smuggler Rogue Hat', 'Reef Druid Hat', 'Shanty Bard Hat', 'Starchart Sage Hat', 'Tidewall Warden Hat', 'Wreck Warlock Hat');

UPDATE town_gear
SET icon = CASE name
  WHEN 'Lighthouse Paladin Tunic' THEN 'garb-tunic:qa_paladin'
  WHEN 'Stormcall Mage Tunic' THEN 'garb-tunic:devops_mage'
  WHEN 'Smuggler Rogue Tunic' THEN 'garb-tunic:refactor_rogue'
  WHEN 'Reef Druid Tunic' THEN 'garb-tunic:backend_druid'
  WHEN 'Shanty Bard Tunic' THEN 'garb-tunic:frontend_bard'
  WHEN 'Starchart Sage Tunic' THEN 'garb-tunic:staff_sage'
  WHEN 'Tidewall Warden Tunic' THEN 'garb-tunic:sre_warden'
  WHEN 'Wreck Warlock Tunic' THEN 'garb-tunic:data_warlock'
END
WHERE ref = 'garb_tunic' AND name IN ('Lighthouse Paladin Tunic', 'Stormcall Mage Tunic', 'Smuggler Rogue Tunic', 'Reef Druid Tunic', 'Shanty Bard Tunic', 'Starchart Sage Tunic', 'Tidewall Warden Tunic', 'Wreck Warlock Tunic');

UPDATE town_gear
SET icon = CASE name
  WHEN 'Lighthouse Paladin Trousers' THEN 'garb-trousers:qa_paladin'
  WHEN 'Stormcall Mage Trousers' THEN 'garb-trousers:devops_mage'
  WHEN 'Smuggler Rogue Trousers' THEN 'garb-trousers:refactor_rogue'
  WHEN 'Reef Druid Trousers' THEN 'garb-trousers:backend_druid'
  WHEN 'Shanty Bard Trousers' THEN 'garb-trousers:frontend_bard'
  WHEN 'Starchart Sage Trousers' THEN 'garb-trousers:staff_sage'
  WHEN 'Tidewall Warden Trousers' THEN 'garb-trousers:sre_warden'
  WHEN 'Wreck Warlock Trousers' THEN 'garb-trousers:data_warlock'
END
WHERE ref = 'garb_trousers' AND name IN ('Lighthouse Paladin Trousers', 'Stormcall Mage Trousers', 'Smuggler Rogue Trousers', 'Reef Druid Trousers', 'Shanty Bard Trousers', 'Starchart Sage Trousers', 'Tidewall Warden Trousers', 'Wreck Warlock Trousers');

UPDATE town_gear
SET icon = CASE name
  WHEN 'Lighthouse Paladin Shoes' THEN 'garb-shoes:qa_paladin'
  WHEN 'Stormcall Mage Shoes' THEN 'garb-shoes:devops_mage'
  WHEN 'Smuggler Rogue Shoes' THEN 'garb-shoes:refactor_rogue'
  WHEN 'Reef Druid Shoes' THEN 'garb-shoes:backend_druid'
  WHEN 'Shanty Bard Shoes' THEN 'garb-shoes:frontend_bard'
  WHEN 'Starchart Sage Shoes' THEN 'garb-shoes:staff_sage'
  WHEN 'Tidewall Warden Shoes' THEN 'garb-shoes:sre_warden'
  WHEN 'Wreck Warlock Shoes' THEN 'garb-shoes:data_warlock'
END
WHERE ref = 'garb_shoes' AND name IN ('Lighthouse Paladin Shoes', 'Stormcall Mage Shoes', 'Smuggler Rogue Shoes', 'Reef Druid Shoes', 'Shanty Bard Shoes', 'Starchart Sage Shoes', 'Tidewall Warden Shoes', 'Wreck Warlock Shoes');

-- Any piece in a hero's bag still left with a plain picture gets its holder's class.

UPDATE inventory
SET icon = 'garb-hat:' || (SELECT class_id FROM characters WHERE characters.player_id = inventory.player_id)
WHERE ref = 'garb_hat' AND icon = 'knit-cap'
  AND player_id IN (SELECT player_id FROM characters)
  AND player_id NOT IN (SELECT player_id FROM characters WHERE class_id = 'qa_paladin');

UPDATE inventory
SET icon = 'garb-tunic:' || (SELECT class_id FROM characters WHERE characters.player_id = inventory.player_id)
WHERE ref = 'garb_tunic' AND icon = 'naval-tunic'
  AND player_id IN (SELECT player_id FROM characters);

UPDATE inventory
SET icon = 'garb-trousers:' || (SELECT class_id FROM characters WHERE characters.player_id = inventory.player_id)
WHERE ref = 'garb_trousers' AND icon = 'armored-pants'
  AND player_id IN (SELECT player_id FROM characters);

UPDATE inventory
SET icon = 'garb-shoes:' || (SELECT class_id FROM characters WHERE characters.player_id = inventory.player_id)
WHERE ref = 'garb_shoes' AND icon = 'deck-boots'
  AND player_id IN (SELECT player_id FROM characters);
