-- Lobby lock + recruitment lobby support.
-- `locked` blocks new invites (and prevents `/sq join` for joinable quests
-- that have a lobby). Default 0 keeps all existing quests behaving as
-- they did before this migration.
ALTER TABLE quests ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
