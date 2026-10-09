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
  trustedClientAddress,
  parseAdminWhitelist,
  addressMatchesWhitelist,
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

// A login bzo did not verify itself -- a proxied server's, where the token
// went to the target unspent -- has a callsign and a null BZID. It survives a
// restart like any other, because the name is the whole point of keeping it.
{
  const store = createSessionStore({ ttlMs: 1000 });
  const sessionId = store.create({ bzid: null, callsign: 'Proxied Player', groups: [] }, 5000);
  assert.equal(store.get(sessionId, 5000).bzid, null);
  const saved = JSON.parse(JSON.stringify(store.serialize(5000)));

  const restored = createSessionStore({ ttlMs: 1000 });
  assert.equal(restored.load(saved, 5000), 1);
  assert.equal(restored.get(sessionId, 5000).callsign, 'Proxied Player');
  assert.equal(restored.get(sessionId, 5000).bzid, null);
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
  // A *missing* bzid is malformed, where an explicit null is a proxy login.
  assert.equal(store.load({ sessions: { a: { callsign: 'x' } } }), 0, 'no bzid');
  assert.equal(store.load({ sessions: { a: { bzid: 7, callsign: 'x', expiresAt: 9e9 } } }), 0,
    'bzid neither string nor null');
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
  assert.equal(isLocalAdminRequest('::1', {}, { enabled: false }), false);
  assert.equal(isLocalAdminRequest('127.0.0.1', {}, { enabled: undefined }), false);
  assert.equal(isLocalAdminRequest('127.0.0.1', {}, { enabled: 'yes' }), false, 'true, not truthy');
  assert.equal(isLocalAdminRequest('127.0.0.1', {}), false, 'no options, no admin');

  // On, and genuinely from this machine.
  assert.equal(isLocalAdminRequest('::1', {}, { enabled: true }), true);
  assert.equal(isLocalAdminRequest('127.0.0.1', {}, { enabled: true }), true);
  assert.equal(isLocalAdminRequest('::ffff:127.0.0.1', {}, { enabled: true }), true);
  assert.equal(isLocalAdminRequest(undefined, {}, { enabled: true }), false, 'no address, no admin');

  // A forwarded address is untrusted by default ('distrust'): a request that
  // went through a proxy is not provably a request from this machine, and a
  // remote client can add a forwarding header but cannot remove one.
  assert.equal(isLocalAdminRequest('::1', { 'x-forwarded-for': '1.2.3.4' }, { enabled: true }), false);
  assert.equal(isLocalAdminRequest('127.0.0.1', { 'X-Forwarded-For': '1.2.3.4' }, { enabled: true }), false);
  // Any of them, not just X-Forwarded-For -- however the hop was labelled.
  assert.equal(isLocalAdminRequest('::1', { 'x-forwarded-proto': 'https' }, { enabled: true }), false);
  assert.equal(isLocalAdminRequest('::1', { 'x-forwarded-host': 'bz.rikers.org' }, { enabled: true }), false);
  // A header that is not a forwarding header changes nothing.
  assert.equal(
    isLocalAdminRequest('::1', { 'user-agent': 'probe', cookie: 'a=b' }, { enabled: true }),
    true,
  );

  // And a remote peer is never local, headers or no headers.
  assert.equal(isLocalAdminRequest('166.70.97.196', {}, { enabled: true }), false);

  // A verified proxy ('trust-first'/'trust-last', from the startup probe in
  // server.js) is what lets a forwarded address count at all, and only then
  // against loopback or the configured whitelist.
  const opts = (forwardedForPolicy, whitelist = []) => (
    { enabled: true, forwardedForPolicy, whitelist: parseAdminWhitelist(whitelist).entries }
  );
  assert.equal(
    isLocalAdminRequest('203.0.113.9', { 'x-forwarded-for': '::1' }, opts('trust-first')),
    true,
    'a proxy that overwrites the header puts its one value first',
  );
  assert.equal(
    isLocalAdminRequest('203.0.113.9', { 'x-forwarded-for': '9.9.9.9, ::1' }, opts('trust-last')),
    true,
    'a proxy that appends puts its own contribution last',
  );
  assert.equal(
    isLocalAdminRequest('203.0.113.9', { 'x-forwarded-for': '9.9.9.9, ::1' }, opts('trust-first')),
    false,
    'trust-first reads only the first element, not any loopback later in the chain',
  );
  assert.equal(
    isLocalAdminRequest('203.0.113.9', { 'x-forwarded-for': '166.70.97.196' }, opts('trust-first')),
    false,
    'trusted policy, but the address itself is neither loopback nor whitelisted',
  );
  assert.equal(
    isLocalAdminRequest(
      '203.0.113.9',
      { 'x-forwarded-for': '166.70.97.196' },
      opts('trust-first', ['166.70.97.0/24']),
    ),
    true,
    'a whitelisted CIDR block, once the forwarded address is trusted',
  );

  // Only the proxy the probe saw has its headers read: any other peer came in
  // directly, so a forged header is ignored and its own address is judged.
  const viaProxy = (whitelist = []) => ({ ...opts('trust-last', whitelist), proxyPeer: '166.70.97.196' });
  assert.equal(
    isLocalAdminRequest('203.0.113.9', { 'x-forwarded-for': '127.0.0.1' }, viaProxy()),
    false,
    'a direct client forging a loopback X-Forwarded-For',
  );
  assert.equal(
    isLocalAdminRequest('::ffff:166.70.97.196', { 'x-forwarded-for': '9.9.9.9, ::1' }, viaProxy()),
    true,
    'the proxy itself is read as before',
  );
  assert.equal(
    isLocalAdminRequest('192.168.12.7', { 'x-forwarded-for': '203.0.113.9' }, viaProxy(['192.168.0.0/16'])),
    false,
    'forwarding headers from a whitelisted peer that is not the proxy: maybe the proxy by another address',
  );
  assert.equal(
    isLocalAdminRequest('192.168.12.7', {}, viaProxy(['192.168.0.0/16'])),
    true,
    'a whitelisted client reaching this server directly',
  );
  assert.equal(
    isLocalAdminRequest('192.168.12.7', {}, opts('distrust', ['192.168.0.0/16'])),
    true,
    'a whitelisted direct peer with no forwarding header',
  );
  assert.equal(
    isLocalAdminRequest('166.70.97.196', {}, viaProxy(['166.70.97.192/29'])),
    false,
    'the proxy saying nothing about its client is not whitelisted itself',
  );
  assert.equal(trustedClientAddress('203.0.113.9', { 'x-forwarded-for': '127.0.0.1' }, 'trust-last', '166.70.97.196'),
    '203.0.113.9');
}

// `adminWhitelist` entries, validated the same way `adminGroups` is.
{
  const { entries, refused } = parseAdminWhitelist([
    '166.70.97.196',
    '10.0.0.0/8',
    '::1',
    'not an address',
    '999.0.0.1',
    '10.0.0.0/33',
  ]);
  assert.equal(entries.length, 3);
  assert.deepEqual(refused, ['not an address', '999.0.0.1', '10.0.0.0/33']);

  assert.equal(addressMatchesWhitelist('166.70.97.196', entries), true);
  assert.equal(addressMatchesWhitelist('166.70.97.197', entries), false, 'a /32 is exact');
  assert.equal(addressMatchesWhitelist('10.1.2.3', entries), true, 'inside the /8');
  assert.equal(addressMatchesWhitelist('11.1.2.3', entries), false, 'outside the /8');
  assert.equal(addressMatchesWhitelist('::1', entries), true);
  assert.equal(addressMatchesWhitelist('::2', entries), false);

  assert.deepEqual(parseAdminWhitelist(undefined).entries, []);

  // IPv6 CIDR blocks, not just exact addresses: a `::`-compressed run expands
  // to as many groups as it stands for, on both sides of the slash.
  const { entries: v6 } = parseAdminWhitelist(['2607:fa18:9fff::/48', 'fc00::/7']);
  assert.equal(addressMatchesWhitelist('2607:fa18:9fff::196', v6), true, 'inside the /48');
  assert.equal(addressMatchesWhitelist('2607:fa18:a000::1', v6), false, 'outside the /48');
  assert.equal(addressMatchesWhitelist('fd00::1', v6), true, 'inside fc00::/7');
  assert.equal(addressMatchesWhitelist('fe00::1', v6), false, 'outside fc00::/7');
}

console.log('session tests passed');
