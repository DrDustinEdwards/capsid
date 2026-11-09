-- audit_log.client: the name the MCP client was shown by when it was granted ("Grok Bot"), for a write made through an
-- OAuth session, so a row says which AI acted and not only whose login it used. Null for every older row and for a write
-- no MCP client made. Additive: one nullable column, no row touched.
ALTER TABLE audit_log ADD COLUMN client TEXT;
