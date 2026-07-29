import { NextResponse } from "next/server";
import { AMBIENT, coordinates } from "@/lib/ambient";

/**
 * Real weather.
 *
 * The cockpit displayed a hardcoded 24°C as though it were live — exactly the
 * kind of fake this build has been removing everywhere else. Open-Meteo needs
 * no API key, so there is no excuse for the constant.
 *
 * Cached for ten minutes: the reading changes hourly at best, and the cockpit
 * re-renders constantly.
 */

export const runtime = "nodejs";
// The handler must run per request: `revalidate` here would statically
// generate this route at build time, freezing whatever the environment looked
// like during `npm run build` — which is how the operator's name came back
// empty no matter what .env.local said. The weather call itself is still
// cached, on the fetch below, which is where the caching belongs.
export const dynamic = "force-dynamic";

// WMO weather codes, condensed to what a HUD line needs.
const CONDITIONS: Array<[number[], string]> = [
  [[0], "Clear"],
  [[1, 2], "Partly cloudy"],
  [[3], "Overcast"],
  [[45, 48], "Fog"],
  [[51, 53, 55, 56, 57], "Drizzle"],
  [[61, 63, 65, 66, 67, 80, 81, 82], "Rain"],
  [[71, 73, 75, 77, 85, 86], "Snow"],
  [[95, 96, 99], "Thunderstorm"],
];

function describe(code: number): string {
  return CONDITIONS.find(([codes]) => codes.includes(code))?.[1] ?? "Unsettled";
}

export async function GET() {
  // No coordinates configured means no weather. Better an absent readout than
  // an invented one.
  const where = coordinates();
  if (!where) {
    return NextResponse.json({
      operator: AMBIENT.operator,
      city: AMBIENT.city,
      temperature: 0,
      conditions: "",
      live: false,
      reason: "Set MORPHEUS_LAT and MORPHEUS_LON to show local weather.",
    });
  }

  const params = new URLSearchParams({
    latitude: where.lat,
    longitude: where.lon,
    current: "temperature_2m,weather_code",
    timezone: "auto",
  });

  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      next: { revalidate: 600 },
    });
    if (!response.ok) throw new Error(`open-meteo ${response.status}`);

    const data = (await response.json()) as {
      current?: { temperature_2m?: number; weather_code?: number };
    };

    const temperature = data.current?.temperature_2m;
    if (typeof temperature !== "number") throw new Error("no reading returned");

    return NextResponse.json({
      operator: AMBIENT.operator,
      city: AMBIENT.city,
      temperature: Math.round(temperature),
      conditions: describe(data.current?.weather_code ?? 1),
      live: true,
    });
  } catch (error) {
    console.error("ambient: weather unavailable", error);
    return NextResponse.json({
      operator: AMBIENT.operator,
      city: AMBIENT.city,
      temperature: 0,
      conditions: "",
      live: false,
      reason: "Weather service unreachable.",
    });
  }
}
