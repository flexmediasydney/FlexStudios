-- 065: Tonomo workDays fee mappings
-- Maps Tonomo's workDays[].feeName values to FlexMedia Surcharge products.
-- Tonomo emits these for weekend/day-specific shoot fees at the top level of
-- the webhook payload (separate from services/service_custom_tiers).

INSERT INTO tonomo_mapping_tables (
  mapping_type, tonomo_id, tonomo_label,
  flexmedia_entity_type, flexmedia_entity_id, flexmedia_label,
  is_confirmed, confidence, auto_suggested, seen_count,
  created_at, updated_at
)
VALUES
  ('workday_fee', 'Saturday Fee', 'Saturday Fee',
   'Product', '30000000-0000-4000-a000-000000000041', 'Saturday Surcharge',
   true, 'high', false, 0,
   now(), now()),
  ('workday_fee', 'Sunday Fee', 'Sunday Fee',
   'Product', 'b2e68671-1d70-4bc2-b4c5-17614be4d7a2', 'Sunday Surcharge',
   true, 'high', false, 0,
   now(), now())
ON CONFLICT DO NOTHING;
