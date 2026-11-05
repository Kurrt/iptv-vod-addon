// IMDb to TMDB id conversion. Clients ask by IMDb id, and an Xtream Codes source often
// has TMDB ids only, so a stream lookup has to convert first. The credential goes to
// the TMDB API and nowhere else, which is why the base URL is not configurable and why
// a redirect is refused rather than followed.

import { normalizeImdb, normalizeTmdb } from './ids.js';
import { failureReason, reasonOf, UpstreamError } from './upstream.js';

const USER_AGENT = 'iptv-vod-addon/2.0';
const FILE_VERSION = 2;

export class TmdbClient {
  #baseUrl;
  #apiKey;
  #accessToken;
  #timeoutMs;
  #stopSignal;

  constructor({ baseUrl, apiKey, accessToken }, timeoutMs, stopSignal) {
    this.#baseUrl = baseUrl;
    this.#apiKey = apiKey;
    this.#accessToken = accessToken;
    this.#timeoutMs = timeoutMs;
    this.#stopSignal = stopSignal;
  }

  // One call answers for both kinds, and an IMDb id only ever names one thing.
  async find(imdbId) {
    const url = new URL(`/3/find/${imdbId}`, this.#baseUrl);
    url.searchParams.set('external_source', 'imdb_id');
    const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
    // The bearer token is preferred when both are set, because it stays out of the URL.
    if (this.#accessToken) headers.Authorization = `Bearer ${this.#accessToken}`;
    else url.searchParams.set('api_key', this.#apiKey);

    let text;
    try {
      const response = await fetch(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(this.#timeoutMs), this.#stopSignal]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new UpstreamError(`http_${response.status}`);
      }
      text = await response.text();
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(failureReason(error));
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new UpstreamError('invalid_json');
    }
    if (!Array.isArray(body?.movie_results) || !Array.isArray(body?.tv_results)) {
      throw new UpstreamError('invalid_shape');
    }
    return {
      movie: normalizeTmdb(body.movie_results[0]?.id),
      tv: normalizeTmdb(body.tv_results[0]?.id),
    };
  }
}

const NO_ID = Object.freeze({ tmdb: null, retry: false });
const TRY_LATER = Object.freeze({ tmdb: null, retry: true });

export class ImdbConverter {
  #find;
  #logger;
  #missTtlMs;
  #maxAgeMs;
  #retryMs;
  #maxEntries;
  #maxMisses;
  #onChange;
  #now;
  #known = new Map(); // tt -> { movie, tv, at }, insertion order is recency
  #misses = new Map(); // tt -> { until, record }, insertion order is age
  #inflight = new Map();
  #lastFailure = null;
  #dirty = false;
  #counts = { conversions: 0, hits: 0, misses: 0, errors: 0 };

  // `find` is null when no credential is set, and everything then answers "no id".
  constructor({ find, logger, missTtlMs, maxAgeMs, retryMs, maxEntries, maxMisses, onChange = () => {}, now = Date.now }) {
    this.#find = find;
    this.#logger = logger;
    this.#missTtlMs = missTtlMs;
    this.#maxAgeMs = maxAgeMs;
    this.#retryMs = retryMs;
    this.#maxEntries = maxEntries;
    this.#maxMisses = maxMisses;
    this.#onChange = onChange;
    this.#now = now;
  }

  get enabled() {
    return this.#find !== null;
  }

  get dirty() {
    return this.#dirty;
  }

  // Resolves to { tmdb, retry } and never rejects. `kind` is 'movie' or 'tv'. A fetch
  // that outlives the caller's budget still fills the cache.
  toTmdb(imdbId, kind) {
    if (!this.enabled) return Promise.resolve(NO_ID);
    const record = this.#cached(imdbId);
    if (record) return Promise.resolve(this.#answer(record, kind));
    return this.#load(imdbId).then((loaded) => this.#answer(loaded, kind));
  }

  #cached(imdbId) {
    const known = this.#known.get(imdbId);
    if (known) {
      this.#remember(imdbId, known);
      return known;
    }
    const miss = this.#misses.get(imdbId);
    if (!miss) return undefined;
    if (this.#now() < miss.until) return miss.record;
    this.#misses.delete(imdbId);
    return undefined;
  }

  // Counted here and not at the fetch, so every lookup it answered counts, once.
  #answer(record, kind) {
    if (record.retry) return TRY_LATER;
    const tmdb = record[kind];
    if (tmdb === null) this.#counts.misses += 1;
    else this.#counts.hits += 1;
    this.#onChange();
    return tmdb === null ? NO_ID : { tmdb, retry: false };
  }

  #load(imdbId) {
    let pending = this.#inflight.get(imdbId);
    if (!pending) {
      pending = this.#fetch(imdbId).finally(() => this.#inflight.delete(imdbId));
      this.#inflight.set(imdbId, pending);
    }
    return pending;
  }

  async #fetch(imdbId) {
    let record;
    try {
      const ids = await this.#find(imdbId);
      this.#counts.conversions += 1;
      this.#lastFailure = null;
      record = { movie: ids.movie, tv: ids.tv, at: this.#now() };
      if (ids.movie !== null || ids.tv !== null) {
        this.#remember(imdbId, record);
        this.#dirty = true;
      } else {
        this.#rememberMiss(imdbId, record, this.#missTtlMs);
      }
    } catch (error) {
      record = { retry: true };
      this.#counts.errors += 1;
      this.#rememberMiss(imdbId, record, this.#retryMs);
      this.#logFailure(reasonOf(error));
    }
    this.#onChange();
    return record;
  }

  // Once per run of the same failure. A reason code only, so never the URL.
  #logFailure(reason) {
    if (reason === 'aborted' || reason === this.#lastFailure) return;
    this.#lastFailure = reason;
    this.#logger.warn(`IMDb id conversion failed: ${reason}`);
  }

  #remember(imdbId, record) {
    this.#known.delete(imdbId);
    this.#known.set(imdbId, record);
    while (this.#known.size > this.#maxEntries) {
      this.#known.delete(this.#known.keys().next().value);
    }
  }

  #rememberMiss(imdbId, record, ttlMs) {
    this.#misses.delete(imdbId);
    this.#misses.set(imdbId, { until: this.#now() + ttlMs, record });
    while (this.#misses.size > this.#maxMisses) {
      this.#misses.delete(this.#misses.keys().next().value);
    }
  }

  // Only conversions that found something are kept: a miss may stop being one.
  document(now = new Date()) {
    return {
      version: FILE_VERSION,
      savedAt: now.toISOString(),
      ids: [...this.#known].map(([imdb, { movie, tv, at }]) => ({ imdb, movie, tv, at })),
    };
  }

  markSaved() {
    this.#dirty = false;
  }

  // Counted from the conversion, not the last use, because the terms limit how long
  // anything from TMDB is kept. A date in the future means a wrong clock or an edited file,
  // so its age can't be known and it goes too. The next lookup of a dropped id simply
  // converts it again.
  dropExpired() {
    const now = this.#now();
    for (const [imdbId, { at }] of this.#known) {
      if (at > now || now - at >= this.#maxAgeMs) {
        this.#known.delete(imdbId);
        this.#dirty = true;
      }
    }
  }

  // A damaged file can only cost entries, so rows are validated one by one. A row with no
  // date cannot be shown to be young enough, so it goes too.
  restore(document) {
    // Anything left out here is still on disk, so the next save has to replace the file.
    if (document !== null) this.#dirty = true;
    if (document?.version !== FILE_VERSION || !Array.isArray(document.ids)) return 0;
    for (const row of document.ids) {
      if (row === null || typeof row !== 'object') continue;
      const imdb = typeof row.imdb === 'string' && row.imdb.startsWith('tt') ? normalizeImdb(row.imdb) : null;
      const movie = normalizeTmdb(row.movie);
      const tv = normalizeTmdb(row.tv);
      if (imdb !== null && (movie !== null || tv !== null) && Number.isFinite(row.at)) {
        this.#remember(imdb, { movie, tv, at: row.at });
      }
    }
    this.dropExpired();
    return this.#known.size;
  }

  stats() {
    return { enabled: this.enabled, ...this.#counts, cached: this.#known.size };
  }
}
