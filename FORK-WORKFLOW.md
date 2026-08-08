# Fork workflow

This is a **soft fork** of [santifer/career-ops](https://github.com/santifer/career-ops).
Upstream moves fast — roughly 19 commits a day — so the branch model exists to
keep our own work and upstream-able fixes from tangling.

> This file lives on `jj` only. It must never reach a PR branch.

## Branches

| Branch | Role | Rule |
|--------|------|------|
| `main` | Pure mirror of `origin/main` | Never commit here. Only `git pull origin main`. |
| `jj` | Our working branch — what we actually run | Everything lands here, by merge. |
| `<topic>` | One self-contained, upstream-able change | Branched from `main`, never from `jj`. |

Merges only ever flow **topic → `jj`**. Never `jj` → topic: that would drag our
private state into a pull request.

## Remotes

```
origin  https://github.com/santifer/career-ops.git   (upstream — read-only for us)
fork    https://github.com/WJiangH/career-ops.git    (ours)
```

## Current topic branches

| Branch | What | Upstream-able |
|--------|------|---------------|
| `doctor-detect-unfilled-templates` | `doctor.mjs` flags personalization files still carrying template content | Yes — fixes a bug that silently mis-scored a real 19-role batch |
| `dashboard-posted-column` | POSTED column (requisition age) + stops the posting date polluting Last-contact | Yes |

## Recipes

**Start a change that could go upstream**

```bash
git checkout main && git pull origin main
git checkout -b some-topic
# ...work, test, commit...
git push -u fork some-topic
git checkout jj && git merge --no-ff some-topic
```

**Sync everything with upstream**

```bash
git checkout main && git pull origin main
git checkout some-topic && git rebase main && git push --force-with-lease fork some-topic
git checkout jj && git merge main
```

Rebase topic branches (they are ours alone, so rewriting is safe and keeps the
diff a maintainer sees minimal). Merge into `jj` — never rebase `jj`.

**Open the PR, when we decide to**

Upstream asks for an issue first, then a PR linking it. Topic branches are kept
independently pushable precisely so this needs no surgery later.

## What belongs where

The deciding question is not "should we give back" — it is **how hot is the code
we touched**. Every patch kept local is re-merged on every upstream sync, forever.

| Change | Home |
|--------|------|
| Bug in upstream code, on a hot path (`doctor.mjs`, `scan.mjs`, `modes/*`) | Topic branch → PR. Cheapest way to stop maintaining it ourselves. |
| Change to a cold, isolated module (`dashboard/`) | Topic branch; PR optional — it rots slowly. |
| Brand-new file, only we want it | Straight onto `jj`. Near-zero merge cost. |
| A new data source or exporter | A **plugin** repo (`ingest` / `provider` / `export` / `search` hooks) — zero fork divergence. |
| Visualization / anything with its own UI | A **separate repo** reading `data/applications.db` + `reports/*.md`. `DATA_CONTRACT.md` commits to those formats. |

## Before pushing anything

```bash
node test-all.mjs                                  # 3143 checks
cd dashboard && gofmt -l . && go vet ./... && go test ./...
```

Personal data (`cv.md`, `config/profile.yml`, `portals.yml`, `modes/_profile.md`,
`modes/_brief.md`, `data/`, `reports/`) is already git-ignored upstream, and
`test-all.mjs` asserts it. Keep it that way.
