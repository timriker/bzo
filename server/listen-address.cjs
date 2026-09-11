/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// listen-address.cjs - Where the game answers: one address, host and port.
//
// `listen` carries both, the way a proxy's own config writes it -- `3000`,
// `:3000`, `127.0.0.1:3000`, `[::1]:3000`, or a bare host with no port at all.
// One setting, because a host and a port are one decision, and an operator who
// moves a server between machines moves both or neither.
//
// `port` stays, as the half of that decision people already had, and fills in
// whenever `listen` names no port. Each is read from the environment first and
// `server.json` second: a container is configured by its orchestration and a
// server by its file.
//
// Every interface by default, in both families, because that is the only answer
// that is right without being told: a container has to be reachable on the
// network Docker gave it, and a LAN game has to be reachable from the LAN. `::`
// is what covers both -- a dual-stack socket accepts an IPv4 peer as an
// IPv4-mapped address, which is why a proxy on the same host shows up in the
// log as `::ffff:127.0.0.1`.
//
// An operator who puts a reverse proxy in front wants the opposite: the game
// reachable only from that proxy, so nobody can step around it to the port and
// reach the uncertificated, uncompressed path. A loopback host here is that.

'use strict';

const DEFAULT_HOST = '::';
const DEFAULT_PORT = 3000;

// A socket binds one address family. `localhost` names both loopbacks and
// resolves to whichever the host puts first, so a server told to bind it would
// answer on one and refuse the other -- and the refused one is exactly where a
// proxy configured the other way is knocking. Resolved to the IPv4 loopback,
// which is what a proxy pointed at `localhost` most often reaches (Caddy's
// `reverse_proxy localhost:3000` connects to 127.0.0.1), and said out loud
// rather than left to be found as a connection refused.
const LOCALHOST_HOST = '127.0.0.1';

// Splits what an operator wrote into a host and a port, either of which may be
// absent. Brackets are what tell an IPv6 address from a host and port, which is
// why a URL uses them and why this does too: `::1` is an address, `[::1]:3000`
// is an address and a port, and `3000` on its own is a port.
function splitHostPort(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return { host: '', port: '' };

  const bracketed = /^\[([^\]]*)\](?::(\d+))?$/.exec(raw);
  if (bracketed) return { host: bracketed[1].trim(), port: bracketed[2] || '' };

  if (/^\d+$/.test(raw)) return { host: '', port: raw };
  if (/^:\d+$/.test(raw)) return { host: '', port: raw.slice(1) };

  // Two or more colons and no brackets is an IPv6 address written bare, which
  // cannot also be carrying a port -- there would be no way to tell where the
  // address ended.
  const colons = (raw.match(/:/g) || []).length;
  if (colons >= 2) return { host: raw, port: '' };

  if (colons === 1) {
    const [host, port] = raw.split(':');
    if (/^\d+$/.test(port)) return { host: host.trim(), port };
  }

  return { host: raw, port: '' };
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return port;
}

// The environment first, `server.json` second, and within each the address's
// own port ahead of the separate `port`. Anything unanswered falls through to
// every interface on 3000.
function resolveListenTarget({
  envListen, envPort, configListen, configPort,
} = {}) {
  const fromEnv = splitHostPort(envListen);
  const fromConfig = splitHostPort(configListen);
  const notes = [];

  let host = fromEnv.host || fromConfig.host || DEFAULT_HOST;
  if (host.toLowerCase() === 'localhost') {
    notes.push(`"localhost" names both loopbacks but a socket binds one, so this is ${LOCALHOST_HOST}.`
      + ' Write ::1 instead for the IPv6 loopback, and point the proxy at the same one.');
    host = LOCALHOST_HOST;
  }

  let port = DEFAULT_PORT;
  for (const candidate of [fromEnv.port, envPort, fromConfig.port, configPort]) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const normalized = normalizePort(candidate);
    if (normalized === null) {
      notes.push(`"${candidate}" is not a port, so this is ${DEFAULT_PORT}.`);
      break;
    }
    port = normalized;
    break;
  }

  return { host, port, note: notes.join(' ') };
}

// `http://[::1]:3000` -- an IPv6 literal is bracketed inside a URL and an IPv4
// address is not, so the line the server logs at startup can be pasted into a
// browser.
function describeListenTarget(host, port) {
  const shown = String(host).includes(':') ? `[${host}]` : String(host);
  return `http://${shown}:${port}`;
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  describeListenTarget,
  resolveListenTarget,
  splitHostPort,
};
