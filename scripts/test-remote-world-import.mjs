import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findPublicServer, collectNonDefaultVariables } = require('../server/remote-world-import.cjs');
const { BZDB_DEFAULTS } = require('../server/bzdb-defaults.cjs');

const publicServers = [
  { host: 'example.org', port: 5154, title: 'Example' },
  { host: 'alternate.example.org', port: 4200, title: 'Alternate' },
];

assert.equal(findPublicServer(publicServers, 'example.org', 5154), publicServers[0]);
assert.equal(findPublicServer(publicServers, 'EXAMPLE.ORG', 5154), publicServers[0],
  'DNS hostnames are case-insensitive and the public record is returned as the canonical target');
assert.equal(findPublicServer(publicServers, 'example.org', 4200), null,
  'a listed hostname on an unlisted port is refused');
assert.equal(findPublicServer(publicServers, 'private.example.org', 5154), null,
  'an unlisted hostname is refused');
assert.equal(findPublicServer(publicServers, 'example.org', '5154'), null,
  'the parsed numeric port is required');
assert.equal(findPublicServer(null, 'example.org', 5154), null);
assert.equal(findPublicServer([{ host: null, port: 5154 }], 'example.org', 5154), null,
  'malformed public-list entries are ignored');

// A server sends its whole BZDB; only what it actually changed belongs in the
// exported map.
assert.deepEqual(collectNonDefaultVariables(null), [],
  'a server that refused the join contributes no -set lines');
assert.deepEqual(
  collectNonDefaultVariables(new Map([['_tankSpeed', BZDB_DEFAULTS._tankSpeed]])), [],
  'a variable still at upstream\'s default is not a setting this server chose');
assert.deepEqual(
  collectNonDefaultVariables(new Map([['_tankSpeed', '32']])), [['_tankSpeed', '32']],
  'a changed world variable is recorded even though bzo does not read it yet');
assert.deepEqual(
  collectNonDefaultVariables(new Map([['_bzoMade Up', 'x'], ['_ok', 'y']])), [['_ok', 'y']],
  'a name upstream does not define is still recorded; one that cannot survive a .bzw line is not');
assert.deepEqual(
  collectNonDefaultVariables(new Map([['poll', '523361792'], ['_worldSize', '800']])), [],
  'bzfs\'s VotingArbiter pointer and the size the world block already states are not settings');
assert.deepEqual(
  collectNonDefaultVariables(new Map([['_b', '2'], ['_a', '1']])), [['_a', '1'], ['_b', '2']],
  'recorded in name order, so re-importing an unchanged server produces an unchanged file');

console.log('remote world import tests passed');