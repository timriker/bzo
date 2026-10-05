# Global login -- what's left

What bzo actually supports today is `docs/login.md`. This is only the
remainder: three gaps, all at the dialog or the handshake rather than in the
identity itself.

No GitHub issue tracks this. Each item below is small enough to ride its own
tracker if it needs one.

## Stashing the staged draft across the login bounce

The entry dialog stages every choice and applies it on OK, but a login is a
page navigation, so pressing it discards whatever name, team and tank were
staged. Stash the draft in `sessionStorage` and restore it after the bounce:
that is UI state rather than identity, so the browser is the right place for
it. Not built -- no `sessionStorage` save/restore for the staged draft exists
in `public/` yet.

## `Origin` check on the WebSocket upgrade

`SameSite=Lax` is what keeps the session cookie off a cross-site handshake, so
an `Origin` check would only be a second layer, not the only one. Every
handshake is already logged as a `[WS]` line with origin, host and cookie
*names* (the `[WS] ... handshake` line in `server.js`) but nothing rejects on a
mismatch yet -- that line exists to sample real traffic before writing the
rule. So far: desktop Chrome and Firefox send a matching origin, a non-browser
client sends none. The rule this points to is "reject only when `Origin` is
present and does not match," but phone and headset browsers haven't been
sampled yet.

## `__Host-` cookie prefix

The session cookie is still plain `bzoSession` (`SESSION_COOKIE_NAME` in
`server/sessions.cjs`). The `__Host-` prefix, which browsers enforce as
`Secure`, host-only and `Path=/`, is strictly better where HTTPS is guaranteed
-- and the login callback is HTTPS by construction -- so this is worth doing
once it doesn't risk breaking the plain version mid-test.
