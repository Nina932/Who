import { NextResponse } from "next/server";
import { buildDailyBriefing } from "@/lib/daily-briefing";
import { onThisDay } from "@/lib/ambient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const now = new Date();
  try {
    return NextResponse.json(
      await buildDailyBriefing(onThisDay(now), now.getTime()),
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("daily-briefing: aggregation failed", error);
    return NextResponse.json(
      {
        error: "The daily briefing could not be assembled.",
        generatedAt: now.getTime(),
        summary: "The briefing sources could not be reached.",
        lines: [],
        headlines: [],
        almanac: onThisDay(now),
        coverage: { live: 0, total: 4 },
      },
      { status: 503 },
    );
  }
}
