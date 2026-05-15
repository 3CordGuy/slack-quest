-- Apothecary activity counters for achievement tracking.
ALTER TABLE characters ADD COLUMN apothecary_purchases INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN revives_given INTEGER NOT NULL DEFAULT 0;
