/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// `proxies` in `server.json`: which real BZFlag servers this instance may
// carry a browser to, as a map from the name a player sees to the address bzo
// dials.
//
//   "proxies": {
//     "bz.rikers.org:5154": "127.0.0.1:5154",
//     "bz-test:5155":       "127.0.0.1:5155"
//   }
//
// The two are different addresses and both are needed. The key is the
// identity: for a publicized target it is exactly the `host:port` the public
// BZFlag list carries -- its own `-publicaddr` -- so the bzo row and the
// bzflag row read the same string and a player comparing them sees one
// server. It is also what the cached world is filed under, so a shared
// `?viewmap=` link names something another bzo could re-ask. The value is how
// this instance reaches it, which is operator configuration and nothing a
// player is ever shown.
//
// A value may instead be an object, for a target that wants more than an
// address:
//
//     "bz.rikers.org:5154": { "address": "127.0.0.1:5154", "requireLogin": false }
//
// `requireLogin` (default true) is the proxy's rule that only a verified
// player plays. False lets a connection with no global login play there too,
// which a test server wants and bzfs itself allows.
//
// `originKey` is the secret shared with that server's proxyOrigin plugin,
// which lets bzo tell it each player's own address and BZID
// (docs/proxy-origin.md). Never sent to a browser.
//
// The map is also the allowlist. A target not named here cannot be proxied,
// linked to, or logged in to, which is what keeps `?proxy=` from being an
// invitation to dial anywhere.
//
// See `docs/proxy.md`.

// A key's host has to survive `remoteMapFileName`, which replaces anything
// outside this set with `_` -- a name that did not round-trip would be a
// `?viewmap=` link nobody could re-import. bzfs is IPv4-only, so there is no
// bracketed IPv6 form to allow for.
const ADDRESS = /^([A-Za-z0-9][A-Za-z0-9.-]*):(\d{1,5})$/;

// `Address::isPrivate` (`Address.cxx:121`), which is the whole of upstream's
// rule: 127/8, 10/8, 172.16/12 and 192.168/16. A forwarded global login only
// verifies when bzfs sees the connection arrive from one of these, so a
// public dial address is worth warning about -- though it is not an error,
// since a target that is not publicized never checks a token at all.
function isPrivateAddress(host) {
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host));
  if (!octets) return false;
  const [a, b] = octets.slice(1).map(Number);
  if (a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

// The same name as a URL carries it. A `:` is legal in a query value but
// browsers show it back as `%3A`, which makes a link somebody was meant to
// share look like an error; `_` survives a round trip through every address
// bar untouched. It is also the spelling the cached world already uses
// (`import-<host>_<port>.bzw`), so the link and the file read the same way,
// while `host:port` stays the identity -- what `/list` shows, what the
// operator configures, and what a bzflag list row says.
function proxyUrlKey(name) {
  return String(name).replace(/:(\d+)$/, '_$1');
}

function parseAddress(value) {
  const match = ADDRESS.exec(String(value || '').trim());
  if (!match) return null;
  const port = Number(match[2]);
  if (!(port >= 1 && port <= 65535)) return null;
  return { host: match[1], port };
}

// Returns the targets that are usable and, separately, every entry refused and
// why -- an operator who mistyped one should be told which and not left to
// wonder why a row is missing.
function parseProxies(raw) {
  const targets = {};
  const byUrlKey = {};
  const refused = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { targets, byUrlKey, refused, warnings };
  }
  for (const [key, value] of Object.entries(raw)) {
    const name = parseAddress(key);
    if (!name) {
      refused.push({ key, reason: 'the name must be <host>:<port>' });
      continue;
    }
    const spec = value && typeof value === 'object' ? value : { address: value };
    const dial = parseAddress(spec.address);
    if (!dial) {
      refused.push({ key, reason: 'the address must be <host>:<port>' });
      continue;
    }
    if (!isPrivateAddress(dial.host)) {
      warnings.push({
        key,
        reason: `${dial.host} is not a private address, so a forwarded global login will not verify`,
      });
    }
    if (typeof spec.originKey === 'string' && spec.originKey && spec.originKey.length < 16) {
      warnings.push({ key, reason: 'its originKey is short; use 32 or more random characters' });
    }
    const urlKey = proxyUrlKey(key);
    if (byUrlKey[urlKey]) {
      refused.push({ key, reason: `its link would collide with "${byUrlKey[urlKey].key}"` });
      continue;
    }
    const target = Object.freeze({
      key,
      urlKey,
      displayHost: name.host,
      displayPort: name.port,
      host: dial.host,
      port: dial.port,
      requireLogin: spec.requireLogin !== false,
      originKey: typeof spec.originKey === 'string' && spec.originKey ? spec.originKey : null,
    });
    targets[key] = target;
    byUrlKey[urlKey] = target;
  }
  return {
    targets: Object.freeze(targets),
    byUrlKey: Object.freeze(byUrlKey),
    refused,
    warnings,
  };
}

module.exports = {
  parseProxies,
  proxyUrlKey,
  parseAddress,
  isPrivateAddress,
};
