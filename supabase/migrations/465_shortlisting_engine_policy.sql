-- 465_shortlisting_engine_policy.sql
-- ─────────────────────────────────────────────────────────────────────────
-- Singleton config row that holds the GLOBAL editorial policy the
-- shortlisting engine applies when no per-package recipe exists.
--
-- Replaces the dual concepts of:
--   - shortlisting_slot_definitions (the static slot lattice — kept for
--     backwards compatibility but no longer authoritative)
--   - shortlisting_slot_allocations (per-recipe overrides — never populated
--     in production, can be retired)
--
-- The engine resolves quotas from packages.products[].quantity at run time.
-- The editorial policy here governs HOW the engine distributes those
-- quotas: which rooms are "common" for AU residential listings, what
-- principles to apply when two compositions tie, what minimum signal
-- score should auto-reject candidates, etc.
--
-- The policy is read once per Stage 4 run via a shared helper
-- (engineEditorialPolicy.ts).  Callers without DB access fall back to the
-- DEFAULT_POLICY constant in that helper.
--
-- Single-row design: a CHECK constraint pins id=1 so the table is
-- effectively a key-value blob.  RLS allows master_admin RW + every
-- authenticated user RO.  Versions are kept inline as a jsonb history
-- array so we can roll back without a separate audit table.

BEGIN;

CREATE TABLE IF NOT EXISTS public.shortlisting_engine_policy (
  id              integer PRIMARY KEY CHECK (id = 1),
  policy          jsonb   NOT NULL,
  history         jsonb   NOT NULL DEFAULT '[]'::jsonb,
  updated_by      uuid    REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  notes           text
);

COMMENT ON TABLE  public.shortlisting_engine_policy IS
  'Singleton row (id=1) holding the global editorial policy applied by the shortlisting engine when no per-package recipe override exists.  Read by Stage 4 at run time via engineEditorialPolicy.ts.';
COMMENT ON COLUMN public.shortlisting_engine_policy.policy IS
  'JSONB blob with keys: editorial_principles (markdown text), tie_breaks (markdown text), quality_floor (number 0-10), common_residential_rooms (string[]), dusk_subjects (string[]), updated_at_principles (timestamp).  See engineEditorialPolicy.ts for the canonical schema + DEFAULT_POLICY constant.';
COMMENT ON COLUMN public.shortlisting_engine_policy.history IS
  'Append-only ring of prior policies (last 20 versions).  Used by the settings UI to restore-from-history.  Each entry: {policy, changed_by, changed_at, notes}.';

-- Seed the singleton row with the default policy so Stage 4 always reads
-- a non-null value.  ON CONFLICT DO NOTHING means this is idempotent on
-- re-apply (e.g. after the engineEditorialPolicy.ts DEFAULT_POLICY has
-- diverged — manual sync is intentional, not auto).
INSERT INTO public.shortlisting_engine_policy (id, policy, notes)
VALUES (
  1,
  '{
    "editorial_principles": "You are an expert Australian real-estate photo editor selecting the deliverable shortlist for an active sales listing.\n\nEditorial principles, ranked:\n  1. Property comprehension — a buyer must understand the layout and lifestyle from the shortlist alone. Coverage > completeness.\n  2. Strongest shot per room wins — never pick two of the same space_instance unless both add genuinely different value (e.g. wide + key detail, or AM vs PM lighting).\n  3. Hero rooms typical for AU listings — kitchen, master_bedroom, primary living, dining (if present), exterior_front, bathroom_main. Use editorial judgment when a property genuinely lacks one. If a hero room has NO viable candidate, say so via coverage_warnings — do NOT pad with a weaker substitute.\n  4. Dusk picks must showcase the facade, exterior architecture, pool/garden/landscape lighting, or street-side ambience. No dusk interiors unless explicitly compelling.\n  5. Reject heavy clutter, blown highlights, mis-aligned compositions UNLESS retouchable AND the room has no better angle in the round.",
    "tie_breaks": "When two candidates tie on overall quality:\n  1. signal_scores.composition × signal_scores.lighting (multiplicative)\n  2. social_first_friendly = true wins\n  3. Operator memory of past decisions on this project (project_memory_block above)\n  4. Signal score: appeal_signals length",
    "quality_floor": 5.5,
    "common_residential_rooms": [
      "kitchen", "master_bedroom", "open_plan_living", "living",
      "dining", "exterior_front", "bathroom_main"
    ],
    "dusk_subjects": [
      "exterior_facade", "facade", "pool_dusk", "garden_dusk",
      "streetscape_dusk", "exterior_rear", "balcony_dusk"
    ]
  }'::jsonb,
  'Initial seed — generated as part of mig 465.  Edit via /SettingsShortlistingCommandCenter?tab=recipes.'
)
ON CONFLICT (id) DO NOTHING;

-- ─── RLS ────────────────────────────────────────────────────────────────
-- master_admin RW; every authenticated user RO so Stage 4's edge function
-- (running as service_role anyway) and the settings UI both work.

ALTER TABLE public.shortlisting_engine_policy ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shortlisting_engine_policy_read
  ON public.shortlisting_engine_policy;
CREATE POLICY shortlisting_engine_policy_read
  ON public.shortlisting_engine_policy
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS shortlisting_engine_policy_master_admin_write
  ON public.shortlisting_engine_policy;
CREATE POLICY shortlisting_engine_policy_master_admin_write
  ON public.shortlisting_engine_policy
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'master_admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'master_admin'
    )
  );

-- ─── updated_at trigger ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_shortlisting_engine_policy_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shortlisting_engine_policy_updated_at
  ON public.shortlisting_engine_policy;
CREATE TRIGGER shortlisting_engine_policy_updated_at
  BEFORE UPDATE ON public.shortlisting_engine_policy
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_shortlisting_engine_policy_updated_at();

COMMIT;
