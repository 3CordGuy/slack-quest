-- Shop stock is channel-scoped and regenerates every 6 hours. One row per offered item.
-- bought_by goes from NULL → character_id when someone purchases the item.

CREATE TABLE shop_stock (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  item_name    TEXT NOT NULL,
  item_type    TEXT NOT NULL,
  power        INTEGER NOT NULL,
  rarity       TEXT NOT NULL,
  flavor       TEXT,
  price        INTEGER NOT NULL,
  bought_by    TEXT REFERENCES characters(slack_user_id) ON DELETE SET NULL
);

CREATE INDEX idx_shop_channel_generated ON shop_stock(channel_id, generated_at);
