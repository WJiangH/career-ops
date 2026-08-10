import { NextResponse } from "next/server";
import { readLastDiscovery } from "@/lib/core/last-discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Collect the result of a sweep whose stream was cut — the recovery path for a
// PWA that got backgrounded mid-scan. `runId` is required to match: without it
// a client that reconnected too early would happily adopt the *previous*
// scan's offers and believe they were its own.
export async function GET(req: Request) {
  const want = new URL(req.url).searchParams.get("runId");
  const last = readLastDiscovery();
  if (!last || (want && last.runId !== want)) {
    return NextResponse.json({ ready: false }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(
    { ready: true, finishedAt: last.finishedAt, event: last.event },
    { headers: { "Cache-Control": "no-store" } },
  );
}
