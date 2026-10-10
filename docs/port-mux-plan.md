# One port

Plan for serving everything on the BZFlag port: one TCP and one UDP, so an
operator's firewall -- or `bzflag.upnp` -- has two rules to make, not four.
Issues #190 (TCP) and #189 (UDP).

## TCP: built (#190)

`server/bzflag-server.cjs` reads the first bytes of each connection on the
BZFlag port and hands it on. Every protocol here speaks first from the
client, so the opening says which it is:

| opening | goes to |
|---|---|
| `BZFLAG\r\n\r\n` | the BZFlag handler, as before |
| a TLS ClientHello (`0x16 0x03`) | the HTTPS server, when `https` is set |
| an HTTP request line (`GET`, `POST`, ...) | the web app's own `http.Server` |
| anything else | the BZFlag handler, which logs what was sent |

bzfs does the same with its non-player connections (`bzfs.cxx:6153`), which
its HTTP API serves.

The web app is Express either way: the port hands it the connection, so
routes, ETags, `Cache-Control`, Brotli sidecars and WebSocket upgrades are
the same as on a server with no `bzflag` block. Node's HTTP server reads a
socket's handle directly, past bytes put back with `unshift`, so the bytes
already read reach its parser as a `data` event; TLS reads through the stream
and takes them back with `unshift`. `scripts/test-port-mux.mjs` holds the
classification.

`https: { cert, key }` in `server.json` -- PEM files, beside it or absolute --
serves the app over TLS on the BZFlag port. A headset needs it for WebXR.
With a `bzflag` block, `listen` is the BZFlag port, so one TCP port carries
everything; a reverse proxy points at it.

Not done: HTTP/2 and HTTP/3 for the web app. The client's startup checks
whether each shared asset (images, audio, models) changed; over HTTP/1.1
those revalidations queue a few at a time on each connection, where HTTP/2
or HTTP/3 runs them all at once on one. Node's `http2` with `allowHTTP1`
would take HTTP/2, but Express 4 only partly runs on its compatibility layer
and `ws` has no WebSockets over HTTP/2. HTTP/3 comes with WebTransport below,
announced by an `Alt-Svc` header over HTTPS.

## UDP: to do (#189)

One UDP port carrying BZFlag, WebTransport and WebRTC, a browser taking the
best that connects:

1. **WebTransport** (HTTP/3) on the BZFlag port: datagrams for what bzfs
   sends over UDP, a stream for the rest. Every current browser has it;
   Safari since 26.4.
2. **WebRTC** (the UDP channel) on the same port, where WebTransport does not
   connect.
3. **WebRTC through TURN over UDP**, the voice servers' relay, for a network
   that passes UDP to the relay but not to the game. TURN over TCP or TLS is
   no better than the WebSocket, so not that.
4. **The WebSocket**, which opens first in every case and carries everything
   until one of the above does. It stays: a network with no UDP, a reverse
   proxy (Apache does not pass QUIC), and an older browser all need it.

### Telling the traffic apart

RFC 7983 and RFC 9443, by the first byte:

| first byte | traffic |
|---|---|
| 0-3 | STUN or BZFlag, by bytes 2-3 (below) |
| 20-63 | DTLS: WebRTC's data |
| 64-127, 192-255 | QUIC: HTTP/3 and WebTransport |

A BZFlag datagram starts with its length (bytes 0-1, under 1024) and its
code (bytes 2-3, two ASCII letters, 0x4141 or more). STUN starts with its
type, then its length after the 20-byte header (bytes 2-3, under 1500), then
the magic cookie `0x2112A442` (bytes 4-7). So bytes 2-3 settle it: a known
BZFlag UDP code whose length fits the datagram goes to the BZFlag handler,
and the cookie confirms STUN. QUIC must not negotiate `grease_quic_bit`
(RFC 9287), which would let its first byte fall below 64. Bytes 64-79 are
also TURN channel data, which only matters to a TURN server on this port.

STUN finds its WebRTC peer by the ICE username it carries, this end's ufrag
first, and from then on that peer owns the sender's address, which is how
DTLS from it is routed. QUIC goes to the one HTTP/3 server, which keeps its
own connections by ID.

### Owning the socket

A datagram reaches one socket, so whatever serves WebRTC and WebTransport has
to take its packets from bzo's socket and send through it:

- **werift**, WebRTC in JavaScript: its `UdpTransport.init` is swapped for a
  view of the shared socket. DTLS's AES-GCM runs in Node's `crypto`; SCTP and
  ICE are JavaScript.
- **@fails-components/webtransport** over its quiche transport: QUIC and
  HTTP/3 are native, and its server socket is a Node `dgram` socket read in
  JavaScript, so its `init` takes the shared socket in place of binding one.
- **libdatachannel** (node-datachannel, what `webrtc.listen` runs today)
  binds its own socket, and neither it nor libjuice takes packets from
  outside. It stays on its own port.

### Measured

`scripts/bench-udp-stack.mjs`: the server a child process, measured alone;
tanks at 30 moves a second, each move relayed to every tank, gathered once
per turn of the event loop and split to fit a packet as bzo does. One x86
core, the dev server running beside it, one run each. CPU is the server
process, 100% one core; delay is p99.

| tanks | libdatachannel, own port | werift, own sockets | werift, shared | WebTransport, shared | half each, shared |
|---|---|---|---|---|---|
| 2 | 4%, 1.5 ms | 11%, 2.8 ms | 11%, 2.6 ms | 8%, 3.0 ms | 11%, 2.9 ms |
| 8 | 15%, 1.8 ms | 38%, 5.1 ms | 36%, 5.4 ms | 39%, 5.4 ms | 32%, 6.7 ms |
| 16 | 33%, 2.6 ms | 66%, 12.2 ms | 66%, 10.0 ms | 69%, 12.5 ms | 79%, 10.9 ms |

Every stack delivered every move at every load, and the shared socket held
one bound port for all of them. Sharing costs nothing over werift's own
sockets. werift and WebTransport cost about twice libdatachannel, and add up
to ten milliseconds at sixteen tanks; WebTransport's quiche is native, so its
cost is crossing into JavaScript for each datagram through web streams.

### Ciphers

Encryption is about 2% of the server's CPU on every stack at sixteen tanks
(perf, symbols summed): libdatachannel 2.5%, werift 2.1%, WebTransport under
2.5% (quiche's header protection, plus at most the 2% of its module perf
cannot name). The cost is per packet -- the stack, the system calls, the
crossings into JavaScript -- not per byte, so ordering ciphers buys a
fraction of that 2%. Each stack already takes the cheap one where it can:

- werift has only AES-128-GCM.
- QUIC is TLS 1.3, and BoringSSL under quiche takes AES-128-GCM on a CPU
  with AES instructions and ChaCha20 on one without, as browsers ask.
- libdatachannel offers `ALL:...:@STRENGTH`, 256-bit first, and browsers
  settle on ChaCha20 with it (`[RTC]` logs each one's). Changing that means
  patching it, which moving off it makes moot.

### Next

WebTransport and werift on the BZFlag port, behind the BZFlag handler's own
check, retire `webrtc.listen` and its second port. Before that:

- the same load on the Orin, which is where CPU runs out;
- a browser end: Chrome and the Quest on WebTransport to this server (the
  Node client above is quiche too), and whether they send the
  `:protocol = "webtransport"` token it accepts;
- quiche's native module on arm64, which the image builds for;
- WebTransport's certificate: the `https` one, valid for the name a player
  uses, since the reverse proxy cannot carry QUIC.

## HTTP/3

WebTransport brings an HTTP/3 server on the BZFlag port. Serving the web app
over it as well, found through `Alt-Svc`, is the HTTP/2 and HTTP/3 item
under TCP above.
