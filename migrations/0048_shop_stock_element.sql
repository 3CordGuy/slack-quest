-- Add element column to shop_stock so elemental weapons survive the roll → DB → buy chain.
ALTER TABLE shop_stock ADD COLUMN element TEXT;
