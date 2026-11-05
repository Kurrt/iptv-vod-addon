// Lazily fetched episode lists, one get_series_info call per series. get_series_info
// can make Dispatcharr contact the IPTV provider, so it is slow and is never
// called during the background refresh.

import { toDigits } from './ids.js';
import { normalizeExtension, resolutionFromName } from './names.js';
import { reasonOf, UpstreamError } from './upstream.js';

const NO_EPISODES = Object.freeze([]);
// Also empty, but because the list could not be fetched, so it is not a real miss. The
// lookup tells them apart by identity, and answers this one so that nothing keeps it.
export const UNAVAILABLE = Object.freeze([]);

// Dispatcharr's shape is { episodes: { "<season>": [ { id, season, episode_num,
// container_extension, title, ... } ] } }. JSON turns the integer season keys
// into strings, and season 0 (specials) is real.
//
// episode_num 0 is never matched. Dispatcharr writes 0 when a provider gave no
// usable number (tasks.py, and `episode_number or 0` in xc_get_series_info), so
// it cannot be told apart from a genuine E00 and could play the wrong episode.
export function parseEpisodes(body) {
  const raw = body?.episodes;
  if (raw === null || typeof raw !== 'object') throw new UpstreamError('invalid_shape');

  const byNumber = new Map();
  const add = (row, seasonKey) => {
    if (row === null || typeof row !== 'object') return;
    const id = toDigits(row.id);
    // The key is only a fallback for a row with no season, not one with a bad season.
    const season = toDigits(row.season ?? seasonKey);
    const number = toDigits(row.episode_num);
    if (id === null || season === null || number === null || Number(number) === 0) return;
    const key = `${Number(season)}:${Number(number)}`;
    const episode = {
      id,
      ext: normalizeExtension(row.container_extension),
      resolution: resolutionFromName(row.title),
    };
    const list = byNumber.get(key);
    if (list) list.push(episode);
    else byNumber.set(key, [episode]);
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (Array.isArray(item)) item.forEach((row) => add(row, null));
      else add(item, null);
    }
  } else {
    for (const [seasonKey, rows] of Object.entries(raw)) {
      if (Array.isArray(rows)) rows.forEach((row) => add(row, seasonKey));
    }
  }
  return byNumber;
}

export class EpisodeCache {
  #fetchInfo;
  #logger;
  #ttlMs;
  #negativeTtlMs;
  #maxEntries;
  #now;
  #entries = new Map(); // insertion order is recency
  #inflight = new Map();

  constructor({ fetchInfo, logger, ttlMs, negativeTtlMs, maxEntries, now = Date.now }) {
    this.#fetchInfo = fetchInfo;
    this.#logger = logger;
    this.#ttlMs = ttlMs;
    this.#negativeTtlMs = negativeTtlMs;
    this.#maxEntries = maxEntries;
    this.#now = now;
  }

  get size() {
    return this.#entries.size;
  }

  // Resolves to the copies of one episode, or an empty array, which is UNAVAILABLE if the
  // latest fetch failed. Never rejects, and a fetch that outlives the caller's budget
  // still fills the cache.
  lookup(seriesId, season, number) {
    const key = `${season}:${number}`;
    const miss = ({ failed }) => (failed ? UNAVAILABLE : NO_EPISODES);
    const entry = this.#entries.get(seriesId);
    if (entry) {
      this.#remember(seriesId, entry);
      const now = this.#now();
      const fresh = now < entry.expiresAt;
      const backingOff = now < entry.retryAfter;
      const hits = entry.episodes.get(key);
      if (hits && (fresh || backingOff)) return Promise.resolve(hits);
      if (backingOff) return Promise.resolve(miss(entry));
    }
    return this.#load(seriesId).then((loaded) => loaded.episodes.get(key) ?? miss(loaded));
  }

  #load(seriesId) {
    let pending = this.#inflight.get(seriesId);
    if (!pending) {
      pending = this.#fetch(seriesId).finally(() => this.#inflight.delete(seriesId));
      this.#inflight.set(seriesId, pending);
    }
    return pending;
  }

  async #fetch(seriesId) {
    let entry;
    try {
      const episodes = parseEpisodes(await this.#fetchInfo(seriesId));
      const now = this.#now();
      // retryAfter is the negative cache for a miss: a season that has not aired
      // yet is asked for again after a few minutes, not after hours.
      entry = { episodes, expiresAt: now + this.#ttlMs, retryAfter: now + this.#negativeTtlMs, failed: false };
    } catch (error) {
      this.#logger.warn(`series info fetch failed for series ${seriesId}: ${reasonOf(error)}`);
      // A failed refresh must not lose a list that was good: keep it, and back off.
      const previous = this.#entries.get(seriesId);
      entry = {
        episodes: previous?.episodes ?? new Map(),
        expiresAt: previous?.expiresAt ?? 0,
        retryAfter: this.#now() + this.#negativeTtlMs,
        failed: true,
      };
    }
    this.#remember(seriesId, entry);
    return entry;
  }

  #remember(seriesId, entry) {
    this.#entries.delete(seriesId);
    this.#entries.set(seriesId, entry);
    while (this.#entries.size > this.#maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
  }
}
