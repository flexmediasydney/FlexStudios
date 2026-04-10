import React from "react";
import { Cloud, Sun, CloudRain, CloudSnow, Wind, AlertCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { OPEN_METEO_FORECAST_URL } from "@/lib/constants";

// WMO weather code to description + icon (same as parent)
function getWeatherInfo(code) {
  if (code === 0) return { label: "Clear", icon: Sun, color: "text-yellow-500" };
  if (code <= 2) return { label: "Partly cloudy", icon: Cloud, color: "text-blue-400" };
  if (code <= 3) return { label: "Overcast", icon: Cloud, color: "text-gray-400" };
  if (code <= 49) return { label: "Foggy", icon: Cloud, color: "text-gray-400" };
  if (code <= 59) return { label: "Drizzle", icon: CloudRain, color: "text-blue-400" };
  if (code <= 69) return { label: "Rain", icon: CloudRain, color: "text-blue-500" };
  if (code <= 79) return { label: "Snow", icon: CloudSnow, color: "text-blue-200" };
  if (code <= 84) return { label: "Showers", icon: CloudRain, color: "text-blue-500" };
  if (code <= 94) return { label: "Thunder", icon: CloudRain, color: "text-purple-500" };
  return { label: "Stormy", icon: Wind, color: "text-gray-600" };
}

export default function WeatherHourlyBreakdown({ latitude, longitude, shootDate }) {
  const [hours, setHours] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    if (!latitude || !longitude || !shootDate) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();

    async function fetchHourly() {
      setLoading(true);
      setError(null);
      try {
        // BUG FIX: use AbortController so the fetch is cancelled on unmount
        // instead of completing in the background and leaking memory.
        const res = await fetch(
          `${OPEN_METEO_FORECAST_URL}?latitude=${latitude}&longitude=${longitude}` +
          `&hourly=temperature_2m,weather_code,precipitation,precipitation_probability` +
          `&timezone=Australia%2FSydney&start_date=${shootDate}&end_date=${shootDate}`,
          { signal: controller.signal }
        );
        const data = await res.json();

        if (!controller.signal.aborted && data.hourly) {
          const h = data.hourly;
          const hourlyData = [];
          // Extract 8am to 9pm (hours 8-21 inclusive)
          for (let hr = 8; hr <= 21; hr++) {
            hourlyData.push({
              hour: hr,
              temp: Math.round(h.temperature_2m[hr]),
              weatherCode: h.weather_code[hr],
              precipitation: h.precipitation[hr] || 0,
              precipProbability: h.precipitation_probability[hr] || 0,
            });
          }
          setHours(hourlyData);
        }
      } catch (e) {
        if (!controller.signal.aborted) setError("Unable to load hourly forecast");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    fetchHourly();
    return () => { controller.abort(); };
  }, [latitude, longitude, shootDate]);

  if (loading) {
    return (
      <div className="text-xs text-muted-foreground text-center py-2">
        Loading hourly forecast...
      </div>
    );
  }

  if (error || !hours || hours.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <AlertCircle className="h-3.5 w-3.5" />
        {error || "No hourly data available"}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-muted-foreground">Hourly (8AM – 9PM)</p>
      <div className="flex gap-1 overflow-x-auto pb-1">
        {hours.map(({ hour, temp, weatherCode, precipitation, precipProbability }) => {
          const { icon: Icon, color } = getWeatherInfo(weatherCode);
          const showPrecip = precipProbability > 0 || precipitation > 0;

          return (
            <div
              key={hour}
              className="flex flex-col items-center gap-0.5 px-1.5 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-[11px] flex-shrink-0"
            >
              <span className="font-semibold text-foreground">{hour}h</span>
              <Icon className={`h-3 w-3 ${color}`} />
              <span className="font-medium text-foreground">{temp}°</span>
              {showPrecip ? (
                <span className="text-blue-500 font-medium text-[9px]">{precipProbability}%</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}