/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Every server bot's pilot and tank, off the server's own thread: a pilot
// planning a route across a big map takes tens of milliseconds, and the game
// on that thread stops for as long. The server starts this when it has a bot
// and ends it when it has none (`server.js`, "Server bots").
//
// What a bot sees comes in as one snapshot of the game a tick, the part every
// bot shares and the part that is each bot's own; what it does goes back as the
// messages its client would send, in order, split where the server makes a
// client's per-frame checks (`act`) so they land where they always did. The
// world itself -- obstacles, colliders, routes -- is held in
// `public/js/bot-host.mjs`, which offline play runs its bots by too.
//
// In:  world   { obstacles, mapSize, noWalls, wallHeight, waterLevel }
//      config  GAME_CONFIG, whenever it changes
//      add     { id, pilotId }       remove  { id }
//      tick    { dt, shared, bots: [own], followId, report }
//      halt    { bots: [own] } stop every tank where it is, and say so: sent
//              once a second while nobody is connected, as each bot's
//              heartbeat
// Out: results { bots: [{ id, pre, self, post, mode, targetId, intent?, report? }] }
//      error   { id, message }

const { parentPort } = require('worker_threads');

let host = null;
const waiting = [];

function handle(message) {
  switch (message.type) {
    case 'world': host.setWorld(message.world); break;
    case 'config': host.setConfig(message.config); break;
    case 'add': {
      const error = host.addBot(message);
      if (error) parentPort.postMessage({ type: 'error', id: message.id, message: error });
      break;
    }
    case 'remove': host.removeBot(message.id); break;
    case 'tick': parentPort.postMessage({ type: 'results', bots: host.tick(message) }); break;
    case 'halt': parentPort.postMessage({ type: 'results', bots: host.halt(message) }); break;
    default: break;
  }
}

parentPort.on('message', (message) => {
  if (host) handle(message);
  else waiting.push(message);
});

import('../public/js/bot-host.mjs').then((module) => {
  host = module;
  host.onError((id, message) => parentPort.postMessage({ type: 'error', id, message }));
  for (const message of waiting.splice(0)) handle(message);
}).catch((error) => {
  parentPort.postMessage({ type: 'error', id: null, message: `pilots did not load: ${error.message}` });
});
