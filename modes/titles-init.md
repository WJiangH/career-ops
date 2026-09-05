# Mode: titles-init — CV-derived `title_filter.positive`, day zero

## Purpose

`modes/titles.md` BROADENS an existing filter. By its own Error Handling it
refuses to run on an empty `title_filter.positive`, and by its Confirm Gate it
only ever adds. So it cannot be the thing that creates the list — and today
nothing is: `doctor.mjs` tells a new user to
`cp templates/portals.example.yml portals.yml`, which hands them the template
author's market. Measured against one real CV: 6 of the template's 37 keywords
overlap, and the resulting filter rejects the candidate's own current job title.

This mode is the day-zero counterpart. It runs as the second half of
`titles-derive.mjs`, after a deterministic pass has already read `cv.md`.

## What has already happened

`lib/cv-keywords.mjs` has read `cv.md`'s Experience and Skills sections and
produced CANDIDATES. That pass is mechanical, byte-identical across runs, and
already handles what does not need judgement:

- job titles from Experience entries, with seniority stripped
- skills from the Skills section, split into domain vs tooling **using the CV's
  own category labels** (`**Tools:**` is excluded; `**ML Systems & Inference:**`
  is not)
- 1–3 word windows, so `Model Quantization` also yields `Quantization`
- bare head nouns (`Engineer`, `Data`, `Model`) marked as unusable alone
- REDUNDANCY GROUPS — pairs where one keyword already covers another under
  substring matching

**Do not re-derive the list.** Your job is the three things that pass cannot do.

## Step 1 — Persona first

Before touching a keyword, write two or three sentences on who this person is
in market terms: what they actually do, what a hiring manager would call them,
and which sub-field they sit in. Ground every clause in `cv.md`.

This exists because the operations below are only as good as the frame. A
reviewer who has not first decided "this is an ML systems engineer working at
the silicon boundary" will keep `Bayesian` and drop `NPU`, both defensibly, and
produce an incoherent filter.

The persona is output, not scratch work — it goes in the JSON so the user can
see the frame the edits were made under and disagree with it.

## Step 2 — Three operations

The scanner matches a **case-insensitive substring** of a posting's title. A
keyword of 2–3 characters is matched on word boundaries instead. Positives are
OR'd: adding one can never reject a good posting, it can only admit more.

### `rewrite` — change a candidate so it matches real postings

The mechanical pass produces what the CV says, and CVs are not written in
posting language. Rewrite when the same claim has a market form:

- an artefact of the CV's punctuation — `Research Assistant Teaching` came from
  "Research Assistant & Teaching Fellow" and is not a phrase anyone posts
- a CV-only compound where the market uses a different head — `LLM Evaluation`
  vs `Model Evaluation`
- casing that does not match the rest of `portals.yml`

Rewrite, do not invent: the rewritten keyword must describe the same evidence.
If it describes different work, it is an `add`.

### `add` — the market's vocabulary for this person. **This is the main step.**

The mechanical pass can only return words that are in the CV, and a CV says
what someone did, not what the market calls it. Measured on one real CV against
a hand-curated filter that was working: of 49 keywords that between them matched
541 of 543 real postings, **only 10 appear anywhere in the CV — prose
included**. The other 39 (`Foundation Model`, `Post-Training`, `Research
Scientist`, `SystemVerilog`, `MLIR`, `CUDA`, `Triton`, `Compiler`,
`Accelerator`, …) are market vocabulary. Extraction cannot invent them, and a
filter built from extraction alone recalled 30%.

So do not treat this as a synonym pass over CANDIDATES. Start from the persona
and ask the recruiting question:

> **What does a job board call the roles this person would be hired into?**

Work outward along the axes the persona names — the sub-field's technologies,
its adjacent titles, the levels above and beside, the specialisations a team
doing this work posts for. A keyword belongs if a posting carrying it is one
this person could credibly apply to.

Aim for coverage of the whole space the persona describes, not a short list.
Twenty to forty additions is normal; five means you renamed things instead of
expanding.

**Grounding.** The evidence requirement is on the CAPABILITY, not the wording:
`why` must say which `cv.md` line makes this person a plausible candidate for
that title. `MLIR` is legitimate for someone whose CV evidences graph- and
kernel-level compiler work even though the CV never writes "MLIR". What stays
forbidden is a keyword with no line behind it at all — a title this person could
not actually apply to is a wasted evaluation, not a wider net.

Two things to keep checking as you expand:

- **Stay inside the persona.** If the persona says "not a data scientist, not a
  career academic", then `Data Scientist` and `Research Fellow` are out however
  much of the CV points at them. An incoherent filter is worse than a narrow one.
- **Respect breadth.** Positives are OR'd and match substrings, so a generic
  addition costs a whole class of irrelevant postings, each one a real
  evaluation. Prefer the shortest phrase that still identifies the role family.

### `drop` — candidates that are not role families

Tool, library, format and architecture names (`llama.cpp`, `GGUF`, `PyTorch`,
`CNNs`, `VAEs`), and words so generic they defeat the filter.

**A drop justified by "it would match unrelated titles" must name those titles
in `false_positives`.** Each is run through the scanner's real matcher before it
is shown. This is checked because the failure mode is confident rather than
hedged: a model proposed dropping `AI` because it "matches inside 'Training',
'Retail', 'Domain', 'Maintain'". None of those match — `compileKeyword`
word-boundaries any keyword of 2–3 characters, precisely so that short ones
cannot. Acting on it would have removed a correct keyword for a false reason.

### Redundancy groups — pick a side

Each group is one broader keyword and the narrower ones it already covers, so
keeping both is keeping one. Choose the keeper, and note it in `keep`. The
answer goes both ways, which is why it is not decided mechanically:

- `Machine Learning` over `Machine Learning Engineer` — broader and still
  on-target, so the shorter one wins
- `Model Serving` over `Serving` — `Serving` matches food-service postings, so
  the longer one wins

## Output contract

Return ONE JSON object. No prose, no markdown fence.

```json
{
  "persona": "2-3 sentences, every clause traceable to cv.md",
  "rewrite": [
    { "from": "<a CANDIDATE>", "to": "<market form>", "why": "<one line>" }
  ],
  "add": [
    { "keyword": "Model Compression", "axis": "lateral",
      "why": "market term for <verbatim cv.md quote>" }
  ],
  "drop": [
    { "keyword": "<a CANDIDATE>", "why": "<one line>",
      "false_positives": ["<posting titles this would wrongly admit>"] }
  ],
  "keep": [
    { "group": "<the group's broad keyword>", "keep": "<the one to keep>",
      "why": "<one line>" }
  ]
}
```

`axis` is `lateral` (same work, different label), `stretch` (a level up or
larger scope than the CV's strongest evidence) or `pivot` (an adjacent function
reachable from CV evidence).

## Rules

1. **`cv.md` is the only evidence — of capability.** Every keyword needs a line
   behind it saying why this person could be hired for that role. The line does
   not have to contain the keyword: the market's word for a capability is
   usually not the CV's. What is forbidden is a keyword with no line at all.
   This is the same source-of-truth boundary `modes/_shared.md` applies to CV
   content, applied to what the candidate can do rather than to how they wrote
   it — a filter is a search, not a claim made to an employer.
2. **Respect the deal-breakers in `modes/_profile.md`.** Never propose a keyword
   for work the user has excluded, and never one that fights
   `title_filter.negative`.
3. **Never invent experience** in either direction — do not stretch a quote to
   fit a title, and do not discount what the CV plainly states.
4. **Write nothing.** This mode proposes; `portals.yml` is written only after
   the user has seen the exact YAML diff and said yes. Same hard rule as
   `modes/titles.md`'s Confirm Gate. "Show me the diff" is not a yes.
