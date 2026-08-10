"use client";

import { useEffect, useState } from "react";
import { CloudOff, Loader2 } from "lucide-react";

// Tells you when the Mac stopped answering.
//
// Everything here runs on your own machine, so "offline" has a specific and
// recoverable meaning the browser's own online/offline events cannot express:
// the phone has perfectly good Wi-Fi, the *Mac* is asleep, or you walked out of
// the house and off its network. Without this the app just hangs on a spinner
// or shows a raw fetch error, and the actual cause — plug the laptop back in —
// is nowhere on screen.
//
// Polls /api/version: the cheapest route that proves the server is really
// serving, not just that something answered the port.

const OK_MS = 20_000; // healthy: a slow heartbeat is enough to notice a sleep
const DOWN_MS = 5_000; // unreachable: check back often so recovery feels instant

export function ConnectionBanner() {
  const [down, setDown] = useState(false);
  // Never flash on the very first tick — a cold start or a slow first paint
  // would otherwise show "unreachable" for a moment on every launch.
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;

    const check = async () => {
      if (stop) return;
      let ok = false;
      try {
        // 4s cap: a sleeping Mac does not refuse the connection, it black-holes
        // it, so without a timeout this hangs instead of reporting anything.
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch("/api/version", { cache: "no-store", signal: ctl.signal });
        clearTimeout(t);
        ok = r.ok;
      } catch {
        ok = false;
      }
      if (stop) return;
      setDown(!ok);
      setSettled(true);
      timer = setTimeout(check, ok ? OK_MS : DOWN_MS);
    };

    // Re-check the instant the phone could plausibly be back: returning to the
    // app after it was backgrounded, or the OS regaining a network. Waiting out
    // the poll interval makes a recovered connection feel broken.
    const wake = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        void check();
      }
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    void check();

    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  }, []);

  if (!settled || !down) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[80] flex items-center justify-center gap-2 bg-amber-500/95 px-4 py-2 text-center text-xs font-medium text-black shadow-md"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      <CloudOff className="size-3.5 shrink-0" />
      <span>Your Mac isn&apos;t answering — it may be asleep, or you&apos;re off its network.</span>
      <Loader2 className="size-3.5 shrink-0 animate-spin opacity-70" />
    </div>
  );
}
