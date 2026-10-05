# bzfs as a web server

Plan for upstream bzfs to deliver the bzo web client itself and accept
browsers as players: one TCP and one UDP port carrying the BZFlag protocol,
HTTPS, WebSocket and HTTP/3. No list server, proxy or CDN is involved; bzfs
serves everything and the browser cache keeps it. Upstream references are
paths under `$HOME/bzflag/`.

## What upstream already has

- **TCP 5154 is already shared.** `processConnectedPeer`
  (`src/bzfs/bzfs.cxx`) makes a player of any connection that opens with
  `BZ_CONNECT_HEADER` (`BZFLAG\r\n\r\n`); anything else goes to plugins as
  `bz_eNewNonPlayerConnection`.
- **An HTTP/1.1 server is built in.** `src/bzfs/bzfsHTTPAPI.cxx` lets
  plugins register virtual directories; `plugins/fastmap` serves the world
  with it. It runs inside the single-threaded `select()` loop.
- **UDP is optional.** A client asks for it with `MsgUDPLinkRequest`; one that
  never does plays entirely over TCP. A browser on a WebSocket is that client.

## What is missing

- **Binary data on the non-player path.** The first read is copied with
  `strncpy` and appended as a C string, so a TLS ClientHello
  (`16 03 01 00 ...`) is cut at its first NUL. The event then hands plugins a
  `strdup` of the buffer with the full length, so reading `size` bytes runs
  past the copy. This has to be fixed before anything below.
- **TLS.** WebXR, the microphone and `wss:` all require a secure context.
- **WebSocket upgrade** in the HTTP API.
- **Streamed responses.** The HTTP API builds a whole response in memory
  before sending it. Assets need non-blocking, chunked sends so a large
  transfer never stalls a game tick.
- **HTTP/3 and WebTransport.**

## Detecting each protocol

TCP, by first bytes:

| Starts with | Protocol |
|-------------|----------|
| `BZFLAG\r\n\r\n` | BZFlag player |
| `0x16` | TLS; HTTP or WebSocket inside |
| an HTTP method | plain HTTP |

SNI is not needed to detect TLS. It only selects a certificate when one bzfs
answers to several names, and OpenSSL's servername callback handles that.
Encrypted ClientHello hides it only when the operator publishes an ECH DNS
record.

UDP, by the first byte: a BZFlag datagram starts with a 16-bit length, so its
first byte is below `0x40`. Every QUIC packet sets the `0x40` fixed bit.

## TLS

bzfs terminates TLS itself with OpenSSL (already a dependency through curl),
using memory BIOs so it stays non-blocking in the `select()` loop. A
TLS-sniffing passthrough to a local Caddy or nginx would keep crypto out of
bzfs, but adds a hop and a daemon for every admin to run.

**Certificates come from the operator** as a cert and key path. ACME cannot
validate a server listening only on 5154: HTTP-01 needs port 80 and
TLS-ALPN-01 needs 443. Admins use certbot or Caddy's DNS-01 support and point
bzfs at the result. Reloading on file change avoids a restart on renewal.

## Choosing the transport

Two separate decisions, made by different parties:

- **Page and assets: the browser.** The first load is always TLS over TCP
  (HTTP/1.1, or HTTP/2 if bzfs offers it in ALPN). An `Alt-Svc` header on that
  response advertises HTTP/3 on the same UDP port, and the browser moves later
  requests there if it can. bzfs does no negotiating.
- **Game connection: the client.** It tries `new WebTransport(url)` and falls
  back to `new WebSocket("wss:...")` on failure. There is no automatic
  fallback between the two.

So TLS plus WebSocket is the required path; HTTP/3 is an upgrade on top of it.
HTTP/2 gains a game socket nothing and can be skipped.

## WebSocket

Upgrade handshake (SHA-1 and base64) and RFC 6455 framing, about 300 lines.
After the upgrade the socket carries exactly the bytes a native client's TCP
stream does: same framing, same messages, same `NetHandler`. Cost is one
small frame buffer per connection.

## HTTP/3 and WebTransport

The one transport that changes gameplay: WebTransport datagrams are
unreliable and unordered, which is upstream's UDP in a browser. See
`docs/lag-plan.md` for what that requires of the move stream.

- **Library:** ngtcp2 + nghttp3 (C, MIT). OpenSSL 3.5 has the QUIC server API
  they need.
- **WebTransport** needs extended CONNECT, HTTP datagrams (RFC 9297) and the
  session handshake on top of HTTP/3. Expect to write part of that layer.
- **Event loop:** ngtcp2 reports its next timer expiry; that bounds the
  `select()` timeout.
- **Build option.** A server built without it, or with no HTTP/3 clients,
  pays nothing.

## Assets

The web client needs the textures and sounds the native client ships in
`data/` (13 MB: 82 PNG, 34 WAV, plus fonts).

- **Source:** images.bzflag.org, which already sends
  `Access-Control-Allow-Origin: *`, `ETag` and `Last-Modified`. The stock set
  is not there yet. A versioned path such as `/stock/2.4.x/` would allow
  `Cache-Control: immutable`, without which browsers revalidate every file on
  every visit.
- **Fallback:** bzfs serves a local copy, so LAN and offline servers work.
- **Client code** is served by bzfs with content-hashed names and long cache
  lifetimes.

## The bzo client

The browser speaks bzo's JSON today (`public/client.js`);
`server/bzflag-native.cjs` and `server/bzfs-session.cjs` translate to and
from the BZFlag wire on the server. Talking to bzfs directly means moving
those codecs into the client and speaking `Msg*` frames end to end, the same
direction as aligning bzo's messages to upstream. Features a stock bzfs lacks
(voice, bots, bzo replays UI) stay bzo-only.

## Plugin route

Everything except three small core patches lives in one plugin, built only by
admins who want it. Upstream reviews a few hundred lines of core instead of a
QUIC stack.

**One port for everything.** Admins run many servers on many ports, and a
port forward often carries only the game port. So the plugin answers HTTPS,
WebSocket and HTTP/3 on the server's own port, `Alt-Svc` advertises
`h3=":<port>"`, and a second port is never required.

### What today's API already provides

- `bz_eNewNonPlayerConnection`, `bz_registerNonPlayerConnectionHandler` and
  `bz_sendNonPlayerData` give a plugin raw TCP connections on the game port.
  The first handler registered for a connection owns it.
- `bz_Plugin::MaxWaitTime` bounds the `select()` timeout and `bz_eTickEvent`
  runs each pass, enough to drive QUIC timers.
- The built-in HTTP API (`bzfsHTTPAPI.cxx`) listens to the same event. The
  plugin claims TLS connections and plaintext `Upgrade: websocket` requests
  only and leaves other HTTP to it.

### What it lacks

- **No way to make a connection a player.** `MakePlayer` is not exported.
  `bz_ServerSidePlayerHandler` is a bot API: the server drives the tank from
  `setMovement(forward, turn)` and most of its callbacks are never called.
  Without a hook, the plugin can only relay each browser into
  `127.0.0.1:<port>`, which makes every web player 127.0.0.1 and breaks IP
  bans, and costs two extra sockets and a copy per player.
- **Binary on the non-player path** is truncated (see "What is missing"), so a
  TLS ClientHello arrives damaged.
- **No access to UDP.** Only core reads the game port's UDP socket.

### Core patches

1. **Binary-safe non-player input.** Append the first read with its length
   rather than as a C string, and give the event a copy of the full buffer.
2. **Attach a player to a plugin transport.** Something like
   `bz_attachPlayerTransport(connectionID, handler)`: core creates the player
   as `MakePlayer` does, keeps the connection's real address for bans and
   `bz_eAllowConnection`, sends its outbound TCP stream through the handler,
   and takes inbound BZFlag bytes the plugin has decoded from WebSocket or
   WebTransport. Datagrams the plugin receives are fed in as if from UDP.
3. **UDP demux.** In `NetHandler::udpReceive` (`src/game/NetHandler.cxx`),
   before the length is read, a datagram with the `0x40` bit set in its first
   byte returns a new code. bzfs's UDP loop (`src/bzfs/bzfs.cxx`) hands it to
   plugins as an event carrying the buffer, length and source address, inside
   the existing 250 ms receive budget. A `bz_sendUDP(addr, data, len)` sends
   from the same socket. Today such a packet is dropped silently: its first
   two bytes read as a length above 16383, larger than any datagram.

Patch 3 changes nothing for BZFlag traffic: its length field never exceeds
`MaxPacketLen`, so the first byte is always below `0x40`, and a server with no
plugin registered drops QUIC packets exactly as now.

### In the plugin

- TLS with OpenSSL memory BIOs and the operator's certificate.
- WebSocket upgrade and framing.
- Static files: client code and assets, streamed in chunks from the tick.
- ngtcp2 and nghttp3 for HTTP/3 and WebTransport on the shared UDP port.

## Cost to bzfs

| Players | Added cost |
|---------|------------|
| none on the web | none |
| per WebSocket | one TLS session, roughly 30-50 KB |
| per HTTP/3 | QUIC connection state, likely 100 KB or more (unmeasured) |

## Staging

Each step ships on its own.

1. Core: binary-safe non-player input.
2. Core: attach a player to a plugin transport.
3. Plugin: TLS with an operator-supplied certificate, plus WebSocket. The
   client works end to end over TCP on the game port.
4. Plugin: streamed asset serving with cache headers, from images.bzflag.org
   or the local copy.
5. Core: UDP demux. Plugin: HTTP/3 for page and asset loads, advertised with
   `Alt-Svc` on the game port.
6. Plugin: WebTransport for the game connection, falling back to WebSocket.
