-- A meal at the pub gives back one gathering outing, once a UTC day.
-- `meal_day` is the day that was last used on.
ALTER TABLE gathering ADD COLUMN meal_day TEXT;
