-- Re-scope smithy stock from per-character to per-channel, mirroring the
-- shop. Adds channel_id alongside the existing character_id (which is left
-- in place for historical rows and for the audit trail of who triggered
-- the restock). Reads now key on channel_id.
ALTER TABLE smithy_stock ADD COLUMN channel_id TEXT;
CREATE INDEX IF NOT EXISTS idx_smithy_stock_channel ON smithy_stock (channel_id, generated_at);
