# Map archive

Old BZFlag maps from public archives, kept in `data/maps/` as this server's
local maps, each with a `metadata` block ([bzw.md](bzw.md#metadata)) saying
what could be learned of it, and counts of how much each is used.

## Importing

```sh
node scripts/import-map-archive.mjs [--dry-run 1] [--out data/maps] \
  [--source bzx|sf|forum|all] [--cache /tmp/bzo-map-archive]
```

It reads three sources:

- [bzexcess bzWorlds](https://static.bzexcess.com/downloads/bzWorlds/), each
  map given `archived 2011-07-30`, the date the archive was copied;
- [SourceForge world-files](https://sourceforge.net/p/bzflag/world-files/),
  every ticket, open or closed. A ticket is one map: its last attachment is
  taken, every world in it if it is an archive (`.zip`, `.tar.gz`, `.gz`,
  `.bz2`). A `.map` is a world bzedit32 saved, and is taken as `.bzw`;
- the BZFlag wiki's [Map Index](https://wiki.bzflag.org/Map_Index), each
  map's author, forum thread and the day it was published there. The
  author's last world attached in the thread is taken, else the first post's.
  Then every other topic in the forum's
  [Map releases](https://forums.bzflag.org/viewforum.php?f=64), the same way,
  its starter as the author.
  The forums ask a browser to pass a proof of work first, so the importer
  passes it once in headless Chrome and fetches with its cookies.
  `posted` is when that post was made, UTC. A map posted after the forums'
  [map terms](https://forums.bzflag.org/viewtopic.php?t=10575)
  (2007-04-11 18:37:23 UTC) may be hosted and changed by anyone, as public
  domain where it names no licence; its `note` links the terms. Requests are
  paced at one a second.

Each file is turned to LF line endings without a stray Ctrl-Z. That changes
the bzfs world hash of a map with text bzfs reads to the end of a line, such
as a death message, which keeps the `\r`; a map added by hand to match the
world servers run stays CRLF. A 404 page or a file with no objects is not
taken; a truncated one is, as it is. Rotations
in radians -- world files before BZFlag 1.7e4 (2001-11-27) -- become degrees,
with a `note` saying so: no bzfs reads radians.

Of several versions of one map -- the same author and the same file name or
title, version numbers aside -- only the newest is taken. A file identical to
one already here is skipped; one identical to a map here with no metadata
gives that map its block, and a forum map identical to one with a block adds
its thread and the fields the block lacks. A map keeps the name it came with,
prefixed `bzx-`, `sf-` or `forum-` only where another map has the name.

The block gives `title`, `author` and `created` from the file's own header
comments where it has them (no email addresses), else from the ticket or
thread;
`version`; `sourceurl` (the ticket, or the bzexcess file); `downloadurl` (the
attachment, `#member` for one out of an archive); and the ticket's
`description` (for a forum map, the first lines of its first post, and the
wiki's author before the file's). No `license` unless the file states one.

Downloads are cached, so a second run fetches nothing, and every file's
outcome is in `report.json` in the cache directory.

Worlds bzfs servers run that are in no archive are not imported: a map may
never have been released, and its author may want it so.

## Map list

A client is sent no list of maps until it asks: the View dialog and a staged
Map Viewer ask for it (`getMaps`), and a `?viewmap=` link asks for its one
map (`importMapForView`). `/list` and the View dialog show sortable Date,
Author, Views and Servers columns, and drop columns on a narrow screen; the
filter also finds a map by its title and description. On `/list`, a leading
`/` filters on one metadata field or count -- `/au)ducati*`, `/y<2005`,
`/so)*forums*` -- and the `?` beside the box lists them.

## Textures

A BZFlag client loads images only from images.bzflag.org, so a map's textures
point there:

```sh
node scripts/migrate-map-textures.mjs [--dry-run 1] \
  [--images /var/www/images-dev] [--maps data/maps,maps]
```

An images.bzflag.org texture -- or one under its older names,
`images.bzflag.bz` and `images.bzflag.com` -- missing from the local copy of
that site (`--images`) is downloaded into it. A texture on an old host images.bzflag.org
keeps copies of -- `louman.bzflag.bz` and `trepan.bzflag.bz` in `bz_legacy/`,
The Purple Panzer's `images.planet-mofo.com` and `cbg.bzflag.org` in
`bbentz/` -- is pointed at the copy, once it is there, and the map gets a
`note` saying so. A texture with no copy there whose own host still serves
it is kept in `data/img/<host>/<path>` and the map points at `/img/`: the
archive keeps the images its maps use, and a host that sends no CORS headers
is one a headset cannot load from at all. Photobucket's answers are its
watermark, not the image, so they are not kept. The rest are listed, not
guessed at: a file name alone does not say which of several `wood.png`s a
map meant. Requests are paced at one a second.

The maps' images are taken to be as open as the maps; one that turns out not
to be is removed on request.

The server checks every texture URL a map names, one a second and again
after a month (`server/image-check.cjs`, kept in the cache as
`image-check.json`); a URL that does not answer with an image, and a texture
name that resolves to nothing, are the map's missing images. `/list` shows
them in the map's pane, and `/mi>0` finds the maps with any.

## Use counts

`data/map-stats.json`, beside `server.json`, by map file name, public on
`/list`:

- views (`?viewmap` and View) and practice starts, by day;
- time played here as the live map, by day, and players;
- servers on the BZFlag list seen running the map's world, matched by its
  bzfs world hash, with the day each was first and last seen. This server's
  own listing is left out.

A browser counts once a day for each map and kind of use, by a hash of its
address and user agent; neither is kept. Headless Chrome and bots count
nothing. A map's entry goes when its file does.
