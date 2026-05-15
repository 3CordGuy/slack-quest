-- Per-character achievements, stored as JSON array of {id, unlocked_at} objects.
-- Consistent with scars/effects pattern. Ordered by unlock time descending at query time.
ALTER TABLE characters ADD COLUMN achievements TEXT NOT NULL DEFAULT '[]';
-- Pending toasts: IDs awarded since last web fetch; cleared on first read.
ALTER TABLE characters ADD COLUMN pending_achievements TEXT NOT NULL DEFAULT '[]';
