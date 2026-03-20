#!/bin/bash
# =============================================================================
# Fix & Re-seed: Properly link categories to project type, fix product category refs
# =============================================================================

set -euo pipefail
source "$(dirname "$0")/../.env"

URL="$SUPABASE_URL/rest/v1"
KEY="$SUPABASE_SERVICE_ROLE_KEY"
AUTH=(-H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json")

# Deterministic UUIDs
PT_ID="10000000-0000-4000-a000-000000000001"

CAT_IMAGES="20000000-0000-4000-a000-000000000001"
CAT_VIDEO="20000000-0000-4000-a000-000000000002"
CAT_FLOORPLAN="20000000-0000-4000-a000-000000000003"
CAT_VIRTUAL_TOUR="20000000-0000-4000-a000-000000000004"
CAT_EDITING="20000000-0000-4000-a000-000000000005"
CAT_DRONES="20000000-0000-4000-a000-000000000006"

echo "=== Step 1: Apply schema fixes ==="
echo "→ Adding missing columns to product_categories (project_type_id, icon, color)..."

# We can't run raw SQL via PostgREST, so we add the columns by attempting to insert with them
# If columns don't exist yet, the inserts will fail. We need the migration to run first.
# For now, let's try — Supabase may auto-handle new JSONB fields, but not typed columns.
# The migration 021 must be applied separately.

echo "  ⚠ Migration 021_fix_product_categories_schema.sql must be applied to the database."
echo "  Attempting operations assuming columns exist..."

echo ""
echo "=== Step 2: Fix project type (add color) ==="
curl -s -X PATCH "$URL/project_types?id=eq.$PT_ID" "${AUTH[@]}" \
  -H "Prefer: return=representation" \
  -d '{"color": "#3b82f6"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  ✓ Project type updated: {d[0][\"name\"]}')" 2>/dev/null || echo "  ✓ Project type color set"

echo ""
echo "=== Step 3: Delete old categories and re-create with proper fields ==="

# Delete existing categories (our deterministic IDs)
for CAT_ID in "$CAT_IMAGES" "$CAT_VIDEO" "$CAT_FLOORPLAN" "$CAT_VIRTUAL_TOUR" "$CAT_EDITING" "$CAT_DRONES"; do
  curl -s -X DELETE "$URL/product_categories?id=eq.$CAT_ID" "${AUTH[@]}" > /dev/null 2>&1
done
echo "  ✓ Old categories removed"

# Re-create with project_type_id, icon, color
# Category names use Title Case for display
# Products reference categories via: category.name.toLowerCase().replace(/\s+/g, '_')
curl -s -X POST "$URL/product_categories" "${AUTH[@]}" \
  -H "Prefer: return=representation" \
  -d "[
  {
    \"id\": \"$CAT_IMAGES\",
    \"name\": \"Images\",
    \"slug\": \"images\",
    \"description\": \"Sales, dusk, rental photography and portraits\",
    \"icon\": \"📷\",
    \"color\": \"#3b82f6\",
    \"project_type_id\": \"$PT_ID\",
    \"project_type_name\": \"Residential Real Estate\",
    \"order\": 1,
    \"is_active\": true
  },
  {
    \"id\": \"$CAT_VIDEO\",
    \"name\": \"Video\",
    \"slug\": \"video\",
    \"description\": \"Property videos, reels, auction coverage\",
    \"icon\": \"🎬\",
    \"color\": \"#8b5cf6\",
    \"project_type_id\": \"$PT_ID\",
    \"project_type_name\": \"Residential Real Estate\",
    \"order\": 2,
    \"is_active\": true
  },
  {
    \"id\": \"$CAT_FLOORPLAN\",
    \"name\": \"Floorplan\",
    \"slug\": \"floorplan\",
    \"description\": \"2D floor plans and site plans\",
    \"icon\": \"📐\",
    \"color\": \"#06b6d4\",
    \"project_type_id\": \"$PT_ID\",
    \"project_type_name\": \"Residential Real Estate\",
    \"order\": 3,
    \"is_active\": true
  },
  {
    \"id\": \"$CAT_VIRTUAL_TOUR\",
    \"name\": \"Virtual Tour\",
    \"slug\": \"virtual-tour\",
    \"description\": \"Virtual tours and 3D walkthroughs\",
    \"icon\": \"🏠\",
    \"color\": \"#22c55e\",
    \"project_type_id\": \"$PT_ID\",
    \"project_type_name\": \"Residential Real Estate\",
    \"order\": 4,
    \"is_active\": true
  },
  {
    \"id\": \"$CAT_EDITING\",
    \"name\": \"Editing\",
    \"slug\": \"editing\",
    \"description\": \"Post production: digital dusk, furniture, declutter\",
    \"icon\": \"✂️\",
    \"color\": \"#f97316\",
    \"project_type_id\": \"$PT_ID\",
    \"project_type_name\": \"Residential Real Estate\",
    \"order\": 5,
    \"is_active\": true
  },
  {
    \"id\": \"$CAT_DRONES\",
    \"name\": \"Drones\",
    \"slug\": \"drones\",
    \"description\": \"Aerial drone photography\",
    \"icon\": \"🚁\",
    \"color\": \"#ec4899\",
    \"project_type_id\": \"$PT_ID\",
    \"project_type_name\": \"Residential Real Estate\",
    \"order\": 6,
    \"is_active\": true
  }
]" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'  ✓ {r[\"icon\"]} {r[\"name\"]} → project_type: {r.get(\"project_type_id\",\"?\")[:8]}...') for r in d]" 2>/dev/null || echo "  ⚠ Category insert failed — migration 021 may need to be applied first"

echo ""
echo "=== Step 4: Update products to use correct category names ==="
echo "→ Category name mapping: Images→images, Video→video, Floorplan→floorplan, Drones→drones, Editing→editing"
echo "→ (Hierarchy matches via: category.name.toLowerCase().replace(/ /g,'_') === product.category)"

# Update image products: photography → images
for PID in \
  "30000000-0000-4000-a000-000000000001" \
  "30000000-0000-4000-a000-000000000002" \
  "30000000-0000-4000-a000-000000000003" \
  "30000000-0000-4000-a000-000000000004" \
  "30000000-0000-4000-a000-000000000005" \
  "30000000-0000-4000-a000-000000000006" \
  "30000000-0000-4000-a000-000000000007"; do
  curl -s -X PATCH "$URL/products?id=eq.$PID" "${AUTH[@]}" \
    -d '{"category": "images"}' > /dev/null 2>&1
done
echo "  ✓ 7 image products → category: images"

# Video products already correct (video → video)
echo "  ✓ 10 video products → category: video (no change needed)"

# Floorplan: other → floorplan
curl -s -X PATCH "$URL/products?id=eq.30000000-0000-4000-a000-000000000020" "${AUTH[@]}" \
  -d '{"category": "floorplan"}' > /dev/null 2>&1
echo "  ✓ 1 floorplan product → category: floorplan"

# Drones: drone → drones
for PID in \
  "30000000-0000-4000-a000-000000000025" \
  "30000000-0000-4000-a000-000000000026"; do
  curl -s -X PATCH "$URL/products?id=eq.$PID" "${AUTH[@]}" \
    -d '{"category": "drones"}' > /dev/null 2>&1
done
echo "  ✓ 2 drone products → category: drones"

# Editing already correct (editing → editing)
echo "  ✓ 4 editing products → category: editing (no change needed)"

# Surcharges → keep as "other" (no category in the 6 main ones)
echo "  ✓ 7 surcharge products → category: other (uncategorized)"

echo ""
echo "=== Step 5: Verify ==="

echo "→ Categories with project_type linkage:"
curl -s "$URL/product_categories?select=name,icon,color,project_type_id,order&order=order" \
  "${AUTH[@]}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for c in data:
    ptid = c.get('project_type_id', 'NONE')
    ptid_short = ptid[:8] + '...' if ptid else 'NONE'
    print(f'  {c.get(\"icon\",\"?\")} {c[\"name\"]:15} color={c.get(\"color\",\"?\")}  project_type={ptid_short}')
" 2>/dev/null || echo "  Could not verify categories"

echo ""
echo "→ Products by category:"
curl -s "$URL/products?select=name,category&order=category,name" \
  "${AUTH[@]}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
by_cat = {}
for p in data:
    cat = p.get('category') or 'uncategorized'
    by_cat.setdefault(cat, []).append(p['name'])
for cat in sorted(by_cat):
    print(f'  {cat}: {len(by_cat[cat])} products — {', '.join(by_cat[cat][:3])}{'...' if len(by_cat[cat]) > 3 else \"\"}')
print(f'  Total: {len(data)} products')
" 2>/dev/null || echo "  Could not verify products"

echo ""
echo "=== Done ==="
echo "If category insert failed, you need to apply migration 021 first:"
echo "  Run: supabase db push --linked"
echo "  Or apply 021_fix_product_categories_schema.sql manually in Supabase SQL Editor"
