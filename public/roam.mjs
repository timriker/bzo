/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The observer's roaming camera, mirroring upstream's `RoamingCamera`
// (`src/bzflag/Roaming.h`) and the free-roam half of `Roaming::updatePosition`
// (`Roaming.cxx:328`) in upstream's frame: the ground plane is (x, y), up is z,
// and the camera faces an azimuth, counter-clockwise from +x.
//
// Upstream drives this from the tank's own two axes -- `myTank->getSpeed()` and
// `getRotation()` in `setupRoamingCamera` (`playing.cxx:6666`) -- and remaps
// which camera axis each feeds with Ctrl/Alt/Shift. A browser cannot have Ctrl
// (Ctrl+W closes the tab; macOS takes Ctrl+arrows) or Alt (Alt+arrows is Back
// and Forward), so altitude rides the two actions an observer has no other use
// for, and Shift -- upstream's altitude -- takes the jobs of both: drive
// pitches (upstream's Ctrl) and turn strafes (upstream's Alt). Travel stays
// level whatever the pitch, as upstream's does. See the Observer section of
// AGENTS.md.

// Roaming.cxx:6776. Free roam translates at four times tank speed: a camera
// crossing a map wants more reach than a tank does.
export const ROAM_TRANSLATE_SPEED_FACTOR = 4;

// Roaming.cxx:6779 turns at `zoom` degrees per second, so the view slows as it
// narrows. bzo keeps that relation even though it does not yet bind zoom.
const ROAM_YAW_DEGREES_PER_ZOOM = 1;

// Ctrl+drive upstream (playing.cxx:6779): two thirds of `zoom` degrees a
// second, so pitch slows as the view narrows, as yaw does. Shift+drive here.
const ROAM_PITCH_DEGREES_PER_ZOOM = 2 / 3;
// Roaming.cxx:422: a thousandth of a degree short of straight up or down.
export const ROAM_PITCH_LIMIT = ((90 - 1e-3) * Math.PI) / 180;

// Upstream puts vertical on a proportional axis under Shift, also at four times
// tank speed. bzo puts it on a button, which has no proportional control, so it
// climbs at tank speed instead -- 100 u/s off a button overshoots badly.
const ROAM_VERTICAL_SPEED_FACTOR = 1;

// defaultBZDB.cxx:76-78. The default equals `displayFOV`, so a roaming view
// starts exactly as wide as a playing one.
export const ROAM_ZOOM_DEFAULT = 60;
export const ROAM_ZOOM_MIN = 15;
export const ROAM_ZOOM_MAX = 120;

// Roaming.h:36. Upstream also has `disabled`, which an observer can never reach:
// Roaming::setMode refuses it for ObserverTeam, so bzo does not model it.
// `DRIVE_FP`/`DRIVE_TP` are bzo-only (issue #68's driveable phantom tank for
// Observer and Map Viewer): a first- or third-person view of a tank the
// observer is flying rather than a real one, driven by the same local physics
// a playing tank uses. `OVERVIEW` is bzo-only too -- the world-framing camera
// a playing tank already reaches as the third entry in its own `C` cycle
// (`CAMERA_MODE_ORDER`, public/input.js), which an observer had no way to ask
// for because an observer's `C` cycles this list instead. None of the three
// needs a subject the way TRACK/FOLLOW/FPS/FLAG do, so `roamViewNeedsTarget`
// leaves them out and they are never excluded by `allowTargeted`.
export const ROAM_VIEW = Object.freeze({
  FREE: 'free',
  TRACK: 'track',
  FOLLOW: 'follow',
  FPS: 'fps',
  FLAG: 'flag',
  DRIVE_FP: 'drive-fp',
  DRIVE_TP: 'drive-tp',
  OVERVIEW: 'overview',
});

// Upstream's own five first and in its own order, then bzo's three -- so a
// cycle through a real match's views reads exactly as bzflag's does before it
// reaches anything bzo added.
export const ROAM_VIEW_ORDER = Object.freeze([
  ROAM_VIEW.FREE,
  ROAM_VIEW.TRACK,
  ROAM_VIEW.FOLLOW,
  ROAM_VIEW.FPS,
  ROAM_VIEW.FLAG,
  ROAM_VIEW.DRIVE_FP,
  ROAM_VIEW.DRIVE_TP,
  ROAM_VIEW.OVERVIEW,
]);

// The flag view tracks team flags only -- upstream skips any flag whose
// `flagTeam` is NoTeam -- so it is not offered where there are none to track.
// `allowTargeted` is Map Viewer's own restriction (issue #68): its world holds
// no other tank to track, follow or ride along with, so every view
// `roamViewNeedsTarget` would ask a subject of is left out -- FREE and the two
// driving views remain, since driving is a tank of the observer's own rather
// than a subject to find in someone else's world.
export function nextRoamView(view, { allowFlag = true, allowTargeted = true, direction = 1 } = {}) {
  const order = ROAM_VIEW_ORDER
    .filter((candidate) => allowFlag || candidate !== ROAM_VIEW.FLAG)
    .filter((candidate) => allowTargeted || !roamViewNeedsTarget(candidate));
  const index = order.indexOf(view);
  const step = direction < 0 ? -1 : 1;
  return order[(index + step + order.length) % order.length];
}

// Views that need a tank to look at. The others read the roaming camera alone.
export function roamViewNeedsTarget(view) {
  return view === ROAM_VIEW.TRACK || view === ROAM_VIEW.FOLLOW || view === ROAM_VIEW.FPS;
}

// Step to the next (or, backward, the previous) entry, or undefined once the
// list is spent in that direction. `null` is the auto slot -- upstream's
// `targetManual == -1` -- so a forward cycle runs auto, first, second, ... and
// falls off the end, and a backward one runs the same list the other way and
// falls off the front.
function nextInCycle(current, entries, direction = 1) {
  if (entries.length === 0) return undefined;
  if (direction < 0) {
    if (current === null || current === undefined) return undefined;
    const index = entries.indexOf(current);
    if (index <= 0) return null;
    return entries[index - 1];
  }
  if (current === null || current === undefined) return entries[0];
  const index = entries.indexOf(current);
  if (index < 0 || index === entries.length - 1) return undefined;
  return entries[index + 1];
}

// Upstream spends two bindings here: F8 cycles the view type and F6/F7 cycle the
// subject. bzo has one button for both, so the two are flattened into a single
// walk -- within a view that takes a subject, step from the leader through every
// player, then move to the next view and start at its leader again. `direction`
// runs the same walk backward, which is what lets left and right on a settings
// row (or `C` versus a future shift-`C`) step through it both ways -- landing
// on a new view's *last* subject rather than its leader, symmetric with a
// forward entry always landing on the leader.
export function advanceRoamSelection(current, {
  playerIds = [],
  flagIndexes = [],
  allowFlag = true,
  allowTargeted = true,
  direction = 1,
} = {}) {
  const view = current?.view;
  if (roamViewNeedsTarget(view)) {
    const nextTarget = nextInCycle(current.targetId, playerIds, direction);
    if (nextTarget !== undefined) {
      return { view, targetId: nextTarget, flagIndex: current.flagIndex ?? null };
    }
  } else if (view === ROAM_VIEW.FLAG) {
    const nextFlag = nextInCycle(current.flagIndex, flagIndexes, direction);
    if (nextFlag !== undefined) {
      return { view, targetId: current.targetId ?? null, flagIndex: nextFlag };
    }
  }
  const nextView = nextRoamView(view, { allowFlag, allowTargeted, direction });
  if (direction < 0 && roamViewNeedsTarget(nextView)) {
    return { view: nextView, targetId: playerIds[playerIds.length - 1] ?? null, flagIndex: null };
  }
  if (direction < 0 && nextView === ROAM_VIEW.FLAG) {
    return { view: nextView, targetId: null, flagIndex: flagIndexes[flagIndexes.length - 1] ?? null };
  }
  return { view: nextView, targetId: null, flagIndex: null };
}

// playing.cxx:6034, the default variant: 40 behind the target's forward and six
// muzzle heights up, looking at its base. `followDist` and `followHeight` belong
// to the smoothed variant, which `slowKeyboard` leaves off by default.
export const ROAM_FOLLOW_DISTANCE = 40;
export const ROAM_FOLLOW_HEIGHT_FACTOR = 6;

function clampAxis(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

export function createRoamCamera(floorZ) {
  const z = Number.isFinite(floorZ) ? floorZ : 0;
  return { x: 0, y: 0, z, azimuth: Math.PI / 2, pitch: 0, zoom: ROAM_ZOOM_DEFAULT };
}

// Forward along an azimuth: a positive turn is left.
export function getRoamForward(azimuth) {
  return { x: Math.cos(azimuth), y: Math.sin(azimuth) };
}

// Free roam's look point: a unit ahead on the heading, raised or lowered by the
// pitch. The horizontal step stays a unit whatever the pitch, so the heading
// read back from it (`getRoamViewAngle`) never degenerates.
export function getRoamLook(camera) {
  const heading = getRoamForward(camera.azimuth);
  return {
    x: camera.x + heading.x,
    y: camera.y + heading.y,
    z: camera.z + Math.tan(Number.isFinite(camera.pitch) ? camera.pitch : 0),
  };
}

// The heading a resolved view points, which is upstream's `roamViewAngle`
// (playing.cxx:6088): the angle from the eye to the look point, so a view that
// tracks a tank faces whatever it is watching. The inverse of getRoamForward. A
// look point standing exactly over the eye names no heading of its own and
// `fallbackAzimuth` stands in -- upstream never meets that case, because every
// one of its look points is offset horizontally.
export function getRoamViewAngle(eye, look, fallbackAzimuth = 0) {
  const dx = look.x - eye.x;
  const dy = look.y - eye.y;
  if (Math.hypot(dx, dy) < 1e-6) return fallbackAzimuth;
  return Math.atan2(dy, dx);
}

// Pure, so `scripts/test-roam.mjs` can hold the rates against upstream's without
// a frame loop around them. `azimuth` is left unwrapped, as upstream leaves its
// angle.
export function updateRoamCamera(camera, input, deltaSeconds, limits) {
  const tankSpeed = Number.isFinite(limits?.tankSpeed) ? limits.tankSpeed : 0;
  const floorZ = Number.isFinite(limits?.floorZ) ? limits.floorZ : 0;
  const step = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;

  const forward = clampAxis(input?.forward);
  const turn = clampAxis(input?.turn);
  // Shift spends both axes: drive pitches instead of travelling, as upstream's
  // `!control && !shift` guard on translation, and turn strafes instead of
  // yawing, as upstream's Alt does -- `4 * rotation * tankSpeed` sideways,
  // left for a positive turn (playing.cxx:6776-6778).
  const pitching = input?.pitch === true;
  const lift = (input?.up ? 1 : 0) - (input?.down ? 1 : 0);

  const yawRate = (camera.zoom * ROAM_YAW_DEGREES_PER_ZOOM) * (Math.PI / 180);
  const azimuth = camera.azimuth + (pitching ? 0 : turn * yawRate * step);
  const strafe = pitching ? turn * ROAM_TRANSLATE_SPEED_FACTOR * tankSpeed * step : 0;

  const travel = pitching ? 0 : forward * ROAM_TRANSLATE_SPEED_FACTOR * tankSpeed * step;
  const pitchRate = (camera.zoom * ROAM_PITCH_DEGREES_PER_ZOOM) * (Math.PI / 180);
  const pitchBefore = Number.isFinite(camera.pitch) ? camera.pitch : 0;
  const pitch = Math.max(-ROAM_PITCH_LIMIT, Math.min(ROAM_PITCH_LIMIT,
    pitchBefore + (pitching ? forward * pitchRate * step : 0)));
  const direction = getRoamForward(azimuth);
  const z = Math.max(floorZ, camera.z + lift * ROAM_VERTICAL_SPEED_FACTOR * tankSpeed * step);

  // Left of the heading: the forward vector turned a quarter counter-clockwise.
  return {
    x: camera.x + direction.x * travel - direction.y * strafe,
    y: camera.y + direction.y * travel + direction.x * strafe,
    z,
    azimuth,
    pitch,
    zoom: Math.max(ROAM_ZOOM_MIN, Math.min(ROAM_ZOOM_MAX, camera.zoom)),
  };
}
