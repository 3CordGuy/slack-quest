-- Per-character slot for a hired pub mercenary. Stores the merc catalog id
-- (e.g. "sellsword") chosen at the pub. Cleared when the quest ends.
-- NULL = no merc hired.
ALTER TABLE characters ADD COLUMN hired_merc_id TEXT;
