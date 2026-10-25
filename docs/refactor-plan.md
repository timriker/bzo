# Refactoring -- plan

Splitting the largest source files by concern, so each part can be read and
changed on its own. Every step is a pure move -- no behaviour change in the
same commit -- checked by output that must not change, and listed in
`.git-blame-ignore-revs` so `git blame` looks through it.

## Autopilot

`public/autopilot.mjs` holds both pilots. Seeded `scripts/bench-stuck.mjs`
runs with `--trace`, `scripts/bench-pilot.mjs` and `scripts/test-autopilot.mjs`
must give byte-identical output before and after each step.

1. The world a pilot asks about -- routers, probes, team bases, vantage
   points -- is `public/autopilot-world.mjs`. Done.
2. Roger, upstream's `AutoPilot.cxx`, is `public/roger.mjs`, with the
   geometry he and Ace share. Done.
3. Ace in layers, each a subclass of the one before: `AceDriver`
   (`public/ace-driver.mjs`: routes, jumps, flights, unstick), `AceFighter`
   (`public/ace-fighter.mjs`: shot planning, firing, chase, ambush, evasion),
   then `Ace` in `autopilot.mjs` (`think`, targets, flags, camping), which
   stays the module everyone imports pilots from. No layer calls a method of
   one above it. Done.

## Server and client

4. `server.js`: the bzfs proxy -- `handleProxyConnection` and the helpers
   only it uses -- is `server/bzfs-proxy.cjs`, handed what it needs of the
   server by `useServer`. Done. Then the message cases in `acceptConnection`
   become a table of handlers in `server/` modules, grouped by voice, chat and
   commands, and play.

   The server has no seeded bench to compare, so each move is checked by
   diffing the moved code against what it replaced -- only the lines that
   read the server's changing state differ -- by `npm run check`, and by a
   proxied game and a replay joined live on the dev server.
5. `public/render.js`: `RenderManager` is split by subsystem -- world
   geometry, tanks, effects and weather, XR -- as objects it owns.
6. `public/client.js`: `handleServerMessage` becomes a handler table, and
   the radar a module of its own.

## Mirrored pairs (to try)

The `.mjs`/`.cjs` pairs (`scripts/check-shared-pairs.mjs`) exist because the
server is CommonJS. Node 22 can `require()` an ES module, which would let the
server load the `.mjs` copies and drop the mirrors -- if the Node in the
Docker image does it without a flag. Tested before anything moves.
