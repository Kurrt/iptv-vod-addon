// A stand-in for the TMDB API's GET /3/find/{external_id}. The shape follows
// developer.themoviedb.org/reference/find-by-id: five result arrays, with `id` on each
// item. It records how each request authenticated, so tests can check the credential.

import { createServer } from 'node:http';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const emptyResults = () => ({
  movie_results: [],
  person_results: [],
  tv_results: [],
  tv_episode_results: [],
  tv_season_results: [],
});

export async function startFakeTmdb({ movies = {}, shows = {}, apiKey = null, accessToken = null } = {}) {
  const fake = {
    movies, // imdb id -> tmdb id
    shows, // imdb id -> tmdb id
    requests: [], // { imdbId, source, apiKey, authorization }
    failure: null, // HTTP status, 'html', 'shape' or 'redirect'
    delayMs: 0,
    redirectTo: null,
    count: (imdbId) => fake.requests.filter((r) => imdbId === undefined || r.imdbId === imdbId).length,
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fake');
    const match = /^\/3\/find\/([^/]+)$/.exec(url.pathname);
    fake.requests.push({
      imdbId: match?.[1] ?? null,
      source: url.searchParams.get('external_source'),
      apiKey: url.searchParams.get('api_key'),
      authorization: req.headers.authorization ?? null,
    });
    if (fake.delayMs) await sleep(fake.delayMs);

    if (fake.failure === 'redirect') {
      res.writeHead(302, { Location: fake.redirectTo });
      res.end();
      return;
    }
    if (fake.failure === 'html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>blocked</title>');
      return;
    }
    if (fake.failure === 'shape') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ surprise: true }));
      return;
    }
    if (fake.failure) {
      res.writeHead(fake.failure, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, status_message: 'failed' }));
      return;
    }

    const authorized = (apiKey !== null && url.searchParams.get('api_key') === apiKey)
      || (accessToken !== null && req.headers.authorization === `Bearer ${accessToken}`);
    if (!match || !authorized) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, status_code: 7, status_message: 'Invalid API key' }));
      return;
    }

    const body = emptyResults();
    if (fake.movies[match[1]]) body.movie_results.push({ id: fake.movies[match[1]], media_type: 'movie' });
    if (fake.shows[match[1]]) body.tv_results.push({ id: fake.shows[match[1]], media_type: 'tv' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });

  fake.port = server.address().port;
  fake.baseUrl = `http://127.0.0.1:${fake.port}`;
  fake.stop = async () => {
    const closed = new Promise((resolve) => { server.close(resolve); });
    server.closeAllConnections();
    await closed;
  };
  return fake;
}
