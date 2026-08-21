'use strict';

const { loadConfig } = require('./config');
const { Store } = require('./db');
const { GitLabClient } = require('./gitlab');
const { ReviewService } = require('./service');
const { createHttpServer } = require('./http');

function log(level, value) {
  const record = typeof value === 'object' && value ? value : { message: String(value) };
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, ...record })}\n`);
}

async function main() {
  const config = loadConfig();
  const logger = {
    info: value => log('info', value),
    warn: value => log('warn', value),
    error: value => log('error', value)
  };
  const store = new Store(config.dbPath);
  const recovered = store.recoverInterruptedJobs();
  if (recovered) logger.info({ event: 'jobs_recovered', count: recovered });
  const gitlab = new GitLabClient(config);
  const service = new ReviewService({ config, store, gitlab, logger });
  const server = createHttpServer({ config, store, service, logger });

  const worker = service.workerLoop().catch(error => {
    logger.error({ event: 'worker_crashed', code: error.code || 'EWORKER' });
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, () => {
    logger.info({ event: 'service_started', host: config.host, port: config.port });
  });

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'shutdown', signal });
    service.stop();
    await new Promise(resolve => server.close(resolve));
    await worker;
    store.close();
  };

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
}

main().catch(error => {
  log('error', { event: 'startup_failed', code: error.code || 'ESTART', message: error.message });
  process.exitCode = 1;
});
