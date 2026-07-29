import { NextResponse } from "next/server";
import {
  operatorProfiles,
  telegramBotStatus,
  telegramWorkerRuntimeStatus,
} from "@/lib/operator-integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [telegram, worker] = await Promise.all([
    telegramBotStatus(),
    telegramWorkerRuntimeStatus(),
  ]);
  return NextResponse.json({
    profiles: operatorProfiles(),
    telegram: { ...telegram, ...worker },
  });
}
