'use strict';

const { Store } = require('./db');

const STORAGE_BACKENDS = Object.freeze(['sqlite']);
const HA_UPGRADE_THRESHOLDS = Object.freeze({
  repositoriesPerInstance: 100,
  concurrentCodexWorkers: 20,
  reviewsPerDay: 100000,
  crossAzRequired: true,
  zeroSingleNodeDowntimeRequired: true
});

function assessHaNeed({ repositories = 0, workers = 0, reviewsPerDay = 0, crossAzRequired = false, zeroSingleNodeDowntimeRequired = false } = {}) {
  const reasons = [];
  if (repositories > HA_UPGRADE_THRESHOLDS.repositoriesPerInstance) reasons.push('repository_count');
  if (workers > HA_UPGRADE_THRESHOLDS.concurrentCodexWorkers) reasons.push('worker_count');
  if (reviewsPerDay > HA_UPGRADE_THRESHOLDS.reviewsPerDay) reasons.push('review_volume');
  if (crossAzRequired) reasons.push('cross_az');
  if (zeroSingleNodeDowntimeRequired) reasons.push('single_node_downtime');
  return Object.freeze({ haRecommended: reasons.length > 0, reasons: Object.freeze(reasons) });
}

function createStorage({ backend = 'sqlite', dbPath, migrationHooks } = {}) {
  if (backend !== 'sqlite') {
    const error = new Error(`Unsupported storage backend: ${backend}. This release intentionally ships SQLite only; use the storage adapter boundary for a future HA backend.`);
    error.code = 'ESTORAGEBACKEND';
    throw error;
  }
  return new Store(dbPath, { migrationHooks });
}

function storageCapabilities() {
  return Object.freeze({
    backend: 'sqlite',
    durable: true,
    wal: true,
    multiProcessWriters: false,
    multiControllerHa: false,
    migrations: true,
    currentSchemaVersion: 6,
    replacementBoundary: 'createStorage'
  });
}

module.exports = Object.freeze({ STORAGE_BACKENDS, HA_UPGRADE_THRESHOLDS, assessHaNeed, createStorage, storageCapabilities });
