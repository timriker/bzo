# Refactoring -- plan

Splitting the largest source files by concern, so each part can be read and
changed on its own. Every step is a pure move -- no behaviour change in the
same commit -- checked by output that must not change, and listed in
`.git-blame-ignore-revs` so `git blame` looks through it.

## Autopilot

`public/js/autopilot.mjs` holds both pilots. Seeded `scripts/bench-stuck.mjs`
runs with `--trace`, `scripts/bench-pilot.mjs` and `scripts/test-autopilot.mjs`
must give byte-identical output before and after each step.

1. The world a pilot asks about -- routers, probes, team bases, vantage
   points -- is `public/js/autopilot-world.mjs`. Done.
2. Roger, upstream's `AutoPilot.cxx`, is `public/js/roger.mjs`, with the
   geometry he and Ace share. Done.
3. Ace in layers, each a subclass of the one before: `AceDriver`
   (`public/js/ace-driver.mjs`: routes, jumps, flights, unstick), `AceFighter`
   (`public/js/ace-fighter.mjs`: shot planning, firing, chase, ambush, evasion),
   then `Ace` in `autopilot.mjs` (`think`, targets, flags, camping), which
   stays the module everyone imports pilots from. No layer calls a method of
   one above it. Done.

## Server and client

4. `server.js`: the bzfs proxy -- `handleProxyConnection` and the helpers
   only it uses -- is `server/bzfs-proxy.cjs`, handed what it needs of the
   server by `useServer`. Done. The message cases in `acceptConnection` are
   a table of handlers, `MESSAGE_HANDLERS`, in `server/messages-voice.cjs`,
   `messages-chat.cjs`, `messages-play.cjs` and `messages-operator.cjs`, each
   handed what it needs by `useServer` and reading what changes as the server
   runs through `MESSAGE_SERVER`. Done.

   The server has no seeded bench to compare, so each move is checked by
   diffing the moved code against what it replaced -- only the lines that
   read the server's changing state differ -- by `npm run check`, and by a
   proxied game and a replay joined live on the dev server.
5. `public/js/render.js`: `RenderManager` is split by subsystem -- world
   geometry, tanks, effects and weather, XR -- as objects it owns.
6. `public/js/client.js`: `handleServerMessage` looks each message up in
   `SERVER_MESSAGE_HANDLERS`, one `receive` function per type, kept in
   `client.js`: they set 76 of its variables, which a module of their own
   would reach only through getters and setters. Done. The radar -- its
   range, size, obstacle cache and drawing -- is `public/js/radar.js`, handed
   what it needs by `useRadarClient`. Done.

## Mirrored pairs (to try)

The `.mjs`/`.cjs` pairs (`scripts/check-shared-pairs.mjs`) exist because the
server is CommonJS. Node 22 can `require()` an ES module, which would let the
server load the `.mjs` copies and drop the mirrors -- if the Node in the
Docker image does it without a flag. Tested before anything moves.
