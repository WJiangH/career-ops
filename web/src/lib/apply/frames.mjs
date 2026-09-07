// frames.mjs — which frames of an application page are worth touching, and how
// long any single per-frame call may take.
//
// Cloudflare's bot-management loader (/cdn-cgi/challenge-platform/…/jsd/main.js)
// leaves a frame with an EMPTY url on branded career pages that embed an ATS
// form — seen on coreweave.com, which fronts every CoreWeave Greenhouse posting
// (the job-boards.greenhouse.io URL 302s there). Any Playwright call against
// that frame never resolves, so the extractor's frame loop hung on every
// CoreWeave posting and the Apply page sat on "Reading your form…" forever.
//
// Two defenses, both cheap: skip frames that carry no URL, and bound every
// per-frame call so one bad frame costs seconds, not the session.
//
// Plain .mjs so the unit test can import it under Node without a TS runner
// (same pattern as clean-chips.mjs / profile-keywords.mjs).

/** Frames with a real URL that are still attached. The main frame always has one. */
export function liveFrames(page) {
  return page.frames().filter((f) => {
    try {
      const u = f.url();
      if (!u || u === "about:blank") return false;
      if (typeof f.isDetached === "function" && f.isDetached()) return false;
      return true;
    } catch {
      return false;
    }
  });
}

/** Resolve `p` or reject after `ms` with a named error, so a hung frame call
 *  surfaces as a caught, skippable failure instead of a stuck session. */
export function withTimeout(p, ms, label) {
  let timer;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, gate]).finally(() => clearTimeout(timer));
}

/** Per-frame budget for extraction / probing. Greenhouse embeds settle in
 *  well under this; a frame that needs longer is a frame we do not want. */
export const FRAME_CALL_MS = 10_000;
