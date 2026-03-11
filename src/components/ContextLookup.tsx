import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { JsonViewer } from "./JsonViewer";

interface WeatherDay {
  temperature_2m_max?: number[];
  temperature_2m_min?: number[];
  precipitation_sum?: number[];
  weathercode?: number[];
  windspeed_10m_max?: number[];
}

interface ContextResponse {
  date: string;
  weather?: {
    daily?: WeatherDay;
  } | null;
  earthquakes?: {
    count?: number;
    max_magnitude?: number;
    avg_magnitude?: number;
    largest_location?: string;
  } | null;
  sunrise?: {
    sunrise?: string;
    sunset?: string;
    day_length_hours?: number;
  } | null;
  lunar?: {
    phase?: string;
    illumination?: number;
    emoji?: string;
    days_into_cycle?: number;
  } | null;
  // Some API versions return these at the top level
  temperature_max?: number;
  temperature_min?: number;
  weathercode?: number;
  precipitation?: number;
  windspeed?: number;
  sunrise_time?: string;
  sunset_time?: string;
  day_length?: number;
  lunar_phase?: string;
  lunar_illumination?: number;
  lunar_emoji?: string;
  earthquake_count?: number;
  earthquake_max_magnitude?: number;
  earthquake_largest_location?: string;
}

const WEATHER_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Slight snowfall",
  73: "Moderate snowfall",
  75: "Heavy snowfall",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

export function ContextLookup() {
  const [date, setDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const context = useApi<ContextResponse>();

  const handleLookup = () => {
    context.fetchData(`/api/context/${date}`);
  };

  // Normalise data: support both nested and flat API response shapes
  const d = context.data;
  const lunarData = d?.lunar ?? (d?.lunar_phase ? {
    phase: d.lunar_phase,
    illumination: d.lunar_illumination,
    emoji: d.lunar_emoji,
  } : null);

  const weatherData = d?.weather?.daily ?? (d?.temperature_max != null ? {
    temperature_2m_max: [d.temperature_max],
    temperature_2m_min: d.temperature_min != null ? [d.temperature_min] : undefined,
    weathercode: d.weathercode != null ? [d.weathercode] : undefined,
    precipitation_sum: d.precipitation != null ? [d.precipitation] : undefined,
    windspeed_10m_max: d.windspeed != null ? [d.windspeed] : undefined,
  } as WeatherDay : null);

  const sunriseData = d?.sunrise ?? (d?.sunrise_time ? {
    sunrise: d.sunrise_time,
    sunset: d.sunset_time,
    day_length_hours: d.day_length,
  } : null);

  const earthquakeData = d?.earthquakes ?? (d?.earthquake_count != null ? {
    count: d.earthquake_count,
    max_magnitude: d.earthquake_max_magnitude,
    largest_location: d.earthquake_largest_location,
  } : null);

  const hasAnyData = lunarData || weatherData || sunriseData || earthquakeData;

  return (
    <div className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider mb-3">
          Cosmic Context Lookup
        </h2>
        <p className="text-xs text-vibe-dim mb-3">
          Enter a date to see the cosmic, meteorological, and seismic conditions.
          This is the correlation layer — the vibe of any given day.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="date"
            className="input flex-1"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <button onClick={handleLookup} className="btn btn-primary">
            Check Vibes
          </button>
        </div>
      </div>

      {context.loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card">
              <div className="shimmer h-4 w-32 mb-3" />
              <div className="shimmer h-8 w-20 mb-2" />
              <div className="shimmer h-3 w-40" />
            </div>
          ))}
        </div>
      )}

      {context.error && (
        <div className="card border-vibe-nay/30">
          <p className="text-sm text-vibe-nay">{context.error}</p>
        </div>
      )}

      {context.data && (
        <>
          <div className="card border-vibe-accent/30 text-center py-6">
            <p className="text-xs text-vibe-dim uppercase tracking-widest mb-2">
              Conditions Report
            </p>
            <p className="text-2xl font-bold">{context.data.date}</p>
            <p className="text-sm text-vibe-dim mt-1">Washington, DC</p>
          </div>

          {hasAnyData ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Lunar */}
              {lunarData && (
                <div className="card">
                  <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
                    Lunar Phase
                  </p>
                  <div className="flex items-center gap-3">
                    <span className="text-4xl">{lunarData.emoji ?? "🌙"}</span>
                    <div>
                      <p className="text-lg font-bold">
                        {lunarData.phase ?? "Unknown"}
                      </p>
                      {lunarData.illumination != null && (
                        <p className="text-xs text-vibe-dim">
                          {Math.round((lunarData.illumination ?? 0) * 100)}%
                          illuminated
                        </p>
                      )}
                      {(context.data.lunar?.days_into_cycle) != null && (
                        <p className="text-xs text-vibe-dim">
                          Day {context.data.lunar?.days_into_cycle} of cycle
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Weather */}
              {weatherData && (
                <div className="card">
                  <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
                    Weather
                  </p>
                  <div>
                    <p className="text-lg font-bold">
                      {weatherData.temperature_2m_max?.[0] != null
                        ? `${weatherData.temperature_2m_max[0]}°C`
                        : "N/A"}
                      {weatherData.temperature_2m_min?.[0] != null
                        ? ` / ${weatherData.temperature_2m_min[0]}°C`
                        : ""}
                    </p>
                    <p className="text-xs text-vibe-dim">
                      {WEATHER_CODES[
                        weatherData.weathercode?.[0] ?? -1
                      ] ?? "Unknown conditions"}
                    </p>
                    <p className="text-xs text-vibe-dim">
                      Precipitation:{" "}
                      {weatherData.precipitation_sum?.[0] ?? 0}mm
                      {weatherData.windspeed_10m_max?.[0] != null
                        ? ` | Wind: ${weatherData.windspeed_10m_max[0]} km/h`
                        : ""}
                    </p>
                  </div>
                </div>
              )}

              {/* Earthquakes */}
              {earthquakeData && (
                <div className="card">
                  <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
                    Seismic Activity
                  </p>
                  <div>
                    <p className="text-lg font-bold">
                      {earthquakeData.count ?? 0} quakes
                    </p>
                    <p className="text-xs text-vibe-dim">
                      Magnitude 2.5+ worldwide
                    </p>
                    {(earthquakeData.max_magnitude ?? 0) > 0 && (
                      <>
                        <p className="text-xs text-vibe-cosmic mt-1">
                          Largest: {earthquakeData.max_magnitude}
                        </p>
                        <p className="text-xs text-vibe-dim">
                          {earthquakeData.largest_location}
                        </p>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Daylight */}
              {sunriseData && (
                <div className="card">
                  <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
                    Daylight
                  </p>
                  <div>
                    <p className="text-lg font-bold">
                      {sunriseData.day_length_hours ?? "?"}h of light
                    </p>
                    <p className="text-xs text-vibe-dim">
                      Sunrise:{" "}
                      {sunriseData.sunrise
                        ? new Date(sunriseData.sunrise).toLocaleTimeString()
                        : "?"}
                    </p>
                    <p className="text-xs text-vibe-dim">
                      Sunset:{" "}
                      {sunriseData.sunset
                        ? new Date(sunriseData.sunset).toLocaleTimeString()
                        : "?"}
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* No sub-data returned — show raw response for debugging */
            <div className="card border-yellow-500/30">
              <p className="text-sm text-yellow-400 mb-2">
                The API returned a date but no environmental data (weather, lunar, earthquakes, or daylight).
              </p>
              <p className="text-xs text-vibe-dim mb-3">
                This may be a temporary issue with the upstream data providers (Open-Meteo, USGS, or sunrise API).
                Try a different date, or check the raw response below for details.
              </p>
              <JsonViewer data={context.data} label="Raw API Response" />
            </div>
          )}

          {/* Disclaimer */}
          {hasAnyData && (
            <>
              <div className="card bg-vibe-bg border-dashed">
                <p className="text-xs text-vibe-dim text-center italic">
                  These conditions were present in the Washington, DC area on this date.
                  Any correlation to congressional activity is almost certainly
                  meaningless. We're monitoring the situation.
                </p>
              </div>
              <JsonViewer data={context.data} label="Raw API Response" />
            </>
          )}
        </>
      )}
    </div>
  );
}
