// The setup notes a reader follows have to stay true to what the code does.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { manifest } from '../src/routes.js';
import { movieRow, seriesRow, startFakeDispatcharr } from '../test-support/fake-dispatcharr.js';
import { setup, startAddon } from '../test-support/harness.js';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const setupSteps = (readme) => readme.slice(readme.indexOf('## Setup'), readme.indexOf('## Configuration'));

const FILM = movieRow({ id: 1, name: 'Film', tmdb: '100', year: 2000 });
const SHOW = seriesRow({ id: 2, name: 'Show', tmdb: '200', releaseDate: '2010' });

test('the README warns against a public route before it says how to set anything up', async () => {
  const readme = await read('README.md');
  const warning = readme.indexOf('must never have a public route');
  assert.ok(warning !== -1, 'the warning is there');
  assert.ok(warning < readme.indexOf('## Setup'), 'and it comes first');
  assert.match(await read('SECURITY.md'), /must never have a public route/);
});

test('the compose example publishes no port and adds no proxy route', async () => {
  const compose = await read('compose.example.yaml');
  assert.doesNotMatch(compose, /^\s*ports:/m);
  assert.doesNotMatch(compose, /^\s*labels:/m, 'a reverse proxy usually picks up its routes from labels');
});

test('the compose example leaves settings to .env, apart from the two it depends on', async () => {
  // A value under `environment` beats the same one in .env, with no warning.
  const compose = await read('compose.example.yaml');
  const settings = /environment:\n((?:\s+- .*\n)+)/.exec(compose)[1].match(/[A-Z_]+(?==)/g);
  assert.deepEqual(settings, ['PORT', 'DATA_DIR']);
});

test('TMDB is attributed as its terms require, with its logo and the wording from them', async () => {
  const notice = 'This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.';
  const readme = await read('README.md');
  assert.ok(readme.includes(notice), 'the README has it');
  assert.ok(manifest.description.includes(notice), 'and so does what a client shows');
  assert.ok(readme.includes('src="assets/tmdb-logo.svg"'), 'the README shows the logo');
  assert.match(await read('assets/tmdb-logo.svg'), /^<svg/);
});

test('every setting the code reads is in the README table', async () => {
  const source = await read('src/config.js');
  const readme = await read('README.md');
  const names = [
    ...source.matchAll(/(?:env, |value\(env, )'([A-Z_]+)'/g),
    ...source.matchAll(/env\.([A-Z_]+)/g),
  ].map((match) => match[1]);
  assert.ok(names.includes('HOST') && names.includes('XC_BASE_URL'), 'the check found them');
  for (const name of new Set(names)) assert.ok(readme.includes(`| \`${name}\` |`), name);
});

test('the example and the README say players connect to XC_BASE_URL directly', async () => {
  const example = await read('.env.example');
  const comment = example.slice(0, example.indexOf('XC_BASE_URL='));
  assert.match(comment, /every player/);
  assert.match(await read('README.md'), /`XC_BASE_URL` has to work for everyone/);
});

test('the README gives shared-namespace deployments the setting that keeps others out', async () => {
  const readme = await read('README.md');
  assert.match(readme, /In a shared network namespace, set `HOST=127\.0\.0\.1`/);
  assert.match(await read('.env.example'), /# HOST=127\.0\.0\.1/);
  assert.match(await read('compose.example.yaml'), /HOST=127\.0\.0\.1/);
});

test('setup gets the code before anything else, and protects the credentials file', async () => {
  const steps = setupSteps(await read('README.md'));
  assert.ok(steps.indexOf('git clone') !== -1 && steps.indexOf('git clone') < steps.indexOf('cp compose.example.yaml'));
  assert.ok(steps.indexOf('cp .env.example .env') < steps.indexOf('chmod 600 .env'));
});

test('every link to the repository names the same one', async () => {
  const { repository } = JSON.parse(await read('package.json'));
  const name = /github\.com\/([^/]+\/[^/.]+)/.exec(repository.url)[1];
  assert.ok(setupSteps(await read('README.md')).includes(`git clone https://github.com/${name}.git`));
  assert.ok((await read('SECURITY.md')).includes(`https://github.com/${name}/security/advisories/new`));
});

test('the aggregator snippet attaches a service to the network, and does not only declare it', async () => {
  // Declaring it at the top level alone leaves the service off it, with no error.
  assert.match(setupSteps(await read('README.md')), /services:\n\s+\S+:\n\s+networks:\n\s+- default\n\s+- iptv-vod\n/);
});

test('a healthy start reads the way the setup check says', async (t) => {
  const { addon } = await setup(t, { fake: { movies: [FILM], series: [SHOW] } });
  await addon.app.heartbeat();
  await addon.app.flush();
  const status = await addon.readData('status.json');
  assert.equal(status.refresh.lastOk, true);
  assert.equal(status.upstream.state, 'up');
  assert.ok(status.movies.withEither > 0);
});

test('a wrong password reads the way the setup check says: /health is ok, status.json is not', async (t) => {
  const { addon } = await setup(t, { fake: { movies: [FILM], series: [SHOW], password: 'not-the-one-sent' } });
  assert.deepEqual((await addon.getJson('/health')).body, { status: 'ok', movies: 0, series: 0 });
  const status = await addon.readData('status.json');
  assert.equal(status.refresh.lastOk, false);
  assert.equal(status.refresh.lastError, 'http_401');
});

test('an address that cannot be reached reads the way the setup check says', async (t) => {
  // A port that was free a moment ago, so the connection is refused.
  const gone = await startFakeDispatcharr();
  await gone.stop();
  const addon = await startAddon({ baseUrl: gone.baseUrl });
  t.after(() => addon.stop());
  await addon.app.refresh();
  assert.equal((await addon.readData('status.json')).refresh.lastError, 'network_ECONNREFUSED');
});

test('rows with no IMDb or TMDB ids are a successful refresh, as the README says', async (t) => {
  const { addon } = await setup(t, {
    fake: { movies: [movieRow({ id: 1, name: 'Film' })], series: [seriesRow({ id: 2, name: 'Show' })] },
  });
  const status = await addon.readData('status.json');
  assert.equal(status.refresh.lastOk, true);
  assert.equal(status.refresh.lastError, null);
  assert.equal(status.movies.rows, 1);
  assert.equal(status.movies.withEither, 0);
});

test('the aggregator timeout the README asks for covers the longest a lookup can take', async () => {
  const { idsBudgetMs, seriesInfoBudgetMs } = loadConfig({ XC_BASE_URL: 'http://up', XC_USERNAME: 'u', XC_PASSWORD: 'p' });
  const worst = idsBudgetMs + seriesInfoBudgetMs;
  const readme = await read('README.md');
  assert.ok(readme.includes(`That is ${worst / 1000} seconds by default`), 'the total is stated');
  const asked = Number(/to at least (\d+) ms/.exec(readme)?.[1]);
  assert.ok(asked > worst, `${asked} covers ${worst}`);
});
