-- What a zone is for, and whose it is. `kind` is 'dev' for a map made in the dev toolbox and 'caves'
-- for a delve into the Haunted Caverns from the Harbor's cave mouth. A crew has one cave at a time:
-- going down finds the crew's cave that is still being fought through, or makes a new one.
-- `status` gains 'cleared' for a map with no enemy left on it.
ALTER TABLE zones ADD COLUMN kind TEXT NOT NULL DEFAULT 'dev';
ALTER TABLE zones ADD COLUMN crew_id TEXT;
CREATE INDEX zones_crew_kind ON zones (crew_id, kind, status);
