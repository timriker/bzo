# bzo on your BZFlag server

bzo is a browser BZFlag client and server. Its server list, `/list`, shows
every server on the public BZFlag list with a picture of its world, lets a
browser view that world, and lets a browser watch or play there through a
proxy. To do that, a bzo server sometimes connects to yours. This page says
what it does, when, and how to ask it to stop.

## What you may see

- **A connection that never joins.** Most visits only ask your world's hash
  (`MsgWantWHash`), on a socket that never enters the game. Nobody sees it.
- **`bzo-import` joining as an observer, then leaving.** This happens when
  your world is new to bzo or its hash changed. bzo downloads the world, then
  joins for a moment to read your BZDB variables, which bzfs sends only to a
  player who has joined. Its motto is `bzo server check -- <url>/list`, the
  page where what it learned is shown.
- **The same visitor checking what a guest may do.** About once a month it
  asks whether an unregistered player may watch, chat and spawn. Chat is one
  private message to itself, never public chat. It spawns only when nobody is
  on your server, and leaves at once.
- **`bzo-view-…` observers, and players from a bzo server.** These are
  people watching or playing through bzo, not checks.

## How often

Only the bzo server that runs bzo's own list, bz.rikers.org, checks the whole
list in the background. Other bzo servers connect only when one of their
players opens your server.

| What | When |
|---|---|
| world hash check | once a day; hourly for a world bzfs generates, which usually changes on restart; sooner when your list entry changes |
| world download and `bzo-import` join | only when the hash changed, or bzo has no picture of the world |
| guest check | a month after the last answer, a week after one that got none; across the whole list, at most one such visit every ten minutes |
| any of the above, failing | retried after 6 hours, doubling each time, up to a week |

Background work is spread out: at most one server is checked every 30
seconds, and at most one world is downloaded a minute. A world viewed on bzo is
reused for an hour before your server is asked anything again.

## Asking bzo to stay away

Ask the operator of the bzo server you see (its address is in the visitor's
motto), or open an issue at
[github.com/timriker/bzo](https://github.com/timriker/bzo/issues). They add
your server to `excludeServers` in their `server.json`:

```json
"excludeServers": ["bzflag.example.org:5154", "other.example.org"]
```

A bare host covers every port on it. That bzo server then never connects to
it: no hash checks, no downloads, no `bzo-import` visits, and no viewing or
watching it from that server. Players can still open your server in a real
BZFlag client from `/list`.

Technical detail: [network.md](network.md) "Talking to a real bzfs" for the
join, [proxy.md](proxy.md) "Guest access" for the guest check.
