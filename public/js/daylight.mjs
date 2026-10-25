/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// daylight.mjs - Where the sun and the moon are, and what colour the sky and
// the light are for it: upstream's `src/bzflag/daylight.cxx`, line for line.
//
// Everything here is in upstream's frame -- x east, y north, z up -- and every
// direction is a unit vector. The renderer turns them into its own axes.
// Latitude is degrees north; longitude is degrees *west*, as upstream reads
// `_longitude` (`localSidereal = GST - longitude`).

const RAD_PER_DEG = Math.PI / 180;
const RAD_PER_HOUR = Math.PI / 12;
const SIDEREAL_HOURS_PER_HOUR = 1.002737908;
const EPOCH = 2415020.0;
const TWO_PI = 2 * Math.PI;

// The Julian day of the Unix epoch (`daylight.h:25`); `updateDaylight` adds
// Unix seconds over a day's to it (playing.cxx:4590).
export const UNIX_EPOCH_JULIAN_DAY = 2440587.5;
const SECONDS_IN_DAY = 86400;

export function julianDayFromUnixSeconds(seconds) {
  return UNIX_EPOCH_JULIAN_DAY + (seconds / SECONDS_IN_DAY);
}

// C's fmod, which keeps the dividend's sign, where `%` would too -- named so a
// reader comparing with upstream sees the same call.
const fmod = (a, b) => a % b;

function getGreenwichSideral(julianDay) {
  // true position requires sidereal time of midnight at prime meridian.
  // get midnight of given julian day (midnight has decimal of .5)
  let jdMidnight = Math.floor(julianDay);
  if (julianDay - jdMidnight >= 0.5) jdMidnight += 0.5;
  else jdMidnight -= 0.5;

  // get fraction of a day
  const dayFraction = (julianDay - jdMidnight) * 24.0;

  // get Greenwich midnight sidereal time (in hours)
  const T = (jdMidnight - EPOCH) / 36525.0;
  const greenwichMidnight = fmod((((0.00002581 * T) + 2400.051262) * T) + 6.6460656, 24.0);

  // return Greenwich sidereal time
  return RAD_PER_HOUR * (greenwichMidnight + (dayFraction * SIDEREAL_HOURS_PER_HOUR));
}

function getTruePosition(julianDay, latitude, longitude, sx, sy, sz) {
  // get local sidereal time
  const localSidereal = getGreenwichSideral(julianDay) - (longitude * RAD_PER_DEG);

  // rotate around polar axis (y-axis) by local sidereal time
  const tx = (sx * Math.cos(localSidereal)) - (sz * Math.sin(localSidereal));
  const ty = sy;
  const tz = (sz * Math.cos(localSidereal)) + (sx * Math.sin(localSidereal));

  // rotate by latitude to local position
  const lat = latitude * RAD_PER_DEG;
  return [
    tx,
    (ty * Math.cos(lat)) - (tz * Math.sin(lat)),
    (tz * Math.cos(lat)) + (ty * Math.sin(lat)),
  ];
}

// The rotation that carries the celestial sphere (x to the vernal equinox, z to
// the celestial north pole) into the local sky (x east, y north, z up), as the
// nine entries of a 3x3, row-major: local = M * celestial. Upstream stores the
// same numbers column-major for glMultMatrixf (daylight.cxx:65-100).
export function getCelestialTransform(julianDay, latitude, longitude) {
  const localSidereal = getGreenwichSideral(julianDay) - (longitude * RAD_PER_DEG);
  const cls = Math.cos(localSidereal);
  const sls = Math.sin(localSidereal);
  const cla = Math.cos(latitude * RAD_PER_DEG);
  const sla = Math.sin(latitude * RAD_PER_DEG);
  return [
    -sls, cls, 0,
    -cls * sla, -sls * sla, cla,
    cls * cla, sls * cla, sla,
  ];
}

export function getSunPosition(julianDay, latitude, longitude) {
  const T = (julianDay - EPOCH) / 36525.0;
  const geometricMeanLongitude = fmod(RAD_PER_DEG
    * ((((0.0003025 * T) + 36000.76892) * T) + 279.69668), TWO_PI);

  const meanAnomaly = fmod(RAD_PER_DEG * (358.47583
    + (((((0.0000033 * T) + 0.000150) * T) + 35999.04975) * T)), TWO_PI);

  const C = fmod(RAD_PER_DEG
    * ((Math.sin(meanAnomaly) * (1.919460 - ((0.004789 + (0.000014 * T)) * T)))
      + (Math.sin(2.0 * meanAnomaly) * (0.020094 - (0.0001 * T)))
      + (Math.sin(3.0 * meanAnomaly) * 0.000293)), TWO_PI);

  const trueLongitude = fmod(geometricMeanLongitude + C, TWO_PI);

  // get obliquity (earth's tilt)
  const obliquity = fmod(RAD_PER_DEG
    * (23.452294 + ((-0.0130125 + ((-0.00000164 + (0.000000503 * T)) * T)) * T)), TWO_PI);

  // position of sun if earth didn't rotate:
  const sx = Math.sin(trueLongitude) * Math.cos(obliquity);
  const sy = Math.sin(trueLongitude) * Math.sin(obliquity);
  const sz = Math.cos(trueLongitude);

  return getTruePosition(julianDay, latitude, longitude, sx, sy, sz);
}

export function getMoonPosition(julianDay, latitude, longitude) {
  const T = (julianDay - EPOCH) / 36525.0;
  const e = 1.0 + ((-0.002495 - (0.00000752 * T)) * T);
  const meanLongitude = fmod(RAD_PER_DEG
    * (270.434164 + ((481267.8831 + ((-0.001133 + (0.0000019 * T)) * T)) * T)), TWO_PI);
  const meanAnomaly = fmod(RAD_PER_DEG
    * (296.104608 + ((477198.8491 + ((0.009192 + (0.0000144 * T)) * T)) * T)), TWO_PI);
  const meanElongation = fmod(RAD_PER_DEG
    * (350.737486 + ((445267.1142 + ((-0.001436 + (0.0000019 * T)) * T)) * T)), TWO_PI);
  const meanElongation2 = 2.0 * meanElongation;
  const distFromAscendingNode = fmod(RAD_PER_DEG
    * (11.250889 + ((483202.0251 + ((-0.003211 - (0.0000003 * T)) * T)) * T)), TWO_PI);

  // get sun's meanAnomaly
  const solMeanAnomaly = fmod(RAD_PER_DEG * (358.47583
    + (((((0.0000033 * T) + 0.000150) * T) + 35999.04975) * T)), TWO_PI);

  // get moon's geocentric latitude and longitude
  const geocentricLongitude = fmod(meanLongitude + (RAD_PER_DEG
    * ((6.288750 * Math.sin(meanAnomaly))
      + (1.274018 * Math.sin(meanElongation2 - meanAnomaly))
      + (0.658309 * Math.sin(meanElongation2))
      + (0.213616 * Math.sin(2.0 * meanAnomaly))
      + (-0.185596 * Math.sin(solMeanAnomaly) * e)
      + (-0.114336 * Math.sin(2.0 * distFromAscendingNode)))), TWO_PI);
  const geocentricLatitude = fmod(RAD_PER_DEG
    * ((5.128189 * Math.sin(distFromAscendingNode))
      + (0.280606 * Math.sin(meanAnomaly + distFromAscendingNode))
      + (0.277693 * Math.sin(meanAnomaly - distFromAscendingNode))
      + (0.173238 * Math.sin(meanElongation2 - distFromAscendingNode))
      + (0.055413 * Math.sin((meanElongation2 + distFromAscendingNode) - meanAnomaly))
      + (0.046272 * Math.sin((meanElongation2 - distFromAscendingNode) - meanAnomaly))
      + (0.032573 * Math.sin(meanElongation2 + distFromAscendingNode))
      + (0.017198 * Math.sin((2.0 * meanAnomaly) + distFromAscendingNode))), TWO_PI);

  // get obliquity (earth's tilt)
  const obliquity = fmod(RAD_PER_DEG
    * (23.452294 + ((-0.0130125 + ((-0.00000164 + (0.000000503 * T)) * T)) * T)), TWO_PI);

  // position of moon if earth didn't rotate:
  const sx = (Math.cos(geocentricLatitude) * Math.sin(geocentricLongitude) * Math.cos(obliquity))
    - (Math.sin(geocentricLatitude) * Math.sin(obliquity));
  const sy = (Math.sin(geocentricLatitude) * Math.cos(obliquity))
    + (Math.cos(geocentricLatitude) * Math.sin(geocentricLongitude) * Math.sin(obliquity));
  const sz = Math.cos(geocentricLatitude) * Math.cos(geocentricLongitude);

  return getTruePosition(julianDay, latitude, longitude, sx, sy, sz);
}

const lerpColor = (t0, t1, t) => [
  ((1 - t) * t0[0]) + (t * t1[0]),
  ((1 - t) * t0[1]) + (t * t1[1]),
  ((1 - t) * t0[2]) + (t * t1[2]),
];

export const NIGHT_ELEVATION = -0.25; // ~sin(-15)
export const DUSK_ELEVATION = -0.17; // ~sin(-10)
export const TWILIGHT_ELEVATION = -0.087; // ~sin(-5)
export const DAWN_ELEVATION = 0.0; // sin(0)
export const DAY_ELEVATION = 0.087; // ~sin(5)
// Below this a body is down: `setTimeOfDay` and `drawSky` both use it.
export const BELOW_HORIZON = -0.009;

const HIGH_SUN_COLOR = [1.75, 1.75, 1.4];
const LOW_SUN_COLOR = [0.75, 0.27, 0.0];
export const MOON_COLOR = [0.4, 0.4, 0.4];
const NIGHT_AMBIENT = [0.3, 0.3, 0.3];
const DAY_AMBIENT = [0.35, 0.5, 0.5];

// The light's colour and the ambient's, and how bright the sun is, all read off
// the sun's height alone -- the moon's light is a fixed grey.
export function getSunColor(sunDir) {
  let color;
  let brightness;
  if (sunDir[2] <= BELOW_HORIZON) {
    color = MOON_COLOR.slice();
    brightness = 0.0;
  } else if (sunDir[2] < DAY_ELEVATION) {
    const t = (sunDir[2] - DAWN_ELEVATION) / (DAY_ELEVATION - DAWN_ELEVATION);
    color = lerpColor(LOW_SUN_COLOR, HIGH_SUN_COLOR, t);
    brightness = t;
  } else {
    color = HIGH_SUN_COLOR.slice();
    brightness = 1.0;
  }

  let ambient;
  if (sunDir[2] < DUSK_ELEVATION) {
    ambient = NIGHT_AMBIENT.slice();
  } else if (sunDir[2] < DAY_ELEVATION) {
    const t = (sunDir[2] - DUSK_ELEVATION) / (DAY_ELEVATION - DUSK_ELEVATION);
    ambient = lerpColor(NIGHT_AMBIENT, DAY_AMBIENT, t);
  } else {
    ambient = DAY_AMBIENT.slice();
  }
  return { color, ambient, brightness };
}

// How far up the sun's side of the sky the sunset reaches, 0 to 1, or null
// outside sunrise and sunset.
export function getSunsetTop(sunDir) {
  if (sunDir[2] > NIGHT_ELEVATION && sunDir[2] < DAY_ELEVATION) {
    return (sunDir[2] - NIGHT_ELEVATION) / (DAY_ELEVATION - NIGHT_ELEVATION);
  }
  return null;
}

const NIGHT_SKY = [0.04, 0.04, 0.08];
const ZENITH_SKY = [0.25, 0.55, 0.86];
const HORIZON_SKY = [0.43, 0.75, 0.95];
const SUNRISE1_SKY = [0.30, 0.12, 0.08];
const SUNRISE2_SKY = [0.47, 0.12, 0.08];

// The sky's four colours -- zenith, the horizon toward the sun, away from it,
// and across it -- times `_skyColor` where the world states one (null, white).
export function getSkyColor(sunDir, skyTint = null) {
  let sky;
  const night = () => NIGHT_SKY.slice();
  if (sunDir[2] < NIGHT_ELEVATION) {
    sky = [night(), night(), night(), night()];
  } else if (sunDir[2] < TWILIGHT_ELEVATION) {
    const t = (sunDir[2] - NIGHT_ELEVATION) / (TWILIGHT_ELEVATION - NIGHT_ELEVATION);
    sky = [night(), lerpColor(NIGHT_SKY, SUNRISE1_SKY, t), night(), night()];
  } else if (sunDir[2] < DAWN_ELEVATION) {
    const t = (sunDir[2] - TWILIGHT_ELEVATION) / (DAWN_ELEVATION - TWILIGHT_ELEVATION);
    sky = [night(), lerpColor(SUNRISE1_SKY, SUNRISE2_SKY, t), night(), night()];
  } else if (sunDir[2] < DAY_ELEVATION) {
    const t = (sunDir[2] - DAWN_ELEVATION) / (DAY_ELEVATION - DAWN_ELEVATION);
    sky = [
      lerpColor(NIGHT_SKY, ZENITH_SKY, t),
      lerpColor(SUNRISE2_SKY, HORIZON_SKY, t),
      lerpColor(NIGHT_SKY, HORIZON_SKY, t),
      lerpColor(NIGHT_SKY, HORIZON_SKY, t),
    ];
  } else {
    sky = [ZENITH_SKY.slice(), HORIZON_SKY.slice(), HORIZON_SKY.slice(), HORIZON_SKY.slice()];
  }
  if (skyTint) {
    for (const color of sky) {
      color[0] *= skyTint[0];
      color[1] *= skyTint[1];
      color[2] *= skyTint[2];
    }
  }
  return sky;
}

export function areShadowsCast(sunDir) {
  return sunDir[2] > 0.5 * DAY_ELEVATION;
}

export function areStarsVisible(sunDir) {
  return sunDir[2] < DAWN_ELEVATION;
}

// The moon's lit share and which way its lit side faces (`makeCelestialLists`,
// BackgroundRenderer.cxx:476-500). `coverage` is where the terminator falls
// across the disc, as a share of its radius: -1 is a full moon (opposite the
// sun), 1 a new one, leaned toward full as upstream's own "hack" does.
// `limbAngle` turns the strip so the lit edge faces the sun.
export function getMoonPhase(sunDir, moonDir) {
  let coverage = (moonDir[0] * sunDir[0]) + (moonDir[1] * sunDir[1]) + (moonDir[2] * sunDir[2]);
  coverage = coverage < 0 ? -Math.sqrt(-coverage) : coverage * coverage;
  const moonAzimuth = Math.atan2(moonDir[1], moonDir[0]);
  const moonAltitude = Math.asin(Math.max(-1, Math.min(1, moonDir[2])));
  const sun0 = (sunDir[0] * Math.cos(moonAzimuth)) + (sunDir[1] * Math.sin(moonAzimuth));
  const sun1 = (sunDir[1] * Math.cos(moonAzimuth)) - (sunDir[0] * Math.sin(moonAzimuth));
  const sun2 = (sunDir[2] * Math.cos(moonAltitude)) - (sun0 * Math.sin(moonAltitude));
  return { coverage, limbAngle: Math.atan2(sun2, sun1), moonAzimuth, moonAltitude };
}
