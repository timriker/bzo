import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const {
  findPublicServer, collectNonDefaultVariables, OBSTACLE_ORDER,
  parseWorldDatabase, buildBZWText,
} = require('../server/remote-world-import.cjs');
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

// A world holding one `group` instance, so the instance's own fields survive a
// real parse rather than a hand-made tree. `nameField` is what
// `GroupInstance::pack` writes: the name, plus -- when the instance remaps
// materials -- a NUL and the remap table behind it.
function worldBlobWithGroupInstance(nameField) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const str = (b) => Buffer.concat([u32(b.length), b]);
  const body = Buffer.concat([
    u32(0), u32(0), u32(0), u32(0), u32(0), // the five managers, all empty
    str(Buffer.alloc(0)),                   // the world group definition's name
    ...OBSTACLE_ORDER.map(() => u32(0)),    // no obstacles of any kind
    u32(1),                                 // one group instance:
    str(Buffer.from('stg')),                //   the definition it places
    str(nameField),                         //   its name (+ any remap table)
    str(Buffer.alloc(0)), u32(0),           //   an unnamed transform, no ops
    Buffer.from([0]),                       //   no modify bits set
    u32(0),                                 // no other group definitions
    u32(0),                                 // no links
    Buffer.from([0xff, 0x80, 0x00, 0x00]),  // water level -Infinity: no water
    u32(0), u32(0),                         // no weapons, no entry zones
  ]);
  const deflated = zlib.deflateSync(body);
  return Buffer.concat([
    Buffer.from([0, 0, 0x68, 0x65, 0, 1]), // length, "he" header, map version
    u32(body.length), u32(deflated.length), deflated,
  ]);
}

function groupBlockOf(nameField) {
  const tree = parseWorldDatabase(worldBlobWithGroupInstance(nameField));
  const text = buildBZWText({ host: 'example.org', port: 5154 },
    { ...tree, worldSize: 800, variables: new Map() }, new Date(0));
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === 'group stg');
  return lines.slice(start, lines.indexOf('end', start) + 1);
}

// #130: every teleporter a group places is named after the instance, so an
// instance whose name is dropped takes every link naming it down with it.
assert.deepEqual(groupBlockOf(Buffer.from('stg-0')), ['group stg', '  name stg-0', 'end'],
  'the instance name is read and written back, so `link stg-0:out:* ...` still resolves');
assert.deepEqual(groupBlockOf(Buffer.alloc(0)), ['group stg', 'end'],
  'an unnamed instance writes no name line, and is named by its position on the way back in');

// `GroupInstance::pack`'s own trick: the remap table rides in the tail of the
// name string, behind a NUL.
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
assert.deepEqual(
  groupBlockOf(Buffer.concat([Buffer.from('stg-0'), Buffer.from([0]), i32(2),
    i32(3), i32(4), i32(5), i32(6)])),
  ['group stg', '  name stg-0', '  matswap 3 4', '  matswap 5 6', 'end'],
  'the name stops at the NUL and the remap table behind it becomes matswap lines');

console.log('remote world import tests passed');