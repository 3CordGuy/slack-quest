-- A finite pack: heroes carry as many unequipped items as their Strength
-- allows (see packages/world/src/carry.ts), and the rest wait in a storage
-- chest at home. `stored = 1` means the item is in that chest: never
-- equipped, not counted against the pack, and only taken out from inside
-- the owner's own hut. Numbered 0014 because 0013 belongs to the pub's
-- traveling salesmen.

ALTER TABLE inventory ADD COLUMN stored INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_inventory_carried ON inventory(player_id, equipped, stored);
