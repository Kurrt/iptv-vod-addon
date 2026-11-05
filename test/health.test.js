import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { UpstreamHealth } from '../src/health.js';
import { episodeRow, movieRow, seriesInfoBody, seriesRow } from '../test-support/fake-dispatcharr.js';
import { setup, startAddon } from '../test-support/harness.js';

const FILM = movieRow({ id: 1, name: 'Film', tmdb: '100', imdb: 'tt100' });

async function beat(addon, times) {
  for (let i = 0; i < times; i += 1) await addon.app.heartbeat();
}

test('heartbeat calls player_api.php with credentials and no action, and only that', async (t) => {
  const { fake, addon } = await setup(t, { refresh: false });
  await addon.app.heartbeat();
  assert.deepEqual(fake.requests, [{ action: 'info', path: '/player_api.php', seriesId: null }]);
  assert.equal(addon.app.health.state, 'up');
});

test('down after HEARTBEAT_FAILURES auth failures: every lookup is an empty 200 nothing should keep', async (t) => {
  const { fake, addon } = await setup(t, { fake: { movies: [FILM] } });
  await addon.app.heartbeat();

  fake.authRejected = true;
  await beat(addon, 2);
  assert.equal(addon.app.health.state, 'up');
  assert.equal((await addon.getJson('/stream/movie/tt100.json')).body.streams.length, 1);

  await addon.app.heartbeat();
  assert.equal(addon.app.health.state, 'down');
  for (const path of ['movie/tt100', 'movie/tmdb:100', 'movie/tt999', 'movie/tmdb:999', 'series/tt100:1:1', 'series/tmdb:100:1:1']) {
    const { status, body } = await addon.getJson(`/stream/${path}.json`);
    assert.equal(status, 200, path);
    assert.deepEqual(body, { streams: [], cacheMaxAge: 0 }, path);
  }
  // These have the same answer whether upstream is up or not, so it can be kept.
  for (const path of ['movie/tt100:1', 'movie/garbage', 'movie/tt100:1:1', 'series/tt100', '%ZZ/tt100', 'movie/%ZZ']) {
    const { status, body } = await addon.getJson(`/stream/${path}.json`);
    assert.equal(status, 200, path);
    assert.deepEqual(body, { streams: [] }, path);
  }
  assert.deepEqual((await addon.getJson('/health')).body, { status: 'upstream_down', movies: 1, series: 0 });
});

test('network failures, bad status codes and non-JSON bodies all count', async (t) => {
  const { fake, addon } = await setup(t, { fake: { movies: [FILM] }, refresh: false });
  fake.failures.info = 503;
  await addon.app.heartbeat();
  fake.failures.info = 'html';
  await addon.app.heartbeat();
  assert.equal(addon.app.health.state, 'unknown');
  await fake.stop();
  await addon.app.heartbeat();
  assert.equal(addon.app.health.state, 'down');
  const status = await addon.readData('status.json');
  assert.match(status.upstream.lastFailureReason, /^network/);
  assert.equal(status.upstream.consecutiveFailures, 3);
});

test('a 200 that says auth 0 is a failure', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user_info: { auth: 0 } }));
  });
  await new Promise((resolve) => { server.listen(0, resolve); });
  t.after(() => server.close());
  const addon = await startAddon({ baseUrl: `http://localhost:${server.address().port}` });
  t.after(() => addon.stop());

  await beat(addon, 3);
  assert.equal(addon.app.health.state, 'down');
  assert.equal((await addon.readData('status.json')).upstream.lastFailureReason, 'auth_rejected');
});

test('recovery takes one success and lookups work again', async (t) => {
  const { fake, addon } = await setup(t, { fake: { movies: [FILM] } });
  fake.authRejected = true;
  await beat(addon, 3);
  assert.equal(addon.app.health.state, 'down');

  fake.authRejected = false;
  await addon.app.heartbeat();
  assert.equal(addon.app.health.state, 'up');
  assert.equal((await addon.getJson('/stream/movie/tt100.json')).body.streams.length, 1);
  assert.deepEqual((await addon.getJson('/health')).body, { status: 'ok', movies: 1, series: 0 });
});

test('a success resets the failure count', async (t) => {
  const { fake, addon } = await setup(t, { refresh: false });
  fake.authRejected = true;
  await beat(addon, 2);
  fake.authRejected = false;
  await addon.app.heartbeat();
  fake.authRejected = true;
  await beat(addon, 2);
  assert.equal(addon.app.health.state, 'up');
});

test('transitions are logged once, not on every failure', async (t) => {
  const { fake, addon } = await setup(t, { refresh: false });
  await beat(addon, 3);
  fake.authRejected = true;
  await beat(addon, 10);
  fake.authRejected = false;
  await beat(addon, 5);
  fake.authRejected = true;
  await beat(addon, 4);

  const count = (text) => addon.logs.filter((l) => l.includes(text)).length;
  assert.equal(count('upstream reachable'), 1);
  assert.equal(count('upstream down'), 2);
  assert.equal(count('upstream recovered'), 1);
});

test('status.json tracks the state after each change', async (t) => {
  const { fake, addon } = await setup(t, { refresh: false });
  await addon.app.heartbeat();
  assert.equal((await addon.readData('status.json')).upstream.state, 'up');

  fake.authRejected = true;
  await beat(addon, 3);
  const down = await addon.readData('status.json');
  assert.equal(down.upstream.state, 'down');
  assert.equal(down.upstream.lastFailureReason, 'http_401');
  assert.ok(Date.parse(down.upstream.since));
  assert.ok(Date.parse(down.upstream.lastFailureAt));
  assert.ok(Date.parse(down.upstream.lastSuccessAt));

  fake.authRejected = false;
  await addon.app.heartbeat();
  assert.equal((await addon.readData('status.json')).upstream.state, 'up');
});

test('no series info is requested for an episode lookup while down', async (t) => {
  const { fake, addon } = await setup(t, {
    fake: {
      series: [seriesRow({ id: 2, name: 'Show', tmdb: '200' })],
      seriesInfo: { 2: seriesInfoBody({ episodes: [episodeRow({ id: 21, season: 1, episode: 1 })] }) },
    },
  });
  fake.authRejected = true;
  await beat(addon, 3);
  await addon.getJson('/stream/series/tmdb:200:1:1.json');
  assert.equal(fake.count('get_series_info'), 0);
});

test('concurrent heartbeats do not count one outage twice', async (t) => {
  const { fake, addon } = await setup(t, { refresh: false });
  fake.authRejected = true;
  fake.delays.info = 20;
  await Promise.all([addon.app.heartbeat(), addon.app.heartbeat(), addon.app.heartbeat()]);
  assert.equal(fake.count('info'), 1);
  assert.equal(addon.app.health.state, 'unknown');
});

test('UpstreamHealth reports changes only when the state moves', () => {
  const health = new UpstreamHealth(2);
  assert.equal(health.state, 'unknown');
  assert.equal(health.recordFailure('x'), false);
  assert.equal(health.recordFailure('x'), true);
  assert.equal(health.state, 'down');
  assert.equal(health.recordFailure('x'), false);
  assert.equal(health.recordSuccess(), true);
  assert.equal(health.state, 'up');
  assert.equal(health.recordSuccess(), false);
});
