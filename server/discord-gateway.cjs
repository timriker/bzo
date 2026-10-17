/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A connection to Discord's gateway, the WebSocket a bot hears messages on.
// Only as much of the protocol as reading one channel takes: hello and
// heartbeat, identify and resume, and dispatches handed to `onDispatch`.
// See docs/chat-bridge-plan.md, "Discord to game" (issue #193).
//
// The session is saved (`store`) after every event, so a server that restarts
// -- a dev server does on every edit -- resumes it rather than identifying
// afresh: Discord then sends what was said while it was down, and a bot that
// identifies too often in a day is locked out until the day is over.

const GATEWAY_URL = 'wss://gateway.discord.gg';
const QUERY = '/?v=10&encoding=json';

// Opcodes (Discord's "Gateway Opcodes").
const OP = Object.freeze({
  DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7,
  INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11,
});

// GUILDS, GUILD_MESSAGES and MESSAGE_CONTENT: a server's channels, the messages
// posted in them, and what those messages say.
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

// Close codes after which trying again cannot help: a bad token, intents the
// app was not granted, a gateway version gone.
const FATAL_CLOSES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 5 * 60 * 1000;

function createGateway({
  token, onDispatch, store, log, logError,
  WebSocketImpl = require('ws'), setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random,
}) {
  let session = store.load() || {};
  let socket = null;
  let heartbeat = null;
  let acked = true;
  let retryMs = RETRY_MIN_MS;
  let stopped = false;

  const save = () => {
    try {
      store.save(session);
    } catch (err) {
      logError('[DISCORD] could not save the gateway session', err);
    }
  };
  const send = (op, d) => {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify({ op, d }));
  };
  const stopHeartbeat = () => {
    if (heartbeat) clearTimer(heartbeat);
    heartbeat = null;
  };

  function connect() {
    if (stopped) return;
    const base = session.resumeUrl && session.sessionId ? session.resumeUrl : GATEWAY_URL;
    socket = new WebSocketImpl(`${base}${QUERY}`);
    socket.on('message', (data) => {
      let packet;
      try {
        packet = JSON.parse(String(data));
      } catch {
        return;
      }
      receive(packet);
    });
    socket.on('close', (code) => closed(code));
    socket.on('error', (err) => log(`[DISCORD] gateway error: ${err.message}`));
  }

  function closed(code) {
    stopHeartbeat();
    socket = null;
    if (stopped) return;
    if (FATAL_CLOSES.has(code)) {
      log(`[DISCORD] gateway closed ${code}; not reconnecting (check the token and the app's intents)`);
      return;
    }
    log(`[DISCORD] gateway closed ${code}; reconnecting in ${Math.round(retryMs / 1000)}s`);
    setTimer(connect, retryMs);
    retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
  }

  function beat(intervalMs) {
    stopHeartbeat();
    acked = true;
    const tick = () => {
      // No acknowledgement since the last one: the connection is a zombie, so
      // close it and resume on a fresh one.
      if (!acked) {
        log('[DISCORD] gateway heartbeat unanswered; reconnecting');
        socket?.close(4000);
        return;
      }
      acked = false;
      send(OP.HEARTBEAT, session.seq ?? null);
      heartbeat = setTimer(tick, intervalMs);
    };
    // The first one jittered, as Discord asks, so a fleet does not beat in step.
    heartbeat = setTimer(tick, Math.floor(intervalMs * random()));
  }

  function receive({ op, d, s, t }) {
    if (s !== null && s !== undefined) {
      session.seq = s;
    }
    switch (op) {
      case OP.HELLO:
        beat(d.heartbeat_interval);
        if (session.sessionId && session.seq !== undefined) {
          send(OP.RESUME, { token, session_id: session.sessionId, seq: session.seq });
        } else {
          send(OP.IDENTIFY, {
            token,
            intents: INTENTS,
            properties: { os: process.platform, browser: 'bzo', device: 'bzo' },
          });
        }
        break;
      case OP.HEARTBEAT_ACK:
        acked = true;
        break;
      case OP.HEARTBEAT:
        send(OP.HEARTBEAT, session.seq ?? null);
        break;
      case OP.RECONNECT:
        socket?.close(4000);
        break;
      case OP.INVALID_SESSION:
        // `d` says whether the session can still be resumed; when it cannot,
        // the next connection identifies afresh.
        if (!d) session = {};
        save();
        socket?.close(4000);
        break;
      case OP.DISPATCH:
        if (t === 'READY') {
          session = { sessionId: d.session_id, resumeUrl: d.resume_gateway_url, seq: session.seq };
          retryMs = RETRY_MIN_MS;
          log(`[DISCORD] gateway ready as ${d.user?.username}`);
        } else if (t === 'RESUMED') {
          retryMs = RETRY_MIN_MS;
          log('[DISCORD] gateway resumed');
        }
        save();
        try {
          onDispatch(t, d);
        } catch (err) {
          logError(`[DISCORD] ${t} handler failed`, err);
        }
        break;
      default:
        break;
    }
  }

  return {
    start: connect,
    stop() {
      stopped = true;
      stopHeartbeat();
      socket?.close(1000);
    },
  };
}

module.exports = { createGateway, INTENTS, OP };
