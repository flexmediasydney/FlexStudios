-- Extends the 357 backfill to projects whose onsite duration is driven by a
-- package (rather than top-level products). Two cases:
--
--   A) Package has scheduling_time > 0 — that overrides per-product timing.
--      Stamp the onsite task with package_id, not product_id.
--   B) Package has no scheduling_time — fall back to its nested products,
--      pick the longest, stamp product_id.
--
-- Tasks already linked by 357 are skipped via the product_id IS NULL guard.

-- A) Package-level scheduling_time wins
WITH onsite AS (
  SELECT pt.id AS task_id, pt.project_id
  FROM project_tasks pt
  WHERE pt.template_id LIKE 'onsite:%'
    AND pt.product_id IS NULL
    AND pt.package_id IS NULL
    AND pt.is_deleted = false
),
proj_pkg AS (
  SELECT
    p.id AS project_id,
    p.pricing_tier,
    (elem->>'package_id')::uuid AS package_id
  FROM projects p
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.packages, '[]'::jsonb)) AS elem
  WHERE p.id IN (SELECT project_id FROM onsite)
),
pkg_scheduling AS (
  SELECT
    pp.project_id,
    pp.package_id,
    COALESCE(
      (CASE WHEN pp.pricing_tier = 'premium'
            THEN COALESCE(pkg.premium_tier, pkg.standard_tier)
            ELSE pkg.standard_tier
       END->>'scheduling_time')::numeric, 0
    ) AS sched_mins
  FROM proj_pkg pp
  JOIN packages pkg ON pkg.id = pp.package_id
),
ranked_pkgs AS (
  SELECT project_id, package_id, sched_mins,
    ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY sched_mins DESC, package_id) AS rnk
  FROM pkg_scheduling
  WHERE sched_mins > 0
)
UPDATE project_tasks pt
SET package_id = r.package_id
FROM onsite o
JOIN ranked_pkgs r ON r.project_id = o.project_id AND r.rnk = 1
WHERE pt.id = o.task_id;

-- B) Nested-product fallback for projects whose package has no scheduling_time.
--    Re-runs the 357 logic but pulls products out of project.packages[*].products.
WITH onsite AS (
  SELECT pt.id AS task_id, pt.project_id
  FROM project_tasks pt
  WHERE pt.template_id LIKE 'onsite:%'
    AND pt.product_id IS NULL
    AND pt.package_id IS NULL
    AND pt.is_deleted = false
),
nested AS (
  SELECT
    p.id AS project_id,
    p.pricing_tier,
    (prod_elem->>'product_id')::uuid AS product_id,
    COALESCE((prod_elem->>'quantity')::int, 1) AS quantity
  FROM projects p
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.packages, '[]'::jsonb)) AS pkg_elem
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pkg_elem->'products', '[]'::jsonb)) AS prod_elem
  WHERE p.id IN (SELECT project_id FROM onsite)
),
durations AS (
  SELECT
    n.project_id,
    n.product_id,
    COALESCE(
      (CASE WHEN n.pricing_tier = 'premium'
            THEN COALESCE(prod.premium_tier, prod.standard_tier)
            ELSE prod.standard_tier
       END->>'onsite_time')::numeric, 0
    ) +
    GREATEST(0, n.quantity - 1) *
    COALESCE(
      (CASE WHEN n.pricing_tier = 'premium'
            THEN COALESCE(prod.premium_tier, prod.standard_tier)
            ELSE prod.standard_tier
       END->>'onsite_time_increment')::numeric, 0
    ) AS mins
  FROM nested n
  JOIN products prod ON prod.id = n.product_id
),
ranked AS (
  SELECT project_id, product_id, mins,
    ROW_NUMBER() OVER (
      PARTITION BY project_id
      ORDER BY mins DESC NULLS LAST, product_id
    ) AS rnk
  FROM durations
  WHERE mins > 0
)
UPDATE project_tasks pt
SET product_id = r.product_id
FROM onsite o
JOIN ranked r ON r.project_id = o.project_id AND r.rnk = 1
WHERE pt.id = o.task_id;
