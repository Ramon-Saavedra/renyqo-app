'use strict';

const { appendFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const MARKER =
  'Calling client.query() when the client is already executing a query is deprecated';

const file = join(
  tmpdir(),
  `renyqo-pg-client-query-overlap-${process.pid}.log`,
);
writeFileSync(file, '');

const emitWarning = process.emitWarning;
process.emitWarning = function renyqoRecordPgClientQueryOverlap(...args) {
  const warning = args[0];
  const message =
    typeof warning === 'string'
      ? warning
      : warning instanceof Error
        ? warning.message
        : '';
  if (message.includes(MARKER)) {
    appendFileSync(file, `${message}\n`);
  }
  return emitWarning.apply(process, args);
};
