# W7.7 — Dynamic Package/Product/Tier Architecture — Design Spec

**Status:** ⚙️ Ready to dispatch (after Joseph confirmation 2026-04-27).
**Backlog ref:** P1-6
**Wave plan ref:** W7.7 — package_shortlist_configs sidecar + tiers first-class table + slot FK refactor + manual-mode plumbing
**Dependencies:** W7.8 ✅ shipped (`products.engine_role`), W7.4/W7.5 ✅ shipped (foundation).
**Unblocks:** W7.9 (per-package expected_file_count_range — subsumed into this spec), W7.11 (frontend hardcoded array purge), W7.13 (manual mode), W8 (tier configs).

---

## Joseph's correction (2026-04-27)

My v1 draft had two architectural mistakes that he caught:

1. **Hardcoded counts.** I drafted `expected_file_count_min/target/max` columns with literal defaults (Gold=30/35/40 etc). Wrong — image counts must come from the price matrix dynamically: `target = sum(packages.products[].quantity for products with relevant engine_role); min = target − 3; max = target + 3.` No defaults to maintain.

2. **Tier as single dimension.** I drafted `package_shortlist_configs.active_tier_id` as if each package has one engine tier. Wrong — engine tier is the **intersection** of (package, package_tier_choice). E.g. Gold-Standard → Tier S; Gold-Premium → Tier P; Flex-* → Tier A. The project's tier choice (standard or premium) at booking time is a real captured field; today's schema doesn't capture it (gap to close in this wave).

Plus a third item:

3. **Manual-mode safeguard.** Project types that aren't shortlisting-relevant (anything where AI scoring doesn't make sense) should fall back to a manual swimlane: read Dropbox, drag to approved, lock-triggers-move. No Pass 0/1/2/3, no engine round. New flag `project_types.shortlisting_supported BOOLEAN`.

This spec replaces the v1 draft entirely.

## Architecture

### Section 1 — Engine tier as a first-class table

```sql
CREATE TABLE shortlisting_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_code TEXT UNIQUE NOT NULL,         -- 'S', 'P', 'A' (forward-compat 'AA' etc)
  display_name TEXT NOT NULL,              -- 'Standard', 'Premium', 'A-Grade'
  score_anchor NUMERIC NOT NULL,           -- 5, 8, 9.5
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  display_order INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Backfilled from existing `shortlisting_stream_b_anchors` rows (Tier S=5, Tier P=8, Tier A=9.5). Wave 8 will add a `shortlisting_tier_configs` versioned-weights table FK'd to this; that admin UI is W8 scope (per Joseph's Q6 punt).

### Section 2 — Package × tier_choice → engine_tier mapping

This is the core correction. Capture which engine tier the engine should target based on what the customer bought.

```sql
CREATE TABLE package_engine_tier_mapping (
  package_id UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  tier_choice TEXT NOT NULL CHECK (tier_choice IN ('standard', 'premium')),
  engine_tier_id UUID NOT NULL REFERENCES shortlisting_tiers(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (package_id, tier_choice)
);
```

**Seed data (Joseph confirmed — best-guess; he'll edit in admin UI as needed):**

| Package | Standard | Premium | Confirmed by Joseph? |
|---|---|---|---|
| Gold Package | **S** | **P** | ✅ explicit |
| Silver Package | S (guess) | P (guess) | ⚙️ guess; editable |
| Flex Package | **A** | **A** | ✅ explicit |
| AI Package | S (guess) | S (guess) | ⚙️ guess (AI is the cheap path) |
| Day Video Package | S (guess) | P (guess) | ⚙️ guess |
| Dusk Video Package | P (guess) | A (guess) | ⚙️ guess (Dusk is high-end) |

Admin UI for this table lands in W7.7 (not W8). Master_admin can edit any cell at any time.

### Section 3 — Engine tier resolution (handles bundled, à la carte, and mixed)

Three real project shapes exist in production:

| Shape | What's set | Tier source |
|---|---|---|
| **Bundled** | `projects.packages[].products[]` populated | `packages[?].tier_choice` (new — see below) → `package_engine_tier_mapping` |
| **À la carte** | `projects.products[]` populated, `packages[]` empty | `projects.pricing_tier` directly (Joseph confirmed 2026-04-27) |
| **Mixed** | Both populated | Package wins for tier; à la carte products inherit |

(The 16 production à la carte projects today are real customers; the architecture must serve them.)

**Bundled path — capture tier_choice in JSONB:**

`projects.packages` JSONB array gains a `tier_choice` field per entry:
```jsonc
[
  {
    "package_id": "...",
    "tier_choice": "standard",   // ← NEW: 'standard' | 'premium' (no DDL)
    "products": [...],
    "quantity": 1
  }
]
```

Backfill rule: every existing entry gets `tier_choice: 'standard'` (no production rounds yet, safe).

**À la carte path — `projects.pricing_tier` (existing TEXT column):**

```
pricing_tier='premium' → engine Tier P
pricing_tier='standard' → engine Tier S
pricing_tier=null → engine Tier S (default, Joseph confirmed)
```

`projects.products[].tier_hint` is metadata only — preserved in audit JSON for traceability but the engine ignores it. Single-tier-per-round is the design (one shoot, one shortlist, one quality bar).

**Round bootstrap stores the resolved tier directly:**

```sql
ALTER TABLE shortlisting_rounds
  ADD COLUMN engine_tier_id UUID REFERENCES shortlisting_tiers(id);
```

Resolved at ingest via this priority chain:

```typescript
function resolveEngineTier(project, packageEngineTierMapping, tiersTable): UUID {
  // 1. Bundled: first package entry's tier_choice → package_engine_tier_mapping
  const firstPkg = project.packages?.[0];
  if (firstPkg?.package_id) {
    const tierChoice = firstPkg.tier_choice 
      || project.pricing_tier 
      || 'standard';
    const mapped = packageEngineTierMapping.find(
      m => m.package_id === firstPkg.package_id && m.tier_choice === tierChoice
    );
    if (mapped) return mapped.engine_tier_id;
  }
  // 2. À la carte: project.pricing_tier directly
  const projectTier = project.pricing_tier === 'premium' ? 'P' : 'S';
  return tiersTable.find(t => t.tier_code === projectTier)!.id;
}
```

Pass 2 reads `round.engine_tier_id` directly; no re-resolution per inference.

### Section 4 — Dynamic file count resolver (operates on union of bundled + à la carte)

Drop ALL `expected_file_count_*` columns. Replace with two runtime helpers:

```typescript
// supabase/functions/_shared/packageCounts.ts (new)

export interface FlatProductEntry {
  product_id: string;
  quantity: number;
  tier_hint: string | null;  // metadata only; engine ignores
}

export interface ProductCatalogEntry {
  id: string;
  category: string | null;
  engine_role: string | null;
}

/**
 * Flatten a project's products from BOTH paths into a single list.
 *
 * - Bundled path: projects.packages[].products[] (each package entry's
 *   tier_choice is propagated as the per-product tier_hint)
 * - À la carte path: projects.products[] (top-level, tier_hint may be set
 *   per-row but the engine ignores it; project.pricing_tier is the canonical
 *   tier source)
 * - Mixed: both arrays unioned. Joseph confirmed 2026-04-27: à la carte
 *   products are ADDITIVE to bundled products (they're addons; not
 *   replacements). e.g. Day Video Package (20 Sales Images) + à la carte
 *   5 Sales Images → target = 25 photos.
 */
export function flattenProjectProducts(project: {
  packages?: Array<{ package_id?: string; tier_choice?: string; products?: FlatProductEntry[] }> | null;
  products?: FlatProductEntry[] | null;
}): FlatProductEntry[] {
  const fromBundled = (project.packages || []).flatMap(pkg =>
    (pkg.products || []).map(p => ({
      product_id: p.product_id,
      quantity: p.quantity,
      tier_hint: pkg.tier_choice || null,
    }))
  );
  const fromAlaCarte = (project.products || []).map(p => ({
    product_id: p.product_id,
    quantity: p.quantity,
    tier_hint: p.tier_hint || null,
  }));
  return [...fromBundled, ...fromAlaCarte];
}

/**
 * Compute target file count for a round.
 * 
 * Source of truth: the union of bundled + à la carte products, filtered
 * by engine_role (with category fallback for products lacking engine_role).
 * Dynamic on every call — no hardcoded defaults.
 */
export function computeExpectedFileCount(
  flatProducts: FlatProductEntry[],
  productsCatalog: ProductCatalogEntry[],
  forEngineRoles: string[],
  fallbackCategories: string[] = [],
): { target: number; min: number; max: number } {
  const catalogById = new Map(productsCatalog.map(p => [p.id, p]));
  const target = flatProducts.reduce((sum, entry) => {
    const product = catalogById.get(entry.product_id);
    if (!product) return sum;
    const matchesEngineRole = product.engine_role
      ? forEngineRoles.includes(product.engine_role)
      : false;
    const matchesFallback = !product.engine_role
      && product.category
      && fallbackCategories.includes(product.category);
    if (matchesEngineRole || matchesFallback) {
      return sum + (entry.quantity || 0);
    }
    return sum;
  }, 0);
  return {
    target,
    min: Math.max(0, target - 3),
    max: target + 3,
  };
}
```

Pass 2 / ingest calls these at round bootstrap:
```typescript
const flatProducts = flattenProjectProducts(project);
const photoCount = computeExpectedFileCount(
  flatProducts,
  productsCatalog,                              // SELECT id, category, engine_role FROM products WHERE is_active
  ['photo_day_shortlist', 'photo_dusk_shortlist'],
  ['Images', 'images'],                         // fallback when engine_role IS NULL
);
// photoCount.target / .min / .max → write to round.expected_count_target / _min / _max
```

For multi-deliverable packages (Day Video, Dusk Video) and à la carte addons: the photo shortlist sums only photo_day/photo_dusk products. Video / drone / floorplan are separate engine_roles handled by their own engines (or QA tabs).

### Section 4b — Manual-mode trigger #2: graceful degradation when target=0

Joseph confirmed 2026-04-27: if `computeExpectedFileCount(...).target === 0` for the photo engine roles, the round falls back to manual mode (W7.13) regardless of `project_type.shortlisting_supported`. This is graceful — a project that somehow ends up with no photo deliverables doesn't run an empty Pass 0/1/2/3 round, doesn't burn Sonnet credits, doesn't emit a confusing "no compositions" failure. It just opens the manual swimlane.

Round bootstrap logic:
```typescript
const trigger1 = projectType.shortlisting_supported === false;  // W7.7 flag
const photoCount = computeExpectedFileCount(...);
const trigger2 = photoCount.target === 0;
if (trigger1 || trigger2) {
  // route to manual mode (W7.13) — synthetic round row, no Pass 0/1/2/3 enqueue
  return createManualRound(project, { reason: trigger1 ? 'project_type_unsupported' : 'no_photo_products' });
}
// engine mode — enqueue Pass 0
```

The trigger reason is captured on the synthetic round row for auditability. Manual swimlane displays "Manual mode — no photo products in this project" or similar context.

### Section 5 — Slot FK refactor (kill `package_types`)

W7.8 added `shortlisting_slot_definitions.eligible_when_engine_roles TEXT[]`. The legacy `package_types TEXT[]` column on the same table is dead weight after this.

Per Joseph's Q5 confirmation (no production data yet, no observation window needed): **drop the column in this migration**.

```sql
ALTER TABLE shortlisting_slot_definitions
  DROP COLUMN IF EXISTS package_types;
```

The Pass 2 resolver in `_shared/slotEligibility.ts` still has a fallback path for empty `eligible_when_engine_roles`; that fallback can be removed in a follow-up commit since every active slot now has the column populated (W7.8 backfilled the 12 active rows).

### Section 6 — Universal hard reject thresholds + admin settings

Per Joseph's Q4: universal thresholds, but with admin UI to edit.

```sql
CREATE TABLE engine_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id)
);

INSERT INTO engine_settings (key, value, description) VALUES
  ('hard_reject_thresholds',
   '{"technical": 4.0, "lighting": 4.0}'::jsonb,
   'Universal floors below which Pass 2 rejects automatically. Master_admin editable via Settings → Engine Settings.');
```

New admin route `Settings → Engine Settings`. Master_admin only. Edit form for each row's value (JSON editor). Read-cached on engine startup; updated cache on edit-save.

### Section 7 — Manual-mode plumbing (W7.13 hook)

Add a flag on `project_types`:

```sql
ALTER TABLE project_types
  ADD COLUMN IF NOT EXISTS shortlisting_supported BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN project_types.shortlisting_supported IS
  'Wave 7 P1-6 (W7.7): when false, the project shortlisting subtab runs in manual mode (no AI passes; operator drags Dropbox files into approved; lock-triggers-move). When true (default), full Pass 0/1/2/3 engine runs.';
```

Backfill: existing project types stay TRUE (sales photography is supported). Master_admin can flip per type via Settings → Project Types admin.

The frontend rendering fork lives in **W7.13** (separate spec). W7.7 just lays the data plumbing.

---

## Migration `339_dynamic_package_tier_engine_settings.sql`

```sql
-- Wave 7 P1-6 (W7.7): dynamic package/tier/engine_settings architecture.

-- 1. shortlisting_tiers
CREATE TABLE IF NOT EXISTS shortlisting_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_code TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  score_anchor NUMERIC NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  display_order INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO shortlisting_tiers (tier_code, display_name, score_anchor, description, display_order)
VALUES
  ('S', 'Standard', 5,    'Tier S — entry-level quality bar (Stream B anchor 5).',     1),
  ('P', 'Premium',  8,    'Tier P — premium quality bar (Stream B anchor 8).',          2),
  ('A', 'A-Grade',  9.5,  'Tier A — top-shelf quality bar (Stream B anchor 9.5+).',     3)
ON CONFLICT (tier_code) DO NOTHING;

-- 2. package_engine_tier_mapping
CREATE TABLE IF NOT EXISTS package_engine_tier_mapping (
  package_id UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  tier_choice TEXT NOT NULL CHECK (tier_choice IN ('standard', 'premium')),
  engine_tier_id UUID NOT NULL REFERENCES shortlisting_tiers(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (package_id, tier_choice)
);

-- Seed mapping (Joseph confirmed Gold + Flex; rest are best guesses, editable in admin UI)
WITH tier_ids AS (
  SELECT tier_code, id FROM shortlisting_tiers
)
INSERT INTO package_engine_tier_mapping (package_id, tier_choice, engine_tier_id, notes)
SELECT p.id, tc.tier_choice, t.id,
  CASE WHEN p.name IN ('Gold Package', 'Flex Package') THEN 'Joseph confirmed 2026-04-27' ELSE 'Best-guess seed; editable' END
FROM packages p
CROSS JOIN (VALUES ('standard'), ('premium')) AS tc(tier_choice)
JOIN tier_ids t ON t.tier_code = CASE
  -- Gold: S / P (Joseph explicit)
  WHEN p.name = 'Gold Package'    AND tc.tier_choice = 'standard' THEN 'S'
  WHEN p.name = 'Gold Package'    AND tc.tier_choice = 'premium'  THEN 'P'
  -- Flex: A / A (Joseph explicit)
  WHEN p.name = 'Flex Package'                                    THEN 'A'
  -- Silver: S / P (best guess)
  WHEN p.name = 'Silver Package'  AND tc.tier_choice = 'standard' THEN 'S'
  WHEN p.name = 'Silver Package'  AND tc.tier_choice = 'premium'  THEN 'P'
  -- AI: S / S (best guess — cheap path)
  WHEN p.name = 'AI Package'                                      THEN 'S'
  -- Day Video: S / P (best guess)
  WHEN p.name = 'Day Video Package' AND tc.tier_choice = 'standard' THEN 'S'
  WHEN p.name = 'Day Video Package' AND tc.tier_choice = 'premium'  THEN 'P'
  -- Dusk Video: P / A (best guess — Dusk is high-end)
  WHEN p.name = 'Dusk Video Package' AND tc.tier_choice = 'standard' THEN 'P'
  WHEN p.name = 'Dusk Video Package' AND tc.tier_choice = 'premium'  THEN 'A'
  -- Anything new defaults to S
  ELSE 'S'
END
WHERE p.is_active = true
ON CONFLICT DO NOTHING;

-- 3. shortlisting_rounds.package_tier_choice
ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS package_tier_choice TEXT
  CHECK (package_tier_choice IS NULL OR package_tier_choice IN ('standard', 'premium'));

COMMENT ON COLUMN shortlisting_rounds.package_tier_choice IS
  'Wave 7 P1-6 (W7.7): which tier the customer chose at booking (standard or premium). Combined with package_type, joins package_engine_tier_mapping to resolve the engine tier (S/P/A) for Stream B scoring.';

-- 4. Drop legacy package_types (Joseph: hard clean now, no production data)
ALTER TABLE shortlisting_slot_definitions
  DROP COLUMN IF EXISTS package_types;

-- 5. engine_settings
CREATE TABLE IF NOT EXISTS engine_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id)
);

INSERT INTO engine_settings (key, value, description) VALUES
  ('hard_reject_thresholds',
   '{"technical": 4.0, "lighting": 4.0}'::jsonb,
   'Universal floors below which Pass 2 rejects. Master_admin editable via Settings → Engine Settings.')
ON CONFLICT (key) DO NOTHING;

-- 6. project_types.shortlisting_supported (manual-mode plumbing for W7.13)
ALTER TABLE project_types
  ADD COLUMN IF NOT EXISTS shortlisting_supported BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN project_types.shortlisting_supported IS
  'Wave 7 P1-6 (W7.7): when false, the project shortlisting subtab runs in manual mode (no AI passes; operator drags Dropbox files into approved; lock-triggers-move). When true (default), full Pass 0/1/2/3 engine runs.';

NOTIFY pgrst, 'reload schema';

-- Rollback (manual if migration breaks production):
--
-- ALTER TABLE project_types DROP COLUMN IF EXISTS shortlisting_supported;
-- DROP TABLE IF EXISTS engine_settings;
-- ALTER TABLE shortlisting_slot_definitions ADD COLUMN IF NOT EXISTS package_types TEXT[];
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS package_tier_choice;
-- DROP TABLE IF EXISTS package_engine_tier_mapping;
-- DROP TABLE IF EXISTS shortlisting_tiers;
--
-- Restoring package_types is OK because W7.8 left eligible_when_engine_roles
-- populated on every active slot — a follow-up backfill of package_types from
-- the engine_role array would be needed to fully restore the legacy fallback,
-- but the engine doesn't depend on that legacy path anymore.
```

## Engine integration

1. **Round bootstrap** (orchestrator): when creating a round, read `projects.packages[?].tier_choice` and write to `round.package_tier_choice`.

2. **Pass 2 prep**:
   - Resolve engine tier via `(round.package_type, round.package_tier_choice) → package_engine_tier_mapping → shortlisting_tiers.tier_code`.
   - Resolve target/min/max counts via `computeExpectedFileCount(round.package_products, productsCatalog, ['photo_day_shortlist','photo_dusk_shortlist'], ['Images'])`.
   - Resolve hard reject thresholds: `SELECT value FROM engine_settings WHERE key = 'hard_reject_thresholds'`.

3. **Slot eligibility** continues to use `eligible_when_engine_roles && project_engine_roles_array` per W7.8.

## Frontend impact

1. **`Settings → Engine Settings`** — new admin page. Master_admin only. Lists rows from `engine_settings`; click to edit JSON value. Save POSTs to a new `update-engine-setting` edge fn (or via existing supabase-js admin client).

2. **`Settings → Packages → Tier Mapping`** — new admin page. Master_admin only. Table view of `package_engine_tier_mapping`. Each row: package name, tier_choice (standard/premium), engine_tier dropdown (S/P/A). Edit any cell.

3. **`Settings → Project Types`** — extend existing project type admin (find via grep for "project_types" in `pages/`). Add a `shortlisting_supported` toggle per type.

4. **Booking flow** — wherever projects.packages is set, surface a tier_choice radio (standard / premium). Existing project edit form needs the field too.

5. **Removal of hardcoded package arrays** — depends on the codebase investigation findings (separate report incoming). The orchestrator routes findings to W7.11 follow-up commits.

## Tests

- `supabase/functions/_shared/packageCounts.test.ts` (new): pure-function tests for `computeExpectedFileCount`. Cover: empty array → 0/0/0; single matching product → exact sum; mixed engine_roles + fallback category; min floors at 0.
- Update `supabase/functions/_shared/slotEligibility.test.ts` to remove the `package_types` fallback expectation (column is dropped).
- Add unit test for the engine-tier resolver SQL via a Deno test that exercises the join logic against a fixture.

## Out of scope (handled in other waves)

- W7.11 frontend hardcoded array purge — separate burst, depends on this spec landing
- W7.13 manual-mode UI fork — separate spec; this wave only adds the `shortlisting_supported` flag
- W8 tier configs versioning + admin UI for tiers themselves
- W7.9 expected_file_count_range — subsumed into Section 4 of this spec; close P1-13 when this lands

## Pre-execution checklist

- [x] Architecture corrected by Joseph 2026-04-27 (dynamic counts, tier intersection, manual-mode plumbing)
- [x] Migration 339 reserved (after W7.5 took 336, W7.8 took 337, W7.6 plans 338)
- [x] Joseph confirmed Gold (S/P) + Flex (A/A) tier mappings; rest seeded as best-guess editable
- [x] Joseph confirmed: hard reject thresholds universal with admin UI, not per-package
- [x] Joseph confirmed: drop `package_types` column now (no production data)
- [x] Joseph confirmed: tiers admin UI punted to W8 (W7.7 only adds the `shortlisting_tiers` table + the package_engine_tier_mapping admin page)
- [x] Joseph confirmed: category='Images' as fallback scope for products lacking engine_role
- [x] Joseph confirmed 2026-04-27: à la carte tier mapping (premium→P, standard→S, null→S)
- [x] Joseph confirmed 2026-04-27: mixed projects = additive (package + à la carte products both counted)
- [x] Joseph confirmed 2026-04-27: target=0 → graceful manual-mode fallback (not hard error)
- [x] Orchestrator decision 2026-04-27 (Joseph deferred to call): tier_hint is metadata-only; project.pricing_tier wins for engine tier resolution
- [x] Codebase investigation report consumed: concrete file/line targets baked into dispatch prompt
- [x] W7.6 vision blocks shipped — pass2Prompt.ts now safe to modify in W7.7 (block-based, no merge collision)
