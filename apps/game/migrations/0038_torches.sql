-- Torches: a lit torch is what lets a hero see in the caves (packages/world/src/zone/light.ts). Every
-- hero now starts with two in the pack (STARTING_ITEMS); those already out in the world are given them
-- here, on top of whatever they carry.
INSERT INTO consumables (player_id, kind, qty)
SELECT player_id, 'torch', 2 FROM characters WHERE status = 'active'
ON CONFLICT(player_id, kind) DO NOTHING;
