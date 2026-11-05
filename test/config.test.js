import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigError, loadConfig, secretsOf } from '../src/config.js';

const REQUIRED = {
  XC_BASE_URL: 'https://upstream.example.org/',
  XC_USERNAME: 'someuser',
  XC_PASSWORD: 'somepass',
};

test('defaults match the documented configuration', () => {
  const config = loadConfig(REQUIRED);
  assert.equal(config.port, 7000);
  assert.equal(config.dataDir, '/data');
  assert.equal(config.refreshMs, 6 * 3_600_000);
  assert.equal(config.unknownResolutionTag, '1080p');
  assert.equal(config.idsBudgetMs, 2500);
  assert.equal(config.seriesInfoBudgetMs, 4000);
  assert.equal(config.heartbeatMs, 60_000);
  assert.equal(config.heartbeatFailures, 3);
  assert.equal(config.xc.baseUrl, 'https://upstream.example.org');
  assert.equal(config.idMissTtlMs, 24 * 3_600_000);
});

test('upstream timeouts tolerate a slow route', () => {
  const { timeouts } = loadConfig(REQUIRED);
  assert.equal(timeouts.listMs, 300_000);
  assert.equal(timeouts.heartbeatMs, 15_000);
  assert.equal(timeouts.seriesInfoMs, 30_000);
});

test('HOST defaults to every address, takes an IP, and refuses a name without echoing it', () => {
  assert.equal(loadConfig(REQUIRED).host, null);
  assert.equal(loadConfig({ ...REQUIRED, HOST: '' }).host, null);
  assert.equal(loadConfig({ ...REQUIRED, HOST: '127.0.0.1' }).host, '127.0.0.1');
  assert.equal(loadConfig({ ...REQUIRED, HOST: '::1' }).host, '::1');
  for (const bad of ['localhost', 'secret-name.example.org', '127.0.0.1:7000', '300.1.1.1']) {
    assert.throws(() => loadConfig({ ...REQUIRED, HOST: bad }), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.message.includes('HOST'));
      assert.ok(!error.message.includes(bad));
      return true;
    }, bad);
  }
});

test('budgets are configurable', () => {
  const config = loadConfig({ ...REQUIRED, IDS_BUDGET_MS: '100', SERIES_INFO_BUDGET_MS: '200' });
  assert.equal(config.idsBudgetMs, 100);
  assert.equal(config.seriesInfoBudgetMs, 200);
  assert.throws(() => loadConfig({ ...REQUIRED, IDS_BUDGET_MS: 'soon' }), /IDS_BUDGET_MS/);
});

test('EXTRA_PROVIDER_TAGS is a comma-separated list, empty unless set', () => {
  assert.deepEqual(loadConfig(REQUIRED).extraProviderTags, []);
  assert.deepEqual(loadConfig({ ...REQUIRED, EXTRA_PROVIDER_TAGS: '' }).extraProviderTags, []);
  assert.deepEqual(loadConfig({ ...REQUIRED, EXTRA_PROVIDER_TAGS: ' ABC, X+ ,,' }).extraProviderTags, ['ABC', 'X+']);
});

test('TMDB credentials are optional, the API address is fixed, and an empty one counts as unset', () => {
  assert.deepEqual(loadConfig(REQUIRED).tmdb, { baseUrl: 'https://api.themoviedb.org', apiKey: null, accessToken: null });
  assert.equal(loadConfig({ ...REQUIRED, TMDB_API_KEY: 'k' }).tmdb.apiKey, 'k');
  assert.equal(loadConfig({ ...REQUIRED, TMDB_ACCESS_TOKEN: 't' }).tmdb.accessToken, 't');
  assert.equal(loadConfig({ ...REQUIRED, TMDB_API_KEY: '' }).tmdb.apiKey, null);
  assert.equal(loadConfig({ ...REQUIRED, TMDB_BASE_URL: 'http://evil.example.org' }).tmdb.baseUrl, 'https://api.themoviedb.org');
});

test('everything secret is on the list the logger scrubs', () => {
  const secrets = secretsOf(loadConfig({ ...REQUIRED, TMDB_API_KEY: 'the-key', TMDB_ACCESS_TOKEN: 'the-token' }));
  for (const value of ['somepass', 'someuser', 'upstream.example.org', 'the-key', 'the-token']) {
    assert.ok(secrets.includes(value), value);
  }
});

for (const name of Object.keys(REQUIRED)) {
  test(`missing ${name} names only that variable`, () => {
    const env = { ...REQUIRED };
    delete env[name];
    assert.throws(() => loadConfig(env), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.message.includes(name));
      for (const other of Object.keys(REQUIRED).filter((n) => n !== name)) {
        assert.ok(!error.message.includes(other));
      }
      for (const secret of Object.values(REQUIRED)) assert.ok(!error.message.includes(secret));
      return true;
    });
  });
}

test('an empty required variable counts as missing', () => {
  assert.throws(() => loadConfig({ ...REQUIRED, XC_PASSWORD: '' }), /XC_PASSWORD/);
});

test('invalid settings fail without echoing the value', () => {
  assert.throws(() => loadConfig({ ...REQUIRED, XC_BASE_URL: 'not a url secretvalue' }), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.ok(!error.message.includes('secretvalue'));
    return true;
  });
  assert.throws(() => loadConfig({ ...REQUIRED, XC_BASE_URL: 'ftp://upstream.example.org' }), ConfigError);
  assert.throws(() => loadConfig({ ...REQUIRED, XC_BASE_URL: 'http://u:p@upstream.example.org' }), ConfigError);
  assert.throws(() => loadConfig({ ...REQUIRED, PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ ...REQUIRED, HEARTBEAT_FAILURES: '0' }), /HEARTBEAT_FAILURES/);
  assert.throws(() => loadConfig({ ...REQUIRED, UNKNOWN_RESOLUTION_TAG: '4K' }), /UNKNOWN_RESOLUTION_TAG/);
});

test('huge intervals are clamped so setInterval cannot overflow', () => {
  assert.equal(loadConfig({ ...REQUIRED, REFRESH_HOURS: '100000' }).refreshMs, 2 ** 31 - 1);
});
