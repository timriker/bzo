# bzo on your BZFlag server

bzo is a browser BZFlag client and server. Its server list, `/list`, shows
every server on the public BZFlag list with a picture of its world, lets a
browser view that world, and lets a browser watch or play there through a
proxy. To do that, a bzo server sometimes connects to yours. This page says
what it does, when, and how to be left out of its checks.

## What bzo reads

Only what your server sends any BZFlag client that joins it: the binary world
(`MsgGetWorld`) and the game settings and BZDB variables a client needs to
play. Where your server offers a cache URL (`-cache`, or the `fastmap`
plugin), bzo downloads the world from it as a BZFlag client does, if it is
on the host bzo dialled and its MD5 matches your world hash; otherwise over
the game protocol. That is not your `.bzw`. bzfs never sends the map file,
so bzo never has it, nor its comments, author or license.

bzo rebuilds the world from what your server sent in order to draw it: the
same world a BZFlag client exports with `/saveworld`. That `.bzw` stays on
the bzo server. Browsers download bzo's own conversion of it, the shapes they
need to draw and play, and bzo never offers the `.bzw` for download.

### Where `/list`'s facts come from

| What | From | Connects to your server? |
|---|---|---|
| players and teams, shots, game style, superflags, jumping, ricochet, IP, owner | the public list server, my.bzflag.org | no |
| world hash, title, limits | a query on a socket that never joins (`MsgQueryGame`, `MsgWantSettings`, `MsgWantWHash`) | yes, without joining |
| the world itself | `MsgGetWorld`, or your cache URL | yes, without joining |
| BZDB variables, version, what a guest may do | a short join, since bzfs sends these only to a player who has joined | yes, joins |

## Only public servers

bzo reads the public BZFlag list as an anonymous client, and contacts a server
only while it is on that list. A private server, one not on the list, and a
restricted one, listed only for certain groups, never appear there, so bzo
never contacts them. A server that leaves the list is not contacted again.
The one exception is a bzo server's own proxies (docs/proxy.md), which its
operator configures for servers they run.

## What you may see

- **A connection that never joins.** Most visits only ask your world's hash
  (`MsgWantWHash`), on a socket that never enters the game. Nobody sees it.
- **`bzo-list` joining as an observer, then leaving.** This happens when
  your world is new to bzo or its hash changed. bzo fetches the world, then
  joins for a moment to read your BZDB variables, which bzfs sends only to a
  player who has joined. Its motto is `see: <url>/list about:
  <url>/bzo-list`: the page where what it learned is shown, and a link to
  this page.
- **`bzo-view` doing the same, with the same motto.** A player on a bzo
  server asked to see or practise on your map, and that bzo server had no
  current copy. It asks no guest questions.
- **The same visitor checking what a guest may do.** About once a month it
  asks whether an unregistered player may watch, chat and spawn. Chat is one
  private message to itself, never public chat. It spawns only when nobody is
  on your server, and leaves at once.
- **`bzo-view-…` observers, and players from a bzo server.** These are
  people watching or playing through bzo, not checks.

The callsign says why bzo is there, and its version ends in the same name
(`1.4.7-bzo-list`):

| Callsign | Why | From |
|---|---|---|
| `bzo-list` | the background check of the list: your world, its variables, guest access | bz.rikers.org |
| `bzo-list` | keeping a proxy target's world current | a bzo server whose operator proxies yours |
| `bzo-view` | a player opened your map: View map, Practice, Import, `?viewmap=`, an operator's `/import` | a bzo server with `viewOtherServers` on, or whose operator imported it |
| `bzo-view-<6 hex>` | a player watching through bzo, not signed in | any bzo server |
| `bzo-<callsign>` | a signed-in bzo admin playing on a server bzo does not proxy | any bzo server |
| a player's own callsign | a player watching, or playing on a proxy, through bzo; its motto names the bzo server | any bzo server |

## How often

Only the bzo server that runs bzo's own list, bz.rikers.org, checks the whole
list in the background. A bzo server fetches your world for a player only if
its operator set `viewOtherServers`; bz.rikers.org does.

| What | When |
|---|---|
| world hash check | once a day; hourly for a world bzfs generates, which usually changes on restart; sooner when your list entry changes |
| world fetch and `bzo-list` join | only when the hash changed, or bzo has no picture of the world |
| guest check | a month after the last answer, a week after one that got none |
| any of the above, failing | retried after 6 hours, doubling each time, up to a week |
| a server that bans bzo | one join a month, asking whether the ban still stands |

Background work is spread out over all the public servers together, not per
server: at most one server is checked every 30 seconds, one world fetched a
minute, and one guest check made every ten minutes. A world viewed on bzo is
reused for an hour before your server is asked anything again.

## Asking bzo to leave you out

Background checks come only from bzo's list server, bz.rikers.org. Ask its
operator, or open an issue at
[github.com/timriker/bzo](https://github.com/timriker/bzo/issues), to add
your server to `excludeServers` in its `server.json`:

```json
"excludeServers": ["bzflag.example.org:5154", "other.example.org"]
```

A bare host covers every port on it. The list server then makes no
background checks of it: no daily hash checks, world fetches, `bzo-list`
visits or guest checks. A player who opens, watches or plays on your server
through any bzo server still can, as with any other BZFlag client: bzo is
acting for that player. To stop those too, ban the bzo server's address.

On `/list` such a server has no picture, says it was left out at its
operator's request, and sorts last.

## Banning bzo

A ban on the bzo server's address works too. bzfs checks a ban only when a
player joins, so it stops the join but not the world download or the hash
query; bzo stops those itself once a join of its own is refused as a ban.

On `/list` a server that bans bzo says so, has no picture, and sorts last. It
shows only what the public list server says: nothing bzo learned before the
ban, which may no longer be true. Its row's buttons:

| Button | Offered | Why |
|---|---|---|
| Launch | yes | a player's own BZFlag client, from their own address |
| View map, Practice, Import | no | bzfs would still send the world, but you have said no to bzo |
| Watch, Play | no | a join through the bzo server would come from the banned address |

bzo refuses the same requests by URL, for anyone. It stops the daily hash
check and world fetches, and once a month joins once to ask whether the ban
still stands. A lifted ban puts your server back on the ordinary schedule at
once.

The list's filter finds servers that ban bzo or asked to be left out with
`/+x`.

Technical detail: [network.md](network.md) "Talking to a real bzfs" for the
join, [proxy.md](proxy.md) "Guest access" for the guest check.
