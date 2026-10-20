// lib/keyword-replay.mjs — the deterministic half of AI keyword suggestion.
//
// A model proposes title keywords; nothing about that proposal is trusted on
// assertion. Every keyword is replayed, with the scanner's REAL matcher, over
// the titles the scanner has already seen:
//
//   data/scan-history.tsv  — every posting a scan saw. Rows past the title
//                            filter are the admitted set (biased BY the
//                            current keywords: right for regression, useless
//                            for discovery); `skipped_title` rows are the
//                            rejected set, the only evidence for "what am I
//                            missing"
//   data/scan-rejects.tsv  — the same rejected titles as written by this fork's
//                            earlier reject log, still read so that history
//                            is not lost
//
// The numbers this returns are what the user confirms against: per keyword,
// how many titles it admits, how many ONLY it admits, and how many of those
// were previously rejected. Determinism lives here, not in the generator —
// two model runs may differ, but the same proposal always scores the same.
//
// Imports title-keywords.mjs, not scan.mjs: scan.mjs creates data/ at import
// time, and this module must be importable from a web route and from tests
// without side effects.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTitleFilter } from '../title-keywords.mjs';
import { parseScanHistoryLine } from './scan-history-columns.mjs';

function tsvColumn(path, col) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').slice(1)
    .map((l) => l.split('\t')[col])
    .filter((t) => t && t.trim());
}

/**
 * Titles from scan-history.tsv, split on the title filter's verdict. Pre-v1.18
 * rows carry three cells (url / date / title), whose title the current column
 * order reads as `portal`; they predate rejection records, so they are admitted.
 */
function historyTitles(path) {
  const admitted = [];
  const rejected = [];
  if (!existsSync(path)) return { admitted, rejected };
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines[0]?.startsWith('url\t')) lines.shift();
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = parseScanHistoryLine(line);
    const legacy = line.split('\t').length === 3;
    const title = (legacy ? row.portal : row.title).trim();
    if (!title) continue;
    (!legacy && row.status === 'skipped_title' ? rejected : admitted).push(title);
  }
  return { admitted, rejected };
}

/** Distinct admitted and rejected titles seen by past scans. */
export function loadCorpus(root) {
  const history = historyTitles(join(root, 'data', 'scan-history.tsv'));
  const admitted = [...new Set(history.admitted)];
  const rejected = [...new Set([...history.rejected, ...tsvColumn(join(root, 'data', 'scan-rejects.tsv'), 0)])];
  return { admitted, rejected };
}

/** Per-keyword evidence for ONE keyword against a negative list and a corpus. */
export function keywordStats(keyword, negative, corpus) {
  const f = buildTitleFilter({ positive: [keyword], negative });
  const admittedHits = corpus.admitted.filter((t) => f(t));
  const rejectedHits = corpus.rejected.filter((t) => f(t));
  return {
    keyword,
    hits: admittedHits.length + rejectedHits.length,
    admittedHits: admittedHits.length,
    rejectedHits: rejectedHits.length,
    examples: [...admittedHits.slice(0, 3), ...rejectedHits.slice(0, 3)],
  };
}

/**
 * Replay a proposal against the corpus and, optionally, against the filter it
 * would replace.
 *
 * @param {{positive: string[], negative: string[]}} proposal
 * @param {{admitted: string[], rejected: string[]}} corpus
 * @param {{positive: string[], negative: string[]}|null} baseline  current filter
 */
export function replayProposal(proposal, corpus, baseline = null) {
  const positive = proposal.positive ?? [];
  const negative = proposal.negative ?? [];
  const fNew = buildTitleFilter({ positive, negative });

  const keeps = corpus.admitted.filter((t) => fNew(t));
  const gains = corpus.rejected.filter((t) => fNew(t));

  const perKeyword = positive.map((k) => {
    const stats = keywordStats(k, negative, corpus);
    const others = buildTitleFilter({ positive: positive.filter((x) => x !== k), negative });
    const all = [...corpus.admitted, ...corpus.rejected].filter((t) => stats.hits && buildTitleFilter({ positive: [k], negative })(t));
    stats.unique = all.filter((t) => !others(t)).length;
    return stats;
  });

  let regression = null;
  if (baseline) {
    const fOld = buildTitleFilter({ positive: baseline.positive ?? [], negative: baseline.negative ?? [] });
    const before = corpus.admitted.filter((t) => fOld(t));
    const lost = before.filter((t) => !fNew(t));
    const gainedVsBaseline = [...corpus.admitted, ...corpus.rejected].filter((t) => fNew(t) && !fOld(t));
    regression = { before: before.length, after: keeps.length, lost, gained: gainedVsBaseline };
  }

  return {
    corpus: { admitted: corpus.admitted.length, rejected: corpus.rejected.length },
    keeps: keeps.length,
    gains: gains.length,
    gainedTitles: gains,
    perKeyword,
    zeroHit: perKeyword.filter((p) => !p.hits).map((p) => p.keyword),
    regression,
  };
}
