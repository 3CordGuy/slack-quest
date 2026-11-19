-- Starting clothes are drawn in the wearer's class look (since #526), but their icons were still the plain knitted
-- cap, navy tunic, greaves and deck boots. Each piece now has its class's own picture, "garb-tunic:staff_sage"
-- (packages/world/src/gear.ts, garbIcon), which new heroes are given from the start.
--
-- The pieces already made are named for their class when they were made ("Starchart Sage Tunic"), so the name
-- says which picture each gets, whoever holds it now or in whichever crew chest it lies. Until 2026-11-18 the
-- Paladin was the Tidewall Paladin and the Warden the Lighthouse Warden, and clothes made then keep those names.
-- Any piece in a hero's bag still left with a plain picture after that gets its holder's class. The Paladin's hat is
-- their Lantern Helm (0047, 0048) and is left as it is.

UPDATE inventory
SET icon = CASE name
  WHEN 'Stormcall Mage Hat' THEN 'garb-hat:devops_mage'
  WHEN 'Smuggler Rogue Hat' THEN 'garb-hat:refactor_rogue'
  WHEN 'Reef Druid Hat' THEN 'garb-hat:backend_druid'
  WHEN 'Shanty Bard Hat' THEN 'garb-hat:frontend_bard'
  WHEN 'Starchart Sage Hat' THEN 'garb-hat:staff_sage'
  WHEN 'Tidewall Warden Hat' THEN 'garb-hat:sre_warden'
  WHEN 'Wreck Warlock Hat' THEN 'garb-hat:data_warlock'
  WHEN 'Lighthouse Warden Hat' THEN 'garb-hat:sre_warden'
END
WHERE ref = 'garb_hat' AND name IN ('Stormcall Mage Hat', 'Smuggler Rogue Hat', 'Reef Druid Hat', 'Shanty Bard Hat', 'Starchart Sage Hat', 'Tidewall Warden Hat', 'Wreck Warlock Hat', 'Lighthouse Warden Hat');

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
  WHEN 'Tidewall Paladin Tunic' THEN 'garb-tunic:qa_paladin'
  WHEN 'Lighthouse Warden Tunic' THEN 'garb-tunic:sre_warden'
END
WHERE ref = 'garb_tunic' AND name IN ('Lighthouse Paladin Tunic', 'Stormcall Mage Tunic', 'Smuggler Rogue Tunic', 'Reef Druid Tunic', 'Shanty Bard Tunic', 'Starchart Sage Tunic', 'Tidewall Warden Tunic', 'Wreck Warlock Tunic', 'Tidewall Paladin Tunic', 'Lighthouse Warden Tunic');

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
  WHEN 'Tidewall Paladin Trousers' THEN 'garb-trousers:qa_paladin'
  WHEN 'Lighthouse Warden Trousers' THEN 'garb-trousers:sre_warden'
END
WHERE ref = 'garb_trousers' AND name IN ('Lighthouse Paladin Trousers', 'Stormcall Mage Trousers', 'Smuggler Rogue Trousers', 'Reef Druid Trousers', 'Shanty Bard Trousers', 'Starchart Sage Trousers', 'Tidewall Warden Trousers', 'Wreck Warlock Trousers', 'Tidewall Paladin Trousers', 'Lighthouse Warden Trousers');

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
  WHEN 'Tidewall Paladin Shoes' THEN 'garb-shoes:qa_paladin'
  WHEN 'Lighthouse Warden Shoes' THEN 'garb-shoes:sre_warden'
END
WHERE ref = 'garb_shoes' AND name IN ('Lighthouse Paladin Shoes', 'Stormcall Mage Shoes', 'Smuggler Rogue Shoes', 'Reef Druid Shoes', 'Shanty Bard Shoes', 'Starchart Sage Shoes', 'Tidewall Warden Shoes', 'Wreck Warlock Shoes', 'Tidewall Paladin Shoes', 'Lighthouse Warden Shoes');

UPDATE town_gear
SET icon = CASE name
  WHEN 'Stormcall Mage Hat' THEN 'garb-hat:devops_mage'
  WHEN 'Smuggler Rogue Hat' THEN 'garb-hat:refactor_rogue'
  WHEN 'Reef Druid Hat' THEN 'garb-hat:backend_druid'
  WHEN 'Shanty Bard Hat' THEN 'garb-hat:frontend_bard'
  WHEN 'Starchart Sage Hat' THEN 'garb-hat:staff_sage'
  WHEN 'Tidewall Warden Hat' THEN 'garb-hat:sre_warden'
  WHEN 'Wreck Warlock Hat' THEN 'garb-hat:data_warlock'
  WHEN 'Lighthouse Warden Hat' THEN 'garb-hat:sre_warden'
END
WHERE ref = 'garb_hat' AND name IN ('Stormcall Mage Hat', 'Smuggler Rogue Hat', 'Reef Druid Hat', 'Shanty Bard Hat', 'Starchart Sage Hat', 'Tidewall Warden Hat', 'Wreck Warlock Hat', 'Lighthouse Warden Hat');

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
  WHEN 'Tidewall Paladin Tunic' THEN 'garb-tunic:qa_paladin'
  WHEN 'Lighthouse Warden Tunic' THEN 'garb-tunic:sre_warden'
END
WHERE ref = 'garb_tunic' AND name IN ('Lighthouse Paladin Tunic', 'Stormcall Mage Tunic', 'Smuggler Rogue Tunic', 'Reef Druid Tunic', 'Shanty Bard Tunic', 'Starchart Sage Tunic', 'Tidewall Warden Tunic', 'Wreck Warlock Tunic', 'Tidewall Paladin Tunic', 'Lighthouse Warden Tunic');

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
  WHEN 'Tidewall Paladin Trousers' THEN 'garb-trousers:qa_paladin'
  WHEN 'Lighthouse Warden Trousers' THEN 'garb-trousers:sre_warden'
END
WHERE ref = 'garb_trousers' AND name IN ('Lighthouse Paladin Trousers', 'Stormcall Mage Trousers', 'Smuggler Rogue Trousers', 'Reef Druid Trousers', 'Shanty Bard Trousers', 'Starchart Sage Trousers', 'Tidewall Warden Trousers', 'Wreck Warlock Trousers', 'Tidewall Paladin Trousers', 'Lighthouse Warden Trousers');

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
  WHEN 'Tidewall Paladin Shoes' THEN 'garb-shoes:qa_paladin'
  WHEN 'Lighthouse Warden Shoes' THEN 'garb-shoes:sre_warden'
END
WHERE ref = 'garb_shoes' AND name IN ('Lighthouse Paladin Shoes', 'Stormcall Mage Shoes', 'Smuggler Rogue Shoes', 'Reef Druid Shoes', 'Shanty Bard Shoes', 'Starchart Sage Shoes', 'Tidewall Warden Shoes', 'Wreck Warlock Shoes', 'Tidewall Paladin Shoes', 'Lighthouse Warden Shoes');

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
