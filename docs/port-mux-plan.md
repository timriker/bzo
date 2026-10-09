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

Not done: HTTP/2. Node's `http2` with `allowHTTP1` would take it, but
Express 4 only partly runs on the compatibility layer and `ws` has no
WebSockets over HTTP/2, so it would speed asset loads and nothing else.

## UDP: to do (#189)

Telling the traffic apart is settled (RFC 7983, RFC 9443), by the first byte:

| first byte | traffic |
|---|---|
| 0-3 | STUN, or a BZFlag frame (its length is under 1024); STUN carries the magic cookie `0x2112A442` at bytes 4-7 |
| 20-63 | DTLS: WebRTC's data |
| 64-127, 192-255 | QUIC: HTTP/3 |

Owning the socket is not. A datagram goes to one socket only, so there is
nothing to push back the way TCP's opening bytes are. node-datachannel binds
its own UDP port, and neither it nor libjuice beneath it takes a socket or a
packet from outside: its bindings offer `IceUdpMuxListener`, which reports
only unknown STUN back, and `proxyServer`, which is for going out through an
HTTP or SOCKS proxy; libjuice's `juice.h` has no external socket and no
user-fed packets, and every `concurrency_mode` keeps the socket inside. The
ways through:

1. **A relay in bzo.** bzo owns the BZFlag port and forwards STUN and DTLS to
   libdatachannel on loopback, sending its replies back out. One loopback
   socket per client, so each client is a distinct peer to it -- a small NAT
   table with an idle timeout -- and the port in the candidates it offers
   rewritten to the BZFlag port. ICE takes this: each STUN check is signed
   and carries the session's username. Every datagram crosses JavaScript
   twice -- measured below.
2. **A JavaScript WebRTC stack** (werift) fed from bzo's own socket: its
   `UdpTransport.init` can be swapped for one on bzo's socket, routed by the
   ICE username -- measured below.
3. **libjuice taking external packets**: native work, upstream or a fork.
4. **Kernel steering**: an iptables `u32` rule sending STUN and DTLS on the
   BZFlag port to the channel's port. No code, but per host, and awkward under
   Docker -- the opposite of the point.

### Measured

A spike ran 16 clients at 30 moves a second, the server relaying each to the
other 15, on one x86 core:

| server | CPU | relayed a second | p50 | p99 |
|---|---|---|---|---|
| libdatachannel on its own port | 39% | 7,080 | 3.0 ms | 9 ms |
| relay through loopback | 94-99% | 7,075 | 11 ms | 31-43 ms |
| werift on the shared socket | 136% | ~380 (3% delivered) | ~500 ms | ~23 s |

Both shared sockets routed a BZFlag datagram to bzo rather than to WebRTC,
so the sorting works; the cost is what fails. werift falls over under game
load -- its DTLS and SCTP are JavaScript. The relay works at two and a half
times the CPU and eight milliseconds more, which the Orin cannot spare, and
it needs a loopback socket per client with libdatachannel seeing only
127.0.0.1. The harness sent each move as its own message where bzo gathers
them, so every figure would be lower in bzo; the order would not change.

### Next

The way to one UDP port at native cost is option 3: libjuice already runs
every connection on one socket (`JUICE_CONCURRENCY_MODE_MUX`). It needs a
callback for a datagram it does not recognise -- handing BZFlag's to bzo --
and a send on that socket, so bzo answers from the same port. That is a small
change, worth offering upstream, then exposing through node-datachannel.

Until then WebRTC keeps its own port (`webrtc.listen`, 5153).

Listening dual-stack is fine; clients still come in on IPv4 -- BZFlag cannot
do IPv6, and the move channel offers IPv4 only (a phone on Verizon drops its
data session over WebRTC on IPv6).

## HTTP/3: after both

QUIC needs the UDP socket (#189), a certificate (the `https` above), and a
QUIC stack in userland, since Node's is experimental. A browser finds it
through an `Alt-Svc` header sent over HTTPS.
