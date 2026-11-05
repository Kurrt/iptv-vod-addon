import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { upstreamBinding } from '../src/catalog.js';
import { movieRow, seriesRow, startFakeDispatcharr } from '../test-support/fake-dispatcharr.js';
import { directUrl, newDataDir, PASSWORD, setup, startAddon, USERNAME } from '../test-support/harness.js';

const FILM = movieRow({ id: 1, name: 'Film [EN]', tmdb: '100', imdb: 'tt100', year: 2000 });
const SHOW = seriesRow({ id: 2, name: 'Show [EN]', tmdb: '200', imdb: 'tt200', releaseDate: '2010' });

test('single flight: concurrent refreshes share one upstream pull', async (t) => {
  const { fake, addon } = await setup(t, { fake: { movies: [FILM], series: [SHOW] }, refresh: false });
  fake.delays.get_vod_streams = 50;
  const calls = [addon.app.refresh(), addon.app.refresh(), addon.app.refresh()];
  await Promise.all(calls);
  assert.equal(fake.count('get_vod_streams'), 1);
  assert.equal(fake.count('get_series'), 1);

  // Once finished, a later refresh does pull again.
  await addon.app.refresh();
  assert.equal(fake.count('get_vod_streams'), 2);
});

test('every upstream call identifies itself with the generic User-Agent', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: { series: [SHOW], seriesInfo: { 2: { episodes: {} } } },
  });
  await addon.app.heartbeat();
  await addon.getJson('/stream/series/tt200:1:1.json');
  assert.equal(fake.count('get_series_info'), 1);
  assert.deepEqual([...fake.userAgents], ['iptv-vod-addon/2.0']);
});

test('refresh failure keeps the last good index and logs', async (t) => {
  const { fake, addon } = await setup(t, { fake: { movies: [FILM], series: [SHOW] } });
  assert.equal(addon.app.catalogs.movies.size, 1);

  for (const failure of [500, 401, 'html']) {
    fake.failures.get_vod_streams = failure;
    fake.failures.get_series = failure;
    fake.movies = [];
    addon.logs.length = 0;
    await addon.app.refresh();
    assert.equal(addon.app.catalogs.movies.size, 1, String(failure));
    assert.equal(addon.app.catalogs.series.size, 1, String(failure));
    assert.equal((await addon.getJson('/stream/movie/tt100.json')).body.streams.length, 1, String(failure));
    assert.equal(addon.logs.filter((l) => l.includes('refresh failed')).length, 2, String(failure));
  }

  const status = await addon.readData('status.json');
  assert.equal(status.refresh.lastOk, false);
  assert.equal(status.refresh.lastError, 'invalid_json');
});

test('one failing list does not stop the other from updating', async (t) => {
  const { fake, addon } = await setup(t, { fake: { movies: [FILM], series: [SHOW] } });
  fake.failures.get_vod_streams = 500;
  fake.series = [SHOW, seriesRow({ id: 3, name: 'New Show', tmdb: '300' })];
  await addon.app.refresh();
  assert.equal(addon.app.catalogs.movies.size, 1);
  assert.equal(addon.app.catalogs.series.size, 2);
  const snapshot = await addon.readData('snapshot.json');
  assert.equal(snapshot.series.length, 2);
});

test('a non-list body counts as a failure', async (t) => {
  const { fake, addon } = await setup(t, { fake: { movies: [FILM], series: [SHOW] } });
  fake.movies = { error: 'surprise' };
  await addon.app.refresh();
  assert.equal(addon.app.catalogs.movies.size, 1);
  assert.equal((await addon.readData('status.json')).refresh.lastError, 'invalid_shape');
});

for (const [label, rows] of [
  ['junk rows', [null, 1, 'x', [], {}]],
  ['rows whose id field was renamed', [{ id: 1, name: 'Film', tmdb_id: '100' }, { id: 2, name: 'Other', tmdb_id: '101' }]],
]) {
  test(`a list of only ${label} is a failure: index and snapshot are kept, and it is retried`, async (t) => {
    const { fake, addon } = await setup(t, {
      fake: { movies: [FILM], series: [SHOW] },
      overrides: { refreshRetryMs: 0 },
    });
    fake.movies = rows;
    await addon.app.refresh();

    assert.equal(addon.app.catalogs.movies.size, 1);
    assert.equal((await addon.getJson('/stream/movie/tt100.json')).status, 200);
    assert.equal((await addon.readData('snapshot.json')).movies.length, 1);
    const status = await addon.readData('status.json');
    assert.equal(status.refresh.lastOk, false);
    assert.equal(status.refresh.lastError, 'invalid_shape');
    assert.ok(addon.logs.some((l) => l.includes('movies refresh failed') && l.includes('invalid_shape')));

    // A later good answer is picked up by the heartbeat's retry.
    fake.movies = [FILM, movieRow({ id: 5, name: 'New', tmdb: '500' })];
    await addon.app.heartbeat();
    await addon.app.refresh();
    assert.equal(addon.app.catalogs.movies.size, 2);
    assert.equal((await addon.readData('status.json')).refresh.lastOk, true);
  });
}

test('an empty list after a good one is not believed the first time', async (t) => {
  const { fake, addon } = await setup(t, { fake: { movies: [FILM], series: [SHOW] } });
  fake.movies = [];
  addon.logs.length = 0;
  await addon.app.refresh();

  assert.equal(addon.app.catalogs.movies.size, 1);
  assert.equal((await addon.getJson('/stream/movie/tt100.json')).body.streams.length, 1);
  assert.equal((await addon.readData('snapshot.json')).movies.length, 1);
  const status = await addon.readData('status.json');
  assert.equal(status.refresh.lastOk, false);
  assert.equal(status.refresh.lastError, 'empty_list');
  assert.equal(status.movies.rows, 1);
  assert.equal(status.movies.upstreamRows, 1);
  assert.equal(addon.logs.filter((l) => l.includes('movies list came back empty')).length, 1);
});

test('a brief empty list costs nothing: the next good list clears it', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: { movies: [FILM], series: [SHOW] },
    overrides: { refreshRetryMs: 0 },
  });
  fake.movies = [];
  await addon.app.refresh();

  fake.movies = [FILM];
  await addon.app.refresh();
  let status = await addon.readData('status.json');
  assert.equal(status.refresh.lastOk, true);
  assert.equal(status.refresh.lastError, null);

  // That cleared the first strike, so a new empty list starts over.
  fake.movies = [];
  await addon.app.refresh();
  assert.equal(addon.app.catalogs.movies.size, 1);
  status = await addon.readData('status.json');
  assert.equal(status.refresh.lastError, 'empty_list');
});

test('an empty list repeated inside the retry window is still not believed', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: { movies: [FILM], series: [SHOW] },
    overrides: { refreshRetryMs: 60_000 },
  });
  fake.movies = [];
  await addon.app.refresh();
  await addon.app.refresh();
  await addon.app.refresh();
  assert.equal(addon.app.catalogs.movies.size, 1);
  assert.equal((await addon.readData('snapshot.json')).movies.length, 1);
  assert.equal(addon.logs.filter((l) => l.includes('movies list came back empty')).length, 1, 'warns once, not on every retry');
});

test('an empty list confirmed by a later attempt is honest: the index goes, and recovery is quick', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: { movies: [FILM], series: [SHOW] },
    overrides: { refreshRetryMs: 0 },
  });
  fake.movies = [];
  await addon.app.refresh();
  assert.equal(addon.app.catalogs.movies.size, 1);

  // The confirming attempt is the heartbeat's retry, which pulls this list alone, so
  // nothing else is there to rewrite the snapshot.
  addon.logs.length = 0;
  const shows = fake.count('get_series');
  await addon.app.heartbeat();
  await addon.app.refresh();
  assert.equal(fake.count('get_series'), shows);
  assert.equal(addon.app.catalogs.movies.size, 0);
  assert.deepEqual((await addon.getJson('/stream/movie/tt100.json')).body, { streams: [] });
  assert.equal((await addon.readData('snapshot.json')).movies.length, 0);
  assert.equal((await addon.readData('snapshot.json')).series.length, 1);
  assert.equal(addon.logs.filter((l) => l.includes('movies list still empty')).length, 1);

  // Still reported, so the heartbeat keeps retrying, and without repeating the warning.
  const status = await addon.readData('status.json');
  assert.equal(status.refresh.lastOk, false);
  assert.equal(status.refresh.lastError, 'empty_list');
  assert.equal(status.movies.rows, 0);
  assert.equal(status.movies.upstreamRows, 0);
  addon.logs.length = 0;
  await addon.app.heartbeat();
  await addon.app.refresh();
  assert.equal(addon.logs.filter((l) => l.includes('empty')).length, 0);

  fake.movies = [FILM];
  await addon.app.heartbeat();
  await addon.app.refresh();
  assert.equal(addon.app.catalogs.movies.size, 1);
  assert.equal((await addon.readData('status.json')).refresh.lastOk, true);
});

test('a failed attempt between two empty lists does not restart the wait', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: { movies: [FILM], series: [SHOW] },
    overrides: { refreshRetryMs: 0 },
  });
  fake.movies = [];
  await addon.app.refresh();
  fake.failures.get_vod_streams = 500;
  await addon.app.refresh();
  assert.equal(addon.app.catalogs.movies.size, 1);
  assert.equal((await addon.readData('status.json')).refresh.lastError, 'http_500');
  delete fake.failures.get_vod_streams;
  await addon.app.refresh();
  assert.equal(addon.app.catalogs.movies.size, 0);
});

test('an empty list with nothing to lose is reported, and only that list is retried', async (t) => {
  // Someone with films but no shows must not re-pull every film every five minutes.
  const { fake, addon } = await setup(t, {
    fake: { movies: [FILM], series: [] },
    overrides: { refreshRetryMs: 0 },
  });
  assert.equal(addon.app.catalogs.movies.size, 1);
  assert.equal(addon.app.catalogs.series.size, 0);
  const status = await addon.readData('status.json');
  assert.equal(status.refresh.lastOk, false);
  assert.equal(status.refresh.lastError, 'empty_list');
  assert.equal(status.series.upstreamRows, 0);
  assert.equal(addon.logs.filter((l) => l.includes('series list came back empty')).length, 1);

  const films = fake.count('get_vod_streams');
  const shows = fake.count('get_series');
  await addon.app.heartbeat();
  await addon.app.refresh();
  assert.equal(fake.count('get_vod_streams'), films);
  assert.equal(fake.count('get_series'), shows + 1);
  assert.equal(addon.logs.filter((l) => l.includes('series list came back empty')).length, 1);

  // Shows turning up clears it.
  fake.series = [SHOW];
  await addon.app.heartbeat();
  await addon.app.refresh();
  assert.equal(addon.app.catalogs.series.size, 1);
  assert.equal(fake.count('get_vod_streams'), films);
  assert.equal((await addon.readData('status.json')).refresh.lastOk, true);
  assert.equal((await addon.readData('snapshot.json')).series.length, 1);
});

test('a retry re-pulls only the list that failed', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: { movies: [FILM], series: [SHOW] },
    refresh: false,
    overrides: { refreshRetryMs: 0 },
  });
  fake.failures.get_series = 500;
  await addon.app.refresh();
  assert.equal(addon.app.catalogs.movies.size, 1);
  assert.equal((await addon.readData('status.json')).refresh.lastError, 'http_500');

  delete fake.failures.get_series;
  await addon.app.heartbeat();
  await addon.app.refresh();
  assert.equal(fake.count('get_vod_streams'), 1);
  assert.equal(fake.count('get_series'), 2);
  assert.equal(addon.app.catalogs.series.size, 1);
  assert.equal((await addon.readData('status.json')).refresh.lastOk, true);
});

test('the scheduled refresh does not settle for a retry that covers only one list', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: { movies: [FILM], series: [SHOW] },
    refresh: false,
    overrides: { refreshRetryMs: 0 },
  });
  fake.failures.get_series = 500;
  await addon.app.refresh();
  assert.equal(fake.count('get_vod_streams'), 1);

  delete fake.failures.get_series;
  fake.delays.get_series = 50;
  await addon.app.heartbeat(); // starts the series-only retry
  await addon.app.scheduledRefresh();
  assert.equal(fake.count('get_vod_streams'), 2);
  assert.equal(fake.count('get_series'), 3);
});

test('the snapshot holds only ids, names, years, extensions and language', async (t) => {
  const { addon } = await setup(t, { fake: { movies: [FILM], series: [SHOW] } });
  const snapshot = await addon.readData('snapshot.json');
  assert.deepEqual(snapshot.movies, [{ id: '1', name: 'Film', year: 2000, lang: 'EN', tmdb: '100', imdb: 'tt100', ext: 'mkv' }]);
  assert.deepEqual(snapshot.series, [{ id: '2', name: 'Show', year: 2010, lang: 'EN', tmdb: '200', imdb: 'tt200' }]);
});

test('a restart serves from the snapshot with upstream gone', async (t) => {
  const dataDir = await newDataDir(t);
  const fake = await startFakeDispatcharr({ username: USERNAME, password: PASSWORD, movies: [FILM], series: [SHOW] });
  const first = await startAddon({ baseUrl: fake.baseUrl, dataDir });
  await first.app.refresh();
  await first.stop();
  const { baseUrl } = fake;
  await fake.stop();

  const second = await startAddon({ baseUrl, dataDir });
  t.after(() => second.stop());

  // Answered before any refresh has happened, and with no upstream to ask.
  const movie = await second.getJson('/stream/movie/tmdb:100.json');
  assert.equal(movie.status, 200);
  assert.equal(movie.body.streams[0].url, directUrl(fake, 'movie', 1, 'mkv'));
  assert.equal(second.app.catalogs.series.find('tt', 'tt200').length, 1);

  // A refresh that cannot reach upstream changes nothing.
  await second.app.refresh();
  assert.equal(second.app.catalogs.movies.size, 1);
});

test('a snapshot written for another upstream is ignored: its ids could be any film there', async (t) => {
  // Dispatcharr's stream ids are database keys, so stream 1 on B is not stream 1 on A.
  const dataDir = await newDataDir(t);
  const fakeA = await startFakeDispatcharr({ username: USERNAME, password: PASSWORD, movies: [FILM], series: [SHOW] });
  const first = await startAddon({ baseUrl: fakeA.baseUrl, dataDir });
  await first.app.refresh();
  await first.stop();
  await fakeA.stop();

  const fakeB = await startFakeDispatcharr({ username: USERNAME, password: PASSWORD });
  fakeB.failures.get_vod_streams = 500;
  fakeB.failures.get_series = 500;
  const second = await startAddon({ baseUrl: fakeB.baseUrl, dataDir });
  t.after(async () => {
    await second.stop();
    await fakeB.stop();
  });
  assert.equal(second.app.catalogs.movies.size, 0);
  assert.equal(second.app.catalogs.series.size, 0);
  assert.deepEqual((await second.getJson('/stream/movie/tt100.json')).body, { streams: [] });
  assert.deepEqual((await second.getJson('/stream/movie/tmdb:100.json')).body, { streams: [] });
  assert.ok(second.logs.some((l) => l.includes('different upstream')));
  for (const line of second.logs) assert.ok(!line.includes(fakeA.baseUrl) && !line.includes('localhost'), line);
});

test('a snapshot with no upstream binding, or a damaged one, is ignored', async (t) => {
  const movies = [{ id: '1', name: 'Film', tmdb: '100', imdb: 'tt100', ext: 'mkv' }];
  for (const upstream of [undefined, null, 'text', {}, { salt: 'a' }, { hash: 'b' }, { salt: 1, hash: 2 }, { salt: 'a', hash: 'b' }]) {
    const dataDir = await newDataDir(t);
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify({ version: 1, upstream, movies, series: [] }));
    const addon = await startAddon({ baseUrl: 'http://localhost:1', dataDir });
    t.after(() => addon.stop());
    assert.equal(addon.app.catalogs.movies.size, 0, JSON.stringify(upstream));
  }
});

test('the upstream binding is salted, and restarts on the same URL still load it', async (t) => {
  const dataDir = await newDataDir(t);
  const fake = await startFakeDispatcharr({ username: USERNAME, password: PASSWORD, movies: [FILM], series: [SHOW] });
  const addon = await startAddon({ baseUrl: fake.baseUrl, dataDir });
  t.after(async () => {
    await addon.stop();
    await fake.stop();
  });
  await addon.app.refresh();
  const first = await addon.readData('snapshot.json');
  await addon.app.refresh();
  const second = await addon.readData('snapshot.json');
  assert.match(first.upstream.salt, /^[0-9a-f]{32}$/);
  assert.match(first.upstream.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(first.upstream.salt, second.upstream.salt);
  assert.notEqual(first.upstream.hash, second.upstream.hash);
  // Nothing but the salt and the hash, so it holds no URL and no credentials.
  assert.deepEqual(Object.keys(first.upstream).sort(), ['hash', 'salt']);

  const again = await startAddon({ baseUrl: `${fake.baseUrl}/`, dataDir });
  t.after(() => again.stop());
  assert.equal(again.app.catalogs.movies.size, 1, 'a trailing slash is the same upstream');
});

test('a snapshot from an older version is served, its names cleaned and copies still dropped', async (t) => {
  // Rows keep the provider's name, and the cleaning happens when a stream is built.
  const dataDir = await newDataDir(t);
  await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify({
    version: 1,
    upstream: upstreamBinding('http://localhost:1'),
    movies: [
      { id: '1', name: 'EN - En (2001)', year: 2001, lang: null, tmdb: '1', ext: 'mkv' },
      { id: '2', name: 'Fr', lang: 'FR', tmdb: '2', ext: 'mkv' },
      { id: '3', name: 'NF - Copy (2026) HDCAM', lang: null, tmdb: '3', ext: 'mkv' },
    ],
    series: [],
  }));
  const addon = await startAddon({ baseUrl: 'http://localhost:1', dataDir });
  t.after(() => addon.stop());
  assert.equal(addon.app.catalogs.movies.size, 2);
  const filename = async (id) => (await addon.getJson(`/stream/movie/tmdb:${id}.json`)).body.streams[0].behaviorHints.filename;
  assert.equal(await filename(1), 'En (2001) 1080p ENG.mkv');
  assert.equal(await filename(2), 'Fr 1080p FR.mkv');
});

test('a damaged snapshot is ignored or partly used, never fatal', async (t) => {
  const garbled = await newDataDir(t);
  await writeFile(join(garbled, 'snapshot.json'), '{not json');
  const first = await startAddon({ baseUrl: 'http://localhost:1', dataDir: garbled });
  t.after(() => first.stop());
  assert.equal(first.app.catalogs.movies.size, 0);
  assert.ok(first.logs.some((l) => l.includes('not valid JSON')));

  const partial = await newDataDir(t);
  await writeFile(join(partial, 'snapshot.json'), JSON.stringify({
    version: 1,
    upstream: upstreamBinding('http://localhost:1'),
    movies: [null, 'x', { id: 'bad' }, { id: '9', tmdb: '../x', imdb: 'nope', ext: '../', name: 5, lang: 'bad' }, { id: '10', name: 'Fine', tmdb: '10' }],
    series: 'nonsense',
  }));
  const second = await startAddon({ baseUrl: 'http://localhost:1', dataDir: partial });
  t.after(() => second.stop());
  assert.equal(second.app.catalogs.movies.size, 2);
  assert.deepEqual(second.app.catalogs.movies.find('tmdb', '../x'), []);
  assert.equal(second.app.catalogs.series.size, 0);
  const row = second.app.catalogs.movies.entries[0];
  assert.equal(row.ext, 'mp4');
  assert.equal(row.name, 'Unknown');
  assert.equal(row.lang, null);

  const wrongVersion = await newDataDir(t);
  await writeFile(join(wrongVersion, 'snapshot.json'), JSON.stringify({ version: 99, upstream: upstreamBinding('http://localhost:1'), movies: [{ id: '1', tmdb: '1' }] }));
  const third = await startAddon({ baseUrl: 'http://localhost:1', dataDir: wrongVersion });
  t.after(() => third.stop());
  assert.equal(third.app.catalogs.movies.size, 0);
});

test('an unwritable DATA_DIR warns once and everything keeps working', async (t) => {
  // A path under a regular file fails for any user, root included.
  const parent = await newDataDir(t);
  const blocker = join(parent, 'not-a-directory');
  await writeFile(blocker, 'x');
  const fake = await startFakeDispatcharr({ username: USERNAME, password: PASSWORD, movies: [FILM] });
  const addon = await startAddon({ baseUrl: fake.baseUrl, dataDir: join(blocker, 'data') });
  t.after(async () => {
    await addon.stop();
    await fake.stop();
  });
  await addon.app.refresh();
  await addon.app.heartbeat();
  await addon.app.refresh();
  assert.equal(addon.logs.filter((l) => l.includes('not writable')).length, 1);
  assert.equal((await addon.getJson('/stream/movie/tmdb:100.json')).body.streams.length, 1);
});

test('status.json counts are right for movies and series separately', async (t) => {
  const movies = [
    movieRow({ id: 1, name: 'both', tmdb: '1', imdb: 'tt1' }),
    movieRow({ id: 2, name: 'tmdb only', tmdb: '2' }),
    movieRow({ id: 3, name: 'imdb only', imdb: 'tt3' }),
    movieRow({ id: 4, name: 'bare imdb', imdb: '0000004' }),
    movieRow({ id: 5, name: 'neither' }),
    movieRow({ id: 6, name: 'junk ids', tmdb: 'tm6', imdb: 'nm6' }),
    movieRow({ id: 7, name: 'adult', tmdb: '7', adult: 1 }),
    movieRow({ id: 8, name: 'french [FR]', tmdb: '8' }),
    { stream_id: 'bad', name: 'invalid', tmdb_id: '9' },
    null,
  ];
  const series = [
    seriesRow({ id: 1, name: 'both', tmdb: '1', imdb: 'tt1' }),
    seriesRow({ id: 2, name: 'neither' }),
  ];
  const { addon } = await setup(t, { fake: { movies, series } });

  const status = await addon.readData('status.json');
  const { lastSuccessAt: moviesAt, ...movieCounts } = status.movies;
  const { lastSuccessAt: seriesAt, ...seriesCounts } = status.series;
  assert.deepEqual(movieCounts, {
    rows: 7,
    withTmdb: 3,
    withImdb: 3,
    withEither: 5,
    yearConflicts: 0,
    upstreamRows: 10,
    adultSkipped: 1,
    invalidSkipped: 2,
    prereleaseSkipped: 0,
  });
  assert.deepEqual(seriesCounts, {
    rows: 2,
    withTmdb: 1,
    withImdb: 1,
    withEither: 1,
    yearConflicts: 0,
    upstreamRows: 2,
    adultSkipped: 0,
    invalidSkipped: 0,
    prereleaseSkipped: 0,
  });
  assert.deepEqual(status.imdbConversion, { enabled: false, conversions: 0, hits: 0, misses: 0, errors: 0, cached: 0 });
  assert.ok(Date.parse(moviesAt));
  assert.ok(Date.parse(seriesAt));
  assert.ok(Date.parse(status.updatedAt));
  assert.ok(Date.parse(status.startedAt));
  assert.ok(Date.parse(status.refresh.lastAttemptAt));
  assert.ok(Date.parse(status.refresh.lastSuccessAt));
  assert.equal(status.refresh.lastOk, true);
  assert.equal(status.refresh.lastError, null);
  assert.equal(status.upstream.state, 'unknown');
});

test('status.json counts rows whose name and row disagree about the year, and it survives a restart', async (t) => {
  const dataDir = await newDataDir(t);
  const fake = await startFakeDispatcharr({
    username: USERNAME,
    password: PASSWORD,
    movies: [
      // A disagreement, and one within a year that is not.
      movieRow({ id: 1, name: 'EN - Dune (2021) DENIS VILLENEUVE', tmdb: '841', year: 1984 }),
      movieRow({ id: 2, name: 'EN - Fantasia 2000 (1999)', tmdb: '49948', year: 2000 }),
      movieRow({ id: 3, name: 'EN - Film (2019)', tmdb: '3', year: 2020 }),
      // The row's year came from the title, so nothing disagrees.
      movieRow({ id: 4, name: 'EN - 1917 (2019)', tmdb: '4', year: 1917 }),
      // Nothing can look it up, so it does not matter.
      movieRow({ id: 5, name: 'EN - Unmatched (2012)', year: 1984 }),
    ],
    series: [
      seriesRow({ id: 6, name: 'EN - Doctor Who (2005)', tmdb: '121', releaseDate: '1963-11-23' }),
      seriesRow({ id: 7, name: 'EN - Friends (1994-2004)', tmdb: '1668', releaseDate: '1996-01-01' }),
    ],
  });
  t.after(() => fake.stop());
  const first = await startAddon({ baseUrl: fake.baseUrl, dataDir });
  t.after(() => first.stop());
  await first.app.refresh();
  const before = await first.readData('status.json');
  assert.equal(before.movies.yearConflicts, 1);
  assert.equal(before.series.yearConflicts, 1);
  const text = await first.readDataText('status.json');
  assert.ok(!text.includes('Dune'), 'a count, not a list of titles');
  await first.stop();

  const second = await startAddon({ baseUrl: fake.baseUrl, dataDir });
  t.after(() => second.stop());
  const after = await second.readData('status.json');
  assert.equal(after.movies.yearConflicts, 1);
  assert.equal(after.series.yearConflicts, 1);
  // Restored rows are left out of lookups too, not only freshly fetched ones.
  const restored = await second.getJson('/stream/movie/tmdb:841.json');
  assert.deepEqual(restored.body.streams, []);
});

test('coverage figures survive a restart, and drop reasons read null until the next refresh', async (t) => {
  const dataDir = await newDataDir(t);
  const fake = await startFakeDispatcharr({
    username: USERNAME,
    password: PASSWORD,
    movies: [
      movieRow({ id: 1, name: 'matched', tmdb: '1' }),
      movieRow({ id: 2, name: 'no ids' }),
      movieRow({ id: 3, name: 'adult', tmdb: '3', adult: 1 }),
    ],
  });
  const first = await startAddon({ baseUrl: fake.baseUrl, dataDir });
  await first.app.refresh();
  const before = await first.readData('status.json');
  await first.stop();

  const second = await startAddon({ baseUrl: fake.baseUrl, dataDir });
  t.after(async () => {
    await second.stop();
    await fake.stop();
  });
  const after = await second.readData('status.json');
  assert.equal(after.movies.rows, before.movies.rows);
  assert.equal(after.movies.rows, 2);
  assert.equal(after.movies.withEither, before.movies.withEither);
  assert.equal(after.movies.adultSkipped, null);
  assert.equal(after.refresh.lastOk, null);
});

test('files are replaced atomically, leaving no temporary files', async (t) => {
  const { readdir } = await import('node:fs/promises');
  const { addon } = await setup(t, { fake: { movies: [FILM], series: [SHOW] } });
  await addon.app.refresh();
  await addon.app.flush();
  assert.deepEqual((await readdir(addon.dataDir)).sort(), ['snapshot.json', 'status.json']);
});

test('a failed refresh is retried by a later successful heartbeat, not after REFRESH_HOURS', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: { movies: [FILM], series: [SHOW] },
    refresh: false,
    overrides: { refreshRetryMs: 0 },
  });
  fake.failures.get_vod_streams = 500;
  fake.failures.get_series = 500;
  await addon.app.refresh();
  assert.equal(addon.app.catalogs.movies.size, 0);

  delete fake.failures.get_vod_streams;
  delete fake.failures.get_series;
  await addon.app.heartbeat();
  await addon.app.refresh();
  assert.equal(addon.app.catalogs.movies.size, 1);
});

test('a successful refresh is not repeated by the heartbeat', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: { movies: [FILM], series: [SHOW] },
    overrides: { refreshRetryMs: 0 },
  });
  const films = fake.count('get_vod_streams');
  const shows = fake.count('get_series');
  await addon.app.heartbeat();
  await addon.app.heartbeat();
  assert.equal(fake.count('get_vod_streams'), films);
  assert.equal(fake.count('get_series'), shows);
});
