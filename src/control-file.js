'use strict';

const fs = require('node:fs');
const { secureReadBuffer } = require('./codex-safe-core/secure-local-file');

// Read privileged JSON through one checked descriptor. Root-owned deployment
// files remain supported; shared writable files, links and malformed UTF-8 do not.
function readControlJson(file, { maxBytes = 1024 * 1024, fsImpl = fs } = {}) {
  const bytes = secureReadBuffer(file, {
    maxBytes,
    requireOwner: false,
    rejectGroupOtherWrite: true,
    requireSingleLink: true,
    fsImpl
  });
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

module.exports = { readControlJson };
