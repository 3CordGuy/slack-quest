-- Abandoning a quest gives back what it paid out. Loot is written to the
-- character as it is earned, so mark where it came from (the run's code) and
-- keep the character's progress from just before the first reward.

ALTER TABLE inventory  ADD COLUMN run_code TEXT;
ALTER TABLE furnishings ADD COLUMN run_code TEXT;
ALTER TABLE blueprints ADD COLUMN run_code TEXT;

ALTER TABLE run_players ADD COLUMN start_level INTEGER;
ALTER TABLE run_players ADD COLUMN start_xp INTEGER;
ALTER TABLE run_players ADD COLUMN start_str INTEGER;
ALTER TABLE run_players ADD COLUMN start_int INTEGER;
ALTER TABLE run_players ADD COLUMN start_vit INTEGER;
ALTER TABLE run_players ADD COLUMN start_agi INTEGER;
ALTER TABLE run_players ADD COLUMN start_dex INTEGER;
ALTER TABLE run_players ADD COLUMN start_unspent INTEGER;
