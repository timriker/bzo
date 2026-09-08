import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SESSION_TTL_MS,
  SESSION_ID_BYTES,
  createSessionId,
  parseCookies,
  isExpired,
  isAdminSession,
  createSessionRecord,
  createSessionStore,
  isLoopbackAddress,
  isLocalAdminRequest,
} = require('../server/sessions.cjs');

// No real callsign or BZID belongs in a test. These are the shapes the list
// server answers with, not anybody's account.
const IDENTITY = { bzid: '4242', callsign: 'Test Player', groups: ['DEVELOPERS', 'SOMETHING.ELSE'] };

// 8 hours, the decided lifetime (docs/login-plan.md).
assert.equal(SESSION_TTL_MS, 8 * 60 * 60 * 1000);

// 256 bits, which is the whole security argument: the id cannot be guessed, so
// a forged cookie matches no record rather than being merely unlikely to.
assert.equal(SESSION_ID_BYTES, 32);
const id = createSessionId();
assert.equal(id.length, 43, 'base64url of 32 bytes is 43 characters');
assert.match(id, /^[A-Za-z0-9_-]+$/, 'base64url carries nothing a cookie must escape');
assert.notEqual(createSessionId(), createSessionId());

// Cookie parsing, because express does not do it without `cookie-parser` and
// one cookie does not earn a dependency.
assert.deepEqual(parseCookies('bzoSession=abc'), { bzoSession: 'abc' });
assert.deepEqual(parseCookies(' a=1 ; b=2 '), { a: '1', b: '2' });
// A value may contain `=`; only the first one separates.
assert.deepEqual(parseCookies('a=1=2'), { a: '1=2' });
// A repeated name keeps the first, as browsers send the most specific first.
assert.deepEqual(parseCookies('a=first; a=second'), { a: 'first' });
// Nothing to parse is not an error anywhere it is asked.
assert.deepEqual(parseCookies(''), {});
assert.deepEqual(parseCookies(undefined), {});
assert.deepEqual(parseCookies('novalue'), {});

// Expiry is exclusive at the boundary: a session is not valid *at* the instant
// it expires.
const record = createSessionRecord(IDENTITY, 1000, 500);
assert.equal(record.expiresAt, 1500);
assert.equal(isExpired(record, 1499), false);
assert.equal(isExpired(record, 1500), true);
assert.equal(isExpired(undefined, 0), true, 'no session is an expired session');
// A record holds no secret: the bzflag.org token is spent at /login.
assert.deepEqual(Object.keys(record).sort(), ['bzid', 'callsign', 'createdAt', 'expiresAt', 'groups']);

// The admin rule: authenticated **and** in at least one named group.
assert.equal(isAdminSession(record, ['DEVELOPERS'], 1000), true);
assert.equal(isAdminSession(record, ['BZADMIN'], 1000), false);
assert.equal(isAdminSession(record, ['BZADMIN', 'DEVELOPERS'], 1000), true);
// A server that names no group grants admin to nobody, which is the default in
// example-server.json.
assert.equal(isAdminSession(record, [], 1000), false);
assert.equal(isAdminSession(record, undefined, 1000), false);
// An expired session grants nothing, whatever it says it is a member of.
assert.equal(isAdminSession(record, ['DEVELOPERS'], 9999), false);
assert.equal(isAdminSession(undefined, ['DEVELOPERS'], 1000), false);
// Case is the operator's intent rather than a non-member: the list server's own
// spelling of a group is not documented.
assert.equal(isAdminSession(record, ['developers'], 1000), true);
assert.equal(isAdminSession(createSessionRecord({ ...IDENTITY, groups: ['developers'] }, 1000, 500),
  ['DEVELOPERS'], 1000), true);
// A session with no groups is a valid session that grants nothing.
assert.equal(isAdminSession(createSessionRecord({ bzid: '1', callsign: 'x' }, 1000, 500),
  ['DEVELOPERS'], 1000), false);

// The store. `now` is injected throughout so expiry is tested rather than waited
// for.
{
  let changes = 0;
  const store = createSessionStore({ ttlMs: 1000, onChange: () => { changes++; } });
  const sessionId = store.create(IDENTITY, 5000);
  assert.equal(store.size, 1);
  assert.equal(changes, 1, 'a new session is a change worth persisting');

  const found = store.get(sessionId, 5999);
  assert.equal(found.callsign, 'Test Player');
  assert.equal(found.bzid, '4242');

  // Unknown, malformed and expired ids are all simply nobody, so a caller
  // cannot honour a stale record by forgetting to check.
  assert.equal(store.get('not-a-real-id', 5999), undefined);
  assert.equal(store.get('', 5999), undefined);
  assert.equal(store.get(undefined, 5999), undefined);
  assert.equal(store.get(sessionId, 6000), undefined, 'expired reads as absent');
  assert.equal(store.size, 0, 'and is dropped on the way out');

  assert.equal(store.remove('not-a-real-id'), false);
}

// Pruning, and the cap that keeps a long-lived server bounded.
{
  const store = createSessionStore({ ttlMs: 1000 });
  store.create(IDENTITY, 0);
  store.create(IDENTITY, 500);
  assert.equal(store.prune(1000), 1, 'the first has expired, the second has not');
  assert.equal(store.size, 1);
}
{
  const store = createSessionStore({ ttlMs: 1000, maxSessions: 2 });
  const first = store.create(IDENTITY, 0);
  store.create(IDENTITY, 1);
  store.create(IDENTITY, 2);
  assert.equal(store.size, 2, 'the cap holds');
  assert.equal(store.get(first, 3), undefined, 'and the oldest is what goes');
}

// Round trip through disk, so a restart does not log everybody out.
{
  const store = createSessionStore({ ttlMs: 1000 });
  const sessionId = store.create(IDENTITY, 5000);
  const saved = JSON.parse(JSON.stringify(store.serialize(5500)));

  const restored = createSessionStore({ ttlMs: 1000 });
  assert.equal(restored.load(saved, 5500), 1);
  assert.equal(restored.get(sessionId, 5500).callsign, 'Test Player');
  assert.deepEqual(restored.get(sessionId, 5500).groups, IDENTITY.groups);

  // A record that has expired while the server was down is not restored.
  const later = createSessionStore({ ttlMs: 1000 });
  assert.equal(later.load(saved, 99999), 0);
  assert.equal(later.size, 0);
}

// Anything malformed is dropped rather than repaired: a session that cannot be
// read is one login, and guessing at its contents would be guessing at an
// identity.
{
  const store = createSessionStore();
  assert.equal(store.load(null), 0);
  assert.equal(store.load({}), 0);
  assert.equal(store.load({ sessions: 'nope' }), 0);
  assert.equal(store.load({ sessions: { a: null } }), 0);
  assert.equal(store.load({ sessions: { a: { callsign: 'x' } } }), 0, 'no bzid');
  assert.equal(store.load({ sessions: { a: { bzid: '1' } } }), 0, 'no callsign');
  assert.equal(store.load({ sessions: { a: { bzid: '1', callsign: 'x' } } }), 0, 'no expiry');
  assert.equal(store.size, 0);
}

// `localAdmin`: whether a connection from this machine is an operator without a
// login. The rule is deliberately two-part, and the second part is the one that
// matters -- bzo does not terminate TLS, so a public deployment is behind a
// reverse proxy, and a proxy on the *same host* makes every request in the world
// arrive from 127.0.0.1.
{
  // Every spelling a Node socket hands back for loopback.
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('0:0:0:0:0:0:0:1'), true);
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.1.2.3'), true, 'the whole 127/8, as loopback is');
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true, 'a dual-stack listener maps IPv4');
  assert.equal(isLoopbackAddress('[::1]'), true);
  // And nothing else, including addresses that merely start the same way.
  assert.equal(isLoopbackAddress('166.70.97.196'), false);
  assert.equal(isLoopbackAddress('10.0.0.1'), false);
  assert.equal(isLoopbackAddress('1270.0.0.1'), false);
  assert.equal(isLoopbackAddress('::2'), false);
  assert.equal(isLoopbackAddress(''), false);
  assert.equal(isLoopbackAddress(undefined), false);

  // Off unless the operator asked, whatever the peer.
  assert.equal(isLocalAdminRequest(false, '::1', {}), false);
  assert.equal(isLocalAdminRequest(undefined, '127.0.0.1', {}), false);
  assert.equal(isLocalAdminRequest('yes', '127.0.0.1', {}), false, 'true, not truthy');

  // On, and genuinely from this machine.
  assert.equal(isLocalAdminRequest(true, '::1', {}), true);
  assert.equal(isLocalAdminRequest(true, '127.0.0.1', {}), true);
  assert.equal(isLocalAdminRequest(true, '::ffff:127.0.0.1', {}), true);
  assert.equal(isLocalAdminRequest(true), false, 'no address, no admin');

  // The part that keeps a same-host proxy from handing admin to the internet: a
  // request that went through a proxy is not a request from this machine, and a
  // remote client can add a forwarding header but cannot remove one.
  assert.equal(isLocalAdminRequest(true, '::1', { 'x-forwarded-for': '1.2.3.4' }), false);
  assert.equal(isLocalAdminRequest(true, '127.0.0.1', { 'X-Forwarded-For': '1.2.3.4' }), false);
  // Any of them, not just X-Forwarded-For -- however the hop was labelled.
  assert.equal(isLocalAdminRequest(true, '::1', { 'x-forwarded-proto': 'https' }), false);
  assert.equal(isLocalAdminRequest(true, '::1', { 'x-forwarded-host': 'bz.rikers.org' }), false);
  // A header that is not a forwarding header changes nothing.
  assert.equal(isLocalAdminRequest(true, '::1', { 'user-agent': 'probe', cookie: 'a=b' }), true);

  // And a remote peer is never local, headers or no headers.
  assert.equal(isLocalAdminRequest(true, '166.70.97.196', {}), false);
}

console.log('session tests passed');
