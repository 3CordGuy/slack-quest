-- Track how many drinks a character has ordered since their last quest.
-- Increments on each successful purchase; reset to 0 when a quest starts or is joined.
ALTER TABLE characters ADD COLUMN drinks_since_last_quest INTEGER NOT NULL DEFAULT 0;
