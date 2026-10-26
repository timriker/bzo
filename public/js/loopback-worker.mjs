/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// `?loopback`: the page's game connection goes through this Worker, which
// relays it to the server over a WebSocket of its own. It decides nothing, so
// a game played through it is the server's game, and it proves the page's
// port transport (`port-transport.mjs`) end to end before a practice Worker
// answers on the same port.
//
// The page's first message is the socket URL; after that, strings are game
// messages either way and objects are the port's open and close.

let socket = null;

self.onmessage = ({ data }) => {
  if (!socket) {
    socket = new WebSocket(data.url);
    socket.onopen = () => self.postMessage({ type: 'open' });
    socket.onmessage = (event) => self.postMessage(event.data);
    socket.onclose = (event) => {
      self.postMessage({ type: 'close', code: event.code, reason: event.reason });
      self.close();
    };
    return;
  }
  if (typeof data === 'string') {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  } else if (data?.type === 'close') {
    socket.close(data.code === 1000 || (data.code >= 3000 && data.code <= 4999) ? data.code : 1000, data.reason);
    self.close();
  }
};
