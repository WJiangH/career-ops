import fs from "node:fs";
import { spawn } from "node:child_process";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { readJsonObject } from "@/lib/json-body";

// AI keyword suggestion for the Explorer's filter builder: runs the core's
// titles-suggest.mjs headless (cv.md → {roles, candidates, exclude}, every
// keyword replayed against scan history) and returns its --json report.
//
// The route writes nothing. portals.yml changes only through the existing
// confirm-gated POST /api/portals when the user runs a discovery with the
// promoted roles — the same path a hand-typed keyword takes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

type Bucket = { keyword: string; why: string; hits?: number; unique?: number; admittedHits?: number; rejectedHits?: number; vetoes?: number };
export type SuggestResponse = {
  source: string | null;
  persona: string;
  roles: Bucket[];
  candidates: Bucket[];
  exclude: Bucket[];
  demoted: string[];
  replay: unknown;
};

export async function POST(req: Request) {
  // An empty or malformed body is fine: both fields are optional.
  const body = (await readJsonObject<{ cliId?: string; hint?: string }>(req)) ?? {};
  const root = careerOpsRoot();
  const script = rootScript("titles-suggest");
  if (!fs.existsSync(script)) {
    return Response.json({ error: "titles-suggest.mjs not found in this checkout — update career-ops." }, { status: 501 });
  }
  if (!fs.existsSync(`${root}/cv.md`)) {
    return Response.json({ error: "No cv.md yet — add your CV first; suggestions are derived from it." }, { status: 409 });
  }

  const args = [script, "--json"];
  const cliId = typeof body.cliId === "string" && /^[a-z0-9-]+$/i.test(body.cliId) ? body.cliId : null;
  if (cliId) args.push("--cli", cliId);
  const hint = typeof body.hint === "string" ? body.hint.trim().slice(0, 500) : "";
  if (hint) args.push("--hint", hint);

  const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, NO_COLOR: "1" } });
    let out = "";
    let err = "";
    const killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 590_000);
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-8_000)));
    child.on("error", (e) => {
      clearTimeout(killer);
      resolve({ stdout: out, stderr: `${err}\n${e.message}`, code: -1 });
    });
    child.on("close", (c) => {
      clearTimeout(killer);
      resolve({ stdout: out, stderr: err, code: c });
    });
  });

  if (code !== 0) {
    const msg = stderr.trim().split("\n").filter(Boolean).slice(-3).join(" · ") || `titles-suggest exited ${code}`;
    return Response.json({ error: msg }, { status: 502 });
  }
  let report: { source?: string | null; proposal?: { persona?: string; roles?: Bucket[]; candidates?: Bucket[]; exclude?: Bucket[]; demoted?: string[] }; replay?: unknown };
  try {
    report = JSON.parse(stdout);
  } catch {
    return Response.json({ error: "titles-suggest returned no JSON" }, { status: 502 });
  }
  const p = report.proposal ?? {};
  const res: SuggestResponse = {
    source: report.source ?? null,
    persona: p.persona ?? "",
    roles: p.roles ?? [],
    candidates: p.candidates ?? [],
    exclude: p.exclude ?? [],
    demoted: p.demoted ?? [],
    replay: report.replay ?? null,
  };
  return Response.json(res);
}
