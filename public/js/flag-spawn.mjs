/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Which flags a game has and where each one comes into the world, for the
// server and for practice (docs/practice-plan.md, step 2): upstream's
// `finalizeParsing` slot order and `FlagInfo::getFlagSpawnPoint`. What it
// needs of the world comes in as arguments, so a host with no server behind
// it asks the same questions.

import { FLAG_ENDURANCE, FLAG_STATUS, getTeamFlagAbbreviation, isTeamFlag } from './flags.mjs';
import { getRandomZonePoint } from './spawn.mjs';

// One flag slot, empty. A slot with a required type always holds that type
// (`FlagInfo::setRequiredFlag`); a `zoneflag` slot also names the zone it
// respawns in.
export function createFlagSlot(index, teamColorIndex, { requiredType = null, zoneIndex = null } = {}) {
  return {
    index,
    team: teamColorIndex,
    requiredType,
    zoneIndex,
    type: teamColorIndex === null ? requiredType : getTeamFlagAbbreviation(teamColorIndex),
    status: FLAG_STATUS.NO_EXIST,
    endurance: teamColorIndex === null ? FLAG_ENDURANCE.UNSTABLE : FLAG_ENDURANCE.NORMAL,
    owner: null,
    grabs: 0,
    // When the current carrier picked it up, which is the shake clock a
    // sticky drop is checked against. Zero whenever nobody holds it.
    grabbedAt: 0,
    // `PlayerState::FlagActive`, which only Phantom Zone reads. A flag arrives
    // in a tank's hands switched off, so picking `PZ` up gives you nothing
    // until you have driven through a teleporter.
    zoned: false,
    position: { x: 0, y: 0, z: 0 },
    launchPosition: { x: 0, y: 0, z: 0 },
    landingPosition: { x: 0, y: 0, z: 0 },
    flightEnd: 0,
    initialVelocity: 0,
    flightStartedAt: 0,
  };
}

// Every slot a game has, in upstream's order: team flags (`teamColors`), then
// `+f` types (`requiredCounts`, abbreviation to count), then each zone's
// flags, then `superCount` random slots that draw from the pool. A forbidden
// type is left out wherever it is asked for, and a zone cannot put a team
// flag anywhere but its base. Returns the slots and the zone types skipped.
export function planFlagSlots({ teamColors = [], requiredCounts = {}, zones = [], forbidden = [], superCount = 0 }) {
  const slots = [];
  teamColors.forEach((color) => slots.push(createFlagSlot(slots.length, color)));
  Object.entries(requiredCounts).forEach(([abbreviation, count]) => {
    if (forbidden.includes(abbreviation)) return;
    for (let n = 0; n < count; n++) slots.push(createFlagSlot(slots.length, null, { requiredType: abbreviation }));
  });
  const skipped = new Set();
  zones.forEach((zone) => {
    (zone.unknownFlags || []).forEach((abbreviation) => skipped.add(abbreviation));
    (zone.flagCounts || new Map()).forEach((count, abbreviation) => {
      if (forbidden.includes(abbreviation) || isTeamFlag(abbreviation)) {
        skipped.add(abbreviation);
        return;
      }
      for (let n = 0; n < count; n++) {
        slots.push(createFlagSlot(slots.length, null, { requiredType: abbreviation, zoneIndex: zone.index }));
      }
    });
  });
  for (let n = 0; n < superCount; n++) slots.push(createFlagSlot(slots.length, null));
  return { slots, skipped };
}

// The zone a flag comes into the world in, or null for anywhere: its own
// `zoneflag` zone, else one of the zones that name its type, picked by area.
export function getFlagSpawnZone(flag, zones, random = Math.random) {
  if (!flag) return null;
  if (flag.zoneIndex !== null && flag.zoneIndex !== undefined) return zones[flag.zoneIndex] || null;
  // The type the flag has now -- upstream asks before a reset clears it -- or,
  // for a required slot not yet in the world, the one it is pinned to.
  const type = flag.type ?? flag.requiredType ?? null;
  if (!type || isTeamFlag(type)) return null;
  const named = zones.filter((zone) => zone.flagTypes?.has(type));
  if (named.length === 0) return null;
  const area = (zone) => 4 * zone.halfWidth * zone.halfDepth;
  const total = named.reduce((sum, zone) => sum + area(zone), 0);
  if (!(total > 0)) return null;
  let pick = random() * total;
  for (const zone of named) {
    pick -= area(zone);
    if (pick < 0) return zone;
  }
  return named[named.length - 1];
}

// Where a flag comes into the world: a random point -- in its zone, or over
// the whole map short of `baseSize` and up to `maxHeight` -- settled onto
// what is under it with `flagsOnBuildings` (`landingZ`, null for open water)
// or the ground without, and tried again until `clearance` passes. Null when
// ten thousand tries find nowhere.
export function findFlagSpawnPosition(flag, {
  zones = [], mapSize, baseSize, maxHeight, flagsOnBuildings, landingZ, clearance, random = Math.random,
}) {
  const span = Math.max(1, mapSize - baseSize);
  for (let attempt = 0; attempt < 10000; attempt++) {
    // Upstream re-asks getFlagSpawnPoint on every attempt and only falls back
    // to a random world point when it has no answer, so a zone flag re-rolls
    // inside its zones rather than escaping them once one proves crowded.
    const zone = getFlagSpawnZone(flag, zones, random);
    const spot = zone
      ? getRandomZonePoint(zone, random)
      : { x: span * (random() - 0.5), y: span * (random() - 0.5), z: maxHeight * random() };
    const z = flagsOnBuildings ? landingZ(spot.x, spot.y, spot.z) : 0;
    if (z === null) continue;
    if (clearance(spot.x, spot.y, z)) return { x: spot.x, y: spot.y, z };
  }
  return null;
}
