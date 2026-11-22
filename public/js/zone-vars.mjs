/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A zone's own world variables (docs/bzw.md, "Zone variables"): bzo's `set`
// lines in a `zone`, which a viewer inside sees in place of the map's. The
// server sends a BZFlag client a zone's variables as it drives in and the
// map's back as it leaves; a browser tests its own view. Both ask `varZoneAt`,
// so the two cannot disagree about where a zone is.

// What a zone may set: how the view looks, never how anything moves or is
// judged, so a viewer inside sees differently and plays by the same rules.
export const ZONE_VARS = new Set([
  '_fogMode', '_fogDensity', '_fogStart', '_fogEnd', '_fogColor', '_fogNoSky',
  '_syncTime',
]);

// The first zone holding the point, or null. A zone is a box: `x`, `y` its
// centre, `z` its floor, `halfWidth`/`halfDepth` along its own axes once
// turned by `rotation` (radians, counter-clockwise), and `height` up, or no
// ceiling where it is null.
export function varZoneAt(zones, x, y, z) {
  if (!zones) return null;
  for (const zone of zones) {
    if (z < zone.z || (zone.height !== null && z > zone.z + zone.height)) continue;
    const dx = x - zone.x;
    const dy = y - zone.y;
    const cos = Math.cos(zone.rotation);
    const sin = Math.sin(zone.rotation);
    const along = (dx * cos) + (dy * sin);
    const across = (dy * cos) - (dx * sin);
    if (Math.abs(along) <= zone.halfWidth && Math.abs(across) <= zone.halfDepth) return zone;
  }
  return null;
}
