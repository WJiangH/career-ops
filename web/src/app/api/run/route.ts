// Both spawners are needed here, and the distinction matters: the agent CLI goes
// through spawnHeadlessCli (which closes stdin so `codex exec` can't hang waiting
// on it, #2085), while the PDF render is a plain Node child process with no CLI
// sandbox in the way (#2172) and so passes `spawn` itself to renderAndMarkPdf.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cliSubstitutionNotice, cliUnavailableError, resolveCliOrFallback } from "@/lib/clis";
import { localISODate } from "@/lib/followups";
import { accumulateTokens, createAgentTextJoiner, isFatalGenericStderr, killMsForKind, timeoutMessage } from "@/lib/run-cli-support.mjs";
import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { careerOpsRoot, readMemory, findReportFile, readInbox, readScanDates, readLanguageConfig } from "@/lib/career-ops";
import { resolvePdfPaths, type PdfPaths } from "@/lib/pdf-paths.mjs";
import { renderAndMarkPdf, writeCvHtml, pdfRunOutcome } from "@/lib/pdf-render.mjs";
import { createCvEnvelopeFilter, type CvEnvelope } from "@/lib/cv-envelope.mjs";
import { createReportEnvelopeFilter } from "@/lib/report-envelope.mjs";
import { persistEvaluation, evaluateRunOutcome } from "@/lib/report-persist.mjs";
import { buildPrompt, isShellSafeCompanyName } from "@/lib/run-prompts.mjs";
import { parseCoverRequest } from "@/lib/cover-brief.mjs";
import { capabilitiesFor } from "@/lib/worker-capabilities.mjs";
import { fencingReport, isCliAllowedForCapabilities } from "@/lib/cli-fencing.mjs";
import { claudeCliArgs } from "@/lib/claude-invocation.mjs";
import { resolveCvTemplate } from "@/lib/core/cv-template.mjs";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";
import { createRunFinalizer } from "@/lib/run-finalizer.mjs";
import { readJsonObject } from "@/lib/json-body";
import { createRunChannel, runJobId } from "@/lib/run-channel.mjs";
import { appendEvent, createJob, finishJob } from "@/lib/core/job-log";
import { parseMachineSummary } from "@/lib/run-summary.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800; // a real oferta evaluation / pdf-mode CV tailoring + render is heavy and multi-step

export async function POST(req: Request) {
  const body = await readJsonObject<{ kind?: string; input?: string; cliId?: string; brief?: unknown; model?: string; effort?: string; jobId?: string; title?: string }>(req);
  if (!body) return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  const { kind = "evaluate", input, cliId: requestedCliId, brief, model, effort } = body;
  if (!input || !requestedCliId) {
    return new Response(JSON.stringify({ error: "input and cliId required" }), { status: 400 });
  }
  const resolved = resolveCliOrFallback(requestedCliId);
  if (!resolved) {
    return new Response(JSON.stringify(cliUnavailableError(requestedCliId)), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, binPath } = resolved;
  // The CLI actually running: fencing, capabilities and argv below are keyed on it.
  const cliId = spec.id;
  const substitution = cliSubstitutionNotice(resolved);
  const capabilities = capabilitiesFor(kind);
  if (!isCliAllowedForCapabilities(cliId, capabilities)) {
    return new Response(
      JSON.stringify({ error: `CLI '${cliId}' cannot run write-capable worker '${kind}' without a verified permission adapter.` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // These run the REAL core (modes/scripts), not just data — fail clearly if the
  // root is incomplete instead of faking it.
  // The precondition must check the file the prompt will actually read. Pinning
  // it to modes/oferta.md meant a configured market passed a check on a file the
  // run never opens, and would have missed a market dir with no evaluation mode.
  const lang = readLanguageConfig();
  const needsScript: Record<string, string> = { evaluate: lang.evalModeFile, "fix-portal": "verify-portals.mjs", pdf: "generate-pdf.mjs", cover: "modes/cover.md" };
  const required = needsScript[kind];
  // CAREER_OPS_ROOT is runtime user data, not a build input. Tracing this
  // dynamic path would copy the whole web project into every server bundle.
  const requiredPath = required
    ? path.join(/* turbopackIgnore: true */ careerOpsRoot(), required)
    : "";
  if (required && !fs.existsSync(/* turbopackIgnore: true */ requiredPath)) {
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
  if ((kind === "evaluate" || kind === "pdf" || kind === "cover") && !fs.existsSync(path.join(careerOpsRoot(), "cv.md"))) {
    return new Response(
      JSON.stringify({ error: "Add your CV first so I can score this against you — drop it on the home page." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const today = localISODate();

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

  const coverRequest = kind === "cover" ? parseCoverRequest({ input, brief, root: careerOpsRoot(), findReportFile }) : undefined;
  if (coverRequest && !coverRequest.ok) {
    return new Response(JSON.stringify({ error: coverRequest.error }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Resolve the posting date HERE rather than asking the agent for it. The
  // scanner already wrote it from the provider's own `offer.postedAt`, so this
  // copies a recorded value instead of inviting a guess — and modes/oferta.md is
  // explicit that a guessed date is worse than an absent one (the POSTED column
  // renders absent as `—`, a wrong date as a fresh req). Unknown URL → undefined
  // → report-persist writes no segment at all.
  const postedAt =
    kind === "evaluate"
      ? readInbox().find((j) => j.url === input)?.postedAt ?? readScanDates().get(input)
      : undefined;
  // Which CV template the worker fills. Resolved HERE, for the same reason `lang`
  // is: the worker has no Bash (#2172), so it cannot run cv-templates.mjs and the
  // prompt used to name the base template outright, silently ignoring cv.template
  // (#4034). Only pdf fills a template, so nothing else pays for the lookup.
  // The root is passed, not re-derived: a relative CAREER_OPS_PROFILE resolves
  // against it, and `process.cwd()` here is `<core>/web` (see cv-template.mjs).
  const cvTemplate = kind === "pdf" ? await resolveCvTemplate(careerOpsRoot()) : undefined;
  const prompt = buildPrompt({
    kind,
    input,
    memory: readMemory(),
    today,
    postedAt,
    lang,
    cvTemplate,
    reportFile: pdfPaths?.reportFile ?? (coverRequest?.ok ? coverRequest.reportFile : undefined),
    coverBrief: coverRequest?.ok ? coverRequest.brief : undefined,
  });

  const isClaude = cliId === "claude";
  // Which tools each kind gets, and the whole claude argv, live in
  // claude-invocation.mjs — see its header for the policy and for why it is asserted on
  // built values rather than on this file's source. NEVER auto-submits; that
  // remains a prompt-level guarantee.
  // Non-Claude CLIs get no tool flags from spec.args(), so permission for them is
  // applied at the spawn boundary instead: spawnHeadlessCli takes what this kind
  // needs (capabilitiesFor) and cli-fencing.mjs translates it for the chosen
  // runtime — an OS sandbox on Codex, nothing yet on the runtimes with no
  // verified mechanism. Those report level "none" and the run says so
  // below, rather than looking identical to a fenced one (#2507).
  // A CLI with its own structured stream gets the argv that turns it on, so its
  // stdout matches spec.parseEvent below; spec.args stays the plain-text argv the
  // envelope-parsing routes rely on.
  const args = isClaude ? claudeCliArgs({ kind, prompt }) : (spec.streamArgs ?? spec.args)(prompt);

  // Model and effort are opt-in: absent, each CLI uses its own default. They are
  // set per CLI in Config, so a run that fell back to another CLI drops them. Values
  // go in as separate argv entries (never interpolated into a shell), so an odd
  // string is at worst an unknown-flag error, never injection. Effort is checked
  // against what the CLI accepts: grok exits non-zero on an unknown level and
  // codex fails the turn with a 400, so forwarding a bad value burns a whole run.
  if (!resolved.substitutedFrom) {
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
  }

  // Tracker-mutating runs hold a write token so a row delete can't race their
  // merge (tracker.mjs delete doesn't yet share a lock with merge-tracker,
  // see run-registry). evaluate's agent no longer writes; the backend persist
  // path below still merges the tracker, so the token stays.
  const writeToken = kind === "evaluate" || kind === "pdf" ? acquireTrackerWrite() : null;

  // stdin must reach EOF or the CLI waits on piped input that never comes: Codex's
  // `exec` blocks reading stdin for additional context, hangs until the kill timer,
  // and then reports a generic "installed and authenticated?" error that reads as an
  // auth failure even though the CLI is fully signed in. #1973 fixed that here with
  // an inline `stdio: ["ignore", …]`; spawnHeadlessCli generalizes the same fix to
  // every CLI-invoking route (assistant, explore/ai, cv/ingest, the apply planners),
  // which had the identical bug, and puts it behind one tested helper so it cannot
  // drift back in on any single call site.
  let child;
  try {
    child = spawnHeadlessCli(
      binPath,
      args,
      { cwd: careerOpsRoot(), env: process.env },
      { cliId, capabilities },
    );
  } catch (e) {
    // Fencing refuses an argv that contradicts the capability record, so nothing
    // spawned and the stream below — which owns finishRun — is never
    // constructed. Release the tracker guard HERE or it is held for the lifetime
    // of the process and acquireTrackerWrite blocks every later evaluate/pdf run:
    // a refused argv would take the tracker down with it.
    if (writeToken !== null) releaseTrackerWrite(writeToken);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "failed to start the CLI" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
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

  // The run belongs to the server, not to the request that started it. The
  // transcript goes to the job log (lib/core/job-log), and a client that loses
  // the stream (a locked phone, a backgrounded PWA, a closed tab) picks it back
  // up from GET /api/jobs/{id}/events?from=N. The client sends the id it will
  // resubscribe with; a missing or malformed one gets a fresh id instead.
  const jobId = runJobId(body.jobId);
  try {
    createJob({ id: jobId, kind, input, title: (typeof body.title === "string" && body.title.trim() ? body.title.trim() : `${kind} · ${input}`).slice(0, 200) });
  } catch {
    /* best-effort: an unwritable log costs the replay, never the run */
  }

  // Stream-lifetime state lives outside start() so cancel() (client disconnect)
  // can stop the heartbeat before the child's late handlers run.
  let killer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let channel: ReturnType<typeof createRunChannel> | undefined;
  // The guard is released once the child has closed AND the run has finalized,
  // which includes any pdf render or evaluate persist that runs after the
  // child. A client disconnect is neither, so it never releases the guard.
  const finishRun = createRunFinalizer(child, () => {
    if (writeToken !== null) releaseTrackerWrite(writeToken);
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Two states, not one `closed` flag: channel.attached (someone is reading
      // the stream) and channel.finalized (the run is over). Losing the reader
      // only stops enqueuing; the child, the transcript and the honesty gates
      // below keep running, and the kill timer still bounds a stuck agent.
      const ch = createRunChannel({
        enqueue: (line: string) => controller.enqueue(enc.encode(line)),
        closeStream: () => controller.close(),
        log: { append: (event: unknown) => appendEvent(jobId, event), finish: (record) => finishJob(jobId, record) },
        onDetach: () => { if (heartbeat) clearInterval(heartbeat); },
      });
      channel = ch;
      let buf = "";
      let emittedText = false; // any assistant text delta → the CLI actually ran
      // Set ONLY by an authoritative structured-stream signal (the ev.error branch
      // in processParsedLine below) — never by flagStderrLine. A stderr keyword
      // match is a guess, not a verdict; see stderrErrorSnippet.
      let sawError = false;
      let stderrBuf = "";
      // Fallback for a CLI with no CliSpec.stderrIsFatal of its own. Moved into
      // run-cli-support.mjs beside the per-CLI classifiers so it has a reachable
      // test: as an inline regex in this closure nothing could assert it, which
      // is how a bare `auth` came to match "Authentication successful" and mark a
      // successful run as failed on six of the eight runtimes (#1974).
      const isFatalStderr = spec.stderrIsFatal ?? isFatalGenericStderr;
      // Snippet only, never fatality. isFatalStderr is a keyword guess over a
      // CLI's own stderr chatter, not a verdict — trusting it to fail the run
      // outright is exactly the bug #1974 reported: "Authentication successful"
      // matched a bare `auth` and marked a clean, successful run as an error, on
      // six of the eight runtimes. The close handler below is the sole place that
      // decides fatality, from cleanExit and the CLI's own structured error event
      // (authoritative — see the ev.error branch in processParsedLine); this only
      // captures human-readable detail for whichever message that decision needs.
      let stderrErrorSnippet: string | null = null;
      const flagStderrLine = (line: string) => {
        if (stderrErrorSnippet || !line.trim() || !isFatalStderr(line)) return;
        stderrErrorSnippet = line.trim().slice(0, 200);
      };
      let lastTokens = 0; // per-run token cost from the CLI's structured usage event (#6) — local only
      let lastCostUsd: number | null = null;
      // pdf-mode's agent only tailors content now (rendering moved to the
      // backend, #2172) — but its killMs still has to leave real headroom
      // inside the route's overall maxDuration (800s): the render+mark phase
      // (renderPdf, below) starts only after this timer's window and has no
      // timeout of its own, so an agent that runs close to its full budget
      // would otherwise leave the platform's hard maxDuration cutoff to kill
      // generate-pdf.mjs mid-render. 600s agent / ~200s render is ample —
      // a Chromium PDF render normally takes low tens of seconds even with a
      // cold Playwright launch.
      // pdf keeps 600s because its render+mark phase runs AFTER this timer; a
      // plain evaluate has no such phase, so it can use almost the whole 800s
      // budget. 285s was cutting real evaluations off mid-run — reading the mode
      // and profile, fetching the posting, ~25 Bash calls and a few web searches
      // routinely run past it — and the SIGTERM then surfaced as "didn't save a
      // report" (see the close handler), blaming the CLI for a limit we imposed
      // (#3124). 780s leaves ~20s under maxDuration for a graceful shutdown.
      const killMs = killMsForKind(kind);
      // Set by the killer so the close handler can tell "we timed it out" apart
      // from "the CLI exited on its own" — different failures, different message.
      let killedByTimeout = false;
      killer = setTimeout(() => {
        killedByTimeout = true;
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, killMs);
      // Logged first, then streamed while a reader is attached. An enqueue that
      // throws detaches the reader (and stops the heartbeat, see onDetach) but
      // never throws out of here (see #1155).
      const send = (obj: unknown) => ch.send(obj);
      // Say so when the chosen runtime has no permission mechanism we can apply.
      // Claude gets tool allow/deny lists and Codex an OS sandbox; the rest run
      // with whatever they grant by default. Without this the two cases are
      // indistinguishable in the UI, and a run that is not fenced reads exactly
      // like one that is — which is the assumption #2507 was filed against.
      //
      // Sent as a status so it lands in job.steps, which the run detail page and
      // the saved run log both render in full. The worker card shows only the
      // latest step, so it also carries a sticky notice, matched via
      // isFencingNotice() rather than a literal spelled in two files.
      const fencing = fencingReport({ cliId, cliName: spec.name, capabilities: capabilitiesFor(kind) });
      if (fencing.notice) send({ type: "status", label: fencing.notice });
      if (substitution) send({ type: "status", label: substitution });
      // Time-based keepalive. The stream is silent whenever the agent is thinking
      // or inside a long tool call, and in pdf mode it is silent for the whole
      // 15-25 KB <<cv-html>> envelope (cvFilter swallows every byte). Measured
      // idle gaps on a real pdf run reached 149s — long enough for the browser or
      // a proxy to drop the connection, after which the client reports
      // "Connection error" even though the agent finished and the PDF rendered.
      // It must be a timer, not a hook on incoming text: piggy-backing on agent
      // output cannot fire during exactly the silences it needs to cover.
      // Unknown event types are ignored by the client's switch, so old tabs are safe.
      // ch.keepalive, not send: a keepalive is transport, not transcript, and
      // one in the job log every 10s would bury what a reconnecting client replays.
      heartbeat = setInterval(() => ch.keepalive(), 10_000);
      // Ends the run: records it in the job log (status from the terminal event
      // already sent), closes the stream if anyone still reads it, and lets the
      // finalizer release the tracker guard once the child has closed too.
      const close = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (killer) clearTimeout(killer);
        ch.finalize({ tokens: lastTokens, costUsd: lastCostUsd });
        finishRun();
      };
      // pdf's CV arrives inline in a <<cv-html>> envelope (#2185); evaluate's
      // report arrives in a <<report-md>> envelope. The filter keeps every byte
      // for the backend while holding the body out of the run log.
      const cvFilter = kind === "pdf" ? createCvEnvelopeFilter() : null;
      const reportFilter = kind === "evaluate" ? createReportEnvelopeFilter() : null;
      // While the agent emits the 15-25 KB <<cv-html>> envelope, cvFilter swallows
      // every byte, so the response stream goes completely silent for as long as
      // the model takes to write the CV — a minute or more. Nothing downstream can
      // tell that from a hung request, and the browser/proxy drops the connection;
      // the client then reports "Connection error" even though the agent is fine
      // and the PDF renders correctly server-side. Emit a throttled keepalive so
      // the stream never idles during the filtered phase. Unknown event types are
      // ignored by the client's switch, so this is safe for older tabs too.
      const sendAgentText = (text: string) => {
        const filter = cvFilter ?? reportFilter;
        const visible = filter ? filter.push(text) : text;
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

      // One dispatch for every structured CLI: the per-CLI knowledge (which event
      // means text/tool/status/usage) lives in run-cli-support.mjs behind
      // spec.parseEvent, so adding the next such CLI needs no change here.
      // Shared with the close-time flush below, so a final JSONL line the CLI never
      // newline-terminates before exiting isn't dropped along with the usage event
      // it carries.
      const joinAgentText = createAgentTextJoiner();
      const processParsedLine = (line: string) => {
        if (!spec.parseEvent) return;
        const ev = spec.parseEvent(line);
        const text = joinAgentText(ev);
        if (text) {
          emittedText = true;
          // sendAgentText, NEVER send: pdf's CV arrives inside the agent's text as a
          // <<cv-html>> envelope, so parsed text has to reach cvFilter too or the
          // backend has nothing to save and the 25 KB body floods the run log (#2185).
          sendAgentText(text);
        }
        if (ev?.tool) send(ev.toolDetail ? { type: "tool", name: ev.tool, detail: ev.toolDetail } : { type: "tool", name: ev.tool });
        if (ev?.status) send({ type: "status", label: ev.status });
        // Accumulated, not assigned: usage events are per-turn, so overwriting made a
        // multi-turn run report only its last turn. The authoritative "done" is sent
        // on close, so the honesty gate decides done-vs-error first.
        lastTokens = accumulateTokens(lastTokens, ev);
        if (typeof ev?.costUsd === "number") lastCostUsd = ev.costUsd;
        if (ev?.error) {
          sawError = true;
          send({ type: "error", msg: ev.error.slice(0, 200) });
        }
      };

      child.stdout.on("data", (chunk: string) => {
        // Gated on the run being over, NOT on a reader being attached:
        // emittedText/sawError feed the honesty gates in child.on("close"), so
        // skipping the parse after a disconnect would fail a completed run.
        if (ch.finalized) return;
        if (!spec.parseEvent) {
          emittedText = true;
          sendAgentText(chunk);
          return;
        }
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) processParsedLine(line);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        // Match on COMPLETE lines. A chunk boundary can fall mid-word, so testing a
        // raw chunk both misses an error split across two of them and can match a
        // fragment that is not the word it looks like. The captured snippet only
        // supplies message text for whichever failure the close handler already
        // decided on — it never sets sawError itself (see flagStderrLine above).
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
      // persistEval below.
      const persistEval = async (markdown: string) => {
        send({ type: "status", label: "Saving report…" });
        try {
          const result = await persistEvaluation({
            spawnFn: spawn,
            execPath: process.execPath,
            root: careerOpsRoot(),
            markdown,
            url: input,
            today,
            postedAt,
          });
          if (!result.ok) {
            send({ type: "error", msg: result.error.slice(0, 200) });
            return;
          }
          sendWarnings(result.warnings);
          const reportN = Number(result.num);
          // The report's own Machine Summary, so a client that was away for the
          // whole run gets the verdict from the transcript or /api/jobs alone.
          const summary = parseMachineSummary(markdown);
          const tldr = summary ? { ...summary, report: `reports/${result.reportFile}` } : undefined;
          send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd, ...(Number.isFinite(reportN) ? { reportN } : {}), ...(tldr ? { tldr } : {}) });
        } catch (e) {
          send({ type: "error", msg: `Evaluation persist crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
        } finally {
          close();
        }
      };
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
            reportNum: paths.reportNum,
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
        // Already finalized (a spawn error ended it). A disconnected client is
        // NOT a reason to stop here: the gates, the persist and the render below
        // still run, so the work is recorded whether or not anyone is reading.
        if (ch.finalized) return;
        // A timeout is the ROOT cause behind every "no report / not clean"
        // symptom the gates below test, so classify it FIRST, for any kind.
        // Otherwise a run we cut off at the time limit reads as "the CLI couldn't
        // save a report" and sends the user to re-check a CLI that was working
        // fine (#3124). code is null here (killed by signal), which the gates
        // would read as a generic non-clean exit.
        if (killedByTimeout) {
          send({
            type: "error",
            msg: timeoutMessage(killMs, kind),
          });
          return close();
        }
        // A final JSONL line with no trailing newline stays in `buf` forever
        // otherwise — flush it through the same parser so the usage/result event it
        // usually carries (the last one of a run) isn't lost. Ahead of the pdf branch,
        // not just the evaluate gate: the pdf path reports lastTokens too.
        const trailing = buf.trim();
        if (trailing) {
          buf = "";
          processParsedLine(trailing);
        }
        const cleanExit = code === 0; // non-zero OR null (killed/signal) = NOT clean
        // Shared by both honesty gates below — the pdf gate receives it as
        // pdfRunOutcome's noOutputMessage — because a CLI that produced no output at
        // all is the same failure mode whether it was evaluating or tailoring
        // a PDF — one place for the condition/message pair instead of two.
        const noOutputError = (): string | null => {
          if (!emittedText && !sawError && !cleanExit) {
            const detail = stderrErrorSnippet ? ` (${stderrErrorSnippet})` : "";
            return `The CLI exited with an error — is it installed and authenticated?${detail}`;
          }
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
              // close() happens once rendering finishes, not here.
              void renderPdf(pdfPaths, envelope.format);
              return;
            }
            // saveCv already streamed the specific reason.
          }
          return close();
        }

        if (kind === "evaluate") {
          const tail = reportFilter?.flush();
          if (tail) send({ type: "text", text: tail });
          const envelope = reportFilter?.result();
          const outcome = evaluateRunOutcome({
            envelope,
            noOutputMessage: noOutputError(),
            sawError,
            cleanExit,
          });
          if (!outcome.ok) {
            send({ type: "error", msg: outcome.message });
          } else if (envelope?.ok !== true) {
            send({ type: "error", msg: "Internal error: the evaluate run passed its gate with no report to save — please report this." });
          } else {
            // close() happens once the persist settles, not here.
            void persistEval(envelope.markdown);
            return;
          }
          return close();
        }

        // Honesty gate (#9): a green "done" with a parsed score requires a CLEAN exit
        // and real output. Anything else is surfaced. An errored run must never be
        // banked as a confident score.
        const baseErr = noOutputError();
        if (baseErr) {
          send({ type: "error", msg: baseErr });
        } else if (!cleanExit || sawError) {
          // Produced output (maybe even a report) but did NOT finish cleanly — flag it
          // instead of recording a confident score off a half-finished run. sawError
          // here means an authoritative structured error already sent its own
          // message above; a bare non-clean exit gets the stderr snippet instead,
          // when the heuristic classifier found one.
          const detail = !sawError && stderrErrorSnippet ? ` (${stderrErrorSnippet})` : "";
          send({ type: "error", msg: `This run hit an error before finishing, so it isn't recorded as a confident result — re-run it to verify.${detail}`.slice(0, 200) });
        } else {
          send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
        }
        close();
      });
    },
    cancel() {
      // The reader went away: a locked phone, a closed tab, a backgrounded PWA.
      // That is not a reason to destroy the work. The child keeps running, the
      // transcript keeps accruing, and the client resubscribes from the job log.
      // The kill timer stays armed, so a stuck agent is still bounded, and the
      // tracker guard stays held: close() releases it when the run really ends,
      // after any persist or render still writing the tracker.
      channel?.detach();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      // Lets a client that did not send its own id still find the run.
      "X-Job-Id": jobId,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
