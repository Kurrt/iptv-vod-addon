import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger, createRedactor, describeError } from '../src/logger.js';
import { episodeRow, movieRow, seriesInfoBody, seriesRow, startFakeDispatcharr } from '../test-support/fake-dispatcharr.js';
import { PASSWORD, startAddon, USERNAME } from '../test-support/harness.js';

// Every form a credential could take on the wire, plus the upstream host.
function forbidden(fake) {
  return [
    USERNAME,
    PASSWORD,
    encodeURIComponent(USERNAME),
    encodeURIComponent(PASSWORD),
    new URLSearchParams({ v: USERNAME }).toString().slice(2),
    new URLSearchParams({ v: PASSWORD }).toString().slice(2),
    'localhost',
    fake.baseUrl,
    `:${fake.port}`,
  ];
}

function assertClean(label, text, needles) {
  for (const needle of needles) {
    assert.ok(!text.toLowerCase().includes(needle.toLowerCase()), `${label} contains ${needle}: ${text}`);
  }
}

test('credentials go in stream responses by design, and nowhere else', async (t) => {
  const fake = await startFakeDispatcharr({
    username: USERNAME,
    password: PASSWORD,
    movies: [movieRow({ id: 1, name: 'Film [EN]', tmdb: '100', imdb: 'tt100', year: 2000 })],
    series: [seriesRow({ id: 2, name: 'Show', tmdb: '200', imdb: 'tt200' }), seriesRow({ id: 3, name: 'Other', tmdb: '300' })],
    seriesInfo: { 2: seriesInfoBody({ episodes: [episodeRow({ id: 21, season: 1, episode: 1 })] }) },
  });
  const addon = await startAddon({ baseUrl: fake.baseUrl });
  t.after(async () => {
    await addon.stop();
    await fake.stop().catch(() => {});
  });
  const needles = forbidden(fake);
  const bodies = [];
  const collect = async (path, init) => {
    const response = await addon.get(path, init);
    bodies.push({ path, status: response.status, text: await response.text() });
    return response;
  };

  // The good path. The heartbeat response really does echo the credentials.
  await addon.app.refresh();
  await addon.app.heartbeat();
  await collect('/manifest.json');
  await collect('/health');

  // Hits are the one place credentials appear. Read here to prove the secret is
  // there, and then to prove it is not logged or stored below.
  const hit = await (await addon.get('/stream/movie/tt100.json')).text();
  assert.ok(hit.includes(encodeURIComponent(PASSWORD)));
  assert.ok(hit.includes(encodeURIComponent(USERNAME)));
  const episode = await (await addon.get('/stream/series/tt200:1:1.json')).text();
  assert.ok(episode.includes(encodeURIComponent(PASSWORD)));

  // Every kind of miss or error response.
  await collect('/stream/movie/tt999.json');
  await collect('/stream/movie/tmdb:999.json');
  await collect('/stream/movie/garbage.json');
  await collect('/nope');
  await collect('/manifest.json', { method: 'POST' });
  await collect(`/nope?username=${encodeURIComponent(USERNAME)}`);

  // Every kind of upstream failure, including one that echoes the request URL
  // with its credentials into the error body.
  for (const failure of [500, 401, 'html', 'echo']) {
    fake.failures.get_vod_streams = failure;
    fake.failures.get_series = failure;
    fake.failures.get_series_info = failure;
    fake.failures.info = failure;
    await addon.app.refresh();
    await addon.app.heartbeat();
    await collect('/stream/series/tmdb:300:1:1.json');
    fake.failures = {};
  }

  // Into and out of the down state, then upstream disappearing altogether, which
  // puts the hostname into the underlying network error.
  fake.authRejected = true;
  for (let i = 0; i < 3; i += 1) await addon.app.heartbeat();
  assert.equal(addon.app.health.state, 'down');
  await collect('/health');
  await collect('/stream/movie/tt100.json');
  fake.authRejected = false;
  await addon.app.heartbeat();
  await fake.stop();
  await addon.app.refresh();
  for (let i = 0; i < 3; i += 1) await addon.app.heartbeat();
  await collect('/health');

  await addon.app.flush();

  assert.ok(addon.logs.length > 0, 'the scenario logged something');
  for (const line of addon.logs) assertClean('log line', line, needles);
  for (const { path, text } of bodies) assertClean(`body of ${path}`, text, needles);
  assertClean('status.json', await addon.readDataText('status.json'), needles);
  assertClean('snapshot.json', await addon.readDataText('snapshot.json'), needles);

  // Prove the sweep actually covered what it claims.
  assert.ok(addon.logs.some((l) => l.includes('refresh failed')));
  assert.ok(addon.logs.some((l) => l.includes('upstream down')));
  assert.ok(addon.logs.some((l) => l.includes('series info fetch failed')));
  assert.ok(bodies.some((b) => b.status === 404));
  assert.ok(bodies.some((b) => b.status === 405));

  // A stream URL's path never appears in a log line in any form.
  for (const line of addon.logs) assert.ok(!line.includes('/movie/') && !line.includes('/series/'), line);
});

test('the manifest and /health are static and hold no credentials', async (t) => {
  const fake = await startFakeDispatcharr({ username: USERNAME, password: PASSWORD });
  const addon = await startAddon({ baseUrl: fake.baseUrl });
  t.after(async () => {
    await addon.stop();
    await fake.stop();
  });
  const needles = forbidden(fake);
  for (const path of ['/manifest.json', '/health']) {
    assertClean(path, await (await addon.get(path)).text(), needles);
  }
});

test('status.json holds no titles', async (t) => {
  const fake = await startFakeDispatcharr({
    username: USERNAME,
    password: PASSWORD,
    movies: [movieRow({ id: 1, name: 'DistinctiveFilmTitle', tmdb: '100' })],
    series: [seriesRow({ id: 2, name: 'DistinctiveShowTitle', tmdb: '200' })],
  });
  const addon = await startAddon({ baseUrl: fake.baseUrl });
  t.after(async () => {
    await addon.stop();
    await fake.stop();
  });
  await addon.app.refresh();
  const status = await addon.readDataText('status.json');
  assert.ok(!status.includes('Distinctive'));
  // The snapshot is where titles belong.
  assert.ok((await addon.readDataText('snapshot.json')).includes('DistinctiveFilmTitle'));
});

test('the redactor covers raw, encoded and differently cased forms', () => {
  const redact = createRedactor(['p@ss w/rd', 'Upstream.Example.org']);
  const cases = [
    'p@ss w/rd',
    'p%40ss%20w%2Frd',
    'p%40ss+w%2Frd',
    'p@ss%20w/rd',
    'P%40SS%20W%2FRD',
    'p%2540ss%2520w%252Frd',
    'upstream.example.org',
    'UPSTREAM.EXAMPLE.ORG',
  ];
  for (const text of cases) {
    const line = `before ${text} after`;
    assert.equal(redact(line), 'before [redacted] after', text);
  }
});

test('redaction ignores empty secrets rather than matching everything', () => {
  assert.equal(createRedactor(['', null, undefined])('text'), 'text');
  assert.equal(createRedactor([])('text'), 'text');
});

test('a logged error is redacted through its whole cause chain', () => {
  const secret = 'hunter2';
  const host = 'upstream.example.org';
  const lines = [];
  const logger = createLogger({ secrets: [secret, host], sink: (level, line) => lines.push(line) });

  const innermost = Object.assign(new Error(`connect ECONNREFUSED ${host}:443`), { code: 'ECONNREFUSED' });
  const middle = new Error(`fetch failed for http://${host}/player_api.php?password=${secret}`, { cause: innermost });
  const aggregate = new AggregateError([new Error(`one ${secret}`), new Error(`two ${host}`)], `all failed ${host}`);
  const outer = new TypeError(`request to ${secret}`, { cause: middle });
  outer.errors = aggregate.errors;

  logger.error(`request for ${host} failed`, outer);
  logger.warn(`plain ${secret}`);
  logger.info('thrown non-error', `string with ${secret}`);

  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.ok(!line.includes(secret), line);
    assert.ok(!line.includes(host), line);
  }
  assert.ok(lines[0].includes('ECONNREFUSED'), 'useful detail survives');
  assert.ok(lines[0].includes('[redacted]'));
});

test('describeError copes with anything thrown', () => {
  assert.equal(describeError('text'), 'text');
  assert.equal(describeError(null), 'null');
  assert.equal(describeError(undefined), 'undefined');
  assert.equal(describeError(42), '42');
  assert.ok(describeError({}).length > 0);
  const circular = new Error('loop');
  circular.cause = circular;
  assert.ok(describeError(circular).includes('loop'));
});
