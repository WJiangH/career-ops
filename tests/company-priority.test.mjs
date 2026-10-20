// tests/company-priority.test.mjs — which companies a capped reverse-ATS scan
// looks at first. The default sample is the dataset's alphabetical prefix, so
// with a 150 cap on a 12,884-board list a scan never leaves the "a…" boards.
// --prefer-known puts the user's tracked / past-match companies first and
// fills the rest of the cap at random.
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { pass, fail, rmSync, ROOT } from './helpers.mjs';

console.log('\ncompany-priority — known-first sampling');

const { slugFromUrl, loadKnownCompanies, sampleWithPriority, datasetKey } =
  await import(pathToFileURL(join(ROOT, 'lib/company-priority.mjs')).href);

const eq = (got, want, label) => (
  JSON.stringify(got) === JSON.stringify(want) ? pass(label) : fail(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
);

// slugFromUrl — every ATS host shape the dataset covers, and nothing else.
eq(slugFromUrl('https://job-boards.greenhouse.io/Anthropic'), 'anthropic', 'slugFromUrl: greenhouse job-boards host');
eq(slugFromUrl('https://boards-api.greenhouse.io/v1/boards/polyai/jobs'), 'polyai', 'slugFromUrl: greenhouse API url');
eq(slugFromUrl('https://job-boards.eu.greenhouse.io/polyai'), 'polyai', 'slugFromUrl: greenhouse EU host');
eq(slugFromUrl('https://jobs.lever.co/ekimetrics/abc-123'), 'ekimetrics', 'slugFromUrl: lever posting url');
eq(slugFromUrl('https://jobs.ashbyhq.com/openai/2d7f9a7c'), 'openai', 'slugFromUrl: ashby posting url');
eq(slugFromUrl('https://adobe.wd5.myworkdayjobs.com/external_experienced/job/San-Jose/x_R1'), 'adobe', 'slugFromUrl: workday tenant');
eq(slugFromUrl('https://openai.com/careers'), null, 'slugFromUrl: a non-ATS host is not a slug');
eq(slugFromUrl('not a url'), null, 'slugFromUrl: garbage input is null, not a throw');

// datasetKey — slug, or the tenant of a workday triple.
eq([datasetKey('Anthropic'), datasetKey('adobe|wd5|external_experienced')], ['anthropic', 'adobe'],
  'datasetKey() lowercases a slug and takes the tenant of a workday triple');

// sampleWithPriority
const list = ['aaa', 'aab', 'aac', 'aad', 'anthropic', 'openai', 'zzz', 'adobe|wd5|ext'];
const known = new Set(['anthropic', 'openai', 'adobe']);
const fixedRng = () => 0.5;
{
  const got = sampleWithPriority(list, 4, known, fixedRng);
  eq(got.slice(0, 3), ['anthropic', 'openai', 'adobe|wd5|ext'],
    'sampleWithPriority() puts known companies first, in dataset order (workday tenants match too)');
  eq(got.length, 4, 'sampleWithPriority() honours the cap');
  eq(got.slice(3).every((e) => !known.has(datasetKey(e))), true, 'sampleWithPriority() fills the rest from the unknown companies');
}
eq(sampleWithPriority(list, 2, known, fixedRng), ['anthropic', 'openai'],
  'sampleWithPriority() truncates known companies when they alone exceed the cap');
eq(sampleWithPriority(list, Infinity, known, fixedRng).length, list.length,
  'sampleWithPriority() with no cap returns every company exactly once');
eq(sampleWithPriority(list, 4, new Set(), () => 0).length, 4, 'sampleWithPriority() with nothing known is a plain random sample');
{
  const copy = list.slice();
  sampleWithPriority(list, 4, known);
  eq(list, copy, 'sampleWithPriority() does not mutate its input');
}

// loadKnownCompanies — tracked_companies + scan-history, best effort.
{
  const root = mkdtempSync(join(tmpdir(), 'cp-prio-'));
  try {
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'portals.yml'), [
      'tracked_companies:',
      '  - name: Anthropic',
      '    careers_url: https://job-boards.greenhouse.io/anthropic',
      '    api: https://boards-api.greenhouse.io/v1/boards/anthropic/jobs',
      '    enabled: true',
      '  - name: Cohere',
      '    careers_url: https://jobs.ashbyhq.com/cohere',
      '  - name: Off Co',
      '    careers_url: https://jobs.lever.co/offco',
      '    enabled: false',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'data', 'scan-history.tsv'),
      'url\tfirst_seen\tportal\ttitle\tcompany\n'
      + 'https://jobs.ashbyhq.com/elevenlabs/abc\t2026-09-06\tashby-api\tResearch Engineer\tElevenLabs\n'
      // A title the filter dropped is not evidence the company hires for this profile.
      + 'https://jobs.ashbyhq.com/salesco/def\t2026-10-01\tashby-api\tAccount Executive\tSalesCo\tskipped_title\n');
    const got = loadKnownCompanies(root);
    eq(got.has('salesco'), false, 'loadKnownCompanies() ignores companies seen only in skipped_title rows');
    eq(['anthropic', 'cohere', 'elevenlabs'].every((k) => got.has(k)), true,
      'loadKnownCompanies() reads tracked_companies and past scan-history matches');
    eq(got.has('offco'), false, 'loadKnownCompanies() skips tracked companies with enabled: false');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  eq(loadKnownCompanies(join(tmpdir(), 'does-not-exist-cp-prio')).size, 0,
    'loadKnownCompanies() on a root with no files is an empty set, not a throw');
}
