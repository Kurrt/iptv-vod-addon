// Tracks whether upstream is usable. While down, every stream lookup answers
// empty, so other sources take over rather than dead links being offered.

export class UpstreamHealth {
  #threshold;
  #state = 'unknown';
  #since;
  #failures = 0;
  #lastSuccessAt = null;
  #lastFailureAt = null;
  #lastFailureReason = null;

  constructor(threshold, now = new Date()) {
    this.#threshold = threshold;
    this.#since = now.toISOString();
  }

  get state() {
    return this.#state;
  }

  get isDown() {
    return this.#state === 'down';
  }

  #moveTo(state, now) {
    if (state === this.#state) return false;
    this.#state = state;
    this.#since = now.toISOString();
    return true;
  }

  // Both return true only when the state actually changed.
  recordSuccess(now = new Date()) {
    this.#failures = 0;
    this.#lastSuccessAt = now.toISOString();
    return this.#moveTo('up', now);
  }

  recordFailure(reason, now = new Date()) {
    this.#failures += 1;
    this.#lastFailureAt = now.toISOString();
    this.#lastFailureReason = reason;
    return this.#failures >= this.#threshold && this.#moveTo('down', now);
  }

  toJSON() {
    return {
      state: this.#state,
      since: this.#since,
      consecutiveFailures: this.#failures,
      lastSuccessAt: this.#lastSuccessAt,
      lastFailureAt: this.#lastFailureAt,
      lastFailureReason: this.#lastFailureReason,
    };
  }
}
