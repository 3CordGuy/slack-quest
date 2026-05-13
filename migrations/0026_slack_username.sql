-- Capture the player's slack handle (e.g. `josh`) so web cards can render
-- "@josh" next to the in-game character name. Written by the slack worker on
-- every command/action; nullable for characters created before this column
-- existed.

ALTER TABLE characters ADD COLUMN slack_username TEXT;
