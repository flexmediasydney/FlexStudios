# W7.8 — Product-Driven Slot Eligibility — Design Spec

**Status:** Design phase. NOT yet ready for delegation.
**Depends on:** W7.7 (`package_shortlist_configs` sidecar must land first).
**Replaces:** my earlier flawed `is_time_of_day_relevant` slot flag proposal.

## Problem

Today's slot eligibility uses `shortlisting_slot_definitions.package_types text[]` matched by string against `projects.tonomo_package`. Hardcoded strings disconnect the engine from the real `products` + `packages` tables. Marketing creating a new package = silent breakage; configurable engine behaviour needs a stronger primitive than text-match.

Joseph's correct architectural critique: slot requirements should derive from the **products inside the project's package**, not from per-slot flags. If a project's package contains both `Sales Images` AND `Dusk Images`, the engine knows day AND dusk slot variants are needed. If it has `Drone Shots`, drone slots are eligible. Clean, data-driven, no hardcoded heuristics.

## Real-world products inventory (queried 2026-04-27)

The `products` table has these fields:
- `product_type`: 'core' | 'addon'
- `category`: 'Images' | 'Video' | 'Drones' | 'Floorplan' | 'Editing' | 'Fees'
- `dusk_only`: boolean (true for Dusk Images, Dusk Video, Flex Video)

Every project's package contains products. Sample core products relevant to shortlisting:

| Product | category | dusk_only | engine relevance |
|---|---|---|---|
| Sales Images | Images | false | day photo shoot baseline |
| Rental Images | Images | false | day photo shoot baseline |
| Dusk Images | Images | **true** | dusk variants required |
| Drone Shots | Drones | false | drone slots eligible |
| Floor and Site Plan | Floorplan | false | floorplan QA in scope |
| Day Video | Video | false | video shortlisting in scope |
| Dusk Video | Video | **true** | dusk video shortlisting |
| Flex Video | Video | true | dusk video shortlisting |
| Individual Portraits | Images | false | **out of scope** for property shortlist |
| Team Portraits | Images | false | **out of scope** |

Add-ons that are NOT trigger products for shortlisting (because they're virtual/post-edit):
- `Digital Dusk Images` (Editing addon — virtual dusk from day RAWs; doesn't need dusk shortlisting)
- `Digital Furniture` (Editing addon)
- `Declutter Images` (Editing addon)
- All Fees-category products

## Architecture decision: introduce `engine_role` on products

Instead of forcing slot eligibility logic to interpret `(category, dusk_only, product_type)` tuples, give each product a single explicit `engine_role` that maps cleanly to slot eligibility.

```sql
ALTER TABLE products
  ADD COLUMN engine_role TEXT;
```

Enum values:

| `engine_role` | Triggers what slot eligibility |
|---|---|
| `photo_day_shortlist` | All day-time interior + exterior + detail slots |
| `photo_dusk_shortlist` | All dusk-time variants of relevant slots (exterior_front_dusk, etc.) |
| `drone_shortlist` | All drone slots (drone_orbit_primary, drone_orbit_secondary, drone_nadir) |
| `floorplan_qa` | Floorplan QA tab in shortlisting UI (validates that floorplan exists; doesn't fill slots) |
| `video_day_shortlist` | Day-time video frame shortlisting (Wave 15+) |
| `video_dusk_shortlist` | Dusk-time video frame shortlisting (Wave 15+) |
| `agent_portraits` | Agent headshots — used for OUT_OF_SCOPE quarantine matching, not shortlisting |
| `null` (default) | No engine impact (Editing addons, Fees, etc.) |

**Why an enum instead of multiple booleans?** Each product has exactly ONE primary role. Boolean explosion (`triggers_photo_shortlist`, `triggers_dusk_variants`, `triggers_drone_shortlist`...) creates ambiguity (what if both true?) and proliferates. Single enum is unambiguous.

**Why not derive from `(category, dusk_only)`?** It mostly works but ambiguity exists: `Day Video` has category=Video, dusk_only=false — should this trigger video shortlisting? Yes, but the rule "category=Video AND product_type=core AND dusk_only=false" is gradually creep-prone. Explicit enum is cleaner + easier to audit + admin-editable per product.

## Slot eligibility model

```sql
ALTER TABLE shortlisting_slot_definitions
  ADD COLUMN eligible_when_engine_roles TEXT[];
```

A slot is in scope for a given project if:
- `slot.eligible_when_engine_roles` is NULL/empty (universal slot — applies to every shoot), OR
- The project's resolved package contains at least one product whose `engine_role` matches at least one entry in `slot.eligible_when_engine_roles`

Examples:

```sql
-- Universal day-photo slots (eligible for any project with photo_day_shortlist)
UPDATE shortlisting_slot_definitions
SET eligible_when_engine_roles = ARRAY['photo_day_shortlist']
WHERE slot_id IN ('exterior_front_hero', 'kitchen_hero', 'master_bedroom_hero', 'open_plan_hero');

-- Dusk-variant slots (only when project has dusk product)
INSERT INTO shortlisting_slot_definitions (slot_id, display_name, phase, eligible_when_engine_roles, ...)
VALUES
  ('exterior_front_dusk', 'Front facade — dusk', 1, ARRAY['photo_dusk_shortlist'], ...),
  ('alfresco_dusk',       'Alfresco — dusk',     2, ARRAY['photo_dusk_shortlist'], ...);

-- Drone slots (only when project has drone product)
INSERT INTO shortlisting_slot_definitions (slot_id, display_name, phase, eligible_when_engine_roles, ...)
VALUES
  ('drone_orbit_primary',   'Drone orbit — primary',   1, ARRAY['drone_shortlist'], ...),
  ('drone_orbit_secondary', 'Drone orbit — secondary', 2, ARRAY['drone_shortlist'], ...),
  ('drone_nadir',           'Drone nadir',             2, ARRAY['drone_shortlist'], ...);

-- Multi-role slot (same physical area, eligible for either day OR dusk products)
-- e.g. an "alfresco hero" can be filled regardless — different timing variants land in
-- different slot_ids
```

## Slot template builder (engine-side)

The Pass 2 prompt builder reads `shortlisting_slot_definitions` filtered by:

```typescript
async function buildSlotTemplate(projectId: string): Promise<SlotDefinition[]> {
  // 1. Resolve project → package → products → engine_roles
  const projectRoles = await resolveProjectEngineRoles(projectId);
  //    e.g. ['photo_day_shortlist', 'photo_dusk_shortlist', 'drone_shortlist', 'floorplan_qa']

  // 2. Pull active slot definitions
  const slots = await db.from('shortlisting_slot_definitions')
    .select('*')
    .eq('is_active', true);

  // 3. Filter slots whose eligibility matches at least one project role
  return slots.filter(s => {
    if (!s.eligible_when_engine_roles || s.eligible_when_engine_roles.length === 0) {
      return true; // universal slot
    }
    return s.eligible_when_engine_roles.some(role => projectRoles.includes(role));
  });
}
```

For a Gold project (only `photo_day_shortlist`): slot template includes only day-photo slots. No dusk variants, no drone slots, no video slots surface in the swimlane.

For a Day-to-Dusk project (`photo_day_shortlist` + `photo_dusk_shortlist`): both day and dusk slot variants surface.

For a Premium-with-drone project (`photo_day_shortlist` + `photo_dusk_shortlist` + `drone_shortlist`): all three slot families surface.

## Migration strategy (additive then subtractive per `MIGRATION_SAFETY.md`)

**Migration N (additive):**
1. `ALTER TABLE products ADD COLUMN engine_role TEXT`
2. Backfill `engine_role` for every existing product (one-shot SQL UPDATE — small table)
3. `ALTER TABLE shortlisting_slot_definitions ADD COLUMN eligible_when_engine_roles TEXT[]`
4. Backfill existing slot definitions: copy current `package_types` text array translation into `eligible_when_engine_roles` (e.g. slots eligible for `Gold` and `Day to Dusk` and `Premium` packages get `eligible_when_engine_roles = ['photo_day_shortlist']`)
5. Engine reads new column with fallback to old (`COALESCE(eligible_when_engine_roles, derive_from_package_types(package_types))`)

**Migration N+M (subtractive, after validation window):**
6. Drop old `package_types` text array

**Migration N+L (additive expansion):**
7. Insert new dusk-variant slot definitions, drone slot definitions
8. These weren't in the old taxonomy — they're enabled by the new architecture

## Backfill table for existing products

To be applied as part of the migration:

```sql
UPDATE products SET engine_role = CASE
  -- Core photo products
  WHEN id = '30000000-0000-4000-a000-000000000001' THEN 'photo_day_shortlist'    -- Sales Images
  WHEN id = '30000000-0000-4000-a000-000000000004' THEN 'photo_day_shortlist'    -- Rental Images
  WHEN id = '30000000-0000-4000-a000-000000000002' THEN 'photo_dusk_shortlist'   -- Dusk Images

  -- Drone
  WHEN id = '30000000-0000-4000-a000-000000000025' THEN 'drone_shortlist'        -- Drone Shots

  -- Floorplan
  WHEN id = '30000000-0000-4000-a000-000000000020' THEN 'floorplan_qa'           -- Floor and Site Plan

  -- Video
  WHEN id = '30000000-0000-4000-a000-000000000010' THEN 'video_day_shortlist'    -- Day Video
  WHEN id = '30000000-0000-4000-a000-000000000011' THEN 'video_dusk_shortlist'   -- Dusk Video
  WHEN id = '30000000-0000-4000-a000-000000000012' THEN 'video_dusk_shortlist'   -- Flex Video
  WHEN id = '30000000-0000-4000-a000-000000000013' THEN 'video_day_shortlist'   -- AI Video
  WHEN id = '30000000-0000-4000-a000-000000000014' THEN 'video_day_shortlist'   -- Auction Video
  WHEN id = '30000000-0000-4000-a000-000000000019' THEN 'video_day_shortlist'   -- Compilation Video

  -- Out of scope for property shortlisting (but engine_role tagged for OOS detection)
  WHEN id = '30000000-0000-4000-a000-000000000006' THEN 'agent_portraits'       -- Individual Portraits
  WHEN id = '30000000-0000-4000-a000-000000000007' THEN 'agent_portraits'       -- Team Portraits

  -- All addons (Editing, Fees) → null
  ELSE NULL
END
WHERE engine_role IS NULL;
```

## Frontend implications

`SettingsProductsManagement.jsx` (or wherever products are admin-managed today) gains an "Engine role" dropdown per product. Master_admin can change a product's engine_role; takes effect on next round.

`SettingsShortlistingSlots.jsx` admin gains an "Eligible when engine roles" multiselect; lists all known engine_role values from a SELECT DISTINCT on products.

## Open questions for sign-off

1. **Should `agent_portraits` be a real engine_role or null?** Adding it lets us OOS-quarantine agent headshots more reliably (Pass 0 detects an agent headshot in `Photos/Raws/Shortlist Proposed/`, can cross-check the project has an `agent_portraits` product to confirm intent — if no such product, escalate). Recommendation: yes, include it.

2. **Should `Individual Portraits` and `Team Portraits` products force separate folder routing?** Today they'd land in `Photos/Raws/Shortlist Proposed/` along with sales images. Probably cleaner to route them to `Photos/Raws/Portraits/` via a new folder kind, but that's a separate burst.

3. **`floorplan_qa` engine_role — should this surface a real slot or just a tab?** Recommendation: just a tab. Floorplans aren't shortlisted; they're checked-in deliverables. The QA tab validates "floorplan present + readable + not the competitor's branding" but doesn't fill a swimlane slot.

4. **Out-of-scope content quarantine** — when a project has only `photo_day_shortlist` engine_role but Pass 0 detects dusk-looking compositions (model says `is_dusk: true`), what happens? Recommendation: warn in the UI ("you've shot dusk content but the project doesn't have a Dusk Images product — was this intentional?") but don't reject. Editor decides.

## Effort estimate

- 1 day design (this doc) + 1 day refinement after Joseph's sign-off
- 2-3 days execution: migration + backfill + slot template builder + engine integration
- 1-2 days frontend: products admin engine_role dropdown + slot definitions admin update

Total: ~1 week after design phase.

## Pre-execution checklist

- [ ] Joseph signs off on the engine_role enum values (Section "Architecture decision")
- [ ] Joseph confirms Q1 (`agent_portraits` inclusion)
- [ ] Joseph confirms Q3 (`floorplan_qa` as tab not slot)
- [ ] Joseph confirms Q4 (out-of-scope warning vs reject)
- [ ] W7.7 (`package_shortlist_configs` sidecar) has landed
- [ ] Existing slot definitions reviewed for which `eligible_when_engine_roles` they should have
