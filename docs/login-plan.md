# Global login

Plan for signing players in with their bzflag.org global callsign, and for
keying admin to it. Upstream references are paths under `$HOME/bzflag/`; the
findings the design rests on are in AGENTS.md, "What a real login would look
like", which is also where anything learned later belongs.

No GitHub issue tracks this. One was meant to be opened before the first commit
and never was; the work shipped in v1.0.83 regardless, so an issue now would be
opened closed. Anything left below is small enough to ride another tracker.

## What is built

**All of "Shape of the work" below, except where this section says otherwise.**
`/login` finishes a verified token by creating a session, setting the cookie and
redirecting to `/`; `server/sessions.cjs` holds the store, `sessions.json`
persists it across the restarts that editing this server causes, and
`scripts/test-sessions.mjs` covers the rules. The handshake reads the cookie and
hangs the identity on the `Player`, `resolveJoinName` enforces the collision
rules, and the entry dialog carries the login row.

The round trip itself works and is probed live. `/login` with no `t` parameter
redirects to `https://my.bzflag.org/weblogin.php`, and bzflag.org sends the
player back to `/login?t=<token>:<callsign>`, where the server asks
`CHECKTOKENS` whether the token is real. A real token verifies **with no IP
supplied**, group membership comes back for the groups named in `adminGroups`
and for no others, and the reply carries a `BZID` -- a small stable integer that
survives a callsign change on the forum.

**Three pieces are not built**, all of them at the dialog rather than in the
identity:

- **Logging out.** `startGlobalLogin` says so when a signed-in player presses
  the row. A session ends only by expiring, which is the 8 hours below.
- **Stashing the staged draft across the login bounce.** The name, team and tank
  staged in the entry dialog are still discarded by the page navigation.
- **A login row that works inside an immersive session.** bzo took a third
  answer to that wrinkle rather than either of the two below: the row refuses in
  XR and says the login leaves VR, so nobody is dropped out of a session without
  warning. Whether that is the final answer is open.

## Decisions

Settled, so they do not need re-arguing:

- **Sessions last 8 hours**, absolute. Group membership is a snapshot -- the
  token is spent, so bzo cannot re-ask bzflag.org later -- and 8 hours bounds
  how long a demotion at bzflag.org goes unnoticed.
- **The browser holds one opaque value and nothing else**: 32 random bytes in a
  host-only `HttpOnly; Secure; SameSite=Lax; Path=/` cookie. Every attribute --
  BZID, callsign, groups, admin -- lives in a server-side record the cookie is a
  key to. A player can write their own cookies, so nothing stored there may be
  *read as* an attribute; an invented id matches no record and is anonymous.
- **`@`, `+` and `-` are indicators, not part of the name.** Upstream builds
  them as a separate cyan field beside the callsign
  (`ScoreboardRenderer.cxx:718`) out of three booleans carried in
  `MsgPlayerInfo`: `@` admin, `+` verified, `-` registered but not
  authenticated. bzo carries the same booleans and draws the same characters,
  and never puts one in a name. bzo can only ever reach `@` and `+`, because it
  learns nothing about a callsign unless a token verifies and a verified token
  means registered *and* authenticated.
- **A leading `+`, `-` or `@` is refused on any name a client asks for**, so
  nobody can fake an indicator where the name is written as plain text -- a chat
  line, the server log. `-` is refused too, though bzo never issues it.
- **`isAdmin` becomes: authenticated **and** a member of at least one group
  named in `adminGroups`.** The courtesy gate -- any name that is not the
  default -- goes away in the same change. Leaving it would mean a player who
  never logged in is still an admin, which makes the login decorative.
- **`example-server.json` ships `DEVELOPERS` and `BZADMIN`**, so a fresh
  install has somebody who can operate it rather than nobody. Those are
  bzflag's own project groups; the site roles a bzflag.org account may also
  carry (`WEBSITE.ADMINS`, `BBMODERATORS`) and the groups belonging to other
  people's servers are deliberately **not** included -- being trusted to
  moderate a forum is not being trusted to change someone's map. An operator who
  wants only their own authority empties the list; one who never opens the file
  inherits bzflag's, which is the point of the default and is documented so it
  is not a surprise.
- **The socket is where identity binds.** The cookie rides the WebSocket
  handshake, so the session is looked up in `wss.on('connection')` and the join
  enforces the name. `/` and the `init` payload only *tell* the client what its
  name and status are, so the entry dialog can show the field locked -- the rule
  bzo already follows for `admin`, where a greyed-out button reads an answer
  rather than keeping a second copy of the question.
- **A login always produces a fresh player.** `/login` ends in a redirect to
  `/`, valid or not, so the page reloads and opens a new socket. There is no
  identity to migrate onto a live connection, and a failed login needs nothing
  beyond clearing the cookie.
- **Failure is reported in the fragment**, `/#login=failed`. A fragment never
  reaches the server, so nothing lands in the access log, and the value only
  picks a message -- forging it achieves nothing.

## Name collisions

A verified callsign outranks a typed one, as upstream protects a registered
callsign. When an authenticating player's callsign is already held by another
connected player:

**The arriving authenticated player always takes the name.** What happens to the
player who had it depends on whether they hold the same identity:

- **They are not authenticated** -- they are renamed in place, to the
  `Player <n>` that `nameCheck` already falls back to, and told why. A rename
  keeps a player in the game they were in the middle of, where a disconnect
  would not, and it frees the name just as well.
- **They are authenticated as the same callsign** -- which can only be **the
  same account on a second device** -- they are **disconnected**, and the newest
  device keeps the identity and the admin rights it logged in for. Logging in
  somewhere else to do admin work is a real thing to want, and last-login-wins
  is what makes it work.

**The superseded session must be invalidated at the same time**, and this is not
optional: bzo clients rejoin without waiting for a click. A kicked device
reconnects on its own, still holding a valid session cookie, authenticates as
the same callsign again, and kicks whatever kicked it -- the two devices would
trade the identity back and forth forever. Deleting the older session id makes
the kick mean something: that device comes back as an ordinary anonymous player,
and its cookie matches no record. Session ids are per browser, so dropping the
old one cannot touch the new device.

## Shape of the work

Built, except for the three pieces named above. Kept because it is the record of
why each piece is shaped the way it is.

**`server/sessions.cjs`**, server-only, holding the store and its rules so
`scripts/test-sessions.mjs` can exercise them without a server around them:
create a session from a verified reply, look one up by id, drop one, prune the
expired. Ids come from `crypto.randomBytes(32).toString('base64url')` -- 256
bits, 43 characters -- and `now` is injected so expiry is testable.

A record is `{ bzid, callsign, groups, createdAt, expiresAt }` and holds no
secret: the bzflag.org token is spent at `/login` and discarded.

**Persistence.** The store is a `Map`, as every other piece of bzo's state is.
It is also written to a JSON file under the runtime directory and read back at
boot, because this server restarts on every edit, the token is single use, and
each re-login is a full bounce through my.bzflag.org -- friction that lands on
whoever is testing, repeatedly. Writes are debounced; expired records are pruned
on read and on a periodic sweep, and the count is capped so the file cannot grow
without bound. This is the first user data bzo writes to disk -- a callsign and
a BZID per session -- which is another argument for the 8 hour life.

**`/login`** stops printing and starts finishing: on a verified token it creates
the session, sets the cookie and redirects to `/`; on anything else it clears
the cookie and redirects to `/#login=failed`. The `[LOGIN]` log lines stay, and
are the diagnostic the plain-text page used to be.

**The handshake** reads the cookie in `wss.on('connection')`, looks up the
session, and hangs the identity on the `Player`. `verified` and `admin` join the
player state the client already receives, next to the existing `admin` field
whose meaning changes under it.

**`nameCheck`** gains three rules: refuse a leading indicator character; force
an authenticated player's name to the session callsign rather than to whatever
was asked for; and resolve a collision as above.

**The entry dialog** -- which is what the "Player Options" button opens
(`input.js:1487`) -- gets a login row beside Name, Team and Choose Tank,
following the same `data-menu-row` convention so keyboard, gamepad and XR
navigation reach it. A logged-in player sees the field locked to their callsign
and a Log out row instead.

Two wrinkles that belong to that step rather than to the server, **both still
open**:

- The dialog stages every choice and applies it on OK, but a login is a page
  navigation, so pressing it discards the staged name, team and tank. Stash the
  draft in `sessionStorage` and restore it after the bounce: that is UI state
  rather than identity, so the browser is the right place for it.
- **In an immersive session a redirect ends the session.** On a headset,
  logging in leaves VR, does the round trip in the flat browser, and needs
  re-entry. The row says so, or is disabled inside a session with logging in
  expected beforehand. Either is a clear answer; what is not acceptable is a row
  that silently drops the player out of VR. bzo does the first: the row refuses
  in XR and says why.

## Still open

- **Logging out**, and the two dialog wrinkles above.
- **Whether to check `Origin` on the upgrade.** `SameSite=Lax` is what keeps the
  cookie off a cross-site handshake, so a check is a second layer rather than
  the only one. Every handshake is already logged as a `[WS]` line; desktop
  Chrome and Firefox send a matching origin and a non-browser client sends none,
  which is the rule to write -- reject only when present and mismatched -- but
  phone and headset browsers have not been sampled yet.
- **`__Host-` cookie prefix**, which browsers enforce as Secure, host-only and
  path `/`. Strictly better where HTTPS is guaranteed, and the callback is
  HTTPS by construction, so this is worth doing once the plain version is
  working.
