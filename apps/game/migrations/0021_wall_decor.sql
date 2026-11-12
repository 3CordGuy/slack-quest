-- Things hung on a hut's walls: a wall piece keeps its wall hex in q/r, the
-- side of that hex it hangs on in facing, how far along that side in x, and
-- how high above the floor (to its middle) here.
ALTER TABLE furnishings ADD COLUMN y REAL NOT NULL DEFAULT 0;
