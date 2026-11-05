// The in-memory index for one kind of content, and the snapshot form of it.
// An entry holds only ids, name, year, extension and language.

import { createHash, randomBytes } from 'node:crypto';

import { normalizeImdb, normalizeTmdb, rowIds, toDigits } from './ids.js';
import { isPrereleaseCopy, isTruthyFlag, normalizeExtension, normalizeYear, parseLanguage, parseName, sanitizeTitle } from './names.js';

const ID_FIELD = { movie: 'stream_id', series: 'series_id' };

export class Catalog {
  #yearConflicts = null;

  // `skipYearConflicts` leaves rows out of the id lookups when the name and the row
  // disagree about the year. On a film that can mean the id names another title of the
  // same name, and offering the wrong film is worse than offering nothing.
  constructor(entries = [], { skipYearConflicts = false } = {}) {
    this.entries = entries;
    this.byImdb = new Map();
    this.byTmdb = new Map();
    for (const entry of entries) {
      if (skipYearConflicts && hasYearConflict(entry)) continue;
      if (entry.imdb) push(this.byImdb, entry.imdb, entry);
      if (entry.tmdb) push(this.byTmdb, entry.tmdb, entry);
    }
  }

  find(ns, key) {
    return (ns === 'tt' ? this.byImdb : this.byTmdb).get(key) ?? [];
  }

  get size() {
    return this.entries.length;
  }

  counts() {
    let withTmdb = 0;
    let withImdb = 0;
    let withEither = 0;
    for (const { tmdb, imdb } of this.entries) {
      if (tmdb) withTmdb += 1;
      if (imdb) withImdb += 1;
      if (tmdb || imdb) withEither += 1;
    }
    return { rows: this.entries.length, withTmdb, withImdb, withEither, yearConflicts: this.#countYearConflicts() };
  }

  // Rows whose id can match, where the name and the row disagree about the year. Counted
  // once per index because it means parsing every name, and status.json is written often.
  #countYearConflicts() {
    if (this.#yearConflicts === null) {
      this.#yearConflicts = this.entries.filter(hasYearConflict).length;
    }
    return this.#yearConflicts;
  }
}

function hasYearConflict({ tmdb, imdb, name, year }) {
  return Boolean(tmdb || imdb) && parseName(name, { year }).yearConflict;
}

function push(map, key, entry) {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}

// Turns one upstream list into entries plus the reasons rows were dropped.
// Rows with no usable id stay in, because they cannot match anything but the
// coverage figures in status.json need them in the denominator.
export function buildEntries(rows, kind) {
  const stats = { upstreamRows: rows.length, adultSkipped: 0, invalidSkipped: 0, prereleaseSkipped: 0 };
  const entries = [];
  const seen = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      stats.invalidSkipped += 1;
      continue;
    }
    if (isTruthyFlag(row.is_adult)) {
      stats.adultSkipped += 1;
      continue;
    }
    const id = toDigits(row[ID_FIELD[kind]]);
    if (id === null || seen.has(id)) {
      stats.invalidSkipped += 1;
      continue;
    }
    // Movies only: a tag like TC in a show's name is far more likely to be part of
    // the title, and cam copies are a cinema-release problem.
    if (kind === 'movie' && isPrereleaseCopy(row.name)) {
      stats.prereleaseSkipped += 1;
      continue;
    }
    seen.add(id);
    const { tmdb, imdb } = rowIds(row);
    const entry = {
      id,
      name: sanitizeTitle(row.name),
      // get_series rows carry no year key, only release_date.
      year: normalizeYear(row.year, row.release_date, row.releaseDate),
      lang: parseLanguage(row.name),
      tmdb,
      imdb,
    };
    if (kind === 'movie') entry.ext = normalizeExtension(row.container_extension);
    entries.push(entry);
  }
  return { entries, stats };
}

const upstreamHash = (salt, baseUrl) => createHash('sha256').update(`${salt}${baseUrl}`).digest('hex');

// Stream ids are Dispatcharr database keys, so a snapshot's ids mean nothing on any
// other upstream and could play any film there. This records which upstream wrote
// it. The salted hash keeps the hostname out of the file.
export function upstreamBinding(baseUrl) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: upstreamHash(salt, baseUrl) };
}

export function snapshotBelongsTo(document, baseUrl) {
  const { salt, hash } = document?.upstream ?? {};
  return typeof salt === 'string' && hash === upstreamHash(salt, baseUrl);
}

export function snapshotDocument(movies, series, baseUrl, now = new Date()) {
  return {
    version: 1,
    savedAt: now.toISOString(),
    upstream: upstreamBinding(baseUrl),
    movies: movies.entries,
    series: series.entries,
  };
}

// Snapshot rows go through the same validation as upstream rows, so an old or
// damaged file can only cost entries.
function restoreEntries(rows, kind) {
  if (!Array.isArray(rows)) return [];
  const entries = [];
  const seen = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const id = toDigits(row.id);
    if (id === null || seen.has(id)) continue;
    if (kind === 'movie' && isPrereleaseCopy(row.name)) continue;
    seen.add(id);
    const entry = {
      id,
      name: sanitizeTitle(row.name),
      year: normalizeYear(row.year),
      lang: typeof row.lang === 'string' && /^[A-Z]{2}$/.test(row.lang) ? row.lang : null,
      tmdb: normalizeTmdb(row.tmdb),
      imdb: normalizeImdb(row.imdb),
    };
    if (kind === 'movie') entry.ext = normalizeExtension(row.ext);
    entries.push(entry);
  }
  return entries;
}

export function restoreSnapshot(document) {
  if (document === null || typeof document !== 'object' || document.version !== 1) return null;
  return {
    movies: new Catalog(restoreEntries(document.movies, 'movie'), { skipYearConflicts: true }),
    series: new Catalog(restoreEntries(document.series, 'series')),
  };
}
