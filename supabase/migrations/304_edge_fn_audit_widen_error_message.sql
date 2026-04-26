-- Wave 11 S1 / Cluster A: edge_fn_call_audit.error_message documentation + substring index
-- Documents the rich error format introduced by callEdgeFn and adds GIN trigram
-- index for substring search across error messages.

COMMENT ON COLUMN edge_fn_call_audit.error_message IS
  'Wave 11 Cluster A: rich error message format "HTTP 4xx StatusText: <body fragment up to 500 chars>". Captures actual server error reason instead of bare "HTTP 4xx".';

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_edge_fn_audit_error_substring
  ON edge_fn_call_audit USING gin (error_message gin_trgm_ops)
  WHERE error_message IS NOT NULL;

NOTIFY pgrst, 'reload schema';
