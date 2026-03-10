import { useState } from "react";
import { useApi } from "../hooks/useApi";

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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Lunar */}
            {context.data.lunar && (
              <div className="card">
                <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
                  Lunar Phase
                </p>
                <div className="flex items-center gap-3">
                  <span className="text-4xl">{context.data.lunar.emoji}</span>
                  <div>
                    <p className="text-lg font-bold">
                      {context.data.lunar.phase}
                    </p>
                    <p className="text-xs text-vibe-dim">
                      {Math.round((context.data.lunar.illumination ?? 0) * 100)}%
                      illuminated
                    </p>
                    <p className="text-xs text-vibe-dim">
                      Day {context.data.lunar.days_into_cycle} of cycle
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Weather */}
            {context.data.weather?.daily && (
              <div className="card">
                <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
                  Weather
                </p>
                <div>
                  <p className="text-lg font-bold">
                    {context.data.weather.daily.temperature_2m_max?.[0] != null
                      ? `${context.data.weather.daily.temperature_2m_max[0]}°C`
                      : "N/A"}
                    {context.data.weather.daily.temperature_2m_min?.[0] != null
                      ? ` / ${context.data.weather.daily.temperature_2m_min[0]}°C`
                      : ""}
                  </p>
                  <p className="text-xs text-vibe-dim">
                    {WEATHER_CODES[
                      context.data.weather.daily.weathercode?.[0] ?? -1
                    ] ?? "Unknown"}
                  </p>
                  <p className="text-xs text-vibe-dim">
                    Precipitation:{" "}
                    {context.data.weather.daily.precipitation_sum?.[0] ?? 0}mm
                    {context.data.weather.daily.windspeed_10m_max?.[0] != null
                      ? ` | Wind: ${context.data.weather.daily.windspeed_10m_max[0]} km/h`
                      : ""}
                  </p>
                </div>
              </div>
            )}

            {/* Earthquakes */}
            {context.data.earthquakes && (
              <div className="card">
                <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
                  Seismic Activity
                </p>
                <div>
                  <p className="text-lg font-bold">
                    {context.data.earthquakes.count ?? 0} quakes
                  </p>
                  <p className="text-xs text-vibe-dim">
                    Magnitude 2.5+ worldwide
                  </p>
                  {(context.data.earthquakes.max_magnitude ?? 0) > 0 && (
                    <>
                      <p className="text-xs text-vibe-cosmic mt-1">
                        Largest: {context.data.earthquakes.max_magnitude}
                      </p>
                      <p className="text-xs text-vibe-dim">
                        {context.data.earthquakes.largest_location}
                      </p>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Daylight */}
            {context.data.sunrise && (
              <div className="card">
                <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
                  Daylight
                </p>
                <div>
                  <p className="text-lg font-bold">
                    {context.data.sunrise.day_length_hours ?? "?"}h of light
                  </p>
                  <p className="text-xs text-vibe-dim">
                    Sunrise:{" "}
                    {context.data.sunrise.sunrise
                      ? new Date(context.data.sunrise.sunrise).toLocaleTimeString()
                      : "?"}
                  </p>
                  <p className="text-xs text-vibe-dim">
                    Sunset:{" "}
                    {context.data.sunrise.sunset
                      ? new Date(context.data.sunrise.sunset).toLocaleTimeString()
                      : "?"}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Disclaimer */}
          <div className="card bg-vibe-bg border-dashed">
            <p className="text-xs text-vibe-dim text-center italic">
              These conditions were present in the Washington, DC area on this date.
              Any correlation to congressional activity is almost certainly
              meaningless. We're monitoring the situation.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
