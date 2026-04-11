import React, { useState, useEffect, useMemo } from "react";
import { Cloud, Sun, CloudRain, CloudSnow, Wind, Thermometer, Droplets, Sunrise } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import WeatherHourlyBreakdown from "./WeatherHourlyBreakdown";
import { OPEN_METEO_FORECAST_URL, OPEN_METEO_GEOCODING_URL } from "@/lib/constants";

// WMO weather code to description + icon
function getWeatherInfo(code) {
  if (code === 0) return { label: "Clear sky", icon: Sun, color: "text-yellow-500" };
  if (code <= 2) return { label: "Partly cloudy", icon: Cloud, color: "text-blue-400" };
  if (code <= 3) return { label: "Overcast", icon: Cloud, color: "text-muted-foreground" };
  if (code <= 49) return { label: "Foggy", icon: Cloud, color: "text-muted-foreground" };
  if (code <= 59) return { label: "Drizzle", icon: CloudRain, color: "text-blue-400" };
  if (code <= 69) return { label: "Rain", icon: CloudRain, color: "text-blue-500" };
  if (code <= 79) return { label: "Snow", icon: CloudSnow, color: "text-blue-200" };
  if (code <= 84) return { label: "Rain showers", icon: CloudRain, color: "text-blue-500" };
  if (code <= 94) return { label: "Thunderstorm", icon: CloudRain, color: "text-purple-500" };
  return { label: "Stormy", icon: Wind, color: "text-muted-foreground" };
}

function extractSuburb(address) {
   if (!address) return null;
   // Extract suburb and state from address
   const STATE_RE = /^(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)(\s+\d{4})?$/i;
   const POSTCODE_RE = /^\d{4}$/;

   const parts = address.split(",").map(s => s.trim());
   let suburb = null;
   let state = null;

   // Work backwards; first non-state/postcode part is the suburb
   for (let i = parts.length - 1; i >= 0; i--) {
     const part = parts[i];
     // Check if this part contains state code
     const stateMatch = part.match(/\b(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)\b/i);
     if (stateMatch) {
       state = stateMatch[1].toUpperCase();
       // Remove state from part to get suburb
       const cleaned = part.replace(/\s+(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)(\s+\d{4})?$/i, "").trim();
       if (cleaned.length > 0 && !POSTCODE_RE.test(cleaned)) {
         suburb = cleaned;
       }
       break;
     }
   }

   // If no state found, still extract suburb
   if (!suburb) {
     for (let i = parts.length - 1; i >= 0; i--) {
       const part = parts[i];
       const cleaned = part.replace(/\s+\d{4}$/, "").trim();
       if (cleaned.length > 0 && !STATE_RE.test(cleaned) && !POSTCODE_RE.test(cleaned)) {
         suburb = cleaned;
         break;
       }
     }
   }

   return { suburb, state };
 }

function formatSunsetTime(isoString) {
  if (!isoString) return null;
  const date = new Date(isoString);
  return date.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: true });
}

export default function ProjectWeatherCard({ project, products = [], packages = [] }) {
  const [weather, setWeather] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showHourly, setShowHourly] = useState(false);

  // Detect if project has dusk/twilight products
  const hasDusk = React.useMemo(() => {
    const allProducts = [...(products || []), ...(packages || [])];
    return allProducts.some(p => {
      const name = (p.product_name || p.name || "").toLowerCase();
      return p.dusk_only || name.includes("dusk") || name.includes("twilight") || name.includes("sunset");
    });
  }, [products, packages]);

  const { suburb, state: addressState } = extractSuburb(project?.property_address) || { suburb: null, state: null };
  // Open-Meteo forecast only supports ±16 days; fall back to today outside that range
  const shootDate = React.useMemo(() => {
    const raw = project?.shoot_date;
    if (!raw) return new Date().toISOString().split("T")[0];
    const d = new Date(raw);
    if (isNaN(d.getTime())) return new Date().toISOString().split("T")[0];
    const today = new Date();
    const diffDays = (d - today) / 86400000;
    const dateOnly = d.toISOString().split("T")[0]; // "2026-04-09" — API needs date only, not timestamp
    if (diffDays > 15 || diffDays < -2) return today.toISOString().split("T")[0];
    return dateOnly;
  }, [project?.shoot_date]);

  useEffect(() => {
    if (!suburb) {
      setLoading(false);
      return;
    }

    // BUG FIX: use AbortController so both sequential fetches are cancelled on
    // unmount instead of completing in the background and leaking memory.
    const controller = new AbortController();

    async function fetchWeather() {
      setLoading(true);
      setError(null);
      try {
        // Step 1: Geocode suburb — include state + Australia for accuracy
        const searchTerm = [suburb, addressState, 'Australia'].filter(Boolean).join(' ');
        const geoRes = await fetch(
          `${OPEN_METEO_GEOCODING_URL}?name=${encodeURIComponent(searchTerm)}&count=10&language=en&format=json`,
          { signal: controller.signal }
        );
        const geoData = await geoRes.json();

        // Strictly prefer Australian results
        const results = geoData.results || [];
        let auResult = results.find(r => r.country_code === "AU" && r.admin1 === addressState);
        if (!auResult) {
          auResult = results.find(r => r.country_code === "AU");
        }
        // Fallback: use project's geocoded coordinates if suburb not in geocoder
        if (!auResult) {
          const projLat = project?.geocoded_lat || project?.latitude;
          const projLng = project?.geocoded_lng || project?.longitude;
          if (projLat && projLng) {
            auResult = { latitude: parseFloat(projLat), longitude: parseFloat(projLng), name: suburb, admin1: addressState };
          } else {
            if (!controller.signal.aborted) { setError("Location not found"); setLoading(false); }
            return;
          }
        }

        const { latitude, longitude, name, admin1 } = auResult;

        // Step 2: Fetch weather for shoot date
         const weatherRes = await fetch(
           `${OPEN_METEO_FORECAST_URL}?latitude=${latitude}&longitude=${longitude}` +
           `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,sunset` +
           `&timezone=Australia%2FSydney&start_date=${shootDate}&end_date=${shootDate}`,
           { signal: controller.signal }
         );
         const weatherData = await weatherRes.json();

         if (!controller.signal.aborted && weatherData.daily) {
           const d = weatherData.daily;
           setWeather({
             suburb: name,
             state: admin1,
             latitude,
             longitude,
             code: d.weather_code[0],
             tempMax: Math.round(d.temperature_2m_max[0]),
             tempMin: Math.round(d.temperature_2m_min[0]),
             rain: d.precipitation_sum[0],
             wind: Math.round(d.wind_speed_10m_max[0]),
             sunset: d.sunset[0],
           });
         }
      } catch (e) {
        if (!controller.signal.aborted) setError("Weather unavailable");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    fetchWeather();
    return () => { controller.abort(); };
  }, [suburb, shootDate]);

  if (!suburb) return null;

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg bg-sky-50 border border-sky-200 text-xs text-sky-600 animate-pulse">
        <Cloud className="h-4 w-4" />
        Loading weather for {suburb}...
      </div>
    );
  }

  if (error || !weather) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 border text-xs text-muted-foreground/70">
        <Cloud className="h-4 w-4" />
        Weather unavailable for {suburb}
      </div>
    );
  }

  const { icon: WeatherIcon, label: weatherLabel, color: iconColor } = getWeatherInfo(weather.code);
  const sunsetTime = formatSunsetTime(weather.sunset);

  return (
    <Card className={`${hasDusk ? "bg-orange-50 border-orange-200" : "bg-sky-50 border-sky-200"}`}>
      <CardContent className="p-4 space-y-3">
        {/* Summary row */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <WeatherIcon className={`h-5 w-5 flex-shrink-0 ${iconColor}`} />
            <div className="min-w-0">
              <span className="font-semibold text-foreground">{weather.suburb}{weather.state ? `, ${weather.state}` : ""}</span>
              <span className="text-muted-foreground ml-1.5 text-xs">{weatherLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap tabular-nums">
            <div className="flex items-center gap-1">
              <Thermometer className="h-3.5 w-3.5 text-red-400" />
              <span className="font-medium">{weather.tempMax}°C</span>
              <span className="text-muted-foreground/70">/ {weather.tempMin}°C</span>
            </div>

            {weather.rain > 0 && (
              <div className="flex items-center gap-1">
                <Droplets className="h-3.5 w-3.5 text-blue-400" />
                <span>{weather.rain}mm</span>
              </div>
            )}

            <div className="flex items-center gap-1">
              <Wind className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{weather.wind} km/h</span>
            </div>

            {hasDusk && sunsetTime && (
              <div className="flex items-center gap-1 font-semibold text-orange-600 bg-orange-100 px-2 py-0.5 rounded-full">
                <Sunrise className="h-3.5 w-3.5" />
                Sunset {sunsetTime}
              </div>
            )}
          </div>
        </div>

        {/* Hourly breakdown toggle & content */}
        <div className="border-t pt-3">
          <button
            onClick={() => setShowHourly(!showHourly)}
            className="text-xs font-semibold text-primary hover:text-primary/80 transition-colors mb-2 cursor-pointer focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:outline-none rounded"
            aria-expanded={showHourly}
            title={showHourly ? "Hide hourly weather breakdown" : "Show hourly weather breakdown"}
          >
            {showHourly ? "▼ Hide" : "▶ Show"} Hourly Breakdown
          </button>
          {showHourly && (
            <WeatherHourlyBreakdown
              latitude={weather.latitude}
              longitude={weather.longitude}
              shootDate={shootDate}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}