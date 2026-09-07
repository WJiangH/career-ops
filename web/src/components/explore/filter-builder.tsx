"use client";

import { useState } from "react";
import { X, Ban, Clock, MapPin, ChevronDown, SlidersHorizontal, Plus, Sparkles, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { ATS_LABEL, ATS_SOURCES, cleanChips, type AtsSource, type ExploreFilters } from "@/lib/explore";

const RECENCY = [
  { label: "24h", days: 1 },
  { label: "3d", days: 3 },
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
];

const STYLE = `
.co-fb__chip{display:inline-flex;align-items:center;gap:.3rem;border-radius:999px;padding:.2rem .5rem .2rem .6rem;font-size:12.5px;line-height:1.2;border:1px solid transparent}
.co-fb__chip button{display:inline-flex;opacity:.6;transition:opacity .15s}
.co-fb__chip button:hover{opacity:1}
.co-fb__chip.cand{color:var(--co-muted,hsl(0 0% 40%));background:transparent;border-color:hsl(0 0% 50% / .35);border-style:dashed}
.co-fb__chip.cand button.promote{opacity:.85}
.co-fb__chip.inc{color:hsl(26 78% 42%);background:hsl(26 73% 51% / .11);border-color:hsl(26 73% 51% / .26)}
html.dark .co-fb__chip.inc{color:hsl(26 86% 70%);background:hsl(26 80% 55% / .14);border-color:hsl(26 80% 55% / .28)}
.co-fb__field{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;min-height:2.6rem;padding:.45rem .55rem;border-radius:.7rem}
.co-fb__field input{flex:1;min-width:7rem;background:transparent;border:none;outline:none;font-size:13.5px;color:inherit}
.co-fb__field input::placeholder{color:var(--co-faint,hsl(0 0% 60%))}
@media (max-width:639px){.co-fb__chip button{min-width:44px;min-height:44px;justify-content:center}.co-fb__chip{min-height:44px}.co-fb__field{min-height:44px}.co-fb__field input{min-height:32px}}
`;

function KeywordField({
  values,
  tone,
  placeholder,
  onChange,
}: {
  values: string[];
  tone: "inc" | "exc";
  placeholder: string;
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  // Split only on UNAMBIGUOUS item separators (comma / newline / semicolon) — never
  // bare spaces, which are legitimate inside multi-word entries ("AI platform",
  // "New York", "Costa Rica"). A space-only paste stays one chip on purpose (#1147).
  const commit = (text: string) => {
    const parts = text.split(/[,\n;\t\r]+/);
    const next = cleanChips([...values, ...parts]);
    onChange(next);
    setDraft("");
  };
  return (
    <div className={cn("co-fb__field border border-border bg-surface/40 focus-within:border-brand/40 transition-colors")}>
      {values.map((v) => (
        <span key={v} className={cn("co-fb__chip", tone === "inc" ? "inc" : "border-border bg-surface-hover text-muted")}>
          {tone === "exc" && <Ban className="size-3 opacity-70" />}
          {v}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => {
          const val = e.target.value;
          if (/[,\n;\t\r]$/.test(val)) commit(val);
          else setDraft(val);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData("text");
          const merged = draft + text;
          // Only commit to chips when the paste contains item separators.
          // A plain-text paste (e.g. pasting "-EMEA" after typing "Remote")
          // stays in the input field so the user can keep editing.
          if (/[,;\n\t\r]/.test(text)) commit(merged);
          else setDraft(merged);
        }}
        onBlur={() => draft.trim() && commit(draft)}
        placeholder={values.length ? "" : placeholder}
      />
    </div>
  );
}

function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between">
      <span className="text-[13px] font-medium text-foreground">{children}</span>
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
    </div>
  );
}

type SuggestBucket = { keyword: string; why: string; hits?: number; unique?: number; rejectedHits?: number; vetoes?: number };
type SuggestResult = { source: string | null; persona: string; roles: SuggestBucket[]; candidates: SuggestBucket[]; exclude: SuggestBucket[]; demoted: string[] };

/** Candidate keywords: AI-suggested, not yet searched for. "+" promotes one into
 *  Roles to find; "×" dismisses it. The hover text carries the model's one-line
 *  reason and the replay numbers, so promoting is a decision with evidence. */
function CandidateRow({
  values,
  reasons,
  onPromote,
  onDismiss,
}: {
  values: string[];
  reasons: Map<string, string>;
  onPromote: (k: string) => void;
  onDismiss: (k: string) => void;
}) {
  return (
    <div className={cn("co-fb__field border border-dashed border-border/70 bg-transparent")}>
      {values.map((v) => (
        <span key={v} className="co-fb__chip cand" title={reasons.get(v) ?? "AI-suggested; not searched for until promoted"}>
          {v}
          <button type="button" className="promote" aria-label={`Add ${v} to roles`} onClick={() => onPromote(v)}>
            <Plus className="size-3" />
          </button>
          <button type="button" aria-label={`Dismiss ${v}`} onClick={() => onDismiss(v)}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      {values.length === 0 && <span className="text-[12px] text-faint">none yet — Suggest from CV fills this row</span>}
    </div>
  );
}

export function FilterBuilder({
  filters,
  onChange,
  seededFrom = [],
  cliId = null,
}: {
  filters: ExploreFilters;
  onChange: (f: ExploreFilters) => void;
  seededFrom?: string[];
  /** the user's configured agent CLI (localStorage career-ops:config.cliId); null = none */
  cliId?: string | null;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Map<string, string>>(new Map());
  const set = (patch: Partial<ExploreFilters>) => onChange({ ...filters, ...patch });
  const candidates = filters.candidates ?? [];

  const promote = (k: string) =>
    onChange({ ...filters, positive: cleanChips([...filters.positive, k]), candidates: candidates.filter((c) => c !== k) });
  const dismiss = (k: string) => set({ candidates: candidates.filter((c) => c !== k) });

  const describe = (b: SuggestBucket) => {
    const n: string[] = [];
    if (typeof b.hits === "number") n.push(`${b.hits} seen title${b.hits === 1 ? "" : "s"}`);
    if (typeof b.rejectedHits === "number" && b.rejectedHits > 0) n.push(`${b.rejectedHits} previously rejected`);
    return [b.why, n.join(" · ")].filter(Boolean).join(" — ");
  };

  const suggest = async () => {
    setSuggesting(true);
    setSuggestNote(null);
    try {
      const r = await fetch("/api/explore/suggest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cliId }) });
      const j = (await r.json()) as SuggestResult & { error?: string };
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      const next = new Map<string, string>();
      for (const b of [...j.roles, ...j.candidates]) next.set(b.keyword, describe(b));
      setReasons(next);
      const roles = cleanChips(j.roles.map((b) => b.keyword));
      const cands = cleanChips(j.candidates.map((b) => b.keyword)).filter((k) => !roles.includes(k));
      // Roles replace (this is an explicit "from my CV" action); excludes merge —
      // a negative the user already typed is never dropped by a suggestion.
      onChange({
        ...filters,
        positive: roles,
        candidates: cands,
        negative: cleanChips([...filters.negative, ...j.exclude.map((b) => b.keyword)]),
      });
      setSuggestNote(`${j.source ? `${j.source}: ` : ""}${roles.length} roles, ${cands.length} candidates, ${j.exclude.length} excludes. ${j.persona}`);
    } catch (e) {
      setSuggestNote(e instanceof Error ? e.message : "suggestion failed");
    } finally {
      setSuggesting(false);
    }
  };
  const toggleAts = (a: AtsSource) => {
    const has = filters.ats.includes(a);
    const next = has ? filters.ats.filter((x) => x !== a) : [...filters.ats, a];
    set({ ats: next.length ? next : filters.ats });
  };

  return (
    <div className="space-y-4">
      <style>{STYLE}</style>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-[13px] font-medium text-foreground">Roles to find</span>
          <span className="flex items-center gap-3">
            {filters.positive.length === 0 && <span className="text-[11px] text-faint">empty = every fresh posting</span>}
            <button
              type="button"
              onClick={() => void suggest()}
              disabled={suggesting || !cliId}
              title={cliId ? "Ask your agent CLI to read cv.md and propose roles, candidates and excludes" : "Configure an agent CLI in Config to enable suggestions"}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-brand disabled:opacity-40"
            >
              {suggesting ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />} Suggest from CV
            </button>
          </span>
        </div>
        <KeywordField values={filters.positive} tone="inc" placeholder="AI platform, ML infrastructure, staff engineer…" onChange={(v) => set({ positive: v })} />
        {seededFrom.length > 0 && filters.positive.length > 0 && !suggestNote && (
          <p className="mt-1 text-[11px] text-faint">Seeded from your {seededFrom.join(" + ")} — edit freely.</p>
        )}
        {suggestNote && <p className="mt-1 text-[11px] text-faint">{suggestNote}</p>}
      </div>

      <div>
        <Label hint="AI-suggested, weaker matches — + adds one to Roles to find">Candidates</Label>
        <CandidateRow values={candidates} reasons={reasons} onPromote={promote} onDismiss={dismiss} />
      </div>

      <div>
        <Label>Exclude</Label>
        <KeywordField values={filters.negative} tone="exc" placeholder="manager, sales, contract…" onChange={(v) => set({ negative: v })} />
      </div>

      <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
        <div>
          <Label hint="postings published in this window">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="size-3.5 text-muted" /> Posted within
            </span>
          </Label>
          <div className="inline-flex rounded-lg border border-border bg-surface/40 p-0.5">
            {RECENCY.map((r) => (
              <button
                key={r.days}
                type="button"
                onClick={() => set({ sinceDays: r.days })}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px]",
                  filters.sinceDays === r.days ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <Label hint={filters.ats.length === 0 ? "pick at least one" : undefined}>Sources</Label>
          <div className="flex flex-wrap gap-1.5">
            {ATS_SOURCES.map((a) => {
              const on = filters.ats.includes(a);
              return (
                <button
                  key={a}
                  type="button"
                  onClick={() => toggleAts(a)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px]",
                    on ? "border-brand/40 bg-brand-soft text-brand" : "border-border text-muted hover:text-foreground",
                  )}
                >
                  {ATS_LABEL[a]}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setAdvanced((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-foreground transition-colors max-sm:min-h-[44px]"
      >
        <SlidersHorizontal className="size-3.5" />
        Location &amp; scope
        <ChevronDown className={cn("size-3.5 transition-transform", advanced && "rotate-180")} />
      </button>

      {advanced && (
        <div className="space-y-3 rounded-xl border border-border bg-surface/30 p-3">
          <div className="flex items-center gap-1.5 text-[12px] text-muted">
            <MapPin className="size-3.5" /> Location
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label hint="rescues multi-loc posts">Always include</Label>
              <KeywordField values={filters.alwaysAllow} tone="inc" placeholder="London…" onChange={(v) => set({ alwaysAllow: v })} />
            </div>
            <div>
              <Label>Only in</Label>
              <KeywordField values={filters.allow} tone="inc" placeholder="Remote, EMEA…" onChange={(v) => set({ allow: v })} />
            </div>
            <div>
              <Label>Never in</Label>
              <KeywordField values={filters.block} tone="exc" placeholder="India…" onChange={(v) => set({ block: v })} />
            </div>
          </div>
          <div>
            <Label hint="hard reject — overrides Always include">Never in (hard)</Label>
            <KeywordField values={filters.blockHard} tone="exc" placeholder="USA, Brazil…" onChange={(v) => set({ blockHard: v })} />
          </div>
          <div>
            <Label hint={`${filters.limitPerAts} companies / source`}>Scan depth</Label>
            <input
              type="range"
              min={50}
              max={500}
              step={50}
              value={filters.limitPerAts}
              onChange={(e) => set({ limitPerAts: Number(e.target.value) })}
              className="w-full accent-brand"
            />
          </div>
        </div>
      )}
    </div>
  );
}
