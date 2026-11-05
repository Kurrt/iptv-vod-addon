// A stand-in for a remote Dispatcharr. It follows Dispatcharr's API behaviour
// and contains none of its code.
//
// Row keys match XC_VOD_STREAM_KEYS and XC_SERIES_KEYS in
// apps/output/tests/test_views.py; response shapes follow xc_get_vod_streams,
// xc_get_series, xc_get_series_info, xc_get_info and xc_auth_error_response in
// apps/output/views.py and apps/accounts/xc_auth.py.
//
// This lives outside test/ because `node --test` runs every file under a
// directory named test as a test file.

import { createServer } from 'node:http';

export function movieRow({ id, name, tmdb = '', imdb = '', year = '', adult = 0, ext = 'mkv' }) {
  return {
    num: id,
    name,
    stream_type: 'movie',
    stream_id: id,
    stream_icon: null,
    rating: '0',
    rating_5based: 0,
    added: '1700000000',
    is_adult: adult,
    tmdb_id: tmdb,
    imdb_id: imdb,
    trailer: '',
    plot: '',
    genre: '',
    year,
    director: '',
    cast: '',
    release_date: '',
    category_id: '0',
    category_ids: [],
    container_extension: ext,
    custom_sid: null,
    direct_source: '',
  };
}

// get_series rows have neither `year` nor `is_adult`: the year only survives in
// release_date, which defaults to str(series.year).
export function seriesRow({ id, name, tmdb = '', imdb = '', releaseDate = '' }) {
  return {
    num: id,
    name,
    series_id: id,
    cover: null,
    plot: '',
    cast: '',
    director: '',
    genre: '',
    release_date: releaseDate,
    releaseDate,
    last_modified: '1700000000',
    rating: '0',
    rating_5based: '0',
    backdrop_path: [],
    youtube_trailer: '',
    episode_run_time: '',
    category_id: '0',
    category_ids: [],
    tmdb_id: tmdb,
    imdb_id: imdb,
  };
}

export function episodeRow({ id, season, episode, title = `S${season}E${episode}`, ext = 'mkv' }) {
  return {
    id,
    season,
    episode_num: episode,
    title,
    container_extension: ext,
    added: '1700000000',
    custom_sid: null,
    direct_source: '',
    info: {
      id,
      name: title,
      overview: '',
      crew: '',
      directed_by: '',
      imdb_id: '',
      air_date: '',
      backdrop_path: [],
      movie_image: null,
      rating: 0,
      release_date: '',
      duration_secs: 0,
      duration: '00:00:00',
      video: {},
      audio: {},
      bitrate: 0,
    },
  };
}

// Episodes are grouped by season under integer keys, which JSON makes strings.
export function seriesInfoBody({ name = 'Show', episodes = [] }) {
  const grouped = {};
  for (const row of episodes) (grouped[row.season] ??= []).push(row);
  return {
    seasons: Object.keys(grouped).map((season) => ({ season_number: Number(season), name: `Season ${season}` })),
    info: { name, cover: null, plot: '', cast: '', director: '', genre: '', release_date: '', imdb: '', tmdb: '' },
    episodes: grouped,
  };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function startFakeDispatcharr({
  username,
  password,
  movies = [],
  series = [],
  seriesInfo = {},
  port = 0,
} = {}) {
  const fake = {
    movies,
    series,
    seriesInfo,
    requests: [], // { action, path } for every call received
    userAgents: new Set(),
    authRejected: false,
    // action -> HTTP status, or 'html' for a 200 that is not JSON, or 'echo' for
    // an error page that repeats the request back
    failures: {},
    delays: {}, // action -> milliseconds
    streamHits: [], // { kind, username, password, id, ext }
    rawStreamPaths: [],
    headersSeen: [], // every request's headers, to prove what reached this server
    urlsSeen: [],
    count: (action) => fake.requests.filter((r) => r.action === action).length,
  };

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  // Django matches routes against the decoded path, and <str:...> stops at '/'.
  function serveStream(req, res, url) {
    // Records every credential-bearing path as it arrived, before decoding.
    fake.rawStreamPaths.push(req.url);
    const match = /^\/(movie|series)\/([^/]+)\/([^/]+)\/([^/]+)\.([^/.]+)$/.exec(decodeURIComponent(url.pathname));
    if (!match) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Dispatcharr</title>');
      return;
    }
    const [, kind, user, pass, id, ext] = match;
    if (user !== username || pass !== password) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    if (!url.searchParams.has('session_id')) {
      // apps/proxy/vod_proxy/views.py: _vod_session_path_redirect
      res.writeHead(301, {
        Location: `${url.pathname}?session_id=abc`,
        'Cache-Control': 'private, max-age=21600',
      });
      res.end();
      return;
    }
    fake.streamHits.push({ kind, username: user, password: pass, id, ext, range: req.headers.range ?? null });
    res.writeHead(200, { 'Content-Type': 'video/x-matroska' });
    res.end('fake video bytes');
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fake');
    fake.userAgents.add(req.headers['user-agent']);
    fake.headersSeen.push(req.headers);
    fake.urlsSeen.push(req.url);
    if (url.pathname !== '/player_api.php') {
      fake.requests.push({ action: 'stream', path: url.pathname });
      serveStream(req, res, url);
      return;
    }

    const action = url.searchParams.get('action') ?? 'info';
    fake.requests.push({ action, path: url.pathname, seriesId: url.searchParams.get('series_id') });
    if (fake.delays[action]) await sleep(fake.delays[action]);

    const failure = fake.failures[action];
    if (failure === 'html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><title>login</title>${req.url}`);
      return;
    }
    if (failure === 'echo') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`boom at ${req.headers.host}${req.url}`);
      return;
    }
    if (failure) {
      json(res, failure, { error: 'failed' });
      return;
    }

    if (fake.authRejected || url.searchParams.get('username') !== username || url.searchParams.get('password') !== password) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (action === 'get_vod_streams') json(res, 200, fake.movies);
    else if (action === 'get_series') json(res, 200, fake.series);
    else if (action === 'get_series_info') {
      const body = fake.seriesInfo[url.searchParams.get('series_id')];
      if (body) json(res, 200, body);
      else {
        // Http404 from xc_get_series_info reaches the client as Django's page.
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>Not Found</h1>');
      }
    } else {
      // xc_get_info. It really does echo the credentials and the host.
      json(res, 200, {
        user_info: {
          username: url.searchParams.get('username'),
          password: url.searchParams.get('password'),
          message: 'Dispatcharr XC API',
          auth: 1,
          status: 'Active',
          exp_date: '1800000000',
          active_cons: '0',
          max_connections: '50',
          allowed_output_formats: ['ts', 'mp4', 'm3u8'],
        },
        server_info: {
          url: req.headers.host,
          server_protocol: 'http',
          port: '80',
          timezone: 'UTC',
          timestamp_now: 1700000000,
          time_now: '2023-11-14 22:13:20',
          process: true,
        },
      });
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  await new Promise((resolve) => { server.listen(port, resolve); });

  fake.port = server.address().port;
  // `localhost`, not 127.0.0.1, so that "the upstream hostname never appears" is
  // not confused by the loopback address tests use to reach the add-on itself.
  fake.baseUrl = `http://localhost:${fake.port}`;
  fake.stop = async () => {
    const closed = new Promise((resolve) => { server.close(resolve); });
    server.closeAllConnections();
    await closed;
  };
  return fake;
}
