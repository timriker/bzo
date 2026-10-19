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
2. Roger, upstream's `AutoPilot.cxx`, in a file of his own with his
   constants, so the reference reads on its own.
3. Ace in layers, each a subclass of the one before, one commit each:
   driving (routes, jumps, flights, unstick), fighting (shot planning,
   firing, chase, ambush, evasion), then Ace (`think`, targets, flags,
   camping). `autopilot.mjs` stays the module everyone imports pilots from.

## Server and client

4. `server.js`: the message cases in `acceptConnection` become a table of
   handlers in `server/` modules, grouped by voice, chat and commands, and
   play; the bzfs proxy (`handleProxyConnection`) moves to a module of its
   own.
5. `public/render.js`: `RenderManager` is split by subsystem -- world
   geometry, tanks, effects and weather, XR -- as objects it owns.
6. `public/client.js`: `handleServerMessage` becomes a handler table, and
   the radar a module of its own.

## Mirrored pairs (to try)

The `.mjs`/`.cjs` pairs (`scripts/check-shared-pairs.mjs`) exist because the
server is CommonJS. Node 22 can `require()` an ES module, which would let the
server load the `.mjs` copies and drop the mirrors -- if the Node in the
Docker image does it without a flag. Tested before anything moves.
