-- A run is a voyage to an island, or a delve into the Haunted Caverns behind
-- the Harbor. Every run before this was a voyage.
ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'voyage';
