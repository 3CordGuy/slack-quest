-- A bought plot is bare ground with a resource bin on it; the shack goes up
-- once the owner has filled the bin. `bin_json` holds what is in the bin, and
-- is NULL once the shack stands. Plots bought before bins keep their shacks.
ALTER TABLE huts ADD COLUMN bin_json TEXT;
