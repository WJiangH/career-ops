import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import type { PlannerField } from "@/lib/apply/planner";
import { companyFromTitle, bankMemoryBlock, overlayBank } from "./answer-bank-pure.mjs";

// The candidate's standing answers (data/answer-bank.json, core `answer-bank.mjs`)
// applied to a live form. Two jobs, both cheap and deterministic:
//
//   1. Before the planner runs, match every field against the bank so the
//      planner is TOLD the standing answers instead of re-deriving (or refusing)
//      them — sponsorship, authorization, start date, links.
//   2. After the planner returns, overwrite its guesses for `auto` hits with the
//      bank's verbatim answer, and mark `confirm` hits needs_confirmation with
//      the bank's answer as the default. The bank is the candidate's own word;
//      the planner never outranks it.
//
// Spawned rather than imported: the core script lives outside web/ (Turbopack
// pins its root to web/), same as every other core helper the routes call.

export type BankHit = {
  id: string; // field id
  label: string;
  entry: string | null;
  hit: boolean;
  level?: "auto" | "suggest";
  score?: number;
  answer?: string | null;
  status?: "answered" | "needs-user";
  confirm_each_time?: boolean;
  source?: string | null;
  note?: string | null;
  intents?: string[];
};
export type BankMatch = { auto: BankHit[]; confirm: BankHit[]; unknown: BankHit[] };

const EMPTY: BankMatch = { auto: [], confirm: [], unknown: [] };

/** "Job Application for X at Anthropic" / "Applied ML Engineer @ Deepgram" → the company, for scoped entries. */
export function matchAnswerBank(fields: PlannerField[], company: string | null): BankMatch {
  const script = rootScript("answer-bank");
  const root = careerOpsRoot();
  if (!fs.existsSync(script) || !fs.existsSync(path.join(root, "data", "answer-bank.json"))) return EMPTY;
  const tmp = path.join(os.tmpdir(), `co-bank-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(fields.map((f) => ({ id: f.id, label: f.label, options: f.options }))));
    const args = [script, "match", "--file", tmp, ...(company ? ["--company", company] : [])];
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 15_000 });
    if (r.status !== 0 || !r.stdout.trim()) return EMPTY;
    const parsed = JSON.parse(r.stdout) as Partial<BankMatch>;
    return { auto: parsed.auto ?? [], confirm: parsed.confirm ?? [], unknown: parsed.unknown ?? [] };
  } catch {
    return EMPTY;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export { companyFromTitle, bankMemoryBlock, overlayBank };
