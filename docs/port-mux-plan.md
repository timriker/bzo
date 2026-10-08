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
| an HTTP request line (`GET `, `POST `, ...) | the web app's own `http.Server` |
| anything else | the BZFlag handler, which logs what was sent |

bzfs does the same with its non-player connections (`bzfs.cxx:6153`), which
its HTTP API serves.

The web app is Express either way: the port hands it the connection, so
routes, ETags, `Cache-Control`, Brotli sidecars and WebSocket upgrades are
identical on the BZFlag port and on `listen`. Node's HTTP server reads a
socket's handle directly, past bytes put back with `unshift`, so the bytes
already read reach its parser as a `data` event; TLS reads through the stream
and takes them back with `unshift`. `scripts/test-port-mux.mjs` holds the
classification.

`https: { cert, key }` in `server.json` -- PEM files, beside it or absolute --
serves the app over TLS on the BZFlag port. A headset needs it for WebXR.
`"listen": false` turns the separate web port off, leaving one TCP port for
everything; a reverse proxy then points at the BZFlag port.

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
   twice, so its CPU wants measuring on the Orin before it is built: a spike
   relaying one client, then a bench. All bzo code; the likeliest route.
2. **A JavaScript WebRTC stack** (werift) fed from bzo's own socket. Clean,
   at a bigger CPU cost.
3. **libjuice taking external packets**: native work, upstream or a fork.
4. **Kernel steering**: an iptables `u32` rule sending STUN and DTLS on the
   BZFlag port to the channel's port. No code, but per host, and awkward under
   Docker -- the opposite of the point.

Until then WebRTC keeps its own port (`webrtc.listen`, 5153).

Listening dual-stack is fine; clients still come in on IPv4 -- BZFlag cannot
do IPv6, and the move channel offers IPv4 only (a phone on Verizon drops its
data session over WebRTC on IPv6).

## HTTP/3: after both

QUIC needs the UDP socket (#189), a certificate (the `https` above), and a
QUIC stack in userland, since Node's is experimental. A browser finds it
through an `Alt-Svc` header sent over HTTPS.
