"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/cn";

type Issue = {
  kind: "template-profile" | "never-reviewed" | "stale-cv";
  severity: "blocker" | "warning";
  title: string;
  detail: string;
};

/**
 * Tells the user when the search no longer follows from the CV on file.
 *
 * It sits on the CV page because that is where the drift is created: saving a
 * CV writes cv.md and nothing else — no keyword is revisited, no target role is
 * re-derived — and until now nothing said so. The two failures it reports have
 * both already happened: a whole batch scored against the template author's
 * `_profile.md`, and a search still tuned to a previous CV.
 *
 * It reports and links. It never rewrites: `titles` writes keywords only behind
 * a confirmed diff, and `_profile.md` holds judgement calls no automated pass
 * should overwrite.
 */
export function PersonaBanner({ refreshKey }: { refreshKey?: number }) {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [marking, setMarking] = useState(false);

  const load = useCallback(() => {
    fetch("/api/persona", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setIssues(Array.isArray(d.issues) ? d.issues : []))
      .catch(() => setIssues([])); // offline: stay silent rather than cry wolf
  }, []);

  // refreshKey changes when the CV is saved, so the warning appears immediately
  // after the edit that caused it instead of on the next visit.
  useEffect(load, [load, refreshKey]);

  async function markReviewed() {
    setMarking(true);
    try {
      await fetch("/api/persona", { method: "POST" });
      load();
    } finally {
      setMarking(false);
    }
  }

  if (!issues || issues.length === 0) return null;

  const blocking = issues.some((i) => i.severity === "blocker");
  // Only the CV-drift half is something the user can declare resolved. A
  // template _profile.md is a real edit — clearing it with a button would let
  // someone dismiss the exact failure this exists to catch.
  const dismissable = !blocking;

  return (
    <div
      className={cn(
        "mb-5 rounded-2xl border p-4",
        blocking ? "border-red-500/40 bg-red-500/5" : "border-amber-500/40 bg-amber-500/5",
      )}
    >
      <div className="flex items-start gap-2.5">
        {blocking ? (
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-red-400" />
        ) : (
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {blocking ? "Your evaluations are not scoring against you" : "The search has drifted from this CV"}
          </p>
          <ul className="mt-2 space-y-2">
            {issues.map((i) => (
              <li key={i.kind} className="text-sm text-muted">
                <span className="text-foreground">{i.title}</span>
                <span className="block text-xs leading-relaxed">{i.detail}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-faint">
            Fix it by running <code className="font-mono text-muted">/career-ops titles</code> for the
            keywords, and editing <code className="font-mono text-muted">modes/_profile.md</code> for
            target roles. Both show you a diff before anything is written.
          </p>
          {dismissable && (
            <button
              type="button"
              onClick={markReviewed}
              disabled={marking}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs transition-colors hover:bg-surface max-sm:min-h-[44px]"
            >
              {marking ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
              I have reviewed the search against this CV
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
