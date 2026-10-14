# API

What a site that polls servers -- a stats page, a server browser -- can ask a
bzo server, and what it gets. Everything here is public: it is what any
client in the game is sent. Nothing names a player's address.

Every bzo server answers on its one port (5154 by default), HTTPS and the
BZFlag protocol alike ([network.md](network.md)).

## Finding servers

- **The BZFlag list:** a bzo server registers with the BZFlag list server as
  bzfs does, so it is in the same `db?action=LIST` reply as every bzfs.
- **The bzo list:** `GET /api/list-server/list` on the designated list server
  (bz.rikers.org). `servers` is every bzo server registered there, including
  ones not on the BZFlag list; `bzfs` is the BZFlag list as that server last
  fetched it, `bzfsCacheAgeSeconds` old. How rows get there:
  [list-server.md](list-server.md).

A `servers` row:

| Field | What |
|---|---|
| `url`, `alsoAt` | where to open it, and any other names it answers to |
| `title`, `description`, `owner`, `ownerBzid` | as the operator set them |
| `version`, `upSince` | bzo version and build; start time, ms since 1970 |
| `players`, `maxPlayers`, `bots` | counts now |
| `teamCounts`, `teamMaximums` | per team: rogue, red, green, blue, purple, observer |
| `style`, `gameOptionsBits`, `maxShots` | the game, as bzfs's ping reports it |
| `shakeTimeout`, `shakeWins`, `maxTime`, `maxTeamScore`, `maxPlayerScore` | limits |
| `map`, `world`, `overviewUrl` | map file, world hash and sizes, overview picture |
| `voiceEnabled`, `proxies` | voice chat; BZFlag servers it proxies |

A `bzfs` row is the BZFlag list's own `host`, `port`, `ip`, `owner`, `title`
and `info` (the ping packet in hex), plus what bz.rikers.org has learned by
visiting: `world.variables`, the world variables that server sets away from
BZFlag's defaults, as name to value (`{ "_tankSpeed": "40" }`), and
`world.version`, its bzfs build.

## One server

### `GET /api/players`

Everyone joined, observers included, as every client has them:

```json
{ "now": 1791849354636, "players": [ {
  "id": "41", "name": "Ace41", "bzid": null, "motto": "Ace", "team": "purple",
  "x": -318.08, "y": -18.36, "z": 30, "azimuth": -0.05,
  "forwardSpeed": 0, "rotationSpeed": 1, "verticalVelocity": 0,
  "alive": true, "paused": false, "autopilot": false, "connectedAt": 1791848012345,
  "wins": 1087, "losses": 1125, "tks": 3,
  "flag": { "type": "GM", "zoned": false },
  "clientType": "s", "link": "", "lag": 42, "jitter": 3, "loss": 0
} ] }
```

- `now` is the server's clock, ms since 1970; positions are as of it.
  `connectedAt` is when the player connected, on the same clock, and
  survives a server restart.
- `bzid` is set for a player logged in to bzflag.org.
- `clientType` and `link` are the scoreboard's `T` column
  ([network.md](network.md)): `d` desktop, `b` a BZFlag client, `s` a server
  bot, and so on, then the UDP link. `lag`, `jitter` and `loss` are
  `/lagstats`, null until measured.
- Score is `wins - losses`, as BZFlag counts it.

The reply is built at most twice a second and may be cached for one, so
polling faster gets nothing new. CORS is open.

### `GET /api/replays`

The recordings this server holds ([replay.md](replay.md)): `name`, `start`
(ms), `seconds`, `players`, `map`, `viewers`.

### `GET /api/ready`

200 once the server is serving. For a health check.

## The BZFlag protocol

What bzfs answers on its port, bzo answers the same way:

- **UDP ping:** one `MsgPingCodeRequest` (0x0404) datagram, no connection,
  gets the `PingPacket` back: game style, options, shots, shake, team counts
  and maximums, limits. The cheapest status there is; no names or scores.
- **TCP:** the `BZFLAG\r\n\r\n` handshake, then `MsgQueryGame` and
  `MsgQueryPlayers` for the game and the roster with scores, without joining
  ([bzflag-clients.md](bzflag-clients.md)). bzfs's own sources are the
  reference for the formats.

## Discovery

What a search engine, an AI or a link preview reads, served by every bzo
instance for itself (`server/discovery.cjs`):

- `/`, `/list` and `/help` carry a description, an Open Graph card and
  schema.org JSON-LD: the game on `/` and `/help`, and on `/list` every public
  bzo server as an entry with its URL, title and player count.
- `/help` is the controls ([controls.md](controls.md)) and every flag, as a
  page.
- `/robots.txt` and `/sitemap.xml` offer those three pages and keep crawlers
  off the API, maps, replays, images and sounds.
- `/llms.txt` ([llmstxt.org](https://llmstxt.org/)) says what bzo is and where
  to read more; `/llms-full.txt` inlines the controls and the flags.

## Being polite

The players reply is the cheapest of these on a bzo server. Once every few
seconds is plenty: the server is a game first.
