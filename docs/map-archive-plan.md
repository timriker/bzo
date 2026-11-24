# Map archive plan

What is built is described in [map-archive.md](map-archive.md).

## Steps

1. **Map list on demand.** Done.
2. **Date, Author, Views and Servers columns; search by description.** Done.
3. **Use counts** (`data/map-stats.json`). Done.
4. **Importer** (`scripts/import-map-archive.mjs`) from bzexcess and
   SourceForge. Done.
5. **Maps moved out of git** (`pizza_box`, `tricolor`, `fountains`,
   `eroah`, `eroah2`) to `data/maps/`, and metadata for the maps already
   there. Done.

## Later

- Worlds many bzfs servers run that are in no archive: which look public,
  found by a manual search, never imported on that alone.
- [bz-next's map archive](https://github.com/bz-next/bz-next.github.io/tree/main/maparchive)
  lists licences for its maps; two of its eight ask the author to be asked
  before hosting.
