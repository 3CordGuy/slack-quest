-- Weapons can be melee or ranged. Ranged weapons let back-row players use /sq attack;
-- melee weapons require front-row positioning. Existing rows are NULL — treated as
-- melee at read time so legacy drops keep their original behavior.

ALTER TABLE inventory   ADD COLUMN weapon_range TEXT;
ALTER TABLE shop_stock  ADD COLUMN weapon_range TEXT;
