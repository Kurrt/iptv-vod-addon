// The stream lookup contract. Every lookup answers HTTP 200: a non-2xx reads as a
// broken add-on to the callers this is built for, so a miss is an empty list.
//
//   hit                       {streams:[...]}
//   miss, or malformed id     {streams:[]}
//   wrong type for the id     {streams:[]}
//   not known yet             {streams:[...], cacheMaxAge:0}, when a budget ran out, when
//                             an id conversion or an episode list fetch failed and will be
//                             retried, or while upstream is down. The real answer can
//                             still change, and cacheMaxAge stops anything keeping this one.

import { UNAVAILABLE } from './episodes.js';
import { parseStreamId } from './ids.js';
import { episodeStream, movieStream } from './streams.js';

const EMPTY = Object.freeze({ streams: [] });
const NOT_YET = Object.freeze({ streams: [], cacheMaxAge: 0 });

// A bare id only means a film when asked for as one: under any other type that number
// can belong to something else entirely. An episode id only means a show's episode.
const TYPE_OF_ID = { movie: 'movie', episode: 'series' };

// Waits for all promises or the budget, whichever comes first. Unfinished ones
// show as undefined and keep running, so their result still reaches the cache.
async function settleWithin(promises, budgetMs) {
  const results = new Array(promises.length);
  const all = Promise.all(promises.map(async (promise, i) => {
    results[i] = await promise;
  }));
  let timer;
  await Promise.race([all, new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); })]);
  clearTimeout(timer);
  return results;
}

export function createLookup({ catalogs, episodes, imdb, health, config }) {
  // The rows an id names in one catalog. The provider's own IMDb ids come first, and
  // only a miss there costs a conversion. Once it is a TMDB id, it is looked up in the
  // requested catalog alone: TMDB numbers films and shows separately.
  async function findRows(catalogKey, conversionKind, id) {
    if (id.ns === 'tmdb') return { rows: catalogs[catalogKey].find('tmdb', id.key), retry: false };
    const indexed = catalogs[catalogKey].find('tt', id.key);
    if (indexed.length > 0) return { rows: indexed, retry: false };

    const [conversion] = await settleWithin([imdb.toTmdb(id.key, conversionKind)], config.idsBudgetMs);
    if (conversion === undefined || conversion.retry) return { rows: [], retry: true };
    return { rows: conversion.tmdb === null ? [] : catalogs[catalogKey].find('tmdb', conversion.tmdb), retry: false };
  }

  async function movieLookup(id) {
    const { rows, retry } = await findRows('movies', 'movie', id);
    if (retry) return NOT_YET;
    return rows.length === 0 ? EMPTY : { streams: rows.map((entry) => movieStream(entry, config)) };
  }

  async function episodeLookup(id) {
    const { rows: shows, retry } = await findRows('series', 'tv', id);
    if (retry) return NOT_YET;
    if (shows.length === 0) return EMPTY;
    const lists = await settleWithin(
      shows.map((show) => episodes.lookup(show.id, id.season, id.episode)),
      config.seriesInfoBudgetMs,
    );
    const streams = [];
    shows.forEach((show, i) => {
      for (const episode of lists[i] ?? []) {
        streams.push(episodeStream(show, episode, id.season, id.episode, config));
      }
    });
    // includes, because an unfinished one is a hole in the array, which some() skips.
    const unsettled = lists.includes(undefined) || lists.includes(UNAVAILABLE);
    return unsettled ? { streams, cacheMaxAge: 0 } : { streams };
  }

  // Resolves to the response body. `rawId` is null when it could not be URL-decoded.
  return async function lookup(type, rawId) {
    const id = rawId === null ? null : parseStreamId(rawId);
    if (id === null || type !== TYPE_OF_ID[id.kind]) return EMPTY;
    if (health.isDown) return NOT_YET;
    return id.kind === 'movie' ? movieLookup(id) : episodeLookup(id);
  };
}
