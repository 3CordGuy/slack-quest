-- Simple gender attribute on characters: "m" or "f", or NULL for legacy
-- characters rolled pre-feature. Used to keep AI flavor pronouns consistent
-- across narration calls and to anchor the per-character portrait so flux
-- doesn't swing between male and female interpretations across regenerations
-- of the same character. Picked at /sq roll time (50/50); no /sq command
-- exists to change it post-roll — re-roll to get a different one.
ALTER TABLE characters ADD COLUMN gender TEXT;
