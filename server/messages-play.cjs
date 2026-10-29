/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Playing: moves and the data channel they ride, teleports, shots, flags and
// zones, joining, team and tank, pause, the autopilot and XR. Each handler
// takes the player who sent the message, their socket and the message;
// acceptConnection (server.js) calls it by the message's `type`, through
// MESSAGE_HANDLERS.

const { DEFAULT_TANK_SKIN, normalizeTankSkinId } = require('../public/js/tank-skins.mjs');
const {
  FLAG_ENDURANCE,
  applyAccelerationLimit,
  canJump,
  canShakeFlag,
  getAccelerationLimits,
  getFlagType,
  getMaxAngVelFactor,
  getMaxSpeedFactor,
  getMotionEffects,
  getShotEffects,
  hasAirControl,
  togglesZoneOnTeleport,
} = require('../public/js/flags.mjs');
const {
  PLAYER_TEAM,
  getJoinPlayerColor,
  getTeamColorIndex,
  isColorTeam,
  isColorTeamIndex,
  isObserverTeam,
  normalizePlayerTeamSelection,
  selectPlayerTeam,
} = require('./teams.cjs');
const { getShotFlight } = require('./shots.cjs');

// What the handlers need of server.js, from `useServer`. `UDP_CHANNELS`,
// `pendingMoveBroadcasts`, `projectileIdCounter`, `rabbitPlayerId` change
// while the server runs, so they are read and written through `server` each
// time instead.
let server = null;
let ALLOW_JUMPING;
let ANTICHEAT_CONFIG;
let ANTIDOTE_FLAGS;
let CTF_ENABLED;
let DEATH_REASON;
let FLAG_SHAKE_TIMEOUT;
let GAME_CONFIG;
let JUMP_START_VERTICAL_VELOCITY;
let MAX_TOTAL_PLAYERS;
let Player;
let Projectile;
let RABBIT_SELECTION;
let SPEED_QUANTIZATION_SLACK;
let TEAM_MODE;
let UDP_CHANNEL_OFFER_INTERVAL_MS;
let anointNewRabbit;
let applyObserverHeartbeat;
let applyPlayerTeleportMessage;
let applyShotPlayerHit;
let bans;
let bots;
let broadcastAll;
let broadcastFlagUpdate;
let broadcastPlayerRecord;
let broadcastTeamScores;
let captureFlag;
let checkAntidote;
let clampToArrivalGap;
let clearPauseTimers;
let countFlagShot;
let decayPlayerTeleportReentryBlock;
let dropFlag;
let dropPlayerFlag;
let flags;
let flushChannelMoves;
let flushMoveBroadcasts;
let formatShotPoint;
let getAccelerationWindow;
let getAvailableShotSlot;
let getLockTarget;
let getPlayerFlag;
let getRosterFor;
let getShotFlagFor;
let getShotRejection;
let getShotVelocityRejection;
let getSpawnPosition;
let getTeamBaseCenters;
let getTeamScoreState;
let getZoneRefusal;
let grabFlag;
let handleRabbitSpawn;
let idBanRefusal;
let isAdmin;
let isAllowedTankModel;
let isPlayerInsideBuilding;
let isPlayerZoned;
let isSwitchableTeam;
let killPlayer;
let log;
let logMalformed;
let matchClock;
let normalizeTankModelId;
let noteHeardFrom;
let noteRejoinWait;
let occupyShotSlot;
let openUdpChannel;
let players;
let projectiles;
let queueChannelMove;
let refreshVoiceRosters;
let rejoinWaitMs;
let removeFromServer;
let replyToPlayer;
let reportCheat;
let reportJumpRejection;
let reportShotRejection;
let reportToListServer;
let requestPause;
let resetTeamFlags;
let resolveJoinName;
let resolveViewMapChoice;
let restoreConnectTime;
let restoreScore;
let retireTeamFlags;
let sanitizeMotto;
let scheduleBotReconcile;
let searchFlag;
let sendMoveToBzflagClients;
let setAutopilot;
let setPlayerTarget;
let supersedeEarlierConnection;
let teamScores;
let traceShotBeam;
let validateMovement;
let wireShot;

function useServer(deps, live) {
  server = live;
  ({
    ALLOW_JUMPING,
    ANTICHEAT_CONFIG,
    ANTIDOTE_FLAGS,
    CTF_ENABLED,
    DEATH_REASON,
    FLAG_SHAKE_TIMEOUT,
    GAME_CONFIG,
    JUMP_START_VERTICAL_VELOCITY,
    MAX_TOTAL_PLAYERS,
    Player,
    Projectile,
    RABBIT_SELECTION,
    SPEED_QUANTIZATION_SLACK,
    TEAM_MODE,
    UDP_CHANNEL_OFFER_INTERVAL_MS,
    anointNewRabbit,
    applyObserverHeartbeat,
    applyPlayerTeleportMessage,
    applyShotPlayerHit,
    bans,
    bots,
    broadcastAll,
    broadcastFlagUpdate,
    broadcastPlayerRecord,
    broadcastTeamScores,
    captureFlag,
    checkAntidote,
    clampToArrivalGap,
    clearPauseTimers,
    countFlagShot,
    decayPlayerTeleportReentryBlock,
    dropFlag,
    dropPlayerFlag,
    flags,
    flushChannelMoves,
    flushMoveBroadcasts,
    formatShotPoint,
    getAccelerationWindow,
    getAvailableShotSlot,
    getLockTarget,
    getPlayerFlag,
    getRosterFor,
    getShotFlagFor,
    getShotRejection,
    getShotVelocityRejection,
    getSpawnPosition,
    getTeamBaseCenters,
    getTeamScoreState,
    getZoneRefusal,
    grabFlag,
    handleRabbitSpawn,
    idBanRefusal,
    isAdmin,
    isAllowedTankModel,
    isPlayerInsideBuilding,
    isPlayerZoned,
    isSwitchableTeam,
    killPlayer,
    log,
    logMalformed,
    matchClock,
    normalizeTankModelId,
    noteHeardFrom,
    noteRejoinWait,
    occupyShotSlot,
    openUdpChannel,
    players,
    projectiles,
    queueChannelMove,
    refreshVoiceRosters,
    rejoinWaitMs,
    removeFromServer,
    replyToPlayer,
    reportCheat,
    reportJumpRejection,
    reportShotRejection,
    reportToListServer,
    requestPause,
    resetTeamFlags,
    resolveJoinName,
    resolveViewMapChoice,
    restoreConnectTime,
    restoreScore,
    retireTeamFlags,
    sanitizeMotto,
    scheduleBotReconcile,
    searchFlag,
    sendMoveToBzflagClients,
    setAutopilot,
    setPlayerTarget,
    supersedeEarlierConnection,
    teamScores,
    traceShotBeam,
    validateMovement,
    wireShot,
  } = deps);
}

function handleTp(player, ws, message) {
  if (isObserverTeam(player.team)) return;

  const now = Date.now();
  const sourceState = {
    x: Number(message.x),
    y: Number(message.y),
    z: Number(message.z),
    azimuth: Number(message.a),
    airVelocityX: Number(message.vx),
    airVelocityY: Number(message.vy),
    jumpAzimuth: message.ja === null ? null : Number(message.ja),
    vv: Number(message.vv),
  };
  const fromFaceId = Number(message.fromFaceId);
  const toFaceId = Number(message.toFaceId);
  const teleportResult = applyPlayerTeleportMessage(player, sourceState, fromFaceId, toFaceId, now);

  if (!teleportResult.ok) {
    ws.send(JSON.stringify({
      type: 'positionCorrection',
      x: player.x,
      y: player.y,
      z: player.z,
      a: player.azimuth,
      vv: player.verticalVelocity || 0,
    }));
    if (teleportResult.reason !== 'cooldown' && teleportResult.reason !== 'reentry_block') {
      log(`[PLAYER_TP_REJECT] player=${player.id} fromFace=${fromFaceId} toFace=${toFaceId} reason=${teleportResult.reason}`);
    }
    return;
  }

  const ptPacket = {
    type: 'pt',
    id: player.id,
    x: player.x,
    y: player.y,
    z: player.z,
    a: player.azimuth,
    fs: player.forwardSpeed || 0,
    rs: player.rotationSpeed || 0,
    vv: player.verticalVelocity || 0,
    vx: player.airVelocityX || 0,
    vy: player.airVelocityY || 0,
    fromFaceId: teleportResult.fromFaceId,
    toFaceId: teleportResult.toFaceId,
    ja: player.jumpAzimuth,
  };
  if (player.slideAzimuth !== undefined) {
    ptPacket.sd = player.slideAzimuth;
  }


  broadcastAll(ptPacket);
  log(
    `[PLAYER_TP] player=${player.id} srcFace=${teleportResult.fromFaceId} ` +
    `dstFace=${teleportResult.toFaceId} pos=(${player.x.toFixed(2)},${player.y.toFixed(2)},${player.z.toFixed(2)})`
  );
  return;
}

function handleRtc(player, ws, message) {
  // The browser's half of the UDP channel's signalling: an offer
  // opens a new peer in place of any earlier one, candidates follow.
  if (!server.UDP_CHANNELS) return;
  if (typeof message.cipher === 'string') {
    if (/^[A-Z0-9_]{1,64}$/.test(message.cipher)) log(`[RTC] ${player.joined ? `"${player.name}"` : `#${player.id}`} ${message.cipher}`);
    return;
  }
  if (message.sdpType === 'offer') {
    const now = Date.now();
    if (now - (player.udpChannelOfferAt || 0) < UDP_CHANNEL_OFFER_INTERVAL_MS) return;
    player.udpChannelOfferAt = now;
    player.udpChannel?.close();
    player.udpChannelHeard = false;
    player.udpChannel = openUdpChannel(player, ws);
  }
  try {
    player.udpChannel?.signal(message);
  } catch (error) {
    log(`[RTC] "${player.name}": ${error.message}`);
    player.udpChannel?.close();
  }
  return;
}

function handleM(player, ws, message) {
  // A connection that has not joined has no tank for a move to be
  // about: its stored position is still the default, so judging one
  // reports the client's previous session as drift.
  if (!player.joined) return;
  noteHeardFrom(player);
  if (isObserverTeam(player.team)) {
    applyObserverHeartbeat(player, message, ws);
    return;
  }

  const now = Date.now();
  // Calculate deltaTime based on server's last update time
  const deltaTime = (now - player.lastUpdate) / 1000;
  // DON'T update player.lastUpdate here - it breaks extrapolation in validateMovement!

  // The interval the drift check extrapolates over: the client's own
  // clock between this move and the last *accepted* one (see
  // `lastClientTimestamp`), clamped to no more than the server's own
  // arrival gap plus SDT_JITTER_ALLOWANCE -- the claim may only widen
  // the window the server itself measured, and only by that much, the
  // same bound the acceleration check already trusts `sdt` with.
  // `ct` is already seconds relative to the client's own origin (see
  // `clientClockOrigin` in client.js) -- only ever differenced against
  // this client's own previous value, never read as an absolute time.
  // docs/lag-plan.md, "Extrapolate on the client's clock, not ours".
  const clientTimestamp = Number(message.ct);
  const hasClientTimestamp = Number.isFinite(clientTimestamp) && Number.isFinite(player.lastClientTimestamp);
  const clientElapsed = hasClientTimestamp
    ? clampToArrivalGap(deltaTime, clientTimestamp - player.lastClientTimestamp)
    : deltaTime;

  // Only accept new compact field names. `r` is the heading, an
  // azimuth, read off the wire's `a`.
  const x = Number(message.x);
  const y = Number(message.y);
  const z = Number(message.z);
  const r = Number(message.a);
  const reverseSpeedRatio = Number.isFinite(GAME_CONFIG.REVERSE_SPEED_RATIO)
    ? GAME_CONFIG.REVERSE_SPEED_RATIO
    : 0.5;
  // `fs` and `rs` are fractions of the world's *base* speed and turn
  // rate, so a tank carrying `V`, `QT` or `A` reports more than 1 and
  // `getExtrapolatedPosition` places it correctly with no flag state of
  // its own. What the server needs here is only the bound, and only the
  // flag's largest -- Agility's window is the client's to run, and a
  // ceiling costs nothing to hold.
  const motionFlag = getPlayerFlag(player.id)?.type ?? null;
  const maxSpeedFactor = getMaxSpeedFactor(motionFlag);
  const maxAngVelFactor = getMaxAngVelFactor(motionFlag);
  const requestedFS = Math.max(
    -reverseSpeedRatio * maxSpeedFactor,
    Math.min(maxSpeedFactor, Number(message.fs)));
  const requestedRS = Math.max(
    -maxAngVelFactor, Math.min(maxAngVelFactor, Number(message.rs)));
  let fs = requestedFS;
  let rs = requestedRS;
  const vv = Number(message.vv);

  if (!Number.isFinite(requestedFS) || !Number.isFinite(requestedRS) || !Number.isFinite(vv)) {
    logMalformed(player, 'MOVE', `velocities fs=${message.fs} rs=${message.rs} vv=${message.vv}`);
    return;
  }

  // The client sends the speed it actually reached, not the key it is
  // holding, so a speed that changed faster than the tank can change
  // speed is a disagreement worth reporting. Only strict mode rewrites
  // it: silently substituting the server's value in warning mode moves
  // the tank the client never asked to move, and then reports the
  // difference back as drift.
  const accelWindow = getAccelerationWindow(deltaTime, message.sdt);
  // `LagInfo::updateLag` (LagInfo.cxx:214). Upstream differences the
  // client's absolute timestamp against its own arrival time; bzo has
  // the same two intervals already -- how long the server waited for
  // this packet, and how long the client says it took to send it -- so
  // jitter needs no field the move does not carry. Measured whatever
  // the anti-cheat mode is: it is a statistic, not a judgement.
  const stall = player.lag.recordUpdate(now, Number(message.sdt));
  // A move held up on TCP: logged, at most once a second a player, to
  // judge whether moves need a lossy transport (docs/lag-plan.md).
  // A server bot's moves never cross a network, so it is left out.
  if (stall && !bots.has(player.id) && now - (player.lastStallLogAt || 0) >= 1000) {
    player.lastStallLogAt = now;
    log(`[LAG] "${player.name}" stalled ${stall.waitedMs}ms (sent ${stall.sentMs}ms apart)`);
  }
  // A third thing the acceleration model has no term for, beside the two
  // in "The acceleration check cannot see the stick": air control. A
  // `WG` tank steers in mid air, and with `_wingsSlideTime` 0 -- which is
  // upstream's default and bzo's -- its velocity follows the stick with
  // no ramp at all, so a full reversal in one frame is correct rather
  // than impossible. No acceleration bound can describe that, so while
  // such a tank is off the ground the bound does not apply. Refusing it
  // in strict mode would rubber-band the one flag whose whole point is
  // steering where nothing else can.
  const airborne = player.jumpAzimuth !== null && player.jumpAzimuth !== undefined;
  const steeringInAir = airborne && hasAirControl(getPlayerFlag(player.id)?.type ?? null);
  // `_disableSpeedChecks` turns the speed check off outright, as
  // upstream's sets its tolerance to infinity (bzfs.cxx:4442).
  if (ANTICHEAT_CONFIG.mode !== 'disabled' && accelWindow > 0 && !steeringInAir
    && GAME_CONFIG.DISABLE_SPEED_CHECKS !== true) {
    // The stick is not in the packet, so the server cannot tell which of
    // the client's rates applied (`updateMovement` in `client.js` picks
    // deceleration by the *desired* input, which the server never sees,
    // and both decelerations are faster than their accelerations). It
    // therefore allows the fastest rate any stick position could have
    // produced. Anything tighter refuses a tank that is merely letting
    // go of a key.
    //
    // The bound is `doMomentum`'s own, run against the same limits the
    // client drove with: the world's `-a`, composed with `M` if the tank
    // is carrying it. With `-a 0 0` -- upstream's default and bzo's --
    // there is no limit, `applyAccelerationLimit` returns what was asked
    // for, and this check finds nothing. That is correct rather than
    // lax: a tank with no inertia really can reach full speed in a
    // frame, and what bounds it then is the speed clamp above.
    //
    // In real units on both sides, because that is what a limit is
    // expressed in. `fs` and `rs` come off the wire as fractions of the
    // world's base speed and turn rate, so they are converted here and
    // back again.
    const limits = getAccelerationLimits(
      motionFlag, GAME_CONFIG.LINEAR_ACCELERATION, GAME_CONFIG.ANGULAR_ACCELERATION);
    const tankSpeed = GAME_CONFIG.TANK_SPEED || 1;
    const tankAngVel = GAME_CONFIG.TANK_ROTATION_SPEED || 1;

    // Agility's boost lands all at once -- the window opens and the tank
    // is 2.25x faster in that same frame -- so no acceleration bound can
    // describe it, which is the Wings exemption above for a different
    // reason. Only the forward half is exempt; Agility does not touch
    // turning, so that bound still holds.
    const burstsSpeed = getMotionEffects(motionFlag).agility;

    let limitedFS = burstsSpeed ? requestedFS : applyAccelerationLimit(
      (player.forwardSpeed || 0) * tankSpeed,
      requestedFS * tankSpeed,
      limits.linear,
      accelWindow,
    ) / tankSpeed;
    let limitedRS = applyAccelerationLimit(
      (player.rotationSpeed || 0) * tankAngVel,
      requestedRS * tankAngVel,
      limits.angular,
      accelWindow,
    ) / tankAngVel;

    limitedFS = Math.max(
      -reverseSpeedRatio * maxSpeedFactor, Math.min(maxSpeedFactor, limitedFS));
    limitedRS = Math.max(-maxAngVelFactor, Math.min(maxAngVelFactor, limitedRS));

    // Both endpoints are quantized to 0.01 by the sender, so the
    // difference carries up to 0.02 that is rounding, not a finding.
    const fsExceeded = Math.abs(limitedFS - requestedFS) > SPEED_QUANTIZATION_SLACK;
    const rsExceeded = Math.abs(limitedRS - requestedRS) > SPEED_QUANTIZATION_SLACK;
    if (fsExceeded || rsExceeded) {
      // `_speedChecksLogOnly`: upstream's speed check logs and does
      // not kick (bzfs.cxx:5404), so this one logs and does not refuse.
      const refused = reportCheat(player, 'speedClamped',
        `SPEED CHANGED TOO FAST: fs ${(player.forwardSpeed || 0).toFixed(2)}->${requestedFS.toFixed(2)}`
        + ` (limit ${limitedFS.toFixed(2)}),`
        + ` rs ${(player.rotationSpeed || 0).toFixed(2)}->${requestedRS.toFixed(2)}`
        + ` (limit ${limitedRS.toFixed(2)}),`
        + ` window=${accelWindow.toFixed(3)}s (arrival ${deltaTime.toFixed(3)}s, client ${message.sdt})`,
        null, GAME_CONFIG.SPEED_CHECKS_LOG_ONLY !== true);
      if (refused) {
        fs = limitedFS;
        rs = limitedRS;
      }
    } else {
      fs = limitedFS;
      rs = limitedRS;
    }
  }

  // Optional slide heading, and the air velocity.
  const d = message.sd !== undefined ? Number(message.sd) : undefined;
  const vx = message.vx !== undefined ? Number(message.vx) : undefined;
  const vy = message.vy !== undefined ? Number(message.vy) : undefined;
  const hasAirVelocity = Number.isFinite(vx) && Number.isFinite(vy);

  const previousState = {
    x: player.x,
    y: player.y,
    z: player.z,
    azimuth: player.azimuth,
  };

  const teleportReentryActive = player.teleportReentryBlockTeleporterIndex !== null
    && (player.teleportReentryBlockDistance > 1e-6 || now < (player.teleportReentryBlockUntil || 0));

  // Track jump direction for extrapolation
  const oldVV = player.verticalVelocity || 0;
  // A tank that was not already climbing and now is has jumped: a
  // grounded one reports exactly 0 and a falling one reports negative,
  // both quantized to two decimals by the sender.
  //
  // The threshold is a tenth of the world's own jump velocity rather
  // than a fixed number, because `BY` Bouncy's bounce is a random
  // quarter-to-full of that velocity and starts as low as 4.75 at bzo's
  // default -- a fixed threshold high enough to clear the quantization
  // would miss those jumps and go on extrapolating the tank along the
  // ground while it was in the air. A tenth is clear of the
  // quantization, under anything that could be a real jump, and follows
  // a server that has tuned the jump.
  const isJumpStart = oldVV <= 0 && vv > JUMP_START_VERTICAL_VELOCITY;
  const isLanding = player.jumpAzimuth !== null && vv === 0; // Transition from air to ground
  const isFallStart = player.jumpAzimuth === null && vv < 0; // Started falling (drove off edge)

  // Log jump/land/fall events but DON'T update jumpDirection yet - must validate first
  if (isJumpStart) {
    // Calculate expected landing position (assuming ~2 second flight)
    const jumpTime = 2.05; // Approximate jump duration
    const speed = GAME_CONFIG.TANK_SPEED || 15;
    const rotSpeed = GAME_CONFIG.TANK_ROTATION_SPEED || 1.5;
    const dx = Math.cos(r) * fs * speed * jumpTime;
    const dy = Math.sin(r) * fs * speed * jumpTime;
    const expectedLandX = x + dx;
    const expectedLandY = y + dy;
    const expectedLandR = r + rs * rotSpeed * jumpTime;
    log(`[JUMP] "${player.name}" jumped: pos=(${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}), r=${r.toFixed(2)}, fs=${fs.toFixed(2)}, rs=${rs.toFixed(2)}, vv=${vv.toFixed(2)}`);
    log(`[JUMP] Expected landing: pos=(${expectedLandX.toFixed(2)},${expectedLandY.toFixed(2)}), r=${expectedLandR.toFixed(2)}`);
  } else if (isLanding) {
    log(`[LAND] "${player.name}" landed: pos=(${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}), r=${r.toFixed(2)}, fs=${fs.toFixed(2)}, rs=${rs.toFixed(2)}, vv=${vv.toFixed(2)}`);
  } else if (isFallStart) {
    log(`[FALL] "${player.name}" started falling: pos=(${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}), r=${r.toFixed(2)}, fs=${fs.toFixed(2)}, rs=${rs.toFixed(2)}, vv=${vv.toFixed(2)}`);
  }

  // Check if velocities changed significantly - if so, use looser validation
  const fsChanged = Math.abs(fs - (player.forwardSpeed || 0)) > 0.1;
  const rsChanged = Math.abs(rs - (player.rotationSpeed || 0)) > 0.1;
  const vvChanged = Math.abs(vv - (player.verticalVelocity || 0)) > 0.5;
  const isSliding = d !== undefined; // Use loose validation whenever sliding (extrapolation may not match)
  const velocityChanged = fsChanged || rsChanged || vvChanged || isSliding;

  // Whether this tank may leave a surface at all. The flap count is not
  // tracked here -- following it would mean running the client's whole
  // ground/air state machine off position updates -- so the server asks
  // the weaker question it can answer, and Wings is taken at its word
  // about how many flaps it has left.
  const carriedFlagType = getPlayerFlag(player.id)?.type ?? null;
  const mayNotJump = isJumpStart
    && !canJump(carriedFlagType, ALLOW_JUMPING, false, GAME_CONFIG.WINGS_JUMP_COUNT,
      isPlayerInsideBuilding(player, x, y, z, r));
  const jumpRefused = mayNotJump && reportJumpRejection(player, carriedFlagType);

  // Extrapolate over the client's own clamped interval where the
  // packet carries one, the server's arrival gap otherwise -- see
  // `clientElapsed` above. Either way the extrapolated position
  // accounts for the full interval using OLD velocities.
  if (!jumpRefused && validateMovement(
    player,
    x,
    y,
    z,
    r,
    clientElapsed,
    velocityChanged,
    { ignoreTeleporters: teleportReentryActive },
    now
  )) {
    // Validation passed - now update jumpDirection
    if (isJumpStart) {
      player.jumpAzimuth = r; // Store the heading at jump start
    } else if (isFallStart) {
      player.jumpAzimuth = r; // Store the heading at fall start (same as jump)
    } else if (isLanding) {
      player.jumpAzimuth = null; // Clear jump direction on landing
    }

    // Update position/rotation AND velocities for next extrapolation
    player.x = x;
    player.y = y;
    player.z = z;
    player.azimuth = r;
    player.forwardSpeed = fs;
    player.rotationSpeed = rs;
    player.verticalVelocity = vv;
    player.slideAzimuth = d; // Store slide direction (undefined if not sliding)
    // The accepted move as the shot check reads it: a shot the client
    // fires next inherits the velocity these numbers state
    // (`packetVelocity`), whatever the server's own reading of the jump.
    // As the move states them, which `moveVelocity` reads.
    player.lastMoveFields = {
      a: r, fs, sd: d, vv, vx, vy, air: Number(message.air) === 1 ? 1 : 0, at: now,
    };
    if (hasAirVelocity) {
      player.airVelocityX = vx;
      player.airVelocityY = vy;
    } else if (player.jumpAzimuth !== null) {
      const speed = GAME_CONFIG.TANK_SPEED || 15;
      const moveAzimuth = d !== undefined ? d : player.jumpAzimuth;
      player.airVelocityX = Math.cos(moveAzimuth) * fs * speed;
      player.airVelocityY = Math.sin(moveAzimuth) * fs * speed;
    } else {
      player.airVelocityX = 0;
      player.airVelocityY = 0;
    }

    const movedPlanarDistance = Math.hypot(player.x - previousState.x, player.y - previousState.y);
    decayPlayerTeleportReentryBlock(player, movedPlanarDistance, now);

    player.lastUpdate = now; // Update timestamp AFTER accepting the move
    if (Number.isFinite(clientTimestamp)) player.lastClientTimestamp = clientTimestamp;

    const pmPacket = {
      id: player.id,
      x,
      y,
      z,
      a: r,
      fs,
      rs,
      vv,
      vx: player.airVelocityX,
      vy: player.airVelocityY,
    };

    // Include optional slide heading if present
    if (d !== undefined) {
      pmPacket.sd = d;
    }

    // Queued rather than broadcast here: one WS frame per move meant
    // one per recipient per move, O(players^2) frames a tick. Batched
    // in `flushMoveBroadcasts`, called once from `gameLoop`, so a busy
    // tick costs one frame per connected client instead.
    server.pendingMoveBroadcasts.push(pmPacket);
    sendMoveToBzflagClients(pmPacket);
    queueChannelMove(pmPacket);

    checkAntidote(player, now);
  } else {
    // Validation failed - jumpDirection unchanged (no update needed)
    // Send correction back to client
    // Reset velocities and timestamp so next extrapolation starts from corrected state
    player.forwardSpeed = 0;
    player.rotationSpeed = 0;
    player.verticalVelocity = 0;
    player.airVelocityX = 0;
    player.airVelocityY = 0;
    player.lastUpdate = now;
    ws.send(JSON.stringify({
      type: 'positionCorrection',
      x: player.x,
      y: player.y,
      z: player.z,
      a: player.azimuth,
      vv: 0,
    }));

  }
  return;
}

function handleShoot(player, ws, message) {
  // message: { type: 'shoot', x, y, z, vx, vy, vz }
  const now = Date.now();
  const from = { x: Number(message.x), y: Number(message.y), z: Number(message.z) };
  const shotRejection = getShotRejection(player, from.x, from.y, from.z, now);
  if (shotRejection
    && reportShotRejection(player, shotRejection.reason, message, shotRejection.fatal)) {
    return;
  }
  const velocity = { x: Number(message.vx), y: Number(message.vy), z: Number(message.vz) };
  if (!Number.isFinite(velocity.x) || !Number.isFinite(velocity.y) || !Number.isFinite(velocity.z)) {
    reportShotRejection(player, 'shot velocity is not a finite number', message, true);
    return;
  }
  const shotFlag = getShotFlagFor(player);
  const shotEffects = getShotEffects(shotFlag);
  // LocalPlayer::fireShot makes a shock wave stationary whatever the
  // tank was doing, and so does the flight below; there is no speed of
  // its own to check.
  const velocityRejection = shotEffects.shockwave ? null : getShotVelocityRejection(player, velocity, now);
  if (velocityRejection && reportShotRejection(player, velocityRejection, message, false)) return;
  const flight = getShotFlight(velocity, shotEffects, GAME_CONFIG.SHOT_SPEED);
  if (!flight) {
    reportShotRejection(player, 'shot velocity has no direction', message, true);
    return;
  }
  // A shot allowed past the slot check in warning mode has no slot left
  // to take. It flies with slot -1: the reload bar ignores it, and the
  // log above already says the client thought it had one.
  const shotSlot = getAvailableShotSlot(player, now);
  occupyShotSlot(player, shotSlot, shotFlag, now);
  const id = (++server.projectileIdCounter).toString();
  const proj = new Projectile(
    id,
    player.id,
    shotSlot,
    from.x,
    from.y,
    from.z,
    flight.x,
    flight.y,
    flight.z,
    // ShotPath::FiringInfo (ShotPath.cxx:46): an unzoned Phantom Zone
    // tank fires ordinary shells, so the flag a shot is fired under is
    // not always the flag its shooter is holding.
    shotFlag,
    now,
    flight.speed
  );
  projectiles.set(id, proj);
  // A beam is already everywhere it is going to be, so its path is walked
  // here and travels with the message that announces it. The tank it
  // reached is resolved after that message, because the client has to
  // have the shot before it is told the shot killed somebody.
  const beamHit = proj.beam ? traceShotBeam(proj, proj.createdAt) : null;
  log(
    `[shotBegin] id=${proj.id} player=${proj.playerId} slot=${proj.shotSlot}` +
    ` pos=${formatShotPoint(proj.x, proj.y, proj.z)}` +
    ` dir=(${proj.dirX.toFixed(4)},${proj.dirY.toFixed(4)},${proj.dirZ.toFixed(4)})` +
    ` speed=${proj.speed.toFixed(2)}` +
    ` flag=${proj.flag || 'none'}${proj.ricochet ? ' ricochet' : ''}` +
    (proj.beam ? ` beam=${proj.segments.length}seg end=${proj.endReason}` : '') +
    (proj.shockwave ? ` shockwave life=${proj.lifetimeSeconds.toFixed(3)}s` : '')
  );
  // The move that came with the shot goes out ahead of it, to everyone:
  // upstream's client sends a player update before every shot
  // (LocalPlayer.cxx:1266) and bzfs relays both as they come, so a
  // tank is never seen behind its own muzzle. A BZFlag client already
  // had the move (`sendMoveToBzflagClients`); a UDP channel's waits for
  // the end of this turn and the WebSocket's for the tick.
  flushChannelMoves();
  flushMoveBroadcasts();
  broadcastAll({
    type: 'shotBegin',
    id: proj.id,
    playerId: proj.playerId,
    shotSlot: proj.shotSlot,
    ...wireShot(proj),
    flag: proj.flag,
    ricochet: proj.ricochet,

    // FiringInfo's `shot.team`: the shooter's team as it fired. Only
    // carried, as upstream's is -- who a shot may hit is still asked of
    // the shooter (`getShotTeam`).
    team: player.team,
    // Who the shooter has locked, so a client that has not seen a
    // `gmUpdate` for them yet still steers this missile from its first
    // frame -- and so the tank being shot at learns of it, which is when
    // upstream warns them rather than when the lock was taken.
    target: proj.guided ? (getLockTarget(proj.playerId)?.id ?? null) : null,
    createdAt: proj.createdAt
  });
  if (beamHit) applyShotPlayerHit(proj, id, beamHit.player, beamHit.point);
  countFlagShot(player);
  return;
}

// MsgQueryPlayers (`bzfs.cxx:3145`). Upstream answers it with the team
// table and one MsgAddPlayer per player -- the whole roster, on demand.
// Its game client never asks, because its world arrives before it
// enters and nothing can land in between; a bzo client builds the world
// after it is already receiving, so it asks once it is ready to draw
// everyone, and that is what guarantees a full scoreboard however the
// reconnects raced.
// setTarget() on upstream's `identify` binding (ActionBinding.cxx:97).
// An observer picks its roaming target on its own client, where the free
// camera it aims with lives; a tank asks here, because the answer steers
// a guided missile.
function handleIdentify(player) {
  if (isObserverTeam(player.team) || !player.alive || player.paused) return;
  setPlayerTarget(player);
  return;
}

function handleQueryPlayers(player, ws) {
  ws.send(JSON.stringify({
    type: 'playerList',
    players: getRosterFor(player),
  }));
  // sendQueryPlayers sends the team table with the roster, directed at
  // the one player who asked rather than broadcast.
  if (TEAM_MODE.enabled) {
    ws.send(JSON.stringify({ type: 'teamUpdate', teams: getTeamScoreState() }));
  }
  return;
}

// The Identify flag asking what the nearest flag is. The client sweeps
// for itself and only asks about one it cannot already name, so this
// arrives once per flag rather than on every position update the way
// upstream's own push does.
function handleNearFlag(player) {
  if (!player.joined) return;
  searchFlag(player);
  return;
}

function handleGrabFlag(player, ws, message) {
  if (!player.joined) return;
  const requestedIndex = Number(message.index);
  if (!Number.isInteger(requestedIndex)) return;
  const flag = flags[requestedIndex];
  if (!flag) return;
  grabFlag(player, flag, Date.now());
  return;
}

function handleCaptureFlag(player, ws, message) {
  if (!player.joined) return;
  const baseTeam = Number(message.team);
  if (!isColorTeamIndex(baseTeam)) return;
  captureFlag(player, baseTeam);
  return;
}

function handleDropFlag(player) {
  if (!player.joined) return;
  if (!player.alive) return;
  const flag = getPlayerFlag(player.id);
  if (!flag) return;
  const now = Date.now();
  // A sticky flag cannot be dropped on request; only its shake timeout
  // or a kill gets rid of it. The client runs the countdown, as upstream
  // does, so the server runs the same clock against the moment it saw
  // the grab -- otherwise a modified client sheds a bad flag on contact.
  if (flag.endurance === FLAG_ENDURANCE.STICKY) {
    const held = (now - flag.grabbedAt) / 1000;
    // A BZFlag client's own antidote spot is one this server never
    // saw, so its drop there is taken as bzfs takes any drop.
    const name = getFlagType(flag.type).name;
    if (canShakeFlag(flag.type, FLAG_SHAKE_TIMEOUT, held)) {
      log(`"${player.name}" shook off ${name} after ${held.toFixed(2)}s`);
    } else if (player.native && ANTIDOTE_FLAGS) {
      log(`"${player.name}" dropped ${name} at its own antidote after ${held.toFixed(2)}s`);
    } else {
      const refused = reportCheat(player, 'flagRejected',
        `SHAKE REJECTED ${name} held ${held.toFixed(2)}s of ${FLAG_SHAKE_TIMEOUT}s`);
      if (refused) return;
      log(`"${player.name}" shook off ${name} after ${held.toFixed(2)}s`);
    }
  }
  // cmdDrop's `!myTank->isPhantomZoned()`: a zoned tank cannot put the
  // flag down at all. Dropping it would leave the tank phased with
  // nothing to unphase it, since only the flag can cross a teleporter.
  if (isPlayerZoned(player)) {
    const refused = reportCheat(player, 'flagRejected', 'DROP REJECTED: zoned');
    if (refused) return;
  }
  // cmdDrop (clientCommands.cxx:355): a flag dropped inside a building
  // would land inside it, where nothing could reach it again. The client
  // refuses the control, so this only catches a modified one.
  if (isPlayerInsideBuilding(player, player.x, player.y, player.z, player.azimuth)) {
    const refused = reportCheat(player, 'flagRejected',
      'DROP REJECTED: inside a building');
    if (refused) return;
  }
  dropFlag(flag, now);
  return;
}

// doUpdateMotion's teleporter branch (LocalPlayer.cxx:729). A Phantom
// Zone tank crossing a teleporter is not moved: the zone toggles
// instead. The client detects the crossing, as it does for an ordinary
// teleport, and this is the server agreeing to it -- the state is the
// server's because being zoned is what decides who can shoot you.
function handleZone(player, ws, message) {
  if (!player.joined) return;
  if (!player.alive) return;
  const flag = getPlayerFlag(player.id);
  if (!flag || !togglesZoneOnTeleport(flag.type)) {
    reportCheat(player, 'flagRejected',
      `ZONE REJECTED: carrying ${flag ? getFlagType(flag.type).name : 'no flag'}`);
    return;
  }
  // The crossing itself is the whole claim, so it is the whole check:
  // the face has to be a teleporter, the point the client says it
  // crossed at has to be inside that teleporter's portal, and the point
  // has to be somewhere the tank could legally be. That is exactly what
  // `applyPlayerTeleportMessage` asks of a tank that does move -- there
  // is simply no destination to transform to here.
  const zoneAt = {
    x: Number(message.x),
    y: Number(message.y),
    z: Number(message.z),
    azimuth: Number(message.a),

  };

  const now = Date.now();
  const zoneRefusal = getZoneRefusal(player, zoneAt, Number(message.fromFaceId), now);
  if (zoneRefusal) {
    reportCheat(player, 'flagRejected', `ZONE REJECTED: ${zoneRefusal}`);
    return;
  }
  flag.zoned = !flag.zoned;
  log(`"${player.name}" ${flag.zoned ? 'zoned' : 'unzoned'}`);
  broadcastFlagUpdate(flag);
  return;
}

function handleSelfDestruct(player) {
  // An observer has no tank to destroy. The dead tank is killPlayer's own
  // guard, and it is only repeated here so a request that will do nothing
  // is not logged as though it did.
  if (isObserverTeam(player.team)) return;
  if (!player.alive) return;
  log(`"${player.name}" self-destructed.`);
  // playing.cxx:6966 is `gotBlowedUp(myTank, SelfDestruct, myTank->getId())`
  // -- upstream's suicide is a kill whose killer is the victim, and it goes
  // through playerKilled like every other death. So this is one call into
  // the one death path: the loss, the flag, the lock, the rabbit and the
  // respawn all happen there, and cannot be forgotten here.
  killPlayer(player, player, DEATH_REASON.SELF_DESTRUCT);
  return;
}

function handleJoinGame(player, ws, message) {
  // checkBan (bzfs.cxx:2257): a banned BZID is turned away at the join,
  // so a signed-in player can still reach the dialog to sign out.
  const ipBan = bans.ipBanned(player.clientIP);
  if (ipBan) {
    log(`Player ${player.id} refused: ${player.clientIP} is banned (${ipBan.mask})`);
    replyToPlayer(player, bans.ipBanRefusal(ipBan));
    removeFromServer(player);
    return;
  }
  const idBan = bans.idBanned(player.bzid);
  if (idBan) {
    log(`Player ${player.id} refused: BZID ${player.bzid} is banned`);
    replyToPlayer(player, idBanRefusal(idBan));
    removeFromServer(player);
    return;
  }
  supersedeEarlierConnection(player, message.page);
  let joinName = resolveJoinName(player, message.name);
  const requestedTankModel = typeof message.tankModel === 'string'
    ? normalizeTankModelId(message.tankModel)
    : 'bzflag';
  const previousTeam = player.joined ? player.team : null;
  const requestedTeam = normalizePlayerTeamSelection(message.team);
  // Coming back through the entry dialog is upstream's leave and arrival,
  // unless the name stays and only observing starts or stops: that is
  // 2.5's `changeTeam`, which leaves nobody on the rejoin list.
  const observingChange = previousTeam !== null && joinName === player.name
    && isObserverTeam(previousTeam) !== (requestedTeam === PLAYER_TEAM.OBSERVER);
  if (player.joined && !observingChange) noteRejoinWait(player);
  // autoTeamSelect (bzfs.cxx:1923) refuses nothing in Rabbit Chase: asking
  // for observer gives observer and asking for anything else means "play",
  // which is a hunter. So the availability check is skipped there and
  // selectPlayerTeam answers on its own.
  if (!RABBIT_SELECTION && requestedTeam !== 'automatic'
    && !TEAM_MODE.teams.includes(requestedTeam)) {
    ws.send(JSON.stringify({ error: `Team is not available: ${requestedTeam}` }));
    return;
  }
  const teamCounts = {};
  // What the players on each team have scored between them, which is
  // what auto-assignment balances on. Not the team score.
  const teamPlayerScores = {};
  players.forEach((candidate) => {
    if (!candidate.joined || candidate.id === player.id) return;
    teamCounts[candidate.team] = (teamCounts[candidate.team] || 0) + 1;
    teamPlayerScores[candidate.team] = (teamPlayerScores[candidate.team] || 0) + candidate.wins - candidate.losses;
  });
  // bzfs.cxx:2339. The total -- tanks and observers together -- is what
  // refuses an arrival outright; the playing limit inside
  // selectPlayerTeam only turns one into a spectator. Asked of arrivals
  // alone, since a player already in the game re-sending their name, team
  // and tank is not a new one, and `teamCounts` above already leaves them
  // out of the count.
  const roster = Object.values(teamCounts).reduce((total, count) => total + count, 0);
  if (!player.joined && roster >= MAX_TOTAL_PLAYERS) {
    ws.send(JSON.stringify({ error: 'This game is full. Try again later.' }));
    return;
  }
  const assignedTeam = selectPlayerTeam(
    requestedTeam, TEAM_MODE, teamCounts, teamPlayerScores, getTeamBaseCenters());
  if (!assignedTeam) {
    ws.send(JSON.stringify({ error: `Team is full: ${requestedTeam}` }));
    return;
  }
  // A team change takes the tank out of play, so it gives up its flag
  // like every other such path. This is keyed on the team actually
  // changing rather than on the join, because Player Options carries
  // name, team, and tank together and re-sends all three -- a player
  // changing only their tank keeps the flag. It runs before the spawn
  // below, since dropFlag() casts its ray from the owner's position.
  if (previousTeam && previousTeam !== assignedTeam) {
    dropPlayerFlag(player.id);
  }
  // changeTeam (bzfs.cxx, master): "If we're switching to observer and
  // they're alive, kill 'em", as a self-destruct, so nobody watches a
  // tank vanish and a shot already on its way is not dodged.
  if (player.alive && previousTeam && isObserverTeam(assignedTeam)) {
    killPlayer(player, player, DEATH_REASON.SELF_DESTRUCT);
  }
  player.nextTeam = null;
  player.name = joinName;
  // Bounded here rather than trusted: it reaches every other player's
  // scoreboard, and a proxied one carries it to a target that has its
  // own `MOTTO_LEN` to respect.
  player.motto = sanitizeMotto(message.motto);
  // A rejoin while flying keeps the pilot on the scoreboard, and the
  // motto it brought is the one to give back on landing -- unless it is
  // a rejoin as an observer, who has no tank to fly: the pilot lands,
  // and everyone is told, as upstream's autopilot can only fly a tank.
  if (player.autopilot && isObserverTeam(assignedTeam)) {
    const previousName = player.autopilotName;
    player.autopilot = false;
    player.autopilotName = null;
    player.savedMotto = null;
    log(`Player ${player.id} "${joinName}" autopilot off (observing)`);
    broadcastAll({ type: 'autopilot', playerId: player.id, on: false, pilot: previousName });
  } else if (player.autopilot) {
    player.savedMotto = player.motto;
    player.motto = player.autopilotName;
  }
  player.tankModel = isAllowedTankModel(requestedTankModel)
    ? requestedTankModel
    : 'bzflag';
  player.skin = normalizeTankSkinId(message.skin);
  player.team = assignedTeam;
  // `player` is already in the roster here, so it is excluded from the
  // colours to stay clear of. A null answer leaves the colour it has.
  const joinColor = getJoinPlayerColor(
    TEAM_MODE, assignedTeam, previousTeam,
    (team) => Player.pickDistinctColor(team, player));
  if (joinColor !== null) player.color = joinColor;
  // bzfs.cxx:2377 resets a team the moment its size becomes one.
  // `teamCounts` excludes this player, so a lone player rejoining
  // their own team resets it too, as a leave and join would upstream.
  if (TEAM_MODE.enabled && !teamCounts[assignedTeam] && isColorTeam(assignedTeam)) {
    teamScores.delete(assignedTeam);
  }
  player.voiceMicEnabled = false;
  player.joined = true;
  player.bot = message.bot === true;
  player.mobile = message.isMobile === true;
  player.xr = message.xr === true;
  player.voiceRosterSignature = '';
  reportToListServer('join');
  scheduleBotReconcile();
  // An observer never comes alive. Not alive is the state the join flow
  // already renders as a scoreboard entry with an invisible tank, which
  // is exactly what an observer wants, and it leaves every path that
  // tests it refusing on its own.
  //
  // It still gets a spawn position, because that is where its camera
  // starts: an observer should arrive standing on the field facing the
  // way a tank would, not hovering at the origin. After that the camera
  // lives on the client and reports itself every five seconds; see
  // applyObserverHeartbeat.
  // A player who arrives while the game is over gets the same
  // non-combatant state an observer gets -- a spectator on the standing
  // result rather than a fresh spawn -- until the next /countdown.
  const joinAsObserver = isObserverTeam(assignedTeam);
  player.alive = !(joinAsObserver || matchClock.gameOver);
  // MsgAlive from a callsign on the rejoin list (bzfs.cxx:4851).
  const rejoinWait = player.alive && !bots.has(player.id) ? rejoinWaitMs(joinName) : 0;
  if (rejoinWait > 0) player.alive = false;
  if (player.alive) player.hasSpawned = true;
  // PlayerInfo::resetPlayer(ctf) puts every CTF spawn on the team base.
  player.restartOnBase = !joinAsObserver && CTF_ENABLED;
  // Map Viewer (issue #68) is Observer on the wire -- same team limit,
  // same team chat, same white colour, every gate above unchanged --
  // distinguished only by this field, which names the map the client
  // asked to look at instead of the live match. Validated against
  // `MAP_REGISTRY` the same way an operator's own map picks are; a
  // stale or invalid request is simply not a Map Viewer, since the
  // client already validated its own choice against `init.viewableMaps`
  // before ever asking. Nothing else about the join reads this -- the
  // world it names is the client's business entirely, not the
  // server's.
  player.viewMap = joinAsObserver ? resolveViewMapChoice(message.viewMap) : null;
  const spawnPos = getSpawnPosition(player);
  player.x = spawnPos.x;
  player.y = spawnPos.y;
  player.z = spawnPos.z;
  player.azimuth = spawnPos.azimuth;
  player.verticalVelocity = 0;
  player.isJumping = false;
  player.onObstacle = false;
  // A join is a new life, and a pause belongs to the life it was taken
  // in. Reopening the entry dialog pauses the tank standing in the
  // world; pressing OK is what ends both the dialog and the pause.
  clearPauseTimers(player);
  player.paused = false;
  player.pauseCountdownStart = 0;
  player.forwardSpeed = 0;
  player.rotationSpeed = 0;
  player.jumpAzimuth = null;
  player.slideAzimuth = undefined;
  player.airVelocityX = 0;
  player.airVelocityY = 0;

  player.teleportReentryBlockTeleporterIndex = null;
  player.teleportReentryBlockDistance = 0;
  player.teleportReentryBlockUntil = 0;
  player.teleportCooldownUntil = 0;
  player.lastUpdate = Date.now();
  player.lastHeardAt = player.lastUpdate;
  player.notResponding = false;
  player.lag.resetUpdateGap();
  player.losses = 0;
  player.wins = 0;
  const scoreRestored = previousTeam === null ? restoreScore(player) : null;
  if (previousTeam === null) restoreConnectTime(player);
  // The tank is named here as well as on a later change, so a join
  // line says what a player is driving without the log having to be
  // read backwards for a change that may never have happened.
  const joinTags = [`[${player.team.toUpperCase()}]`, `[${player.tankModel}]`];
  if (player.skin !== DEFAULT_TANK_SKIN) joinTags.push(`[${player.skin}]`);
  if (message.isMobile) joinTags.push('[MOBILE]');
  if (player.bot) joinTags.push('[BOT]');
  log(`Player ${player.id} joining as "${joinName}" ${joinTags.join(' ')}`);

  // broadcast join to all (full player info)
  // bzfs.cxx:2478 and :2966: a team's flag follows its population. The
  // first player to arrive brings it back, and a team left empty by
  // someone switching away loses theirs.
  if (isColorTeam(assignedTeam) && !teamCounts[assignedTeam]) {
    resetTeamFlags(getTeamColorIndex(assignedTeam));
  }
  if (previousTeam && previousTeam !== assignedTeam) {
    retireTeamFlags(getTeamColorIndex(previousTeam));
  }

  broadcastPlayerRecord('playerJoined', player);
  if (scoreRestored) replyToPlayer(player, scoreRestored);
  clearTimeout(player.rejoinTimer);
  if (rejoinWait > 0) {
    replyToPlayer(player, 'You are unable to begin playing for {seconds} seconds.', { seconds: (rejoinWait / 1000).toFixed(1) });
    log(`[REJOIN] "${joinName}" waits ${(rejoinWait / 1000).toFixed(1)}s to spawn`);
    player.rejoinTimer = setTimeout(() => {
      if (players.get(player.id) !== player || !player.joined || player.alive || matchClock.gameOver) return;
      player.respawn();
      broadcastPlayerRecord('alive', player);
    }, rejoinWait);
  }
  // `init` went out before this player had joined, and `isAdmin`
  // refuses anyone who has not -- so an admin's opening roster was
  // built without the admin-only fields. One roster replay after the
  // join is what fills the BZID column in for the players who were
  // already here; everyone who arrives later rides in on
  // `broadcastPlayerRecord`.
  if (isAdmin(player)) {
    ws.send(JSON.stringify({ type: 'playerList', players: getRosterFor(player) }));
  }
  // After the join is on the wire, so `newRabbit` never names a player the
  // other clients have not heard of yet.
  //
  // A rejoin arrives as a hunter, and upstream's own rejoin is a leave and
  // an arrival -- `removePlayer` deposes the rabbit (bzfs.cxx:3001). So a
  // rabbit that reopened the entry dialog puts the post up for anointing
  // and is disfavoured for it, keeping it only if nobody else qualifies.
  if (RABBIT_SELECTION && server.rabbitPlayerId === player.id) anointNewRabbit();
  handleRabbitSpawn(player);
  broadcastTeamScores();
  refreshVoiceRosters(true);
  return;
}

// MsgSetTeam (bzfs.cxx, master): a tank asking for another playing
// team gets it at its next spawn, keeping its score. Observing starts
// and stops through `joinGame`, which the camera needs.
function handleSetTeam(player, ws, message) {
  const team = normalizePlayerTeamSelection(message.team);
  if (!player.joined || !isSwitchableTeam(player.team)) return;
  if (!isSwitchableTeam(team) || TEAM_MODE.autoTeam) {
    replyToPlayer(player, 'Team is not available: {team}', { team: { msgid: team } });
    return;
  }
  if (team === player.team) {
    if (player.nextTeam) replyToPlayer(player, 'You stay {team}', { team: { msgid: team } });
    player.nextTeam = null;
    return;
  }
  let onTeam = 0;
  players.forEach((other) => {
    if (other !== player && other.joined && (other.nextTeam || other.team) === team) onTeam += 1;
  });
  if (onTeam >= TEAM_MODE.limits[team]) {
    replyToPlayer(player, 'Team is full: {team}', { team: { msgid: team } });
    return;
  }
  player.nextTeam = team;
  log(`Player ${player.id} "${player.name}" asks for ${team}`);
  replyToPlayer(player, 'You will join {team} when you next spawn', { team: { msgid: team } });
  return;
}

// The skin changes in a life as the model does; a join carries it too.
function handleSetTankSkin(player, ws, message) {
  const skin = normalizeTankSkinId(message.skin);
  if (player.skin === skin) return;
  log(`Player ${player.id} "${player.name}" skin ${player.skin} -> ${skin}`);
  player.skin = skin;
  if (player.joined) broadcastPlayerRecord('playerUpdated', player);
  return;
}

function handleSetTankModel(player, ws, message) {
  const requestedTankModel = typeof message.tankModel === 'string'
    ? normalizeTankModelId(message.tankModel)
    : '';
  if (!isAllowedTankModel(requestedTankModel)) {
    ws.send(JSON.stringify({ error: 'Invalid tank model' }));
    return;
  }

  if (player.tankModel !== requestedTankModel) {
    const previousTankModel = player.tankModel;
    player.tankModel = requestedTankModel;
    // What a client is drawing is the first thing wanted of a report
    // that it is drawing slowly, and a model is the one part of that
    // no client-side stats line can carry: every tank in the scene may
    // be a different one, so the answer is per player and belongs
    // here, where every player's is in the same log.
    log(`Player ${player.id} "${player.name}" tank model`
      + ` ${previousTankModel} -> ${requestedTankModel}`);
    // Same rule as sendPlayerUpdate: nobody hears about a player who is
    // not in the game. A tank picked in the entry dialog before joining
    // travels with the join itself.
    if (player.joined) {
      broadcastPlayerRecord('playerUpdated', player);
    }
  }
  return;
}

function handlePause(player) {
  requestPause(player);
  return;
}

function handleAutopilot(player, ws, message) {
  setAutopilot(player, message.on === true, message.pilot);
  return;
}

// An XR session opening or closing, which turns the player's `T`
// column to `v` and back.
function handleXrSession(player, ws, message) {
  const xr = message.on === true;
  if (player.xr === xr) return;
  player.xr = xr;
  if (player.joined) broadcastPlayerRecord('playerUpdated', player);
  return;
}

const MESSAGE_HANDLERS = Object.freeze({
  tp: handleTp,
  rtc: handleRtc,
  m: handleM,
  shoot: handleShoot,
  identify: handleIdentify,
  queryPlayers: handleQueryPlayers,
  nearFlag: handleNearFlag,
  grabFlag: handleGrabFlag,
  captureFlag: handleCaptureFlag,
  dropFlag: handleDropFlag,
  zone: handleZone,
  selfDestruct: handleSelfDestruct,
  joinGame: handleJoinGame,
  setTeam: handleSetTeam,
  setTankSkin: handleSetTankSkin,
  setTankModel: handleSetTankModel,
  pause: handlePause,
  autopilot: handleAutopilot,
  xrSession: handleXrSession,
});

module.exports = { useServer, MESSAGE_HANDLERS };
