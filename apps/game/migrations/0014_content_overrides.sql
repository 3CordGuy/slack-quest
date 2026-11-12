-- Admin content overrides: names, palettes and pixel art changed without a
-- code change. Display only; the rules never read these. Each row replaces
-- the code default for one target until it is deleted (revert to default).

CREATE TABLE content_overrides (
  kind       TEXT NOT NULL,          -- name | palette | icon | sprite
  target     TEXT NOT NULL,          -- name: "<catalogue kind>:<id>"; palette/sprite: look kind; icon: icon name
  value_json TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES players(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, target)
);

-- Every change, for history and "restore this version". new_json is null for a revert.
CREATE TABLE content_override_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind     TEXT NOT NULL,
  target   TEXT NOT NULL,
  old_json TEXT,
  new_json TEXT,
  by       TEXT NOT NULL REFERENCES players(id),
  at       INTEGER NOT NULL
);
CREATE INDEX idx_content_override_log_target ON content_override_log(kind, target, id);

-- 'version' goes up on every change; clients cache the bundle by it.
CREATE TABLE content_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
INSERT INTO content_meta (k, v) VALUES ('version', '0');
