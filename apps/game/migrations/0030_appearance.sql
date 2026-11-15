-- How a hero looks, chosen at character creation (packages/world/src/appearance.ts):
-- body proportions, head and face, skin and hair. JSON; NULL for a hero who never
-- chose, who is drawn in their class's stock look.
ALTER TABLE characters ADD COLUMN appearance TEXT;
