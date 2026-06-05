-- One-shot cleanup of orphaned web_combat_state rows.
--
-- Background: before the endQuestWithStatus funnel landed, several quest
-- completion paths (tower/exit, applyWebCombatOutcome's standard victory/
-- defeat, advanceTowerAfterCombat wipe + empty-queue) marked the quest
-- terminal via markQuestStatus but never called deleteWebCombatState.
-- The combat row lingered indefinitely; one such orphan (quest 1043) surfaced
-- as a stuck "active combat" UI that could not be cleared through normal flow.
--
-- This migration drops any web_combat_state row whose parent quest is no
-- longer active. New completions now go through endQuestWithStatus so the
-- problem won't reappear.
DELETE FROM web_combat_state
WHERE quest_id IN (
  SELECT id FROM quests WHERE status IN ('completed', 'failed')
);
