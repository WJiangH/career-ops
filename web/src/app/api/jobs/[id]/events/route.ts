import { reapIfOrphaned, readEvents, readJob } from "@/lib/core/job-log";

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

  let meta: ReturnType<typeof readJob>;
  try {
    meta = readJob(id);
  } catch {
    return Response.json({ error: "invalid job id" }, { status: 400 });
  }
  if (!meta) return Response.json({ error: "unknown job" }, { status: 404 });
  // A follower polls only this route, so it has to see a restart here too.
  meta = reapIfOrphaned(meta);

  let events: unknown[] = [];
  let nextLine = from;
  try {
    ({ events, nextLine } = readEvents(id, from));
  } catch {
    return Response.json({ error: "invalid job id" }, { status: 400 });
  }

  return Response.json(
    { job: meta, events, nextLine, running: meta.status === "running" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
