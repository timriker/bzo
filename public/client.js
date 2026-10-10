/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// The XR chat panel's own fixed window (public/client.js's flat one scrolls
// natively and keeps the whole scrollback instead -- see `updateChatWindow`).
const CHAT_VISIBLE_MESSAGES = 6;
const CHAT_SCROLLBACK_LIMIT = 600;
// `[HH:MM:SS] `. A stamp longer than this is `formatChatTimestamp` having
// added the date, which is how a line from another day is told apart without
// re-deriving the day where it is drawn. Up here with the rest of the chat's
// constants because `updateChatWindow` paints the first debug line while this
// module is still being evaluated.
const CHAT_TIME_ONLY_LENGTH = 11;
const CHAT_MIN_WIDTH_WITH_DEBUG = 560;
const CHAT_DEBUG_PANEL_RESERVE = 352;
// A chat destination that is not a player is one of upstream's reserved
// PlayerIds -- see `player-ids.mjs` for the space and why bzo shares it.
// `send team` (ActionBinding.cxx:101) is `FIRST_TEAM` and means this client's
// own team, which is the only one it can address.
const CHAT_TARGET_ALL = ALL_PLAYERS;
const CHAT_TARGET_SERVER = SERVER_PLAYER;
const CHAT_TARGET_ADMIN = ADMIN_PLAYERS;
const CHAT_TARGET_TEAM = FIRST_TEAM;
const CHAT_KIND_CHAT = 'chat';
const CHAT_KIND_ACTION = 'action';
const CHAT_KIND_SERVER = 'server';
const CHAT_KIND_MISC = 'misc';
const CHAT_KIND_DEBUG = 'debug';
const CHAT_KIND_TEAM = 'team';
const CHAT_KIND_ADMIN = 'admin';
const CHAT_KIND_DIRECT_IN = 'direct-in';
const CHAT_KIND_DIRECT_OUT = 'direct-out';
const CLIENT_COPYRIGHT = 'Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>';
const CLIENT_LICENSE = 'AGPL-3.0-only';
const CLIENT_LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';
const CHAT_TABS = [
  { id: 'all', label: 'All' },
  { id: 'chat', label: 'Chat' },
  { id: 'server', label: 'Server' },
  { id: 'misc', label: 'Misc' },
  { id: 'debug', label: 'Debug' },
];
const chatState = {
  activeTab: 'all',
  messages: {
    all: [],
    chat: [],
    server: [],
    misc: [],
    debug: [],
  },
  unread: {
    all: false,
    chat: false,
    server: false,
    misc: false,
    debug: false,
  }
};
let lastDirectSenderId = null;
let nemesisPlayerId = null;
let chatInput = null;
let sendBtn = null;
let chatActive = false;
// A press in the chat transcript, selecting text, which keeps chat entry open
// through the input's blur (see the transcript's listeners).
let chatSelectingTranscript = false;
let virtualControlsEnabled = false;
let latency = 0;
let sentBps = 0;
let sentBytes = 0;
let lastSentBytesUpdate = performance.now();
let receivedBps = 0;
let receivedBytes = 0;
let lastReceivedBytesUpdate = performance.now();

import {
  setupInputHandlers,
  virtualInput,
  keys,
  initHudControls,
  latestOrientation,
  toggleMouseMode,
  isMouseSteeringAvailable,
  refreshHudButtons,
  setPointerIdentify,
  isMobile,
  updateVirtualInputFromXR,
  updateVirtualInputFromGamepad,
  isGamepadConnected,
  getGamepadInfo,
  isGameplayInputActive,
  isMenuContextActive,
  isDialogContextActive,
  adjustSettingsMenuRow,
  activateXRSettingsMenuItem,
  closeSettingsDialog,
  openSettingsDialog,
  isFullscreenActive,
  getXRSettingsMenuItems,
  dismissDialogFromOutsideClick,
  refreshSettingsMenu,
  registerGameplayInputReset,
  setGameplayKeyState,
  getHeldKeyDebug,
  isRumbleEnabled,
  rumble,
  setRumbleEnabled,
  setInputContext,
  syncInputContextFromUi,
  toggleOperatorPanel,
  toggleViewPanel
} from './input.js';
import {
  ALL_PLAYERS,
  SERVER_PLAYER,
  ADMIN_PLAYERS,
  FIRST_TEAM,
} from './player-ids.mjs';
import { getMenuClickDirection, playMenuBackSound, playMenuSelectSound, setMenuSoundPlayer } from './menus.js';

setMenuSoundPlayer((name) => renderManager.playLocalSound(name));
import { DestructCountdown, PauseState } from './pause.mjs';
import { createMoveChannel } from './move-channel.mjs';
import { HUNT_MARKER_COLOR, HuntState } from './hunt.mjs';
import { XRMenuRenderer } from './xr-menu.js';
import {
  colorToCSS,
  formatMatchClock,
  formatTeamScore,
  getTeamScoreRows,
  updateDebugDisplay,
  updateHudButtons,
  toggleDebugHud,
  toggleDebugLabels,
  compareScoreboardPlayers,
  formatPlayerLabel,
  formatScoreboardStats,
  formatScoreboardCell,
  SCOREBOARD_TIER,
  getPlayerTeamMark,
  getPlayerStatusIndicator,
  getScoreboardStatsHeader,
  buildScoreboardRows,
  getScoreboardHuntLabel,
  SCOREBOARD_HUNT_COLOR,
  SCOREBOARD_STATUS_COLOR,
  getActiveHudAlerts,
  getHudAlertColor,
  setHudAlert,
  updateAlertHud,
  updateFiringStatusHud,
  FLAG_HELP_SECONDS,
  getActiveFlagHelp,
  setFlagHelp,
  updateFlagHelpHud,
  updateScoreboard,
  updateAltimeter,
  updateDegreeBar,
  updateShotStatus,
  roundedRect,
  readStoredFlag,
  bindToggleButton,
  fitText,
  wrapText,
  setChatCollapsed,
  borrowChat,
  returnChat,
  borrowScoreboard,
  returnScoreboard,
  SCOREBOARD_WATCHING_LABEL,
} from './hud.js';
import {
  renderManager, GHOST_ALPHA_SCALE, GHOST_SCALE, meshSpinRadians,
  reportAlphaWithoutThreshold, TANK_NAV_LIGHTS_NAME,
} from './render.js';
import { CAMO_SOURCE_TEXTURE } from './camo.mjs';
import { describeMeasurements, describeRenderCapabilities } from './capabilities.mjs';
import {
  describeGrowth,
  getFramePhaseReport,
  getFastestFrame,
  getFrameProgramRange,
  getHeapUsedMB,
  markFramePhase,
  rollFramePhases,
  startFramePhases,
} from './perf.js';
import * as THREE from 'three';
import {
  initXR,
  isHeadsetAppLaunch,
  isHeadsetDevice,
  isSystemKeyboardSupported,
  XR_LAUNCH_SESSION_EVENT,
  toggleXRSession,
  updateXRControllerInput,
  getXRControllerInput,
  setNormalAnimationLoop,
  isXREnabled,
} from './webxr.js';
import { INPUT_CONTEXT } from './input-context.mjs';
import {
  ROAM_FOLLOW_DISTANCE,
  ROAM_FOLLOW_HEIGHT_FACTOR,
  ROAM_VIEW,
  ROAM_VIEW_ORDER,
  advanceRoamSelection,
  createRoamCamera,
  getRoamForward,
  getRoamLook,
  ROAM_PITCH_LIMIT,
  getRoamViewAngle,
  roamViewNeedsTarget,
  updateRoamCamera,
} from './roam.mjs';
import {
  PLAYER_TEAM,
  PLAYER_TEAM_COLORS,
  PLAYER_TEAMS,
  PLAYER_TEAM_LABELS,
  getPlayerTeamColor,
  getPlayerTeamRadarColor,
  getPlayerTeamSelections,
  getTeamColorIndex,
  getTeamFromColorIndex,
  getPlayerRanking,
  isColorTeam,
  isObserverTeam,
  areFoes,
  isRabbitTeam,
  normalizePlayerTeam,
  normalizePlayerTeamSelection,
} from './teams.mjs';
import { getKillScoreDeltas } from './scoring.mjs';
import {
  RADAR_BOX_CORNERS,
  clipPolygonToRadarSquare,
  ensureRadarPolygonBuffers,
  getRadarClipBuffer,
  getRadarMeshFaceCull,
  getRadarMeshObstacleCull,
  getRadarObstacleCullRadius,
  getRadarPolygonScratch,
  isOutsideRadarSquare as isOutsideRadarSquareOf,
  isTippedRadarSpin,
} from './radar-geometry.mjs';
import { createVoiceManager } from './voice.js';
import {
  DEFAULT_VOICE_CHANNEL,
  VOICE_CHANNELS,
  getVoiceChannel,
  normalizeVoiceChannel,
  voiceChannelUsesDistance,
} from './voice-channels.mjs';
import {
  ANTIDOTE_FLAG_COLOR,
  getFlagTuning,
  RADAR_JAM_DECAY_MIN,
  FLAG_ENDURANCE,
  FLAG_GRAB_INTERVAL_MS,
  FLAG_GRAB_LEVEL_TOLERANCE,
  getFlagGrabRadius,
  BAD_FLAG_COLOR,
  FLAG_RADIUS,
  FLAG_STATUS,
  FLAG_TYPES,
  SUPER_FLAG_COLOR,
  isBadFlag,
  getFlagEndurance,
  getFlagTeamIndex,
  getFlagType,
  getShotEffects,
  getThiefDropReloadSeconds,
  firesContinuously,
  getShockWaveAlpha,
  getShockWaveRadius,
  blanksTheView,
  cloaksTheTank,
  drivesThroughBuildings,
  fakesTeamColor,
  BURROW_RADAR_FACTOR,
  getGroundLimit,
  getFiredShotFlag,
  isZoned,
  getNextRadarJamDecay,
  getTankAlphaTarget,
  getTankDimensionScale,
  getVisibleTankAlpha,
  hidesFromRadar,
  hidesTeamColors,
  jamsTheRadar,
  seesThroughDisguises,
  hasAirControl,
  isTeamFlag,
  normalizeShakeTimeout,
  normalizeShakeWins,
  keepFlagIdentity,
  parseFlagInfo,
  findNearestGroundFlag,
  shotRicochets,
  TARGETING_ANGLE,
  canRunOver,
  getRunOverRadius,
  getRunOverSeparation,
  configureFlagEffects,
} from './flags.mjs';
import { steerGuidedShot, pickTargetInSights, getFlagFlightState } from './flags.mjs';
import {
  normalizeShotSlotCount,
  WORLD_WEAPON_PLAYER_ID,
  getWorldMissileLifetimeSeconds,
  WORLD_WEAPON_TEAM,
  SHOT_TAP_SPACING_MS,
  getWorldReloadSeconds,
  getSlotReloadSeconds,
  getShotSlotProgress,
  findFreeShotSlot,
  countFreeShotSlots,
  shockWaveHitsTank,
  getShotFlight,
} from './shots.mjs';
import { getShotTankHit } from './shots.mjs';
import { CLIENT_VERSION } from './version.mjs';
import {
  VOICE_DUCK_HOLD_MS,
  VOICE_REF_DISTANCE,
  getSoundPaths,
} from './audio.js';
import {
  DEFAULT_VOLUME_LEVEL,
  VOLUME_CHANNELS,
  clampVolumeLevel,
  formatVolumeLevel,
  readVolumeLevel,
  stepVolumeLevel,
  writeVolumeLevel,
} from './volume.mjs';
import {
  ComposeHistory,
  WORD_KIND,
  completeCompose,
} from './compose.mjs';
import {
  CHAT_CACHE_TABS,
  CHAT_RELOAD_DIVIDER,
  formatChatTimestamp,
  formatTranscript,
  packChatCache,
  transcriptFilename,
  unpackChatCache,
} from './chat-cache.mjs';
import { setupInstallPrompt } from './install.js';
import {
  SHOT_COLLISION_RADIUS,
  SHOT_BOUNCE_CLEARANCE,
  getBaseTeamAtPoint,
  getColliderLocalPoint,
  getOrigRectNormal,
  getTankHitNormal,
  findMeshHitFace,
  findMeshHitFaceOriented,
  getPyramidHeight,
  isPyramidFlatTop,
  getObstacleHeight,
  getShotObstacleNormal,
  getBoxCrossingPlane,
  getMeshCrossingPlane,
  getShotTeleporterDims,
  resolvePhysicsDriverAt,
  isOverFlatTop,
  reflectShotDirection,
  testOrigRectCircle,
  traceShotStep,
  buildCollisionColliders,
  configureTankDimensions,
  DEFAULT_MUZZLE_FORWARD,
  DEFAULT_MUZZLE_HEIGHT,
  WORLD_WALL_HEIGHT,
  TANK,
  findShotSegmentImpact,
  getObstacleBase,
} from './collision.mjs';
import { meshArrays, FACE_NO_RADAR } from './mesh-arrays.mjs';
import {
  AIR_VELOCITY_THRESHOLD,
  createDriveState,
  findInsideBuildings,
  isDrivenUpward,
  movePacketFields,
  packetVelocity,
  readDriveInput,
  shotFromTank,
  stepDrive,
  holdDrive,
} from './drive.mjs';
import { bzdbFromObject, worldConfig as evaluateWorldConfig } from './bzdb.mjs';
import { normalizeAngle } from './motion.mjs';
import {
  buildTeleporterIndex,
  getShotTeleporterCrossing,
  getTeleportDestinationFace,
  transformShotThroughTeleporter,
} from './teleport.mjs';
import { findMapEdgeImpactPoint, traceBeam, traceShotThroughTeleporters } from './trace.mjs';
import {
  AUTOPILOTS, DEFAULT_PILOT, createRouter, createWorldProbes, findVantagePoints, teamBasesOf,
} from './autopilot.mjs';
import {
  TRACK_SURFACE_TOLERANCE,
  TRACK_UPDATE_TIME,
  getTrackMarkPlacement,
  getTrackMarkSides,
  setTrackFadeTime
} from './tracks.mjs';

// A tank's mesh, where it stands and the way it faces. It stands in the
// renderer's `worldFrame`, and its model faces +x, so it turns by its azimuth
// about z.
function placeTank(object, x, y, z, azimuth) {
  object.position.set(x, y, z);
  object.rotation.set(0, 0, azimuth);
}

// Where a shot is, kept on it as the game's state, and its mesh moved there:
// a shot stands in the renderer's `worldFrame`, which is upstream's.
function placeShot(projectile, p) {
  projectile.userData.at = { x: p.x, y: p.y, z: p.z };
  projectile.position.set(p.x, p.y, p.z);
}

// Where a tank's mesh stands, and the way it faces: a remote tank's state is
// its mesh's, which the animation loop places each frame.
function tankPoint(tank) {
  return { x: tank.position.x, y: tank.position.y, z: tank.position.z };
}

function tankAzimuth(tank) {
  return tank.rotation.z;
}

// Register the service worker that makes the game installable and serves its
// assets from disk. The build id rides in the script URL, so any change to what
// the client is served changes the worker's identity and forces a fresh install
// of its cache. Keyed to the build rather than to the release, because the
// release version does not move between releases: during development a new
// texture or sound would otherwise keep being served from a cache the reload
// below cannot clear.
const swVersion = document.querySelector('meta[name="bzo-build"]')?.content || CLIENT_VERSION;
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`/sw.js?v=${swVersion}`).catch(() => {});
  });
}

// The build the page booted with, from the first init message it saw. A server
// restart on its own is not a reason to reload -- bzo reconnects across those on
// purpose -- but a restart that brought new client code is, because this tab
// would otherwise keep running the old code for as long as it stays open. That
// is how an unattended test client ends up reporting stats from a build nobody
// is looking at any more.
const RELOADED_FOR_KEY = 'bzoReloadedFor';
let bootClientBuild = null;

// Returns false when the page is on its way out, so the caller stops handling a
// message meant for code that is about to be replaced.
function checkClientBuild(build) {
  if (!build) return true;
  if (bootClientBuild === null) {
    bootClientBuild = build;
    // Booted on this build, so whatever reload got us here worked. Forgetting
    // it lets a later return to the same build reload again.
    if (sessionStorage.getItem(RELOADED_FOR_KEY) === build) {
      sessionStorage.removeItem(RELOADED_FOR_KEY);
    }
    return true;
  }
  if (build === bootClientBuild) return true;
  if (sessionStorage.getItem(RELOADED_FOR_KEY) === build) {
    // Reloading did not pick up the new code, so stop rather than loop. Says so
    // in server.log, which is the only place an unattended client can say it.
    debugLog(`client.build stale boot=${bootClientBuild} server=${build} reload did not help`);
    return true;
  }
  sessionStorage.setItem(RELOADED_FOR_KEY, build);
  debugLog(`client.build stale boot=${bootClientBuild} server=${build} reloading`);
  // Long enough for that line to reach the socket, short enough not to be seen.
  setTimeout(reloadWhenServerIsUp, 250);
  return false;
}

// A reload is the one thing a client does that it cannot recover from. The
// socket retries forever on its own, but `location.reload()` fetches the page
// over HTTP -- and if that lands while the server is restarting, the browser
// replaces the tab with its own error page and there is no script left to try
// again. The tab is then dead until somebody presses reload by hand, which is
// exactly what an unattended test client on a headset cannot do.
//
// So wait for the server to answer before asking the browser to leave. The dev
// server restarts on every `server.js`, `public/`, `maps/` and `server.json`
// change, which is many times an hour while something is being worked on, and a
// map change is the worst of them: it tells every client to reload at the same
// moment it takes the server away.
const RELOAD_READY_POLL_MS = 400;
const RELOAD_READY_TIMEOUT_MS = 60000;

async function reloadWhenServerIsUp() {
  // The one place the fresh reading *is* the measurement: this polls across
  // awaits while the server restarts, and frames may have stopped entirely, so
  // the frame clock would never advance and the deadline would never arrive.
  const deadline = Date.now() + RELOAD_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('/api/ready', { cache: 'no-store' });
      if (response.ok) break;
    } catch {
      // Still down, or still starting. Neither is worth logging every 400ms.
    }
    await new Promise((resolve) => { setTimeout(resolve, RELOAD_READY_POLL_MS); });
  }
  // Out of patience rather than answered: reload anyway, because a tab that
  // never reloads is no better off than one that reloaded too early, and the
  // browser will at least show why.
  //
  // The reload this cache exists for, so the last lines go down now rather
  // than waiting for a timer the new page will never run.
  saveChatCache();
  window.location.reload();
}

// FPS
let fps = 0;
let frameCount = 0;
let lastFpsUpdate = performance.now();
// How long after a map is built the first automatic renderer.stats line waits.
const RENDER_STATS_SAMPLE_DELAY_MS = 10000;
// And how often another one lands while an XR session is running. A headset is
// the machine that cannot open the debug HUD to read its own counters, and one
// line ten seconds into a map is a race: enter the session late and the sample
// describes the flat page instead, which looks perfectly reasonable and answers
// a different question. A series also lets a mode be read on its middle sample
// rather than on wherever the player happened to be standing for the only one.
const XR_STATS_SAMPLE_INTERVAL_MS = 20000;
let nextXRStatsSampleAt = 0;
// And how often one lands on a client that is simply left open. This is the
// series that answers "why did an idle browser get slower over an hour", which
// no single sample can: see sampleIdleRenderStats.
const IDLE_STATS_SAMPLE_INTERVAL_MS = 300000;
let nextIdleStatsSampleAt = 0;

function updateFps() {
  frameCount++;
  const now = performance.now();
  if (now - lastFpsUpdate >= 500) { // update every 0.5s
    fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
    frameCount = 0;
    lastFpsUpdate = now;
  }
  // Update sentBps every second
  if (now - lastSentBytesUpdate >= 1000) {
    sentBps = Math.round(sentBytes / ((now - lastSentBytesUpdate) / 1000));
    sentBytes = 0;
    lastSentBytesUpdate = now;
  }
  // Update receivedBps every second
  if (now - lastReceivedBytesUpdate >= 1000) {
    receivedBps = Math.round(receivedBytes / ((now - lastReceivedBytesUpdate) / 1000));
    receivedBytes = 0;
    lastReceivedBytesUpdate = now;
  }
}

// Game state
let scene;
let myPlayerId = null;
let myPlayerName = '';
let myTank = null;
let tanks = new Map();
let projectiles = new Map();
let pendingLocalProjectiles = [];
let localProjectileCounter = 0;
const SHOT_SIM_STEP_SECONDS = 1 / 60;
const SHOT_SIM_MAX_STEPS_PER_FRAME = 8;
let projectileSimAccumulator = 0;
let ws = null;
let gameConfig = null;
// The live match's own config, exactly as `init` sent it. `gameConfig` is
// that with the currently-applied world's own physics laid over the top, so
// coming back from a Map Viewer preview is a matter of dropping the overlay
// rather than asking the server for the config again.
let liveGameConfig = null;
// What `liveGameConfig` is made of, as an upstream client holds it: the
// server's settings that are not BZDB, and the world's BZDB as raw strings
// (`init.bzdb`, kept up to date by `setVar`), evaluated over them by the same
// `worldConfig` the server runs.
let worldBaseConfig = null;
let liveBzdb = new Map();
// The server's own `-set`s (server.json's `bzdb`), which a previewed map's
// lines go over as the live map's do.
let serverBzdb = new Map();
function recomputeLiveConfig() {
  if (worldBaseConfig) liveGameConfig = evaluateWorldConfig(worldBaseConfig, liveBzdb);
}

// The config a world plays by here: the live world's, or a previewed map's own
// BZDB and `-ms` over this server's -- the map as it would play here.
function configForWorld(world) {
  if (!worldBaseConfig) return liveGameConfig;
  if (!isPreviewingAltWorld()) return liveGameConfig;
  const bzdb = new Map([...serverBzdb, ...bzdbFromObject(world?.bzdb)]);
  return evaluateWorldConfig({ ...worldBaseConfig, ...(world?.gameplay || {}) }, bzdb);
}
let serverMotdText = '';
let serverTitleText = '';
let startupBuildInfoAnnounced = false;
let lastAnnouncedServerMotd = null;
let radarCanvas, radarCtx;
// One record per XR HUD overlay: the canvas it paints, the texture wrapping it,
// and the camera-parented plane it draws on. ensureXRHudPanel fills them in.
// `planeWidth`/`planeHeight` are the size the plane was last built at, so a
// frame that asks for the size it already has does not rebuild the geometry.
const xrRadarPanel = { canvas: null, texture: null, mesh: null, planeWidth: 0, planeHeight: 0 };
const xrChatPanel = { canvas: null, texture: null, mesh: null, planeWidth: 0, planeHeight: 0 };
const xrShotStatusPanel = { canvas: null, texture: null, mesh: null, planeWidth: 0, planeHeight: 0 };
const xrScoreboardPanel = {
  canvas: null, texture: null, mesh: null, planeWidth: 0, planeHeight: 0,
  // Which roster is on the canvas, so a frame can tell there is nothing to draw.
  paintedVersion: 0, paintedRows: 0,
};
const xrAlertPanel = { canvas: null, texture: null, mesh: null, planeWidth: 0, planeHeight: 0 };
const xrFlagHelpPanel = {
  canvas: null, texture: null, mesh: null, planeWidth: 0, planeHeight: 0,
  // Which help is on the canvas. The text is fixed for as long as the flag is
  // held, so this is what keeps a minute of the same three sentences from being
  // painted and uploaded every frame.
  paintedText: null,
};
const XR_HUD_PANELS = [
  xrRadarPanel, xrChatPanel, xrShotStatusPanel, xrScoreboardPanel, xrAlertPanel, xrFlagHelpPanel,
];
const XR_HUD_PLANE_Z = -0.85;
// --hud-edge is what keeps every DOM panel the same distance from the edge of
// the viewport. An immersive session has no viewport edge to measure from: the
// panels are planes parented to the head, and what bounds them is how far the
// eye can turn before a panel stops being readable. This is that bound, in
// degrees off the gaze axis, and it is the XR half of the same rule -- one box
// that the radar, the scoreboard, the notices and the chat are all placed
// inside, so they cannot drift apart.
//
// Down is the tightest direction on a headset: the facial interface and the
// nose cut into it and it is where the lens is furthest from the eye, which is
// why it gets no more room than up even though a neck bends that way more
// easily. These are the three numbers to tune if the HUD sits wrong in a
// headset; nothing else encodes a position.
const XR_HUD_ANGLE_X = 28;
const XR_HUD_ANGLE_UP = 24;
const XR_HUD_ANGLE_DOWN = 24;
// How far off centre a given angle lands on the HUD plane.
function xrHudEdge(degrees) {
  return Math.abs(XR_HUD_PLANE_Z) * Math.tan((degrees * Math.PI) / 180);
}
// messageColor. The roaming status line wears it, as #roamStatus does in the
// DOM column, and so does the flag help -- upstream draws both in it.
const XR_MESSAGE_COLOR = '#cfd8e6';
// The radar's side on the HUD plane. It takes the box's top-right corner, and
// this is the size that keeps the corner nearest the gunsight where it has
// always been while the far corner comes inside the box -- a radar large enough
// to reach both would have its inner edge on the gunsight.
const XR_RADAR_PLANE_SIZE = 0.3;
const XR_CHAT_PLANE_WIDTH = 0.9;
// The chat canvas is laid out in pixels and the plane takes its aspect, so these
// decide both what fits and how large it reads. A line is 22px on a canvas 1024
// wide shown 0.9m across at 0.85m, which is about 1.2 degrees tall -- the size
// text has to be to survive a lens, and the reason the panel shows six lines
// rather than the twelve the same box would hold at desktop sizes.
const XR_CHAT_CANVAS_WIDTH = 1024;
const XR_CHAT_CAPTION_PX = 22;
const XR_CHAT_LINE_PX = 22;
const XR_CHAT_LINE_HEIGHT_PX = 26;
const XR_CHAT_CANVAS_HEIGHT = 204;
// The flag help panel. A headset has no targeting box to hang this under, so
// it takes the band between the notice column above and the chat below, its top
// edge just under the gaze axis -- which is where the text lands on a monitor
// too, the box there being the same few degrees across.
//
// The canvas is a fixed size and the text is painted from the top of it, so the
// plane never changes shape and the texture is allocated once: a two-line help
// leaves the bottom of the canvas transparent rather than making a shorter
// panel. Five lines is the room, and the longest string in the flag table
// (Phantom Zone, at 185 characters) wraps to three.
const XR_FLAG_HELP_CANVAS_WIDTH = 1024;
const XR_FLAG_HELP_LINE_PX = 26;
const XR_FLAG_HELP_LINE_HEIGHT_PX = 32;
const XR_FLAG_HELP_MARGIN_PX = 32;
const XR_FLAG_HELP_MAX_LINES = 5;
const XR_FLAG_HELP_CANVAS_HEIGHT = 168;
const XR_FLAG_HELP_PLANE_WIDTH = 0.8;
// How far below the gaze axis the first line starts. Clear of the gaze axis
// itself, and far enough above the chat panel that a five-line help still
// does not reach it.
const XR_FLAG_HELP_TOP = -0.05;
// BZFlag fires with Enter or the left mouse button and keeps the space bar for
// dropping a flag (ActionBinding.cxx:92-95).
// `?bot` joins as a robot tank, upstream's `ComputerPlayer` rather than its
// `TankPlayer`: what a probe or a test client is, so the list counts it apart
// from the people playing. Autopilot is not this -- a human on autopilot is
// still a human, as upstream's `isBot()` has it.
const IS_BOT_CLIENT = new URLSearchParams(window.location.search).has('bot');
// `?novoice` never creates a voice peer connection, so this client sends and
// receives no WebRTC traffic at all: for telling a network that drops on
// voice apart from one that drops on the game.
const NO_VOICE = new URLSearchParams(window.location.search).has('novoice');
// `?voicemode=silent` connects voice but never plays it: separates a device
// upset by voice playout from one upset by the WebRTC traffic.
// `?voicemode=relay` sends all of this client's voice through the TURN relay,
// so nothing reaches it from another player's address directly.
// `?voicemode=nohost` never tells peers this client's own interface addresses.
// `?voicemode=direct` drops the STUN and TURN servers: this client offers only
// its own addresses and never contacts either server.
// `?voicemode=google` swaps them for Google's public STUN server alone.
// `?voicemode=ipv6` is direct with every IPv4 candidate dropped both ways.
// `?voicemode=data` carries a 50-per-second data channel in place of audio;
// both ends need it.
const VOICE_MODE = new URLSearchParams(window.location.search).get('voicemode');
const VOICE_SILENT = VOICE_MODE === 'silent';
// Which address family voice uses. Phones keep it on IPv4: Verizon drops a
// phone's whole data session when a WebRTC call to some destinations runs over
// its IPv6. `?voicemode=ipv6` forces IPv6, `?voicemode=dual` allows both.
const VOICE_IP_FAMILY = VOICE_MODE === 'ipv6' ? '6'
  : VOICE_MODE === 'dual' ? null
    : VOICE_MODE === 'ipv4' || isMobile ? '4' : null;
// `?voicemic=1` opens the microphone and transmits as soon as voice starts, so
// a phone sends as well as receives: a device that only ever receives is the
// one shape of call Meet never makes.
const VOICE_MIC = new URLSearchParams(window.location.search).get('voicemic') === '1';
// `?voicepeers=1` connects voice to at most that many players at once.
const VOICE_MAX_PEERS = Number.parseInt(new URLSearchParams(window.location.search).get('voicepeers'), 10) || undefined;
// This page's own id, sent with every join. A reconnect carries the same one,
// so the server can drop the connection it replaces at once rather than after
// the pong timeout -- a dropped phone otherwise comes back to find its old self
// still holding its name. Per page load, not stored: a duplicated tab copies
// sessionStorage, and two tabs with one id would keep replacing each other.
const PAGE_TOKEN = Array.from(window.crypto.getRandomValues(new Uint8Array(16)),
  (byte) => byte.toString(16).padStart(2, '0')).join('');
const FIRE_KEY = 'Enter';
// The drive keys and which way each one pushes its axis, kept as the two axes
// they steer rather than one list, because a held key owns its own axis and
// leaves the other to the stick or the mouse.
const FORWARD_KEYS = Object.freeze({ KeyW: 1, ArrowUp: 1, KeyS: -1, ArrowDown: -1 });
const TURN_KEYS = Object.freeze({ KeyA: 1, ArrowLeft: 1, KeyD: -1, ArrowRight: -1 });
// playing.cxx:4028 shows the death notice for four seconds as a warning. The
// kill notice is bzo's own and matches it, so the two read as a pair.
const DEATH_ALERT_SECONDS = 4;
const KILL_ALERT_SECONDS = 4;
// setTarget()'s own two seconds, on its own slot so it never displaces a death.
const IDENTIFY_ALERT_SECONDS = 2;
// playing.cxx:3540. A guided missile's target is warned at most this often,
// however many missiles are in the air or how often the shooter retargets.
const LOCK_WARNING_INTERVAL_MS = 750;
// playing.cxx:3260, :3277 and :3299. A message announces itself no more often
// than this -- upstream's own two seconds, kept per kind because upstream keeps
// a separate `static lastMsg` in each of the three branches.
const MESSAGE_SOUND_INTERVAL_MS = 2000;
// handleNearFlag()'s five (playing.cxx:2016). It shares the identify slot
// rather than upstream's slot 0: driving past a row of flags reports each one,
// and bzo keeps slot 0 for the death and kill notices, which a player has four
// seconds to read and cannot ask for again.
const NEAR_FLAG_ALERT_SECONDS = 5;
// playing.cxx:1455 names the flag you just took on slot 2 for three seconds, in
// the warning colour when it is one you cannot put down. bzo keeps both the slot
// and the rule, and holds the slot for as long as a sticky flag lasts so the
// shake countdown has somewhere upstream-shaped to live.
const CARRIED_FLAG_ALERT_SECONDS = 3;
const FLAG_SHAKE_ALERT_SLOT = 2;
// Every pause alert upstream writes goes to slot 1 for a second at a time:
// the countdown, whatever refused it, and the clear when it takes hold
// (clientCommands.cxx:455, playing.cxx:6889).
const PAUSE_ALERT_SLOT = 1;
const PAUSE_ALERT_SECONDS = 1;
// Player.cxx:1006 sizes the paused sphere at one and a half tank radii, which is
// wide enough to enclose the tank it is drawn around.
function pausedSphereRadius() {
  return 1.5 * TANK.radius;
}
const RADAR_ZOOM_LEVELS = [0.25, 0.5, 1.0];
const RADAR_ZOOM_LABELS = ['Short', 'Medium', 'Long'];
// BZFlag's displayRadarRange default (defaultBZDB.cxx). The level is deliberately
// not persisted: a headset has no key or button to zoom with, so every session
// starts at a range that reads well on every device.
const RADAR_ZOOM_DEFAULT = 0.5;
const RADAR_ZOOM_MIN = 0.005;
const RADAR_ZOOM_MAX = 2.0;
const RADAR_ZOOM_STEP = 1.05;
let radarZoomLevel = RADAR_ZOOM_DEFAULT;
// `?radarZoom=` -- a measurement knob, the same rules as the ones in render.js:
// URL only, never persisted, never in the UI, clamped on the way in, and on
// every `renderer.stats` line. The panel's cost is what its range puts on it,
// so a client asked to measure a map has to be able to start wide rather than
// be wheeled there by hand -- and a sample that did not say which range it was
// taken at could not be compared with the one beside it.
function readRadarZoomKnob() {
  const raw = new URLSearchParams(window.location.search).get('radarZoom');
  if (raw === null) return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(RADAR_ZOOM_MIN, Math.min(RADAR_ZOOM_MAX, numeric));
}
const radarZoomKnob = readRadarZoomKnob();
if (radarZoomKnob !== null) radarZoomLevel = radarZoomKnob;
const pendingDebugPackets = [];
let pendingJoinRequest = null;
let renderReadyForJoin = false;
let gameplayJoinConfirmed = false;
let initSequence = 0;
let activeInitSequence = 0;
// The roster in `init` is a snapshot, and it is applied only once the models,
// textures and audio it names have loaded -- a window seconds wide on a cold
// start. When several clients reconnect together, the others are still joining
// through that window, and their real names arrive in it. Applying the snapshot
// afterwards would put back the `Player n` each of them was called at the
// moment it was taken, and nothing later would correct it: movement packets
// carry no name. So the messages that arrive in the window are held and
// replayed over the snapshot in the order they came.
let rosterSnapshotPending = false;
let queuedRosterMessages = [];
// Everything that carries a player's identity or their place in the world.
const ROSTER_MESSAGE_TYPES = new Set([
  'playerJoined',
  'playerUpdated',
  'playerLeft',
  'alive',
  'playerList',
]);
let xrSettingsShortcutLatched = false;
let xrSettingsShortcutInFlight = false;
let xrSettingsMenuOpen = false;
let xrHudOverlaysActive = false;
let xrSettingsMenuScreen = 'settings';
let xrSettingsMenuRenderer = null;
let xrSettingsMenuSelectedIndex = 0;
let xrSettingsMenuNavigationDirection = 0;
let xrSettingsMenuNextRepeatAt = 0;
let xrSettingsMenuActivateLatched = false;
let xrSettingsMenuBackLatched = false;
// Upstream's `shots[]` (LocalPlayer.h:170) with the shells left out: when each
// of this tank's slots comes back, and nothing else. A slot is taken when it is
// fired and freed only by its own reload running out -- a shell stopping
// against a wall does not hand one back, on either end, so there is nothing
// about the shot itself worth keeping here. Cleared on spawn, as
// `LocalPlayer::restart` clears it.
let myShotSlotFreeAt = [];
// The reload each slot was filled on, kept beside it because a bar reads its
// own shot's `ShotPath::reloadTime` and not the tank's current one: fire with a
// Machine Gun and drop it, and those slots still come back at a Machine Gun's
// rate. Only the bars need this; what the trigger waits on is the time above.
let myShotSlotReloadMs = [];
// `LocalPlayer::jamTime`, the one gate that sits across every slot at once.
// `getReloadTime` reads it before it looks at a single slot, and `forceReload`
// is the only thing that sets it: Thief's drop penalty, and Trigger Happy
// keeping its own shots from going off together.
let shotJamUntil = 0;
// The trigger's own two gates, which are bzo's and not upstream's -- see
// `SHOT_TAP_SPACING_MS`. One press may fire again `SHOT_TAP_SPACING_MS` later;
// a trigger that is simply still held repeats at the world's sustained rate
// instead, so a thumb resting on a touch button never empties the slots.
let nextTapShotAt = 0;
let nextHeldShotAt = 0;
let fireWasHeld = false;
// The tank's velocity as of the last move, which a shot inherits.
let shotTankVelocity = { x: 0, y: 0, z: 0 };
let playerTeam = PLAYER_TEAM.ROGUE;
// `rabbitIndex` on the client side (playing.cxx keeps it in the players' teams
// alone; bzo keeps the id as well, because the radar and the scoreboard both
// want to ask "is this the rabbit" without walking the roster). null on a world
// that is not playing Rabbit Chase, and between one rabbit and the next.
let rabbitPlayerId = null;
// World::allowRabbit() -- whether this world plays Rabbit Chase at all, which is
// a different question from whether it has a rabbit right now. The scoreboard's
// sort and its rank column read this, so they must not read `rabbitPlayerId`:
// that is null between one rabbit and the next, and a board that reordered
// itself in the gap would be unreadable.
let rabbitChaseEnabled = false;
// hud->setAlert(0, "You are now the rabbit.", 10.0f, false) -- playing.cxx:2877.
const RABBIT_ALERT_SECONDS = 10;
// Whether this player may speak on the admin channel and operate the server.
// The server's answer, not a rule kept here -- see `isAdmin` in `server.js` for
// what decides it. Everything behind the Operator panel is refused there as
// well, so this only decides what is worth offering.
let amAdmin = false;
// Authenticated with a bzflag.org global callsign. Read off the server's own
// player state, never decided here: this is the client being told an answer,
// as `amAdmin` is. See docs/login-plan.md.
let amVerified = false;
let myGlobalCallsign = null;
// The wall clock, read once a frame.
//
// `TimeKeeper::setTick()` / `getTick()` upstream (`TimeKeeper.h:71`), sampled at
// the top of the play loop and read 64 times against 39 direct `getCurrent()`
// calls: the cached value is the default and a fresh reading is the exception.
// The rule its exceptions follow is that a fresh reading is taken only where the
// reading *is* the measurement -- upstream keeps its network timing on
// `getCurrent()` and everything else on the tick.
//
// bzo's split is by clock rather than by call site. `performance.now()` is
// monotonic and is what motion and send timing already run on, so `deltaTime`
// and `sdt` are untouched by this. This is the *epoch* clock, the one used for
// anything measured against a timestamp the server also holds, and one reading
// a frame is enough for all of it -- reading it per projectile instead would
// difference two samples taken microseconds apart and call the difference
// physics.
//
// Anything that can run while frames are stopped calls `sampleEpochClock()`
// instead of reading the stale value: a hidden tab delivers no frames but still
// delivers socket messages, and a countdown started against a clock thirty
// seconds old has already expired.
let frameEpochMs = Date.now();

function sampleEpochClock() {
  frameEpochMs = Date.now();
  return frameEpochMs;
}

// The origin a move packet's `ct` is measured from -- upstream's own
// `TimeKeeper::getNullTime()` (`ServerLink.cxx:782`), so the value that rides
// the wire stays a small, growing-from-zero number for the length of the
// session instead of a thirteen-digit epoch. Only ever differenced against
// another of this client's own `ct` values, so what it is relative to does
// not matter to the server.
const clientClockOrigin = Date.now();

// One entry per colour team the server offers: { team, size, wins, losses }.
// Empty until a team-mode server sends its first update.
let teamScores = [];
// The match clock ("Match end" in docs/game-modes-plan.md). `matchTimeLeft` is
// the server's value as of `matchTimeReceivedAt` (an `frameEpochMs` reading),
// extrapolated locally every time the scoreboard redraws rather than re-sent
// every frame -- the same reason HUDRenderer does upstream. `null` with no
// clock configured, `-1` while paused.
let matchTimeLeft = null;
let matchTimeReceivedAt = 0;
let matchGameOver = false;

// The Operator panel's Match Timer buttons and the XR equivalents both funnel
// here, exactly as `/countdown`/`/gameover` reach the same server-side
// functions from the chat entry.
function sendMatchControl(action) {
  sendToServer({ type: 'matchControl', action });
}

// `init.listServer` -- admin-only, see docs/list-server-plan.md -- shows or
// hides the panel's key row and fills in its status line. Never shown the
// key itself, only whether one is configured: `setListServerKey` is a
// write-only field the same way a password field is.
function syncListServerRow(listServer) {
  const row = document.getElementById('listServerRow');
  const status = document.getElementById('listServerKeyStatus');
  if (!row) return;
  row.hidden = !listServer;
  if (!listServer || !status) return;
  status.textContent = listServer.designated
    ? 'this is the designated list server'
    : !listServer.url
      ? 'disabled (no listServerUrl)'
      : `reporting to ${listServer.url}: ${listServer.keyConfigured ? 'key configured' : 'no key yet'}`;
}

function applyMatchTimeUpdate(timeLeft) {
  matchTimeLeft = timeLeft;
  matchTimeReceivedAt = sampleEpochClock();
  // Exactly zero is the only value that means the match is over: `-1` is
  // paused (still playing) and `null` is "no clock", which is also what
  // `startMatch` sends on a clockless server specifically to clear a stale
  // `GAME OVER` left over from a score-limit ending.
  matchGameOver = timeLeft === 0;
  refreshScoreboards();
}

// playing.cxx:2240: a score limit's own end, distinct from the clock's --
// there is a winner to name here, where a time-up or an operator's /gameover
// has none. Reuses the same game-over scoreboard state `timeUpdate(0)` sets,
// since the hold itself (no respawn) is identical either way.
function applyScoreOver(playerId, team) {
  matchGameOver = true;
  refreshScoreboards();
  const text = team
    ? `The ${PLAYER_TEAM_LABELS[team] || team} team won the game`
    : null;
  if (text) {
    noticeAbout(0, [text], DEATH_ALERT_SECONDS, true);
  } else if (playerId) {
    noticeAbout(0, [describePlayer(playerId), ' won the game'], DEATH_ALERT_SECONDS, true);
  }
}

// The number the HUD actually shows: extrapolated from the last update rather
// than re-read every frame, and left untouched while paused (`-1` upstream's
// own "show nothing" value, not a countdown to extrapolate).
function getDisplayedMatchTimeLeft() {
  if (matchTimeLeft === null || matchTimeLeft < 0) return matchTimeLeft;
  const elapsed = (frameEpochMs - matchTimeReceivedAt) / 1000;
  return Math.max(0, Math.round(matchTimeLeft - elapsed));
}
// The team row's choice, kept like the name and the tank (issue #163): a
// server restart reloads every client onto its new build, and an observer has
// to come back an observer. What is kept is the choice -- Automatic stays
// Automatic, never the team it landed on -- and only one the player made: a
// link that stages a team decides that page load and nothing after it.
const PLAYER_TEAM_STORAGE_KEY = 'playerTeam';
function readStoredPlayerTeam() {
  try {
    const stored = localStorage.getItem(PLAYER_TEAM_STORAGE_KEY);
    return stored ? stored : null;
  } catch {
    return null;
  }
}
// The team a Play link plays on: the player's own choice, unless that is to
// watch, which a Play link is not.
function playLinkTeam() {
  const team = selectedPlayerTeam;
  return team && !isObserverTeam(team) && team !== PLAYER_TEAM.MAP_VIEWER ? team : PLAYER_TEAM.AUTOMATIC;
}
function storePlayerTeamChoice(team) {
  try {
    // Map Viewer needs its map, which its own link carries; without one the
    // nearest thing is to watch.
    localStorage.setItem(PLAYER_TEAM_STORAGE_KEY, team === PLAYER_TEAM.MAP_VIEWER ? PLAYER_TEAM.OBSERVER : team);
  } catch {
    /* ignore storage errors */
  }
}
let selectedPlayerTeam = normalizePlayerTeamSelection(readStoredPlayerTeam() ?? PLAYER_TEAM.AUTOMATIC);
let availablePlayerTeams = [PLAYER_TEAM.ROGUE, PLAYER_TEAM.OBSERVER];
// `?follow=leader` -- the link to hand somebody who wants to watch a match. It
// joins as an observer in the follow view on whoever is leading, and does not
// stop to ask for a name, because a link that opens a dialog is not a link you
// can hand out.
//
// The value names *who* to watch, which is the axis that will want more later:
// a callsign is the obvious next one, and `leader` is simply the one target bzo
// can already resolve without being told an id. Which rig to watch from is the
// other axis and would be a parameter of its own, since one value cannot carry
// both. A value bzo cannot resolve is refused rather than guessed at -- the page
// joins as it always would, so a typo puts you in the game under your own name
// instead of silently watching the wrong tank.
const AUTO_FOLLOW_LEADER = 'leader';

function readAutoFollowTarget() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('follow')) return null;
  const requested = (params.get('follow') || '').trim().toLowerCase();
  return requested === '' || requested === AUTO_FOLLOW_LEADER ? AUTO_FOLLOW_LEADER : null;
}

const autoFollowTarget = readAutoFollowTarget();

// Which view to watch in, the second axis the comment above says belongs in a
// parameter of its own: `?follow=leader&view=track` comes back tracking the
// leader rather than following them, which is a different camera and, on a
// screen left running, usually the one wanted. Any of the views the roam
// cycle offers by name, and an unrecognised one is refused the same way --
// the link watches as it otherwise would rather than guessing.
function readAutoRoamView() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('view')) return null;
  const requested = (params.get('view') || '').trim().toLowerCase();
  return ROAM_VIEW_ORDER.includes(requested) ? requested : null;
}

const autoRoamView = readAutoRoamView();

// `?viewmap=bzo.bzw` -- issue #68's direct link into Map Viewer. Names a file
// rather than validating one: the list of what this server has actually
// hashed only exists once `init` arrives, so this just captures the request
// and `init`'s handling of it decides whether the file is real.
function readViewMapTarget() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('viewmap')) return null;
  const requested = (params.get('viewmap') || '').trim();
  return requested || null;
}
const autoViewMapTarget = readViewMapTarget();

// `?cam=free|fp|tp|overview` alongside `?viewmap=` -- which roam view a shared
// Map Viewer link starts in. The four named are the only ones a link can
// reproduce at all: every other `ROAM_VIEW` rides a specific player or flag,
// which a generic link has no way to name. Read once and applied on every
// (re)join the same way `autoFollowTarget` already is, below.
function readViewCamTarget() {
  const params = new URLSearchParams(window.location.search);
  const raw = (params.get('cam') || '').trim().toLowerCase();
  if (raw === 'free') return ROAM_VIEW.FREE;
  if (raw === 'fp') return ROAM_VIEW.DRIVE_FP;
  if (raw === 'tp') return ROAM_VIEW.DRIVE_TP;
  if (raw === 'overview') return ROAM_VIEW.OVERVIEW;
  return null;
}
const autoViewCamTarget = readViewCamTarget();

// `?pos=x,y,z,deg[,pitch]` -- where a shared Map Viewer link starts, and which
// way it faces, in upstream's frame as a `.bzw` and `/mv` state it: `z` up, and
// the facing an azimuth, counter-clockwise from east. The optional fifth is an
// observer's pitch, up positive (roam.mjs). Degrees rather than radians: this
// is the one part of the link a person might actually read or type by hand, the
// same reason a `.bzw`'s own `rotation` line is degrees and not radians.
function readViewPosTarget() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('pos')) return null;
  const parts = (params.get('pos') || '').split(',').map(Number);
  if ((parts.length !== 4 && parts.length !== 5) || !parts.every(Number.isFinite)) return null;
  const [x, y, z, deg, pitchDeg = 0] = parts;
  const pitch = Math.max(-ROAM_PITCH_LIMIT, Math.min(ROAM_PITCH_LIMIT, (pitchDeg * Math.PI) / 180));
  return { x, y, z, azimuth: (deg * Math.PI) / 180, pitch };
}
const autoViewPosTarget = readViewPosTarget();
// A link's pitch, held until the roaming camera is next made and taken once.
let linkRoamPitch = null;
// Set once a link's `pos=` has placed the viewer. A free camera is free: the
// spot a link names is where its sender stood, outside the walls or not, so
// `confineViewerToWorld` leaves it alone in that view.
let viewerPlacedByLink = false;

// The current view, as a link -- what the "Share View Link" button hands
// back. It names the map actually on screen: the staged or joined Map Viewer
// world while one is up, and the live match's own map otherwise. The picker's
// `selectedViewMapFile` is not that map -- the entry dialog stages the first
// map on the list into it whether or not anyone is heading for Map Viewer, so
// reading it handed a player in a live match a link to somebody else's map.
// A page watching a remote server hands back a `?watch=` link to that server
// instead, since the live game there is what is on screen.
//
// An observer riding a player or a flag (`roamViewNeedsTarget`'s list, and
// FLAG) is handed back as free roam from where the camera is now: whoever it
// follows may not be leading, or even present, when the link is opened.
function buildShareViewLink() {
  const destination = currentDestination();
  const watching = destination.startsWith('watch:') ? destination.slice('watch:'.length) : null;
  // A replay is shared as itself, for the same reason.
  const replaying = destination.startsWith('replay:') ? destination.slice('replay:'.length) : null;
  const mapFile = isPreviewingAltWorld() ? previewedMapFile : currentMapFile;
  // A link is only worth handing over for a map this server has hashed and
  // will serve to whoever opens it -- which the served map is, but a `random`
  // world generated at startup is not.
  if (!watching && !replaying && (!mapFile || !availableViewMaps.some((entry) => entry.file === mapFile))) return null;
  const camNames = {
    [ROAM_VIEW.FREE]: 'free',
    [ROAM_VIEW.DRIVE_FP]: 'fp',
    [ROAM_VIEW.DRIVE_TP]: 'tp',
    [ROAM_VIEW.OVERVIEW]: 'overview',
  };
  // An observer's camera is a roam view; a playing tank's is its own setting,
  // and the two share the link's vocabulary but not their state.
  const playerCamNames = {
    'first-person': 'fp',
    'third-person': 'tp',
    overview: 'overview',
  };
  const cam = isObserver() ? (camNames[roamView] || 'free') : playerCamNames[cameraMode];
  // As `/mv` takes it -- see `readViewPosTarget` -- with an observer's pitch
  // after it when the view is tilted: the angle the view actually looks, so a
  // link from a view riding a tank keeps the slope it was watching from.
  const deg = ((myAzimuth * 180) / Math.PI).toFixed(1);
  let pos = `${myX.toFixed(1)},${myY.toFixed(1)},${myZ.toFixed(1)},${deg}`;
  const framing = isObserver() ? getRoamFraming() : null;
  if (framing) {
    const { eye, look } = framing;
    const pitchDeg = (Math.atan2(look.z - eye.z, Math.hypot(look.x - eye.x, look.y - eye.y)) * 180) / Math.PI;
    if (Math.abs(pitchDeg) >= 0.05) pos += `,${pitchDeg.toFixed(1)}`;
  }
  const where = replaying ? `replay=${encodeURIComponent(replaying)}` : watching
    ? `watch=${encodeURIComponent(watching)}`
    : `viewmap=${encodeURIComponent(mapFile)}`;
  const query = `${where}${cam ? `&cam=${cam}` : ''}&pos=${pos}`;
  return `${window.location.origin}${window.location.pathname}?${query}`;
}
let selectedVoiceInputDeviceId = '';
// One level per VOLUME_CHANNELS row, restored before the first sound plays so
// nothing is ever briefly loud on the way to the level the player chose.
const volumeLevels = Object.fromEntries(VOLUME_CHANNELS.map(
  (channel) => [channel.id, readVolumeLevel(localStorage, channel.storageKey)],
));
let voiceRtcConfig = { iceServers: [] };
let selectedVoiceChannel = normalizeVoiceChannel(
  localStorage.getItem('voiceChannel') ?? DEFAULT_VOICE_CHANNEL,
);
// What the WebRTC layer is actually doing, keyed by peer id. The voice manager
// tracks its peers already; this is the part the player can see.
const voicePeerDebug = new Map();
let voiceManager = null;
let voiceManagerState = {
  channel: selectedVoiceChannel,
  team: PLAYER_TEAM.ROGUE,
  microphonePermission: 'prompt',
  microphoneEnabled: false,
  transmitting: false,
  hasLocalStream: false,
  canTransmit: true,
  lastError: null,
};

function getSelectedPlayerTeam() {
  const teamSelector = document.getElementById('entryTeamSelector');
  return teamSelector ? normalizePlayerTeamSelection(teamSelector.dataset.team) : selectedPlayerTeam;
}

function syncPlayerTeamSelector() {
  const teamSelector = document.getElementById('entryTeamSelector');
  const teamValue = document.getElementById('entryTeamValue');
  const label = PLAYER_TEAM_LABELS[selectedPlayerTeam];
  if (teamSelector) {
    teamSelector.dataset.team = selectedPlayerTeam;
    teamSelector.setAttribute('aria-label', `Team: ${label}`);
  }
  if (teamValue) teamValue.textContent = label;
  // The preview tank wears the staged team's colour, so the row above changing
  // is the row below needing to be repainted. Every team change comes through
  // here, which is why the call belongs here rather than at each caller.
  refreshTankPreviewColor();
  // Whether a previewed world is still the one being looked at: leaving Map
  // Viewer for a playing team is what hands the view back to the live match
  // (issue #68). The map itself is chosen in the View dialog, not here.
  syncMapViewerPreview();
}

// Whether the 3D view and radar right now are showing a map nobody has
// joined, rather than the live match -- true while the dialog is staging Map
// Viewer over a chosen map, and true for the rest of a session actually
// joined as one. Remote tanks, shots and flags are hidden for the same
// duration: they belong to the live match's coordinates, which no longer
// describe anything in view.
function isPreviewingAltWorld() {
  return previewedMapFile !== null;
}

// Hides what is already on screen the instant a preview starts, and restores
// ordinary visibility the instant one ends -- the guards in `addPlayer`,
// `createProjectile` and `updateFlags` handle everything from here on by
// simply not drawing more of it while `isPreviewingAltWorld()` holds.
function setMapViewerPreviewActive(active) {
  if (active) {
    tanks.forEach((tank) => { tank.visible = false; });
    flags.forEach((flag, index) => renderManager.hideFlag(index));
    projectiles.forEach((projectile) => renderManager.removeProjectile(projectile));
    projectiles.clear();
  } else {
    tanks.forEach((tank) => {
      const state = tank.userData?.playerState;
      tank.visible = Boolean(state && state.alive);
    });
  }
}

// The heart of the dialog-time preview (issue #68): behind the entry dialog,
// exactly the way the live match already renders there before a fresh
// connection has joined anything, Map Viewer's own picker swaps in whichever
// map is currently staged. `loadWorldFile` is cache-backed (module-level by
// hash, and the browser's own HTTP cache besides, since the URL is
// `immutable`), so cycling back to an already-seen map is instant.
function syncMapViewerPreview() {
  const stagedTeam = getSelectedPlayerTeam();
  if (stagedTeam !== PLAYER_TEAM.MAP_VIEWER) {
    if (previewedMapFile !== null) {
      previewedMapFile = null;
      setMapViewerPreviewActive(false);
      applyWorldData(liveWorldData);
    }
    return;
  }
  const target = selectedViewMapFile || availableViewMaps[0]?.file || null;
  if (!target || target === previewedMapFile) return;
  const entry = availableViewMaps.find((candidate) => candidate.file === target);
  if (!entry) return;
  const wasAlreadyPreviewing = previewedMapFile !== null;
  previewedMapFile = target;
  if (!wasAlreadyPreviewing) setMapViewerPreviewActive(true);
  loadWorldFile(entry).then((world) => {
    // The player may have cycled to a different map (or left Map Viewer
    // entirely) while this fetch was in flight; only the most recent choice
    // gets applied.
    if (previewedMapFile === target) applyWorldData(world);
  });
}

// The dialog's own team cycle: every server-recognized selection, with Map
// Viewer (issue #68) inserted right after Observer -- it is never a real team
// (see `PLAYER_TEAM.MAP_VIEWER`'s own comment in teams.mjs), offered here
// purely as a client-side alternative to plain Observer, exactly when
// Observer itself is offered and there is at least one map to look at.
// --- Where this browser is pointed ------------------------------------------
//
// `local`, or `proxy:<key>` for one of the bzfs servers this instance carries
// (`proxies` on `init`). Changing it is a page navigation, not a message: a
// proxied target is fixed before the socket opens, because `init` is
// synthesized from it. See docs/proxy-plan.md, "How the selector behaves".

const DESTINATION_LOCAL = 'local';

let availableProxies = [];
let localDestinationTeams = [];
// The map this instance's own game is on, without its extension: `hix`, not
// `hix.bzw`. What names the local row in the destination selector.
let localDestinationMap = '';

// Where this page actually is, read off its own URL rather than remembered, so
// there is no second copy of the answer to drift from the connection.
function currentDestination() {
  const params = new URLSearchParams(window.location.search);
  // A watched server is its own destination: not this instance's game, and
  // not one of the targets it proxies either.
  const watching = params.get('watch');
  if (watching) return `watch:${watching}`;
  // So is a replay: one of this instance's recordings, played to whoever
  // watches it (docs/replay.md).
  const replaying = params.get('replay');
  if (replaying) return `replay:${replaying}`;
  const key = params.get('proxy');
  return key ? `proxy:${key}` : DESTINATION_LOCAL;
}

let selectedDestination = currentDestination();

function getDestinationChoices() {
  const choices = [DESTINATION_LOCAL, ...availableProxies.map((proxy) => `proxy:${proxy.key}`)];
  // Watching is reached from the View dialog rather than chosen here, but a
  // page already on one has to be able to name where it is -- and to leave.
  const here = currentDestination();
  if (here.startsWith('watch:') || here.startsWith('replay:')) choices.unshift(here);
  return choices;
}

function findProxyDestination(destination) {
  if (!destination.startsWith('proxy:')) return null;
  const key = destination.slice('proxy:'.length);
  return availableProxies.find((proxy) => proxy.key === key) || null;
}

function destinationLabel(destination) {
  if (destination.startsWith('watch:')) {
    return `watching ${destination.slice('watch:'.length).replace(/_(\d+)$/, ':$1')}`;
  }
  if (destination.startsWith('replay:')) return `replay ${destination.slice('replay:'.length)}`;
  const proxy = findProxyDestination(destination);
  // `host:port`, not the title the public list carries. A title is a
  // description -- two servers may well share one, and "bzo compatibilty
  // testing https://bz.rikers.org" says nothing about which of them this row
  // is. The address is the one thing that cannot collide.
  if (proxy) return proxy.name;
  // This instance has no `host:port` to show for itself -- it is the page you
  // are already on -- so its map is what distinguishes it from the targets
  // beside it.
  return localDestinationMap ? `local ${localDestinationMap}` : 'This server';
}

// The teams the chosen destination would accept. For wherever this connection
// already is that is `init`'s own answer, which is the authoritative one; for
// anywhere else it is what that destination said about itself, which is the
// best anyone can know before arriving.
function getDestinationTeams(destination) {
  // A watched server is played as an unregistered guest where it lets guests
  // spawn (`guestCallsign`, docs/proxy.md) -- the /list row's Play -- so the
  // page already on one offers what that server runs, which `init` said.
  // Anywhere else watched is only somewhere to watch from here.
  if (destination.startsWith('watch:')) {
    return destination === currentDestination() ? availablePlayerTeams : [PLAYER_TEAM.OBSERVER];
  }
  // Nobody plays in a recording.
  if (destination.startsWith('replay:')) return [PLAYER_TEAM.OBSERVER];
  if (destination === currentDestination()) return availablePlayerTeams;
  const proxy = findProxyDestination(destination);
  if (proxy) return PLAYER_TEAMS.filter((team) => proxy.teams.includes(team));
  return PLAYER_TEAMS.filter((team) => localDestinationTeams.includes(team));
}

// Whether pressing OK would open a *new* proxy connection on a playing team,
// which always needs a fresh global login: a token is single use and is spent
// at `MsgEnter`, so no live connection is holding one and none can be reused.
// That is the whole test -- there is no token state to track.
//
// Being verified somewhere else does not count, and asking `amVerified` here
// was a bug: it says this connection is verified on the server it is already
// talking to, which is exactly the thing a token cannot be carried over from.
//
// Staying put does not count either. Already on that target and already on
// that team, OK is a rejoin down the connection that was authenticated when
// it opened, so nothing new is needed.
//
// Observer never needs one, though signing in is still worth it there: it is
// how a player arrives under their registered callsign with whatever it
// carries on the target.
function destinationNeedsLogin(destination, team) {
  if (destination === DESTINATION_LOCAL) return false;
  if (team === PLAYER_TEAM.OBSERVER) return false;
  // A watched server is played as an unregistered guest (`guestCallsign` in
  // server.js), which no login could help with.
  if (destination.startsWith('watch:')) return false;
  if (destination.startsWith('replay:')) return false;
  return !(destination === currentDestination() && team === proxyEnteredTeam);
}

function setAvailableProxies(proxies, localTeams, localMap) {
  availableProxies = Array.isArray(proxies)
    ? proxies.filter((proxy) => proxy && typeof proxy.key === 'string' && Array.isArray(proxy.teams))
    : [];
  localDestinationTeams = Array.isArray(localTeams) ? localTeams : [];
  localDestinationMap = typeof localMap === 'string' ? localMap.replace(/\.bzw$/i, '') : '';
  selectedDestination = currentDestination();
  syncDestinationSelector();
}

function syncDestinationSelector() {
  const row = document.getElementById('entryDestinationSelector');
  const value = document.getElementById('entryDestinationValue');
  if (!row || !value) return;
  // Nothing to choose between is not a choice. Same rule the Map Viewer team
  // already follows, and it is the one that survives a proxy-only instance.
  const choices = getDestinationChoices();
  row.hidden = choices.length < 2;
  value.textContent = destinationLabel(selectedDestination);
  row.setAttribute('aria-label', `Server: ${value.textContent}`);
}

function selectRelativeDestination(direction) {
  const choices = getDestinationChoices();
  if (choices.length < 2) return;
  const at = choices.indexOf(selectedDestination);
  const next = choices[((at < 0 ? 0 : at) + direction + choices.length) % choices.length];
  if (next === selectedDestination) return;
  selectedDestination = next;
  // The team offered has to follow, or the dialog would carry a team the new
  // destination has never heard of into the link.
  const teams = getDestinationTeams(next);
  if (selectedPlayerTeam !== PLAYER_TEAM.AUTOMATIC && !teams.includes(selectedPlayerTeam)) {
    selectedPlayerTeam = PLAYER_TEAM.AUTOMATIC;
  }
  syncDestinationSelector();
  syncPlayerTeamSelector();
  // Both of these mean something different per destination: the login row is a
  // fresh login for a target rather than this connection's own status
  // (`applyLoginUi`), and a tank model reaches nobody on a proxied one
  // (`syncTankSelectorForDestination`).
  applyLoginUi();
  syncTankSelectorForDestination();
  syncMottoForDestination();
  syncEntryActions();
}

// Where the dialog's OK goes when the destination is not where we already are.
function destinationHref(destination, team) {
  if (destination === DESTINATION_LOCAL) return `${window.location.pathname}`;
  const proxy = findProxyDestination(destination);
  if (!proxy) return `${window.location.pathname}`;
  const params = new URLSearchParams({ proxy: proxy.key });
  if (team && team !== PLAYER_TEAM.AUTOMATIC) params.set('team', team);
  return `${window.location.pathname}?${params.toString()}`;
}

// OK cannot take you somewhere you would be refused. It greys only because
// Login is enabled beside it and carries both the destination and the team --
// a dead button with an enabled way through is a prompt, not a wall.
function syncEntryActions() {
  const ok = document.getElementById('entryOkButton');
  if (!ok) return;
  const team = getJoinTeamFields().team;
  // OK goes where it was asked to go. Playing on a proxied target has exactly
  // one route -- a global login, then that team -- so refusing to move until
  // the player finds the row that starts it is the button declining its own
  // job over a step it could take itself.
  //
  // It is not a surprise redirect either, because the label says so before it
  // is pressed. That was the real objection to OK doing this, and naming the
  // action answers it; a greyed button whose remedy is another row does not.
  const signsIn = destinationNeedsLogin(selectedDestination, team);
  ok.disabled = false;
  ok.textContent = signsIn ? 'Sign in & Play' : 'OK';
  ok.title = signsIn
    ? 'Playing here needs a bzflag.org global login. This signs you in, then'
      + ' joins on the team you picked.'
    : '';
}

function getDialogTeamSelections() {
  return getPlayerTeamSelections(getDestinationTeams(selectedDestination));
}

function setAvailablePlayerTeams(teams) {
  availablePlayerTeams = PLAYER_TEAMS.filter((team) => teams.includes(team));
  if (selectedPlayerTeam !== PLAYER_TEAM.AUTOMATIC && !getDialogTeamSelections().includes(selectedPlayerTeam)) {
    selectedPlayerTeam = PLAYER_TEAM.AUTOMATIC;
  }
  syncPlayerTeamSelector();
}

// Offered to a player already in the game as well: the dialog stages the choice
// and OK pays for it with a rejoin.
function selectRelativePlayerTeam(direction) {
  const teamSelections = getDialogTeamSelections();
  const currentIndex = teamSelections.indexOf(selectedPlayerTeam);
  const nextIndex = (currentIndex + direction + teamSelections.length) % teamSelections.length;
  selectedPlayerTeam = teamSelections[nextIndex];
  storePlayerTeamChoice(selectedPlayerTeam);
  // After the selector, not before: `getSelectedPlayerTeam` reads the row's
  // own dataset, which `syncPlayerTeamSelector` is what writes.
  syncPlayerTeamSelector();
  // The login row's wording depends on the staged team as well as the
  // destination, since it is what says "to play" when OK cannot.
  applyLoginUi();
  syncEntryActions();
}

function isObserver() {
  return isObserverTeam(playerTeam);
}

// The driveable phantom tank for Observer and Map Viewer alike (issue #68):
// a first- or third-person view of a tank the observer is flying, run
// through the exact same local physics a playing tank uses -- collision,
// jumping, shooting -- with nothing but the existing infrequent heartbeat
// (`sendObserverUpdate`) ever reaching the server. `roamView` already carries
// which camera the observer's whole camera system is in, so driving is just
// two more entries in that same list rather than a mode of its own.
function isPhantomDriving() {
  return roamView === ROAM_VIEW.DRIVE_FP || roamView === ROAM_VIEW.DRIVE_TP;
}

// The observer/Map Viewer end of the world-framing camera -- true only while
// an observer has actually cycled to it, so a playing tank's own Overview
// (`cameraMode`, public/input.js) is untouched and comes back unchanged on
// joining a team.
function isObservingOverview() {
  return isObserver() && roamView === ROAM_VIEW.OVERVIEW;
}

// The flag a phantom tank's own motion, jumping and Wings behave as if they
// were reading -- always Wings, so it never runs out of altitude -- without
// touching `getMyFlag()` itself. `getMyFlag()` stays null for an observer
// exactly as it already is: Drop Flag has to keep no-op'ing (`requestFlagDrop`
// returns false for a null flag), and nothing else that reads the real flag
// (the shot type, the HUD, the scoreboard colour) should think there is one.
function effectiveMotionFlagType() {
  return isPhantomDriving() ? 'WG' : (getMyFlag()?.type ?? null);
}

function isTheRabbit(playerId) {
  return rabbitPlayerId !== null && playerId === rabbitPlayerId;
}

// A hunted tank as the hunter sees it, which is what every mark over one asks:
// the radar ring, the sky beacon and the scoreboard's own bullseye.
//
// Never your own blip, since it is always dead centre and always you --
// upstream marks only the remote players for the same reason, and clears the
// hunt outright when the rabbit is you (playing.cxx:2880) -- and never at all
// while Colourblindness has taken the team colours away, which is upstream's
// own gate on the hunted flash (RadarRenderer.cxx:136).
//
// The rabbit is here without being named: Rabbit Chase marks it automatically
// (playing.cxx:2887), so on a Rabbit Chase world this answers for exactly the
// one tank it used to.
function isHuntMarked(playerId) {
  return huntState.isHunted(playerId) && playerId !== myPlayerId && !isColorblind();
}

// A tank in one line of text: the callsign, the flag it carries and the Rabbit
// Chase mark, in the shape a scoreboard row draws them. Upstream's Identify says
// as much (playing.cxx:4488) and bzo's alerts read the same as its roster.
//
// Colourblindness costs the whole answer, not just the name: upstream drops to
// "a tank" outright (playing.cxx:4479), and naming the flag or marking the
// rabbit would hand back what the colour no longer says.
// A tank in one line of text: the callsign in the colour the roster gives it, the
// flag it carries, and its team where the team says something. That is upstream's
// `<callsign> (<Team>) with <Flag>` (playing.cxx:4016, :4488) in bzo's own order,
// with the flag tight against the name as every bzo surface writes the pair.
//
// Every alert and notice that names a player goes through this, so none of them
// can describe the same tank differently -- and adding the colour to alerts is
// what let the team and the flag come with it.
//
// `blind` is Colourblindness, which costs the whole answer rather than just the
// name: upstream drops to "a tank" outright (playing.cxx:4479), and naming the
// flag or the team would hand back exactly what the colour no longer says.
// `flag` overrides what the world says this tank is carrying, for a notice about
// a moment that has already passed -- a kill message carries the flag from the
// server for exactly that reason.
function describePlayer(playerId, { blind = isColorblind(), flag } = {}) {
  if (blind) return { text: 'a tank', segments: null };
  const state = playerId === myPlayerId
    ? myTank?.userData?.playerState
    : tanks.get(playerId)?.userData?.playerState;
  return formatPlayerLabel({
    name: getPlayerName(playerId),
    // The colour the scoreboard gives this player's row, so a notice and the
    // roster agree about whose tank is being described.
    nameColor: Number.isFinite(state?.color) ? state.color : null,
    flag: flag === undefined ? getPlayerFlagLabel(playerId) : flag,
    mark: getPlayerTeamMark(getPlayerTeamById(playerId)),
  });
}

// The callsign alone, in the colour the roster gives it. Upstream's "teammate
// <callsign>" carries neither team nor flag: we are already the same team, and
// which of us it was is the whole of what went wrong.
function describePlayerName(playerId) {
  if (isColorblind()) return { text: 'a tank', segments: null };
  const state = playerId === myPlayerId
    ? myTank?.userData?.playerState
    : tanks.get(playerId)?.userData?.playerState;
  return formatPlayerLabel({
    name: getPlayerName(playerId),
    nameColor: Number.isFinite(state?.color) ? state.color : null,
  });
}

// A notice that names a player, on both surfaces at once: the alert slot the eye
// is on, and the chat line that keeps it after the alert times out. `parts` is
// the sentence as `[string | describePlayer(...)]`, so a caller writes the words
// and names the tanks without composing colours itself.
function noticeAbout(slot, parts, seconds, warning, kind = CHAT_KIND_MISC) {
  const segments = [];
  for (const part of parts) {
    if (typeof part === 'string') segments.push({ text: part });
    else if (part?.segments) segments.push(...part.segments);
    else if (part) segments.push({ text: part.text });
  }
  const text = segments.map((segment) => segment.text).join('');
  if (slot !== null) setHudAlert(slot, text, seconds, warning, segments);
  addChatEntry(['misc', 'all'], text, kind, segments);
  updateChatWindow();
  return text;
}

// The Identify alerts, on both surfaces: a prefix in the alert's own colour and
// then the player, coloured as their scoreboard row is. The prefix segment
// carries no colour of its own, which is how it inherits the alert's.
function showIdentifyAlert(prefix, playerId) {
  const described = describePlayer(playerId);
  setHudAlert(
    1,
    `${prefix} ${described.text}`,
    IDENTIFY_ALERT_SECONDS,
    false,
    described.segments ? [{ text: `${prefix} ` }, ...described.segments] : null,
  );
}

// The team a player is on, from whichever copy of the roster knows it:
// `playerTeam` for me, since that is the one the join confirms, and the tank's
// own state for anybody else.
function getPlayerTeamById(playerId) {
  if (playerId === myPlayerId) return playerTeam;
  return tanks.get(playerId)?.userData?.playerState?.team ?? null;
}

// A tank is built from its colour rather than tinted, so a tank whose effective
// colour just changed has to be rebuilt. `refreshTankDisguises` does that once a
// frame for remote tanks and skips the local one on purpose -- you cannot see
// your own disguise -- but being the rabbit is a team, not a disguise, so this is
// the path the rabbit's repaint takes for either.
function rebuildTankColor(playerId) {
  const tank = tanks.get(playerId);
  const state = tank?.userData?.playerState;
  if (!tank || !state) return;
  if (getEffectiveTankColor(playerId, state.color) === tank.userData.builtColor
    && getTankCamoOptions(playerId).rogue === tank.userData.builtRogue) return;
  // The live mesh position rather than the one the last roster message carried:
  // the local tank's stored state is only refreshed on a join, so rebuilding
  // from it would stand the tank back where it was then for a frame.
  addPlayer({
    ...state,
    ...tankPoint(tank),
    azimuth: tankAzimuth(tank),
  });
  // addPlayer *replaces* the mesh when the colour changed, so every caller that
  // can rebuild the local tank has to re-point `myTank` at the new one -- the old
  // one is out of `tanks` and out of the scene. Miss this and the movement code
  // goes on writing positions onto an orphan while the camera reads myX/Y/Z:
  // the view moves and the tank does not.
  if (playerId === myPlayerId) myTank = tanks.get(myPlayerId);
}

// MsgNewRabbit (playing.cxx:2851). One id repaints the whole roster: that player
// becomes the rabbit and every other non-observer a hunter, which is what the
// message says rather than something derived from it -- the server has already
// made the same change to its own roster.
function applyNewRabbit(nextRabbitId) {
  const previousRabbitId = rabbitPlayerId;
  rabbitPlayerId = nextRabbitId;
  // PlayerInfo::wasARabbit: deposed, and excused a team kill until it spawns
  // again, when its fresh state clears this.
  const deposed = previousRabbitId !== nextRabbitId ? getPlayerStateOf(previousRabbitId) : null;
  if (deposed) deposed.wasRabbit = true;

  tanks.forEach((tank, id) => {
    const state = tank.userData?.playerState;
    if (!state || isObserverTeam(state.team)) return;
    state.team = id === nextRabbitId ? PLAYER_TEAM.RABBIT : PLAYER_TEAM.HUNTER;
  });
  if (myPlayerId && !isObserver()) {
    playerTeam = myPlayerId === nextRabbitId ? PLAYER_TEAM.RABBIT : PLAYER_TEAM.HUNTER;
  }
  // Only the two tanks whose colour can have changed, since hunters keep the
  // per-player colour they already had.
  if (previousRabbitId !== null) rebuildTankColor(previousRabbitId);
  if (nextRabbitId !== null) rebuildTankColor(nextRabbitId);
  // The hunt follows the anointing: every mark is cleared and the new rabbit
  // takes one, so a hunter's radar ring, sky beacon and `SPOTTED` alert all come
  // from the hunt rather than from a second rule about rabbits
  // (playing.cxx:2858-2889).
  huntState.rabbitChanged(nextRabbitId, {
    iAmTheRabbit: nextRabbitId !== null && nextRabbitId === myPlayerId,
    observing: isObserver(),
  });
  refreshScoreboards();

  if (nextRabbitId === null || nextRabbitId === previousRabbitId) return;
  if (nextRabbitId === myPlayerId) {
    setHudAlert(0, 'You are now the rabbit.', RABBIT_ALERT_SECONDS, false);
    renderManager.playLocalSound('huntSelect');
  }
  // addMessage(rabbit, "is now the rabbit") sits outside upstream's own branch,
  // so the new rabbit reads the line as well as hearing the alert. The mark the
  // description carries is `(rabbit)` by now, which is the point of the line.
  noticeAbout(null, [describePlayer(nextRabbitId), ' is now the rabbit'], 0, false);
}

function normalizeRadarZoomLevel(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return RADAR_ZOOM_DEFAULT;
  return Math.max(RADAR_ZOOM_MIN, Math.min(RADAR_ZOOM_MAX, numeric));
}

function getRadarZoomLabel(level = radarZoomLevel) {
  const index = RADAR_ZOOM_LEVELS.findIndex((preset) => Math.abs(level - preset) < 1e-4);
  if (index >= 0) return RADAR_ZOOM_LABELS[index];
  const rounded = Math.round(level * 1000) / 1000;
  return `${rounded}x`;
}

function updateRadarZoomButton() {
  const radarZoomBtn = document.getElementById('radarZoomBtn');
  if (!radarZoomBtn) return;
  const label = getRadarZoomLabel();
  radarZoomBtn.textContent = `Radar: ${label}`;
  radarZoomBtn.title = `Radar range preset: ${label}`;
}

function setRadarZoomLevel(level, { announce = true } = {}) {
  const normalized = normalizeRadarZoomLevel(level);
  if (normalized === radarZoomLevel) return false;
  radarZoomLevel = normalized;
  updateRadarZoomButton();
  if (announce) {
    showMessage(`Radar range: ${getRadarZoomLabel(radarZoomLevel)}`);
  }
  return true;
}

function cycleRadarZoomLevel(direction = 1) {
  let nearestIndex = 0;
  let nearestDelta = Math.abs(radarZoomLevel - RADAR_ZOOM_LEVELS[0]);
  for (let i = 1; i < RADAR_ZOOM_LEVELS.length; i++) {
    const delta = Math.abs(radarZoomLevel - RADAR_ZOOM_LEVELS[i]);
    if (delta < nearestDelta) {
      nearestDelta = delta;
      nearestIndex = i;
    }
  }
  const step = direction < 0 ? -1 : 1;
  const nextIndex = (nearestIndex + step + RADAR_ZOOM_LEVELS.length) % RADAR_ZOOM_LEVELS.length;
  setRadarZoomLevel(RADAR_ZOOM_LEVELS[nextIndex]);
}

function adjustRadarZoom(direction) {
  if (direction > 0) {
    setRadarZoomLevel(radarZoomLevel * RADAR_ZOOM_STEP);
  } else if (direction < 0) {
    setRadarZoomLevel(radarZoomLevel / RADAR_ZOOM_STEP);
  }
}

function callVoiceManager(method, ...args) {
  if (!voiceManager || typeof voiceManager[method] !== 'function') {
    return { called: false, value: undefined };
  }
  try {
    return { called: true, value: voiceManager[method](...args) };
  } catch (error) {
    console.error(`[Voice] ${method} failed:`, error);
    showMessage(`Voice error: ${error.message || 'operation failed'}`);
    return { called: true, value: undefined };
  }
}

// How far through the interval since the last shot the reload is, 0 to 1. bzo's
// reload is one interval shared by every slot, so this is a floor under all of
// the shot bars rather than one bar's own progress.
// The world's `_shotSpeed` as the firing flag leaves it: a shot's speed from a
// standing tank. A moving one adds its own velocity (`getShotFlight`).
function getShotSpeed(flag) {
  const base = Number.isFinite(gameConfig?.SHOT_SPEED) ? gameConfig.SHOT_SPEED : 100;
  return base * getShotEffects(flag).velocityFactor;
}

// GetShotLifetime (GameKeeper.cxx:401), as the server resolves it onto the
// projectile: the world's shot life scaled by the firing flag's own factor. A
// shock wave is the one shot the client has to know this for, because the size
// it is drawn at is how far through its life it is.
function getShotLifetimeSeconds(flag) {
  return getWorldReloadSeconds(gameConfig || {}) * getShotEffects(flag).lifeFactor;
}

// `ShotPath::reloadTime` for a shot of this flag, in ms -- how long the slot it
// fills is out of action. Not the same as the shot's life: `SW` and `GM` never
// call `setReloadTime` at all, so their slots come back on the world's own
// interval however briefly each shot lives.
function getSlotReloadMs(flag) {
  const worldReload = getWorldReloadSeconds(gameConfig || {});
  return getSlotReloadSeconds(worldReload, getShotEffects(flag).rateFactor) * 1000;
}

// How often a trigger that is simply *held* fires, in ms. Every slot held for
// one reload sustains exactly `maxShots` shots per reload, and that is the
// interval: the world's reload over its slot count, which is what
// `SHOT_RELOAD_TIME` carries and what an operator pins when they set
// `shotReloadTime`. Scaled by the firing flag's rate, so a Machine Gun's held
// trigger repeats as fast as its slots can take it.
//
// bzo's own rule, for a device upstream does not have. A tap is gated by
// `SHOT_TAP_SPACING_MS` instead, and neither gate is ever the reason a shot is
// refused on the wire -- the slots are.
function getHeldTriggerIntervalMs() {
  const configuredReload = Number(gameConfig?.SHOT_RELOAD_TIME);
  const base = Number.isFinite(configuredReload) && configuredReload > 0
    ? configuredReload
    : 1000;
  return base / getShotEffects(getMyShotFlag()).rateFactor;
}

// LocalPlayer::forceReload, which sets `jamTime`: the trigger is out of action
// for this long whatever the slots have left, and `getReloadTime` answers with
// it before it looks at a slot at all. What a theft costs the thief, and what
// keeps a Trigger Happy tank's shots from going off together.
function forceReload(seconds) {
  shotJamUntil = Math.max(shotJamUntil, sampleEpochClock() + (seconds * 1000));
}

function getVoiceAudioSettings() {
  return {
    echoCancellation: document.getElementById('voiceEchoCancellation')?.checked !== false,
    noiseSuppression: document.getElementById('voiceNoiseSuppression')?.checked !== false,
    autoGainControl: document.getElementById('voiceAutoGainControl')?.checked !== false,
  };
}

function getVoiceState() {
  if (voiceManager && typeof voiceManager.getState === 'function') {
    try {
      return { ...voiceManagerState, ...voiceManager.getState() };
    } catch (error) {
      console.error('[Voice] Could not read manager state:', error);
    }
  }
  return { ...voiceManagerState };
}

// The voice manager has always tracked its peers -- a Map of RTCPeerConnections,
// with handlers on connectionstatechange and iceconnectionstatechange -- and has
// always offered them through callbacks. Nothing listened, so a voice link that
// never came up, or quietly died, left no trace anywhere the player could see.
//
// These go through debugLog when the debug HUD is on, which puts them in the
// debug chat tab and the server log as well as the console. With it off the
// console still gets them: a peer coming and going is rare and worth having in a
// bug report, but not worth sending to the server unasked.
function logVoiceEvent(text) {
  if (debugEnabled) debugLog(text, 'Voice');
  else console.log(`[Voice] ${text}`);
}

// A peer in a log line, named where the roster has told us the name. Quoted for
// the same reason every other logged name is: the quotes are what say "this is a
// player", so a line naming two of them reads as two players rather than as a
// player and a stray word.
function describeVoicePeer(peerId) {
  const name = voicePeerDebug.get(peerId)?.name;
  return name ? `"${name}" (${peerId})` : `peer ${peerId}`;
}

function trackVoicePeer(peerId, changes) {
  const entry = voicePeerDebug.get(peerId) || { name: null, states: {}, audioReceived: false };
  Object.assign(entry, changes);
  voicePeerDebug.set(peerId, entry);
  return entry;
}

function handleVoicePeerChange({ peerId, state, connection } = {}) {
  if (!peerId || !state) return;
  const entry = trackVoicePeer(peerId, connection ? { connection } : {});
  Object.entries(state).forEach(([key, value]) => {
    if (entry.states[key] === value) return;
    entry.states[key] = value;
    logVoiceEvent(`${describeVoicePeer(peerId)} ${key}: ${value}`);
  });
}

function handleVoiceRosterChange(roster = []) {
  const present = new Set();
  roster.forEach((item) => {
    const peerId = String(item?.id ?? '');
    if (!peerId) return;
    present.add(peerId);
    const known = voicePeerDebug.has(peerId);
    trackVoicePeer(peerId, { name: item.name || null });
    if (!known) logVoiceEvent(`${describeVoicePeer(peerId)} joined the roster`);
  });
  Array.from(voicePeerDebug.keys()).forEach((peerId) => {
    if (present.has(peerId)) return;
    logVoiceEvent(`${describeVoicePeer(peerId)} left the roster`);
    voicePeerDebug.delete(peerId);
  });
}

// voice.js has fired this on every ontrack since the day peer tracking was
// added, but nothing ever listened -- so whether the browser ever tells the
// app a remote track exists at all has been invisible until now. Logged
// unconditionally, once per firing: unlike the polled fields above there is
// no "current value" to compare against, and a track that fires twice (a
// renegotiation replacing it) is exactly the kind of thing worth seeing each
// time, not collapsing into one line.
function handleVoiceRemoteTrack({ peerId, track } = {}) {
  if (!peerId) return;
  const kind = track?.kind || 'unknown';
  const trackState = track ? `${track.readyState}${track.muted ? ', muted' : ''}` : 'no track';
  logVoiceEvent(`${describeVoicePeer(peerId)} ontrack: ${kind} (${trackState})`);
}

// What this browser offered a peer, one line once gathering finishes: the
// candidate types, and through which server for a relayed one. `relay` here
// means sam handed out a relay address; whether a pair through it was chosen is
// `candidateType` in the debug HUD.
function ipv6Prefix64(address) {
  return `${String(address).replace(/^\[|\]$/g, '').split(':').slice(0, 4).join(':')}::/64`;
}

function handleVoiceLocalCandidate({ peerId, candidate } = {}) {
  if (!peerId) return;
  const entry = trackVoicePeer(peerId, {});
  entry.gathered ||= [];
  if (candidate) {
    const via = candidate.type === 'relay' && candidate.relayProtocol ? ` via ${candidate.relayProtocol}` : '';
    // Chrome hides a host address behind an mDNS name unless the page has
    // camera or mic permission, so a host candidate may have no family.
    const address = String(candidate.address || '');
    const family = address.endsWith('.local') ? ' mdns' : address.includes(':') ? '6' : '4';
    // The /64 an IPv6 candidate came from: whether it is the network the game's
    // own connection uses, which the server logs at connect.
    const prefix = family === '6' && candidate.type === 'host' ? ` ${ipv6Prefix64(address)}` : '';
    entry.gathered.push(`${candidate.type || '?'} ${candidate.protocol || '?'}${family}${prefix}${via}`);
    return;
  }
  const counts = new Map();
  entry.gathered.forEach((kind) => counts.set(kind, (counts.get(kind) || 0) + 1));
  const summary = Array.from(counts, ([kind, n]) => (n > 1 ? `${kind} x${n}` : kind)).join(', ');
  logVoiceEvent(`${describeVoicePeer(peerId)} candidates: ${summary || 'none'}`);
  entry.gathered = [];
}

// Each distinct STUN/TURN failure once per peer: Chrome repeats the same
// error for every local address, and a server that cannot be reached at all
// is one fact, not a dozen.
function handleVoiceIceCandidateError({ peerId, url, errorCode, errorText, address, port } = {}) {
  if (!peerId) return;
  const entry = trackVoicePeer(peerId, {});
  entry.iceErrors ||= new Set();
  const key = `${url} ${errorCode}`;
  if (entry.iceErrors.has(key)) return;
  entry.iceErrors.add(key);
  const from = address ? ` from ${address}${port ? `:${port}` : ''}` : '';
  logVoiceEvent(`${describeVoicePeer(peerId)} ICE error ${errorCode} ${errorText} ${url}${from}`);
}

// The one that actually answers "does real audio ever arrive": `muted` at
// ontrack time is expected and meaningless, but a transition away from it
// means the browser itself decided real media showed up on the wire.
function handleVoiceRemoteTrackMuteChange({ peerId, muted } = {}) {
  if (!peerId) return;
  logVoiceEvent(`${describeVoicePeer(peerId)} track ${muted ? 'muted' : 'unmuted'}`);
}

// A peer's mic-enabled flag says they could be heard, not that they are being
// heard right now -- this is voice.js's own read of their track's audio
// energy, so it tracks real transmission the way the mic glyph cannot.
// Mirrors voiceMicToggled's own write to the same playerState.
function handleVoiceSpeakingChange({ peerId, speaking } = {}) {
  // Ducking asks a narrower question than the indicator does: not "is this
  // player talking" but "is their voice reaching my ears", so a silenced
  // player still shows the indicator and still ducks nothing.
  setVoiceDuckingPeer(peerId, speaking === true && !isPlayerSilenced(peerId));
  const state = tanks.get(peerId)?.userData?.playerState;
  if (!state) return;
  state.voiceSpeaking = speaking === true;
  refreshScoreboards();
}

// Game sound steps back while somebody is talking (issue #119). Kept as the
// set of peers actually being heard rather than a counter, so a peer that
// disconnects mid-sentence -- voice.js reports them as stopped when it tears
// their graph down -- cannot leave the game ducked forever.
const voiceDuckingPeers = new Set();
let voiceDuckReleaseTimer = null;

function setVoiceDuckingPeer(peerId, audible) {
  if (peerId === null || peerId === undefined) return;
  const id = String(peerId);
  if (audible) voiceDuckingPeers.add(id); else voiceDuckingPeers.delete(id);
  applyVoiceDucking();
}

// Ducking engages at once and releases on a hold. Speaking is sampled every
// 200 ms, so releasing immediately would let the game swell back up in the
// gaps between words and duck again on the next one.
function applyVoiceDucking() {
  if (voiceDuckingPeers.size > 0) {
    if (voiceDuckReleaseTimer !== null) {
      clearTimeout(voiceDuckReleaseTimer);
      voiceDuckReleaseTimer = null;
    }
    renderManager.setVoiceDucking(true);
    return;
  }
  if (voiceDuckReleaseTimer !== null) return;
  voiceDuckReleaseTimer = setTimeout(() => {
    voiceDuckReleaseTimer = null;
    if (voiceDuckingPeers.size === 0) renderManager.setVoiceDucking(false);
  }, VOICE_DUCK_HOLD_MS);
}

const voiceListenerPosition = new THREE.Vector3();
const voiceSpeakerPosition = new THREE.Vector3();
const voiceBearing = new THREE.Vector3();

// Where each peer's voice is heard from (issue #119). The renderer owns the
// ears and voice.js owns the panners; the geometry between them is this, and
// it lives here because this is the half that knows where every tank is.
//
// Only Nearby is placed at the speaker's real distance. All and Team reach
// across the whole map, and a teammate calling for help from the far corner
// has to be as loud there as they are alongside you -- so those are placed on
// the bearing to the speaker at the panner's own reference distance, which
// gives the direction and leaves the level alone.
//
// A peer with no tank to stand on -- one who has not been added yet -- is put
// at the listener, which is unattenuated and unplaced rather than silent.
// Called directly rather than through callVoiceManager: this runs once a
// frame per peer, and that wrapper allocates a result object and puts every
// failure on screen. setPeerPosition answers false instead of throwing.
function updateVoicePlacement() {
  if (voicePeerDebug.size === 0) return;
  const place = voiceManager?.setPeerPosition;
  if (typeof place !== 'function') return;
  const listener = renderManager.getListenerWorldPosition(voiceListenerPosition);
  if (!listener) return;
  const usesDistance = voiceChannelUsesDistance(selectedVoiceChannel);
  voicePeerDebug.forEach((_entry, peerId) => {
    const tank = tanks.get(peerId);
    if (!tank) {
      place(peerId, listener);
      return;
    }
    const speaker = tank.getWorldPosition(voiceSpeakerPosition);
    if (usesDistance) {
      place(peerId, speaker);
      return;
    }
    const bearing = voiceBearing.subVectors(speaker, listener);
    const distance = bearing.length();
    if (distance < 1e-4) {
      place(peerId, listener);
      return;
    }
    place(peerId, bearing.multiplyScalar(VOICE_REF_DISTANCE / distance).add(listener));
  });
}

// getStats() is async and not pushed the way the state-change events are, so
// this runs as a side effect of each debug-HUD tick (getVoiceDebugState,
// called only while the panel is open) rather than its own timer: the next
// tick, 500ms later, is what actually shows a fresh answer. Only worth asking
// once a link is up -- there is no selected candidate pair before then.
//
// `packetsReceived`/`packetsSent` off the inbound/outbound-rtp reports are
// real RTP audio that has actually crossed the wire in each direction --
// unlike the `<audio>` element's own creation (fires the moment the peer
// connection exists, whether or not anything has ever been sent) or
// `ontrack` (fires once negotiation completes, before either side has
// necessarily sent a frame). Checking our own outbound alongside the
// inbound half matters because a player has no other way to see whether
// their own mic is actually reaching anyone -- webrtc-internals/about:webrtc
// says so too, but reading it back off a remote or headless client is not
// always something a player can copy out and hand to someone else. Read
// both from the same stats snapshot as the candidate type rather than a
// second getStats() call.
async function refreshVoicePeerStats(peerId, pc) {
  if (!pc || typeof pc.getStats !== 'function') return;
  try {
    const stats = await pc.getStats();
    let selected = null;
    let audioReceived = false;
    let audioSent = false;
    stats.forEach((report) => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        if (!selected || report.nominated) selected = report;
      } else if (report.type === 'inbound-rtp' && (report.kind || report.mediaType) === 'audio') {
        if (report.packetsReceived > 0) audioReceived = true;
      } else if (report.type === 'outbound-rtp' && (report.kind || report.mediaType) === 'audio') {
        if (report.packetsSent > 0) audioSent = true;
      }
    });
    const local = selected && stats.get(selected.localCandidateId);
    const entry = trackVoicePeer(peerId, {});
    // Logged only on an actual change, the same restraint
    // handleVoicePeerChange applies to connectionState/iceConnectionState --
    // this polls every 500ms while the debug HUD is open, and logging that
    // often would flood the server log with repeats of the same answer.
    [
      ['candidateType', local?.candidateType
        ? `${local.candidateType}${String(local.address || local.ip || '').includes(':') ? ` ${ipv6Prefix64(local.address || local.ip)}` : ''}`
        : null],
      ['audioReceived', audioReceived],
      ['audioSent', audioSent],
    ].forEach(([key, value]) => {
      if (entry[key] === value) return;
      entry[key] = value;
      logVoiceEvent(`${describeVoicePeer(peerId)} ${key}: ${value}`);
    });
  } catch {
    // A peer mid-teardown can throw here; the cached values just go stale
    // until the next successful poll.
  }
}

// One line per peer for the debug HUD: who, whether real audio has actually
// arrived from them, and a single state word. Upstream WebRTC exposes
// `connectionState` and `iceConnectionState` as two separate readouts of the
// same link, which almost always agree -- host/srflx/relay only exists once
// that link actually is 'connected', so showing the candidate type in place
// of the word "connected" says strictly more in less space rather than
// repeating a state already implied by having a type at all.
function getVoiceDebugState() {
  return {
    channel: getVoiceChannel(selectedVoiceChannel).label,
    transmitting: getVoiceState().transmitting === true,
    ducked: renderManager.isVoiceDucked(),
    peers: Array.from(voicePeerDebug.entries()).map(([peerId, entry]) => {
      const connectionState = entry.states.connectionState || 'new';
      const connected = connectionState === 'connected';
      if (connected && entry.connection) void refreshVoicePeerStats(peerId, entry.connection);
      // The one thing webrtc-internals/about:webrtc can show that getStats()
      // never will: whether the actual <audio> element bzo created for this
      // peer ever started playing at all. `audioReceived` only proves packets
      // reached the RTCRtpReceiver -- it says nothing about whether ontrack
      // ever fired or .play() ever ran, and copying this out of a remote or
      // headless client's devtools to hand to someone else is exactly the
      // friction this whole panel exists to avoid.
      //
      // `placed` is the element still running but handed over: the voice is
      // coming out of its panner, at the speaker's bearing, and the element is
      // only still there as the fallback for a browser that never proves the
      // graph. Which stage a peer is on is the manager's own answer, not the
      // element's volume -- a silenced peer reads zero on either stage.
      const audioElement = document.querySelector(`audio[data-voice-peer-id="${peerId}"]`);
      const placed = voiceManager?.getPeerPlacement?.(peerId) === 'panner';
      const playback = !audioElement
        ? 'no element'
        : audioElement.paused ? 'paused' : placed ? 'placed' : 'playing';
      if (entry.playback !== playback) {
        entry.playback = playback;
        logVoiceEvent(`${describeVoicePeer(peerId)} playback: ${playback}`);
      }
      return {
        label: entry.name || peerId,
        audio: entry.audioReceived === true,
        sending: entry.audioSent === true,
        playback,
        connected,
        state: connected ? (entry.candidateType || 'connected') : connectionState,
        // Read off the same playerState the scoreboard's mic glyph reads,
        // rather than the roster's own (unused) mic field, so debug and
        // scoreboard cannot disagree about the same player.
        mic: tanks.get(peerId)?.userData?.playerState?.voiceMicEnabled === true,
        speaking: tanks.get(peerId)?.userData?.playerState?.voiceSpeaking === true,
      };
    }),
  };
}

function getVolumeLevel(channelId) {
  return clampVolumeLevel(volumeLevels[channelId], DEFAULT_VOLUME_LEVEL);
}

// Each channel ends in a different place: the game level is the renderer's
// AudioListener master gain, and the two voice levels live in the voice manager
// -- one on the remote elements, one on the microphone gain node.
function sendVolumeLevelToSink(channelId, level) {
  if (channelId === 'game') {
    renderManager.setGameVolumeLevel(level);
    return;
  }
  if (channelId === 'voice') {
    callVoiceManager('setVoiceVolumeLevel', level);
    return;
  }
  if (channelId === 'microphone') callVoiceManager('setMicrophoneVolumeLevel', level);
}

function syncVolumeControl(channel) {
  const level = getVolumeLevel(channel.id);
  const slider = document.getElementById(channel.sliderId);
  if (slider) {
    slider.value = String(level);
    slider.setAttribute('aria-valuetext', formatVolumeLevel(level));
  }
  const value = document.getElementById(channel.valueId);
  if (value) value.textContent = formatVolumeLevel(level);
}

function setVolumeLevel(channelId, level) {
  const clamped = clampVolumeLevel(level, getVolumeLevel(channelId));
  volumeLevels[channelId] = clamped;
  const channel = VOLUME_CHANNELS.find((candidate) => candidate.id === channelId);
  if (channel) {
    writeVolumeLevel(localStorage, channel.storageKey, clamped);
    syncVolumeControl(channel);
  }
  sendVolumeLevelToSink(channelId, clamped);
  return clamped;
}

function setVoiceChannel(nextChannel) {
  const normalized = normalizeVoiceChannel(nextChannel);
  const changed = normalized !== selectedVoiceChannel;
  selectedVoiceChannel = normalized;
  localStorage.setItem('voiceChannel', normalized);
  const select = document.getElementById('voiceChannelSelect');
  if (select && select.value !== normalized) select.value = normalized;
  const hint = document.getElementById('voiceChannelDescription');
  if (hint) hint.textContent = getVoiceChannel(normalized).hint;
  if (changed) {
    callVoiceManager('setChannel', normalized);
    logVoiceEvent(`channel: ${getVoiceChannel(normalized).label}`);
  }
  updateVoiceHud();
  return normalized;
}

function bindVolumeControls() {
  const overlay = document.getElementById('audioOverlay');
  VOLUME_CHANNELS.forEach((channel) => {
    syncVolumeControl(channel);
    // Pointer and touch drags arrive here; keyboard and XR arrive as menuadjust
    // below, because the shared dialog model owns Left/Right on a focused row.
    document.getElementById(channel.sliderId)
      ?.addEventListener('input', (event) => setVolumeLevel(channel.id, event.target.value));
  });
  overlay?.addEventListener('menuadjust', (event) => {
    const row = event.target.closest?.('[data-menu-row]');
    const channel = VOLUME_CHANNELS.find((candidate) => candidate.sliderId === row?.id);
    if (!channel) return;
    setVolumeLevel(channel.id, stepVolumeLevel(getVolumeLevel(channel.id), event.detail?.direction));
    event.preventDefault();
  });
  renderManager.setGameVolumeLevel(getVolumeLevel('game'));
}

function updateVoiceInputDevices(devices = []) {
  const input = document.getElementById('voiceInputDevice');
  if (!input) return;

  const previousValue = selectedVoiceInputDeviceId || input.value || '';
  input.replaceChildren();

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'Default microphone';
  input.appendChild(defaultOption);

  if (Array.isArray(devices)) {
    devices.forEach((device) => {
      if (!device || typeof device.deviceId !== 'string') return;
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || 'Microphone';
      input.appendChild(option);
    });
  }

  selectedVoiceInputDeviceId = previousValue;
  input.value = previousValue;
  if (input.value !== previousValue) {
    selectedVoiceInputDeviceId = '';
    input.value = '';
  }
}

function updateVoiceHud(nextState = null) {
  const state = nextState && typeof nextState === 'object'
    ? { ...voiceManagerState, ...nextState }
    : getVoiceState();
  voiceManagerState = state;

  const micButton = document.getElementById('micBtn');
  const permissionStatus = document.getElementById('voicePermissionStatus');
  const permissionButton = document.getElementById('voiceRequestPermissionBtn');
  const microphoneButton = document.getElementById('voiceMicToggle');
  const inputDevice = document.getElementById('voiceInputDevice');
  const channelSelect = document.getElementById('voiceChannelSelect');
  const microphoneSlider = document.getElementById('microphoneVolumeSlider');

  const channelLabel = getVoiceChannel(selectedVoiceChannel).label;
  const team = normalizePlayerTeam(state.team || playerTeam);
  const transmitting = Boolean(state.transmitting);
  const permission = state.microphonePermission || 'prompt';
  let status = 'Microphone off';
  if (isObserverTeam(team)) {
    status = 'Receive only';
  } else if (transmitting) {
    status = 'Microphone on';
  } else if (permission === 'denied') {
    status = 'Permission denied';
  } else if (permission === 'unavailable') {
    status = 'Microphone unavailable';
  } else if (state.lastError && state.lastError.message) {
    status = 'Microphone unavailable';
  }

  // What the hover says is what the click would do, then the channel it would
  // do it on: `Disable Mic - Nearby`. Where the click cannot do anything --
  // an observer, a blocked or missing microphone -- it says the reason instead
  // of promising a toggle that will not happen.
  const micActionLabel = isObserverTeam(team) ? 'Receive only'
    : permission === 'denied' ? 'Mic blocked'
      : permission === 'unavailable' ? 'Mic unavailable'
        : transmitting ? 'Disable Mic' : 'Enable Mic';

  // The whole of the on-screen voice display: a red or green border in the HUD
  // row. The channel is in the hover text rather than on the button, that being
  // the one thing a name can say and a colour cannot.
  if (micButton) {
    micButton.classList.toggle('micBtn--on', transmitting);
    micButton.classList.toggle('micBtn--off', !transmitting);
    micButton.setAttribute('aria-pressed', transmitting ? 'true' : 'false');
    micButton.title = `${micActionLabel} - ${channelLabel}`;
    micButton.setAttribute('aria-label', `${channelLabel} voice channel, ${status.toLowerCase()}`);
  }
  if (channelSelect) {
    channelSelect.value = selectedVoiceChannel;
  }
  const channelHint = document.getElementById('voiceChannelDescription');
  if (channelHint) channelHint.textContent = getVoiceChannel(selectedVoiceChannel).hint;
  if (permissionButton) {
    permissionButton.textContent = permission === 'granted' ? 'Microphone permission granted' : 'Enable microphone';
  }
  if (microphoneButton) {
    const permissionGranted = permission === 'granted';
    microphoneButton.disabled = !permissionGranted && !state.hasLocalStream;
    microphoneButton.textContent = transmitting ? 'Microphone on' : 'Microphone off';
    microphoneButton.setAttribute('aria-pressed', transmitting ? 'true' : 'false');
  }
  if (inputDevice) inputDevice.disabled = false;
  if (microphoneSlider) microphoneSlider.disabled = false;
  if (permissionStatus) {
    if (permission === 'granted') {
      permissionStatus.textContent = transmitting ? `Microphone is transmitting on the ${channelLabel} channel.` : 'Microphone permission granted; transmission is off.';
    } else if (permission === 'denied') {
      permissionStatus.textContent = 'Microphone permission was denied by the browser.';
    } else if (permission === 'unavailable') {
      permissionStatus.textContent = 'Microphone capture is unavailable in this browser or context.';
    } else {
      permissionStatus.textContent = 'Microphone permission has not been requested.';
    }
  }
}

function handleVoiceError(error) {
  if (!error) return;
  const message = error.message || 'Voice operation failed.';
  updateVoiceHud(getVoiceState());
  showMessage(message);
  // reportError (voice.js) never logs itself, only sets state and shows this
  // one on-screen toast -- easy to miss mid-session and invisible to
  // server.log. Every voice error is worth having in the same trail the
  // connection-state and stats transitions already land in.
  logVoiceEvent(`error${error.code ? ` (${error.code})` : ''}: ${message}`);
}

function initializeVoiceManager() {
  if (voiceManager) return voiceManager;
  if (NO_VOICE) return null;

  voiceManager = createVoiceManager({
    sendToServer,
    localPlayerId: myPlayerId,
    team: playerTeam,
    channel: selectedVoiceChannel,
    inputDeviceId: selectedVoiceInputDeviceId,
    rtcConfig: voiceRtcConfig,
    audioConstraints: getVoiceAudioSettings(),
    voiceVolumeLevel: getVolumeLevel('voice'),
    microphoneVolumeLevel: getVolumeLevel('microphone'),
    // The renderer's context is already open, and a phone counts contexts.
    getAudioContext: () => renderManager.getAudioContext(),
    startMuted: true,
    playRemoteAudio: !VOICE_SILENT,
    maxPeers: VOICE_MAX_PEERS,
    sendHostCandidates: VOICE_MODE !== 'nohost',
    ipFamily: VOICE_IP_FAMILY,
    dataOnly: VOICE_MODE === 'data',
    callbacks: {
      onStateChange: updateVoiceHud,
      onError: handleVoiceError,
      onInputDevices: updateVoiceInputDevices,
      onPeerChange: handleVoicePeerChange,
      onRosterChange: handleVoiceRosterChange,
      onRemoteTrack: handleVoiceRemoteTrack,
      onLocalCandidate: handleVoiceLocalCandidate,
      onIceCandidateError: handleVoiceIceCandidateError,
      onRemoteTrackMuteChange: handleVoiceRemoteTrackMuteChange,
      onSpeakingChange: handleVoiceSpeakingChange,
    },
  });
  if (VOICE_MIC) {
    const result = callVoiceManager('requestMicrophone', { enable: true });
    if (result.value && typeof result.value.catch === 'function') result.value.catch(handleVoiceError);
  }
  updateVoiceHud();
  return voiceManager;
}

function updateVoiceIdentity() {
  if (!voiceManager) return;
  callVoiceManager('updateLocalIdentity', {
    localPlayerId: myPlayerId,
    team: playerTeam,
  });
  updateVoiceHud();
}

async function resetVoiceManagerForReconnect() {
  if (!voiceManager || typeof voiceManager.reset !== 'function') return;
  try {
    await voiceManager.reset();
  } catch (error) {
    console.error('[Voice] Could not reset voice state before reconnect:', error);
  }
  updateVoiceHud();
}

function requestVoicePermission() {
  const result = callVoiceManager('requestMicrophone', { enable: false });
  if (result.value && typeof result.value.catch === 'function') {
    result.value.catch(handleVoiceError);
  }
}

function toggleVoiceMicrophone() {
  const result = callVoiceManager('toggleMicrophone');
  if (result.value && typeof result.value.catch === 'function') {
    result.value.catch(handleVoiceError);
  }
}

function bindAudioControls() {
  bindVolumeControls();

  const destinationSelector = document.getElementById('entryDestinationSelector');
  if (destinationSelector) {
    destinationSelector.addEventListener('click', (event) => selectRelativeDestination(getMenuClickDirection(event)));
    destinationSelector.addEventListener('menuadjust', (event) => {
      const direction = Number(event.detail?.direction) < 0 ? -1 : 1;
      selectRelativeDestination(direction);
      event.preventDefault();
    });
  }
  syncDestinationSelector();

  const teamSelector = document.getElementById('entryTeamSelector');
  if (teamSelector) {
    teamSelector.addEventListener('click', (event) => selectRelativePlayerTeam(getMenuClickDirection(event)));
    teamSelector.addEventListener('menuadjust', (event) => {
      const direction = Number(event.detail?.direction) < 0 ? -1 : 1;
      selectRelativePlayerTeam(direction);
      event.preventDefault();
    });
  }
  syncPlayerTeamSelector();


  const loginRow = document.getElementById('entryLoginRow');
  if (loginRow) {
    loginRow.addEventListener('click', () => startGlobalLogin());
    // An action rather than a choice, so left and right have nothing to walk
    // through -- but the row still has to answer the gamepad and controller
    // press that a menu row is expected to answer.
    loginRow.addEventListener('menuactivate', (event) => {
      startGlobalLogin();
      event.preventDefault();
    });
  }
  applyLoginUi();

  const channelSelect = document.getElementById('voiceChannelSelect');
  if (channelSelect) {
    channelSelect.value = selectedVoiceChannel;
    channelSelect.addEventListener('change', () => setVoiceChannel(channelSelect.value));
  }

  const inputDevice = document.getElementById('voiceInputDevice');
  if (inputDevice) {
    selectedVoiceInputDeviceId = inputDevice.value || '';
    inputDevice.addEventListener('change', () => {
      selectedVoiceInputDeviceId = inputDevice.value || '';
      const result = callVoiceManager('setInputDevice', selectedVoiceInputDeviceId);
      if (result.value && typeof result.value.catch === 'function') {
        result.value.catch(handleVoiceError);
      }
    });
  }

  const processingInputs = [
    'voiceEchoCancellation',
    'voiceNoiseSuppression',
    'voiceAutoGainControl',
  ]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  processingInputs.forEach((input) => {
    input.addEventListener('change', () => {
      const result = callVoiceManager('setAudioConstraints', getVoiceAudioSettings());
      if (result.value && typeof result.value.catch === 'function') {
        result.value.catch(handleVoiceError);
      }
    });
  });
}

function waitForAnimationFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function setLoadingOverlayState({ visible = true, progress = 0, status = '', detail = '' } = {}) {
  const overlay = document.getElementById('loadingOverlay');
  const statusEl = document.getElementById('loadingStatus');
  const detailEl = document.getElementById('loadingDetail');
  const fillEl = document.getElementById('loadingBarFill');
  if (overlay) {
    overlay.style.display = visible ? 'flex' : 'none';
  }
  if (statusEl && typeof status === 'string') {
    statusEl.textContent = status;
  }
  if (detailEl) {
    detailEl.textContent = detail || '';
  }
  if (fillEl) {
    const clamped = Math.max(0, Math.min(1, progress));
    fillEl.style.width = `${Math.round(clamped * 100)}%`;
  }
}

function hideLoadingOverlay() {
  setLoadingOverlayState({ visible: false });
}

// Map Viewer (issue #68) is Observer on the wire -- same team limit, same
// team chat, same white scoreboard colour -- distinguished only by `viewMap`,
// which the server reads purely for its own bookkeeping since the client
// already rendered its choice before Join was ever pressed. One function so
// every `joinGame` send -- the flat dialog's OK and the XR menu's "Apply and
// Join" alike -- translates the client-only `mapviewer` sentinel the same
// way; a second copy of this ternary is how the XR path once sent it to the
// server raw, which read as an unrecognized team and fell back to Rogue.
// Whether this page is pointed at a proxied bzfs rather than this server's own
// game. Read off the URL rather than waiting for `init`, because the entry
// dialog is dressed before the first message arrives.
function isProxiedPage() {
  const params = new URLSearchParams(window.location.search);
  return params.get('proxy') !== null || params.get('replay') !== null;
}

// Upstream has one tank model and no way to choose another, and the bzfs
// protocol carries no field for one -- so on a proxied connection the choice
// reaches nobody: not the target, not the native clients, not even another bzo
// browser watching the same match, all of which draw every tank with the
// default. A control whose setting only the person touching it can see is one
// that promises something it cannot deliver, so it goes away rather than
// greys, the way the entry dialog already drops Map Viewer where there are no
// maps to view. The XR panel greys its own row instead, which is that panel's
// idiom (`mapViewXR`). The model is forced back to the default without saving
// it, so a player's real choice is still theirs in this server's own game.
// Whether the staged destination is somewhere this server only relays to.
function stagedDestinationIsRemote() {
  return selectedDestination !== DESTINATION_LOCAL;
}

// The motto a proxied or watched target will actually be told, which is not
// the player's: the field is the attribution and nothing else, because it is
// one of the few ways the connection announces itself (`proxyMotto`). Shown
// rather than hidden, and read-only rather than editable, so the box says
// what the other end will see instead of taking a value it would discard.
function syncMottoForDestination() {
  const input = document.getElementById('entryMottoInput');
  if (!input) return;
  const remote = stagedDestinationIsRemote();
  input.disabled = remote;
  input.value = remote ? `via ${window.location.origin}` : myPlayerMotto;
  input.title = remote
    ? 'A proxied connection tells the target which bzo it came through, and'
      + ' nothing else. Your own motto is used on this server.'
    : '';
}

function syncTankSelectorForDestination() {
  const selector = document.getElementById('tankSelector');
  const proxied = stagedDestinationIsRemote();
  if (selector) selector.style.display = proxied ? 'none' : '';
  // Follows the destination rather than the page, the way the team row does.
  // Staging this server from a proxied page is about to go somewhere the
  // choice means something again, so it comes back -- and comes back as the
  // player's own, because forcing the default never wrote over what they
  // saved. Nothing here is committed until OK either way.
  const wanted = proxied
    ? DEFAULT_TANK_MODEL_ID
    : canonicalTankModelId(localStorage.getItem('tankModelId') || DEFAULT_TANK_MODEL_ID);
  if (wanted !== selectedTankModelId) setSelectedTankModel(wanted);
}

// The team the live connection entered its target on, as the target itself
// reported it. Null off a proxy, where a team is this server's to change on the
// open socket like any other setting.
let proxyEnteredTeam = null;

// Changing team on a proxied connection is opening a different connection.
// bzfs fixes the team when it answers `MsgEnter` and the protocol carries no
// message for changing it, so there is nothing to send -- the choice goes on
// the page's own URL and the reload is what applies it, the same way `?proxy=`
// and `/login` already work (`docs/proxy.md`). Returns true when it has taken
// over, and the caller sends nothing.
function proxyTeamChangeNavigated(team) {
  if (proxyEnteredTeam === null || team === proxyEnteredTeam) return false;
  const params = new URLSearchParams(window.location.search);
  if (!params.get('proxy') && !params.get('watch')) return false;
  params.set('team', team);
  window.location.search = params.toString();
  return true;
}

function getJoinTeamFields() {
  const team = getSelectedPlayerTeam();
  const isMapViewer = team === PLAYER_TEAM.MAP_VIEWER;
  return {
    team: isMapViewer ? PLAYER_TEAM.OBSERVER : team,
    viewMap: isMapViewer ? selectedViewMapFile : undefined,
  };
}

function setPendingJoinRequest(name) {
  pendingJoinRequest = {
    name,
    isMobile,
    tankModel: selectedTankModelId,
    motto: myPlayerMotto,
  };
}

function maybeSendPendingJoinRequest() {
  if (!renderReadyForJoin || gameplayJoinConfirmed || !pendingJoinRequest) return;
  if (proxyTeamChangeNavigated(getJoinTeamFields().team)) return;
  sendToServer({
    type: 'joinGame',
    name: pendingJoinRequest.name,
    isMobile: pendingJoinRequest.isMobile,
    xr: isXREnabled(),
    tankModel: pendingJoinRequest.tankModel,
    motto: pendingJoinRequest.motto,
    bot: IS_BOT_CLIENT,
    page: PAGE_TOKEN,
    ...getJoinTeamFields(),
  });
}

// Keyed by content hash, so a Map Viewer choosing the live match's own map,
// or a reconnect within the same tab, never re-fetches a world it already
// holds -- on top of the browser's own HTTP cache, which is what makes a
// fresh tab's reconnect free (server.js serves each world at an
// `immutable`, hash-named URL; see `MAP_REGISTRY`).
const worldFileCache = new Map();

// Every world URL a client is ever handed -- the live match's, a Map
// Viewer's, a freshly imported remote server's -- is one `server.js` itself
// built from a content hash (`registerMapFile`'s `/maps/<12 hex>.json`),
// never an arbitrary string, however the caller found the entry that named
// it (`availableViewMaps`/`viewableMapEntries`, both server-sent). Checked
// here rather than trusted implicitly: `worldRef` arrives over the same
// `JSON.parse(event.data)` every other server message does, so nothing
// upstream of this function actually proves its shape, and CodeQL's
// js/request-forgery query is right that an unchecked `fetch(worldRef.url)`
// is one bug away from following whatever a compromised or spoofed
// connection put there instead.
const WORLD_FILE_URL_RE = /^\/maps\/[0-9a-f]{12}\.json$/;

async function loadWorldFile(worldRef) {
  if (!worldRef || !worldRef.url) return null;
  if (worldRef.hash && worldFileCache.has(worldRef.hash)) {
    return worldFileCache.get(worldRef.hash);
  }
  // A listed map whose world the server has not written: asked for first,
  // the same request a remote server's map makes, and fetched by the entry
  // that comes back -- a map parsed again may have hashed differently.
  if (worldRef.ready === false && worldRef.file) {
    const prepared = await prepareWorldFile(worldRef.file);
    return prepared && prepared.ready !== false ? loadWorldFile(prepared) : null;
  }
  if (!WORLD_FILE_URL_RE.test(worldRef.url)) {
    console.error('Refusing to fetch a world file with an unexpected URL shape:', worldRef.url);
    return null;
  }
  try {
    const response = await fetch(worldRef.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const world = await response.json();
    if (worldRef.hash) worldFileCache.set(worldRef.hash, world);
    return world;
  } catch (error) {
    console.error('Failed to load world file', worldRef.url, error);
    return null;
  }
}

// Asks the server to write one of its own maps' worlds, resolving to that
// map's fresh `viewableMaps` entry or null. One request per file at a time.
const worldFilePreparations = new Map();
function prepareWorldFile(file) {
  const pending = worldFilePreparations.get(file);
  if (pending) return pending.promise;
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  worldFilePreparations.set(file, { promise, resolve });
  sendToServer({ type: 'importMapForView', file });
  return promise;
}

function worldFilePrepared(message) {
  const waiting = worldFilePreparations.get(message.file);
  if (!waiting) return;
  worldFilePreparations.delete(message.file);
  const maps = Array.isArray(message.viewableMaps) ? message.viewableMaps : null;
  if (maps) {
    availableViewMaps = maps;
    viewableMapEntries = maps;
  }
  waiting.resolve(message.success && maps ? maps.find((entry) => entry.file === message.file) || null : null);
}

// GAME_CONFIG's own default (defaultBZDB.cxx's `worldSize`, doubled the same
// way the server doubles a map's own `world size` line -- see server.js's
// `DEFAULT_MAP_SIZE`), used only in the brief window before any world has
// applied at all.
const DEFAULT_MAP_SIZE = 800;

// The map size currently built into the scene -- the live match's, or a Map
// Viewer preview's (issue #68) -- read from the world file the same way
// obstacles and teleporters are. `init.config` deliberately carries no
// MAP_SIZE of its own to ask instead: this is the one place map size comes
// from, live match or preview alike.
let currentWorldMapSize = null;
// `noWalls` -- read the same way and for the same reason as `currentWorldMapSize`.
let currentWorldNoWalls = false;
let currentWorldWaterHeight = 0;

// Whichever world is actually on screen right now, live match or Map Viewer
// preview alike -- set unconditionally at the bottom of `applyWorldData`, so
// `announceWorldMessages` always has the right one to read from regardless
// of which caller just ran it.
let currentWorldData = null;

// A map's own greeting: `-srvmsg` lines and the dropped-unsupported-feature
// tally, both computed once server-side (parseBZWMap) and carried in this
// map's own MAP_REGISTRY entry rather than pushed by the server on join --
// see AGENTS.md's "Intentional deviations from BZFlag" for why. Reusing
// `handleServerMessage` for the display keeps chat formatting, sound and
// roster handling identical to a message that actually arrived over the
// wire; only the trigger differs. Callers decide *when* this fires --
// `applyWorldData` itself never calls this, since it also runs for a Map
// Viewer preview nobody has committed to yet, and a preview must stay silent
// or cycling through choices would spam chat with every map's own lines,
// none of them clearly attributed to what the player is actually looking at.
function announceWorldMessages(world) {
  const lines = Array.isArray(world?.messages) ? world.messages : [];
  for (const text of lines) {
    handleServerMessage({ type: 'message', src: -1, dst: myPlayerId, msgType: 'server', text, ts: Date.now() });
  }
}

// Obstacles, teleporters, clouds and world size -- everything a fetched world
// file carries. Whatever else `init` sends (roster, scores, config) is live
// match state and does not come from here.
function applyWorldData(world) {
  currentWorldData = world;
  // The world's own scene switches and track fade, before anything below
  // builds the scenery they switch.
  const sceneConfig = configForWorld(world) || {};
  renderManager.setSceneSwitches(sceneConfig);
  renderManager.setMirror(sceneConfig.MIRROR ?? null);
  setTrackFadeTime(sceneConfig.TRACK_FADE);
  if (world && world.obstacles) {
    OBSTACLES = world.obstacles;
  } else {
    OBSTACLES = [];
  }
  // `OBSTACLES` includes `type === 'mesh'` entries now (the collision pair
  // itself skips them explicitly -- see collision.mjs), but `setObstacles`'s
  // own box/pyramid/teleporter/base dispatch has no case for one and would
  // build a NaN-filled box from its missing w/d/h/rotation, corrupting the
  // shared fragment buffer it merges into. `setMeshes` is a mesh's own render
  // path instead, so each half of the split list gets only the shapes it
  // knows how to draw.
  renderManager.setBoxHeight(sceneConfig.BOX_HEIGHT);
  renderManager.setObstacles(OBSTACLES.filter((obs) => obs.type !== 'mesh'));
  // `drawnByInstance` marks a mesh whose geometry a batch below already
  // draws (#153). It stays in `OBSTACLES` because collision reads it; it
  // just must not also be drawn one copy at a time.
  renderManager.setMeshes(
    OBSTACLES.filter((obs) => obs.type === 'mesh' && !obs.drawnByInstance),
  );
  // Definitions a map places many times and nothing collides with, carried as
  // the template plus a transform apiece (#153). Absent from a world an older
  // server sent, and from a map that places nothing that way, in which case
  // this does nothing and every such definition arrived expanded into
  // `OBSTACLES` as before.
  renderManager.setMeshInstances(
    world && world.meshTemplates, world && world.meshInstances,
  );

  if (world && world.teleporterGraph && typeof world.teleporterGraph === 'object') {
    TELEPORTER_GRAPH = world.teleporterGraph;
  } else {
    TELEPORTER_GRAPH = { teleporters: [], links: [] };
  }
  rebuildTeleporterRuntimeState();
  debugLog(`world.teleporters count=${TELEPORTER_GRAPH.teleporters.length} links=${TELEPORTER_GRAPH.links.length}`);

  if (world && world.clouds) {
    renderManager.createClouds(world.clouds, world.cloudBase);
  } else {
    renderManager.clearClouds();
  }

  // Ground, boundary walls and mountains all have to match whichever map is
  // actually on screen -- the live match's, or a Map Viewer preview's. The
  // fallback only ever applies to a world that failed to fetch.
  currentWorldMapSize = Number.isFinite(world?.mapSize) ? world.mapSize : DEFAULT_MAP_SIZE;
  currentWorldNoWalls = !!world?.noWalls;
  refreshCollisionColliders();
  // Kept because a proxied connection has to decide its own water death, and
  // upstream reads exactly this one number for it (`World::getWaterLevel`,
  // tested against the tank's own z at `playing.cxx:4196`). Absent or zero is
  // a world with no water, which upstream spells as a level that is not
  // greater than zero.
  currentWorldWaterHeight = Number.isFinite(world?.waterLevel?.height)
    ? world.waterLevel.height
    : 0;
  renderManager.buildGround(currentWorldMapSize, world?.groundMaterial || null);
  renderManager.setGroundGridEnabled(showDebugGeometry, currentWorldMapSize);
  renderManager.createMapBoundaries(currentWorldMapSize, currentWorldNoWalls, currentWallHeight());
  renderManager.createMountains(currentWorldMapSize);
  renderManager.buildCloudLayer(currentWorldMapSize);
  renderManager.buildWater(currentWorldMapSize, world?.waterLevel || null);
  renderManager.buildWeather(currentWorldMapSize, world?.weather || null, OBSTACLES);
  applyWorldGameplay(world);
  confineViewerToWorld();
}

// How the world now on screen drives and shoots. A Map Viewer preview is the
// only place the two can differ -- upstream has no way to look at a map it is
// not playing, so a real bzflag client's BZDB is always its own server's --
// and a preview that showed a `_tankSpeed 40` map at bzo's own 25 would be
// showing how the map is *not* played.
//
// Only what that map actually states is laid over; a variable it says nothing
// about keeps the live match's value, which is how upstream reads a BZDB
// variable a world leaves alone. Jumping and ricochet are not in here (bzo
// forces both on) and neither are the flag variables, since a preview
// suppresses every flag along with every other player's tank.
function applyWorldGameplay(world) {
  if (!liveGameConfig) return;
  gameConfig = configForWorld(world);
  configureFlagEffects(gameConfig);
  configureTankDimensions(gameConfig);
  renderManager._applyFogConfig(gameConfig);
}

// Where this tank's shots leave from: its model's own muzzle, moved as the
// world's `_muzzleFront` and `_muzzleHeight` move it, or the world's default
// where there is no model.
function myMuzzle() {
  const data = myTank?.userData;
  // `Player::getMuzzle` (Player.cxx:224): the barrel's reach scales with the
  // tank's length, so Obesity, Tiny and Thief move it and Narrow does not.
  const reach = getMyTankScale().length;
  return {
    forward: (Number.isFinite(data?.muzzleForward)
      ? data.muzzleForward * (TANK.muzzleForward / DEFAULT_MUZZLE_FORWARD)
      : TANK.muzzleForward) * reach,
    height: Number.isFinite(data?.muzzleHeight)
      ? data.muzzleHeight * (TANK.muzzleHeight / DEFAULT_MUZZLE_HEIGHT)
      : TANK.muzzleHeight,
  };
}

// `_wallHeight`: the world's own, where it states one, before any game config
// has arrived to carry it.
function currentWallHeight() {
  const height = (configForWorld(currentWorldData) || gameConfig)?.WALL_HEIGHT;
  return Number.isFinite(height) && height >= 0 ? height : WORLD_WALL_HEIGHT;
}

// How far inside the border wall a viewer brought back into bounds is put --
// a couple of tank lengths, so the camera is plainly inside the world rather
// than embedded in the wall it just came through.
const WORLD_REENTRY_MARGIN = 10;

// A Map Viewer or an observer keeps whatever position it already had when the
// world underneath it changes -- issue #68 lets the map change without
// rejoining, and a `?viewmap=` link can arrive carrying a `pos=` copied from
// an entirely different map. A world smaller than the last one then leaves
// that position outside its own border wall, looking in at the map from the
// mountains, which is what `spintest.bzw` does to anyone arriving from a
// full-sized map.
//
// Only a position genuinely outside the new bounds is touched. An ordinary
// join is always inside them -- the server's spawn is authoritative and is
// chosen against this same world -- so this can never argue with it.
function confineViewerToWorld() {
  if (viewerPlacedByLink && roamView === ROAM_VIEW.FREE) return;
  const half = (Number.isFinite(currentWorldMapSize) ? currentWorldMapSize : DEFAULT_MAP_SIZE) / 2;
  const limit = Math.max(0, half - WORLD_REENTRY_MARGIN);
  const confine = (value) => Math.max(-limit, Math.min(limit, value));
  const outside = (value) => Math.abs(value) > limit;

  // `myX`/`myY` rather than the tank mesh, because this runs at points in a
  // join where the mesh has not been picked up into `myTank` yet -- the pair
  // is what the heartbeat, the radar and the tank's own transform all read
  // from anyway, so moving it moves everything that follows.
  if (outside(myX) || outside(myY)) {
    myX = confine(myX);
    myY = confine(myY);
    if (myTank) myTank.position.set(myX, myY, myZ);
  }
  if (roamCamera && (outside(roamCamera.x) || outside(roamCamera.y))) {
    roamCamera.x = confine(roamCamera.x);
    roamCamera.y = confine(roamCamera.y);
  }
}

async function prepareInitialRender(message, sequenceId) {
  const localModelPath = getTankModelPathById(selectedTankModelId);
  const playerModelPaths = (message.players || []).map((player) => getTankModelPathById(getTankModelIdFromPlayer(player)));
  const modelPaths = Array.from(new Set([localModelPath, ...playerModelPaths].filter(Boolean)));
  const texturePaths = [
    '/textures/std_ground.png',
    '/textures/wall.png',
    '/textures/boxwall.png',
    '/textures/roof.png',
    '/textures/pyrwall.png',
    CAMO_SOURCE_TEXTURE,
    '/textures/green_bolt.png',
    '/textures/shot_tail.png',
    '/textures/explode1.png',
    '/textures/explode2.png',
    '/textures/treads.png',
    '/textures/mountain1.png',
    '/textures/mountain2.png',
    '/textures/mountain3.png',
    '/textures/mountain4.png',
    '/textures/mountain5.png',
    '/textures/blend_flash.png',
    '/textures/dusty_flare.png',
    '/textures/jumpjets.png',
    '/textures/flag.png',
  ];
  const audioPaths = getSoundPaths();

  setLoadingOverlayState({
    visible: true,
    progress: 0.05,
    status: 'Preparing battlefield...',
    detail: 'Building world geometry',
  });

  await waitForAnimationFrame();
  if (sequenceId !== activeInitSequence) return false;

  setLoadingOverlayState({
    visible: true,
    progress: 0.3,
    status: 'Placing obstacles...',
    detail: 'Synchronizing world objects',
  });

  // `init` carries only a { hash, url } reference (see `MAP_REGISTRY` in
  // server.js) so a client that already has this world -- an `immutable`
  // response -- skips the fetch entirely. `loadWorldFile`/`applyWorldData`
  // are also what a Map Viewer client (issue #68) calls a second time for
  // the map it chose, against this same world-build code.
  const world = message.world ? await loadWorldFile(message.world) : null;
  if (sequenceId !== activeInitSequence) return false;
  // Kept so a Map Viewer preview or session (issue #68) can hand the live
  // world back on the way out without a re-fetch.
  liveWorldData = world;
  // `?viewmap=` (issue #68) stages its preview synchronously, before this
  // `await` above ever yields, so a preview already under way by the time
  // this resolves means the live world lost the race and stays un-applied --
  // otherwise it would flash onto the screen the moment its own fetch
  // finishes, undoing the direct link.
  if (!isPreviewingAltWorld()) applyWorldData(world);

  // The sun and the moon are the sky and the shadow direction, not dynamic
  // lighting, so they are here whatever that setting says.
  worldTime = message.worldTime || 0;
  updateSkyClock(0);

  setLoadingOverlayState({
    visible: true,
    progress: 0.55,
    status: 'Loading vehicle systems...',
    detail: 'Preparing tank models, textures, and audio',
  });

  try {
    await Promise.all([
      ...modelPaths.map((path) => renderManager.whenTankModelReady(path)),
      ...texturePaths.map((path) => renderManager.preloadImage(path).catch(() => null)),
      renderManager.preloadGameplayAudio(),
    ]);
  } catch (error) {
    console.warn('Render asset preload failed:', error, audioPaths);
  }
  if (sequenceId !== activeInitSequence) return false;

  setLoadingOverlayState({
    visible: true,
    progress: 0.82,
    status: 'Assembling tanks...',
    detail: 'Creating player vehicles',
  });

  applyRosterSnapshot(message.players);
  myTank = tanks.get(myPlayerId);
  refreshScoreboards();
  await waitForAnimationFrame();
  if (sequenceId !== activeInitSequence) return false;

  renderReadyForJoin = true;
  setLoadingOverlayState({
    visible: true,
    progress: 1,
    status: pendingJoinRequest ? 'Entering battle...' : 'Render ready',
    detail: pendingJoinRequest ? 'Joining game' : 'Waiting for player name',
  });
  maybeSendPendingJoinRequest();
  // Ready to draw everyone, so ask who everyone is. Anything the snapshot and
  // its replay missed -- a message that raced the socket, a join that landed in
  // a gap -- is settled here, and it costs one round trip per map entry. It
  // goes after the join request so the answer already counts this player in.
  sendToServer({ type: 'queryPlayers' });
  window.setTimeout(() => {
    if (sequenceId === activeInitSequence && renderReadyForJoin) {
      hideLoadingOverlay();
    }
  }, 180);
  // Late enough to land on a settled frame rather than the first one after the
  // world was built, and dropped if the map changed in the meantime.
  window.setTimeout(() => {
    if (sequenceId === activeInitSequence) logRenderStats('mapEntry');
  }, RENDER_STATS_SAMPLE_DELAY_MS);
  return true;
}

// The snapshot goes down first, then everything that happened while it was
// waiting for its models, in order -- so the last word about any player is
// whichever message actually came last, which is what a stale snapshot applied
// on top of live updates was getting wrong.
function applyRosterSnapshot(players) {
  players.forEach((player) => addPlayer(player));
  const queued = queuedRosterMessages;
  rosterSnapshotPending = false;
  queuedRosterMessages = [];
  queued.forEach((message) => handleServerMessage(message));
}

// The roster this client should be showing, asked for rather than assumed.
// bzfs answers MsgQueryPlayers with the whole list; anyone the answer does not
// name is gone, so this reconciles in both directions.
function applyPlayerList(players) {
  const known = new Set();
  players.forEach((player) => {
    known.add(player.id);
    addPlayer(player);
  });
  Array.from(tanks.keys()).forEach((id) => {
    if (id === myPlayerId || known.has(id)) return;
    removePlayer(id);
  });
  myTank = tanks.get(myPlayerId);
  refreshScoreboards();
}

function isDebugHudVisible() {
  const debugHud = document.getElementById('debugHud');
  if (!debugHud) return false;
  if (debugHud.style.display === 'none') return false;
  const computed = window.getComputedStyle(debugHud);
  return computed.display !== 'none' && computed.visibility !== 'hidden';
}

function updateChatLayoutForDebugOverlap() {
  const body = document.body;
  if (!body) return;
  const desktopLike = window.innerWidth > 900 && !window.matchMedia('(orientation: portrait)').matches;
  const debugVisible = isDebugHudVisible();
  const availableChatWidth = window.innerWidth - CHAT_DEBUG_PANEL_RESERVE;
  const shouldAvoidOverlap = desktopLike && debugVisible && availableChatWidth >= CHAT_MIN_WIDTH_WITH_DEBUG;
  body.classList.toggle('chat-avoid-debug', shouldAvoidOverlap);
}

// The chat palette lives in styles.css, where the DOM chat window uses it. The
// XR panel paints the same chat onto a canvas and reads the same values back,
// rather than keeping a second list that drifts the first time one changes. A
// custom property on :root does not change while the page is up, so each one is
// read once.
const cssColorCache = new Map();
function getCssColor(name, fallback) {
  if (cssColorCache.has(name)) return cssColorCache.get(name);
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const color = value || fallback;
  cssColorCache.set(name, color);
  return color;
}

// The colour the DOM gives a chat line of this kind, from the same variable its
// .chat-kind-* rule reads. A kind with no colour of its own -- `chat`, which is
// most of them -- falls through to the window's own text colour, exactly as it
// does in CSS.
function getChatKindColor(kind) {
  return getCssColor(`--chat-kind-${kind}`, '') || getCssColor('--chat-text', '#fff');
}

function getVisibleChatTabs() {
  if (isDebugHudVisible()) {
    return CHAT_TABS;
  }
  return CHAT_TABS.filter((tab) => tab.id !== 'debug');
}

function normalizeActiveChatTab() {
  if (chatState.activeTab === 'debug' && !isDebugHudVisible()) {
    chatState.activeTab = 'all';
  }
}

function setActiveChatTab(tabId) {
  const visibleTabs = getVisibleChatTabs();
  if (!visibleTabs.some((tab) => tab.id === tabId)) {
    return false;
  }
  chatState.activeTab = tabId;
  chatState.unread[tabId] = false;
  chatWindowDirty = true;
  updateChatWindow();
  // A freshly selected tab always opens on its newest message -- what
  // switching to it meant back when scroll was tracked as an offset from the
  // end, and `updateChatWindow`'s own bottom-preservation has nothing to go
  // on yet for a tab whose messages it has not painted before.
  const chatMessagesDiv = document.getElementById('chatMessages');
  if (chatMessagesDiv) chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
  return true;
}

function cycleChatTab(direction) {
  const visibleTabs = getVisibleChatTabs();
  if (visibleTabs.length === 0) return;
  const currentIndex = visibleTabs.findIndex((tab) => tab.id === chatState.activeTab);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + direction + visibleTabs.length) % visibleTabs.length;
  setActiveChatTab(visibleTabs[nextIndex].id);
}

// `segments` is optional, and is how a line carries more than one colour:
// `[{ text, color }]`, where a segment with no colour of its own takes the
// kind's. `text` is still the whole line as one string -- it is what the XR
// panel measures against and what anything that only wants the words reads --
// so a renderer that ignores segments still draws something correct.
// Stamped on every entry so the cache can put the tabs back in the order the
// lines arrived in. A line is one object in however many tabs it appears, and
// `ts` alone cannot separate two that landed on the same millisecond.
let nextChatEntrySeq = 0;

function addChatEntry(tabIds, text, kind = CHAT_KIND_MISC, segments = null) {
  const entry = {
    text: String(text),
    kind,
    segments: Array.isArray(segments) && segments.length > 0 ? segments : null,
    // Chat arrives from the socket, which keeps delivering while a hidden tab
    // delivers no frames, so this advances the clock rather than reading it.
    ts: sampleEpochClock(),
    seq: nextChatEntrySeq,
  };
  nextChatEntrySeq += 1;
  const uniqueTabIds = Array.from(new Set(tabIds));
  uniqueTabIds.forEach((tabId) => {
    const tabMessages = chatState.messages[tabId];
    if (!Array.isArray(tabMessages)) return;
    tabMessages.push(entry);
    while (tabMessages.length > CHAT_SCROLLBACK_LIMIT) {
      tabMessages.shift();
    }
    if (tabId !== chatState.activeTab) {
      chatState.unread[tabId] = true;
    }
  });
  if (uniqueTabIds.some((tabId) => CHAT_CACHE_TABS.includes(tabId))) scheduleChatCacheSave();
  chatWindowDirty = true;
}

// `sessionStorage` rather than `localStorage`, because the transcript belongs
// to the tab -- which is the thing that reloads. Two tabs on the same origin
// would otherwise write over each other's, and a private `/msg` has no
// business outliving the window it was said in.
const CHAT_CACHE_KEY = 'bzoChatCache';
// Long enough that a burst of chat costs one write, short enough that a tab
// closed without warning loses almost nothing. Every path that knows the page
// is going away flushes instead of waiting for this.
const CHAT_CACHE_SAVE_MS = 2000;
let chatCacheTimer = null;

function saveChatCache() {
  if (chatCacheTimer !== null) {
    clearTimeout(chatCacheTimer);
    chatCacheTimer = null;
  }
  try {
    sessionStorage.setItem(CHAT_CACHE_KEY, JSON.stringify(packChatCache(chatState.messages)));
  } catch {
    // A full or blocked store means no cache, not a broken chat window.
  }
}

function scheduleChatCacheSave() {
  if (chatCacheTimer !== null) return;
  chatCacheTimer = setTimeout(saveChatCache, CHAT_CACHE_SAVE_MS);
}

// Restored lines are not news: they go straight into the tabs rather than
// through `addChatEntry`, so nothing is marked unread and nothing sounds for
// chat that was already read before the reload. The highlight pattern is not
// applied here either -- `updateChatWindow` tests it on every line on every
// repaint (ControlPanel.cxx:513), so a restored line lights up exactly as it
// did before.
function restoreChatCache() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(CHAT_CACHE_KEY) || 'null');
  } catch {
    return;
  }
  const restored = unpackChatCache(saved);
  if (restored.length === 0) return;
  const touched = new Set();
  const push = (tabId, entry) => {
    const tabMessages = chatState.messages[tabId];
    if (!Array.isArray(tabMessages)) return;
    tabMessages.push(entry);
    touched.add(tabId);
  };
  restored.forEach((line) => {
    const entry = {
      text: line.text,
      kind: line.kind,
      segments: line.segments,
      ts: line.ts,
      seq: nextChatEntrySeq,
    };
    nextChatEntrySeq += 1;
    line.tabs.forEach((tabId) => push(tabId, entry));
  });
  // `Date.now()` rather than `sampleEpochClock()`: this runs while the module
  // is still loading, before there is a frame to sample.
  const divider = {
    text: CHAT_RELOAD_DIVIDER,
    kind: CHAT_KIND_MISC,
    segments: null,
    ts: Date.now(),
    seq: nextChatEntrySeq,
  };
  nextChatEntrySeq += 1;
  [...touched].forEach((tabId) => push(tabId, divider));
  chatWindowDirty = true;
}


// Whether chat is following the newest message. Kept as the panel is scrolled
// rather than measured when it is wanted, because the moment it is wanted --
// after a resize -- the panel has already changed size and cannot answer.
let chatPinnedToBottom = true;

// A few px of slack: a fractional `scrollHeight` from sub-pixel line heights
// would otherwise read as "not at the bottom" forever.
function isChatScrolledToBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 4;
}

// PageUp/PageDown still move the transcript a page at a time; the wheel and a
// touch drag need nothing here at all, because `#chatMessages` scrolls
// natively now -- see "Chat scrolls like Debug and Help" below.
function scrollChatPage(direction) {
  const el = document.getElementById('chatMessages');
  if (!el) return;
  el.scrollTop -= direction * el.clientHeight;
}

function scrollChatToNewest() {
  const el = document.getElementById('chatMessages');
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

function routeLocalHudMessage(text) {
  addChatEntry(['misc', 'all'], `local: ${text}`, CHAT_KIND_MISC);
  updateChatWindow();
}

function announceBuildInfoOnce() {
  if (startupBuildInfoAnnounced) return;
  startupBuildInfoAnnounced = true;
  addChatEntry(['misc', 'all'], `client version: ${CLIENT_VERSION}`, CHAT_KIND_MISC);
  addChatEntry(['misc', 'all'], `copyright: ${CLIENT_COPYRIGHT}`, CHAT_KIND_MISC);
  addChatEntry(['misc', 'all'], `license: ${CLIENT_LICENSE} (${CLIENT_LICENSE_URL})`, CHAT_KIND_MISC);
  updateChatWindow();
}

function announceServerTextIfChanged() {
  let announced = false;

  if (typeof serverMotdText === 'string') {
    const nextMotd = serverMotdText.trim();
    if (nextMotd.length > 0 && nextMotd !== lastAnnouncedServerMotd) {
      addChatEntry(['server', 'all'], `[SERVER] MOTD: ${nextMotd}`, CHAT_KIND_SERVER);
      lastAnnouncedServerMotd = nextMotd;
      announced = true;
    }
  }

  if (announced) {
    updateChatWindow();
  }
}

function focusChatWithTarget(targetId, { clearInput = true } = {}) {
  // A `focus()` on a hidden input does nothing at all, so anything that puts
  // the caret in the box opens the folder first (issue #145). Borrowed, not
  // reopened: it shuts again when the caret leaves.
  borrowChat();
  const chatTarget = document.getElementById('chatTarget');
  const nextTarget = normalizeMessageEndpoint(targetId, CHAT_TARGET_ALL);
  if (chatTarget) {
    const value = nextTarget === CHAT_TARGET_ALL || nextTarget === CHAT_TARGET_SERVER
      ? String(nextTarget)
      : nextTarget;
    const optionExists = Array.from(chatTarget.options).some((opt) => opt.value === value);
    chatTarget.value = optionExists ? value : String(CHAT_TARGET_ALL);
  }
  if (chatInput) {
    if (clearInput) {
      chatInput.value = '';
    }
    chatInput.focus();
  }
}

// Chat entry owns the keyboard while it is active, and ends only on Enter,
// Escape, or the Send button. Focus is the single source of that state, so
// everything routes through focus/blur rather than tracking a flag of its own.
function setChatEntryActive(active) {
  chatActive = active;
  // Typing is what a folder is borrowed for, so the end of it is when one goes
  // back. A folder opened from its tabs was never borrowed and stays.
  if (!active) returnChat();
  document.body.classList.toggle('chat-active', active);
  if (sendBtn) {
    sendBtn.classList.toggle('active', active);
    sendBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

// Client-local commands ("Which surface a command belongs to" in
// docs/commands-plan.md): a line upstream's own client claims before the
// server ever sees it. `/silence` is the first of these -- "one client's
// choice to ignore somebody" needs no server round trip, and asking the
// server to keep that state would be inventing state for it.
const LOCAL_COMMANDS = new Map();
function defineLocalCommand(name, run) {
  LOCAL_COMMANDS.set(name, run);
}

// Upstream's own list: callsigns, case-insensitive, persisted rather than
// per-session (`silencedPersonN` in its BZDB config; `localStorage` here).
// bzo adds one thing upstream's "-" cannot mean on this side: upstream's "-"
// silences every *unregistered* player, and bzo's equivalent identity is
// `verified`, not registration -- see the `+`/`@` marks already drawn beside
// a callsign -- so `silenceUnverified` is a flag beside the set rather than a
// member of it.
let silencedCallsigns = new Set();
let silenceUnverified = false;

function loadSilenceState() {
  try {
    const saved = JSON.parse(localStorage.getItem('silencedCallsigns') || '[]');
    if (Array.isArray(saved)) silencedCallsigns = new Set(saved);
  } catch {
    /* ignore storage errors */
  }
  try {
    silenceUnverified = localStorage.getItem('silenceUnverifiedPlayers') === 'true';
  } catch {
    /* ignore storage errors */
  }
}

function saveSilenceState() {
  try {
    localStorage.setItem('silencedCallsigns', JSON.stringify([...silencedCallsigns]));
    localStorage.setItem('silenceUnverifiedPlayers', silenceUnverified ? 'true' : 'false');
  } catch {
    /* ignore storage errors */
  }
}
loadSilenceState();

// Asked at the two places a silenced player can still reach this client: an
// incoming chat/action message, by the name it carries as its sender, and
// voice, by id -- see `applySilenceToVoice`.
function isPlayerSilenced(playerId) {
  if (!playerId || playerId === myPlayerId) return false;
  const state = tanks.get(playerId)?.userData?.playerState;
  if (!state) return false;
  if (silenceUnverified && state.verified !== true) return true;
  return silencedCallsigns.has(state.name.trim().toLowerCase());
}

// bzo's own half of /silence: upstream has no voice chat to extend to, but a
// text-only /silence here would leave a silenced player's voice coming
// through regardless, which is not what anyone asking for it would expect.
// Safe to call for a peer that has not connected yet -- voice.js's own
// `mutedPeerIds` is what a fresh connection consults, not this call's timing.
function applySilenceToVoice(playerId) {
  if (!playerId || playerId === myPlayerId) return;
  const silenced = isPlayerSilenced(playerId);
  callVoiceManager('setPeerMuted', playerId, silenced);
  // Silencing somebody mid-sentence has to lift the duck they are holding
  // down, and unsilencing them has to put it back.
  setVoiceDuckingPeer(
    playerId,
    !silenced && tanks.get(playerId)?.userData?.playerState?.voiceSpeaking === true
  );
}

// Every connected id, re-asked. Cheap enough to run on every roster change
// (`addPlayer` calls this too) since `setPeerMuted` is just a Set update
// unless the peer's own mute state actually flips.
function refreshAllSilencedVoice() {
  tanks.forEach((_tank, playerId) => applySilenceToVoice(playerId));
}

// cmdAutoPilot (clientCommands.cxx:490), which upstream reaches from its own
// command line rather than chat; bzo's is the chat entry.
defineLocalCommand('/autopilot', (args) => {
  const name = args.trim().toLowerCase();
  if (!name) {
    toggleAutopilot();
    return;
  }
  const entry = AUTOPILOTS.find((candidate) => candidate.id === name);
  if (!entry) {
    showMessage(`Usage: /autopilot [${AUTOPILOTS.map((candidate) => candidate.id).join('|')}]`);
    return;
  }
  autopilotRowId = entry.id;
  storeAutopilotRow(entry.id);
  engageAutopilot(entry.id);
});

defineLocalCommand('/silence', (args) => {
  const target = args.trim();
  if (!target) {
    showMessage('Usage: /silence <callsign>|-');
    return;
  }
  if (target === '-') {
    silenceUnverified = true;
    saveSilenceState();
    refreshAllSilencedVoice();
    showMessage('Silencing every unauthenticated player');
    return;
  }
  silencedCallsigns.add(target.toLowerCase());
  saveSilenceState();
  refreshAllSilencedVoice();
  showMessage(`Silenced "${target}"`);
});

defineLocalCommand('/unsilence', (args) => {
  const target = args.trim();
  if (!target) {
    showMessage('Usage: /unsilence <callsign>|-');
    return;
  }
  if (target === '-') {
    silenceUnverified = false;
    saveSilenceState();
    refreshAllSilencedVoice();
    showMessage('No longer silencing unauthenticated players');
    return;
  }
  silencedCallsigns.delete(target.toLowerCase());
  saveSilenceState();
  refreshAllSilencedVoice();
  showMessage(`Unsilenced "${target}"`);
});

// HighlightCommand (CommandsImplementation.cxx:184): one regular expression,
// case-insensitive, replacing whatever was there before. Persisted like
// upstream's own `highlightPattern` BZDB var (`persistent = true`), unlike
// the session-only silence list -- there is nothing per-session about
// wanting your name to stand out.
let highlightPattern = '';
let highlightRegex = null;

function compileHighlightRegex() {
  if (!highlightPattern) {
    highlightRegex = null;
    return;
  }
  try {
    highlightRegex = new RegExp(highlightPattern, 'i');
  } catch {
    // An invalid pattern highlights nothing rather than throwing on every
    // chat line -- upstream's own `regcomp` failure is silent the same way.
    highlightRegex = null;
  }
}

function loadHighlightState() {
  try {
    highlightPattern = localStorage.getItem('highlightPattern') || '';
  } catch {
    highlightPattern = '';
  }
  compileHighlightRegex();
}

function saveHighlightState() {
  try {
    localStorage.setItem('highlightPattern', highlightPattern);
  } catch {
    /* ignore storage errors */
  }
}
loadHighlightState();

// ControlPanel.cxx:513: checked against every line already in the buffer, on
// every redraw, not once at the moment a message arrived -- so changing the
// pattern relights old lines that already match it as well as new ones.
function isHighlightMatch(text) {
  return Boolean(highlightRegex && highlightRegex.test(text));
}

defineLocalCommand('/highlight', (args) => {
  highlightPattern = args.trim();
  compileHighlightRegex();
  saveHighlightState();
  chatWindowDirty = true;
  updateChatWindow();
  if (!highlightPattern) {
    showMessage('Highlight cleared');
  } else if (!highlightRegex) {
    showMessage(`Invalid highlight pattern: ${highlightPattern}`);
  } else {
    showMessage(`Highlighting "${highlightPattern}"`);
  }
});

// SaveMsgsCommand (CommandsImplementation.cxx:189): upstream writes the All tab
// into `msglog-<when>.txt` in its config dir. A browser has no config dir, so
// the same file arrives as a download, under the same name. `-t` stamps each
// line as it does upstream; `-s` is accepted so the habit still works, and does
// nothing, because bzo keeps a line's colours in its segments rather than in
// ANSI escapes inside the text.
defineLocalCommand('/savemsgs', (args) => {
  const flags = args.trim().split(/\s+/).filter(Boolean);
  const timestamps = flags.includes('-t');
  const at = Date.now();
  const filename = transcriptFilename(at);
  const text = formatTranscript(chatState.messages.all, { timestamps, savedAt: at });
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // The click is synchronous, but the fetch the browser starts from it is not,
  // so the URL outlives this turn of the loop.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  showMessage(`Saved messages to: ${filename}`);
});

// CommandList (CommandsImplementation.cxx:201-269): upstream prints its own
// local table, then asks the server for its own list too, rather than
// answering only one half of "what commands are there".
defineLocalCommand('/cmds', () => {
  const names = [...LOCAL_COMMANDS.keys()].sort();
  addChatEntry(['misc', 'all'], `Client-side commands: ${names.join(', ')}`, CHAT_KIND_MISC);
  updateChatWindow();
  sendToServer({ type: 'message', dst: CHAT_TARGET_ALL, msgType: CHAT_KIND_CHAT, text: '/?' });
});

// ComposeDefaultKey.cxx:98's own order: a composed line is tried against the
// local table before it is ever sent, and a match never reaches the server --
// the whole reason a command can be genuinely local rather than merely
// answered locally.
function tryLocalChatCommand(text) {
  const match = /^(\/\S*)\s*([\s\S]*)$/.exec(text);
  if (!match) return false;
  const run = LOCAL_COMMANDS.get(match[1].toLowerCase());
  if (!run) return false;
  run(match[2]);
  return true;
}

// The lines this client has sent, and the words Tab reaches from the chat
// entry. `public/compose.mjs` holds both rules; what is here is where the words
// come from -- who is on the server, what this server answers, what the flags
// are called.
const composeHistory = new ComposeHistory();

// The twenty lines under Up outlive the tab, unlike the transcript beside them.
// Upstream's own die with the process, but upstream's process is not restarted
// for it by the server it is talking to -- and what was typed is the same kind
// of thing as the callsign and the highlight pattern already in `localStorage`
// beside it: not a record of the session, but a habit worth keeping.
const COMPOSE_HISTORY_KEY = 'composeHistory';

function loadComposeHistory() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(COMPOSE_HISTORY_KEY) || 'null');
  } catch {
    return;
  }
  if (!Array.isArray(saved)) return;
  // Newest first on the way out, so they go back in oldest first -- `remember`
  // pushes to the front, and the cap and the de-duplication apply again on the
  // way in rather than being trusted from storage.
  saved.filter((line) => typeof line === 'string').reverse()
    .forEach((line) => composeHistory.remember(line));
}

function saveComposeHistory() {
  try {
    localStorage.setItem(COMPOSE_HISTORY_KEY, JSON.stringify(composeHistory.lines));
  } catch {
    // Nothing to recall next time; no reason to refuse to send this line.
  }
}

loadComposeHistory();

// The server's own command table, as `init` sends it. Filtered by tier at the
// moment of completing rather than on arrival, because an operator logs in
// after joining and the list must follow without being re-sent.
let serverCommands = [];

function composeVocabulary() {
  const callsigns = [];
  const slots = [];
  tanks.forEach((tank, id) => {
    if (id === myPlayerId) return;
    const name = tank.userData.playerState.name;
    callsigns.push(name);
    slots.push({ word: `#${id}`, label: `#${id} "${name}"` });
  });
  return {
    [WORD_KIND.COMMAND]: [
      ...LOCAL_COMMANDS.keys(),
      ...serverCommands.filter((command) => amAdmin || !command.operator)
        .map((command) => command.name),
    ],
    [WORD_KIND.CALLSIGN]: callsigns,
    [WORD_KIND.SLOT]: slots,
    [WORD_KIND.FLAG]: Object.values(FLAG_TYPES).map((type) => ({
      word: type.abbreviation,
      label: `${type.abbreviation} (${type.name})`,
    })),
  };
}

// Tab. Only the line up to the caret is completed and the rest is put back
// after it, so a word fixed in the middle of a finished sentence does not eat
// the end of it -- upstream completes the whole compose string, having no
// caret to speak of.
function completeChatInput() {
  const caret = chatInput.selectionStart;
  const head = chatInput.value.slice(0, caret);
  const tail = chatInput.value.slice(caret);
  const completed = completeCompose(head, composeVocabulary());
  if (completed.head !== head) {
    chatInput.value = completed.head + tail;
    chatInput.setSelectionRange(completed.head.length, completed.head.length);
  }
  // More than one word matched, so the candidates go where upstream puts them:
  // into the message panel, as a line only this client sees
  // (ComposeDefaultKey.cxx:67).
  if (completed.matches.length > 0) {
    addChatEntry(['misc', 'all'], completed.matches.join(', '), CHAT_KIND_MISC);
    updateChatWindow();
  }
}

// Up and Down. A recall that reaches the end of the matching lines leaves the
// entry alone rather than clearing it, so holding Up does not lose what was
// typed.
function recallComposeLine(older) {
  const line = older ? composeHistory.earlier(chatInput.value) : composeHistory.later();
  if (line === null) return;
  chatInput.value = line;
  chatInput.setSelectionRange(line.length, line.length);
}

function sendChatInputText() {
  const chatTarget = document.getElementById('chatTarget');
  const text = chatInput.value.trim();
  if (text.length === 0) return;
  // Whatever was composed, including a line the local table answers: upstream
  // records the history after `LocalCommand::execute` has had it
  // (ComposeDefaultKey.cxx:104), so `/highlight` comes back under Up like
  // anything else.
  composeHistory.remember(text);
  saveComposeHistory();
  if (tryLocalChatCommand(text)) {
    chatInput.value = '';
    return;
  }
  const dst = normalizeMessageEndpoint(chatTarget.value, CHAT_TARGET_ALL);
  sendToServer({ type: 'message', dst, msgType: CHAT_KIND_CHAT, text });
  chatInput.value = '';
}

function toggleChatEntry() {
  if (chatActive) {
    sendChatInputText();
    chatInput.blur();
    return;
  }
  borrowChat();
  chatInput.focus();
}

function handleReplyToLastSender() {
  if (typeof lastDirectSenderId !== 'string' || lastDirectSenderId.length === 0) {
    showMessage('No recent direct sender to reply to');
    return;
  }
  focusChatWithTarget(lastDirectSenderId);
}

function handleMessageNemesisTarget() {
  if (typeof nemesisPlayerId !== 'string' || nemesisPlayerId.length === 0) {
    showMessage('No nemesis target available');
    return;
  }
  focusChatWithTarget(nemesisPlayerId);
}

function normalizeMessageEndpoint(value, fallback = CHAT_TARGET_ALL) {
  if (value === CHAT_TARGET_ALL || value === String(CHAT_TARGET_ALL)) return CHAT_TARGET_ALL;
  if (value === CHAT_TARGET_SERVER || value === String(CHAT_TARGET_SERVER)) return CHAT_TARGET_SERVER;
  if (value === CHAT_TARGET_TEAM || value === String(CHAT_TARGET_TEAM)) return CHAT_TARGET_TEAM;
  if (value === CHAT_TARGET_ADMIN || value === String(CHAT_TARGET_ADMIN)) return CHAT_TARGET_ADMIN;
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function getPlayerName(id) {
  const normalizedId = normalizeMessageEndpoint(id, CHAT_TARGET_SERVER);
  if (normalizedId === CHAT_TARGET_ALL) return 'ALL';
  if (normalizedId === CHAT_TARGET_SERVER) return 'SERVER';
  if (normalizedId === CHAT_TARGET_TEAM) return 'TEAM';
  if (normalizedId === CHAT_TARGET_ADMIN) return 'ADMIN';
  if (normalizedId === myPlayerId && typeof myPlayerName === 'string' && myPlayerName.trim().length > 0) {
    return myPlayerName.trim();
  }
  const tank = tanks.get(normalizedId);
  return tank && tank.userData && tank.userData.playerState && tank.userData.playerState.name
    ? tank.userData.playerState.name
    : `Player ${normalizedId}`;
}

// The colour to write a player's name in wherever it appears in a chat line --
// their own raw colour, not the effective (Masquerade-adjusted) one, since
// Masquerade changes how a tank looks rather than who said something. `null`
// for a target with no tank behind it (ALL, SERVER, TEAM, ADMIN, or a player
// who has since left), which is left uncoloured rather than guessed at.
function getChatPlayerColor(id) {
  const state = tanks.get(id)?.userData?.playerState;
  return state ? colorToCSS(state.color) : null;
}

function formatNetworkMessage(message) {
  const text = typeof message.text === 'string' ? message.text : '';
  const src = normalizeMessageEndpoint(message.src ?? message.from, CHAT_TARGET_SERVER);
  const dst = normalizeMessageEndpoint(message.dst ?? message.to, CHAT_TARGET_ALL);
  const msgType = message.msgType === CHAT_KIND_ACTION
    ? CHAT_KIND_ACTION
    : (message.msgType === CHAT_KIND_SERVER ? CHAT_KIND_SERVER : CHAT_KIND_CHAT);
  const fromName = getPlayerName(src);
  const toName = getPlayerName(dst);
  // The rabbit mark, exactly as every notice already shows it (describePlayer,
  // via getPlayerTeamMark): chat had never said who is -- or was, at the time
  // they sent it -- the rabbit, though the scoreboard and every other line
  // naming a tank already do. `null` for a target with no team to speak of
  // (ALL, SERVER, TEAM, ADMIN), same as for anyone who currently isn't it.
  const fromMark = getPlayerTeamMark(getPlayerTeamById(src));
  const toMark = getPlayerTeamMark(getPlayerTeamById(dst));
  const fromSuffix = fromMark ? ` ${fromMark.label}` : '';
  const toSuffix = toMark ? ` ${toMark.label}` : '';
  const markSegment = (mark) => (mark ? [{ text: ` ${mark.label}`, color: colorToCSS(mark.color) }] : []);

  if (msgType === CHAT_KIND_SERVER || src === CHAT_TARGET_SERVER) {
    return { text: `[SERVER] ${text}`, tabs: ['server', 'all'], kind: CHAT_KIND_SERVER };
  }
  // playing.cxx:3286. A team message is marked `[Team]` and goes to the Chat tab
  // like any other -- upstream has no team tab, and neither does bzo.
  //
  // Two colours, because bzo has two to say: the team's own colour on the label
  // -- the one its flag, its blip and its heading marker already wear -- and the
  // sender's own colour on the callsign, which is a thing upstream has no way to
  // show, since its team mates all share one colour. The raw player colour and
  // not the effective one: Masquerade changes how a tank *looks*, not who said
  // something.
  // playing.cxx:3271. An admin message is marked and goes to the Chat tab like a
  // team message does -- upstream has no admin tab either. Only an admin ever
  // receives one, so there is nothing to hide from anybody who can read it.
  if (dst === CHAT_TARGET_ADMIN) {
    const senderState = tanks.get(src)?.userData?.playerState;
    const separator = msgType === CHAT_KIND_ACTION ? ' ' : ': ';
    return {
      text: `[ADMIN] ${fromName}${fromSuffix}${separator}${text}`,
      tabs: ['chat', 'all'],
      kind: CHAT_KIND_ADMIN,
      segments: [
        { text: '[ADMIN]', color: colorToCSS(getChatKindColor(CHAT_KIND_ADMIN)) },
        { text: ` ${fromName}`, color: colorToCSS(senderState?.color ?? getChatKindColor(CHAT_KIND_ADMIN)) },
        ...markSegment(fromMark),
        { text: `${separator}${text}` },
      ],
    };
  }
  if (dst === CHAT_TARGET_TEAM) {
    const senderState = tanks.get(src)?.userData?.playerState;
    // Named by its colour alone -- `[Green]`, not `[Green Team]` -- for the same
    // reason `getPlayerFlagLabel` strips it off a team flag: the bracket says
    // which of the two kinds of name this is and the colour says the rest, so the
    // word is as redundant here as "Player" before a quoted name.
    const teamName = PLAYER_TEAM_LABELS[normalizePlayerTeam(senderState?.team)] ?? 'Team';
    const label = `[${teamName.replace(/ Team$/, '')}]`;
    const separator = msgType === CHAT_KIND_ACTION ? ' ' : ': ';
    return {
      text: `${label} ${fromName}${fromSuffix}${separator}${text}`,
      tabs: ['chat', 'all'],
      kind: CHAT_KIND_TEAM,
      segments: [
        { text: label, color: colorToCSS(getPlayerTeamColor(senderState?.team)) },
        { text: ` ${fromName}`, color: colorToCSS(senderState?.color ?? getChatKindColor(CHAT_KIND_TEAM)) },
        ...markSegment(fromMark),
        { text: `${separator}${text}` },
      ],
    };
  }
  // Whoever's name appears gets their own colour, same as the team and admin
  // branches above -- playing.cxx colours the sender's name too, though only
  // by team; bzo already goes further there, so plain chat and a direct
  // message (action or not, the bracket reads the same either way) should not
  // be the two kinds of line where a name is left uncoloured. `undefined` when
  // there is no tank behind the id (a name from a player who has since left),
  // which leaves the line exactly as uncoloured as it already was.
  if (typeof dst === 'string') {
    if (src === myPlayerId) {
      const toColor = getChatPlayerColor(dst);
      return {
        text: `[->${toName}${toSuffix}] ${text}`,
        tabs: ['chat', 'all'],
        kind: CHAT_KIND_DIRECT_OUT,
        segments: toColor
          ? [{ text: '[->' }, { text: toName, color: toColor }, ...markSegment(toMark), { text: `] ${text}` }]
          : undefined,
      };
    }
    const fromColor = getChatPlayerColor(src);
    return {
      text: `[${fromName}${fromSuffix}->] ${text}`,
      tabs: ['chat', 'all'],
      kind: CHAT_KIND_DIRECT_IN,
      segments: fromColor
        ? [{ text: '[' }, { text: fromName, color: fromColor }, ...markSegment(fromMark), { text: `->] ${text}` }]
        : undefined,
    };
  }
  if (msgType === CHAT_KIND_ACTION) {
    const fromColor = getChatPlayerColor(src);
    return {
      text: `${fromName}${fromSuffix} ${text}`,
      tabs: ['chat', 'all'],
      kind: CHAT_KIND_ACTION,
      segments: fromColor
        ? [{ text: fromName, color: fromColor }, ...markSegment(fromMark), { text: ` ${text}` }]
        : undefined,
    };
  }
  const fromColor = getChatPlayerColor(src);
  return {
    text: `${fromName}${fromSuffix}: ${text}`,
    tabs: ['chat', 'all'],
    kind: CHAT_KIND_CHAT,
    segments: fromColor
      ? [{ text: fromName, color: fromColor }, ...markSegment(fromMark), { text: `: ${text}` }]
      : undefined,
  };
}

// What being an admin, or not, looks like. Two things: the ADMIN destination is
// only offered to somebody the server would let speak on it, and the Operator
// button is disabled rather than hidden -- a control that is plainly unavailable
// says more than one that is missing, which is the same rule the capability
// gating follows for a renderer feature it cannot draw.
function applyAdminUi() {
  const adminOption = document.querySelector(`#chatTarget option[value="${CHAT_TARGET_ADMIN}"]`);
  if (adminOption) {
    adminOption.hidden = !amAdmin;
    adminOption.disabled = !amAdmin;
  }
  const chatTarget = document.getElementById('chatTarget');
  if (chatTarget && !amAdmin
    && normalizeMessageEndpoint(chatTarget.value, CHAT_TARGET_ALL) === CHAT_TARGET_ADMIN) {
    chatTarget.value = String(CHAT_TARGET_ALL);
  }
  const operatorBtn = document.getElementById('operatorBtn');
  if (operatorBtn) {
    operatorBtn.disabled = !amAdmin;
    operatorBtn.title = amAdmin
      ? 'Show Operator Panel (O)'
      : 'Operator: sign in with a bzflag.org global callsign that the server grants admin to';
  }
  applyLoginUi();
}

// A verified session's join name is not a choice: `resolveJoinName` forces
// the join to the session's callsign regardless of what the entry dialog's
// name field holds, so the field is locked to match rather than inviting an
// edit the server will ignore (issue #75). `null` where there is nothing to
// force, which is every unverified connection.
function forcedEntryName() {
  return (amVerified && myGlobalCallsign) ? myGlobalCallsign : null;
}

// The Global login row in the entry dialog. It says what the server said and
// nothing more: signed in as whom, and whether that carried admin. `@` and `+`
// are upstream's own indicators (`ScoreboardRenderer.cxx:718`), so the row uses
// the same characters the scoreboard will.
function applyLoginUi() {
  const value = document.getElementById('entryLoginValue');
  const row = document.getElementById('entryLoginRow');
  const entryInput = document.getElementById('entryInput');
  const forcedName = forcedEntryName();
  if (entryInput) {
    entryInput.disabled = forcedName !== null;
    if (forcedName !== null) entryInput.value = forcedName;
  }
  if (!value) return;
  // A staged proxy destination needs a token of its own, and no local status
  // can supply one: a token is single use, spent at `MsgEnter`, and issued per
  // target. So this row stops reporting where this connection stands and
  // becomes the one thing that helps -- a fresh login for the target. Showing
  // the local callsign here would be worse than unhelpful, because while
  // signed in the row is a sign-*out*, and pressing it would leave for the
  // proxy carrying nothing.
  // Only when the staged proxy is somewhere this page is not. Already on it
  // and verified, the row reports that standing the way it does anywhere else
  // -- it is the target's own answer, and signing out is a real thing to want.
  const stagedProxy = findProxyDestination(selectedDestination);
  const goingElsewhere = stagedProxy && `proxy:${stagedProxy.key}` !== currentDestination();
  if (goingElsewhere) {
    value.textContent = 'Sign in';
    if (row) {
      delete row.dataset.loggedIn;
      row.setAttribute('aria-label', `Global login for ${stagedProxy.name}`);
      row.title = `Sign in at bzflag.org to play on ${stagedProxy.name}.`
        + ' A login is needed for each target, and bzo never sees your password.';
    }
    return;
  }
  if (amVerified) {
    value.textContent = `${amAdmin ? '@' : '+'}${myGlobalCallsign || myPlayerName}`;
    if (row) {
      row.dataset.loggedIn = 'true';
      row.setAttribute('aria-label', `Signed in as ${myGlobalCallsign || myPlayerName}. Activate to sign out.`);
      row.title = amAdmin
        ? 'Signed in, and an admin on this server. Click to sign out.'
        : 'Signed in with a bzflag.org global callsign. Click to sign out.';
    }
    return;
  }
  value.textContent = 'Sign in';
  if (row) {
    delete row.dataset.loggedIn;
    row.setAttribute('aria-label', 'Global login: sign in');
    row.title = 'Sign in at bzflag.org with a global callsign. bzo never sees your password.';
  }
}

// Signed out: leaving for bzflag.org's own login form, which
// `misc/checkToken.php` requires -- a site that collects the password itself is
// refused, and that is the whole point, bzo never sees one. The server does the
// rest at `/login`, sets a session cookie and sends the browser back to `/`.
//
// Signed in: `/logout` removes the stored session server-side and clears the
// cookie, then also sends the browser back to `/`.
//
// Either way this is a page navigation, so everything staged in the dialog is
// discarded and the game is left. Inside an immersive session it also ends the
// session, which is why the row says so before it goes: a headset player who is
// thrown out of VR without warning has no idea what happened.
function startGlobalLogin() {
  if (isXREnabled()) {
    setHudAlert(2, amVerified
      ? 'Signing out leaves VR. Exit the headset session first.'
      : 'Global login leaves VR. Exit the headset session first.', 5, true);
    return;
  }
  // Back to the page this started on, still watching what it was watching. A
  // browser on a proxied server returns to that match rather than to this
  // server's own game, and the view rides along as a second path segment --
  // the callback bzflag.org returns to may hold only one query parameter, so
  // anything the round trip must carry travels in the path (see `/login`).
  //
  // One value covers both spectator parameters: `?view=` implies watching the
  // leader, so a page on `?follow=leader` comes back on `view=follow`, which
  // is the same camera.
  const params = new URLSearchParams(window.location.search);
  // The destination staged in the dialog, not the one this page is on: a
  // player who picked a proxy and a team, and found they must sign in, is
  // saying where they want to land. `/login` comes back to that link.
  const stagedProxy = findProxyDestination(selectedDestination);
  const proxyTarget = stagedProxy ? stagedProxy.key : params.get('proxy');
  const stagedTeam = proxyTarget ? (getJoinTeamFields().team || params.get('team')) : null;
  // The roam view only comes back if a playing team is *not* being carried.
  // Clicking this row while watching is the ordinary case -- a tokenless
  // connection is an observer -- so the view would otherwise ride along beside
  // the team, and `?view=` forces observer on arrival (`autoObserving` below).
  // The player would sign in, enter on the team they asked for, and then be
  // navigated straight back to watching. The team is the more specific of the
  // two requests, so it is the one that survives.
  const carryingPlay = Boolean(stagedTeam) && stagedTeam !== PLAYER_TEAM.OBSERVER;
  const watching = !carryingPlay && isObserver() && roamView
    ? encodeURIComponent(roamView)
    : '';
  // The team comes back too, and it is the team *staged in the dialog* rather
  // than the one this connection entered on. Signing in is the thing that
  // makes playing possible at all on a target that has the callsign
  // registered, so the player who picks a team, finds they must sign in and
  // clicks this row has already said where they want to land -- coming back
  // on the old team would grant the wish and undo the choice in one move.
  // `getJoinTeamFields` is what every join reads, so Map Viewer resolves to
  // Observer here the same way it does on the wire.
  //
  // Path segments are positional, so a team with no view still fills the view
  // slot; `-` is not a view name and resolves to none.
  const proxyTeam = stagedTeam;
  const tail = proxyTeam
    ? `/${watching || '-'}/${encodeURIComponent(proxyTeam)}`
    : (watching ? `/${watching}` : '');
  const returnPage = proxyTarget ? `/${encodeURIComponent(proxyTarget)}${tail}` : '';
  // Never `/logout` when a proxy is staged: that row is a fresh login for the
  // target whatever this connection's own status is (`applyLoginUi`).
  const goingElsewhere = stagedProxy && `proxy:${stagedProxy.key}` !== currentDestination();
  const action = (amVerified && !goingElsewhere) ? '/logout' : '/login';
  window.location.href = `${action}${returnPage}`;
}

function syncDebugTabVisibility() {
  normalizeActiveChatTab();
  updateChatLayoutForDebugOverlap();
  chatWindowDirty = true;
  updateChatWindow();
}

function queueDebugPacket(payload) {
  pendingDebugPackets.push(payload);
  if (pendingDebugPackets.length > 120) {
    pendingDebugPackets.shift();
  }
}

// A server-assigned 'Player' or 'Player n' is a placeholder, not a name the
// player chose, so it does not count as one to join under. Neither does having
// no name at all, which is what a browser that has never been here has.
// The server's own ceiling (`MAX_MOTTO_LENGTH`), repeated here only so the
// field stops accepting before it starts silently losing characters.
const MAX_MOTTO_LENGTH = 40;

function isDefaultPlayerName(name) {
  return !name || name === 'Player' || /^Player \d+$/.test(name);
}

// Upstream's `motto`: a short line the player writes about themselves, drawn
// beside their callsign on the scoreboard and carried to a proxied or watched
// server in the field of that name. Kept in `localStorage` like the name, and
// bounded again on the server, which is the copy that matters.
let myPlayerMotto = (localStorage.getItem('playerMotto') || '').slice(0, MAX_MOTTO_LENGTH);

function savePlayerMotto(motto) {
  myPlayerMotto = String(motto).trim().slice(0, MAX_MOTTO_LENGTH);
  localStorage.setItem('playerMotto', myPlayerMotto);
}

function savePlayerName(name) {
  const trimmed = String(name).trim().substring(0, 20);
  localStorage.setItem('playerName', trimmed);
  myPlayerName = trimmed;
  const entryInput = document.getElementById('entryInput');
  if (entryInput) entryInput.value = trimmed;
  return trimmed;
}

function getSavedJoinableName() {
  const savedName = localStorage.getItem('playerName');
  if (typeof savedName !== 'string') return '';
  const trimmed = savedName.trim();
  if (!trimmed || isDefaultPlayerName(trimmed)) return '';
  return trimmed;
}

function getDebugSenderName() {
  if (typeof myPlayerName === 'string' && myPlayerName.trim().length > 0) {
    return myPlayerName.trim();
  }
  const savedName = localStorage.getItem('playerName');
  if (typeof savedName === 'string' && savedName.trim().length > 0) {
    return savedName.trim();
  }
  return '';
}

// The renderer reports a lost GL context, which is a thing only it can see and
// only client.js can send down the socket. Assigned once, here, beside the
// function itself so the two cannot drift apart.
renderManager.debugLog = (message, source) => debugLog(message, source);

// A map whose texture turned out to be transparent while its material stated
// no `alphathresh`. bzo draws it correctly on its own default, so nothing is
// broken here -- but upstream runs no alpha test without one, so the same map
// renders differently there, and the mapper is the only one who can close
// that gap. Said once per texture, to the server, so it reaches whoever owns
// the map rather than only the browser console of whoever happened to load it.
reportAlphaWithoutThreshold((textureName) => {
  debugLog(`Texture "${textureName}" has transparency but its material states no alphathresh;`
    + ` bzo is using its own ${'0.05'} default. Upstream would run no alpha test at all.`, 'map');
});

function debugLog(message, source = '') {
  const text = source ? `[${source}] ${String(message)}` : String(message);
  addChatEntry(['debug'], `[DBG] ${text}`, CHAT_KIND_DEBUG);
  updateChatWindow();
  console.log(text);
  const payload = {
    type: 'debug',
    message: text,
    name: getDebugSenderName() || undefined,
  };
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendToServer(payload);
    return;
  }
  queueDebugPacket(payload);
}

function flushDebugPacketQueue() {
  if (!ws || ws.readyState !== WebSocket.OPEN || pendingDebugPackets.length === 0) {
    return;
  }
  while (pendingDebugPackets.length > 0) {
    const payload = pendingDebugPackets.shift();
    sendToServer(payload);
  }
}

function collectClientCapabilities() {
  const probeCanvas = document.createElement('canvas');
  const gl2 = !!probeCanvas.getContext('webgl2');
  const gl = !!probeCanvas.getContext('webgl');
  const experimental = !!probeCanvas.getContext('experimental-webgl');
  debugLog(
    `capabilities ua="${navigator.userAgent}" webgl2=${gl2} webgl=${gl} experimentalWebgl=${experimental} secure=${window.isSecureContext}`,
  );
}

window.addEventListener('error', (event) => {
  const message = event && event.message ? event.message : 'Unknown error event';
  const source = event && event.filename ? event.filename : 'unknown-source';
  const line = event && event.lineno ? event.lineno : 0;
  const col = event && event.colno ? event.colno : 0;
  debugLog(`window.error message="${message}" at ${source}:${line}:${col}`);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason ? event.reason : 'Unknown rejection reason';
  const serialized = typeof reason === 'string' ? reason : (reason && reason.message ? reason.message : JSON.stringify(reason));
  debugLog(`window.unhandledrejection reason="${serialized}"`);
});

window.gameDebugLog = debugLog;

function lightenHexColor(colorValue, mix = 0.45) {
  const color = new THREE.Color(typeof colorValue === 'number' ? colorValue : (colorValue || 0x4caf50));
  color.lerp(new THREE.Color(0xffffff), Math.max(0, Math.min(1, mix)));
  return color;
}

// Team::addBrightness (Team.cxx:192) at upstream's `shotBrightness` of 0.2: a
// shot is its tank's colour lifted toward white by (1 - c)^4 a channel, so a
// channel already bright stays put and a dark one gains a little. A blue team's
// shot stays deep blue. Worked in the colour's own display values, which is
// what upstream's floats are.
const SHOT_BRIGHTNESS = 0.2;
function shotColorFromTankColor(colorValue) {
  const color = new THREE.Color(typeof colorValue === 'number' ? colorValue : (colorValue || 0x4caf50));
  const rgb = color.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  const lift = (c) => Math.max(0, Math.min(1, c + (SHOT_BRIGHTNESS * ((1 - c) ** 4))));
  return color.setRGB(lift(rgb.r), lift(rgb.g), lift(rgb.b), THREE.SRGBColorSpace);
}

// The colour a shot is made from: its shooter's tank colour. A guided
// missile's model wears it flat, nose and fins; the bolt lifts it
// (`getPlayerShotColor`).
function getPlayerShotBaseColor(playerId, team = null) {
  // A world weapon's shot has no shooter to take a colour from. Upstream draws
  // one in its `shot.team`'s colour: the weapon's own `color`, or rogue, which
  // no player of a colour team wears and so reads as nobody's.
  if (String(playerId) === String(WORLD_WEAPON_PLAYER_ID)) {
    return getPlayerTeamColor(team || WORLD_WEAPON_TEAM);
  }
  const tank = tanks.get(playerId);
  const playerColor = tank?.userData?.playerState?.color;
  // Player::addShots takes a `colorblind` flag for exactly this
  // (playing.cxx:6169): a shot has to lie about its owner's team too, or the
  // shots would give away what the tanks no longer do.
  return getEffectiveTankColor(
    playerId,
    typeof playerColor === 'number' ? playerColor : 0x4caf50
  );
}

function getPlayerShotColor(playerId, team = null) {
  return shotColorFromTankColor(getPlayerShotBaseColor(playerId, team));
}

// The colour the radar draws a shot in. Deliberately not `getPlayerShotColor`:
// that lifts a player's colour toward white so the bolt reads as hot against
// the world, which a two-pixel line on a dark panel does not need. The radar
// wants the colour its own blips use, so a shot and the tank that fired it are
// the same colour on the same panel.
//
// Upstream asks the same question and answers it the same way -- its shots take
// `Team::getRadarColor` (RadarRenderer.cxx:671), the radar palette, not the
// lightened `Team::getShotColor` the bolt itself is drawn with.
function getShotRadarColor(playerId, team = null) {
  // A world weapon has no tank to match, so it takes its shot's team -- the
  // weapon's own `color`, or rogue, which reads as nobody's.
  if (String(playerId) === String(WORLD_WEAPON_PLAYER_ID)) {
    return colorToCSS(getPlayerTeamRadarColor(team || WORLD_WEAPON_TEAM));
  }
  // The one blip bzo paints from a team rather than from the player, for the
  // reason spelled out where the blip itself is drawn: the rabbit's grey is the
  // one shade that does not read on a dark panel.
  if (isTheRabbit(playerId) && !isColorblind()) {
    return colorToCSS(getPlayerTeamRadarColor(PLAYER_TEAM.RABBIT));
  }
  const tank = tanks.get(playerId);
  const playerColor = tank?.userData?.playerState?.color;
  const color = getEffectiveTankColor(
    playerId,
    typeof playerColor === 'number' ? playerColor : 0x4caf50
  );
  return colorToCSS(color);
}

// Input state

// Entry Dialog
function isEntryDialogOpen() {
  return document.getElementById('entryDialog')?.style.display === 'block';
}

// What the dialog was opened on top of. Every field in it edits a draft, and
// nothing reaches the game, localStorage or the server until OK is pressed --
// so Cancel, the [X] and Escape all have something exact to put back.
let entrySnapshot = null;

function openEntryDialog(name = '') {
  const entryDialog = document.getElementById('entryDialog');
  const entryInput = document.getElementById('entryInput');
  if (!entryDialog || !entryInput) return;

  entrySnapshot = {
    name: myPlayerName,
    team: getSelectedPlayerTeam(),
    tankModel: selectedTankModelId,
    motto: myPlayerMotto,
  };
  setInputContext(INPUT_CONTEXT.ENTRY);
  entryDialog.style.display = 'block';
  startTankPreviewAnimation();
  entryDialogFreeze = true;
  // Team is settled at join time, so changing it means rejoining -- which OK
  // does, and which is why the selector is offered to a player already in the
  // game rather than greyed out for them.
  const forcedName = forcedEntryName();
  entryInput.value = forcedName ?? (name === '' ? myPlayerName : name);
  entryInput.disabled = forcedName !== null;
  // Staged like every other row: what is in the box is a draft until OK.
  syncMottoForDestination();
  entryInput.focus();
  entryDialogReturnCameraMode = cameraMode;
  cameraMode = 'overview';
}

// `revert` puts the draft back: that is Cancel, the [X], Escape and a click
// that lands outside. OK and the XR join panel close without it, having either
// applied the draft themselves or being about to.
function closeEntryDialog({ revert = true } = {}) {
  const entryDialog = document.getElementById('entryDialog');
  if (!entryDialog || entryDialog.style.display !== 'block') return;

  if (revert && entrySnapshot) {
    // Straight back onto the field rather than through savePlayerName, which
    // would write to localStorage -- the one thing Cancel must not do.
    myPlayerName = entrySnapshot.name;
    const entryInput = document.getElementById('entryInput');
    if (entryInput) entryInput.value = myPlayerName;
    selectedPlayerTeam = entrySnapshot.team;
    syncPlayerTeamSelector();
    // Nothing was applied, so putting the draft back is the id and the two
    // pieces of the dialog that were drawn from it.
    selectedTankModelId = entrySnapshot.tankModel;
    updateSelectedTankOptionUI();
    loadTankPreviewModel(getTankModelPathById(selectedTankModelId));
  }

  entryDialog.style.display = 'none';
  stopTankPreviewAnimation();
  entryDialogFreeze = false;
  cameraMode = entryDialogReturnCameraMode === 'overview' ? 'first-person' : entryDialogReturnCameraMode;
  syncInputContextFromUi();
}

// OK. The name and the team are settled by the server at join time, so either
// one changing means rejoining; the tank is not, so it travels on its own and
// costs nothing to change from inside a life.
function applyEntrySelections() {
  const entryInput = document.getElementById('entryInput');
  const snapshot = entrySnapshot;
  if (!entryInput || !snapshot) return;

  savePlayerName(entryInput.value);
  // Only when it is the player's to save. On a proxied destination the box
  // holds the attribution this server will send, not anything they typed.
  const mottoInput = document.getElementById('entryMottoInput');
  if (mottoInput && !stagedDestinationIsRemote()) savePlayerMotto(mottoInput.value);
  // The login carries the staged destination and team already, so it lands on
  // exactly what was asked for (`startGlobalLogin`).
  if (destinationNeedsLogin(selectedDestination, getJoinTeamFields().team)) {
    startGlobalLogin();
    return;
  }
  // Somewhere else is a navigation rather than a join: the name is saved
  // above, so it survives the reload and the arriving `init` joins with it.
  if (selectedDestination !== currentDestination()) {
    window.location.href = destinationHref(selectedDestination, getJoinTeamFields().team);
    return;
  }
  if (selectedTankModelId !== snapshot.tankModel) {
    applySelectedTankModel(selectedTankModelId);
  }

  const rejoin = !gameplayJoinConfirmed
    || myPlayerName !== snapshot.name
    || myPlayerMotto !== snapshot.motto
    || getSelectedPlayerTeam() !== snapshot.team;
  if (!rejoin) return;
  // The join is the authority on both, and it is refused while the client still
  // believes it is in the game.
  gameplayJoinConfirmed = false;
  setPendingJoinRequest(myPlayerName);
  maybeSendPendingJoinRequest();
}

// The Default button: the dialog goes back to what a first-time player is
// offered. It stages like every other control here, so nothing has happened
// until OK.
function resetEntrySelectionsToDefault() {
  const entryInput = document.getElementById('entryInput');
  // A verified name is not the default button's to clear -- it is not the
  // player's choice while signed in, and logging out is what restores it.
  if (entryInput && forcedEntryName() === null) {
    entryInput.value = '';
    entryInput.focus();
  }
  // The player's own, and the Default button's to clear -- unlike the name,
  // nothing else ever sets it.
  const mottoInput = document.getElementById('entryMottoInput');
  if (mottoInput) mottoInput.value = '';
  selectedPlayerTeam = PLAYER_TEAM.AUTOMATIC;
  storePlayerTeamChoice(selectedPlayerTeam);
  syncPlayerTeamSelector();
  setSelectedTankModel(getDefaultTankModel().id);
}

function toggleEntryDialog(name = '') {
  if (isEntryDialogOpen()) closeEntryDialog();
  else openEntryDialog(name);
}

// Obstacle definitions (received from server)
let OBSTACLES = [];
let TELEPORTER_GRAPH = { teleporters: [], links: [] };
let TELEPORTER_OBSTACLES_BY_INDEX = new Map();
let TELEPORTER_LINKS_BY_SOURCE_FACE = new Map();
let TELEPORTER_INDEX = { teleporters: TELEPORTER_OBSTACLES_BY_INDEX, links: TELEPORTER_LINKS_BY_SOURCE_FACE };

// Map Viewer (issue #68). `availableViewMaps` is `init.viewableMaps` verbatim
// -- every map hashed so far, `{ file, hash, url }`. `selectedViewMapFile` is
// the dialog's staged choice; `previewedMapFile` is whichever map is actually
// applied to the scene right now, non-null exactly while that differs from
// the live match (dialog preview or actual Map Viewer play). `liveWorldData`
// is the live match's own world payload, kept so leaving a preview restores
// it without a re-fetch.
let availableViewMaps = [];
let selectedViewMapFile = null;
let previewedMapFile = null;
let liveWorldData = null;

// A `?viewmap=` link naming a remote import the server hasn't hashed (yet,
// or again -- see `IMPORT_REUSE_MS` in server.js) waits here for
// `importMapForViewResult` rather than falling through to an ordinary join.
// `sequenceId` is the `init` this request was for, so a reconnect that
// starts a new one before the reply lands does not resolve a stale one.
let pendingViewMapImport = null;

// Asks the server to (re-)import the remote server a viewmap link's own
// filename names (`import-<host>_<port>.bzw`, parsed back server-side by
// `parseImportMapFileName`) and finishes the join once that settles --
// as Map Viewer on success, as an ordinary join on failure. The loading
// overlay already showing for this connection borrows a line to say so
// rather than a dialog of its own, since nothing else is asking for
// attention at this point in a fresh page load.
function requestMapImportForView(file, sequenceId, onSuccess, onFailure) {
  pendingViewMapImport = { file, sequenceId, onSuccess, onFailure };
  setLoadingOverlayState({
    visible: true,
    progress: 0.02,
    status: 'Fetching remote server\'s map...',
    detail: file,
  });
  sendToServer({ type: 'importMapForView', file });
}

// Camera mode
let cameraMode = 'first-person'; // 'first-person', 'third-person', or 'overview'
let entryDialogReturnCameraMode = 'first-person';
// Mirrors entryDialogReturnCameraMode, for the XR menu's own "Join Game" /
// "Player Options" screen (issue #68): it is the one place XR previews a team
// or Map Viewer choice before confirming it, the same reason the flat dialog
// forces 'overview' while open. Without it, the render call site's
// `isObserver()` reads the *confirmed* team -- during staging, whatever team
// was last actually joined -- and shows that team's ordinary camera instead
// of a preview. `null` means no override is currently applied.
let xrPlayerScreenReturnCameraMode = null;

// Pause state. Three facts and the rules over them live in pause.mjs, which is
// what keeps the two ways to pause -- the P key and a menu covering the game --
// answering to one set of rules, `pausedByUnmap` (playing.cxx:124) among them:
// a pause a menu took is the menu's to undo, and neither may resume a pause the
// player asked for. The rules and the reasons are in pause.mjs.
const pauseState = new PauseState();
// Which second the countdown alert last showed, so it is rewritten once a
// second rather than once a frame. Shared by both countdowns, since they share
// upstream's alert slot and only one of them can be running.
let pauseAlertSecondsShown = 0;
// cmdDestruct's five seconds (clientCommands.cxx:415), which is the client's own
// clock: the server owns the pause countdown because it decides whether a tank
// may be hit, and owns nothing about this one because it ends in a request.
const destructCountdown = new DestructCountdown(5000);
// The hunt: which players are marked, and where the scoreboard cursor is while
// one is being picked. The rules are in hunt.mjs, because the two keys, the
// board's cursor and Rabbit Chase's own anointing all move the same state.
const huntState = new HuntState();
// pulse (playing.cxx:4581) -- `SFX_HUNT` sounds at a hunted tank at most once a
// second however long it stays in the sights. In `frameEpochMs` terms; 0 before
// the first ping.
let huntPulseUntil = 0;
// hud->setAlert(1, msg, 2.0f, 0) -- playing.cxx:4581. Identify's own two
// seconds, on the same slot, because a look and a sighting answer the same
// question and only one of them can be the latest answer.
const HUNT_ALERT_SECONDS = 2;
const HUNT_PULSE_MS = 1000;
// The Settings row's own subject: the player it is currently pointed at.
// Separate from `huntState.cursorId`, which belongs to the scoreboard cursor --
// stepping this row must not put the board into select mode, and the board's
// cursor must not move because a menu is open somewhere.
let huntRowTargetId = null;
// Clear rides that row's stepping list as its first entry rather than taking a
// row of its own: `Clear - Alice - Bob -` wraps, so it is one step from either
// end of the roster, and the menu keeps a line it would otherwise spend saying
// the same thing. It is always present, even with nothing marked, because a
// list that changes length underneath you is the thing alphabetical order is
// here to avoid -- it simply does nothing then. Not a player id any roster can
// produce.
const HUNT_ROW_CLEAR_ID = 'hunt:clear';

// Both live up here rather than beside the row they serve because
// `initHudControls` refreshes the Settings menu synchronously as it binds, long
// before the rest of the file has run: anything the row reads on that first
// pass has to be initialized by now, or it is read inside its own temporal dead
// zone. Same reason `getHuntRowPlayers` walks `tanks` rather than asking for
// the scoreboard model, which is built from state declared much further down.
// The tank is frozen while the entry dialog is up, which is not a pause: the
// player is picking a name and a team, and the server knows nothing about it.
let entryDialogFreeze = false;

function isMyTankAlive() {
  return Boolean(myTank && myTank.userData?.playerState?.alive);
}

// Whether the local tank is a playing one waiting to respawn, dead or not yet
// spawned, which upstream holds still (`doMotion` only runs `isAlive()`,
// playing.cxx:7336). An observer is never alive and moves anyway: roaming,
// Map Viewer and the phantom tank are all Observer.
function isMyTankFrozenByDeath() {
  return !isObserver() && !isMyTankAlive();
}

// Whether the game is being watched at all: a menu in front of it or a hidden
// window both mean no. `document.hidden` is not that signal in XR -- entering
// an immersive session backgrounds the flat page itself, on top of and not
// instead of watching the game through the headset, and it stays "hidden" for
// as long as the session runs, so treating it as a pause here would pause on
// entry and never find its way back to unpaused.
function shouldAutoPause() {
  if (document.hidden && !isXREnabled()) return true;
  // A menu over a tank a pilot is flying, or one a pilot is chosen for, is
  // not a pause: the pilot goes on driving while the menu has the keys
  // (issue #162). A hidden window still pauses -- the browser stops drawing
  // it, and with the frames goes the pilot.
  if (!isMenuContextActive()) return false;
  return !(isDialogContextActive() && autopilotFliesThroughMenus());
}

function autopilotFliesThroughMenus() {
  return canUseAutopilot() && (autopilotOn || autopilotRowId !== null);
}

// A menu opening with a pilot chosen but not flying puts the pilot on, and
// closing it takes that pilot off again; one already flying is left alone.
function syncAutopilotWithMenu() {
  const covered = isDialogContextActive();
  if (covered === autopilotMenuCovered) return;
  autopilotMenuCovered = covered;
  if (covered) {
    if (!autopilotOn && autopilotRowId !== null && canUseAutopilot() && isMyTankAlive()) {
      setAutopilot(autopilotRowId, { remember: false });
      autopilotMenuEngaged = true;
    }
  } else if (autopilotMenuEngaged) {
    setAutopilot(null, { remember: false });
  }
}

// The Unmap/Map pair (playing.cxx:1211, :1246). Every menu and the window's own
// visibility reconcile through this one function rather than toggling a pause
// each on their own, so opening a menu, hiding the window and showing it again
// leaves the tank paused for as long as the menu is still up. The server owns
// the countdown, so both directions are the same toggle the P key sends: it
// cancels a countdown that has not finished and unpauses one that has.
function syncAutoPause() {
  syncAutopilotWithMenu();
  const send = pauseState.syncMenu({
    covered: shouldAutoPause(),
    alive: isMyTankAlive(),
    observer: isObserver(),
  });
  if (send) sendToServer({ type: 'pause' });
}

// Unmap and Map themselves. A hidden tab is the browser's word for iconified,
// and it is the only one it gives: a window that is merely unfocused is still
// on screen, which upstream does not pause for either.
document.addEventListener('visibilitychange', syncAutoPause);

// What is left of updatePauseCountdown (playing.cxx:6863) once the server owns
// the countdown itself: upstream's own guard on a tank that is no longer alive,
// and the alert that counts the rest of it down where the eye is.
function updatePauseCountdown() {
  // A pause belongs to the life it was taken in. The server abandons its own
  // copy of the countdown the moment the tank dies and sends nothing, so this is
  // the client keeping its copy honest rather than waiting to be told -- it can
  // see its own tank explode. Issue #48 is what the wait cost: a tank shot
  // during the countdown came back playing on the server and frozen here.
  if (!isMyTankAlive() && pauseState.tankDied()) {
    pauseAlertSecondsShown = 0;
    setHudAlert(PAUSE_ALERT_SLOT, null, 0);
    return;
  }
  if (pauseState.countdownStart === 0) {
    if (!destructCountdown.isCounting()) pauseAlertSecondsShown = 0;
    return;
  }
  const remaining = gameConfig.PAUSE_COUNTDOWN - (frameEpochMs - pauseState.countdownStart);
  const seconds = Math.max(1, Math.ceil(remaining / 1000));
  if (seconds === pauseAlertSecondsShown) return;
  pauseAlertSecondsShown = seconds;
  setHudAlert(PAUSE_ALERT_SLOT, `Pausing in ${seconds}`, 1, false);
}

// updateDestructCountdown (playing.cxx:6950), which bzo ends differently: where
// upstream blows the tank up where it stands, bzo asks the server to, because
// the server is what decides a tank died. Everything else is upstream's -- five
// seconds, one alert a second, abandoned with the life, and the key calls it off.
function updateDestructCountdown() {
  const outcome = destructCountdown.tick(frameEpochMs, { alive: isMyTankAlive() });
  if (outcome === 'cleared') {
    pauseAlertSecondsShown = 0;
    setHudAlert(PAUSE_ALERT_SLOT, null, 0);
    return;
  }
  if (outcome === 'fire') {
    pauseAlertSecondsShown = 0;
    setHudAlert(PAUSE_ALERT_SLOT, null, 0);
    sendToServer({ type: 'selfDestruct' });
    return;
  }
  if (!destructCountdown.isCounting()) return;
  const seconds = destructCountdown.secondsLeft(frameEpochMs);
  if (seconds === pauseAlertSecondsShown) return;
  pauseAlertSecondsShown = seconds;
  setHudAlert(PAUSE_ALERT_SLOT, `Self Destructing in ${seconds}`, 1, false);
}
let playerPausedSpheres = new Map(); // Map of playerId to its paused sphere
let deathFollowTarget = null;
// Whether the death camera owns the view. Not `deathFollowTarget` alone: an
// explosion does not always leave a body to chase, and a death with no debris
// still watches the spot it happened from `deathFollowAnchor`. Set on the local
// player's own death and cleared by the respawn, so `cameraMode` underneath
// stays exactly what the player chose.
let deathCameraActive = false;

function isDeathCameraActive() {
  return deathCameraActive;
}

// Computed width resolves the viewport units even while the box is hidden for
// the death camera, which a layout rect would report as zero.
function readBoxHalfExtent(elementId) {
  const element = document.getElementById(elementId);
  if (!element) return 0;
  const width = parseFloat(window.getComputedStyle(element).width);
  return Number.isFinite(width) ? width / 2 : 0;
}

function updateMotionBoxMetrics() {
  motionBoxHalfExtent = readBoxHalfExtent('controlBox');
  motionBoxDeadZone = readBoxHalfExtent('noMotionBox');
}

// One axis of the mapping, matching upstream's per-axis clamp: past the box the
// axis is pinned at full deflection, so pulling the cursor further out steers
// only through whatever the other axis is doing.
function motionBoxAxisInput(offsetPx) {
  const span = motionBoxHalfExtent - motionBoxDeadZone;
  if (!(span > 0)) return 0;
  const beyondDeadZone = Math.abs(offsetPx) - motionBoxDeadZone;
  if (beyondDeadZone <= 0) return 0;
  return Math.sign(offsetPx) * Math.min(1, beyondDeadZone / span);
}

// The motion box, shot status and altimeter are hidden by CSS off this one
// class, rather than by three inline styles.
function updateObserverHudVisibility() {
  // Driving (issue #68) wants exactly what a playing tank's HUD shows --
  // shot status, the touch control box -- so it is excluded here
  // the same way it is from `cameraMode`/`roamFraming` above: `.observing`'s
  // CSS is what hides all of that (see styles.css), and free-roam is the only
  // one of the two with nothing to aim or reload.
  const observing = isObserver() && !isPhantomDriving();
  document.body.classList.toggle('observing', observing);
  document.body.classList.toggle('autopiloting', !observing && autopilotOn);
  // HUDRenderer::renderStatus (HUDRenderer.cxx:1026) prints the roaming label
  // where a playing tank's status would go.
  const status = document.getElementById('roamStatus');
  if (status) {
    const parts = getHudStatusParts(observing);
    // Rebuilt only when the words change, since this runs every frame and the
    // line is usually the same one it was.
    if (status.textContent !== parts.text) {
      status.textContent = '';
      for (const segment of parts.segments) {
        if (!segment.text) continue;
        const span = document.createElement('span');
        span.textContent = segment.text;
        if (Number.isFinite(segment.color)) span.style.color = colorToCSS(segment.color);
        status.appendChild(span);
      }
    }
  }
}

// HUDRenderer::renderStatus: the roaming label for an observer, and
// "AutoPilot on" (HUDRenderer.cxx:1805) for a piloted tank -- here naming the
// pilot.
function getHudStatusParts(observing) {
  if (observing) return getRoamLabelParts();
  if (autopilotOn) {
    // Upstream's "AutoPilot on", naming the pilot and what it is doing.
    const mode = autopilotOutput?.intent?.mode;
    const reason = autopilotOutput?.intent?.reason;
    const text = `AutoPilot ${getAutopilotName(autopilotId)}${mode ? `: ${describePilotIntent(mode, reason)}` : ''}`;
    return { text, segments: [{ text }] };
  }
  return { text: '', segments: [] };
}

function updateDeathCameraHudVisibility() {
  const controlBox = document.getElementById('controlBox');
  if (!controlBox) return;
  const inDeathCamera = isDeathCameraActive();
  controlBox.style.display = inDeathCamera ? 'none' : '';
}

// updateFlag (playing.cxx:1444), which upstream calls on every change of the
// local tank's flag and which restarts the flag help clock each time. bzo asks
// rather than being told: a flag leaves a tank down a good many paths -- put
// down, shaken off, stolen, lost to a death, replaced by the next grab -- and
// a poll cannot miss one of them the way a call added to four of the five
// would. It costs a string compare a frame.
//
// Carrying nothing clears the text, which is what upstream gets out of
// Flags::Null having no help string of its own.
let lastFlagHelpType = null;
function updateFlagHelp() {
  const flagType = getMyFlag()?.type ?? null;
  if (flagType === lastFlagHelpType) return;
  lastFlagHelpType = flagType;
  setFlagHelp(getFlagType(flagType)?.help || '', FLAG_HELP_SECONDS);
}

// Mouse control
let mouseControlEnabled = false;
let mouseX = 0; // Percentage from center (-1 to 1)
let mouseY = 0; // Percentage from center (-1 to 1)
// BZFlag's targeting box is the mouse mapping, not decoration: inside the inner
// box the tank does nothing, and the outer box edge is full deflection
// (playing.cxx:1088-1131). The boxes are sized in CSS, so their geometry is read
// back off them rather than kept a second time here.
let motionBoxHalfExtent = 0;
let motionBoxDeadZone = 0;
function resetMouseSteering() {
  mouseX = 0;
  mouseY = 0;
}
registerGameplayInputReset(resetMouseSteering);

// The preference and the context together. `mouseControlEnabled` is what the
// player asked for and survives a context that cannot honour it; this is
// whether the box is actually steering right now.
function mouseSteeringActive() {
  return mouseControlEnabled && isMouseSteeringAvailable();
}

// Whether a click on the battlefield is a shot. The on-screen controls own the
// whole screen while they are up -- a tap that misses the fire button is a miss,
// not a shot -- and in VR there is no cursor to aim, so a paired mouse's buttons
// are not a trigger either. Not gated on having a fine pointer: a touch that
// lands on the canvas with the overlay off arrives here as a click, and firing
// is the only thing it could mean.
function mouseGameplayClickActive() {
  return !virtualControlsEnabled && !isXREnabled();
}

const DEFAULT_TANK_MODEL_ID = 'bzflag';

let TANK_MODELS = [
  { id: 'bzflag', path: '/obj/bzflag.obj', label: 'BZFlag' },
  { id: 'modern', path: '/obj/modern.obj', label: 'Modern' },
  { id: 'simple', path: '/obj/simple.obj', label: 'Simple' },
  { id: 'wheeled6', path: '/obj/wheeled6.obj', label: 'Wheeled 6' },
  { id: 'bzflag-notracks', path: '/obj/bzflag-notracks.obj', label: 'BZFlag notracks' },
  // Upstream's own two cheaper tanks, which it falls back to at distance and
  // bzo had no equivalent of. Extracted from the BZFlag source rather than
  // from misc/tank.obj, because that file is packaged but never read by the
  // client -- what upstream draws is built in C++, one function per part per
  // level of detail. See scripts/extract-bzflag-lod-tanks.mjs.
  { id: 'bzflag-high', path: '/obj/bzflag-high.obj', label: 'BZFlag High' },
  { id: 'bzflag-medium', path: '/obj/bzflag-medium.obj', label: 'BZFlag Medium' },
  { id: 'bzflag-low', path: '/obj/bzflag-low.obj', label: 'BZFlag Low' },
];
let selectedTankModelId = localStorage.getItem('tankModelId') || DEFAULT_TANK_MODEL_ID;
let tankPreviewCard = null;
let tankPreviewAnimating = false;
// How much of the frame the tank fills. The margin is wider than a flat fit
// needs because the camera is a perspective one looking slightly down: the half
// of a turning tank that swings towards the camera is nearer than the point the
// fit was measured at, so it is magnified past what the measurement predicts.
// Fitting tightly leaves a tank that sits neatly at one angle and pushes out of
// frame a quarter turn later.
const TANK_PREVIEW_FILL = 0.7;
// Where the preview camera aims, shared by the camera and the fit that measures
// from it -- two copies of this number would silently misframe every model.
// The preview stands in the game's axes, on +z, as a tank does in the world.
const TANK_PREVIEW_LOOK_AT = new THREE.Vector3(0, 0, 0.8);
// Only reached before joining on a server with no team colour to borrow.
const TANK_PREVIEW_FALLBACK_COLOR = 0x4caf50;
// The pose a tank is first seen in. A model faces +x unrotated and the camera
// sits at -y, looking north. A half turn about z faces it -x, which from the
// camera is the left: a side-on profile, and the silhouette that tells two
// hulls apart.
const TANK_PREVIEW_START_ROTATION = Math.PI;
// The turntable's spin, in radians of yaw per frame.
const TANK_PREVIEW_SPIN_PER_FRAME = 0.015;
// The longest step the treads will take from one preview frame to the next.
const TANK_PREVIEW_MAX_STEP = 0.1;
let tankPreviewLastFrameAt = 0;
let tankPreviewRafId = null;

function getDefaultTankModel() {
  if (!Array.isArray(TANK_MODELS) || TANK_MODELS.length === 0) {
    return { id: DEFAULT_TANK_MODEL_ID, path: '/obj/bzflag.obj', label: 'BZFlag' };
  }
  return TANK_MODELS.find((model) => model.id === DEFAULT_TANK_MODEL_ID) || TANK_MODELS[0];
}

function getTankModelById(modelId) {
  const normalized = typeof modelId === 'string' ? modelId.trim().toLowerCase() : '';
  return TANK_MODELS.find((model) => model.id === normalized) || null;
}

// What an id means, without asking whether the server is offering it. The
// spelling is settled here; whether the model exists is a separate question,
// and one that cannot be answered until the model list has been fetched.
function canonicalTankModelId(modelId) {
  const normalized = typeof modelId === 'string' ? modelId.trim().toLowerCase() : '';
  if (normalized === 'default') return DEFAULT_TANK_MODEL_ID;
  if (normalized === 'bzflag-tank') return 'bzflag';
  // The treads tank's own name before it became the stock one.
  if (normalized === 'bzflag-treads') return 'bzflag';
  if (normalized === 'tank') return DEFAULT_TANK_MODEL_ID;
  return normalized;
}

// The same, and then held against what the server actually offers: an id for a
// model this server does not have falls back to the default.
function normalizeTankModelId(modelId) {
  const selected = getTankModelById(canonicalTankModelId(modelId));
  return selected ? selected.id : getDefaultTankModel().id;
}

// Canonical only, deliberately. `TANK_MODELS` is still the built-in list at
// this point -- the server's is fetched -- so asking whether the stored model
// exists would answer "no" for every model the built-in list does not happen
// to name, and a player who chose one of those would find themselves back in
// the default tank on every reload. The availability test waits for the fetch.
selectedTankModelId = canonicalTankModelId(selectedTankModelId);

function getTankModelPathById(modelId) {
  const normalizedId = normalizeTankModelId(modelId);
  const selected = getTankModelById(normalizedId);
  return selected ? selected.path : getDefaultTankModel().path;
}

function getTankModelIdFromPlayer(player) {
  return normalizeTankModelId(player && player.tankModel);
}

function updateSelectedTankOptionUI() {
  const currentModel = getTankModelById(selectedTankModelId) || getDefaultTankModel();
  const optionLabel = document.getElementById('tankOptionLabel');
  if (optionLabel) {
    optionLabel.textContent = currentModel.label || currentModel.id;
  }

  const currentOption = document.getElementById('tankCurrentOption');
  if (currentOption) {
    currentOption.classList.add('selected');
    currentOption.dataset.modelId = currentModel.id;
  }

  const disableArrows = TANK_MODELS.length <= 1;
  const prevBtn = document.getElementById('tankPrevBtn');
  const nextBtn = document.getElementById('tankNextBtn');
  if (prevBtn) prevBtn.disabled = disableArrows;
  if (nextBtn) nextBtn.disabled = disableArrows;
}

// Everything a tank choice costs outside the dialog it was made in: the stored
// preference, the model the world draws for this player, and the one message
// that tells everyone else. Kept apart from the selection itself so the entry
// dialog can stage a choice and OK can be what pays for it.
function applySelectedTankModel(modelId) {
  const selected = getTankModelById(normalizeTankModelId(modelId));
  if (!selected) return;
  localStorage.setItem('tankModelId', selected.id);
  renderManager.setTankModel(selected.path);
  if (!gameplayJoinConfirmed || !myPlayerId) return;
  const currentPlayerState = tanks.get(myPlayerId)?.userData?.playerState;
  if (currentPlayerState) {
    addPlayer({
      ...currentPlayerState,
      tankModel: selected.id,
    });
    myTank = tanks.get(myPlayerId);
  }
  sendToServer({
    type: 'setTankModel',
    tankModel: selected.id,
  });
}

function setSelectedTankModel(modelId) {
  const selected = getTankModelById(normalizeTankModelId(modelId));
  if (!selected) return;
  selectedTankModelId = selected.id;
  if (tankPreviewCard) {
    loadTankPreviewModel(selected.path);
  }
  if (pendingJoinRequest) {
    pendingJoinRequest.tankModel = selectedTankModelId;
  }
  // Nothing the entry dialog offers takes effect until OK, and the carousel is
  // one of the things it offers.
  if (!isEntryDialogOpen()) {
    applySelectedTankModel(selectedTankModelId);
  }
  updateSelectedTankOptionUI();
}

// The model a player is looking at, and the ones a single step either side of
// it, because those are the only ones the carousel can reach next.
//
// Every model was fetched up front once, which cost every client the whole
// catalogue whether or not they ever wore any of it: a megabyte and change on
// the wire, and most of a second of OBJ parsing on the main thread -- several
// seconds on a slow one -- before the entry dialog could be used. That price
// grew with each model added, which is the wrong way round for a list meant to
// keep growing. A model nobody has looked at is loaded when somebody does: the
// renderer already fetches a template it does not hold and builds the tank when
// it lands, which is the same path another player's unfamiliar tank takes.
function preloadTankModelsAround(modelId) {
  if (!renderManager || typeof renderManager.preloadTankModel !== 'function') return;
  if (!Array.isArray(TANK_MODELS) || TANK_MODELS.length === 0) return;
  const currentIndex = TANK_MODELS.findIndex((model) => model.id === modelId);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const count = TANK_MODELS.length;
  // Centre first: it is the one being drawn, and the neighbours are only a
  // guess at where the player goes next.
  for (const step of [0, 1, -1]) {
    const model = TANK_MODELS[(safeIndex + step + count) % count];
    if (model && model.path) renderManager.preloadTankModel(model.path);
  }
}

function cycleTankModel(step) {
  if (!Array.isArray(TANK_MODELS) || TANK_MODELS.length === 0) return;
  const currentIndex = TANK_MODELS.findIndex((model) => model.id === selectedTankModelId);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + step + TANK_MODELS.length) % TANK_MODELS.length;
  setSelectedTankModel(TANK_MODELS[nextIndex].id);
  // Now that the carousel has moved, the model beyond the new one is the next
  // it could reach.
  preloadTankModelsAround(TANK_MODELS[nextIndex].id);
}

// The preview is built by the same `createTank` the world uses, so what the
// carousel shows is what spawns: body and turret carry the tank texture in the
// player's own colour, the treads carry `treads.png`, and a model that has
// wheels instead of treads gets wheels.
//
// Its own renderer, and its own scene: two WebGLRenderers each keep their own
// GPU state for a material, and `createTank` hands back a fresh object graph per
// call, so nothing is shared with the world but the canvas-backed texture
// images.
function getPreviewTankColor() {
  // The **staged** team wins, because the dialog stages every choice it offers
  // and this preview is what the staged choices would look like -- showing the
  // colour of the team being left behind is showing the wrong answer to the
  // question the player is in the middle of asking.
  //
  // Only where the staging says nothing does the current colour stand in: a
  // team of Automatic names no colour, and on a server with team play off
  // neither does Rogue -- there every player gets a distinct colour of their
  // own, so their own is the honest preview.
  const team = getSelectedPlayerTeam();
  // Observer names a colour on every server, so staging it always answers:
  // upstream's flat white, which is what an observer is given whatever the team
  // mode -- see getJoinPlayerColor. The colour-team test below is about whether
  // *Rogue* names one, and on a world with no colour teams it does not.
  // Map Viewer (issue #68) is staged the same way here, before it becomes a
  // plain `observer` join at send time -- also flat white, and for the same
  // reason: no hue of its own to shade.
  if (isObserverTeam(team) || team === PLAYER_TEAM.MAP_VIEWER) return getPlayerTeamColor(PLAYER_TEAM.OBSERVER);
  const staged = team !== PLAYER_TEAM.AUTOMATIC
    && availablePlayerTeams.some(isColorTeam)
    && PLAYER_TEAM_COLORS[team] !== undefined;
  if (staged) return PLAYER_TEAM_COLORS[team];
  const mine = tanks.get(myPlayerId)?.userData?.playerState?.color;
  if (Number.isFinite(mine)) return mine;
  return TANK_PREVIEW_FALLBACK_COLOR;
}

// The camo options that go with that preview colour, by the same staging rule.
// A rogue's tank is grey wherever Rogue names a team (see getTankCamoOptions),
// so a preview that showed the scoreboard's yellow would be promising a tank
// the player is not about to get.
//
// Automatic stages nothing here, for the reason it stages no colour above: the
// team is the server's to choose, so there is no answer yet to show. It falls
// through to the player's own tank, or to TANK_PREVIEW_FALLBACK_COLOR's green
// before there is one, and a rogue is not what either of those is.
function getPreviewTankCamoOptions() {
  const team = getSelectedPlayerTeam();
  return {
    rogue: team === PLAYER_TEAM.ROGUE && availablePlayerTeams.some(isColorTeam),
  };
}

// Fill the canvas rather than a fixed 2.7 units: the frame is what the player
// sees, and a model is only as big as its own bounding box says. The visible
// extent is measured at the model's own distance, so the fit holds for any
// aspect ratio the dialog is laid out at and for models of any proportion.
// Measured **once**, while the tank still has no parent, and the numbers kept.
// `Box3.setFromObject` reports a *world* box, so measuring a tank that already
// sits inside the spinning group returns its box at whatever angle the spin has
// reached -- and writing that centre into a position that lives in the rotated
// frame moves the tank off the pivot by an amount that depends on the angle.
// A resize is a refit, and the observer fires one as the dialog opens, so that
// showed up as a tank orbiting its own tread instead of turning about itself.
function measureTankModel(tank) {
  tank.scale.setScalar(1);
  tank.position.set(0, 0, 0);
  tank.rotation.set(0, 0, 0);
  tank.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(tank);
  return {
    size: bounds.getSize(new THREE.Vector3()),
    center: bounds.getCenter(new THREE.Vector3()),
    minZ: bounds.min.z,
  };
}

function fitTankPreviewToView() {
  const { camera, modelInner: tank, modelMeasure: measure } = tankPreviewCard;
  if (!tank || !measure) return;
  const { size, center, minZ } = measure;
  if (!(size.x > 0) || !(size.z > 0)) return;

  const distance = camera.position.distanceTo(TANK_PREVIEW_LOOK_AT);
  const visibleHeight = 2 * Math.tan((camera.fov * Math.PI) / 360) * distance;
  const visibleWidth = visibleHeight * camera.aspect;

  // The tank turns while it is previewed, so the width it needs is its widest
  // horizontal reach -- the diagonal of its footprint -- not whichever of x and
  // y happens to face the camera at this instant. Otherwise it fits at one angle
  // and clips a quarter turn later.
  const turningWidth = Math.hypot(size.x, size.y);
  const scale = Math.min(
    (visibleWidth * TANK_PREVIEW_FILL) / turningWidth,
    (visibleHeight * TANK_PREVIEW_FILL) / size.z,
  );

  tank.scale.setScalar(scale);
  // Centred on the two axes it turns around, and standing on the floor rather
  // than centred vertically, which is how a tank is seen everywhere else.
  tank.position.set(-center.x * scale, -center.y * scale, -minZ * scale);
  return scale * Math.max(size.x, size.y);
}

// The canvas is sized by CSS and the drawing buffer has to follow it, or the
// preview is drawn at whatever size the dialog happened to be when it was
// built -- which, for a dialog that starts hidden, is no size at all and a
// fallback. Called from a ResizeObserver, so opening the dialog, rotating a
// phone and resizing a window all arrive the same way.
function resizeTankPreview() {
  if (!tankPreviewCard) return;
  const { renderer, camera } = tankPreviewCard;
  const canvas = renderer.domElement;
  const width = Math.floor(canvas.clientWidth);
  const height = Math.floor(canvas.clientHeight);
  // A hidden dialog measures zero. Keeping the last good size means reopening
  // it does not have to rebuild anything.
  if (width < 1 || height < 1) return;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  // The fit was measured against the old frustum, so it has to be measured
  // again -- a wider frame is room the tank should be using.
  if (tankPreviewCard.modelInner) {
    const footprint = fitTankPreviewToView();
    if (tankPreviewCard.floor && footprint) tankPreviewCard.floor.scale.setScalar(footprint * 0.62);
  }
  if (!tankPreviewAnimating) renderer.render(tankPreviewCard.scene, camera);
}

// Rebuilds the preview in the colour `getPreviewTankColor` now returns. The
// texture is painted from the colour when the tank is built, so this is a
// rebuild rather than a material tweak -- and it costs nothing when the dialog
// has never been opened, because there is no preview to rebuild.
function refreshTankPreviewColor() {
  if (!tankPreviewCard || !tankPreviewCard.requestedModelPath) return;
  loadTankPreviewModel(tankPreviewCard.requestedModelPath);
}

function loadTankPreviewModel(modelPath) {
  if (!tankPreviewCard || !modelPath) return;

  const { scene } = tankPreviewCard;
  tankPreviewCard.requestedModelPath = modelPath;

  renderManager.whenTankModelReady(modelPath).then(() => {
    // A slow model and a fast carousel: by the time this resolves the player may
    // have walked on to another tank, and drawing the one they left would be
    // worse than drawing nothing.
    if (!tankPreviewCard || tankPreviewCard.requestedModelPath !== modelPath) return;

    if (tankPreviewCard.modelRoot) {
      scene.remove(tankPreviewCard.modelRoot);
      tankPreviewCard.modelRoot = null;
      tankPreviewCard.modelInner = null;
      tankPreviewCard.modelMeasure = null;
    }

    const tank = renderManager.createTank(
      getPreviewTankColor(), '', modelPath, getPreviewTankCamoOptions());
    if (!tank) return;
    // Two groups: the inner tank is centred and scaled to the frame, and the
    // outer one only turns. Rotating the group that carries the centring offset
    // would swing the tank around the frame instead of about itself.
    // Measured while it is still parentless, so the box is the model's own and
    // no ancestor's rotation can lean into it.
    tankPreviewCard.modelMeasure = measureTankModel(tank);
    const root = new THREE.Group();
    root.add(tank);
    tankPreviewCard.modelInner = tank;
    const footprint = fitTankPreviewToView();
    root.rotation.z = TANK_PREVIEW_START_ROTATION;
    scene.add(root);
    tankPreviewCard.modelRoot = root;
    // The floor is a shadow under this tank, so it is sized from this tank.
    if (tankPreviewCard.floor && footprint) {
      tankPreviewCard.floor.scale.setScalar(footprint * 0.62);
    }
  }).catch((error) => {
    console.warn('Failed to build tank preview:', error);
  });
}

async function fetchTankModels() {
  try {
    const response = await fetch('/api/tank-models', { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.models)) return;

    const models = payload.models
      .filter((model) => model && typeof model.id === 'string' && typeof model.path === 'string')
      .map((model) => ({
        id: model.id.trim().toLowerCase(),
        path: model.path,
        label: model.label || model.id,
      }))
      .sort((left, right) => {
        if (left.id === DEFAULT_TANK_MODEL_ID) return -1;
        if (right.id === DEFAULT_TANK_MODEL_ID) return 1;
        return left.id.localeCompare(right.id);
      });

    if (models.length > 0) {
      TANK_MODELS = models;
      const normalizedSelectedTankModelId = normalizeTankModelId(selectedTankModelId);
      if (normalizedSelectedTankModelId !== selectedTankModelId) {
        localStorage.setItem('tankModelId', normalizedSelectedTankModelId);
      }
      selectedTankModelId = normalizedSelectedTankModelId;
      preloadTankModelsAround(selectedTankModelId);
    }
  } catch (error) {
    console.warn('Failed to fetch tank model list:', error);
  }
}

function animateTankPreviews() {
  if (!tankPreviewAnimating) return;
  const now = performance.now();
  // A dialog that was closed, or a tab left in the background, comes back with
  // a gap no tread should cover in one step. The first frame of a run has no
  // previous one to measure from and simply does not move the treads.
  const deltaTime = tankPreviewLastFrameAt
    ? Math.min(TANK_PREVIEW_MAX_STEP, (now - tankPreviewLastFrameAt) / 1000)
    : 0;
  tankPreviewLastFrameAt = now;

  if (tankPreviewCard) {
    if (tankPreviewCard.modelRoot) {
      tankPreviewCard.modelRoot.rotation.z += TANK_PREVIEW_SPIN_PER_FRAME;
    }
    // The preview tank is not driving anywhere, it is turning on the spot, so
    // its treads run the way a tank spinning in place runs them: one forward,
    // one back, at the speed the turntable is actually going. The renderer's
    // own tread update does the work rather than the textures being scrolled
    // here, which keeps one account of how fast a tread runs and turns a
    // wheeled model's wheels for free.
    const previewTank = tankPreviewCard.modelInner;
    if (previewTank && deltaTime > 0 && renderManager) {
      const tankRotationSpeed = gameConfig ? gameConfig.TANK_ROTATION_SPEED : 2;
      previewTank.userData.forwardSpeed = 0;
      previewTank.userData.rotationSpeed = TANK_PREVIEW_SPIN_PER_FRAME
        / (tankRotationSpeed * deltaTime);
      renderManager.updateTreads([previewTank], deltaTime, gameConfig);
    }
    tankPreviewCard.renderer.render(tankPreviewCard.scene, tankPreviewCard.camera);
  }
  tankPreviewRafId = requestAnimationFrame(animateTankPreviews);
}

function startTankPreviewAnimation() {
  if (tankPreviewAnimating) return;
  tankPreviewAnimating = true;
  tankPreviewLastFrameAt = 0;
  animateTankPreviews();
}

function stopTankPreviewAnimation() {
  tankPreviewAnimating = false;
  if (tankPreviewRafId !== null) {
    cancelAnimationFrame(tankPreviewRafId);
    tankPreviewRafId = null;
  }
}

async function initTankSelector() {
  const canvas = document.getElementById('tankPreviewCanvas');
  if (!canvas) return;

  const width = Math.max(120, Math.floor(canvas.clientWidth || 120));
  const height = Math.max(80, Math.floor(canvas.clientHeight || 80));

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(width, height, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
  camera.position.set(0, -7.2, 2.4);
  camera.up.set(0, 0, 1);
  camera.lookAt(TANK_PREVIEW_LOOK_AT);

  const ambient = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambient);
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.7);
  keyLight.position.set(3, -4, 5);
  scene.add(keyLight);

  // Unit radius, scaled to whichever tank is standing on it: the models differ
  // in footprint, and a disc sized for one of them reads as a puddle under
  // another.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(1, 24),
    new THREE.MeshBasicMaterial({ color: 0x123018, transparent: true, opacity: 0.35 }),
  );
  floor.position.z = -0.05;
  scene.add(floor);

  tankPreviewCard = {
    renderer, scene, camera, floor,
    modelRoot: null, modelInner: null, modelMeasure: null, requestedModelPath: null,
  };

  // The dialog is hidden when this runs, so the size above is a fallback and
  // this is what corrects it -- a ResizeObserver fires on the transition out of
  // zero, which is exactly the moment the dialog opens.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => resizeTankPreview()).observe(canvas);
  } else {
    window.addEventListener('resize', resizeTankPreview);
  }

  const prevBtn = document.getElementById('tankPrevBtn');
  const nextBtn = document.getElementById('tankNextBtn');
  if (prevBtn) prevBtn.addEventListener('click', () => cycleTankModel(-1));
  if (nextBtn) nextBtn.addEventListener('click', () => cycleTankModel(1));
  // The carousel is a choice row like the team selector above it, so left and
  // right walk the tanks while the focus is anywhere inside it -- which is what
  // a thumbstick has instead of reaching for one arrow or the other.
  document.getElementById('tankSelector')?.addEventListener('menuadjust', (event) => {
    cycleTankModel(Number(event.detail?.direction) < 0 ? -1 : 1);
    event.preventDefault();
  });

  await fetchTankModels();
  selectedTankModelId = normalizeTankModelId(selectedTankModelId);
  setSelectedTankModel(selectedTankModelId);
}

// This tank, in upstream's frame: (x, y) on the ground, z up, and the azimuth
// counter-clockwise from +x.
let myX = 0;
let myY = 0;
let myZ = 0;
let myAzimuth = Math.PI / 2;
// The observer's roaming camera, held only while observing. See roam.mjs.
let roamCamera = null;
// Set while phantom-driving (DRIVE_FP/DRIVE_TP), whose own tank physics move
// `myTank` without touching `roamCamera` at all -- read on the frame that
// drops back out of it, so free roam (and every other camera-driven view)
// picks up from wherever driving actually left the tank rather than resuming
// the stale spot `roamCamera` was still parked at from before driving began.
let wasPhantomDriving = false;
let roamView = ROAM_VIEW.FREE;
// null is upstream's `targetManual == -1`: follow whoever is leading.
let roamTargetId = null;
let roamTargetFlagIndex = null;
// Identify picks a target, which is an edge rather than a held state.
let roamIdentifyWasHeld = false;
// -Infinity so the first frame of observing sends one rather than waiting out
// an interval the camera has not been alive for.
let lastObserverHeartbeatAt = -Infinity;
// Where that last update said the camera was, so a camera that has since gone
// somewhere else can correct it before the next heartbeat comes due.
let lastObserverSentX = 0;
let lastObserverSentY = 0;
let lastObserverSentZ = 0;

// Dead reckoning state - track last sent velocities (not positions, since positions are extrapolated)
let lastSentForwardSpeed = 0;
let lastSentRotationSpeed = 0;
let lastSentVerticalVelocity = 0;
let lastSentAirVelocityX = 0;
let lastSentAirVelocityY = 0;
let lastSentTime = 0;
// The heading the last move carried, for `_angleTolerance`'s drift check.
let lastSentHeading = null;
let worldTime = 0;

// The sky's clock, each frame. Upstream's (#166) is the real instant -- or the
// frozen one `_syncTime` names -- read off the wall clock every client shares,
// at the world's `_latitude` and `_longitude`; the renderer moves the sky only
// every few seconds of it. `SKY: 'minecraft'` is bzo's day clock instead: a
// real day's 24000 ticks at `DAY_SPEED` 1, its default 72 a 20-minute day,
// and 0 holds the sky where the server said it was.
function updateSkyClock(deltaTime) {
  if (gameConfig?.SKY === 'minecraft') {
    const daySpeed = Number.isFinite(gameConfig?.DAY_SPEED) ? gameConfig.DAY_SPEED : 72;
    worldTime = (worldTime + ((24000 / 86400) * daySpeed * deltaTime)) % 24000;
    renderManager.setWorldTime(worldTime);
    return;
  }
  const sync = gameConfig?.SYNC_TIME;
  const seconds = Number.isFinite(sync) && sync >= 0 ? sync : frameEpochMs / 1000;
  renderManager.setCelestialTime(
    seconds,
    Number.isFinite(gameConfig?.LATITUDE) ? gameConfig.LATITUDE : 37.5,
    Number.isFinite(gameConfig?.LONGITUDE) ? gameConfig.LONGITUDE : 122,
  );
}
let chatWindowDirty = true;
let cachedCollisionColliders = null;
// Velocity-based thresholds: only send when velocity changes significantly
// Thresholds must be large enough to avoid noise from frame-to-frame velocity calculation variations
const VELOCITY_THRESHOLD = 0.15; // Send if forward/rotation speed changes by 15%
const VERTICAL_VELOCITY_THRESHOLD = 1.0; // Send if vertical velocity changes significantly
// How long this client will go without reporting, whatever the tank is doing.
// The server's, because it is the server that decides what silence means: bzo
// extrapolates between packets and keeps the socket alive with WebSocket
// pings, while a proxied connection is answering a bzfs, which takes the flag
// of a player it has not heard from (see `MAX_UPDATE_INTERVAL` in server.js).
// The fallback is bzo's own default, for an `init` that predates the field.
const MAX_UPDATE_INTERVAL_DEFAULT = 5000;
function getMaxUpdateInterval() {
  const configured = Number(gameConfig?.MAX_UPDATE_INTERVAL);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : MAX_UPDATE_INTERVAL_DEFAULT;
}
const DEAD_STICK_STOP_THRESHOLD = 0.03; // Force an update when ground motion settles to near-zero
const MAX_REMOTE_EXTRAPOLATION_STOP_SECONDS = 0.3; // Short horizon only when replicated state is fully stopped
// The occupant height every tank collision test measures with. Upstream passes
// `getDimensions()[2]`, which is _tankHeight; bzo's collision tests have always
// used a flat 2 for it, so it is named here rather than repeated.
const JUMP_PATH_MAX_TIME = 4.0;
const JUMP_PATH_STEP_TIME = 0.12;

// Extrapolation state
// Tracks repeated low-progress face contacts so we can nudge out of corner pockets.
let supportSurfaceDebugMarker = null;
let surfaceOutlineDebugMarker = null;
let supportSurfaceDebugTouchedThisFrame = false;
// Toggle for ghost meshes and debug geometry
let showDebugGeometry = readStoredFlag('showDebugGeometry', readStoredFlag('showGhosts'));

// Debug tracking
let debugEnabled = false;
let debugLabelsEnabled = readStoredFlag('debugLabelsEnabled');
renderManager.setDebugLabelsEnabled(debugLabelsEnabled);
const packetsSent = new Map();
const packetsReceived = new Map();

function ensureSurfaceOutlineDebugMarker() {
  if (!showDebugGeometry) return null;
  if (surfaceOutlineDebugMarker || !scene) return surfaceOutlineDebugMarker;
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.LineBasicMaterial({
    color: 0xffb347,
    transparent: true,
    opacity: 0.95,
    depthWrite: false
  });
  surfaceOutlineDebugMarker = new THREE.LineLoop(geometry, material);
  surfaceOutlineDebugMarker.visible = false;
  renderManager.getWorldFrame().add(surfaceOutlineDebugMarker);
  return surfaceOutlineDebugMarker;
}

function ensureSupportSurfaceDebugMarker() {
  if (!showDebugGeometry) return null;
  if (supportSurfaceDebugMarker || !scene) return supportSurfaceDebugMarker;
  const markerGroup = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.1, 4.5, 10),
    new THREE.MeshBasicMaterial({ color: 0xff4d9d, transparent: true, opacity: 0.85 })
  );
  // A cylinder is built along its own y, and stood up on z.
  pole.rotation.x = Math.PI / 2;
  pole.position.z = 2.25;
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 0.18, 16),
    new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.95 })
  );
  cap.rotation.x = Math.PI / 2;
  cap.position.z = 4.6;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false }));
  label.position.set(0, 0, 5.7);
  label.scale.set(3.4, 0.85, 1);
  markerGroup.userData.nameLabel = label;
  markerGroup.add(pole);
  markerGroup.add(cap);
  markerGroup.add(label);
  markerGroup.visible = false;
  renderManager.getWorldFrame().add(markerGroup);
  supportSurfaceDebugMarker = markerGroup;
  return supportSurfaceDebugMarker;
}

function clearJumpPredictionDebug(tank) {
  if (!tank?.userData?.jumpPredictionDebug) return;
  const debugGroup = tank.userData.jumpPredictionDebug;
  debugGroup.removeFromParent();
  debugGroup.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) {
        child.material.forEach((material) => material.dispose());
      } else {
        child.material.dispose();
      }
    }
  });
  tank.userData.jumpPredictionDebug = null;
}

function ensureJumpPredictionDebug(tank, mode = 'received') {
  if (!tank) return null;
  if (tank.userData.jumpPredictionDebug) return tank.userData.jumpPredictionDebug;

  const playerColor = tank.userData?.playerState?.color;
  const baseColor = lightenHexColor(
    typeof playerColor === 'number' ? playerColor : (mode === 'sent' ? 0x7cf29a : 0x7cd6ff),
    mode === 'sent' ? 0.25 : 0.35
  );
  const landingColor = baseColor.clone().lerp(new THREE.Color(0xffffff), 0.25);

  const group = new THREE.Group();
  const lineGeometry = new THREE.BufferGeometry();
  const lineMaterial = new THREE.LineBasicMaterial({
    color: baseColor.getHex(),
    transparent: true,
    opacity: 0.8,
    depthWrite: false
  });
  const line = new THREE.Line(lineGeometry, lineMaterial);

  const landingRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.9, 0.08, 8, 24),
    new THREE.MeshBasicMaterial({
      color: landingColor.getHex(),
      transparent: true,
      opacity: 0.9,
      depthWrite: false
    })
  );

  const landingPillar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 1.2, 10),
    new THREE.MeshBasicMaterial({
      color: landingColor.getHex(),
      transparent: true,
      opacity: 0.55,
      depthWrite: false
    })
  );
  // A cylinder stands along y; the world's up is z.
  landingPillar.rotation.x = Math.PI / 2;
  landingPillar.position.z = 0.6;

  group.add(line);
  group.add(landingRing);
  group.add(landingPillar);
  group.userData = { line, landingRing, landingPillar, mode };
  group.visible = false;
  // In the world's own frame: a torus lies flat in xy as it is built.
  renderManager.getWorldFrame().add(group);
  tank.userData.jumpPredictionDebug = group;
  return group;
}

function samplePredictedAirPath(state) {
  if (!state || !gameConfig) return null;
  const points = [];
  const stepTime = JUMP_PATH_STEP_TIME;
  const maxSteps = Math.max(4, Math.floor(JUMP_PATH_MAX_TIME / stepTime));
  const gravity = hasAirControl(state.flagType) ? gameConfig.WINGS_GRAVITY : gameConfig.GRAVITY;
  let landed = false;
  let landingPoint = null;

  for (let step = 0; step <= maxSteps; step += 1) {
    const t = step * stepTime;
    const pos = extrapolatePosition(state, t);
    let pointZ = pos.z;
    let landedType = null;

    const pathGroundLimit = getGroundLimit(state.flagType ?? null);
    if (pos.z <= pathGroundLimit) {
      pointZ = pathGroundLimit;
      landed = true;
      landedType = 'ground';
    }

    points.push(new THREE.Vector3(pos.x, pos.y, pointZ));
    if (landed) {
      landingPoint = { x: pos.x, y: pos.y, z: pointZ, type: landedType };
      break;
    }
  }

  if (!landed) {
    const initialZ = Number.isFinite(state.z) ? state.z : 0;
    const initialVV = Number.isFinite(state.verticalVelocity) ? state.verticalVelocity : 0;
    const discriminant = (initialVV * initialVV) + (2 * gravity * initialZ);
    if (gravity > 0 && discriminant >= 0) {
      const landingTime = (initialVV + Math.sqrt(discriminant)) / gravity;
      if (Number.isFinite(landingTime) && landingTime > 0) {
        const landingPos = extrapolatePosition(state, landingTime);
        points.push(new THREE.Vector3(landingPos.x, landingPos.y, 0));
        landingPoint = { x: landingPos.x, y: landingPos.y, z: 0, type: 'ground' };
      }
    }
  }

  if (points.length < 2) {
    const pos = extrapolatePosition(state, 0);
    points.push(new THREE.Vector3(pos.x, pos.y, pos.z));
    points.push(new THREE.Vector3(pos.x, pos.y, Math.max(0, pos.z - 0.01)));
  }

  return {
    points,
    landingPoint: landingPoint || {
      x: points[points.length - 1].x,
      y: points[points.length - 1].y,
      z: points[points.length - 1].z,
      type: 'projected'
    }
  };
}

function updateJumpPredictionDebug(tank, state, mode = 'received') {
  if (!tank) return;
  const airborne = state && state.jumpAzimuth !== null && state.jumpAzimuth !== undefined;
  if (!airborne) {
    if (tank.userData.jumpPredictionDebug) {
      tank.userData.jumpPredictionDebug.visible = false;
    }
    return;
  }

  const prediction = samplePredictedAirPath(state);
  if (!prediction) return;

  const debugGroup = ensureJumpPredictionDebug(tank, mode);
  if (!debugGroup) return;
  const { line, landingRing, landingPillar } = debugGroup.userData;
  if (!line) return;

  if (line.geometry) {
    line.geometry.dispose();
  }
  line.geometry = new THREE.BufferGeometry().setFromPoints(prediction.points);
  line.geometry.computeBoundingSphere();

  const landing = prediction.landingPoint;
  if (landingRing) {
    landingRing.position.set(landing.x, landing.y, landing.z + 0.05);
  }
  if (landingPillar) {
    landingPillar.position.set(landing.x, landing.y, landing.z + 0.6);
  }
  debugGroup.visible = showDebugGeometry;
}

function ensurePacketMotionDebug(targetObject, mode = 'received') {
  if (!showDebugGeometry || !targetObject) return null;
  if (targetObject.userData.packetMotionDebug) return targetObject.userData.packetMotionDebug;

  // In the tank's own axes: x forward, y to port, z up. A cylinder or a cone
  // is built along its own y, and turned to the axis it shows.
  const motionGroup = new THREE.Group();
  motionGroup.position.set(0, 0, 3.1);

  const linearGroup = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 1.4, 10),
    new THREE.MeshBasicMaterial({ color: mode === 'sent' ? 0x7cf29a : 0x7cd6ff, transparent: true, opacity: 0.9 })
  );
  shaft.rotation.z = -Math.PI / 2;
  shaft.position.x = 0.7;
  shaft.userData.baseLength = 1.4;
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 0.55, 12),
    new THREE.MeshBasicMaterial({ color: mode === 'sent' ? 0xc9ff6a : 0xfff36a, transparent: true, opacity: 0.95 })
  );
  head.rotation.z = -Math.PI / 2;
  head.position.x = 1.55;
  head.userData.baseOffset = 1.55;
  linearGroup.add(shaft);
  linearGroup.add(head);

  const verticalGroup = new THREE.Group();
  const verticalShaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 1.2, 10),
    new THREE.MeshBasicMaterial({ color: 0xff9f43, transparent: true, opacity: 0.9 })
  );
  verticalShaft.userData.baseLength = 1.2;
  verticalShaft.rotation.x = Math.PI / 2;
  verticalShaft.position.z = 0.6;
  const verticalHead = new THREE.Mesh(
    new THREE.ConeGeometry(0.2, 0.45, 12),
    new THREE.MeshBasicMaterial({ color: 0xff6b6b, transparent: true, opacity: 0.95 })
  );
  verticalHead.userData.baseOffset = 1.35;
  verticalHead.rotation.x = Math.PI / 2;
  verticalHead.position.z = 1.35;
  verticalGroup.add(verticalShaft);
  verticalGroup.add(verticalHead);

  const turnRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.0, 0.04, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0xff7ad9, transparent: true, opacity: 0.35 })
  );
  turnRing.position.z = 0.15;

  const turnIndicator = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 0.5, 12),
    new THREE.MeshBasicMaterial({ color: 0xff7ad9, transparent: true, opacity: 0.95 })
  );
  turnIndicator.rotation.z = Math.PI;
  turnIndicator.position.set(0, -1.0, 0.15);
  turnIndicator.userData.baseOffset = 1.0;

  const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false }));
  label.position.set(0, 0, 1.7);
  label.scale.set(4.2, 0.95, 1);

  motionGroup.userData = { linearGroup, verticalGroup, turnRing, turnIndicator, nameLabel: label, mode };
  motionGroup.add(linearGroup);
  motionGroup.add(verticalGroup);
  motionGroup.add(turnRing);
  motionGroup.add(turnIndicator);
  motionGroup.add(label);
  motionGroup.visible = false;
  targetObject.add(motionGroup);
  targetObject.userData.packetMotionDebug = motionGroup;
  return motionGroup;
}

function updatePacketMotionDebug(targetObject, packetState, mode = 'received') {
  if (!targetObject) return;
  const gizmo = ensurePacketMotionDebug(targetObject, mode);
  if (!gizmo) return;
  targetObject.userData.hasPacketState = true;

  const linearGroup = gizmo.userData.linearGroup;
  const verticalGroup = gizmo.userData.verticalGroup;
  const turnRing = gizmo.userData.turnRing;
  const turnIndicator = gizmo.userData.turnIndicator;
  const label = gizmo.userData.nameLabel;

  const fs = Number.isFinite(packetState?.fs) ? packetState.fs : 0;
  const rs = Number.isFinite(packetState?.rs) ? packetState.rs : 0;
  // The gizmo hangs off the tank, so only the angle between the way it moves
  // and the way it faces matters.
  const vx = Number.isFinite(packetState?.vx) ? packetState.vx : 0;
  const vy = Number.isFinite(packetState?.vy) ? packetState.vy : 0;
  const vv = Number.isFinite(packetState?.vv) ? packetState.vv : 0;
  const r = Number.isFinite(packetState?.a) ? packetState.a : tankAzimuth(targetObject);
  const moveAzimuth = packetState?.sd ?? packetState?.jumpAzimuth;
  const moveDirection = Number.isFinite(moveAzimuth) ? moveAzimuth : r;
  const tankSpeed = gameConfig?.TANK_SPEED || 12.5;

  const airSpeed = Math.hypot(vx, vy);
  const hasAirVector = airSpeed > 0.01;
  let displayDirection = moveDirection;
  let speedMagnitude = Math.abs(fs);
  if (hasAirVector) {
    displayDirection = Math.atan2(vy, vx);
    speedMagnitude = airSpeed / tankSpeed;
  } else if (fs < 0) {
    displayDirection += Math.PI;
  }
  speedMagnitude = Math.max(0, Math.min(1.5, speedMagnitude));

  if (linearGroup) {
    const arrowScale = Math.max(0.18, speedMagnitude);
    const shaft = linearGroup.children[0];
    const head = linearGroup.children[1];
    linearGroup.visible = speedMagnitude > 0.01;
    linearGroup.rotation.z = displayDirection - r;
    if (shaft) {
      shaft.scale.set(1, arrowScale, 1);
      shaft.position.x = (shaft.userData.baseLength || 1.4) * arrowScale * 0.5;
    }
    if (head) {
      head.position.x = (head.userData.baseOffset || 1.55) * arrowScale;
    }
  }

  if (verticalGroup) {
    const jumpVelocity = gameConfig?.JUMP_VELOCITY || 22;
    const verticalMagnitude = Math.min(1.5, Math.abs(vv) / jumpVelocity);
    const activeVertical = verticalMagnitude > 0.01;
    const verticalShaft = verticalGroup.children[0];
    const verticalHead = verticalGroup.children[1];
    verticalGroup.visible = activeVertical;
    if (activeVertical) {
      const arrowScale = Math.max(0.2, verticalMagnitude);
      if (verticalShaft) {
        verticalShaft.scale.set(1, arrowScale, 1);
        verticalShaft.position.z = (verticalShaft.userData.baseLength || 1.2) * arrowScale * 0.5;
      }
      if (verticalHead) {
        verticalHead.scale.set(1, arrowScale, 1);
        verticalHead.position.z = (verticalHead.userData.baseOffset || 1.35) * arrowScale;
        verticalHead.rotation.x = vv >= 0 ? Math.PI / 2 : -Math.PI / 2;
      }
    }
  }

  if (turnRing && turnIndicator) {
    const turnMagnitude = Math.min(1.5, Math.abs(rs));
    const activeTurn = turnMagnitude > 0.01;
    turnRing.visible = activeTurn;
    turnIndicator.visible = activeTurn;
    if (activeTurn) {
      const turnScale = Math.max(0.2, turnMagnitude);
      const turnOffset = (turnIndicator.userData.baseOffset || 1.0) * turnScale;
      // A left turn points the cone to port, on the port side.
      turnIndicator.position.y = rs >= 0 ? turnOffset : -turnOffset;
      turnIndicator.rotation.z = rs >= 0 ? 0 : Math.PI;
      turnIndicator.scale.set(1, turnScale, 1);
      turnRing.material.opacity = 0.2 + Math.min(0.5, turnMagnitude * 0.35);
    }
  }

  if (label) {
    renderManager.updateSpriteLabel(
      label,
      `f:${fs.toFixed(2)} r:${rs.toFixed(2)}`,
      mode === 'sent' ? '#7cf29a' : '#7cd6ff'
    );
    label.visible = true;
  }

  gizmo.visible = showDebugGeometry;
}

function showSupportSurfaceDebug(obstacle, position) {
  if (!showDebugGeometry || !obstacle || !position) return;
  const marker = ensureSupportSurfaceDebugMarker();
  if (!marker) return;
  marker.position.copy(position);
  if (marker.userData.nameLabel) {
    renderManager.updateSpriteLabel(marker.userData.nameLabel, obstacle.name || 'support', '#ffb347');
    marker.userData.nameLabel.visible = true;
  }
  marker.visible = true;
  supportSurfaceDebugTouchedThisFrame = true;
}

function hideSupportSurfaceDebug() {
  if (supportSurfaceDebugMarker) supportSurfaceDebugMarker.visible = false;
}

function hideSurfaceOutlineDebug() {
  if (surfaceOutlineDebugMarker) surfaceOutlineDebugMarker.visible = false;
}

// The face of the last obstacle the step met, outlined. It is read off the
// obstacle and the hit normal rather than off a support record, because there is
// no support record any more: a flat top is the obstacle's own top rectangle,
// and a slope is the triangle from the apex down the face the normal names.
function getMotionSurfaceOutlinePoints(obstacle) {
  if (!obstacle) return null;
  const epsilon = 0.06;

  // A mesh has no `size`/`angle` to reconstruct a footprint from -- its own
  // faces already are the footprint, in world space already, so the outline
  // is simply whichever face the tank is actually touching, found the same
  // way `getTankHitNormal`'s own mesh case does (the oriented box when there
  // is a heading to orient it by, the plain cylinder otherwise).
  //
  // A stop square-on to a face backs the tank off by `TINY_DISTANCE * mag`
  // (motion.cjs), and `mag` there is the *full* velocity dotted against the
  // normal -- largest precisely when the hit is square-on, smallest at a
  // shallow slide. A re-query at the tank's exact resting spot, with no
  // slack of its own, finds a shallow-angle face fine and just misses a
  // square one it backed off from a hair further -- `DEBUG_OUTLINE_SLACK`
  // is comfortably past any speed a tank actually reaches (see V_High_Speed,
  // `flags.mjs`) so this reads as "touching" either way, the way the debug
  // outline always should for whatever the tank is actually resting against.
  if (obstacle.type === 'mesh') {
    // The query box only ever reaches upward from the point it is asked
    // at (`findMeshHitFaceOriented`'s own `[0, height]`, matching a tank's
    // feet-at-the-query-point shape) -- fine for a wall, where the slack
    // above only needs to widen the footprint, but resting square on a
    // *roof* backs the tank off upward by that same tiny amount, which can
    // leave the roof's own plane just below this query's floor instead of
    // inside it. Asking a touch below the tank instead, with the extra slack
    // folded into `queryHeight` on top of that, straddles the true surface
    // regardless of which side the backoff nudged it to.
    const DEBUG_OUTLINE_SLACK = 0.5;
    const tankScale = getMyTankScale();
    const halfWidth = (TANK.halfWidth * (tankScale ? tankScale.width : 1)) + DEBUG_OUTLINE_SLACK;
    const halfLength = (TANK.halfLength * (tankScale ? tankScale.length : 1)) + DEBUG_OUTLINE_SLACK;
    const queryZ = myZ - DEBUG_OUTLINE_SLACK;
    const queryHeight = TANK.collisionHeight + (2 * DEBUG_OUTLINE_SLACK);
    // A face is its index in the mesh now (issue #153), and index zero is a
    // real face and a falsy number -- so both the fallback and the "none"
    // test compare against -1 rather than leaning on truthiness.
    const oriented = findMeshHitFaceOriented(
      obstacle, myX, myY, queryZ, myAzimuth, halfWidth, halfLength, queryHeight,
    );
    const f = oriented >= 0
      ? oriented
      : findMeshHitFace(obstacle, myX, myY, queryZ, queryHeight, queryHeight);
    if (f < 0) return null;
    const arrays = meshArrays(obstacle);
    const offset = new THREE.Vector3(
      arrays.facePlanes[f * 4], arrays.facePlanes[(f * 4) + 1], arrays.facePlanes[(f * 4) + 2],
    ).multiplyScalar(epsilon);
    const outline = [];
    for (let c = arrays.faceStart[f]; c < arrays.faceStart[f + 1]; c += 1) {
      const v = arrays.corners[c] * 3;
      outline.push(new THREE.Vector3(
        arrays.vertices[v], arrays.vertices[v + 1], arrays.vertices[v + 2],
      ).add(offset));
    }
    return outline;
  }

  // A point in the obstacle's own frame, `getColliderLocalPoint`'s, in the
  // world's.
  const cos = Math.cos(obstacle.angle || 0);
  const sin = Math.sin(obstacle.angle || 0);
  const toWorldPoint = (lx, ly, z) => new THREE.Vector3(
    obstacle.pos[0] + (lx * cos) - (ly * sin),
    obstacle.pos[1] + (lx * sin) + (ly * cos),
    z,
  );
  const halfW = obstacle.size[0];
  const halfD = obstacle.size[1];
  const base = getObstacleBase(obstacle);
  const local = getColliderLocalPoint(myX, myY, obstacle);

  if (obstacle.type === 'pyramid' && !isPyramidFlatTop(obstacle)) {
    const normal = getTankHitNormal(obstacle, myX, myY, myZ, myAzimuth, myZ, TANK.collisionHeight);
    const apex = base + getPyramidHeight(obstacle);
    const offset = new THREE.Vector3(normal.x, normal.y, normal.z).multiplyScalar(epsilon);
    // Which of the four faces, by the side of the axis the tank is on and which
    // extent it is further out along -- the same question the normal answers.
    const localPoints = Math.abs(local.x) * halfD >= Math.abs(local.y) * halfW
      ? [
        { x: 0, y: 0, z: apex },
        { x: (local.x >= 0 ? 1 : -1) * halfW, y: -halfD, z: base },
        { x: (local.x >= 0 ? 1 : -1) * halfW, y: halfD, z: base },
      ]
      : [
        { x: 0, y: 0, z: apex },
        { x: -halfW, y: (local.y >= 0 ? 1 : -1) * halfD, z: base },
        { x: halfW, y: (local.y >= 0 ? 1 : -1) * halfD, z: base },
      ];
    return localPoints.map((point) => toWorldPoint(point.x, point.y, point.z).add(offset));
  }

  // A box (or a flat-top pyramid, which shares its footprint). `getTankHitNormal`
  // answers "which face" from a *crossing* -- fromZ on one side of a threshold,
  // toZ on the other -- which cannot fire from a single static position (there
  // is no crossing to have happened), so it is no use here. Position alone
  // answers it instead, the same way the pyramid branch above already reads
  // position rather than a crossing to pick between two candidate faces:
  // within the footprint is standing on it (or, rarely, under a raised one);
  // outside the footprint but still solid is a side, and `getOrigRectNormal`
  // -- itself position-only, the same function a box's own ordinary side hit
  // resolves to -- says which one.
  const top = getColliderTopY(obstacle);
  const withinFootprint = Math.abs(local.x) <= halfW && Math.abs(local.y) <= halfD;

  if (withinFootprint) {
    const z = myZ >= (base + top) / 2 ? top + epsilon : base - epsilon;
    return [
      toWorldPoint(-halfW, -halfD, z),
      toWorldPoint(-halfW, halfD, z),
      toWorldPoint(halfW, halfD, z),
      toWorldPoint(halfW, -halfD, z),
    ];
  }

  const side = getOrigRectNormal(halfW, halfD, local.x, local.y);
  // A teleporter's front/rear face is solid only at its two pillars -- the
  // door between them, below the header, is the whole reason it teleports
  // rather than blocks. Left at the outer footprint's full depth, the
  // outline spanned the open doorway along with the frame, as if the whole
  // face were one solid wall.
  let yNear = -halfD;
  let yFar = halfD;
  if (obstacle.kind === 'teleporter' && Math.abs(side.x) >= Math.abs(side.y)) {
    const dims = getShotTeleporterDims(obstacle);
    if (myZ < base + dims.activeH) {
      const sign = local.y >= 0 ? 1 : -1;
      yNear = sign * dims.activeHalfD;
      yFar = sign * halfD;
    }
  }
  const localPoints = Math.abs(side.x) >= Math.abs(side.y)
    ? [
      { x: Math.sign(side.x) * (halfW + epsilon), y: yNear, z: base },
      { x: Math.sign(side.x) * (halfW + epsilon), y: yFar, z: base },
      { x: Math.sign(side.x) * (halfW + epsilon), y: yFar, z: top },
      { x: Math.sign(side.x) * (halfW + epsilon), y: yNear, z: top },
    ]
    : [
      { x: -halfW, y: Math.sign(side.y) * (halfD + epsilon), z: base },
      { x: halfW, y: Math.sign(side.y) * (halfD + epsilon), z: base },
      { x: halfW, y: Math.sign(side.y) * (halfD + epsilon), z: top },
      { x: -halfW, y: Math.sign(side.y) * (halfD + epsilon), z: top },
    ];
  return localPoints.map((point) => toWorldPoint(point.x, point.y, point.z));
}


// The surface the last step met, which is upstream's `lastObstacle`.
//
// The marker stands at the middle of whatever the outline traced, so the two
// always name the same surface: the centre of a box's roof or a plateau, and the
// centre of the *face* of a slope rather than the point above it. Taking the
// obstacle's own centre and top instead put it on a pyramid's apex however far
// down the face the tank was.
function showMotionSurfaceDebug(obstacle) {
  if (!obstacle) {
    hideSupportSurfaceDebug();
    hideSurfaceOutlineDebug();
    return;
  }
  if (!showDebugGeometry) return;
  const points = getMotionSurfaceOutlinePoints(obstacle);
  if (!points || points.length < 3) {
    hideSupportSurfaceDebug();
    hideSurfaceOutlineDebug();
    return;
  }
  const centre = points
    .reduce((sum, point) => sum.add(point), new THREE.Vector3())
    .multiplyScalar(1 / points.length);
  showSupportSurfaceDebug(obstacle, centre);
  const marker = ensureSurfaceOutlineDebugMarker();
  if (!marker) return;
  if (marker.geometry) marker.geometry.dispose();
  marker.geometry = new THREE.BufferGeometry().setFromPoints(points);
  marker.visible = true;
}

function updateDebugGeometryVisibility() {
  renderManager.setGroundGridEnabled(showDebugGeometry, currentWorldMapSize ?? DEFAULT_MAP_SIZE);
  if (!showDebugGeometry) {
    hideSupportSurfaceDebug();
    hideSurfaceOutlineDebug();
  }
  tanks.forEach((tank) => {
    applyTankDebugVisibility(tank);
    if (tank.userData.jumpPredictionDebug) {
      tank.userData.jumpPredictionDebug.visible = showDebugGeometry;
    }
  });
}

// Whether a tank's server-position ghost is drawn. Called both from the debug
// toggle and once a frame from applyTankAlpha, because the answer depends on the
// cloak as well as the toggle and those change on different clocks -- the toggle
// fires on a keypress, the cloak finishes 0.64s after a flag is taken. Deciding
// it in one function and calling it from both is what keeps the two from
// disagreeing.
//
// A ghost left behind a vanished tank is not a cosmetic problem. It is a full
// tank clone that writes depth, so it occludes the ground grid behind it -- the
// silhouette of a tank that is supposed to be invisible, handed to anyone with
// debug geometry on.
function applyTankDebugVisibility(tank) {
  const ghost = tank?.userData?.ghostMesh;
  if (!ghost) return;
  const isLocalTank = tank.userData.playerState && tank.userData.playerState.id === myPlayerId;
  const shouldShowGhost = showDebugGeometry
    && !tank.userData.cloakHidden
    && (!isLocalTank || Boolean(ghost.userData.hasPacketState));
  // Evaluated every frame, written only on a change. The evaluation cannot be
  // event-driven: a cloak *completes* 0.64s after the flag event that started it,
  // on its own clock, so there is no event at the moment the tank should vanish.
  // The write can be, and is -- three property writes a tank a frame is not much,
  // but it is not nothing on a client that runs out of one core.
  if (tank.userData.ghostShown === shouldShowGhost) return;
  tank.userData.ghostShown = shouldShowGhost;
  ghost.visible = shouldShowGhost;
  if (ghost.userData.packetMotionDebug) {
    ghost.userData.packetMotionDebug.visible = shouldShowGhost;
  }
}

// The counters mean nothing apart from the machine that produced them, and the
// machines a render level would be for -- a headset, a phone -- are the ones
// nobody opens the debug HUD on. So one line lands when the HUD closes, and one
// a while into every map, which is the only sample those devices ever send.
// The program count as it stands, plus how far it moved over the last window.
// A count that moves during play is programs being recompiled, which is a cost
// no other counter shows.
function withProgramWindow(stats) {
  if (!stats) return stats;
  const programRange = getFrameProgramRange();
  if (programRange) stats.programsWindow = programRange;
  const fastest = getFastestFrame();
  if (fastest !== null) stats.fastest = fastest;
  return stats;
}

function logRenderStats(reason) {
  // The logged series is the one that pays for the scene walk: it lands a few
  // times an hour, where the debug HUD polls twice a second.
  const stats = withProgramWindow(renderManager.getRenderStats({ deep: true }));
  if (!stats) return;
  // The debug toggles change what is in the scene -- labels are a sprite over
  // every obstacle, geometry is a ghost and a trace per tank -- so a sample
  // that does not say whether they were on is a sample that cannot be compared
  // with the one beside it.
  stats.debugLabels = debugLabelsEnabled;
  stats.debugGeometry = showDebugGeometry;
  stats.debugHud = debugEnabled;
  // A setting rather than a knob, and one that decides whether the scene has
  // seven lights in it or none -- which is a different shader for every
  // material in the world, so it cannot be left off a sample either.
  stats.lighting = renderManager.dynamicLightingEnabled;
  // The radar's range decides how much of the map the panel draws, which is the
  // `radar` phase. It moves with the wheel as well as with `?radarZoom=`, so it
  // belongs on every sample rather than on the init line.
  stats.radarZoom = Math.round(radarZoomLevel * 1000) / 1000;
  // How the radar's obstacles were drawn since the last line: from the cached
  // image, live, and how many times the image was rebaked (#133).
  stats.radarCache = `${radarCacheFrames.cached}/${radarCacheFrames.live}/${radarCacheFrames.bakes}`;
  radarCacheFrames.cached = 0;
  radarCacheFrames.live = 0;
  radarCacheFrames.bakes = 0;
  // bzo's own collections, which is where a leak would live if the scene graph
  // is clean: each of these is added to on an event and has to be removed from
  // on another, and a count that climbs while a client sits idle names which one
  // forgot. `objects` in the render stats is the scene-graph half of the same
  // question.
  stats.tanks = tanks.size;
  stats.shots = projectiles.size;
  stats.worldFlags = flags.size;
  stats.spheres = playerPausedSpheres.size;
  const heap = getHeapUsedMB();
  // Absent rather than zero where the browser does not expose it: a zero would
  // read as "no memory used" beside another browser's real figure.
  if (heap !== null) stats.heap = heap;
  // What has moved since this page's first sample, and nothing when nothing has.
  // A leak is a trend and no single line can show one -- see perf.js. The
  // baseline deliberately outlives a reconnect, because a leak that a reconnect
  // clears is the case worth catching.
  const grew = describeGrowth({
    objects: stats.objects,
    textures: stats.textures,
    geometries: stats.geometries,
    programs: stats.programs,
    labels: stats.labels,
    tanks: stats.tanks,
    shots: stats.shots,
    worldFlags: stats.worldFlags,
    spheres: stats.spheres,
    ...(heap === null ? {} : { heap }),
  });
  if (grew) stats.grew = grew;
  const report = getFramePhaseReport();
  const phases = report ? ` ${describeMeasurements(report)}` : '';
  debugLog(`renderer.stats reason=${reason} fps=${fps} ${describeMeasurements(stats)}${phases}`);
}

function setDebugEnabledState(value) {
  if (debugEnabled && !value) logRenderStats('debugHudClosed');
  debugEnabled = value;
  // Only toggles debug HUD, not debug labels
  syncDebugTabVisibility();
}

function getDebugState() {
  return {
    fps,
    latency,
    packetsSent,
    packetsReceived,
    sentBps,
    receivedBps,
    playerX: myX,
    playerY: myY,
    playerZ: myZ,
    azimuth: myAzimuth,
    myTank,
    cameraMode,
    OBSTACLES,
    clouds: renderManager.getClouds(),
    latestOrientation,
    worldTime,
    gamepadConnected: isGamepadConnected(),
    gamepadInfo: getGamepadInfo(),
    renderStats: withProgramWindow(renderManager.getRenderStats()),
    framePhases: getFramePhaseReport(),
    voice: getVoiceDebugState(),
    heldKeys: getHeldKeyDebug()
  };
}

// Keys the game acts on. Holding the browser off them is the keydown
// listener's job in input.js, which claims the whole set before this runs.
function handleGameplayKeydown(event) {
  // doKeyCommon puts the hunt cursor ahead of every driving key while it is
  // open (playing.cxx:609), so Up and Down pick a row rather than driving and
  // Enter commits rather than firing.
  if (huntState.isSelecting() && handleHuntSelectionKey(event)) return true;
  // huntKeyEvent (ScoreboardRenderer.cxx:283), on upstream's own two bindings:
  // `U` is `hunt` (ActionBinding.cxx:153) and `7` is `addhunt`
  // (clientConfig.cxx:259).
  if ((event.code === 'KeyU' || event.code === 'Digit7') && !event.repeat) {
    pressHuntKey(event.code === 'Digit7');
    return true;
  }
  // `autopilot` on `9` (ActionBinding.cxx:157).
  if (event.code === 'Digit9' && !event.repeat) {
    toggleAutopilot();
    return true;
  }

  // An observer has no tank to pause or destroy, and the server drops both
  // messages from one. The keys stay consumed so nothing else reacts to them.
  // A pause a menu asked for is the menu's to undo, which is why cmdPause does
  // nothing at all while pausedByUnmap is set.
  if (event.code === 'KeyP') {
    if (pauseState.pressPauseKey({ observer: isObserver() })) sendToServer({ type: 'pause' });
    return true;
  }

  if (event.key === 'n' || event.key === 'N') {
    focusChatWithTarget(CHAT_TARGET_ALL);
    return true;
  }

  if (event.code === 'Period' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    handleReplyToLastSender();
    return true;
  }

  if (event.code === 'Comma' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    handleMessageNemesisTarget();
    return true;
  }

  const chatTabsByCode = {
    Digit1: 'all',
    Digit2: 'chat',
    Digit3: 'server',
    Digit4: 'misc',
    Digit5: 'debug',
  };
  const tabId = chatTabsByCode[event.code];
  if (tabId) {
    setActiveChatTab(tabId);
    return true;
  }

  if (event.code === 'BracketLeft' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    cycleChatTab(-1);
    return true;
  }
  if (event.code === 'BracketRight' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    cycleChatTab(1);
    return true;
  }
  if (event.code === 'PageUp' || event.key === 'PageUp') {
    scrollChatPage(1);
    return true;
  }
  if (event.code === 'PageDown' || event.key === 'PageDown') {
    scrollChatPage(-1);
    return true;
  }
  if (event.code === 'End' || event.key === 'End') {
    scrollChatToNewest();
    return true;
  }
  // Shift is ignored: + and = are one key, and demanding the shift made zooming
  // out a two-handed job while zooming in needed none.
  if (event.code === 'Equal' || event.code === 'NumpadAdd') {
    adjustRadarZoom(1);
    return true;
  }
  if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
    adjustRadarZoom(-1);
    return true;
  }
  if (event.code === 'Backslash') {
    setRadarZoomLevel(radarZoomKnob ?? RADAR_ZOOM_DEFAULT);
    return true;
  }
  // cmdDestruct (clientCommands.cxx:400): five seconds, and the key again calls
  // it off. The request goes when the count runs out, in updateDestructCountdown.
  // `Delete` is upstream's own default binding (ActionBinding.cxx:122).
  if (event.code === 'Delete' && ws && ws.readyState === WebSocket.OPEN) {
    const outcome = destructCountdown.pressDestructKey(frameEpochMs, {
      observer: isObserver(),
      alive: isMyTankAlive(),
    });
    pauseAlertSecondsShown = 0;
    if (outcome === 'started') {
      const seconds = destructCountdown.secondsLeft(frameEpochMs);
      pauseAlertSecondsShown = seconds;
      setHudAlert(PAUSE_ALERT_SLOT, `Self Destructing in ${seconds}`, 1, false);
    } else if (outcome === 'cancelled') {
      setHudAlert(PAUSE_ALERT_SLOT, 'Self Destruct cancelled', 1.5, true);
    }
    return true;
  }
  // Upstream's `identify` key (ActionBinding.cxx:98). It picks the roaming
  // target for an observer, and locks a guided missile for a tank.
  if (event.code === 'KeyI' && !event.repeat) {
    if (isObserver()) identifyRoamTarget();
    else requestLockOn();
    return true;
  }
  // Upstream's drop-flag key. It stays claimed even with no flag in hand, so a
  // press never reaches whichever HUD button holds focus.
  if (event.code === 'Space' && ws && ws.readyState === WebSocket.OPEN) {
    requestFlagDrop();
    return true;
  }
  if (event.code === 'Escape') {
    // Upstream's Escape opens the main menu (`MainMenu.cxx`), and Settings is
    // the closest thing bzo has -- but the web spends Escape on its own state
    // first, so it is a ladder and each press undoes exactly one rung:
    //
    //   in fullscreen  the browser leaves fullscreen. The game does nothing.
    //   mouse steering  turns off. The web cannot confine the cursor to the
    //                   box, so leaving needs a key that is not a drive key.
    //   otherwise       Settings opens, and Escape again closes it.
    //
    // Settings is therefore one press away from a plain client and three from a
    // fullscreen mouse-steering one, in the order somebody would want them
    // undone. The fourth press always undoes the third, so pressing once too
    // often costs nothing -- which is what makes a ladder acceptable at all.
    if (isFullscreenActive()) {
      // Whether the browser also delivers this keydown is up to the browser;
      // claiming it here means the rung is spent either way rather than
      // doubling up with the one below on the browsers that do.
      return true;
    }
    if (mouseControlEnabled) {
      // Through the toggle, so the row, the button and the stored preference
      // all follow.
      toggleMouseMode(false);
      return true;
    }
    openSettingsDialog();
    return true;
  }
  return false;
}

initHudControls({
  showMessage,
  updateHudButtons,
  toggleDebugHud,
  toggleDebugLabels,
  updateDebugDisplay,
  getDebugEnabled: () => debugEnabled,
  setDebugEnabled: setDebugEnabledState,
  getDebugLabelsEnabled: () => debugLabelsEnabled,
  setDebugLabelsEnabled: (value) => {
    debugLabelsEnabled = value;
    renderManager.setDebugLabelsEnabled(debugLabelsEnabled);
    localStorage.setItem('debugLabelsEnabled', debugLabelsEnabled.toString());
    updateDebugLabelsButton();
  },
  getDebugState,
  onOperatorPanelShown: () => openOperatorPanel(),
  onOperatorPanelHidden: () => discardOperatorPanel(),
  onViewPanelShown: () => openViewPanel(),
  isObserver: () => isObserver(),
  cycleObserverView: (direction) => cycleRoamView(direction),
  getObserverViewLabel: () => getRoamLabel(),
  getCameraMode: () => cameraMode,
  setCameraMode: (mode) => { cameraMode = mode; },
  // The Hunt row, on every surface the Settings menu reaches: the flat panel,
  // a phone's touch zones, and the XR list, which mirrors these rows rather
  // than keeping a copy of its own.
  getHuntRowValue,
  stepHuntRow,
  toggleHuntRow,
  getAutopilotRowValue,
  stepAutopilotRow,
  selectAutopilotRow,
  hasHuntCandidates: () => getHuntRowPlayers().length > 0,
  getMouseControlEnabled: () => mouseControlEnabled,
  setMouseControlEnabled: (value) => { mouseControlEnabled = value; },
  getVirtualControlsEnabled: () => virtualControlsEnabled,
  setVirtualControlsEnabled: (value) => { virtualControlsEnabled = value; },
  resetMouseSteering,
  pushChatMessage: (msg) => {
    addChatEntry(['misc', 'all'], msg, CHAT_KIND_MISC);
  },
  updateChatWindow: () => updateChatWindow(),
  sendToServer: (payload) => sendToServer(payload),
  cycleRadarZoom: (direction) => cycleRadarZoomLevel(direction),
  requestVoicePermission,
  toggleVoiceMicrophone,
  getScene: () => scene,
  getChatInput: () => chatInput,
  toggleEntryDialog,
  handleGameplayKeydown,
  syncAutoPause,
});

// --- Debug Labels Button Wiring ---
// Server bots' current plan -- what each is doing and at whom -- shown on its
// name label while the debug labels are on. Asked for only then, so nobody
// else is sent it; `botWatchSent` is what this connection last asked for.
// And the whole plan of the one bot an observer follows -- its route, target
// and shot -- drawn over it while the debug geometry is on (`followedBotPlan`).
let botIntents = new Map();
let botWatchSent = null;
let followedBotPlan = null;

function syncBotWatch() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const want = debugLabelsEnabled === true;
  const follow = showDebugGeometry && isObserver() && roamViewNeedsTarget(roamView) && roamTargetId !== null
    ? String(roamTargetId) : null;
  const key = `${want}|${follow}`;
  if (botWatchSent === key) return;
  botWatchSent = key;
  sendToServer({ type: 'watchBots', on: want, follow });
  if (!follow) followedBotPlan = null;
  if (!want && botIntents.size > 0) {
    const was = [...botIntents.keys()];
    botIntents = new Map();
    was.forEach(refreshTankNameLabel);
  }
}

// What a pilot is doing, and why when that is more than the nearest foe:
// `chase (retaliate)`.
function describePilotIntent(mode, reason) {
  return reason && reason !== 'nearest' ? `${mode} (${reason})` : mode;
}

// A tank's name label: the name, and for a server bot under the debug labels
// what it is doing -- `Ace1 · chase (leader) Tim`.
function tankLabelText(playerId, name) {
  const intent = debugLabelsEnabled ? botIntents.get(playerId) : null;
  if (!intent?.mode) return name;
  const target = intent.targetId !== null && intent.targetId !== undefined
    ? tanks.get(intent.targetId)?.userData?.playerState?.name : null;
  return `${name} · ${describePilotIntent(intent.mode, intent.reason)}${target ? ` ${target}` : ''}`;
}

function refreshTankNameLabel(playerId) {
  const tank = tanks.get(playerId);
  const player = tank?.userData?.playerState;
  if (!player?.name || !tank.userData.nameLabel?.material) return;
  renderManager.updateSpriteLabel(tank.userData.nameLabel, tankLabelText(playerId, player.name), player.color);
}

function updateDebugLabelsButton() {
  syncBotWatch();
  const btn = document.getElementById('debugLabelsBtn');
  if (!btn) return;
  if (debugLabelsEnabled) {
    btn.classList.add('active');
    btn.title = 'Hide Debug Labels';
  } else {
    btn.classList.remove('active');
    btn.title = 'Show Debug Labels';
  }
}

window.addEventListener('DOMContentLoaded', () => {
  updateRadarZoomButton();

  document.getElementById('radarZoomBtn')?.addEventListener('click', (event) => cycleRadarZoomLevel(getMenuClickDirection(event)));

  // A context that cannot light the scene overrides the saved preference: the
  // row goes dead rather than promising something it cannot draw.
  const canLight = renderManager.canUseDynamicLighting();
  renderManager.dynamicLightingEnabled = readStoredFlag('dynamicLightingEnabled', true) && canLight;
  bindToggleButton(document.getElementById('dynamicLightingBtn'), {
    get: () => renderManager.dynamicLightingEnabled,
    set: (value) => { renderManager.dynamicLightingEnabled = value; },
    storageKey: 'dynamicLightingEnabled',
    onTitle: 'Disable Dynamic Lighting',
    offTitle: 'Enable Dynamic Lighting',
    available: () => canLight,
    unavailableTitle: 'Dynamic Lighting needs more shader uniforms than this browser reports',
  });

  // BZDB `rumble`, on by default (defaultBZDB.cxx:79).
  setRumbleEnabled(readStoredFlag('rumbleEnabled', true));
  bindToggleButton(document.getElementById('rumbleBtn'), {
    get: isRumbleEnabled,
    set: setRumbleEnabled,
    storageKey: 'rumbleEnabled',
    onTitle: 'Disable Rumble',
    offTitle: 'Enable Rumble',
  });

  const refreshAnaglyphBtn = bindToggleButton(document.getElementById('anaglyphBtn'), {
    get: () => renderManager.getAnaglyphEnabled(),
    set: (value) => renderManager.setAnaglyphEnabled(value),
    onTitle: 'Disable Anaglyph 3D',
    offTitle: 'Enable Anaglyph 3D',
    // The headset draws its own stereo pair, so anaglyph has nothing to add.
    available: () => !isXREnabled(),
    unavailableTitle: 'Anaglyph 3D is unavailable in VR mode',
    forceOffWhenUnavailable: true,
  });
  window.addEventListener('webxrsessionchange', refreshAnaglyphBtn);

  bindToggleButton(document.getElementById('debugGeometryBtn'), {
    get: () => showDebugGeometry,
    set: (value) => { showDebugGeometry = value; },
    storageKey: 'showDebugGeometry',
    onTitle: 'Hide Debug Geometry',
    offTitle: 'Show Debug Geometry',
    onChange: updateDebugGeometryVisibility,
  });

  // Add handler for Upload Map button
  const uploadBtn = document.getElementById('uploadBtn');
  const uploadMap = document.getElementById('uploadMap');
  if (uploadBtn && uploadMap) {
    uploadBtn.addEventListener('click', () => {
      const file = uploadMap.files && uploadMap.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(e) {
        const content = e.target.result;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'uploadMap',
            mapName: file.name,
            mapContent: content
          }));
        }
      };
      reader.readAsText(file);
    });
  }

  // A recording is binary, so it goes as base64.
  const uploadReplayBtn = document.getElementById('uploadReplayBtn');
  const uploadReplay = document.getElementById('uploadReplay');
  if (uploadReplayBtn && uploadReplay) {
    uploadReplayBtn.addEventListener('click', () => {
      const file = uploadReplay.files && uploadReplay.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        sendToServer({
          type: 'uploadReplay',
          replayName: file.name,
          content: dataUrl.slice(dataUrl.indexOf(',') + 1),
        });
      };
      reader.readAsDataURL(file);
    });
  }

  // The last N seconds of the game, or everything the buffer holds, as a
  // recording (`/record save`).
  const saveRecordingBtn = document.getElementById('saveRecordingBtn');
  if (saveRecordingBtn) {
    saveRecordingBtn.addEventListener('click', () => {
      const name = document.getElementById('saveRecordingName')?.value.trim() || '';
      const seconds = Number.parseInt(document.getElementById('saveRecordingSeconds')?.value, 10);
      if (!name) return;
      sendToServer({ type: 'saveRecording', name, seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null });
    });
  }

  const deleteUploadBtn = document.getElementById('deleteUploadBtn');
  const deleteUploadSelect = document.getElementById('deleteUploadSelect');
  if (deleteUploadBtn && deleteUploadSelect) {
    // Two presses, the first arming the second for a few seconds: a native
    // confirm() would leave a headset or a full-screen game for a browser box.
    let armedValue = null;
    let armTimer = null;
    const disarm = () => {
      armedValue = null;
      clearTimeout(armTimer);
      deleteUploadBtn.textContent = 'Delete';
    };
    deleteUploadSelect.addEventListener('change', disarm);
    deleteUploadBtn.addEventListener('click', () => {
      if (!deleteUploadSelect.value) return;
      if (armedValue !== deleteUploadSelect.value) {
        disarm();
        armedValue = deleteUploadSelect.value;
        deleteUploadBtn.textContent = 'Confirm';
        armTimer = setTimeout(disarm, 4000);
        return;
      }
      const { kind, name } = JSON.parse(armedValue);
      disarm();
      sendToServer({ type: 'deleteUpload', kind, name });
    });
  }

  attachSortFilter('viewServerTable', 'viewServerFilter');
  attachSortFilter('viewMapTable', 'viewMapFilter');
  attachSortFilter('viewReplayTable', 'viewReplayFilter');
  document.getElementById('viewServerRefreshBtn')?.addEventListener('click', () => requestViewData());

  // Match Timer buttons: immediate actions like Upload above, not staged
  // config -- see "Match end" in AGENTS.md. `/countdown`/`/gameover` reach the
  // same server functions; this is the panel's front end for them.
  [
    ['matchStartBtn', 'start'],
    ['matchPauseBtn', 'pause'],
    ['matchResumeBtn', 'resume'],
    ['matchGameOverBtn', 'gameover'],
  ].forEach(([id, action]) => {
    document.getElementById(id)?.addEventListener('click', () => sendMatchControl(action));
  });

  document.getElementById('listServerKeySetBtn')?.addEventListener('click', () => {
    const input = document.getElementById('listServerKeyInput');
    if (!input) return;
    sendToServer({ type: 'setListServerKey', key: input.value.trim() });
    input.value = '';
  });

  wireOperatorPanel();
  const btn = document.getElementById('debugLabelsBtn');
  if (btn) {
    btn.addEventListener('click', () => {
      toggleDebugLabels({
        debugLabelsEnabled,
        setDebugLabelsEnabled: (v) => {
          debugLabelsEnabled = v;
          renderManager.setDebugLabelsEnabled(debugLabelsEnabled);
          localStorage.setItem('debugLabelsEnabled', debugLabelsEnabled.toString());
          updateDebugLabelsButton();
        },
        updateHudButtons: refreshHudButtons,
        showMessage
      });
    });
    updateDebugLabelsButton();
  }

  document.getElementById('shareViewBtn')?.addEventListener('click', async () => {
    const link = buildShareViewLink();
    if (!link) {
      showMessage('Share View Link: only available while viewing a map');
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      showMessage('View link copied to clipboard');
    } catch {
      // No clipboard permission (or no secure context) -- the chat log is
      // still a place to read it from and select it by hand.
      showMessage(link);
    }
  });

  // Initialize WebXR support
  window.addEventListener('webxrsessionchange', event => {
    // A headset has no cursor to read, so the box stops steering for as long as
    // the session lasts -- and must not resume from wherever the cursor was
    // parked when the player left it.
    resetMouseSteering();
    refreshHudButtons();
    // Turns this player's scoreboard `T` to `v` and back, for everyone.
    sendToServer({ type: 'xrSession', on: Boolean(event.detail?.enabled) });
    if (event.detail?.enabled) return;
    closeXRSettingsMenu();
    document.getElementById('xrTextInput')?.blur();
    xrSettingsShortcutLatched = false;
    setXRButtonState(false);
    // A player who left XR before joining needs the dialog they never saw.
    if (!gameplayJoinConfirmed && isDefaultPlayerName(myPlayerName) && !isEntryDialogOpen()) {
      toggleEntryDialog(myPlayerName);
    }
  });

  initXR().then(mode => {
    showMessage(`WebXR: ${mode}`, 'info');
    const xrBtn = document.getElementById('xrBtn');
    const xrQuickBtn = document.getElementById('xrQuickBtn');
    if (mode === 'none') {
      if (xrBtn) {
        xrBtn.disabled = true;
        xrBtn.title = 'WebXR not supported on this device';
        xrBtn.classList.add('disabled');
      }
    } else {
      const toggleXRFromUi = async ({ announceFailure = true } = {}) => {
        showMessage('Requesting VR...');
        const renderer = renderManager.getRenderer();
        if (!renderer) {
          showMessage('Error: Renderer not available');
          return false;
        }

        const wasEnabled = isXREnabled();
        const result = await toggleXRSession(renderer, animate);
        if (result || isXREnabled()) {
          setXRButtonState(true);
          closeSettingsDialog();
          // Force first-person camera when entering VR
          cameraMode = 'first-person';
          // Whatever the 2D dialog was asking for, ask for it on the XR panel.
          if (isEntryDialogOpen()) openXRJoinMenu();
          showMessage('✓ WebXR VR Mode: ON');
          return true;
        }

        setXRButtonState(false);
        if (!wasEnabled && announceFailure) {
          showMessage('✗ VR request failed - check server.log');
        }
        showMessage('WebXR VR Mode: OFF');
        return false;
      };
      const xrClickHandler = () => {
        void toggleXRFromUi();
      };
      if (xrBtn) xrBtn.addEventListener('click', xrClickHandler);
      if (xrQuickBtn) {
        xrQuickBtn.addEventListener('click', xrClickHandler);
        if (isHeadsetDevice()) xrQuickBtn.classList.add('xrAvailable');
      }
      // A headset launched from its own icon has nothing to show in 2D: a saved
      // name joins with no dialog at all, and without one the XR menu asks.
      if (isHeadsetAppLaunch()) {
        debugLog(
          `autolaunch mode=${mode} display=${getDisplayMode()}`
          + ` digitalGoods=${typeof window.getDigitalGoodsService}`
          + ` activation=${navigator.userActivation?.isActive}/${navigator.userActivation?.hasBeenActive}`
          + ` t=${Math.round(performance.now())}ms`,
          'WebXR',
        );
        // The launch keeps asking for a session in the background, on every
        // signal that could carry the activation it needs, so enter VR whenever
        // one lands rather than only on this first attempt.
        window.addEventListener(XR_LAUNCH_SESSION_EVENT, () => {
          void toggleXRFromUi({ announceFailure: false });
        });
        void toggleXRFromUi({ announceFailure: false });
      }
    }
  });
});

// Autoplay policy hands the renderer's AudioContext over suspended, and
// nothing else in bzo ever resumes it -- so a fresh join relies on the
// mandatory entry-dialog click to happen to unlock it before any sound plays.
// Auto-rejoin (see AGENTS.md) skips that dialog on a reload, which can leave
// other tanks' sounds arriving, and dropped by playSound/playLocalSound's own
// state check, for however long it takes the browser's own implicit
// gesture-detection to notice something. Resuming explicitly on the very
// first interaction of any kind, rather than waiting on that, is what keeps
// the gap as short as it can be.
function resumeAudioContextOnFirstGesture() {
  const events = ['click', 'keydown', 'touchstart'];
  const resume = () => {
    events.forEach((type) => window.removeEventListener(type, resume));
    const context = renderManager.getAudioContext();
    if (context && context.state === 'suspended') context.resume().catch(() => {});
  };
  events.forEach((type) => window.addEventListener(type, resume));
}

// Initialize Three.js
function init() {
  // Prevent iOS scrolling/bounce on fullscreen (web app mode)
  document.addEventListener('touchmove', (e) => {
    // Allow touch on specific elements (chat, controls overlay, etc.)
    const allowedSelectors = ['#chatInput', '#chatWindow', '#controlsOverlay', '#settingsHud', '#audioOverlay', '#helpPanel', '#entryDialog', '#operatorOverlay', '#scoreboardList'];
    const isAllowed = allowedSelectors.some(sel => {
      const el = document.querySelector(sel);
      return el && (e.target === el || (e.target && el.contains(e.target)));
    });

    if (!isAllowed) {
      e.preventDefault();
    }
  }, { passive: false });

  buildFlagHelp();
  setupInputHandlers();
  bindAudioControls();
  initializeVoiceManager();
  collectClientCapabilities();

  // Chat UI
  //
  // The transcript goes back before anything paints, and from here rather than
  // from the top of the module: `chatWindowDirty` is declared further down it,
  // so a restore during load would reach it before it exists.
  restoreChatCache();
  // The two things a browser says before a page goes away. `pagehide` covers a
  // reload and a navigation; `visibilitychange` is the one a phone actually
  // fires when the tab is swiped away, and neither alone is enough.
  window.addEventListener('pagehide', saveChatCache);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveChatCache();
  });

  const chatTabs = document.getElementById('chatTabs');
  chatInput = document.getElementById('chatInput');
  sendBtn = document.getElementById('sendBtn');
  const chatTarget = document.getElementById('chatTarget');

  // Helper to update chatTarget dropdown with player names
  function updateChatTargetOptions() {
    if (!chatTarget) return;
    // Save current selection
    const prevValue = chatTarget.value;
    // Remove all but the destinations that are not players
    const fixedTargets = [
      CHAT_TARGET_ALL, CHAT_TARGET_TEAM, CHAT_TARGET_ADMIN, CHAT_TARGET_SERVER,
    ].map(String);
    for (let i = chatTarget.options.length - 1; i >= 0; i--) {
      if (!fixedTargets.includes(chatTarget.options[i].value)) {
        chatTarget.remove(i);
      }
    }
    // Add each player by name
    tanks.forEach((tank, id) => {
      if (id === myPlayerId) return; // Don't add self
      const name = tank.userData && tank.userData.playerState && tank.userData.playerState.name ? tank.userData.playerState.name : `Player ${id}`;
      let opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      chatTarget.appendChild(opt);
    });
    // Restore previous selection if possible
    chatTarget.value = prevValue;
    // The rebuild does not touch the fixed options, but it runs on a timer and
    // is the one place that could outlive a join, so the gate is re-applied
    // rather than assumed to still hold.
    applyAdminUi();
  }

  // Update dropdown whenever tanks change
  setInterval(updateChatTargetOptions, 1000);
  updateChatTargetOptions();

  // The match clock ticks locally between updates (see `applyMatchTimeUpdate`),
  // so the board needs redrawing once a second even with nothing else to
  // report -- both surfaces read the same extrapolated value from
  // `getScoreboardModel()`.
  setInterval(() => {
    if (matchTimeLeft !== null) refreshScoreboards();
  }, 1000);

  if (chatTabs) {
    chatTabs.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.target.closest('button[data-chat-tab]');
      if (!target) return;
      const tabId = target.getAttribute('data-chat-tab');
      if (tabId) {
        // The tabs are all that is left of a collapsed folder, so the tap that
        // picks a page is also the one that opens it again.
        setChatCollapsed(false);
        setActiveChatTab(tabId);
      }
    });
  }

  // The roster above and the chat folder below divide one screen between them,
  // and chat is as tall as its lines and its tab strip make it. The CSS can
  // reserve chat's 33vh ceiling and keep the two from overlapping, but chat is
  // at that ceiling only when it is full, so the rest of the time the roster
  // stops short of a band of screen nothing is using. Publishing chat's
  // measured height lets the roster's `max-height` end exactly one
  // `--hud-edge-gap` above it, whatever size chat currently is.
  //
  // A ResizeObserver rather than a per-frame read: this changes when a line
  // arrives or a tab opens, which is thousands of frames apart, and the roster
  // is laid out by CSS from the variable either way.
  const chatWindowEl = document.getElementById('chatWindow');
  if (chatWindowEl && typeof ResizeObserver === 'function') {
    const publishChatHeight = () => {
      const height = Math.round(chatWindowEl.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--chat-height', `${height}px`);
    };
    new ResizeObserver(publishChatHeight).observe(chatWindowEl);
    publishChatHeight();
  }

  // A notch is not a number of pixels. `deltaMode` says what the number in
  // `deltaY` means -- pixels, whole lines, or whole pages -- and browsers do
  // not agree: a pixel browser sends about 100 per notch, a line browser sends
  // 3, the OS's own three-lines-per-notch. Chat is six lines tall
  // (`#chatMessages` in styles.css), so an unconverted value is wrong in both
  // directions at once: 100 is nearly the whole panel and 3 is three pixels.
  //
  // Converted, a notch can still be most of a short panel, so it is also
  // capped -- and the cap is what stops a notch skipping past unread rows on a
  // mouse whose own notch is several hundred pixels. These two are the whole
  // knob: raise one for a longer throw, lower it for a shorter one.
  //
  // A panel is capped in whatever it is made of. Chat is made of text, so it
  // moves in lines; the roster is made of rows, and a roster capped in lines
  // would land a fraction of a row past where it started every time. Half the
  // panel caps it instead on a panel too short for even that, because a notch
  // that moves more than half can carry a line off the top that was never on
  // screen long enough to read.
  const WHEEL_NOTCH_LINES = 2;
  const WHEEL_NOTCH_ROWS = 1;
  const wheelScrollPixels = (e, el, unitPx = 0, unitCount = WHEEL_NOTCH_LINES) => {
    const style = window.getComputedStyle(el);
    const unit = unitPx
      || parseFloat(style.lineHeight)
      || (parseFloat(style.fontSize) * 1.25)
      || 16;
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= unit;
    else if (e.deltaMode === 2) delta *= el.clientHeight;
    const cap = Math.max(unit, Math.min(unit * unitCount, el.clientHeight / 2));
    return Math.max(-cap, Math.min(cap, delta));
  };

  // A roster row's height, measured rather than assumed: it is the font, the
  // padding and the margin together, and all three are viewport-derived.
  const scoreboardRowHeight = (list) => {
    const [first, second] = list.children;
    if (!first) return 0;
    if (second) {
      return second.getBoundingClientRect().top - first.getBoundingClientRect().top;
    }
    return first.getBoundingClientRect().height;
  };

  // Chat scrolls like Debug and Help now (`#chatMessages` is `overflow-y:
  // auto` in styles.css) whenever something lets a pointer event reach it --
  // while chat is active, the scrollbar itself, and PageUp/PageDown/End
  // through `scrollChatPage`/`scrollChatToNewest` above always do. The wheel
  // alone needs its own answer while idle: `#chatMessages` (and `#radar`,
  // below) keep `pointer-events: none` so a click or a drag there still
  // reaches the game (aiming and firing while reversing put the cursor
  // exactly at the bottom centre; looking around puts it near the radar's own
  // top-right corner just as often), and `pointer-events` cannot tell a wheel
  // apart from a click to make an exception for just one of them. This
  // listens on the window instead and asks by coordinate, which is the same
  // question hit-testing would have answered if either element could afford
  // to take the pointer -- a touch drag still cannot reach either while idle
  // for the same reason a click cannot.
  window.addEventListener('wheel', (e) => {
    const messagesDiv = document.getElementById('chatMessages');
    if (messagesDiv) {
      const rect = messagesDiv.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0
        && e.clientX >= rect.left && e.clientX <= rect.right
        && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        messagesDiv.scrollTop += wheelScrollPixels(e, messagesDiv);
        e.preventDefault();
        return;
      }
    }
    // Up zooms in, the same direction a map or a photo viewer's wheel does --
    // there is no existing radar convention of bzo's own to match instead,
    // upstream has no wheel bound to anything. `adjustRadarZoom` is the same
    // fine, continuous step `+`/`-` already use; `cycleRadarZoomLevel` is a
    // different thing -- the "Radar: Medium" button's own three-preset
    // cycle, which wraps past its ends and would make a wheel gesture that
    // feels continuous suddenly jump to the opposite extreme.
    const radarEl = document.getElementById('radar');
    if (radarEl) {
      const rect = radarEl.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0
        && e.clientX >= rect.left && e.clientX <= rect.right
        && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        adjustRadarZoom(e.deltaY < 0 ? 1 : -1);
        e.preventDefault();
      }
    }
  }, { passive: false });

  // The roster scrolls too, and unlike chat it takes pointer events already, so
  // the browser was scrolling it natively -- at the mouse's own notch, which on
  // a mouse that sends a few hundred pixels jumped ten-odd rows and skipped
  // every name between. It gets the same capped notch chat gets, which is why
  // the cap lives in one place and not in each. Listening on the element rather
  // than by coordinate, because here the element can afford to be asked.
  // Reading the newest message means staying on the newest message when the
  // panel changes size -- going fullscreen with `F`, leaving it, rotating a
  // phone, or crossing the breakpoint that takes chat from six lines to three.
  //
  // A resize does not move `scrollTop`; it moves the bottom. A shorter panel
  // has a larger maximum scroll, so the same offset that was the bottom before
  // is now a couple of lines above it, and because the offset itself never
  // changed the browser fires no scroll event to notice it by. That is why
  // this is remembered rather than measured after the fact: by the time the
  // resize is observable the panel is already the wrong size to ask.
  //
  // Re-pinned in a frame callback so the question is asked of the finished
  // layout -- the observer runs before the new line count has been laid out,
  // and `scrollHeight` at that moment is still the old one.
  const chatMessagesEl = document.getElementById('chatMessages');
  if (chatMessagesEl) {
    chatMessagesEl.addEventListener('scroll', () => {
      chatPinnedToBottom = isChatScrolledToBottom(chatMessagesEl);
    }, { passive: true });
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        if (!chatPinnedToBottom) return;
        requestAnimationFrame(() => {
          if (chatPinnedToBottom) scrollChatToNewest();
        });
      }).observe(chatMessagesEl);
    }
  }

  const scoreboardListEl = document.getElementById('scoreboardList');
  if (scoreboardListEl) {
    scoreboardListEl.addEventListener('wheel', (e) => {
      if (scoreboardListEl.scrollHeight <= scoreboardListEl.clientHeight) return;
      scoreboardListEl.scrollTop += wheelScrollPixels(
        e, scoreboardListEl, scoreboardRowHeight(scoreboardListEl), WHEEL_NOTCH_ROWS,
      );
      e.preventDefault();
    }, { passive: false });

    // A finger. `body` is `touch-action: none` and the guard in `init` cancels
    // any touchmove that is not on the short allowlist, both so a drag across
    // the battlefield aims instead of scrolling the page -- which between them
    // also stopped the browser ever scrolling the roster natively. The roster
    // is on that allowlist now, and `touch-action: pan-y` (styles.css) is what
    // lets a vertical drag there be a scroll while every other direction stays
    // the game's.
    let rosterTouchY = null;
    scoreboardListEl.addEventListener('touchstart', (e) => {
      rosterTouchY = e.touches.length === 1 ? e.touches[0].clientY : null;
    }, { passive: true });
    scoreboardListEl.addEventListener('touchmove', (e) => {
      if (rosterTouchY === null || e.touches.length !== 1) return;
      if (scoreboardListEl.scrollHeight <= scoreboardListEl.clientHeight) return;
      const y = e.touches[0].clientY;
      // The content follows the finger, so the offset moves against it.
      scoreboardListEl.scrollTop -= y - rosterTouchY;
      rosterTouchY = y;
      e.preventDefault();
    }, { passive: false });
    const endRosterTouch = () => { rosterTouchY = null; };
    scoreboardListEl.addEventListener('touchend', endRosterTouch, { passive: true });
    scoreboardListEl.addEventListener('touchcancel', endRosterTouch, { passive: true });
  }

  // The wheel's answer, for a finger. `#chatMessages` keeps `pointer-events:
  // none` while chat is idle so a drag over it still reaches the battlefield,
  // which also means the browser never scrolls it natively and the iOS-bounce
  // guard in `init` cancels the gesture outright. So the same coordinate check
  // the wheel uses reads the touch and moves `scrollTop` by hand.
  //
  // Only while chat is idle: once it is active the transcript has the pointer
  // back and scrolls, drags and selects the ordinary way, and a second hand on
  // `scrollTop` would move it twice per frame.
  let chatTouchY = null;
  const chatTouchTarget = (touch) => {
    if (chatActive) return null;
    const messagesDiv = document.getElementById('chatMessages');
    if (!messagesDiv) return null;
    const rect = messagesDiv.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (touch.clientX < rect.left || touch.clientX > rect.right) return null;
    if (touch.clientY < rect.top || touch.clientY > rect.bottom) return null;
    return messagesDiv;
  };
  window.addEventListener('touchstart', (e) => {
    // One finger only. Two is a pinch, which belongs to whatever is under the
    // panel rather than to the transcript.
    chatTouchY = e.touches.length === 1 && chatTouchTarget(e.touches[0])
      ? e.touches[0].clientY
      : null;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (chatTouchY === null || e.touches.length !== 1) return;
    const messagesDiv = document.getElementById('chatMessages');
    if (!messagesDiv) return;
    const touch = e.touches[0];
    // A finger dragging up moves the content up, which is the direction a
    // native touch scroll goes -- the opposite sign from the wheel's deltaY.
    messagesDiv.scrollTop += chatTouchY - touch.clientY;
    chatTouchY = touch.clientY;
  }, { passive: true });
  const endChatTouch = () => { chatTouchY = null; };
  window.addEventListener('touchend', endChatTouch, { passive: true });
  window.addEventListener('touchcancel', endChatTouch, { passive: true });

  const chatMessagesDiv = document.getElementById('chatMessages');
  if (chatMessagesDiv) {
    // The transcript only takes the pointer while chat entry is active, for
    // selecting text out of it. Pressing there takes focus from the input,
    // and the input's blur would end chat entry -- and with it the
    // transcript's hold on the pointer -- in the middle of the drag. So a
    // press in the transcript keeps chat entry through that blur. Released
    // with nothing selected, the keyboard goes back to the input; with a
    // selection, chat entry stays open around it for the copy.
    chatMessagesDiv.addEventListener('mousedown', () => {
      if (chatActive) chatSelectingTranscript = true;
    });
    window.addEventListener('mouseup', () => {
      if (!chatSelectingTranscript) return;
      chatSelectingTranscript = false;
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) return;
      chatInput.focus();
    }, true);
    // Holding a selection, the keyboard is the page's, not the input's: a
    // shortcut (the copy) is left to the browser, Escape ends chat entry as it
    // would from the input, and anything typed goes back into the input,
    // character included.
    document.addEventListener('keydown', (e) => {
      if (!chatActive || document.activeElement === chatInput) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
        setChatEntryActive(false);
        syncInputContextFromUi();
        return;
      }
      if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace') chatInput.focus();
    }, true);
    // Once copied, back to typing.
    document.addEventListener('copy', () => {
      if (chatActive && document.activeElement !== chatInput) setTimeout(() => chatInput.focus(), 0);
    });
  }

  chatInput.addEventListener('keydown', (e) => {
    // Prevent all game events while typing
    e.stopPropagation();
    if (e.code === 'PageUp' || e.key === 'PageUp') {
      scrollChatPage(1);
      e.preventDefault();
      return;
    }
    if (e.code === 'PageDown' || e.key === 'PageDown') {
      scrollChatPage(-1);
      e.preventDefault();
      return;
    }
    if (e.code === 'End' || e.key === 'End') {
      scrollChatToNewest();
      e.preventDefault();
      return;
    }
    // Tab would walk the focus out of the entry, which is the one thing chat
    // entry must not lose -- see "Chat entry owns the keyboard" in AGENTS.md.
    if (e.key === 'Tab') {
      completeChatInput();
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      recallComposeLine(e.key === 'ArrowUp');
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      sendChatInputText();
      chatInput.blur();
    } else if (e.key === 'Escape') {
      composeHistory.reset();
      chatInput.blur();
    }
  });

  // Typing ends a recall: the line is the player's own again, and the next Up
  // starts over from the newest with whatever is now in front of the caret.
  // Setting the value from the recall itself fires no `input` event, so only a
  // real keystroke lands here.
  chatInput.addEventListener('input', () => {
    composeHistory.reset();
  });

  // Focus is what makes chat entry active, and the game gives up the keyboard
  // with it.
  chatInput.addEventListener('focus', () => {
    setChatEntryActive(true);
    setInputContext(INPUT_CONTEXT.CHAT);
  });
  chatInput.addEventListener('blur', () => {
    // A press in the transcript, selecting text to copy, is still chat.
    if (chatSelectingTranscript) return;
    setChatEntryActive(false);
    syncInputContextFromUi();
  });
  // Picking a recipient is a step on the way to typing, so the keyboard follows
  // the choice into the input rather than being left with nothing focused.
  chatTarget.addEventListener('change', () => {
    chatInput.focus();
  });

  // Acting on mousedown, with the default prevented, keeps the button from
  // blurring the input first: by the time a click event arrived chat would
  // already have ended, and the button would reopen it instead of sending.
  let sendToggledByPointer = false;
  sendBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    sendToggledByPointer = true;
    toggleChatEntry();
  });
  sendBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (sendToggledByPointer) {
      sendToggledByPointer = false;
      return;
    }
    toggleChatEntry();
  });
  syncDebugTabVisibility();
  updateChatWindow();
  announceBuildInfoOnce();

  // Restore debug state from localStorage
  if (readStoredFlag('debugEnabled')) {
    toggleDebugHud({
      debugEnabled,
      setDebugEnabled: setDebugEnabledState,
      updateHudButtons: refreshHudButtons,
      showMessage,
      updateDebugDisplay,
      getDebugState
    });
  }

  let renderContext;
  try {
    renderContext = renderManager.init({});
    scene = renderContext.scene;
    const renderer = renderManager.getRenderer();
    if (renderer) {
      const rendererSize = renderer.getSize(new THREE.Vector2());
      const drawingBufferSize = renderer.getDrawingBufferSize(new THREE.Vector2());
      debugLog(
        `renderer.init.ok viewport=${window.innerWidth}x${window.innerHeight} canvas=${renderer.domElement.width}x${renderer.domElement.height} css=${rendererSize.x}x${rendererSize.y} shown=${renderer.domElement.clientWidth}x${renderer.domElement.clientHeight} drawbuf=${drawingBufferSize.x}x${drawingBufferSize.y} renderScale=${renderManager.renderScale} xrScale=${renderManager.xrFramebufferScale} shadows=${renderManager.projectedShadowsEnabled} celestial=${renderManager.celestialEnabled}`,
      );
      const capabilities = renderManager.getRenderCapabilities();
      if (capabilities) debugLog(`renderer.capabilities ${describeRenderCapabilities(capabilities)}`);
    }
  } catch (error) {
    console.error('Failed to initialize 3D renderer:', error);
    const reason = error && error.message ? error.message : 'Unknown renderer initialization error';
    showMessage(`3D renderer unavailable: ${reason}`);
    debugLog(`renderer.init.failed reason="${reason}"`);
    scene = renderManager.getScene();
    const debugContent = document.getElementById('debugContent');
    if (debugContent) {
      debugContent.innerHTML = `<p>3D renderer failed to initialize.</p><p>${reason}</p><p>Open the game in an external browser window for full WebGL support.</p>`;
      const debugHud = document.getElementById('debugHud');
      if (debugHud) debugHud.style.display = 'block';
    }
  }

  if (renderManager.getRenderer()) {
    initTankSelector();
    renderManager.setTankModel(getTankModelPathById(selectedTankModelId));
  }
  resumeAudioContextOnFirstGesture();

  // Radar map
  radarCanvas = document.getElementById('radar');
  radarCtx = radarCanvas.getContext('2d');
  resizeRadar();
  updateRadar();
  updateChatLayoutForDebugOverlap();
  updateMotionBoxMetrics();

  // Event listeners
  window.addEventListener('resize', () => {
    onWindowResize();
    updateChatLayoutForDebugOverlap();
    updateMotionBoxMetrics();
  });

  // Mouse movement for analog control
  // Mouse analog control using position relative to center (cursor always visible)
  document.addEventListener('mousemove', (e) => {
    if (!isGameplayInputActive() || !mouseSteeringActive()) return;
    mouseX = motionBoxAxisInput(e.clientX - window.innerWidth / 2);
    mouseY = motionBoxAxisInput(e.clientY - window.innerHeight / 2);
  });

  // Upstream binds Right Mouse to `identify` (ActionBinding.cxx:97), so the
  // browser's own menu cannot have it. Only while the game owns input, and only
  // outside the chrome: a right click in the chat box or the name field is still
  // a paste.
  document.addEventListener('contextmenu', (e) => {
    if (!isGameplayInputActive()) return;
    if (e.target.closest && e.target.closest('button, a, input, select, textarea, #chatWindow')) return;
    e.preventDefault();
  });

  // Mouse click to shoot
  document.addEventListener('mousedown', (e) => {
    // A click outside an open dialog closes it and is consumed here, so it never
    // reaches the tank. The click after that one is an ordinary gameplay click.
    if (dismissDialogFromOutsideClick(e.target)) return;

    // Chat entry ends on Enter, Escape, or the Chat button, never on a stray
    // click. Preventing the default keeps focus in the input, which is what
    // holds the keyboard.
    if (chatActive) {
      if (!(e.target.closest && e.target.closest('#chatWindow'))) {
        e.preventDefault();
      }
      return;
    }

    if (!isGameplayInputActive()) return;

    // The chat panel is click-through while chat is idle, so a click that does
    // land in it is on one of its controls and belongs to chat, not the tank.
    if (e.target.closest && e.target.closest('#chatWindow')) return;

    // Anything clickable in the HUD is chrome, not the battlefield. Matching on
    // the control itself rather than a list of ids means a button added later is
    // covered without touching this, and it holds in mouse mode too: pressing
    // Settings should never also fire the tank.
    // .playerLabel rather than #playerName: the flag beside the name is part of
    // the same label, and clicking it should not also fire the tank.
    if (e.target.closest && e.target.closest('button, a, input, select, textarea, .playerLabel')) {
      return;
    }

    if (!mouseGameplayClickActive()) return;

    if (e.button === 0) { // Left click
      setGameplayKeyState(FIRE_KEY, true);
    }
    // Upstream's other `identify` binding (ActionBinding.cxx:97). It goes to the
    // same held input the on-screen and XR buttons use, so an observer picks a
    // roaming target with it and a guided missile will lock with it.
    if (e.button === 2) setPointerIdentify(true);
    // Upstream's default "Middle Mouse" -> drop binding (ActionBinding.cxx:95),
    // alongside Space -- a discrete action on press, not a held key, so this
    // asks for it once per click rather than tracking mouseup at all.
    if (e.button === 1) requestFlagDrop();
  });

  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      setGameplayKeyState(FIRE_KEY, false);
    }
    // Released wherever it happens, including over the chrome and after the
    // context that armed it has gone: a button nobody is holding must not stay
    // held.
    if (e.button === 2) setPointerIdentify(false);
  });

  // Load saved player name from localStorage
  const savedName = localStorage.getItem('playerName');
  const entryDialog = document.getElementById('entryDialog');
  const entryInput = document.getElementById('entryInput');
  if (savedName && savedName.trim().length > 0) {
    const trimmed = savedName.trim();
    myPlayerName = trimmed;
    entryInput.value = trimmed;
  }

  // Add click handler for name change
  const playerNameEl = document.getElementById('playerName');
  const entryOkButton = document.getElementById('entryOkButton');
  const entryCancelButton = document.getElementById('entryCancelButton');
  const entryDefaultButton = document.getElementById('entryDefaultButton');
  const closeEntryBtn = document.getElementById('closeEntryBtn');

  if (playerNameEl && entryDialog) {
    // Closed before the draft is applied, so the menu pause is lifted and the
    // camera is back where it was before the join is asked for.
    entryOkButton.addEventListener('click', () => {
      closeEntryDialog({ revert: false });
      applyEntrySelections();
    });

    // Cancel and the [X] are the same button in two places.
    const cancelEntry = () => closeEntryDialog();
    entryCancelButton.addEventListener('click', cancelEntry);
    closeEntryBtn.addEventListener('click', cancelEntry);

    entryDefaultButton.addEventListener('click', () => {
      resetEntrySelectionsToDefault();
    });

    // Escape reaches the dialog through the shared menu keydown handler, which
    // dismisses it the way Cancel does.
    entryInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') entryOkButton.click();
    });
  }

  setupInstallPrompt(document.getElementById('installBtn'), refreshSettingsMenu);

  // Connect to server
  connectToServer();

  // Let Three.js own frame scheduling in both normal and XR modes.
  const renderer = renderManager.getRenderer();
  setNormalAnimationLoop(renderer, animate);
  if (!renderManager.setAnimationLoop(animate)) {
    // Keep the update loop alive when renderer initialization failed.
    runFallbackAnimationLoop();
  }
}

// Moves over a WebRTC data channel when the server offers one (#8,
// move-channel.mjs); the WebSocket carries them otherwise, and the signalling
// always.
const moveChannel = createMoveChannel({
  sendSignal: (signal) => sendToServer({ type: 'rtc', ...signal }),
  onMessage: (text) => {
    receivedBytes += text.length;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (MOVE_CHANNEL_DOWN_TYPES.has(message?.type)) handleServerMessage(message);
  },
  log: (text) => debugLog(text, 'rtc'),
});

// What the channel carries each way, upstream's UDP list (see server.js).
const MOVE_CHANNEL_UP_TYPES = new Set(['m', 'shoot']);
const MOVE_CHANNEL_DOWN_TYPES = new Set(['pmBatch', 'shotBegin', 'shotEnd', 'gmUpdate']);

// Shots whose end came before their start, which a channel that does not keep
// order can do. Upstream drops such an end (`endShot` finds no shot) and the
// shot then flies its whole lifetime; remembering it lets the late start be
// dropped instead. Kept for a while longer than any shot lives.
const earlyShotEnds = new Map();
const EARLY_SHOT_END_MS = 15000;

// The newest batch each tank's moves came in (`n` on a 'pmBatch'). A channel
// that does not keep order can deliver an old batch after a new one, and its
// moves would put the tank back where it was.
const lastMoveBatchById = new Map();

function sendToServer(message) {
  if (MOVE_CHANNEL_UP_TYPES.has(message.type) && moveChannel.isOpen()) {
    const data = JSON.stringify(message);
    if (moveChannel.send(data)) {
      if (debugEnabled) packetsSent.set(message.type, (packetsSent.get(message.type) || 0) + 1);
      sentBytes += data.length;
      return;
    }
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Track sent packets
    if (debugEnabled) {
      const type = message.type || 'unknown';
      packetsSent.set(type, (packetsSent.get(type) || 0) + 1);
    }
    const data = JSON.stringify(message);
    ws.send(data);
    sentBytes += data.length;
  }
}


// A player's scoreboard state, my own included.
function getPlayerStateOf(playerId) {
  if (playerId === null || playerId === undefined) return null;
  return (playerId === myPlayerId ? myTank : tanks.get(playerId))?.userData?.playerState ?? null;
}

function addScore(state, delta) {
  if (!state || !delta) return;
  state.wins = (state.wins || 0) + delta.wins;
  state.losses = (state.losses || 0) + delta.losses;
  state.tks = (state.tks || 0) + delta.tks;
}

// Set by `superKill`, so the close after it is not reported as a lost link.
let serverForcedDisconnect = false;
// Set by a `superKill` that says not to come straight back: a kick or a ban.
let waitToRejoin = false;

// Once, on the player's next key, tap or XR select.
function onNextPlayerAction(run) {
  const session = renderManager.renderer?.xr?.getSession?.();
  const once = () => {
    window.removeEventListener('keydown', once, true);
    window.removeEventListener('pointerdown', once, true);
    session?.removeEventListener('select', once);
    run();
  };
  window.addEventListener('keydown', once, true);
  window.addEventListener('pointerdown', once, true);
  session?.addEventListener('select', once);
}

function connectToServer() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // `?proxy=<target>` rides on the socket as well as the page: it is how the
  // server knows which real bzfs this connection is for, and it has to know
  // before it can send `init`, which it does the moment the socket opens. A
  // page without it connects to this server's own game, as it always has.
  const params = new URLSearchParams(window.location.search);
  const proxyTarget = params.get('proxy');
  // `&team=` rides along for the same reason `?proxy=` does, and it has to:
  // bzfs fixes a player's team when it answers `MsgEnter` and the protocol has
  // no message for changing it afterwards, so the team is part of which
  // connection this is rather than something to ask for once it is open.
  const proxyTeam = proxyTarget ? params.get('team') : null;
  // `?watch=` rides on the socket for the same reason `?proxy=` does: the
  // server has to know which game this connection is before it can build
  // `init`, and it builds it the moment the socket opens. Without this the
  // page sits on a watch URL while the socket joins the local game.
  const watchTarget = params.get('watch');
  // A player's own motto is not sent to a target. The motto is one of the few
  // ways a proxied connection announces itself at all, so it says only that --
  // see `proxyMotto`.
  // A team on a watch link is an admin playing there rather than watching.
  // `team=play`, the /list row's Play, is the team Player Options holds --
  // Automatic where that is to watch -- so the link carries no choice of its
  // own to override the player's.
  const linkTeam = watchTarget ? params.get('team') : null;
  const watchTeam = linkTeam === 'play' ? playLinkTeam() : linkTeam;
  // `?replay=` rides on the socket for the same reason again, and carries no
  // team: a replay is only ever watched.
  const replayName = params.get('replay');
  const query = replayName
    ? `/?replay=${encodeURIComponent(replayName)}`
    : watchTarget
    ? `/?watch=${encodeURIComponent(watchTarget)}${watchTeam ? `&team=${encodeURIComponent(watchTeam)}` : ''}`
    : (proxyTarget
      ? `/?proxy=${encodeURIComponent(proxyTarget)}${proxyTeam ? `&team=${encodeURIComponent(proxyTeam)}` : ''}`
        + (IS_BOT_CLIENT ? '&bot' : '')
      : '');
  ws = new WebSocket(`${protocol}//${window.location.host}${query}`);

  ws.onopen = () => {
    botWatchSent = null;
    callVoiceManager('start');
    showMessage('Connected to server!');
    debugLog(`ws.open host=${window.location.host} protocol=${window.location.protocol}`);
    flushDebugPacketQueue();
    setLoadingOverlayState({
      visible: true,
      progress: 0.02,
      status: 'Connected to server',
      detail: 'Waiting for world state',
    });
  };

  ws.onmessage = (event) => {
    receivedBytes += event.data.length;
    const message = JSON.parse(event.data);

    // Track received packets
    if (debugEnabled) {
      const type = message.type || 'unknown';
      packetsReceived.set(type, (packetsReceived.get(type) || 0) + 1);
    }

    handleServerMessage(message);
  };

  ws.onclose = (event) => {
    moveChannel.close();
    renderReadyForJoin = false;
    gameplayJoinConfirmed = false;
    activeInitSequence = 0;
    hideLoadingOverlay();
    // A world being written for a view is not coming on this socket.
    for (const { resolve } of worldFilePreparations.values()) resolve(null);
    worldFilePreparations.clear();
    let wins = 0;
    let losses = 0;
    if (myTank && myTank.userData && myTank.userData.playerState) {
      wins = myTank.userData.playerState.wins || 0;
      losses = myTank.userData.playerState.losses || 0;
    }
    console.log(`Disconnected from server (code: ${event.code}, reason: ${event.reason}) | Kills: ${wins} | Deaths: ${losses}`);
    const scheduleReconnect = (delay) => {
      void resetVoiceManagerForReconnect().finally(() => {
        setTimeout(connectToServer, delay);
      });
    };
    // Ignore 503 (Service Unavailable) and silently retry
    if (event.code === 1008 || event.reason === '503') {
      console.log('Server temporarily unavailable (503), retrying...');
      scheduleReconnect(2000);
      return;
    }
    if (!serverForcedDisconnect) showMessage(`Disconnected from server | Kills: ${wins} | Deaths: ${losses}`, 'death');
    serverForcedDisconnect = false;
    if (waitToRejoin) {
      waitToRejoin = false;
      setTimeout(() => {
        showMessage('Press a key, tap or pull a trigger to rejoin', 'death');
        onNextPlayerAction(() => scheduleReconnect(0));
      }, 3000);
      return;
    }
    scheduleReconnect(3000);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    const details = error && error.message ? error.message : 'WebSocket error event';
    debugLog(`ws.error ${details}`);
  };
}

// Shared body of the 'pm'/'pt' cases and each entry of a 'pmBatch': applies
// one tank's server-confirmed move. Split out so a batch can replay it once
// per move without duplicating the logic.
function applyPlayerMoveMessage(message, isTeleportPacket) {
  const tank = tanks.get(message.id);
  if (!tank) return;
  const oldVerticalVel = tank.userData.verticalVelocity || 0;
  const oldJumpAzimuth = tank.userData.jumpAzimuth;

  // Store server-confirmed position for ghost rendering
  tank.userData.serverPosition = {
    x: message.x,
    y: message.y,
    z: message.z,
    azimuth: message.a,
  };
  tank.userData.lastUpdateTime = performance.now();

  // Update position (will be overridden by extrapolation in animation loop)
  placeTank(tank, message.x, message.y, message.z, message.a);
  tank.userData.forwardSpeed = message.fs;
  tank.userData.rotationSpeed = message.rs;
  tank.userData.verticalVelocity = message.vv;
  tank.userData.slideAzimuth = message.sd; // Optional slide direction (undefined if not sliding)
  tank.userData.airVelocityX = Number.isFinite(message.vx)
    ? message.vx
    : tank.userData.airVelocityX || 0;
  tank.userData.airVelocityY = Number.isFinite(message.vy)
    ? message.vy
    : tank.userData.airVelocityY || 0;

  if (isTeleportPacket && message.ja !== undefined) {
    tank.userData.jumpAzimuth = message.ja;
  }

  // Detect jump start (record jump direction). Upstream announces a flap
  // with PlayerState::WingsSound; bzo already knows who carries what, so
  // the flag answers instead of a bit in the packet.
  if (oldVerticalVel <= 0 && message.vv > 10) {
    tank.userData.jumpAzimuth = message.a;
    const wings = hasAirControl(getPlayerFlag(message.id)?.type);
    renderManager.playSound(wings ? 'flap' : 'jump', tank.position);
    renderManager.fireTankJumpJets(tank);
  }

  // Detect fall start (drove off edge - record direction for air physics).
  //
  // A tank at or below ground level has driven off nothing: it is a Burrow
  // tank digging itself in, or climbing back out of its hole once the flag
  // is gone. Upstream never reads either as a fall -- its `location` stays
  // `OnGround` for the whole of it, because only a z above zero makes a
  // tank `InAir` (LocalPlayer.cxx:670), so `PlayerState::Falling` never
  // sets and `justLanded` never becomes true. bzo infers both from the
  // vertical velocity in the packet instead, and without this gate a
  // burrow reads as a fall and the climb out as a landing: rings and a
  // landing sound every time somebody puts the flag down.
  if (oldJumpAzimuth === null && message.vv < 0 && message.vv > -1 && message.z > 0) {
    tank.userData.jumpAzimuth = message.a;
  }

  // Detect landing (clear jump direction)
  // Don't check oldVerticalVel < 0 because extrapolation doesn't update tank.userData.verticalVelocity
  if (oldJumpAzimuth !== null && message.vv === 0) {
    tank.userData.jumpAzimuth = null;
    triggerLandingFeedback(tank, Math.abs(oldVerticalVel), { local: message.id === myPlayerId });
  }

  // Update ghost mesh position to server-confirmed position
  if (tank.userData.ghostMesh) {
    placeTank(tank.userData.ghostMesh, message.x, message.y, message.z, message.a);
    updatePacketMotionDebug(tank.userData.ghostMesh, {
      fs: message.fs,
      rs: message.rs,
      vv: message.vv,
      vx: message.vx,
      vy: message.vy,
      a: message.a,
      sd: message.sd,
      jumpAzimuth: tank.userData.jumpAzimuth
    }, 'received');
  }

  if (tank.userData.jumpAzimuth !== null && tank.userData.jumpAzimuth !== undefined) {
    updateJumpPredictionDebug(tank, {
      x: message.x,
      y: message.y,
      z: message.z,
      azimuth: message.a,
      forwardSpeed: message.fs,
      rotationSpeed: message.rs,
      verticalVelocity: message.vv,
      jumpAzimuth: tank.userData.jumpAzimuth,
      slideAzimuth: message.sd,
      airVelocityX: Number.isFinite(message.vx) ? message.vx : tank.userData.airVelocityX || 0,
      airVelocityY: Number.isFinite(message.vy) ? message.vy : tank.userData.airVelocityY || 0,
      flagType: getPlayerFlag(message.id)?.type ?? null
    }, 'received');
  } else {
    clearJumpPredictionDebug(tank);
  }

  if (isTeleportPacket) {
    // The sound and nothing else. Upstream's tank teleport is
    // `playWorldSound(SFX_TELEPORT, pos)` (playing.cxx:3085) with no
    // effect attached: `addSpawnEffect` belongs to the spawn handler, one
    // line above `setStatus(PlayerState::Alive)`, and the teleport effect
    // upstream does have -- `addShotTeleportEffect` -- is for shots. A
    // tank that grew out of the floor on arrival read as a respawn, which
    // is a different event with a different meaning. See issue #38.
    const suppressLocalFx = message.id === myPlayerId && performance.now() < suppressLocalTeleportFxUntil;
    if (!suppressLocalFx) {
      renderManager.playSound('teleport', tank.position);
    }

    if (message.id === myPlayerId) {
      myX = message.x;
      myY = message.y;
      myZ = message.z;
      myAzimuth = message.a;
      jumpAzimuth = tank.userData.jumpAzimuth ?? null;
      localTeleportCooldownUntil = sampleEpochClock() + PLAYER_TELEPORT_COOLDOWN_MS;
      lastSentForwardSpeed = Number.isFinite(message.fs) ? message.fs : lastSentForwardSpeed;
      lastSentRotationSpeed = Number.isFinite(message.rs) ? message.rs : lastSentRotationSpeed;
      lastSentHeading = null;
      lastSentVerticalVelocity = Number.isFinite(message.vv) ? message.vv : lastSentVerticalVelocity;
      lastSentAirVelocityX = Number.isFinite(message.vx) ? message.vx : lastSentAirVelocityX;
      lastSentAirVelocityY = Number.isFinite(message.vy) ? message.vy : lastSentAirVelocityY;
      lastSentTime = performance.now();
    }
  }
}

function handleServerMessage(message) {
  // Let the voice manager consume signaling and nearby voice state while the
  // regular game switch continues to own player, render, and chat messages.
  if (voiceManager) {
    const voiceHandled = callVoiceManager('handleServerMessage', message);
    if (typeof message.type === 'string' && message.type.startsWith('voice')) {
      if (!voiceHandled.called || voiceHandled.value !== false) return;
    }
  }

  // Some admin/operator responses are sent without a message type.
  if (typeof message?.error === 'string' && message.error.length > 0) {
    console.error('Server error response:', message.error, message);
    showMessage(`Server error: ${message.error}`);
    return;
  }

  if (message?.success === true && typeof message.type !== 'string') {
    showMessage('Server: action completed successfully');
    return;
  }

  if (rosterSnapshotPending && ROSTER_MESSAGE_TYPES.has(message.type)) {
    queuedRosterMessages.push(message);
    return;
  }

  switch (message.type) {
    case 'init': {
      if (!checkClientBuild(message.clientBuild)) return;
      // A batch number and a shot id are this server process's; a new init
      // may be another.
      lastMoveBatchById.clear();
      earlyShotEnds.clear();
      if (!message.moveChannel) moveChannel.close();
      else if (!moveChannel.isOpen()) void moveChannel.start();
      const operatorPanelTitleEl = document.getElementById('operatorPanelTitle');
      if (operatorPanelTitleEl && typeof message.serverVersion === 'string') {
        operatorPanelTitleEl.textContent = `Operator Panel (v${message.serverVersion})`;
      }
      const sequenceId = ++initSequence;
      activeInitSequence = sequenceId;
      // A fresh world clears every tank, so anything queued against the old one
      // is about players who no longer exist here.
      rosterSnapshotPending = true;
      queuedRosterMessages = [];
      renderReadyForJoin = false;
      gameplayJoinConfirmed = false;
      pendingJoinRequest = null;

      // Show server info in entryDialog
      const serverTitleEl = document.getElementById('serverTitle');
      const serverMotdEl = document.getElementById('serverMotd');
      serverMotdText = message.motd || '';
      serverTitleText = message.title || '';
      if (serverTitleEl) serverTitleEl.textContent = serverTitleText;
      if (serverMotdEl) serverMotdEl.textContent = serverMotdText;
      announceServerTextIfChanged();
      worldTime = message.worldTime;
      // Every map hashed so far (issue #68's Map Viewer picker) -- a fresh
      // connection, a fresh list, and no preview staged against the old one.
      availableViewMaps = Array.isArray(message.viewableMaps) ? message.viewableMaps : [];
      // Which of them the live match is on, so a share link made without ever
      // opening the View dialog still names the world it was made in.
      currentMapFile = message.currentMap || '';
      selectedViewMapFile = null;
      previewedMapFile = null;
      liveWorldData = null;
      // Clear any existing tanks from previous connections
      tanks.forEach((tank) => discardTank(tank));
      tanks.clear();

      // Clear any existing projectiles
      projectiles.forEach((projectile) => {
        renderManager.removeProjectile(projectile);
      });
      projectiles.clear();
      pendingLocalProjectiles = [];

      // Clear any existing shields
      playerPausedSpheres.forEach((sphere) => {
        renderManager.removePausedSphere(sphere);
      });
      playerPausedSpheres.clear();

      // Clear any existing clouds
      renderManager.clearClouds();

      clearFlags();
      message.flags.forEach((state) => setFlagState(state));

      myPlayerId = message.player.id;
      worldBaseConfig = message.config;
      liveBzdb = bzdbFromObject(message.bzdb);
      serverBzdb = bzdbFromObject(message.serverBzdb);
      recomputeLiveConfig();
      // Whatever world is already on screen keeps its own physics: the entry
      // dialog renders a preview before a join, so `init` can arrive with a
      // previewed map already applied underneath it.
      applyWorldGameplay(currentWorldData);
      setAvailablePlayerTeams(message.teamMode.teams);
      setAvailableProxies(message.proxies, message.localTeams, message.localMap);
      teamScores = message.teamScores || [];
      // bzfs.cxx:2437 sends MsgNewRabbit to a joining player for the same reason:
      // who the rabbit is is world state rather than an event. Set directly --
      // there is no roster yet to repaint and nothing to announce about a rabbit
      // that was chosen before this client arrived.
      rabbitPlayerId = message.rabbitId ?? null;
      rabbitChaseEnabled = Boolean(message.teamMode.rabbitSelection);
      // huntReset (ScoreboardRenderer.cxx:333) -- joining a server. Nothing
      // marked here is about the world that is arriving, and a reconnect is a
      // join: the ids it would keep belong to whoever holds them now.
      huntState.reset();
      if (rabbitPlayerId !== null) {
        huntState.rabbitChanged(rabbitPlayerId, {
          iAmTheRabbit: rabbitPlayerId === myPlayerId,
          observing: isObserver(),
        });
      }
      matchTimeLeft = typeof message.timeLeft === 'number' ? message.timeLeft : null;
      matchTimeReceivedAt = sampleEpochClock();
      matchGameOver = Boolean(message.gameOver);
      clientTracesShots = message.clientTracesShots === true;
      if (Array.isArray(message.liveConfigKeys)) liveConfigKeys = message.liveConfigKeys;
      if (message.operatorConfig && typeof message.operatorConfig === 'object') {
        serverOperatorConfig = message.operatorConfig;
      }
      // The panel is wired before the first `init` arrives, so its rows start on
      // placeholders. This is where the server's real values first exist.
      if (!operatorStaged) syncOperatorPanelFromServer();
      // Admin-only (server.js's `init` deliberately omits this for anyone
      // `isAdmin` refuses) -- see docs/list-server-plan.md. The row stays
      // hidden for everyone else.
      syncListServerRow(message.listServer || null);
      if (message.voiceRtcConfig && typeof message.voiceRtcConfig === 'object') {
        // Phones keep voice on IPv4 (voice.js `ipFamily`), through the relay by
        // its IPv4-only names when the server has them.
        const { ipv4IceServers, ...sharedConfig } = message.voiceRtcConfig;
        const baseConfig = VOICE_IP_FAMILY === '4' && Array.isArray(ipv4IceServers)
          ? { ...sharedConfig, iceServers: ipv4IceServers }
          : sharedConfig;
        voiceRtcConfig = VOICE_MODE === 'relay'
          ? { ...baseConfig, iceTransportPolicy: 'relay' }
          : VOICE_MODE === 'direct' || VOICE_MODE === 'ipv6'
            ? { ...baseConfig, iceServers: [] }
            : VOICE_MODE === 'google'
              ? { ...baseConfig, iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] }
              : baseConfig;
        callVoiceManager('setRtcConfig', voiceRtcConfig);
      }
      // Keep the requested team until the server confirms the joined player.
      // The initial handshake describes the temporary connection player.
      updateVoiceIdentity();
      renderManager._applyFogConfig(gameConfig);
      applyRicochetSetting(gameConfig.ALL_SHOTS_RICOCHET === true);
      refreshCollisionColliders();
      myX = message.player.x;
      myY = message.player.y;
      myAzimuth = message.player.azimuth;

      // Known from the handshake cookie, before any join -- set here rather
      // than waiting for `playerJoined` so the entry dialog below locks the
      // name field to a verified session's callsign from the moment it is
      // first shown, including right after the redirect back from weblogin
      // (issue #75).
      amVerified = !!message.player.verified;
      amAdmin = !!message.player.admin;
      // What this server answers, for the chat entry's Tab. A proxied session
      // sends none, because the commands there are the target's.
      serverCommands = message.commands;
      myGlobalCallsign = message.player.globalCallsign || null;
      applyAdminUi();

      // A proxied connection is already on a team -- the target decided it when
      // it answered `MsgEnter` -- so the dialog shows what this connection is,
      // not what localStorage remembers wanting. Anything else would read as a
      // team change the moment Join was pressed and bounce the page for no
      // reason (`proxyTeamChangeNavigated`).
      if (isProxiedPage()) {
        proxyEnteredTeam = message.player.team;
        selectedPlayerTeam = proxyEnteredTeam;
        syncPlayerTeamSelector();
      }
      syncTankSelectorForDestination();
      syncMottoForDestination();

      // A server that does not offer the observer team cannot honour the
      // spectator link, so the page joins as it otherwise would rather than
      // asking for a team and being refused.
      const autoObserving = (autoFollowTarget !== null || autoRoamView !== null)
        && availablePlayerTeams.includes(PLAYER_TEAM.OBSERVER);
      if (autoObserving) {
        // Staged the way the dialog stages it, and not saved: the link decides
        // this page load and nothing after it.
        selectedPlayerTeam = PLAYER_TEAM.OBSERVER;
        syncPlayerTeamSelector();
      }
      // `?viewmap=` (issue #68), the same shape of link: Map Viewer is
      // Observer on the wire, offered wherever Observer is, so it only means
      // something if the server offers Observer at all and has actually
      // hashed the requested file by now.
      const autoViewingMapAvailable = autoViewMapTarget !== null
        && availablePlayerTeams.includes(PLAYER_TEAM.OBSERVER)
        && availableViewMaps.some((entry) => entry.file === autoViewMapTarget);

      // The rest of this handler decides how to join, which depends on
      // whether Map Viewer staged -- so it wraps in a closure rather than
      // running inline, and runs either now (the ordinary case) or once a
      // pending remote re-import settles (`requestMapImportForView` below).
      const finishInit = (autoViewingMap) => {
        if (autoViewingMap) {
          selectedPlayerTeam = PLAYER_TEAM.MAP_VIEWER;
          selectedViewMapFile = autoViewMapTarget;
          syncPlayerTeamSelector();
        }

        // Only send join if there is a saved name of the player's own choosing
        const savedName = getSavedJoinableName();
        if (savedName) {
          myPlayerName = savedName;
        }
        // A verified session's name is not saved from a choice, it is forced --
        // overriding whatever a previous, unauthenticated visit left in
        // localStorage, the same way `resolveJoinName` would at join time.
        if (amVerified && myGlobalCallsign) {
          myPlayerName = myGlobalCallsign;
        }
        if (!isDefaultPlayerName(myPlayerName)) {
          setPendingJoinRequest(myPlayerName);
        } else if (autoObserving || autoViewingMap) {
          // The name the server gave this connection, which is the one the entry
          // dialog would have offered. A spectator arriving on a handed-out link
          // has no name to be asked for.
          myPlayerName = message.player.name;
          setPendingJoinRequest(myPlayerName);
        } else {
          // Ask for a name: in XR on the menu panel, otherwise in the 2D dialog
          myPlayerName = message.player.name;
          if (isXREnabled()) openXRJoinMenu();
          else toggleEntryDialog(myPlayerName);
        }

        // Initialize dead reckoning state (velocity-based)
        lastSentForwardSpeed = 0;
        lastSentRotationSpeed = 0;
        lastSentHeading = null;
        lastSentVerticalVelocity = 0;
        lastSentTime = performance.now();
        void prepareInitialRender(message, sequenceId);
      };

      if (autoViewingMapAvailable) {
        finishInit(true);
      } else if (autoViewMapTarget !== null && availablePlayerTeams.includes(PLAYER_TEAM.OBSERVER)) {
        // Not already hashed -- but a remote import's own name still says
        // which server to ask (see `parseImportMapFileName` in server.js),
        // and bzo only keeps that cache for an hour (`IMPORT_REUSE_MS`), so a
        // shared link outliving it asks the server to fetch it again rather
        // than silently falling through to an ordinary join.
        requestMapImportForView(autoViewMapTarget, sequenceId, () => finishInit(true), () => finishInit(false));
      } else {
        // An unknown name that is not a remote import's own, or a server
        // that refuses Observer entirely: nothing to fetch, so fall through
        // to a normal join rather than staging a team the server would refuse.
        finishInit(false);
      }
      break;
    }

    case 'playerJoined':
      // A join is always unpaused on the server (server.js's own `joinGame`
      // resets `player.paused` unconditionally), but the paused sphere is
      // event-driven -- only 'playerPaused'/'playerUnpaused' touch it -- so a
      // pause picked up in a previous life would otherwise hang on the tank
      // forever, having no unpause event left to answer to.
      setTankPausedState(message.player.id, false);
      removePausedSphere(message.player.id);
      if (message.player.id === myPlayerId) {
        gameplayJoinConfirmed = true;
        syncBotWatch();
        // The moment this join is confirmed, not before -- whatever is
        // already applied (the live world on a fresh connection, or
        // whichever map the entry dialog's Map Viewer preview settled on) is
        // what this join is actually for, so its message says exactly once,
        // never once per map cycled through while still choosing.
        announceWorldMessages(currentWorldData);
        playerTeam = normalizePlayerTeam(message.player.team);
        // A reconnect is a new player to the server, but the same pilot here;
        // a reload finds it in storage, and is not a fresh enable. An observer
        // has no tank to fly (issue #164): the pilot lands, and is kept --
        // in storage too -- to take the controls again the next time this
        // player joins to play.
        if (isObserver()) {
          if (autopilotOn) {
            autopilotRestoreId = autopilotId;
            setAutopilot(null, { remember: false });
          }
        } else {
          if (autopilotOn) {
            sendToServer({ type: 'autopilot', on: true, pilot: getAutopilotName(autopilotId) });
          } else if (autopilotRestoreId && canUseAutopilot()) {
            setAutopilot(autopilotRestoreId);
          }
          autopilotRestoreId = null;
        }
        // The view the spectator link asked for. Applied on every join rather
        // than once: a reconnect is how this client comes back from a server
        // restart, and a link left running on a screen somewhere should come
        // back watching rather than staring at the spawn it landed on.
        if ((autoFollowTarget === AUTO_FOLLOW_LEADER || autoRoamView !== null)
          && isObserverTeam(playerTeam)) {
          roamView = autoRoamView || ROAM_VIEW.FOLLOW;
          roamTargetId = null;
          roamTargetFlagIndex = null;
        }
        // No link asked for a view: the default, which follows the game.
        roamViewDefaulted = isObserverTeam(playerTeam)
          && autoFollowTarget !== AUTO_FOLLOW_LEADER && autoRoamView === null
          && !autoViewCamTarget && !autoViewMapTarget;
        if (roamViewDefaulted) applyDefaultRoamView();
        amAdmin = message.player.admin === true;
        amVerified = message.player.verified === true;
        myGlobalCallsign = amVerified ? message.player.name : null;
        applyAdminUi();
        teamFlagMarkerStyle = colorToCSS(getPlayerTeamColor(playerTeam));
        syncPlayerTeamSelector();
        updateVoiceIdentity();
        const wasAliveBefore = !!(myTank && myTank.userData?.playerState?.alive);
        addPlayer(message.player);

        // This is our join confirmation, update our tank and finish join
        myPlayerName = message.player.name;
        myX = message.player.x;
        myY = message.player.y;
        myZ = message.player.z;
        myAzimuth = message.player.azimuth;

        // The view a shared Map Viewer link asked for -- applied on every
        // join, same reasoning as `autoFollowTarget` just above. A position
        // override resets `roamCamera` too, so free-roam's own lazy pickup
        // (`handleRoamMotion`) re-derives from the new spot on its next
        // frame rather than the one still sitting in it from before.
        if (isObserverTeam(playerTeam)) {
          if (autoViewCamTarget) {
            roamView = autoViewCamTarget;
          } else if (autoViewMapTarget) {
            // A bare `?viewmap=` with no explicit `cam=` starts driving
            // rather than free-floating -- closer to "walk around and look"
            // than a spawn in empty air pointed at nothing in particular.
            roamView = ROAM_VIEW.DRIVE_FP;
          }
          if (autoViewPosTarget) {
            myX = autoViewPosTarget.x;
            myY = autoViewPosTarget.y;
            myZ = autoViewPosTarget.z;
            myAzimuth = autoViewPosTarget.azimuth;
            linkRoamPitch = autoViewPosTarget.pitch;
            roamCamera = null;
            viewerPlacedByLink = true;
          }
          // Whatever this join settled on -- the server's spawn, chosen
          // against the live match's world, or a `pos=` copied off a link to
          // some other map entirely -- is a position in a world that may not
          // be the one about to be drawn. See `confineViewerToWorld`.
          confineViewerToWorld();
        }

        // Saved only when it is a name the player chose. A `Player n` the server
        // handed out because ours was taken -- on a quick reconnect, by this
        // player's own previous connection, not yet timed out -- would
        // otherwise replace the real one, and every later join would ask for
        // `Player n` too.
        if (!isDefaultPlayerName(myPlayerName) || isDefaultPlayerName(pendingJoinRequest?.name)) {
          localStorage.setItem('playerName', myPlayerName);
        }
        pendingJoinRequest = null;

        // Update player name display
        document.getElementById('playerName').textContent = myPlayerName;

        // Reuse and update my tank
        myTank = tanks.get(myPlayerId);
        if (myTank) {
          placeTank(myTank, myX, myY, myZ, myAzimuth);
          myTank.userData.verticalVelocity = message.player.verticalVelocity || 0;
          myTank.userData.playerState = withClientLocalPlayerState(myTank.userData.playerState, message.player);

          // Update name label with confirmed name from server
          if (myTank.userData.nameLabel && myTank.userData.nameLabel.material) {
            renderManager.updateSpriteLabel(myTank.userData.nameLabel, message.player.name, message.player.color);
          }

          // Create ghost mesh for local player to visualize what others see
          if (!myTank.userData.ghostMesh) {
            const ghostTank = renderManager.createGhostMesh(myTank);
            // Reset rotation to 0 to ensure we're setting absolute values
            ghostTank.rotation.set(0, 0, 0);
            placeTank(ghostTank, myX, myY, myZ, myAzimuth);
            ghostTank.visible = showDebugGeometry;
            renderManager.getWorldFrame().add(ghostTank);
            myTank.userData.ghostMesh = ghostTank;
          }

          // Update ghost mesh name label too
          if (myTank.userData.ghostMesh && myTank.userData.ghostMesh.userData.nameLabel &&
              myTank.userData.ghostMesh.userData.nameLabel.material) {
            renderManager.updateSpriteLabel(myTank.userData.ghostMesh.userData.nameLabel, message.player.name, message.player.color);
          }

          myTank.userData.forwardSpeed = message.player.forwardSpeed || 0;
          myTank.userData.rotationSpeed = message.player.rotationSpeed || 0;
          myTank.userData.jumpAzimuth = message.player.jumpAzimuth ?? null;
          myTank.userData.slideAzimuth = message.player.slideAzimuth;
          myTank.userData.airVelocityX = message.player.airVelocityX || 0;
          myTank.userData.airVelocityY = message.player.airVelocityY || 0;
          myTank.visible = true;
          localTeleportReentryBlockTeleporterIndex = null;
          localTeleportReentryBlockDistance = 0;
          localTeleportReentryBlockUntil = 0;
          localTeleportCooldownUntil = 0;
          suppressLocalTeleportFxUntil = 0;

          if (!wasAliveBefore && message.player.alive) {
            triggerSpawnEffectForTank(myTank, message.player.color);
          }
        }
        // A join is a new life on both ends -- the server's own join handler
        // clears its copy of the pause the same way `respawned()` does for a
        // respawn -- but nothing did that here on the client, so a pause or
        // countdown picked up moments earlier (staging a team in the entry
        // dialog while still on a live tank, say) would otherwise survive a
        // join that has nothing to do with it and show as already paused.
        if (pauseState.respawned({
          covered: shouldAutoPause(),
          alive: isMyTankAlive(),
          observer: isObserver(),
        })) {
          sendToServer({ type: 'pause' });
        }
        refreshScoreboards();
      } else {
        // Another player joined: update their info and create their tank if needed
        const existingTank = tanks.get(message.player.id);
        const wasAliveBefore = !!(existingTank && existingTank.userData?.playerState?.alive);
        addPlayer(message.player);
        const joinedTank = tanks.get(message.player.id);
        if (!wasAliveBefore && message.player.alive && joinedTank) {
          triggerSpawnEffectForTank(joinedTank, message.player.color);
        }
        refreshScoreboards();
        noticeAbout(null, [describePlayer(message.player.id), ' joined'], 0, false);
      }
      // Someone arriving is a game to follow, for an observer still on the default.
      refreshDefaultRoamView();
      break;

    case 'teamUpdate':
      teamScores = message.teams || [];
      refreshScoreboards();
      break;

    case 'newRabbit':
      applyNewRabbit(message.playerId ?? null);
      break;

    case 'matchStart':
      // resetPlayerScores: everybody back to nothing, as on the server.
      for (const id of [myPlayerId, ...tanks.keys()]) {
        const state = getPlayerStateOf(id);
        if (!state) continue;
        state.wins = 0;
        state.losses = 0;
        state.tks = 0;
      }
      refreshScoreboards();
      break;

    case 'timeUpdate':
      applyMatchTimeUpdate(typeof message.timeLeft === 'number' ? message.timeLeft : null);
      break;

    case 'scoreOver':
      applyScoreOver(message.playerId ?? null, message.team ?? null);
      break;

    case 'playerLeft': {
      // Show the player's name before removing
      // Described before the tank goes, since that is where the colour, the flag
      // and the team are read from.
      noticeAbout(null, [describePlayer(message.id), ' left'], 0, false);
      removePlayer(message.id);
      // The last player gone leaves nothing to follow but the map.
      refreshDefaultRoamView();
      break;
    }

    case 'playerUpdated':
      if (message.player) {
        // Upstream's own lines when a tank goes quiet and comes back
        // (playing.cxx:7323-7329).
        const before = tanks.get(message.player.id)?.userData?.playerState;
        if (before && message.player.id !== myPlayerId
          && typeof message.player.notResponding === 'boolean'
          && Boolean(before.notResponding) !== message.player.notResponding) {
          addChatEntry(['server', 'all'],
            `${message.player.name} ${message.player.notResponding ? 'not responding' : 'okay'}`,
            CHAT_KIND_SERVER);
        }
        addPlayer(message.player);
        if (message.player.id === myPlayerId) {
          myTank = tanks.get(myPlayerId);
          if (message.player.team !== undefined) {
            playerTeam = normalizePlayerTeam(message.player.team);
            amAdmin = message.player.admin === true;
            amVerified = message.player.verified === true;
            myGlobalCallsign = amVerified ? message.player.name : null;
            applyAdminUi();
            syncPlayerTeamSelector();
            updateVoiceIdentity();
          }
        }
        refreshScoreboards();
      }
      break;

    case 'pm':
    case 'pt':
      applyPlayerMoveMessage(message, message.type === 'pt');
      break;

    // `MsgTeleport` from a proxied target: who went through, with no position.
    // bzo's own `pt` above carries one because this server decides where a
    // tank lands; a target decides for itself and the player updates either
    // side of this already move the tank. So this is the sound and nothing
    // else, which is all upstream's own handler does (`playing.cxx:3085`) --
    // see the note in `applyPlayerMoveMessage` for why there is no effect.
    case 'teleport': {
      const tank = tanks.get(message.playerId);
      if (tank) renderManager.playSound('teleport', tank.position);
      break;
    }

    // One WebSocket frame per tick carrying every other tank's move instead
    // of one frame per move (server.js batches `pendingMoveBroadcasts` in
    // `gameLoop`). The sender's own id can appear here -- unlike plain 'pm',
    // this is broadcastAll -- and is skipped for the same reason 'pm' was
    // never sent back to its origin: applying it would fight local prediction.
    case 'pmBatch':
      for (const move of message.moves || []) {
        if (move.id === myPlayerId) continue;
        if (Number.isFinite(message.n)) {
          if (message.n < (lastMoveBatchById.get(move.id) ?? -Infinity)) continue;
          lastMoveBatchById.set(move.id, message.n);
        }
        applyPlayerMoveMessage(move, false);
      }
      break;

    case 'rtc':
      void moveChannel.signal(message);
      break;

    case 'positionCorrection':
      // An observer has a camera rather than a tank: `/mv` puts it there.
      if (isObserver()) {
        moveRoamCameraTo(message);
        break;
      }
      // Server corrected our position - update dead reckoning state
      myX = message.x;
      myY = message.y;
      myZ = message.z;
      myAzimuth = message.a;
      // Don't reset velocity tracking - the correction is only for position/rotation drift
      // Resetting velocities to 0 would trigger immediate resend of current velocities
      // Only update lastSentTime to prevent immediate heartbeat trigger
      lastSentTime = performance.now();
      if (myTank) {
        placeTank(myTank, myX, myY, myZ, myAzimuth);
        myTank.userData.verticalVelocity = message.vv || 0;
        myTank.userData.airVelocityX = 0;
        myTank.userData.airVelocityY = 0;
        myTank.userData.jumpAzimuth = null;
        myTank.userData.slideAzimuth = undefined;
        localTeleportReentryBlockTeleporterIndex = null;
        localTeleportReentryBlockDistance = 0;
        localTeleportReentryBlockUntil = 0;
        localTeleportCooldownUntil = 0;
        suppressLocalTeleportFxUntil = 0;
        clearJumpPredictionDebug(myTank);
        deathCameraActive = false;
        deathFollowTarget = null;
        renderManager.deathFollowTarget = null;
        renderManager.deathFollowAnchor = null;
        updateDeathCameraHudVisibility();
      }
      break;

    case 'flagUpdate':
      message.flags.forEach((state) => setFlagState(state));
      // MsgDropFlag still names its owner, so the drop that precedes this
      // repaints the scoreboard while the flag is still on the tank. This is
      // the message that makes it anonymous, so this is the one that has to
      // repaint -- otherwise a shaken flag stays on the scoreboard until some
      // unrelated event happens to redraw it.
      refreshScoreboards();
      break;

    case 'grabFlag': {
      const flag = setFlagState(message.flag);
      // The player in their roster colour and the flag in its own, as every other
      // notice that names a tank does. `flag: null` because the sentence names
      // the flag already, and a callsign wearing it too would say it twice.
      //
      // No trailing " flag", which upstream appends (`playing.cxx:2736`).
      // `Red Team` and `MG/Machine Gun` are already flag names and nothing
      // else in the game is called either, so the word is a fifth of the line
      // spent saying what the line already said -- and a line this one shares
      // with three others on a phone.
      noticeAbout(
        null,
        [describePlayer(message.playerId, { flag: null }), ' grabbed ', describeFlagForNotice(flag)],
        0,
        false,
      );
      // After the notice, not before it: what this adds for a bad flag is a
      // sentence about the flag the line above just named, and it read
      // backwards arriving first.
      handleFlagGrabbedAlerts(message.playerId, flag);
      // The scoreboard names the carried flag, and it only repaints on events.
      refreshScoreboards();
      break;
    }

    // MsgTransferFlag. A thief's shot moved a flag from one tank to another
    // without it ever touching the ground, so there is no grab and no drop to
    // repaint from -- this is the only message that says so.
    case 'transferFlag':
      handleFlagTransferred(message);
      refreshScoreboards();
      break;

    case 'captureFlag':
      handleFlagCaptured(message);
      refreshScoreboards();
      break;

    case 'nearFlag':
      handleNearFlag(message);
      break;

    case 'antidoteFlag':
      handleAntidoteFlag(message);
      break;

    case 'dropFlag': {
      const flag = setFlagState(message.flag);
      if (message.playerId === myPlayerId) {
        renderManager.playLocalSound('flagDrop');
        // handleFlagDropped's "make sure the player must reload after theft"
        // (playing.cxx:3823). Charged when the flag leaves the tank, which after
        // a successful steal is the moment the theft spends it.
        if (flag.type === 'TH') {
          forceReload(getThiefDropReloadSeconds(getShotLifetimeSeconds(null)));
        }
      }
      // Terse for the same reason the grab above is: see that comment.
      noticeAbout(
        null,
        [describePlayer(message.playerId, { flag: null }), ' dropped ', describeFlagForNotice(flag)],
        0,
        false,
      );
      refreshScoreboards();
      break;
    }

    case 'shotBegin':
      // A missile arrives already locked, so the map is seeded before the shot
      // is drawn and its first step is aimed.
      //
      // Except my own, where this client is the one that decided the lock.
      // That is upstream's own split: `GuidedMissileStrategy::update` reads
      // `lastTarget` off the wire only `if (isRemote)`, and asks
      // `myTank->getTarget()` otherwise (GuidedMissleStrategy.cxx:139-149). A
      // target has no target field in `MsgShotBegin` to relay, so taking an
      // answer back from it would clear the lock on every trigger pull.
      // Ended already, its end having overtaken it on the move channel.
      if (earlyShotEnds.delete(message.id)) break;
      if (message.flag === 'GM'
        && !(clientTracesShots && message.playerId === myPlayerId)) {
        setPlayerLockTarget(message.playerId, message.target ?? null);
      }
      createProjectile(message);
      if (message.flag === 'GM') warnLockedOnMe(message.playerId, message.target ?? null);
      break;

    // MsgGMUpdate's target half (GuidedMissleStrategy.cxx:430). Who a player has
    // locked, so every client steers that player's missiles at the same tank and
    // the shooter's own gets the marker. Named after the message it answers to,
    // which is what the rest of bzo's wire does (`docs/network.md`): on a
    // proxied server it *is* that message, and a name of bzo's own would be one
    // more thing to map.
    case 'botIntents': {
      followedBotPlan = message.plan ? { ...message.plan, at: performance.now() } : null;
      const previous = botIntents;
      botIntents = new Map(debugLabelsEnabled ? (message.bots || []).map((bot) => [bot.id, bot]) : []);
      new Set([...previous.keys(), ...botIntents.keys()]).forEach(refreshTankNameLabel);
      break;
    }
    case 'gmUpdate':
      setPlayerLockTarget(message.playerId, message.targetId ?? null);
      warnLockedOnMe(message.playerId, message.targetId ?? null);
      break;

    // setTarget()'s answer to the identify press, for a tank. The server ran the
    // scan; this is only the alert it puts on slot 1 for two seconds.
    case 'identifyResult':
      showIdentifyResult(message.targetId ?? null, message.locked === true);
      break;

    // The server's own measurement of this connection's round trip
    // (docs/lag-plan.md) -- riding the existing keep-alive ping, not a
    // client-side measurement, since a client cannot be trusted to report on
    // the number it would be judged by.
    case 'lag':
      if (Number.isFinite(message.lagMs)) latency = message.lagMs;
      break;

    case 'shotEnd':
      if (!projectiles.has(message.id)) {
        const now = performance.now();
        for (const [id, at] of earlyShotEnds) {
          if (now - at > EARLY_SHOT_END_MS) earlyShotEnds.delete(id);
        }
        earlyShotEnds.set(message.id, now);
      }
      removeProjectile(message.id, message.reason, message.x, message.y, message.z);
      break;

    case 'killed':
      handlePlayerHit(message);
      break;

    case 'alive':
      handlePlayerRespawn(message);
      break;

    case 'playerList':
      applyPlayerList(message.players || []);
      break;

    // MsgAutoPilot (playing.cxx:2423), and upstream's own words for it.
    case 'autopilot': {
      const tank = tanks.get(message.playerId);
      if (tank?.userData?.playerState) tank.userData.playerState.autopilot = message.on;
      // Upstream's words, with the pilot's own name where it is not Roger.
      noticeAbout(null, [describePlayer(message.playerId),
        `: ${message.pilot || 'Roger'} ${message.on ? 'taking' : 'releasing'} controls`], 0, false);
      break;
    }

    case 'pauseCountdown':
      if (message.playerId === myPlayerId) {
        pauseState.countdownStarted(sampleEpochClock());
        pauseAlertSecondsShown = 0;
        updatePauseCountdown();
      }
      break;

    // Either the player pressed pause again or the tank had driven somewhere it
    // may not pause from. Upstream shows both on the pause alert slot.
    case 'pauseCancelled':
      if (message.playerId === myPlayerId) {
        pauseState.cancelledByServer();
        pauseAlertSecondsShown = 0;
        setHudAlert(PAUSE_ALERT_SLOT, message.reason, PAUSE_ALERT_SECONDS, false);
        showMessage(message.reason);
      }
      break;

    case 'playerPaused':
      if (message.playerId === myPlayerId) {
        pauseState.pausedByServer();
        pauseAlertSecondsShown = 0;
        // setAlert(1, NULL) clears the countdown the moment it runs out.
        setHudAlert(PAUSE_ALERT_SLOT, null, 0);
      }
      // One line, whoever paused. A `local:` line saying "Paused" beside
      // everyone else's "<name> paused" said the same thing twice as far as
      // the transcript is concerned, and in a different voice.
      noticeAbout(null, [describePlayer(message.playerId), ' paused'], 0, false);
      setTankPausedState(message.playerId, true, message);
      createPausedSphere(message.playerId, message.x, message.y, message.z);
      refreshScoreboards();
      break;

    case 'playerUnpaused':
      if (message.playerId === myPlayerId) {
        pauseState.unpausedByServer();
        pauseAlertSecondsShown = 0;
      }
      noticeAbout(null, [describePlayer(message.playerId), ' unpaused'], 0, false);
      setTankPausedState(message.playerId, false);
      removePausedSphere(message.playerId);
      refreshScoreboards();
      break;

    case 'voiceMicToggled': {
      const state = tanks.get(message.playerId)?.userData?.playerState;
      if (state) {
        state.voiceMicEnabled = message.enabled === true;
        refreshScoreboards();
      }
      break;
    }

    case 'message': {
      const srcId = normalizeMessageEndpoint(message.src ?? message.from, CHAT_TARGET_SERVER);
      const dstId = normalizeMessageEndpoint(message.dst ?? message.to, CHAT_TARGET_ALL);
      // playing.cxx:3116-3150: only chat and action messages are ever
      // filtered -- never a server-originated one (`src: -1` normalizes to
      // `CHAT_TARGET_SERVER`, never a player id, so `isPlayerSilenced` cannot
      // match it anyway).
      if ((message.msgType === CHAT_KIND_CHAT || message.msgType === CHAT_KIND_ACTION)
        && typeof srcId === 'string' && isPlayerSilenced(srcId)) {
        break;
      }
      if (typeof srcId === 'string' && dstId === myPlayerId && srcId !== myPlayerId) {
        lastDirectSenderId = srcId;
      }
      // playing.cxx:3259, :3276 and :3296. Three sounds, each only when somebody
      // else sent it, and each on a clock of its own -- upstream keeps a separate
      // `static lastMsg` per branch, so a team message does not silence the
      // private one that arrives beside it.
      if (srcId !== myPlayerId) {
        const now = performance.now();
        const throttled = (last) => now - last >= MESSAGE_SOUND_INTERVAL_MS;
        if (dstId === CHAT_TARGET_TEAM && throttled(lastTeamMessageSoundAt)) {
          lastTeamMessageSoundAt = now;
          renderManager.playLocalSound('messageTeam');
        } else if (dstId === CHAT_TARGET_ADMIN && throttled(lastAdminMessageSoundAt)) {
          lastAdminMessageSoundAt = now;
          renderManager.playLocalSound('messageAdmin');
        } else if (dstId === myPlayerId && typeof srcId === 'string'
          && throttled(lastPrivateMessageSoundAt)) {
          // A message addressed to me by a player. Upstream refuses this one for
          // a message from the *server* unless `beepOnServerMsg` is set, which
          // is a setting bzo does not ship -- and `srcId` being a player id
          // rather than a channel is the same test.
          lastPrivateMessageSoundAt = now;
          renderManager.playLocalSound('messagePrivate');
        }
      }
      // `/flag show`'s answer names every flag, and it is the only thing that
      // ever names an unidentified superflag: both bzo and bzfs hide one from
      // every flag update while nobody is carrying it. Reading the reply is
      // what puts those identities on the field, and it is one reader for
      // both -- bzo says this in upstream's own shape (`formatFlagInfo`), so
      // a proxied server's reply lands here the same way.
      //
      // Only a line from the server counts. A player typing something that
      // looks like one is a player talking.
      if (srcId === CHAT_TARGET_SERVER) applyFlagInfoLine(message.text);
      const formatted = formatNetworkMessage(message);
      addChatEntry(formatted.tabs, formatted.text, formatted.kind, formatted.segments);
      updateChatWindow();
      break;
    }

    case 'mapList':
      handleMapsList(message);
      break;

    case 'remoteServerList':
      handleRemoteServerList(message);
      break;

    case 'importMapResult':
      importMapResultReceived(message);
      break;

    case 'importMapForViewResult':
      worldFilePrepared(message);
      handleImportMapForViewResult(message);
      break;

    case 'serverConfigUpdate':
      handleServerConfigUpdate(message);
      break;

    // MsgSetVar: one world variable set, or with a null value reset, by the
    // server's `/set` or a bzfs target's. The live world is rebuilt under it,
    // so its scenery switches and sizes follow too; a preview keeps its own
    // map's until it ends.
    case 'setVar':
      if (typeof message.name !== 'string') break;
      if (message.value === null || message.value === undefined) liveBzdb.delete(message.name);
      else liveBzdb.set(message.name, String(message.value));
      recomputeLiveConfig();
      if (!isPreviewingAltWorld() && currentWorldData) {
        applyWorldData(currentWorldData);
      } else {
        applyWorldGameplay(currentWorldData);
      }
      break;

    case 'superKill':
      // MsgSuperKill's words (playing.cxx:2115); the reason came before it
      // as a server message.
      serverForcedDisconnect = true;
      // A kick or a ban: come back only when the player asks, as a BZFlag
      // client must, rather than straight back into what removed it.
      waitToRejoin = message.rejoin === false;
      showMessage('Server forced a disconnect', 'death');
      break;

    case 'reload':
      // The server usually says this on its way out -- a map change restarts it
      // -- so the reload waits for it to come back rather than racing it.
      showMessage('Server updated - reloading...', 'death');
      setTimeout(reloadWhenServerIsUp, 1000);
      break;

    default:
      console.warn('Unknown message type from server:', message);
      break;
  }
}

// Fields the server's own state carries no opinion about, because they are
// what this client alone has watched: the personal kill record (`handlePlayerHit`,
// mirroring Player::changeLocalScore, playing.cxx:2556) and whether this
// peer's voice is audibly active right now (voice.js). A join, a respawn and
// a plain roster update each replace a tank's whole playerState wholesale
// with a fresh object from the server, which was the bug: a kill counted a
// moment before the victim's respawn message arrived was one the respawn threw
// away for having never heard of it. Every wholesale replacement goes through
// this instead of copying the field list three times.
const CLIENT_LOCAL_PLAYER_STATE_FIELDS = ['localWins', 'localLosses', 'selfKills', 'voiceSpeaking'];

function withClientLocalPlayerState(previousState, serverPlayer) {
  if (!previousState) return serverPlayer;
  const preserved = {};
  for (const field of CLIENT_LOCAL_PLAYER_STATE_FIELDS) {
    if (previousState[field] !== undefined) preserved[field] = previousState[field];
  }
  return { ...serverPlayer, ...preserved };
}

function addPlayer(player) {
  const playerTankModelId = getTankModelIdFromPlayer(player);
  const playerTankModelPath = getTankModelPathById(playerTankModelId);
  let tank = tanks.get(player.id);
  // Captured before a colour or model change discards and recreates `tank`
  // below, so a rebuild cannot lose what a plain update would have kept.
  const previousPlayerState = tank?.userData?.playerState;

  // The colour the tank is actually built from, which is rogue for everyone else
  // while colourblind. Comparing against the effective colour rather than the
  // player's own is what makes picking the flag up a colour change, so the same
  // rebuild path that handles a real recolour handles this too -- the body
  // texture and the name label are both generated from it, so there is nothing
  // cheaper to tweak in place.
  const effectiveColor = getEffectiveTankColor(player.id, player.color);
  const camoOptions = getTankCamoOptions(player.id);
  const tankColorChanged = tank?.userData?.builtColor !== effectiveColor
    || tank?.userData?.builtRogue !== camoOptions.rogue;
  if (tank && tank.userData && (tank.userData.tankModel !== playerTankModelId || tankColorChanged)) {
    discardTank(tank, player.id);
    tank = null;
  }

  if (!tank) {
    tank = renderManager.createTank(
      effectiveColor, player.name, playerTankModelPath, camoOptions);
    // No tank rather than a stand-in one: the renderer has already said on the
    // console which model it could not build, and the server does not offer a
    // model that fails the same check, so this is a model that stopped loading
    // rather than a player to draw a guess for. The next update for this player
    // tries again, since nothing was put in `tanks` to skip the build.
    if (!tank) return;
    tank.userData.builtColor = effectiveColor;
    tank.userData.builtRogue = camoOptions.rogue;
    renderManager.getWorldFrame().add(tank);
    tanks.set(player.id, tank);

    // Create ghost mesh for this tank. Remote ghosts show last received server
    // state; the local ghost shows the last sent movement packet.
    const ghostTank = renderManager.createGhostMesh(tank);
    ghostTank.visible = false;
    renderManager.getWorldFrame().add(ghostTank);
    tank.userData.ghostMesh = ghostTank;
    ensurePacketMotionDebug(ghostTank, player.id === myPlayerId ? 'sent' : 'received');

    if (player.id !== myPlayerId) {
      tank.userData.serverPosition = { x: player.x, y: player.y, z: player.z, azimuth: player.azimuth };
      ghostTank.visible = showDebugGeometry;
      ghostTank.userData.hasPacketState = true;
    } else {
      ghostTank.userData.hasPacketState = false;
    }
  }
  // Always update tank state
  placeTank(tank, player.x, player.y, player.z, player.azimuth);
  tank.userData.tankModel = playerTankModelId;
  tank.userData.playerState = withClientLocalPlayerState(previousPlayerState, player); // Store player state for scoreboard
  applySilenceToVoice(player.id);
  tank.userData.verticalVelocity = player.verticalVelocity;
  tank.userData.forwardSpeed = player.forwardSpeed || 0;
  tank.userData.rotationSpeed = player.rotationSpeed || 0;
  tank.userData.jumpAzimuth = player.jumpAzimuth ?? null;
  tank.userData.slideAzimuth = player.slideAzimuth;
  tank.userData.airVelocityX = player.airVelocityX || 0;
  tank.userData.airVelocityY = player.airVelocityY || 0;
  // Roster bookkeeping (userData.playerState, just above) still updates for
  // the scoreboard while a Map Viewer preview or session is showing a
  // different map -- only the mesh itself is hidden, since the live match's
  // coordinates no longer describe anything in view. See isPreviewingAltWorld.
  tank.visible = player.alive && !isPreviewingAltWorld();

  // Update name label if it exists and has a material
  if (tank.userData.nameLabel && tank.userData.nameLabel.material && player.name) {
    renderManager.updateSpriteLabel(tank.userData.nameLabel, tankLabelText(player.id, player.name), player.color);
  }

  // Update ghost mesh name label if it exists and has a material
  if (tank.userData.ghostMesh && tank.userData.ghostMesh.userData.nameLabel &&
      tank.userData.ghostMesh.userData.nameLabel.material && player.name) {
    renderManager.updateSpriteLabel(tank.userData.ghostMesh.userData.nameLabel, player.name, player.color);
  }

  if (player.id !== myPlayerId && tank.userData.ghostMesh) {
    updatePacketMotionDebug(tank.userData.ghostMesh, {
      fs: player.forwardSpeed || 0,
      rs: player.rotationSpeed || 0,
      vv: player.verticalVelocity || 0,
      vx: player.airVelocityX || 0,
      vy: player.airVelocityY || 0,
      a: player.azimuth,
      sd: player.slideAzimuth,
      jumpAzimuth: player.jumpAzimuth ?? null
    }, 'received');
  }

  if (player.jumpAzimuth !== null && player.jumpAzimuth !== undefined) {
    updateJumpPredictionDebug(tank, {
      x: player.x,
      y: player.y,
      z: player.z,
      azimuth: player.azimuth,
      forwardSpeed: player.forwardSpeed || 0,
      rotationSpeed: player.rotationSpeed || 0,
      verticalVelocity: player.verticalVelocity || 0,
      jumpAzimuth: player.jumpAzimuth,
      slideAzimuth: player.slideAzimuth,
      airVelocityX: player.airVelocityX || 0,
      airVelocityY: player.airVelocityY || 0,
      flagType: getPlayerFlag(player.id)?.type ?? null
    }, player.id === myPlayerId ? 'sent' : 'received');
  } else {
    clearJumpPredictionDebug(tank);
  }

  refreshScoreboards();
}

// Everything hanging off a tank that is not parented to it, undone in one place.
// The ghost, the projected shadows and the crossing-wall lights are all
// *siblings* of the tank in the world group rather than children -- a child
// would inherit the tank's landing squish and spawn scaling -- so none of them
// go away when the tank does, and each has to be let go by name.
//
// One function and three callers, because there are three ways a tank leaves:
// a player quits, a new world arrives, and `addPlayer` throws a tank away to
// rebuild it in another colour or model. They were three copies of this, and
// they had already drifted -- only the quit path dropped the shadows -- so the
// lights were left behind by two of the three the day they were added.
function discardTank(tank, playerId = null) {
  if (!tank) return;
  clearJumpPredictionDebug(tank);
  if (tank.userData?.ghostMesh) {
    tank.userData.ghostMesh.removeFromParent();
    tank.userData.ghostMesh = null;
  }
  renderManager.dropProjectedShadows(tank);
  renderManager.dropTankCrossingEffect(tank);
  tank.removeFromParent();
  if (playerId !== null) tanks.delete(playerId);
}

function removePlayer(playerId) {
  const tank = tanks.get(playerId);
  if (tank) {
    discardTank(tank, playerId);
    // Before the repaint, so the row that has gone takes its bullseye with it
    // and hunting that has run out of targets is already over by the time the
    // board is drawn.
    pruneHuntedPlayers();
    refreshScoreboards();
  }
  removePausedSphere(playerId);
  // Whatever this player had locked goes with them. The server clears every lock
  // pointing *at* a departing player; this is the other direction, the lock they
  // were holding, which no message covers because nobody has to be told.
  playerLockTargets.delete(playerId);
}

// The pause messages are the only ones that carry the flag, so they are what
// keeps the drawn state in step with it. The position comes with the pause
// because a tank that was rolling has been standing still on the server since
// the moment it took hold.
function setTankPausedState(playerId, paused, position = null) {
  const state = tanks.get(playerId)?.userData?.playerState;
  if (!state) return;
  state.paused = paused;
  if (!position) return;
  state.x = position.x;
  state.y = position.y;
  state.z = position.z;
}

function createPausedSphere(playerId, x, y, z) {
  removePausedSphere(playerId);
  const sphere = renderManager.createPausedSphere({ x, y, z, radius: pausedSphereRadius() });
  if (!sphere) return;
  playerPausedSpheres.set(playerId, sphere);
}

function removePausedSphere(playerId) {
  const sphere = playerPausedSpheres.get(playerId);
  if (!sphere) return;
  renderManager.removePausedSphere(sphere);
  playerPausedSpheres.delete(playerId);
}

function createProjectile(data) {
  // Belongs to the live match, which a Map Viewer preview or session is not
  // looking at (issue #68) -- nothing about a shot is scoreboard state, so
  // unlike a tank there is nothing worth keeping track of underneath.
  if (isPreviewingAltWorld()) return;
  const effects = getShotEffects(data.flag ?? null);
  data = withShotFlight(data, effects);

  // A beam is traced whole when it is fired and does not move, so there is no
  // local copy to re-anchor and nothing to integrate: it is drawn from the
  // segments it was given, or from the ones traced here when it arrived
  // without any -- a proxied target leaves the path to each of its clients.
  if (effects.beam) {
    // A laser wears its shooter's colour; a thief's beam is cyan for everybody,
    // because `thiefNodes[i]->setColor(0, 1, 1)` never asks who fired it.
    const beamColor = effects.beamColor === null
      ? getPlayerShotColor(data.playerId, data.team)
      : new THREE.Color(effects.beamColor);
    // A proxied target leaves the path to each of its clients, so a beam that
    // arrives without one is traced here, minus the tank hits that stay the
    // shooting server's to decide.
    const segments = Array.isArray(data.segments) ? data.segments : traceBeam(
      { colliders: getCollisionColliders(), teleports: TELEPORTER_INDEX, mapSize: currentWorldMapSize ?? DEFAULT_MAP_SIZE },
      { x: data.x, y: data.y, z: data.z },
      { x: data.dirX, y: data.dirY, z: Number.isFinite(data.dirZ) ? data.dirZ : 0 },
      data.speed * getShotLifetimeSeconds(data.flag ?? null),
      { ricochet: data.ricochet === true, throughBuildings: effects.throughBuildings === true },
    ).segments;
    const beam = renderManager.createShotBeam({
      ...data,
      segments,
      color: beamColor.getHex(),
      fireSound: effects.fireSound,
      // The shooter fired the report and the flash itself, the moment it pulled
      // the trigger; only the path had to wait for the server.
      silent: data.playerId === myPlayerId,
    });
    if (!beam) return;
    beam.userData.playerId = data.playerId;
    beam.userData.createdAt = data.createdAt;
    beam.userData.radarColor = getShotRadarColor(data.playerId, data.team);
    beam.userData.flag = data.flag ?? null;
    beam.userData.segments = segments;
    beam.userData.lifetimeSeconds = getShotLifetimeSeconds(data.flag ?? null);
    beam.userData.lifeFactor = effects.lifeFactor;
    beam.userData.hiddenOnRadar = effects.hiddenOnRadar;
    projectiles.set(data.id, beam);
    checkOwnBeamHit(data.id, beam);
    return;
  }

  if (data.playerId === myPlayerId) {
    while (pendingLocalProjectiles.length > 0) {
      const pending = pendingLocalProjectiles.shift();
      const localProjectile = projectiles.get(pending.id);
      if (!localProjectile) continue;

      projectiles.delete(pending.id);
      // Re-anchor to authoritative spawn so replayed local shots follow
      // exactly the same path regardless of transient local frame timing.
      placeShot(localProjectile, data);
      localProjectile.userData.dirX = data.dirX;
      localProjectile.userData.dirY = data.dirY;
      localProjectile.userData.dirZ = Number.isFinite(data.dirZ) ? data.dirZ : 0;
      localProjectile.userData.createdAt = data.createdAt;
      localProjectile.userData.pendingServerAck = false;
      localProjectile.userData.flag = data.flag ?? null;
      localProjectile.userData.ricochet = data.ricochet === true;
      localProjectile.userData.speed = data.speed;
      localProjectile.userData.lifeFactor = effects.lifeFactor;
      localProjectile.userData.hiddenOnRadar = effects.hiddenOnRadar;
      localProjectile.userData.guided = effects.guided;
      localProjectile.userData.lifetimeSeconds = getShotLifetimeSeconds(data.flag ?? null);
      localProjectile.userData.teleportReentryBlockTeleporterIndex = null;
      localProjectile.userData.teleportReentryBlockDistance = 0;
      projectiles.set(data.id, localProjectile);
      return;
    }
  }

  const shotColor = getPlayerShotColor(data.playerId, data.team);
  // Keep remote shot starts authoritative to avoid cross-machine clock skew.
  // BZFlag does not rely on sender wall-clock deltas to place remote shots.
  //
  // A shock wave gets a sphere rather than a bolt, and no muzzle flash: it never
  // left a barrel. Only somebody else's reaches here -- the shooter's own was
  // predicted locally and re-anchored above.
  const projectile = effects.shockwave
    ? renderManager.createShotShockWave({
      ...data,
      color: shotColor.getHex(),
      fireSound: effects.fireSound,
    })
    : renderManager.createProjectile({
      ...data,
      color: shotColor.getHex(),
      modelColor: new THREE.Color(getPlayerShotBaseColor(data.playerId, data.team)).getHex(),
      fireSound: effects.fireSound,
      guided: effects.guided,
    });
  if (!projectile) return;
  projectile.userData.at = { x: data.x, y: data.y, z: data.z };
  projectile.userData.playerId = data.playerId;
  projectile.userData.createdAt = data.createdAt;
  projectile.userData.dirX = data.dirX;
  projectile.userData.dirY = data.dirY;
  projectile.userData.dirZ = Number.isFinite(data.dirZ) ? data.dirZ : 0;
  projectile.userData.radarColor = getShotRadarColor(projectile.userData.playerId, data.team);
  // The flag a shot was fired with, as upstream's FiringInfo carries it, and the
  // one thing bzo reads off it so far: whether the shot bounces.
  projectile.userData.flag = data.flag ?? null;
  projectile.userData.ricochet = data.ricochet === true;
  // How fast it flies, how long its slot is held, and whether anybody else's
  // radar shows it -- all three come off the firing flag.
  projectile.userData.speed = data.speed;
  projectile.userData.lifeFactor = effects.lifeFactor;
  projectile.userData.hiddenOnRadar = effects.hiddenOnRadar;
  // A missile's heading is not fixed at the muzzle: `updateProjectiles` turns it
  // every step at whichever tank its shooter has locked.
  projectile.userData.guided = effects.guided;
  projectile.userData.lifetimeSeconds = getWorldMissileLifetimeSeconds(
    data.playerId, effects.guided, currentWorldMapSize, projectile.userData.speed,
  ) ?? getShotLifetimeSeconds(data.flag ?? null);
  projectile.userData.teleportReentryBlockTeleporterIndex = null;
  projectile.userData.teleportReentryBlockDistance = 0;
  projectiles.set(data.id, projectile);
}

// `shotBegin` carries the velocity the shot was fired with, as upstream's
// MsgShotBegin does, and this screen makes its flight from it the way every
// upstream client's shot strategy does: the flag's factor on a segmented shot,
// the world's speed along the heading for a Guided Missile, none for a wave.
function withShotFlight(data, effects) {
  const flight = getShotFlight({ x: data.vx, y: data.vy, z: data.vz }, effects, getShotSpeed(null))
    || { x: 0, y: 0, z: 0, speed: 0 };
  return { ...data, dirX: flight.x, dirY: flight.y, dirZ: flight.z, speed: flight.speed };
}

function createLocalProjectile({ x, y, z, dirX, dirY, dirZ = 0, speed }) {
  if (myPlayerId === null || myPlayerId === undefined) return;

  const shotColor = getPlayerShotColor(myPlayerId);
  const localId = `local-${myPlayerId}-${frameEpochMs}-${localProjectileCounter++}`;
  const myFlag = getMyShotFlag();
  const localEffects = getShotEffects(myFlag);
  const projectile = localEffects.shockwave
    ? renderManager.createShotShockWave({
      id: localId,
      playerId: myPlayerId,
      x,
      y,
      z,
      color: shotColor.getHex(),
      fireSound: localEffects.fireSound,
    })
    : renderManager.createProjectile({
      id: localId,
      playerId: myPlayerId,
      x,
      y,
      z,
      dirX,
      dirY,
      dirZ,
      color: shotColor.getHex(),
      modelColor: new THREE.Color(getPlayerShotBaseColor(myPlayerId)).getHex(),
      fireSound: localEffects.fireSound,
      guided: localEffects.guided,
    });
  if (!projectile) return;

  projectile.userData.at = { x, y, z };
  projectile.userData.playerId = myPlayerId;
  projectile.userData.createdAt = frameEpochMs;
  projectile.userData.dirX = dirX;
  projectile.userData.dirY = dirY;
  projectile.userData.dirZ = Number.isFinite(dirZ) ? dirZ : 0;
  projectile.userData.radarColor = getShotRadarColor(projectile.userData.playerId);
  projectile.userData.pendingServerAck = true;
  // The server decides this too, and says so in shotBegin; predicting it here is
  // what keeps a bounce from arriving a round trip late on the shooter's own
  // screen, which is the one screen it has to look right on.
  projectile.userData.flag = myFlag;
  // Always on for a phantom tank's own shot (issue #68) -- cosmetic, so there
  // is nothing lost in enhancing it beyond whatever the live match's own
  // ricochet setting happens to be.
  projectile.userData.ricochet = isPhantomDriving()
    ? true
    : shotRicochets(myFlag, gameConfig?.ALL_SHOTS_RICOCHET);
  projectile.userData.speed = speed;
  projectile.userData.lifeFactor = localEffects.lifeFactor;
  projectile.userData.hiddenOnRadar = localEffects.hiddenOnRadar;
  projectile.userData.guided = localEffects.guided;
  projectile.userData.lifetimeSeconds = getShotLifetimeSeconds(myFlag);
  projectile.userData.teleportReentryBlockTeleporterIndex = null;
  projectile.userData.teleportReentryBlockDistance = 0;
  projectiles.set(localId, projectile);
  pendingLocalProjectiles.push({ id: localId, sentAt: frameEpochMs });
}

function removeProjectile(id, reason = 1, x = null, y = null, z = null) {
  const numericReason = Number(reason);
  const hasServerImpactPosition = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
  const projectile = projectiles.get(id);
  if (projectile) {
    // Use authoritative server coordinates for end-of-shot effects.
    if (hasServerImpactPosition) {
      placeShot(projectile, { x, y, z });
    }
    renderManager.removeProjectile(projectile, numericReason);
    projectiles.delete(id);
    return;
  }

  // If we don't have the projectile object (rare race/id mismatch), still
  // render the authoritative impact effect so players always see shot ends.
  if (numericReason === 0 && hasServerImpactPosition) {
    renderManager.createShotImpact({ x, y, z });
  }
}

// Whether this player has a missile in the air. Upstream asks the same question
// two ways -- `tankHasShotType` for who may lock, and the arrival of a
// MsgGMUpdate for who is warned -- and both reduce to this.
function hasGuidedShotInFlight(playerId) {
  for (const projectile of projectiles.values()) {
    if (projectile?.userData?.playerId === playerId && projectile.userData.guided) return true;
  }
  return false;
}

function handlePlayerHit(message) {
  checkOwnGenocide(message);
  // teachAutoPilot (playing.cxx:2547, :3895): a kill counts for the flag it
  // was made with, a death against the flag held.
  if (autopilotOn) {
    const pilot = autopilots.get(autopilotId);
    if (message.victimId === myPlayerId) {
      pilot.teach(message.victimFlag ?? null, -1);
      autopilotTally.deaths++;
    } else if (message.shooterId === myPlayerId) {
      pilot.teach(message.shooterFlag ?? null, 1);
      autopilotTally.kills++;
    }
  }
  const shooterTank = tanks.get(message.shooterId);
  const victimTank = tanks.get(message.victimId);
  // A world weapon has no tank and no name of its own -- see `WORLD_WEAPON_NAME`
  // in shots.mjs for what upstream does have. Nothing reads a callsign off it,
  // because upstream's notice for this kill is a whole phrase rather than a
  // prefix and a name: "Killed by the server".
  const killedByWorld = String(message.shooterId) === String(WORLD_WEAPON_PLAYER_ID);
  // What each tank held when it happened, from the message rather than from the
  // world: the victim's has been dropped by now, and the killer may have changed
  // theirs. Upstream's MsgKilled carries the same thing for the same reason.
  const victimFlag = getFlagLabelForAbbreviation(message.victimFlag);
  const shooterFlag = getFlagLabelForAbbreviation(message.shooterFlag);
  const isSelfDestruct = Boolean(message.suicide) || (message.victimId === message.shooterId);
  // Upstream's BlowedUpReason, as far as the server has reasons to send. It
  // picks both the notice and the sound: `blowedUpMessage[]` (playing.cxx:186)
  // is upstream's own table and these are its own words.
  const deathReason = typeof message.reason === 'string' ? message.reason : 'shot';
  // playing.cxx:2212's own wording for the clock reaching zero -- a distinct
  // notice from "Killed by the server", which is what every other world-weapon
  // kill still says.
  const isMatchEnd = deathReason === 'gameOver';
  // A `death` physics driver -- no killer, and its own mapper-authored
  // message (`message.deathMessage`) rather than a `deathPrefix`-templated
  // one, the same "whole phrase" treatment `killedByWorld` gets below.
  const isPhysicsDriverDeath = deathReason === 'physicsDriver';
  // `waterLevel` -- no killer, and a fixed message rather than a mapper's
  // own: upstream's own local-player alert for this is "Tank Rusted"
  // (`blowedUpMessage[WaterDeath]`, `playing.cxx:186-195`), not a phrase
  // that names the water at all, while the notice about someone else says
  // "fell in the water" instead (`playing.cxx:2601-2604`) -- two different
  // fixed strings for the same reason, both upstream's own.
  const isWaterDeath = deathReason === 'water';
  // "if (!killerPlayer) blowedUpNotice = \"Killed by the server\"" -- gotBlowedUp
  // (playing.cxx:3999) throws the whole prefix away when the killer has no
  // roster entry, which is every kill by a world weapon: `lookupPlayer` finds
  // its pseudo-player by name and never by id, so a `ServerPlayer` id always
  // comes back empty. Upstream's exact words, and the reason a world weapon
  // needs no name in the message.
  // blowedUpMessage[] (playing.cxx:186) is a *prefix*; the killer is described
  // after it, which is where the team and the flag go.
  const deathPrefix = {
    runOver: 'Got flattened by ',
    genocide: 'Teammate hit with Genocide by ',
  }[deathReason] || 'Got shot by ';
  // "matching the team-display style of other kill messages" (playing.cxx:4008):
  // a killer on my own team is named `teammate <callsign>` and gets neither team
  // nor flag, because which of us it was is the whole of what went wrong.
  //
  // Upstream's own test is `myTank->getTeam() == team && team != RogueTeam &&
  // team != ObserverTeam`, which needs no separate "does this world have sides":
  // in OpenFFA everybody is a rogue, and the rogue exclusion is what covers it.
  // Hunters reach it too, and should -- they share a team, so hunter-on-hunter
  // fire really is friendly fire.
  const myTeamNow = normalizePlayerTeam(playerTeam);
  const shotByTeammate = !killedByWorld
    && !isSelfDestruct
    && normalizePlayerTeam(getPlayerTeamById(message.shooterId)) === myTeamNow
    && myTeamNow !== PLAYER_TEAM.ROGUE
    && myTeamNow !== PLAYER_TEAM.OBSERVER;
  const deathSound = deathReason === 'runOver' ? 'runOver' : 'explosion';
  // A capture kills a whole team at once. Upstream scores nobody for it -- the
  // team loss is the entire penalty -- and the captureFlag message has already
  // said what happened, so only the local victim needs telling.
  const isCapture = Boolean(message.captured);
  const shooterId = normalizeMessageEndpoint(message.shooterId, CHAT_TARGET_SERVER);
  const victimId = normalizeMessageEndpoint(message.victimId, CHAT_TARGET_SERVER);

  if (!isSelfDestruct && !isCapture) {
    if (victimId === myPlayerId && typeof shooterId === 'string' && shooterId !== myPlayerId) {
      nemesisPlayerId = shooterId;
    } else if (shooterId === myPlayerId && typeof victimId === 'string' && victimId !== myPlayerId) {
      nemesisPlayerId = victimId;
    }
  }

  if (message.victimId === myPlayerId) {
    // Local player was killed. gotBlowedUp() puts this on the alert HUD for four
    // seconds as a warning (playing.cxx:4028), which is where the eye is.
    if (isCapture) {
      noticeAbout(0, ['Your team flag was captured!'], DEATH_ALERT_SECONDS, true);
    } else if (isMatchEnd) {
      noticeAbout(0, ['Time Expired - GAME OVER'], DEATH_ALERT_SECONDS, true);
    } else if (isSelfDestruct) {
      noticeAbout(0, ['Tank Self Destructed'], DEATH_ALERT_SECONDS, true);
    } else if (isWaterDeath) {
      noticeAbout(0, ['Tank Rusted'], DEATH_ALERT_SECONDS, true);
    } else if (isPhysicsDriverDeath) {
      noticeAbout(0, [typeof message.deathMessage === 'string' && message.deathMessage
        ? message.deathMessage : 'Killed by the server'], DEATH_ALERT_SECONDS, true);
    } else if (killedByWorld) {
      // "Killed by the server" -- gotBlowedUp throws the whole prefix away when
      // the killer has no roster entry, which is every world weapon.
      noticeAbout(0, ['Killed by the server'], DEATH_ALERT_SECONDS, true);
    } else if (shotByTeammate) {
      noticeAbout(
        0, [deathPrefix, 'teammate ', describePlayerName(message.shooterId)],
        DEATH_ALERT_SECONDS, true);
    } else {
      noticeAbout(
        0, [deathPrefix, describePlayer(message.shooterId, { flag: shooterFlag })],
        DEATH_ALERT_SECONDS, true);
    }
    // The death camera is asked for while there is a body to watch, and
    // `cameraMode` is not touched at all: it is still whatever the player
    // chose, waiting under the death camera for the respawn to resume it. It
    // used to be overwritten with 'overview', which is why a player who had
    // *chosen* Overview never got it back -- the restore could not tell that
    // apart from the death camera's own doing and bailed to first person.
    // Start it above and behind the body rather than letting the first frame
    // lerp in from wherever the tank's own view was standing.
    if (victimTank) renderManager.startDeathCamera(victimTank.position);
  } else if (isCapture) {
    // Nothing to say: the capture itself was already announced.
  } else if (message.shooterId === myPlayerId) {
    // Local player got a kill. Upstream has no alert for this -- it only warns
    // you about your own death -- but the two belong together on screen, and the
    // victim is described exactly as the killer is in the notice above.
    if (!isSelfDestruct) {
      noticeAbout(
        0, ['You killed ', describePlayer(message.victimId, { flag: victimFlag })],
        KILL_ALERT_SECONDS, false);
    }
  } else if (isMatchEnd) {
    // Nothing to say about any one tank: everyone alive died in the same
    // tick, the dying player already got their own alert above, and a chat
    // line per tank would spam the room for exactly the players it can't
    // reach anyway (all of them just got the same treatment).
  } else if (isSelfDestruct) {
    // Somebody else's death: chat only, since upstream warns you about your own
    // and nobody else's.
    noticeAbout(
      null, [describePlayer(message.victimId, { flag: victimFlag }), ' self-destructed'],
      0, false);
  } else if (isWaterDeath) {
    noticeAbout(
      null, [describePlayer(message.victimId, { flag: victimFlag }), ' fell in the water'],
      0, false);
  } else if (isPhysicsDriverDeath) {
    noticeAbout(
      null,
      [describePlayer(message.victimId, { flag: victimFlag }), ': ',
        typeof message.deathMessage === 'string' && message.deathMessage
          ? message.deathMessage : 'killed by the server'],
      0, false);
  } else if (killedByWorld) {
    noticeAbout(
      null,
      [describePlayer(message.victimId, { flag: victimFlag }), ' was killed by the server'],
      0, false);
  } else {
    noticeAbout(
      null,
      [
        describePlayer(message.shooterId, { flag: shooterFlag }),
        ' killed ',
        describePlayer(message.victimId, { flag: victimFlag }),
      ],
      0, false);
  }
  // Update other players' stats

  // The scoreboard, tallied here from the kill as the server tallies it
  // (`getKillScoreDeltas`, one rule for both). A capture's and the match end's
  // deaths score nobody, there as here.
  if (!isCapture && message.reason !== 'gameOver') {
    const shooterState = getPlayerStateOf(message.shooterId);
    const victimState = getPlayerStateOf(message.victimId);
    const deltas = getKillScoreDeltas({
      killerId: shooterState ? message.shooterId : null,
      victimId: message.victimId,
      killerTeam: shooterState?.team ?? null,
      victimTeam: victimState?.team ?? null,
      teamsAllowed: gameConfig?.TEAMS_ALLOWED !== false,
      killerWasRabbit: shooterState?.wasRabbit === true,
    });
    addScore(victimState, deltas.victim);
    addScore(shooterState, deltas.killer);
    // Personal head-to-head record (Player::changeLocalScore, playing.cxx:2556):
    // kept on the opponent's own state, not mine, so their scoreboard row can
    // show my score against them specifically -- the aggregate kills/deaths
    // above is everyone else's fight too, not just ours. A self-destruct
    // updates neither side of it; it only ever moves my own selfKills.
    if (isSelfDestruct) {
      if (victimId === myPlayerId && victimTank?.userData.playerState) {
        victimTank.userData.playerState.selfKills = (victimTank.userData.playerState.selfKills || 0) + 1;
      }
    } else if (shooterId === myPlayerId && victimTank?.userData.playerState) {
      victimTank.userData.playerState.localWins = (victimTank.userData.playerState.localWins || 0) + 1;
    } else if (victimId === myPlayerId && shooterTank?.userData.playerState) {
      shooterTank.userData.playerState.localLosses = (shooterTank.userData.playerState.localLosses || 0) + 1;
    }
    refreshScoreboards();
  }

  // Remove the projectile. A shock wave is the exception: `isStoppedByHit()` is
  // false for it, so it goes on swelling through everybody else it reaches and
  // the server ends it on its own clock rather than on this kill.
  if (!projectiles.get(message.projectileId)?.userData?.shockwave) {
    removeProjectile(message.projectileId, 0);
  }

  // Get victim tank and create explosion effect
  if (victimTank) {
    clearJumpPredictionDebug(victimTank);
    // gotBlowedUp's `setStatus(getStatus() & ~PlayerState::Alive)`
    // (playing.cxx:3990) for your own tank, and `setExplode()` for anybody
    // else's. The server sends no state with the kill -- the next one it sends
    // for this player is the respawn -- so until this runs the client still
    // believes the tank it just exploded is alive, and everything that asks
    // (`isMyTankAlive`, the roam list, who a missile may lock) gets the stale
    // answer. Upstream never has this to do because a death is a status flag on
    // the same struct the explosion is drawn from.
    if (victimTank.userData.playerState) victimTank.userData.playerState.alive = false;
    // Immediately hide the tank from the scene
    victimTank.visible = false;
    // Create explosion with tank parts
    const explosionResult = renderManager.createExplosion(
      victimTank.position, victimTank, deathSound, {
        explodeTime: Number.isFinite(gameConfig?.RESPAWN_DELAY) ? gameConfig.RESPAWN_DELAY / 1000 : 5,
        size: Number.isFinite(gameConfig?.TANK_EXPLOSION_SIZE) ? gameConfig.TANK_EXPLOSION_SIZE : 3.5 * TANK.length,
      },
    );
    if (message.victimId === myPlayerId) {
      // ForceFeedback::death (playing.cxx:3936). Upstream also shakes a pad
      // for the tank an observer is riding in; bzo keeps it to the player's own.
      if (!isObserver()) rumble('death');
      deathCameraActive = true;
      deathFollowTarget = explosionResult?.followTarget || null;
      renderManager.deathFollowTarget = deathFollowTarget;
      renderManager.setDeathFollowAnchor(victimTank.position);
      const vp = victimTank.position;
      debugLog(`deathCam playerPos=${vp.x.toFixed(1)},${vp.y.toFixed(1)},${vp.z.toFixed(1)} hasDebris=${!!deathFollowTarget}`, 'death');
      updateDeathCameraHudVisibility();
    }
  }
}

function handlePlayerRespawn(message) {
  const tank = tanks.get(message.player.id);
  if (tank) {
    clearJumpPredictionDebug(tank);
    if (message.player.id === myPlayerId) {
      deathCameraActive = false;
      deathFollowTarget = null;
      renderManager.deathFollowTarget = null;
      renderManager.deathFollowAnchor = null;
      updateDeathCameraHudVisibility();
      // `LocalPlayer::restart` (LocalPlayer.cxx:1052) deletes every shot the
      // tank had, so it comes back loaded. The server clears its own copy of
      // this on the same event; a jam does not survive the life it was charged
      // in either, since the flag that charged it is gone with the tank.
      myShotSlotFreeAt = [];
      myShotSlotReloadMs = [];
      shotJamUntil = 0;
      // A new life is a new death to report. Cleared here rather than in the
      // `killed` handler because the tank is not standing anywhere until it
      // respawns, and a cleared guard with no tank would let the very next
      // frame report the same water or death pad again.
      reportedOwnDeath = false;
    }
    placeTank(tank, message.player.x, message.player.y, message.player.z, message.player.azimuth);
    tank.userData.verticalVelocity = message.player.verticalVelocity;
    tank.userData.forwardSpeed = message.player.forwardSpeed || 0;
    tank.userData.rotationSpeed = message.player.rotationSpeed || 0;
    tank.userData.jumpAzimuth = message.player.jumpAzimuth ?? null;
    tank.userData.slideAzimuth = message.player.slideAzimuth;
    tank.userData.airVelocityX = message.player.airVelocityX || 0;
    tank.userData.airVelocityY = message.player.airVelocityY || 0;

    // Update player state with full respawn data (including alive = true).
    // Merged forward through the same helper addPlayer() uses, not a plain
    // overwrite -- a respawn is exactly the message that used to erase the
    // kill just landed on this player a moment earlier.
    tank.userData.playerState = withClientLocalPlayerState(tank.userData.playerState, message.player);

    // Update ghost mesh position BEFORE making it visible
    if (tank.userData.ghostMesh) {
      placeTank(tank.userData.ghostMesh, message.player.x, message.player.y, message.player.z, message.player.azimuth);
      tank.userData.ghostMesh.visible = showDebugGeometry;
    }

    // Update server position for extrapolation
    tank.userData.serverPosition = {
      x: message.player.x,
      y: message.player.y,
      z: message.player.z,
      azimuth: message.player.azimuth
    };

    tank.visible = true;

    if (message.player.alive) {
      triggerSpawnEffectForTank(tank, message.player.color);
    }
  }

  refreshScoreboards();

  if (message.player.id === myPlayerId) {
    myX = message.player.x;
    myY = message.player.y;
    myZ = message.player.z;
    myAzimuth = message.player.azimuth;
    // The new life starts unpaused on both ends -- the server's own `respawn`
    // clears the pause and the countdown -- and then asks again for whatever is
    // still true: a menu still in front of the game, or the countdown the player
    // was in when they died. The asking outlives the life; P still calls it off.
    if (pauseState.respawned({
      covered: shouldAutoPause(),
      alive: true,
      observer: isObserver(),
    })) {
      sendToServer({ type: 'pause' });
    }
    showMessage('You respawned!');
    // Nothing to restore: `cameraMode` was never taken away. Clearing the body
    // is what ends the death camera, and the view the player chose -- Overview
    // included -- is the one they come back to.
  }
}
// The scoreboard, assembled once for every surface that draws it. Two of them
// do -- the flat HUD's DOM list and the headset's canvas panel -- and they had
// each gathered their own inputs, which is how they came to disagree: a repaint
// that reached one of them without the flag lookup dropped every carried flag
// off the board, and the two sorted their rows by different rules.
//
// So the roster is built here and nowhere else. `refreshScoreboards()` is the
// only entry point, it takes no arguments, and there is nothing for a caller to
// leave out.
let scoreboardModel = null;
let scoreboardVersion = 0;

function getScoreboardModel() {
  if (!scoreboardModel) {
    const observing = isObserver();
    scoreboardVersion += 1;
    scoreboardModel = {
      version: scoreboardVersion,
      rows: buildScoreboardRows({
        myPlayerId, myPlayerName, myTank, tanks, getPlayerFlagLabel,
        rabbitChase: rabbitChaseEnabled,
        huntedIds: huntState.hunted,
        huntCursorId: huntState.getCursorId(),
      }),
      teamRows: getTeamScoreRows(teamScores),
      // Only the column heading reads this; the rows carry their own rank.
      rabbitChase: rabbitChaseEnabled,
      // Only the heading reads this too: the cursor itself is on a row.
      huntSelecting: huntState.isSelecting(),
      timeLeft: getDisplayedMatchTimeLeft(),
      gameOver: matchGameOver,
      // Only an observer can pick a roam target, and only an explicit one is
      // marked: with no target the view follows the leader, and marking the top
      // row would claim a choice the player did not make.
      roamTargetId: observing ? roamTargetId : null,
      onSelectRoamTarget: observing ? selectRoamTarget : null,
      // Offers the BZID column. The values themselves only arrive in the
      // roster when the server agrees, so this decides the column and not the
      // secret.
      isAdmin: amAdmin,
    };
  }
  return scoreboardModel;
}

// Every change to the roster, the scores or the roaming target ends here. The
// DOM list is rebuilt now; the headset's panel is painted from the render loop
// and picks the new model up on its next frame, which is also what keeps it
// from repainting a canvas that has not changed.
// The cursor is drawn on the roster, so a collapsed roster is borrowed for as
// long as a hunt is being aimed and handed back once it is committed or backed
// out of. Every path that opens or closes the cursor -- `U`, `7`, the fire key,
// the Hunt row in Settings, a marked player leaving -- repaints the board, so
// asking here covers all of them rather than each remembering to.
function syncHuntScoreboard() {
  if (huntState.isSelecting()) borrowScoreboard();
  else returnScoreboard();
}

function refreshScoreboards() {
  syncHuntScoreboard();
  scoreboardModel = null;
  updateScoreboard(getScoreboardModel());
  // The Hunt row reads the same roster and the same marks, so a board repaint
  // is also when the row goes stale -- a player leaving takes a name out of its
  // list, and a key press changes the ring it is showing.
  refreshSettingsMenu();
}

// The Operator panel's Delete Upload choices: the maps and replays it
// uploaded that are still here, as the server lists them.
function populateDeleteUploadSelect(uploaded) {
  const select = document.getElementById('deleteUploadSelect');
  if (!select) return;
  select.innerHTML = '';
  const add = (kind, name, label) => {
    const option = document.createElement('option');
    option.value = JSON.stringify({ kind, name });
    option.textContent = label;
    select.appendChild(option);
  };
  for (const name of uploaded?.maps || []) add('maps', name, `map ${name}`);
  for (const name of uploaded?.replays || []) add('replays', name, `replay ${name}`);
  if (select.options.length === 0) {
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'nothing uploaded';
    select.appendChild(none);
  }
}

function handleMapsList(message) {
  const mapList = document.getElementById('mapList');
  if (!mapList) return;
  populateDeleteUploadSelect(message.uploads);

  // Clear existing options
  mapList.innerHTML = '';

  message.maps.forEach((mapName) => {
    const option = document.createElement('option');
    option.value = mapName;
    option.textContent = mapName;
    mapList.appendChild(option);
  });

  if (message.currentMap) {
    currentMapFile = message.currentMap;
    mapList.value = message.currentMap;
  }

  const motdEl = document.getElementById('motd');
  const motdInput = document.getElementById('motdInput');
  if (motdEl) motdEl.textContent = `MOTD: ${serverMotdText}`;
  if (motdInput) motdInput.value = serverMotdText;

  if (typeof message.ricochet === 'boolean') {
    applyRicochetSetting(message.ricochet);
  }
  // The panel reads the server's values, so a map list that carries new ones has
  // to re-stage from them -- unless somebody is mid-edit, whose staged copy is
  // theirs until they commit or cancel.
  if (!operatorStaged) syncOperatorPanelFromServer();

  // The entry dialog's own picker reads `availableViewMaps`, which `init`
  // seeds once. A map hashed after that -- the background trickle finishing
  // its pass, or a remote import landing -- arrives as one of these, so the
  // list has to take it too or it stays stuck on whatever existed the moment
  // this client connected.
  if (Array.isArray(message.viewableMaps)) {
    availableViewMaps = message.viewableMaps;
  }
  populateViewMapTable(Array.isArray(message.viewableMaps) ? message.viewableMaps : []);
}

// The View dialog's own state. Two independent replies (`mapList` and
// `remoteServerList`) can arrive in either order, and the remote table's
// View/Import choice per row depends on both -- so each handler updates its
// own cache and both funnel through `renderServerTable`, rather than the
// remote-list handler trusting whichever `viewableMapFiles` happened to
// already be there.
let viewableMapFiles = new Set();
// The full {file,hash,url} entries behind `viewableMapFiles`, so `viewMapFile`
// can hand one straight to `loadWorldFile` without a round trip back to the
// server just to ask for what it was already sent.
let viewableMapEntries = [];
let lastRemoteServers = [];

// Mirrors `remoteMapFileName` in server.js -- the only other place this
// naming is allowed to happen, so a check here and the file the server
// actually wrote can never disagree.
function remoteMapFileName(host, port) {
  return `import-${host}_${port}`.replace(/[^A-Za-z0-9._-]/g, '_') + '.bzw';
}

// A table row that behaves like the button it replaces: pointer, keyboard and
// a name, since a bare `click` handler on a `<tr>` is reachable by mouse only.
function makeRowActivate(row, activate, label) {
  row.classList.add('clickable');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', label);
  row.addEventListener('click', activate);
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activate();
  });
}

// Whether this connection may watch a live game on a server this instance
// does not proxy. Both halves are the server's own answer, already on `init`:
// verified is what makes the forum name sendable, and admin is the gate on
// connecting anywhere the operator did not configure. The server checks the
// same two things again on the socket -- this only decides whether to offer.
function canWatchRemoteServers() {
  return amVerified && amAdmin;
}

// The row tooltip: what the four columns leave out. Only what the map states,
// so a map with no teleporters says nothing about them rather than "0".
function describeMapStats(stats) {
  const parts = [];
  const counts = stats.counts || {};
  // Spelled out rather than suffixed: "box" takes -es and "pyramid" takes -s.
  for (const [key, one, many] of [
    ['box', 'box', 'boxes'],
    ['pyramid', 'pyramid', 'pyramids'],
    ['mesh', 'mesh', 'meshes'],
  ]) {
    const count = counts[key];
    if (count) parts.push(`${count.toLocaleString()} ${count === 1 ? one : many}`);
  }
  if (stats.bases) parts.push(`${stats.bases} base${stats.bases === 1 ? '' : 's'}`);
  if (stats.teleporters) {
    parts.push(`${stats.teleporters} teleporter${stats.teleporters === 1 ? '' : 's'}`);
  }
  const has = [];
  if (stats.water) has.push('water');
  if (stats.weather) has.push('weather');
  if (stats.ground) has.push('custom ground');
  if (has.length) parts.push(has.join(', '));
  return parts.join(' | ');
}

function populateViewMapTable(viewableMaps) {
  viewableMapFiles = new Set(viewableMaps.map((entry) => entry.file));
  viewableMapEntries = viewableMaps;
  const tbody = document.querySelector('#viewMapTable tbody');
  if (tbody) {
    tbody.innerHTML = '';
    for (const entry of viewableMaps) {
      const row = document.createElement('tr');
      const stats = entry.stats || null;
      // What the map is, before anyone waits for it to load. Faces is the
      // column that earns its place: nothing else predicts it, and it is what
      // decides whether a map is worth opening on a phone or in a headset.
      const nameCell = document.createElement('td');
      nameCell.textContent = entry.file;
      const numberCell = (value) => {
        const td = document.createElement('td');
        if (Number.isFinite(value)) {
          td.textContent = value.toLocaleString();
          // What the column sorts on, since the text is grouped for reading.
          td.dataset.value = String(value);
        } else {
          td.textContent = '';
        }
        return td;
      };
      const styleCell = document.createElement('td');
      styleCell.textContent = stats?.style || '';
      // The breakdown rides on the row's own tooltip rather than in columns:
      // it is detail to read about one map, not a number to compare maps by.
      if (stats) row.title = describeMapStats(stats);
      // The row is the button. A table where every row carries an identical
      // one-word control is a table with a column of noise in it, and `/list`
      // already treats a row as the way in (`tbody tr.clickable`, server.js).
      makeRowActivate(row, () => viewMapFile(entry.file), `View ${entry.file}`);
      row.append(
        nameCell,
        numberCell(stats?.size),
        numberCell(stats?.objects),
        numberCell(stats?.faces),
        styleCell,
      );
      tbody.appendChild(row);
    }
  }
  renderServerTable();
}

// The View dialog's remote-server table. `listRemoteServers` never connects
// to any server it lists (see server.js) -- only pressing Import does that,
// same as the /list page this mirrors.
function handleRemoteServerList(message) {
  lastRemoteServers = Array.isArray(message.servers) ? message.servers : [];
  renderServerTable();
}

function renderServerTable() {
  const tbody = document.querySelector('#viewServerTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const server of lastRemoteServers) {
    const fileName = remoteMapFileName(server.host, server.port);
    const alreadyImported = viewableMapFiles.has(fileName);
    const row = document.createElement('tr');
    const cell = (text) => {
      const td = document.createElement('td');
      td.textContent = text;
      return td;
    };
    row.append(
      cell(typeof server.players === 'number' ? String(server.players) : ''),
      cell(typeof server.maxPlayers === 'number' ? String(server.maxPlayers) : ''),
      cell(server.style || ''),
      cell(server.title || ''),
      cell(server.host),
      cell(String(server.port)),
    );
    // The row is the action here too. A server nobody has imported yet is
    // fetched first and shown when it lands (`pendingRemoteView`), so the old
    // two-step "Import, then View" is one press on the row.
    const actionCell = document.createElement('td');
    let fetching = false;
    makeRowActivate(row, () => {
      if (viewableMapFiles.has(fileName)) {
        viewMapFile(fileName);
        return;
      }
      if (fetching) return;
      fetching = true;
      pendingRemoteView = {
        fileName,
        done: () => { fetching = false; },
      };
      // The wording a `?viewmap=` link already uses for this exact step, so
      // the two ways in read the same. The map's own load takes over from
      // here once the fetch lands (`viewMapFile`).
      setLoadingOverlayState({
        visible: true,
        progress: 0.02,
        status: 'Fetching remote server\'s map...',
        detail: `${server.host}:${server.port}`,
      });
      sendToServer({ type: 'importMap', hostPort: `${server.host}:${server.port}` });
      // The reply may never come -- a server that stopped answering between
      // being listed and being asked. The row goes back to offering rather
      // than sitting on a promise nothing will keep.
      setTimeout(() => {
        if (pendingRemoteView?.fileName !== fileName || !fetching) return;
        pendingRemoteView = null;
        fetching = false;
        hideLoadingOverlay();
        showMessage(`${server.host}:${server.port} did not answer`);
      }, 15000);
    }, `View ${server.title || server.host}`);
    // Watching is the live game rather than the map: a real observer
    // connection to that server, carrying the forum callsign bzo verified
    // (`docs/list-server-plan.md`). Offered only to an admin of this instance
    // who is signed in, because it connects this server to one its operator
    // never configured -- and because bzo will not send a name it did not
    // check. Stops the click reaching the row, which would view instead.
    if (canWatchRemoteServers()) {
      const watchBtn = document.createElement('button');
      watchBtn.type = 'button';
      watchBtn.textContent = 'Watch';
      watchBtn.title = `Watch the live game on ${server.host}:${server.port}`;
      watchBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        // A navigation like every other destination change: the target has to
        // be fixed before the socket opens, because `init` is built from it.
        // `host_port`, not `host:port` -- the spelling `?proxy=` already uses,
        // so a browser shows the address rather than offering to search it.
        window.location.href = `${window.location.pathname}?watch=`
          + encodeURIComponent(`${server.host}_${server.port}`);
      });
      actionCell.appendChild(watchBtn);
    }
    // Kept beside it only where there is already a copy to replace: a map
    // imported an hour ago is not the map that server is running now. It stops
    // the click going through to the row, which would view rather than refetch.
    if (alreadyImported) {
      const importBtn = document.createElement('button');
      importBtn.type = 'button';
      importBtn.textContent = 'Re-import';
      importBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        importBtn.disabled = true;
        importBtn.textContent = 'Importing…';
        sendToServer({ type: 'importMap', hostPort: `${server.host}:${server.port}` });
        setTimeout(() => {
          importBtn.disabled = false;
          importBtn.textContent = 'Re-import';
        }, 4000);
      });
      actionCell.appendChild(importBtn);
    }
    row.appendChild(actionCell);
    tbody.appendChild(row);
  }
}

// A rejoin, not a lighter-weight preview: this sends the same `joinGame` the
// entry dialog's Map Viewer team already does (see `getJoinTeamFields`),
// reachable here mid-game as well as before joining. Chat persists, score
// resets and the tank colour changes exactly as switching to any other team
// already does -- there is nothing View-specific about the mechanism, only
// about how the player got here.
//
// Unlike the entry dialog, nothing already previewed this file's geometry
// behind the dialog, so this has to do that part itself -- `applyWorldData`
// here is what the entry dialog's `syncMapViewerPreview` does automatically
// while cycling choices. The map's own message is not said here: it fires
// once, from the join confirmation (`playerJoined`), the same trigger the
// entry dialog's flow uses -- saying it here too would be twice for one
// switch.
function viewMapFile(file) {
  selectedPlayerTeam = PLAYER_TEAM.MAP_VIEWER;
  storePlayerTeamChoice(selectedPlayerTeam);
  selectedViewMapFile = file;
  syncPlayerTeamSelector();
  const entry = viewableMapEntries.find((candidate) => candidate.file === file);
  // The same overlay a `?viewmap=` link puts up, for the same wait. Arriving by
  // link and pressing View do identical work -- fetch the world, build it,
  // rejoin looking at it -- and until now only the link said so, leaving the
  // dialog's press looking like nothing had happened for as long as a large
  // map takes. The stages are the real ones: the fetch, then the build, which
  // is where the time goes (`prepareInitialRender` names the same two).
  setLoadingOverlayState({
    visible: true,
    progress: 0.05,
    status: 'Loading map...',
    detail: file,
  });
  const worldPromise = entry
    ? loadWorldFile(entry).then((world) => {
      setLoadingOverlayState({
        visible: true,
        progress: 0.4,
        status: 'Building world geometry...',
        detail: file,
      });
      return applyWorldData(world);
    })
    : Promise.resolve();
  worldPromise.finally(() => {
    // Hidden whichever way it went. A map that failed to load leaves the view
    // where it was, and an overlay left up over it would be the only thing
    // still claiming to be busy.
    hideLoadingOverlay();
    if (proxyTeamChangeNavigated(getJoinTeamFields().team)) return;
    sendToServer({
      type: 'joinGame',
      name: myPlayerName,
      isMobile,
      tankModel: selectedTankModelId,
      motto: myPlayerMotto,
      bot: IS_BOT_CLIENT,
      page: PAGE_TOKEN,
      ...getJoinTeamFields(),
    });
  });
  toggleViewPanel();
}

function requestViewData() {
  sendToServer({ type: 'listRemoteServers' });
  sendToServer({ type: 'getMaps' });
  void refreshViewReplayTable();
}

// The View dialog's "Local replays": this instance's recordings, over HTTP
// rather than the socket, since a proxied or replay connection answers only
// what its target would. A row is the way in, as a map's is.
async function refreshViewReplayTable() {
  const tbody = document.querySelector('#viewReplayTable tbody');
  if (!tbody) return;
  let replays = [];
  try {
    const response = await fetch('/api/replays', { cache: 'no-store' });
    if (response.ok) replays = (await response.json()).replays || [];
  } catch {
    // Listed as none; the dialog's other tables are unaffected.
  }
  tbody.innerHTML = '';
  for (const entry of replays) {
    const row = document.createElement('tr');
    const cell = (text, value) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (value !== undefined) td.dataset.value = String(value);
      return td;
    };
    const whole = Math.round(entry.seconds || 0);
    row.append(
      cell(entry.name),
      // UTC, as /list writes it.
      cell(entry.start ? new Date(entry.start).toISOString().replace('T', ' ').slice(0, 16) : ''),
      cell(`${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`, whole),
      cell(String(entry.players || 0), entry.players || 0),
      cell(entry.map || ''),
    );
    if (entry.viewers) row.title = `${entry.viewers} watching now`;
    makeRowActivate(row, () => {
      window.location.href = `${window.location.pathname}?replay=${encodeURIComponent(entry.name)}`;
    }, `Watch ${entry.name}`);
    tbody.appendChild(row);
  }
}

function openViewPanel() {
  requestViewData();
}

// A View press on a server nobody had imported yet, waiting for the fetch.
let pendingRemoteView = null;

function importMapResultReceived(message) {
  const waiting = pendingRemoteView;
  if (message.success && message.file) {
    // The reply already renamed the file it wrote; re-asking for the maps
    // list is what turns that into a `viewableMapFiles` entry the table can
    // offer. Cheap and always fresh, unlike the entry dialog's
    // `init.viewableMaps`, which only updates on a reload.
    sendToServer({ type: 'getMaps' });
    // Whoever pressed View is owed the map, not just the download. The
    // reply's own filename is used rather than the one guessed from the
    // address, because the server is what decides what it wrote.
    if (waiting) {
      pendingRemoteView = null;
      waiting.done?.();
      viewMapFile(message.file);
      return;
    }
  }
  if (!waiting) return;
  // Nothing to show, so the button goes back to offering rather than sitting
  // disabled on a fetch that failed.
  pendingRemoteView = null;
  waiting.done?.();
  hideLoadingOverlay();
  showMessage('That server\'s map could not be fetched');
}

// The reply to `requestMapImportForView`. Ignored if it is not an answer to
// the request still pending -- a reconnect before this landed already moved
// on to a new `init` and a new (or no) request of its own -- otherwise
// finishes the join `case 'init'` deferred: as Map Viewer, with
// `availableViewMaps` updated from this same reply so the picker and the
// preview see the map that just got imported, or as an ordinary join if the
// import failed.
function handleImportMapForViewResult(message) {
  const pending = pendingViewMapImport;
  if (!pending || pending.file !== message.file || pending.sequenceId !== activeInitSequence) return;
  pendingViewMapImport = null;
  if (message.success) {
    if (Array.isArray(message.viewableMaps)) availableViewMaps = message.viewableMaps;
    pending.onSuccess();
  } else {
    setHudAlert(2, `Could not load that server's map: ${message.reason || 'import failed'}`, 6, true);
    pending.onFailure();
  }
}

// Shared by both View dialog tables (and mirrors the same few lines /list's
// own inline script uses): click a header to sort by that column, type in
// the filter box to hide rows that do not match anywhere in the row's text.
function attachSortFilter(tableId, filterId) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const tbody = table.tBodies[0];
  Array.from(table.tHead.rows[0].cells).forEach((th, colIndex) => {
    let dir = 1;
    th.addEventListener('click', () => {
      const numeric = th.dataset.sort === 'num';
      const rows = Array.from(tbody.rows);
      rows.sort((a, b) => {
        const acell = a.cells[colIndex];
        const bcell = b.cells[colIndex];
        let av = acell?.textContent.trim() || '';
        let bv = bcell?.textContent.trim() || '';
        if (numeric) {
          // The raw value where a cell carries one, because a displayed number
          // is grouped for reading -- `parseFloat('81,332')` is 81, which sorted
          // the largest map in the list down among the small ones. Stripping the
          // separator would work only for a locale that groups with a comma, and
          // `toLocaleString` follows the reader's.
          const an = parseFloat(acell?.dataset.value ?? av);
          const bn = parseFloat(bcell?.dataset.value ?? bv);
          return ((Number.isNaN(an) ? -Infinity : an) - (Number.isNaN(bn) ? -Infinity : bn)) * dir;
        }
        return av.localeCompare(bv) * dir;
      });
      dir *= -1;
      rows.forEach((row) => tbody.appendChild(row));
    });
  });
  const filterInput = filterId && document.getElementById(filterId);
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      const q = filterInput.value.toLowerCase();
      Array.from(tbody.rows).forEach((row) => {
        row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  }
}

function handleServerConfigUpdate(message) {
  if (typeof message.title === 'string') {
    serverTitleText = message.title;
    const serverTitleEl = document.getElementById('serverTitle');
    const serverTitleInput = document.getElementById('serverTitleInput');
    if (serverTitleEl) serverTitleEl.textContent = serverTitleText;
    if (serverTitleInput) serverTitleInput.value = serverTitleText;
  }

  if (typeof message.motd === 'string') {
    serverMotdText = message.motd;
    const serverMotdEl = document.getElementById('serverMotd');
    const motdEl = document.getElementById('motd');
    const motdInput = document.getElementById('motdInput');
    if (serverMotdEl) serverMotdEl.textContent = serverMotdText;
    if (motdEl) motdEl.textContent = `MOTD: ${serverMotdText}`;
    if (motdInput) motdInput.value = serverMotdText;
  }

  announceServerTextIfChanged();

  // Written to the live match's own config, not to `gameConfig`, which may be
  // a Map Viewer preview's overlay over it -- an operator's change belongs to
  // the match either way, and `applyWorldGameplay` below rebuilds the overlay
  // on top of it. The two are the same object whenever no preview is up.
  if (Number.isFinite(message.shotMaxActive) && liveGameConfig) {
    worldBaseConfig.SHOT_MAX_ACTIVE = message.shotMaxActive;
  }

  if (typeof message.ricochet === 'boolean') {
    applyRicochetSetting(message.ricochet);
  }

  if (Number.isFinite(message.timeLimit) && liveGameConfig) {
    worldBaseConfig.TIME_LIMIT = message.timeLimit;
  }
  if (typeof message.timeManualStart === 'boolean' && liveGameConfig) {
    worldBaseConfig.TIME_MANUAL_START = message.timeManualStart;
  }
  if (Number.isFinite(message.maxPlayerScore) && liveGameConfig) {
    worldBaseConfig.MAX_PLAYER_SCORE = message.maxPlayerScore;
  }
  if (Number.isFinite(message.maxTeamScore) && liveGameConfig) {
    worldBaseConfig.MAX_TEAM_SCORE = message.maxTeamScore;
  }
  if (Number.isFinite(message.botFill)) serverOperatorConfig.botFill = message.botFill;
  if (typeof message.botPilot === 'string') serverOperatorConfig.botPilot = message.botPilot;
  // Whatever world is on screen keeps its own physics over the top of the
  // values that just moved.
  recomputeLiveConfig();
  applyWorldGameplay(currentWorldData);
  // An applied change is now the server's value, so the panel starts from it.
  // A staged edit survives: it belongs to whoever is typing, not to the update.
  if (!operatorStaged) syncOperatorPanelFromServer();
}

// The Operator panel stages every edit and commits on one confirm, exactly as
// the entry dialog stages a name, a team and a tank. `operatorStaged` holds the
// edits while the panel is open and is thrown away by Cancel, the `X`, or a
// commit -- so re-opening always starts from what the server currently has.
//
// See docs/operator-panel-plan.md. The short version: a button per row meant a
// restart per row on a dev box, and in a headset it meant two rows per setting.
let operatorStaged = null;
// Which map the server is actually running, so a staged choice can be compared
// against it. `mapList.value` is the staged one once the panel is open.
let currentMapFile = '';
// Sent in `init`: the settings that can change without starting a new game.
// Read rather than duplicated, so the confirm's label cannot promise something
// the server will not do.
// Whether this connection's shots are this client's to fly to their end. A
// bzo server traces every shot and says where it stopped; a proxied target
// leaves that to each client the way upstream always has.
let clientTracesShots = false;
let liveConfigKeys = ['title', 'motd', 'shotMaxActive', 'ricochet'];
// Sent in `init` too: what every setting the panel offers is currently set to.
// The three live ones are read from the live config below instead, since a
// `serverConfigUpdate` moves those without an `init` to carry them.
let serverOperatorConfig = {};

// Zero is a real setting, not a floor to clamp away: it is upstream's own
// "tanks cannot shoot" (`-ms 0`), and an operator who can read it off a map
// should be able to set it here too.
const SHOT_MAX_ACTIVE_MIN = 0;
const SHOT_MAX_ACTIVE_MAX = 10;
// Matches the slider in index.html and the server's own ceiling
// (`OPERATOR_TIME_LIMIT_MAX`); 0 is upstream's "no limit".
const OPERATOR_TIME_LIMIT_MAX = 3600;
const OPERATOR_TIME_LIMIT_STEP = 15;
// Matches the sliders in index.html and the server's own ceiling
// (`OPERATOR_SCORE_LIMIT_MAX`); 0 is upstream's "no limit" for either.
const OPERATOR_SCORE_LIMIT_MAX = 100;
// Upstream's own ceiling on a player count (`MaxPlayers`, CmdLineOptions.h:37).
const OPERATOR_LIMIT_MAX = 200;
// A `choice` row needs an off position where a command line switch is simply
// absent, so `-rabbit [score|killer|random]` becomes four values.
const RABBIT_SELECTIONS = ['off', 'score', 'killer', 'random'];
// One limit row per team, observer first: it is the one team every mode has,
// including Rabbit Chase, where it is the only team anyone may ask for.
const OPERATOR_LIMIT_TEAMS = [
  PLAYER_TEAM.OBSERVER,
  PLAYER_TEAM.ROGUE,
  PLAYER_TEAM.RED,
  PLAYER_TEAM.GREEN,
  PLAYER_TEAM.BLUE,
  PLAYER_TEAM.PURPLE,
];
// The teams the playing limit counts and caps -- upstream's `CtfTeams` span,
// which leaves the observers outside it (CmdLineOptions.cxx:453). Map Viewer
// (issue #68) has no row of its own here at all -- it is Observer on the
// wire, so an operator caps it by capping Observer.
const OPERATOR_PLAYING_TEAMS = OPERATOR_LIMIT_TEAMS.filter((team) => team !== PLAYER_TEAM.OBSERVER);
// The rows `resolveTeamMode` zeroes when teams are off or rabbit chase is on.
const OPERATOR_COLOR_TEAMS = [
  PLAYER_TEAM.RED, PLAYER_TEAM.GREEN, PLAYER_TEAM.BLUE, PLAYER_TEAM.PURPLE,
];
const operatorLimitKey = (team) => `${team}Limit`;

function getOperatorServerState() {
  return {
    ...serverOperatorConfig,
    title: serverTitleText || '',
    motd: serverMotdText || '',
    // `|| SHOT_MAX_ACTIVE_MIN` would read a real zero as "no value" and then
    // answer with the minimum, which is now zero itself -- so the panel has
    // to ask whether the server said anything at all, not whether what it
    // said was truthy. One shot stands in until it has.
    shotMaxActive: Number.isFinite(gameConfig?.SHOT_MAX_ACTIVE)
      ? normalizeShotSlotCount(gameConfig.SHOT_MAX_ACTIVE)
      : 1,
    ricochet: Boolean(gameConfig?.ALL_SHOTS_RICOCHET),
    timeLimit: Number(gameConfig?.TIME_LIMIT) || 0,
    timeManualStart: Boolean(gameConfig?.TIME_MANUAL_START),
    maxPlayerScore: Number(gameConfig?.MAX_PLAYER_SCORE) || 0,
    maxTeamScore: Number(gameConfig?.MAX_TEAM_SCORE) || 0,
    mapFile: currentMapFile || serverOperatorConfig.mapFile || '',
    botFill: Number(serverOperatorConfig.botFill) || 0,
    botPilot: serverOperatorConfig.botPilot || DEFAULT_PILOT,
  };
}

// Rabbit Chase derives the hunter limit from the rogue limit
// (CmdLineOptions.cxx:1596), so the rogue row is what caps the hunters there --
// relabelled rather than greyed, since greying it would leave an operator with
// no way to say how many people may play.
function getOperatorLimitLabel(team, rabbit) {
  const label = rabbit && team === PLAYER_TEAM.ROGUE
    ? PLAYER_TEAM_LABELS[PLAYER_TEAM.HUNTER]
    : PLAYER_TEAM_LABELS[team];
  return `${label} Limit:`;
}

// What a row's stepper may reach. In one place so the slider, the arrow keys and
// the XR arrows cannot disagree about it.
function getOperatorNumberBounds(key, state) {
  if (key === 'shotMaxActive') return { min: SHOT_MAX_ACTIVE_MIN, max: SHOT_MAX_ACTIVE_MAX };
  if (key === 'timeLimit') return { min: 0, max: OPERATOR_TIME_LIMIT_MAX };
  if (key === 'maxPlayerScore' || key === 'maxTeamScore') return { min: 0, max: OPERATOR_SCORE_LIMIT_MAX };
  if (key === 'botFill') return { min: 0, max: Number(state?.maxPlayers) || OPERATOR_LIMIT_MAX };
  // At least one tank: a server that allows none is one nobody can play on.
  if (key === 'maxPlayers') return { min: 1, max: OPERATOR_LIMIT_MAX };
  const team = OPERATOR_LIMIT_TEAMS.find((candidate) => operatorLimitKey(candidate) === key);
  if (team && OPERATOR_PLAYING_TEAMS.includes(team)) {
    return { min: 0, max: Number(state?.maxPlayers) || OPERATOR_LIMIT_MAX };
  }
  // Zero is a real value for a team limit: it turns the team off.
  return { min: 0, max: OPERATOR_LIMIT_MAX };
}

// The panel's own rows, built rather than written out: one per team, from the
// team list the client already has, so a row cannot name a team the rest of the
// client does not know about.
function buildOperatorTeamLimitRows() {
  const container = document.getElementById('operatorTeamLimits');
  if (!container || container.childElementCount > 0) return;
  for (const team of OPERATOR_LIMIT_TEAMS) {
    const key = operatorLimitKey(team);
    const row = document.createElement('div');
    row.className = 'operatorRow operatorConfigRow';
    row.dataset.menuRow = key;
    row.dataset.menuKind = 'range';

    const label = document.createElement('label');
    label.id = `${key}Label`;
    label.htmlFor = `${key}Slider`;
    label.textContent = getOperatorLimitLabel(team, false);

    const control = document.createElement('div');
    control.className = 'volumeControl';
    const slider = document.createElement('input');
    slider.id = `${key}Slider`;
    slider.className = 'volumeSlider';
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(OPERATOR_LIMIT_MAX);
    slider.step = '1';
    slider.value = '0';
    const value = document.createElement('output');
    value.id = `${key}Value`;
    value.className = 'volumeValue';
    value.setAttribute('for', slider.id);
    value.textContent = '0';
    slider.addEventListener('input', () => stageOperatorNumberValue(key, Number(slider.value)));

    control.append(slider, value);
    row.append(label, control);
    container.append(row);
  }
}

function setOperatorRangeRow(key, value, { disabled = false, max = null } = {}) {
  const slider = document.getElementById(`${key}Slider`);
  const output = document.getElementById(`${key}Value`);
  const number = Number(value);
  if (slider) {
    if (max !== null) slider.max = String(max);
    if (Number(slider.value) !== number) slider.value = String(number);
    slider.disabled = disabled;
  }
  if (output) output.textContent = Number.isFinite(number) ? String(number) : '';
}

// Overwrites a range row's own label for the rows where 0 means "off" rather
// than a literal zero -- `timeLimit`, `maxPlayerScore`, `maxTeamScore` -- all
// of which `setOperatorRangeRow` above has already written a plain number
// into. `format` is only for `timeLimit`, whose label is a duration rather
// than a bare count.
function setOperatorNoLimitLabel(outputId, value, format = String) {
  const output = document.getElementById(outputId);
  if (!output) return;
  output.textContent = value > 0 ? format(value) : 'No limit';
}

// The staged keys that differ from what the server has. Empty means the confirm
// has nothing to do, which is worth showing rather than letting somebody press
// it and wonder.
function getOperatorChanges() {
  if (!operatorStaged) return [];
  const current = getOperatorServerState();
  return Object.keys(operatorStaged).filter((key) => operatorStaged[key] !== current[key]);
}

function operatorChangesNeedRestart(changes) {
  return changes.some((key) => !liveConfigKeys.includes(key));
}

// Writes the staged values into the panel and labels the confirm by what it is
// about to do. Called on open and after every edit, so the label can never
// disagree with the rows above it.
// Every row, from one state -- staged while the panel is open, the server's own
// while it is not -- so the two paths cannot paint a row differently.
//
// Which rows the mode can honour is decided here as well: `resolveTeamMode`
// zeroes the colour teams when teams are off and when rabbit chase is on, so
// those rows grey out rather than offering a number the server would override.
// Same rule as capabilities.mjs, applied to gameplay.
function paintOperatorRows(state) {
  const rabbit = Boolean(state.rabbit) && state.rabbit !== 'off';
  setOperatorRangeRow('shotMaxActive', state.shotMaxActive);
  const ricochetInput = document.getElementById('ricochetInput');
  if (ricochetInput) ricochetInput.checked = Boolean(state.ricochet);
  const teamsInput = document.getElementById('teamsInput');
  if (teamsInput) {
    teamsInput.checked = state.teams === true;
    // Rabbit Chase is the last word on the game type whichever order the
    // switches arrived in (CmdLineOptions.cxx:1586), so with it on there is
    // nothing this row can decide.
    teamsInput.disabled = rabbit;
  }
  const jumpingInput = document.getElementById('jumpingInput');
  if (jumpingInput) jumpingInput.checked = state.jumping === true;
  setOperatorRangeRow('timeLimit', state.timeLimit);
  // setOperatorRangeRow just wrote the raw number; 0 reads "No limit" on every
  // one of these rows instead, upstream's own word for the same absence.
  setOperatorNoLimitLabel('timeLimitValue', state.timeLimit, (v) => formatMatchClock(v) || '0:00');
  const timeManualStartInput = document.getElementById('timeManualStartInput');
  if (timeManualStartInput) timeManualStartInput.checked = state.timeManualStart === true;
  setOperatorRangeRow('maxPlayerScore', state.maxPlayerScore);
  setOperatorNoLimitLabel('maxPlayerScoreValue', state.maxPlayerScore);
  setOperatorRangeRow('maxTeamScore', state.maxTeamScore);
  setOperatorNoLimitLabel('maxTeamScoreValue', state.maxTeamScore);
  setOperatorRangeRow('botFill', state.botFill, { max: getOperatorNumberBounds('botFill', state).max });
  const botFillValue = document.getElementById('botFillValue');
  if (botFillValue && !(state.botFill > 0)) botFillValue.textContent = 'Off';
  const botPilotSelect = document.getElementById('botPilotSelect');
  if (botPilotSelect) botPilotSelect.value = state.botPilot;
  const rabbitSelect = document.getElementById('rabbitSelect');
  if (rabbitSelect) {
    rabbitSelect.value = RABBIT_SELECTIONS.includes(state.rabbit) ? state.rabbit : 'off';
  }
  setOperatorRangeRow('maxPlayers', state.maxPlayers);
  for (const team of OPERATOR_LIMIT_TEAMS) {
    const key = operatorLimitKey(team);
    const bounds = getOperatorNumberBounds(key, state);
    setOperatorRangeRow(key, state[key], {
      disabled: OPERATOR_COLOR_TEAMS.includes(team) && (rabbit || state.teams !== true),
      max: bounds.max,
    });
    const label = document.getElementById(`${key}Label`);
    if (label) label.textContent = getOperatorLimitLabel(team, rabbit);
  }
}

function syncOperatorPanel() {
  if (!operatorStaged) return;
  const serverTitleInput = document.getElementById('serverTitleInput');
  if (serverTitleInput && serverTitleInput.value !== operatorStaged.title) {
    serverTitleInput.value = operatorStaged.title;
  }
  const motdInput = document.getElementById('motdInput');
  if (motdInput && motdInput.value !== operatorStaged.motd) motdInput.value = operatorStaged.motd;
  const mapList = document.getElementById('mapList');
  if (mapList && operatorStaged.mapFile && mapList.value !== operatorStaged.mapFile) {
    mapList.value = operatorStaged.mapFile;
  }
  paintOperatorRows(operatorStaged);

  const changes = getOperatorChanges();
  const restart = operatorChangesNeedRestart(changes);
  const apply = document.getElementById('operatorApplyBtn');
  if (apply) {
    apply.textContent = restart ? 'Restart' : 'Apply';
    apply.classList.toggle('startsNewGame', restart);
    apply.disabled = changes.length === 0;
    apply.title = restart
      ? 'Starts a new game: every player reloads into the new settings'
      : 'Applies the staged changes';
  }
}

function openOperatorPanel() {
  operatorStaged = getOperatorServerState();
  syncOperatorPanel();
}

// Paints the panel from what the server has, for when nothing is staged. The
// rows are still the operator's view of the world while the panel is shut, so
// they are worth keeping current.
function syncOperatorPanelFromServer() {
  paintOperatorRows(getOperatorServerState());
  const apply = document.getElementById('operatorApplyBtn');
  if (apply) {
    apply.textContent = 'Apply';
    apply.classList.remove('startsNewGame');
    apply.disabled = true;
  }
}

function discardOperatorPanel() {
  operatorStaged = null;
  // Painted back to the server's own values rather than left showing the edit
  // that was just abandoned: the rows are the operator's view of the world while
  // the panel is shut, and the XR menu reads the same state.
  syncOperatorPanelFromServer();
}

function commitOperatorPanel() {
  const changes = getOperatorChanges();
  if (changes.length === 0 || !ws || ws.readyState !== WebSocket.OPEN) return;
  const payload = { type: 'setOperatorConfig' };
  for (const key of changes) payload[key] = operatorStaged[key];
  sendToServer(payload);
  // Thrown away on send rather than on the reply: the reply is a restart for
  // half of these, and there is nothing to stage against afterwards.
  operatorStaged = null;
}

// Each row edits the staged copy and nothing else. Called once, and every
// surface that changes a value goes through `stageOperatorChange` so the label
// is recomputed from one place.
function stageOperatorChange(key, value) {
  if (!operatorStaged) operatorStaged = getOperatorServerState();
  operatorStaged[key] = value;
  syncOperatorPanel();
}

// Every number on the panel stages through here, clamped to the row's own
// bounds: a slider drag, an arrow key and an XR thumbstick all arrive as a
// value, and none of them may leave a row outside what the server will take.
function stageOperatorNumberValue(key, value) {
  if (!operatorStaged) operatorStaged = getOperatorServerState();
  const bounds = getOperatorNumberBounds(key, operatorStaged);
  const next = Math.max(bounds.min, Math.min(bounds.max, Math.round(Number(value) || 0)));
  stageOperatorChange(key, next);
  // CmdLineOptions.cxx:453: a playing team may not be allowed more players than
  // the whole game is. The server clamps on the way in; doing it here as well is
  // what makes the clamp visible before the button is pressed rather than a
  // silent correction afterwards.
  if (key === 'maxPlayers') {
    for (const team of OPERATOR_PLAYING_TEAMS) {
      const limitKey = operatorLimitKey(team);
      if (Number(operatorStaged[limitKey]) > next) stageOperatorChange(limitKey, next);
    }
  }
}

// One notch of a row, for the headset's stick and the flat panel's own arrow
// keys. A plain count wants 1; a number of seconds wants the slider's own
// step, or fifteen presses reaches fifteen seconds.
function getOperatorNumberStep(key) {
  return key === 'timeLimit' ? OPERATOR_TIME_LIMIT_STEP : 1;
}

// One step of a row, which is what a headset has: left, right and select.
function stageOperatorNumber(key, direction) {
  if (!operatorStaged) operatorStaged = getOperatorServerState();
  const step = getOperatorNumberStep(key);
  stageOperatorNumberValue(key, Number(operatorStaged[key]) + (direction > 0 ? step : -step));
}

// The rabbit chase row, which is a `choice` rather than a number: off, then
// upstream's three selection styles.
function stageOperatorRabbit(direction) {
  if (!operatorStaged) operatorStaged = getOperatorServerState();
  const index = Math.max(0, RABBIT_SELECTIONS.indexOf(operatorStaged.rabbit));
  const next = (index + (direction > 0 ? 1 : -1) + RABBIT_SELECTIONS.length) % RABBIT_SELECTIONS.length;
  stageOperatorChange('rabbit', RABBIT_SELECTIONS[next]);
}

function wireOperatorPanel() {
  buildOperatorTeamLimitRows();
  // Not trimmed here: stageOperatorChange re-syncs the field from the staged
  // value on every keystroke (syncOperatorPanel), and trimming a value that
  // still has the input's own trailing space in it makes that sync snap the
  // field back and eat the space the moment it's typed -- there is no way to
  // type a space at all, only ever paste one in already-trimmed. The server
  // trims on commit regardless (applyServerConfigChanges), so nothing here
  // needs to.
  const serverTitleInput = document.getElementById('serverTitleInput');
  if (serverTitleInput) {
    serverTitleInput.addEventListener('input', () => stageOperatorChange('title', serverTitleInput.value));
  }
  const motdInput = document.getElementById('motdInput');
  if (motdInput) {
    motdInput.addEventListener('input', () => stageOperatorChange('motd', motdInput.value));
  }
  // `input` rather than `change`, so dragging a slider updates the label and the
  // confirm as it moves rather than only on release.
  const shotSlider = document.getElementById('shotMaxActiveSlider');
  if (shotSlider) {
    shotSlider.addEventListener('input', () => {
      stageOperatorNumberValue('shotMaxActive', Number(shotSlider.value));
    });
  }
  const maxPlayersSlider = document.getElementById('maxPlayersSlider');
  if (maxPlayersSlider) {
    maxPlayersSlider.addEventListener('input', () => {
      stageOperatorNumberValue('maxPlayers', Number(maxPlayersSlider.value));
    });
  }
  // Staged rather than applied on tick, unlike before: a checkbox that acted
  // immediately was the one row that could not be cancelled.
  const ricochetInput = document.getElementById('ricochetInput');
  if (ricochetInput) {
    ricochetInput.addEventListener('change', () => stageOperatorChange('ricochet', ricochetInput.checked));
  }
  const teamsInput = document.getElementById('teamsInput');
  if (teamsInput) {
    teamsInput.addEventListener('change', () => stageOperatorChange('teams', teamsInput.checked));
  }
  const jumpingInput = document.getElementById('jumpingInput');
  if (jumpingInput) {
    jumpingInput.addEventListener('change', () => stageOperatorChange('jumping', jumpingInput.checked));
  }
  const timeLimitSlider = document.getElementById('timeLimitSlider');
  if (timeLimitSlider) {
    timeLimitSlider.addEventListener('input', () => {
      stageOperatorNumberValue('timeLimit', Number(timeLimitSlider.value));
    });
  }
  const timeManualStartInput = document.getElementById('timeManualStartInput');
  if (timeManualStartInput) {
    timeManualStartInput.addEventListener('change', () => {
      stageOperatorChange('timeManualStart', timeManualStartInput.checked);
    });
  }
  const maxPlayerScoreSlider = document.getElementById('maxPlayerScoreSlider');
  if (maxPlayerScoreSlider) {
    maxPlayerScoreSlider.addEventListener('input', () => {
      stageOperatorNumberValue('maxPlayerScore', Number(maxPlayerScoreSlider.value));
    });
  }
  const maxTeamScoreSlider = document.getElementById('maxTeamScoreSlider');
  if (maxTeamScoreSlider) {
    maxTeamScoreSlider.addEventListener('input', () => {
      stageOperatorNumberValue('maxTeamScore', Number(maxTeamScoreSlider.value));
    });
  }
  const rabbitSelect = document.getElementById('rabbitSelect');
  if (rabbitSelect) {
    rabbitSelect.addEventListener('change', () => stageOperatorChange('rabbit', rabbitSelect.value));
  }
  const botFillSlider = document.getElementById('botFillSlider');
  if (botFillSlider) {
    botFillSlider.addEventListener('input', () => stageOperatorNumberValue('botFill', Number(botFillSlider.value)));
  }
  // The pilots, from the module that defines them, so the panel cannot offer
  // one the server does not have.
  const botPilotSelect = document.getElementById('botPilotSelect');
  if (botPilotSelect) {
    for (const entry of AUTOPILOTS) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.name;
      botPilotSelect.append(option);
    }
    botPilotSelect.addEventListener('change', () => stageOperatorChange('botPilot', botPilotSelect.value));
  }
  const mapList = document.getElementById('mapList');
  if (mapList) {
    mapList.addEventListener('change', () => stageOperatorChange('mapFile', mapList.value));
  }
  // Left and right on the focused row. The shared dialog model owns those keys
  // and a controller's stick arrives the same way, so a row that does not answer
  // `menuadjust` is a row only a mouse can operate -- which is what every slider
  // here was. See menus.js.
  document.getElementById('operatorOverlay')?.addEventListener('menuadjust', (event) => {
    const row = event.target.closest?.('[data-menu-row]');
    const key = row?.dataset.menuRow;
    if (!key) return;
    const direction = event.detail?.direction > 0 ? 1 : -1;
    const slider = row.querySelector('input[type="range"]');
    if (slider) {
      if (!slider.disabled) stageOperatorNumber(key, direction);
      event.preventDefault();
      return;
    }
    // A `<select>` keeps the browser's own left and right when it has the focus;
    // this is the controller reaching it, which the browser never sees.
    const select = row.querySelector('select');
    if (select) {
      if (!select.disabled) cycleSelectElement(select, direction);
      event.preventDefault();
      return;
    }
    const toggle = row.querySelector('input[type="checkbox"]');
    if (toggle) {
      // Right is on and left is off, rather than a toggle on either: a stepper
      // that answers the two directions differently is one an operator can aim.
      if (!toggle.disabled) stageOperatorChange(key, direction > 0);
      event.preventDefault();
    }
  });
  document.getElementById('operatorApplyBtn')?.addEventListener('click', commitOperatorPanel);
  // Honest from the start: nothing is staged before the panel is opened, so the
  // confirm is disabled rather than sitting there enabled with nothing to do.
  syncOperatorPanelFromServer();
  // Through the same toggle every other close path uses, which also fires
  // `onOperatorPanelHidden` and so does the discarding.
  document.getElementById('operatorCancelBtn')?.addEventListener('click', () => {
    toggleOperatorPanel();
  });
}

// The ricochet game style reaches the client twice over: in the `init` config
// with the rest of the world's rules, and again whenever an operator changes it.
// Both land here, because the help panel and the shots the client predicts have
// to move with it.
function applyRicochetSetting(allShotsRicochet) {
  if (gameConfig) gameConfig.ALL_SHOTS_RICOCHET = allShotsRicochet;
  const ricochetInput = document.getElementById('ricochetInput');
  if (ricochetInput) ricochetInput.checked = allShotsRicochet;
  updateRicochetHelp();
}

function showMessage(text) {
  routeLocalHudMessage(text);
}

function getCollisionColliders() {
  if (cachedCollisionColliders === null) {
    cachedCollisionColliders = buildCollisionColliders(
      OBSTACLES, currentWorldMapSize ?? DEFAULT_MAP_SIZE, currentWorldNoWalls, currentWallHeight());
  }
  return cachedCollisionColliders;
}

function refreshCollisionColliders() {
  cachedCollisionColliders = null;
  // The buildings a tank was inside belonged to the world that is going away,
  // and the renderer disposes their eighth-dimension nodes with it.
  insideBuildings = [];
  renderedInsideBuildings = [];
}

function rebuildTeleporterRuntimeState() {
  TELEPORTER_INDEX = buildTeleporterIndex(OBSTACLES, TELEPORTER_GRAPH?.links);
  TELEPORTER_OBSTACLES_BY_INDEX = TELEPORTER_INDEX.teleporters;
  TELEPORTER_LINKS_BY_SOURCE_FACE = TELEPORTER_INDEX.links;
}

// Every obstacle's top, teleporters included: the importer resolves a
// teleporter's frame into `w`/`d`/`h` so there is no special case left here.
// A mesh has no `h` of its own, so `getObstacleHeight` reads its bounds
// instead -- a real top rather than a zero-height ledge at its base.
function getColliderTopY(obs) {
  return obs ? getObstacleBase(obs) + getObstacleHeight(obs) : 0;
}

// Phasing, for the local tank -- the only tank this client resolves
// motion for. `insideBuildings` is upstream's own list
// (LocalPlayer::collectInsideBuildings, LocalPlayer.cxx:966) and answers both
// questions the flag asks: whether the tank is `InBuilding`, which is what takes
// its reverse, its trigger and its drop control away.
let insideBuildings = [];
// What the renderer actually draws the eighth dimension inside of -- the
// same body sweep above, unioned with whatever the current camera position
// also lands inside (#77). Kept apart from `insideBuildings` because the two
// questions have different answers once the camera can lead or lag the tank
// (#104): the camera clipping into a wall should make that wall see-through,
// not take the tank's drop/reverse/jump/fire away from it.
let renderedInsideBuildings = [];
// `desiredSpeed < 0` as `phasedObstacleExpels` asks it. Sampled where the stick
// is read, which is a frame ahead of the collider that uses it -- as upstream's
// is, `setDesiredSpeed` running off the input event and `getHitBuilding` off the
// motion update.
let phasedReverse = false;

// LocalPlayer::doUpdateMotion's `phased` (LocalPlayer.cxx:271), asked once per
// collider sweep rather than once per obstacle: reading the flag means walking
// the flag list, and the sweeps run every frame.
function amPhased() {
  const flag = getMyFlag();
  return drivesThroughBuildings(flag?.type ?? null, flag?.zoned === true);
}

// Player::isPhantomZoned for the local tank. The flag entry carries the state,
// which is the server's, so this is one place rather than a variable of its own
// that could disagree with the roster.
// ShotPath::FiringInfo (ShotPath.cxx:46): the flag a shot is fired under, which
// is the flag in hand for every type but `PZ` -- an unzoned Phantom Zone tank
// fires ordinary shells. Everything that reads a shot's behaviour reads this
// rather than the flag, so the muzzle sound, the reload and the local
// projectile all agree with the shot the server actually creates.
function getMyShotFlag() {
  const flag = getMyFlag();
  return getFiredShotFlag(flag?.type ?? null, flag?.zoned === true);
}

function amZoned() {
  const flag = getMyFlag();
  return isZoned(flag?.type ?? null, flag?.zoned === true);
}


function amInsideBuilding() {
  return insideBuildings.length > 0;
}

// LocalPlayer::setDesiredSpeed's firing-status switch (LocalPlayer.cxx:835),
// reduced to the one state bzo has nothing else saying. Upstream's other four
// are already answered here: Deceased and Loading by the shot-slot bars, Ready
// by their being full, and Zoned by its own message when the flag toggles.
//
// The order is upstream's own and matters. A dead tank reports Deceased before
// the building is even looked at, so a tank that died inside a wall is not
// sealed, it is dead; and a Phantom Zone tank inside a wall is Zoned rather
// than Sealed, which is why being zoned is asked here and not just assumed to
// be somebody else's business. `!isObserver()` is upstream's `!roaming` guard,
// and it is also what keeps this from contradicting the roaming label sharing
// the column with it.
function getFiringStatusText() {
  if (isObserver() || !isMyTankAlive()) return '';
  if (amInsideBuilding() && !amZoned()) return 'Sealed';
  return '';
}




// The wall a phasing tank is currently half inside, or null. Upstream works this
// out on the tank's own client and ships a `CrossingWall` status bit for the
// others to redraw from (LocalPlayer.cxx:678, PlayerState.h:30) -- but bzo's
// client already knows every player's flag, because the server owns flags, and
// already holds the whole obstacle list. So every client can answer this for
// every tank and the protocol says nothing, which is one less thing to keep in
// step across a version.
//
// The first straddled obstacle wins. Upstream asks `hitBuilding` for one
// obstacle and tests that; a tank in a corner is inside two, and either wall is
// as good an answer as the guess `isCrossing` makes anyway.
function findTankCrossingPlane(tank, tankScale) {
  const at = tankPoint(tank);
  const azimuth = tankAzimuth(tank);
  for (const obs of buildingsAt(at.x, at.y, at.z, azimuth, tankScale)) {
    const plane = obs.type === 'mesh'
      ? getMeshCrossingPlane(obs, at.x, at.y, at.z, azimuth, tankScale)
      : getBoxCrossingPlane(obs, at.x, at.y, at.z, azimuth, tankScale);
    if (plane) return plane;
  }
  return null;
}

// A tank box has no meaning for a bodiless observer camera -- zero width and
// length reduces `findInsideBuildings`' rect test to a single point, which is
// exactly "is the camera's own position inside this solid" and nothing more.
const OBSERVER_POINT_SCALE = Object.freeze({ width: 0, length: 0 });

// `drive`'s own test (collectInsideBuildings), against this client's world.
function buildingsAt(x, y, z, azimuth, tankScale = getMyTankScale()) {
  return findInsideBuildings(getCollisionColliders(), getColliderTopY, x, y, z, azimuth, tankScale);
}

// doUpdateMotion's last act (LocalPlayer.cxx:854), with the tank where the frame
// leaves it. Only a phased tank can be inside a building, so every other real
// tank skips the sweep rather than running it to find nothing, and the
// renderer is told only when the answer changes.
//
// An observer's free camera has no such gate and no collision at all: roam
// can end up inside solid geometry with nothing stopping it, where the same
// "otherwise there is nothing to see" problem applies -- so it gets the same
// treatment unconditionally, tested as a point rather than a tank's own
// footprint, since there is no tank body here to test.
//
// Neither of those is actually "where the camera is", though (#77) --
// third-person and an observer's own follow-leader view both put the
// rendered eye at a fixed offset from the tracked position, with no
// wall-avoidance, so it can sit inside a solid before the tracked tank's own
// body (or the observer's own roam position) ever would. Wherever the
// current view actually renders from is unioned in on top of the sweep
// above for the eighth-dimension shells the renderer draws -- both can name
// obstacles the other misses, and *that* effect belongs on all of them.
//
// `insideBuildings` itself stays body-only, though (#104): it is also
// `amInsideBuilding()`, which the drop/reverse/jump/fire rules all read as
// "is the tank actually touching a wall". A third-person camera that has
// swung into a wall the tank's own box has not reached is not that, and
// gating gameplay on it left a flag undroppable for a reason only the
// camera could see.
function updateInsideBuildings() {
  const phased = amPhased();
  const observer = isObserver();
  const found = phased
    ? buildingsAt(myX, myY, myZ, myAzimuth)
    : observer
      ? buildingsAt(myX, myY, myZ, myAzimuth, OBSERVER_POINT_SCALE)
      : [];
  if (found.length !== insideBuildings.length
    || !found.every((obs, i) => obs === insideBuildings[i])) {
    insideBuildings = found;
  }
  const cameraPosition = (phased || observer) ? renderManager.getCameraPosition() : null;
  const forRender = cameraPosition ? found.slice() : found;
  if (cameraPosition) {
    for (const obs of buildingsAt(
      cameraPosition.x, cameraPosition.y, cameraPosition.z, 0, OBSERVER_POINT_SCALE,
    )) {
      if (!forRender.includes(obs)) forRender.push(obs);
    }
  }
  if (forRender.length === renderedInsideBuildings.length
    && forRender.every((obs, i) => obs === renderedInsideBuildings[i])) return;
  renderedInsideBuildings = forRender;
  renderManager.setInsideBuildings(renderedInsideBuildings);
}

// Intended input state
let intendedForward = 0; // -1..1
let intendedRotation = 0; // -1..1
let jumpTriggered = false;
let isInAir = false;
let onGround = false;
let onObstacle = false;
// `lastObstacle` (LocalPlayer.cxx:428): what the step last met, which is what
// the debug overlay draws and what upstream's no-climb jump rule reads.
let lastMotionObstacle = null;
let jumpAzimuth = null; // The azimuth a jump or fall left with
// LocalPlayer::wingsFlapCount. Refilled to _wingsJumpCount on every tick the
// tank spends on a surface and spent one per jump, take-off included. Only Wings
// ever reads it, because every other tank is refused the moment it leaves the
// ground.
let wingsFlapsLeft = 0;
// LocalPlayer::setJump. Upstream takes one jump per key press; every bzo input
// surface reports the jump control as a held button instead, and a wings tank
// holding it would spend all _wingsJumpCount flaps in as many frames.
let jumpWasHeld = false;
// doUpdateMotion's `lastSpeed` and the tank's angular velocity, in real units --
// units a second and radians a second, not stick fractions. They are what
// `doMomentum` clamps against, so they have to be the actual velocities and not
// what the stick was asking for.
let lastSpeed = 0;
let lastAngVel = 0;
// This frame's top speed and `doMomentum` limit, for the autopilot to know what
// speed it can be going by the next frame.
let lastTopSpeed = 0;
let lastLinearLimit = 0;
let lastAngularLimit = 0;
let lastTurnRate = 0;
let localTeleportReentryBlockTeleporterIndex = null;
let localTeleportReentryBlockDistance = 0;
let localTeleportReentryBlockUntil = 0;
let localTeleportCooldownUntil = 0;
let suppressLocalTeleportFxUntil = 0;
// `_squishFactor` and `_squishTime`, upstream's landing squash: how far a hard
// landing flattens a tank, and how long it takes to stand back up.
function landingSquishFactor() {
  return Number.isFinite(gameConfig?.SQUISH_FACTOR) && gameConfig.SQUISH_FACTOR >= 0 ? gameConfig.SQUISH_FACTOR : 1.0;
}
function landingSquishTime() {
  return gameConfig?.SQUISH_TIME > 0 ? gameConfig.SQUISH_TIME : 1.0;
}
// BZFlag Player::spawnEffect(): a spawning tank starts at 1% on every axis and
// grows to full size over _flagEffectTime. It shares dimensionsScale with the
// landing squish, so both converge through the same loop (Player.cxx:520).
const SPAWN_START_SCALE = 0.01;
const PLAYER_TELEPORT_REENTRY_BLOCK_DISTANCE = 5.0;
const PLAYER_TELEPORT_REENTRY_BLOCK_MIN_MS = 250;
const PLAYER_TELEPORT_EXIT_EPSILON = 0.08;
const PLAYER_TELEPORT_COOLDOWN_MS = 1000;

function ensureTankDimensionState(tank) {
  if (!tank?.userData) return;
  if (!Number.isFinite(tank.userData.baseScaleX)) tank.userData.baseScaleX = tank.scale.x;
  if (!Number.isFinite(tank.userData.baseScaleY)) tank.userData.baseScaleY = tank.scale.y;
  if (!Number.isFinite(tank.userData.baseScaleZ)) tank.userData.baseScaleZ = tank.scale.z;
  if (!Number.isFinite(tank.userData.landingSquishScaleZ)) tank.userData.landingSquishScaleZ = 1;
  if (!Number.isFinite(tank.userData.landingSquishRecoverRate)) tank.userData.landingSquishRecoverRate = 1 / landingSquishTime();
  if (!Number.isFinite(tank.userData.spawnScale)) tank.userData.spawnScale = 1;
  // Player::dimensionsScale / Target / Rate, for the drawn tank only. The
  // gameplay size is the target from the moment the flag changes hands.
  if (!Number.isFinite(tank.userData.dimensionScaleLength)) tank.userData.dimensionScaleLength = 1;
  if (!Number.isFinite(tank.userData.dimensionScaleWidth)) tank.userData.dimensionScaleWidth = 1;
  if (!Number.isFinite(tank.userData.dimensionTargetLength)) tank.userData.dimensionTargetLength = 1;
  if (!Number.isFinite(tank.userData.dimensionTargetWidth)) tank.userData.dimensionTargetWidth = 1;
  if (!Number.isFinite(tank.userData.dimensionRateLength)) tank.userData.dimensionRateLength = 0;
  if (!Number.isFinite(tank.userData.dimensionRateWidth)) tank.userData.dimensionRateWidth = 0;
  // Player::alpha / alphaTarget / alphaRate, which upstream updates in
  // updateTranslucency right beside the dimensions and over the same
  // _flagEffectTime. Cloaking is the only thing that moves it.
  if (!Number.isFinite(tank.userData.cloakAlpha)) tank.userData.cloakAlpha = 1;
  if (!Number.isFinite(tank.userData.cloakAlphaTarget)) tank.userData.cloakAlphaTarget = 1;
  if (!Number.isFinite(tank.userData.cloakAlphaRate)) tank.userData.cloakAlphaRate = 0;
}

// A tank's opacity, applied to every material it is built from. A fully faded
// tank is hidden outright rather than drawn at alpha 0, so it costs no draws and
// casts no shadow -- upstream returns before adding it to the scene at all
// (Player.cxx:901). The name label goes with it: a floating callsign over an
// invisible tank would give away the one thing the flag is for.
function applyTankAlpha(tank, alpha) {
  if (!tank) return;
  const hidden = alpha <= 0;
  if (tank.userData.cloakHidden !== hidden) {
    tank.userData.cloakHidden = hidden;
    // Cloaking owns the *alpha*, never whether there is a tank to draw at all.
    // `cloakHidden` starts undefined, so the first frame after a tank is built
    // always takes this branch -- and a tank built for a player who has not
    // spawned was hidden by `addPlayer` a moment earlier. Writing plain
    // `!hidden` here put it back on screen at the origin, which on a proxied
    // server is every player bzfs has listed but not yet placed. A player who
    // dies later never hit it, because `cloakHidden` is already `false` by
    // then and this branch is skipped, which is why it looked intermittent.
    //
    // `!== false` rather than a truth test: only an explicit "not alive" hides
    // a tank here. A path that has not said either way is left alone, which is
    // what the local tank relies on.
    tank.visible = !hidden && tank.userData.playerState?.alive !== false;
  }
  // The tank's own shadow needs no help: _projectShadowForMesh already refuses
  // to project from a mesh whose `visible` is false, so hiding the tank takes
  // the silhouette with it. The ghost does need help, because it is a sibling of
  // the tank rather than a child and inherits nothing.
  applyTankDebugVisibility(tank);
  if (hidden) return;
  if (tank.userData.cloakAppliedAlpha === alpha) return;
  tank.userData.cloakAppliedAlpha = alpha;
  const opaque = alpha >= 1;
  // The ghost is a clone with its own materials, so it fades with the tank
  // rather than staying solid beside a fading one. Its own 5% inflation and the
  // dimension scaling are separate; this is only the opacity.
  const fade = (root, scale) => root.traverse((child) => {
    if (!child.material) return;
    // The navigation lights are one material shared by every tank on the map,
    // so writing this tank's alpha into it writes it into all of them -- and
    // turning its transparency off drops it out of the transparent pass, where
    // being drawn after the turret is the only thing keeping the turret from
    // painting over it. They go with the tank when it is hidden outright,
    // which is the only fading upstream's own lights do.
    if (child.name === TANK_NAV_LIGHTS_NAME) return;
    // The callsign, for the same reason and then some. It is a label over the
    // tank rather than a part of it, and an opaque material is not in the
    // transparent pass at all -- so no render order can keep it over the
    // alpha-textured world, whose every bush, teleporter and beacon is drawn
    // after the whole opaque queue. Its own alpha is set where it is built:
    // solid on the tank, `GHOST_ALPHA_SCALE` on the ghost's copy.
    if (child.isSprite) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      material.transparent = !opaque || scale < 1;
      material.opacity = alpha * scale;
      material.needsUpdate = true;
    }
  });
  fade(tank, 1);
  if (tank.userData.ghostMesh) fade(tank.userData.ghostMesh, GHOST_ALPHA_SCALE);
}

// Player::updateDimensions (Player.cxx:503) for one axis. The rate is fixed when
// the target changes, which is what makes the ease linear and exactly
// _flagEffectTime long however far it has to travel.
function easeTankDimension(scale, target, rate, deltaTime) {
  if (rate === 0 || scale === target) return target;
  const next = scale + (deltaTime * rate);
  if (rate < 0) return next < target ? target : next;
  return next > target ? target : next;
}

function applySpawnGrow(tank) {
  if (!tank?.userData) return;
  ensureTankDimensionState(tank);
  tank.userData.spawnScale = SPAWN_START_SCALE;
}

function applyLandingSquish(tank, impactSpeed = 0) {
  if (!tank?.userData || !gameConfig) return;

  ensureTankDimensionState(tank);

  const gravity = Number.isFinite(gameConfig.GRAVITY) && gameConfig.GRAVITY > 0
    ? gameConfig.GRAVITY
    : 9.8;
  const velocity = Math.max(0, impactSpeed || 0);
  let k = 0.1 / (2 * gravity * gravity);
  k *= landingSquishFactor();

  const targetScaleZ = 1 / (1 + (k * velocity * velocity));
  if (targetScaleZ < tank.userData.landingSquishScaleZ) {
    tank.userData.landingSquishScaleZ = targetScaleZ;
  }
  tank.userData.landingSquishRecoverRate = 1 / landingSquishTime();
}

// A nametag sprite is a child of the tank (or ghost) group it labels, so it
// inherits that group's scale by default. Dividing out the group's current
// scale keeps the label's own size -- set in updateSpriteLabel -- as the only
// thing that determines how it looks, regardless of Tiny/Narrow/Obesity or
// landing squish/spawn growth.
function counterScaleNameLabel(label, groupScale) {
  if (!label || label.userData.baseScaleX === undefined) return;
  label.scale.set(
    label.userData.baseScaleX / groupScale.x,
    label.userData.baseScaleY / groupScale.y,
    1
  );
}

function updateTankDimensions(deltaTime) {
  tanks.forEach((tank, playerId) => {
    if (!tank?.userData) return;
    ensureTankDimensionState(tank);

    // Player::updateFlagEffect: a change of flag sets new targets and the rate
    // that reaches them over _flagEffectTime. Height is never scaled, so only
    // the length and width axes move.
    const target = getTankDimensionScale(getPlayerFlag(playerId)?.type ?? null);
    if (tank.userData.dimensionTargetLength !== target.length) {
      tank.userData.dimensionRateLength =
        (target.length - tank.userData.dimensionScaleLength) / getFlagTuning().flagEffectTime;
      tank.userData.dimensionTargetLength = target.length;
    }
    if (tank.userData.dimensionTargetWidth !== target.width) {
      tank.userData.dimensionRateWidth =
        (target.width - tank.userData.dimensionScaleWidth) / getFlagTuning().flagEffectTime;
      tank.userData.dimensionTargetWidth = target.width;
    }
    tank.userData.dimensionScaleLength = easeTankDimension(
      tank.userData.dimensionScaleLength,
      tank.userData.dimensionTargetLength,
      tank.userData.dimensionRateLength,
      deltaTime
    );
    tank.userData.dimensionScaleWidth = easeTankDimension(
      tank.userData.dimensionScaleWidth,
      tank.userData.dimensionTargetWidth,
      tank.userData.dimensionRateWidth,
      deltaTime
    );

    // Player::updateTranslucency, the same ease on the same clock. Cloaking
    // fades a tank out over _flagEffectTime and dropping it fades back in, so
    // the moment a cloak completes is visible rather than instant.
    const alphaTarget = getTankAlphaTarget(getPlayerFlagType(playerId));
    if (tank.userData.cloakAlphaTarget !== alphaTarget) {
      tank.userData.cloakAlphaRate =
        (alphaTarget - tank.userData.cloakAlpha) / getFlagTuning().flagEffectTime;
      tank.userData.cloakAlphaTarget = alphaTarget;
    }
    tank.userData.cloakAlpha = easeTankDimension(
      tank.userData.cloakAlpha,
      tank.userData.cloakAlphaTarget,
      tank.userData.cloakAlphaRate,
      deltaTime
    );
    // Your own tank is never hidden from you, whatever it is carrying: upstream
    // only ever asks this of a remote player. A zoned tank is the exception, and
    // it is not hiding -- the quarter alpha is how the flag says it is on, so it
    // applies to the tank driving it as much as to the ones looking at it.
    const viewedFlag = getPlayerFlagType(playerId);
    const viewedZoned = getPlayerFlag(playerId)?.zoned === true;
    applyTankAlpha(
      tank,
      playerId === myPlayerId && !isZoned(viewedFlag, viewedZoned)
        ? 1
        : getVisibleTankAlpha(
          viewedFlag,
          tank.userData.cloakAlpha,
          getMyFlag()?.type ?? null,
          viewedZoned
        )
    );
    // And the ground the local tank is driving over, which is the whole of
    // upstream's zoned screen effect.
    if (playerId === myPlayerId) renderManager.setZoneGround(viewedZoned);

    // The clip plane and the interdimensional lights, for a tank straddling a
    // wall it is driving through. Only a phasing tank can be inside one, so
    // every other tank skips the obstacle sweep entirely -- the same reason
    // `updateInsideBuildings` gates on `amPhased`.
    //
    // `tank.visible` is the whole of upstream's two early returns in
    // `addToScene`: it drops out for a tank that is not alive and for one
    // cloaked to nothing, both of which draw no tank and so must draw no lights.
    // A tank killed inside a wall is the case that matters -- it stops being
    // drawn where it stood, and without this the streaks hang in the building
    // with nothing in the middle of them. The tank also keeps its flag on this
    // client for the moment between the kill and the server's drop, so the flag
    // alone is not enough to notice.
    //
    // Null rather than skipping the call, because a tank that stops qualifying
    // has to lose both the plane and the lights it already has.
    //
    // The cut itself is skipped for the tank you are driving, seen from its own
    // cockpit -- upstream's `if (!inCockpit)` (Player.cxx:961-963), where
    // `inCockpit` is true for your own tank in ordinary play
    // (playing.cxx:6143). The clip is only there to give the lights a clean
    // coplanar edge; the depth buffer already hides whatever is behind a wall,
    // so skipping it costs nothing and is the difference between seeing your
    // own tank inside a building and seeing none of it (#98). bzo's own third
    // person is the `devDriving` half of that test, so it keeps the cut.
    const crossingScale = getTankDimensionScale(viewedFlag);
    const inCockpit = isTankInCockpit(playerId);
    // Upstream draws your own tank in first person -- Display Treads on, which
    // is the branch that skips `setOnlyShadows` -- and you still see no turret
    // and no barrel. Nothing hides them: the eye sits at the tank's own centre
    // at muzzle height (playing.cxx:5996), which is inside both, and every
    // face of a solid points away from a camera within it.
    //
    // A bored barrel breaks that, and only that. The inside of the bore is the
    // one surface on the tank that faces its own axis, and the axis is where
    // the eye is -- so the pipe that reads correctly on a tank coming at you
    // turns into a tube you are looking along on your own. It is taken out of
    // the cockpit view rather than unbored, so it still reads as a pipe
    // everywhere it is seen from outside, which is where it was wanted.
    //
    // This covers an observer in FPS or drive-FP as well as your own tank,
    // which is the same view of the same problem: upstream puts the roaming
    // first-person eye at the watched tank's own muzzle height too.
    //
    // Except in a headset, where the barrel is kept. bzo forces first person
    // on entering VR, and there the gun is the only thing in the world that
    // says where the tank is pointing -- there is no screen HUD to fall back
    // on. A head that moves can look over the barrel rather than
    // along it, which is the thing a fixed screen camera cannot do.
    const ownBarrel = tank.userData.barrel;
    if (ownBarrel) ownBarrel.visible = !inCockpit || isXREnabled();
    renderManager.setTankCrossingPlane(
      tank,
      tank.visible && drivesThroughBuildings(viewedFlag, viewedZoned)
        ? findTankCrossingPlane(tank, crossingScale)
        : null,
      !inCockpit,
    );

    const baseScaleX = tank.userData.baseScaleX;
    const baseScaleY = tank.userData.baseScaleY;
    const baseScaleZ = tank.userData.baseScaleZ;

    let squishScaleZ = tank.userData.landingSquishScaleZ;
    if (!Number.isFinite(squishScaleZ)) squishScaleZ = 1;

    if (squishScaleZ < 1) {
      const recoverRate = Number.isFinite(tank.userData.landingSquishRecoverRate)
        ? tank.userData.landingSquishRecoverRate
        : (1 / landingSquishTime());
      squishScaleZ = Math.min(1, squishScaleZ + recoverRate * deltaTime);
      tank.userData.landingSquishScaleZ = squishScaleZ;
    }

    let spawnScale = tank.userData.spawnScale;
    if (!Number.isFinite(spawnScale)) spawnScale = 1;
    if (spawnScale < 1) {
      const growTime = getFlagTuning().flagEffectTime;
      spawnScale = growTime > 0 ? Math.min(1, spawnScale + (deltaTime / growTime)) : 1;
      tank.userData.spawnScale = spawnScale;
    }

    // A tank faces +x, so its x is its length and its y its width -- the two
    // axes a flag scales -- and the world's own tank size scales all three
    // (`TANK.modelScale`).
    const { modelScale } = TANK;
    tank.scale.set(
      baseScaleX * modelScale.length * tank.userData.dimensionScaleLength * spawnScale,
      baseScaleY * modelScale.width * tank.userData.dimensionScaleWidth * spawnScale,
      baseScaleZ * modelScale.height * squishScaleZ * spawnScale,
    );
    counterScaleNameLabel(tank.userData.nameLabel, tank.scale);

    // The server-position ghost is a sibling of the tank rather than a child, so
    // it carries its own transform and has to be told. A ghost that stayed
    // full-size around a Tiny tank would misreport the very thing it is there to
    // show.
    const ghost = tank.userData.ghostMesh;
    if (ghost) {
      ghost.scale.set(
        GHOST_SCALE * modelScale.length * tank.userData.dimensionScaleLength,
        GHOST_SCALE * modelScale.width * tank.userData.dimensionScaleWidth,
        GHOST_SCALE * modelScale.height,
      );
      counterScaleNameLabel(ghost.userData.nameLabel, ghost.scale);
    }
  });
}

// `TrackMarks::onBuilding` (`TrackMarks.cxx:415`): is there a surface directly
// under this point for a mark to lie on. Upstream casts a short ray down through
// its collision octree and takes any flat-topped obstacle whose top the mark is
// level with; bzo walks the obstacle list, as every other geometry question on
// this client does, and asks the same two things of each -- is the mark level
// with the top, and is it over the footprint.
//
// The world floor answers first and answers everywhere, which is why upstream
// never asks this of a mark left on the ground.
function isTrackSurfaceAt(x, y, z) {
  if (Math.abs(z) <= TRACK_SURFACE_TOLERANCE) return true;
  for (const obs of getCollisionColliders()) {
    // Nothing a tank drives through holds a mark up either, and a collider
    // missing a dimension has no top to be level with.
    if (obs.driveThrough) continue;
    if (!obs.size || !obs.size.every(Number.isFinite)) continue;
    if (Math.abs(z - getColliderTopY(obs)) > TRACK_SURFACE_TOLERANCE) continue;
    if (isOverFlatTop(obs, x, y)) return true;
  }
  return false;
}

// `Player::updateTrackMarks` (`Player.cxx:458`), for every tank this client can
// see. Upstream runs it from `Player::updatePlayerState` beside the tread
// animation, on a clock of its own: a mark every `TrackMarks::updateTime`
// whatever the frame rate, and the clock is only reset when a mark is actually
// laid, so a tank that has been sitting still leaves one the moment it moves.
//
// A tank in the air leaves nothing -- there is no surface under the treads --
// and neither does one phased into a wall, which is upstream's
// `isAlive() && !isFalling() && !isPhantomZoned()`. Falling is asked of the
// local tank through the ground state its own motion resolves, and of a remote
// one through the jump direction its updates carry.
function updateTrackMarks(deltaTime) {
  if (!renderManager || !gameConfig || !(deltaTime > 0)) return;

  tanks.forEach((tank, playerId) => {
    const state = tank.userData.playerState;
    if (!state || !state.alive) return;

    const elapsed = (tank.userData.trackMarkTimer || 0) + deltaTime;
    tank.userData.trackMarkTimer = elapsed;
    if (elapsed <= TRACK_UPDATE_TIME) return;

    const falling = playerId === myPlayerId
      ? isInAir
      : (tank.userData.jumpAzimuth !== null && tank.userData.jumpAzimuth !== undefined);
    if (falling) return;
    const flag = getPlayerFlag(playerId);
    if (isZoned(flag?.type ?? null, flag?.zoned === true)) return;

    const mark = getTrackMarkPlacement({
      x: tank.position.x,
      y: tank.position.y,
      z: tank.position.z,
      azimuth: tankAzimuth(tank),
      // Upstream's `relativeSpeed` is the velocity resolved along the heading,
      // in world units; bzo carries the same thing as a fraction of tank speed.
      speed: (tank.userData.forwardSpeed || 0) * gameConfig.TANK_SPEED,
      scaleLength: tank.userData.dimensionScaleLength ?? 1,
      scaleWidth: tank.userData.dimensionScaleWidth ?? 1,
    });
    if (!mark) return;

    mark.sides = getTrackMarkSides(mark, isTrackSurfaceAt);
    if (!mark.sides) return;

    renderManager.addTrackMark(mark);
    tank.userData.trackMarkTimer = 0;
  });
}

function triggerSpawnEffectForTank(tank, colorOverride = null) {
  if (!tank || !renderManager || !tank.position) return;

  const defaultColor = 0x4caf50;
  const tankColor = tank.userData?.playerState?.color;
  const effectColor = colorOverride ?? tankColor ?? defaultColor;
  renderManager.createSpawnEffect(tank.position, effectColor);
  applySpawnGrow(tank);
}







// HUDRenderer's altitude tape, which updateFlag() (playing.cxx:1465) puts up
// only where there is altitude to read: a world that allows jumping, or the
// Jumping flag in hand. Upstream does not list Wings there, and neither does
// this.
let altitudeTapeShown = true;
function updateAltitudeTape() {
  if (!gameConfig) return;
  const shown = gameConfig.ALLOW_JUMPING || getMyFlag()?.type === 'JP';
  if (shown === altitudeTapeShown) return;
  altitudeTapeShown = shown;
  document.body.classList.toggle('no-jumping', !shown);
}



// No impact threshold, because upstream has none: `addLandEffect` gates only on
// `useFancyEffects` and the `landEffect` type, and the sound only on `entryDrop`
// (LocalPlayer.cxx:812). Any InAir -> OnGround|OnBuilding transition rings, however
// gentle. Upstream can afford that because it never manufactures a transition,
// and neither does bzo now that the support snap cannot lift a falling tank back
// onto a surface it left.
// `silent` is the bounce branch above winning the else-chain: upstream still
// runs `EFFECTS.addLandEffect` for any landing (LocalPlayer.cxx:799-801) and
// only the sound is skipped, so the ring and the squish stay.
function triggerLandingFeedback(tank, impactSpeed = 0, { local = false, silent = false } = {}) {
  if (!tank?.position) return;
  const clampedImpact = Math.max(0, impactSpeed || 0);
  const intensity = 1.0;
  applyLandingSquish(tank, clampedImpact);
  renderManager.createLandingEffect(tank.position, intensity, { local, silent });
}

function decayLocalTeleportReentryBlock(distanceMoved, nowMs) {
  const moved = Math.max(0, Number(distanceMoved) || 0);
  localTeleportReentryBlockDistance = Math.max(0, localTeleportReentryBlockDistance - moved);
  if (localTeleportReentryBlockDistance <= 1e-6 && nowMs >= localTeleportReentryBlockUntil) {
    localTeleportReentryBlockTeleporterIndex = null;
    localTeleportReentryBlockDistance = 0;
    localTeleportReentryBlockUntil = 0;
  }
}

function isLocalTeleportReentryBlocked(teleporterIndex, nowMs) {
  if (!Number.isInteger(teleporterIndex)) return false;
  if (localTeleportReentryBlockTeleporterIndex !== teleporterIndex) return false;
  return localTeleportReentryBlockDistance > 1e-6 || nowMs < localTeleportReentryBlockUntil;
}

function predictLocalPlayerTeleport(startState, endState, nowMs) {
  if (nowMs < localTeleportCooldownUntil) {
    return {
      applied: false,
      state: endState,
      rotateDelta: 0,
      destinationObstacle: null,
      destinationTeleporterIndex: null,
      fromFaceId: null,
      toFaceId: null,
    };
  }

  const deltaX = endState.x - startState.x;
  const deltaY = endState.y - startState.y;
  const deltaZ = endState.z - startState.z;
  const segmentLength = Math.hypot(deltaX, deltaY, deltaZ);
  const planarDistance = Math.hypot(deltaX, deltaY);
  if (segmentLength <= 1e-6) {
    return {
      applied: false,
      state: endState,
      rotateDelta: 0,
      destinationObstacle: null,
      destinationTeleporterIndex: null,
      fromFaceId: null,
      toFaceId: null,
    };
  }

  const start = { x: startState.x, y: startState.y, z: startState.z };
  const end = { x: endState.x, y: endState.y, z: endState.z };

  let earliest = null;
  for (const obs of TELEPORTER_OBSTACLES_BY_INDEX.values()) {
    if (isLocalTeleportReentryBlocked(obs.teleporterIndex, nowMs)) continue;
    const crossing = getShotTeleporterCrossing(start, end, obs);
    if (!crossing) continue;
    if (!earliest || crossing.t < earliest.crossing.t) {
      earliest = { obs, crossing };
    }
  }

  if (!earliest) {
    decayLocalTeleportReentryBlock(planarDistance, nowMs);
    return {
      applied: false,
      state: endState,
      rotateDelta: 0,
      destinationObstacle: null,
      destinationTeleporterIndex: null,
      fromFaceId: null,
      toFaceId: null,
    };
  }

  const sourceFaceId = earliest.crossing.sourceFaceId;
  const sourceFace = sourceFaceId % 2;
  const destFaceId = getTeleportDestinationFace(TELEPORTER_LINKS_BY_SOURCE_FACE, sourceFaceId);
  const destTeleporterIndex = Math.floor(destFaceId / 2);
  const destFace = destFaceId % 2;
  const destObs = TELEPORTER_OBSTACLES_BY_INDEX.get(destTeleporterIndex);
  if (!destObs) {
    decayLocalTeleportReentryBlock(planarDistance, nowMs);
    return {
      applied: false,
      state: endState,
      rotateDelta: 0,
      destinationObstacle: null,
      destinationTeleporterIndex: null,
      fromFaceId: null,
      toFaceId: null,
    };
  }

  const dirIn = {
    x: deltaX / segmentLength,
    y: deltaY / segmentLength,
    z: deltaZ / segmentLength,
  };
  const transformed = transformShotThroughTeleporter(
    earliest.crossing.point,
    dirIn,
    earliest.obs,
    sourceFace,
    destObs,
    destFace,
  );

  const exitAdvance = PLAYER_TELEPORT_EXIT_EPSILON;
  const outState = {
    ...endState,
    x: transformed.pointOut.x + transformed.dirOut.x * exitAdvance,
    y: transformed.pointOut.y + transformed.dirOut.y * exitAdvance,
    z: Math.max(0, transformed.pointOut.z + transformed.dirOut.z * exitAdvance),
  };

  const { rotateDelta } = transformed;

  localTeleportReentryBlockTeleporterIndex = destTeleporterIndex;
  localTeleportReentryBlockDistance = Math.max(
    PLAYER_TELEPORT_REENTRY_BLOCK_DISTANCE,
    (getShotTeleporterDims(destObs).halfW * 2) + 0.25,
  );
  localTeleportReentryBlockUntil = nowMs + PLAYER_TELEPORT_REENTRY_BLOCK_MIN_MS;
  localTeleportCooldownUntil = nowMs + PLAYER_TELEPORT_COOLDOWN_MS;

  return {
    applied: true,
    state: outState,
    rotateDelta,
    destinationObstacle: destObs,
    destinationTeleporterIndex: destTeleporterIndex,
    fromFaceId: sourceFaceId,
    toFaceId: destFaceId,
  };
}

// Whether `virtualInput` is worth reading: something is producing it. This was
// spelled three different ways for driving, firing and dropping a flag, and the
// two that left out `virtualControlsEnabled` made the on-screen fire and flag
// buttons dead for anyone who turned the controls on deliberately rather than
// being handed them by a phone. One predicate so they cannot drift again.
//
// `isMobile` is redundant -- a phone turns the controls on at startup, and with
// them off there is no overlay to press -- but it is kept so no case that
// worked before can stop working.
function usesVirtualInput() {
  return isMobile || isXREnabled() || isGamepadConnected() || virtualControlsEnabled;
}

// The fire key or button, from whichever surface the player is using. A tank
// shoots with it; an observer cycles the roaming view with it, which is the
// whole reason it is shared rather than inlined.
function isFireHeld() {
  const held = keys[FIRE_KEY] || (usesVirtualInput() && virtualInput.fire);
  // A pilot's trigger adds to the player's, as every other source's does.
  if (autopilotOn && !isObserver()) return held || autopilotOutput?.fire === true;
  return held;
}

// Every tank that can be roamed to, which is exactly the set
// `ScoreboardRenderer::getPlayerList` walks and hands `Roaming::changePlayer`:
// every player who is not an observer. Nothing else is asked of them.
//
// Not what they are carrying: a cloaked or stealthed tank is still somebody an
// observer may watch, and upstream lets you ride along with one. Those rules
// belong to `ID` Identify, which is a tank locking on to another tank, and
// they live where that decision is made (`identifyRoamTarget`).
//
// Not whether they are alive, either. A followed tank that dies is still the
// tank being followed upstream, and the view picks them up again when they
// spawn rather than dropping to free roam the moment they are shot.
function getRoamCandidates() {
  const candidates = [];
  tanks.forEach((tank, id) => {
    const state = tank.userData.playerState;
    if (!state || id === myPlayerId) return;
    if (isObserverTeam(state.team)) return;
    candidates.push({
      id,
      x: tank.position.x,
      y: tank.position.y,
      wins: state.wins || 0,
      losses: state.losses || 0,
      // The roaming leader is read off the scoreboard's own order
      // (ScoreboardRenderer::getLeader), so a candidate carries whatever that
      // order sorts by -- in Rabbit Chase the rank, or the top row and the
      // followed tank would be two different players.
      rank: rabbitChaseEnabled ? getPlayerRanking(state.wins || 0, state.losses || 0) : null,
      connectDate: state.connectDate ? new Date(state.connectDate) : new Date(0),
      isObserver: false,
    });
  });
  return candidates;
}

// getRoamCandidates() walks every tank and builds a record for each, which is
// wasted work run once a frame when the answer only ever changes on the events
// that already invalidate the scoreboard model -- a join, a leave, a team
// change. So this is kept in step with that model instead of the render loop:
// cached per scoreboardVersion, and rebuilt the first time that version is
// asked for.
let roamCandidatesCacheVersion = -1;
let roamCandidatesCache = [];
function getCachedRoamCandidates() {
  const version = getScoreboardModel().version;
  if (roamCandidatesCacheVersion !== version) {
    roamCandidatesCacheVersion = version;
    roamCandidatesCache = getRoamCandidates();
  }
  return roamCandidatesCache;
}

// A null target resolves to the leader rather than pinning one, so the view
// follows whoever is winning. Resolved off the cached candidates above, so
// this is as cheap to call every frame as reading the target's own transform
// is -- deciding *who* to follow only moves with the scoreboard.
function getRoamTargetId() {
  const candidates = getCachedRoamCandidates();
  if (roamTargetId !== null && candidates.some((candidate) => candidate.id === roamTargetId)) {
    return roamTargetId;
  }
  // A target that left the game drops us back to the leader, as changePlayer does.
  roamTargetId = null;
  if (candidates.length === 0) return null;
  return candidates.sort(compareScoreboardPlayers)[0].id;
}

function getRoamTargetTank() {
  const id = getRoamTargetId();
  return id === null ? null : tanks.get(id) || null;
}

// The tank the current view is looking out of, which upstream calls
// `inCockpit` and works out twice: once for your own tank (playing.cxx:6143)
// and once for a roamed one (playing.cxx:6182-6185, true only in its FP view
// and only for the tank actually being roamed). It is what decides whether a
// tank crossing a wall wears the clip plane, because the cut is only there to
// give the interdimensional lights a clean coplanar edge -- the depth buffer
// does the real occluding either way -- and cutting the tank you are looking
// out of leaves you with none of it (#98).
//
// bzo's own `drive-fp` is the same view one step further on, so it counts.
// Every other view -- third person, TRACK, FOLLOW, `drive-tp` -- watches the
// tank from outside, which is upstream's non-FP case, and keeps the cut.
function isTankInCockpit(playerId) {
  if (isObserver()) {
    if (roamView !== ROAM_VIEW.FPS && roamView !== ROAM_VIEW.DRIVE_FP) return false;
    return getRoamTargetId() === playerId;
  }
  return playerId === myPlayerId && cameraMode === 'first-person';
}

// Only team flags are trackable, which is upstream's `flagTeam != NoTeam` test.
function getRoamTrackableFlags() {
  return Array.from(flags.values()).filter((flag) => flag.type && isTeamFlag(flag.type));
}

function getRoamTargetFlag() {
  const trackable = getRoamTrackableFlags();
  if (trackable.length === 0) return null;
  return trackable.find((flag) => flag.index === roamTargetFlagIndex) || trackable[0];
}

// Selecting a target by hand leaves the view alone unless it cannot show one.
function adoptRoamTarget(id) {
  roamViewDefaulted = false;
  roamTargetId = id;
  if (id !== null && !roamViewNeedsTarget(roamView)) roamView = ROAM_VIEW.TRACK;
  refreshScoreboards();
}

// A row click sets an explicit target; clicking the marked row releases back to
// the leader, which is upstream's targetManual == -1.
function selectRoamTarget(id) {
  adoptRoamTarget(id);
}

// An observer who has not chosen a view watches the game if there is one --
// following the leader while anyone is playing -- and roams freely while
// nobody is. It keeps up as players come and go, until the observer picks a
// view or a player themself; then the choice is theirs.
let roamViewDefaulted = false;

function applyDefaultRoamView() {
  roamView = getRoamCandidates().length > 0 ? ROAM_VIEW.FOLLOW : ROAM_VIEW.FREE;
  roamTargetId = null;
  roamTargetFlagIndex = null;
}

function refreshDefaultRoamView() {
  if (!roamViewDefaulted || !isObserver() || isPreviewingAltWorld()) return;
  applyDefaultRoamView();
}

// One sequence walks the whole space: the leader, then each player, then the next
// view. Upstream splits this across F8 (view type) and F6/F7 (subject), but bzo
// binds nothing to changing the subject on its own, so fire, `C`, and the
// Settings Camera row all step through the same list rather than offering a view
// cycle that skips past the players. See advanceRoamSelection in roam.mjs.
function cycleRoamView(direction = 1) {
  roamViewDefaulted = false;
  const flagIndexes = getRoamTrackableFlags().map((flag) => flag.index);
  // Map Viewer (issue #68) is Observer on the wire, so nothing about
  // `playerTeam` says so -- `isPreviewingAltWorld()` is what actually means
  // "this world has no other tank or flag in it to track, follow or ride
  // along with", true for a dialog preview and for the rest of a session
  // joined as one alike.
  const viewingAltWorld = isPreviewingAltWorld();
  const next = advanceRoamSelection(
    { view: roamView, targetId: roamTargetId, flagIndex: roamTargetFlagIndex },
    {
      playerIds: getRoamCandidates().sort(compareScoreboardPlayers).map((candidate) => candidate.id),
      flagIndexes,
      allowFlag: flagIndexes.length > 0 && !viewingAltWorld,
      allowTargeted: !viewingAltWorld,
      direction,
    },
  );
  roamView = next.view;
  roamTargetId = next.targetId;
  roamTargetFlagIndex = next.flagIndex;
  refreshScoreboards();
}

// setTarget() (playing.cxx:4390): whoever is centred in the sights.
//
// That only means something in the free view, where the player aims the camera.
// Every other view is already pointed at its target, so identifying from it
// would just re-pick the tank being watched. Upstream never hits this because it
// changes subject with F6/F7 rather than by looking.
function identifyRoamTarget() {
  // setTarget() answers on alert slot 1 for two seconds (playing.cxx:4471), so
  // the reply to a button press lands where the eye is rather than in a chat tab.
  if (roamViewNeedsTarget(roamView)) {
    setHudAlert(1, 'Already following someone', IDENTIFY_ALERT_SECONDS, false);
    return;
  }
  const framing = getRoamFraming();
  if (!framing) return;
  const { eye, look } = framing;
  const forward = { x: look.x - eye.x, y: look.y - eye.y };
  // shouldTarget (playing.cxx:4239), and only here: blindness refuses every
  // target, and a stealthed or cloaked tank can only be locked onto with Seer.
  // Hiding from the eye and the radar would mean little if the flag that names
  // a tank could still find one. Watching one is a different question, which is
  // why `getRoamCandidates` does not ask this.
  const targetable = isViewBlinded() ? [] : getRoamCandidates().filter((candidate) => {
    if (isSeer()) return true;
    const theirFlag = getPlayerFlagType(candidate.id);
    return !hidesFromRadar(theirFlag) && !cloaksTheTank(theirFlag);
  });
  const picked = pickTargetInSights(eye, forward, targetable, TARGETING_ANGLE);
  if (picked === null) {
    setHudAlert(1, 'Looking at nothing', IDENTIFY_ALERT_SECONDS, false);
    return;
  }
  nemesisPlayerId = picked;
  adoptRoamTarget(picked);
  // playing.cxx:4479. Colourblindness costs Identify its answer: upstream drops
  // to "Looking at a tank" rather than naming the callsign, because the name
  // would give away the team the colour no longer does.
  showIdentifyAlert('Looking at', picked);
}

// LocalPlayer::target, mirrored per player. The server owns the lock -- it is
// what steers a real missile -- and broadcasts it, so every client can turn every
// missile the same way rather than guessing. Keyed by shooter; the value is the
// tank id they have locked, or null.
const playerLockTargets = new Map();

function setPlayerLockTarget(playerId, targetId) {
  if (targetId === null || targetId === undefined) playerLockTargets.delete(playerId);
  else playerLockTargets.set(playerId, targetId);
}

// The same eligibility the server applies (`canLockOnto`), asked here so a
// target that dies, pauses or takes `ST` stops being followed without waiting
// for a packet. Returns the tank to steer at, or null.
//
// A lock is also only live while there is a missile for it to steer: `GM` in the
// hand, or one still in the air after the flag was dropped. That is the server's
// `canLockOn`, and it is why the bracket goes out when the flag does.
function getLockTargetTank(shooterId) {
  const targetId = playerLockTargets.get(shooterId);
  if (targetId === undefined) return null;
  if (getPlayerFlagType(shooterId) !== 'GM' && !hasGuidedShotInFlight(shooterId)) return null;
  const tank = tanks.get(targetId);
  const state = tank?.userData?.playerState;
  if (!state || !state.alive || state.paused) return null;
  if (isObserverTeam(state.team)) return null;
  if (hidesFromRadar(getPlayerFlagType(targetId))) return null;
  return tank;
}

// "Right between the eyes" (GuidedMissleStrategy.cxx:180), as the mid-height of
// the hit cylinder -- see `getLockAimPoint` in `server.js` for why bzo aims at
// that rather than at a muzzle.
function getLockAimPoint(tank) {
  const at = tankPoint(tank);
  return { x: at.x, y: at.y, z: at.z + (TANK.height / 2) };
}

// playing.cxx:3537. The tank a missile is coming for is told so -- once, and not
// again for three quarters of a second, however many missiles or updates arrive.
// Upstream warns on the update that names you rather than on the lock itself,
// which is the difference between "somebody could shoot at me" and "somebody
// has".
let lastLockWarningAt = -Infinity;
function warnLockedOnMe(shooterId, targetId) {
  if (targetId !== myPlayerId || shooterId === myPlayerId) return;
  if (!hasGuidedShotInFlight(shooterId)) return;
  const now = performance.now();
  if (now - lastLockWarningAt < LOCK_WARNING_INTERVAL_MS) return;
  lastLockWarningAt = now;
  renderManager.playLocalSound('lock');
  noticeAbout(1, [describePlayer(shooterId), ' locked on me'], IDENTIFY_ALERT_SECONDS, true);
}

// setTarget()'s two messages (playing.cxx:4451 and :4489), composed here because
// the server sends the id and the client owns what a player is called -- and
// owns Colourblindness, which costs Identify its answer: upstream drops to
// "Looking at a tank" rather than naming the callsign, because the name would
// give away the team the colour no longer does.
function showIdentifyResult(targetId, locked) {
  if (targetId === null) {
    setHudAlert(1, 'Looking at nothing', IDENTIFY_ALERT_SECONDS, false);
    return;
  }
  // setNemesis() is inside setTarget()'s locked branch alone (playing.cxx:4450):
  // a lock names your enemy, a look does not.
  if (locked) nemesisPlayerId = targetId;
  showIdentifyAlert(locked ? 'Locked on' : 'Looking at', targetId);
}

// `setTarget` (playing.cxx:4390), which is upstream's own client-side answer and
// becomes bzo's wherever the client is the one tracing shots. bzo's server
// normally decides a lock, because a lock steers a real missile and a missile is
// the server's -- but a target has no such message and no such opinion: upstream
// picks its own target and tells the server afterwards, in `MsgGMUpdate`.
//
// Deliberately the same shape as the server's `setPlayerTarget`, down to the two
// candidate lists and the two angles: a lock is the narrow cone and only over a
// tank a missile could really chase, a look is the wide one and takes anything
// the eye can pick out. `pickTargetInSights` is shared, so the sweep itself is
// one piece of code rather than two.
function resolveOwnLockTarget() {
  if (!myTank) return { targetId: null, locked: false };
  const eye = tankPoint(myTank);
  const azimuth = tankAzimuth(myTank);
  const forward = { x: Math.cos(azimuth), y: Math.sin(azimuth) };
  const seer = isSeer();

  const lockable = [];
  const visible = [];
  tanks.forEach((tank, playerId) => {
    if (playerId === myPlayerId) return;
    const state = tank.userData?.playerState;
    if (!state || !state.alive || state.paused) return;
    if (isObserverTeam(state.team)) return;
    const at = tankPoint(tank);
    const candidate = { id: playerId, x: at.x, y: at.y };
    const theirFlag = getPlayerFlagType(playerId);
    // "can't lock on stealth" (playing.cxx:4426) -- and unlike the look below,
    // no flag sees through it, because a missile is not looking.
    if (!hidesFromRadar(theirFlag)) lockable.push(candidate);
    if (seer || !hidesFromRadar(theirFlag)) visible.push(candidate);
  });

  // A lock is only worth taking while there is a missile for it to steer: `GM`
  // in the hand, or one still in the air after the flag was dropped.
  const canLock = getPlayerFlagType(myPlayerId) === 'GM' || hasGuidedShotInFlight(myPlayerId);
  const locked = canLock ? pickTargetInSights(eye, forward, lockable, getFlagTuning().lockOnAngle) : null;
  return {
    targetId: locked ?? pickTargetInSights(eye, forward, visible, TARGETING_ANGLE),
    locked: locked !== null,
  };
}

// The identify binding, for a tank. An observer answers this on its own client
// -- the free camera it aims with lives there -- a tank on bzo's own server asks
// the server, and a tank on a proxied one answers it here, because that is where
// upstream answers it too.
function requestLockOn() {
  if (clientTracesShots) {
    const { targetId, locked } = resolveOwnLockTarget();
    setPlayerLockTarget(myPlayerId, locked ? targetId : null);
    // Nothing is sent here. Upstream tells the server from the *missile*, not
    // from the key press -- `GuidedMissileStrategy::sendUpdate` fires "only
    // when needed", which is when a missile's own target changes -- so a lock
    // taken with nothing in the air costs no packet, and a missile fired after
    // one announces itself on its first steer (`updateProjectiles`).
    showIdentifyResult(targetId, locked);
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  sendToServer({ type: 'identify' });
}

// The bracket around whatever this player has locked, once a frame: it follows
// the tank, and it goes out the moment the lock does -- a target that dies,
// pauses or takes `ST` is dropped by `getLockTargetTank` without a packet.
// Blindness takes it too, as it takes everything else out the window.
// The autopilot's chase marks its quarry the same way: upstream's
// `AutoPilot::chasePlayer` makes it the tank's target (AutoPilot.cxx:394), and
// the HUD brackets whatever the target is (playing.cxx:7351). A real lock
// wins, and a target hidden by Stealth is not marked.
function getAutopilotTargetTank() {
  if (!autopilotOn) return null;
  const targetId = autopilotOutput?.targetId;
  if (targetId === null || targetId === undefined) return null;
  const tank = tanks.get(targetId);
  const state = tank?.userData?.playerState;
  if (!state || !state.alive || state.paused || isObserverTeam(state.team)) return null;
  if (hidesFromRadar(getPlayerFlagType(targetId))) return null;
  return tank;
}

function updateLockOnMarker() {
  const target = isObserver() || isViewBlinded()
    ? null
    : (getLockTargetTank(myPlayerId) || getAutopilotTargetTank());
  if (!target) {
    renderManager.setLockOnMarker(null);
    return;
  }
  renderManager.setLockOnMarker(
    { x: target.position.x, y: target.position.y, z: target.position.z + (TANK.height / 2) },
    getLockTargetColor(target),
    gameConfig?.FORBID_MARKERS === true,
  );
}

// The colour the target is drawn in, so a masquerading tank's bracket agrees
// with the tank inside it and a colourblind viewer's brackets say no more about
// teams than the tanks do.
function getLockTargetColor(tank) {
  const state = tank.userData?.playerState;
  return getEffectiveTankColor(state?.id, state?.color ?? 0xffffff);
}

// --- hunting ------------------------------------------------------------

// The rows the hunt cursor may land on, in the order the scoreboard draws them.
// Upstream walks its own sorted list (ScoreboardRenderer.cxx:494) and steps past
// your own row, because a tank cannot hunt itself. bzo steps past observers as
// well: an observer has no tank to ring, to stand a beacon over or to spot down
// the sights, so a cursor stop there would mark nothing.
function getHuntCandidates() {
  return getScoreboardModel().rows
    .filter((row) => !row.isCurrent && !row.isObserver)
    .map((row) => row.id);
}

// Entering the cursor with a drive key already down would leave the tank
// rolling: the key's state was set before the press reached here, and the next
// event it produces is a keyup the cursor has already spent. Every key the
// cursor claims is let go on the way in and on every press it takes.
function releaseHuntSelectionKeys() {
  [ 'ArrowUp', 'ArrowDown', 'Space', FIRE_KEY ].forEach((code) => {
    setGameplayKeyState(code, false);
  });
}

// `hunt` and `addhunt` (clientCommands.cxx:1032 and :1044), upstream's own `U`
// and `7`. Both only open the scoreboard cursor; what they differ in is whether
// committing replaces the hunted set or adds to it -- and, from a hunt already
// running, whether the key reopens the cursor or turns hunting off.
//
// Upstream force-opens the scoreboard here if `displayScore` is off
// (ScoreboardRenderer.cxx:310), and so does bzo: the cursor the key opens is
// drawn on the roster, and a hunt aimed at a collapsed one would be invisible.
// Where the two part is afterwards -- see `syncHuntScoreboard`.
function pressHuntKey(isAdd) {
  const sound = huntState.pressHuntKey(isAdd, getHuntCandidates());
  if (sound) renderManager.playLocalSound(sound);
  if (huntState.isSelecting()) releaseHuntSelectionKeys();
  refreshScoreboards();
}

// doKeyCommon (playing.cxx:609). While the cursor is open the scoreboard owns
// Up, Down and fire, so the arrows do not drive and Enter does not shoot.
// Upstream's `identify` and `drop` bindings step the cursor too -- `I` and
// `Space` here -- which is what lets a surface with no arrow keys reach it.
// Returns whether the key was spent.
function handleHuntSelectionKey(event) {
  const direction = (event.code === 'ArrowDown' || event.code === 'KeyI') ? 1
    : (event.code === 'ArrowUp' || event.code === 'Space') ? -1
      : 0;
  if (direction !== 0) {
    releaseHuntSelectionKeys();
    huntState.moveCursor(getHuntCandidates(), direction);
    refreshScoreboards();
    return true;
  }
  if (event.code !== FIRE_KEY) return false;
  releaseHuntSelectionKeys();
  const sound = huntState.select(getHuntCandidates());
  if (sound) renderManager.playLocalSound(sound);
  refreshScoreboards();
  return true;
}

// The mark on a player who has left, and the rule underneath it: hunting that
// has run out of targets is over (ScoreboardRenderer.cxx:581). Upstream reaches
// this by recounting the hunted rows every time it draws the board; bzo asks it
// wherever the roster changes, since the board here is not redrawn every frame.
function pruneHuntedPlayers() {
  if (!huntState.hasHunted() && !huntState.isSelecting()) return;
  const sound = huntState.prune(new Set(tanks.keys()));
  if (sound) renderManager.playLocalSound(sound);
  // A cursor whose row has left, or that has nobody left to point at. Asked
  // after the marks, because a departure can empty both at once.
  huntState.refreshCursor(getHuntCandidates());
}

// --- the Hunt row in Settings -------------------------------------------

// The entries the row steps through: Clear, then the players in alphabetical
// order rather than the board's. A list you step through has to be stable --
// score order re-sorts on every kill, so `right` would land on a different
// player depending on when the press arrived. The scoreboard cursor tolerates
// that only because it is drawn *on* the board and has to follow what is drawn;
// this row is not, so it sorts for stepping instead. Ties break on id, so two
// identical callsigns hold still.
//
// Off the roster rather than the scoreboard model, which the order makes free:
// with nothing to inherit from the board, asking for the model would only tie
// the row to state that is not ready when Settings first paints.
function getHuntRowPlayers() {
  const players = [];
  tanks.forEach((tank, id) => {
    const state = tank.userData?.playerState;
    if (!state || id === myPlayerId || isObserverTeam(state.team)) return;
    players.push({ id, name: state.name || 'Player' });
  });
  return players.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    || String(a.id).localeCompare(String(b.id)));
}

function getHuntRowCandidates() {
  return [{ id: HUNT_ROW_CLEAR_ID, name: 'Clear', clear: true }, ...getHuntRowPlayers()];
}

// The subject, repaired against the current roster: a player who has left hands
// the row back to the first player rather than leaving it pointed at nobody.
// The first *player*, not the first entry -- opening Settings on `Clear` would
// offer to undo the hunt before offering to start one.
function getHuntRowTarget() {
  const candidates = getHuntRowCandidates();
  const found = candidates.find((candidate) => candidate.id === huntRowTargetId);
  if (found) return found;
  const fallback = candidates.find((candidate) => !candidate.clear) ?? null;
  huntRowTargetId = fallback?.id ?? null;
  return fallback;
}

// `<callsign> ○` or `<callsign> ◎`, which is the scoreboard's own pair in the
// scoreboard's own order -- the mark follows the name there too. The row is
// always its own cursor, since it shows one player at a time, so it asks for
// the label with `huntCursor` set and gets the open ring when unmarked.
//
// Clear says how much it would clear, so a press that wipes three marks says so
// before it is pressed rather than after.
function getHuntRowValue() {
  const target = getHuntRowTarget();
  if (!target) return null;
  if (target.clear) {
    return huntState.hasHunted() ? `Clear (${huntState.hunted.size})` : 'Clear';
  }
  const mark = getScoreboardHuntLabel({
    hunted: huntState.isHunted(target.id),
    huntCursor: true,
  });
  return `${target.name} ${mark}`;
}

function stepHuntRow(direction) {
  const candidates = getHuntRowCandidates();
  if (candidates.length < 2) return false;
  const at = candidates.findIndex((candidate) => candidate.id === huntRowTargetId);
  const step = direction < 0 ? -1 : 1;
  const next = at === -1 ? 0 : (at + step + candidates.length) % candidates.length;
  huntRowTargetId = candidates[next].id;
  refreshScoreboards();
  return true;
}

// The row's own verb, which is whatever the entry it is on means. On a player,
// `addhunt` semantics -- it adds to the set and takes one back off it -- because
// a row that replaced everything on every press could never mark a second
// player, and `U` is the key for replacing. On Clear, upstream's `hunt` from a
// running hunt: every mark goes.
function toggleHuntRow() {
  const target = getHuntRowTarget();
  if (!target) return false;
  const sound = target.clear ? huntState.clearAll() : huntState.toggle(target.id);
  if (sound) renderManager.playLocalSound(sound);
  refreshScoreboards();
  return true;
}

// setHuntTarget (playing.cxx:4505), run every frame for a driving tank: if a
// hunted tank is the nearest thing inside the targeting cone, say so and ping
// from where it is.
//
// This is the one targeting question bzo asks on the client. `identify` goes to
// the server because it can take a guided-missile lock, which steers a real
// shot and so cannot be a client's word -- see `setPlayerTarget` in server.js.
// A sighting steers nothing: it is an alert and a sound for the player who
// already marked the target, so a modified client that faked one would be
// lying only to itself, and asking the server once a frame per player would be
// a real cost for it.
//
// Upstream lets a guided-missile lock further away beat a nearer tank inside
// the wider cone, purely because both are picked in one loop; bzo asks the
// targeting cone on its own, the same split `setPlayerTarget` already makes.
function updateHuntBearing() {
  if (!huntState.hasHunted()) return;
  // `_forbidHunting`: the world allows marking but no sighting
  // (playing.cxx:4507), so a hunted tank in the sights is never announced.
  if (gameConfig?.FORBID_HUNTING === true) return;
  if (!myTank || isObserver() || !isMyTankAlive()) return;
  // Blindness and Colourblindness both refuse the alert and the ping
  // (playing.cxx:4562). Upstream picks the target first and then checks; the
  // answer is the same and this way the scan is skipped entirely.
  const myFlagType = getMyFlag()?.type ?? null;
  if (blanksTheView(myFlagType) || hidesTeamColors(myFlagType)) return;

  // The tank's own heading, not the camera's, which is what upstream scans
  // with -- a sighting is about where the barrel points.
  const eye = { x: myX, y: myY };
  const forward = { x: Math.cos(myAzimuth), y: Math.sin(myAzimuth) };
  const seer = isSeer();
  const candidates = [];
  tanks.forEach((tank, id) => {
    const state = tank.userData?.playerState;
    if (!state || id === myPlayerId || !state.alive || isObserverTeam(state.team)) return;
    // Stealth is out of the scan unless Seer is in hand (playing.cxx:4552).
    if (!seer && hidesFromRadar(getPlayerFlagType(id))) return;
    const at = tankPoint(tank);
    candidates.push({ id, x: at.x, y: at.y });
  });

  const spotted = pickTargetInSights(eye, forward, candidates, TARGETING_ANGLE);
  if (spotted === null || !huntState.isHunted(spotted)) return;
  // Checked again after the pick, as upstream checks it: a Seer may scan a
  // Stealth tank, but hunting still refuses to report one.
  if (hidesFromRadar(getPlayerFlagType(spotted))) return;

  // "Don't interfere with GM lock display" (playing.cxx:4566) -- the lock
  // already owns this alert slot and is the more urgent of the two. The ping
  // still sounds, which is upstream's own split.
  if (!getLockTargetTank(myPlayerId)) {
    showHuntAlert(spotted);
  }
  if (frameEpochMs >= huntPulseUntil) {
    huntPulseUntil = frameEpochMs + HUNT_PULSE_MS;
    const tank = tanks.get(spotted);
    if (tank) renderManager.playSound('hunt', tank.position);
  }
}

// `SPOTTED: <callsign> (<team>) with <flag>` (playing.cxx:4569), written through
// the same composition every other bzo notice names a tank with, so a sighting
// and the roster describe the same player the same way.
function showHuntAlert(playerId) {
  const described = describePlayer(playerId);
  setHudAlert(
    1,
    `SPOTTED: ${described.text}`,
    HUNT_ALERT_SECONDS,
    false,
    described.segments ? [{ text: 'SPOTTED: ' }, ...described.segments] : null,
  );
}

function getTankEyeHeight(tank) {
  return Number.isFinite(tank?.userData?.cameraHeight)
    ? tank.userData.cameraHeight
    : TANK.muzzleHeight;
}

// Each view resolved to a concrete eye and look point, so render.js only has to
// apply one. The rigs are upstream's from `playing.cxx:6001`.
function getRoamFraming() {
  if (!roamCamera) return null;
  const eye = { x: roamCamera.x, y: roamCamera.y, z: roamCamera.z };

  if (roamViewNeedsTarget(roamView)) {
    const target = getRoamTargetTank();
    if (target) {
      const targetAt = target.position;
      const targetEye = getTankEyeHeight(target);
      const forward = getRoamForward(tankAzimuth(target));
      if (roamView === ROAM_VIEW.FPS) {
        const fpsEye = {
          x: targetAt.x,
          y: targetAt.y,
          z: targetAt.z + targetEye,
        };
        return {
          eye: fpsEye,
          look: { x: fpsEye.x + forward.x, y: fpsEye.y + forward.y, z: fpsEye.z },
        };
      }
      if (roamView === ROAM_VIEW.FOLLOW) {
        return {
          eye: {
            x: targetAt.x - forward.x * ROAM_FOLLOW_DISTANCE,
            y: targetAt.y - forward.y * ROAM_FOLLOW_DISTANCE,
            z: targetAt.z + targetEye * ROAM_FOLLOW_HEIGHT_FACTOR,
          },
          look: { x: targetAt.x, y: targetAt.y, z: targetAt.z },
        };
      }
      // Track: the camera stays put and turns to keep the target in view.
      return {
        eye,
        look: {
          x: targetAt.x,
          y: targetAt.y,
          z: targetAt.z + targetEye,
        },
      };
    }
  } else if (roamView === ROAM_VIEW.FLAG) {
    const flag = getRoamTargetFlag();
    if (flag) {
      return {
        eye,
        look: { x: flag.position.x, y: flag.position.y, z: flag.position.z },
      };
    }
  }

  // Free roam, and the fallback whenever a view has nothing to point at, which
  // is what `Roaming::changeTarget` does when it finds no target. The look point
  // is one unit ahead, tilted by the camera's pitch, so it travels with the
  // camera -- forward, sideways and vertically.
  return { eye, look: getRoamLook(roamCamera) };
}

// getRoamingLabel() (Roaming.cxx:325). ScoreboardRenderer::getLeader prefixes
// "Leader " when the target is the automatic one, so watching whoever is winning
// reads differently from having picked that same player by hand.
function getRoamLabel() {
  return getRoamLabelParts().text;
}

// The label as `{ text, segments }`, so the name in it is written the way the
// scoreboard and chat write one -- the player's own colour, the cyan `+`/`@`
// before it, and `/FLAG` after it in the flag's colour (issue #154). It was a
// plain string, which made the one place an observer reads a callsign the one
// place a callsign said nothing.
//
// The words around the name stay uncoloured, and `text` is still the whole
// line, so a surface that cannot colour anything reads exactly as before.
function getRoamLabelParts() {
  const plain = (text) => ({ text, segments: [{ text }] });
  const join = (...parts) => {
    const segments = [];
    for (const part of parts) {
      if (typeof part === 'string') segments.push({ text: part });
      else if (part?.segments) segments.push(...part.segments);
    }
    return { text: segments.map((segment) => segment.text).join(''), segments };
  };

  const targetId = getRoamTargetId();
  const target = getRoamTargetTank();
  const state = target?.userData?.playerState;
  const named = target
    ? formatPlayerLabel({
      name: state?.name || 'nobody',
      nameColor: Number.isFinite(state?.color) ? state.color : null,
      flag: getPlayerFlagLabel(targetId),
      mark: getPlayerTeamMark(getPlayerTeamById(targetId)),
      status: getPlayerStatusIndicator(state),
    })
    : plain('nobody');
  // `Leader` is the automatic target rather than one picked by hand, the same
  // distinction `ScoreboardRenderer::getLeader` draws -- a word about the
  // choice, not part of the callsign, so it stays uncoloured.
  const who = roamTargetId === null && target ? join('Leader ', named) : named;

  if (roamView === ROAM_VIEW.TRACK && target) return join('Tracking ', who);
  if (roamView === ROAM_VIEW.FOLLOW && target) return join('Following ', who);
  if (roamView === ROAM_VIEW.FPS && target) return join('Driving with ', who);
  if (roamView === ROAM_VIEW.FLAG) {
    const flag = getRoamTargetFlag();
    if (flag) return plain(`Tracking ${describeFlag(flag)}`);
  }
  if (roamView === ROAM_VIEW.DRIVE_FP) return plain('First Person');
  if (roamView === ROAM_VIEW.DRIVE_TP) return plain('Third Person');
  if (roamView === ROAM_VIEW.OVERVIEW) return plain('Overview');
  return plain('Roaming');
}

// Upstream moves the observer's own tank to the eye point every frame --
// `myTank->move(virtPos, roamViewAngle)` in `playing.cxx:6110` -- so the radar,
// the heading tape, and the sound listener all read the camera without knowing
// about roaming. bzo does the same: the mesh is invisible while dead, and the
// only thing sent for it is the position update at the bottom of this function.
// `/mv` on an observer: the camera, in free roam, where it was sent -- at eye
// height above the spot, as a camera made from a spawn is -- tilted when a
// pitch came with it and as it was otherwise. Choosing for the player, as
// picking a view does, so the leader default does not take it back.
function moveRoamCameraTo(message) {
  if (!myTank || ![message.x, message.y, message.z, message.a].every(Number.isFinite)) return;
  const eyeHeight = Number.isFinite(myTank.userData?.cameraHeight)
    ? myTank.userData.cameraHeight
    : TANK.muzzleHeight;
  roamCamera = {
    ...createRoamCamera(eyeHeight),
    x: message.x,
    y: message.y,
    z: Math.max(eyeHeight, message.z + eyeHeight),
    azimuth: message.a,
    pitch: Number.isFinite(message.pitch) ? message.pitch : (roamCamera?.pitch ?? 0),
  };
  roamView = ROAM_VIEW.FREE;
  roamTargetId = null;
  roamTargetFlagIndex = null;
  roamViewDefaulted = false;
}

function handleRoamMotion(deltaTime) {
  if (!isObserver()) {
    roamCamera = null;
    roamView = ROAM_VIEW.FREE;
    roamTargetId = null;
    roamIdentifyWasHeld = false;
    lastObserverHeartbeatAt = -Infinity;
    return;
  }
  if (!myTank || !gameConfig) return;

  // Driving (issue #68's phantom tank): `handleMotion`/`handleInputEvents`
  // already resolved position, rotation and the tank's own transform through
  // the real tank's own physics this frame -- the same pass a playing tank
  // runs, `updateInsideBuildings` included -- so nothing below this belongs
  // to it. Visibility and the heartbeat still do: a phantom tank is shown to
  // the player driving it (unlike free-roam's invisible virtual tank), but
  // never to anyone else, since `addPlayer`'s alive-gated visibility on
  // every other client is untouched and this player stays dead on the
  // server regardless of camera mode.
  if (isPhantomDriving()) {
    myTank.visible = true;
    if (myTank.userData.ghostMesh) myTank.userData.ghostMesh.visible = false;
    if (myTank.userData.jumpPredictionDebug) myTank.userData.jumpPredictionDebug.visible = false;
    wasPhantomDriving = true;
    sendObserverUpdate();
    return;
  }
  // Dropping back out of DRIVE_FP/DRIVE_TP: the tank's own physics just left
  // `myTank` wherever driving ended, but `roamCamera` was never touched while
  // that ran (see above) and still holds wherever free roam was parked before
  // driving started. Clearing it here forces the `!roamCamera` init below to
  // re-seed it from `myTank`'s current position instead of resuming that
  // stale one.
  if (wasPhantomDriving) {
    roamCamera = null;
    wasPhantomDriving = false;
  }

  const inputActive = isGameplayInputActive();

  const identifyHeld = inputActive && virtualInput.identify;
  if (identifyHeld && !roamIdentifyWasHeld) identifyRoamTarget();
  roamIdentifyWasHeld = identifyHeld;

  // The camera rides at a tank's eye height, so roamCamera.z is an eye and the
  // mesh below it stands on the ground -- the same relation first person has
  // between myTank.position.z and cameraHeight.
  const eyeHeight = Number.isFinite(myTank.userData?.cameraHeight)
    ? myTank.userData.cameraHeight
    : TANK.muzzleHeight;
  if (!roamCamera) {
    // Upstream's resetCamera() starts at the origin, which it gets away with
    // because its default view is fps and never free. Starting there here drops
    // the observer in the middle of the map looking at nothing, so the camera
    // begins at the spawn the server handed us, facing the way it faces.
    roamCamera = {
      ...createRoamCamera(eyeHeight),
      x: myTank.position.x,
      y: myTank.position.y,
      z: Math.max(eyeHeight, myTank.position.z + eyeHeight),
      azimuth: myAzimuth,
      pitch: linkRoamPitch ?? 0,
    };
    linkRoamPitch = null;
  }

  // A dialog or the chat input owning the keyboard must not also fly the camera.
  const input = isGameplayInputActive()
    ? gatherDriveInput()
    : { forward: 0, turn: 0, up: false, down: false };

  roamCamera = updateRoamCamera(roamCamera, input, deltaTime, {
    tankSpeed: gameConfig.TANK_SPEED,
    floorZ: eyeHeight,
  });

  // An observer has no tank to show, with one exception. The mesh is still
  // moved, because the radar, the heading tape and the sound listener all read
  // its transform -- that is upstream's virtual tank -- but nothing draws it:
  // not the tank, not its server-position ghost, which hangs off worldFrame
  // rather than off the tank and so does not inherit this.
  //
  // Overview is the exception. The whole point of that view is seeing the map
  // laid out, and a camera above the map is the one place where the virtual
  // tank is not under your feet but a thing on the board -- without it there
  // is nothing on screen saying where you are, or where switching back to any
  // other view would put you.
  myTank.visible = roamView === ROAM_VIEW.OVERVIEW;
  if (myTank.userData.ghostMesh) myTank.userData.ghostMesh.visible = false;
  if (myTank.userData.jumpPredictionDebug) myTank.userData.jumpPredictionDebug.visible = false;

  // The eye is whichever view is running, not the roaming camera: a tracking
  // view leaves `roamCamera` where free roam parked it and frames itself off the
  // target instead. Upstream reads the same eyePoint back out of the view it
  // just resolved -- `virtPos` in playing.cxx:6108 -- so following a tank
  // carries the radar, the heading tape and the position other clients place
  // this observer at along with the camera.
  const framing = getRoamFraming();
  const eye = framing ? framing.eye : { x: roamCamera.x, y: roamCamera.y, z: roamCamera.z };

  // The virtual tank stands under the eye rather than at it, so it sits where a
  // driver's tank would relative to the camera.
  myX = eye.x;
  myY = eye.y;
  myZ = eye.z - eyeHeight;
  myAzimuth = framing
    ? getRoamViewAngle(framing.eye, framing.look, roamCamera.azimuth)
    : roamCamera.azimuth;
  placeTank(myTank, myX, myY, myZ, myAzimuth);

  // `handleMotion` -- where this runs for a real tank -- returns immediately
  // for an observer, so it never reaches its own call to this.
  updateInsideBuildings();

  sendObserverUpdate();
}

// How far the camera may leave the position last sent before the heartbeat is
// not worth waiting out. It is a quarter of the nearby voice radius, which is
// the one thing that reads the position, so nobody is ever placed a full earshot
// away from where they are. A camera parked or drifting slowly never reaches it
// and keeps the plain heartbeat.
const OBSERVER_DRIFT_THRESHOLD = 15;
// And no more than one of those a second however fast the camera is moving, so
// the early send stays a correction to the heartbeat rather than a stream. At
// free roam's 100 u/s that is one send per 100 units travelled.
const OBSERVER_DRIFT_MIN_INTERVAL = 1000;

// Upstream has this: `sendObserverHeartbeat` in playing.cxx:7415 gates a normal
// player update behind `observerHeartbeat`, so a server can say where its
// observers are. Its default is 30 seconds, which is coarse enough to place a
// name on a scoreboard and far too coarse to place a voice, so bzo sends one on
// the same MAX_UPDATE_INTERVAL a driving tank already uses as its heartbeat.
//
// The packet carries a position and a heading and nothing else. Every velocity
// is zero, so neither end has anything to dead reckon: the camera is simply
// wherever it was when the packet left, until the next one says otherwise. An
// observer is not tracked through its movements and does not need to be -- the
// question anything asks of the position is roughly where, not exactly where.
//
// The heartbeat alone answers that only for a camera that stays put. A tracking
// view rides a tank that drives, without the observer touching a control, and
// five seconds of that is further than the whole nearby radius: the observer
// would be heard from a place they had already left entirely. So the drift check
// below sends early when the camera has genuinely gone somewhere else, capped at
// one a second, and the heartbeat carries every other case as before.
function sendObserverUpdate() {
  const now = performance.now();
  const sinceLastSend = now - lastObserverHeartbeatAt;
  const drifted = Math.hypot(
    myX - lastObserverSentX,
    myY - lastObserverSentY,
    myZ - lastObserverSentZ,
  ) >= OBSERVER_DRIFT_THRESHOLD;
  const due = drifted
    ? sinceLastSend >= OBSERVER_DRIFT_MIN_INTERVAL
    : sinceLastSend >= getMaxUpdateInterval();
  if (!due) return;
  lastObserverHeartbeatAt = now;
  lastObserverSentX = myX;
  lastObserverSentY = myY;
  lastObserverSentZ = myZ;
  sendToServer({
    type: 'm',
    id: myPlayerId,
    x: Number(myX.toFixed(2)),
    y: Number(myY.toFixed(2)),
    z: Number(myZ.toFixed(2)),
    a: Number(normalizeAngle(myAzimuth).toFixed(2)),
    fs: 0,
    rs: 0,
    vv: 0,
  });
}

// --- Autopilot -----------------------------------------------------------
//
// Roger (`AutoPilot.cxx`) and the pilots built on him, chosen on the Settings
// row and toggled by `9` or `/autopilot`. The decisions live in
// `public/autopilot.mjs` behind a view of this client's world, so a
// server-launched bot can drive the same code; this is the view, and the seam
// where its answer replaces the sticks. One of each pilot for the session, so
// what one has learned about flags survives switching it off and on, as
// upstream's static tables do.
const autopilots = new Map(AUTOPILOTS.map((entry) => [entry.id, new entry.Pilot()]));
// The pilot flying, or null.
let autopilotId = null;
// The pilot flying when the page went away, kept so a reload -- which is what a
// server restart with a new build does to every client -- comes back flying.
const AUTOPILOT_STORAGE_KEY = 'autopilot';
function readStoredAutopilot() {
  try {
    const id = localStorage.getItem(AUTOPILOT_STORAGE_KEY);
    return AUTOPILOTS.some((entry) => entry.id === id) ? id : null;
  } catch {
    return null;
  }
}
function storeAutopilot(id) {
  try {
    if (id) localStorage.setItem(AUTOPILOT_STORAGE_KEY, id);
    else localStorage.removeItem(AUTOPILOT_STORAGE_KEY);
  } catch {
    /* ignore storage errors */
  }
}
let autopilotRestoreId = readStoredAutopilot();
// The pilot the Settings row is pointed at: `9` turns it on, and a menu opened
// while it is not flying engages it rather than pausing (issue #162). None, the
// default, keeps a menu's pause. Remembered on its own, as the player's choice.
const AUTOPILOT_ROW_STORAGE_KEY = 'autopilotRow';
function readStoredAutopilotRow() {
  try {
    const id = localStorage.getItem(AUTOPILOT_ROW_STORAGE_KEY);
    return AUTOPILOTS.some((entry) => entry.id === id) ? id : null;
  } catch {
    return null;
  }
}
function storeAutopilotRow(id) {
  try {
    if (id) localStorage.setItem(AUTOPILOT_ROW_STORAGE_KEY, id);
    else localStorage.removeItem(AUTOPILOT_ROW_STORAGE_KEY);
  } catch {
    /* ignore storage errors */
  }
}
let autopilotRowId = readStoredAutopilotRow() ?? autopilotRestoreId;
// Whether the pilot flying was put on by a menu opening, and so comes off
// when the menu closes.
let autopilotMenuEngaged = false;
let autopilotMenuCovered = false;
let autopilotOn = false;
let autopilotOutput = null;
let autopilotEnabledAt = -Infinity;
let autopilotDropAt = -Infinity;
let autopilotLockAt = -Infinity;
// cmdAutoPilot's "more than once every five seconds" (clientCommands.cxx:526).
const AUTOPILOT_ENABLE_INTERVAL_MS = 5000;
// How long a drop request is left to land before Roger asks again.
const AUTOPILOT_DROP_RETRY_MS = 1000;
// How often Roger may press Identify to move its missile lock.
const AUTOPILOT_LOCK_RETRY_MS = 500;

function canUseAutopilot() {
  return gameplayJoinConfirmed && !isObserver() && gameConfig?.DISABLE_BOTS !== true;
}

function getAutopilotName(id) {
  return AUTOPILOTS.find((entry) => entry.id === id)?.name ?? id;
}

// cmdAutoPilot: off if on, otherwise on with the pilot `id` names.
function toggleAutopilot(id = autopilotRowId ?? DEFAULT_PILOT) {
  if (!gameplayJoinConfirmed || isObserver()) return;
  if (autopilotOn) {
    setAutopilot(null);
    setHudAlert(0, 'autopilot disabled', 1);
    return;
  }
  engageAutopilot(id);
}

function engageAutopilot(id) {
  if (!gameplayJoinConfirmed || isObserver()) return;
  if (gameConfig?.DISABLE_BOTS === true) {
    setHudAlert(0, 'autopilot not allowed on this server', 1);
    return;
  }
  // Changing pilot in flight is not enabling the autopilot, so it does not
  // spend the five seconds.
  if (autopilotOn) {
    autopilotId = id;
    autopilotOutput = null;
    // Chosen by the player, so it stays when a menu that put a pilot on closes.
    autopilotMenuEngaged = false;
    storeAutopilot(id);
    sendToServer({ type: 'autopilot', on: true, pilot: getAutopilotName(id) });
    setHudAlert(0, `${getAutopilotName(id)} has the controls`, 1);
    return;
  }
  const now = performance.now();
  if (now - autopilotEnabledAt <= AUTOPILOT_ENABLE_INTERVAL_MS) {
    showMessage('You may not enable the Autopilot more than once every five seconds.');
    return;
  }
  autopilotEnabledAt = now;
  setAutopilot(id);
  setHudAlert(0, 'autopilot enabled', 1);
}

function setAutopilot(id, { remember = true } = {}) {
  autopilotId = id;
  autopilotOn = id !== null;
  if (!autopilotOn) clearAutopilotIntent();
  autopilotReportAt = 0;
  // A pilot a menu put on is not the player's choice to come back to.
  if (remember) storeAutopilot(id);
  autopilotMenuEngaged = false;
  autopilotOutput = null;
  sendToServer({ type: 'autopilot', on: autopilotOn, pilot: autopilotOn ? getAutopilotName(id) : null });
}

// The Autopilot row: `None`, then each pilot, the one flying marked as the
// Hunt row marks a hunted player. Select flies the pilot shown, or on `None`
// or the pilot already flying, lands.
function getAutopilotRowChoices() {
  return [{ id: null, name: 'None' }, ...AUTOPILOTS];
}

function getAutopilotRowValue() {
  if (!canUseAutopilot()) return gameConfig?.DISABLE_BOTS === true ? 'Not allowed' : 'Unavailable';
  const flying = autopilotOn ? autopilotId : null;
  const mark = autopilotRowId === flying ? '◎' : '○';
  return `${autopilotRowId === null ? 'None' : getAutopilotName(autopilotRowId)} ${mark}`;
}

function stepAutopilotRow(direction) {
  const choices = getAutopilotRowChoices();
  const at = choices.findIndex((choice) => choice.id === autopilotRowId);
  const next = (at + (direction < 0 ? -1 : 1) + choices.length) % choices.length;
  autopilotRowId = choices[next].id;
  storeAutopilotRow(autopilotRowId);
  return true;
}

function selectAutopilotRow() {
  if (!canUseAutopilot()) return false;
  if (autopilotRowId === null || (autopilotOn && autopilotId === autopilotRowId)) {
    if (autopilotOn) {
      setAutopilot(null);
      setHudAlert(0, 'autopilot disabled', 1);
    }
    return true;
  }
  engageAutopilot(autopilotRowId);
  return true;
}

const autopilotRouter = createRouter(() => ({
  obstacles: OBSTACLES,
  mapSize: currentWorldMapSize || DEFAULT_MAP_SIZE,
  waterLevel: currentWorldWaterHeight > 0 ? currentWorldWaterHeight : null,
  teleporterLinks: TELEPORTER_GRAPH?.links || [],
  // The jump itself always, for a tank whose flag lets it jump where the
  // world does not; whether this one may is the pilot's to say.
  allowJumping: gameConfig?.ALLOW_JUMPING === true,
  jump: gameConfig
    ? { velocity: gameConfig.JUMP_VELOCITY, gravity: gameConfig.GRAVITY, tankSpeed: gameConfig.TANK_SPEED }
    : null,
}));
const autopilotProbes = createWorldProbes({
  obstacles: () => OBSTACLES,
  colliders: getCollisionColliders,
  mapSize: () => currentWorldMapSize || DEFAULT_MAP_SIZE,
  findImpact: findShotSegmentImpact,
  topOf: getColliderTopY,
});


// A remote tank's motion now, from the last move it sent, by the same model
// `extrapolatePosition` draws it with: in the air its packet's air velocity
// and its vertical velocity run down by gravity since the packet, on the
// ground its speed along its heading.
function getTankMotion(tank, flagType, now) {
  const data = tank.userData;
  const airborne = data.jumpAzimuth !== null && data.jumpAzimuth !== undefined;
  const gravity = hasAirControl(flagType) ? gameConfig.WINGS_GRAVITY : gameConfig.GRAVITY;
  if (airborne) {
    const elapsed = Math.max(0, (now - (data.lastUpdateTime || now)) / 1000);
    return {
      airborne,
      gravity,
      vx: data.airVelocityX || 0,
      vy: data.airVelocityY || 0,
      vz: (data.verticalVelocity || 0) - (gravity * elapsed),
    };
  }
  const azimuth = data.slideAzimuth ?? tankAzimuth(tank);
  const speed = (data.forwardSpeed || 0) * gameConfig.TANK_SPEED;
  return {
    airborne, gravity, vx: Math.cos(azimuth) * speed, vy: Math.sin(azimuth) * speed, vz: 0,
  };
}

function buildAutopilotView() {
  const myFlag = getMyFlag();
  const myType = myFlag?.type ?? null;
  const myTeamColor = getMyTeamColorIndex();
  const teamsAllowed = gameConfig?.TEAMS_ALLOWED !== false;
  const now = performance.now();
  const players = [];
  for (const [playerId, tank] of tanks) {
    if (playerId === myPlayerId) continue;
    const state = tank.userData?.playerState;
    if (!state || isObserverTeam(state.team)) continue;
    const flag = getPlayerFlag(playerId);
    players.push({
      id: playerId,
      ...tankPoint(tank),
      ...getTankMotion(tank, flag?.type ?? null, now),
      team: state.team,
      alive: state.alive === true,
      paused: state.paused === true,
      notResponding: false,
      flag: flag?.type ?? null,
      flagIndex: flag?.index ?? null,
      flagTeam: getFlagTeamIndex(flag?.type ?? null),
      zoned: isZoned(flag?.type ?? null, flag?.zoned === true),
    });
  }
  const shots = [];
  for (const projectile of projectiles.values()) {
    const data = projectile.userData;
    if (!data || data.playerId === myPlayerId || !Number.isFinite(data.speed)) continue;
    const ownerFlag = getPlayerFlag(data.playerId);
    shots.push({
      ownerId: data.playerId,
      ownerZoned: isZoned(ownerFlag?.type ?? null, ownerFlag?.zoned === true),
      flag: data.flag ?? null,
      ...data.at,
      vx: (data.dirX || 0) * data.speed,
      vy: (data.dirY || 0) * data.speed,
      vz: (data.dirZ || 0) * data.speed,
    });
  }
  const groundFlags = [];
  let teamFlags = false;
  for (const flag of flags.values()) {
    const team = getFlagTeamIndex(flag.type);
    if (team !== null) teamFlags = true;
    groundFlags.push({
      index: flag.index,
      type: flag.type ?? null,
      team,
      onGround: flag.status === FLAG_STATUS.ON_GROUND,
      x: flag.position.x,
      y: flag.position.y,
      z: flag.position.z,
    });
  }
  return {
    now: now / 1000,
    self: {
      id: myPlayerId,
      x: myX,
      y: myY,
      z: myZ,
      azimuth: myAzimuth,
      flag: myType,
      flagIndex: myFlag?.index ?? null,
      flagTeam: getFlagTeamIndex(myType),
      teamColor: myTeamColor,
      team: playerTeam,
      zoned: amZoned(),
      inAir: isInAir,
      muzzleForward: myMuzzle().forward,
      muzzleHeight: myMuzzle().height,
      shotSpeed: getShotSpeed(getMyShotFlag()),
      shotLifetime: getShotLifetimeSeconds(getMyShotFlag()),
      ricochet: shotRicochets(getMyShotFlag(), gameConfig?.ALL_SHOTS_RICOCHET),
      canFire: findFreeShotSlot(
        myShotSlotFreeAt, normalizeShotSlotCount(gameConfig.SHOT_MAX_ACTIVE), frameEpochMs) >= 0,
      freeShots: countFreeShotSlots(
        myShotSlotFreeAt, normalizeShotSlotCount(gameConfig.SHOT_MAX_ACTIVE), frameEpochMs),
      // How the tank is moving, which a shot inherits: its velocity as of the
      // last move, its speed along the barrel, how fast it can go and how fast
      // that speed may change (0, no limit).
      velocity: { ...shotTankVelocity },
      speed: lastSpeed,
      topSpeed: lastTopSpeed || gameConfig.TANK_SPEED,
      accel: lastLinearLimit,
      // The turn rate it has, radians a second, and how fast that may change
      // (0, no limit): what a jump leaves with is reached from here.
      angVel: lastAngVel,
      angAccel: lastAngularLimit,
      // Full-stick turn rate as this tank's flag and place leave it.
      turnRate: lastTurnRate || gameConfig.TANK_ROTATION_SPEED,
    },
    players,
    shots,
    flags: groundFlags,
    world: {
      allowJumping: gameConfig.ALLOW_JUMPING === true,
      teamFlags,
      waterLevel: currentWorldWaterHeight > 0 ? currentWorldWaterHeight : null,
      shotSpeed: Number.isFinite(gameConfig.SHOT_SPEED) ? gameConfig.SHOT_SPEED : 100,
      maxShots: normalizeShotSlotCount(gameConfig.SHOT_MAX_ACTIVE),
      tankHeight: TANK.height,
      tankLength: TANK.halfLength * 2,
      tankAngVel: gameConfig.TANK_ROTATION_SPEED,
      tankSpeed: gameConfig.TANK_SPEED,
      shakeTimeout: normalizeShakeTimeout(gameConfig.FLAG_SHAKE_TIMEOUT),
      jumpVelocity: gameConfig.JUMP_VELOCITY,
      gravity: gameConfig.GRAVITY,
      lockOnAngle: getFlagTuning().lockOnAngle,
      mapSize: Number.isFinite(currentWorldMapSize) ? currentWorldMapSize : DEFAULT_MAP_SIZE,
      shockOutRadius: getShotEffects('SW').shockOutRadius,
    },
    isFoe: (player) => areFoes(player.team, playerTeam, teamsAllowed),
    myBase: () => {
      const base = OBSTACLES.find((obs) => obs.kind === 'base' && obs.team === myTeamColor);
      if (!base) return null;
      return {
        x: base.pos[0],
        y: base.pos[1],
        z: getColliderTopY(base),
        radius: Math.min(base.size[0], base.size[1]),
      };
    },
    bases: teamBasesOf(OBSTACLES, getColliderTopY),
    vantages: autopilotVantages(),
    safetyZones: liveWorldData?.safetyZones || [],
    ...autopilotProbes,
    findRoute: autopilotRouter,
    // Where this client's bad flag can be shed, which the server tells only
    // its carrier.
    antidote: antidotePosition,
  };
}

// What the pilot is doing, drawn under Debug Geometry for the person it is
// flying for: the route
// left to drive (jump legs in their own colour), a beacon on what it is going
// for, a cross where a jumper it is waiting on will land, and each shot's path
// for a moment after it goes -- red for one it held back. None of this is the
// server's business, so a server-run bot simply has no one to draw it for.
// The flat tops the autopilot may camp on, found once per world.
let autopilotVantageCache = { obstacles: null, spots: [] };
function autopilotVantages() {
  if (autopilotVantageCache.obstacles !== OBSTACLES) {
    autopilotVantageCache = { obstacles: OBSTACLES, spots: findVantagePoints(OBSTACLES, getColliderTopY) };
  }
  return autopilotVantageCache.spots;
}

const AUTOPILOT_OVERLAY = Object.freeze({
  vantage: 0x8080ff,
  vantageChosen: 0x40ff40,
  vantageHeight: 8,
  ground: 0x00e5ff,
  raised: 0xffd400,
  jump: 0xff40ff,
  target: 0x40ff40,
  foe: 0xff6040,
  landing: 0xffffff,
  shot: 0xffffff,
  held: 0xff3030,
  lift: 0.3,
  beaconHeight: 20,
  shotSeconds: 1,
});
let autopilotShotOverlay = null;
// The report the pilot sends every so often, and the kills and deaths since
// the last one, which only the client hears about.
const AUTOPILOT_REPORT_MS = 10000;
let autopilotReportAt = 0;
const autopilotTally = { kills: 0, deaths: 0 };

// `origin` is where the route starts: the tank the plan belongs to, which is
// this one unless it is a followed server bot's.
function drawAutopilotIntent(intent, nowMs, origin = null) {
  const segments = [];
  const lift = (p, dz = AUTOPILOT_OVERLAY.lift) => ({ x: p.x, y: p.y, z: p.z + dz });
  if (intent?.route?.length) {
    let from = origin || { x: myX, y: myY, z: myZ };
    for (const node of intent.route) {
      const color = node.jump
        ? AUTOPILOT_OVERLAY.jump
        : (node.z > 0.33 ? AUTOPILOT_OVERLAY.raised : AUTOPILOT_OVERLAY.ground);
      segments.push({ a: lift(from), b: lift(node), color });
      from = node;
    }
  }
  if (intent?.target) {
    const t = intent.target;
    const color = t.id !== undefined ? AUTOPILOT_OVERLAY.foe : AUTOPILOT_OVERLAY.target;
    segments.push({ a: lift(t, 0), b: lift(t, AUTOPILOT_OVERLAY.beaconHeight), color });
    const r = 3;
    const corners = [[r, 0], [0, r], [-r, 0], [0, -r], [r, 0]];
    for (let i = 0; i < 4; i++) {
      segments.push({
        a: { x: t.x + corners[i][0], y: t.y + corners[i][1], z: t.z + 0.5 },
        b: { x: t.x + corners[i + 1][0], y: t.y + corners[i + 1][1], z: t.z + 0.5 },
        color,
      });
    }
  }
  // Camping spots the pilot scored: a post on each, taller for a better
  // score, and the chosen one in its own colour.
  if (intent?.vantages?.length) {
    const top = Math.max(...intent.vantages.map((v) => v.score));
    const low = Math.min(...intent.vantages.map((v) => v.score));
    for (const v of intent.vantages) {
      const share = top > low ? (v.score - low) / (top - low) : 1;
      const height = AUTOPILOT_OVERLAY.vantageHeight * (0.3 + (0.7 * share));
      segments.push({
        a: lift(v, 0),
        b: lift(v, height),
        color: v.chosen ? AUTOPILOT_OVERLAY.vantageChosen : AUTOPILOT_OVERLAY.vantage,
      });
    }
  }
  if (intent?.landing) {
    const l = intent.landing;
    const r = 2.5;
    segments.push({ a: { x: l.x - r, y: l.y - r, z: l.z + 0.2 }, b: { x: l.x + r, y: l.y + r, z: l.z + 0.2 }, color: AUTOPILOT_OVERLAY.landing });
    segments.push({ a: { x: l.x - r, y: l.y + r, z: l.z + 0.2 }, b: { x: l.x + r, y: l.y - r, z: l.z + 0.2 }, color: AUTOPILOT_OVERLAY.landing });
  }
  if (intent?.shot) {
    const shot = intent.shot;
    const path = shot.segments || autopilotProbes.traceShot(
      shot.from, shot.dir, shot.speed ?? getShotSpeed(getMyShotFlag()), getShotLifetimeSeconds(getMyShotFlag()),
      shotRicochets(getMyShotFlag(), gameConfig?.ALL_SHOTS_RICOCHET));
    autopilotShotOverlay = { path, held: shot.held === true, at: nowMs };
  }
  if (autopilotShotOverlay && nowMs - autopilotShotOverlay.at < AUTOPILOT_OVERLAY.shotSeconds * 1000) {
    const color = autopilotShotOverlay.held ? AUTOPILOT_OVERLAY.held : AUTOPILOT_OVERLAY.shot;
    for (const step of autopilotShotOverlay.path) segments.push({ a: step.from, b: step.to, color });
  }
  renderManager.setOverlaySegments(segments);
}

function clearAutopilotIntent() {
  autopilotShotOverlay = null;
  renderManager.setOverlaySegments([]);
}

function reportAutopilot(nowMs) {
  if (nowMs < autopilotReportAt) return;
  const first = autopilotReportAt === 0;
  autopilotReportAt = nowMs + AUTOPILOT_REPORT_MS;
  const report = autopilots.get(autopilotId).takeReport();
  if (first) return;
  sendToServer({
    type: 'debug',
    message: `[autopilot] ${getAutopilotName(autopilotId)}: ${report};`
      + ` kills ${autopilotTally.kills}, deaths ${autopilotTally.deaths}`,
  });
  autopilotTally.kills = 0;
  autopilotTally.deaths = 0;
}

// One autopilot flight, takeoff to landing, against what the pilot planned
// for it (`lastFlight`): the heading and turn rate it left with, and how far
// off the way on it faced when it came down. Sent as a debug line, so the log
// says what a flight on a real client did -- the bot benchmark flies the
// server's physics, not this one.
let autopilotFlight = null;
function noteAutopilotFlight(wasInAir, nowInAir, rotationSpeed) {
  if (!autopilotOn) {
    autopilotFlight = null;
    return;
  }
  const deg = (radians) => (radians * 180 / Math.PI).toFixed(0);
  if (!wasInAir && nowInAir) {
    const pilot = autopilots.get(autopilotId);
    const plan = pilot?.lastFlight && (performance.now() / 1000) - pilot.lastFlight.at < 0.5 ? pilot.lastFlight : null;
    autopilotFlight = {
      at: performance.now(),
      azimuth: myAzimuth,
      rs: rotationSpeed,
      x: myX,
      y: myY,
      plan,
      mode: autopilotOutput?.intent?.mode ?? '?',
      // What the route asked for as the tank left the surface, for an
      // unplanned one: the next node, and whether it was backing off a face.
      next: autopilotOutput?.intent?.route?.[0] ?? null,
      backingOff: pilot?.teleportBackingOff === true
        || (pilot?.lastThinkAt ?? 0) - (pilot?.lastTeleportAt ?? -Infinity) < 1.5,
    };
    return;
  }
  if (!(wasInAir && !nowInAir) || !autopilotFlight) return;
  const flight = autopilotFlight;
  autopilotFlight = null;
  const plan = flight.plan;
  const aim = plan?.aim;
  const want = aim ? Math.atan2(aim.y - myY, aim.x - myX) : null;
  const off = want === null ? null : Math.abs(normalizeAngle(myAzimuth - want));
  sendToServer({
    type: 'debug',
    message: `[autopilot] flight (${flight.mode}${plan ? (plan.jump ? ', jump' : ', drive-off') : ', unplanned'}):`
      + ` from (${flight.x.toFixed(0)},${flight.y.toFixed(0)}) a ${flight.azimuth.toFixed(2)} rs ${flight.rs.toFixed(2)}`
      + ` to (${myX.toFixed(0)},${myY.toFixed(0)},${myZ.toFixed(0)}) a ${myAzimuth.toFixed(2)}`
      + ` after ${((performance.now() - flight.at) / 1000).toFixed(2)}s`
      + (plan ? `; planned air ${plan.air.toFixed(2)}s turn ${deg(plan.turn)} deg cmd ${plan.rotation.toFixed(2)},`
        + ` landing (${plan.landing.x},${plan.landing.y},${plan.landing.z}) aim (${aim.x},${aim.y}),`
        + ` facing ${deg(off)} deg off the aim` : '')
      + (!plan && flight.next ? `; next (${flight.next.x},${flight.next.y},${flight.next.z})`
        + `${flight.next.teleport ? ' teleport' : ''}${flight.backingOff ? ', just teleported' : ''}` : ''),
  });
}

// A followed server bot's plan, drawn as an autopilot's own is: kept while the
// server keeps sending it, dropped a second after it stops.
const FOLLOWED_BOT_PLAN_STALE_MS = 1000;
function drawFollowedBotPlan() {
  syncBotWatch();
  const plan = followedBotPlan;
  const now = performance.now();
  const tank = plan ? tanks.get(plan.id) : null;
  if (!showDebugGeometry || !plan || !tank || now - plan.at > FOLLOWED_BOT_PLAN_STALE_MS) {
    if (followedBotPlanDrawn) clearAutopilotIntent();
    followedBotPlanDrawn = false;
    return;
  }
  drawAutopilotIntent(plan.intent, now, tank.position);
  followedBotPlanDrawn = true;
}
let followedBotPlanDrawn = false;

function runAutopilot() {
  if (!autopilotOn || isObserver() || !isMyTankAlive() || pauseState.paused) {
    if (autopilotOutput) clearAutopilotIntent();
    autopilotOutput = null;
    if (isObserver()) drawFollowedBotPlan();
    return;
  }
  autopilotOutput = autopilots.get(autopilotId).think(buildAutopilotView());
  const now = performance.now();
  if (showDebugGeometry) drawAutopilotIntent(autopilotOutput.intent, now);
  else if (autopilotShotOverlay !== null || renderManager.overlayLines?.visible) clearAutopilotIntent();
  reportAutopilot(now);
  // chasePlayer's `setTarget` (AutoPilot.cxx:394), which is what a Guided
  // Missile steers at. Upstream names the target outright; bzo locks the way a
  // player does, with Identify, so the server keeps its sights check. Roger
  // only fires inside a cone narrower than the lock's, so a shot it is about to
  // take is one Identify would lock.
  if (autopilotOutput.shotTargetId !== null
    && getMyFlag()?.type === 'GM'
    && playerLockTargets.get(myPlayerId) !== autopilotOutput.shotTargetId
    && now - autopilotLockAt > AUTOPILOT_LOCK_RETRY_MS) {
    autopilotLockAt = now;
    requestLockOn();
  }
  if (autopilotOutput.dropFlag && getMyFlag() && now - autopilotDropAt > AUTOPILOT_DROP_RETRY_MS) {
    autopilotDropAt = now;
    requestFlagDrop();
  }
}

// The drive axes every input surface funnels into, gathered in one place so a
// tank and an observer's camera read the same controls. Callers apply their own
// limits: a tank caps reverse and treats `up` as a jump, while the roaming
// camera spends `up` and `down` on altitude, which is the whole reason those two
// come back raw.
function gatherDriveInput({ player = true } = {}) {
  if (!player) {
    return {
      forward: autopilotOutput?.speed ?? 0,
      turn: autopilotOutput?.rotation ?? 0,
      up: autopilotOutput?.jump === true,
      down: false,
    };
  }
  let up = false;
  let down = false;

  // Use virtual input if gamepad connected, XR enabled, or virtual controls enabled
  let stickForward = 0;
  let stickTurn = 0;
  if (usesVirtualInput()) {
    stickForward = virtualInput.forward;
    stickTurn = virtualInput.turn;
    up = virtualInput.jump;
    down = virtualInput.drop;
  }

  let keyForward = 0;
  let keyTurn = 0;
  let forwardKeyHeld = false;
  let turnKeyHeld = false;
  for (const code in FORWARD_KEYS) {
    if (keys[code]) {
      keyForward += FORWARD_KEYS[code];
      forwardKeyHeld = true;
    }
  }
  for (const code in TURN_KEYS) {
    if (keys[code]) {
      keyTurn += TURN_KEYS[code];
      turnKeyHeld = true;
    }
  }

  // Per axis, the first source with something to say wins: keys, then a stick,
  // then the mouse box. Upstream mixes the same way where it mixes at all --
  // its joystick branch takes rotation from the keyboard and speed from the
  // stick (playing.cxx:1048) -- and the order matters, because a released stick
  // reads zero and falls through while the mouse box legitimately holds an
  // offset with the cursor parked away from centre. Holding W and S together is
  // a deliberate stop, so a held pair still owns its axis at zero, which is
  // what upstream's keyboardSpeed does with the same pair of keys.
  let forward = forwardKeyHeld ? keyForward : stickForward;
  let turn = turnKeyHeld ? keyTurn : stickTurn;

  if (keys['Tab']) up = true;
  if (keys['Space']) down = true;
  // Shift turns drive into pitch for an observer's camera (roam.mjs); a tank
  // has no use for it.
  const pitch = Boolean(keys['ShiftLeft'] || keys['ShiftRight']);

  // The autopilot takes the mouse box's place, last in line: a key or a stick
  // still owns its axis while it is held, so a player can turn a pilot out of
  // a corner while it keeps the speed, and lets go to hand it back. The mouse
  // box is left out altogether -- it holds an offset wherever the cursor is
  // parked, so it would never hand anything back.
  if (autopilotOn && autopilotOutput) {
    if (!forwardKeyHeld && stickForward === 0) forward = autopilotOutput.speed;
    if (!turnKeyHeld && stickTurn === 0) turn = autopilotOutput.rotation;
    return { forward, turn, up: up || autopilotOutput.jump, down, pitch };
  }

  if (mouseSteeringActive()) {
    if (!forwardKeyHeld && stickForward === 0) forward = -mouseY;
    if (!turnKeyHeld && stickTurn === 0) turn = -mouseX;
  }

  return { forward, turn, up, down, pitch };
}

// The local tank as the shared `drive` step sees it. The rest of client.js
// reads and writes the tank through its own globals -- position, the air and
// ground state, the momentum velocities -- so each step loads them in and
// writes them back out, and the step itself never touches the page.
const myDrive = createDriveState();
function loadMyDrive() {
  const data = myTank.userData;
  Object.assign(myDrive, {
    x: myX,
    y: myY,
    z: myZ,
    azimuth: myAzimuth,
    verticalVelocity: data.verticalVelocity || 0,
    airVelocityX: data.airVelocityX || 0,
    airVelocityY: data.airVelocityY || 0,
    jumpDirection: jumpAzimuth ?? null,
    onGround,
    onObstacle,
    inAir: isInAir,
    lastObstacle: lastMotionObstacle,
    insideBuildings,
    lastSpeed,
    lastAngVel,
    previousSpeedFraction: data.previousSpeedFraction || 0,
    agilityStartedAt: data.agilityStartedAt ?? -Infinity,
    jumpForwardSpeed: data.jumpForwardSpeed || 0,
    fallForwardSpeed: data.fallForwardSpeed || 0,
    slideDirection: data.slideAzimuth,
    forwardSpeed: data.forwardSpeed || 0,
    rotationSpeed: data.rotationSpeed || 0,
    stuckFrameCount: data.stuckFrameCount || 0,
    wingsFlapsLeft,
    jumpWasHeld,
    wasAirborne: data.wasAirborne === true,
    bounceReadyAt: data.bounceReadyAt ?? 0,
  });
}
function storeMyDrive() {
  const data = myTank.userData;
  myX = myDrive.x;
  myY = myDrive.y;
  myZ = myDrive.z;
  myAzimuth = myDrive.azimuth;
  data.verticalVelocity = myDrive.verticalVelocity;
  data.airVelocityX = myDrive.airVelocityX;
  data.airVelocityY = myDrive.airVelocityY;
  jumpAzimuth = myDrive.jumpDirection;
  onGround = myDrive.onGround;
  onObstacle = myDrive.onObstacle;
  isInAir = myDrive.inAir;
  lastMotionObstacle = myDrive.lastObstacle;
  lastSpeed = myDrive.lastSpeed;
  lastAngVel = myDrive.lastAngVel;
  lastTopSpeed = myDrive.topSpeed;
  lastTurnRate = myDrive.turnRate;
  lastLinearLimit = myDrive.linearLimit;
  lastAngularLimit = myDrive.angularLimit;
  data.previousSpeedFraction = myDrive.previousSpeedFraction;
  data.agilityStartedAt = myDrive.agilityStartedAt;
  data.jumpForwardSpeed = myDrive.jumpForwardSpeed;
  data.fallForwardSpeed = myDrive.fallForwardSpeed;
  data.slideAzimuth = myDrive.slideDirection;
  data.forwardSpeed = myDrive.forwardSpeed;
  data.rotationSpeed = myDrive.rotationSpeed;
  data.stuckFrameCount = myDrive.stuckFrameCount;
  wingsFlapsLeft = myDrive.wingsFlapsLeft;
  jumpWasHeld = myDrive.jumpWasHeld;
  data.wasAirborne = myDrive.wasAirborne;
  data.bounceReadyAt = myDrive.bounceReadyAt;
}
function myDriveTank() {
  const flag = getMyFlag();
  return {
    flag: flag?.type ?? null,
    motionFlag: effectiveMotionFlagType(),
    zoned: flag?.zoned === true,
    // Unlimited Wings while driving as an observer (issue #68).
    unlimitedFlaps: isPhantomDriving(),
  };
}
function myDriveWorld() {
  return {
    config: gameConfig,
    colliders: getCollisionColliders(),
    topOf: getColliderTopY,
    teleport: (from, to) => predictLocalPlayerTeleport(from, to, frameEpochMs),
  };
}
function myDriveClock() {
  return { now: performance.now() / 1000, random: Math.random };
}

function handleInputEvents() {
  // Reset intended input each frame
  intendedForward = 0;
  intendedRotation = 0;
  jumpTriggered = false;

  updateVirtualInputFromXR();
  updateVirtualInputFromGamepad();

  if (!myTank || !gameConfig) return;
  // A driving observer (issue #68) reads every input a playing tank does --
  // only `handleRoamMotion` still treats it as an observer, for the camera
  // and the heartbeat.
  if (isObserver() && !isPhantomDriving()) return;

  // Where the tank is standing is not asked again here. doUpdateMotion reads
  // `location` at the top of the frame from whatever the last step resolved
  // (LocalPlayer.cxx:307) and the input branch is chosen off that -- so the one
  // pass in `handleMotion` is the only thing that decides it, and this only
  // reads the answer. Searching for a support surface here as well was the
  // second opinion every bug in this path came out of.
  showMotionSurfaceDebug(lastMotionObstacle);

  if (pauseState.isFrozen() || entryDialogFreeze) return;
  if (isMyTankFrozenByDeath()) return;

  runAutopilot();

  // What the controls ask for, after the flags have had their say: the shared
  // `drive` step's own reading. With a menu or chat holding the keys a pilot
  // still drives -- the player's own controls are simply not read -- and with
  // neither, nothing is (issues #95 and #99).
  let controls = null;
  if (isGameplayInputActive() || (autopilotOn && autopilotOutput)) {
    const drive = gatherDriveInput({ player: isGameplayInputActive() });
    controls = { forward: drive.forward, turn: drive.turn, up: drive.up };
  }
  loadMyDrive();
  const intended = readDriveInput(myDrive, controls, myDriveTank(), myDriveWorld(), myDriveClock());
  storeMyDrive();
  intendedForward = intended.forward;
  intendedRotation = intended.rotation;
  jumpTriggered = intended.jumpTriggered;
  phasedReverse = intended.phasedReverse;
}

function handleMotion(deltaTime) {
  if (!myTank || !gameConfig) return;
  // A driving observer (issue #68) runs this whole pass unmodified -- the
  // point of it is reusing exactly what a playing tank already does. Only the
  // three `sendToServer` calls inside (move packet, teleport report, drop
  // flag) and shooting's own send are conditioned separately below, on
  // `isObserver()` alone rather than this, since driving never sends any of
  // them.
  if (isObserver() && !isPhantomDriving()) return;
  if (pauseState.isFrozen() || entryDialogFreeze) return;

  // The motion is the shared `drive` step's (public/drive.mjs), the one every
  // tank drives by -- this browser's, a server bot's, a practice Worker's. What
  // stays here is what only a browser does with it: the sounds, the jets and
  // rings, the packets, and the tank's mesh.
  loadMyDrive();
  const wasInAir = isInAir;
  // The rest of this pass still runs for a dead tank: the heartbeat below is
  // what keeps a proxied bzfs from marking it not responding.
  const events = isMyTankFrozenByDeath() ? holdDrive(myDrive) : stepDrive(myDrive, {
    forward: intendedForward,
    rotation: intendedRotation,
    jumpTriggered,
    phasedReverse,
  }, myDriveTank(), myDriveWorld(), myDriveClock(), deltaTime);
  storeMyDrive();
  let forceMoveSend = events.forceSend;
  const jumpStarted = Boolean(events.jumpStarted);

  if (events.landed) {
    clearJumpPredictionDebug(myTank);
    triggerLandingFeedback(myTank, events.landed.impactSpeed, {
      local: true,
      silent: isDrivenUpward(events.landed.obstacle, events.landed.x, events.landed.y, events.landed.z),
    });
  }
  if (events.jumpStarted) {
    renderManager.playSound(events.jumpStarted.flap ? 'flap' : 'jump', myTank.position);
    renderManager.fireTankJumpJets(myTank);
  }
  if (events.zoneToggle) {
    const zoneFlag = getMyFlag();
    const zoned = !(zoneFlag.zoned === true);
    zoneFlag.zoned = zoned;
    // The point the crossing happened at: the server has to check the claim
    // the client actually made.
    sendToServer({
      type: 'zone',
      fromFaceId: events.zoneToggle.fromFaceId,
      x: Number(events.zoneToggle.x.toFixed(2)),
      y: Number(events.zoneToggle.y.toFixed(2)),
      z: Number(events.zoneToggle.z.toFixed(2)),
      a: Number(events.zoneToggle.azimuth.toFixed(2)),
    });
    // SFX_PHANTOM, in place of SFX_TELEPORT. Upstream plays one or the other.
    renderManager.playSound('phantom', myTank.position);
    showMessage(zoned ? 'Zoned' : 'Unzoned');
  }

  placeTank(myTank, myX, myY, myZ, myAzimuth);

  if (events.teleport) {
    renderManager.playSound('teleport', myTank.position);
    suppressLocalTeleportFxUntil = performance.now() + 250;
    // BZFlag's order: the teleport is reported before any move this frame
    // makes. A driving observer (issue #68) crosses the portal but never
    // reports it, which the server would refuse from Observer anyway.
    const tp = events.teleport;
    if (!isObserver() && ws && ws.readyState === WebSocket.OPEN) {
      sendToServer({
        type: 'tp',
        fromFaceId: tp.fromFaceId,
        toFaceId: tp.toFaceId,
        x: Number(tp.source.x.toFixed(2)),
        y: Number(tp.source.y.toFixed(2)),
        z: Number(tp.source.z.toFixed(2)),
        a: Number(tp.sourceAzimuth.toFixed(2)),
        vv: Number(tp.verticalVelocity.toFixed(2)),
        vx: Number(tp.airVelocityX.toFixed(2)),
        vy: Number(tp.airVelocityY.toFixed(2)),
        ja: tp.jumpDirection !== null && tp.jumpDirection !== undefined ? Number(tp.jumpDirection.toFixed(2)) : null,
      });
    }
  } else {
    decayLocalTeleportReentryBlock(events.moved, frameEpochMs);
  }

  updateInsideBuildings();

  // doUpdateMotion's sound chain (LocalPlayer.cxx:803-816), in upstream's order
  // and in the ear rather than positional: a driver pushing upward, otherwise
  // the frame a tank goes into the ground, which only Burrow ever does.
  if (events.drivenUpward) {
    renderManager.playLocalSound('bounce');
  } else if (events.burrowEntered) {
    renderManager.playLocalSound('burrow');
  }

  const forwardSpeed = myDrive.forwardSpeed;
  const rotationSpeed = myDrive.rotationSpeed;
  noteAutopilotFlight(wasInAir, isInAir, rotationSpeed);

  const now = performance.now();
  const timeSinceLastSend = now - lastSentTime;
  const verticalVelocity = myTank ? (myTank.userData.verticalVelocity || 0) : 0;
  const airborneState = jumpAzimuth !== null;
  const airVelocityX = airborneState ? (myTank.userData.airVelocityX || 0) : 0;
  const airVelocityY = airborneState ? (myTank.userData.airVelocityY || 0) : 0;

  // Velocity-based dead reckoning: only send when velocities change (positions are extrapolated)
  const forwardSpeedDelta = Math.abs(forwardSpeed - lastSentForwardSpeed);
  const rotationSpeedDelta = Math.abs(rotationSpeed - lastSentRotationSpeed);
  // Player::isDeadReckoningWrong (Player.cxx:1300): the heading the others
  // predict from the last move -- its heading, turned at its rate since -- drifts
  // from the real one by more than `_angleTolerance` (0.05 rad by default).
  const angleTolerance = Number.isFinite(gameConfig?.ANGLE_TOLERANCE) ? gameConfig.ANGLE_TOLERANCE : 0.05;
  const predictedHeading = lastSentHeading === null ? myAzimuth
    : lastSentHeading + (lastSentRotationSpeed * (gameConfig?.TANK_ROTATION_SPEED || 0)
      * (timeSinceLastSend / 1000));
  const headingDrift = Math.abs(normalizeAngle(myAzimuth - predictedHeading));
  // Don't check vertical velocity changes while in air - gravity is extrapolated
  // Only jump/land transitions matter (handled by forceMoveSend)
  const verticalVelocityDelta = airborneState ? 0 : Math.abs(verticalVelocity - lastSentVerticalVelocity);
  const airVelocityDelta = airborneState
    ? Math.hypot(airVelocityX - lastSentAirVelocityX, airVelocityY - lastSentAirVelocityY)
    : 0;

  // Stopped against moving, on either axis and in either direction, is sent
  // whatever the size of the change. A viewer sees a tank held still that is
  // creeping, or one creeping that has stopped, until the next heartbeat --
  // and then it snaps. `VELOCITY_THRESHOLD` alone lets a slow start, or one
  // axis stopping while the other carries on, slip under it. Throttled with
  // the other velocity changes, so a stick hovering at the line cannot flood.
  // Judged on the value as it goes on the wire, rounded to two places, or a
  // speed just over the line that rounds onto it would never match what was
  // sent and would be sent again every frame.
  const movingAt = (speed) => Math.abs(Number(speed.toFixed(2))) > DEAD_STICK_STOP_THRESHOLD;
  const stopStartCrossed = !airborneState && (
    movingAt(forwardSpeed) !== movingAt(lastSentForwardSpeed)
    || movingAt(rotationSpeed) !== movingAt(lastSentRotationSpeed));

  const deadStickStopUpdate =
    !airborneState &&
    Math.abs(forwardSpeed) <= DEAD_STICK_STOP_THRESHOLD &&
    Math.abs(rotationSpeed) <= DEAD_STICK_STOP_THRESHOLD &&
    (Math.abs(lastSentForwardSpeed) > DEAD_STICK_STOP_THRESHOLD ||
      Math.abs(lastSentRotationSpeed) > DEAD_STICK_STOP_THRESHOLD);

  if (deadStickStopUpdate) {
    forceMoveSend = true;
  }

  // Fire: the keyboard fire key or the left mouse button, and on mobile, XR or
  // a gamepad, virtualInput.fire.
  //
  // `LocalPlayer::fireShot` waits on one thing: a free slot. `firingStatus`
  // stays Ready however long a reload has left (LocalPlayer.cxx:847), and
  // nothing upstream puts a minimum gap between two shots -- a bzflag player
  // empties their slots as fast as they can click. What upstream does have is a
  // trigger read once per press (`cmdFire`, clientCommands.cxx:333) on a mouse.
  //
  // bzo has a touch button, an XR trigger and a gamepad, where a trigger left
  // held would fire on every frame. So a press and a hold are told apart: a
  // press may fire again after `SHOT_TAP_SPACING_MS`, which is short enough
  // that tapping is as fast as clicking a mouse, and a trigger still held
  // repeats at the world's sustained rate instead. Holding is the convenience;
  // it is never the faster option.
  //
  // "Tank can't stop firing." Trigger Happy pulls the trigger every frame
  // whether or not anybody is holding it, and neither of the trigger's own
  // gates applies to it -- but `forceReload` below does, which is upstream's
  // own way of stopping all of its shots going off at once.
  //
  // Decided here, ahead of the move, because a shot forces one: "always send
  // a player-update message. To synchronize movement and shot start"
  // (LocalPlayer.cxx:1268). The server measures the muzzle against where the
  // last move says the tank is, and a tank that turned since then is not there.
  const triggerHappy = firesContinuously(getMyFlag()?.type ?? null);
  const fireHeld = isFireHeld();
  const firePress = fireHeld && !fireWasHeld;
  fireWasHeld = fireHeld;
  const fireNow = frameEpochMs;
  let triggerOpen = false;
  if (triggerHappy) triggerOpen = true;
  else if (firePress) triggerOpen = fireNow >= nextTapShotAt;
  else if (fireHeld) triggerOpen = fireNow >= nextHeldShotAt;
  const maxActiveShots = normalizeShotSlotCount(gameConfig?.SHOT_MAX_ACTIVE);
  const shotSlot = triggerOpen && fireNow >= shotJamUntil
    ? findFreeShotSlot(myShotSlotFreeAt, maxActiveShots, fireNow)
    : -1;
  if (shotSlot >= 0) forceMoveSend = true;

  const reasons = [];
  if (forceMoveSend) reasons.push('force');
  if (deadStickStopUpdate) reasons.push('dead-stick-stop');
  if (forwardSpeedDelta > VELOCITY_THRESHOLD) reasons.push(`fs:${forwardSpeedDelta.toFixed(3)}`);
  if (rotationSpeedDelta > VELOCITY_THRESHOLD) reasons.push(`rs:${rotationSpeedDelta.toFixed(3)}`);
  if (verticalVelocityDelta > VERTICAL_VELOCITY_THRESHOLD) reasons.push(`vv:${verticalVelocityDelta.toFixed(3)}`);
  if (airVelocityDelta > AIR_VELOCITY_THRESHOLD) reasons.push(`av:${airVelocityDelta.toFixed(3)}`);
  if (headingDrift > angleTolerance) reasons.push(`r:${headingDrift.toFixed(3)}`);
  if (timeSinceLastSend > getMaxUpdateInterval()) reasons.push(`time:${(timeSinceLastSend/1000).toFixed(1)}s`);

  // Minimum 100ms between non-forced updates to prevent rapid-fire from calculation noise
  // `_updateThrottleRate`: no more than that many a second (Player.cxx:1268),
  // and 0 is no limit.
  const throttleRate = Number.isFinite(gameConfig?.UPDATE_THROTTLE_RATE) ? gameConfig.UPDATE_THROTTLE_RATE : 30;
  const minTimeBetweenUpdates = throttleRate > 0 ? 1000 / throttleRate : 0; // ms
  const canSendVelocityUpdate = forceMoveSend || timeSinceLastSend > minTimeBetweenUpdates;

  const shouldSendUpdate =
    forceMoveSend || // Force send on jump/land transitions
    // A frame that fires sends its move first, always: upstream's
    // `fireShot` sends a player update before every MsgShotBegin "to
    // synchronize movement and shot start" (LocalPlayer.cxx:1266).
    shotSlot >= 0 ||
    // Heartbeat every MAX_UPDATE_INTERVAL, on the ground or in the air. A
    // grounded tank already relies on this to say something when nothing else
    // has changed; an airborne one needs it too, because a jump's own forced
    // sends (start, land, an air-velocity change) only cover an ordinary jump
    // -- one that's over in a couple of seconds. A tank that cannot progress
    // its own arc at all (a collision livelock: see
    // docs/hung-player-plan.md) otherwise has nothing left to report, ever.
    // Costs nothing on an ordinary jump, which never runs long
    // enough to reach it, and is the one thing that still fires when a jump
    // that should have taken two seconds is still going after five.
    timeSinceLastSend > getMaxUpdateInterval() ||
    (canSendVelocityUpdate && (
      stopStartCrossed ||
      forwardSpeedDelta > VELOCITY_THRESHOLD ||
      rotationSpeedDelta > VELOCITY_THRESHOLD ||
      verticalVelocityDelta > VERTICAL_VELOCITY_THRESHOLD ||
      airVelocityDelta > AIR_VELOCITY_THRESHOLD ||
      headingDrift > angleTolerance
    ));

  // A driving observer (issue #68) resolves every bit of this exactly like a
  // playing tank -- it just never reports it. `sendObserverUpdate`, from
  // `handleRoamMotion`, is the only thing that reaches the server for it.
  // Not before the join is confirmed, for the reason `shoot` gives: a
  // reconnect still carries the last session's tank until the new `init`
  // clears it, and a move from it reports the old position to a server that
  // has none yet.
  // The move's motion, from the shared step's state, rounded as it goes on the
  // wire (`movePacketFields`); a jump sends the speed it left with and a dead
  // stick its zero. The shot fired this frame inherits the velocity the server
  // will read back off those same numbers.
  const motionFields = movePacketFields(myDrive, { jumpStarted, stopped: deadStickStopUpdate });
  const sentFS = motionFields.fs;
  const sentRS = motionFields.rs;
  const sentVV = motionFields.vv;
  shotTankVelocity = packetVelocity(motionFields, gameConfig);

  if (shouldSendUpdate && !isObserver() && gameplayJoinConfirmed
    && ws && ws.readyState === WebSocket.OPEN) {

    const movePacket = {
      type: 'm',
      id: myPlayerId,
      ...motionFields,
      dt: Number(deltaTime.toFixed(3)),
      // How long the client took to get from the last packet's speeds to these
      // ones. `dt` above is one frame, which is the window `fs` and `rs` were
      // measured over, not the window they changed over. The server's own
      // arrival gap is the send interval plus network jitter, so it is the one
      // number neither side can measure alone; see the acceleration check in
      // `server.js`, which bounds how far it will trust this.
      sdt: Number((timeSinceLastSend / 1000).toFixed(3)),
      // This frame's epoch clock (`sampleEpochClock`), relative to
      // `clientClockOrigin` so it is upstream's own small float rather than a
      // wall-clock epoch -- the server only ever differences it against this
      // same client's previous accepted value, never reads it as an absolute
      // time. See docs/lag-plan.md, "Extrapolate on the client's clock, not
      // ours".
      ct: Number(((frameEpochMs - clientClockOrigin) / 1000).toFixed(3)),
    };

    if (myTank && myTank.userData.ghostMesh) {
      placeTank(myTank.userData.ghostMesh, movePacket.x, movePacket.y, movePacket.z, movePacket.a);
      myTank.userData.ghostMesh.userData.hasPacketState = true;
      myTank.userData.ghostMesh.visible = showDebugGeometry;
      updatePacketMotionDebug(myTank.userData.ghostMesh, {
      fs: sentFS,
      rs: sentRS,
      vv: sentVV,
      vx: movePacket.vx,
      vy: movePacket.vy,
      a: movePacket.a,
      sd: movePacket.sd,
      jumpAzimuth
      }, 'sent');
    }

    if (jumpAzimuth !== null && jumpAzimuth !== undefined) {
      updateJumpPredictionDebug(myTank, {
        x: movePacket.x,
        y: movePacket.y,
        z: movePacket.z,
        azimuth: movePacket.a,
        forwardSpeed: sentFS,
        rotationSpeed: sentRS,
        verticalVelocity: sentVV,
        jumpAzimuth,
        slideAzimuth: movePacket.sd,
        airVelocityX: movePacket.vx,
        airVelocityY: movePacket.vy
      }, 'sent');
    } else {
      clearJumpPredictionDebug(myTank);
    }

    sendToServer(movePacket);
    // Store the ROUNDED values we actually sent to prevent rounding-induced deltas
    lastSentForwardSpeed = sentFS;
    lastSentRotationSpeed = sentRS;
    lastSentHeading = movePacket.a;
    lastSentVerticalVelocity = sentVV;
    lastSentAirVelocityX = movePacket.vx;
    lastSentAirVelocityY = movePacket.vy;
    lastSentTime = now;

  }
  // Drop: the Space key is handled with the other discrete keys, so this is the
  // touch button, the XR A button, and the gamepad's spare face button. Held
  // down it must drop once, not once a frame.
  const dropHeld = usesVirtualInput() && virtualInput.drop;
  if (dropHeld && !dropWasHeld) requestFlagDrop();
  dropWasHeld = dropHeld;

  // Identify: the `I` key is a discrete key handled with the others, so this is
  // the touch button, the right mouse button, either VR B and either gamepad
  // shoulder. Held down it locks once, not once a frame. The test is the
  // observer's rather than the drop key's above, because the right mouse button
  // reaches `virtualInput` on a desktop that uses no virtual controls at all.
  const identifyHeld = isGameplayInputActive() && virtualInput.identify;
  if (identifyHeld && !identifyWasHeld) requestLockOn();
  identifyWasHeld = identifyHeld;

  // The shot decided above, taken now that the move it rides with is out.
  if (shotSlot >= 0 && shoot()) {
    const slotReloadMs = getSlotReloadMs(getMyShotFlag());
    myShotSlotFreeAt[shotSlot] = fireNow + slotReloadMs;
    myShotSlotReloadMs[shotSlot] = slotReloadMs;
    nextTapShotAt = fireNow + SHOT_TAP_SPACING_MS;
    nextHeldShotAt = fireNow + getHeldTriggerIntervalMs();
    // LocalPlayer.cxx:1311, "make sure all the shots don't go off at once".
    // The one place upstream itself spaces shots, and it spaces only this
    // flag's: a tank nobody is even aiming would otherwise fire its whole
    // magazine into the ground the instant it picked the flag up.
    if (triggerHappy) {
      forceReload(getWorldReloadSeconds(gameConfig || {}) / Math.max(1, maxActiveShots));
    }
  }
}

function shoot() {
  if (isObserver() && !isPhantomDriving()) return false;
  // LocalPlayer::fireShot's "make sure we're allowed to shoot"
  // (LocalPlayer.cxx:1220). A dead or paused tank has no shot to fire, and bzo
  // holds to it here rather than leaving it to the server: `getShotRejection`
  // refuses both, so a client that fired anyway would be sending a packet the
  // server only accepts in warning mode -- and warning mode is for measuring
  // honest disagreements, not for carrying a client's own bugs.
  //
  // `isMyTankAlive()` reads the server's own roster, which reports not alive
  // for an observer always -- a phantom tank is never dead by that measure,
  // so aliveness is skipped entirely while driving rather than asked at all.
  if ((!isPhantomDriving() && !isMyTankAlive()) || pauseState.paused) return false;
  // "((location == InBuilding) && !isPhantomZoned())" from the same test: a tank
  // inside a building has no shot to fire, because the shot would come out of a
  // wall. `getShotRejection` refuses it too -- the cover a building gives is
  // worth more to a modified client than anything else `OO` grants.
  if (amInsideBuilding() && !amZoned()) return false;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  // An open socket is not a tank. bzo reconnects on its own, and between the
  // socket opening and the join being confirmed the client still carries the
  // last session's state -- alive, holding the trigger, standing where it used
  // to. Upstream has nothing to guard here because it has no tank at all until
  // it has entered the game.
  if (!gameplayJoinConfirmed) return false;

  const dirX = Math.cos(myAzimuth);
  const dirY = Math.sin(myAzimuth);

  const myShot = getShotEffects(getMyShotFlag());

  // The shot every tank fires (`shotFromTank` in the shared drive pair): from
  // the muzzle this tank's model reports -- under the tank for a shock wave,
  // which swells around it rather than leaving a barrel -- with upstream's
  // velocity, the tank's own plus the shot speed along the barrel.
  //
  // A phantom tank's shot (issue #68) is cosmetic: nothing about it is sent,
  // so nobody else ever sees or hears it and the server never learns it
  // happened. The local prediction below runs exactly as it does for a real
  // shot waiting on `shotBegin` -- which for this one never arrives, so the
  // existing 2-second stale-prediction purge in `updateProjectiles` is what
  // ends it rather than the shot's own ~3.5s range/speed lifetime. Accepted
  // for now rather than teaching it a real expiry.
  const shotMessage = shotFromTank({
    x: myX,
    y: myY,
    z: myTank ? myZ : 0,
    azimuth: myAzimuth,
    tankVelocity: shotTankVelocity,
    config: gameConfig,
    shockwave: myShot.shockwave,
    muzzleForward: myMuzzle().forward,
    muzzleHeight: myMuzzle().height,
  });
  const shotX = shotMessage.x;
  const shotY = shotMessage.y;
  const shotZ = shotMessage.z;
  const velocity = { x: shotMessage.vx, y: shotMessage.vy, z: shotMessage.vz };
  const flight = getShotFlight(velocity, myShot, getShotSpeed(null))
    || { x: dirX, y: dirY, z: 0, speed: getShotSpeed(getMyShotFlag()) };
  if (!isObserver()) {
    sendToServer(shotMessage);
    rumble(myShot.fireSound);
  }
  // A beam's path is the server's to trace -- it is a polyline through whatever
  // it met, not something the client can extrapolate from a direction -- so the
  // shooter gets the muzzle flash and the report at once and the beam itself
  // when `shotBegin` lands. Everything else is predicted locally as before,
  // including a shock wave: it is a sphere that grows from a known point at a
  // known rate, so the shooter has no reason to wait a round trip to see it.
  if (myShot.beam) {
    const muzzle = { x: shotX, y: shotY, z: shotZ };
    renderManager.playSound(myShot.fireSound, muzzle);
    renderManager.createMuzzleFlash(muzzle, { x: dirX, y: dirY, z: 0 });
    return true;
  }

  createLocalProjectile({
    x: shotX, y: shotY, z: shotZ, dirX: flight.x, dirY: flight.y, dirZ: flight.z, speed: flight.speed,
  });
  return true;
}

// _tankRadius (global.cxx:155): 0.72 * tankLength, the bounding-circle radius
// used only for this proximity test -- everywhere else a tank is the
// rectangle collision.mjs already carries.
function teleporterProximityRadius() {
  return 0.72 * (2 * TANK.halfLength);
}

// Teleporter::getProximity (Teleporter.cxx:373): how close a point is to
// being swallowed by this portal, 0 (clear) to 1 (centred in the opening).
// SceneRenderer::renderDimming() turns the max of these across every
// teleporter into the yellow screen wash; Player::updateTranslucency turns
// the same number into a tank's own alpha fade.
function getTeleporterProximity(x, y, z, obs) {
  const halfW = obs.size[0];
  const border = obs.border;
  const activeHalfD = obs.size[1] - border;
  const activeH = obs.size[2] - border;
  const gate = 1.2 * teleporterProximityRadius();

  const local = getColliderLocalPoint(x, y, obs);
  if (!testOrigRectCircle(halfW, activeHalfD, local.x, local.y, gate)) return 0;

  const relZ = z - getObstacleBase(obs);
  if (relZ < -gate || relZ > activeH + gate) return 0;

  const absX = Math.abs(local.x);
  const absY = Math.abs(local.y);
  let t = 1.2 - absX / teleporterProximityRadius();

  if (absY > activeHalfD) {
    const f = (2 / Math.PI) * Math.atan2(absX, absY - activeHalfD);
    t *= f * f;
  } else if (relZ < 0) {
    const f = 1 + relZ / gate;
    if (f >= 0 && f <= 1) t *= f * f;
  } else if (relZ > activeH) {
    const f = 1 - (relZ - activeH) / gate;
    if (f >= 0 && f <= 1) t *= f * f;
  }

  return t > 0 ? Math.min(t, 1) : 0;
}

// World::getProximity (World.cxx:446): the maximum over every teleporter.
function getWorldTeleporterProximity(x, y, z) {
  let best = 0;
  for (const obs of TELEPORTER_OBSTACLES_BY_INDEX.values()) {
    const p = getTeleporterProximity(x, y, z, obs);
    if (p > best) best = p;
  }
  return best;
}

function isShotTeleportDebugEnabled() {
  try {
    return localStorage.getItem('debugShotTeleports') === '1';
  } catch {
    return false;
  }
}

// --- Flags -------------------------------------------------------------
//
// The server owns every flag; a flag event carries the whole flight, and the
// client integrates it locally from there. See docs/flags.md.

const flags = new Map();
// Which flag `checkNearFlag` last named or asked about, so Identify speaks once
// per flag rather than once per frame. Upstream's
// `GameKeeper::Player::lastIdFlag`, on the end that now asks the question.
let lastIdentifiedFlagIndex = null;
// checkEnvironment() sweeps for flags to grab no more than five times a second,
// and a capture is rate-limited the same way: the flag only leaves the tank when
// the server says so, and until then the condition stays true every frame.
let lastGrabRequestAt = 0;
let lastCaptureRequestAt = 0;
let lastShakeRequestAt = 0;
// Drop is an event, but every non-keyboard source reports a held button.
let dropWasHeld = false;
let identifyWasHeld = false;
let lastTeamMessageSoundAt = -Infinity;
let lastAdminMessageSoundAt = -Infinity;
let lastPrivateMessageSoundAt = -Infinity;
// LocalPlayer::flagShakingTime. The countdown belongs to one carried flag, so it
// is keyed on the slot as well as the seconds: taking a different sticky flag
// starts a fresh clock rather than inheriting what was left of the last one.
let shakeFlagIndex = null;
let shakeSecondsLeft = 0;
// LocalPlayer::flagAntidotePos and antidoteFlag. Where this client's antidote
// stands while it carries a bad flag, or null. The server picks the spot and
// decides when driving onto it counts; the client draws it and points at it.
let antidotePosition = null;
// The flag node pool is keyed by flag index, and the antidote is not a flag in
// the world, so it takes a key of its own and gets the cloth, the billboarding
// and the ripple for free -- which is what upstream's FlagSceneNode gives it.
const ANTIDOTE_FLAG_KEY = 'antidote';
// Shared so a frame with no team flag to point at allocates nothing.
const EMPTY_HEADING_MARKERS = Object.freeze([]);
let teamFlagMarkerStyle = '#ffffff';
// bzo tanks are 2 units tall. Upstream reads getDimensions()[2], which varies
// with Obesity and Tiny; bzo has neither yet.
const FLAG_CARRY_HEIGHT = 2;

function clearFlags() {
  flags.clear();
  lastIdentifiedFlagIndex = null;
  // clearFlags() disposes the antidote's node with every other flag's, so the
  // position it was drawn from has to go with it or the next frame recreates it.
  antidotePosition = null;
  renderManager.clearFlags();
  // The beacons stood over the flags that just went, and the next world's are
  // built from its own clouds.
  renderManager.clearSkyBeacons();
}

// One line of `/flag show`'s answer, applied to the slot it names. The rest of
// the record is whatever this client already had: the line is about identity,
// and where the flag is arrived in a flag update.
function applyFlagInfoLine(text) {
  const info = parseFlagInfo(text);
  if (!info) return;
  const flag = flags.get(info.index);
  if (!flag || flag.type === info.type) return;
  setFlagState({ ...flag, type: info.type });
}

function setFlagState(state) {
  const existing = flags.get(state.index);
  // Upstream advances flightTime locally and lets the server's copy seed it, so
  // a client that joins mid-flight picks the arc up where it already is.
  const flag = {
    index: state.index,
    // A superflag on the ground arrives without its type: bzfs hides the
    // identity of any superflag nobody is holding. What this client has already
    // learned about the slot lives in this same field and is kept across such an
    // update -- see `keepFlagIdentity` for when a record forgets.
    type: keepFlagIdentity(state.type, existing?.type, state.status),
    status: state.status,
    owner: state.owner,
    position: { ...state.position },
    launchPosition: { ...state.launchPosition },
    landingPosition: { ...state.landingPosition },
    flightTime: state.flightTime,
    flightEnd: state.flightEnd,
    initialVelocity: state.initialVelocity,
    // Phantom Zone's `PlayerState::FlagActive`. The server owns it, as it owns
    // everything else about a flag, because being zoned decides who can shoot
    // you. It arrives as the state it is rather than as a toggle, so the
    // client's own prediction of a crossing converges instead of doubling.
    zoned: state.zoned === true,
    // How the flag currently looks is carried over, so an update that arrives
    // part way through a fade does not pop it back to solid for one frame.
    warp: existing ? existing.warp : 0,
    alpha: existing ? existing.alpha : 1,
  };
  flags.set(state.index, flag);
  if (flag.status === FLAG_STATUS.NO_EXIST) renderManager.hideFlag(flag.index);
  return flag;
}

function getPlayerFlag(playerId) {
  for (const flag of flags.values()) {
    if (flag.owner === playerId) return flag;
  }
  return null;
}

function getMyFlag() {
  return getPlayerFlag(myPlayerId);
}

// The size the local tank is, from the flag it carries. The target, not the
// eased scale the model is drawn at: the server tests the target from the moment
// the flag changes hands, so anything the client collides with has to agree.
function getMyTankScale() {
  return getTankDimensionScale(getMyFlag()?.type ?? null);
}

// The three view flags, all read off the flag in the local tank's own
// hands. Nothing else in the game changes, which is why the server has no part
// in any of them.
function isViewBlinded() {
  return blanksTheView(getMyFlag()?.type ?? null);
}

function isRadarJammed() {
  return jamsTheRadar(getMyFlag()?.type ?? null);
}

function isColorblind() {
  return hidesTeamColors(getMyFlag()?.type ?? null);
}

// The viewer side of per-viewer visibility. `SE` is the only one of the four read off the local
// tank; the other three are read off whoever is being looked at.
function isSeer() {
  return seesThroughDisguises(getMyFlag()?.type ?? null);
}

function getPlayerFlagType(playerId) {
  return getPlayerFlag(playerId)?.type ?? null;
}

// Whether a remote tank appears on the radar at all. RadarRenderer.cxx:628 skips
// a stealthed tank's blip outright rather than dimming it, and Seer is the only
// thing that brings it back.
function isHiddenFromRadar(playerId) {
  if (playerId === myPlayerId || isSeer()) return false;
  return hidesFromRadar(getPlayerFlagType(playerId));
}

// A tank is built from its colour rather than tinted -- the body texture and the
// name label are both generated from it -- so a tank whose *effective* colour
// changes has to be rebuilt. Three flags can cause that and they do not share a
// trigger: `CB` and `SE` are mine to pick up, `MQ` is theirs, and a flag change
// arrives on a flag message rather than a player update. So rather than hooking
// three events, each tank's effective colour is compared against the one it was
// built from, once a frame. The compare is two property reads and a number test;
// only an actual change costs a rebuild.
function refreshTankDisguises() {
  for (const [playerId, tank] of [...tanks.entries()]) {
    if (playerId === myPlayerId) continue;
    const state = tank?.userData?.playerState;
    if (!state) continue;
    if (getEffectiveTankColor(playerId, state.color) !== tank.userData.builtColor
      || getTankCamoOptions(playerId).rogue !== tank.userData.builtRogue) {
      // This rebuild is for the colour alone. `state` is the last full
      // `playerUpdated` snapshot, which the server only sends on join, rename or
      // tank-model change -- not on movement, which travels over the frequent
      // `pm`/`pt` packets that update the tank's live position and velocities
      // directly (see the `pm`/`pt` handler above) without ever touching
      // `state`. Passing `state` straight to addPlayer would snap the tank back
      // to wherever it was as of that stale snapshot and reset the
      // extrapolation from there -- a "ghost" the server's own hit test
      // disagrees with (issue #103). Carry the tank's live motion state into
      // the rebuild instead.
      addPlayer({
        ...state,
        ...tankPoint(tank),
        azimuth: tankAzimuth(tank),
        forwardSpeed: tank.userData.forwardSpeed,
        rotationSpeed: tank.userData.rotationSpeed,
        verticalVelocity: tank.userData.verticalVelocity,
        jumpAzimuth: tank.userData.jumpAzimuth,
        slideAzimuth: tank.userData.slideAzimuth,
        airVelocityX: tank.userData.airVelocityX,
        airVelocityY: tank.userData.airVelocityY,
      });
    }
  }
}

// The colour a remote tank is drawn in, after every flag that has an opinion.
// playing.cxx:6171 settles the same argument in the same order, and the order is
// the whole of it:
//
//   1. Colourblindness first, and it wins outright. Upstream computes
//      `effectiveTeam = RogueTeam` and only consults Masquerade `if
//      (!colorblind)`, so a colourblind viewer cannot be fooled by a disguise --
//      there is nothing left to fool.
//   2. Masquerade next: the tank wears the *viewer's own* colour, so it reads as
//      friendly to that viewer and to nobody else. Defeated by Seer, and never
//      applied for an observer, who has no colour to be impersonated with.
//   3. Otherwise the tank's own colour.
//
// Upstream writes step 2 as `effectiveTeam = myTank->getTeam()`, which is the
// viewer's *own* colour there, because upstream's team mates all share one. bzo
// shades team mates apart inside a band around the team colour, which splits
// that into two readings, and the viewer's own colour is the right one:
//
//   - it is a colour that certainly exists on the viewer's team, where the
//     team's base colour is one no real team mate wears -- a masquerading tank
//     painted in it would be the only tank with the exact base shade, which is a
//     tell a regular would learn in a day;
//   - it needs no roster lookup and no choice of which team mate to copy, so it
//     cannot collide with a second masquerading tank or change from frame to
//     frame;
//   - and it is the colour a viewer most associates with "one of us", which is
//     the whole job.
//
// The cost is the mirror image: your own colour is unique in bzo, so a tank
// wearing it exactly is impossible otherwise. That is a subtler tell than the
// base shade and it is the one worth paying, since a player rarely has a precise
// sense of their own tank's shade -- they are inside it.
//
// Your own tank always keeps its colour: upstream only ever rewrites a remote
// player's, so you cannot see your own disguise. The rabbit is the exception at
// both ends -- see below -- because it is a team colour rather than a lie about
// one.
function getEffectiveTankColor(playerId, color) {
  // Colourblindness still wins outright, and it wins over the rabbit too:
  // upstream computes `effectiveTeam = RogueTeam` and draws the tank from that,
  // so a colourblind viewer cannot pick the rabbit out either. That is the whole
  // reason the radar ring below is suppressed for one as well.
  if (playerId !== myPlayerId && isColorblind()) return PLAYER_TEAM_COLORS[PLAYER_TEAM.ROGUE];
  // Team::getTankColor. The rabbit is the one tank in bzo that wears a team's
  // colour instead of its own -- see PLAYER_TEAM_COLORS in teams.mjs for why it
  // is the only one -- and it applies to your own tank as well, because being
  // the rabbit is not a disguise: upstream puts you on RabbitTeam and repaints
  // you along with everybody else (playing.cxx:2869).
  if (isRabbitTeam(getPlayerTeamById(playerId))) {
    return PLAYER_TEAM_COLORS[PLAYER_TEAM.RABBIT];
  }
  if (playerId === myPlayerId) return color;
  if (
    fakesTeamColor(getPlayerFlagType(playerId))
    && !isSeer()
    && !isObserver()
  ) {
    const mine = tanks.get(myPlayerId)?.userData?.playerState?.color;
    if (Number.isFinite(mine)) return mine;
  }
  return color;
}

// Upstream's `visualTeam` (Player.cxx:790): the team a tank is *drawn* as,
// which is not always the team it is on. Upstream needs it to choose which of
// its seven team textures to load; bzo needs it for the one thing its generated
// camo still varies by team, which is whether a tank is a rogue and so painted
// nearly black -- see ROGUE_CAMO_SATURATION in render.js.
//
// This is getEffectiveTankColor's twin and has to keep its branches, in the
// same order: every case there swaps a colour and a team together, so a tank
// drawn in the rabbit's grey has to be drawn with the rabbit's team as well. A
// masquerading rogue is the case that shows why -- it wears the viewer's own
// colour, so painting it as a rogue would black out a tank that is pretending
// to be a team mate and give the lie away.
function getEffectiveTankTeam(playerId) {
  if (playerId !== myPlayerId && isColorblind()) return PLAYER_TEAM.ROGUE;
  const team = getPlayerTeamById(playerId);
  if (isRabbitTeam(team)) return PLAYER_TEAM.RABBIT;
  if (playerId === myPlayerId) return team;
  if (
    fakesTeamColor(getPlayerFlagType(playerId))
    && !isSeer()
    && !isObserver()
  ) {
    const mine = getPlayerTeamById(myPlayerId);
    if (mine) return mine;
  }
  return team;
}

// The tank build options that follow from that team. An object per call, but
// only on a rebuild -- the once-a-frame compare below reads the boolean.
//
// Gated on there being colour teams at all, for the reason getPreviewTankColor
// gives above: the question is whether Rogue names a team, and on a world
// without colour teams it does not. Every player on such a server is nominally
// a rogue while wearing a colour picked from the whole wheel, because that
// colour is the only thing telling them apart -- painting the lot of them
// upstream's near-black would throw away the distinction bzo exists to draw.
// Rogue is only a team, and only worth drawing as one, where there are other
// teams for it not to be.
function getTankCamoOptions(playerId) {
  return {
    rogue: availablePlayerTeams.some(isColorTeam)
      && getEffectiveTankTeam(playerId) === PLAYER_TEAM.ROGUE,
  };
}

// ScoreboardRenderer::drawPlayerScore names a team flag after the callsign and a
// superflag by its abbreviation, both in the flag's own colour. bzo names the
// team flag by its colour alone, dropping the "Team" upstream spells out: the
// label is already drawn in that team's colour, so the word is redundant. A flag
// whose identity is still hidden cannot be on a tank, so there is nothing to
// fall back to.
// A carried flag as the scoreboards write it: what to call it, and what colour
// to say it in.
//
// A bad flag is named in the warning colour, which is the same red the alert
// wears when the flag is picked up (`hud->setAlert(2, flagName, 3.0f,
// endurance == FlagSticky)`, playing.cxx:1455). Upstream leaves the scoreboard's
// flag in the player's own colour and separates the bad ones onto a help page
// instead; bzo says it on the line, because a penalty someone is carrying is
// worth seeing at a glance and the roster is where it is read. The flag itself
// in the world keeps `FlagType::getColor`, which is white for every superflag.
function getPlayerFlagLabel(playerId) {
  const flag = getPlayerFlag(playerId);
  const type = getFlagType(flag?.type);
  if (!type) return null;
  return {
    label: type.team ? type.name.replace(/ Team$/, '') : type.abbreviation,
    color: getKnownFlagColor(flag),
  };
}

// The same label from an abbreviation rather than from a flag in the world, for
// a flag that has already left the tank by the time it is named -- which is
// every flag a kill notice mentions, since the server drops the victim's before
// it says anyone died. Naming it at all means its identity is known, so there is
// no hidden-flag case to answer here.
function getFlagLabelForAbbreviation(abbreviation) {
  const type = getFlagType(abbreviation);
  if (!type) return null;
  return {
    label: type.team ? type.name.replace(/ Team$/, '') : type.abbreviation,
    color: isBadFlag(abbreviation) ? BAD_FLAG_COLOR : getFlagColor(abbreviation),
  };
}

// What colour a flag is drawn in, from what this client has learned about it.
// A flag whose identity is still hidden is white, as every superflag is
// upstream; a flag known to be bad wears the bad-flag colour everywhere it
// appears, which is the point of bzo tracking identities at all.
function getKnownFlagColor(flag) {
  const abbreviation = flag?.type ?? null;
  if (!abbreviation) return SUPER_FLAG_COLOR;
  if (isBadFlag(abbreviation)) return BAD_FLAG_COLOR;
  return getFlagColor(abbreviation);
}

function describeFlag(flag) {
  const type = getFlagType(flag?.type);
  return type ? type.name : 'unidentified';
}

// The chat form: `ID/Identify`, pairing the abbreviation the scoreboard shows
// against a callsign with the name that says what the flag does. Upstream prints
// the name alone (`playing.cxx:2734`), and bzo's own kill notices print the
// abbreviation alone -- so a player reading both had no line that connected
// them. A grab is where that connection is worth three characters: it is the
// moment somebody learns which `/ID` is which flag, and it happens once per
// pickup rather than every frame like a HUD alert, which is why the alerts keep
// `describeFlag` and its shorter name.
//
// Team flags are name-only. Their abbreviations are `R*` through `P*`, which
// nothing displays anywhere -- the scoreboard shows "Red" -- so pairing one
// against "Red Team" would teach a string that never appears again.
function describeFlagForChat(flag) {
  const type = getFlagType(flag?.type);
  if (!type) return 'unidentified';
  if (type.team) return type.name;
  return `${type.abbreviation}/${type.name}`;
}

// The flag a notice is about, as a coloured part `noticeAbout` takes -- the same
// shape `describePlayer` returns, so one sentence can name both. The colour is
// the one the flag wears everywhere else, `getKnownFlagColor`, so a bad flag
// carries the same warning into the chat line that it wears on the scoreboard,
// on the radar and in the world.
function describeFlagForNotice(flag) {
  const text = describeFlagForChat(flag);
  return { text, segments: [{ text, color: colorToCSS(getKnownFlagColor(flag)) }] };
}

// A team named in a notice, in that team's own tank colour. The capture lines
// are about whose flag went into whose territory, and the colour is the fastest
// way to read which pair that was.
function describeTeamForNotice(colorIndex) {
  const team = getTeamFromColorIndex(colorIndex);
  if (!team) return { text: 'unknown', segments: null };
  return { text: team, segments: [{ text: team, color: colorToCSS(getPlayerTeamColor(team)) }] };
}

// HelpMenu's flag pages, built from the shared flag table rather than written
// out in index.html. The table is the list of flags bzo implements, so the help
// cannot document a flag the server will not hand out, or miss one it will.
//
// Team flags share a single help string upstream, so it is printed once for the
// group instead of four times. Each name is drawn in the flag's own colour, as
// the scoreboard draws it.
function buildFlagHelp() {
  const container = document.getElementById('helpFlags');
  if (!container) return;
  container.replaceChildren();

  const abbreviations = Object.keys(FLAG_TYPES);
  // Team flags keep BZFlag's own team order -- red, green, blue, purple -- which
  // is the numbering every other part of the game counts in. The superflags have
  // no such order to keep: upstream walks a `std::set<FlagType*>`, so its own
  // help is in pointer order, and bzo's table was in whatever order the phases
  // landed. Sorted by abbreviation, because the abbreviation is the column the
  // list leads with and what the code, the config and the scoreboard all use.
  const byAbbreviation = (a, b) => a.localeCompare(b);
  const teamAbbreviations = abbreviations.filter((abbreviation) => isTeamFlag(abbreviation));
  const superAbbreviations = abbreviations.filter(
    (abbreviation) => !isTeamFlag(abbreviation) && !isBadFlag(abbreviation),
  ).sort(byAbbreviation);
  const badAbbreviations = abbreviations
    .filter((abbreviation) => isBadFlag(abbreviation))
    .sort(byAbbreviation);

  const addSection = (title, listAbbreviations, sharedHelp) => {
    if (listAbbreviations.length === 0) return;
    const heading = document.createElement('h3');
    heading.textContent = title;
    container.appendChild(heading);

    if (sharedHelp) {
      const shared = document.createElement('p');
      shared.textContent = sharedHelp;
      container.appendChild(shared);
    }

    const list = document.createElement('ul');
    listAbbreviations.forEach((abbreviation) => {
      const type = FLAG_TYPES[abbreviation];
      const item = document.createElement('li');
      const code = document.createElement('strong');
      code.textContent = abbreviation;
      const name = document.createElement('b');
      name.textContent = type.name;
      // The colour a flag is drawn in everywhere else it appears, which for a
      // bad one is the warning it wears in the world and on the scoreboards.
      name.style.color = colorToCSS(
        isBadFlag(abbreviation) ? BAD_FLAG_COLOR : getFlagColor(abbreviation),
      );
      item.append(code, ' — ', name);
      if (!sharedHelp) item.append(` — ${type.help}`);
      list.appendChild(item);
    });
    container.appendChild(list);
  };

  // HelpMenu splits these across two pages, Good Flags then Bad Flags
  // (HelpMenu.cxx:416, :453). bzo's help is one scrolling panel rather than
  // pages, so the split is a heading and the bad flags go last: the thing you
  // are looking one up to avoid should not be mixed in among the ones you want.
  addSection('Team Flags', teamAbbreviations, FLAG_TYPES[teamAbbreviations[0]]?.help);
  addSection('Good Flags', superAbbreviations, null);
  addSection('Bad Flags', badAbbreviations, null);
  updateRicochetHelp();
}

// What the world's own ricochet rule is, said where the flag that grants it is
// documented. bzfs forbids `R` outright once every shot already bounces, so on
// such a server the help would otherwise still promise a flag nobody can find.
function updateRicochetHelp() {
  const note = document.getElementById('helpRicochet');
  if (!note) return;
  note.textContent = gameConfig?.ALL_SHOTS_RICOCHET
    ? 'This server bounces every shot off walls, whatever flag fired it,'
      + ' so the Ricochet flag is not in play here.'
    : 'On this server only the Ricochet flag bounces shots off walls.';
}

// FlagType::getColor. Team flags take their team's colour and every superflag is
// white, which is what makes hiding a superflag's identity cost nothing.
function getFlagColor(abbreviation) {
  const teamIndex = getFlagTeamIndex(abbreviation);
  if (teamIndex === null) return SUPER_FLAG_COLOR;
  return getPlayerTeamColor(getTeamFromColorIndex(teamIndex));
}

// FlagType::getRadarColor, which is the same distinction against the radar's own
// team colours: those are lifted so a team reads on a dark panel.
function getFlagRadarColor(abbreviation) {
  const teamIndex = getFlagTeamIndex(abbreviation);
  if (teamIndex === null) return SUPER_FLAG_COLOR;
  return getPlayerTeamRadarColor(getTeamFromColorIndex(teamIndex));
}

function getMyTeamColorIndex() {
  return getTeamColorIndex(playerTeam);
}

// The colour the radar draws a flag in, which is the answer `getKnownFlagColor`
// gives the world put against the radar's own team colours -- so a flag cannot
// be one colour in front of the tank and another on the panel.
//
// A flag whose identity this client has not learned is white, as every
// superflag is upstream. A team flag's colour is lifted for the dark panel,
// which is upstream's own split between `getColor` and `getRadarColor`. A bad
// flag keeps the single orange it wears everywhere else: that colour is bzo's
// warning rather than a team's identity, and there is nothing to lift it away
// from -- it was picked precisely because no team wears it.
function getKnownFlagRadarColor(flag) {
  const abbreviation = flag?.type ?? null;
  if (!abbreviation) return SUPER_FLAG_COLOR;
  if (isBadFlag(abbreviation)) return BAD_FLAG_COLOR;
  return getFlagRadarColor(abbreviation);
}

// colorToCSS builds a string, and the radar asks for the same handful of flag
// colours on every frame, so each one is resolved once and reused.
const flagRadarStyles = new Map();

// The sought flags found by the frame's walk of the flag table, held back so
// they draw after the batched crosses. Reused rather than rebuilt: a world may
// hold two hundred flags and this runs every frame on a client with one core to
// spend, so the walk that finds them is the one the panel already makes.
const radarSoughtFlags = [];

function getFlagRadarStyle(flag) {
  const color = getKnownFlagRadarColor(flag);
  let style = flagRadarStyles.get(color);
  if (!style) {
    style = colorToCSS(color);
    flagRadarStyles.set(color, style);
  }
  return style;
}

function requestFlagDrop() {
  const flag = getMyFlag();
  if (!flag) return false;
  // A sticky flag does not answer the drop control at all: only the shake
  // countdown or a kill gets rid of it. Saying so beats sending a request the
  // server will refuse, and beats a control that silently does nothing.
  if (getFlagEndurance(flag.type) === FLAG_ENDURANCE.STICKY) {
    showMessage(`${describeFlag(flag)} ${describeBadFlagRelease()}`);
    return false;
  }
  // cmdDrop's last condition (clientCommands.cxx:355). A flag dropped inside a
  // building would be inside it too, where nothing could reach it, so the drop
  // waits until the tank is out. Upstream ignores the key; bzo says why, as it
  // does for a sticky flag.
  // cmdDrop's other condition on the same line: `!myTank->isPhantomZoned()`. A
  // zoned tank cannot put the flag down at all, wherever it is standing --
  // dropping it would strand the tank phased with no way back.
  if (amZoned()) {
    showMessage('Can\'t drop the flag while zoned');
    return false;
  }
  if (amInsideBuilding()) {
    showMessage('Can\'t drop a flag while inside a building');
    return false;
  }
  sendToServer({ type: 'dropFlag' });
  return true;
}

// LocalPlayer::doUpdate's shake timeout, upstream's -st. The client owns the
// countdown and asks the server to take the flag when it runs out; the server
// runs the same clock against its own record of the grab, so a request that
// arrives before that clock agrees is refused and simply asked again -- which
// is why this does not latch at zero the way upstream's does. Upstream has no
// refusal to recover from.
function updateFlagShake(deltaTime) {
  const timeout = normalizeShakeTimeout(gameConfig?.FLAG_SHAKE_TIMEOUT);
  const flag = getMyFlag();
  if (!flag || timeout === 0 || getFlagEndurance(flag.type) !== FLAG_ENDURANCE.STICKY) {
    shakeFlagIndex = null;
    shakeSecondsLeft = 0;
    return;
  }
  if (flag.index !== shakeFlagIndex) {
    shakeFlagIndex = flag.index;
    shakeSecondsLeft = timeout;
  }
  shakeSecondsLeft = Math.max(0, shakeSecondsLeft - deltaTime);
  // HUDRenderer.cxx:998 draws the time left to a tenth while a bad flag is in
  // hand. It is re-set each frame with barely more than a frame to live, so the
  // slot clears itself the moment the flag is gone or the loop stops.
  setHudAlert(
    FLAG_SHAKE_ALERT_SLOT,
    `${describeFlag(flag)} ${shakeSecondsLeft.toFixed(1)}`,
    Math.max(0.25, deltaTime * 4),
    true
  );
  if (shakeSecondsLeft > 0) return;

  const now = performance.now();
  if (now - lastShakeRequestAt < FLAG_GRAB_INTERVAL_MS) return;
  lastShakeRequestAt = now;
  sendToServer({ type: 'dropFlag' });
}

// The ways this world lets a bad flag go, for the message a player gets when
// they take one. With none of them on, dying is the only way out, which is what
// upstream's defaults leave you with.
function describeBadFlagRelease() {
  const ways = [];
  const timeout = normalizeShakeTimeout(gameConfig?.FLAG_SHAKE_TIMEOUT);
  const wins = normalizeShakeWins(gameConfig?.FLAG_SHAKE_WINS);
  if (timeout > 0) ways.push(`in ${timeout}s`);
  if (wins > 0) ways.push(`after ${wins} ${wins === 1 ? 'kill' : 'kills'}`);
  if (gameConfig?.ANTIDOTE_FLAGS === true) ways.push('on the antidote');
  return ways.length > 0 ? `shakes off ${ways.join(' or ')}` : 'stays until it kills you';
}

// The antidote flag's position, sent to its owner alone the way `nearFlag` is,
// and null when the bad flag it belongs to is gone. Upstream's client picks the
// spot itself; bzo's server picks it so that driving onto it is a server-side
// decision rather than a drop request the server would have to take on trust.
function handleAntidoteFlag(message) {
  const position = message.position;
  antidotePosition = position && Number.isFinite(position.x) && Number.isFinite(position.y)
    ? { x: position.x, y: position.y, z: Number.isFinite(position.z) ? position.z : 0 }
    : null;
  if (!antidotePosition) renderManager.hideFlag(ANTIDOTE_FLAG_KEY);
}

// A yellow flag standing where the antidote is (LocalPlayer.cxx:1695). It rides
// the ordinary flag node pool under a key of its own, so it ripples and turns to
// face the camera like every other flag without a second code path.
function updateAntidoteFlag() {
  if (!antidotePosition) return;
  renderManager.showFlag(ANTIDOTE_FLAG_KEY, {
    ...antidotePosition,
    color: ANTIDOTE_FLAG_COLOR,
  });
}

// MsgGrabFlag on the client. Taking a flag is a local sound for whoever took it,
// and for everyone else it matters only when a team flag changed hands. A theft
// comes through here too: the same flag is in the same hands by the end of it.
function handleFlagGrabbedAlerts(grabberId, flag) {
  if (grabberId === myPlayerId) {
    renderManager.playLocalSound('flagGrab');
    // What was taken is already on the chat line every player gets and on the
    // alert slot below, so the only thing said here is the part no other
    // player's line carries: a bad flag is the one grab where what happens
    // next matters more than what was taken, so it says how this world lets
    // you put it down.
    const sticky = getFlagEndurance(flag?.type) === FLAG_ENDURANCE.STICKY;
    if (sticky) showMessage(describeBadFlagRelease());
    // The flag you are carrying, in the warning colour when it is one you cannot
    // put down. A sticky flag with a shake timeout running takes the slot over
    // from here for its countdown, so this is what it looks like for the moment
    // before the first tick.
    setHudAlert(FLAG_SHAKE_ALERT_SLOT, describeFlag(flag), CARRIED_FLAG_ALERT_SECONDS, sticky);
    return;
  }

  const flagTeamIndex = getFlagTeamIndex(flag.type);
  if (flagTeamIndex === null) return;
  const myTeamIndex = getMyTeamColorIndex();
  if (myTeamIndex === null) return;

  const grabber = tanks.get(grabberId);
  const grabberTeamIndex = getTeamColorIndex(grabber?.userData?.playerState?.team);

  if (grabberTeamIndex !== myTeamIndex && flagTeamIndex === myTeamIndex) {
    showMessage('Flag Alert!!!', 'death');
    renderManager.playLocalSound('flagAlert');
    return;
  }

  // A team mate carrying off somebody else's flag. The one flag sound BZFlag
  // plays out in the world rather than in the ear.
  if (grabberTeamIndex === myTeamIndex && flagTeamIndex !== grabberTeamIndex) {
    showMessage('Team Grab!!!');
    if (grabber) renderManager.playSound('teamGrab', grabber.position);
  }
}

// MsgTransferFlag on the client (handleFlagTransferred, playing.cxx:3846). The
// flag changes tanks with no grab and no drop between, so this is what moves it
// on the scoreboard, in the world and on the thief's own HUD.
//
// A theft is the one way of losing a flag that sends the victim no drop at all,
// so the notice below is what says the flag is gone -- and it names the victim,
// so the victim needs no second line of their own.
function handleFlagTransferred(message) {
  const flag = setFlagState(message.flag);
  noticeAbout(
    null,
    [
      describePlayer(message.toId, { flag: null }),
      ' stole ',
      describePlayer(message.fromId, { flag: null }),
      "'s ",
      describeFlagForNotice(flag),
      ' flag',
    ],
    0,
    false,
  );
  if (message.fromId === myPlayerId) renderManager.playLocalSound('flagDrop');
  handleFlagGrabbedAlerts(message.toId, flag);
}

// MsgNearFlag on the client. The Identify flag's answer: the name of the
// nearest flag on the ground, on the HUD and in the chat log.
//
// Upstream guards this on still carrying `ID`, because the message can arrive a
// lag period after the flag is gone (playing.cxx:2029), and so does bzo.
function handleNearFlag(message) {
  if (getMyFlag()?.type !== 'ID') return;
  const type = getFlagType(message.flagType);
  if (!type) return;
  // The answer goes into the flag record, which is where every other surface
  // reads an identity from: the label over the flag, the radar cross, the
  // scoreboard. Identify is one of the two ways a record learns one.
  const flag = flags.get(message.index);
  if (flag) flag.type = message.flagType;
  lastIdentifiedFlagIndex = message.index;
  announceNearFlag(type);
}

function announceNearFlag(type) {
  const notice = `Closest Flag: ${type.name}`;
  setHudAlert(1, notice, NEAR_FLAG_ALERT_SECONDS, false);
  showMessage(notice);
}

// searchFlag() on this end. Upstream's server sweeps for every player on every
// position update and pushes the answer; here the client sweeps for itself and
// speaks when the nearest flag changes.
//
// It asks the server only about a flag it cannot name. A record keeps what it
// has learned, so driving back along a row of flags costs nothing after the
// first pass -- and the identity cannot have gone stale underneath it, because
// the only things that change a slot's identity are exactly the states that make
// the record forget it.
//
// `lastIdentifiedFlagIndex` moves whether the flag was named or asked about, so
// a flag still unknown is asked about once rather than once a frame. The answer
// arrives as a `nearFlag`, which names it and moves the mark again.
function checkNearFlag() {
  if (getMyFlag()?.type !== 'ID' || !myTank) {
    // Upstream clears its own `lastIdFlag` when the flag goes, so re-taking
    // Identify beside the same flag answers again instead of staying silent.
    lastIdentifiedFlagIndex = null;
    return;
  }
  const closest = findNearestGroundFlag(flags.values(), myX, myY, myZ, getFlagTuning().identifyRange);
  if (!closest) {
    lastIdentifiedFlagIndex = null;
    return;
  }
  if (closest.index === lastIdentifiedFlagIndex) return;
  lastIdentifiedFlagIndex = closest.index;

  const type = getFlagType(closest.type);
  if (type) {
    announceNearFlag(type);
    return;
  }
  // The server sweeps again on its own copy of this tank's position rather than
  // trusting the index, so the request carries nothing to check.
  sendToServer({ type: 'nearFlag' });
}

// MsgCaptureFlag on the client. The server sends a killed for each tank on
// the losing team, so the explosions come through the usual death path.
// The message says who capped, which flag slot, and whose territory it went
// into -- `MsgCaptureFlag`'s own three fields. Which team *lost* the flag is
// read off the flag itself, as upstream reads it (`playing.cxx:2767`): a team
// flag keeps its type through the reset that sent it home, so the slot still
// answers for it.
function handleFlagCaptured(message) {
  const capturer = tanks.get(message.playerId);
  const capturerTeamIndex = message.playerId === myPlayerId
    ? getMyTeamColorIndex()
    : getTeamColorIndex(capturer?.userData?.playerState?.team);
  const myTeamIndex = getMyTeamColorIndex();
  const capturedTeamIndex = getFlagTeamIndex(flags.get(message.index)?.type);
  const ownGoal = capturedTeamIndex !== null && capturerTeamIndex === capturedTeamIndex;

  if (ownGoal) {
    noticeAbout(
      null,
      [describePlayer(message.playerId, { flag: null }), ' took their own flag into ',
        describeTeamForNotice(message.team), ' territory'],
      0,
      false,
    );
    if (message.playerId === myPlayerId) {
      showMessage("Don't capture your own flag!!!", 'death');
      renderManager.playLocalSound('killTeam');
    }
  } else {
    noticeAbout(
      null,
      [describePlayer(message.playerId, { flag: null }), ' captured the ',
        describeTeamForNotice(capturedTeamIndex), ' flag'],
      0,
      false,
    );
  }

  // My team lost its flag, or my team is the one that took somebody else's.
  if (capturedTeamIndex === myTeamIndex) {
    renderManager.playLocalSound('flagLost');
  } else if (capturerTeamIndex === myTeamIndex) {
    renderManager.playLocalSound('flagWon');
  }
}

// A flag of the player's own team that they are not the one carrying. Upstream
// asks this of the heading tape alone; bzo's radar rings the same flags, so both
// ask here and the tape and the panel cannot end up marking different ones. An
// enemy carrying it off is exactly when the bearing matters most, so a flag on a
// tank still counts -- `updateFlags` parks a carried flag on top of its carrier,
// which puts the mark on the tank that has it.
function isSoughtTeamFlag(flag, myTeamIndex) {
  if (myTeamIndex === null) return false;
  if (getFlagTeamIndex(flag.type) !== myTeamIndex) return false;
  if (flag.status === FLAG_STATUS.NO_EXIST) return false;
  return flag.owner !== myPlayerId;
}

// prepareTheHUD() (playing.cxx:6820). One marker per flag of my own team, unless
// I am the one carrying it -- an enemy carrying it off is exactly when knowing
// which way it went matters most -- and then the antidote, which upstream adds
// straight after them in yellow (playing.cxx:6847). The team marker takes the
// team's tank colour, not its radar colour, because the heading tape is not the
// radar.
//
// bzo's rotation faces -Z at 0 and turns toward -X, so a direction (dx, dz) is
// the rotation atan2(-dx, -dz). The tape reads the same units.
function getFlagHeadingMarkers() {
  if (!myTank) return EMPTY_HEADING_MARKERS;
  const markers = [];
  const azimuthTo = (position) => Math.atan2(position.y - myY, position.x - myX);

  const myTeamIndex = getMyTeamColorIndex();
  if (myTeamIndex !== null) {
    flags.forEach((flag) => {
      if (!isSoughtTeamFlag(flag, myTeamIndex)) return;
      markers.push({ azimuth: azimuthTo(flag.position), color: teamFlagMarkerStyle });
    });
  }

  if (antidotePosition) {
    markers.push({
      azimuth: azimuthTo(antidotePosition),
      color: ANTIDOTE_FLAG_STYLE,
    });
  }

  // The locked tank gets a marker of its own, in the colour it is drawn in.
  // Upstream has no such marker -- it clamps the lock-on bracket to the edge of
  // the window instead -- but bzo's bracket stands in the world, so a target off
  // the side of the screen would have nothing at all saying where it went.
  const locked = getLockTargetTank(myPlayerId);
  if (locked) {
    markers.push({
      azimuth: azimuthTo(tankPoint(locked)),
      color: colorToCSS(getLockTargetColor(locked)),
    });
  }
  return markers.length > 0 ? markers : EMPTY_HEADING_MARKERS;
}

// Clear of the thing it points at: a flag's pole is 1.6 tall and a tank 2.05,
// so one height puts the tip just over either without touching it.
const SKY_BEACON_CLEARANCE = 3;
// Refilled in place every frame. A beacon is drawn in whatever colour identifies
// the thing it stands over: the team's colour for a team flag, the antidote's
// yellow, and a hunted tank's own colour -- see `getHuntBeaconColor` for why
// that one departs from the cyan its radar ring wears.
const skyBeaconTargets = [];

// A beacon over a hunted tank is drawn in that tank's own colour, where its
// radar ring is hunt cyan. The two disagree on purpose: the ring is a mark laid
// *on* a blip already painted in the player's colour, so it has to be a colour
// that is not theirs or it disappears into the blip -- at radius 9 over a blip
// spanning six either side it sits right on the arrow. A beacon stands alone
// against the sky with nothing inside it, so its colour is the only thing that
// can say *who*, which matters the moment `7` has marked more than one tank.
//
// The rabbit is the exception, and keeps the cyan. Its own colour is the
// reserved rabbit grey, which reads badly against a bright sky, and it is the
// one target the world chose rather than this player -- everybody is hunting it
// and everybody's beacon over it should say the same thing. That is the same
// line the scoreboard already draws between `(rabbit)`, a fact about the world,
// and the bullseye, a mark this viewer put there.
//
// `getEffectiveTankColor` rather than the raw colour, so a Masquerading tank's
// beacon agrees with the tank underneath it.
function getHuntBeaconColor(playerId, state) {
  if (isTheRabbit(playerId)) return HUNT_MARKER_COLOR;
  return getEffectiveTankColor(playerId, state?.color ?? HUNT_MARKER_COLOR);
}

function addSkyBeaconTarget(count, position, color) {
  const target = skyBeaconTargets[count] || (skyBeaconTargets[count] = { x: 0, y: 0, z: 0, color: 0 });
  target.x = position.x;
  target.y = position.y;
  target.z = position.z + SKY_BEACON_CLEARANCE;
  target.color = color;
  return count + 1;
}

// Everything the radar rings stands under a wedge in the sky as well: the
// player's own team flags, the antidote, and every hunted tank. The radar says
// where on the map; the beacon says which way to drive, which is the half a
// headset has no heading tape to give and a flat client has to look away from
// the world to work out.
//
// A hunted tank drops out of the sky under exactly the conditions that take its
// blip off the panel -- dead, hidden, or wearing Stealth -- because the beacon
// is the ring's other half and a flag that denies one has to deny both.
function updateSkyBeacons() {
  let count = 0;

  const myTeamIndex = getMyTeamColorIndex();
  if (myTeamIndex !== null) {
    flags.forEach((flag) => {
      if (!isSoughtTeamFlag(flag, myTeamIndex)) return;
      count = addSkyBeaconTarget(count, flag.position, getFlagColor(flag.type));
    });
  }

  if (antidotePosition) {
    count = addSkyBeaconTarget(count, antidotePosition, ANTIDOTE_FLAG_COLOR);
  }

  // One beacon per hunted tank. In Rabbit Chase that is the one the rabbit used
  // to get; off it, it is however many the player marked, which they chose one
  // at a time and can clear with a single `U`.
  if (huntState.hasHunted()) {
    tanks.forEach((tank, playerId) => {
      if (!isHuntMarked(playerId) || !tank?.position || tank.visible === false) return;
      const state = tank.userData?.playerState;
      if (state && (!state.alive || isHiddenFromRadar(playerId))) return;
      count = addSkyBeaconTarget(count, tankPoint(tank), getHuntBeaconColor(playerId, state));
    });
  }

  renderManager.showSkyBeacons(skyBeaconTargets, count);
}

// checkEnvironment(). Carrying a team flag onto a base is a capture: either an
// enemy's flag brought home, or your own carried onto an enemy base. The server
// decides what it costs; the client only reports arriving.
function checkFlagCapture() {
  const flag = getMyFlag();
  if (!flag) return;
  const flagTeamIndex = getFlagTeamIndex(flag.type);
  if (flagTeamIndex === null) return;

  const baseTeamIndex = getBaseTeamAtPoint(OBSTACLES, myX, myY, myZ);
  if (baseTeamIndex === null) return;

  const myTeamIndex = getMyTeamColorIndex();
  const ownFlagOnEnemyBase = flagTeamIndex === myTeamIndex && baseTeamIndex !== myTeamIndex;
  const enemyFlagOnMyBase = flagTeamIndex !== myTeamIndex && baseTeamIndex === myTeamIndex;
  if (!ownFlagOnEnemyBase && !enemyFlagOnMyBase) return;
  // `_disallowSelfCap`: the server would refuse it.
  if (ownFlagOnEnemyBase && gameConfig?.DISALLOW_SELF_CAP === true) return;

  const now = performance.now();
  if (now - lastCaptureRequestAt < FLAG_GRAB_INTERVAL_MS) return;
  lastCaptureRequestAt = now;
  sendToServer({ type: 'captureFlag', team: baseTeamIndex });
}

// checkEnvironment(). Grab anything the tank is driving over, on the same level
// and within a tank plus a flag radius, and let the server confirm it.
function checkFlagGrab() {
  if (!myTank || isObserver()) return;
  if (!gameplayJoinConfirmed) return;
  if (!myTank.userData?.playerState?.alive) return;
  checkFlagCapture();
  if (getMyFlag()) return;
  // Upstream only grabs from the ground or a building, never mid-jump.
  if (jumpAzimuth !== null) return;

  const now = performance.now();
  if (now - lastGrabRequestAt < FLAG_GRAB_INTERVAL_MS) return;

  const reachSquared = getFlagGrabRadius() * getFlagGrabRadius();
  flags.forEach((flag) => {
    if (flag.status !== FLAG_STATUS.ON_GROUND) return;
    if (Math.abs(myZ - flag.position.z) >= FLAG_GRAB_LEVEL_TOLERANCE) return;
    const dx = myX - flag.position.x;
    const dy = myY - flag.position.y;
    if ((dx * dx) + (dy * dy) >= reachSquared) return;
    sendToServer({ type: 'grabFlag', index: flag.index });
    lastGrabRequestAt = now;
  });
}

// World::updateFlag plus updateFlags(): advance each flight, park carried flags
// on top of their tanks, and hand the result to the renderer.
function updateFlags(deltaTime) {
  // The live match's flags do not belong in a Map Viewer's world (issue #68);
  // setMapViewerPreviewActive already hid whatever was on screen when the
  // preview started, so there is nothing left to keep updating.
  if (isPreviewingAltWorld()) return;
  if (flags.size === 0 && !antidotePosition) return;
  const gravity = Number.isFinite(gameConfig?.GRAVITY) ? gameConfig.GRAVITY : 9.8;

  flags.forEach((flag) => {
    if (flag.status === FLAG_STATUS.NO_EXIST) return;

    if (flag.status === FLAG_STATUS.ON_TANK) {
      const carrier = tanks.get(flag.owner);
      // A carrier whose tank is gone or dead carries nothing visible; the
      // server's drop is already on its way.
      if (!carrier || !carrier.visible) {
        renderManager.hideFlag(flag.index);
        return;
      }
      const at = tankPoint(carrier);
      flag.position = { x: at.x, y: at.y, z: at.z + FLAG_CARRY_HEIGHT };
      flag.alpha = 1;
      flag.warp = 0;
    } else if (
      flag.status === FLAG_STATUS.IN_AIR
      || flag.status === FLAG_STATUS.COMING
      || flag.status === FLAG_STATUS.GOING
    ) {
      flag.flightTime += deltaTime;
      const state = getFlagFlightState(flag, flag.flightTime, gravity);
      flag.position = { x: state.x, y: state.y, z: state.z };
      flag.alpha = state.alpha;
      flag.warp = state.warp;
      if (state.landed) {
        // Touchdown is local, exactly as upstream's is: the server reached the
        // same conclusion from the same numbers and does not need to say so.
        flag.status = flag.status === FLAG_STATUS.GOING
          ? FLAG_STATUS.NO_EXIST
          : FLAG_STATUS.ON_GROUND;
        flag.flightTime = 0;
        if (flag.status === FLAG_STATUS.NO_EXIST) {
          renderManager.hideFlag(flag.index);
          return;
        }
      }
    } else {
      // Sitting on the ground: nothing to advance, as upstream's default case
      // does nothing either.
      flag.alpha = 1;
      flag.warp = 0;
    }

    renderManager.showFlag(flag.index, {
      ...flag.position,
      color: getKnownFlagColor(flag),
      alpha: flag.alpha,
      warp: flag.warp,
      label: flag.type,
    });
  });

  updateAntidoteFlag();
}

// --- Reporting the local tank's own death ---------------------------------
//
// `checkEnvironment`'s death chain (playing.cxx:4160-4226) and `gotBlowedUp`
// (:3874). bzo's server decides every death in its own game and tells the
// client, which is the opposite of upstream: bzfs takes the victim's word for
// it and never asks. So on a connection the client traces shots for, a tank
// nobody reports dead is alive forever -- shot at, driven through water and
// parked on death pads, with nothing happening.
//
// Only such a connection runs any of this. On bzo's own server these checks
// would be a second opinion about a death the server already owns, and the two
// would eventually disagree.

// One report per life. Upstream's guard is `!tank->isAlive()`, which it can use
// because it blows the tank up on the spot; bzo waits for the death to come
// back round so a proxied death and a local one are drawn by the same handler,
// and needs a flag of its own to cover the round trip.
let reportedOwnDeath = false;

// `lookupServer(tank)->sendKilled(killer, reason, shotId, flagType, phydrv)`
// (playing.cxx:3963). The two messages upstream sends first -- ending the shot
// and dropping the flag -- are the proxy's to send, in its order, because they
// are bzfs messages rather than anything bzo's own server would want.
function sendOwnDeath(report) {
  sendToServer({ type: 'killed', ...report });
}

// Whether the local tank is something a death can happen to at all: upstream's
// `tank->getTeam() == ObserverTeam || !tank->isAlive()` (playing.cxx:3879).
function ownTankCanDie() {
  if (!clientTracesShots || reportedOwnDeath) return false;
  if (!myTank || !isMyTankAlive()) return false;
  const team = myTank.userData?.playerState?.team;
  return Boolean(team) && !isObserverTeam(team);
}

// The shot half of the chain, asked of one shot over the piece of its path this
// simulation step covered. Upstream asks it of every shot every frame
// (`LocalPlayer::checkHit`) and takes the nearest; here each shot asks for
// itself as it is stepped, which reaches the same answer because a step this
// short cannot hold two of them.
//
// Thief is the one hit that is not a death -- upstream transfers the flag and
// leaves the tank standing (`playing.cxx:4174-4180`). bzo's proxy sends no
// `MsgTransferFlag`, so a thief's beam is left to the target, which already
// decides thefts for every other client watching this one.
// `bounces` is passed rather than read off the projectile because a beam has no
// running count: its whole path arrives at once, and how many times it has
// bounced is simply which segment is being asked about.
function checkOwnShotHit(shotId, projectile, from, to, bounces = null) {
  if (!ownTankCanDie()) return false;
  const state = myTank.userData.playerState;
  const myFlag = getMyFlag();
  const shotFlag = projectile.userData.flag ?? null;
  const effects = getShotEffects(shotFlag);
  if (effects.steals) return false;
  const hit = getShotTankHit(
    {
      playerId: projectile.userData.playerId,
      flag: shotFlag,
      steals: false,
      bounces: Number.isFinite(bounces)
        ? bounces
        : (Number.isFinite(projectile.userData.bounces) ? projectile.userData.bounces : 0),
      team: getPlayerTeamById(projectile.userData.playerId),
    },
    from,
    to,
    {
      id: myPlayerId,
      team: state.team,
      // Upstream asks `isAlive() && !isPaused()` of the local tank before it
      // checks anything (`LocalPlayer::checkHit`); `ownTankCanDie` has the
      // first half and this is the second.
      paused: pauseState.paused,
      alive: true,
      position: { ...tankPoint(myTank), azimuth: tankAzimuth(myTank) },
      flagType: myFlag?.type ?? null,
      zoned: amZoned(),
    },
    {
      noTeamKills: gameConfig?.NO_TEAM_KILLS === true,
      teamsAllowed: gameConfig?.TEAMS_ALLOWED !== false,
      shotRadius: Number.isFinite(gameConfig?.SHOT_RADIUS) ? gameConfig.SHOT_RADIUS : 0.5,
    },
  );
  if (!hit) return false;

  // "don't die if we had the shield flag and we've been shot" (`gotBlowedUp`,
  // playing.cxx:3918). The flag still goes and the shot still ends -- both are
  // before that test upstream -- so a shielded hit is reported as a hit that
  // costs a flag rather than a life, and the tank plays on.
  const shielded = myFlag?.type === 'SH';
  if (!shielded) reportedOwnDeath = true;
  sendOwnDeath({
    reason: shielded ? 'shielded' : 'shot',
    killerId: projectile.userData.playerId ?? null,
    // The id the proxy itself built for this shot (`proxyShot`), handed back
    // whole so the one place that knows its shape is the place that made it.
    shotId,
    flag: shotFlag,
    // `if (hit->isStoppedByHit()) serverLink->sendEndShot(...)`
    // (playing.cxx:4168). `ShotStrategy::isStoppedByHit` is true by default
    // and overridden to false by exactly three strategies -- Laser, Thief and
    // ShockWave -- which are exactly the three `getShotEffects` already
    // describes as a beam, a theft and a wave. So the rule needs no table of
    // its own, only the one bzo already has.
    stoppedByHit: !(effects.beam || effects.shockwave || effects.steals),
  });
  return true;
}

// `GuidedMissileStrategy::sendUpdate` (GuidedMissleStrategy.cxx:406): the
// missile tells the server who it is chasing, and only when that changes --
// "only send an update when needed". Everyone else steers their own copy at
// whoever it last named, so a packet a frame would repeat itself.
//
// Only for missiles this client owns, and only where it owns them: on bzo's own
// server the lock is the server's and it broadcasts one for every shooter.
function announceOwnGuidedTarget(shotId, projectile, target) {
  if (!clientTracesShots) return;
  if (projectile.userData.playerId !== myPlayerId) return;
  if (projectile.userData.pendingServerAck) return;
  const targetId = target ? target.userData?.playerState?.id ?? null : null;
  if (projectile.userData.sentGuidedTarget === targetId) return;
  projectile.userData.sentGuidedTarget = targetId;
  const speed = Number.isFinite(projectile.userData.speed)
    ? projectile.userData.speed
    : (Number.isFinite(gameConfig?.SHOT_SPEED) ? gameConfig.SHOT_SPEED : 100);
  sendToServer({
    type: 'lockTarget',
    targetId,
    // The proxy's own id for this shot, handed back for it to unpick, exactly
    // as a death report hands one back.
    shotId,
    ...projectile.userData.at,
    // The missile's velocity, which is what upstream packs -- direction and
    // speed are separate here and multiplied back together on the way out.
    dirX: projectile.userData.dirX,
    dirY: projectile.userData.dirY,
    dirZ: projectile.userData.dirZ,
    speed,
  });
}

// The sixth way to die, and the only one nothing local sets off: somebody else
// is shot with Genocide and everybody on their team goes with them. Upstream
// reaches it from the *killed* message rather than from any check of its own
// ("blow up if killer has genocide flag and i'm on same team as victim",
// playing.cxx:2657-2668), and so does this -- which is why it hangs off the
// handler for that message and not off the frame.
function checkOwnGenocide(message) {
  if (!ownTankCanDie()) return;
  // "geno only works in team games :)" -- upstream's own comment on the guard.
  if (gameConfig?.TEAMS_ALLOWED === false) return;
  if (message.shooterFlag !== 'G') return;
  // `shotId >= 0`: a genocide death comes of a genocide *shot*, so a death with
  // no bolt behind it takes nobody else with it.
  if (!message.projectileId) return;
  if (message.victimId === myPlayerId) return;
  const myState = myTank.userData.playerState;
  // A rogue has no team to be wiped out with.
  if (myState.team === PLAYER_TEAM.ROGUE) return;
  const victimTeam = tanks.get(message.victimId)?.userData?.playerState?.team ?? null;
  if (victimTeam !== myState.team) return;

  reportedOwnDeath = true;
  sendOwnDeath({
    reason: 'genocide',
    killerId: message.shooterId ?? null,
    shotId: null,
    flag: 'G',
    // The bolt that did it is the victim's to end, not every teammate's: one
    // shot, one `MsgShotEnd`, however many tanks it took down with it.
    stoppedByHit: false,
  });
}

// A beam, which is neither traced nor stepped either: its whole path exists the
// moment it is fired, and upstream's own laser crosses it in so little time that
// the segment its `checkHit` finds active is the first one, on the first frame.
// So it is asked once, over every segment in order, and the first tank-crossing
// wins -- which is the nearest, because the segments are already in flight
// order and each one starts where the last stopped against a wall.
//
// Nothing is removed on a hit: a laser and a thief's beam both pass through
// (`isStoppedByHit`), which is also why neither reports a shot to end.
// `expireLockTargets` (server.js), for the connection that has no server doing
// it. A lock lapses when its target stops being lockable -- dead, paused, gone
// or under `ST` -- or when there is nothing left for it to steer, `GM` gone
// from the hand and the last missile out of the air. Upstream makes that
// permanent rather than momentary: `GuidedMissleStrategy.cxx:165` sets
// `lastTarget = NoPlayer`, and dropping the flag clears it outright
// (`playing.cxx:3826`, "drop lock if i had GM").
//
// Permanence is the point. `getLockTargetTank` already refuses a dead target,
// so the bracket goes out either way -- but the stored id would outlive the
// death and come back the moment that tank respawned, steering at somebody
// nobody had aimed at. This acts on that same answer rather than keeping a
// second copy of the question.
//
// A missile still in the air when the lock lapses says so on its next step,
// because `announceOwnGuidedTarget` sends a change to null like any other.
function expireOwnLockTarget() {
  if (!clientTracesShots) return;
  if (!playerLockTargets.has(myPlayerId)) return;
  if (getLockTargetTank(myPlayerId)) return;
  setPlayerLockTarget(myPlayerId, null);
}

function checkOwnBeamHit(id, beam) {
  if (!ownTankCanDie()) return;
  const segments = Array.isArray(beam.userData.segments) ? beam.userData.segments : [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (!segment?.from || !segment?.to) continue;
    // The segment index is the bounce count: a beam's path is cut into a new
    // segment at each ricochet, so reaching segment 1 is exactly what "has
    // bounced once" means -- which is the rule that decides whether a beam may
    // come back and hit the tank that fired it.
    if (checkOwnShotHit(id, beam, segment.from, segment.to, i)) return;
  }
}

// A wave, which is neither traced nor stepped: it sits where it was fired and
// swells, so it is asked once a frame at whatever radius it has reached. It
// also never stops at a tank (`ShockWaveStrategy::isStoppedByHit` is false), so
// there is no shot to end -- only a death to report, and `reportedOwnDeath`
// already keeps a wave that is still swelling from reporting it twice.
function checkOwnShockWaveHit(projectile, radius) {
  if (!ownTankCanDie()) return;
  const state = myTank.userData.playerState;
  if (!shockWaveHitsTank(
    {
      playerId: projectile.userData.playerId,
      team: getPlayerTeamById(projectile.userData.playerId),
      ...projectile.userData.at,
      radius,
    },
    {
      id: myPlayerId,
      team: state.team,
      paused: pauseState.paused,
      alive: true,
      position: tankPoint(myTank),
    },
    {
      noTeamKills: gameConfig?.NO_TEAM_KILLS === true,
      teamsAllowed: gameConfig?.TEAMS_ALLOWED !== false,
    },
  )) return;

  // A Shield saves a tank from a wave exactly as it does from a bullet --
  // `gotBlowedUp`'s test is on the reason being `GotShot`, which a wave is,
  // and not on what kind of shot it was (playing.cxx:3918).
  const shielded = getMyFlag()?.type === 'SH';
  if (!shielded) reportedOwnDeath = true;
  sendOwnDeath({
    reason: shielded ? 'shielded' : 'shot',
    killerId: projectile.userData.playerId ?? null,
    shotId: null,
    flag: projectile.userData.flag ?? null,
    stoppedByHit: false,
  });
}

// The rest of the chain, in upstream's own order and with upstream's own
// `else if` between them: a tank dies once per check, of the first thing that
// killed it. Run-over is upstream's fourth and is not here -- it asks the
// steamroller radius of every other tank every frame, and wants its own pass.
function checkOwnEnvironmentDeath() {
  if (!ownTankCanDie()) return;
  const me = tankPoint(myTank);
  const driver = resolvePhysicsDriverAt(lastMotionObstacle, me.x, me.y, me.z);
  if (driver && driver.death) {
    reportedOwnDeath = true;
    sendOwnDeath({ reason: 'physicsDriver', deathMessage: driver.death, phydrv: driver.index ?? -1 });
    return;
  }
  // `(waterLevel > 0.0f) && (myTank->getPosition()[2] <= waterLevel)`
  // (playing.cxx:4196).
  if (currentWorldWaterHeight > 0 && me.z <= currentWorldWaterHeight) {
    reportedOwnDeath = true;
    sendOwnDeath({ reason: 'water' });
    return;
  }
  checkOwnRunOver();
}

// Upstream's fourth and last branch (playing.cxx:4199-4224): a Steamroller
// crushes what it touches, and anybody at all crushes a burrowed tank. The same
// three shared rules bzo's server squashes people by (`canRunOver`,
// `getRunOverRadius`, `getRunOverSeparation`), asked the other way round --
// here the local tank is the victim and every other tank is a candidate roller.
function checkOwnRunOver() {
  if (!ownTankCanDie()) return;
  const myState = myTank.userData.playerState;
  const myFlagType = getMyFlag()?.type ?? null;
  // Upstream reads the *victim's* own pause further up the chain rather than
  // in this loop, and `ownTankCanDie` is not that -- so it is asked here, as
  // the shot path asks it.
  if (pauseState.paused) return;

  for (const [playerId, tank] of tanks) {
    if (playerId === myPlayerId) continue;
    const state = tank.userData?.playerState;
    if (!state || !state.alive || state.paused) continue;
    if (isObserverTeam(state.team)) continue;
    // "Squashing is a kill like any other, so friendly fire governs it" --
    // upstream's guard is in this very loop (playing.cxx:4212).
    if (gameConfig?.NO_TEAM_KILLS === true
      && !areFoes(state.team, myState.team, gameConfig?.TEAMS_ALLOWED !== false)) continue;

    const rollerFlag = getPlayerFlag(playerId);
    const rollerFlagType = rollerFlag?.type ?? null;
    const roller = tankPoint(tank);
    if (!canRunOver(
      rollerFlagType,
      myFlagType,
      roller.z,
      isZoned(rollerFlagType, rollerFlag?.zoned === true),
    )) continue;

    const me = tankPoint(myTank);
    const separation = getRunOverSeparation(me.x - roller.x, me.y - roller.y, me.z - roller.z);
    if (separation >= getRunOverRadius(myFlagType, rollerFlagType, TANK.radius)) continue;

    reportedOwnDeath = true;
    sendOwnDeath({ reason: 'runOver', killerId: playerId, shotId: null, flag: null });
    return;
  }
}

function updateProjectiles(deltaTime) {
  const clampedDelta = Math.min(0.1, Math.max(0, Number.isFinite(deltaTime) ? deltaTime : 0));
  projectileSimAccumulator += clampedDelta;
  const maxAccumulated = SHOT_SIM_STEP_SECONDS * SHOT_SIM_MAX_STEPS_PER_FRAME;
  if (projectileSimAccumulator > maxAccumulated) {
    projectileSimAccumulator = maxAccumulated;
  }

  while (projectileSimAccumulator >= SHOT_SIM_STEP_SECONDS) {
    projectiles.forEach((projectile, id) => {
      // A beam does not travel: the server traced its whole path when it was
      // fired and the shot is a line until it fades. Neither does a shock wave:
      // it stays where it was fired and grows, which is a per-frame job rather
      // than a fixed-step one -- see below.
      if (projectile.userData.beam || projectile.userData.shockwave) return;
      const projectileSpeed = Number.isFinite(projectile.userData.speed)
        ? projectile.userData.speed
        : (Number.isFinite(gameConfig?.SHOT_SPEED) ? gameConfig.SHOT_SPEED : 100);

      // GuidedMissileStrategy::update, run here as well as on the server. This is
      // the one shot whose path cannot be extrapolated from where it started, so
      // both ends integrate it from the same shared function and the same locked
      // target -- upstream's remote clients do exactly this, steering their own
      // copy of the missile at the target the shooter last named. Where a
      // client's idea of that tank lags the server's, the missile is drawn a
      // little wide of where it really is, and the server still decides the hit.
      if (projectile.userData.guided) {
        const target = getLockTargetTank(projectile.userData.playerId);
        announceOwnGuidedTarget(id, projectile, target);
        const steered = steerGuidedShot(
          {
            x: projectile.userData.dirX,
            y: projectile.userData.dirY,
            z: projectile.userData.dirZ,
          },
          projectile.userData.at,
          target ? getLockAimPoint(target) : null,
          getShotEffects('GM').turnAngle,
          SHOT_SIM_STEP_SECONDS,
        );
        projectile.userData.dirX = steered.x;
        projectile.userData.dirY = steered.y;
        projectile.userData.dirZ = steered.z;
        renderManager.aimProjectile(projectile, steered);
      }
      const traced = traceShotThroughTeleporters(
        TELEPORTER_INDEX,
        projectile.userData.at,
        {
          x: Number.isFinite(projectile.userData.dirX) ? projectile.userData.dirX : 0,
          y: Number.isFinite(projectile.userData.dirY) ? projectile.userData.dirY : 0,
          z: Number.isFinite(projectile.userData.dirZ) ? projectile.userData.dirZ : 0,
        },
        projectileSpeed * SHOT_SIM_STEP_SECONDS,
        projectile.userData.teleportReentryBlockTeleporterIndex,
        projectile.userData.teleportReentryBlockDistance,
      );

      // A shot that ricochets of its own accord is traced against solid
      // geometry every step, same as the server. One that does not still has
      // to be checked, though: an obstacle can force a bounce of its own
      // (`ricochet` in a `.bzw`, `traceShotStep`'s own `impact.obstacle.ricochet`
      // test) regardless of what the shot itself carries, and an ordinary shot
      // that met one would otherwise fly straight through it while the server
      // reflects it -- the explosion lands in the right place with nothing
      // shown getting it there. A plain stop against ordinary geometry is
      // still left alone here: the server owns where an ordinary shot really
      // ends, and applying one early is the second answer the shot doesn't
      // need. `ricochet` below is the shot's own property, not a constant, so
      // `traceShotStep` bounces off an obstacle that declares it and nothing
      // else.
      const ownRicochet = projectile.userData.ricochet === true;

      // ShotStrategy::getFirstBuilding treats a teleporter frame as an
      // ordinary building hit, so a ricocheting shot bounces off it visually
      // the same as the server now does (issue #110). A shot that does not
      // ricochet is left at the frame for the server's own `shotEnd` to
      // remove -- the same "leave it to the server" rule the ordinary-geometry
      // stop below already follows.
      let frameBounceStart = null;
      if (traced.frameHit) {
        const impact = traced.point;
        if (ownRicochet) {
          const normal = getShotObstacleNormal(traced.frameHitObstacle, impact.x, impact.y, impact.z, SHOT_COLLISION_RADIUS);
          const reflected = reflectShotDirection(traced.direction.x, traced.direction.y, traced.direction.z, normal);
          renderManager.playSound('ricochet', impact);
          renderManager.createRicochetEffect(
            impact,
            { x: reflected.x - traced.direction.x, y: reflected.y - traced.direction.y, z: reflected.z - traced.direction.z }
          );
          traced.direction = reflected;
          // A shot only becomes able to hit its own shooter once it has
          // bounced (`getShotTankHit`), so every bounce is counted wherever
          // one happens -- a teleporter frame as much as a wall.
          projectile.userData.bounces = (projectile.userData.bounces || 0) + 1;
          frameBounceStart = {
            x: impact.x + (normal.x * SHOT_BOUNCE_CLEARANCE),
            y: impact.y + (normal.y * SHOT_BOUNCE_CLEARANCE),
            z: impact.z + (normal.z * SHOT_BOUNCE_CLEARANCE),
          };
        } else if (clientTracesShots) {
          removeProjectile(id, 0, impact.x, impact.y, impact.z);
          return;
        } else {
          placeShot(projectile, impact);
          projectile.userData.dirX = traced.direction.x;
          projectile.userData.dirY = traced.direction.y;
          projectile.userData.dirZ = traced.direction.z;
          return;
        }
      }

      placeShot(projectile, frameBounceStart || traced.point);
      if (traced.teleports > 0) {
        renderManager.createShotTeleportEffect(projectile);
      }
      projectile.userData.dirX = traced.direction.x;
      projectile.userData.dirY = traced.direction.y;
      projectile.userData.dirZ = traced.direction.z;
      projectile.userData.teleportReentryBlockTeleporterIndex = traced.reentryBlockTeleporterIndex;
      projectile.userData.teleportReentryBlockDistance = traced.reentryBlockDistance;

      if (traced.teleports > 0 && projectile?.userData?.playerId === myPlayerId && isShotTeleportDebugEnabled()) {
        sendToServer({
          type: 'debug',
          message: `[SHOT_TP_CLIENT] id=${String(projectile?.userData?.pendingServerAck ? 'pending' : 'ack')} teleports=${traced.teleports} pos=(${projectile.userData.at.x.toFixed(2)},${projectile.userData.at.y.toFixed(2)},${projectile.userData.at.z.toFixed(2)})`,
        });
      }

      // The segment to trace ends where the teleporter trace put the shot, so a
      // step that crossed a portal is measured back from the far side of it. A
      // frame bounce already has its own start, clear of the surface it just
      // reflected off.
      const stepDistance = projectileSpeed * SHOT_SIM_STEP_SECONDS;
      const traceDistance = frameBounceStart ? traced.frameHitRemaining : stepDistance;
      const startX = frameBounceStart ? frameBounceStart.x : traced.point.x - (traced.direction.x * stepDistance);
      const startY = frameBounceStart ? frameBounceStart.y : traced.point.y - (traced.direction.y * stepDistance);
      const startZ = frameBounceStart ? frameBounceStart.z : traced.point.z - (traced.direction.z * stepDistance);
      const step = traceShotStep({
        obstacles: getCollisionColliders(),
        x: startX,
        y: startY,
        z: startZ,
        dirX: traced.direction.x,
        dirY: traced.direction.y,
        dirZ: traced.direction.z,
        distance: traceDistance,
        radius: SHOT_COLLISION_RADIUS,
        ricochet: ownRicochet,
        justTeleported: frameBounceStart ? false : traced.teleports > 0,
      });
      // Did it hit me? Asked over the segment this step actually covered, and
      // before the shot is retired against geometry below -- `step` already
      // ends at whatever building stopped it, so a tank standing behind that
      // wall is outside the segment and cannot be hit through it.
      if (checkOwnShotHit(id, projectile, { x: startX, y: startY, z: startZ }, { x: step.x, y: step.y, z: step.z })) {
        removeProjectile(id, 0, step.x, step.y, step.z);
        return;
      }

      // Where the server owns the shot it says where it stopped, and this
      // leaves an ordinary stop to it. Where the client owns it, this is the
      // only thing that will: a building or the ground ends the shot right
      // here, with the impact a `shotEnd` of reason 0 would have drawn.
      if (clientTracesShots && step.bounces === 0 && (step.obstacle || step.ground)) {
        removeProjectile(id, 0, step.x, step.y, step.z);
        return;
      }
      // The world's edge, above the wall too. Upstream's border is a plane with
      // no top for every shot but a bouncing one (`ignoreHit` needs `Reflect`,
      // SegmentedShotStrategy.cxx:469), so a shell or a missile flying higher
      // than `_wallHeight` still stops and bursts there, as bzo's server ends
      // its own shots at the edge.
      if (clientTracesShots && !ownRicochet && !currentWorldNoWalls) {
        const halfMap = (Number.isFinite(currentWorldMapSize) ? currentWorldMapSize : DEFAULT_MAP_SIZE) / 2;
        if (Math.abs(step.x) > halfMap || Math.abs(step.y) > halfMap) {
          const edge = findMapEdgeImpactPoint(startX, startY, startZ, step.x, step.y, step.z, halfMap);
          removeProjectile(id, 0, edge.x, edge.y, edge.z);
          return;
        }
      }
      if (!ownRicochet && step.bounces === 0) return;
      placeShot(projectile, step);
      projectile.userData.dirX = step.dirX;
      projectile.userData.dirY = step.dirY;
      projectile.userData.dirZ = step.dirZ;
      if (step.bounces > 0) {
        projectile.userData.bounces = (projectile.userData.bounces || 0) + step.bounces;
        // SegmentedShotStrategy plays SFX_RICOCHET at the start of the new
        // segment and throws the effect along the change in direction.
        const at = projectile.userData.at;
        renderManager.playSound('ricochet', at);
        renderManager.createRicochetEffect(
          at,
          { x: step.dirX - traced.direction.x, y: step.dirY - traced.direction.y, z: step.dirZ - traced.direction.z }
        );
      }
    });
    projectileSimAccumulator -= SHOT_SIM_STEP_SECONDS;
  }

  // The trail and the bolt animation are both per-frame rather than per step:
  // upstream leaves a puff off a clock the missile carries, and steps the bolt's
  // texture once per rendered frame.
  let hasGuided = false;
  projectiles.forEach((projectile) => {
    if (!projectile.userData.guided) return;
    hasGuided = true;
    renderManager.trailGMPuffs(projectile, clampedDelta);
  });
  if (hasGuided) renderManager.advanceMissileFrames(projectiles);
  renderManager.updateGMPuffs(clampedDelta);

  // ShotStrategy::isActive: a shot's life is something the client already
  // knows, so where it owns the path it owns the clock too and drops the shot
  // when the life is up, with no impact -- upstream's own clients each expire
  // their copy and no message says so. A beam is expired this way whoever
  // owns it: the wire carries a reload time rather than a beam's own short
  // life, and bzo's `shotEnd` lands at the same moment anyway.
  projectiles.forEach((projectile, id) => {
    if (!projectile.userData.beam && !clientTracesShots) return;
    const createdAt = Number.isFinite(projectile.userData.createdAt)
      ? projectile.userData.createdAt
      : frameEpochMs;
    const lifetimeSeconds = Number.isFinite(projectile.userData.lifetimeSeconds)
      ? projectile.userData.lifetimeSeconds
      : getShotLifetimeSeconds(projectile.userData.flag ?? null);
    if ((frameEpochMs - createdAt) / 1000 < lifetimeSeconds) return;
    renderManager.removeProjectile(projectile);
    projectiles.delete(id);
  });

  // ShockWaveStrategy::update, which upstream runs on the frame rather than on a
  // simulation step because nothing about it is integrated: the radius is a
  // function of how old the wave is, so it is read straight off the clock. The
  // server ends the wave; this only draws it, and holds it at full size for the
  // frame or two between the two.
  projectiles.forEach((projectile) => {
    if (!projectile.userData.shockwave) return;
    const createdAt = Number.isFinite(projectile.userData.createdAt)
      ? projectile.userData.createdAt
      : frameEpochMs;
    const lifetimeSeconds = Number.isFinite(projectile.userData.lifetimeSeconds)
      ? projectile.userData.lifetimeSeconds
      : getShotLifetimeSeconds(projectile.userData.flag ?? null);
    const radius = getShockWaveRadius((frameEpochMs - createdAt) / 1000, lifetimeSeconds);
    projectile.userData.shockWaveRadius = radius;
    checkOwnShockWaveHit(projectile, radius);
    renderManager.updateShotShockWave(projectile, radius, getShockWaveAlpha(radius));
  });

  if (pendingLocalProjectiles.length > 0) {
    const now = frameEpochMs;
    const timeoutMs = 2000;
    pendingLocalProjectiles = pendingLocalProjectiles.filter((pending) => {
      if (now - pending.sentAt <= timeoutMs) return true;
      const projectile = projectiles.get(pending.id);
      if (projectile?.userData?.pendingServerAck) {
        renderManager.removeProjectile(projectile);
        projectiles.delete(pending.id);
      }
      return false;
    });
  }
}

// pausedSphere->move (Player.cxx:1006): it follows the tank and does nothing
// else. A paused tank does not move, but its owner may still be falling onto
// something when the pause lands.
function updatePausedSpheres() {
  playerPausedSpheres.forEach((sphere, playerId) => {
    const tank = tanks.get(playerId);
    if (tank) sphere.position.copy(tank.position);
  });
}

function onWindowResize() {
  renderManager.handleResize();
  resizeRadar();
}

function resizeRadar() {
  if (!radarCanvas) return;
  const smallerDimension = Math.min(window.innerWidth, window.innerHeight);
  const size = Math.max(120, Math.min(390, Math.round(smallerDimension * 0.375)));
  radarCanvas.width = size;
  radarCanvas.height = size;
  radarCanvas.style.width = size + 'px';
  radarCanvas.style.height = size + 'px';
}

// Every XR HUD overlay is the same object: a 2D canvas wrapped in a
// CanvasTexture on a plane parented to the camera, so it rides the head. Only
// the canvas size, the plane size and placement, and the painting differ.
function ensureXRHudPanel(panel, { canvas = null, canvasWidth = 0, canvasHeight = 0 }) {
  const baseCamera = renderManager?.getCamera();
  if (!baseCamera) return null;

  if (canvas) {
    panel.canvas = canvas;
  } else if (!panel.canvas) {
    panel.canvas = document.createElement('canvas');
    panel.canvas.width = canvasWidth;
    panel.canvas.height = canvasHeight;
  }

  if (!panel.texture) {
    panel.texture = new THREE.CanvasTexture(panel.canvas);
    panel.texture.colorSpace = THREE.SRGBColorSpace;
  }

  if (!panel.mesh) {
    panel.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: panel.texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        opacity: 1,
      }),
    );
    panel.mesh.renderOrder = Number.MAX_SAFE_INTEGER;
    panel.mesh.visible = false;
    panel.mesh.userData.drawGroup = 'hud';
  }

  if (panel.mesh.parent !== baseCamera) {
    panel.mesh.parent?.remove(panel.mesh);
    baseCamera.add(panel.mesh);
  }

  return panel.mesh;
}

// Resize the plane to the panel's current size and place it on the HUD plane.
// The settings menu covers the view, so nothing else shows while it is open.
//
// Whatever a caller asks for is held inside the HUD box: a panel wider or taller
// than the box is scaled down to fit, and one that would hang over an edge is
// slid back in. A caller that already asks for a spot inside the box is placed
// exactly where it asked, so the box is a bound rather than a layout -- the same
// thing --hud-edge is for the DOM panels, which position themselves and only
// promise to stop short of the screen.
function placeXRHudPanel(panel, { width: requestedWidth, height: requestedHeight, x: requestedX, y: requestedY }) {
  const left = -xrHudEdge(XR_HUD_ANGLE_X);
  const right = xrHudEdge(XR_HUD_ANGLE_X);
  const top = xrHudEdge(XR_HUD_ANGLE_UP);
  const bottom = -xrHudEdge(XR_HUD_ANGLE_DOWN);
  // Scale rather than crop: the canvas behind a panel is laid out for its own
  // aspect, so squeezing one dimension would letter-box the painting.
  const fit = Math.min(1, (right - left) / requestedWidth, (top - bottom) / requestedHeight);
  const width = requestedWidth * fit;
  const height = requestedHeight * fit;
  const x = Math.min(right - (width / 2), Math.max(left + (width / 2), requestedX));
  const y = Math.min(top - (height / 2), Math.max(bottom + (height / 2), requestedY));

  if (panel.planeWidth !== width || panel.planeHeight !== height) {
    panel.mesh.geometry.dispose();
    panel.mesh.geometry = new THREE.PlaneGeometry(width, height);
    panel.planeWidth = width;
    panel.planeHeight = height;
  }
  panel.mesh.scale.set(1, 1, 1);
  panel.mesh.position.set(x, y, XR_HUD_PLANE_Z);
  panel.mesh.rotation.set(0, 0, 0);
  panel.mesh.visible = isXREnabled() && !xrSettingsMenuOpen;
}

// Every overlay repaints its canvas and re-uploads it as a texture, and none of
// them are drawn outside an XR session. So paint none of them there: hide the
// panels once on the way out of a session, and skip the whole set until the
// next one. The desktop HUD these mirror is DOM and canvas that draws itself.
function updateXRHudOverlays() {
  if (!isXREnabled()) {
    if (!xrHudOverlaysActive) return;
    xrHudOverlaysActive = false;
    XR_HUD_PANELS.forEach((panel) => {
      if (panel.mesh) panel.mesh.visible = false;
    });
    xrSettingsMenuRenderer?.hide();
    return;
  }

  xrHudOverlaysActive = true;
  ensureXRRadarTexture();
  ensureXRShotStatusOverlay();
  ensureXRChatOverlay();
  ensureXRScoreboardOverlay();
  ensureXRNoticeOverlay();
  ensureXRFlagHelpOverlay();
  ensureXRSettingsMenu();
}

// The same column the DOM HUD shows -- the roaming status line, then the alert
// slots -- on the one surface an immersive session has. Nothing is drawn when
// there is nothing to say, so a quiet session pays only the visibility flag.
function ensureXRNoticeOverlay() {
  const alerts = getActiveHudAlerts();
  const status = getHudStatusParts(isObserver() && !isPhantomDriving());
  const lines = [];
  // The panel already draws a chat line's own `segments`, so the roaming
  // label's name arrives in the player's colour here too.
  if (status && status.text) {
    lines.push({ text: status.text, color: XR_MESSAGE_COLOR, segments: status.segments });
  }
  alerts.forEach((alert) => lines.push({
    text: alert.text,
    color: getHudAlertColor(alert.warning),
    segments: alert.segments,
  }));
  if (lines.length === 0) {
    if (xrAlertPanel.mesh) xrAlertPanel.mesh.visible = false;
    return;
  }
  if (!ensureXRHudPanel(xrAlertPanel, { canvasWidth: 1024, canvasHeight: 210 })) return;

  const canvas = xrAlertPanel.canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    xrAlertPanel.mesh.visible = false;
    return;
  }

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.font = 'bold 40px sans-serif';
  const lineHeight = 46;
  lines.forEach((line, index) => {
    const y = 52 + index * lineHeight;
    // A dark stroke stands in for the DOM text-shadow: the panel is transparent,
    // so the world behind it is whatever the player happens to be looking at.
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    if (!line.segments) {
      ctx.strokeText(line.text, w / 2, y);
      ctx.fillStyle = line.color;
      ctx.fillText(line.text, w / 2, y);
      return;
    }
    // A line with coloured runs is drawn run by run, as the chat panel draws
    // one. Unlike the chat panel this column is centred, so the whole line is
    // measured first and the runs are laid out from the left edge that puts --
    // there is no per-run alignment that adds up to a centred line.
    const widths = line.segments.map((segment) => ctx.measureText(segment.text || '').width);
    const total = widths.reduce((sum, width) => sum + width, 0);
    ctx.textAlign = 'left';
    // The stroke goes under the whole line before any fill, so a run's outline
    // never darkens the run beside it where the two touch.
    let x = (w / 2) - (total / 2);
    line.segments.forEach((segment, segmentIndex) => {
      ctx.strokeText(segment.text || '', x, y);
      x += widths[segmentIndex];
    });
    x = (w / 2) - (total / 2);
    line.segments.forEach((segment, segmentIndex) => {
      ctx.fillStyle = segment.color ? colorToCSS(segment.color) : line.color;
      ctx.fillText(segment.text || '', x, y);
      x += widths[segmentIndex];
    });
    ctx.textAlign = 'center';
  });

  placeXRHudPanel(xrAlertPanel, { width: 0.86, height: 0.176, x: 0, y: 0.3 });
  xrAlertPanel.texture.needsUpdate = true;
}

// What the flag you are carrying does, on the surface a session has. The DOM
// copy of this is one element the browser wraps; here the wrap is measured
// against the canvas, and the same stroke the notice column uses stands in for
// its text-shadow because the panel is transparent and the world behind it is
// whatever the player happens to be looking at.
//
// The scoreboard's rule, and it matters more here than there: this panel is up
// for a minute at a time and its text cannot change while it is, so the canvas
// is painted when the help changes and left alone every other frame. Repainting
// it at frame rate would spend a megabyte of texture upload and five stroked
// lines of layout on words that never move.
function ensureXRFlagHelpOverlay() {
  const text = getActiveFlagHelp();
  if (!text) {
    if (xrFlagHelpPanel.mesh) xrFlagHelpPanel.mesh.visible = false;
    xrFlagHelpPanel.paintedText = null;
    return;
  }
  if (!ensureXRHudPanel(xrFlagHelpPanel, {
    canvasWidth: XR_FLAG_HELP_CANVAS_WIDTH,
    canvasHeight: XR_FLAG_HELP_CANVAS_HEIGHT,
  })) return;

  if (text !== xrFlagHelpPanel.paintedText) {
    const canvas = xrFlagHelpPanel.canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      xrFlagHelpPanel.mesh.visible = false;
      return;
    }
    const w = canvas.width;
    ctx.clearRect(0, 0, w, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${XR_FLAG_HELP_LINE_PX}px sans-serif`;
    // Wrapped against the canvas, as makeHelpString wraps against 75% of the
    // window width. Nothing in the flag table reaches the panel's last line
    // today -- Phantom Zone, the longest, takes three of the five.
    const maxWidth = w - (2 * XR_FLAG_HELP_MARGIN_PX);
    const lines = wrapText(ctx, text, maxWidth);
    if (lines.length > XR_FLAG_HELP_MAX_LINES) {
      const last = XR_FLAG_HELP_MAX_LINES - 1;
      // A longer one is cut rather than dropped, so it says there is more
      // instead of ending mid-sentence as if that were all of it. The overflow
      // is rejoined first because it is wider than a line by construction,
      // which is what gives fitText something to cut.
      const overflow = lines.slice(last).join(' ');
      lines.length = XR_FLAG_HELP_MAX_LINES;
      lines[last] = fitText(ctx, overflow, maxWidth);
    }
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillStyle = XR_MESSAGE_COLOR;
    lines.forEach((line, index) => {
      const y = XR_FLAG_HELP_LINE_PX + (index * XR_FLAG_HELP_LINE_HEIGHT_PX);
      ctx.strokeText(line, w / 2, y);
      ctx.fillText(line, w / 2, y);
    });
    xrFlagHelpPanel.paintedText = text;
    xrFlagHelpPanel.texture.needsUpdate = true;
  }

  const height = XR_FLAG_HELP_PLANE_WIDTH
    * (XR_FLAG_HELP_CANVAS_HEIGHT / XR_FLAG_HELP_CANVAS_WIDTH);
  placeXRHudPanel(xrFlagHelpPanel, {
    width: XR_FLAG_HELP_PLANE_WIDTH,
    height,
    x: 0,
    // Placed by its top edge: the first line has to land the same distance
    // below the gaze axis whatever the help says, and the canvas is painted
    // from the top for the same reason.
    y: XR_FLAG_HELP_TOP - (height / 2),
  });
}

function ensureXRRadarTexture() {
  if (!radarCanvas) return;
  if (!ensureXRHudPanel(xrRadarPanel, { canvas: radarCanvas })) return;

  const size = XR_RADAR_PLANE_SIZE;
  placeXRHudPanel(xrRadarPanel, {
    width: size,
    height: size,
    x: xrHudEdge(XR_HUD_ANGLE_X) - (size / 2),
    y: xrHudEdge(XR_HUD_ANGLE_UP) - (size / 2),
  });

  if (isXREnabled()) xrRadarPanel.texture.needsUpdate = true;
}

function ensureXRChatOverlay() {
  if (!ensureXRHudPanel(xrChatPanel, {
    canvasWidth: XR_CHAT_CANVAS_WIDTH,
    canvasHeight: XR_CHAT_CANVAS_HEIGHT,
  })) return;

  const canvas = xrChatPanel.canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    xrChatPanel.mesh.visible = false;
    return;
  }

  const w = canvas.width;
  const h = canvas.height;
  const panelX = 14;
  const panelY = 10;
  const panelW = w - (2 * panelX);
  const panelH = h - (2 * panelY);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = getCssColor('--chat-bg', 'rgba(0, 0, 0, 0.5)');
  roundedRect(ctx, panelX, panelY, panelW, panelH, 12);
  ctx.fill();

  // Which tab you are reading, and whether anything has arrived on another one.
  // The DOM chat spends a whole row on the tabs because they are buttons there;
  // in a session nothing points at this panel and the tabs are keyboard-bound
  // (the digits and the brackets), so a strip of five labels would be five
  // labels you cannot press. One caption says the same thing in a fifth of the
  // room, and the room goes to the messages, which are the part worth reading.
  const activeTab = getVisibleChatTabs().find((tab) => tab.id === chatState.activeTab);
  const unreadCount = getVisibleChatTabs()
    .filter((tab) => tab.id !== chatState.activeTab && chatState.unread[tab.id]).length;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `bold ${XR_CHAT_CAPTION_PX}px monospace`;
  ctx.fillStyle = getCssColor('--chat-tab-active', '#fff');
  const captionBaseline = panelY + XR_CHAT_CAPTION_PX + 4;
  ctx.fillText(activeTab ? activeTab.label : 'All', panelX + 10, captionBaseline);
  if (unreadCount > 0) {
    ctx.textAlign = 'right';
    ctx.fillStyle = getCssColor('--chat-tab-unread', '#ff8a80');
    ctx.fillText(`+${unreadCount} unread`, panelX + panelW - 10, captionBaseline);
    ctx.textAlign = 'left';
  }

  // The same six lines the DOM window holds, in the same colour per kind. A
  // message that is yellow on a monitor is yellow in the headset.
  const activeMessages = chatState.messages[chatState.activeTab] || [];
  const visibleMessages = activeMessages.slice(-CHAT_VISIBLE_MESSAGES);
  ctx.font = `${XR_CHAT_LINE_PX}px monospace`;
  const firstLineBaseline = captionBaseline + XR_CHAT_CAPTION_PX;
  visibleMessages.forEach((msg, index) => {
    const kindColor = getChatKindColor(msg.kind);
    const baseline = firstLineBaseline + (index * XR_CHAT_LINE_HEIGHT_PX);
    const maxWidth = panelW - 20;
    if (!msg.segments) {
      ctx.fillStyle = kindColor;
      ctx.fillText(fitText(ctx, msg.text || '', maxWidth), panelX + 10, baseline);
      return;
    }
    // A line with coloured runs is drawn run by run, each starting where the
    // last one ended. `fitText` truncates one string against one width, so the
    // width left over is carried along and the line stops mid-run rather than
    // spilling off the panel.
    let x = panelX + 10;
    let remaining = maxWidth;
    for (const segment of msg.segments) {
      if (remaining <= 0) break;
      const drawn = fitText(ctx, segment.text || '', remaining);
      if (!drawn) break;
      ctx.fillStyle = segment.color ? colorToCSS(segment.color) : kindColor;
      ctx.fillText(drawn, x, baseline);
      const width = ctx.measureText(drawn).width;
      x += width;
      remaining -= width;
    }
  });

  xrChatPanel.texture.needsUpdate = true;
  placeXRHudPanel(xrChatPanel, {
    width: XR_CHAT_PLANE_WIDTH,
    // The plane takes the canvas's own aspect, so a line of text is the shape it
    // was painted rather than stretched to whatever height the plane was given.
    height: XR_CHAT_PLANE_WIDTH * (XR_CHAT_CANVAS_HEIGHT / XR_CHAT_CANVAS_WIDTH),
    x: 0,
    // Against the bottom of the HUD box. It sat at 34 degrees below the gaze
    // axis, which on a headset is under the lens rather than in front of it.
    y: -xrHudEdge(XR_HUD_ANGLE_DOWN),
  });
}

function ensureXRShotStatusOverlay() {
  if (!ensureXRHudPanel(xrShotStatusPanel, { canvasWidth: 220, canvasHeight: 200 })) return;

  const canvas = xrShotStatusPanel.canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    xrShotStatusPanel.mesh.visible = false;
    return;
  }

  const maxSlots = gameConfig && Number.isFinite(gameConfig.SHOT_MAX_ACTIVE)
    ? normalizeShotSlotCount(gameConfig.SHOT_MAX_ACTIVE)
    : 5;
  // `-ms 0`: no slots to draw bars for. Without this the canvas is sized to
  // its own 32px floor and an empty panel hangs in the headset.
  if (maxSlots === 0) {
    xrShotStatusPanel.mesh.visible = false;
    return;
  }
  // The XR copy of the same bar: see the comment in `updateShotStatus`. A bar
  // fills on its own slot's reload and nothing else, and the row is sorted,
  // because the bars tally how ready the slots are rather than naming them
  // (HUDRenderer.cxx:1988). Issue #36.
  const slotProgress = new Array(maxSlots);
  for (let slot = 0; slot < maxSlots; slot++) {
    slotProgress[slot] = getShotSlotProgress(
      myShotSlotFreeAt, slot, myShotSlotReloadMs[slot], frameEpochMs,
    );
  }
  slotProgress.sort((a, b) => a - b);

  const barGap = 2;
  const barHeight = 7;
  const barWidth = 32;
  const totalHeight = maxSlots * barHeight + Math.max(0, maxSlots - 1) * barGap;
  canvas.width = barWidth;
  canvas.height = Math.max(32, totalHeight);

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  slotProgress.forEach((progress, index) => {
    const y = index * (barHeight + barGap);
    if (progress >= 1) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fillRect(0, y, barWidth, barHeight);
      return;
    }
    ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
    ctx.fillRect(0, y, barWidth, barHeight);
    ctx.fillStyle = 'rgba(0, 255, 0, 0.5)';
    ctx.fillRect(0, y, barWidth * Math.max(0, Math.min(1, progress)), barHeight);
  });

  xrShotStatusPanel.texture.needsUpdate = true;

  const shotWidth = 0.08;
  const radarMesh = xrRadarPanel.mesh;
  const radarPlaneWidth = radarMesh?.geometry ? radarMesh.geometry.parameters.width : XR_RADAR_PLANE_SIZE;
  const radarRightEdge = radarMesh
    ? radarMesh.position.x + (radarPlaneWidth / 2)
    : xrHudEdge(XR_HUD_ANGLE_X);
  placeXRHudPanel(xrShotStatusPanel, {
    width: shotWidth,
    height: Math.min(0.18, 0.02 + maxSlots * 0.015),
    x: radarRightEdge - (shotWidth / 2),
    y: 0.02,
  });
}

function ensureXRScoreboardOverlay() {
  if (!ensureXRHudPanel(xrScoreboardPanel, { canvasWidth: 720, canvasHeight: 340 })) return;

  const canvas = xrScoreboardPanel.canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    xrScoreboardPanel.mesh.visible = false;
    return;
  }

  // The same rows the flat scoreboard draws, in the same order, with the same
  // flags: one model, two surfaces. This runs every frame of a session, so an
  // unchanged model is drawn by leaving the canvas alone and only placing the
  // panel again -- the roster is repainted when it changes, not at frame rate.
  const model = getScoreboardModel();
  if (model.version === xrScoreboardPanel.paintedVersion) {
    placeXRScoreboardPanel();
    return;
  }
  const playerData = model.rows;
  const teamRows = model.teamRows;
  const margin = 12;
  const panelW = 320;
  // The match clock, drawn above everything else the panel shows -- upstream's
  // own scoreboard has no clock row because its HUD already carries one
  // elsewhere on screen; a headset's scoreboard panel is the nearest thing bzo
  // has to that, so the clock rides here instead. Nothing is reserved when no
  // clock is configured.
  const clockText = model.gameOver ? 'GAME OVER' : formatMatchClock(model.timeLeft);
  const clockHeight = clockText ? 22 : 0;
  // Both columns are laid out in pixels, as the other canvas HUDs are. The
  // score column is right-aligned against this edge rather than started at a
  // fixed offset, so a two-digit score grows to the left instead of off the
  // panel, and the name is cut to whatever is left over rather than to a
  // character count that cannot know how wide the score beside it is.
  const contentRight = panelW - margin;
  const columnGap = 8;
  const rowHeight = 18;
  const headerHeight = 20;
  const maxRows = 8;
  const visiblePlayers = playerData.slice(0, maxRows);
  // ScoreboardRenderer.cxx:562's blank line before the first observer, which the
  // model marks so both boards break in the same place. Half a row here rather
  // than a whole one: this panel's rows are tighter than the flat board's.
  const observerGap = visiblePlayers.some((player) => player.startsObservers)
    ? Math.round(rowHeight / 2)
    : 0;
  // A replay's live viewers get a line of their own for the flat board's
  // "Watching" heading.
  const watchingGap = visiblePlayers.some((player) => player.startsWatching) ? rowHeight : 0;
  const teamBlockHeight = teamRows.length ? headerHeight + teamRows.length * rowHeight + 8 : 0;
  const panelH = Math.max(
    120,
    clockHeight + teamBlockHeight + headerHeight + 10 + visiblePlayers.length * rowHeight + observerGap + watchingGap + 12,
  );
  canvas.width = panelW;
  canvas.height = panelH;

  ctx.clearRect(0, 0, panelW, panelH);
  ctx.fillStyle = 'rgba(7, 10, 14, 0.78)';
  ctx.fillRect(0, 0, panelW, panelH);

  ctx.strokeStyle = 'rgba(130, 150, 170, 0.6)';
  ctx.lineWidth = 2;
  ctx.strokeRect(6, 6, panelW - 12, panelH - 12);

  if (clockText) {
    ctx.fillStyle = '#4CAF50';
    ctx.font = 'bold 15px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(clockText, panelW / 2, 18);
    ctx.textAlign = 'left';
  }

  ctx.fillStyle = '#4CAF50';
  ctx.font = 'bold 14px monospace';
  if (teamRows.length) {
    ctx.fillText('Teams', margin, 16 + clockHeight);
    ctx.font = '13px monospace';
    teamRows.forEach((row, index) => {
      const y = 38 + clockHeight + index * rowHeight;
      const score = formatTeamScore(row);
      // The flat board's team rows read from the radar's colour table, for the
      // radar's own reason -- a dark panel -- and this panel is darker still.
      ctx.fillStyle = colorToCSS(getPlayerTeamRadarColor(row.team));
      ctx.textAlign = 'right';
      ctx.fillText(score, contentRight, y);
      ctx.textAlign = 'left';
      const labelWidth = contentRight - margin - ctx.measureText(score).width - columnGap;
      ctx.fillText(fitText(ctx, row.label, labelWidth), margin, y);
    });
    ctx.fillStyle = '#4CAF50';
    ctx.font = 'bold 14px monospace';
  }

  const playerHeaderY = 16 + clockHeight + teamBlockHeight;
  // The `#` column's width, measured once in the row font rather than per row,
  // so every name starts at the same x instead of wherever that row's own id
  // happened to end. The header reserves the same allowance, which is what
  // puts 'Player' over the names rather than over the numbers.
  ctx.save();
  ctx.font = '13px monospace';
  const numberWidth = ctx.measureText('###').width;
  // The `T` letter after the number, as the flat board has it.
  const typeWidth = ctx.measureText('T ').width;
  ctx.restore();
  ctx.fillText('#', margin, playerHeaderY);
  ctx.fillText('T', margin + numberWidth, playerHeaderY);
  ctx.fillText('Player', margin + numberWidth + typeWidth, playerHeaderY);
  ctx.textAlign = 'right';
  // The flat board's heading, abbreviated to what fits a headset panel. Both
  // read it from the same place so they cannot name the columns differently.
  ctx.fillText(
    getScoreboardStatsHeader(rabbitChaseEnabled, true), contentRight, playerHeaderY);
  ctx.textAlign = 'left';

  let rowY = playerHeaderY + 22;
  visiblePlayers.forEach((player) => {
    if (player.startsObservers) rowY += observerGap;
    if (player.startsWatching) {
      ctx.font = '11px monospace';
      ctx.fillStyle = 'rgba(230, 241, 255, 0.7)';
      ctx.fillText(SCOREBOARD_WATCHING_LABEL, margin, rowY);
      rowY += watchingGap;
    }
    const y = rowY;
    rowY += rowHeight;
    // The row is drawn in the colour the player's tank is drawn in, as the flat
    // scoreboard's rows are, so a name reads the same in the headset as on the
    // screen. Only the flag departs from it, in the flag's own colour.
    const rowColor = player.color ? colorToCSS(player.color) : '#E6F1FF';
    // The flat scoreboard bolds your own row and lays a green band behind it;
    // colour alone cannot say which row is yours once every row is coloured.
    if (player.isCurrent) {
      ctx.fillStyle = 'rgba(76, 175, 80, 0.25)';
      ctx.fillRect(margin - 4, y - rowHeight + 5, panelW - (margin * 2) + 8, rowHeight);
    }
    // Measured in the row's own font, which the current player's row bolds.
    ctx.font = player.isCurrent ? 'bold 13px monospace' : '13px monospace';
    // The same columns the flat board draws, which for an observer is none of
    // them: it cannot kill or die, and it has no rank because it can never be
    // anointed.
    const stats = formatScoreboardStats(player, { tier: SCOREBOARD_TIER.MEDIUM });
    const flagLabel = player.flag ? `/${player.flag.label}` : '';
    // The authentication indicator, in front of the name and in cyan, as
    // upstream draws it (`ScoreboardRenderer.cxx:712`) and as the flat
    // scoreboard draws it. It takes its width off the name for the same reason
    // the flag does.
    const status = player.status || '';
    const statusWidth = status ? ctx.measureText(status).width : 0;
    // The player number, ahead of everything else on the row. Upstream shows it
    // only to an admin; bzo shows it to everyone, here as on the flat board.
    const numberLabel = String(player.id ?? '');
    // The Rabbit Chase mark, which the flat scoreboard draws after the flag and
    // in the same place. The leading space is this panel's answer to the flat
    // one's margin: everything here is laid out by measured width.
    const rabbitLabel = player.rabbit ? ` ${player.rabbit.label}` : '';
    // The bullseye on a marked row, drawn from the same place the flat board reads
    // it. The cursor never lands here -- a headset has no key to move it with --
    // but the mark does, because the hunt is the same hunt on both surfaces.
    const huntMark = getScoreboardHuntLabel(player);
    const huntLabel = huntMark ? ` ${huntMark}` : '';
    // The flat scoreboard's own paused hourglass and mic glyph, drawn after
    // the flag the same way there.
    const pausedLabel = player.paused ? '⏳' : (player.notResponding ? '[nr]' : '');
    const micLabel = player.speaking ? '\u{1F50A}' : player.micOn ? '\u{1F3A4}' : '';
    // A carried flag shares the row with the name, so the name gives up room for
    // it rather than the panel growing a column nothing usually fills. The mark
    // comes out of the same allowance.
    const nameWidth = contentRight - margin - columnGap
      - ctx.measureText(stats).width
      - numberWidth
      - typeWidth
      - statusWidth
      - (flagLabel ? ctx.measureText(flagLabel).width : 0)
      - (pausedLabel ? ctx.measureText(pausedLabel).width : 0)
      - (micLabel ? ctx.measureText(micLabel).width : 0)
      - (rabbitLabel ? ctx.measureText(rabbitLabel).width : 0)
      - (huntLabel ? ctx.measureText(huntLabel).width : 0);
    const shown = fitText(ctx, String(player.name || 'Player'), Math.max(0, nameWidth));

    ctx.fillStyle = rowColor;
    ctx.fillText(numberLabel, margin, y);
    ctx.fillText(formatScoreboardCell(player, 'type'), margin + numberWidth, y);
    const nameLeft = margin + numberWidth + typeWidth;
    if (status) {
      ctx.fillStyle = colorToCSS(SCOREBOARD_STATUS_COLOR);
      ctx.fillText(status, nameLeft, y);
    }
    ctx.fillStyle = rowColor;
    ctx.fillText(shown, nameLeft + statusWidth, y);
    let labelRight = nameLeft + statusWidth + ctx.measureText(shown).width;
    if (flagLabel) {
      ctx.fillStyle = colorToCSS(player.flag.color);
      ctx.fillText(flagLabel, labelRight, y);
      labelRight += ctx.measureText(flagLabel).width;
    }
    if (pausedLabel) {
      ctx.fillStyle = rowColor;
      ctx.fillText(pausedLabel, labelRight, y);
      labelRight += ctx.measureText(pausedLabel).width;
    }
    if (micLabel) {
      ctx.fillStyle = rowColor;
      ctx.fillText(micLabel, labelRight, y);
      labelRight += ctx.measureText(micLabel).width;
    }
    if (rabbitLabel) {
      ctx.fillStyle = colorToCSS(player.rabbit.color);
      ctx.fillText(rabbitLabel, labelRight, y);
      labelRight += ctx.measureText(rabbitLabel).width;
    }
    if (huntLabel) {
      ctx.fillStyle = colorToCSS(SCOREBOARD_HUNT_COLOR);
      ctx.fillText(huntLabel, labelRight, y);
    }
    ctx.fillStyle = rowColor;
    ctx.textAlign = 'right';
    ctx.fillText(stats, contentRight, y);
    ctx.textAlign = 'left';
  });

  xrScoreboardPanel.texture.needsUpdate = true;
  xrScoreboardPanel.paintedVersion = model.version;
  xrScoreboardPanel.paintedRows = visiblePlayers.length + teamRows.length;
  placeXRScoreboardPanel();
}

// Where the panel hangs, which depends on how many rows it drew rather than on
// the model, so it can be re-applied on a frame that repainted nothing.
function placeXRScoreboardPanel() {
  const baseWidth = 0.36;
  const baseHeight = Math.min(0.36, 0.06 + (xrScoreboardPanel.paintedRows || 0) * 0.025);
  placeXRHudPanel(xrScoreboardPanel, {
    width: baseWidth,
    height: baseHeight,
    // Left-aligned with the chat panel below it, against the top of the box.
    x: -(XR_CHAT_PLANE_WIDTH / 2) + (baseWidth / 2),
    y: xrHudEdge(XR_HUD_ANGLE_UP) - (baseHeight / 2),
  });
}

const RADAR_WORLD_INSET_PX = 10;
const RADAR_EDGE_DOT_INSET_PX = 4;
const RADAR_TANK_ARROW_EXTENT_PX = 10;
// RadarRenderer::drawFlag and drawFlagOnTank size their crosses in world units
// with a pixel floor, so a distant flag stays visible at any radar range.
const RADAR_FLAG_MIN_HALF_PX = 3;
function radarFlagOnTankRadii() {
  return 2.5 * TANK.radius;
}
const RADAR_FLAG_ON_TANK_MIN_HALF_PX = 4;

function getRadarWorldHalfExtent(radius) {
  return Math.max(1, radius - RADAR_WORLD_INSET_PX);
}

function radarPixelsToWorldDistance(pixelDistance, radarDistance, radarWorldHalfExtent) {
  if (pixelDistance <= 0) return 0;
  const pixelsPerWorldUnit = radarWorldHalfExtent / Math.max(radarDistance, 1e-6);
  return pixelDistance / Math.max(pixelsPerWorldUnit, 1e-6);
}

// A world point (x, y) on the panel, relative to its centre at the player
// (px, py) and turned so the player's azimuth points up: x to the right, y
// down, as a canvas row runs.
//
// The azimuth is one value for the whole frame and this runs once per vertex
// of every obstacle in the map, so a caller that draws more than one thing
// hands its own sine and cosine in rather than paying for them again here.
function worldToRadarRelative(worldX, worldY, px, py, azimuth, azimuthCos, azimuthSin) {
  const dx = worldX - px;
  const dy = worldY - py;
  const cos = azimuthCos === undefined ? Math.cos(azimuth) : azimuthCos;
  const sin = azimuthSin === undefined ? Math.sin(azimuth) : azimuthSin;
  return { x: (dx * sin) - (dy * cos), y: 0 - ((dx * cos) + (dy * sin)) };
}

function radarRelativeToCanvas(radarX, radarY, center, radarWorldHalfExtent, radarDistance) {
  return {
    x: center + (radarX / radarDistance) * radarWorldHalfExtent,
    y: center + (radarY / radarDistance) * radarWorldHalfExtent,
  };
}

function world2Radar(worldX, worldY, px, py, azimuth, center, radius, shotDistance) {
  const rel = worldToRadarRelative(worldX, worldY, px, py, azimuth);
  return radarRelativeToCanvas(rel.x, rel.y, center, getRadarWorldHalfExtent(radius), shotDistance);
}

// RadarRenderer::colorScale and transScale. Anything at the player's own level
// is drawn at full strength and everything else fades with the altitude gap,
// over `RADAR_DEPTH_FACTOR` units and no further than its own floor. The two
// upstream functions differ only in that floor: objects stop at 0.35, the
// obstacles they stand on at 0.5.
const RADAR_DEPTH_FACTOR = 40;
const RADAR_OBJECT_DEPTH_FLOOR = 0.35;
const RADAR_OBSTACLE_DEPTH_FLOOR = 0.5;

function getRadarDepthScale(playerZ, base, height, floor) {
  const top = base + height;
  if (playerZ >= base && playerZ <= top) return 1;
  const gap = playerZ > top ? (playerZ - top) : (base - playerZ);
  return Math.max(floor, 1 - (gap / RADAR_DEPTH_FACTOR));
}

function getRadarOpacity(playerZ, base = 0, height = 0) {
  return getRadarDepthScale(playerZ, base, height, RADAR_OBSTACLE_DEPTH_FLOOR);
}

// A top-down panel should read like a height map: where two obstacles overlap,
// the higher surface is the one you are looking at, so the lowest are painted
// first. Upstream draws its boxes and then its pyramids in map order and lets a
// pyramid cover the base standing beside it, which is what made the ring of
// supports around a hix base look like it was on top of the base.
//
// Sorted once per map rather than per frame, keyed on the obstacle list itself.
let radarObstacleOrder = { source: null, list: [] };
let radarBaseList = { source: null, list: [] };

// The bases, drawn apart from the obstacles and after them: an outline in the
// team's own radar colour, as upstream's `RadarRenderer::renderBasesAndTeles`
// draws them (a `GL_LINE_LOOP` in `Team::getRadarColor`). Filled, a base hid
// the players and the flag on it, which is what a base is for. Unshaded and
// undimmed, as upstream's is -- an outline has no area to read as ground.
function getRadarBases() {
  if (radarBaseList.source !== OBSTACLES) {
    radarBaseList = {
      source: OBSTACLES,
      list: OBSTACLES
        .filter((obs) => obs.kind === 'base' && !obs.noRadar)
        .map((obs) => {
          const team = getTeamFromColorIndex(Number(obs.team));
          const color = team ? getPlayerTeamRadarColor(team) : null;
          return {
            obs,
            cullRadius: getRadarObstacleCullRadius(obs),
            stroke: Number.isFinite(color) ? colorToCSS(color) : RADAR_NEUTRAL_FILL,
          };
        }),
    };
  }
  return radarBaseList.list;
}

function getRadarObstacleTop(obs) {
  return getObstacleBase(obs) + getObstacleHeight(obs);
}

function getRadarObstacles() {
  if (radarObstacleOrder.source !== OBSTACLES) {
    radarObstacleOrder = {
      source: OBSTACLES,
      // A material's `noradar` flag (docs/bzw.md, "Materials and appearance")
      // -- upstream's RadarRenderer skips a face whose material asks for it;
      // bzo has no per-face radar drawing to skip, so the whole obstacle sits
      // out instead. A mesh draws through `getRadarMeshObstacles` below instead of
      // here -- it has no single footprint the way a box's `w`/`d` gives one.
      list: [...OBSTACLES]
        .filter((obs) => !obs.noRadar && obs.type !== 'mesh' && obs.kind !== 'base')
        .sort((left, right) => getRadarObstacleTop(left) - getRadarObstacleTop(right))
        .map((obs) => ({ obs, cullRadius: getRadarObstacleCullRadius(obs) })),
    };
  }
  return radarObstacleOrder.list;
}

// A mesh's own radar footprint -- upstream's own "enhanced" radar mode
// (RadarRenderer.cxx), the higher-quality one of its two ("bzo does not
// mirror BZFlag's client display options", AGENTS.md): each face draws for
// itself rather than the mesh as one shape, and only a face angled at least
// partly upward (`plane[1] > 0`, bzo's Y the same up axis upstream's Z is)
// draws at all from a plan view -- a vertical wall would draw edge-on as
// noise, not signal, the same reason upstream skips it. A face's own
// `noradar` (inherited from the mesh's own default, same as any other
// material property a face does not restate) drops it same as any other
// obstacle's. Sorted and cached the same way `getRadarObstacles` is.
// Grouped by the mesh rather than kept flat, because how much of a mesh is
// worth drawing is one decision for the whole of it -- see
// `RADAR_MESH_FOOTPRINT_PIXELS`. Every face of a mesh shares its top altitude,
// so sorting the meshes by that gives the same paint order a flat list sorted
// face by face did.
let radarMeshOrder = { source: null, list: [] };

// A mesh's drawn faces all share one colour where every one of them states the
// same, which is the colour its footprint can stand in with. Mixed, the panel's
// neutral grey is the only honest answer for a shape that is several colours.
function getRadarMeshFootprintTint(arrays, faces) {
  let tint = null;
  for (const { f } of faces) {
    const { color } = arrays.materials[arrays.faceMaterial[f]];
    if (!color) return null;
    if (!tint) tint = color;
    else if (color[0] !== tint[0] || color[1] !== tint[1] || color[2] !== tint[2]) {
      return null;
    }
  }
  return tint;
}

function getRadarMeshObstacles() {
  if (radarMeshOrder.source !== OBSTACLES) {
    const entries = [];
    let widestFace = 0;
    OBSTACLES.forEach((obs) => {
      if (obs.type !== 'mesh' || !obs.bounds) return;
      // Out of the mesh's flat arrays rather than a face object apiece
      // (issue #153). The panel keeps only faces that point upward and are
      // not `noradar`, both of which the arrays carry.
      const arrays = meshArrays(obs);
      const faces = [];
      for (let f = 0; f < arrays.faceCount; f += 1) {
        if (arrays.facePlanes[(f * 4) + 2] <= 0) continue;
        if (arrays.faceFlags[f] & FACE_NO_RADAR) continue;
        const cornerCount = arrays.faceStart[f + 1] - arrays.faceStart[f];
        widestFace = Math.max(widestFace, cornerCount);
        faces.push({ f, ...getRadarMeshFaceCull(obs, arrays, f) });
      }
      if (!faces.length) return;
      entries.push({
        obs,
        arrays,
        faces,
        footprintTint: getRadarMeshFootprintTint(arrays, faces),
        ...getRadarMeshObstacleCull(obs),
      });
    });
    // Sized for the widest face the map has, once, rather than growing the
    // scratch buffers part-way through a frame.
    ensureRadarPolygonBuffers((widestFace * 2) + 8);
    radarMeshOrder = {
      source: OBSTACLES,
      list: entries.sort((left, right) => left.obs.bounds.maxZ - right.obs.bounds.maxZ),
    };
  }
  return radarMeshOrder.list;
}

// The obstacles that never move, painted once into a world-space image and
// drawn each frame as that one image (#133). The only thing that changes the
// picture is the player's height, through `getRadarOpacity`: so the image is
// baked at one height and stays good while the player stays near it, and a
// player going up or down draws live until they have held a height long
// enough to bake again. A tank spends most of its life on the ground, so most
// frames are one `drawImage` however much map there is.
//
// Resolution is the panel's own pixels per world unit at the current zoom,
// oversampled because the image is turned with the heading every frame and
// resampling a texel per pixel would blur. Zoomed far enough in that the
// image would be too big, the live path draws instead -- and there it is
// already cheap, because nearly everything is outside the panel.
const RADAR_CACHE_OVERSAMPLE = 2;
const RADAR_CACHE_MAX_PIXELS = 2048;
// How long a height has to hold before it is worth baking at.
const RADAR_CACHE_SETTLE_MS = 250;
let radarObstacleCache = null;
// Frames drawn each way since the last `renderer.stats` line.
const radarCacheFrames = { cached: 0, live: 0, bakes: 0 };

function getRadarObstacleCache({ mapSize, pz, size, radarDistance, scale }) {
  const resolution = scale * RADAR_CACHE_OVERSAMPLE;
  const pixels = Math.ceil(mapSize * resolution);
  if (!(pixels > 0) || pixels > RADAR_CACHE_MAX_PIXELS) {
    radarCacheFrames.live += 1;
    return { ready: false, bakeNow: false };
  }
  const now = performance.now();
  let cache = radarObstacleCache;
  if (!cache || cache.source !== OBSTACLES || cache.mapSize !== mapSize
    || cache.size !== size || cache.radarDistance !== radarDistance) {
    const canvas = cache?.canvas || document.createElement('canvas');
    canvas.width = pixels;
    canvas.height = pixels;
    cache = {
      source: OBSTACLES,
      mapSize,
      size,
      radarDistance,
      canvas,
      ctx: canvas.getContext('2d'),
      resolution,
      bakedZ: NaN,
      lastZ: pz,
      stillSince: now,
    };
    radarObstacleCache = cache;
  }
  if (Math.abs(pz - cache.lastZ) > 1e-3) {
    cache.lastZ = pz;
    cache.stillSince = now;
  }
  // Half an opacity step of `addRadarFill`'s rounding, in height: within it,
  // a live paint would round to the same fill the image holds.
  const heightTolerance = (RADAR_DEPTH_FACTOR / RADAR_FILL_ALPHA_STEPS) / 2;
  if (Math.abs(pz - cache.bakedZ) <= heightTolerance) {
    radarCacheFrames.cached += 1;
    return { ready: true, canvas: cache.canvas };
  }
  radarCacheFrames.live += 1;
  const bakeNow = now - cache.stillSince >= RADAR_CACHE_SETTLE_MS;
  return {
    ready: false,
    bakeNow,
    canvas: cache.canvas,
    ctx: cache.ctx,
    resolution: cache.resolution,
    markBaked: () => {
      cache.bakedZ = pz;
      radarCacheFrames.bakes += 1;
    },
  };
}

// Team::getRadarColor is what upstream's radar draws a base in
// (RadarRenderer.cxx:1186), and bzo has the same table. That colour and the one
// a map paints an obstacle are both shaded towards the radar's neutral grey, so
// a coloured surface still reads as ground rather than as a tank.
const RADAR_NEUTRAL_FILL_RGB = [180, 180, 180];
const RADAR_TINT_STRENGTH = 0.65;
// A base's outline, in panel pixels. Upstream's is a one-pixel line on a panel
// a fraction the size of this one.
const RADAR_BASE_OUTLINE_WIDTH = 1.5;
const RADAR_NEUTRAL_FILL = `rgb(${RADAR_NEUTRAL_FILL_RGB.join(',')})`;

// How finely an obstacle's depth opacity is rounded before it decides whether
// the batched fill can keep going -- see `addRadarFill`.
const RADAR_FILL_ALPHA_STEPS = 32;

// How small a mesh has to be on the panel before its own footprint stands in
// for its faces. A mesh this wide has faces a pixel or two across, which the
// panel cannot tell apart from the outline around them -- and a map built out
// of a few `define` blocks placed a couple of hundred times puts tens of
// thousands of such faces on the panel at a wide zoom, each one a polygon the
// radar walks and fills for a pixel. It is bzo's own answer to what a map that
// ships `radarLods` would have answered for itself (#90): the detail a plan
// view cannot show is not drawn.
const RADAR_MESH_FOOTPRINT_PIXELS = 10;

// And how small one face of a mesh too big to collapse has to be before it is
// left out. A polygon narrower than a pixel cannot draw a pixel: it tints one,
// faintly, under whatever its neighbours put there. Measured on
// `import-xs.bzexcess.com_5155.bzw` at the widest range, 2160 of the 7429
// faces that survive the footprint test are this small, and they are the
// interior detail of structures whose own large faces draw the shape either
// way.
const RADAR_FACE_MIN_PIXELS = 1;

// Channels are 0 to 1, as the colour a map states is.
function getRadarShadedFill(red, green, blue) {
  const shade = (value, neutral) => Math.round(
    (neutral * (1 - RADAR_TINT_STRENGTH))
    + (Math.max(0, Math.min(1, value)) * 0xff * RADAR_TINT_STRENGTH)
  );
  const [neutralRed, neutralGreen, neutralBlue] = RADAR_NEUTRAL_FILL_RGB;
  return `rgb(${shade(red, neutralRed)},${shade(green, neutralGreen)},${shade(blue, neutralBlue)})`;
}

// Cached by the colour rather than by the obstacle: a map that paints fifty
// pads one colour cuts one string, and a colour means the same fill whatever
// map it came from.
const radarTintFills = new Map();

function getRadarTintFill(tint) {
  const key = `${tint[0]},${tint[1]},${tint[2]}`;
  const cached = radarTintFills.get(key);
  if (cached) return cached;
  const fill = getRadarShadedFill(tint[0], tint[1], tint[2]);
  radarTintFills.set(key, fill);
  return fill;
}

// An obstacle takes the colour its map painted it, if it painted one. The cap
// first: the radar looks down. A base is not filled at all (`getRadarBases`).
function getObstacleRadarFillStyle(obs) {
  if (!obs) return RADAR_NEUTRAL_FILL;
  const tint = obs.capColor || obs.wallColor;
  return tint ? getRadarTintFill(tint) : RADAR_NEUTRAL_FILL;
}

// A blip the player is looking for is ringed: a hunted tank, the player's own
// team flags, and the antidote. Upstream rings none of the three. It marks the
// hunted tank by flashing its blip cyan every fifth of a second
// (RadarRenderer.cxx:136), and it leaves the two flag bearings to the heading
// tape (prepareTheHUD, playing.cxx:6820), which an immersive session has no room
// for.
//
// A ring rather than a flash: a flash is half invisible on a client running at a
// low frame rate, which is the client bzo has to draw for.
//
// The hunted ring is upstream's own hunt cyan, because its blip is one of a
// panel full of per-player colours and grey is the one shade that does not read
// against a dark panel. A flag's ring takes the colour of the cross it rings,
// which is already the team's or the antidote's yellow, so a second colour would
// say nothing the cross does not.
//
// XR needs no separate path: the XR radar panel is textured from this canvas.
//
// The cyan itself lives in `hunt.mjs`, because the scoreboard's bullseye wears
// it too and a second literal is how the two would eventually disagree.
const RADAR_HUNT_RING_COLOR = colorToCSS(HUNT_MARKER_COLOR);
// The antidote's yellow as a style, cut once. Every other flag colour on the
// panel goes through `getFlagRadarStyle`'s cache for the same reason: the radar
// is redrawn every frame on a client with one core to spend.
const ANTIDOTE_FLAG_STYLE = colorToCSS(ANTIDOTE_FLAG_COLOR);
const RADAR_MARKER_RING_RADIUS = 9;
const RADAR_MARKER_RING_WIDTH = 1.5;
// Clear air between a ringed cross and its ring, for the zoom levels where the
// cross is sized in world units and has grown past the default radius.
const RADAR_MARKER_RING_GAP = 3;

// RadarRenderer::drawTank's height box: a diamond round the tank that grows
// with its height over the world's `_boxHeight`, half again as wide at one box
// up, so a tank on a building reads as one (RadarRenderer.cxx:204). Upstream
// starts it at the tank's own blip size, as this does at its arrow's; a tank
// below the ground starts it small. Drawn in the tank's own frame, which is
// screen-aligned here, as upstream's is.
const RADAR_HEIGHT_BOX_BURROWED_PX = 3;
function drawRadarHeightBox(height, style) {
  const boxHeight = gameConfig?.BOX_HEIGHT > 0 ? gameConfig.BOX_HEIGHT : 6.0 * 1.57;
  const y = Number.isFinite(height) ? height : 0;
  const base = y < 0 ? RADAR_HEIGHT_BOX_BURROWED_PX : RADAR_TANK_ARROW_EXTENT_PX;
  const half = Math.max(1, base * (1 + (0.5 * (y / boxHeight))));
  radarCtx.save();
  radarCtx.strokeStyle = style;
  radarCtx.lineWidth = 1;
  radarCtx.globalAlpha = 0.9;
  radarCtx.beginPath();
  radarCtx.moveTo(-half, 0);
  radarCtx.lineTo(0, -half);
  radarCtx.lineTo(half, 0);
  radarCtx.lineTo(0, half);
  radarCtx.closePath();
  radarCtx.stroke();
  radarCtx.restore();
}

function drawRadarMarkerRing(x, y, style, radius = RADAR_MARKER_RING_RADIUS) {
  radarCtx.save();
  radarCtx.globalAlpha = 1;
  radarCtx.lineWidth = RADAR_MARKER_RING_WIDTH;
  radarCtx.strokeStyle = style;
  radarCtx.beginPath();
  radarCtx.arc(x, y, radius, 0, Math.PI * 2);
  radarCtx.stroke();
  radarCtx.restore();
}

// SegmentedShotStrategy::radarRender (SegmentedShotStrategy.cxx:329) draws a
// bolt as a line along its own velocity rather than a dot, so the panel says
// which way a shot is going and not just where it is. The line runs forward
// from the shot -- upstream's `leadingShotLine` default of 1, the one that
// shows where the shot will be rather than where it has been.
//
// Its length is `_shotTailLength * linedradarshots`, and upstream's defaults
// are 4.0 and 5. That is a world distance, not a pixel one, so the line grows
// and shrinks with the radar's range exactly as the map under it does.
const RADAR_SHOT_LINE_TAIL_MULTIPLIER = 5;
const RADAR_SHOT_LINE_TAIL_LENGTH_DEFAULT = 4.0;
// A guided missile draws a longer line than anything else. Upstream draws every
// shot's the same length -- `GuidedMissileStrategy::radarRender` is the
// segmented one's line word for word -- but a missile is the one shot whose
// direction is a live answer rather than a fixed one, and the one shot you most
// need to read off the panel in the second you have to turn away from it. The
// extra third is enough to pick it out of a crowded panel without making it the
// only thing on there.
const RADAR_SHOT_LINE_GM_FACTOR = 1.3;
const RADAR_SHOT_LINE_WIDTH = 2;
// Upstream's "bright bullet tip": `sizedradarshots` pixels of grey 0.75 at the
// shot's own position, drawn over the line's near end. It is deliberately not
// the shot's colour -- the line carries that, and a tip brighter than its line
// is what picks the shot itself out of the streak it is drawing.
const RADAR_SHOT_TIP_SIZE = 4;
const RADAR_SHOT_TIP_COLOR = 'rgb(191,191,191)';

// RadarRenderer::render's noise branch (RadarRenderer.cxx:433). Upstream paints a
// noise texture over the whole panel at full white and draws nothing else, so the
// radar is gone rather than dimmed -- "Radar doesn't work" is the flag's own help
// text. bzo has no noise texture, so the static is generated: one greyscale value
// per cell of a coarse grid, which reads as static at radar size and costs a few
// hundred fills rather than a texture upload.
//
// XR needs no separate path. The XR radar panel is textured from this very
// canvas, so whatever lands here lands in the headset on the same frame.
const RADAR_JAM_CELL = 4;
// The panel the working radar sits on: a half-transparent black square at 95%,
// so about 47% of the world behind it shows through. Named because the jammed
// frames are tied to it.
const RADAR_PANEL_FILL_ALPHA = 0.5;
const RADAR_PANEL_GLOBAL_ALPHA = 0.95;
const RADAR_PANEL_BORDER = 'rgba(76, 175, 80, 0.65)';

// Upstream's noise is opaque, and it can afford to be: its radar owns a region of
// the screen outside the 3D viewport, so covering it costs the view nothing. bzo's
// radar floats *over* the 3D view, where opaque static would take away part of
// what the flag explicitly leaves you -- "Radar doesn't work.  Can still see."
//
// So a jammed frame replaces the panel background rather than covering it, at the
// same alpha the background would have had. The jammed panel is then exactly as
// heavy as a working one: no more of the world is hidden while jammed than the
// radar hides anyway, and the panel does not visibly change weight as static and
// good frames alternate.
const RADAR_JAM_STATIC_ALPHA = RADAR_PANEL_FILL_ALPHA * RADAR_PANEL_GLOBAL_ALPHA;
let radarJamDecay = RADAR_JAM_DECAY_MIN;

function drawRadarPanelBorder(size) {
  radarCtx.strokeStyle = RADAR_PANEL_BORDER;
  radarCtx.lineWidth = Math.max(2, Math.round(size * 0.01));
  radarCtx.strokeRect(0, 0, size, size);
}

function drawRadarPanelBackground(size) {
  radarCtx.clearRect(0, 0, size, size);
  radarCtx.save();
  radarCtx.globalAlpha = RADAR_PANEL_GLOBAL_ALPHA;
  radarCtx.fillStyle = `rgba(0,0,0,${RADAR_PANEL_FILL_ALPHA})`;
  radarCtx.fillRect(0, 0, size, size);
  drawRadarPanelBorder(size);
  radarCtx.restore();
}

function drawJammedRadar(size) {
  radarCtx.clearRect(0, 0, size, size);
  radarCtx.save();
  radarCtx.globalAlpha = RADAR_JAM_STATIC_ALPHA;
  for (let y = 0; y < size; y += RADAR_JAM_CELL) {
    for (let x = 0; x < size; x += RADAR_JAM_CELL) {
      const level = Math.floor(Math.random() * 256);
      radarCtx.fillStyle = `rgb(${level},${level},${level})`;
      radarCtx.fillRect(x, y, RADAR_JAM_CELL, RADAR_JAM_CELL);
    }
  }
  radarCtx.restore();
  // Outside the static's alpha, so the frame stays as crisp as it is on a good
  // frame and the panel keeps its edge while jammed.
  radarCtx.save();
  drawRadarPanelBorder(size);
  radarCtx.restore();
}

// The world's `_radarLimit`: none means upstream's default, the world's size.
function worldRadarLimit() {
  return Number.isFinite(gameConfig?.RADAR_LIMIT) ? gameConfig.RADAR_LIMIT : (currentWorldMapSize ?? DEFAULT_MAP_SIZE);
}

function updateRadar() {
  if (!radarCtx || !myTank || !gameConfig) return;
  // Declare radar variables only once
  const size = radarCanvas.width;
  // RadarRenderer::render: a world with a radar limit of 0 or less -- upstream's
  // `-noradar` -- has no radar for anyone (RadarRenderer.cxx:377).
  const radarLimit = worldRadarLimit();
  radarCanvas.style.visibility = radarLimit > 0 ? '' : 'hidden';
  if (!(radarLimit > 0)) return;

  // `bzfrand() > decay` is upstream's roll, and the decay it leaves behind is
  // what makes a jammed radar break through for a frame or two at a time rather
  // than flicker evenly. Kept out of the flags pair only in its randomness: the
  // decay rule itself is shared, so both copies agree on the cadence.
  if (isRadarJammed()) {
    const showNoise = Math.random() > radarJamDecay;
    radarJamDecay = getNextRadarJamDecay(radarJamDecay, showNoise);
    if (showNoise) {
      drawJammedRadar(size);
      return;
    }
  } else if (radarJamDecay !== RADAR_JAM_DECAY_MIN) {
    radarJamDecay = RADAR_JAM_DECAY_MIN;
  }
  const center = size / 2;
  const radius = center * 0.95;
  const radarWorldHalfExtent = getRadarWorldHalfExtent(radius);
  // RadarRenderer::render (RadarRenderer.cxx:400): the range is the zoom times
  // the world's radar limit, and never past the limit -- a quarter of it while
  // burrowed, "when burrowed, limit radar range". Upstream caps the range rather
  // than scaling it, so a player already zoomed further in than the cap keeps
  // their own setting, and gets it back untouched on surfacing.
  const burrowed = (getMyFlag()?.type ?? null) === 'BU' && myTank.position.z < 0;
  const maxRange = burrowed ? radarLimit * BURROW_RADAR_FACTOR : radarLimit;
  const radarDistance = Math.min(radarLimit * radarZoomLevel, maxRange);
  const tankArrowWorldMargin = radarPixelsToWorldDistance(
    RADAR_TANK_ARROW_EXTENT_PX,
    radarDistance,
    radarWorldHalfExtent
  );
  // A Map Viewer preview's own size (issue #68), not the live match's --
  // see currentWorldMapSize.
  const mapSize = currentWorldMapSize ?? DEFAULT_MAP_SIZE;
  // Where the player is and which way they face.
  const px = myTank.position.x;
  const py = myTank.position.y;
  const pz = myTank.position.z;
  const azimuth = tankAzimuth(myTank);
  // One pair for the whole panel. The obstacle and mesh-face loops below run
  // over every obstacle in the map at four or more vertices each, and a sine
  // and a cosine per vertex is thousands of them for one value that does not
  // change inside a frame.
  const azimuthCos = Math.cos(azimuth);
  const azimuthSin = Math.sin(azimuth);
  const toRadarRelative = (worldX, worldY) => worldToRadarRelative(
    worldX,
    worldY,
    px,
    py,
    azimuth,
    azimuthCos,
    azimuthSin,
  );
  const radarToCanvas = (radarX, radarY) => radarRelativeToCanvas(
    radarX,
    radarY,
    center,
    radarWorldHalfExtent,
    radarDistance,
  );
  const isOutsideRadarSquare = (radarX, radarY, margin = 0) => (
    isOutsideRadarSquareOf(radarX, radarY, radarDistance, margin)
  );
  // Refreshed each time it is read: `clipPolygonToRadarSquare` grows the
  // buffers to fit the widest polygon it is handed, and a grow replaces them.
  const radarPolygonScratch = () => getRadarPolygonScratch();

  // One `fill()` a colour rather than one an obstacle, which is the same trade
  // a batched draw makes against a per-primitive one: the panel repaints every
  // frame over every obstacle in the map, and on a large one the call overhead
  // outweighs the filling.
  //
  // The order obstacles paint in is load-bearing -- a higher surface has to
  // cover the lower one it overlaps, which is what the altitude sort above is
  // for -- so this coalesces *runs* of neighbours that share a fill rather than
  // gathering the whole list by colour. The sequence is exactly what it was.
  // The sort is by top altitude, so neighbours mostly share an opacity too, and
  // most of a map wears the one neutral grey.
  //
  // Two obstacles inside one run that overlap fill as their union, once, so a
  // partly transparent overlap does not darken at the seam. The panel reads as
  // a height map off the sort, and a doubled patch says nothing the sort does
  // not.
  let radarFillPath = null;
  let radarFillStyle = '';
  let radarFillAlpha = -1;
  // Where fills land and how a radar-relative unit becomes a pixel there: the
  // panel itself, or the world-space cache `paintRadarObstacleLayer` bakes.
  let fillTarget = { ctx: radarCtx, offset: center, scale: radarWorldHalfExtent / radarDistance };
  const flushRadarFills = () => {
    if (!radarFillPath) return;
    const { ctx } = fillTarget;
    ctx.globalAlpha = radarFillAlpha;
    ctx.fillStyle = radarFillStyle;
    ctx.fill(radarFillPath);
    ctx.globalAlpha = 1;
    radarFillPath = null;
  };
  // `polygon` is a flat `x, y` buffer in radar-relative units, as the clip
  // leaves it.
  const addRadarFill = (polygon, count, fillStyle, opacity) => {
    // Quantised so a run is not broken by a difference the panel cannot show:
    // the depth scale spans 0.5 to 1, and a thirty-secondth of that is well
    // under what a two-hundred-pixel panel resolves.
    const alpha = Math.round(opacity * RADAR_FILL_ALPHA_STEPS) / RADAR_FILL_ALPHA_STEPS;
    if (radarFillPath && (fillStyle !== radarFillStyle || alpha !== radarFillAlpha)) {
      flushRadarFills();
    }
    if (!radarFillPath) {
      radarFillPath = new Path2D();
      radarFillStyle = fillStyle;
      radarFillAlpha = alpha;
    }
    const { offset, scale } = fillTarget;
    for (let i = 0; i < count; i += 1) {
      const panelX = offset + (polygon[i * 2] * scale);
      const panelY = offset + (polygon[(i * 2) + 1] * scale);
      if (i === 0) radarFillPath.moveTo(panelX, panelY);
      else radarFillPath.lineTo(panelX, panelY);
    }
    radarFillPath.closePath();
  };
  // Something past radar range is pinned to the border of the panel in its own
  // direction, which is bzo's own -- upstream's radar simply stops at its range.
  // The direction is preserved rather than the distance, so the marker sits on
  // the side the thing is on and never mirrors. Null for a direction with no
  // length, which is something standing exactly where the player is.
  const projectToRadarEdge = (radarX, radarY) => {
    const len = Math.hypot(radarX, radarY);
    if (len < 1e-6) return null;
    const nx = radarX / len;
    const ny = radarY / len;
    const halfExtent = Math.max(1, (size / 2) - RADAR_EDGE_DOT_INSET_PX);
    const denom = Math.max(Math.abs(nx), Math.abs(ny), 1e-6);
    return {
      x: center + (nx / denom) * halfExtent,
      y: center + (ny / denom) * halfExtent,
    };
  };
  drawRadarPanelBackground(size);


  // Draw world border (clip to radar distance area, rotated to player forward)
  if (mapSize) {
    radarCtx.save();
    radarCtx.globalAlpha = 0.7;
    // Calculate visible world border segment within radar distance
    const border = mapSize / 2;
    const west = Math.max(px - radarDistance, -border);
    const east = Math.min(px + radarDistance, border);
    const north = Math.min(py + radarDistance, border);
    const south = Math.max(py - radarDistance, -border);
    // One edge, dashed from world coordinates so the dashes stay put as the
    // player moves.
    const drawEdge = (x1, y1, x2, y2, color, dashOffset) => {
      const p1 = world2Radar(x1, y1, px, py, azimuth, center, radius, radarDistance);
      const p2 = world2Radar(x2, y2, px, py, azimuth, center, radius, radarDistance);
      radarCtx.save();
      radarCtx.strokeStyle = color;
      radarCtx.lineWidth = 2.5;
      radarCtx.setLineDash([6, 6]);
      radarCtx.lineDashOffset = dashOffset;
      radarCtx.beginPath();
      radarCtx.moveTo(p1.x, p1.y);
      radarCtx.lineTo(p2.x, p2.y);
      radarCtx.stroke();
      radarCtx.restore();
    };
    if (north === border) drawEdge(west, border, east, border, '#B20000', west * 2);
    if (south === -border) drawEdge(west, -border, east, -border, '#1976D2', west * 2);
    if (west === -border) drawEdge(-border, north, -border, south, '#9C27B0', -north * 2);
    if (east === border) drawEdge(border, north, border, south, '#388E3C', -north * 2);
    radarCtx.restore();
  }

  // Draw cardinal direction letters (N/E/S/W) at border, facing outward,
  // rotating with the map. Each at its own azimuth: the panel turns a
  // direction `a` to `azimuth - a` clockwise from up.
  const cardinalLabels = [
    { angle: Math.PI / 2, label: 'N', color: '#B20000' },
    { angle: 0, label: 'E', color: '#388E3C' },
    { angle: -Math.PI / 2, label: 'S', color: '#1976D2' },
    { angle: Math.PI, label: 'W', color: '#9C27B0' },
  ];
  cardinalLabels.forEach(dir => {
    radarCtx.save();
    radarCtx.translate(center, center);
    // Rotate with the map/radar, so compass turns as player turns
    radarCtx.rotate(azimuth - dir.angle);
    radarCtx.textAlign = 'center';
    radarCtx.textBaseline = 'middle';
    radarCtx.font = `bold ${Math.round(radius * 0.22)}px sans-serif`;
    radarCtx.fillStyle = dir.color;
    radarCtx.strokeStyle = '#222';
    radarCtx.lineWidth = 3;
    // Place letter on a slightly larger circle so cardinal letters clip at square edges.
    const labelRadius = radius + Math.max(2, Math.round(size * 0.015));
    radarCtx.save();
    radarCtx.translate(0, -labelRadius);
    // Keep letters upright (vertical) at top
    radarCtx.rotate(dir.angle - azimuth);
    radarCtx.strokeText(dir.label, 0, 0);
    radarCtx.fillText(dir.label, 0, 0);
    radarCtx.restore();
    radarCtx.restore();
  });

  // The obstacles, painted through one routine whatever they land on. `view`
  // is the frame a world point is measured in -- the player's, turned to the
  // heading, for the panel; the world's own for the cache -- and the square
  // it is clipped and culled against. `spinning` says which meshes this pass
  // owns: a spinning one turns every frame, so the cache leaves it out and the
  // panel draws it live over the cached image.
  const paintRadarObstacleLayer = (view, spinning) => {
    const { ox, oy, cos: viewCos, sin: viewSin, half } = view;
    // `worldToRadarRelative` for this view, and the same turn for an offset.
    const turnX = (dx, dy) => (dx * viewSin) - (dy * viewCos);
    const turnY = (dx, dy) => 0 - ((dx * viewCos) + (dy * viewSin));
    const relative = (worldX, worldY) => {
      const dx = worldX - ox;
      const dy = worldY - oy;
      return { x: turnX(dx, dy), y: turnY(dx, dy) };
    };
    const outside = (x, y, margin) => isOutsideRadarSquareOf(x, y, half, margin);

    if (spinning !== 'only') {
      getRadarObstacles().forEach(({ obs, cullRadius }) => {
        const centerRel = relative(obs.pos[0], obs.pos[1]);
        // The whole footprint against the square, so a long obstacle whose
        // centre is off it still draws the span of it that is on -- see
        // `getRadarObstacleCullRadius`. Ahead of the corner work rather than
        // after it, which is the point: on a large map most of the list is out
        // of range and costs one comparison rather than a clipped polygon.
        if (outside(centerRel.x, centerRel.y, cullRadius)) return;

        const halfW = obs.size ? obs.size[0] : 4;
        const halfD = obs.size ? obs.size[1] : 4;
        const cosA = Math.cos(obs.angle || 0);
        const sinA = Math.sin(obs.angle || 0);
        const scratch = radarPolygonScratch();
        for (let i = 0; i < 4; i += 1) {
          const localX = RADAR_BOX_CORNERS[i * 2] * halfW;
          const localY = RADAR_BOX_CORNERS[(i * 2) + 1] * halfD;
          const dx = (localX * cosA) - (localY * sinA);
          const dy = (localX * sinA) + (localY * cosA);
          scratch[i * 2] = centerRel.x + turnX(dx, dy);
          scratch[(i * 2) + 1] = centerRel.y + turnY(dx, dy);
        }
        const clippedCount = clipPolygonToRadarSquare(scratch, 4, half);
        if (clippedCount < 3) return;

        // Opacity from the player's height against the obstacle's span.
        addRadarFill(
          getRadarClipBuffer(),
          clippedCount,
          getObstacleRadarFillStyle(obs),
          getRadarOpacity(pz, getObstacleBase(obs), getObstacleHeight(obs)),
        );
      });
    }

    // A mesh's own upward-facing faces -- see `getRadarMeshObstacles`. Each
    // face's own vertices are already in world space (no obstacle rotation to
    // apply, unlike a box), so this projects them directly rather than
    // rotating a local rectangle the way the obstacle loop above does -- unless
    // the mesh itself has an `angvel` (#88), in which case its faces are
    // rotated live about its own `spinPivot` first, the flat equivalent of
    // `renderManager`'s own turn about z on that mesh's 3D pivot group
    // (`meshSpinRadians` is the one shared formula both read).
    //
    // A mesh too small on the panel for its faces to separate draws its
    // footprint instead -- see `RADAR_MESH_FOOTPRINT_PIXELS`. The footprint is
    // the same world-space box, so a spin turns it the same way a face turns.
    // The test is in panel pixels at the current zoom whichever target this
    // is, so the cache keeps exactly the detail the panel would draw.
    const worldToPanelPixels = radarWorldHalfExtent / radarDistance;
    getRadarMeshObstacles().forEach((entry) => {
      const { obs, arrays, faces, footprint, footprintTint, cullX, cullY, cullRadius } = entry;
      const spins = Boolean(obs.angvel && obs.spinPivot);
      if ((spinning === 'skip' && spins) || (spinning === 'only' && !spins)) return;
      // Same rejection as the obstacle loop, on the circle the cached list
      // carries for this mesh -- a spinning one's is centred on the pivot, so
      // it holds whatever angle the mesh is at this frame.
      const cullRel = relative(cullX, cullY);
      if (outside(cullRel.x, cullRel.y, cullRadius)) return;

      const spinAngle = spins ? meshSpinRadians(obs.angvel) : 0;
      const spinCos = Math.cos(spinAngle);
      const spinSin = Math.sin(spinAngle);
      // A tipped spin (#168) turns about a tilted axis, so the point's height
      // feeds its flat position: Rodrigues about `spinAxis`, then dropped to
      // x/y like every other radar point. A down-pointing vertical axis is
      // the same turn the other way.
      const pivot = obs.spinPivot;
      const tippedAxis = spinAngle && isTippedRadarSpin(obs) ? obs.spinAxis : null;
      const flatSin = obs.spinAxis && obs.spinAxis.z < 0 ? -spinSin : spinSin;
      // Projects one world point into the scratch buffer at `slot`, spinning
      // it about the mesh's pivot first where the mesh turns.
      const project = (scratch, slot, worldX, worldY, worldZ = pivot ? pivot.z : 0) => {
        let spunX = worldX;
        let spunY = worldY;
        if (tippedAxis) {
          const offX = worldX - pivot.x;
          const offY = worldY - pivot.y;
          const offZ = worldZ - pivot.z;
          const { x: ax, y: ay, z: az } = tippedAxis;
          const dot = ((ax * offX) + (ay * offY) + (az * offZ)) * (1 - spinCos);
          spunX = pivot.x + (offX * spinCos) + (((ay * offZ) - (az * offY)) * spinSin) + (ax * dot);
          spunY = pivot.y + (offY * spinCos) + (((az * offX) - (ax * offZ)) * spinSin) + (ay * dot);
        } else if (spinAngle) {
          const offsetX = worldX - pivot.x;
          const offsetY = worldY - pivot.y;
          spunX = pivot.x + (offsetX * spinCos) - (offsetY * flatSin);
          spunY = pivot.y + (offsetX * flatSin) + (offsetY * spinCos);
        }
        const dx = spunX - ox;
        const dy = spunY - oy;
        scratch[slot * 2] = turnX(dx, dy);
        scratch[(slot * 2) + 1] = turnY(dx, dy);
      };

      // A single face has no height of its own to speak of -- upstream's own
      // `BZDBCache::useMeshForRadar` fallback for exactly this, using the
      // whole mesh's own vertical span instead of one infinitely thin face.
      // The footprint reads the same figure, being the same mesh.
      const opacity = getRadarOpacity(pz, obs.bounds.minZ, obs.bounds.maxZ - obs.bounds.minZ);

      if ((cullRadius * 2 * worldToPanelPixels) < RADAR_MESH_FOOTPRINT_PIXELS) {
        const scratch = radarPolygonScratch();
        for (let i = 0; i < 4; i += 1) {
          project(scratch, i, footprint[i * 2], footprint[(i * 2) + 1]);
        }
        const clippedCount = clipPolygonToRadarSquare(scratch, 4, half);
        if (clippedCount < 3) return;
        addRadarFill(
          getRadarClipBuffer(),
          clippedCount,
          footprintTint ? getRadarTintFill(footprintTint) : RADAR_NEUTRAL_FILL,
          opacity,
        );
        return;
      }

      faces.forEach(({ f, cullRadius: faceRadius }) => {
        if ((faceRadius * 2 * worldToPanelPixels) < RADAR_FACE_MIN_PIXELS) return;
        const start = arrays.faceStart[f];
        const vertexCount = arrays.faceStart[f + 1] - start;
        const scratch = radarPolygonScratch();
        for (let i = 0; i < vertexCount; i += 1) {
          const v = arrays.corners[start + i] * 3;
          project(scratch, i, arrays.vertices[v], arrays.vertices[v + 1], arrays.vertices[v + 2]);
        }

        const clippedCount = clipPolygonToRadarSquare(scratch, vertexCount, half);
        if (clippedCount < 3) return;

        const { color } = arrays.materials[arrays.faceMaterial[f]];
        addRadarFill(
          getRadarClipBuffer(),
          clippedCount,
          color ? getRadarTintFill(color) : RADAR_NEUTRAL_FILL,
          opacity,
        );
      });
    });
    flushRadarFills();
  };

  const panelView = {
    ox: px, oy: py, cos: azimuthCos, sin: azimuthSin, half: radarDistance,
  };
  if (typeof OBSTACLES !== 'undefined' && Array.isArray(OBSTACLES)) {
    const cache = getRadarObstacleCache({
      mapSize, pz, size, radarDistance, scale: radarWorldHalfExtent / radarDistance,
    });
    if (cache.ready) {
      // One image for every obstacle that does not move: the world-space bake,
      // north up, turned and placed the way the panel's own projection would
      // put each polygon, clipped to the square the live path clips to. The
      // image holds (x, -y), so the player is at (px, -py) on it.
      const k = radarWorldHalfExtent / radarDistance;
      const halfMap = mapSize / 2;
      radarCtx.save();
      radarCtx.beginPath();
      radarCtx.rect(center - radarWorldHalfExtent, center - radarWorldHalfExtent,
        radarWorldHalfExtent * 2, radarWorldHalfExtent * 2);
      radarCtx.clip();
      radarCtx.translate(center, center);
      radarCtx.scale(k, k);
      radarCtx.rotate(azimuth - (Math.PI / 2));
      radarCtx.translate(-px, py);
      radarCtx.drawImage(cache.canvas, -halfMap, -halfMap, mapSize, mapSize);
      radarCtx.restore();
      paintRadarObstacleLayer(panelView, 'only');
    } else {
      paintRadarObstacleLayer(panelView, 'all');
      if (cache.bakeNow) {
        // Painted in the world's own frame, north up: no player offset, the
        // map's whole square, a pixel per `cache.resolution` world units.
        const target = fillTarget;
        fillTarget = { ctx: cache.ctx, offset: (mapSize / 2) * cache.resolution, scale: cache.resolution };
        cache.ctx.clearRect(0, 0, cache.canvas.width, cache.canvas.height);
        paintRadarObstacleLayer({ ox: 0, oy: 0, cos: 0, sin: 1, half: mapSize / 2 }, 'skip');
        fillTarget = target;
        cache.markBaked();
      }
    }
  }

  // The bases over the obstacles, as outlines -- see `getRadarBases`. Clipped
  // to the panel rather than polygon-clipped, so a base half off the edge does
  // not draw the edge as part of its outline.
  const radarBases = typeof OBSTACLES !== 'undefined' && Array.isArray(OBSTACLES) ? getRadarBases() : [];
  if (radarBases.length) {
    radarCtx.save();
    radarCtx.beginPath();
    radarCtx.rect(center - radarWorldHalfExtent, center - radarWorldHalfExtent,
      radarWorldHalfExtent * 2, radarWorldHalfExtent * 2);
    radarCtx.clip();
    radarCtx.lineWidth = RADAR_BASE_OUTLINE_WIDTH;
    radarCtx.lineJoin = 'miter';
    for (const { obs, cullRadius, stroke } of radarBases) {
      const centerRel = toRadarRelative(obs.pos[0], obs.pos[1]);
      if (isOutsideRadarSquare(centerRel.x, centerRel.y, cullRadius)) continue;
      const halfW = obs.size ? obs.size[0] : 4;
      const halfD = obs.size ? obs.size[1] : 4;
      const cosA = Math.cos(obs.angle || 0);
      const sinA = Math.sin(obs.angle || 0);
      radarCtx.beginPath();
      for (let i = 0; i < 4; i += 1) {
        const localX = RADAR_BOX_CORNERS[i * 2] * halfW;
        const localY = RADAR_BOX_CORNERS[(i * 2) + 1] * halfD;
        const corner = toRadarRelative(
          obs.pos[0] + (localX * cosA) - (localY * sinA),
          obs.pos[1] + (localX * sinA) + (localY * cosA),
        );
        const relX = corner.x;
        const relY = corner.y;
        const panelX = center + ((relX / radarDistance) * radarWorldHalfExtent);
        const panelY = center + ((relY / radarDistance) * radarWorldHalfExtent);
        if (i === 0) radarCtx.moveTo(panelX, panelY);
        else radarCtx.lineTo(panelX, panelY);
      }
      radarCtx.closePath();
      radarCtx.strokeStyle = stroke;
      radarCtx.stroke();
    }
    radarCtx.restore();
  }

  // Draw projectiles (shots) within radar distance
  const shotRadarColorOf = (proj) => proj.userData?.radarColor || '#FFD700';
  // One length for the whole panel: it comes off the server's `_shotTailLength`
  // and cannot change inside a frame.
  const shotTailLength = Number.isFinite(gameConfig.SHOT_TAIL_LENGTH)
    ? gameConfig.SHOT_TAIL_LENGTH
    : RADAR_SHOT_LINE_TAIL_LENGTH_DEFAULT;
  const shotLineWorldLength = shotTailLength * RADAR_SHOT_LINE_TAIL_MULTIPLIER;
  if (typeof projectiles !== 'undefined' && projectiles.forEach) {
    projectiles.forEach((proj) => {
      // RadarRenderer.cxx:664. An Invisible Bullet is drawn on its owner's radar
      // and nobody else's -- upstream sweeps its own shots (:585) before it asks
      // the question at all. Seer is the exception, below.
      // RadarRenderer.cxx:665's `iSeeAll`: Seer puts invisible bullets back on
      // the radar, so a seer is the counter to an invisible shooter.
      if (
        proj.userData?.hiddenOnRadar
        && proj.userData.playerId !== myPlayerId
        && !isSeer()
      ) return;
      // ShockWaveStrategy::radarRender draws a circle of the current radius, as
      // its scene node is a sphere of it out the window. The radar's world-to-
      // canvas scale is uniform, so the radius scales with it.
      const projAt = proj.position;
      if (proj.userData?.shockwave) {
        const rel = toRadarRelative(projAt.x, projAt.y);
        const waveRadius = Number.isFinite(proj.userData.shockWaveRadius)
          ? proj.userData.shockWaveRadius
          : 0;
        if (isOutsideRadarSquare(rel.x, rel.y, waveRadius)) return;
        const pos = radarToCanvas(rel.x, rel.y);
        const panelRadius = (waveRadius / radarDistance) * radarWorldHalfExtent;
        if (panelRadius <= 0) return;
        radarCtx.save();
        radarCtx.strokeStyle = shotRadarColorOf(proj);
        radarCtx.globalAlpha = 0.85;
        radarCtx.lineWidth = 2;
        radarCtx.beginPath();
        radarCtx.arc(pos.x, pos.y, panelRadius, 0, Math.PI * 2);
        radarCtx.stroke();
        radarCtx.restore();
        return;
      }
      // A beam is a line on the radar, as its scene node is out the window. Its
      // segments are each two points.
      if (proj.userData?.beam) {
        const segments = proj.userData.segments || [];
        if (segments.length === 0) return;
        radarCtx.save();
        radarCtx.strokeStyle = shotRadarColorOf(proj);
        radarCtx.globalAlpha = 0.85;
        radarCtx.lineWidth = 2;
        radarCtx.beginPath();
        for (const segment of segments) {
          const fromRel = toRadarRelative(segment.from.x, segment.from.y);
          const toRel = toRadarRelative(segment.to.x, segment.to.y);
          if (isOutsideRadarSquare(fromRel.x, fromRel.y) && isOutsideRadarSquare(toRel.x, toRel.y)) {
            continue;
          }
          const fromPos = radarToCanvas(fromRel.x, fromRel.y);
          const toPos = radarToCanvas(toRel.x, toRel.y);
          radarCtx.moveTo(fromPos.x, fromPos.y);
          radarCtx.lineTo(toPos.x, toPos.y);
        }
        radarCtx.stroke();
        radarCtx.restore();
        return;
      }
      const rel = toRadarRelative(projAt.x, projAt.y);
      const lineLength = proj.userData?.guided
        ? shotLineWorldLength * RADAR_SHOT_LINE_GM_FACTOR
        : shotLineWorldLength;
      // The line reaches forward from the shot, so a shot already past the edge
      // can still have the near end of its line on the panel. The margin is the
      // whole line: one that has nothing on the panel is dropped, and one that
      // has any of itself on it is drawn and clipped by the canvas.
      if (isOutsideRadarSquare(rel.x, rel.y, lineLength)) return;
      const pos = radarToCanvas(rel.x, rel.y);
      const shotRadarColor = shotRadarColorOf(proj);

      // `dirX/dirY/dirZ` rather than the trail's direction: these are rewritten
      // by every bounce, every teleport and every step a missile steers, so the
      // line turns with the shot instead of pointing at the muzzle forever.
      //
      // Upstream normalises the whole velocity and then draws the x and y of
      // it, which shortens the line as the shot climbs or dives -- the panel is
      // a top-down view, and a shot going mostly upwards is covering little
      // ground. Dividing the horizontal components by the 3D length does that.
      const dirX = Number.isFinite(proj.userData?.dirX) ? proj.userData.dirX : 0;
      const dirY = Number.isFinite(proj.userData?.dirY) ? proj.userData.dirY : 0;
      const dirZ = Number.isFinite(proj.userData?.dirZ) ? proj.userData.dirZ : 0;
      const dirLength = Math.hypot(dirX, dirY, dirZ);

      radarCtx.save();
      radarCtx.globalAlpha = 0.85;
      if (dirLength > 1e-6) {
        const reach = lineLength / dirLength;
        const tipRel = toRadarRelative(
          projAt.x + (dirX * reach),
          projAt.y + (dirY * reach),
        );
        const tipPos = radarToCanvas(tipRel.x, tipRel.y);
        radarCtx.strokeStyle = shotRadarColor;
        radarCtx.lineWidth = RADAR_SHOT_LINE_WIDTH;
        radarCtx.beginPath();
        radarCtx.moveTo(pos.x, pos.y);
        radarCtx.lineTo(tipPos.x, tipPos.y);
        radarCtx.stroke();
      }
      radarCtx.fillStyle = RADAR_SHOT_TIP_COLOR;
      radarCtx.fillRect(
        pos.x - (RADAR_SHOT_TIP_SIZE / 2),
        pos.y - (RADAR_SHOT_TIP_SIZE / 2),
        RADAR_SHOT_TIP_SIZE,
        RADAR_SHOT_TIP_SIZE,
      );
      radarCtx.restore();
    });
  }

  // Draw tanks within radar distance, or as edge dots if beyond
  tanks.forEach((tank, playerId) => {
    if (!tank.position) return;
    const state = tank.userData && tank.userData.playerState;
    const isSelf = playerId === myPlayerId;
    // An observer's own tank is never alive and is invisible in the 3D
    // world by design (see handleRoamMotion's "nothing draws it"), which
    // would otherwise hide it here same as anyone else's -- but a Map Viewer
    // or spectator has no other reference point on an empty radar without it,
    // so the local player's own marker is exempt from both gates.
    //
    // These are asked directly rather than through `tank.visible`: `CL`
    // (issue #85) drives that same flag to false once cloak alpha hits zero
    // (see applyTankAlpha), which would silently buy every cloaked tank the
    // radar-blip immunity that only `ST` is supposed to grant.
    if (!isSelf && state && !state.alive) return;
    if (!isSelf && isPreviewingAltWorld()) return;
    // RadarRenderer.cxx:628. A stealthed tank has no blip at all rather than a
    // dim one, and Seer is the only thing that brings it back. A cloaked tank is
    // the mirror image and stays on the radar: `CL` hides you from the window,
    // `ST` hides you from the panel, and carrying one does not buy the other.
    if (!isSelf && state && isHiddenFromRadar(state.id)) return;

    // Get player color (convert from hex number to CSS string). RadarRenderer.cxx
    // asks the same question of every blip it draws: colourblindness reaches the
    // radar, or the panel would still say what the world no longer does.
    let playerColor = '#4CAF50'; // Default green
    if (state && typeof state.color === 'number') {
      const effective = getEffectiveTankColor(state.id, state.color);
      playerColor = '#' + effective.toString(16).padStart(6, '0');
    }
    // Team::getRadarColor for the rabbit, which is white where its tank is grey
    // (Team.cxx:38). The radar's team colours are lifted so a team reads against
    // a dark panel, and grey is the one shade that does not -- least of all
    // inside the cyan ring below. This is the only blip bzo paints from a team
    // rather than from the player, because the rabbit is the only tank that
    // wears a team's colour at all. Colourblindness takes it, as it takes the
    // tank's.
    if (isTheRabbit(playerId) && !isColorblind()) {
      playerColor = colorToCSS(getPlayerTeamRadarColor(PLAYER_TEAM.RABBIT));
    }

    const tankAt = tank.position;
    const rel = toRadarRelative(tankAt.x, tankAt.y);
    const rotX = rel.x;
    const rotY = rel.y;
    const tankOutsideRadarSquare = isOutsideRadarSquare(rotX, rotY, tankArrowWorldMargin);
    const pos = radarToCanvas(rel.x, rel.y);
    const ringTheHunted = isHuntMarked(playerId);

    if (tankOutsideRadarSquare) {
      // Tank is outside radar range - draw as small dot against square edge.
      const edge = projectToRadarEdge(rotX, rotY);
      if (!edge) return;

      radarCtx.save();
      radarCtx.beginPath();
      radarCtx.arc(edge.x, edge.y, 3, 0, Math.PI * 2);
      radarCtx.fillStyle = playerColor;
      radarCtx.globalAlpha = 0.8;
      radarCtx.fill();
      radarCtx.restore();
      // A hunted tank that has run off the panel is exactly the one a hunter
      // wants marked, so the ring follows it out to the edge.
      if (ringTheHunted) drawRadarMarkerRing(edge.x, edge.y, RADAR_HUNT_RING_COLOR);
      return;
    }

    radarCtx.save();
    radarCtx.translate(pos.x, pos.y);
    drawRadarHeightBox(tankAt.z, playerColor);
    if (playerId === myPlayerId) {
      // Player tank: always point up (no rotation needed)
      radarCtx.beginPath();
      radarCtx.moveTo(0, -10);
      radarCtx.lineTo(-6, 8);
      radarCtx.lineTo(6, 8);
      radarCtx.closePath();
      radarCtx.fillStyle = playerColor;
      radarCtx.globalAlpha = 1;
      radarCtx.fill();
    } else {
      // Other tanks: turned by how far their azimuth is from the player's,
      // clockwise on the panel as an azimuth runs counter-clockwise.
      radarCtx.rotate(azimuth - tankAzimuth(tank));
      radarCtx.beginPath();
      radarCtx.moveTo(0, -10);
      radarCtx.lineTo(-6, 8);
      radarCtx.lineTo(6, 8);
      radarCtx.closePath();
      radarCtx.fillStyle = playerColor;
      radarCtx.globalAlpha = 0.95;
      radarCtx.fill();
    }
    radarCtx.restore();
    if (ringTheHunted) drawRadarMarkerRing(pos.x, pos.y, RADAR_HUNT_RING_COLOR);
  });

  // Flags on the ground, drawn as RadarRenderer::drawFlag does: a cross a flag
  // radius across, never smaller than three pixels. Belongs to the live match
  // the same way the 3D flag meshes do (see updateFlags), so it is withheld
  // for the same reason during a Map Viewer preview or session (issue #68).
  if (flags.size > 0 && !isPreviewingAltWorld()) {
    const pixelsPerWorldUnit = radarWorldHalfExtent / Math.max(radarDistance, 1e-6);
    const crossHalf = Math.max(FLAG_RADIUS * pixelsPerWorldUnit, RADAR_FLAG_MIN_HALF_PX);
    const tankCrossHalf = Math.max(
      radarFlagOnTankRadii() * pixelsPerWorldUnit,
      RADAR_FLAG_ON_TANK_MIN_HALF_PX
    );
    // Crosses that share a colour and an altitude go into one path and one
    // stroke. Sixteen white superflags standing on the ground -- the common case
    // -- cost a single stroke rather than sixteen, which matters because the
    // radar is redrawn every frame on a client with one core to spend.
    let batchStyle = null;
    let batchAlpha = null;
    const flushRadarFlags = () => {
      if (batchStyle === null) return;
      radarCtx.stroke();
      batchStyle = null;
    };
    const drawRadarFlag = (flag) => {
      if (flag.status === FLAG_STATUS.NO_EXIST || flag.status === FLAG_STATUS.ON_TANK) return;
      const at = flag.position;
      const rel = toRadarRelative(at.x, at.y);
      if (isOutsideRadarSquare(rel.x, rel.y)) return;

      const style = getFlagRadarStyle(flag);
      const alpha = getRadarDepthScale(pz, at.z, 0, RADAR_OBJECT_DEPTH_FLOOR);
      if (style !== batchStyle || alpha !== batchAlpha) {
        flushRadarFlags();
        radarCtx.globalAlpha = alpha;
        radarCtx.strokeStyle = style;
        radarCtx.beginPath();
        batchStyle = style;
        batchAlpha = alpha;
      }

      const pos = radarToCanvas(rel.x, rel.y);
      radarCtx.moveTo(pos.x - crossHalf, pos.y);
      radarCtx.lineTo(pos.x + crossHalf, pos.y);
      radarCtx.moveTo(pos.x, pos.y - crossHalf);
      radarCtx.lineTo(pos.x, pos.y + crossHalf);
    };

    // A flag the player is looking for is drawn on its own after the rest: in
    // flat colour rather than depth-scaled, since dimming the one flag you are
    // hunting for by how far above or below you it is works against the point;
    // pinned to the border of the panel when it is past radar range, where an
    // ordinary flag is simply dropped; and ringed wherever it lands.
    //
    // It stays a cross out at the edge, where a tank degrades to a dot. A tank's
    // blip is an arrow because it carries a heading, and a heading is the thing
    // a pinned marker no longer has; a cross carries nothing but a position, so
    // it loses none of its meaning by being pinned and stays the shape that says
    // "flag" everywhere else on the panel.
    //
    // A flag on a tank takes drawFlagOnTank's larger cross over the carrier's
    // blip, which is upstream's own mark for a carried flag -- so the one
    // marker answers who has it and which way they went.
    const drawSoughtFlag = (position, style, onTank) => {
      const rel = toRadarRelative(position.x, position.y);
      const pos = isOutsideRadarSquare(rel.x, rel.y)
        ? projectToRadarEdge(rel.x, rel.y)
        : radarToCanvas(rel.x, rel.y);
      if (!pos) return;
      const half = onTank ? tankCrossHalf : crossHalf;
      radarCtx.globalAlpha = 1;
      radarCtx.strokeStyle = style;
      radarCtx.beginPath();
      radarCtx.moveTo(pos.x - half, pos.y);
      radarCtx.lineTo(pos.x + half, pos.y);
      radarCtx.moveTo(pos.x, pos.y - half);
      radarCtx.lineTo(pos.x, pos.y + half);
      radarCtx.stroke();
      drawRadarMarkerRing(
        pos.x,
        pos.y,
        style,
        Math.max(RADAR_MARKER_RING_RADIUS, half + RADAR_MARKER_RING_GAP)
      );
    };

    const myTeamIndex = getMyTeamColorIndex();
    radarCtx.save();
    radarCtx.lineWidth = 1.5;
    // Upstream walks the flags backwards purely so the team flags, which come
    // first, end up drawn over the superflags. Two passes say that outright.
    // `_hideFlagsOnRadar` takes every flag on the ground off the panel, and
    // `_hideTeamFlagsOnRadar` the team flags (RadarRenderer.cxx:688-707); a
    // carried flag is the tank's, and shows with it either way.
    const hideAllFlags = gameConfig?.HIDE_FLAGS_ON_RADAR === true;
    const hideTeamFlags = hideAllFlags || gameConfig?.HIDE_TEAM_FLAGS_ON_RADAR === true;
    flags.forEach((flag) => {
      if (getFlagTeamIndex(flag.type) === null && !hideAllFlags) drawRadarFlag(flag);
    });
    radarSoughtFlags.length = 0;
    flags.forEach((flag) => {
      if (getFlagTeamIndex(flag.type) === null) return;
      if (hideTeamFlags && flag.status !== FLAG_STATUS.ON_TANK) return;
      // A sought flag is held back rather than batched, so its cross is not
      // drawn twice in two different alphas.
      if (isSoughtTeamFlag(flag, myTeamIndex)) {
        radarSoughtFlags.push(flag);
        return;
      }
      drawRadarFlag(flag);
    });
    flushRadarFlags();
    radarSoughtFlags.forEach((flag) => {
      drawSoughtFlag(flag.position, getFlagRadarStyle(flag), flag.status === FLAG_STATUS.ON_TANK);
    });
    // RadarRenderer.cxx:715 draws the antidote last and in flat yellow, over
    // every flag in the world, because it is the one you are looking for.
    if (antidotePosition) {
      drawSoughtFlag(antidotePosition, ANTIDOTE_FLAG_STYLE, false);
    }
    radarCtx.restore();

    // drawFlagOnTank(): carrying a flag puts a larger cross on your own blip.
    const carried = getMyFlag();
    if (carried) {
      radarCtx.save();
      radarCtx.strokeStyle = getFlagRadarStyle(carried);
      radarCtx.lineWidth = 1.5;
      radarCtx.beginPath();
      radarCtx.moveTo(center - tankCrossHalf, center);
      radarCtx.lineTo(center + tankCrossHalf, center);
      radarCtx.moveTo(center, center - tankCrossHalf);
      radarCtx.lineTo(center, center + tankCrossHalf);
      radarCtx.stroke();
      radarCtx.restore();
    }
  }
}

let lastTime = performance.now();
const MAX_FRAME_DELTA_SECONDS = 0.1;

function setXRButtonState(enabled) {
  const xrBtn = document.getElementById('xrBtn');
  const xrQuickBtn = document.getElementById('xrQuickBtn');
  if (enabled) {
    if (xrBtn) { xrBtn.classList.add('active'); xrBtn.title = 'Exit WebXR VR Mode'; }
    if (xrQuickBtn) { xrQuickBtn.classList.add('active'); xrQuickBtn.title = 'Exit WebXR VR Mode'; }
  } else {
    if (xrBtn) { xrBtn.classList.remove('active'); xrBtn.title = 'Enter WebXR VR Mode'; }
    if (xrQuickBtn) { xrQuickBtn.classList.remove('active'); xrQuickBtn.title = 'Enter WebXR VR Mode'; }
  }
}

// See `xrPlayerScreenReturnCameraMode`'s own comment. Called wherever the
// active screen (or whether the menu is open at all) might have changed, so
// entering "player" always forces the override and leaving it (to another
// screen, or by closing the menu entirely) always lifts it again.
function syncXRPlayerScreenCameraOverride() {
  const onPlayerScreen = xrSettingsMenuOpen && xrSettingsMenuScreen === 'player';
  if (onPlayerScreen && xrPlayerScreenReturnCameraMode === null) {
    xrPlayerScreenReturnCameraMode = cameraMode;
    cameraMode = 'overview';
  } else if (!onPlayerScreen && xrPlayerScreenReturnCameraMode !== null) {
    cameraMode = xrPlayerScreenReturnCameraMode === 'overview' ? 'first-person' : xrPlayerScreenReturnCameraMode;
    xrPlayerScreenReturnCameraMode = null;
  }
}

function closeXRSettingsMenu() {
  if (!xrSettingsMenuOpen) return;
  xrSettingsMenuOpen = false;
  xrSettingsMenuRenderer?.hide();
  syncXRPlayerScreenCameraOverride();
  syncInputContextFromUi();
}

function setXRSettingsMenuScreen(screen) {
  xrSettingsMenuScreen = screen;
  xrSettingsMenuSelectedIndex = 0;
  xrSettingsMenuNavigationDirection = 0;
  xrSettingsMenuNextRepeatAt = 0;
  syncXRPlayerScreenCameraOverride();
  if (screen === 'operator') {
    sendToServer({ type: 'getMaps', requestId: Math.floor(Math.random() * 1e9) });
  }
}

function toggleXRSettingsMenu() {
  if (xrSettingsMenuOpen) {
    closeXRSettingsMenu();
    return;
  }
  xrSettingsMenuOpen = true;
  setXRSettingsMenuScreen('settings');
  xrSettingsMenuActivateLatched = true;
  xrSettingsMenuBackLatched = true;
  setInputContext(INPUT_CONTEXT.DIALOG);
}

const XR_HELP_ITEMS = Object.freeze([
  { id: 'helpMove', label: 'Move', value: 'Either stick Up / Down', disabled: true },
  { id: 'helpTurn', label: 'Turn', value: 'Either stick Left / Right', disabled: true },
  { id: 'helpFire', label: 'Fire', value: 'Either trigger', disabled: true },
  { id: 'helpJump', label: 'Jump', value: 'Either grip', disabled: true },
  { id: 'helpDrop', label: 'Drop Flag', value: 'Either primary (A)', disabled: true },
  { id: 'helpIdentify', label: 'Identify', value: 'Press either stick', disabled: true },
  { id: 'helpMenu', label: 'Open Menu', value: 'Either secondary (B)', disabled: true },
  { id: 'helpNavigate', label: 'Navigate', value: 'Either stick', disabled: true },
  { id: 'helpActivate', label: 'Activate', value: 'Trigger / primary', disabled: true },
  { id: 'helpBack', label: 'Back', value: 'Either secondary (B) / grip', disabled: true },
  { id: 'backXR', label: 'Back', value: '' },
]);

// Name, team, and tank are what the 2D entry dialog asks for, so before the
// player has joined this screen stands in for it and the menu opens here.
function getXRPlayerOptionsMenuItems() {
  const tankModel = getTankModelById(selectedTankModelId) || getDefaultTankModel();
  const keyboard = isSystemKeyboardSupported();
  return [
    {
      id: 'nameXR',
      label: 'Name',
      value: keyboard ? myPlayerName : 'Desktop only',
      disabled: !keyboard,
    },
    { id: 'teamXR', label: 'Team', value: PLAYER_TEAM_LABELS[selectedPlayerTeam], adjustable: true },
    {
      id: 'tankXR',
      label: 'Tank',
      value: tankModel.label || tankModel.id,
      adjustable: true,
      // Nothing on a proxied target can see this choice; see
      // `syncTankSelectorForDestination`.
      disabled: selectedDestination !== DESTINATION_LOCAL,
    },
    { id: 'rejoinXR', label: gameplayJoinConfirmed ? 'Apply & Rejoin' : 'Join', value: '' },
    { id: 'backXR', label: 'Back', value: '' },
  ];
}

// The headset keyboard opens a fresh editing session every time, so the first
// key replaces the whole field: the current value is a prompt to retype, not
// something the player can edit in place. Text comes back through the field's
// value, since the keyboard sends no key events of its own.
function beginXRTextEntry(value, commit) {
  const input = document.getElementById('xrTextInput');
  if (!input || !isSystemKeyboardSupported()) return;
  input.value = value;
  input.addEventListener('blur', () => {
    const typed = input.value.trim();
    input.value = '';
    if (typed) commit(typed);
  }, { once: true });
  input.focus();
}

function getXRAudioMenuItems() {
  const state = getVoiceState();
  const input = document.getElementById('voiceInputDevice');
  const selectedInput = input?.selectedOptions?.[0]?.textContent || 'Default microphone';
  return [
    {
      id: 'voiceChannelXR',
      label: 'Voice Channel',
      value: getVoiceChannel(selectedVoiceChannel).label,
      adjustable: true,
    },
    ...VOLUME_CHANNELS.map((channel) => ({
      id: channel.xrId,
      label: channel.label,
      value: formatVolumeLevel(getVolumeLevel(channel.id)),
      adjustable: true,
    })),
    {
      id: 'voicePermissionXR',
      label: 'Permission',
      value: state.microphonePermission || 'Prompt',
      disabled: state.microphonePermission === 'granted',
    },
    {
      id: 'voiceMicrophoneXR',
      label: 'Microphone',
      value: state.transmitting ? 'On' : 'Off',
      disabled: state.microphonePermission !== 'granted' && !state.hasLocalStream,
    },
    { id: 'voiceInputXR', label: 'Input', value: selectedInput, adjustable: true },
    { id: 'voiceEchoXR', label: 'Echo Cancellation', value: getVoiceAudioSettings().echoCancellation ? 'On' : 'Off' },
    { id: 'voiceNoiseXR', label: 'Noise Suppression', value: getVoiceAudioSettings().noiseSuppression ? 'On' : 'Off' },
    { id: 'voiceGainXR', label: 'Auto Gain', value: getVoiceAudioSettings().autoGainControl ? 'On' : 'Off' },
    { id: 'backXR', label: 'Back', value: '' },
  ];
}

// What the XR rows call each rabbit chase style. The flat panel's `<select>`
// carries its own labels; this is the same list for the surface that draws them.
const RABBIT_LABELS = {
  off: 'Off',
  score: 'Score',
  killer: 'Killer',
  random: 'Random',
};
const getXROperatorLimitId = (team) => `operator${team}LimitXR`;

// The same staged model the flat panel edits, one row per setting: a
// per-setting apply row ("Restart with Map", "Apply Shot Limit") would double
// every row on the surface with the least room, so one confirm replaces them
// all. See docs/operator-panel-plan.md.
function getXROperatorMenuItems() {
  const mapList = document.getElementById('mapList');
  const staged = operatorStaged || getOperatorServerState();
  const changes = getOperatorChanges();
  const restart = operatorChangesNeedRestart(changes);
  const keyboard = isSystemKeyboardSupported();
  const rabbit = Boolean(staged.rabbit) && staged.rabbit !== 'off';
  const mapLabel = mapList
    ? ([...mapList.options].find((option) => option.value === staged.mapFile)?.textContent
      || staged.mapFile || 'Loading...')
    : 'Loading...';
  return [
    {
      id: 'operatorTitleXR',
      label: 'Title',
      // The headset's own keyboard where the session has one; see
      // beginXRTextEntry. A paired physical keyboard is untested.
      value: keyboard ? (staged.title || '(empty)') : 'Desktop only',
      disabled: !keyboard,
    },
    {
      id: 'operatorMotdXR',
      label: 'MOTD',
      // The headset's own keyboard where the session has one; see
      // beginXRTextEntry. A paired physical keyboard is untested.
      value: keyboard ? (staged.motd || '(empty)') : 'Desktop only',
      disabled: !keyboard,
    },
    {
      id: 'operatorMapXR',
      label: 'Map',
      value: mapLabel,
      adjustable: true,
      disabled: !mapList?.options?.length,
    },
    { id: 'operatorShotsXR', label: 'Shot Limit', value: String(staged.shotMaxActive), adjustable: true },
    { id: 'operatorRicochetXR', label: 'All Shots Ricochet', value: staged.ricochet ? 'On' : 'Off' },
    // The game's shape. Every row below is one line with one value -- a row
    // plus its own apply row per setting would put fourteen settings near
    // thirty lines, not a list anybody can read in a headset.
    {
      id: 'operatorTeamsXR',
      label: 'Teams',
      value: staged.teams === true ? 'On' : 'Off',
      disabled: rabbit,
    },
    {
      id: 'operatorRabbitXR',
      label: 'Rabbit Chase',
      value: RABBIT_LABELS[staged.rabbit] || 'Off',
      adjustable: true,
    },
    { id: 'operatorJumpingXR', label: 'Jumping', value: staged.jumping === true ? 'On' : 'Off' },
    {
      id: 'operatorTimeLimitXR',
      label: 'Time Limit',
      value: staged.timeLimit > 0 ? (formatMatchClock(staged.timeLimit) || '0:00') : 'No limit',
      adjustable: true,
    },
    {
      id: 'operatorTimeManualStartXR',
      label: 'Manual Start',
      value: staged.timeManualStart === true ? 'On' : 'Off',
    },
    {
      id: 'operatorMaxPlayerScoreXR',
      label: 'Player Score Limit',
      value: staged.maxPlayerScore > 0 ? String(staged.maxPlayerScore) : 'No limit',
      adjustable: true,
    },
    {
      id: 'operatorMaxTeamScoreXR',
      label: 'Team Score Limit',
      value: staged.maxTeamScore > 0 ? String(staged.maxTeamScore) : 'No limit',
      adjustable: true,
    },
    {
      id: 'operatorBotFillXR',
      label: 'Bot Fill',
      value: staged.botFill > 0 ? String(staged.botFill) : 'Off',
      adjustable: true,
    },
    {
      id: 'operatorBotPilotXR',
      label: 'Bot Pilot',
      value: getAutopilotName(staged.botPilot),
      adjustable: true,
    },
    {
      id: 'operatorPlayersXR',
      label: 'Playing Limit',
      value: String(staged.maxPlayers ?? ''),
      adjustable: true,
    },
    ...OPERATOR_LIMIT_TEAMS.map((team) => ({
      id: getXROperatorLimitId(team),
      // Without the colon the flat panel's label carries, since the XR row draws
      // its own label and value columns.
      label: getOperatorLimitLabel(team, rabbit).replace(/:$/, ''),
      value: String(staged[operatorLimitKey(team)] ?? ''),
      adjustable: true,
      disabled: OPERATOR_COLOR_TEAMS.includes(team) && (rabbit || staged.teams !== true),
    })),
    {
      id: 'operatorApplyXR',
      // Labelled by what it will do, as the flat panel's is.
      label: restart ? 'Restart' : 'Apply',
      value: changes.length === 0 ? 'no changes' : changes.join(', '),
      disabled: changes.length === 0,
    },
    { id: 'operatorCancelXR', label: 'Cancel', value: '', disabled: changes.length === 0 },
    // Immediate actions, like the Apply/Cancel pair above them and Upload Map
    // below -- nothing here is staged.
    { id: 'operatorMatchStartXR', label: 'Match: Start', value: '' },
    { id: 'operatorMatchPauseXR', label: 'Match: Pause', value: '' },
    { id: 'operatorMatchResumeXR', label: 'Match: Resume', value: '' },
    { id: 'operatorMatchEndXR', label: 'Match: End Now', value: '' },
    { id: 'operatorRefreshXR', label: 'Refresh Server Data', value: '' },
    { id: 'operatorDesktopXR', label: 'Upload Map', value: 'Desktop only', disabled: true },
    { id: 'backXR', label: 'Back', value: '' },
  ];
}

function getXRSettingsMenuDefinition() {
  if (xrSettingsMenuScreen === 'player') {
    return {
      title: gameplayJoinConfirmed ? 'Player Options' : 'Join Game',
      items: getXRPlayerOptionsMenuItems(),
    };
  }
  if (xrSettingsMenuScreen === 'help') return { title: 'Help', items: XR_HELP_ITEMS };
  if (xrSettingsMenuScreen === 'audio') return { title: 'Audio', items: getXRAudioMenuItems() };
  if (xrSettingsMenuScreen === 'operator') return { title: 'Operator', items: getXROperatorMenuItems() };
  return { title: 'Settings', items: getXRSettingsMenuItems() };
}

function cycleSelectElement(select, direction) {
  if (!select || select.options.length < 1) return false;
  const nextIndex = (select.selectedIndex + direction + select.options.length) % select.options.length;
  select.selectedIndex = nextIndex;
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  return true;
}

function adjustXRSettingsMenuItem(item, direction) {
  if (!item || item.disabled) return false;
  if (item.id === 'voiceChannelXR') {
    const index = VOICE_CHANNELS.findIndex((channel) => channel.id === selectedVoiceChannel);
    const next = (index + direction + VOICE_CHANNELS.length) % VOICE_CHANNELS.length;
    setVoiceChannel(VOICE_CHANNELS[next].id);
    return true;
  }
  const volumeChannel = VOLUME_CHANNELS.find((channel) => channel.xrId === item.id);
  if (volumeChannel) {
    setVolumeLevel(volumeChannel.id, stepVolumeLevel(getVolumeLevel(volumeChannel.id), direction));
    return true;
  }
  if (item.id === 'teamXR') {
    selectRelativePlayerTeam(direction);
    return true;
  }
  if (item.id === 'tankXR') {
    cycleTankModel(direction);
    return true;
  }
  if (item.id === 'voiceInputXR') {
    return cycleSelectElement(document.getElementById('voiceInputDevice'), direction);
  }
  // Both stage rather than apply, through the same functions the flat panel's
  // rows call -- so the confirm's label is recomputed once and agrees on both
  // surfaces.
  if (item.id === 'operatorMapXR') {
    return cycleSelectElement(document.getElementById('mapList'), direction);
  }
  if (item.id === 'operatorShotsXR') {
    stageOperatorNumber('shotMaxActive', direction);
    return true;
  }
  if (item.id === 'operatorRabbitXR') {
    stageOperatorRabbit(direction);
    return true;
  }
  if (item.id === 'operatorTimeLimitXR') {
    stageOperatorNumber('timeLimit', direction);
    return true;
  }
  if (item.id === 'operatorMaxPlayerScoreXR') {
    stageOperatorNumber('maxPlayerScore', direction);
    return true;
  }
  if (item.id === 'operatorMaxTeamScoreXR') {
    stageOperatorNumber('maxTeamScore', direction);
    return true;
  }
  if (item.id === 'operatorPlayersXR') {
    stageOperatorNumber('maxPlayers', direction);
    return true;
  }
  if (item.id === 'operatorBotFillXR') {
    stageOperatorNumber('botFill', direction);
    return true;
  }
  if (item.id === 'operatorBotPilotXR') {
    if (!operatorStaged) operatorStaged = getOperatorServerState();
    const at = AUTOPILOTS.findIndex((entry) => entry.id === operatorStaged.botPilot);
    const next = (Math.max(0, at) + (direction > 0 ? 1 : -1) + AUTOPILOTS.length) % AUTOPILOTS.length;
    stageOperatorChange('botPilot', AUTOPILOTS[next].id);
    return true;
  }
  const limitTeam = OPERATOR_LIMIT_TEAMS.find((team) => getXROperatorLimitId(team) === item.id);
  if (limitTeam) {
    stageOperatorNumber(operatorLimitKey(limitTeam), direction);
    return true;
  }
  // Everything above is a row the XR panel owns. The rest are the flat menu's
  // own rows, and they answer to the same left and right there as here.
  return adjustSettingsMenuRow(item.id, direction);
}

function getDisplayMode() {
  const modes = ['fullscreen', 'standalone', 'minimal-ui', 'browser'];
  return modes.find((mode) => window.matchMedia(`(display-mode: ${mode})`).matches) || 'unknown';
}

// Opened in place of the 2D entry dialog, which a headset player cannot see.
function openXRJoinMenu() {
  if (!xrSettingsMenuOpen) toggleXRSettingsMenu();
  setXRSettingsMenuScreen('player');
}

function applyXRJoinSelection() {
  // The 2D dialog is open if the player entered XR from it. This panel is its
  // OK, so it closes without putting the draft back.
  closeEntryDialog({ revert: false });
  // Both surfaces close before the join is sent rather than after it. Closing
  // this panel gives back the pause it took when it opened, and that toggle
  // belongs to the life it was taken in: behind the join the server clears the
  // pause in the respawn and then reads the toggle against the new life, which
  // comes up paused and stays there -- a pause the panel did not take is one it
  // cannot give back, because `PauseState.syncMenu` will not claim a tank that
  // is already frozen.
  closeXRSettingsMenu();
  gameplayJoinConfirmed = false;
  if (proxyTeamChangeNavigated(getJoinTeamFields().team)) return;
  applySelectedTankModel(selectedTankModelId);
  sendToServer({
    type: 'joinGame',
    name: myPlayerName,
    isMobile,
    tankModel: selectedTankModelId,
    motto: myPlayerMotto,
    bot: IS_BOT_CLIENT,
    page: PAGE_TOKEN,
    ...getJoinTeamFields(),
  });
}

function activateXRSettingsMenuSelection(item) {
  if (!item || item.disabled) return;
  if (item.adjustable) {
    adjustXRSettingsMenuItem(item, 1);
    return;
  }
  if (item.id === 'exitXR') void exitXRFromMenu();
  else if (item.id === 'closeXRMenu') closeXRSettingsMenu();
  else if (item.id === 'backXR') setXRSettingsMenuScreen('settings');
  else if (item.id === 'playerOptionsBtn') setXRSettingsMenuScreen('player');
  else if (item.id === 'helpBtn') setXRSettingsMenuScreen('help');
  else if (item.id === 'audioBtn') setXRSettingsMenuScreen('audio');
  else if (item.id === 'operatorBtn') setXRSettingsMenuScreen('operator');
  else if (item.id === 'rejoinXR') applyXRJoinSelection();
  else if (item.id === 'nameXR') beginXRTextEntry(myPlayerName, savePlayerName);
  else if (item.id === 'voicePermissionXR') requestVoicePermission();
  else if (item.id === 'voiceMicrophoneXR') toggleVoiceMicrophone();
  else if (item.id === 'voiceEchoXR') document.getElementById('voiceEchoCancellation')?.click();
  else if (item.id === 'voiceNoiseXR') document.getElementById('voiceNoiseSuppression')?.click();
  else if (item.id === 'voiceGainXR') document.getElementById('voiceAutoGainControl')?.click();
  else if (item.id === 'operatorTitleXR') {
    // Staged like every other row: the headset keyboard returns the text and the
    // confirm is what sends it.
    beginXRTextEntry((operatorStaged || getOperatorServerState()).title, (typed) => {
      stageOperatorChange('title', typed.trim());
    });
  }
  else if (item.id === 'operatorMotdXR') {
    // Staged like every other row: the headset keyboard returns the text and the
    // confirm is what sends it.
    beginXRTextEntry((operatorStaged || getOperatorServerState()).motd, (typed) => {
      stageOperatorChange('motd', typed.trim());
    });
  }
  else if (item.id === 'operatorRicochetXR') {
    stageOperatorChange('ricochet', !(operatorStaged || getOperatorServerState()).ricochet);
  }
  // The two booleans below toggle on select, as the ricochet row does: a
  // headset's select is one press where its arrows are two.
  else if (item.id === 'operatorTeamsXR') {
    stageOperatorChange('teams', (operatorStaged || getOperatorServerState()).teams !== true);
  }
  else if (item.id === 'operatorJumpingXR') {
    stageOperatorChange('jumping', (operatorStaged || getOperatorServerState()).jumping !== true);
  }
  else if (item.id === 'operatorTimeManualStartXR') {
    stageOperatorChange('timeManualStart', (operatorStaged || getOperatorServerState()).timeManualStart !== true);
  }
  else if (item.id === 'operatorApplyXR') commitOperatorPanel();
  else if (item.id === 'operatorCancelXR') {
    // Back to the server's values, staying on the screen: in a headset there is
    // no `X` to close, and leaving the screen is the Back row's job.
    operatorStaged = getOperatorServerState();
  }
  else if (item.id === 'operatorMatchStartXR') sendMatchControl('start');
  else if (item.id === 'operatorMatchPauseXR') sendMatchControl('pause');
  else if (item.id === 'operatorMatchResumeXR') sendMatchControl('resume');
  else if (item.id === 'operatorMatchEndXR') sendMatchControl('gameover');
  else if (item.id === 'operatorRefreshXR') setXRSettingsMenuScreen('operator');
  else activateXRSettingsMenuItem(item.id);
}

async function exitXRFromMenu() {
  if (xrSettingsShortcutInFlight) return;
  xrSettingsShortcutInFlight = true;
  try {
    const renderer = renderManager.getRenderer();
    if (!renderer) return;

    closeXRSettingsMenu();
    await toggleXRSession(renderer, animate);
    setXRButtonState(false);
    showMessage('WebXR VR Mode: OFF');
  } finally {
    xrSettingsShortcutInFlight = false;
  }
}

function handleXRSettingsMenuInput(now = performance.now()) {
  if (!isXREnabled()) {
    closeXRSettingsMenu();
    xrSettingsShortcutLatched = false;
    return;
  }

  // B opens the menu, steps back out of a submenu, and closes it from the top.
  // Not the thumbstick press: that sits under a thumb already steering, where
  // an accidental press is costly, so it drives identify instead, where a
  // stray press costs nothing. B carries the whole menu rather than only
  // opening it, so a press cannot both open the menu and be read as the back it
  // is inside one.
  const xrInput = getXRControllerInput();
  const pressed = Boolean(xrInput.buttonB);
  if (pressed && !xrSettingsShortcutLatched) {
    xrSettingsShortcutLatched = true;
    if (!xrSettingsMenuOpen) {
      toggleXRSettingsMenu();
    } else {
      playMenuBackSound();
      if (xrSettingsMenuScreen === 'settings') closeXRSettingsMenu();
      else setXRSettingsMenuScreen('settings');
    }
  } else if (!pressed) {
    xrSettingsShortcutLatched = false;
  }

  if (!xrSettingsMenuOpen) return;

  const { items } = getXRSettingsMenuDefinition();
  xrSettingsMenuSelectedIndex = Math.min(xrSettingsMenuSelectedIndex, Math.max(0, items.length - 1));
  const leftX = xrInput.leftThumbstick?.x || 0;
  const leftY = xrInput.leftThumbstick?.y || 0;
  const rightX = xrInput.rightThumbstick?.x || 0;
  const rightY = xrInput.rightThumbstick?.y || 0;
  const navigationX = Math.abs(rightX) >= Math.abs(leftX) ? rightX : leftX;
  const navigationY = Math.abs(rightY) >= Math.abs(leftY) ? rightY : leftY;
  const useHorizontal = Math.abs(navigationX) > Math.abs(navigationY);
  const dominantAxis = useHorizontal ? navigationX : navigationY;
  const direction = dominantAxis > 0.6 ? 1 : dominantAxis < -0.6 ? -1 : 0;
  const navigationToken = direction === 0 ? '' : `${useHorizontal ? 'horizontal' : 'vertical'}:${direction}`;

  if (direction === 0) {
    xrSettingsMenuNavigationDirection = 0;
    xrSettingsMenuNextRepeatAt = 0;
  } else if (navigationToken !== xrSettingsMenuNavigationDirection || now >= xrSettingsMenuNextRepeatAt) {
    const selectedItem = items[xrSettingsMenuSelectedIndex];
    // Sideways adjusts the row the stick is on. A row with nothing to adjust
    // keeps the selection where it is rather than moving it, so the two axes
    // read the same way here as they do on a flat screen.
    if (useHorizontal) {
      adjustXRSettingsMenuItem(selectedItem, direction);
    } else {
      xrSettingsMenuSelectedIndex = (
        xrSettingsMenuSelectedIndex + direction + items.length
      ) % items.length;
    }
    xrSettingsMenuNavigationDirection = navigationToken;
    xrSettingsMenuNextRepeatAt = now + 250;
  }

  const activatePressed = xrInput.leftTrigger > 0.5 || xrInput.rightTrigger > 0.5 || xrInput.buttonA;
  if (activatePressed && !xrSettingsMenuActivateLatched) {
    const selectedItem = items[xrSettingsMenuSelectedIndex];
    playMenuSelectSound();
    activateXRSettingsMenuSelection(selectedItem);
  }
  xrSettingsMenuActivateLatched = activatePressed;

  // B is handled above, where it stands for the whole menu; grip is the other
  // way back out of a submenu.
  const backPressed = xrInput.buttonGrip;
  if (backPressed && !xrSettingsMenuBackLatched) {
    playMenuBackSound();
    if (xrSettingsMenuScreen === 'settings') closeXRSettingsMenu();
    else setXRSettingsMenuScreen('settings');
  }
  xrSettingsMenuBackLatched = backPressed;
}

function ensureXRSettingsMenu() {
  if (!xrSettingsMenuRenderer) {
    xrSettingsMenuRenderer = new XRMenuRenderer();
  }
  const definition = getXRSettingsMenuDefinition();
  xrSettingsMenuRenderer.update(renderManager.getCamera(), {
    visible: isXREnabled() && xrSettingsMenuOpen,
    title: definition.title,
    items: definition.items,
    selectedIndex: xrSettingsMenuSelectedIndex,
  });
}

function updateChatWindow() {
  if (!chatWindowDirty) return;
  normalizeActiveChatTab();
  const chatTabsDiv = document.getElementById('chatTabs');
  const chatMessagesDiv = document.getElementById('chatMessages');
  if (!chatMessagesDiv) return;

  if (chatTabsDiv) {
    chatTabsDiv.innerHTML = '';
    const visibleTabs = getVisibleChatTabs();
    visibleTabs.forEach((tab) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-tab';
      if (tab.id === chatState.activeTab) {
        btn.classList.add('active');
      } else if (chatState.unread[tab.id]) {
        btn.classList.add('unread');
      }
      btn.setAttribute('data-chat-tab', tab.id);
      btn.textContent = tab.label;
      chatTabsDiv.appendChild(btn);
    });
  }

  // Captured before the rebuild below touches anything: a viewer already at
  // the bottom stays pinned to the newest message the way a live chat should,
  // and one who has scrolled up to read keeps looking at exactly what they
  // were looking at -- restoring the same `scrollTop` after an unrelated
  // message arrives leaves old content exactly where it was, which is the
  // whole of "do not yank someone back down while they are reading".
  const wasAtBottom = isChatScrolledToBottom(chatMessagesDiv);
  const previousScrollTop = chatMessagesDiv.scrollTop;

  chatMessagesDiv.innerHTML = '';

  const activeMessages = chatState.messages[chatState.activeTab] || [];
  // One clock reading for the whole repaint: what "today" means is the same for
  // every line in it, and a line drawn either side of midnight can wait for the
  // next repaint to grow its date.
  const now = Date.now();
  activeMessages.forEach((msg) => {
    const div = document.createElement('div');
    div.className = `chat-line chat-kind-${msg.kind || CHAT_KIND_CHAT}`;
    if (isHighlightMatch(msg.text)) div.classList.add('chat-highlight');
    // The stamp is a span of its own rather than part of the text, so the
    // narrow layouts can drop it (`.chat-time` in styles.css) without the line
    // it belongs to changing, and so nothing that reads a line -- the cache,
    // `/savemsgs`, the highlight test, the XR panel -- has to know it is there.
    const stamp = formatChatTimestamp(msg.ts, now);
    if (stamp) {
      const time = document.createElement('span');
      // A stamp carrying a date is marked as such, because it is the one a
      // narrow screen keeps: see `.chat-time` in styles.css.
      time.className = stamp.length > CHAT_TIME_ONLY_LENGTH ? 'chat-time chat-time-date' : 'chat-time';
      time.textContent = stamp;
      div.appendChild(time);
    }
    if (msg.segments) {
      // A segment with no colour inherits the line's, which is the kind's own
      // CSS rule -- so only the runs that need a colour carry one. Through
      // `colorToCSS` because a colour reaches here as either: the chat lines
      // written here have always used CSS strings, and a segment describing a
      // player carries the packed integer every other part of bzo colours a
      // player with.
      msg.segments.forEach((segment) => {
        const span = document.createElement('span');
        span.textContent = segment.text;
        if (segment.color) span.style.color = colorToCSS(segment.color);
        div.appendChild(span);
      });
    } else {
      // Appended rather than set as the line's `textContent`, which would take
      // the stamp with it.
      div.appendChild(document.createTextNode(msg.text));
    }
    chatMessagesDiv.appendChild(div);
  });

  if (!wasAtBottom) {
    chatMessagesDiv.scrollTop = previousScrollTop;
    chatWindowDirty = false;
    return;
  }

  chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
  // A pin is only as good as the layout it was taken against. On a reload the
  // transcript is filled before the panel has settled -- a font still
  // resolving, a phone still deciding how tall its viewport is -- so
  // `scrollHeight` grows after the pin and the newest line ends up below the
  // fold, which reads as chat opening at the top. Taking it again on the next
  // frame costs nothing and is what makes a reload show the newest message.
  const pinned = chatMessagesDiv.scrollTop;
  requestAnimationFrame(() => {
    // Only if nothing has moved it since: a finger or a wheel on the
    // transcript in that frame owns the position, not this.
    if (chatMessagesDiv.scrollTop !== pinned) return;
    chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
  });

  chatWindowDirty = false;
}

/**
 * Extrapolate a player's position based on their last known state and elapsed time.
 * @param {Object} player - Player object with position, rotation, and movement state
 * @param {number} dt - Time elapsed since last server update (seconds)
 * @returns {{x: number, y: number, z: number, r: number}} Extrapolated position and rotation
 */
function extrapolatePosition(player, dt) {
  if (!player || !gameConfig) return player;

  const {
    x, y, z, azimuth, forwardSpeed, rotationSpeed, verticalVelocity,
    jumpAzimuth, slideAzimuth, airVelocityX, airVelocityY, flagType
  } = player;

  // getDeadReckoning (Player.cxx:1127): a paused tank does not move, whatever it
  // was doing when the pause landed. Without this a tank that paused while
  // rolling drifts away from where the server has it, and the sphere drawn
  // around it goes with it.
  if (player.paused) return { x, y, z, azimuth };

  // Apply rotation
  const rotSpeed = gameConfig.TANK_ROTATION_SPEED || 1.5;
  const newAzimuth = azimuth + (rotationSpeed || 0) * rotSpeed * dt;

  // Determine if player is in air based on jumpAzimuth
  const isInAir = jumpAzimuth !== null && jumpAzimuth !== undefined;

  if (isInAir) {
    const hasAirVelocity = Number.isFinite(airVelocityX) && Number.isFinite(airVelocityY);
    const speed = gameConfig.TANK_SPEED || 15;
    const moveAzimuth = slideAzimuth !== undefined ? slideAzimuth : jumpAzimuth;
    const dx = hasAirVelocity ? airVelocityX * dt : Math.cos(moveAzimuth) * (forwardSpeed || 0) * speed * dt;
    const dy = hasAirVelocity ? airVelocityY * dt : Math.sin(moveAzimuth) * (forwardSpeed || 0) * speed * dt;

    // Apply gravity to vertical velocity. Wings falls at _wingsGravity, which is
    // the world's own unless a server has said otherwise.
    const gravity = hasAirControl(flagType) ? gameConfig.WINGS_GRAVITY : gameConfig.GRAVITY;
    const vv = (verticalVelocity || 0) - gravity * dt;
    const dz = ((verticalVelocity || 0) + vv) / 2 * dt; // Average velocity over dt

    return {
      x: x + dx,
      y: y + dy,
      // Don't go below this tank's own ground: Burrow's is `_burrowDepth`, and
      // getDeadReckoning clamps to the same limit (Player.cxx:1333) so a remote
      // burrowed tank is not drawn hovering at zero while the server has it in
      // its hole.
      z: Math.max(getGroundLimit(flagType ?? null), z + dz),
      azimuth: newAzimuth
    };
  }
  // On the ground: a straight line, or the arc a turning tank drives -- its
  // heading turns at the angular rate and it moves along it, so the position
  // is the integral of the heading over the time.
  const speed = gameConfig.TANK_SPEED || 15;
  const rs = rotationSpeed || 0;
  const fs = forwardSpeed || 0;

  // Use slide direction if present, otherwise the heading
  const moveAzimuth = slideAzimuth !== undefined ? slideAzimuth : azimuth;

  if (Math.abs(rs) < 0.001) {
    const dx = Math.cos(moveAzimuth) * fs * speed * dt;
    const dy = Math.sin(moveAzimuth) * fs * speed * dt;
    return { x: x + dx, y: y + dy, z, azimuth: newAzimuth };
  }
  const angularVelocity = rs * rotSpeed;
  const theta = angularVelocity * dt;
  const reach = (fs * speed) / angularVelocity;
  return {
    x: x + (reach * (Math.sin(azimuth + theta) - Math.sin(azimuth))),
    y: y - (reach * (Math.cos(azimuth + theta) - Math.cos(azimuth))),
    z,
    azimuth: azimuth + theta,
  };
}

function runFallbackAnimationLoop(frameTime) {
  animate(frameTime);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(runFallbackAnimationLoop);
  }
}

// The frame's own timestamp, not the clock reading from whenever this callback
// got scheduled. Three passes the animation frame's timestamp straight through
// -- rAF's, and in an XR session the frame's predicted display time -- and those
// land on the display's cadence, while `performance.now()` here also carries
// however long the main thread took to reach this call. Measured on this client,
// frame timestamps sit 0.05ms off the vsync grid and a `performance.now()`
// reading sits 3.8ms off it. Spending that noise as movement makes every step
// slightly too long or too short, which reads as the ground jittering -- worst
// at low speed, where the eye tracks the motion and expects it to be even.
function animate(frameTime) {
  startFramePhases();
  supportSurfaceDebugTouchedThisFrame = false;
  // The frame's one reading of the wall clock. Everything measured against a
  // timestamp the server also holds reads `frameEpochMs` from here on, so a
  // whole frame agrees about when it happened.
  sampleEpochClock();
  const now = Number.isFinite(frameTime) ? frameTime : performance.now();
  // A hidden tab stops delivering frames, so the first one back would otherwise
  // spend the whole gap at once and throw the tank across the map.
  const deltaTime = Math.max(0, Math.min((now - lastTime) / 1000, MAX_FRAME_DELTA_SECONDS));
  lastTime = now;

  updateSkyClock(deltaTime);

  updateXRControllerInput();
  handleXRSettingsMenuInput(now);
  updateXRHudOverlays();

  // Debug: log game state in XR once on entry
  if (isXREnabled() && !window.xrDebugLogged) {
    window.xrDebugLogged = true;
    debugLog(`[Game] XR entered, myTank: ${myTank ? `(${myTank.position.x.toFixed(1)}, ${myTank.position.y.toFixed(1)}, ${myTank.position.z.toFixed(1)})` : 'NULL'}, tanks: ${tanks.size}`);
  }
  if (!isXREnabled()) {
    window.xrDebugLogged = false;
  }
  markFramePhase('xr');

  updateLockOnMarker();
  // With the lock marker, and for the same reason: both ask what is in the
  // sights this frame, and upstream runs them back to back (playing.cxx:6893).
  updateHuntBearing();

  updateFps();
  // None of the DOM HUD is on screen in a session -- the XR panels stand in for
  // it -- and each of these measures an element with getBoundingClientRect
  // before deciding whether to repaint, which is a layout flush per panel per
  // frame for something nobody is looking at. It comes back on the first frame
  // after the session ends: none of it is state, each paints from what the game
  // currently is, and the one piece that is deferred -- the chat window -- keeps
  // its dirty flag until somebody draws it.
  if (!isXREnabled()) {
    updateChatWindow();
    updateAltitudeTape();
    updateAltimeter({ myTank });
    updateDegreeBar({ myTank, azimuth: myAzimuth, markers: getFlagHeadingMarkers() });
    updateShotStatus({
      myPlayerId,
      slotFreeAt: myShotSlotFreeAt,
      slotReloadMs: myShotSlotReloadMs,
      gameConfig,
      now: frameEpochMs,
    });
  }
  markFramePhase('hud');

  handleInputEvents();
  handleMotion(deltaTime);
  handleRoamMotion(deltaTime);
  markFramePhase('input');

  renderManager.updateWorldMatrices();
  // Dead tanks go in too. A tank withheld from the pass keeps whatever shadow
  // it last cast, so the pass is what has to be told to put it away.
  renderManager.updateProjectedShadows(tanks.values());
  markFramePhase('shadows');
  if (!supportSurfaceDebugTouchedThisFrame) {
    hideSupportSurfaceDebug();
    hideSurfaceOutlineDebug();
  }

  // Extrapolate other players' positions
  if (gameConfig) {
    tanks.forEach((tank, playerId) => {
      if (playerId === myPlayerId) return; // Skip local player
      if (!tank.userData || !tank.userData.serverPosition) return;

      const lastUpdate = tank.userData.lastUpdateTime || now;
      const timeSinceUpdate = (now - lastUpdate) / 1000; // Convert to seconds
      const remoteFS = tank.userData.forwardSpeed;
      const remoteRS = tank.userData.rotationSpeed;
      const remoteVV = tank.userData.verticalVelocity;
      const remoteJumpAzimuth = tank.userData.jumpAzimuth;
      const remoteAirVx = tank.userData.airVelocityX;
      const remoteAirVy = tank.userData.airVelocityY;
      const remoteAirborne = remoteJumpAzimuth !== null && remoteJumpAzimuth !== undefined;
      const remoteStopped =
        !remoteAirborne &&
        remoteFS === 0 &&
        remoteRS === 0 &&
        remoteVV === 0 &&
        remoteAirVx === 0 &&
        remoteAirVy === 0;
      const clampedTimeSinceUpdate = remoteStopped
        ? Math.max(0, Math.min(timeSinceUpdate, MAX_REMOTE_EXTRAPOLATION_STOP_SECONDS))
        : Math.max(0, timeSinceUpdate);

      // Extrapolate position from last server-confirmed state
      const extrapolated = extrapolatePosition({
        x: tank.userData.serverPosition.x,
        y: tank.userData.serverPosition.y,
        z: tank.userData.serverPosition.z,
        azimuth: tank.userData.serverPosition.azimuth,
        forwardSpeed: remoteFS,
        rotationSpeed: remoteRS,
        verticalVelocity: remoteVV,
        jumpAzimuth: remoteJumpAzimuth,
        slideAzimuth: tank.userData.slideAzimuth,
        airVelocityX: remoteAirVx,
        airVelocityY: remoteAirVy,
        flagType: getPlayerFlag(playerId)?.type ?? null
      }, clampedTimeSinceUpdate);

      // Update tank's rendered position smoothly
      if (extrapolated) {
        placeTank(tank, extrapolated.x, extrapolated.y, extrapolated.z, extrapolated.azimuth);
      }
    });
  }

  updateProjectiles(deltaTime);
  // After the shots, because upstream's own chain is an `else if` behind them:
  // a tank that was shot this frame does not also drown (`checkEnvironment`,
  // playing.cxx:4162-4197).
  checkOwnEnvironmentDeath();
  expireOwnLockTarget();
  checkFlagGrab();
  checkNearFlag();
  updateFlagShake(deltaTime);
  updatePauseCountdown();
  updateDestructCountdown();
  updateFlags(deltaTime);
  updateTankDimensions(deltaTime);
  // The view flags, applied where both surfaces reach: the DOM HUD block
  // further down runs only outside XR, and blindness and colourblindness have to
  // hold in a headset too.
  refreshTankDisguises();
  // playing.cxx:6212 blanks the view for a paused tank as well as a blinded one.
  // bzo draws its own paused overlay instead, so this is Blindness alone.
  renderManager.setBlank(isViewBlinded());
  // Player::move (Player.cxx:276): recomputed off the tank's own position
  // every time it moves, not just when driving through a teleporter.
  if (myTank) {
    const at = tankPoint(myTank);
    renderManager.setTeleporterProximity(getWorldTeleporterProximity(at.x, at.y, at.z));
  }
  renderManager.updateExplosions(deltaTime);
  updatePausedSpheres();
  renderManager.updateTreads(tanks, deltaTime, gameConfig);
  // Where the treads have been. Upstream lays the marks with the rest of the
  // per-tank visuals and ages them once for the whole world
  // (`playing.cxx:7316`), so the two halves sit either side of the same call.
  updateTrackMarks(deltaTime);
  renderManager.updateTrackMarks(deltaTime);
  renderManager.updateMuzzleFlashes(deltaTime);
  renderManager.updateRicochetEffects(deltaTime);
  renderManager.updateShotTeleportEffects(deltaTime);
  renderManager.updateJumpJets(tanks, deltaTime, gameConfig);
  if (gameConfig) {
    // A Map Viewer preview's own size (issue #68), so clouds wrap within the
    // map actually on screen rather than the live match's.
    renderManager.updateClouds(deltaTime, currentWorldMapSize ?? DEFAULT_MAP_SIZE);
  }
  renderManager.updateWeather(deltaTime);
  if (deathFollowTarget && !deathFollowTarget.parent) {
    deathFollowTarget = null;
    renderManager.deathFollowTarget = null;
  }
  updateAlertHud();
  updateFiringStatusHud(getFiringStatusText());
  updateFlagHelp();
  updateFlagHelpHud();
  updateDeathCameraHudVisibility();
  updateObserverHudVisibility();
  // An observer cannot leave roaming, which is upstream's rule: Roaming::setMode
  // refuses roamViewDisabled for ObserverTeam. The player's own camera choice is
  // left untouched underneath, so it comes back on switching to a playing team.
  // Driving (issue #68) is the one exception: its two views are real first-
  // and third-person cameras on the phantom tank, not the roam camera's own
  // framing, so they read exactly as a playing tank's own choice would.
  renderManager.updateCamera({
    // The entry dialog frames the world whoever is behind it (issue #107):
    // `showEntryDialog` puts the camera in overview, and an observer would
    // otherwise keep the roaming camera and leave the map picker previewing
    // each map from wherever the last one was being watched from. The dialog
    // owns the view while it is open and gives it back on close, the same way
    // it already gives back `cameraMode`.
    cameraMode: isEntryDialogOpen()
      ? 'overview'
      // While there is a body to watch, and not a frame longer: the death
      // camera is a mode of its own rather than a second meaning for Overview,
      // so `cameraMode` underneath is untouched and the respawn simply resumes
      // it. The entry dialog still wins -- a player picking a team is choosing
      // where to go next, not watching what just happened.
      : isDeathCameraActive()
        ? 'death'
        : isPhantomDriving()
          ? (roamView === ROAM_VIEW.DRIVE_FP ? 'first-person' : 'third-person')
          // An observer's own Overview is the same world-framing camera a
          // playing tank's third mode reaches -- one implementation in
          // render.js, asked for the same way from either side, rather than a
          // roam framing that would have to recompute the map's extents.
          : (isObservingOverview() ? 'overview'
            : (isObserver() ? 'roam' : cameraMode)),
    myTank,
    azimuth: myAzimuth,
    deathFollowTarget,
    // Overview frames the world itself, so it hands over no eye/look pair of
    // its own -- leaving it out is what lets the branch above take effect.
    roamFraming: (!isEntryDialogOpen() && isObserver() && !isPhantomDriving()
      && !isObservingOverview())
      ? getRoamFraming()
      : null,
  });
  // After the camera, not with the rest of the flag work: a flag turns to face
  // wherever the viewer ended up this frame, and in a session that is decided by
  // where updateCamera just put the world.
  renderManager.updateFlagVisuals(deltaTime);
  // After the shots have been stepped and before the draw: every bolt in the
  // world is written into its colour's instanced meshes from where the
  // simulation just left it.
  renderManager.updateShotVisuals(projectiles);
  // With the flags, and after the camera for the same reason: a beacon fades on
  // how far the viewer ended up from what it marks.
  updateSkyBeacons();
  markFramePhase('sim');
  updateRadar();
  markFramePhase('radar');

  // renderManager marks 'worldfx' from inside renderFrame, once it has finished
  // rebuilding geometry and before it submits anything; the rest is the draw.
  renderManager.renderFrame();
  // After the draw, not before it: three.js updates the world matrices and
  // writes the camera's pose onto the AudioContext listener during the render,
  // so this is the one point in the frame where the ears and every tank agree
  // about where they are.
  updateVoicePlacement();
  markFramePhase('draw');
  rollFramePhases();
  sampleXRRenderStats();
  sampleIdleRenderStats();
}

// A slow series for every client, flat page included. The XR series above is
// seconds apart because a session is short and its cost is immediate; this one
// is for the opposite question -- a client that has been left open, whose frame
// rate has drifted down over an hour and comes back on a reconnect. One sample
// at map entry cannot show that, and a trend is the only thing that can.
//
// Five minutes because the symptom takes minutes to hours to appear, so twelve
// samples an hour is plenty and the cost is a log line. The counters it carries
// are cheap; the scene walk behind `objects` is the most expensive part of it and
// happens twelve times an hour.
function sampleIdleRenderStats() {
  // The XR series already covers a session, and two overlapping series would
  // interleave in the log for no gain.
  if (isXREnabled()) {
    nextIdleStatsSampleAt = 0;
    return;
  }
  const now = performance.now();
  if (nextIdleStatsSampleAt === 0) {
    nextIdleStatsSampleAt = now + IDLE_STATS_SAMPLE_INTERVAL_MS;
    return;
  }
  if (now < nextIdleStatsSampleAt) return;
  nextIdleStatsSampleAt = now + IDLE_STATS_SAMPLE_INTERVAL_MS;
  logRenderStats('idleSeries');
}

// The session's own series. The clock starts when the session does, so the
// first sample is a whole interval in and none of them describe the seconds
// after entry, where the XR panels are uploading their textures and the driver
// is still compiling.
function sampleXRRenderStats() {
  if (!isXREnabled()) {
    nextXRStatsSampleAt = 0;
    return;
  }
  const now = performance.now();
  if (nextXRStatsSampleAt === 0) {
    nextXRStatsSampleAt = now + XR_STATS_SAMPLE_INTERVAL_MS;
    return;
  }
  if (now < nextXRStatsSampleAt) return;
  nextXRStatsSampleAt = now + XR_STATS_SAMPLE_INTERVAL_MS;
  logRenderStats('xrSession');
}

// Start the game
init();
