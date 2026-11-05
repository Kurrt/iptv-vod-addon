// Wires the parts together and owns the background work: index refresh,
// heartbeat, and the snapshot, status and id conversion files.

import { createServer } from 'node:http';

import { buildEntries, Catalog, restoreSnapshot, snapshotBelongsTo, snapshotDocument } from './catalog.js';
import { EpisodeCache } from './episodes.js';
import { UpstreamHealth } from './health.js';
import { createLookup } from './lookup.js';
import { setExtraProviderTags } from './names.js';
import { Persister } from './persist.js';
import { createHandler } from './routes.js';
import { ImdbConverter, TmdbClient } from './tmdb.js';
import { reasonOf, UpstreamError, XtreamClient } from './upstream.js';

const SNAPSHOT_FILE = 'snapshot.json';
const STATUS_FILE = 'status.json';
const ID_CACHE_FILE = 'imdb-tmdb.json';

export function createApp(config, { logger }) {
  setExtraProviderTags(config.extraProviderTags);
  const stopController = new AbortController();
  const client = new XtreamClient(config, stopController.signal);
  const persister = new Persister(config.dataDir, logger);
  const health = new UpstreamHealth(config.heartbeatFailures);

  // `lookup` and the routes read through this object, so a refresh swaps a
  // whole index in one assignment and a request never sees a partial one.
  const catalogs = { movies: new Catalog(), series: new Catalog() };
  const episodes = new EpisodeCache({
    fetchInfo: (seriesId) => client.seriesInfo(seriesId),
    logger,
    ttlMs: config.refreshMs,
    negativeTtlMs: config.negativeTtlMs,
    maxEntries: config.maxSeriesCache,
  });
  const hasTmdbCredential = Boolean(config.tmdb.apiKey || config.tmdb.accessToken);
  const tmdb = hasTmdbCredential ? new TmdbClient(config.tmdb, config.timeouts.tmdbMs, stopController.signal) : null;
  const imdb = new ImdbConverter({
    find: tmdb && ((imdbId) => tmdb.find(imdbId)),
    logger,
    missTtlMs: config.idMissTtlMs,
    maxAgeMs: config.idMaxAgeMs,
    retryMs: config.idRetryMs,
    maxEntries: config.maxIdCache,
    maxMisses: config.maxIdMisses,
    onChange: () => scheduleConversionSave(),
  });
  const lookup = createLookup({ catalogs, episodes, imdb, health, config });
  const lists = {
    movies: { kind: 'movie', fetchRows: () => client.listMovies() },
    series: { kind: 'series', fetchRows: () => client.listSeries() },
  };
  const allLists = Object.keys(lists);
  const server = createServer(createHandler({ lookup, catalogs, health, logger }));
  // Longer than Node's 5s default, so a client's pooled connections are not closed
  // just as it reuses them.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const startedAt = new Date().toISOString();
  // Drop reasons are per-refresh figures. Until the first refresh after a
  // restart they are unknown, not zero, so they read null.
  const unknownDrops = { upstreamRows: null, adultSkipped: null, invalidSkipped: null, prereleaseSkipped: null };
  const drops = { movies: unknownDrops, series: unknownDrops };
  const lastSuccess = { movies: null, series: null };
  // Each list's latest outcome, and when it started coming back empty.
  const listErrors = { movies: null, series: null };
  const emptySince = { movies: null, series: null };
  const refreshState = { lastAttemptAt: null, lastSuccessAt: null, lastOk: null, lastError: null, lastDurationMs: null };

  let refreshing = null;
  let beating = null;
  let refreshTimer = null;
  let heartbeatTimer = null;
  let conversionSaveTimer = null;
  let stopping = false;

  const statusDocument = () => ({
    version: 1,
    updatedAt: new Date().toISOString(),
    startedAt,
    refresh: refreshState,
    upstream: health,
    movies: { ...catalogs.movies.counts(), ...drops.movies, lastSuccessAt: lastSuccess.movies },
    series: { ...catalogs.series.counts(), ...drops.series, lastSuccessAt: lastSuccess.series },
    imdbConversion: imdb.stats(),
  });

  const writeStatus = () => persister.write(STATUS_FILE, statusDocument());

  async function saveConversions() {
    clearTimeout(conversionSaveTimer);
    conversionSaveTimer = null;
    if (imdb.dirty) {
      imdb.markSaved();
      await persister.write(ID_CACHE_FILE, imdb.document());
    }
    await writeStatus();
  }

  // Lookups can arrive in bursts, so the files are written once for each burst.
  function scheduleConversionSave() {
    if (conversionSaveTimer !== null || stopping) return;
    conversionSaveTimer = setTimeout(() => void saveConversions(), config.idSaveDelayMs);
    conversionSaveTimer.unref();
  }

  function swapIn(key, entries, stats) {
    catalogs[key] = new Catalog(entries, { skipYearConflicts: key === 'movies' });
    drops[key] = stats;
    lastSuccess[key] = new Date().toISOString();
  }

  // Dispatcharr answers [] when VOD is switched off for the user or the M3U account
  // is disabled, which may be brief or may be honest. So an empty list does not
  // replace a populated index until an attempt at least refreshRetryMs later agrees.
  // That costs a few minutes of dead links if it is honest, where believing it at
  // once would cost all VOD for up to REFRESH_HOURS if it is not. It stays an error
  // either way, so the heartbeat keeps retrying this list until it fills again.
  function handleEmptyList(key, entries, stats) {
    const firstStrike = emptySince[key] === null;
    if (firstStrike) emptySince[key] = Date.now();
    const populated = catalogs[key].size > 0;
    const confirmed = !firstStrike && Date.now() - emptySince[key] >= config.refreshRetryMs;
    if (populated && !confirmed) {
      if (firstStrike) logger.warn(`${key} list came back empty, keeping the last good index until a retry agrees`);
      return { error: 'empty_list', changed: false };
    }
    if (populated) logger.warn(`${key} list still empty on retry, clearing the index`);
    else if (firstStrike) logger.warn(`${key} list came back empty`);
    swapIn(key, entries, stats);
    return { error: 'empty_list', changed: populated };
  }

  async function refreshList(key) {
    const { kind, fetchRows } = lists[key];
    try {
      const rows = await fetchRows();
      const { entries, stats } = buildEntries(rows, kind);
      if (rows.length === 0) return handleEmptyList(key, entries, stats);
      // Not one usable id means the response format changed, not that the rows are gone.
      if (stats.invalidSkipped === rows.length) throw new UpstreamError('invalid_shape');
      emptySince[key] = null;
      swapIn(key, entries, stats);
      return { error: null, changed: true };
    } catch (error) {
      const reason = reasonOf(error);
      if (!stopping) logger.warn(`${key} refresh failed, keeping the last good index: ${reason}`);
      return { error: reason, changed: false };
    }
  }

  async function runRefresh(keys) {
    const started = Date.now();
    refreshState.lastAttemptAt = new Date(started).toISOString();
    // One at a time: both are heavy queries on Dispatcharr, and a failure of one
    // list must not stop the other from updating.
    let snapshotStale = false;
    for (const key of keys) {
      const { error, changed } = await refreshList(key);
      listErrors[key] = error;
      if (changed) snapshotStale = true;
    }
    if (stopping) return;

    const error = listErrors.movies ?? listErrors.series;
    refreshState.lastOk = error === null;
    refreshState.lastError = error;
    refreshState.lastDurationMs = Date.now() - started;
    if (error === null) {
      refreshState.lastSuccessAt = new Date().toISOString();
      logger.info(`refresh ok: ${catalogs.movies.size} movies, ${catalogs.series.size} series`);
    }
    if (snapshotStale) {
      await persister.write(SNAPSHOT_FILE, snapshotDocument(catalogs.movies, catalogs.series, config.xc.baseUrl));
    }
    imdb.dropExpired();
    await saveConversions();
  }

  // Single flight: a caller arriving mid-refresh shares the one in progress.
  function refresh(keys = allLists) {
    if (!refreshing) {
      refreshing = runRefresh(keys)
        .catch((error) => logger.error('refresh crashed', error))
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  // A retry in progress may cover only one list, so the scheduled pull waits for it
  // rather than sharing it, or the other list would go a whole cycle without one.
  async function scheduledRefresh() {
    await refreshing;
    if (!stopping) await refresh();
  }

  // Only the lists that need it: the other may be huge, and a list that is honestly
  // empty, such as an account with no shows, is retried indefinitely.
  function retryRefreshIfDue() {
    if (refreshState.lastOk !== false) return;
    const since = Date.now() - Date.parse(refreshState.lastAttemptAt);
    if (since >= config.refreshRetryMs) void refresh(allLists.filter((key) => listErrors[key] !== null));
  }

  async function runHeartbeat() {
    let failure = null;
    try {
      await client.ping();
    } catch (error) {
      failure = reasonOf(error);
    }
    if (stopping) return;

    const wasDown = health.isDown;
    const changed = failure === null ? health.recordSuccess() : health.recordFailure(failure);
    if (changed) {
      if (health.isDown) {
        logger.warn(`upstream down after ${config.heartbeatFailures} failed heartbeats (${failure}), answering all lookups empty`);
      } else {
        logger.info(wasDown ? 'upstream recovered, answering lookups again' : 'upstream reachable');
      }
      await writeStatus();
    }
    // A refresh that failed while upstream was unreachable would otherwise not
    // be attempted again for REFRESH_HOURS.
    if (failure === null) retryRefreshIfDue();
  }

  function heartbeat() {
    if (!beating) {
      beating = runHeartbeat()
        .catch((error) => logger.error('heartbeat crashed', error))
        .finally(() => { beating = null; });
    }
    return beating;
  }

  async function loadSnapshot() {
    const document = await persister.read(SNAPSHOT_FILE);
    if (document !== null && !snapshotBelongsTo(document, config.xc.baseUrl)) {
      logger.warn('ignoring the snapshot: it was written for a different upstream');
      return;
    }
    const restored = restoreSnapshot(document);
    if (restored) {
      catalogs.movies = restored.movies;
      catalogs.series = restored.series;
      logger.info(`loaded snapshot: ${restored.movies.size} movies, ${restored.series.size} series`);
    }
  }

  async function loadConversions() {
    if (!imdb.enabled) {
      logger.warn('neither TMDB_API_KEY nor TMDB_ACCESS_TOKEN is set: IMDb ids can only match a source that supplies them');
      return;
    }
    const restored = imdb.restore(await persister.read(ID_CACHE_FILE));
    if (restored > 0) logger.info(`loaded ${restored} id conversions`);
  }

  function warnAboutCredentials() {
    for (const name of ['username', 'password']) {
      const value = config.xc[name];
      if (value.includes('/') || /^\.+$/.test(value)) {
        logger.warn(`XC_${name.toUpperCase()} cannot appear in a Dispatcharr stream path, playback will fail`);
      }
    }
  }

  // `background: false` is for tests, which drive refresh and heartbeat by hand.
  async function start({ background = true } = {}) {
    warnAboutCredentials();
    await persister.init();
    await loadSnapshot();
    await loadConversions();
    await writeStatus();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port: config.port, host: config.host ?? undefined }, () => {
        server.off('error', reject);
        resolve();
      });
    });
    logger.info(`listening on port ${server.address().port}${config.host ? `, on ${config.host} only` : ''}`);
    if (background) {
      void refresh();
      void heartbeat();
      refreshTimer = setInterval(() => void scheduledRefresh(), config.refreshMs);
      heartbeatTimer = setInterval(() => void heartbeat(), config.heartbeatMs);
      refreshTimer.unref();
      heartbeatTimer.unref();
    }
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(refreshTimer);
    clearInterval(heartbeatTimer);
    stopController.abort();
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await Promise.allSettled([closed, refreshing, beating]);
    await flush();
  }

  async function flush() {
    if (conversionSaveTimer !== null) await saveConversions();
    await persister.flush();
  }

  return {
    start,
    stop,
    refresh,
    scheduledRefresh,
    heartbeat,
    flush,
    catalogs,
    health,
    episodes,
    imdb,
    port: () => server.address().port,
  };
}
