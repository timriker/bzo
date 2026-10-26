/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A game connection over a `MessagePort` or a `Worker`, shaped like the
// WebSocket the client otherwise holds: `readyState` with WebSocket's own
// numbers, `send(text)`, `close()`, and `onopen`, `onmessage`, `onclose` and
// `onerror`. So `ws` can be either, and nothing that sends, receives or checks
// `ws.readyState === WebSocket.OPEN` has to know which.
//
// On the port a game message is a string, the same JSON a socket carries, and
// a plain object is the connection's own signalling, which the far end of a
// socket gets from the socket itself:
//
//   { type: 'open' }                 the far end is ready (`onopen`)
//   { type: 'close', code, reason }  either end is done (`onclose`)

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

export function createPortTransport(port) {
  const transport = {
    readyState: CONNECTING,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(text) {
      if (transport.readyState !== OPEN) return;
      port.postMessage(text);
    },
    close(code = 1000, reason = '') {
      if (transport.readyState === CLOSING || transport.readyState === CLOSED) return;
      transport.readyState = CLOSING;
      port.postMessage({ type: 'close', code, reason });
      // A socket reports its own close() too, once it has happened.
      queueMicrotask(() => finish(code, reason));
    },
  };

  const finish = (code, reason) => {
    if (transport.readyState === CLOSED) return;
    transport.readyState = CLOSED;
    port.onmessage = null;
    transport.onclose?.({ code, reason, wasClean: true });
  };

  port.onmessage = ({ data }) => {
    if (typeof data === 'string') {
      if (transport.readyState === OPEN) transport.onmessage?.({ data });
      return;
    }
    if (data?.type === 'open' && transport.readyState === CONNECTING) {
      transport.readyState = OPEN;
      transport.onopen?.({});
    } else if (data?.type === 'close') {
      finish(data.code ?? 1006, data.reason ?? '');
    }
  };
  port.onmessageerror = (event) => transport.onerror?.(event);
  port.start?.();
  return transport;
}
