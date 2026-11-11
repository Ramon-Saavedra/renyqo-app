'use strict';

// Jest vm-modules bridge: production uses cookie@2 (ESM). E2E loads AppModule under
// --experimental-vm-modules (required by Prisma 7's wasm query compiler). Map bare `cookie`
// imports to this CJS adapter so express-session and session infrastructure load safely.
const legacy = require('cookie-legacy');

module.exports = {
  parse: legacy.parse,
  serialize: legacy.serialize,
  parseCookie: legacy.parse,
  parseSetCookie: legacy.parse,
  stringifyCookie: legacy.serialize,
  stringifySetCookie: legacy.serialize,
};
