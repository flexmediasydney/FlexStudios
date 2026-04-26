-- Wave 6 P1 SHORTLIST: mig 284: shortlisting_jobs + shortlisting_events
--
-- Two infrastructure tables that mirror the drone module's drone_jobs +
-- drone_events (mig 225). Same dispatcher pattern, same dead-letter
-- behaviour, same append-only audit log shape.
--
-- shortlisting_jobs — worker queue
--   kinds:
--     ingest          → run after settling window expires; orchestrates Pass 0
--     extract         → EXIF + bracket-grouping subset (split for retry granularity)
--     pass0           → preview extraction + hard-reject cull
--     pass1           → classification (concurrent Sonnet calls)
--     pass2           → three-phase shortlisting decision
--     pass3           → coverage validation + retouch flag surfacing
--     render_preview  → 1024px preview JPEG (per group, on demand)
--   statuses:
--     pending → running → succeeded
--                       ↘ dead_letter (after attempt_count >= max_attempts)
--   debounce: a unique partial index on (project_id) WHERE status='pending'
--   AND kind='ingest' guarantees that 50 dropbox file events for one project
--   collapse to a single pending ingest job (the enqueue RPC ratchets
--   scheduled_for forward — never backward — see mig 288).
--
-- shortlisting_events — append-only domain audit log
--   Distinct from project_folder_events (file-system layer) and
--   composition_classifications (Pass 1 output). Tracks domain transitions:
--   round started, Pass 2 emitted N proposals, human locked round, etc.
--   SELECT + INSERT only; no UPDATE/DELETE policies.
--
-- RLS pattern follows mig 225: master_admin/admin/manager/employee full
-- access for jobs read/write (workers run as service_role and bypass RLS);
-- contractor scoped via my_project_ids() for events.

-- ============================================================================
-- 1. shortlisting_jobs
-- ============================================================================

CREATE TABLE IF NOT EXISTS shortlisting_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- round_id and group_id are NULLABLE: an ingest job pre-dates the round
  -- (the dispatcher creates the round when it picks up the ingest job), and
  -- some kinds (pass0/pass1) operate at round scope without a single group.
  round_id UUID REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  group_id UUID REFERENCES composition_groups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'ingest','extract','pass0','pass1','pass2','pass3','render_preview'
  )),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','running','succeeded','failed','dead_letter'
  )),
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  payload JSONB,
  result JSONB,
  error_message TEXT,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shortlisting_jobs_status
  ON shortlisting_jobs(status);
CREATE INDEX IF NOT EXISTS idx_shortlisting_jobs_pending_scheduled
  ON shortlisting_jobs(scheduled_for) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_shortlisting_jobs_project
  ON shortlisting_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_shortlisting_jobs_kind
  ON shortlisting_jobs(kind);

-- Debounce mechanism: at most one PENDING ingest job per project. Other
-- kinds (pass0/pass1/render_preview) are unconstrained — they have natural
-- keys (round_id, group_id) and don't need the same debounce. The enqueue
-- RPC (mig 288) restates this predicate inline for ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_shortlisting_jobs_pending_ingest_per_project
  ON shortlisting_jobs (project_id)
  WHERE status = 'pending' AND kind = 'ingest';

COMMENT ON TABLE shortlisting_jobs IS
  'Worker queue mirroring drone_jobs (mig 225). Kinds: ingest|extract|pass0|pass1|pass2|pass3|render_preview. Statuses: pending|running|succeeded|failed|dead_letter. Unique partial index uniq_shortlisting_jobs_pending_ingest_per_project debounces ingest enqueues per project. Spec §17.';
COMMENT ON COLUMN shortlisting_jobs.max_attempts IS
  'Soft cap; the dispatcher transitions to dead_letter after attempt_count >= max_attempts. Default 3 matches drone module.';

ALTER TABLE shortlisting_jobs ENABLE ROW LEVEL SECURITY;

-- Workers run as service_role and bypass RLS. Human read access for ops UI:
CREATE POLICY "shortlisting_jobs_read" ON shortlisting_jobs FOR SELECT
  USING (get_user_role() IN ('master_admin','admin','manager','employee'));
CREATE POLICY "shortlisting_jobs_insert" ON shortlisting_jobs FOR INSERT
  WITH CHECK (get_user_role() IN ('master_admin','admin','manager','employee'));
CREATE POLICY "shortlisting_jobs_update" ON shortlisting_jobs FOR UPDATE
  USING (get_user_role() IN ('master_admin','admin'));
CREATE POLICY "shortlisting_jobs_delete" ON shortlisting_jobs FOR DELETE
  USING (get_user_role() = 'master_admin');

-- ============================================================================
-- 2. shortlisting_events (append-only)
-- ============================================================================

CREATE TABLE IF NOT EXISTS shortlisting_events (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round_id UUID REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  group_id UUID REFERENCES composition_groups(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system','user','worker')),
  actor_id UUID,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shortlisting_events_project_time
  ON shortlisting_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shortlisting_events_round_time
  ON shortlisting_events(round_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shortlisting_events_event_type
  ON shortlisting_events(event_type);

COMMENT ON TABLE shortlisting_events IS
  'Append-only domain audit log. Mirrors drone_events (mig 225). Distinct from project_folder_events (file-system layer) and composition_classifications (Pass 1 output). Tracks domain transitions only: round started, Pass 2 emitted N proposals, human locked round, etc.';

ALTER TABLE shortlisting_events ENABLE ROW LEVEL SECURITY;

-- Append-only: SELECT + INSERT only. Service role bypasses for workers.
CREATE POLICY "shortlisting_events_read" ON shortlisting_events FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "shortlisting_events_insert" ON shortlisting_events FOR INSERT
  WITH CHECK (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );

NOTIFY pgrst, 'reload schema';
