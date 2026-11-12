-- Harbor projects: buildings a whole crew pays into together
-- (packages/world/src/projects.ts has the catalogue and the rules).
--
-- A contribution is one batch that takes from the giver and adds to the
-- project. The CHECK constraints below are what make that batch safe when
-- two crewmates give at once: a statement that would over-pay a cost, or
-- take more than the giver holds, fails, and D1 rolls the whole batch back.

-- One row per project a crew has started. built_at is set once, when every
-- cost is met, and never cleared.
CREATE TABLE crew_projects (
  crew_id    TEXT NOT NULL REFERENCES crews(id),
  project_id TEXT NOT NULL,
  built_at   INTEGER,
  PRIMARY KEY (crew_id, project_id)
);

-- What has been paid toward each cost of a project. `cap` is that cost's
-- full amount, written from the catalogue with every gift.
CREATE TABLE crew_project_paid (
  crew_id    TEXT NOT NULL REFERENCES crews(id),
  project_id TEXT NOT NULL,
  kind       TEXT NOT NULL,           -- gold | wood | stone | iron | copper | fur | bone
  qty        INTEGER NOT NULL DEFAULT 0,
  cap        INTEGER NOT NULL,
  PRIMARY KEY (crew_id, project_id, kind),
  CHECK (qty >= 0 AND qty <= cap)
);

-- Who gave what, one row per kind given. left_after is what the giver had
-- left of that kind; a gift they could not cover (or one to a project that
-- is already built, written as NULL) cannot be recorded, which stops the batch.
CREATE TABLE crew_project_gifts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  crew_id    TEXT NOT NULL REFERENCES crews(id),
  project_id TEXT NOT NULL,
  player_id  TEXT NOT NULL REFERENCES players(id),
  kind       TEXT NOT NULL,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  left_after INTEGER NOT NULL CHECK (left_after >= 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_crew_project_gifts_crew ON crew_project_gifts(crew_id, id);

-- The projects the crew had built when a ship was launched, as a JSON array
-- of project ids. Fixed at launch, so a voyage's doom clock can be replayed.
ALTER TABLE runs ADD COLUMN projects_json TEXT NOT NULL DEFAULT '[]';
