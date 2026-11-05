// Stream URLs point straight at Dispatcharr: its credentials, percent-encoded, in a
// form its routes accept. Nothing in the add-on sits between a player and the bytes.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { streamUrl } from '../src/streams.js';
import { episodeRow, movieRow, seriesInfoBody, seriesRow } from '../test-support/fake-dispatcharr.js';
import { PASSWORD, setup, USERNAME } from '../test-support/harness.js';

test('every reserved character in a credential is percent-encoded', () => {
  const url = streamUrl({ baseUrl: 'http://up', username: 'a b/c?d#e', password: 'p@s%s&w=rd' }, 'movie', '1', 'mkv');
  assert.equal(url, 'http://up/movie/a%20b%2Fc%3Fd%23e/p%40s%25s%26w%3Drd/1.mkv');
});

test('a base URL with a path keeps it', () => {
  const url = streamUrl({ baseUrl: 'https://up.example.org/dispatcharr', username: 'u', password: 'p' }, 'series', '9', 'mp4');
  assert.equal(url, 'https://up.example.org/dispatcharr/series/u/p/9.mp4');
});

test('a returned movie URL really reaches the Dispatcharr route, with the credentials decoded', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: { movies: [movieRow({ id: 123, name: 'Film', tmdb: '1', ext: 'mkv' })] },
  });
  const [stream] = (await addon.getJson('/stream/movie/tmdb:1.json')).body.streams;
  // The fake decodes then routes as Django does, and follows the 301 to ?session_id
  // before serving bytes, the chain a player walks.
  const response = await fetch(stream.url, { headers: { Range: 'bytes=0-7' } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'fake video bytes');
  assert.deepEqual(fake.streamHits, [{
    kind: 'movie', username: USERNAME, password: PASSWORD, id: '123', ext: 'mkv', range: 'bytes=0-7',
  }]);
  assert.ok(fake.rawStreamPaths[0].includes(encodeURIComponent(PASSWORD)), 'encoded on the wire');
});

test('a returned episode URL really reaches the series route', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: {
      series: [seriesRow({ id: 2, name: 'Show', tmdb: '2' })],
      seriesInfo: { 2: seriesInfoBody({ episodes: [episodeRow({ id: 456, season: 1, episode: 1, ext: 'mp4' })] }) },
    },
  });
  const [stream] = (await addon.getJson('/stream/series/tmdb:2:1:1.json')).body.streams;
  assert.equal(await (await fetch(stream.url)).text(), 'fake video bytes');
  assert.deepEqual(fake.streamHits, [{
    kind: 'series', username: USERNAME, password: PASSWORD, id: '456', ext: 'mp4', range: null,
  }]);
});

test('EXTRA_PROVIDER_TAGS reaches filenames and the pre-release check, and only when set', async (t) => {
  const movies = [
    movieRow({ id: 1, name: 'ABC - Heat (1995)', tmdb: '1', year: 1995 }),
    // A real film called Cam, once the tag is known not to be part of the title.
    movieRow({ id: 2, name: 'X+ - CAM (2018)', tmdb: '2', year: 2018 }),
  ];
  const { addon: tagged } = await setup(t, { fake: { movies }, env: { EXTRA_PROVIDER_TAGS: 'ABC,X+' } });
  const filenameOf = async (addon, id) => (await addon.getJson(`/stream/movie/tmdb:${id}.json`)).body.streams[0]?.behaviorHints.filename;
  assert.equal(await filenameOf(tagged, 1), 'Heat (1995) 1080p.mkv');
  assert.equal(await filenameOf(tagged, 2), 'CAM (2018) 1080p.mkv');

  const { addon: plain } = await setup(t, { fake: { movies } });
  assert.equal(await filenameOf(plain, 1), 'ABC - Heat (1995) 1080p.mkv');
  assert.equal(await filenameOf(plain, 2), undefined);
});

test('no CORS header: a web page must not be able to read credentials from here', async (t) => {
  const { addon } = await setup(t, {
    fake: { movies: [movieRow({ id: 1, name: 'Film', tmdb: '1' })] },
  });
  for (const path of ['/manifest.json', '/stream/movie/tmdb:1.json', '/health']) {
    const response = await addon.get(path, { headers: { Origin: 'http://evil.example.org' } });
    assert.equal(response.headers.get('access-control-allow-origin'), null, path);
  }
});
