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

### Section 3 — Capture project's tier choice at booking

`projects.packages` is a JSONB array today with `{package_id, products: [{product_id, quantity}], quantity}`. Add `tier_choice` per package entry:

```jsonc
[
  {
    "package_id": "...",
    "tier_choice": "standard",   // ← NEW: 'standard' | 'premium'
    "products": [...],
    "quantity": 1
  }
]
```

No DDL needed — JSONB shape change is application-level. Backfill rule for existing projects: every entry gets `tier_choice: 'standard'` (Joseph confirmed: no real production data yet, OK to assume).

Propagate to `shortlisting_rounds` so the engine has a stable handle:
```sql
ALTER TABLE shortlisting_rounds
  ADD COLUMN package_tier_choice TEXT CHECK (package_tier_choice IS NULL OR package_tier_choice IN ('standard', 'premium'));
```

Round bootstrap reads `projects.packages[?].tier_choice` and writes it onto the round at creation. Pass 2's tier resolution becomes:
```sql
SELECT t.*
FROM shortlisting_rounds r
JOIN packages p ON p.name = r.package_type
JOIN package_engine_tier_mapping m ON m.package_id = p.id AND m.tier_choice = r.package_tier_choice
JOIN shortlisting_tiers t ON t.id = m.engine_tier_id
WHERE r.id = $1;
```

### Section 4 — Dynamic file count resolver (no hardcoded defaults)

Drop ALL `expected_file_count_*` columns from any sidecar table. Replace with a runtime function:

```typescript
// supabase/functions/_shared/packageCounts.ts (new)

export interface PackageProductEntry {
  product_id: string;
  quantity: number;
  // ...
}

export interface ProductCatalogEntry {
  id: string;
  category: string | null;
  engine_role: string | null;
}

/**
 * Compute target file count for a round.
 * 
 * Source of truth: the package's products array, filtered by engine_role
 * matching the engine's interest (e.g. ['photo_day_shortlist', 'photo_dusk_shortlist']
 * for the photo shortlist), with a category='Images' fallback for
 * products that haven't been backfilled with engine_role yet.
 * 
 * Returned counts are dynamic on every call — no hardcoded defaults.
 */
export function computeExpectedFileCount(
  packageProducts: PackageProductEntry[],
  productsCatalog: ProductCatalogEntry[],
  forEngineRoles: string[],
  fallbackCategories: string[] = [],
): { target: number; min: number; max: number } {
  const catalogById = new Map(productsCatalog.map(p => [p.id, p]));
  const target = packageProducts.reduce((sum, entry) => {
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

Pass 2 calls this at round start:
```typescript
const photoCount = computeExpectedFileCount(
  packageProducts,           // from projects.packages[?].products
  productsCatalog,           // SELECT id, category, engine_role FROM products WHERE is_active
  ['photo_day_shortlist', 'photo_dusk_shortlist'],
  ['Images', 'images'],      // fallback when engine_role IS NULL
);
// photoCount.target / .min / .max
```

For multi-deliverable packages (Day Video, Dusk Video): the photo shortlist sums only photo_day/photo_dusk products. Video / drone / floorplan are separate engine_roles handled by their own engines (or QA tabs).

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
- [ ] Codebase investigation report (in flight) reviewed before dispatch — may surface additional fixups
