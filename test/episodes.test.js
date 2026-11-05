import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Catalog } from '../src/catalog.js';
import { EpisodeCache, parseEpisodes, UNAVAILABLE } from '../src/episodes.js';
import { createLookup } from '../src/lookup.js';
import { episodeRow, seriesInfoBody, seriesRow } from '../test-support/fake-dispatcharr.js';
import { directUrl, setup, waitFor } from '../test-support/harness.js';

const SHOW = seriesRow({ id: 2, name: 'Show', tmdb: '200', imdb: 'tt200' });
const INFO = seriesInfoBody({ episodes: [episodeRow({ id: 21, season: 1, episode: 1 })] });

const NOT_YET = { streams: [], cacheMaxAge: 0 };

test('budget expiry: an empty 200 with cacheMaxAge 0 at once, and the next lookup is an instant hit', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: { series: [SHOW], seriesInfo: { 2: INFO } },
    env: { SERIES_INFO_BUDGET_MS: '30' },
  });
  fake.delays.get_series_info = 200;

  const started = Date.now();
  const first = await addon.getJson('/stream/series/tt200:1:1.json');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, NOT_YET);
  assert.ok(Date.now() - started < 200, 'answered inside the budget, not after the fetch');

  // The fetch carries on in the background and fills the cache.
  await waitFor(async () => (await addon.app.episodes.lookup('2', 1, 1)).length > 0);
  assert.equal(fake.count('get_series_info'), 1);

  const second = await addon.getJson('/stream/series/tt200:1:1.json');
  assert.equal(second.status, 200);
  assert.equal(second.body.streams[0].url, directUrl(fake, 'series', 21, 'mkv'));
  assert.equal(second.body.cacheMaxAge, undefined);
  assert.equal(fake.count('get_series_info'), 1);
});

test('budget expiry by tmdb id is the same, and a real miss after it has no cacheMaxAge', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: { series: [SHOW], seriesInfo: { 2: INFO } },
    env: { SERIES_INFO_BUDGET_MS: '30' },
  });
  fake.delays.get_series_info = 200;

  const first = await addon.getJson('/stream/series/tmdb:200:1:1.json');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, NOT_YET);

  await waitFor(async () => (await addon.app.episodes.lookup('2', 1, 1)).length > 0);
  const second = await addon.getJson('/stream/series/tmdb:200:1:1.json');
  assert.equal(second.body.streams.length, 1);

  // Once the list is in, a real miss is the plain empty 200.
  const missing = await addon.getJson('/stream/series/tmdb:200:9:9.json');
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body, { streams: [] });
});

test('a caching client does not get stuck on a budget expiry', async (t) => {
  // A client honouring cacheMaxAge: 0 keeps nothing, and asks again.
  const { fake, addon } = await setup(t, {
    fake: { series: [SHOW], seriesInfo: { 2: INFO } },
    env: { SERIES_INFO_BUDGET_MS: '30' },
  });
  fake.delays.get_series_info = 200;
  const cache = new Map();
  const client = async (path) => {
    if (cache.has(path)) return cache.get(path);
    const { body } = await addon.getJson(path);
    if (body.cacheMaxAge !== 0) cache.set(path, body.streams);
    return body.streams;
  };
  const path = '/stream/series/tmdb:200:1:1.json';
  assert.deepEqual(await client(path), []);
  await waitFor(async () => (await addon.app.episodes.lookup('2', 1, 1)).length > 0);
  assert.equal((await client(path)).length, 1);
  assert.equal(cache.get(path).length, 1);
});

test('cacheMaxAge 0 appears only while a result could still arrive', async () => {
  const never = new Promise(() => {});
  const hit = Promise.resolve([{ id: '70', ext: 'mkv', resolution: null }]);
  const none = Promise.resolve([]);
  const failed = Promise.resolve(UNAVAILABLE);
  const lookupWith = (results) => createLookup({
    catalogs: {
      movies: new Catalog(),
      series: new Catalog(Object.keys(results).map((id) => ({ id, name: `Copy ${id}`, year: null, lang: null, tmdb: '7', imdb: 'tt7' }))),
    },
    episodes: { lookup: (id) => results[id] },
    imdb: { toTmdb: async () => ({ tmdb: null, retry: false }) },
    health: { isDown: false },
    config: {
      seriesInfoBudgetMs: 10,
      idsBudgetMs: 10,
      unknownResolutionTag: '1080p',
      xc: { baseUrl: 'http://up', username: 'u', password: 'p' },
    },
  });

  for (const id of ['tt7:1:1', 'tmdb:7:1:1']) {
    assert.deepEqual(await lookupWith({ a: never })('series', id), NOT_YET, id);
    assert.deepEqual(await lookupWith({ a: none, b: never })('series', id), NOT_YET, id);
    // Some copies in hand, one still coming: offered, and not to be kept.
    const partial = await lookupWith({ a: hit, b: never })('series', id);
    assert.equal(partial.streams.length, 1, id);
    assert.equal(partial.cacheMaxAge, 0, id);
    // A list that could not be fetched is not a miss, with or without other copies.
    assert.deepEqual(await lookupWith({ a: failed })('series', id), NOT_YET, id);
    assert.deepEqual(await lookupWith({ a: none, b: failed })('series', id), NOT_YET, id);
    const stranded = await lookupWith({ a: hit, b: failed })('series', id);
    assert.equal(stranded.streams.length, 1, id);
    assert.equal(stranded.cacheMaxAge, 0, id);
    // Finished with no such episode: an ordinary miss.
    assert.deepEqual(await lookupWith({ a: none })('series', id), { streams: [] }, id);
    // All finished, with a hit.
    const full = await lookupWith({ a: hit, b: none })('series', id);
    assert.equal(full.streams.length, 1, id);
    assert.equal(full.cacheMaxAge, undefined, id);
  }
});

test('a fetch inside the budget answers straight away', async (t) => {
  const { addon } = await setup(t, { fake: { series: [SHOW], seriesInfo: { 2: INFO } } });
  const { status, body } = await addon.getJson('/stream/series/tt200:1:1.json');
  assert.equal(status, 200);
  assert.equal(body.streams.length, 1);
});

test('single flight per series, and the result is cached', async (t) => {
  const { fake, addon } = await setup(t, { fake: { series: [SHOW], seriesInfo: { 2: INFO } } });
  fake.delays.get_series_info = 30;
  const answers = await Promise.all([
    addon.getJson('/stream/series/tt200:1:1.json'),
    addon.getJson('/stream/series/tmdb:200:1:1.json'),
    addon.getJson('/stream/series/tt200:1:1.json'),
    addon.getJson('/stream/series/tt200:9:9.json').catch(() => null),
  ]);
  assert.equal(fake.count('get_series_info'), 1);
  assert.equal(answers[0].body.streams.length, 1);
  assert.equal(answers[1].body.streams.length, 1);

  await addon.getJson('/stream/series/tt200:1:1.json');
  assert.equal(fake.count('get_series_info'), 1);
});

for (const failure of [500, 'html']) {
  test(`a failed fetch (${failure}) backs off, and answers empty with cacheMaxAge 0 throughout`, async (t) => {
    const { fake, addon } = await setup(t, { fake: { series: [SHOW], seriesInfo: { 2: INFO } } });
    fake.failures.get_series_info = failure;
    assert.deepEqual((await addon.getJson('/stream/series/tt200:1:1.json')).body, NOT_YET);
    assert.deepEqual((await addon.getJson('/stream/series/tmdb:200:1:1.json')).body, NOT_YET);
    assert.deepEqual((await addon.getJson('/stream/series/tt200:1:1.json')).body, NOT_YET);
    assert.equal(fake.count('get_series_info'), 1);
    assert.equal(addon.logs.filter((l) => l.includes('series info fetch failed')).length, 1);
  });
}

test('a series Dispatcharr answers 404 for backs off the same way', async (t) => {
  const { fake, addon } = await setup(t, { fake: { series: [SHOW], seriesInfo: {} } });
  assert.deepEqual((await addon.getJson('/stream/series/tt200:1:1.json')).body, NOT_YET);
  assert.deepEqual((await addon.getJson('/stream/series/tt200:1:1.json')).body, NOT_YET);
  assert.equal(fake.count('get_series_info'), 1);
});

test('a real miss keeps its plain answer, including one that follows a recovery', async () => {
  let clock = 0;
  let fail = true;
  const body = seriesInfoBody({ episodes: [episodeRow({ id: 1, season: 1, episode: 1 })] });
  const { episodes } = cache(async () => {
    if (fail) throw new Error('nope');
    return body;
  }, { now: () => clock });

  assert.equal(await episodes.lookup('s', 1, 1), UNAVAILABLE);
  assert.equal(await episodes.lookup('s', 1, 1), UNAVAILABLE, 'and while it backs off');

  clock = 150;
  fail = false;
  assert.equal((await episodes.lookup('s', 1, 1))[0].id, '1');
  const missing = await episodes.lookup('s', 9, 9);
  assert.deepEqual(missing, []);
  assert.notEqual(missing, UNAVAILABLE);
});

test('a failed re-fetch still offers what it had, and a miss then is not a real one', async () => {
  let clock = 0;
  let fail = false;
  const body = seriesInfoBody({ episodes: [episodeRow({ id: 1, season: 1, episode: 1 })] });
  const { episodes } = cache(async () => {
    if (fail) throw new Error('nope');
    return body;
  }, { now: () => clock });

  await episodes.lookup('s', 1, 1);
  clock = 2000;
  fail = true;
  assert.equal((await episodes.lookup('s', 1, 1))[0].id, '1');
  assert.equal(await episodes.lookup('s', 9, 9), UNAVAILABLE);
});

function cache(fetchInfo, { now, maxEntries = 10, ttlMs = 1000, negativeTtlMs = 100 } = {}) {
  const warnings = [];
  return {
    warnings,
    episodes: new EpisodeCache({
      fetchInfo,
      logger: { warn: (m) => warnings.push(m) },
      ttlMs,
      negativeTtlMs,
      maxEntries,
      now,
    }),
  };
}

test('a missing episode is looked for again after the negative TTL, not before', async () => {
  let clock = 0;
  let calls = 0;
  const bodies = [
    seriesInfoBody({ episodes: [episodeRow({ id: 1, season: 1, episode: 1 })] }),
    seriesInfoBody({ episodes: [episodeRow({ id: 1, season: 1, episode: 1 }), episodeRow({ id: 2, season: 1, episode: 2 })] }),
  ];
  const { episodes } = cache(async () => bodies[calls++], { now: () => clock });

  assert.deepEqual(await episodes.lookup('s', 1, 2), []);
  clock = 50;
  assert.deepEqual(await episodes.lookup('s', 1, 2), []);
  assert.equal(calls, 1);

  clock = 150;
  assert.equal((await episodes.lookup('s', 1, 2))[0].id, '2');
  assert.equal(calls, 2);
});

test('a positive entry is served until it expires, then fetched again', async () => {
  let clock = 0;
  let calls = 0;
  const body = seriesInfoBody({ episodes: [episodeRow({ id: 1, season: 1, episode: 1 })] });
  const { episodes } = cache(async () => { calls += 1; return body; }, { now: () => clock });

  await episodes.lookup('s', 1, 1);
  clock = 999;
  await episodes.lookup('s', 1, 1);
  assert.equal(calls, 1);
  clock = 1001;
  await episodes.lookup('s', 1, 1);
  assert.equal(calls, 2);
});

test('a failed re-fetch keeps the good list while backing off', async () => {
  let clock = 0;
  let fail = false;
  const body = seriesInfoBody({ episodes: [episodeRow({ id: 1, season: 1, episode: 1 })] });
  let calls = 0;
  const { episodes, warnings } = cache(async () => {
    calls += 1;
    if (fail) throw new Error('nope');
    return body;
  }, { now: () => clock });

  await episodes.lookup('s', 1, 1);
  clock = 2000; // expired
  fail = true;
  assert.equal((await episodes.lookup('s', 1, 1))[0].id, '1');
  assert.equal((await episodes.lookup('s', 1, 1))[0].id, '1');
  assert.equal(calls, 2);
  assert.equal(warnings.length, 1);
});

test('lookup never rejects, even for a malformed body', async () => {
  for (const body of [null, 42, 'text', [], {}, { episodes: null }, { episodes: 'nope' }]) {
    const { episodes } = cache(async () => body);
    assert.deepEqual(await episodes.lookup('s', 1, 1), [], JSON.stringify(body));
  }
});

test('the series cache is bounded, evicting the least recently used', async () => {
  const body = seriesInfoBody({ episodes: [episodeRow({ id: 1, season: 1, episode: 1 })] });
  let calls = 0;
  const { episodes } = cache(async () => { calls += 1; return body; }, { maxEntries: 3 });

  for (let i = 0; i < 50; i += 1) await episodes.lookup(String(i), 1, 1);
  assert.equal(episodes.size, 3);
  assert.equal(calls, 50);

  // 49 is cached; touching 47 keeps it through the next insert.
  await episodes.lookup('49', 1, 1);
  await episodes.lookup('47', 1, 1);
  assert.equal(calls, 50);
  await episodes.lookup('new', 1, 1);
  assert.equal(calls, 51);
  await episodes.lookup('47', 1, 1);
  assert.equal(calls, 51);
  await episodes.lookup('48', 1, 1);
  assert.equal(calls, 52);
});

test('parseEpisodes matches on season and episode_num, never title', () => {
  const byNumber = parseEpisodes(seriesInfoBody({
    episodes: [
      episodeRow({ id: 1, season: 1, episode: 2, title: 'S01E09 misleading title' }),
      episodeRow({ id: 2, season: 1, episode: 9, title: 'S01E02 misleading title' }),
    ],
  }));
  assert.equal(byNumber.get('1:2')[0].id, '1');
  assert.equal(byNumber.get('1:9')[0].id, '2');
});

test('parseEpisodes tolerates provider-style variations and junk rows', () => {
  // String numbers, and a season only available from the key.
  const strings = parseEpisodes({ episodes: { 3: [{ id: '30', episode_num: '4', container_extension: 'mp4' }] } });
  assert.deepEqual(strings.get('3:4'), [{ id: '30', ext: 'mp4', resolution: null }]);
  // The empty form PHP panels send, and a list of lists.
  assert.equal(parseEpisodes({ episodes: [] }).size, 0);
  const lists = parseEpisodes({ episodes: [[{ id: 1, season: 1, episode_num: 1 }], { id: 2, season: 2, episode_num: 2 }] });
  assert.equal(lists.get('1:1')[0].id, '1');
  assert.equal(lists.get('2:2')[0].id, '2');
  // Junk never throws, and never matches.
  const junk = parseEpisodes({
    episodes: {
      1: [null, 5, 'x', {}, { id: 'abc', season: 1, episode_num: 1 }, { id: 1, season: 'x', episode_num: 1 }, { id: 1, season: 1, episode_num: null }],
      nonsense: 'not a list',
      x: [{ id: 2, episode_num: 3 }],
    },
  });
  assert.equal(junk.size, 0);
});

test('an episode-level resolution in the title is used', async (t) => {
  const { addon } = await setup(t, {
    fake: {
      series: [seriesRow({ id: 5, name: 'Plain Show', tmdb: '5' })],
      seriesInfo: { 5: seriesInfoBody({ episodes: [episodeRow({ id: 50, season: 1, episode: 1, title: 'Pilot 720p' })] }) },
    },
  });
  const { body } = await addon.getJson('/stream/series/tmdb:5:1:1.json');
  assert.equal(body.streams[0].behaviorHints.filename, 'Plain Show S01E01 720p.mkv');
  assert.equal(body.streams[0].description, 'Plain Show S01E01 720p.mkv');
});
