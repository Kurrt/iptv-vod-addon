# iptv-vod-addon

A small, self-hosted [Stremio](https://github.com/Stremio/stremio-addon-sdk) stream add-on. It offers movies and TV episodes from your own [Dispatcharr](https://github.com/Dispatcharr/Dispatcharr) or other Xtream Codes source, matched by IMDb or TMDB id. It is one container with no runtime dependencies.

> **This add-on must never have a public route.** Its stream responses contain your Xtream Codes username and password, in the URL of every stream, and it has no login. Do not publish its port or put it behind a reverse proxy. Run it on a private network where only one trusted client can reach it. See [Security model](#security-model).

That client is usually an aggregator, such as [AIOStreams](https://github.com/Viren070/AIOStreams): another add-on that collects streams from several sources, sorts and filters them, and hands them to your player. It also works added directly to a server-side client that reads Stremio add-ons, such as Remux, when that client runs on the same private network as this add-on. If you have neither an aggregator nor such a client, you'll need one first, because this can't safely be added straight to a player over a network.

## What it does

**IDs only.** A title is offered only when its IMDb or TMDB id matches exactly. Episodes also need an exact season and episode number. There is no fuzzy matching and no matching on names, because offering the wrong film is the worst thing this add-on could do. Titles with no usable id are simply never offered, and `status.json` shows how many that is.

**Direct URLs.** A stream's URL points straight at the source, so the bytes do not pass through this add-on. See [Security model](#security-model) for what that means for the credentials.

**No pre-release movie copies.** Movies whose names carry a CAM, TS, TC or SCR tag (or variants such as HDCAM or Telesync) are dropped. This only works on explicit tags: a mislabelled copy can get through, and many providers' names carry no quality tag at all. Rows the source flags as adult are dropped too.

## What it does not do

- **It provides no content and no credentials.** You bring your own source, and you are responsible for having the rights to what you access.
- It has no catalogs or metadata. It only answers stream requests for titles a client already knows.
- It does not proxy, transcode or check streams. It can't tell you whether a stream plays, or what quality it really is.
- It has no login and no TLS, so it can't safely be added straight to a player over a network.
- It can't match a source whose lists have no ids. It reads `tmdb_id` and `imdb_id` from each row of `get_vod_streams` and `get_series`. Some Xtream Codes servers may leave those out, and then nothing is offered. `withEither` in `status.json` shows your coverage.
- It was written against Dispatcharr, and the tests use a fake that follows Dispatcharr's API behaviour. Other Xtream Codes servers share the API, but there is no promise they behave the same way.

## TMDB

<img src="assets/tmdb-logo.svg" alt="TMDB" height="12">

This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.

TMDB is only used to turn the IMDb ids clients ask with into TMDB ids. No key is included, so use your own, from the API section of your TMDB account settings. Your use of it falls under TMDB's [API terms of use](https://www.themoviedb.org/api-terms-of-use), which limit free use to non-commercial projects. The TMDB logo belongs to TMDB and is not covered by this project's licence.

## Setup

You need Docker with Compose, and an Xtream Codes source. For IMDb lookups you also need a TMDB key.

1. Get the code:
   ```bash
   git clone https://github.com/Kurrt/iptv-vod-addon.git
   cd iptv-vod-addon
   ```
2. Copy the examples, and make `.env` readable only by you, because it will hold your credentials:
   ```bash
   cp compose.example.yaml compose.yaml
   cp .env.example .env
   chmod 600 .env
   ```
   In `.env`, fill in `XC_BASE_URL`, `XC_USERNAME` and `XC_PASSWORD`, and one TMDB credential. On Dispatcharr the password is the user's XC password, not their login password.
3. Create the data directory, because Docker would otherwise create it owned by root:
   ```bash
   mkdir -p data
   ```
   The container runs as user and group 1000, so if your own ids differ, set `PUID` and `PGID` in `.env` to the output of `id -u` and `id -g`. If you're root, don't do that, because the container would then run as root too. Run `chown 1000:1000 data` instead and leave `PUID` and `PGID` alone.
4. Start it, then check it. The `sleep` is there because `up -d` returns before the add-on is listening.
   ```bash
   docker compose up -d --build
   sleep 5
   docker exec iptv-vod wget -qO- http://127.0.0.1:7000/health
   cat data/status.json
   ```
   A good result has `refresh.lastOk` true, `upstream.state` up, and `movies.withEither` above 0. If `refresh.lastOk` is still null, the first pull has not finished. A big list can take minutes, and a wrong address can take a while to fail, so run the `cat` again later.

   Go by `status.json`, because `/health` can say `ok` with 0 rows. In `refresh.lastError`, `http_401` means the username or password is wrong, and `network` or a reason starting `network_`, such as `network_ENOTFOUND` or `network_EAI_AGAIN`, means `XC_BASE_URL` is wrong or can't be reached.
5. Put your aggregator on the `iptv-vod` network, and add `http://iptv-vod:7000/manifest.json` to it as a custom Stremio add-on. Start this add-on first, because it creates the network. An aggregator in another compose project joins like this, where `default` keeps its other connections:
   ```yaml
   services:
     my-aggregator:
       networks:
         - default
         - iptv-vod

   networks:
     iptv-vod:
       external: true
   ```
   If the service already has a `networks` list, add `iptv-vod` to that list instead.

**`XC_BASE_URL` has to work for everyone.** The add-on uses it for its own requests, and it also becomes the address in every stream URL, which players connect to directly. A name only Docker can resolve will not work for them.

**Give the aggregator enough time.** The first lookup of an episode by IMDb id can take up to `IDS_BUDGET_MS` plus `SERIES_INFO_BUDGET_MS`, because they are spent one after the other. That is 6.5 seconds by default, so set the aggregator's timeout for this add-on to at least 7000 ms, or lower the budgets, or it will report a timeout instead of an empty answer.

To update:

```bash
git pull
docker compose up -d --build
```

## Configuration

Set these in `.env`.

| Variable | Default | |
| --- | --- | --- |
| `XC_BASE_URL` | required | Source base URL, reachable by this add-on and by every player |
| `XC_USERNAME` | required | Source username |
| `XC_PASSWORD` | required | Source XC password |
| `TMDB_API_KEY` | none | TMDB v3 API key, sent as a query parameter |
| `TMDB_ACCESS_TOKEN` | none | TMDB v4 read access token, sent as a bearer header. Used in preference to the key, because it stays out of the URL |
| `HOST` | every address | The IP address to listen on. Set `127.0.0.1` when sharing a network namespace with the aggregator. See [Security model](#security-model) |
| `PORT` | `7000` | Fixed at 7000 in the compose example |
| `DATA_DIR` | `/data` | Where the snapshot, status and id conversion files go. Fixed at `/data` in the compose example |
| `REFRESH_HOURS` | `6` | Catalog refresh interval, and how long an episode list is cached |
| `UNKNOWN_RESOLUTION_TAG` | `1080p` | One of `2160p`, `1440p`, `1080p`, `720p`, `576p`, `480p`, `360p`. See [Labels](#labels) |
| `EXTRA_PROVIDER_TAGS` | none | Comma-separated tags to strip from the front of names, as well as the built-in ones. Case-sensitive. See [Labels](#labels) |
| `IDS_BUDGET_MS` | `2500` | How long a lookup waits for an IMDb id conversion |
| `SERIES_INFO_BUDGET_MS` | `4000` | How long an episode lookup waits for upstream |
| `HEARTBEAT_SECONDS` | `60` | How often it checks the source is up |
| `HEARTBEAT_FAILURES` | `3` | Consecutive failures before going down |

Upstream timeouts are fixed and generous, because these calls may travel through a VPN: 300 seconds for a list, 30 for series info, 15 for a heartbeat and 15 for a TMDB call.

## How it answers

`GET /stream/{type}/{id}.json`, with `id` one of `tt123`, `tt123:S:E`, `tmdb:123` or `tmdb:123:S:E`, percent-encoded or not. Every lookup answers HTTP 200.

| Lookup | Answer |
| --- | --- |
| Hit | `{streams:[...]}` |
| Miss, or a malformed id | `{streams:[]}` |
| A bare `tt123` or `tmdb:123` under any type but `movie` | `{streams:[]}`, because it names no episode, and TMDB numbers films and shows separately, so it could be an unrelated film |
| `tt123:S:E` or `tmdb:123:S:E` under any type but `series` | `{streams:[]}`, because it names no film |
| A budget ran out with nothing found | `{streams:[],cacheMaxAge:0}`. The work continues, so the next lookup is instant |
| A budget ran out with only some copies in | `{streams:[...],cacheMaxAge:0}` |
| An id conversion failed | `{streams:[],cacheMaxAge:0}`, and it is tried again after a minute |
| An episode list could not be fetched | `{streams:[...],cacheMaxAge:0}` with any copies that are known, and it is tried again after 5 minutes |
| Upstream down | `{streams:[],cacheMaxAge:0}` for every lookup above with a valid id and type, so other sources take over and nothing keeps the answer |

`cacheMaxAge:0` marks every answer that could change as soon as something recovers. Anything without it is a real answer.

Movie lookups by TMDB id are answered from memory. Episode lookups fetch `get_series_info` once per series, because it can make the source contact the IPTV provider. The catalog comes from `DATA_DIR/snapshot.json` at startup, so restarts serve immediately, and is pulled again at startup and every `REFRESH_HOURS`.

A failed pull keeps the last good index. That includes a list where not one row has a usable stream or series id, which reports `invalid_shape`. A list with no IMDb or TMDB ids is a successful refresh, and shows as `withEither` 0. The heartbeat retries any failed list every 5 minutes, without re-pulling the other one.

An empty list reports `empty_list`, because Dispatcharr returns one while VOD is off for the user or the M3U account is disabled. It replaces a populated index only if an attempt at least 5 minutes later is also empty, so a brief toggle costs nothing and a real shutdown leaves dead links for 5 to 10 minutes. It stays `lastOk: false` and retried while empty, so recovery takes about 5 minutes rather than `REFRESH_HOURS`. If you really have no shows or no films, `empty_list` is permanent and harmless.

**The snapshot belongs to one upstream.** Stream ids are the source's database keys, so the same id can be a different film elsewhere. The snapshot holds a salted hash of `XC_BASE_URL` and is ignored if that changes. A database rebuilt under the same URL cannot be detected, so after rebuilding or restoring it, delete `snapshot.json` and restart.

The heartbeat calls `player_api.php` with no action, which on Dispatcharr authenticates and reads only its own database and Redis. It never contacts the provider. Upstream goes down after `HEARTBEAT_FAILURES` consecutive failures, including rejected credentials, and comes back after one success.

### IMDb ids

Clients ask by IMDb id, and an Xtream Codes source often has TMDB ids only. So a `tt` lookup goes:

1. The source's own IMDb ids, if it has any. A hit costs nothing further.
2. The TMDB API's `/3/find/{tt}?external_source=imdb_id`, reading `movie_results` for a movie and `tv_results` for an episode. Calls are shared per id, so simultaneous lookups make one.
3. The row with that TMDB id, in the requested kind's catalog only.

Conversions that find something are kept in `DATA_DIR/imdb-tmdb.json`, written atomically and restored at startup, up to 50,000 ids, dropping the least recently used. Each one is dropped 150 days after it was made and converted again when next asked for, because TMDB's terms do not allow caching for longer than 6 months. One dated in the future is dropped too, because its age can't be known. One that finds nothing is remembered in memory for 24 hours. A failed call (network, 401, 429, 5xx, or a body of the wrong shape) is not a miss: the id is retried after a minute, and the reason is logged once per run of the same failure.

With no TMDB credential, `tt` lookups use only the source's own ids, and a warning is logged once at startup.

## Labels

Everything a filename parser needs goes in `behaviorHints.filename`, which `description` repeats. `name` is always `IPTV VOD`, so no title can be mistaken for a service.

```
Title (Year) 1080p [quality] [codec] [language].ext
Title (Year) S01E02 1080p [quality] [codec] [language].ext
```

Some examples:

| Provider's name | Filename |
| --- | --- |
| `4K-NF - The Irishman (2019)` | `The Irishman (2019) 2160p.mkv` |
| `09 EN - The Matrix` | `The Matrix 1080p ENG.mp4` |
| `NF - Roma (MX)` | `Roma 1080p.mkv` |
| `EN - Alien - 1979`, a `.ts` | `Alien (1979) 1080p ENG` |
| `EN - Amelie (2001) AUDREY TAUTOU (FRENCH ENG-SUB)` | `Amelie (2001) 1080p FRENCH ENG-SUB.mkv` |
| `AMZ - Arrival.2016.2016.1080p.AMZN.WEB-DL.AAC2.0.H.264-NOGRP` | `Arrival (2016) 1080p WEB-DL H.264.mkv` |
| `HBO - Dracula 2000 (2000)` | `Dracula 2000 (2000) 1080p.mkv` |
| `The Wire-eng`, an episode of a row from 2002 | `The Wire (2002) S01E02 1080p ENG.mkv` |

- **Provider prefixes** are stripped from a closed, case-sensitive list in `src/names.js`, because real titles have the same shape: `Heat - 1995`, `SAS - Rogue Heroes`. The list holds a few language codes and common streaming service names. A tag that is not listed stays in the title, which only looks untidy, and the id still matches. Add your source's tags with `EXTRA_PROVIDER_TAGS`, for example `EXTRA_PROVIDER_TAGS=ABC,X+`, then run `docker compose up -d`.
- **Year** is the row's, unless the name states one that disagrees. A row year that is one of the title's words came from the title, as `1917` does in `EN - 1917 (2019)`, so the name's year is used. More than a year apart otherwise, a film prints the name's year, so a year filter can see the conflict, and the row is counted in `yearConflicts`. Such a film is not offered, because the id may name another title of the same name. A show keeps the row's year and is still offered, because its name may state a later season or a revival, and it is counted unless a range in the name covers the row. The row's year comes from the provider, not from TMDB, so neither is authoritative.
- **Resolution** comes from the raw name, prefix included, otherwise `UNKNOWN_RESOLUTION_TAG`. **This is a guess for most rows.** Few providers' names state a resolution, so a 4K copy with no marker reads as the fallback.
- **Quality** is only what the name states. It is never invented, so most rows have none, and neither size nor bitrate is ever sent.
- **Language** is any bracketed language words, plus a `[XX]` suffix from Dispatcharr, which is the row's language unless it is `[HD]`, `[SD]`, `[TV]` or `[CC]`. A bracket closing on an uppercase `SUB`, `SUBS` or `ONLY` counts whatever else it says, typos included, and may be left unclosed at the end of the name. With none of those, an `EN` prefix, a `-eng` or `_eng` suffix or a `[EN]` suffix gives `ENG`. Nothing is filtered on language here.
- **A `.ts` extension is left off the filename**, and only there: the URL keeps it. Filename parsers keep the extension in the text they search for quality tags, and TS is the Telesync tag, so `.ts` would mark a good copy as a cam.

`bingeGroup` is per copy: the film's row, or the show's row, so it stays the same across a show's episodes. `cached: true` says VOD plays at once. `notWebReady` is false only for an https mp4.

## status.json

Written atomically to `DATA_DIR` after each refresh and each heartbeat state change, and shortly after id conversions. It holds no credentials, hostnames, ids or titles.

| Field | |
| --- | --- |
| `updatedAt`, `startedAt` | Timestamps |
| `refresh.lastAttemptAt`, `lastDurationMs` | The last attempt, which after a failure may cover only the failed list |
| `refresh.lastSuccessAt` | When both lists were last good |
| `refresh.lastOk`, `lastError` | Result, with a reason code such as `http_401`, `timeout`, `invalid_shape` or `empty_list`. `lastOk` is null until the first refresh |
| `upstream.state` | `unknown`, `up` or `down` |
| `upstream.since`, `consecutiveFailures`, `lastSuccessAt`, `lastFailureAt`, `lastFailureReason` | Heartbeat detail |
| `movies`, `series` | The same fields, separately: |
| `.rows` | Rows kept in the index |
| `.withTmdb`, `.withImdb`, `.withEither` | How many of `rows` have a valid id. `withEither / rows` is your coverage |
| `.yearConflicts` | Rows with a valid id whose name and row disagree about the year. Films among them are not offered, because the id may name another title of the same name. Series still are, because a show's name can state a later season. See [Labels](#labels). |
| `.upstreamRows` | Rows the source returned, kept or not |
| `.adultSkipped`, `.prereleaseSkipped`, `.invalidSkipped` | Why the others were dropped. These and `upstreamRows` are null after a restart until the first refresh, and describe the list now in the index, so an empty list being held back does not change them |
| `.lastSuccessAt` | When this list last replaced the index |
| `imdbConversion.enabled` | Whether a TMDB credential is set |
| `imdbConversion.conversions`, `errors` | TMDB calls answered and failed, since startup |
| `imdbConversion.hits`, `misses` | `tt` lookups that needed converting and did, or did not, get a TMDB id of the kind asked for, since startup. These include lookups answered from the cache |
| `imdbConversion.cached` | Ids in `imdb-tmdb.json` |

## Security model

- **Stream responses contain the Xtream Codes credentials**, in the URL of every stream, because players connect directly. The manifest and `/health` are static and hold none, but anyone who can read those can ask for a stream response too, so treat the whole add-on as holding the credentials.
- **It must only be reachable by its trusted aggregator**, either on a private Docker network with nothing else on it, or on loopback in a shared network namespace. Never publish the port or add a reverse proxy route. Nothing here authenticates a request.
- **No CORS headers is not a defence for a published port.** They stop a web page reading the add-on in the ordinary way, but it does not check the `Host` header, so DNS rebinding could get round that from any browser that can reach it. Keep it off any network a browser can reach.
- **In a shared network namespace, set `HOST=127.0.0.1`.** By default it listens on every address in the namespace, and sharing one does not make it private: a VPN container's firewall commonly accepts traffic from its local network on every port, so anything on that network could ask for a stream. The aggregator then reaches it at `http://localhost:7000` or `http://127.0.0.1:7000`. Everything inside the namespace can still reach it, so that includes any forward proxy running there, and whoever can use that proxy.
- **Whoever gets a stream gets the credentials.** That includes every client of the aggregator, and its logs if it logs URLs. Treat those as sensitive. Use a dedicated XC user you can revoke.
- **Use https for `XC_BASE_URL` if players reach it over a network you don't trust.** Over plain http, the credentials cross the network in the clear with every stream.
- **The TMDB credential goes to the TMDB API and nowhere else.** Its address is fixed in the code, and a redirect is refused rather than followed. It is not in any response or file.
- Logs pass through one redactor that scrubs the credentials and the upstream host, including encoded forms and error causes. Request URLs and stream URLs are never logged.
- `/health`, `status.json`, `snapshot.json`, `imdb-tmdb.json` and error bodies hold no credentials or upstream host. The snapshot's `upstream` field is a random salt and a SHA-256 hash, not the URL. The snapshot does hold your source's titles, so keep `data/` private.

To report a security problem, see [SECURITY.md](SECURITY.md).

## Development

Requires Node 24. There is nothing to install.

```bash
node --test
```

The tests start fake servers on this machine, and need no network, source or key. `test-support/fake-dispatcharr.js` is a fake Dispatcharr that follows its API behaviour and contains none of its code, and `test-support/fake-tmdb.js` is a fake TMDB. They sit outside `test/` because `node --test` runs every file in a directory named `test`. They are libraries for the tests, so running one on its own does nothing and just exits. The TMDB address is fixed in the code, so `tt` conversion through the fake can only be reached from the tests.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the commit rule and how to check it. For anything security related, please use [SECURITY.md](SECURITY.md) instead of an issue.

## Licence

MIT. See [LICENSE](LICENSE).
