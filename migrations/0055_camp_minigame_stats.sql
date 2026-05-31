-- Camp mini-game lifetime stats per character.
--   mine_rich_hits    : total rich-vein strikes in the mining mini-game.
--                       Drives the "Veins Struck" Harvest Hall leaderboard.
--   forage_rare_finds : total rare herbs revealed in the foraging grid game (phase 2).
--   fish_best_ms      : fastest bite reaction time in milliseconds for the fishing game
--                       (phase 2). Lower is better; 0 means no qualifying play yet.
ALTER TABLE characters ADD COLUMN mine_rich_hits    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN forage_rare_finds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN fish_best_ms      INTEGER NOT NULL DEFAULT 0;
