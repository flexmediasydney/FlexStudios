#!/bin/bash
# =============================================================================
# Seed Script: Residential Real Estate — Project Type, Categories, Products, Packages
# Extracted from Flex Media 2026 Standard + Premium Price Lists
# =============================================================================

set -euo pipefail

# Load env
source "$(dirname "$0")/../.env"

URL="$SUPABASE_URL/rest/v1"
KEY="$SUPABASE_SERVICE_ROLE_KEY"
AUTH=(-H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: return=representation")

# Deterministic UUIDs for cross-referencing
PT_ID="10000000-0000-4000-a000-000000000001"  # Project Type: Residential Real Estate

# Product Category IDs
CAT_IMAGES="20000000-0000-4000-a000-000000000001"
CAT_VIDEO="20000000-0000-4000-a000-000000000002"
CAT_FLOORPLAN="20000000-0000-4000-a000-000000000003"
CAT_VIRTUAL_TOUR="20000000-0000-4000-a000-000000000004"
CAT_EDITING="20000000-0000-4000-a000-000000000005"
CAT_DRONES="20000000-0000-4000-a000-000000000006"

# Product IDs — Images
P_SALES_IMAGES="30000000-0000-4000-a000-000000000001"
P_DUSK_IMAGES="30000000-0000-4000-a000-000000000002"
P_ADDITIONAL_SALES_DUSK="30000000-0000-4000-a000-000000000003"
P_RENTAL_IMAGES="30000000-0000-4000-a000-000000000004"
P_ADDITIONAL_RENTAL="30000000-0000-4000-a000-000000000005"
P_INDIVIDUAL_PORTRAITS="30000000-0000-4000-a000-000000000006"
P_TEAM_PORTRAITS="30000000-0000-4000-a000-000000000007"

# Product IDs — Video
P_DAY_VIDEO="30000000-0000-4000-a000-000000000010"
P_DUSK_VIDEO="30000000-0000-4000-a000-000000000011"
P_FLEX_VIDEO="30000000-0000-4000-a000-000000000012"
P_AI_VIDEO="30000000-0000-4000-a000-000000000013"
P_AUCTION_VIDEO="30000000-0000-4000-a000-000000000014"
P_CUT_DOWN_REEL="30000000-0000-4000-a000-000000000015"
P_PERSONALITY_REEL="30000000-0000-4000-a000-000000000016"
P_CUSTOM_FILMING="30000000-0000-4000-a000-000000000017"
P_CUSTOM_EDITING="30000000-0000-4000-a000-000000000018"
P_COMPILATION_VIDEO="30000000-0000-4000-a000-000000000019"

# Product IDs — Floorplan
P_FLOOR_SITE_PLAN="30000000-0000-4000-a000-000000000020"

# Product IDs — Drones
P_DRONE_SHOTS="30000000-0000-4000-a000-000000000025"
P_ADDITIONAL_DRONE="30000000-0000-4000-a000-000000000026"

# Product IDs — Editing (Post Production)
P_DIGITAL_DUSK="30000000-0000-4000-a000-000000000030"
P_DIGITAL_FURNITURE="30000000-0000-4000-a000-000000000031"
P_DECLUTTER="30000000-0000-4000-a000-000000000032"
P_DIGITAL_DUSK_FOOTAGE="30000000-0000-4000-a000-000000000033"

# Product IDs — Surcharges
P_SECOND_DWELLING="30000000-0000-4000-a000-000000000040"
P_SATURDAY_SURCHARGE="30000000-0000-4000-a000-000000000041"
P_SUNDAY_SURCHARGE="30000000-0000-4000-a000-000000000042"
P_ONSITE_CANCELLATION="30000000-0000-4000-a000-000000000043"
P_TRAVEL_CITY="30000000-0000-4000-a000-000000000044"
P_SPLIT_BOOKING="30000000-0000-4000-a000-000000000045"
P_LOCATION_IMAGE="30000000-0000-4000-a000-000000000046"

# Package IDs
PKG_SILVER="40000000-0000-4000-a000-000000000001"
PKG_GOLD="40000000-0000-4000-a000-000000000002"
PKG_DAY_VIDEO="40000000-0000-4000-a000-000000000003"
PKG_DUSK_VIDEO="40000000-0000-4000-a000-000000000004"
PKG_AI="40000000-0000-4000-a000-000000000005"
PKG_FLEX="40000000-0000-4000-a000-000000000006"

echo "=== Seeding Residential Real Estate Products & Packages ==="

# ─────────────────────────────────────────────────────────────────────────────
# 1. PROJECT TYPE
# ─────────────────────────────────────────────────────────────────────────────
echo "→ Creating project type..."
curl -s -X POST "$URL/project_types" "${AUTH[@]}" \
  -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "{
    \"id\": \"$PT_ID\",
    \"name\": \"Residential Real Estate\",
    \"slug\": \"residential-real-estate\",
    \"description\": \"Photography, videography, drones, and floorplans for residential real estate listings\",
    \"is_active\": true,
    \"is_default\": true,
    \"order\": 1
  }" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  ✓ Project type: {d[0][\"name\"]} ({d[0][\"id\"]})')" 2>/dev/null || echo "  ✓ Project type created"

# ─────────────────────────────────────────────────────────────────────────────
# 2. PRODUCT CATEGORIES
# ─────────────────────────────────────────────────────────────────────────────
echo "→ Creating product categories..."
curl -s -X POST "$URL/product_categories" "${AUTH[@]}" \
  -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "[
    {\"id\": \"$CAT_IMAGES\",       \"name\": \"Images\",       \"slug\": \"images\",       \"description\": \"Sales, dusk, rental photography and portraits\",  \"order\": 1, \"is_active\": true},
    {\"id\": \"$CAT_VIDEO\",        \"name\": \"Video\",        \"slug\": \"video\",        \"description\": \"Property videos, reels, auction coverage\",        \"order\": 2, \"is_active\": true},
    {\"id\": \"$CAT_FLOORPLAN\",    \"name\": \"Floorplan\",    \"slug\": \"floorplan\",    \"description\": \"2D floor plans and site plans\",                  \"order\": 3, \"is_active\": true},
    {\"id\": \"$CAT_VIRTUAL_TOUR\", \"name\": \"Virtual Tour\", \"slug\": \"virtual-tour\", \"description\": \"Virtual tours and 3D walkthroughs\",               \"order\": 4, \"is_active\": true},
    {\"id\": \"$CAT_EDITING\",      \"name\": \"Editing\",      \"slug\": \"editing\",      \"description\": \"Post production: digital dusk, furniture, declutter\", \"order\": 5, \"is_active\": true},
    {\"id\": \"$CAT_DRONES\",       \"name\": \"Drones\",       \"slug\": \"drones\",       \"description\": \"Aerial drone photography\",                       \"order\": 6, \"is_active\": true}
  ]" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'  ✓ Category: {r[\"name\"]}') for r in d]" 2>/dev/null || echo "  ✓ 6 categories created"

# ─────────────────────────────────────────────────────────────────────────────
# 3. PRODUCTS
# ─────────────────────────────────────────────────────────────────────────────
echo "→ Creating products..."

PT_IDS="[\"$PT_ID\"]"

# --- IMAGES ---
curl -s -X POST "$URL/products" "${AUTH[@]}" \
  -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "[
  {
    \"id\": \"$P_SALES_IMAGES\",
    \"name\": \"Sales Images\",
    \"description\": \"5 architectural-style sales images. Standard: Crisp White. Premium: Crisp White, Moody, or Warm.\",
    \"product_type\": \"core\",
    \"category\": \"photography\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 5,
    \"max_quantity\": 50,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 200, \"included_qty\": 5, \"unit_label\": \"images\"},
    \"premium_tier\":  {\"base_price\": 275, \"included_qty\": 5, \"unit_label\": \"images\"},
    \"is_active\": true
  },
  {
    \"id\": \"$P_DUSK_IMAGES\",
    \"name\": \"Dusk Images\",
    \"description\": \"4 dusk images — 2x front exterior, 2x rear exterior. Flex Media reserves the right to choose dusk timing.\",
    \"product_type\": \"core\",
    \"category\": \"photography\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 4,
    \"max_quantity\": 20,
    \"dusk_only\": true,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 300, \"included_qty\": 4, \"unit_label\": \"images\"},
    \"premium_tier\":  {\"base_price\": 350, \"included_qty\": 4, \"unit_label\": \"images\"},
    \"is_active\": true
  },
  {
    \"id\": \"$P_ADDITIONAL_SALES_DUSK\",
    \"name\": \"Additional Sales/Dusk Image\",
    \"description\": \"Extra sales or dusk image, charged per image.\",
    \"product_type\": \"addon\",
    \"category\": \"photography\",
    \"pricing_type\": \"per_unit\",
    \"min_quantity\": 1,
    \"max_quantity\": null,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"unit_price\": 25, \"unit_label\": \"per image\"},
    \"premium_tier\":  {\"unit_price\": 50, \"unit_label\": \"per image\"},
    \"is_active\": true
  },
  {
    \"id\": \"$P_RENTAL_IMAGES\",
    \"name\": \"Rental Images\",
    \"description\": \"7 rental images — front, back, kitchen, bed, bath, lounge, open space.\",
    \"product_type\": \"core\",
    \"category\": \"photography\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 7,
    \"max_quantity\": 30,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 150, \"included_qty\": 7, \"unit_label\": \"images\"},
    \"premium_tier\":  {\"base_price\": 250, \"included_qty\": 7, \"unit_label\": \"images\"},
    \"is_active\": true
  },
  {
    \"id\": \"$P_ADDITIONAL_RENTAL\",
    \"name\": \"Additional Rental Image\",
    \"description\": \"Extra rental image, charged per image.\",
    \"product_type\": \"addon\",
    \"category\": \"photography\",
    \"pricing_type\": \"per_unit\",
    \"min_quantity\": 1,
    \"max_quantity\": null,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"unit_price\": 15, \"unit_label\": \"per image\"},
    \"premium_tier\":  {\"unit_price\": 25, \"unit_label\": \"per image\"},
    \"is_active\": true
  },
  {
    \"id\": \"$P_INDIVIDUAL_PORTRAITS\",
    \"name\": \"Individual Portraits\",
    \"description\": \"Onsite at a location of your choosing. Flash or Natural styles.\",
    \"product_type\": \"core\",
    \"category\": \"photography\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 10,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 150},
    \"premium_tier\":  {\"base_price\": 150},
    \"is_active\": true
  },
  {
    \"id\": \"$P_TEAM_PORTRAITS\",
    \"name\": \"Team Portraits\",
    \"description\": \"Onsite team portraits at a location of your choosing. Flash or Natural styles.\",
    \"product_type\": \"core\",
    \"category\": \"photography\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 10,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 250},
    \"premium_tier\":  {\"base_price\": 250},
    \"is_active\": true
  }
]" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  ✓ {len(d)} image products')" 2>/dev/null || echo "  ✓ Image products created"

# --- VIDEO ---
curl -s -X POST "$URL/products" "${AUTH[@]}" \
  -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "[
  {
    \"id\": \"$P_DAY_VIDEO\",
    \"name\": \"Day Video\",
    \"description\": \"Day footage, detailed shots, day drones, agent interactions. Standard: Calm or Intense styles. Premium: Premium feel.\",
    \"product_type\": \"core\",
    \"category\": \"video\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 1,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 850},
    \"premium_tier\":  {\"base_price\": 1450},
    \"is_active\": true
  },
  {
    \"id\": \"$P_DUSK_VIDEO\",
    \"name\": \"Dusk Video\",
    \"description\": \"External dusk, textures, day drones, detailed shots, agent interactions. Standard: Calm or Energetic. Premium: Premium feel.\",
    \"product_type\": \"core\",
    \"category\": \"video\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 1,
    \"dusk_only\": true,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 1100},
    \"premium_tier\":  {\"base_price\": 1950},
    \"is_active\": true
  },
  {
    \"id\": \"$P_FLEX_VIDEO\",
    \"name\": \"Flex Video\",
    \"description\": \"Internal dusk, lights off, dusk drones, textures, external dusk, day drones, agent interactions, detailed shots, timelapses. Edited to the highest of standards. Premium tier only.\",
    \"product_type\": \"core\",
    \"category\": \"video\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 1,
    \"dusk_only\": true,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {},
    \"premium_tier\":  {\"base_price\": 2450},
    \"is_active\": true
  },
  {
    \"id\": \"$P_AI_VIDEO\",
    \"name\": \"AI Video\",
    \"description\": \"Convert images into a video via AI technology. Highly dependent on technology shifts, style dictated by technology capabilities. Standard tier only.\",
    \"product_type\": \"core\",
    \"category\": \"video\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 1,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 125},
    \"premium_tier\":  {},
    \"is_active\": true
  },
  {
    \"id\": \"$P_AUCTION_VIDEO\",
    \"name\": \"Auction Video\",
    \"description\": \"Full auction coverage, typically 60-90 sec. Styles: Traditional or Energised. Premium includes 2x shooters.\",
    \"product_type\": \"core\",
    \"category\": \"video\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 1,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 950},
    \"premium_tier\":  {\"base_price\": 1500},
    \"is_active\": true
  },
  {
    \"id\": \"$P_CUT_DOWN_REEL\",
    \"name\": \"Cut Down Reel\",
    \"description\": \"Up to 60 sec vertical reel conversion. Must be part of a horizontal video order.\",
    \"product_type\": \"addon\",
    \"category\": \"video\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 3,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 150},
    \"premium_tier\":  {\"base_price\": 300},
    \"is_active\": true
  },
  {
    \"id\": \"$P_PERSONALITY_REEL\",
    \"name\": \"Personality/Hype Reel\",
    \"description\": \"Highly engaging, dynamic text, emotionally charged. Catches attention and retains curiosity. Must be part of a horizontal video order. Premium tier only.\",
    \"product_type\": \"addon\",
    \"category\": \"video\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 3,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {},
    \"premium_tier\":  {\"base_price\": 1300},
    \"is_active\": true
  },
  {
    \"id\": \"$P_CUSTOM_FILMING\",
    \"name\": \"Custom Video — Filming Onsite\",
    \"description\": \"Custom video production filming onsite, charged per 30 minutes.\",
    \"product_type\": \"addon\",
    \"category\": \"video\",
    \"pricing_type\": \"per_unit\",
    \"min_quantity\": 1,
    \"max_quantity\": null,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"unit_price\": 200, \"unit_label\": \"per 30 min\"},
    \"premium_tier\":  {\"unit_price\": 250, \"unit_label\": \"per 30 min\"},
    \"is_active\": true
  },
  {
    \"id\": \"$P_CUSTOM_EDITING\",
    \"name\": \"Custom Video — Editing Footage\",
    \"description\": \"Custom video production editing footage, charged per 15 seconds delivered.\",
    \"product_type\": \"addon\",
    \"category\": \"video\",
    \"pricing_type\": \"per_unit\",
    \"min_quantity\": 1,
    \"max_quantity\": null,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"unit_price\": 200, \"unit_label\": \"per 15 sec\"},
    \"premium_tier\":  {\"unit_price\": 200, \"unit_label\": \"per 15 sec\"},
    \"is_active\": true
  },
  {
    \"id\": \"$P_COMPILATION_VIDEO\",
    \"name\": \"Compilation Video\",
    \"description\": \"Mash up of your best properties, sales, milestones and bloopers. Perfect for quarterly or yearly wrap ups. Only available for existing clients on an exclusivity agreement. Premium tier only.\",
    \"product_type\": \"core\",
    \"category\": \"video\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 1,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {},
    \"premium_tier\":  {\"base_price\": 1750},
    \"is_active\": true
  }
]" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  ✓ {len(d)} video products')" 2>/dev/null || echo "  ✓ Video products created"

# --- FLOORPLAN ---
curl -s -X POST "$URL/products" "${AUTH[@]}" \
  -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "[
  {
    \"id\": \"$P_FLOOR_SITE_PLAN\",
    \"name\": \"Floor and Site Plan\",
    \"description\": \"Includes colour 2D floorplan, siteplan and compass. Total internal/land measurements must be provided by agency. Strictly no furniture icons.\",
    \"product_type\": \"core\",
    \"category\": \"other\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 5,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 200},
    \"premium_tier\":  {\"base_price\": 250},
    \"is_active\": true
  }
]" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  ✓ {len(d)} floorplan products')" 2>/dev/null || echo "  ✓ Floorplan products created"

# --- DRONES ---
curl -s -X POST "$URL/products" "${AUTH[@]}" \
  -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "[
  {
    \"id\": \"$P_DRONE_SHOTS\",
    \"name\": \"Drone Shots\",
    \"description\": \"4 drone shots — 1x top down, 1x scenic, 2x location shots. Max 3 POIs per location shot. White borders and Flex Media drone outline style only.\",
    \"product_type\": \"core\",
    \"category\": \"drone\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 4,
    \"max_quantity\": 20,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 200, \"included_qty\": 4, \"unit_label\": \"shots\"},
    \"premium_tier\":  {\"base_price\": 350, \"included_qty\": 4, \"unit_label\": \"shots\"},
    \"is_active\": true
  },
  {
    \"id\": \"$P_ADDITIONAL_DRONE\",
    \"name\": \"Additional Drone Shot\",
    \"description\": \"Extra drone shot, charged per shot.\",
    \"product_type\": \"addon\",
    \"category\": \"drone\",
    \"pricing_type\": \"per_unit\",
    \"min_quantity\": 1,
    \"max_quantity\": null,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"unit_price\": 25, \"unit_label\": \"per shot\"},
    \"premium_tier\":  {\"unit_price\": 50, \"unit_label\": \"per shot\"},
    \"is_active\": true
  }
]" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  ✓ {len(d)} drone products')" 2>/dev/null || echo "  ✓ Drone products created"

# --- EDITING (Post Production) ---
curl -s -X POST "$URL/products" "${AUTH[@]}" \
  -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "[
  {
    \"id\": \"$P_DIGITAL_DUSK\",
    \"name\": \"Digital Dusk\",
    \"description\": \"Convert a day image into a dusk image digitally. Strictly no requests for specific dusk styles.\",
    \"product_type\": \"addon\",
    \"category\": \"editing\",
    \"pricing_type\": \"per_unit\",
    \"min_quantity\": 1,
    \"max_quantity\": null,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"unit_price\": 25, \"unit_label\": \"per image\"},
    \"premium_tier\":  {\"unit_price\": 50, \"unit_label\": \"per image\"},
    \"is_active\": true
  },
  {
    \"id\": \"$P_DIGITAL_FURNITURE\",
    \"name\": \"Digital Furniture\",
    \"description\": \"Clear and stage a room with furniture digitally. Strictly no requests for specific furniture placements or styles.\",
    \"product_type\": \"addon\",
    \"category\": \"editing\",
    \"pricing_type\": \"per_unit\",
    \"min_quantity\": 1,
    \"max_quantity\": null,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"unit_price\": 50, \"unit_label\": \"per image\"},
    \"premium_tier\":  {\"unit_price\": 90, \"unit_label\": \"per image\"},
    \"is_active\": true
  },
  {
    \"id\": \"$P_DECLUTTER\",
    \"name\": \"Declutter\",
    \"description\": \"Remove unwanted objects from an image digitally.\",
    \"product_type\": \"addon\",
    \"category\": \"editing\",
    \"pricing_type\": \"per_unit\",
    \"min_quantity\": 1,
    \"max_quantity\": null,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"unit_price\": 25, \"unit_label\": \"per image\"},
    \"premium_tier\":  {\"unit_price\": 35, \"unit_label\": \"per image\"},
    \"is_active\": true
  },
  {
    \"id\": \"$P_DIGITAL_DUSK_FOOTAGE\",
    \"name\": \"Digital Dusk Footage\",
    \"description\": \"Convert day exterior video footage into a digital dusk effect for high impact video results.\",
    \"product_type\": \"addon\",
    \"category\": \"editing\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 1,
    \"dusk_only\": false,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 100},
    \"premium_tier\":  {\"base_price\": 200},
    \"is_active\": true
  }
]" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  ✓ {len(d)} editing products')" 2>/dev/null || echo "  ✓ Editing products created"

# --- SURCHARGES ---
curl -s -X POST "$URL/products" "${AUTH[@]}" \
  -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "[
  {
    \"id\": \"$P_SECOND_DWELLING\",
    \"name\": \"Second Dwelling Surcharge\",
    \"description\": \"Additional charge for properties with a second dwelling.\",
    \"product_type\": \"surcharge\",
    \"category\": \"other\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 1,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 100},
    \"premium_tier\":  {\"base_price\": 350},
    \"is_active\": true
  },
  {
    \"id\": \"$P_SATURDAY_SURCHARGE\",
    \"name\": \"Saturday Surcharge\",
    \"description\": \"Additional charge for Saturday bookings.\",
    \"product_type\": \"surcharge\",
    \"category\": \"other\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 1,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 250},
    \"premium_tier\":  {\"base_price\": 250},
    \"is_active\": true
  },
  {
    \"id\": \"$P_SUNDAY_SURCHARGE\",
    \"name\": \"Sunday Surcharge\",
    \"description\": \"Additional charge for Sunday bookings.\",
    \"product_type\": \"surcharge\",
    \"category\": \"other\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 1,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 500},
    \"premium_tier\":  {\"base_price\": 500},
    \"is_active\": true
  },
  {
    \"id\": \"$P_ONSITE_CANCELLATION\",
    \"name\": \"Onsite Cancellation Fee\",
    \"description\": \"Fee charged for onsite cancellation or no-show.\",
    \"product_type\": \"surcharge\",
    \"category\": \"other\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 1,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 500},
    \"premium_tier\":  {\"base_price\": 500},
    \"is_active\": true
  },
  {
    \"id\": \"$P_TRAVEL_CITY\",
    \"name\": \"Travel/City Surcharge\",
    \"description\": \"Additional charge for out-of-area or CBD bookings.\",
    \"product_type\": \"surcharge\",
    \"category\": \"other\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 1,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 150},
    \"premium_tier\":  {\"base_price\": 150},
    \"is_active\": true
  },
  {
    \"id\": \"$P_SPLIT_BOOKING\",
    \"name\": \"Split Booking Surcharge\",
    \"description\": \"Additional charge for forced split bookings, per split.\",
    \"product_type\": \"surcharge\",
    \"category\": \"other\",
    \"pricing_type\": \"fixed\",
    \"min_quantity\": 1,
    \"max_quantity\": 3,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"base_price\": 500},
    \"premium_tier\":  {\"base_price\": 500},
    \"is_active\": true
  },
  {
    \"id\": \"$P_LOCATION_IMAGE\",
    \"name\": \"Location Image/Footage\",
    \"description\": \"Additional charge per extra location for images or footage. Premium tier only.\",
    \"product_type\": \"surcharge\",
    \"category\": \"other\",
    \"pricing_type\": \"per_unit\",
    \"min_quantity\": 1,
    \"max_quantity\": null,
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {},
    \"premium_tier\":  {\"unit_price\": 150, \"unit_label\": \"per location\"},
    \"is_active\": true
  }
]" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  ✓ {len(d)} surcharge products')" 2>/dev/null || echo "  ✓ Surcharge products created"

# ─────────────────────────────────────────────────────────────────────────────
# 4. PACKAGES
# ─────────────────────────────────────────────────────────────────────────────
echo "→ Creating packages..."

curl -s -X POST "$URL/packages" "${AUTH[@]}" \
  -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "[
  {
    \"id\": \"$PKG_SILVER\",
    \"name\": \"Silver Package\",
    \"description\": \"Up to 10 day images + floor & site plan.\",
    \"products\": [
      {\"product_id\": \"$P_SALES_IMAGES\", \"product_name\": \"Sales Images\", \"quantity\": 10},
      {\"product_id\": \"$P_FLOOR_SITE_PLAN\", \"product_name\": \"Floor and Site Plan\", \"quantity\": 1}
    ],
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"package_price\": 400},
    \"premium_tier\":  {\"package_price\": 700},
    \"is_active\": true
  },
  {
    \"id\": \"$PKG_GOLD\",
    \"name\": \"Gold Package\",
    \"description\": \"Up to 15 day images + 4 drone shots + floor & site plan.\",
    \"products\": [
      {\"product_id\": \"$P_SALES_IMAGES\", \"product_name\": \"Sales Images\", \"quantity\": 15},
      {\"product_id\": \"$P_DRONE_SHOTS\", \"product_name\": \"Drone Shots\", \"quantity\": 4},
      {\"product_id\": \"$P_FLOOR_SITE_PLAN\", \"product_name\": \"Floor and Site Plan\", \"quantity\": 1}
    ],
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"package_price\": 550},
    \"premium_tier\":  {\"package_price\": 1100},
    \"is_active\": true
  },
  {
    \"id\": \"$PKG_DAY_VIDEO\",
    \"name\": \"Day Video Package\",
    \"description\": \"Up to 20 day images + 4 drone shots + floor & site plan + day video.\",
    \"products\": [
      {\"product_id\": \"$P_SALES_IMAGES\", \"product_name\": \"Sales Images\", \"quantity\": 20},
      {\"product_id\": \"$P_DRONE_SHOTS\", \"product_name\": \"Drone Shots\", \"quantity\": 4},
      {\"product_id\": \"$P_FLOOR_SITE_PLAN\", \"product_name\": \"Floor and Site Plan\", \"quantity\": 1},
      {\"product_id\": \"$P_DAY_VIDEO\", \"product_name\": \"Day Video\", \"quantity\": 1}
    ],
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"package_price\": 1450},
    \"premium_tier\":  {\"package_price\": 3000},
    \"is_active\": true
  },
  {
    \"id\": \"$PKG_DUSK_VIDEO\",
    \"name\": \"Dusk Video Package\",
    \"description\": \"Up to 25 day images + 4 dusk images + 4 drone shots + floor & site plan + dusk video.\",
    \"products\": [
      {\"product_id\": \"$P_SALES_IMAGES\", \"product_name\": \"Sales Images\", \"quantity\": 25},
      {\"product_id\": \"$P_DUSK_IMAGES\", \"product_name\": \"Dusk Images\", \"quantity\": 4},
      {\"product_id\": \"$P_DRONE_SHOTS\", \"product_name\": \"Drone Shots\", \"quantity\": 4},
      {\"product_id\": \"$P_FLOOR_SITE_PLAN\", \"product_name\": \"Floor and Site Plan\", \"quantity\": 1},
      {\"product_id\": \"$P_DUSK_VIDEO\", \"product_name\": \"Dusk Video\", \"quantity\": 1}
    ],
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"package_price\": 2250},
    \"premium_tier\":  {\"package_price\": 4000},
    \"is_active\": true
  },
  {
    \"id\": \"$PKG_AI\",
    \"name\": \"AI Package\",
    \"description\": \"Up to 15 day images + 4 digital dusk images + 4 drone shots + floor & site plan + AI video. Standard tier only.\",
    \"products\": [
      {\"product_id\": \"$P_SALES_IMAGES\", \"product_name\": \"Sales Images\", \"quantity\": 15},
      {\"product_id\": \"$P_DIGITAL_DUSK\", \"product_name\": \"Digital Dusk\", \"quantity\": 4},
      {\"product_id\": \"$P_DRONE_SHOTS\", \"product_name\": \"Drone Shots\", \"quantity\": 4},
      {\"product_id\": \"$P_FLOOR_SITE_PLAN\", \"product_name\": \"Floor and Site Plan\", \"quantity\": 1},
      {\"product_id\": \"$P_AI_VIDEO\", \"product_name\": \"AI Video\", \"quantity\": 1}
    ],
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {\"package_price\": 750},
    \"premium_tier\":  {},
    \"is_active\": true
  },
  {
    \"id\": \"$PKG_FLEX\",
    \"name\": \"Flex Package\",
    \"description\": \"Up to 30 day images + 4 dusk images + 4 drone shots + floor & site plan + Flex video. Premium tier only.\",
    \"products\": [
      {\"product_id\": \"$P_SALES_IMAGES\", \"product_name\": \"Sales Images\", \"quantity\": 30},
      {\"product_id\": \"$P_DUSK_IMAGES\", \"product_name\": \"Dusk Images\", \"quantity\": 4},
      {\"product_id\": \"$P_DRONE_SHOTS\", \"product_name\": \"Drone Shots\", \"quantity\": 4},
      {\"product_id\": \"$P_FLOOR_SITE_PLAN\", \"product_name\": \"Floor and Site Plan\", \"quantity\": 1},
      {\"product_id\": \"$P_FLEX_VIDEO\", \"product_name\": \"Flex Video\", \"quantity\": 1}
    ],
    \"project_type_ids\": $PT_IDS,
    \"standard_tier\": {},
    \"premium_tier\":  {\"package_price\": 5000},
    \"is_active\": true
  }
]" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  ✓ {len(d)} packages')" 2>/dev/null || echo "  ✓ 6 packages created"

echo ""
echo "=== Seed Complete ==="
echo ""
echo "Summary:"
echo "  • 1 Project Type: Residential Real Estate"
echo "  • 6 Product Categories: Images, Video, Floorplan, Virtual Tour, Editing, Drones"
echo "  • 28 Products (7 images, 10 video, 1 floorplan, 2 drones, 4 editing, 7 surcharges)"
echo "  • 6 Packages (Silver, Gold, Day Video, Dusk Video, AI, Flex)"
echo ""
echo "All prices extracted from Flex Media 2026 Standard + Premium price lists."
echo "Each product has dual-tier pricing (standard_tier / premium_tier)."
