// Starts the real app against a fake Dispatcharr and captures its log output.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.js';
import { loadConfig, secretsOf } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { startFakeDispatcharr } from './fake-dispatcharr.js';

export const USERNAME = 'vod.user@example.com';
export const PASSWORD = 'pa55-w.rd_x@9';
export const TMDB_KEY = 'tmdb-key-3f9a';
export const TMDB_TOKEN = 'tmdb-token-77bc';

// The address a stream URL should hold for a stream on this fake.
export function directUrl(fake, kind, id, ext) {
  return `${fake.baseUrl}/${kind}/${encodeURIComponent(USERNAME)}/${encodeURIComponent(PASSWORD)}/${id}.${ext}`;
}

// Pass the test context to have the directory removed afterwards.
export async function newDataDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'iptv-vod-test-'));
  t?.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// `tmdbBaseUrl` points the converter at a fake TMDB, which only tests can do: there is
// no environment variable for it, so a real deployment's credential cannot go elsewhere.
export async function startAddon({ baseUrl, env = {}, dataDir, overrides = {}, tmdbBaseUrl }) {
  const directory = dataDir ?? await newDataDir();
  const config = loadConfig({
    XC_BASE_URL: baseUrl,
    XC_USERNAME: USERNAME,
    XC_PASSWORD: PASSWORD,
    PORT: '0',
    DATA_DIR: directory,
    HEARTBEAT_FAILURES: '3',
    ...env,
  });
  Object.assign(config, overrides);
  if (tmdbBaseUrl) config.tmdb.baseUrl = tmdbBaseUrl;
  const logs = [];
  const logger = createLogger({
    secrets: secretsOf(config),
    sink: (level, line) => logs.push(line),
  });
  const app = createApp(config, { logger });
  await app.start({ background: false });
  const base = `http://127.0.0.1:${app.port()}`;
  return {
    app,
    config,
    logs,
    logger,
    base,
    dataDir: directory,
    get: (path, init) => fetch(`${base}${path}`, { redirect: 'manual', ...init }),
    getJson: async (path) => {
      const response = await fetch(`${base}${path}`);
      return { status: response.status, body: await response.json() };
    },
    readData: async (name) => JSON.parse(await readFile(join(directory, name), 'utf8')),
    readDataText: (name) => readFile(join(directory, name), 'utf8'),
    stop: async () => {
      await app.stop();
      if (!dataDir) await rm(directory, { recursive: true, force: true });
    },
  };
}

// The usual setup: a populated fake and a refreshed add-on, torn down with the test.
export async function setup(t, { fake: fakeOptions = {}, env, overrides, refresh = true, tmdbBaseUrl, dataDir } = {}) {
  const fake = await startFakeDispatcharr({ username: USERNAME, password: PASSWORD, ...fakeOptions });
  const addon = await startAddon({ baseUrl: fake.baseUrl, env, overrides, tmdbBaseUrl, dataDir });
  t.after(async () => {
    await addon.stop();
    await fake.stop();
  });
  if (refresh) await addon.app.refresh();
  return { fake, addon };
}

export async function waitFor(condition, { timeoutMs = 3000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}
