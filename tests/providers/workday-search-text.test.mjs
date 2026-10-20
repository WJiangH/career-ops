// tests/providers/workday-search-text.test.mjs — server-side keyword search for
// the Workday provider. Without a query the provider crawls a whole tenant and
// filters locally; on a big retail/health board that means thousands of pages
// and facet slicing. With ctx.searchText the CXS API returns only the postings
// that match the title keywords. Two behaviours are pinned here because each
// fails silently: the query must reach the request body, and date early-stop
// must be OFF while a query is set (search results are relevance-ordered, so a
// stale page does not imply stale later pages).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — workday searchText');

try {
  const workdayModule = await import(pathToFileURL(join(ROOT, 'providers/workday.mjs')).href);
  const workday = workdayModule.default;
  const { buildSearchText } = workdayModule;

  const eq = (got, want, label) => (
    JSON.stringify(got) === JSON.stringify(want) ? pass(label) : fail(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  );

  // buildSearchText — phrases are quoted (an unquoted multi-word term would
  // become a flat OR of its words), prefixes only tune the local matcher, an
  // `a + b` group becomes AND terms, and duplicates/junk are dropped.
  eq(buildSearchText(['Machine Learning Engineer', 'Kernel']), '"machine learning engineer" OR "kernel"',
    'buildSearchText() quotes each phrase and joins with OR');
  eq(buildSearchText(['word:Kernel', 'stem:agent']), '"kernel" OR "agent"',
    'buildSearchText() drops word:/stem: prefixes');
  eq(buildSearchText(['AI + Systems']), '"ai systems"',
    'buildSearchText() turns an AND-group into space-joined (AND) terms');
  eq(buildSearchText(['Kernel', 'kernel', 'KERNEL']), '"kernel"',
    'buildSearchText() de-duplicates case-insensitively');
  eq(buildSearchText(['say "hi"', 'C++']), '"say hi" OR "c++"',
    'buildSearchText() strips quotes that would break the query and keeps "C++"');
  eq([buildSearchText([]), buildSearchText(undefined), buildSearchText(['', '  ', null, 42])], ['', '', ''],
    'buildSearchText() returns "" (no search) when nothing is usable');

  const mkCtx = (fetchJson, extra = {}) => ({
    transport: 'http',
    fetchText: async () => { throw new Error('fetchText should not be called'); },
    fetchJson,
    sleep: async () => {},
    ...extra,
  });
  const entry = { name: 'Acme', careers_url: 'https://acme.wd5.myworkdayjobs.com/External' };

  // The query reaches every request body (page 0 and later pages).
  const bodies = [];
  await workday.fetch(entry, mkCtx(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    return { total: 40, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Job ${body.offset}-${i}`, externalPath: `/job/x/${body.offset}-${i}`, postedOn: 'Posted Today' })) };
  }, { searchText: '"kernel" OR "inference"' }));
  if (bodies.length === 2 && bodies.every((b) => b.searchText === '"kernel" OR "inference"')) {
    pass('workday.fetch() sends ctx.searchText on every page request');
  } else {
    fail(`workday searchText not on every request: ${JSON.stringify(bodies.map((b) => b.searchText))}`);
  }

  // No ctx.searchText → the body keeps the empty query it always sent.
  const plain = [];
  await workday.fetch(entry, mkCtx(async (_url, opts) => {
    plain.push(JSON.parse(opts.body).searchText);
    return { total: 1, jobPostings: [{ title: 'One', externalPath: '/job/x/1', postedOn: 'Posted Today' }] };
  }));
  eq(plain, [''], 'workday.fetch() without ctx.searchText still sends an empty query');

  // Early-stop is disabled with a query: page 0 ranks a 20-days-old posting
  // first, a 2-days-old one only on page 1. Newest-first early-stop would quit
  // after page 0 and never see the fresh one.
  const sinceMs = Date.now() - 7 * 86_400_000;
  const relevanceOrdered = (offset) => (offset === 0
    ? Array.from({ length: 20 }, (_, i) => ({ title: `Old ${i}`, externalPath: `/job/x/old-${i}`, postedOn: 'Posted 20 Days Ago' }))
    : Array.from({ length: 20 }, (_, i) => ({ title: `Fresh ${i}`, externalPath: `/job/x/fresh-${i}`, postedOn: 'Posted 2 Days Ago' })));

  let searchRequests = 0;
  const searched = await workday.fetch(entry, mkCtx(async (_url, opts) => {
    searchRequests++;
    return { total: 40, jobPostings: relevanceOrdered(JSON.parse(opts.body).offset) };
  }, { sinceMs, searchText: '"kernel"' }));
  if (searchRequests === 2 && searched.some((j) => j.title === 'Fresh 0')) {
    pass('workday.fetch() does not early-stop on a stale page when a search is active (relevance order)');
  } else {
    fail(`workday searchText early-stop: requests=${searchRequests}, sawFresh=${searched.some((j) => j.title === 'Fresh 0')} (expected 2/true)`);
  }

  // Control: the same data without a query still early-stops, so the carve-out
  // is specific to searches and the default crawl keeps its optimization.
  let plainRequests = 0;
  await workday.fetch(entry, mkCtx(async (_url, opts) => {
    plainRequests++;
    return { total: 1_000_000, jobPostings: relevanceOrdered(JSON.parse(opts.body).offset === 0 ? 0 : 0) };
  }, { sinceMs }));
  if (plainRequests === 1) {
    pass('workday.fetch() still early-stops on a stale first page when no search is set');
  } else {
    fail(`workday default early-stop regressed: requests=${plainRequests} (expected 1)`);
  }
} catch (e) {
  fail(`workday searchText test crashed: ${e?.stack || e}`);
}
