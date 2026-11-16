-- Worn gear can be hidden: it still counts (stats, armor, the weapon's power),
-- but it is not drawn on the hero. Cleared whenever the piece comes off, so
-- gear in the pack, a chest or a trade never carries it.
ALTER TABLE inventory ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
