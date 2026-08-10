import { NextResponse } from "next/server";
import { listJobs, reapStaleJobs } from "@/lib/core/job-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Jobs orphaned by a server restart are reaped once per process, on the first
// listing. Their child was a child of the previous process, so nothing will
// ever close them — without this the UI shows a spinner that spins forever.
let reaped = false;

export async function GET() {
  if (!reaped) {
    reaped = true;
    reapStaleJobs();
  }
  return NextResponse.json({ jobs: listJobs() });
}
