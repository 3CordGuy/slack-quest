-- Trading becomes a table two players stand at. Each lays out their own side
-- (gear, gold, materials), each accepts what they see, and everything changes
-- hands when both have. The row keeps its shape: `give_json` is the side of
-- the player who opened the trade (`from_id`), `ask_json` the other's, and
-- now either may hold items.
--
--   from_ok, to_ok  whether each has accepted the table as it stands
--   rev             counts every change to either side. An acceptance names
--                   the rev it saw, and a change takes both acceptances back.

ALTER TABLE trades ADD COLUMN from_ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN to_ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;

-- Offers still open were made under the old rules (one side asks, the other accepts): let them lapse.
UPDATE trades SET status = 'expired', closed_at = created_at WHERE status = 'open';
