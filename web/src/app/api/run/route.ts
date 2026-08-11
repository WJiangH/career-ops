import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveCli } from "@/lib/clis";
import { parserFor } from "@/lib/cli-stream.mjs";
import { careerOpsRoot, readMemory, findReportFile } from "@/lib/career-ops";
import { resolvePdfPaths, type PdfPaths } from "@/lib/pdf-paths.mjs";
import { renderAndMarkPdf, writeCvHtml, pdfRunOutcome } from "@/lib/pdf-render.mjs";
import { createCvEnvelopeFilter, type CvEnvelope } from "@/lib/cv-envelope.mjs";
import { buildPrompt, isShellSafeCompanyName } from "@/lib/run-prompts.mjs";
import { claudeCliArgs } from "@/lib/claude-invocation.mjs";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";
import { appendEvent, createJob, finishJob } from "@/lib/core/job-log";
import { newReportSince, readMachineSummary, snapshotReports } from "@/lib/machine-summary.mjs";

/** The normalized shape cli-stream.mjs parsers emit, whatever the CLI's dialect. */
type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "status"; label: string }
  | { type: "usage"; tokens: number; costUsd: number | null }
  | { type: "error"; msg: string };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800; // a real oferta evaluation / pdf-mode CV tailoring + render is heavy and multi-step

export async function POST(req: Request) {
  let body: { kind?: string; input?: string; cliId?: string; jobId?: string; model?: string; effort?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }
  const { kind = "evaluate", input, cliId, jobId, model, effort } = body;
  if (!input || !cliId) {
    return new Response(JSON.stringify({ error: "input and cliId required" }), { status: 400 });
  }
  const resolved = resolveCli(cliId);
  if (!resolved) {
    return new Response(JSON.stringify({ error: `CLI '${cliId}' not found` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, binPath } = resolved;

  // These run the REAL core (modes/scripts), not just data — fail clearly if the
  // root is incomplete instead of faking it.
  const needsScript: Record<string, string> = { evaluate: "modes/oferta.md", "fix-portal": "verify-portals.mjs", pdf: "generate-pdf.mjs" };
  const required = needsScript[kind];
  if (required && !fs.existsSync(path.join(careerOpsRoot(), required))) {
    return new Response(
      JSON.stringify({
        error: `This needs a complete career-ops checkout (${required}). CAREER_OPS_ROOT has data only — point it at a full checkout.`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // fix-portal's prompt puts this straight into a shell command the agent runs, and
  // a company name can arrive from a public ATS listing rather than the user's own
  // typing. Refuse rather than sanitize: a silently rewritten name would repair the
  // wrong portal.
  if (kind === "fix-portal" && !isShellSafeCompanyName(input)) {
    return new Response(
      JSON.stringify({ error: "That company name has characters I can't safely pass to the portal checker — rename it in portals.yml first." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // An A–F score is meaningless without a CV to score against — the CLI would
  // hallucinate a fit narrative and still emit a VERDICT. Require cv.md first.
  if ((kind === "evaluate" || kind === "pdf") && !fs.existsSync(path.join(careerOpsRoot(), "cv.md"))) {
    return new Response(
      JSON.stringify({ error: "Add your CV first so I can score this against you — drop it on the home page." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  // Precompute deterministic scratch + final paths so the agent never chooses
  // its own filenames — the backend owns naming, writing (#2185) and rendering
  // (#2172). Nothing is cleared first: writeCvHtml rewrites the HTML
  // from this run's freshly parsed envelope before any render, and the agent is
  // no longer told these paths, so a stale file cannot survive into a render.
  let pdfPaths: PdfPaths | undefined;
  if (kind === "pdf") {
    const pathsResult = resolvePdfPaths(input, today, careerOpsRoot(), findReportFile);
    if (!pathsResult.ok) {
      return new Response(JSON.stringify({ error: pathsResult.error }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    pdfPaths = pathsResult.paths;
  }

  const prompt = buildPrompt({ kind, input, memory: readMemory(), today });

  const isClaude = cliId === "claude";
  const parseEvent = parserFor(cliId);
  // Which tools each kind gets, and the whole claude argv, live in
  // claude-invocation.mjs — see its header for the policy and for why it is asserted on
  // built values rather than on this file's source. NEVER auto-submits; that
  // remains a prompt-level guarantee.
  // Non-Claude CLIs get no tool flags from spec.args() at all, so their agents
  // stay unrestricted here. That gap is route-wide (it applies to 'evaluate' too),
  // not specific to pdf, and each CLI needs its own mechanism researched — tracked
  // as #2507 rather than half-fixed here. On those CLIs the backend is the only
  // INTENDED writer — the agent is not asked to write — but that is mitigation, not
  // enforcement: the capability is still there for an injected posting to reach.
  // streamArgs only requests structured output; it grants nothing, so it does not
  // widen that gap, and the route still spells no tool flag itself.
  const args = isClaude ? claudeCliArgs({ kind, prompt }) : (spec.streamArgs?.(prompt) ?? spec.args(prompt));

  // Model and effort are opt-in: absent, each CLI uses its own default. Values
  // go in as separate argv entries (never interpolated into a shell), so an odd
  // string is at worst an unknown-flag error, never injection. Effort is checked
  // against what the CLI actually accepts — grok exits non-zero on an unknown
  // level and codex fails the turn with a 400, so forwarding a bad value would
  // burn a whole run to learn nothing.
  if (model?.trim() && spec.modelArgs) args.push(...spec.modelArgs(model.trim()));
  if (effort?.trim() && spec.effortArgs) {
    const want = effort.trim();
    if (spec.efforts?.length && !spec.efforts.includes(want)) {
      return new Response(
        JSON.stringify({ error: `${spec.name} does not accept effort '${want}'. Supported: ${spec.efforts.join(", ")}` }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    args.push(...spec.effortArgs(want));
  }

  // For write-needing kinds, snapshot reports/ so we can verify the worker
  // actually persisted (non-Claude CLIs lack Write auth and silently no-op).
  const reportsDir = path.join(careerOpsRoot(), "reports");
  const countReports = () => {
    try {
      return fs.readdirSync(reportsDir).filter((f) => f.endsWith(".md")).length;
    } catch {
      return 0;
    }
  };
  const persists = kind === "evaluate";
  const reportsBefore = persists ? countReports() : 0;
  // Names, not just a count: identifying the new report by set difference is
  // concurrency-safe, where "newest mtime" would hand one run another's report.
  const reportNamesBefore = persists ? snapshotReports(careerOpsRoot()) : new Set<string>();
  // Tracker-mutating runs hold a write token so a row delete can't race their merge
  // (tracker.mjs delete doesn't yet share a lock with merge-tracker — see run-registry).
  const writeToken = kind === "evaluate" || kind === "pdf" ? acquireTrackerWrite() : null;

  // The client may supply the id it will resubscribe with; otherwise mint one.
  // Rejecting a malformed id here (rather than sanitizing) keeps the id the
  // client holds and the id on disk identical — a rewritten one would 404 on
  // reconnect.
  const jobRunId = jobId && /^[A-Za-z0-9._-]{1,128}$/.test(jobId) ? jobId : `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // stdin is 'ignore', not the default pipe. The prompt goes in via argv, so the
  // child never needs stdin — but with an open pipe nobody ever writes to or
  // ends, a CLI that checks stdin blocks forever waiting for EOF. Codex prints
  // "Reading additional input from stdin..." and hangs; it has never worked in
  // the web UI for this reason. Claude masked it by not reading stdin at all.
  const child = spawn(binPath, args, {
    cwd: careerOpsRoot(),
    env: process.env,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Decode once on the stream, not per chunk. Buffer#toString() decodes each chunk
  // independently, so a chunk boundary falling inside a multi-byte UTF-8 sequence
  // yields a replacement character and mis-decodes the bytes after it. Those bytes
  // are the CV now (#2185) — the agent's HTML flows through cvFilter to
  // writeCvHtml and on to the renderer — and no structural check would catch it,
  // because the envelope markers and </html> are ASCII and still match. Setting
  // the encoding makes Node hold partial sequences across chunks.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const enc = new TextEncoder();

  // The run is now owned by the server, so two states that used to share one
  // `closed` flag have to be distinguished:
  //   clientGone — nobody is reading the HTTP stream. Stop enqueuing; keep the
  //                child, the transcript and the honesty gates running.
  //   closed     — the run itself is over and finalized. Late handlers no-op.
  // Conflating them is exactly why locking a phone killed an evaluation: cancel()
  // set one flag that both killed the child AND made child.on("close") skip every
  // honesty gate, so the run neither finished nor recorded anything.
  let closed = false;
  let clientGone = false;
  // Durable transcript. Every event lands here whether or not a client is
  // attached, and a reconnecting client replays from its line offset.
  const job = createJob({ id: jobRunId, kind, input, title: `${kind} · ${input.slice(0, 80)}` });
  void job;
  let killer: ReturnType<typeof setTimeout> | undefined;
  // pdf-kind's render+mark work (renderPdf, below) keeps running detached even
  // after the agent child closes — and even after a client disconnect fires
  // cancel(). Track its promise so cancel() can defer releasing writeToken
  // until that work actually settles, instead of releasing the tracker-delete
  // guard while mark-pdf-ready.mjs is still actively writing applications.md.
  let pdfRenderPromise: Promise<void> | null = null;
  // Set by the kill timer so the finished record says "timed out" rather than
  // the generic "hit an error", which sent us reading logs to tell them apart.
  let timedOut = false;
  let writeTokenReleased = false;
  const releaseWriteTokenOnce = () => {
    if (writeToken !== null && !writeTokenReleased) {
      writeTokenReleased = true;
      releaseTrackerWrite(writeToken);
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emittedText = false; // any assistant text delta → the CLI actually ran
      let sawError = false;
      let stderrBuf = "";
      // Widened over time: auth/login/quota failures are the most common real error
      // and a narrow regex missed them (silent false "success").
      const STDERR_FAILURE = /error|denied|fatal|not found|unauthorized|forbidden|auth|login|credential|api[ -]?key|quota|rate limit|not authenticated/i;
      const flagStderrLine = (line: string) => {
        // Some CLIs log benign diagnostics that STDERR_FAILURE reads as a failed
        // run — codex emits a models-cache warning on every invocation. Filtered
        // here, so it sees the same complete lines the classifier does.
        if (spec.benignStderr?.test(line)) return;
        if (!line.trim() || !STDERR_FAILURE.test(line)) return;
        sawError = true;
        send({ type: "error", msg: line.trim().slice(0, 200) });
      };
      let lastTokens = 0; // per-run token cost from the Claude result event (#6) — local only
      let lastCostUsd: number | null = null;
      let terminalStatus: "done" | "error" | null = null;
      let terminalSummary = "";
      // pdf-mode's agent only tailors content now (rendering moved to the
      // backend, #2172) — but its killMs still has to leave real headroom
      // inside the route's overall maxDuration (800s): the render+mark phase
      // (renderPdf, below) starts only after this timer's window and has no
      // timeout of its own, so an agent that runs close to its full budget
      // would otherwise leave the platform's hard maxDuration cutoff to kill
      // generate-pdf.mjs mid-render. 600s agent / ~200s render is ample —
      // a Chromium PDF render normally takes low tens of seconds even with a
      // cold Playwright launch.
      // 285s used to be the non-pdf budget, chosen when the browser held the
      // connection and a platform timeout was the real ceiling. Runs are
      // server-owned now, and a genuine oferta evaluation measures 7-8 minutes
      // — a Workday JD that WebFetch cannot render costs another API round trip
      // on top. The old value killed real work at 4m45s: observed at exactly
      // 286s, one second past the timer, mid-sentence after the agent had
      // already reserved its report number. Both budgets now sit inside the
      // route's 800s maxDuration with room for pdf's post-agent render.
      const killMs = kind === "pdf" ? 600_000 : 660_000;
      killer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, killMs);
      const send = (obj: unknown) => {
        // Latch the terminal outcome from the event itself. sawError only
        // reflects the stderr regex, so a run failed by an honesty gate — which
        // reports via send({type:"error"}) — was being recorded as "done".
        const t = (obj as { type?: string; msg?: string })?.type;
        if (t === "error") {
          terminalStatus = "error";
          terminalSummary = (obj as { msg?: string }).msg ?? "";
        } else if (t === "done" && terminalStatus === null) {
          terminalStatus = "done";
        }
        // Persist first, unconditionally: the transcript is the product, the
        // HTTP stream is just one optional consumer of it.
        appendEvent(jobRunId, obj);
        if (closed || clientGone) return;
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + "\n")); } catch { clientGone = true; }
      };
      const close = (outcome?: { status: "done" | "error"; summary?: string; tldr?: Record<string, unknown> }) => {
        if (!closed) {
          closed = true;
          if (killer) clearTimeout(killer);
          releaseWriteTokenOnce();
          finishJob(jobRunId, {
            status: outcome?.status ?? terminalStatus ?? (sawError ? "error" : "done"),
            summary: outcome?.summary ?? (timedOut
              ? `Timed out after ${Math.round(killMs / 1000)}s — re-run it, or evaluate from the Mac where nothing bounds it.`
              : terminalSummary || undefined),
            tokens: lastTokens,
            costUsd: lastCostUsd,
            ...(outcome?.tldr ? { tldr: outcome.tldr } : {}),
          });
          try { controller.close(); } catch { /* */ }
        }
      };
      // pdf's CV arrives inline in a <<cv-html>> envelope instead of being written
      // by the agent (#2185). The filter keeps every byte for the backend while
      // holding the 15-25 KB body out of the run log, which is the agent's
      // narration — see cv-envelope.mjs.
      const cvFilter = kind === "pdf" ? createCvEnvelopeFilter() : null;
      const sendAgentText = (text: string) => {
        const visible = cvFilter ? cvFilter.push(text) : text;
        if (visible) send({ type: "text", text: visible });
      };
      /** Surface non-fatal issues in the run log rather than only a server log. */
      const sendWarnings = (warnings: string[]) => {
        for (const w of warnings) send({ type: "text", text: `⚠️ ${w}\n` });
      };
      /** Persist the emitted CV; streams the reason and returns false on failure. */
      const saveCv = (paths: PdfPaths, envelope: CvEnvelope) => {
        const written = writeCvHtml({ pdfPaths: paths, html: envelope.html });
        if (!written.ok) send({ type: "error", msg: written.error.slice(0, 200) });
        return written.ok;
      };

      child.stdout.on("data", (chunk: string) => {
        // Deliberately not gated on clientGone: emittedText/sawError feed the
        // honesty gates in child.on("close"), so skipping the parse would make a
        // completed run look like "the CLI produced no output".
        if (closed) return;
        // No parser → the CLI has no structured mode; show its stdout verbatim.
        // Usage stays unknown for those, which is honest: there is nothing to read.
        if (!parseEvent) {
          emittedText = true;
          // MERGE HAZARD (#2102): once that PR parses non-Claude stdout as JSONL,
          // this must move onto the PARSED text or the envelope silently stops
          // being filtered and collected for codex. git reports no conflict.
          sendAgentText(chunk);
          return;
        }
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue; // partial or non-JSON line
          }
          for (const ev of parseEvent(parsed) as StreamEvent[]) {
            if (ev.type === "text") {
              emittedText = true;
              // sendAgentText, not send — this is the hand-off the MERGE HAZARD
              // note above marks. Now that non-Claude stdout is parsed as JSONL,
              // its text arrives here instead of the raw-chunk branch; sending it
              // directly would silently stop the pdf CV envelope being filtered
              // and collected on codex and grok, with no test failing and no
              // merge conflict to notice.
              sendAgentText(ev.text);
            } else if (ev.type === "tool") {
              send(ev.detail ? { type: "tool", name: ev.name, detail: ev.detail } : { type: "tool", name: ev.name });
            } else if (ev.type === "status") {
              send({ type: "status", label: ev.label });
            } else if (ev.type === "error") {
              // Same treatment as a stderr failure: mark it so the honesty gate
              // records "error", and tell the user the actual reason instead of
              // the generic no-output message.
              sawError = true;
              send({ type: "error", msg: ev.msg.slice(0, 300) });
            } else if (ev.type === "usage") {
              // Last-wins: every CLI's final total arrives last, and keeping the
              // intermediate ones means a run killed mid-flight still records
              // something. The authoritative "done" is still sent on close, so
              // the honesty gate decides done-vs-error first.
              lastTokens = ev.tokens;
              if (typeof ev.costUsd === "number") lastCostUsd = ev.costUsd;
            }
          }
        }
      });
      child.stderr.on("data", (chunk: string) => {
        // Match on COMPLETE lines. A chunk boundary can fall mid-word, so testing a
        // raw chunk both misses an error split across two of them and can match a
        // fragment that is not the word it looks like. sawError feeds pdfRunOutcome,
        // where a false positive fails a run whose PDF rendered fine, so the
        // boundary has to be settled before the regex sees it.
        stderrBuf += chunk;
        let nl;
        while ((nl = stderrBuf.indexOf("\n")) !== -1) {
          const line = stderrBuf.slice(0, nl);
          stderrBuf = stderrBuf.slice(nl + 1);
          flagStderrLine(line);
        }
      });
      // Render + mark-tracker-ready live in pdf-render.mjs (plain, dependency-
      // injected, unit-tested) so the render-then-mark orchestration isn't
      // buried untested inside this transport-layer closure. Runs generate-
      // pdf.mjs and mark-pdf-ready.mjs as plain Node child processes — no agent
      // CLI or its sandbox involved — so a browser launch never depends on an
      // interactive approval nobody is present to grant in a headless/web-
      // triggered run (#2172). The tracker is marked ✅ only after a CONFIRMED
      // successful render, not optimistically — same honesty-gate discipline as
      // the evaluate path below.
      const renderPdf = async (paths: PdfPaths, format: "letter" | "a4") => {
        send({ type: "status", label: "Rendering PDF…" });
        // renderAndMarkPdf is designed to resolve, never throw — but this is
        // the one place nothing else awaits or catches this promise (cancel()
        // only attaches a .finally for the write-token release), so an
        // unexpected exception here must still close the stream instead of
        // leaving it — and the write-token — open until process shutdown.
        try {
          const result = await renderAndMarkPdf({
            spawnFn: spawn,
            execPath: process.execPath,
            root: careerOpsRoot(),
            pdfPaths: paths,
            format,
            reportNum: input,
          });
          if (result.kind === "render-failed") {
            send({ type: "error", msg: result.error.slice(0, 200) });
            return;
          }
          // Non-fatal issues (a defaulted page format, a tracker row not marked) still
          // surface here rather than only in a server log nobody sees.
          sendWarnings(result.warnings);
          send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
        } catch (e) {
          send({ type: "error", msg: `PDF rendering crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
        } finally {
          close();
        }
      };

      child.on("error", (e) => { send({ type: "error", msg: e.message }); close(); });
      child.on("close", (code) => {
        // A trailing line with no newline would otherwise never be tested.
        if (stderrBuf) { flagStderrLine(stderrBuf); stderrBuf = ""; }
        // A client disconnect can fire cancel() (which kills `child`) before
        // this event finally arrives — killing a process doesn't make its
        // 'close' event disappear, just delays it. Without this guard a pdf
        // run could still start a brand-new render (and re-touch the tracker)
        // after the stream — and its writeToken guard — is already gone.
        if (closed) return;
        const cleanExit = code === 0; // non-zero OR null (killed/signal) = NOT clean
        // Shared by both honesty gates below — the pdf gate receives it as
        // pdfRunOutcome's noOutputMessage — because a CLI that produced no output at
        // all is the same failure mode whether it was evaluating or tailoring
        // a PDF — one place for the condition/message pair instead of two.
        const noOutputError = (): string | null => {
          if (!emittedText && !sawError && !cleanExit) return "The CLI exited with an error — is it installed and authenticated?";
          if (!emittedText && !sawError) return "The CLI produced no output — is it installed and authenticated? (career-ops is best on Claude Code.)";
          return null;
        };

        if (kind === "pdf") {
          // Release any text the filter was still holding, so the log keeps the
          // agent's closing narration and its VERDICT line.
          const tail = cvFilter?.flush();
          if (tail) send({ type: "text", text: tail });
          // The artifact check moved from the filesystem to the stream (#2185):
          // whether pdfPaths.html exists says nothing now that the backend is its
          // only writer. pdfRunOutcome owns the decision and the message.
          const envelope = cvFilter?.result();
          const outcome = pdfRunOutcome({
            envelope,
            noOutputMessage: noOutputError(),
            sawError,
            cleanExit,
            hasPaths: pdfPaths !== undefined,
          });
          if (!outcome.ok) {
            send({ type: "error", msg: outcome.message });
          } else if (!pdfPaths || envelope?.ok !== true) {
            // Unreachable: pdfRunOutcome validated both via hasPaths/envelope.ok.
            // Kept for narrowing, but it must REPORT rather than fall through to a
            // bare close() — a stream that ends with neither error nor done is the
            // one outcome this handler exists to prevent.
            send({ type: "error", msg: "Internal error: the pdf run passed its gate with no CV to save — please report this." });
          } else {
            sendWarnings(envelope.warnings);
            if (saveCv(pdfPaths, envelope)) {
              // Tracked so cancel() can defer releasing writeToken until this
              // settles; close() happens once rendering finishes, not here.
              pdfRenderPromise = renderPdf(pdfPaths, envelope.format);
              return;
            }
            // saveCv already streamed the specific reason.
          }
          return close();
        }

        const wroteReport = countReports() > reportsBefore;
        // Honesty gate (#9): a green "done" with a parsed score requires a CLEAN exit,
        // real output, AND (for evaluations) a report actually written. Anything else
        // is surfaced — an errored run must never be banked as a confident score.
        const baseErr = noOutputError();
        if (baseErr) {
          send({ type: "error", msg: baseErr });
        } else if (persists && !wroteReport) {
          // The worker ran but never wrote the report/tracker row (e.g. a CLI
          // without file-write authorization) — surface it instead of a fake score.
          send({ type: "error", msg: "This evaluation didn't save a report, so it's not in your tracker. Full evaluation is verified on Claude Code." });
        } else if (!cleanExit || sawError) {
          // Produced output (maybe even a report) but did NOT finish cleanly — flag it
          // instead of recording a confident score off a half-finished run.
          send({ type: "error", msg: "This run hit an error before finishing, so it isn't recorded as a confident result — re-run it to verify." });
        } else {
          send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
          if (persists) {
            const rel = newReportSince(careerOpsRoot(), reportNamesBefore);
            const tldr = rel ? readMachineSummary(careerOpsRoot(), rel) : null;
            if (tldr) {
              // The product of the run, captured before close() writes the
              // record — so /api/jobs alone can render a verdict without the
              // client having to go read markdown.
              close({ status: "done", tldr });
              return;
            }
          }
        }
        close();
      });
    },
    cancel() {
      // A reader went away — a locked phone, a closed tab, a backgrounded PWA.
      // That is not a reason to destroy the work: the child keeps running, the
      // transcript keeps accruing, and the client resubscribes via
      // GET /api/jobs/{id}/events?from=N. The kill timer stays armed so a
      // genuinely stuck agent is still bounded.
      clientGone = true;
      // The write token is deliberately NOT released here any more. It used to
      // be, because a disconnect ended the run — now the run outlives the
      // reader, and dropping the tracker-delete guard while the agent is still
      // writing applications.md would reintroduce the very race the token
      // exists to prevent. close() owns the release, on success and failure
      // alike, and the kill timer still bounds a genuinely stuck agent.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
