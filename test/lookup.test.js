import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { movieStream } from '../src/streams.js';
import { episodeRow, movieRow, seriesInfoBody, seriesRow } from '../test-support/fake-dispatcharr.js';
import { directUrl, setup } from '../test-support/harness.js';

const MATRIX = movieRow({ id: 101, name: 'The Matrix [EN]', tmdb: '603', imdb: 'tt0133093', year: 1999, ext: 'mkv' });

test('the manifest is a plain stream add-on, with idPrefixes where clients read them', async (t) => {
  const { addon } = await setup(t);
  const { status, body } = await addon.getJson('/manifest.json');
  assert.equal(status, 200);
  assert.deepEqual(body, {
    id: 'local.iptv-vod-addon',
    version: '2.0.0',
    name: 'IPTV VOD',
    description: 'Movies and episodes from your own Xtream Codes VOD source, matched by IMDb and TMDB id. This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.',
    resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt', 'tmdb:'] }],
    types: ['movie', 'series'],
    catalogs: [],
  });
});

test('every kind of miss is an empty 200, never a 404', async (t) => {
  const { addon } = await setup(t, { fake: { movies: [MATRIX] } });
  for (const path of ['/stream/movie/tt9999999.json', '/stream/movie/tmdb:999.json', '/stream/series/tt9999999:1:1.json', '/stream/series/tmdb:999:1:1.json']) {
    const { status, body } = await addon.getJson(path);
    assert.equal(status, 200, path);
    assert.deepEqual(body, { streams: [] }, path);
  }
});

test('a movie hit has the exact shape', async (t) => {
  const { fake, addon } = await setup(t, { fake: { movies: [MATRIX] } });
  const { status, body } = await addon.getJson('/stream/movie/tt0133093.json');
  assert.equal(status, 200);
  assert.deepEqual(body, {
    streams: [{
      name: 'IPTV VOD',
      description: 'The Matrix (1999) 1080p ENG.mkv',
      url: directUrl(fake, 'movie', 101, 'mkv'),
      behaviorHints: {
        filename: 'The Matrix (1999) 1080p ENG.mkv',
        indexer: 'IPTV VOD',
        notWebReady: true,
        cached: true,
        bingeGroup: 'iptv-vod-movie-101',
      },
    }],
  });
});

test('nothing is fabricated: no size, duration or date, and no torrent fields', async (t) => {
  const { addon } = await setup(t, { fake: { movies: [MATRIX] } });
  const [stream] = (await addon.getJson('/stream/movie/tt0133093.json')).body.streams;
  for (const key of ['infoHash', 'sources', 'nzbUrl', 'fileIdx']) assert.ok(!(key in stream), key);
  for (const key of ['videoSize', 'duration', 'publishDate', 'seeders', 'service']) assert.ok(!(key in stream.behaviorHints), key);
  // A name carrying a quality word is passed on as stated, and one without gains none.
  assert.ok(!/WEB|BluRay|Rip/i.test(stream.behaviorHints.filename));
});

test('the stream name is constant, so no title can read as a service', async (t) => {
  const { addon } = await setup(t, {
    fake: { movies: [movieRow({ id: 1, name: 'EN - Alien - 1979', tmdb: '1', year: 1979, ext: 'mp4' })] },
  });
  const [stream] = (await addon.getJson('/stream/movie/tmdb:1.json')).body.streams;
  assert.equal(stream.name, 'IPTV VOD');
  assert.equal(stream.description, stream.behaviorHints.filename);
  assert.ok(!stream.description.includes('EN -'));
});

test('movie lookups make no upstream call of any kind', async (t) => {
  const { fake, addon } = await setup(t, { fake: { movies: [MATRIX] } });
  const before = fake.requests.length;
  await addon.getJson('/stream/movie/tt0133093.json');
  await addon.getJson('/stream/movie/tmdb:603.json');
  await addon.getJson('/stream/movie/tt1.json');
  await addon.getJson('/stream/movie/tmdb:1.json');
  assert.equal(fake.requests.length, before);
});

test('an encoded colon is decoded', async (t) => {
  const { addon } = await setup(t, { fake: { movies: [MATRIX] } });
  const { status, body } = await addon.getJson('/stream/movie/tmdb%3A603.json');
  assert.equal(status, 200);
  assert.equal(body.streams.length, 1);
});

test('a bare id is a film only under type movie: other types never get one', async (t) => {
  // TMDB numbers collide between films and shows: this is the wrong-film case. A bare
  // id under another type names no episode either, so there is nothing to offer.
  const { addon } = await setup(t, { fake: { movies: [MATRIX] } });
  for (const type of ['series', 'anime', 'tv', 'other', 'Movie', '%E0%A4%A']) {
    for (const id of ['tmdb:603', 'tt0133093']) {
      const { status, body } = await addon.getJson(`/stream/${type}/${id}.json`);
      assert.equal(status, 200, `${type} ${id}`);
      assert.deepEqual(body, { streams: [] }, `${type} ${id}`);
    }
  }
  assert.equal((await addon.getJson('/stream/movie/tmdb:603.json')).body.streams.length, 1);
  assert.equal((await addon.getJson('/stream/movie/tt0133093.json')).body.streams.length, 1);
});

test('an episode id is an episode only under type series: other types never get one', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: {
      movies: [movieRow({ id: 1, name: 'Same Number', tmdb: '200', imdb: 'tt02' })],
      series: [seriesRow({ id: 20, name: 'The Show', tmdb: '200', imdb: 'tt02' })],
      seriesInfo: { 20: seriesInfoBody({ episodes: [episodeRow({ id: 2001, season: 1, episode: 1 })] }) },
    },
  });
  const before = fake.count('get_series_info');
  for (const type of ['movie', 'banana', 'tv', 'Series', '%ZZ']) {
    for (const id of ['tmdb:200:1:1', 'tt02:1:1']) {
      const { status, body } = await addon.getJson(`/stream/${type}/${id}.json`);
      assert.equal(status, 200, `${type} ${id}`);
      assert.deepEqual(body, { streams: [] }, `${type} ${id}`);
    }
  }
  assert.equal(fake.count('get_series_info'), before, 'and it costs no upstream call');
  for (const id of ['tmdb:200:1:1', 'tt02:1:1']) {
    assert.equal((await addon.getJson(`/stream/series/${id}.json`)).body.streams.length, 1, id);
  }
});

test('malformed ids are empty 200s', async (t) => {
  const { addon } = await setup(t, { fake: { movies: [MATRIX] } });
  for (const id of [
    'tt0133093:1', 'tt0133093:1:2:3', 'tt', 'foo', 'kitsu:1', 'tt0133093:a:b', '%E0%A4%A', 'TT0133093',
    'tmdb:603:1', 'tmdb:', 'tmdb:abc', 'a%2Fb', '..%2F..%2Fetc',
  ]) {
    const { status, body } = await addon.getJson(`/stream/movie/${id}.json`);
    assert.equal(status, 200, id);
    assert.deepEqual(body, { streams: [] }, id);
  }
});

test('an episode hit by tt and by tmdb, matched on exact season and episode_num', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: {
      series: [seriesRow({ id: 20, name: 'EN - Good Show', tmdb: '1396', imdb: 'tt0903747', releaseDate: '2008-01-20' })],
      seriesInfo: {
        20: seriesInfoBody({
          episodes: [
            episodeRow({ id: 2001, season: 1, episode: 1, ext: 'mkv' }),
            episodeRow({ id: 2002, season: 1, episode: 2, ext: 'mp4' }),
            episodeRow({ id: 2011, season: 2, episode: 1, ext: 'mkv' }),
          ],
        }),
      },
    },
  });

  const expected = {
    streams: [{
      name: 'IPTV VOD',
      description: 'Good Show (2008) S01E02 1080p ENG.mp4',
      url: directUrl(fake, 'series', 2002, 'mp4'),
      behaviorHints: {
        filename: 'Good Show (2008) S01E02 1080p ENG.mp4',
        indexer: 'IPTV VOD',
        notWebReady: true,
        cached: true,
        bingeGroup: 'iptv-vod-series-20',
      },
    }],
  };

  for (const path of ['tt0903747:1:2', 'tmdb:1396:1:2', 'tt0903747%3A1%3A2', 'tmdb%3A1396%3A1%3A2']) {
    const { status, body } = await addon.getJson(`/stream/series/${path}.json`);
    assert.equal(status, 200, path);
    assert.deepEqual(body, expected, path);
  }
});

test('the binge group stays the same across a copy\'s episodes', async (t) => {
  const { addon } = await setup(t, {
    fake: {
      series: [seriesRow({ id: 20, name: 'Show', tmdb: '1' })],
      seriesInfo: { 20: seriesInfoBody({ episodes: [episodeRow({ id: 1, season: 1, episode: 1 }), episodeRow({ id: 2, season: 1, episode: 2 })] }) },
    },
  });
  const group = async (e) => (await addon.getJson(`/stream/series/tmdb:1:1:${e}.json`)).body.streams[0].behaviorHints.bingeGroup;
  assert.equal(await group(1), await group(2));
});

test('episode misses are empty 200s', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: {
      series: [seriesRow({ id: 20, name: 'Good Show', tmdb: '1396', imdb: 'tt0903747' })],
      seriesInfo: { 20: seriesInfoBody({ episodes: [episodeRow({ id: 2001, season: 1, episode: 1 })] }) },
    },
  });

  // Unknown series: no upstream call needed.
  const before = fake.count('get_series_info');
  assert.deepEqual((await addon.getJson('/stream/series/tt1:1:1.json')).body, { streams: [] });
  assert.deepEqual((await addon.getJson('/stream/series/tmdb:1:1:1.json')).body, { streams: [] });
  assert.equal(fake.count('get_series_info'), before);

  // Known series, unknown episode.
  for (const path of ['/stream/series/tt0903747:9:9.json', '/stream/series/tmdb:1396:9:9.json']) {
    const { status, body } = await addon.getJson(path);
    assert.equal(status, 200, path);
    assert.deepEqual(body, { streams: [] }, path);
  }
});

test('season 0 specials match, but episode_num 0 never does', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: {
      series: [seriesRow({ id: 20, name: 'Good Show', tmdb: '1396' })],
      seriesInfo: {
        20: seriesInfoBody({
          episodes: [
            episodeRow({ id: 5, season: 0, episode: 1, title: 'Special' }),
            // Dispatcharr writes 0 when a provider gave no usable number.
            episodeRow({ id: 6, season: 1, episode: 0, title: 'Unnumbered' }),
          ],
        }),
      },
    },
  });
  const special = await addon.getJson('/stream/series/tmdb:1396:0:1.json');
  assert.equal(special.body.streams[0].url, directUrl(fake, 'series', 5, 'mkv'));
  const unnumbered = await addon.getJson('/stream/series/tmdb:1396:1:0.json');
  assert.deepEqual(unnumbered.body, { streams: [] });
});

test('adult rows are skipped', async (t) => {
  const { addon } = await setup(t, {
    fake: {
      movies: [
        movieRow({ id: 1, name: 'Mature Movie', tmdb: '11', imdb: 'tt11', adult: 1 }),
        movieRow({ id: 2, name: 'Family Movie', tmdb: '22', imdb: 'tt22', adult: 0 }),
      ],
    },
  });
  assert.deepEqual((await addon.getJson('/stream/movie/tt11.json')).body, { streams: [] });
  assert.deepEqual((await addon.getJson('/stream/movie/tmdb:11.json')).body, { streams: [] });
  assert.equal((await addon.getJson('/stream/movie/tt22.json')).body.streams.length, 1);
});

test('languages are not filtered here: they are labelled and left to the consumer', async (t) => {
  const { addon } = await setup(t, {
    fake: {
      movies: [
        movieRow({ id: 1, name: 'English [EN]', tmdb: '1' }),
        movieRow({ id: 2, name: 'French [FR]', tmdb: '2' }),
        movieRow({ id: 3, name: 'Untagged', tmdb: '3' }),
      ],
    },
  });
  const name = async (id) => (await addon.getJson(`/stream/movie/tmdb:${id}.json`)).body.streams[0].behaviorHints.filename;
  assert.equal(await name(1), 'English 1080p ENG.mkv');
  assert.equal(await name(2), 'French 1080p FR.mkv');
  assert.equal(await name(3), 'Untagged 1080p.mkv');
});

test('duplicate copies keep distinct URLs and binge groups', async (t) => {
  // Dispatcharr's identity is (external id, language), so one tmdb id can be two rows.
  const { addon } = await setup(t, {
    fake: {
      movies: [
        movieRow({ id: 1, name: 'Same [EN]', tmdb: '9', year: 2000 }),
        movieRow({ id: 2, name: 'Same [DE]', tmdb: '9', year: 2000 }),
        movieRow({ id: 3, name: 'Same', tmdb: '9', year: 2000 }),
        movieRow({ id: 4, name: 'Same', tmdb: '9', year: 2000 }),
      ],
    },
  });
  const { body } = await addon.getJson('/stream/movie/tmdb:9.json');
  assert.equal(body.streams.length, 4);
  assert.equal(new Set(body.streams.map((s) => s.behaviorHints.bingeGroup)).size, 4);
  assert.equal(new Set(body.streams.map((s) => s.url)).size, 4);
  // Rows 3 and 4 have the same filename, which is exactly why the group has to differ.
  assert.equal(body.streams[2].behaviorHints.filename, body.streams[3].behaviorHints.filename);
});

test('episode copies from two series rows of one id are both returned', async (t) => {
  const { addon } = await setup(t, {
    fake: {
      series: [
        seriesRow({ id: 30, name: 'Show [EN]', tmdb: '77' }),
        seriesRow({ id: 31, name: 'Show [DE]', tmdb: '77' }),
      ],
      seriesInfo: {
        30: seriesInfoBody({ episodes: [episodeRow({ id: 301, season: 1, episode: 1 })] }),
        31: seriesInfoBody({ episodes: [episodeRow({ id: 311, season: 1, episode: 1 })] }),
      },
    },
  });
  const { body } = await addon.getJson('/stream/series/tmdb:77:1:1.json');
  assert.deepEqual(
    body.streams.map((s) => s.behaviorHints.bingeGroup).sort(),
    ['iptv-vod-series-30', 'iptv-vod-series-31'],
  );
});

test('the resolution token comes from the name, otherwise the configured fallback', async (t) => {
  const { addon } = await setup(t, {
    fake: {
      movies: [
        movieRow({ id: 1, name: 'Film 4K', tmdb: '1', year: 2020 }),
        movieRow({ id: 2, name: 'Film 720p', tmdb: '2', year: 2020 }),
        movieRow({ id: 3, name: 'Film', tmdb: '3', year: 2020 }),
        movieRow({ id: 4, name: '4K-NF - Film', tmdb: '4', year: 2020 }),
      ],
    },
    env: { UNKNOWN_RESOLUTION_TAG: '720p' },
  });
  const filename = async (id) => (await addon.getJson(`/stream/movie/tmdb:${id}.json`)).body.streams[0].behaviorHints.filename;
  assert.equal(await filename(1), 'Film (2020) 2160p.mkv');
  assert.equal(await filename(2), 'Film (2020) 720p.mkv');
  assert.equal(await filename(3), 'Film (2020) 720p.mkv');
  assert.equal(await filename(4), 'Film (2020) 2160p.mkv');
});

test('an interlaced token never reaches the filename', async (t) => {
  const { addon } = await setup(t, {
    fake: {
      movies: [
        movieRow({ id: 1, name: 'Film 1080i', tmdb: '1', year: 2000 }),
        movieRow({ id: 2, name: 'Film 720I', tmdb: '2', year: 2000 }),
        movieRow({ id: 3, name: 'Film 1080i50', tmdb: '3', year: 2000 }),
      ],
      series: [seriesRow({ id: 7, name: 'Show 1080i', tmdb: '7' })],
      seriesInfo: { 7: seriesInfoBody({ episodes: [episodeRow({ id: 71, season: 1, episode: 1 })] }) },
    },
  });
  const filename = async (id) => (await addon.getJson(`/stream/movie/tmdb:${id}.json`)).body.streams[0].behaviorHints.filename;
  assert.equal(await filename(1), 'Film (2000) 1080p.mkv');
  assert.equal(await filename(2), 'Film (2000) 720p.mkv');
  assert.equal(await filename(3), 'Film (2000) 1080p.mkv');
  const episode = (await addon.getJson('/stream/series/tmdb:7:1:1.json')).body.streams[0];
  assert.equal(episode.behaviorHints.filename, 'Show S01E01 1080p.mkv');
});

test('a provider quality tag is not a language, and leaves the title', async (t) => {
  const { addon } = await setup(t, {
    fake: {
      movies: [
        movieRow({ id: 1, name: 'Bracket Film [HD]', tmdb: '1', year: 2000 }),
        movieRow({ id: 2, name: 'Bracket Film [SD]', tmdb: '2', year: 2000 }),
        // Dispatcharr appends its own tag after the provider's.
        movieRow({ id: 5, name: 'Tagged [HD] [EN]', tmdb: '5', year: 2000 }),
        movieRow({ id: 6, name: 'Tagged [HD] [FR]', tmdb: '6', year: 2000 }),
      ],
    },
  });
  const filename = async (id) => (await addon.getJson(`/stream/movie/tmdb:${id}.json`)).body.streams[0].behaviorHints.filename;
  assert.equal(await filename(1), 'Bracket Film (2000) 1080p.mkv');
  assert.equal(await filename(2), 'Bracket Film (2000) 480p.mkv');
  assert.equal(await filename(5), 'Tagged (2000) 1080p ENG.mkv');
  assert.equal(await filename(6), 'Tagged (2000) 1080p FR.mkv');
});

test('pre-release movie copies are never offered, but a film called Cam still is', async (t) => {
  const { addon } = await setup(t, {
    fake: {
      movies: [
        movieRow({ id: 1, name: 'Fresh Film (2026) HDCAM', tmdb: '1', year: 2026 }),
        movieRow({ id: 2, name: 'EN - Fresh Film (2026) TS', tmdb: '2', year: 2026 }),
        movieRow({ id: 3, name: 'Cam', tmdb: '3', year: 2018 }),
        movieRow({ id: 4, name: 'Fresh Film (2026) 1080p', tmdb: '4', year: 2026 }),
        movieRow({ id: 5, name: 'EN - CAM (2018)', tmdb: '5', year: 2018 }),
      ],
    },
  });
  const stream = async (id) => (await addon.getJson(`/stream/movie/tmdb:${id}.json`)).body.streams[0];
  assert.equal(await stream(1), undefined);
  assert.equal(await stream(2), undefined);
  assert.ok(await stream(3));
  assert.ok(await stream(4));
  assert.ok(await stream(5));

  const status = await addon.readData('status.json');
  assert.equal(status.movies.prereleaseSkipped, 2);
  assert.equal(status.movies.rows, 3);
});

test('a title cut at its length limit is still JSON a strict parser can read', async (t) => {
  const { addon } = await setup(t, {
    fake: {
      movies: [
        movieRow({ id: 1, name: `${'a'.repeat(159)}\u{1F3AC} tail`, tmdb: '1' }),
        movieRow({ id: 2, name: 'Provider \ud83d broken', tmdb: '2' }),
      ],
    },
  });
  for (const id of ['1', '2']) {
    const text = await (await addon.get(`/stream/movie/tmdb:${id}.json`)).text();
    assert.ok(!/\\ud[89ab]/i.test(text), text);
    assert.equal(JSON.parse(text).streams.length, 1);
    assert.ok(JSON.parse(text).streams[0].behaviorHints.filename.isWellFormed());
  }
});

test('filenames are sanitised, and .ts stays in the URL but leaves the filename', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: {
      movies: [
        movieRow({ id: 1, name: 'Face/Off\\Again\nNow [EN]', tmdb: '1', year: 1997, ext: 'ts' }),
        movieRow({ id: 2, name: 'Already Dated (2004)', tmdb: '2', year: 2004, ext: 'MP4' }),
        movieRow({ id: 3, name: '2012', tmdb: '3', year: 2012, ext: 'avi' }),
      ],
      series: [seriesRow({ id: 4, name: 'Show', tmdb: '4' })],
      seriesInfo: { 4: seriesInfoBody({ episodes: [episodeRow({ id: 41, season: 1, episode: 1, ext: 'ts' })] }) },
    },
  });
  const stream = async (id) => (await addon.getJson(`/stream/movie/tmdb:${id}.json`)).body.streams[0];

  const first = await stream(1);
  assert.equal(first.behaviorHints.filename, 'Face Off Again Now (1997) 1080p ENG');
  assert.equal(first.description, 'Face Off Again Now (1997) 1080p ENG');
  assert.equal(first.url, directUrl(fake, 'movie', 1, 'ts'));

  const second = await stream(2);
  assert.equal(second.behaviorHints.filename, 'Already Dated (2004) 1080p.mp4');
  assert.equal(second.url, directUrl(fake, 'movie', 2, 'mp4'));

  assert.equal((await stream(3)).behaviorHints.filename, '2012 (2012) 1080p.avi');

  const episode = (await addon.getJson('/stream/series/tmdb:4:1:1.json')).body.streams[0];
  assert.equal(episode.behaviorHints.filename, 'Show S01E01 1080p');
  assert.equal(episode.url, directUrl(fake, 'series', 41, 'ts'));
});

test('notWebReady is false only for https and mp4 together', () => {
  const entry = { id: '1', name: 'Film', year: 2000, lang: null, ext: 'mp4' };
  const required = { XC_USERNAME: 'u', XC_PASSWORD: 'p' };
  const hint = (base, ext) => movieStream({ ...entry, ext }, loadConfig({ ...required, XC_BASE_URL: base })).behaviorHints.notWebReady;
  assert.equal(hint('https://up.example.org', 'mp4'), false);
  assert.equal(hint('https://up.example.org', 'mkv'), true);
  assert.equal(hint('http://up.example.org', 'mp4'), true);
  assert.equal(hint('http://up.example.org', 'ts'), true);
});

test('series year comes from release_date, since get_series has no year key', async (t) => {
  const { addon } = await setup(t, {
    fake: { series: [seriesRow({ id: 5, name: 'Dated Show', tmdb: '5', releaseDate: '2022-06-01' })] },
  });
  assert.equal(addon.app.catalogs.series.find('tmdb', '5')[0].year, 2022);
});

test('malformed rows are skipped without throwing, and good rows survive', async (t) => {
  const good = movieRow({ id: 50, name: 'Good', tmdb: '500', imdb: 'tt500' });
  const { fake, addon } = await setup(t, {
    fake: {
      movies: [
        null, 42, 'text', [], {},
        { name: 'no id', tmdb_id: '1' },
        { stream_id: 'abc', name: 'bad id', tmdb_id: '2' },
        { stream_id: -1, name: 'negative', tmdb_id: '3' },
        { stream_id: 1.5, name: 'float', tmdb_id: '4' },
        { stream_id: null, name: 'null id', tmdb_id: '5' },
        { stream_id: 60, tmdb_id: 600, imdb_id: 600601 },
        { stream_id: 61, name: 'junk ids', tmdb_id: 'tm123', imdb_id: 'nm000', year: {}, container_extension: 'bad/ext' },
        { stream_id: 62, name: { nested: true }, tmdb_id: null, imdb_id: null },
        { stream_id: 63, name: 'Bad ext', tmdb_id: '630', container_extension: '../../x' },
        good,
      ],
      series: [null, { series_id: 'x' }, 7, seriesRow({ id: 70, name: 'Survivor', tmdb: '700' })],
    },
  });
  assert.equal(addon.logs.filter((l) => l.includes('refresh failed')).length, 0);
  assert.equal((await addon.getJson('/stream/movie/tmdb:500.json')).body.streams.length, 1);

  // A numeric id and a nameless row are still usable.
  const numeric = (await addon.getJson('/stream/movie/tmdb:600.json')).body.streams[0];
  assert.equal(numeric.behaviorHints.filename, 'Unknown 1080p.mp4');
  assert.equal(numeric.url, directUrl(fake, 'movie', 60, 'mp4'));
  assert.equal((await addon.getJson('/stream/movie/tt600601.json')).body.streams.length, 1);

  // A bad extension can never reach a URL.
  const bad = (await addon.getJson('/stream/movie/tmdb:630.json')).body.streams[0];
  assert.equal(bad.url, directUrl(fake, 'movie', 63, 'mp4'));

  // Rows with no usable id never match anything.
  assert.deepEqual((await addon.getJson('/stream/movie/tmdb:1.json')).body, { streams: [] });
});

test('only GET and HEAD are served, and HEAD has no body', async (t) => {
  const { addon } = await setup(t, { fake: { movies: [MATRIX] } });
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await addon.get('/stream/movie/tt0133093.json', { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  }
  const head = await addon.get('/stream/movie/tt0133093.json', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await addon.get('/stream/movie/tt1.json', { method: 'HEAD' })).status, 200);
  assert.equal((await addon.get('/manifest.json', { method: 'HEAD' })).status, 200);
});

test('unknown paths are 404 and reflect nothing, and nothing here serves or redirects to a stream', async (t) => {
  const { addon } = await setup(t);
  for (const path of [
    '/', '/stream', '/stream/movie/tt1', '/catalog/movie/x.json', '/meta/movie/tt1.json', '/manifest.json/x',
    '/play/movie/123.mkv', '/play/series/456.mp4',
  ]) {
    const response = await addon.get(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('location'), null, path);
    assert.deepEqual(await response.json(), { error: 'not found' });
  }
});

test('/health reports status and counts only', async (t) => {
  const { addon } = await setup(t, {
    fake: {
      movies: [MATRIX],
      series: [seriesRow({ id: 1, name: 'S', tmdb: '1' }), seriesRow({ id: 2, name: 'T', tmdb: '2' })],
    },
  });
  const { status, body } = await addon.getJson('/health');
  assert.equal(status, 200);
  assert.deepEqual(body, { status: 'ok', movies: 1, series: 2 });
});

test('a film whose name and row disagree about the year is not offered', async (t) => {
  const { addon } = await setup(t, {
    fake: {
      movies: [
        // The row says 1984 and carries that film's id, but the name is the 2021 film.
        movieRow({ id: 1, name: 'EN - Dune (2021) DENIS VILLENEUVE', tmdb: '841', year: 1984 }),
        movieRow({ id: 2, name: 'NF - Dune - 2021', tmdb: '438631', year: 2021 }),
        // One year apart is ordinary, and the row's year here is only a word of the title.
        movieRow({ id: 3, name: 'EN - Film (2019)', tmdb: '3', year: 2020 }),
        movieRow({ id: 4, name: 'EN - 1917 (2019)', tmdb: '4', year: 1917 }),
      ],
    },
  });
  const count = async (id) => (await addon.getJson(`/stream/movie/tmdb:${id}.json`)).body.streams.length;
  assert.equal(await count(841), 0);
  assert.equal(await count(438631), 1);
  assert.equal(await count(3), 1);
  assert.equal(await count(4), 1);
});

test('a series keeps its rows when the name states a later year', async (t) => {
  const { addon } = await setup(t, {
    fake: {
      series: [seriesRow({ id: 6, name: 'EN - Doctor Who (2005)', tmdb: '121', releaseDate: '1963-11-23' })],
      seriesInfo: { 6: seriesInfoBody({ episodes: [episodeRow({ id: 60, season: 1, episode: 1 })] }) },
    },
  });
  const { body } = await addon.getJson('/stream/series/tmdb:121:1:1.json');
  assert.equal(body.streams.length, 1);
});
