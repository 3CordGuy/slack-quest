-- Smithy carries a small rotating stock of armor pieces. One row per offered item.
-- Per-character (character_id = slack_user_id). Refreshes every 4 hours; bought_by
-- flips from NULL to the buyer's character_id when purchased.

CREATE TABLE smithy_stock (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  item_name    TEXT NOT NULL,
  item_type    TEXT NOT NULL,
  power        INTEGER NOT NULL,
  rarity       TEXT NOT NULL,
  flavor       TEXT,
  price        INTEGER NOT NULL,
  slot         TEXT,
  stat_bonus   TEXT,
  item_subtype TEXT,
  bought_by    TEXT REFERENCES characters(slack_user_id) ON DELETE SET NULL
);

CREATE INDEX idx_smithy_character_generated ON smithy_stock(character_id, generated_at);
