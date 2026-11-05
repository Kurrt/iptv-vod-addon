// Atomic JSON files in DATA_DIR. Losing them only costs a slower restart, so
// any failure warns once and the add-on carries on in memory.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class Persister {
  #dir;
  #logger;
  #warned = false;
  #queue = Promise.resolve();
  #sequence = 0;

  constructor(dir, logger) {
    this.#dir = dir;
    this.#logger = logger;
  }

  #warnOnce(error) {
    if (this.#warned) return;
    this.#warned = true;
    this.#logger.warn('DATA_DIR is not writable, continuing without persistence', error);
  }

  async init() {
    try {
      await mkdir(this.#dir, { recursive: true });
    } catch (error) {
      this.#warnOnce(error);
    }
  }

  // Null for a file that is absent, unreadable or not valid JSON.
  async read(name) {
    let text;
    try {
      text = await readFile(join(this.#dir, name), 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#logger.warn(`could not read ${name}`, error);
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      this.#logger.warn(`ignoring ${name}: not valid JSON`);
      return null;
    }
  }

  // Writes are queued, so a slow older write cannot land on top of a newer one.
  write(name, document) {
    this.#queue = this.#queue.then(() => this.#writeNow(name, document));
    return this.#queue;
  }

  flush() {
    return this.#queue;
  }

  async #writeNow(name, document) {
    const target = join(this.#dir, name);
    this.#sequence += 1;
    const temporary = `${target}.${process.pid}.${this.#sequence}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(document));
      await rename(temporary, target);
    } catch (error) {
      this.#warnOnce(error);
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
