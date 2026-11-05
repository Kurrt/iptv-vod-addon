// Runs src/server.js for real, as the container does.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { rm } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { movieRow, seriesRow, startFakeDispatcharr } from '../test-support/fake-dispatcharr.js';
import { directUrl, newDataDir, PASSWORD, TMDB_KEY, USERNAME, waitFor } from '../test-support/harness.js';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

function run(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  return { child, output };
}

// The port is not known in advance, so it is read back from the log line.
async function startServer(t, env) {
  const dataDir = await newDataDir();
  const fake = await startFakeDispatcharr({
    username: USERNAME,
    password: PASSWORD,
    movies: [movieRow({ id: 1, name: 'Film [EN]', tmdb: '100', imdb: 'tt100', year: 2000 })],
    series: [seriesRow({ id: 2, name: 'Show', tmdb: '200' })],
  });
  const { child, output } = run({
    XC_BASE_URL: fake.baseUrl,
    XC_USERNAME: USERNAME,
    XC_PASSWORD: PASSWORD,
    PORT: '0',
    DATA_DIR: dataDir,
    ...env,
  });
  t.after(async () => {
    child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    await fake.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  let port;
  await waitFor(() => {
    port = /listening on port (\d+)/.exec(output.stdout)?.[1];
    return port;
  }, { timeoutMs: 10_000 });
  return { fake, child, output, base: `http://127.0.0.1:${port}` };
}

for (const name of ['XC_BASE_URL', 'XC_USERNAME', 'XC_PASSWORD']) {
  test(`exits non-zero naming only ${name} when it is missing`, async () => {
    const env = { XC_BASE_URL: 'http://upstream.example.org', XC_USERNAME: 'theuser', XC_PASSWORD: 'thepass' };
    delete env[name];
    const { child, output } = run(env);
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.equal(output.stderr.trim(), `Missing required environment variable: ${name}`);
    assert.equal(output.stdout, '');
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`serves real traffic, then shuts down cleanly on ${signal}`, async (t) => {
    const { fake, child, output, base } = await startServer(t, { TMDB_API_KEY: TMDB_KEY });

    // The background refresh runs by itself.
    await waitFor(async () => {
      const health = await (await fetch(`${base}/health`)).json();
      return health.movies === 1 && health.series === 1;
    }, { timeoutMs: 10_000 });
    const response = await fetch(`${base}/stream/movie/tt100.json`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).streams[0].url, directUrl(fake, 'movie', 1, 'mkv'));

    // And the startup heartbeat fired by itself too.
    await waitFor(() => fake.count('info') >= 1, { timeoutMs: 10_000 });

    child.kill(signal);
    const [code, killedBy] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(killedBy, null);
    assert.ok(output.stdout.includes(`${signal} received`));
    assert.equal(output.stderr, '');

    for (const text of [output.stdout, output.stderr]) {
      assert.ok(!text.includes(PASSWORD));
      assert.ok(!text.includes(USERNAME));
      assert.ok(!text.includes(TMDB_KEY));
      assert.ok(!text.includes('localhost'));
    }
  });
}

function nonLoopbackAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const { address, family, internal } of addresses ?? []) {
      if (family === 'IPv4' && !internal) return address;
    }
  }
  return null;
}

test('with HOST=127.0.0.1 a stream response cannot be read from any other address', async (t) => {
  const address = nonLoopbackAddress();
  if (address === null) {
    t.skip('this machine has only loopback addresses');
    return;
  }
  const portOf = (base) => new URL(base).port;
  const stream = (host, port) => fetch(`http://${host}:${port}/stream/movie/tmdb:100.json`);

  // Without it the password is there to be read: this is the exposure, and it shows the
  // check below can tell the difference.
  const open = await startServer(t, {});
  await waitFor(async () => (await (await fetch(`${open.base}/health`)).json()).movies === 1, { timeoutMs: 10_000 });
  const exposed = await (await stream(address, portOf(open.base))).text();
  assert.ok(exposed.includes(encodeURIComponent(PASSWORD)));

  const closed = await startServer(t, { HOST: '127.0.0.1' });
  await waitFor(async () => (await (await fetch(`${closed.base}/health`)).json()).movies === 1, { timeoutMs: 10_000 });
  await assert.rejects(stream(address, portOf(closed.base)), (error) => {
    assert.equal(error.cause?.code, 'ECONNREFUSED');
    return true;
  });
  assert.equal((await (await stream('127.0.0.1', portOf(closed.base))).json()).streams.length, 1);
  assert.match(closed.output.stdout, /127\.0\.0\.1 only/);
});

test('an aggregator asking for localhost reaches a socket bound to 127.0.0.1', async (t) => {
  const { base } = await startServer(t, { HOST: '127.0.0.1' });
  const { port } = new URL(base);
  assert.equal((await fetch(`http://localhost:${port}/manifest.json`)).status, 200);

  // Where localhost also resolves to ::1, and first, the client has to fall back to it.
  // Node's default for every connection, which is what fetch uses underneath.
  const lookup = (hostname, options, callback) => {
    const addresses = [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }];
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  };
  const socket = connect({ host: 'localhost', port: Number(port), lookup });
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  assert.equal(socket.remoteAddress, '127.0.0.1');
  socket.destroy();
});

test('with no TMDB credential it warns once, on stderr, and still serves', async (t) => {
  const { child, output, base } = await startServer(t, {});
  await waitFor(async () => (await (await fetch(`${base}/health`)).json()).movies === 1, { timeoutMs: 10_000 });
  assert.equal((await (await fetch(`${base}/stream/movie/tt100.json`)).json()).streams.length, 1);
  assert.deepEqual(await (await fetch(`${base}/stream/movie/tt999.json`)).json(), { streams: [] });
  assert.equal(output.stderr.match(/TMDB_API_KEY/g).length, 1);
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});
