# Server skins plan

Issue #208: a server's own tank skins, kept under `data/` and offered beside
the five built-in ones (`public/js/tank-skins.mjs`). A model's own texture is
already built: see [Own Texture](tank-model-format.md#own-texture).

## Where they live

A skin is one PNG in `data/img/skins/` (`/data/img/skins/` in Docker), named
for its id: `stripes.png` is the skin `stripes`. `/img/` already serves that
folder and holds it to the map textures' limits (`server/local-images.cjs`),
so no new route or new limits are needed.

One file serves every team. The built-in skins come painted once per team,
and any colour that is not a team's has the blue file repainted for it
(`camo.mjs`); a server skin is repainted that way for every team.

## On the wire

bzo clients already send a skin as its id (`setTankSkin`, and in the join),
and the server narrows it to the built-in five (`normalizeTankSkinId`). That
check widens to the server's own list. BZFlag clients are never sent a skin,
so nothing changes for them.

## Steps

1. List the skins: built-in, then `data/img/skins/*.png`, at
   `/api/tank-skins`, the way `/api/tank-models` lists models. A refused PNG is
   left out and logged once.
2. Accept those ids on the server, in the join and in `setTankSkin`.
3. The skin row in the entry dialog cycles through the list, and the renderer
   paints a server skin through the same camo path as the blue file.
4. Docs: the skin folder in [installation.md](installation.md) and in
   [tank-model-format.md](tank-model-format.md).

## Open question

What the skin row offers on a model with its own texture. Its UVs are laid
out for its own picture, so a camo pattern drawn through them comes out as
scattered patches rather than a pattern. Either the row shows only "Model"
on such a model, or it offers the skins anyway and accepts how they look.
