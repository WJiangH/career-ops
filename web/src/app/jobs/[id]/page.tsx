"use client";

import { use } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Loader2, Wrench, CircleDot, Check, X } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { HeroGlow } from "@/components/hero-glow";
import { Badge } from "@/components/ui/badge";

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { jobs } = useJobs();
  const job = jobs.find((j) => j.id === id);

  if (!job) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
          <ArrowLeft className="size-4" /> Pipeline
        </Link>
        <p className="mt-8 text-sm text-muted">
          This worker is no longer in memory (it finished earlier or the page was reloaded).
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
        <ArrowLeft className="size-4" /> Pipeline
      </Link>

      <section className="dot-bg relative mt-5 overflow-hidden rounded-2xl border border-border bg-surface/40 px-6 py-7">
        {job.status === "running" && <HeroGlow />}
        <div className="relative z-10">
          <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-faint">
            {job.status === "running" ? (
              <><Loader2 className="size-3 animate-spin text-brand" /> working</>
            ) : job.status === "done" ? (
              <><Check className="size-3 text-emerald-500" /> done</>
            ) : (
              <><X className="size-3 text-red-400" /> error</>
            )}
          </p>
          <h1 className="mt-2 font-display text-2xl tracking-tight text-landing">{job.title}</h1>
          {job.subtitle && <p className="mt-1 text-sm text-muted">{job.subtitle}</p>}
          {job.result?.score != null && (
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <Badge tone={job.result.tone}>{job.result.score}/5</Badge>
              {job.result.summary && <span className="text-sm text-muted">{job.result.summary}</span>}
            </div>
          )}
        </div>
      </section>

      {/* The trace is HOW the run went; the verdict is what it produced. While
          running it is the only signal and stays open. Once a verdict exists it
          collapses — otherwise ~20 tool lines sit at full weight between the
          header and the verdict card, pushing the answer below the fold and
          giving process the same prominence as result. Same demotion the
          narration below already gets, for the same reason. */}
      <details className="group mt-6" open={job.status === "running" || !job.tldr}>
        <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-[0.2em] text-muted marker:content-['']">
          <span className="group-open:hidden">Show what the agent did ({job.steps.length} steps)</span>
          <span className="hidden group-open:inline">Agent steps</span>
        </summary>
      <ol className="mt-3 space-y-2">
        {job.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm">
            {s.kind === "tool" ? (
              <Wrench className="mt-0.5 size-3.5 shrink-0 text-brand" />
            ) : (
              <CircleDot className="mt-0.5 size-3.5 shrink-0 text-faint" />
            )}
            <span className={s.kind === "tool" ? "min-w-0 font-medium" : "text-muted"}>
              {s.kind === "tool" ? `Using ${s.label}` : s.label}
              {/* The argument is what distinguishes twenty read_file lines from
                  each other. Muted and lighter: the tool is the event, the
                  argument is the subject. break-all so a long path wraps
                  instead of widening the pane. */}
              {s.detail && (
                <span className="ml-2 break-all font-normal text-muted">{s.detail}</span>
              )}
            </span>
          </li>
        ))}
        {job.status === "running" && (
          <li className="flex items-center gap-2.5 text-sm text-muted">
            <Loader2 className="size-3.5 animate-spin text-brand" /> thinking…
          </li>
        )}
      </ol>
      </details>

      {/* The verdict, when the run produced one. The agent writes its real
          output to reports/{num}-{slug}-{date}.md and only narrates on the
          stream, so showing the stream tail as "Output" surfaced running
          commentary ("Now let's release the reservation, write the tracker TSV,
          and merge.") in place of the actual result. */}
      {job.tldr && (
        <div className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Verdict</h2>
          <div className="mt-3 rounded-2xl border border-border bg-surface/40 p-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {typeof job.tldr.score === "number" && (
                <span className="text-2xl font-semibold tabular-nums">{job.tldr.score.toFixed(1)}<span className="text-base text-muted">/5</span></span>
              )}
              {job.tldr.final_decision && (
                <span className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide">{job.tldr.final_decision}</span>
              )}
              {job.tldr.work_auth && job.tldr.work_auth !== "unstated" && (
                <span className="text-xs text-muted">work auth: {job.tldr.work_auth}</span>
              )}
            </div>
            {(job.tldr.company || job.tldr.role) && (
              <p className="mt-1 text-sm text-muted">{[job.tldr.company, job.tldr.role].filter(Boolean).join(" · ")}</p>
            )}
            {job.tldr.next_action && <p className="mt-4 text-sm leading-relaxed">{job.tldr.next_action}</p>}

            {[
              { label: "Blockers", items: job.tldr.hard_stops },
              { label: "Gaps", items: job.tldr.soft_gaps },
              { label: "Strengths", items: job.tldr.top_strengths },
            ].map(({ label, items }) =>
              items && items.length > 0 ? (
                <div key={label} className="mt-4">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{label}</h3>
                  <ul className="mt-1.5 space-y-1.5">
                    {items.map((t, i) => (
                      <li key={i} className="flex gap-2 text-sm leading-relaxed text-muted">
                        <span className="text-faint">—</span>
                        <span>{t}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}

            {/* The report number IS the route: /pipeline/48 renders
                reports/048-*.md. This pointed at bare /pipeline, which lands on
                the INBOX tab — so the report was one unguessable click away and
                read as missing, worst of all for a SKIP whose tracker row sits
                under a tab you'd have to know to open. No leading number means
                no route to derive, so show plain text rather than a wrong link. */}
            {job.tldr.report && (() => {
              const file = job.tldr.report.replace("reports/", "");
              const num = /^(\d+)/.exec(file)?.[1];
              return (
                <p className="mt-5 text-sm">
                  {num ? (
                    <Link className="text-brand underline underline-offset-4" href={`/pipeline/${num}`}>
                      Full report · {file}
                    </Link>
                  ) : (
                    <span className="text-muted">Full report · {file}</span>
                  )}
                </p>
              );
            })()}
          </div>
        </div>
      )}

      {/* Narration stays available, but demoted: it is how the run went, not
          what it produced. Open by default only when there is no verdict to
          show — a failed or still-running job, where it is the only signal. */}
      {job.text && (
        <details className="mt-8" open={!job.tldr}>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.2em] text-muted">
            {job.tldr ? "Agent log" : "Output"}
          </summary>
          <div className="report-prose mt-3 rounded-2xl border border-border bg-surface/40 p-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{job.text}</ReactMarkdown>
          </div>
        </details>
      )}
    </div>
  );
}
