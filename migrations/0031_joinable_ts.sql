-- Store the Slack message ts of the "joinable quest" recruitment card
-- so it can be deleted when the quest is no longer joinable.
ALTER TABLE quests ADD COLUMN joinable_ts TEXT;
