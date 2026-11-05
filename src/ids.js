// Identifier handling for both directions: validating what Dispatcharr sends
// and parsing what clients ask for. Matching is on these exact strings, nothing
// fuzzier, because offering the wrong film is the worst outcome.

export function toDigits(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

const allZero = (digits) => /^0+$/.test(digits);

export function normalizeTmdb(value) {
  const digits = toDigits(value);
  return digits !== null && !allZero(digits) ? digits : null;
}

export function normalizeImdb(value) {
  if (typeof value === 'string') {
    const match = /^tt(\d+)$/i.exec(value.trim());
    if (match) return allZero(match[1]) ? null : `tt${match[1]}`;
  }
  const digits = toDigits(value);
  return digits !== null && !allZero(digits) ? `tt${digits}` : null;
}

// A bare number in imdb_id that equals tmdb_id is a provider that put the TMDB
// id in both fields. Prefixing it would invent an IMDb id for a different title.
export function rowIds(row) {
  const tmdb = normalizeTmdb(row.tmdb_id);
  let imdb = normalizeImdb(row.imdb_id);
  if (imdb !== null && tmdb !== null && toDigits(row.imdb_id) === tmdb) imdb = null;
  return { tmdb, imdb };
}

const MOVIE_ID = /^(?:(tt\d+)|tmdb:(\d+))$/;
const EPISODE_ID = /^(?:(tt\d+)|tmdb:(\d+)):(\d{1,9}):(\d{1,9})$/;

// `kind` is 'movie', 'episode' or 'invalid'.
export function parseStreamId(id) {
  const movie = MOVIE_ID.exec(id);
  if (movie) {
    return movie[1]
      ? { kind: 'movie', ns: 'tt', key: movie[1] }
      : { kind: 'movie', ns: 'tmdb', key: movie[2] };
  }
  const episode = EPISODE_ID.exec(id);
  if (episode) {
    return {
      kind: 'episode',
      ns: episode[1] ? 'tt' : 'tmdb',
      key: episode[1] ?? episode[2],
      season: Number(episode[3]),
      episode: Number(episode[4]),
    };
  }
  return { kind: 'invalid' };
}
