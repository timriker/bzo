# Telling bzfs who a proxied player is

A proxied player reaches bzfs from bzo's address, so the server sees the proxy
and not the player ([proxy.md](proxy.md#what-a-target-operator-sees)). A bzfs
running the **proxyOrigin** plugin can be told each player's own address and,
where bzo verified it, their BZID. Both ends share a secret; nothing changes
on a server without the plugin or without the key.

## Detection

The plugin sets the public BZDB variable `_proxyOrigin` to its protocol
version, `1`. bzo reads it from the variables every joiner gets. When it is at
least 1 and the proxy entry has an `originKey`, bzo sends `/origin` once, just
after joining. Otherwise it sends nothing, so a player never sees "Unknown
command".

The key is never in BZDB, since every client reads BZDB. It is in two places
only: the plugin's config and the proxy entry in bzo's `server.json`:

```json
"proxies": {
  "whammo.bmbz.org:5159": { "address": "127.0.0.1:5159", "originKey": "<same secret>" }
}
```

Use one key per server, 32 or more random characters. bzo warns at startup
about a key under 16.

## The line

```text
/origin <ip> <bzid> <unixtime> <mac>
```

- `<ip>`: the player's address as bzo trusts it (`X-Forwarded-For` only from
  a front proxy bzo has confirmed). IPv4 or IPv6; a v4-mapped IPv6 address is
  sent as plain IPv4.
- `<bzid>`: the forum account bzo verified at its own `/login`, under the same
  callsign the player has on the server. `0` when bzo did not verify one --
  a guest, a player not logged in to bzo, or a login made only for the
  proxied server, whose token bzfs checks itself.
- `<unixtime>`: seconds since 1970.
- `<mac>`: the first 32 lowercase hex characters (128 bits) of HMAC-SHA256,
  keyed with the shared secret, over these four lines joined by `\n` with no
  trailing newline:

  ```text
  <ip>
  <bzid>
  <unixtime>
  <callsign>
  ```

  `<ip>` and `<bzid>` exactly as sent; `<callsign>` as the server has it, so a
  line cannot be reused for another player.

The MAC is cut to 32 characters so the widest line, an IPv6 address with an
eight-digit BZID, fits bzfs's 128-byte message.

## What the plugin should do with it

- Accept it only from a configured proxy address, inside a time window (±120
  s), once per player.
- Treat a nonzero BZID as bzo's verified login: whoever holds the key can
  claim any BZID on that server, so the key is as sensitive as an admin
  password.
- Apply the server's IP bans to the address.

bzo never passes on an `/origin` a player types. bzfs records server commands
in a replay, so a recording holds the line, address included.
