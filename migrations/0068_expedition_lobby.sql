-- Expedition party lobby + invites (pre-run only).
--
-- Two changes:
--
-- 1) Add `invite_status` to expedition_party so a row can be 'pending'
--    (invited but not accepted), 'accepted' (in the party, mutex held), or
--    'declined' (kept briefly for audit; deleted on user action by the
--    /:id/decline route).
--
--    Default is 'accepted' so existing rows (from /api/expedition/start before
--    this PR shipped) back-fill correctly — they were all auto-joined and
--    have membership rows already.
--
-- 2) An index on (character_id, invite_status) to keep the
--    "is this character pending anywhere?" lookup cheap. The lobby endpoint
--    walks pending+accepted rows for the signed-in user; without the index
--    we'd table-scan the party table for every poll.
--
-- The `expeditions.status` column already permits arbitrary TEXT (no CHECK
-- constraint in 0066) so the new 'lobby' status value needs no schema change.
-- The mutex (active_expedition_membership) is still enforced by its PK on
-- character_id; lobby expeditions ONLY insert a membership row for the
-- creator. Invitees' membership rows are inserted at /accept time so the
-- "can't be in two expeditions" rule still holds without blocking other
-- expedition starts on a stale pending invite.

ALTER TABLE expedition_party
  ADD COLUMN invite_status TEXT NOT NULL DEFAULT 'accepted';

CREATE INDEX idx_expedition_party_char_invite
  ON expedition_party(character_id, invite_status);
