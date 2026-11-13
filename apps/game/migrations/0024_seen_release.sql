-- The newest release (a game-v* tag) whose notes this player has read on the
-- Harbor's notice board. The board wears a "!" until it is the newest there
-- is. Null until they first read it.
ALTER TABLE players ADD COLUMN seen_release TEXT;
