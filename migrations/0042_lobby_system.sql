-- Lobby system: quest_party tracks invite acceptance + readiness.
-- Quests gain a lobby phase (status = 'lobby') before going active.

ALTER TABLE quest_party ADD COLUMN invite_status TEXT NOT NULL DEFAULT 'accepted';
ALTER TABLE quest_party ADD COLUMN ready INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quests ADD COLUMN lobby_expires_at INTEGER;
-- ts of the lobby channel message so we can chat.update it on state changes
ALTER TABLE quests ADD COLUMN lobby_ts TEXT;
