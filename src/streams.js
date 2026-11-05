// Stremio stream objects. Everything a filename parser needs is in
// behaviorHints.filename, which is also the description, so no size can be misread
// from other text there. A constant `name` means no title can be mistaken for a
// service. Deliberately absent, because nothing here knows them: videoSize, duration,
// publishDate. infoHash and sources too: these are plain URLs.

import { parseName, resolutionFromName } from './names.js';

const STREAM_NAME = 'IPTV VOD';
// Filename parsers keep the extension in the text they test for quality tags, and TS
// is the Telesync tag, so a transport stream's extension is left off its filename.
// The URL keeps it. .m2ts is no way round this: release-name filters often exclude it.
const TRANSPORT_STREAM = new Set(['ts', 'm2ts', 'mts']);

// Dispatcharr's routes use Django's <str:...>, matched against the decoded path,
// so each credential is percent-encoded as one segment and decoded by Dispatcharr.
// Dispatcharr only allows [A-Za-z0-9._@-] in these values, so in practice only
// '@' is affected. A '/' could never route, encoded or not (app.js warns about it).
export function streamUrl(xc, kind, id, ext) {
  const user = encodeURIComponent(xc.username);
  const pass = encodeURIComponent(xc.password);
  return `${xc.baseUrl}/${kind}/${user}/${pass}/${id}.${ext}`;
}

// Year before SxxExx, because release-name parsers look for the season after it.
export function buildFilename({ title, year, tags, languages }, resolution, episodeTag, ext) {
  const parts = [title];
  if (year !== null) parts.push(`(${year})`);
  if (episodeTag !== null) parts.push(episodeTag);
  parts.push(resolution, ...tags, ...languages);
  return `${parts.join(' ')}${TRANSPORT_STREAM.has(ext) ? '' : `.${ext}`}`;
}

function buildStream({ url, filename, ext, bingeGroup }) {
  return {
    name: STREAM_NAME,
    description: filename,
    url,
    behaviorHints: {
      filename,
      indexer: STREAM_NAME,
      // Browsers only play mp4 directly, and an https page cannot load http video.
      notWebReady: !(url.startsWith('https:') && ext === 'mp4'),
      // VOD plays at once: there is no download or debrid step to wait for.
      cached: true,
      bingeGroup,
    },
  };
}

const pad = (n) => String(n).padStart(2, '0');

const parseEntry = (entry, series) => parseName(entry.name, { year: entry.year, language: entry.lang, series });

export function movieStream(entry, config) {
  const parsed = parseEntry(entry, false);
  const resolution = parsed.resolution ?? config.unknownResolutionTag;
  return buildStream({
    url: streamUrl(config.xc, 'movie', entry.id, entry.ext),
    filename: buildFilename(parsed, resolution, null, entry.ext),
    ext: entry.ext,
    bingeGroup: `iptv-vod-movie-${entry.id}`,
  });
}

// The binge group names the show's row, not the episode: it has to stay the same
// across episodes for a player to carry on with the same copy of the show.
export function episodeStream(series, episode, season, number, config) {
  const parsed = parseEntry(series, true);
  const resolution = lowest(parsed.resolution, episode.resolution) ?? config.unknownResolutionTag;
  return buildStream({
    url: streamUrl(config.xc, 'series', episode.id, episode.ext),
    filename: buildFilename(parsed, resolution, `S${pad(season)}E${pad(number)}`, episode.ext),
    ext: episode.ext,
    bingeGroup: `iptv-vod-series-${series.id}`,
  });
}

function lowest(a, b) {
  if (a === null || b === null) return a ?? b;
  return resolutionFromName(`${a} ${b}`);
}
