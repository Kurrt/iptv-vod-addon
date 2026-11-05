import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { ImdbConverter } from '../src/tmdb.js';
import { episodeRow, movieRow, seriesInfoBody, seriesRow } from '../test-support/fake-dispatcharr.js';
import { startFakeTmdb } from '../test-support/fake-tmdb.js';
import { directUrl, newDataDir, setup, TMDB_KEY, TMDB_TOKEN, waitFor } from '../test-support/harness.js';

const ONLY_TMDB = movieRow({ id: 7, name: 'EN - Only Tmdb', tmdb: '555', year: 2001 });
const SHOW = seriesRow({ id: 2, name: 'EN - Show', tmdb: '200', releaseDate: '2010' });
const INFO = seriesInfoBody({ episodes: [episodeRow({ id: 21, season: 1, episode: 1 })] });
const EMPTY_RETRY = { streams: [], cacheMaxAge: 0 };

// A fake Dispatcharr, a fake TMDB, and an add-on using both, with a key set.
async function withTmdb(t, { tmdb: tmdbOptions = {}, fake, env, overrides, dataDir } = {}) {
  const tmdb = await startFakeTmdb({
    apiKey: TMDB_KEY,
    movies: { tt0000555: 555 },
    shows: { tt0000200: 200 },
    ...tmdbOptions,
  });
  t.after(() => tmdb.stop());
  const { fake: dispatcharr, addon } = await setup(t, {
    fake: { movies: [ONLY_TMDB], series: [SHOW], seriesInfo: { 2: INFO }, ...fake },
    env: { TMDB_API_KEY: TMDB_KEY, ...env },
    overrides,
    tmdbBaseUrl: tmdb.baseUrl,
    dataDir,
  });
  return { tmdb, fake: dispatcharr, addon };
}

test('a tt movie id converts through movie_results and finds the row by its TMDB id', async (t) => {
  const { tmdb, fake, addon } = await withTmdb(t);
  const { status, body } = await addon.getJson('/stream/movie/tt0000555.json');
  assert.equal(status, 200);
  assert.equal(body.streams.length, 1);
  assert.equal(body.streams[0].url, directUrl(fake, 'movie', 7, 'mkv'));
  assert.equal(body.cacheMaxAge, undefined);
  assert.deepEqual(tmdb.requests, [{ imdbId: 'tt0000555', source: 'imdb_id', apiKey: TMDB_KEY, authorization: null }]);
});

test('a tt episode id converts through tv_results, plain and percent-encoded', async (t) => {
  const { tmdb, fake, addon } = await withTmdb(t);
  for (const id of ['tt0000200:1:1', 'tt0000200%3A1%3A1']) {
    const { status, body } = await addon.getJson(`/stream/series/${id}.json`);
    assert.equal(status, 200, id);
    assert.equal(body.streams[0].url, directUrl(fake, 'series', 21, 'mkv'), id);
    assert.equal(body.streams[0].behaviorHints.filename, 'Show (2010) S01E01 1080p ENG.mkv', id);
  }
  assert.equal(tmdb.count(), 1);
});

test('film and show numbers never cross: each kind reads only its own results', async (t) => {
  // TMDB film 99 and TMDB show 99 are unrelated titles.
  const { tmdb, addon } = await withTmdb(t, {
    tmdb: { movies: { tt1: 99 }, shows: { tt2: 99 } },
    fake: {
      movies: [movieRow({ id: 1, name: 'Film 99', tmdb: '99' })],
      series: [seriesRow({ id: 2, name: 'Show 99', tmdb: '99' })],
      seriesInfo: { 2: seriesInfoBody({ episodes: [episodeRow({ id: 5, season: 1, episode: 1 })] }) },
    },
  });
  assert.equal((await addon.getJson('/stream/movie/tt1.json')).body.streams.length, 1);
  assert.deepEqual((await addon.getJson('/stream/series/tt1:1:1.json')).body, { streams: [] });
  assert.equal((await addon.getJson('/stream/series/tt2:1:1.json')).body.streams.length, 1);
  assert.deepEqual((await addon.getJson('/stream/movie/tt2.json')).body, { streams: [] });
  // One call per IMDb id: the first answer already says which kind it is.
  assert.equal(tmdb.count('tt1'), 1);
  assert.equal(tmdb.count('tt2'), 1);
});

test('the v4 access token goes as a bearer header and the URL stays clean', async (t) => {
  const { tmdb, addon } = await withTmdb(t, {
    tmdb: { apiKey: null, accessToken: TMDB_TOKEN },
    env: { TMDB_API_KEY: '', TMDB_ACCESS_TOKEN: TMDB_TOKEN },
  });
  assert.equal((await addon.getJson('/stream/movie/tt0000555.json')).body.streams.length, 1);
  assert.deepEqual(tmdb.requests, [{ imdbId: 'tt0000555', source: 'imdb_id', apiKey: null, authorization: `Bearer ${TMDB_TOKEN}` }]);
});

test('with both set, the bearer token is used, because it stays out of the URL', async (t) => {
  const { tmdb, addon } = await withTmdb(t, {
    tmdb: { accessToken: TMDB_TOKEN },
    env: { TMDB_ACCESS_TOKEN: TMDB_TOKEN },
  });
  await addon.getJson('/stream/movie/tt0000555.json');
  assert.equal(tmdb.requests[0].apiKey, null);
  assert.equal(tmdb.requests[0].authorization, `Bearer ${TMDB_TOKEN}`);
});

test('the source\'s own IMDb ids come first, and cost no conversion', async (t) => {
  const { tmdb, addon } = await withTmdb(t, {
    fake: {
      movies: [movieRow({ id: 1, name: 'Has Imdb', imdb: 'tt77', tmdb: '77' })],
      series: [seriesRow({ id: 2, name: 'Has Imdb Too', imdb: 'tt88' })],
      seriesInfo: { 2: INFO },
    },
  });
  assert.equal((await addon.getJson('/stream/movie/tt77.json')).body.streams.length, 1);
  assert.equal((await addon.getJson('/stream/series/tt88:1:1.json')).body.streams.length, 1);
  assert.equal(tmdb.count(), 0);
});

test('tmdb ids are looked up directly and cost no conversion', async (t) => {
  const { tmdb, addon } = await withTmdb(t);
  assert.equal((await addon.getJson('/stream/movie/tmdb:555.json')).body.streams.length, 1);
  assert.equal((await addon.getJson('/stream/series/tmdb:200:1:1.json')).body.streams.length, 1);
  assert.equal(tmdb.count(), 0);
});

test('a converted id the catalog does not have is an ordinary miss', async (t) => {
  const { tmdb, addon } = await withTmdb(t, { tmdb: { movies: { tt404: 404404 } } });
  assert.deepEqual((await addon.getJson('/stream/movie/tt404.json')).body, { streams: [] });
  assert.deepEqual((await addon.getJson('/stream/movie/tt404.json')).body, { streams: [] });
  assert.equal(tmdb.count('tt404'), 1);
});

test('a conversion is remembered across a restart, with TMDB never asked again', async (t) => {
  const dataDir = await newDataDir(t);
  const first = await withTmdb(t, { dataDir });
  await first.addon.getJson('/stream/movie/tt0000555.json');
  await first.addon.getJson('/stream/series/tt0000200:1:1.json');
  await first.addon.app.flush();
  assert.equal(first.tmdb.count(), 2);
  const { ids } = await first.addon.readData('imdb-tmdb.json');
  assert.deepEqual(ids.map(({ imdb, movie, tv }) => ({ imdb, movie, tv })), [
    { imdb: 'tt0000555', movie: '555', tv: null },
    { imdb: 'tt0000200', movie: null, tv: '200' },
  ]);
  assert.ok(ids.every(({ at }) => Number.isFinite(at)), 'each one is dated');
  await first.addon.stop();

  // A TMDB that would fail everything, so a call here would show as a miss.
  const second = await withTmdb(t, { dataDir });
  second.tmdb.failure = 500;
  assert.equal((await second.addon.getJson('/stream/movie/tt0000555.json')).body.streams.length, 1);
  assert.equal((await second.addon.getJson('/stream/series/tt0000200:1:1.json')).body.streams.length, 1);
  assert.equal(second.tmdb.count(), 0);
  assert.ok(second.addon.logs.some((l) => l.includes('loaded 2 id conversions')));
});

test('a conversion past its age limit is dropped at startup and from the file, then converted again', async (t) => {
  const dataDir = await newDataDir(t);
  const day = 24 * 3_600_000;
  await writeFile(join(dataDir, 'imdb-tmdb.json'), JSON.stringify({
    version: 2,
    ids: [
      { imdb: 'tt0000555', movie: '555', tv: null, at: Date.now() - 151 * day },
      { imdb: 'tt0000200', movie: null, tv: '200', at: Date.now() - 149 * day },
      { imdb: 'tt0000777', movie: '777', tv: null },
      // A date in the future would otherwise never reach the limit.
      { imdb: 'tt0000888', movie: '888', tv: null, at: Date.now() + 365 * day },
    ],
  }));
  const { tmdb, addon } = await withTmdb(t, { dataDir });
  assert.deepEqual((await addon.readData('imdb-tmdb.json')).ids.map((row) => row.imdb), ['tt0000200']);
  assert.equal((await addon.getJson('/stream/movie/tt0000555.json')).body.streams.length, 1);
  assert.equal(tmdb.count('tt0000555'), 1);
  assert.equal((await addon.getJson('/stream/series/tt0000200:1:1.json')).body.streams.length, 1);
  assert.equal(tmdb.count('tt0000200'), 0);
});

test('an add-on left running drops old conversions at its next refresh', async (t) => {
  const { tmdb, addon } = await withTmdb(t, { overrides: { idMaxAgeMs: 0 } });
  assert.equal((await addon.getJson('/stream/movie/tt0000555.json')).body.streams.length, 1);
  await addon.app.flush();
  assert.equal(addon.app.imdb.stats().cached, 1);
  await addon.app.refresh();
  assert.equal(addon.app.imdb.stats().cached, 0);
  assert.deepEqual((await addon.readData('imdb-tmdb.json')).ids, []);
  assert.equal((await addon.getJson('/stream/movie/tt0000555.json')).body.streams.length, 1);
  assert.equal(tmdb.count('tt0000555'), 2);
});

test('conversions are kept for less than the 6 months TMDB allows, even with the longest refresh', async (t) => {
  const { addon } = await setup(t, { refresh: false });
  const shortestSixMonths = 181 * 24 * 3_600_000;
  const longestRefresh = 2 ** 31 - 1;
  assert.ok(addon.config.idMaxAgeMs + longestRefresh < shortestSixMonths);
});

test('a miss is remembered, but not across a restart', async (t) => {
  const { tmdb, addon } = await withTmdb(t);
  assert.deepEqual((await addon.getJson('/stream/movie/tt999.json')).body, { streams: [] });
  assert.deepEqual((await addon.getJson('/stream/movie/tt999.json')).body, { streams: [] });
  assert.deepEqual((await addon.getJson('/stream/series/tt999:1:1.json')).body, { streams: [] });
  assert.equal(tmdb.count('tt999'), 1);
  await addon.app.flush();
  assert.deepEqual(addon.app.imdb.document().ids, []);
});

test('single flight per id: concurrent lookups of both kinds share one call', async (t) => {
  const { tmdb, addon } = await withTmdb(t, { tmdb: { movies: { tt5: 555 } } });
  tmdb.delayMs = 30;
  const answers = await Promise.all([
    addon.getJson('/stream/movie/tt5.json'),
    addon.getJson('/stream/movie/tt5.json'),
    addon.getJson('/stream/series/tt5:1:1.json'),
  ]);
  assert.equal(tmdb.count('tt5'), 1);
  assert.equal(answers[0].body.streams.length, 1);
  assert.equal(answers[1].body.streams.length, 1);
  assert.deepEqual(answers[2].body, { streams: [] });
});

test('budget expiry answers empty with cacheMaxAge 0, finishes behind the scenes, and the next lookup hits', async (t) => {
  const { tmdb, addon } = await withTmdb(t, { env: { IDS_BUDGET_MS: '30' } });
  tmdb.delayMs = 200;

  const started = Date.now();
  const first = await addon.getJson('/stream/movie/tt0000555.json');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, EMPTY_RETRY);
  assert.ok(Date.now() - started < 200, 'answered inside the budget, not after the fetch');

  await waitFor(() => addon.app.imdb.stats().cached === 1);
  const second = await addon.getJson('/stream/movie/tt0000555.json');
  assert.equal(second.body.streams.length, 1);
  assert.equal(second.body.cacheMaxAge, undefined);
  assert.equal(tmdb.count(), 1);
});

for (const failure of [500, 503, 401, 429, 'html', 'shape']) {
  test(`a failed conversion (${failure}) is not a miss: empty, cacheMaxAge 0, and tried again later`, async (t) => {
    const { tmdb, addon } = await withTmdb(t);
    tmdb.failure = failure;
    assert.deepEqual((await addon.getJson('/stream/movie/tt0000555.json')).body, EMPTY_RETRY);
    // Backing off: no second call inside the retry window, and still not a final answer.
    assert.deepEqual((await addon.getJson('/stream/movie/tt0000555.json')).body, EMPTY_RETRY);
    assert.equal(tmdb.count(), 1);
    assert.equal(addon.logs.filter((l) => l.includes('IMDb id conversion failed')).length, 1);
    assert.equal(addon.app.imdb.stats().errors, 1);
    assert.equal(addon.app.imdb.stats().misses, 0);
  });
}

test('TMDB being unreachable answers empty with cacheMaxAge 0', async (t) => {
  const { tmdb, addon } = await withTmdb(t);
  await tmdb.stop();
  assert.deepEqual((await addon.getJson('/stream/movie/tt0000555.json')).body, EMPTY_RETRY);
  assert.ok(addon.logs.some((l) => /IMDb id conversion failed: network/.test(l)));
});

test('recovery: after the back-off a failed id is converted', async (t) => {
  const { tmdb, addon } = await withTmdb(t, { overrides: { idRetryMs: 0 } });
  tmdb.failure = 500;
  assert.deepEqual((await addon.getJson('/stream/movie/tt0000555.json')).body, EMPTY_RETRY);
  tmdb.failure = null;
  assert.equal((await addon.getJson('/stream/movie/tt0000555.json')).body.streams.length, 1);
  assert.equal(tmdb.count(), 2);
});

test('a run of the same failure logs once, and a new one logs again', async (t) => {
  const { tmdb, addon } = await withTmdb(t, { overrides: { idRetryMs: 0 } });
  tmdb.failure = 500;
  for (const id of ['tt1', 'tt2', 'tt3']) await addon.getJson(`/stream/movie/${id}.json`);
  assert.equal(addon.logs.filter((l) => l.includes('http_500')).length, 1);
  tmdb.failure = 401;
  await addon.getJson('/stream/movie/tt4.json');
  assert.equal(addon.logs.filter((l) => l.includes('http_401')).length, 1);
});

test('a redirect is refused, so the credential cannot follow it anywhere', async (t) => {
  const seen = [];
  const elsewhere = createServer((req, res) => {
    seen.push(req.url);
    res.end('{}');
  });
  await new Promise((resolve) => { elsewhere.listen(0, '127.0.0.1', resolve); });
  t.after(() => elsewhere.close());

  const { tmdb, addon } = await withTmdb(t);
  tmdb.failure = 'redirect';
  tmdb.redirectTo = `http://127.0.0.1:${elsewhere.address().port}/3/find/tt0000555?api_key=${TMDB_KEY}`;
  assert.deepEqual((await addon.getJson('/stream/movie/tt0000555.json')).body, EMPTY_RETRY);
  assert.deepEqual(seen, []);
});

test('the credential reaches TMDB only: not Dispatcharr, responses, files or logs', async (t) => {
  const { tmdb, fake, addon } = await withTmdb(t);
  await addon.app.heartbeat();
  const bodies = [
    await (await addon.get('/manifest.json')).text(),
    await (await addon.get('/health')).text(),
    await (await addon.get('/stream/movie/tt0000555.json')).text(),
    await (await addon.get('/stream/series/tt0000200:1:1.json')).text(),
  ];
  await addon.app.flush();
  tmdb.failure = 401;
  await addon.getJson('/stream/movie/tt123123.json');
  await addon.app.flush();

  assert.ok(tmdb.count() >= 2);
  for (const text of bodies) assert.ok(!text.includes(TMDB_KEY), text);
  for (const url of fake.urlsSeen) assert.ok(!url.includes(TMDB_KEY), url);
  for (const headers of fake.headersSeen) assert.ok(!JSON.stringify(headers).includes(TMDB_KEY));
  for (const name of await readdir(addon.dataDir)) {
    assert.ok(!(await readFile(join(addon.dataDir, name), 'utf8')).includes(TMDB_KEY), name);
  }
  for (const line of addon.logs) assert.ok(!line.includes(TMDB_KEY), line);
});

test('both TMDB credentials are redacted from logs, in raw and encoded form', async (t) => {
  const { addon } = await withTmdb(t, { env: { TMDB_ACCESS_TOKEN: 'tok en/1' } });
  addon.logger.warn(`a ${TMDB_KEY} b tok en/1 c ${encodeURIComponent('tok en/1')}`);
  const line = addon.logs.at(-1);
  assert.ok(!line.includes(TMDB_KEY), line);
  assert.ok(!line.includes('tok en/1'), line);
  assert.ok(!line.includes(encodeURIComponent('tok en/1')), line);
  assert.equal(line.match(/\[redacted\]/g).length, 3);
});

test('with no credential, tt ids use only the source\'s index, and it warns once', async (t) => {
  const { addon } = await setup(t, {
    fake: {
      movies: [movieRow({ id: 1, name: 'Indexed', imdb: 'tt11' }), ONLY_TMDB],
      series: [SHOW],
      seriesInfo: { 2: INFO },
    },
  });
  assert.equal((await addon.getJson('/stream/movie/tt11.json')).body.streams.length, 1);
  // A definite empty answer, not a "try again": nothing will ever change it.
  assert.deepEqual((await addon.getJson('/stream/movie/tt0000555.json')).body, { streams: [] });
  assert.deepEqual((await addon.getJson('/stream/series/tt0000200:1:1.json')).body, { streams: [] });
  assert.equal((await addon.getJson('/stream/movie/tmdb:555.json')).body.streams.length, 1);
  assert.equal(addon.logs.filter((l) => l.includes('TMDB_API_KEY')).length, 1);
  assert.deepEqual(addon.app.imdb.stats(), { enabled: false, conversions: 0, hits: 0, misses: 0, errors: 0, cached: 0 });
});

test('with a credential, no such warning', async (t) => {
  const { addon } = await withTmdb(t);
  assert.equal(addon.logs.filter((l) => l.includes('TMDB_API_KEY')).length, 0);
});

test('no TMDB call while upstream is down', async (t) => {
  const { tmdb, fake, addon } = await withTmdb(t);
  fake.authRejected = true;
  for (let i = 0; i < 3; i += 1) await addon.app.heartbeat();
  assert.deepEqual((await addon.getJson('/stream/movie/tt0000555.json')).body, { streams: [], cacheMaxAge: 0 });
  assert.equal(tmdb.count(), 0);
});

test('status.json counts conversions, hits and misses, and holds no secrets', async (t) => {
  const { tmdb, addon } = await withTmdb(t, { overrides: { idRetryMs: 60_000 } });
  await addon.getJson('/stream/movie/tt0000555.json'); // converted, a hit
  await addon.getJson('/stream/movie/tt0000555.json'); // from the cache, a hit
  await addon.getJson('/stream/movie/tt999.json'); // converted, a miss
  await addon.getJson('/stream/movie/tt999.json'); // from the cache, a miss
  await addon.getJson('/stream/series/tt0000555:1:1.json'); // a film asked for as a show, a miss
  tmdb.failure = 500;
  await addon.getJson('/stream/movie/tt888.json'); // an error, neither
  await addon.app.flush();

  const status = await addon.readData('status.json');
  assert.deepEqual(status.imdbConversion, {
    enabled: true,
    conversions: 2,
    hits: 2,
    misses: 3,
    errors: 1,
    cached: 1,
  });
  const text = await addon.readDataText('status.json');
  assert.ok(!text.includes(TMDB_KEY));
  assert.ok(!text.includes('tt0000555'), 'counts only, no ids');
});

test('status.json catches up by itself after a conversion', async (t) => {
  const { addon } = await withTmdb(t, { overrides: { idSaveDelayMs: 5 } });
  await addon.getJson('/stream/movie/tt0000555.json');
  await waitFor(async () => (await addon.readData('status.json')).imdbConversion.conversions === 1);
  await waitFor(async () => (await addon.readData('imdb-tmdb.json')).ids.length === 1);
});

test('the cache file is written atomically, leaving no temporary files', async (t) => {
  const { addon } = await withTmdb(t);
  await addon.getJson('/stream/movie/tt0000555.json');
  await addon.app.flush();
  assert.deepEqual((await readdir(addon.dataDir)).sort(), ['imdb-tmdb.json', 'snapshot.json', 'status.json']);
});

test('a damaged cache file is ignored or partly used, never fatal', async (t) => {
  const garbled = await newDataDir(t);
  await writeFile(join(garbled, 'imdb-tmdb.json'), '{not json');
  const first = await withTmdb(t, { dataDir: garbled });
  assert.equal(first.addon.app.imdb.stats().cached, 0);
  assert.ok(first.addon.logs.some((l) => l.includes('not valid JSON')));

  const partial = await newDataDir(t);
  await writeFile(join(partial, 'imdb-tmdb.json'), JSON.stringify({
    version: 2,
    ids: [
      null, 'x', { imdb: 'nope', movie: '1', at: 1 }, { imdb: 'tt1', movie: '../x', tv: null, at: 1 }, { imdb: 'tt2', at: 1 },
      { imdb: '5', movie: '5', at: 1 }, { imdb: 'tt6', movie: '6', tv: null, at: 'soon' },
      { imdb: 'tt0000555', movie: '555', tv: null, at: Date.now() },
    ],
  }));
  const second = await withTmdb(t, { dataDir: partial });
  assert.equal(second.addon.app.imdb.stats().cached, 1);
  assert.equal((await second.addon.getJson('/stream/movie/tt0000555.json')).body.streams.length, 1);
  assert.equal(second.tmdb.count(), 0);

  // A version 1 file has no dates, so nothing in it can be kept.
  const wrongVersion = await newDataDir(t);
  await writeFile(join(wrongVersion, 'imdb-tmdb.json'), JSON.stringify({ version: 1, ids: [{ imdb: 'tt1', movie: '1', tv: null }] }));
  const third = await withTmdb(t, { dataDir: wrongVersion });
  assert.equal(third.addon.app.imdb.stats().cached, 0);
});

function converter(find, overrides = {}) {
  return new ImdbConverter({
    find,
    logger: { warn: () => {} },
    missTtlMs: 1000,
    maxAgeMs: 5000,
    retryMs: 100,
    maxEntries: 3,
    maxMisses: 3,
    ...overrides,
  });
}

const NO_RESULT = { movie: null, tv: null };

test('a miss lasts its whole TTL, and is looked up again after', async () => {
  let clock = 0;
  let calls = 0;
  const imdb = converter(async () => { calls += 1; return NO_RESULT; }, { now: () => clock });
  assert.deepEqual(await imdb.toTmdb('tt1', 'movie'), { tmdb: null, retry: false });
  clock = 999;
  await imdb.toTmdb('tt1', 'movie');
  assert.equal(calls, 1);
  clock = 1000;
  await imdb.toTmdb('tt1', 'movie');
  assert.equal(calls, 2);
});

test('a miss lasts 24 hours by default', async (t) => {
  const { addon } = await setup(t, { refresh: false });
  assert.equal(addon.config.idMissTtlMs, 24 * 3_600_000);
});

test('a failure backs off for much less time than a miss', async () => {
  let clock = 0;
  let calls = 0;
  const imdb = converter(async () => { calls += 1; throw new Error('nope'); }, { now: () => clock });
  assert.deepEqual(await imdb.toTmdb('tt1', 'tv'), { tmdb: null, retry: true });
  clock = 99;
  assert.deepEqual(await imdb.toTmdb('tt1', 'tv'), { tmdb: null, retry: true });
  assert.equal(calls, 1);
  clock = 100;
  await imdb.toTmdb('tt1', 'tv');
  assert.equal(calls, 2);
});

test('a hit lasts until it is too old, counted from the conversion and not the last use', async () => {
  let clock = 0;
  let calls = 0;
  const imdb = converter(async () => { calls += 1; return { movie: '5', tv: null }; }, { now: () => clock });
  await imdb.toTmdb('tt1', 'movie');
  imdb.markSaved();
  clock = 4999;
  imdb.dropExpired();
  assert.deepEqual(await imdb.toTmdb('tt1', 'movie'), { tmdb: '5', retry: false });
  assert.equal(calls, 1);
  assert.equal(imdb.dirty, false, 'nothing to save yet');
  clock = 5000;
  imdb.dropExpired();
  assert.equal(imdb.stats().cached, 0);
  assert.equal(imdb.dirty, true, 'the file has to lose it too');
  assert.deepEqual(await imdb.toTmdb('tt1', 'movie'), { tmdb: '5', retry: false });
  assert.equal(calls, 2);
});

test('a conversion dated in the future is dropped, because its age cannot be known', async () => {
  let clock = 1000;
  let calls = 0;
  const imdb = converter(async () => { calls += 1; return { movie: '5', tv: null }; }, { now: () => clock });
  await imdb.toTmdb('tt1', 'movie');
  imdb.markSaved();
  // The clock was ahead when it was made, and has since been put right.
  clock = 999;
  imdb.dropExpired();
  assert.equal(imdb.stats().cached, 0);
  assert.equal(imdb.dirty, true, 'the file has to lose it too');
  await imdb.toTmdb('tt1', 'movie');
  assert.equal(calls, 2);
});

test('the cache is bounded, evicting the least recently used', async () => {
  let calls = 0;
  const imdb = converter(async () => { calls += 1; return { movie: '5', tv: null }; });
  for (const id of ['tt1', 'tt2', 'tt3']) await imdb.toTmdb(id, 'movie');
  await imdb.toTmdb('tt1', 'movie'); // touched, so tt2 is now the oldest
  await imdb.toTmdb('tt4', 'movie');
  assert.equal(imdb.stats().cached, 3);
  assert.deepEqual(imdb.document().ids.map((row) => row.imdb), ['tt3', 'tt1', 'tt4']);

  const callsBefore = calls;
  await imdb.toTmdb('tt1', 'movie');
  assert.equal(calls, callsBefore);
  await imdb.toTmdb('tt2', 'movie');
  assert.equal(calls, callsBefore + 1);
});

test('the bound holds for a restored file too', () => {
  const imdb = converter(async () => NO_RESULT);
  const ids = Array.from({ length: 50 }, (_, i) => ({ imdb: `tt${i + 1}`, movie: String(i + 1), tv: null, at: Date.now() }));
  assert.equal(imdb.restore({ version: 2, ids }), 3);
  assert.deepEqual(imdb.document().ids.map((row) => row.imdb), ['tt48', 'tt49', 'tt50']);
});

test('misses are bounded too, and toTmdb never rejects', async () => {
  let calls = 0;
  const imdb = converter(async () => { calls += 1; return NO_RESULT; });
  for (let i = 0; i < 50; i += 1) await imdb.toTmdb(`tt${i}`, 'movie');
  assert.equal(calls, 50);
  await imdb.toTmdb('tt49', 'movie');
  assert.equal(calls, 50);
  await imdb.toTmdb('tt0', 'movie');
  assert.equal(calls, 51);

  const broken = converter(async () => { throw new TypeError('boom'); });
  assert.deepEqual(await broken.toTmdb('tt1', 'movie'), { tmdb: null, retry: true });
});
