# Installing and running a bzo server

Everything needed to put a bzo server on the internet: install it, configure
it, put it behind a reverse proxy, list it, and point it at BZFlag servers you
already run. `README.md` is what bzo *is*; this is how to run one.

## Install with Docker

### Quick start with docker compose

Use [compose.yml](../compose.yml):

```bash
docker compose up -d
```

This starts the server on port 3000, with 5154 open for BZFlag clients, and
stores runtime config in `./data/server.json`.

On first start, the server copies [example-server.json](../example-server.json)
to the configured runtime path if no config exists.

Its `bzdb` block is upstream's command-line `-set`: world variables by
upstream's names and as upstream writes the values, `"_tankSpeed": "30"` or
`"_shotRange": "_shotSpeed * 3.5"`. A map's own `-set` lines go over it, and
`/set` and `/reset` change it while the server runs. [docs/bzdb.md](bzdb.md)
lists the variables bzo reads, with their defaults. A server.json from before
the block still works: its old keys (`tankSpeed`, `gravity`, `shotDuration` and
the rest) are read as the variables they were, and the startup log names each
one to move.

Then open:

- `http://localhost:3000`

The image is multi-arch (`linux/amd64` and `linux/arm64`), so Docker will pull the
correct variant for your host by default.

If you need to force an architecture, set `platform` in compose:

```yaml
services:
  bzo:
    image: ghcr.io/timriker/bzo:latest
    platform: linux/amd64 # or linux/arm64
    volumes:
      - ./data:/data
```

### Direct docker run

```bash
docker run -d \
  --name bzo \
  -p 3000:3000 \
  -p 5154:5154 -p 5154:5154/udp \
  -v bzo-data:/data \
  ghcr.io/timriker/bzo:latest
```

Port 5154, TCP and UDP, is for BZFlag clients, and only does anything once
server.json has a `bzflag` block (**On the BZFlag list** below).

The image defaults to `SERVER_CONFIG_PATH=/data/server.json`.

To force a specific architecture when running directly:

```bash
docker run -d \
  --name bzo \
  --platform linux/amd64 \
  -p 3000:3000 \
  -p 5154:5154 -p 5154:5154/udp \
  -v bzo-data:/data \
  ghcr.io/timriker/bzo:latest
```

Use `--platform linux/arm64` on ARM hosts if you want to pin that explicitly.

### Docker data persistence

- Persist server settings and runtime config by mounting `/data` (already done in
  `compose.yml`).
- `SERVER_CONFIG_PATH` defaults to `/data/server.json`.
- `/data` holds three things, all of which want to survive an image upgrade:
  `server.json`, the maps in `/data/maps`, and `/data/cache`. The cache is
  where parsed worlds, their overview pictures and the world hashes bzo has
  collected from other servers live -- rebuilding it means downloading every
  listed server's world again, which is why it is not inside the image.
  `CACHE_PATH` moves it elsewhere; it is much the largest of the three.
- The container runs as UID/GID `1000:1000`; for bind mounts, ensure the host
  `./data` directory is writable by that user (for example `chown -R 1000:1000 ./data`).

### Persisting custom maps (optional)

Built-in maps ship inside the image at `/app/maps`.

Runtime map uploads and operator-managed custom maps are stored in a writable
runtime maps directory that defaults to `$(dirname $SERVER_CONFIG_PATH)/maps`.
With the default Docker settings, this is `/data/maps`, which is already
persisted by the existing `./data:/data` volume.

No extra volume is required for operator uploads to persist across restarts.

If you want to override the runtime map directory, set `MAPS_PATH`:

```yaml
services:
  bzo:
    image: ghcr.io/timriker/bzo:latest
    environment:
      SERVER_CONFIG_PATH: /data/server.json
      MAPS_PATH: /data/maps
    volumes:
      - ./data:/data
```

You can still provide static read-only maps in the image path, but uploaded maps
should go to the runtime directory.

Replays work the same way: the bundled sample ships at `/app/replays`, uploads
go to `$(dirname $SERVER_CONFIG_PATH)/replays`, and `REPLAYS_PATH` overrides
that. The Operator panel deletes only what it uploaded, which it records in
`uploads.json` beside `server.json`.

## Install from source

### Prerequisites

- Node.js 18.19.1 or Node.js 24.19.0
- npm

### Setup

```bash
npm install
```

If `server.json` does not exist, the server will create it from
[example-server.json](../example-server.json) on first start.

### Run

Production:

```bash
npm start
```

Development:

```bash
npm run dev
```

Then open:

- `http://localhost:3000`

## Configuration

Runtime configuration lives in `server.json` by default.

You can override the path with:

```bash
SERVER_CONFIG_PATH=/path/to/server.json npm start
```

See [example-server.json](../example-server.json) for the supported shape.
`"mapFile": "random"` generates a world as bzfs does, tuned by a
`randomWorld` block -- see **Generated worlds** in [bzw.md](bzw.md).

### Voice

Voice is peer to peer, and is offered only with at least one
`voiceIceServers` entry. STUN alone connects most players; a TURN relay
reaches the rest (mobile carriers, strict NATs). For a coturn server
with `use-auth-secret`, list its URLs without a username and set
`voiceTurnSecret` to its `static-auth-secret`:

```json
"voiceIceServers": [
  { "urls": ["stun:turn.example.org:3478"] },
  { "urls": ["turn:turn.example.org:3478?transport=udp",
             "turn:turn.example.org:3478?transport=tcp",
             "turns:turn.example.org:443?transport=tcp"] }
],
"voiceTurnSecret": "same value as coturn's static-auth-secret"
```

Each player then gets their own credential, valid for 24 hours.

Phones keep voice on IPv4: some carriers (Verizon, at least) drop a phone's
whole data connection when a WebRTC call runs over its IPv6. Give them the
same servers by a name with no IPv6 address, or they reach the relay over
IPv6 anyway:

```json
"voiceIceServersIpv4": [
  { "urls": ["stun:turn4.example.org:3478"] },
  { "urls": ["turn:turn4.example.org:3478?transport=udp",
             "turn:turn4.example.org:3478?transport=tcp",
             "turns:turn4.example.org:443?transport=tcp"] }
]
```

The TLS name has to be on the relay's certificate too.

## Behind a reverse proxy

Terminate TLS at the proxy and serve the game over `https://`; the client uses
`wss://` for its WebSocket whenever the page is HTTPS. WebXR needs a secure
context, so this is not optional for headsets.

Apache's `mod_proxy` sends `X-Forwarded-For`, `X-Forwarded-Host` and
`X-Forwarded-Server` on its own, but **not** `X-Forwarded-Proto` or
`X-Forwarded-Port`. Add them in the HTTPS vhost, with `mod_headers` enabled, or
the server logs every connection as plain HTTP:

```apache
RequestHeader set X-Forwarded-Proto "https"
RequestHeader set X-Forwarded-Port  "443"
# mod_proxy appends to X-Forwarded-For, so pin it to the real peer rather than
# letting a client prepend an address of its choosing.
RequestHeader set X-Forwarded-For   "expr=%{REMOTE_ADDR}"
```

`set` rather than `add`, so a header a client sent cannot survive the hop.

### Admin without a login

`"localAdmin": true` makes a connection from this machine an operator without
a bzflag.org login -- for a headless test client, not for a public box. A
loopback peer counts only with no `X-Forwarded-*` header, since a same-host
proxy makes every request arrive from `127.0.0.1`.

`adminWhitelist` widens it to more addresses: a list of IPv4 or IPv6
addresses or CIDR blocks (`"192.168.1.0/24"`, `"2001:db8::/32"`). These
arrive through the proxy, so they need `publicUrl`: at startup the server
calls itself there, once with a forged `X-Forwarded-For`, and trusts the
header only if the proxy replaced or appended to it as above. Until that
probe passes, only unproxied loopback is admin. Bad entries are logged and
refused, and the log warns when the whitelist names non-loopback addresses
but `localAdmin` is off, since it then does nothing. A whitelisted operator
can also read and revoke list-server keys (`docs/list-server.md`).

## Listing your server

A bzo server is listed by registering one key with the designated bzo list
server -- `bz.rikers.org` unless you have changed `listServerUrl` -- and
pasting that key into this server's Operator panel.

1. Set `publicUrl` in `server.json` to this server's own `https://` URL. The
   list server calls it back, so it has to be reachable.
2. Open `https://bz.rikers.org/list#keys`, log in with your bzflag.org forum
   account, and register a key for that same URL.
3. In bzo, open the Operator panel and paste it into the List Server Key row.
   It takes effect at once; no restart.

Your row appears on every bzo instance's `/list`. A `bzfs` server's key is a
different key from <https://my.bzflag.org/listkeys/> and does not go here.

`docs/list-server.md` has the protocol, the validation callback, key lifetime
and what a row carries.

### On the BZFlag list

A `bzflag` block also lists the server where BZFlag clients look, with a
`bzfs` key from <https://my.bzflag.org/listkeys/>:

```json
"bzflag": {
  "listen": "0.0.0.0:5154",
  "publicAddr": "your.host:5154",
  "publicKey": "<key>"
}
```

The list shows server.json's `title` with the map's name after it. The
port, TCP and UDP, has to be reachable at `publicAddr`, and the host
name has to resolve to this server's IPv4 address. BZFlag clients join and
play beside bzo's own; [docs/bzflag-clients.md](bzflag-clients.md) has the
details.

## Proxying BZFlag servers

A bzo instance can carry a browser into an ordinary `bzfs` game. Name each
server in `proxies`, from the name players see to the address bzo dials:

```json
"proxies": {
  "example.org:5154": "127.0.0.1:5154",
  "my-test:5155":     "192.168.12.20:5155"
}
```

The key is the identity -- for a listed server, exactly the `host:port` the
public BZFlag list carries. The value is private on purpose: a forwarded
global login only verifies when bzfs sees the connection arrive from
127/8, 10/8, 172.16/12 or 192.168/16, so **bzo has to run inside its target's
network**, which in practice means on the same host. Each target gets a row
on `/list` and a link of its own:

```text
https://your-bzo.example.com/?proxy=example.org_5154
```

`docs/proxy.md` has what a proxied player gets, what they do not, and why.

## Bots

The server can keep its game at a size with bots of its own:

```json
"bots": { "fill": 4, "pilot": "ace" }
```

That is four players: a bot for each place people leave empty, and none once
four people are playing. Observers watch rather than take a place. With nobody
connected the bots idle until somebody arrives. `pilot` is `roger` (upstream's
autopilot) or `ace`.

An operator changes it live with `/bot fill <n> [pilot]`, adds bots outside
the fill with `/bot add [pilot] [team] [count]`, removes them with
`/bot remove <name|all>`, and sees what is running with `/bot`.
`"disableBots": true`, or `-disableBots` in a map's options, turns all
of it off, autopilot included. `AGENTS.md` (the `docs/bots-plan.md`
paragraph) has how they work.

## Kicks and bans

An admin's `/kick <player> <reason>` removes a player, and
`/idban <player|+bzid> <duration> <reason>` bans a signed-in player's
bzflag.org account, as on a BZFlag server: `30m`, `1h`, `1w2d`, `forever`,
or `short` for server.json's `banTime` (300 minutes by default).
`/idbanlist` and `/idunban <bzid>` read and lift them. `/ban <player|ip>
<duration> <reason>` bans an address or a block -- `1.2.3.4`, `1.2.*.*`,
`1.2.0.0/16`, an IPv6 `2001:db8::/32` -- and a named player's BZID with it;
`/banlist`, `/checkip <ip>` and `/unban <ip>` go with it. Behind a reverse
proxy bzo bans only an address its startup check of that proxy vouches for
([ban-plan.md](ban-plan.md)). Bans are kept in
`bans.json` beside `server.json`. A kicked or banned browser stays off
until its player presses a key, taps or pulls a trigger, rather than
rejoining by itself.

## Polls

Players vote as on a BZFlag server: `/poll kick <player>`, `/poll flagreset`,
`/poll kill <player>` and `/poll set <variable> <value>`, then `/vote yes|no`,
and an admin's `/veto`. Signed-in players may start kick and flag reset polls
and vote; kill and set polls are an admin's, as in BZFlag's default groups,
and only an admin may poll against an admin. A poll needs two votes
besides its starter's and 50.1% in favour. server.json's `poll` block takes
BZFlag's `-poll` settings, and `"voteTime": 0` turns polls off:

```json
"poll": { "voteTime": 60, "vetoTime": 2, "votesRequired": 2, "votePercentage": 50.1, "voteRepeatTime": 300 }
```

## Updating

### Source installs

There is no built-in self-update path for source installs.

To update, download a newer release or pull newer source, then run:

```bash
npm install
```

### Docker installs

Docker is the recommended update path.

Manual update:

```bash
docker compose pull
docker compose up -d
```

or:

```bash
docker pull ghcr.io/timriker/bzo:latest
```

If you want automatic container updates, use your preferred container update
manager. That is not built into the game itself.
