# Address bans

`/ban`, `/unban`, `/banlist` and `/checkip` on IPv4 and IPv6 addresses and
CIDR blocks, and `/poll ban` on them, beside the BZID bans and `/kick` (see
**Kicks and bans** in [installation.md](installation.md)). All of it is
built; what is left is under **Then**. Upstream references are paths under
`$HOME/bzflag/`.

## An address worth banning

A ban on an address is only worth having if a client cannot choose the
address. The startup probe (`probeAdminWhitelist` in `server.js`) answers
that for `adminWhitelist`: it fetches the server's own public URL once plain
and once with a forged `X-Forwarded-For`, and sets `forwardedForPolicy`:

- `trust-first`: the proxy replaces the header, so it holds one entry.
- `trust-last`: the proxy appends, so a forged value sits in front and the
  last entry is the address the proxy saw. bz.rikers.org is this case.
- `distrust`: anything else, or no answer. No forwarded address is used.

Address bans rest on the same answer.

### Read the address through the policy

`trustedClientAddress` (`server/sessions.cjs`) is the one reader: the peer's
own address without a forwarded header, the proxy's entry with one (the
last under `trust-last`), and null under `distrust`. The admin whitelist,
`player.clientIP` -- what a ban matches, `/playerlist` shows and a saved
score is keyed by -- and the login rate limit all read it. The header's
first entry is kept as `claimedIP`, for logs and for `/playerlist` to show
as `(unverified)`. A player with no trusted address cannot be banned by
address, only by BZID.

### Make the probe refuse a second proxy

An appending proxy behind another one -- a CDN in front of Apache -- passes
the probe as it stands: the last entry is the CDN's edge, the same on both
requests, and the forged value never reaches the end. Every player would
then have the CDN's address, and banning one would ban them all.

The probe's own request comes from this server, so the proxy's entry has to
name it (`ownAddresses`): an address on this machine
(`os.networkInterfaces()`), or a public one `https://ip4.me/api/` or
`https://ip6.me/api/` reports for it. Otherwise `distrust`, logging both. If
neither lookup answers, the local addresses stand alone, which a CDN still
fails.

Both kinds are needed. Measured on bz.rikers.org:

| Probe over | Last entry | Matches |
|---|---|---|
| IPv6 | `2607:fa18:9fff:0:db23:fe42:e45a:affa` | ip6.me, and a local address |
| IPv4 | `192.168.12.5` | a local address only; ip4.me says `166.70.97.196` |

Over IPv4 the request hairpins inside the LAN, so the proxy sees the
machine's LAN address. A home network or Azure, whose request leaves and
comes back through the router, matches the ip4.me/ip6.me answer instead.

## The ban list

- A ban is an IPv4 or IPv6 CIDR block, parsed and matched by
  `adminWhitelist`'s own `parseWhitelistEntry` and `addressMatchesWhitelist`.
  A bare address is `/32` or `/128`.
- Upstream's wildcards (`AccessControlList::convert`) are taken and turned
  into CIDR: `1.2.*.*` is `1.2.0.0/16`. A `*` that is not a whole trailing
  octet (`1.2*.3.4`, `1.*.3.4`) is refused.
- Kept in `bans.json` with the BZID bans (`server/bans.cjs`): who, until
  when, by whom, why.
- `/ban` takes a player as well as an address, as upstream's does, and bans
  that player's address.

## Where it is checked

- A browser, when it connects, on the address read through the policy.
- A BZFlag client, when it connects and before `MsgEnter`, on its socket's
  address, which needs no proxy trust. Refused with `RejectIPBanned` and
  upstream's `REFUSED:` text.
- Everybody on at the time of a ban.

A browser is checked at `joinGame`, as a BZID is, so its player sees why;
a BZFlag client at `MsgEnter`, with `RejectIPBanned` (`RejectIDBanned` for
a BZID).

`/poll ban` bans the address the target had when the poll began, for
`banTime`, as upstream's does -- and, as upstream's does, names the target
as who banned it.

## Then

- `/hostban` (reverse DNS names) and `/masterban` (the list server's shared
  list).
