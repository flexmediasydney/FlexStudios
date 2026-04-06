// ─── Time constants ──────────────────────────────────────────────────────────
export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR   = 60 * MS_PER_MINUTE;
export const MS_PER_DAY    = 24 * MS_PER_HOUR;
export const MS_PER_WEEK   = 7 * MS_PER_DAY;

// ─── Open-Meteo weather API ─────────────────────────────────────────────────
export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const OPEN_METEO_GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';

// ─── Leaflet map assets (shared by ProjectHeatmap + TerritoryMap) ───────────
export const LEAFLET_CDN_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images';
export const LEAFLET_ICON_OPTIONS = {
  iconRetinaUrl: `${LEAFLET_CDN_BASE}/marker-icon-2x.png`,
  iconUrl:       `${LEAFLET_CDN_BASE}/marker-icon.png`,
  shadowUrl:     `${LEAFLET_CDN_BASE}/marker-shadow.png`,
};

// ─── Real estate portal URLs ────────────────────────────────────────────────
export const DOMAIN_AGENT_URL = 'https://www.domain.com.au/agent';
export const REA_AGENT_URL    = 'https://www.realestate.com.au/agent';

// ─── Business email / calendar identifiers ──────────────────────────────────
export const TONOMO_MASTER_CALENDAR_EMAIL = 'info@flexmedia.sydney';
