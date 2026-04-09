-- 033_media_cache.sql
-- Server-side media cache for Dropbox file listings and thumbnails.
-- Eliminates repeat Dropbox API calls; page loads go from ~3s to ~100ms.

CREATE TABLE IF NOT EXISTS media_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key TEXT NOT NULL UNIQUE,       -- e.g. "listing::{share_url}" or "thumb::{file_path}"
  cache_type TEXT NOT NULL,              -- 'listing' or 'thumbnail'
  data JSONB,                            -- for listings: the full { folders, total_files } response
  blob_path TEXT,                        -- for thumbnails: Supabase Storage path
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_media_cache_key ON media_cache(cache_key);
CREATE INDEX idx_media_cache_project ON media_cache(project_id);
CREATE INDEX idx_media_cache_expires ON media_cache(expires_at);

CREATE TRIGGER set_media_cache_updated_at BEFORE UPDATE ON media_cache
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE media_cache ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read cache entries
CREATE POLICY "authenticated_read" ON media_cache FOR SELECT USING (auth.uid() IS NOT NULL);

-- Service role (edge functions) can insert/update/delete
CREATE POLICY "service_insert" ON media_cache FOR INSERT WITH CHECK (true);
CREATE POLICY "service_update" ON media_cache FOR UPDATE USING (true);
CREATE POLICY "service_delete" ON media_cache FOR DELETE USING (true);
