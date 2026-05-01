-- Migration 391 — Wave 11.6.7 P1-3: shortlisting_room_types admin table.
--
-- Origin: docs/WAVE_7_BACKLOG.md L183-201. Adds an admin-editable, versioned
-- table that mirrors the static taxonomy block. A new W7.6 dynamic block
-- (`roomTypesFromDb.ts`) reads this table cached 60s and renders the prompt
-- block on demand. The static `roomTypeTaxonomy.ts` block remains as a
-- fallback when the DB read fails. Seeded from the canonical 40-row taxonomy.

BEGIN;

CREATE TABLE IF NOT EXISTS public.shortlisting_room_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  detection_hints TEXT[] NOT NULL DEFAULT '{}',
  category TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INT NOT NULL DEFAULT 1,
  created_by UUID,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.shortlisting_room_types IS
  'Wave 11.6.7 P1-3: admin-editable room_type taxonomy. Stage 1 reads dynamic block from here (60s cache); static TS block remains as fallback.';

CREATE INDEX IF NOT EXISTS idx_shortlisting_room_types_active
  ON public.shortlisting_room_types (is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_shortlisting_room_types_category
  ON public.shortlisting_room_types (category) WHERE is_active = TRUE;

CREATE OR REPLACE FUNCTION public.shortlisting_room_types_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shortlisting_room_types_updated_at_t ON public.shortlisting_room_types;
CREATE TRIGGER shortlisting_room_types_updated_at_t
  BEFORE UPDATE ON public.shortlisting_room_types
  FOR EACH ROW EXECUTE FUNCTION public.shortlisting_room_types_set_updated_at();

ALTER TABLE public.shortlisting_room_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shortlisting_room_types_read ON public.shortlisting_room_types;
CREATE POLICY shortlisting_room_types_read ON public.shortlisting_room_types
  FOR SELECT USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

DROP POLICY IF EXISTS shortlisting_room_types_write ON public.shortlisting_room_types;
CREATE POLICY shortlisting_room_types_write ON public.shortlisting_room_types
  FOR ALL
  USING (auth.role() = 'service_role' OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'master_admin'))
  WITH CHECK (auth.role() = 'service_role' OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'master_admin'));

INSERT INTO public.shortlisting_room_types (key, display_name, description, category, detection_hints) VALUES
  ('interior_open_plan', 'Interior — open plan', 'Combined kitchen/living/dining shot in an open-plan layout.', 'interior_living', ARRAY['kitchen', 'living', 'dining', 'open plan']),
  ('kitchen_main', 'Kitchen — main', 'Primary kitchen with island, benches and cooking zone.', 'interior_living', ARRAY['benchtop', 'island', 'cooktop']),
  ('kitchen_scullery', 'Kitchen — scullery', 'Butler''s pantry / prep kitchen behind the main kitchen.', 'interior_living', ARRAY['scullery', 'butler', 'prep kitchen']),
  ('living_room', 'Living room', 'Primary lounge / living zone (downstairs / main floor).', 'interior_living', ARRAY['sofa', 'lounge', 'TV unit']),
  ('living_secondary', 'Living — secondary', 'Upstairs lounge, sitting room, rumpus, or any secondary living zone.', 'interior_living', ARRAY['rumpus', 'sitting room', 'upstairs lounge']),
  ('dining_room', 'Dining room', 'Formal or standalone dining space (separate from open plan).', 'interior_living', ARRAY['dining table', 'pendant', 'sideboard']),
  ('master_bedroom', 'Master bedroom', 'Primary bedroom — typically largest, often with WIR + ensuite.', 'interior_private', ARRAY['king bed', 'master', 'wir']),
  ('bedroom_secondary', 'Bedroom — secondary', 'Any non-master bedroom (children, guest, study/bed combo).', 'interior_private', ARRAY['bedroom', 'queen', 'single']),
  ('ensuite_primary', 'Ensuite — primary', 'Master bedroom ensuite.', 'interior_private', ARRAY['ensuite', 'double vanity']),
  ('ensuite_secondary', 'Ensuite — secondary', 'Secondary bedroom ensuite.', 'interior_private', ARRAY['secondary ensuite', 'guest ensuite']),
  ('bathroom', 'Bathroom', 'Common / family bathroom (shared, not ensuite).', 'interior_private', ARRAY['bathtub', 'vanity', 'shower']),
  ('wir_wardrobe', 'WIR / wardrobe', 'Walk-in robe or built-in wardrobe shot.', 'interior_private', ARRAY['walk in robe', 'wardrobe']),
  ('study_office', 'Study / office', 'Home office or study nook.', 'interior_living', ARRAY['desk', 'study', 'office']),
  ('laundry', 'Laundry', 'Laundry / utility room.', 'interior_living', ARRAY['laundry tub', 'washing machine']),
  ('entry_foyer', 'Entry / foyer', 'Front door entrance, foyer, mudroom.', 'interior_circulation', ARRAY['entry', 'foyer', 'front door']),
  ('staircase', 'Staircase', 'Stairs / stairwell — internal vertical circulation.', 'interior_circulation', ARRAY['staircase', 'balustrade']),
  ('hallway_corridor', 'Hallway / corridor', 'Internal horizontal circulation — generally narrow.', 'interior_circulation', ARRAY['hallway', 'corridor']),
  ('home_cinema', 'Home cinema', 'Dedicated home theatre / media room.', 'interior_special', ARRAY['cinema', 'projector', 'theatre']),
  ('games_room', 'Games room', 'Dedicated games / billiards / activity room.', 'interior_special', ARRAY['games', 'pool table', 'billiards']),
  ('gymnasium', 'Gymnasium', 'Home gym — equipment + mirrors + flooring.', 'interior_special', ARRAY['gym', 'treadmill', 'weights']),
  ('wine_cellar', 'Wine cellar', 'Dedicated wine storage / tasting room.', 'interior_special', ARRAY['wine cellar', 'wine rack']),
  ('garage_showcase', 'Garage — showcase', 'Showcase garage — gallery-style finishes, EV chargers.', 'utility', ARRAY['showcase garage', 'EV charger']),
  ('garage_standard', 'Garage — standard', 'Standard garage / carport.', 'utility', ARRAY['garage', 'carport', 'roller door']),
  ('alfresco', 'Alfresco', 'Covered outdoor entertaining adjacent to the home.', 'exterior_living', ARRAY['alfresco', 'pergola']),
  ('pool_area', 'Pool area', 'Swimming pool + surround / coping / cabana.', 'exterior_living', ARRAY['pool', 'spa', 'cabana']),
  ('outdoor_kitchen', 'Outdoor kitchen', 'Built-in outdoor kitchen / BBQ zone.', 'exterior_living', ARRAY['outdoor kitchen', 'BBQ']),
  ('courtyard_internal', 'Courtyard — internal', 'Internal courtyard / lightwell.', 'exterior_living', ARRAY['courtyard', 'lightwell']),
  ('balcony_terrace', 'Balcony / terrace', 'Elevated outdoor space — balcony, terrace, deck.', 'exterior_living', ARRAY['balcony', 'terrace', 'deck']),
  ('exterior_front', 'Exterior — front', 'Front facade / streetscape.', 'exterior_facade', ARRAY['front facade', 'streetscape']),
  ('exterior_rear', 'Exterior — rear', 'Rear of house viewed from yard / garden.', 'exterior_facade', ARRAY['rear facade', 'backyard']),
  ('exterior_side', 'Exterior — side', 'Side of house — typically a service corridor or garden path.', 'exterior_facade', ARRAY['side path', 'side garden']),
  ('exterior_detail', 'Exterior — detail', 'Architectural detail outside — cladding, eave, fence.', 'exterior_facade', ARRAY['detail', 'cladding', 'eave']),
  ('drone_contextual', 'Drone — contextual', 'High-altitude drone shot showing the property in setting.', 'aerial', ARRAY['aerial', 'drone', 'high altitude']),
  ('drone_nadir', 'Drone — nadir', 'Top-down drone shot (90° gimbal).', 'aerial', ARRAY['nadir', 'top down']),
  ('drone_oblique', 'Drone — oblique', 'Angled drone shot (30-60° gimbal pitch).', 'aerial', ARRAY['oblique drone', 'angled aerial']),
  ('floorplan', 'Floorplan', 'Floorplan diagram (not a photograph).', 'reference', ARRAY['floorplan', 'plan view']),
  ('detail_material', 'Detail — material', 'Close-up of a material (timber, stone, fabric).', 'detail', ARRAY['material detail', 'texture']),
  ('detail_lighting', 'Detail — lighting', 'Close-up of a light fitting / pendant / sconce.', 'detail', ARRAY['pendant', 'sconce']),
  ('lifestyle_vehicle', 'Lifestyle — vehicle', 'Vehicle (boat, car, motorbike) staged with property.', 'lifestyle', ARRAY['boat', 'car', 'lifestyle']),
  ('special_feature', 'Special feature', 'Catch-all for one-off features (sauna, observatory, etc.).', 'interior_special', ARRAY['feature', 'unique'])
ON CONFLICT (key) DO NOTHING;

COMMIT;
