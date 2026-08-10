import { NextRequest } from "next/server";
import { saveLastDiscovery } from "@/lib/core/last-discovery";
import fs from "node:fs";
import { runDiscovery } from "@/lib/core/scan";
import { rootScript } from "@/lib/career-ops";
import { parseExplorePatch, DEFAULT_FILTERS, type DiscoveredOffer, type ScanEvent } from "@/lib/explore";

// Discovery is HTTP-bound across many ATS boards; give it room. It is FREE —
// zero LLM tokens (the scanner only does HTTP + JSON, and --dry-run writes nothing).
export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* empty body → defaults */
  }

  const filters = parseExplorePatch(body, DEFAULT_FILTERS);

  // Guard: a data-only checkout (or pre-onboarding) has no scanner. Fail soft.
  if (!fs.existsSync(rootScript("scan-ats-full"))) {
    return Response.json(
      { error: "The discovery scanner isn't available in this checkout yet." },
      { status: 400 },
    );
  }

  // Discovery is a query that yields a result set, not a stream of side
  // effects — so the result is worth keeping. Backgrounding the PWA cancels the
  // fetch, and until now that lost a scan that had already finished server-side
  // ("Couldn't finish the search. Load failed"). The sweep still runs to
  // completion; persisting it lets a returning client collect the answer.
  const runId = typeof (body as { runId?: unknown }).runId === "string" ? (body as { runId: string }).runId : null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          /* stream closed */
        }
      };
      // Wire budget matters here in a way it does not on localhost. Over
      // Tailscale the phone reaches this through a DERP relay on cellular, and
      // `tailscale serve` speaks HTTP/2 — every request shares one TCP
      // connection. A megabyte of scan chatter with any packet loss stalls that
      // connection head-of-line, so the health check and the job poll queue
      // behind it and the app declares the Mac unreachable while it is happily
      // serving in 40ms. Measured on one sweep: 1,047KB total, of which
      // `log` was 308KB (29%) with no client handler at all — the UI never
      // reads them — and the `done` frame repeated all 1,420 offers for
      // another 340KB (33%) that the client also ignores, since it accumulates
      // from the individual `offer` events. Dropping both is a 62% cut with no
      // behaviour change.
      // The summary carries what the UI needs to explain an empty result —
      // companiesScanned, capHit, datasetStatus. It arrives near the very end,
      // so a client whose stream died never sees it, and its absence reads as
      // companiesScanned === 0 → "couldn't reach any sources", which is a
      // different and much more alarming claim than the truth ("capped at 600
      // of 15,862"). Stash it so the recovery path can restore it too.
      let summary: ScanEvent | null = null;
      const sendToClient = (e: ScanEvent) => {
        if (e.kind === "log") return;
        if (e.kind === "summary") summary = e;
        send(e);
      };
      send({ kind: "start", ats: filters.ats, sinceDays: filters.sinceDays, limit: filters.limitPerAts, free: true } satisfies ScanEvent);
      let offers: DiscoveredOffer[] = [];
      try {
        offers = await runDiscovery(filters, sendToClient);
      } catch (err) {
        send({ kind: "error", message: err instanceof Error ? err.message : "discovery failed" } satisfies ScanEvent);
      }
      const done = { kind: "done", count: offers.length, offers, cost: { tokens: 0, usd: 0 } } satisfies ScanEvent;
      // Persist the FULL result — the recovery path in /api/explore/last is the
      // one consumer that genuinely needs the offers, and it reads from disk.
      saveLastDiscovery({ runId, finishedAt: Date.now(), event: done, summary });
      // …but put a slim frame on the wire.
      send({ ...done, offers: [] });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
