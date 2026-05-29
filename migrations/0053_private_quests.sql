-- Private hunt support: when set, the quest is excluded from broadcast
-- discovery (`getActiveQuestInChannel`) so other players in the channel
-- don't get a "joinable quest" toast or Slack ping. Party members
-- (the starter + accepted invitees) still see the quest normally
-- via getActiveQuestForCharacter. Default 0 preserves existing behavior.
ALTER TABLE quests ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
