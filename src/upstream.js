// Dispatcharr's Xtream Codes API. Credentials travel in the query string, so
// nothing in this file ever puts a URL or a response body in an error: errors
// carry a short reason code that is safe to log and to store in status.json.

const USER_AGENT = 'iptv-vod-addon/2.0';

export class UpstreamError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'UpstreamError';
    this.reason = reason;
  }
}

export function reasonOf(error) {
  return error instanceof UpstreamError ? error.reason : 'error';
}

export function failureReason(error) {
  if (error?.name === 'TimeoutError') return 'timeout';
  if (error?.name === 'AbortError') return 'aborted';
  const code = error?.cause?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? `network_${code}` : 'network';
}

export class XtreamClient {
  #baseUrl;
  #username;
  #password;
  #timeouts;
  #stopSignal;

  constructor(config, stopSignal) {
    this.#baseUrl = config.xc.baseUrl;
    this.#username = config.xc.username;
    this.#password = config.xc.password;
    this.#timeouts = config.timeouts;
    this.#stopSignal = stopSignal;
  }

  async #call(params, timeoutMs) {
    const query = new URLSearchParams({
      username: this.#username,
      password: this.#password,
      ...params,
    });
    let text;
    try {
      const response = await fetch(`${this.#baseUrl}/player_api.php?${query}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.#stopSignal]),
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
    try {
      return JSON.parse(text);
    } catch {
      // Includes Dispatcharr's catch-all HTML page and login portals.
      throw new UpstreamError('invalid_json');
    }
  }

  async #list(action) {
    const body = await this.#call({ action }, this.#timeouts.listMs);
    if (!Array.isArray(body)) throw new UpstreamError('invalid_shape');
    return body;
  }

  listMovies() {
    return this.#list('get_vod_streams');
  }

  listSeries() {
    return this.#list('get_series');
  }

  seriesInfo(seriesId) {
    return this.#call({ action: 'get_series_info', series_id: seriesId }, this.#timeouts.seriesInfoMs);
  }

  // No action: xc_player_api falls through to xc_get_info, which authenticates
  // and reads only Dispatcharr's own database and Redis, never the IPTV
  // provider. The body echoes the credentials back, so it is checked and dropped.
  async ping() {
    const body = await this.#call({}, this.#timeouts.heartbeatMs);
    if (!body?.user_info?.auth) throw new UpstreamError('auth_rejected');
  }
}
