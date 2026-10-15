-- THE SEARCH INDEX FEED READS DOCUMENTS BY CHANGE TIME (src/doc-index.ts). Every five
-- minutes the tick asks for documents changed since its (updated_at, id) watermark,
-- oldest first. Without this index that read walks the whole documents table each tick.
--
-- Schema only, additive: one index, no data change.

CREATE INDEX IF NOT EXISTS documents_updated ON documents(updated_at, id);
