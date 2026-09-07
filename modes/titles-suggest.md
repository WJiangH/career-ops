# Mode: titles-suggest — AI-proposed `title_filter` keywords from cv.md

## Purpose

Propose the keywords the portal scanner should search for, from the CV alone.
This is the AI-empowered path beside `modes/titles.md` (which widens an
existing list) and the template flow (`templates/portals.example.yml`, which
is what a user gets when no agent is available). It replaces neither.

You receive `cv.md` and, optionally, one line of targeting from the user.
Nothing else. The CV is the only evidence of capability; the user's line is
the only statement of intent.

## How the scanner matches — read this first

A keyword is matched against a posting's **title** as a case-insensitive
substring. A keyword of 2–3 characters is matched as a whole word instead.
Positives are OR'd: one match admits the posting. Negatives veto: one match
rejects it, whatever the positives said.

Three consequences decide everything below:

1. **Only words that appear in job titles can ever match.** Skills, tools,
   libraries and formats do not appear in titles. `llama.cpp`, `GGUF`,
   `PyTorch`, `quantization`, `RLHF` have never matched a posting and never
   will. The test for every keyword is one question: *would this string appear
   in the title of a job this person could be hired for?*
2. **A broad keyword costs a whole class of postings.** Bare `AI` admits
   `AI Tutor`, `AI Strategist`, `AI Success Manager`. Prefer the shortest phrase
   that still names a role family (`AI Engineer`, `Applied AI Engineer`), and
   never propose a bare 2–3 letter token.
3. **Negatives do the cleaning.** The families that carry a positive's word but
   are not engineering roles — managers, program managers, solutions
   architects, recruiters, tutors, counsel, developer relations — are removed
   by the exclude list, not by making every positive narrower.

## Step 1 — Persona, two sentences

Who is this person in market terms: what they do, what a hiring manager
would call them, which sub-field they sit in and which they do not. Every
clause traceable to cv.md. This is output, not scratch work — the user sees
the frame the keywords were chosen under.

## Step 2 — Three buckets

### `roles` — strong matches, 15–25

Title vocabulary for roles the CV's strongest evidence supports directly.
Include the market's names for the same work, not the CV's phrasing:
someone who tunes kernels and graph schedules is searched for as
`Performance Engineer`, `Compiler`, `Kernel`, not as "operator scheduling".
Include the level-neutral form (`Machine Learning Engineer`), not
`Senior Machine Learning Engineer` — seniority is handled elsewhere.

### `candidates` — weaker or adjacent, 10–20

Roles the CV makes plausible but not obvious: a level up, an adjacent
function, a sub-field the CV touches once. Each with a one-line `why` naming
the CV line behind it. The user promotes these one by one; a candidate the user
would never want is noise in this list too, so keep them credible.

### `exclude` — negatives, 10–15

Title fragments that share words with the roles above but are not this
person's work. Reason from the roles you proposed: for each broad-ish positive,
what non-engineering titles carry the same word?

## Rules

1. cv.md is the only evidence of capability. A keyword needs a CV line behind
   it — the line does not have to contain the keyword, but it has to exist.
2. Respect the user's targeting line if one is given: it can narrow (leave out
   a family the CV supports) or add intent (a stretch the user has chosen).
   It cannot add evidence.
3. Never invent experience in either direction.
4. Output title vocabulary only. No tools, no libraries, no formats, no
   metrics, no verbs.
5. Write nothing. This mode proposes; the caller replays every keyword against
   real scan history and shows the user the numbers before anything is written.

## Output contract

Return ONE JSON object. No prose before or after, no markdown fence.

```json
{
  "persona": "two sentences",
  "roles":      [ { "keyword": "Inference", "why": "cv.md: optimize LLM inference on NPU silicon" } ],
  "candidates": [ { "keyword": "Research Scientist", "why": "PhD, 1,000+ citations; current title is engineer" } ],
  "exclude":    [ { "keyword": "Solutions Architect", "why": "customer-facing; shares 'AI' with the roles above" } ]
}
```
