-- The galley, the last Harbor crew project: a larder the whole crew cooks
-- into. One row per crew and dish. When the crew's next ship sails the
-- crew's rows are deleted and what they held goes aboard. Each dish's cap
-- (packages/world/src/galley.ts) is checked by the batch that cooks it.
CREATE TABLE galley_larder (
  crew_id TEXT NOT NULL REFERENCES crews(id),
  dish_id TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  PRIMARY KEY (crew_id, dish_id)
);
