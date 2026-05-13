-- Cross-surface coherence: which client surface is driving this quest?
-- 'slack' = original Slack-bot cooldown loop (default). 'web' = QuestRoom DO
-- via the React app. Set when start_web_combat creates the initial state;
-- the Slack combat handlers refuse actions on web-mode quests so the two
-- surfaces don't fight each other for the same scene_json.
ALTER TABLE quests ADD COLUMN mode TEXT NOT NULL DEFAULT 'slack';
