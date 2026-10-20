import { listJobs, reapStaleJobs } from "@/lib/core/job-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Jobs orphaned by a server restart are reaped on every listing. Their child
// was a child of the previous process, so nothing will ever close them, and
// without this the UI shows a spinner that spins forever. Ownership decides,
// so a run this process started is never reaped, however early it began.
export async function GET() {
  reapStaleJobs();
  return Response.json({ jobs: listJobs() }, { headers: { "Cache-Control": "no-store" } });
}
