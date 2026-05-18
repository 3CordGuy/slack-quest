-- Elemental weapon affinity (fire | ice | lightning). NULL = no element.
-- Only rare+ non-focus weapons ever receive a value, assigned at drop time.
ALTER TABLE inventory ADD COLUMN element TEXT NULL;
