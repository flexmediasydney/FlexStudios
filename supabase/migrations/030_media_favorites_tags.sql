-- Media Favorites & Tags
-- Allows users to star/favorite individual media files or projects,
-- tag them with hashtag labels, and filter/sort in the favorites dashboard.

-- ─── media_favorites ────────────────────────────────────────────────
CREATE TABLE media_favorites (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Target: exactly one must be non-null
  file_path         TEXT,
  project_id        UUID REFERENCES projects(id) ON DELETE CASCADE,

  -- Denormalized metadata (avoids re-fetching Dropbox or joining projects)
  file_name         TEXT,
  file_type         TEXT,
  project_title     TEXT,
  property_address  TEXT,
  tonomo_base_path  TEXT,

  -- Tags: hashtag labels stored as array, GIN-indexed for fast filtering
  tags              TEXT[] DEFAULT '{}',

  -- Optional annotation
  note              TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_favorite_target CHECK (
    (file_path IS NOT NULL AND project_id IS NULL) OR
    (file_path IS NULL AND project_id IS NOT NULL)
  ),
  CONSTRAINT uq_user_file UNIQUE (user_id, file_path),
  CONSTRAINT uq_user_project UNIQUE (user_id, project_id)
);

CREATE INDEX idx_media_favorites_user ON media_favorites(user_id);
CREATE INDEX idx_media_favorites_project ON media_favorites(project_id);
CREATE INDEX idx_media_favorites_tags ON media_favorites USING GIN(tags);
CREATE INDEX idx_media_favorites_created ON media_favorites(created_at DESC);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON media_favorites
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── media_tags (autocomplete registry) ─────────────────────────────
CREATE TABLE media_tags (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL UNIQUE,
  color             TEXT DEFAULT '#3b82f6',
  usage_count       INTEGER DEFAULT 0,
  created_by_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_name   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_media_tags_name ON media_tags(name);
CREATE INDEX idx_media_tags_usage ON media_tags(usage_count DESC);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON media_tags
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── RLS ────────────────────────────────────────────────────────────
ALTER TABLE media_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_all" ON media_favorites FOR ALL
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "authenticated_all" ON media_tags FOR ALL
  USING (auth.uid() IS NOT NULL);

-- ─── Realtime ───────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE media_favorites;
ALTER PUBLICATION supabase_realtime ADD TABLE media_tags;
