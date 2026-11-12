-- Class traits: one of two picked at level 2, another at level 4 (packages/world/src/traits.ts).
-- A JSON list of trait ids. Heroes already past those levels get their picks waiting.
ALTER TABLE characters ADD COLUMN traits TEXT NOT NULL DEFAULT '[]';
