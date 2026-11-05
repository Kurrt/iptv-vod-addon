// Configuration comes from the environment only. Error messages name the
// variable and never echo its value.

import { isIP } from 'node:net';

export class ConfigError extends Error {}

export const RESOLUTION_TAGS = ['2160p', '1440p', '1080p', '720p', '576p', '480p', '360p'];

const REQUIRED = ['XC_BASE_URL', 'XC_USERNAME', 'XC_PASSWORD'];
const TMDB_BASE_URL = 'https://api.themoviedb.org';
// setInterval overflows above this and would fire every millisecond.
const MAX_TIMER_MS = 2 ** 31 - 1;

function value(env, name) {
  const raw = env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}

function number(env, name, fallback, { integer = false, min = 0, max = Infinity } = {}) {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  const valid = Number.isFinite(parsed) && parsed >= min && parsed <= max
    && (!integer || Number.isInteger(parsed));
  if (!valid) {
    throw new ConfigError(`${name} must be a${integer ? 'n integer' : ' number'} between ${min} and ${max}`);
  }
  return parsed;
}

// The address to listen on, or null for all of them. An address, not a name, because
// a name decides at startup what it means: `localhost` can resolve to ::1 alone.
function listenHost(env) {
  const host = value(env, 'HOST');
  if (host === undefined) return null;
  if (isIP(host) === 0) throw new ConfigError('HOST must be an IP address');
  return host;
}

// Comma-separated. Spaces around a tag are not part of it.
function tagList(env, name) {
  return (value(env, name) ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
}

function baseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('XC_BASE_URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('XC_BASE_URL must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError('XC_BASE_URL must be scheme, host, port and optional path only');
  }
  return { url, text: url.href.replace(/\/+$/, '') };
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => value(env, name) === undefined);
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variable: ${missing.join(', ')}`);
  }

  const base = baseUrl(env.XC_BASE_URL);

  const unknownResolutionTag = (value(env, 'UNKNOWN_RESOLUTION_TAG') ?? '1080p').toLowerCase();
  if (!RESOLUTION_TAGS.includes(unknownResolutionTag)) {
    throw new ConfigError(`UNKNOWN_RESOLUTION_TAG must be one of ${RESOLUTION_TAGS.join(', ')}`);
  }

  return {
    xc: {
      baseUrl: base.text,
      username: env.XC_USERNAME,
      password: env.XC_PASSWORD,
      host: base.url.host,
      hostname: base.url.hostname,
    },
    tmdb: {
      baseUrl: TMDB_BASE_URL,
      apiKey: value(env, 'TMDB_API_KEY') ?? null,
      accessToken: value(env, 'TMDB_ACCESS_TOKEN') ?? null,
    },
    host: listenHost(env),
    port: number(env, 'PORT', 7000, { integer: true, max: 65535 }),
    dataDir: value(env, 'DATA_DIR') ?? '/data',
    refreshMs: Math.min(number(env, 'REFRESH_HOURS', 6, { min: 0.0001 }) * 3_600_000, MAX_TIMER_MS),
    unknownResolutionTag,
    extraProviderTags: tagList(env, 'EXTRA_PROVIDER_TAGS'),
    idsBudgetMs: number(env, 'IDS_BUDGET_MS', 2500),
    seriesInfoBudgetMs: number(env, 'SERIES_INFO_BUDGET_MS', 4000),
    heartbeatMs: Math.min(number(env, 'HEARTBEAT_SECONDS', 60, { min: 0.001 }) * 1000, MAX_TIMER_MS),
    heartbeatFailures: number(env, 'HEARTBEAT_FAILURES', 3, { integer: true, min: 1 }),
    // Generous, because upstream calls may travel through a slow route such as a VPN.
    timeouts: { listMs: 300_000, heartbeatMs: 15_000, seriesInfoMs: 30_000, tmdbMs: 15_000 },
    negativeTtlMs: 5 * 60_000,
    refreshRetryMs: 5 * 60_000,
    maxSeriesCache: 2000,
    idMissTtlMs: 24 * 3_600_000,
    // TMDB's terms allow caching for up to 6 months. Old conversions are swept at each
    // refresh, and even the longest refresh interval leaves this short of that.
    idMaxAgeMs: 150 * 24 * 3_600_000,
    idRetryMs: 60_000,
    maxIdCache: 50_000,
    maxIdMisses: 10_000,
    idSaveDelayMs: 5000,
  };
}

// Everything the logger must scrub. Hostname is included so a network error
// such as "getaddrinfo ENOTFOUND <host>" cannot leak where upstream lives.
export function secretsOf(config) {
  const { password, username, baseUrl: url, host, hostname } = config.xc;
  return [password, username, url, host, hostname, config.tmdb.apiKey, config.tmdb.accessToken];
}
