/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Sessions for the bzflag.org global login. Server-only: a session is an
// authority question, and in bzo those belong to the server alone.
//
// A player's browser holds one opaque id and nothing else. Every attribute --
// the BZID, the callsign, the groups, whether any of them grants admin -- lives
// in the record here, which the id is a key to. That is what makes a forged
// cookie harmless rather than merely unlikely: a player can write any cookie
// they like, and an id that matches no record is simply anonymous. Nothing
// here is ever *parsed* out of what the client sent; it is only ever looked up.
//
// See docs/login-plan.md, and AGENTS.md "What a real login would look like" for
// what the list server actually answers.

const crypto = require('crypto');
const net = require('net');

// 8 hours, absolute. Group membership is a snapshot -- the token is spent at
// `/login` and cannot be re-asked -- so the lifetime is also how long a
// demotion at bzflag.org can go unnoticed.
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

// 256 bits, 43 characters of base64url. The whole security argument is that
// this cannot be guessed, so it comes from the CSPRNG and never from anything
// about the player: a value derived from a BZID or a callsign would be
// forgeable by whoever knows one.
const SESSION_ID_BYTES = 32;

// A cap so a long-lived server cannot be walked into unbounded memory, or an
// unbounded file, by repeated logins. Oldest goes first; the victim of the cap
// is asked to log in again, which is the mildest failure available here.
const MAX_SESSIONS = 500;

const SESSION_COOKIE_NAME = 'bzoSession';

function createSessionId(randomBytes = crypto.randomBytes) {
  return randomBytes(SESSION_ID_BYTES).toString('base64url');
}

// Cookie *names* and values, parsed the one way bzo needs: express does not
// parse cookies without `cookie-parser`, and one cookie does not earn a
// dependency. A repeated name keeps the first value, as browsers send the most
// specific first.
function parseCookies(header) {
  const cookies = {};
  for (const pair of String(header || '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    if (!name || name in cookies) continue;
    cookies[name] = pair.slice(separator + 1).trim();
  }
  return cookies;
}

function isExpired(session, now) {
  return !session || !(session.expiresAt > now);
}

// The admin rule, in one place: authenticated **and** a member of at least one
// group the server named. A session with no groups is a perfectly good session
// that grants nothing, which is the common case.
function isAdminSession(session, adminGroups, now = Date.now()) {
  if (isExpired(session, now)) return false;
  if (!Array.isArray(adminGroups) || adminGroups.length === 0) return false;
  const groups = Array.isArray(session.groups) ? session.groups : [];
  // Case-insensitively, because the list server's spelling of a group is not
  // documented and a server.json that differs in case means the operator's
  // intent, not a non-member.
  const held = new Set(groups.map((group) => String(group).toLowerCase()));
  return adminGroups.some((group) => held.has(String(group).toLowerCase()));
}

// A record holds no secret. The bzflag.org token is spent at `/login` and
// discarded, so nothing here would help anybody who read the file.
// `bzid` is null for a login bzo did not verify itself: a proxied server's,
// where the token was forwarded to the target unspent and the target is what
// checked it (`docs/proxy.md`). Such a session carries a callsign and nothing
// else, so this server's own game treats it as anonymous -- the name is a
// convenience, not an identity, and only a BZID is an identity here.
function createSessionRecord({ bzid = null, callsign, groups = [] }, now = Date.now(), ttlMs = SESSION_TTL_MS) {
  return {
    bzid: bzid === null || bzid === undefined ? null : String(bzid),
    callsign: String(callsign),
    groups: groups.map((group) => String(group)),
    createdAt: now,
    expiresAt: now + ttlMs,
  };
}

function createSessionStore({
  ttlMs = SESSION_TTL_MS,
  maxSessions = MAX_SESSIONS,
  randomBytes = crypto.randomBytes,
  onChange = () => {},
} = {}) {
  const sessions = new Map();

  function prune(now = Date.now()) {
    let dropped = 0;
    for (const [id, session] of sessions) {
      if (isExpired(session, now)) {
        sessions.delete(id);
        dropped++;
      }
    }
    // Insertion order is creation order, so the oldest are at the front.
    while (sessions.size > maxSessions) {
      sessions.delete(sessions.keys().next().value);
      dropped++;
    }
    if (dropped > 0) onChange();
    return dropped;
  }

  return {
    // Returns the id, because that is the only part the browser ever sees.
    create(identity, now = Date.now()) {
      const id = createSessionId(randomBytes);
      sessions.set(id, createSessionRecord(identity, now, ttlMs));
      // After the insert, not before: pruning first would leave the store one
      // over the cap until the *next* login, and the cap exists to bound this
      // one. The new session is the newest, so trimming oldest-first cannot
      // take it. `onChange` may fire twice here, which the debounced writer
      // absorbs.
      prune(now);
      onChange();
      return id;
    },

    // Undefined for an id that is unknown *or* expired, so a caller cannot
    // accidentally honour a stale record by forgetting to check.
    get(id, now = Date.now()) {
      if (typeof id !== 'string' || id === '') return undefined;
      const session = sessions.get(id);
      if (!session) return undefined;
      if (isExpired(session, now)) {
        sessions.delete(id);
        onChange();
        return undefined;
      }
      return session;
    },

    remove(id) {
      if (typeof id !== 'string' || !sessions.delete(id)) return false;
      onChange();
      return true;
    },

    prune,

    get size() {
      return sessions.size;
    },

    // What goes to disk, so a restart does not log everybody out: this server
    // restarts on every edit and a bzflag.org token is single use, so each
    // re-login is a full round trip through my.bzflag.org.
    serialize(now = Date.now()) {
      prune(now);
      return { version: 1, sessions: Object.fromEntries(sessions) };
    },

    // Anything malformed is dropped rather than repaired. A session that cannot
    // be read is one login, and guessing at its contents would be guessing at
    // an identity.
    load(data, now = Date.now()) {
      let loaded = 0;
      const entries = data && typeof data === 'object' ? data.sessions : null;
      if (!entries || typeof entries !== 'object') return 0;
      for (const [id, session] of Object.entries(entries)) {
        if (typeof id !== 'string' || !session || typeof session !== 'object') continue;
        if (typeof session.callsign !== 'string') continue;
        // `null` is a real value here, not a missing one: a proxy login has a
        // callsign and no BZID, and dropping it on load would lose the name a
        // restart is supposed to keep. Anything else is malformed.
        if (session.bzid !== null && typeof session.bzid !== 'string') continue;
        if (!Number.isFinite(session.expiresAt) || isExpired(session, now)) continue;
        sessions.set(id, {
          bzid: session.bzid,
          callsign: session.callsign,
          groups: Array.isArray(session.groups) ? session.groups.map(String) : [],
          createdAt: Number.isFinite(session.createdAt) ? session.createdAt : now,
          expiresAt: session.expiresAt,
        });
        loaded++;
      }
      prune(now);
      return loaded;
    },
  };
}

// Loopback, in every spelling a Node socket hands back: `::1`, `127.0.0.0/8`,
// and the IPv4-mapped form `::ffff:127.0.0.1` that a dual-stack listener reports
// for an IPv4 peer.
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false;
  const bare = address.replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '');
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

// A full IPv6 address (no embedded IPv4 tail, no zone id -- neither belongs in
// a config file entry) as one 128-bit BigInt, or null if it is not one.
// `net.isIPv6` confirms the shape; this does the arithmetic `net` has no
// getter for, expanding a `::` run to the groups it stands for.
function ipv6ToBigInt(address) {
  if (!net.isIPv6(address)) return null;
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (s) => (s === '' ? [] : s.split(':'));
  let groups;
  if (halves.length === 1) {
    groups = groupsOf(halves[0]);
  } else {
    const head = groupsOf(halves[0]);
    const tail = groupsOf(halves[1]);
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

// A whitelist entry from `server.json`'s `adminWhitelist`: a bare IPv4/IPv6
// address (an implicit /32 or /128) or a CIDR block of either. Returns null
// for anything unparseable rather than throwing, so one bad entry can be
// refused and logged instead of crashing startup.
function parseWhitelistEntry(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const [addr, prefixRaw] = trimmed.split('/');
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    const prefix = prefixRaw === undefined ? 32 : Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    const value = octets.reduce((acc, octet) => (acc << 8) | octet, 0) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return { family: 4, network: value & mask, mask };
  }
  const bare = addr.replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '');
  const value = ipv6ToBigInt(bare);
  if (value === null) return null;
  const prefix = prefixRaw === undefined ? 128 : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
  const mask = prefix === 0 ? 0n : (((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix));
  return { family: 6, network: value & mask, mask };
}

// `adminWhitelist` in server.json, validated and logged the way `adminGroups`
// is at startup: accepted entries kept, malformed ones named and refused
// rather than silently dropped.
function parseAdminWhitelist(list) {
  const raw = Array.isArray(list) ? list : [];
  const entries = [];
  const refused = [];
  for (const item of raw) {
    const parsed = parseWhitelistEntry(item);
    if (parsed) entries.push(parsed);
    else refused.push(item);
  }
  return { entries: Object.freeze(entries), refused };
}

function addressMatchesWhitelist(address, entries) {
  if (typeof address !== 'string' || address === '') return false;
  const bare = address.replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '');
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  const asIpv4 = ipv4Match
    ? (ipv4Match.slice(1).map(Number).reduce((acc, octet) => (acc << 8) | octet, 0) >>> 0)
    : null;
  // Only computed once, and only when something might need it: every address
  // this sees is IPv4 except the rare loopback/whitelisted IPv6 peer.
  let asIpv6;
  return entries.some((entry) => {
    if (entry.family === 4) return asIpv4 !== null && (asIpv4 & entry.mask) === entry.network;
    if (asIpv6 === undefined) asIpv6 = ipv6ToBigInt(bare);
    return entry.family === 6 && asIpv6 !== null && (asIpv6 & entry.mask) === entry.network;
  });
}

// `localAdmin` in server.json: whether a connection from this machine is an
// operator without logging in, generalised to a whitelist of addresses (issue
// #80's `adminWhitelist`) once the proxy in front of this server is known to
// handle `X-Forwarded-For` safely. It exists so a test client -- a headless
// browser, a raw WebSocket probe -- can drive the Operator panel and the server
// commands without a bzflag.org account, and so an operator's own network can
// too, without a login.
//
// **Off by default, and it has to be.** bzo does not terminate TLS, so a public
// deployment is behind a reverse proxy, and a proxy on the *same host* makes
// every request in the world arrive from 127.0.0.1. Granting admin on the peer
// address alone would hand it to the internet.
//
// `forwardedForPolicy` is the result of the startup probe in server.js, which
// calls this server on its own public URL -- once plain, once with a poisoned
// `X-Forwarded-For` -- to see whether the header that reaches this process can
// be trusted, and if so, how a chain from it should be read. Until that probe
// finishes, or when it finds the proxy unsafe, the policy is `'distrust'` and a
// forwarded address never counts.
//
// `proxyPeer` is the address that probe arrived from: the proxy itself. Only a
// connection from it has its forwarding headers read. Any other peer reached
// this server directly -- the BZFlag port answers the web app too -- so its
// headers are its own invention and its socket address is the client's.
//
// A connection with no forwarding header is judged by its own address against
// loopback and the whitelist -- except one from the proxy itself, which only
// speaks for a client when it says who, so counts only as loopback. One with
// forwarding headers from any other peer is never admin: it is a client
// inventing them, or a proxy reaching this server from a second address, and
// a whitelisted proxy would otherwise hand admin to everyone behind it.
function isLocalAdminRequest(remoteAddress, headers = {}, options = {}) {
  const { enabled = false, whitelist = [], forwardedForPolicy = 'distrust', proxyPeer = null } = options;
  if (enabled !== true) return false;
  const fromProxy = proxyPeer !== null && sameAddress(remoteAddress, proxyPeer);
  if (!hasForwardedHeader(headers)) {
    if (isLoopbackAddress(remoteAddress)) return true;
    return !fromProxy && addressMatchesWhitelist(remoteAddress, whitelist);
  }
  if (proxyPeer !== null && !fromProxy) return false;
  const address = trustedClientAddress(remoteAddress, headers, forwardedForPolicy, proxyPeer);
  if (!address) return false;
  if (isLoopbackAddress(address)) return true;
  return addressMatchesWhitelist(address, whitelist);
}

function hasForwardedHeader(headers) {
  return Object.keys(headers).some((name) => /^x-forwarded-/i.test(name));
}

function sameAddress(a, b) {
  const bare = (address) => String(address || '').trim().replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '').toLowerCase();
  return bare(a) !== '' && bare(a) === bare(b);
}

// The client's address as far as anything may rest on it -- the admin
// whitelist above, an address ban, a saved score -- read by the same probe
// result. Without a forwarded header, or from a peer other than `proxyPeer`,
// it is the peer's own. From the proxy it is the entry that proxy wrote: the
// only one under `trust-first`, the last under `trust-last`. Under `distrust`,
// or with no X-Forwarded-For to read, a forwarded connection has none, and
// null says so.
function trustedClientAddress(remoteAddress, headers = {}, forwardedForPolicy = 'distrust', proxyPeer = null) {
  if (!hasForwardedHeader(headers)) return remoteAddress || null;
  if (forwardedForPolicy === 'distrust') return null;
  if (proxyPeer !== null && !sameAddress(remoteAddress, proxyPeer)) return remoteAddress || null;
  const xff = headers['x-forwarded-for'];
  if (typeof xff !== 'string' || xff.trim() === '') return null;
  const parts = xff.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return forwardedForPolicy === 'trust-last' ? parts[parts.length - 1] : parts[0];
}

module.exports = {
  isLoopbackAddress,
  isLocalAdminRequest,
  trustedClientAddress,
  parseAdminWhitelist,
  parseWhitelistEntry,
  addressMatchesWhitelist,
  SESSION_TTL_MS,
  SESSION_ID_BYTES,
  MAX_SESSIONS,
  SESSION_COOKIE_NAME,
  createSessionId,
  parseCookies,
  isExpired,
  isAdminSession,
  createSessionRecord,
  createSessionStore,
};
