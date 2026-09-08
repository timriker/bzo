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
function createSessionRecord({ bzid, callsign, groups = [] }, now = Date.now(), ttlMs = SESSION_TTL_MS) {
  return {
    bzid: String(bzid),
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
        if (typeof session.callsign !== 'string' || typeof session.bzid !== 'string') continue;
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

// `localAdmin` in server.json: whether a connection from this machine is an
// operator without logging in. It exists so a test client -- a headless browser,
// a raw WebSocket probe -- can drive the Operator panel and, once bzo has them,
// the server commands, without a bzflag.org account.
//
// **Off by default, and it has to be.** bzo does not terminate TLS, so a public
// deployment is behind a reverse proxy, and a proxy on the *same host* makes
// every request in the world arrive from 127.0.0.1. Granting admin on the peer
// address alone would hand it to the internet.
//
// So the peer must be loopback *and* the request must carry no `X-Forwarded-For`.
// That is the half a remote client cannot forge: it can add the header but not
// remove it, and a proxy that follows the deployment notes in the README sets it
// on every hop (`RequestHeader set`, so a client's own copy never survives). A
// proxy that omits it entirely is the case this cannot see, which is the whole
// reason an operator has to ask for this rather than get it by default.
function isLocalAdminRequest(enabled, remoteAddress, headers = {}) {
  if (enabled !== true) return false;
  if (!isLoopbackAddress(remoteAddress)) return false;
  // Any of them, not just X-Forwarded-For: a request that went through a proxy
  // at all is not a request from this machine, however it was labelled.
  return !Object.keys(headers).some((name) => /^x-forwarded-/i.test(name));
}

module.exports = {
  isLoopbackAddress,
  isLocalAdminRequest,
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
