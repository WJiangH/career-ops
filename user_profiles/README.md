# user_profiles/

Your own source documents. **Nothing in this folder is ever committed** — the
`.gitignore` covers everything except this README.

career-ops treats `cv.md` in the project root as the single canonical CV, and it
has no home for the files that CV was built from. This is that home.

## What belongs here

- **Source resumes** — the `.docx` / `.pdf` you actually edit, plus older versions
- **Per-company archives** — the exact resume and cover letter sent to each employer
- **Credentials** — transcripts, diplomas, certifications, publication lists
- **Correspondence** — reference letters, offer letters, recruiter threads worth keeping
- **Immigration paperwork** — I-797, I-20, EAD, visa stamps, attorney correspondence
- Anything else personal you want beside the project rather than loose on your desktop

## What does NOT belong here

| Instead of here | Put it in | Why |
|---|---|---|
| Your CV as text | `cv.md` (project root) | The canonical source every mode reads |
| Structured identity, comp target, work authorization | `config/profile.yml` | Read by evaluation and form-filling |
| Your archetypes and targeting narrative | `modes/_profile.md` | Drives A–F scoring |
| Your writing, for voice matching | `writing-samples/` | Feeds `voice-dna.md` |
| Job descriptions saved locally | `jds/` | Referenced as `local:jds/{file}` |
| Generated CV/cover-letter PDFs | `output/` | Build output, regenerated on demand |

career-ops does not read this folder. It is storage, not input — which is the
point: nothing here can silently leak into a generated CV or a form answer.
If a fact should reach your applications, it has to be written into `cv.md`
first, deliberately. That is the Source-of-Truth Boundary in `AGENTS.md`.

## A suggested layout

```
user_profiles/
├── resumes/          Resume_2026.docx, Resume_2026.pdf, older versions
├── applications/     {company}-{role}/ — exactly what was sent, and when
├── credentials/      transcripts, diplomas, certifications
└── immigration/      I-797, I-20, EAD, attorney correspondence
```

## Before you push

The ignore rule is `/user_profiles/*` with a single negation for this README.
To confirm nothing is staged:

```bash
git status --porcelain user_profiles/
```

Empty output means you are clean. `node test-all.mjs` also asserts the
user-layer ignore rules on every run.
