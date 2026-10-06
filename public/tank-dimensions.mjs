/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzflag/blob/master/LICENSE
 */

// The outside measurements of BZFlag's own tank, in an OBJ file's axes: +X right,
// +Y up, +Z toward the rear, so a smaller Z is further forward.
//
// Measured from the high level of detail in BZFlag's src/geometry/models/tank,
// which is what upstream actually draws. They agree with misc/tank.obj, which
// bzflag-notracks.obj was made from, so the stock tank already has these and the
// generated ones are being brought to the same envelope.
//
// They are a target to fit to, not a shape to copy. A generated tank keeps its
// own style -- Modern's turret still floats clear of its hull, Wheeled 6 still
// rides on six wheels instead of tracks -- and only its overall size and
// position are brought into line, because those are what a player reads when
// two tanks slide along the same wall beside each other.
export const UPSTREAM_TANK = {
  // `_tankWidth`, `_tankHeight` and `_tankLength` from BZFlag's global.cxx.
  width: 2.8,
  height: 2.05,
  length: 6.0,
  // `_muzzleHeight`, and where a shot leaves the gun.
  muzzleHeight: 1.57,

  body: { x: [-0.88, 0.88], y: [0.25, 1.24], z: [-2.82, 3.10] },
  turret: { x: [-1.11, 1.11], y: [1.03, 2.05], z: [-1.77, 1.64] },
  // One side. The other is the mirror of it.
  tread: { x: [-1.40, -0.88], y: [0.00, 1.41], z: [-3.00, 2.97] },
  // The gun reaches well past the hull and the tracks -- 1.94 past the front
  // of the tracks -- which is most of what makes a BZFlag tank read as one
  // from the side. A barrel that stops flush with the track looks like a
  // different vehicle.
  barrel: { x: [-0.18, 0.18], y: [1.35, 1.71], z: [-4.94, -1.57] },
};

// Scales and shifts `geometry` so the axes named in `target` span exactly what
// upstream's does, leaving every other axis alone.
//
// Per axis rather than as a whole box, because a model is allowed to disagree
// with upstream about some of its shape and not the rest. A floating turret
// wants upstream's footprint and upstream's top without upstream's underside,
// which would seat it on the hull and take the float away; `anchor` says which
// end of the axis stays put while the other is brought to the target.
export function fitGeometryAxes(geometry, target, axes) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const minimums = [box.min.x, box.min.y, box.min.z];
  const maximums = [box.max.x, box.max.y, box.max.z];
  const index = { x: 0, y: 1, z: 2 };
  const scale = [1, 1, 1];
  const shift = [0, 0, 0];

  for (const [axis, anchor] of Object.entries(axes)) {
    const i = index[axis];
    const [wantMin, wantMax] = target[axis];
    const have = maximums[i] - minimums[i];
    if (have <= 1e-9) continue;
    // `both` puts the part exactly in upstream's span. `min` holds the end the
    // model has a reason for -- a floating turret's underside, which upstream
    // seats on the hull -- and stretches the far end to upstream's, so the
    // part reaches the right height without being reseated.
    if (anchor === 'min') {
      scale[i] = (wantMax - minimums[i]) / have;
      shift[i] = minimums[i] - (minimums[i] * scale[i]);
    } else if (anchor === 'max') {
      scale[i] = (maximums[i] - wantMin) / have;
      shift[i] = maximums[i] - (maximums[i] * scale[i]);
    } else {
      scale[i] = (wantMax - wantMin) / have;
      shift[i] = wantMin - (minimums[i] * scale[i]);
    }
  }

  const position = geometry.attributes.position;
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    position.setXYZ(
      vertex,
      (position.getX(vertex) * scale[0]) + shift[0],
      (position.getY(vertex) * scale[1]) + shift[1],
      (position.getZ(vertex) * scale[2]) + shift[2],
    );
  }
  position.needsUpdate = true;
  geometry.computeBoundingBox();
  // A non-uniform scale tilts every normal that is not along an axis.
  geometry.computeVertexNormals();
  return geometry;
}

// The height of the model directly under a point, or null over empty space.
//
// Nav lights rest on the deck they are over, and a light written as a literal
// goes wrong the moment the hull under it moves -- growing a body to the
// envelope above is exactly the kind of change that buries one. So a generator
// asks the geometry rather than remembering a number.
//
// `triangles` is a flat array of [x, y, z] triples, three to a triangle.
export function surfaceUnderPoint(triangles, x, z) {
  let best = null;
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const [a, b, c] = [triangles[i], triangles[i + 1], triangles[i + 2]];
    const d = ((b[2] - c[2]) * (a[0] - c[0])) + ((c[0] - b[0]) * (a[2] - c[2]));
    if (Math.abs(d) < 1e-9) continue;
    const u = (((b[2] - c[2]) * (x - c[0])) + ((c[0] - b[0]) * (z - c[2]))) / d;
    const v = (((c[2] - a[2]) * (x - c[0])) + ((a[0] - c[0]) * (z - c[2]))) / d;
    const w = 1 - u - v;
    if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
    const y = (u * a[1]) + (v * b[1]) + (w * c[1]);
    if (best === null || y > best) best = y;
  }
  return best;
}

// Where a tank's three nav lights go, worked out from the tank rather than
// remembered. A literal position is only right for the shape it was measured
// on, and goes wrong the moment a hull grows or a turret changes size.
//
// They belong on the turret. Upstream puts all three there -- white astern,
// red to port, green to starboard, at [0, 2.1, 1.53] and [+-0.75, 2.1, -0.1]
// in an OBJ file's axes -- which is the highest part of the tank and the part that
// turns, so which way a tank is pointing reads at a range where its silhouette
// does not. Placing them on the hull or the tracks instead hides them behind
// the turret from most angles and stops them turning with the gun.
//
// So they are placed at upstream's own proportions of its turret, and each
// model's turret is then what they land on. Upstream's turret spans x +-1.11
// and z -1.77..1.64, which puts its lights at about two thirds out to the
// side, its rear light almost at the back of the turret and its beam lights
// just forward of the middle.
const NAV_LIGHT_SIDE_FRACTION = 0.75 / 1.11;
const NAV_LIGHT_REAR_FRACTION = (1.53 - -1.77) / (1.64 - -1.77);
const NAV_LIGHT_BEAM_FRACTION = (-0.1 - -1.77) / (1.64 - -1.77);

export function navLightPositions(bounds) {
  const turret = bounds.get('turret');
  if (!turret) return null;

  const halfWidth = Math.max(Math.abs(turret.min[0]), Math.abs(turret.max[0]));
  const span = turret.max[2] - turret.min[2];
  const alongTurret = (fraction) => turret.min[2] + (span * fraction);
  const sideX = halfWidth * NAV_LIGHT_SIDE_FRACTION;

  return {
    lightRear: [0, alongTurret(NAV_LIGHT_REAR_FRACTION)],
    lightPort: [-sideX, alongTurret(NAV_LIGHT_BEAM_FRACTION)],
    lightStarboard: [sideX, alongTurret(NAV_LIGHT_BEAM_FRACTION)],
  };
}

// The spot a nav light actually goes, given where upstream's proportions put
// it and what the turret under it is shaped like.
//
// Upstream can use its proportions directly because it has one turret. bzo's
// turrets are all different: a low-detail one is a short cone with almost no
// flat on top, so upstream's two-thirds-out beam lights land on the slope,
// most of half a unit below the crown. A light down the shoulder is hidden by
// the turret itself from the far side, which is the one thing a nav light
// cannot afford.
//
// So the proportional spot is a starting point, and it walks in toward the
// middle of the turret until it is standing on the crown rather than the
// slope. A turret with a broad flat top keeps upstream's placement, because
// the first thing tried already qualifies.
export function navLightSpot(triangles, [x, z], turret, tolerance = 0.08) {
  const top = turret.max[1];
  const centreX = (turret.min[0] + turret.max[0]) / 2;
  const centreZ = (turret.min[2] + turret.max[2]) / 2;

  // The highest spot along the way in, not the first one that will do. A
  // turret's crown need not be over the line this walks: on the low-detail
  // turret the beam lights' own z never reaches 2.05 at all, it tops out at
  // 1.92, so a test against the turret's greatest height anywhere can pass
  // nowhere along it. Keeping the best seen answers that without needing to
  // know the shape -- and the walk still stops early on a turret that does
  // have a broad flat top, which leaves upstream's placement alone.
  // Never the whole way in: a beam light that reached the centreline would
  // stop being a beam light, and on a flat-topped turret the highest surface
  // is as good at the middle as anywhere, so nothing would pull it back out.
  // Port stays to port and starboard to starboard.
  const REACH = 0.7;

  const STEPS = 24;
  const at = (step) => {
    const t = (step / STEPS) * REACH;
    return [x + ((centreX - x) * t), z + ((centreZ - z) * t)];
  };

  // Two passes, because how high the turret gets along this line is not known
  // until the line has been walked. The first finds it; the second takes the
  // furthest-out spot that is still within `tolerance` of it.
  //
  // Furthest out rather than highest, because these are read as a pair: how
  // far apart the red and the green sit is what says which way a tank is
  // facing, and walking to the highest point puts them a quarter of the
  // separation upstream gives them, near enough together to read as one light.
  let bestSurface = -Infinity;
  for (let step = 0; step <= STEPS; step += 1) {
    const [atX, atZ] = at(step);
    const surface = surfaceUnderPoint(triangles, atX, atZ);
    if (surface !== null && surface > bestSurface) bestSurface = surface;
    if (bestSurface >= top - tolerance) break;
  }
  if (bestSurface === -Infinity) return [centreX, centreZ];

  for (let step = 0; step <= STEPS; step += 1) {
    const [atX, atZ] = at(step);
    const surface = surfaceUnderPoint(triangles, atX, atZ);
    if (surface !== null && surface >= bestSurface - tolerance) return [atX, atZ];
  }
  return [centreX, centreZ];
}
