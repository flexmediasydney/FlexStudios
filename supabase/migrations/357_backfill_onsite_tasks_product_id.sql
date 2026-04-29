-- Onsite tasks were previously created at the project level (no product_id /
-- package_id). They belong on the product (or package) whose onsite_time drove
-- the duration. After 356 the runtime function (syncOnsiteEffortTasks) sets
-- the FK going forward; this one-time backfill migrates existing rows so the
-- TaskListView grouping doesn't dump them into "Project-level tasks".
--
-- Heuristic: pick the product on the project with the longest computed onsite
-- duration (base + (qty-1) * increment) under the project's pricing tier. Ties
-- broken by product_id for determinism. Projects whose onsite was driven by a
-- package's scheduling_time aren't reachable from product templates here, so
-- those tasks stay project-level until the function re-syncs them on the next
-- pricing save.

WITH onsite AS (
  SELECT pt.id AS task_id, pt.project_id
  FROM project_tasks pt
  WHERE pt.template_id LIKE 'onsite:%'
    AND pt.product_id IS NULL
    AND pt.package_id IS NULL
    AND pt.is_deleted = false
),
proj_products AS (
  SELECT
    p.id AS project_id,
    p.pricing_tier,
    (elem->>'product_id')::uuid AS product_id,
    COALESCE((elem->>'quantity')::int, 1) AS quantity
  FROM projects p
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.products, '[]'::jsonb)) AS elem
  WHERE p.id IN (SELECT project_id FROM onsite)
),
durations AS (
  SELECT
    pp.project_id,
    pp.product_id,
    COALESCE(
      (CASE WHEN pp.pricing_tier = 'premium'
            THEN COALESCE(prod.premium_tier, prod.standard_tier)
            ELSE prod.standard_tier
       END->>'onsite_time')::numeric, 0
    ) +
    GREATEST(0, pp.quantity - 1) *
    COALESCE(
      (CASE WHEN pp.pricing_tier = 'premium'
            THEN COALESCE(prod.premium_tier, prod.standard_tier)
            ELSE prod.standard_tier
       END->>'onsite_time_increment')::numeric, 0
    ) AS mins
  FROM proj_products pp
  JOIN products prod ON prod.id = pp.product_id
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
