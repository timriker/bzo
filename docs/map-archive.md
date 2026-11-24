# Map archive

Old BZFlag maps from public archives, kept in `data/maps/` as this server's
local maps, each with a `metadata` block ([bzw.md](bzw.md#metadata)) saying
what could be learned of it, and counts of how much each is used.

## Importing

```sh
node scripts/import-map-archive.mjs [--dry-run 1] [--out data/maps] \
  [--source bzx|sf|all] [--cache /tmp/bzo-map-archive]
```

It reads two sources:

- [bzexcess bzWorlds](https://static.bzexcess.com/downloads/bzWorlds/), each
  map given `archived 2011-07-30`, the date the archive was copied;
- [SourceForge world-files](https://sourceforge.net/p/bzflag/world-files/),
  every ticket, open or closed. A ticket is one map: its last attachment is
  taken, every world in it if it is an archive (`.zip`, `.tar.gz`, `.gz`,
  `.bz2`). A `.map` is a world bzedit32 saved, and is taken as `.bzw`.

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
gives that map its block. A map keeps the name it came with, prefixed `bzx-`
or `sf-` only where another map has the name.

The block gives `title`, `author` and `created` from the file's own header
comments where it has them (no email addresses), else from the ticket;
`version`; `sourceurl` (the ticket, or the bzexcess file); `downloadurl` (the
attachment, `#member` for one out of an archive); and the ticket's
`description`. No `license` unless the file states one.

Downloads are cached, so a second run fetches nothing, and every file's
outcome is in `report.json` in the cache directory.

Worlds bzfs servers run that are in no archive are not imported: a map may
never have been released, and its author may want it so.

## Map list

A client is sent no list of maps until it asks: the View dialog and a staged
Map Viewer ask for it (`getMaps`), and a `?viewmap=` link asks for its one
map (`importMapForView`). `/list` and the View dialog show sortable Date,
Author, Views and Servers columns, and drop columns on a narrow screen; the
filter also finds a map by its description.

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
