-- Persist the final OutcomeSummary alongside the combat state row so a
-- reconnecting client (lost WS, refresh, network blip) can be replayed the
-- outcome it missed instead of hanging on "Resolving outcome…". NULL until
-- the combat reaches a terminal state; cleared with the parent row at quest
-- end (deleteWebCombatState).

ALTER TABLE web_combat_state ADD COLUMN outcome_json TEXT;
