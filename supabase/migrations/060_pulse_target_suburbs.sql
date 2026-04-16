-- 060: Shared suburb pool for Industry Pulse data sources
-- One global list of target suburbs that all scrapers pull from

CREATE TABLE IF NOT EXISTS pulse_target_suburbs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'NSW',
  postcode TEXT,
  region TEXT, -- e.g. "Inner West", "Canterbury-Bankstown", "Strathfield"
  is_active BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 0, -- higher = scraped first
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(name, state)
);

ALTER TABLE pulse_target_suburbs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_full_access" ON pulse_target_suburbs FOR ALL USING (auth.uid() IS NOT NULL);
ALTER PUBLICATION supabase_realtime ADD TABLE pulse_target_suburbs;

CREATE INDEX IF NOT EXISTS idx_pulse_target_suburbs_active ON pulse_target_suburbs(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_pulse_target_suburbs_region ON pulse_target_suburbs(region);

-- Seed Greater Sydney suburbs by region (current targets + expansion)
INSERT INTO pulse_target_suburbs (name, state, region, is_active, priority) VALUES
  -- Strathfield / Inner West core (existing)
  ('Strathfield', 'NSW', 'Strathfield', true, 10),
  ('Burwood', 'NSW', 'Inner West', true, 10),
  ('Homebush', 'NSW', 'Strathfield', true, 9),
  ('Croydon Park', 'NSW', 'Inner West', true, 8),
  ('Concord', 'NSW', 'Inner West', true, 7),
  ('Concord West', 'NSW', 'Inner West', true, 5),
  ('North Strathfield', 'NSW', 'Strathfield', true, 7),
  ('Strathfield South', 'NSW', 'Strathfield', true, 6),
  ('Homebush West', 'NSW', 'Strathfield', true, 6),
  ('Belfield', 'NSW', 'Inner West', true, 5),
  ('Enfield', 'NSW', 'Inner West', true, 5),
  ('Croydon', 'NSW', 'Inner West', true, 6),
  ('Ashfield', 'NSW', 'Inner West', true, 7),
  ('Summer Hill', 'NSW', 'Inner West', true, 5),
  ('Five Dock', 'NSW', 'Inner West', true, 6),
  ('Drummoyne', 'NSW', 'Inner West', true, 6),
  ('Leichhardt', 'NSW', 'Inner West', true, 6),
  ('Marrickville', 'NSW', 'Inner West', true, 6),
  ('Dulwich Hill', 'NSW', 'Inner West', true, 5),
  ('Petersham', 'NSW', 'Inner West', true, 5),

  -- Canterbury-Bankstown (existing)
  ('Bankstown', 'NSW', 'Canterbury-Bankstown', true, 9),
  ('Canterbury', 'NSW', 'Canterbury-Bankstown', true, 8),
  ('Punchbowl', 'NSW', 'Canterbury-Bankstown', true, 8),
  ('Lakemba', 'NSW', 'Canterbury-Bankstown', true, 7),
  ('Campsie', 'NSW', 'Canterbury-Bankstown', true, 8),
  ('Roselands', 'NSW', 'Canterbury-Bankstown', true, 5),
  ('Belmore', 'NSW', 'Canterbury-Bankstown', true, 6),
  ('Wiley Park', 'NSW', 'Canterbury-Bankstown', true, 4),
  ('Revesby', 'NSW', 'Canterbury-Bankstown', true, 6),
  ('Padstow', 'NSW', 'Canterbury-Bankstown', true, 5),
  ('Panania', 'NSW', 'Canterbury-Bankstown', true, 4),
  ('Bass Hill', 'NSW', 'Canterbury-Bankstown', true, 4),
  ('Yagoona', 'NSW', 'Canterbury-Bankstown', true, 5),
  ('Greenacre', 'NSW', 'Canterbury-Bankstown', true, 6),
  ('Earlwood', 'NSW', 'Canterbury-Bankstown', true, 6),
  ('Kingsgrove', 'NSW', 'Canterbury-Bankstown', true, 5),
  ('Beverly Hills', 'NSW', 'Canterbury-Bankstown', true, 5),

  -- Parramatta / Western Sydney
  ('Parramatta', 'NSW', 'Parramatta', true, 8),
  ('Harris Park', 'NSW', 'Parramatta', true, 5),
  ('Granville', 'NSW', 'Parramatta', true, 6),
  ('Merrylands', 'NSW', 'Parramatta', true, 6),
  ('Guildford', 'NSW', 'Parramatta', true, 5),
  ('Auburn', 'NSW', 'Parramatta', true, 7),
  ('Lidcombe', 'NSW', 'Parramatta', true, 7),
  ('Berala', 'NSW', 'Parramatta', true, 5),
  ('Regents Park', 'NSW', 'Parramatta', true, 5),
  ('Westmead', 'NSW', 'Parramatta', true, 5),
  ('Wentworthville', 'NSW', 'Parramatta', true, 5),
  ('Toongabbie', 'NSW', 'Parramatta', true, 4),
  ('Pendle Hill', 'NSW', 'Parramatta', true, 4),
  ('Silverwater', 'NSW', 'Parramatta', true, 4),
  ('Newington', 'NSW', 'Parramatta', true, 5),
  ('Wentworth Point', 'NSW', 'Parramatta', true, 5),
  ('Olympic Park', 'NSW', 'Parramatta', true, 4),

  -- Eastern Suburbs
  ('Bondi', 'NSW', 'Eastern Suburbs', true, 7),
  ('Bondi Junction', 'NSW', 'Eastern Suburbs', true, 7),
  ('Randwick', 'NSW', 'Eastern Suburbs', true, 7),
  ('Coogee', 'NSW', 'Eastern Suburbs', true, 6),
  ('Maroubra', 'NSW', 'Eastern Suburbs', true, 6),
  ('Double Bay', 'NSW', 'Eastern Suburbs', true, 6),
  ('Paddington', 'NSW', 'Eastern Suburbs', true, 6),
  ('Woollahra', 'NSW', 'Eastern Suburbs', true, 5),
  ('Bronte', 'NSW', 'Eastern Suburbs', true, 5),
  ('Rose Bay', 'NSW', 'Eastern Suburbs', true, 5),
  ('Kensington', 'NSW', 'Eastern Suburbs', true, 5),

  -- North Shore
  ('Chatswood', 'NSW', 'North Shore', true, 8),
  ('Lane Cove', 'NSW', 'North Shore', true, 6),
  ('Willoughby', 'NSW', 'North Shore', true, 6),
  ('Crows Nest', 'NSW', 'North Shore', true, 6),
  ('North Sydney', 'NSW', 'North Shore', true, 7),
  ('Mosman', 'NSW', 'North Shore', true, 7),
  ('Neutral Bay', 'NSW', 'North Shore', true, 5),
  ('Cremorne', 'NSW', 'North Shore', true, 5),
  ('Lindfield', 'NSW', 'North Shore', true, 5),
  ('Roseville', 'NSW', 'North Shore', true, 5),
  ('Gordon', 'NSW', 'North Shore', true, 5),
  ('Killara', 'NSW', 'North Shore', true, 5),
  ('Pymble', 'NSW', 'North Shore', true, 5),
  ('Turramurra', 'NSW', 'North Shore', true, 5),
  ('Wahroonga', 'NSW', 'North Shore', true, 4),
  ('Hornsby', 'NSW', 'North Shore', true, 5),
  ('St Leonards', 'NSW', 'North Shore', true, 6),

  -- Northern Beaches
  ('Manly', 'NSW', 'Northern Beaches', true, 7),
  ('Dee Why', 'NSW', 'Northern Beaches', true, 6),
  ('Brookvale', 'NSW', 'Northern Beaches', true, 5),
  ('Mona Vale', 'NSW', 'Northern Beaches', true, 5),
  ('Freshwater', 'NSW', 'Northern Beaches', true, 5),
  ('Narrabeen', 'NSW', 'Northern Beaches', true, 4),
  ('Avalon', 'NSW', 'Northern Beaches', true, 4),
  ('Collaroy', 'NSW', 'Northern Beaches', true, 4),
  ('Curl Curl', 'NSW', 'Northern Beaches', true, 4),

  -- South Sydney / St George
  ('Hurstville', 'NSW', 'St George', true, 7),
  ('Kogarah', 'NSW', 'St George', true, 6),
  ('Rockdale', 'NSW', 'St George', true, 6),
  ('Carlton', 'NSW', 'St George', true, 4),
  ('Sans Souci', 'NSW', 'St George', true, 5),
  ('Bexley', 'NSW', 'St George', true, 5),
  ('Arncliffe', 'NSW', 'St George', true, 5),
  ('Penshurst', 'NSW', 'St George', true, 5),
  ('Mortdale', 'NSW', 'St George', true, 4),
  ('Oatley', 'NSW', 'St George', true, 4),
  ('Peakhurst', 'NSW', 'St George', true, 4),

  -- Sutherland Shire
  ('Sutherland', 'NSW', 'Sutherland Shire', true, 6),
  ('Cronulla', 'NSW', 'Sutherland Shire', true, 6),
  ('Miranda', 'NSW', 'Sutherland Shire', true, 6),
  ('Caringbah', 'NSW', 'Sutherland Shire', true, 5),
  ('Engadine', 'NSW', 'Sutherland Shire', true, 4),
  ('Menai', 'NSW', 'Sutherland Shire', true, 4),
  ('Kirrawee', 'NSW', 'Sutherland Shire', true, 4),
  ('Gymea', 'NSW', 'Sutherland Shire', true, 4),

  -- Hills District
  ('Castle Hill', 'NSW', 'Hills District', true, 7),
  ('Baulkham Hills', 'NSW', 'Hills District', true, 6),
  ('Bella Vista', 'NSW', 'Hills District', true, 5),
  ('Kellyville', 'NSW', 'Hills District', true, 5),
  ('Rouse Hill', 'NSW', 'Hills District', true, 5),
  ('Norwest', 'NSW', 'Hills District', true, 4),
  ('Cherrybrook', 'NSW', 'Hills District', true, 4),
  ('Carlingford', 'NSW', 'Hills District', true, 5),
  ('Epping', 'NSW', 'Hills District', true, 6),
  ('Eastwood', 'NSW', 'Hills District', true, 6),

  -- Ryde
  ('Ryde', 'NSW', 'Ryde', true, 6),
  ('Gladesville', 'NSW', 'Ryde', true, 5),
  ('Meadowbank', 'NSW', 'Ryde', true, 5),
  ('West Ryde', 'NSW', 'Ryde', true, 5),
  ('Macquarie Park', 'NSW', 'Ryde', true, 5),
  ('North Ryde', 'NSW', 'Ryde', true, 5),
  ('Putney', 'NSW', 'Ryde', true, 4),

  -- Sydney CBD + surrounds
  ('Sydney', 'NSW', 'CBD', true, 7),
  ('Surry Hills', 'NSW', 'CBD', true, 6),
  ('Darlinghurst', 'NSW', 'CBD', true, 5),
  ('Potts Point', 'NSW', 'CBD', true, 5),
  ('Pyrmont', 'NSW', 'CBD', true, 5),
  ('Ultimo', 'NSW', 'CBD', true, 4),
  ('Redfern', 'NSW', 'CBD', true, 5),
  ('Waterloo', 'NSW', 'CBD', true, 5),
  ('Zetland', 'NSW', 'CBD', true, 5),
  ('Alexandria', 'NSW', 'CBD', true, 5),
  ('Mascot', 'NSW', 'CBD', true, 5),
  ('Rosebery', 'NSW', 'CBD', true, 5),
  ('Newtown', 'NSW', 'CBD', true, 6),
  ('Erskineville', 'NSW', 'CBD', true, 5),
  ('Glebe', 'NSW', 'CBD', true, 5),

  -- Liverpool / South-West
  ('Liverpool', 'NSW', 'South-West', true, 7),
  ('Cabramatta', 'NSW', 'South-West', true, 5),
  ('Fairfield', 'NSW', 'South-West', true, 6),
  ('Wetherill Park', 'NSW', 'South-West', true, 4),
  ('Campbelltown', 'NSW', 'South-West', true, 6),
  ('Ingleburn', 'NSW', 'South-West', true, 4),
  ('Leppington', 'NSW', 'South-West', true, 4),
  ('Prestons', 'NSW', 'South-West', true, 4),
  ('Hoxton Park', 'NSW', 'South-West', true, 4),
  ('Casula', 'NSW', 'South-West', true, 4),

  -- Blacktown / North-West
  ('Blacktown', 'NSW', 'North-West', true, 6),
  ('Seven Hills', 'NSW', 'North-West', true, 5),
  ('Doonside', 'NSW', 'North-West', true, 4),
  ('Rooty Hill', 'NSW', 'North-West', true, 4),
  ('Mt Druitt', 'NSW', 'North-West', true, 4),
  ('Quakers Hill', 'NSW', 'North-West', true, 4),
  ('Marsden Park', 'NSW', 'North-West', true, 4),
  ('Schofields', 'NSW', 'North-West', true, 4),
  ('Riverstone', 'NSW', 'North-West', true, 4),

  -- Penrith / Far West
  ('Penrith', 'NSW', 'Far West', true, 5),
  ('Kingswood', 'NSW', 'Far West', true, 4),
  ('St Marys', 'NSW', 'Far West', true, 4),
  ('Emu Plains', 'NSW', 'Far West', true, 3),
  ('Glenmore Park', 'NSW', 'Far West', true, 4),
  ('Jordan Springs', 'NSW', 'Far West', true, 3)
ON CONFLICT (name, state) DO NOTHING;
