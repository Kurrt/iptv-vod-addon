import { createApp } from './app.js';
import { ConfigError, loadConfig, secretsOf } from './config.js';
import { createLogger } from './logger.js';

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

const logger = createLogger({ secrets: secretsOf(config) });

// Node's default handlers print the raw error, which is not redacted.
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception', error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', reason);
  process.exit(1);
});

const app = createApp(config, { logger });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    logger.info(`${signal} received, shutting down`);
    app.stop().finally(() => process.exit(0));
  });
}

await app.start();
