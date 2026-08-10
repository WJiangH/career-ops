import { NextResponse } from "next/server";
import { readEvents, readJob } from "@/lib/core/job-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Replay/tail a run's transcript from a line offset.
//
// This is the reconnect path. A phone that locked mid-evaluation comes back,
// asks for everything after the last line it saw, and catches up — the run
// itself never noticed it left. Polling rather than a held SSE connection is
// deliberate: the failure mode being fixed *is* held connections dying, so the
// recovery path must not depend on one staying alive.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(_req.url);
  const from = Math.max(0, Number(url.searchParams.get("from") ?? 0) || 0);

  const meta = readJob(id);
  if (!meta) return NextResponse.json({ error: "unknown job" }, { status: 404 });

  let events: unknown[] = [];
  let nextLine = from;
  try {
    ({ events, nextLine } = readEvents(id, from));
  } catch {
    return NextResponse.json({ error: "invalid job id" }, { status: 400 });
  }

  return NextResponse.json(
    { job: meta, events, nextLine, running: meta.status === "running" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
