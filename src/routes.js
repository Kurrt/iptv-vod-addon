// HTTP surface. Paths are matched on the raw request target, so an encoded
// traversal simply fails to match. No request URL is ever logged, and no input
// is ever reflected in a response. There are no CORS headers, on purpose: stream
// responses hold credentials, so no web page should be able to read them.

const STREAM_ROUTE = /^\/stream\/([^/]+)\/([^/]+)\.json$/;

export const manifest = Object.freeze({
  id: 'local.iptv-vod-addon',
  version: '2.0.0',
  name: 'IPTV VOD',
  description: 'Movies and episodes from your own Xtream Codes VOD source, matched by IMDb and TMDB id. This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.',
  resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt', 'tmdb:'] }],
  types: ['movie', 'series'],
  catalogs: [],
});

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function createHandler({ lookup, catalogs, health, logger }) {
  async function route(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    const path = req.url.split('?', 1)[0];

    if (path === '/manifest.json') {
      sendJson(res, 200, manifest);
      return;
    }

    if (path === '/health') {
      sendJson(res, 200, {
        status: health.isDown ? 'upstream_down' : 'ok',
        movies: catalogs.movies.size,
        series: catalogs.series.size,
      });
      return;
    }

    const stream = STREAM_ROUTE.exec(path);
    if (stream) {
      sendJson(res, 200, await lookup(decode(stream[1]), decode(stream[2])));
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  return (req, res) => {
    route(req, res).catch((error) => {
      logger.error('request failed', error);
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: 'internal error' });
    });
  };
}
