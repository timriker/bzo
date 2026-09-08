/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The observer's roaming camera, mirroring upstream's `RoamingCamera`
// (`src/bzflag/Roaming.h`) and the free-roam half of `Roaming::updatePosition`
// (`Roaming.cxx:328`) in bzo's coordinates: the ground plane is (x, z) and up is
// y, where upstream has (pos[0], pos[1]) and pos[2].
//
// Upstream drives this from the tank's own two axes -- `myTank->getSpeed()` and
// `getRotation()` in `setupRoamingCamera` (`playing.cxx:6666`) -- and remaps
// which camera axis each feeds with Ctrl/Alt/Shift. bzo cannot spend those
// modifiers, so altitude rides the two actions an observer has no other use
// for, and there is no pitch axis at all: free roam looks level, exactly as a
// driving tank does, and climbing carries the look point up with the camera
// rather than tilting it toward the ground. See the Observer section of AGENTS.md.

// Roaming.cxx:6776. Free roam translates at four times tank speed: a camera
// crossing a map wants more reach than a tank does.
export const ROAM_TRANSLATE_SPEED_FACTOR = 4;

// Roaming.cxx:6779 turns at `zoom` degrees per second, so the view slows as it
// narrows. bzo keeps that relation even though it does not yet bind zoom.
const ROAM_YAW_DEGREES_PER_ZOOM = 1;

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
export const ROAM_VIEW = Object.freeze({
  FREE: 'free',
  TRACK: 'track',
  FOLLOW: 'follow',
  FPS: 'fps',
  FLAG: 'flag',
});

export const ROAM_VIEW_ORDER = Object.freeze([
  ROAM_VIEW.FREE,
  ROAM_VIEW.TRACK,
  ROAM_VIEW.FOLLOW,
  ROAM_VIEW.FPS,
  ROAM_VIEW.FLAG,
]);

// The flag view tracks team flags only -- upstream skips any flag whose
// `flagTeam` is NoTeam -- so it is not offered where there are none to track.
export function nextRoamView(view, { allowFlag = true } = {}) {
  const order = allowFlag
    ? ROAM_VIEW_ORDER
    : ROAM_VIEW_ORDER.filter((candidate) => candidate !== ROAM_VIEW.FLAG);
  const index = order.indexOf(view);
  return order[(index + 1) % order.length];
}

// Views that need a tank to look at. The others read the roaming camera alone.
export function roamViewNeedsTarget(view) {
  return view === ROAM_VIEW.TRACK || view === ROAM_VIEW.FOLLOW || view === ROAM_VIEW.FPS;
}

// Step to the next entry, or undefined once the list is spent. `null` is the
// auto slot -- upstream's `targetManual == -1` -- so a cycle runs
// auto, first, second, ... and then falls off the end.
function nextInCycle(current, entries) {
  if (entries.length === 0) return undefined;
  if (current === null || current === undefined) return entries[0];
  const index = entries.indexOf(current);
  if (index < 0 || index === entries.length - 1) return undefined;
  return entries[index + 1];
}

// Upstream spends two bindings here: F8 cycles the view type and F6/F7 cycle the
// subject. bzo has one button for both, so the two are flattened into a single
// walk -- within a view that takes a subject, step from the leader through every
// player, then move to the next view and start at its leader again.
export function advanceRoamSelection(current, {
  playerIds = [],
  flagIndexes = [],
  allowFlag = true,
} = {}) {
  const view = current?.view;
  if (roamViewNeedsTarget(view)) {
    const nextTarget = nextInCycle(current.targetId, playerIds);
    if (nextTarget !== undefined) {
      return { view, targetId: nextTarget, flagIndex: current.flagIndex ?? null };
    }
  } else if (view === ROAM_VIEW.FLAG) {
    const nextFlag = nextInCycle(current.flagIndex, flagIndexes);
    if (nextFlag !== undefined) {
      return { view, targetId: current.targetId ?? null, flagIndex: nextFlag };
    }
  }
  return { view: nextRoamView(view, { allowFlag }), targetId: null, flagIndex: null };
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

export function createRoamCamera(floorY) {
  const y = Number.isFinite(floorY) ? floorY : 0;
  return { x: 0, y, z: 0, theta: 0, zoom: ROAM_ZOOM_DEFAULT };
}

// bzo's heading convention, matching the look target `updateCamera` builds for a
// driving tank: at theta 0 the camera faces -Z, and a positive theta turns left.
export function getRoamForward(theta) {
  return { x: -Math.sin(theta), z: -Math.cos(theta) };
}

// Pure, so `scripts/test-roam.mjs` can hold the rates against upstream's without
// a frame loop around them. `theta` is left unwrapped, as upstream leaves it.
export function updateRoamCamera(camera, input, deltaSeconds, limits) {
  const tankSpeed = Number.isFinite(limits?.tankSpeed) ? limits.tankSpeed : 0;
  const floorY = Number.isFinite(limits?.floorY) ? limits.floorY : 0;
  const step = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;

  const forward = clampAxis(input?.forward);
  const turn = clampAxis(input?.turn);
  const lift = (input?.up ? 1 : 0) - (input?.down ? 1 : 0);

  const yawRate = (camera.zoom * ROAM_YAW_DEGREES_PER_ZOOM) * (Math.PI / 180);
  const theta = camera.theta + turn * yawRate * step;

  const travel = forward * ROAM_TRANSLATE_SPEED_FACTOR * tankSpeed * step;
  const direction = getRoamForward(theta);
  const y = Math.max(floorY, camera.y + lift * ROAM_VERTICAL_SPEED_FACTOR * tankSpeed * step);

  return {
    x: camera.x + direction.x * travel,
    y,
    z: camera.z + direction.z * travel,
    theta,
    zoom: Math.max(ROAM_ZOOM_MIN, Math.min(ROAM_ZOOM_MAX, camera.zoom)),
  };
}
