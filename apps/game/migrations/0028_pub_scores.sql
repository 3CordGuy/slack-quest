-- The pub's leaderboard: each player's results at the crew's game tables
-- (dice, Shoals, Cargo and Krakens, Turn the Tide), one row per crew, game and
-- player. Written in the same batch that pays a finished game's pot.

CREATE TABLE pub_scores (
  crew_id     TEXT NOT NULL,
  game        TEXT NOT NULL,              -- 'dice', 'shoals', 'crew' or 'tide'
  player_id   TEXT NOT NULL REFERENCES players(id),
  played      INTEGER NOT NULL DEFAULT 0, -- games sat through to the end (a forfeit counts)
  wins        INTEGER NOT NULL DEFAULT 0,
  gold_won    INTEGER NOT NULL DEFAULT 0, -- prizes taken, after the house's cut
  staked      INTEGER NOT NULL DEFAULT 0, -- antes paid
  streak      INTEGER NOT NULL DEFAULT 0, -- wins in a row, now
  best_streak INTEGER NOT NULL DEFAULT 0,
  best        INTEGER,                    -- Cargo and Krakens: the most cargo in one game
  PRIMARY KEY (crew_id, game, player_id)
);
