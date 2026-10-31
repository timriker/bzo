/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
// `SERVER_LOG_PATH` moves the log, which is what `npm run check:boot` uses:
// booting a second copy of the server in this same directory would otherwise
// truncate the running one's log, since the next line clears it.
const logPath = process.env.SERVER_LOG_PATH
  || require('path').join(__dirname, 'server.log');
// Clear server.log on restart
require('fs').writeFileSync(logPath, '');
const http = require('http');
const http2 = require('http2');
const { bridgeHttp2 } = require('./server/http2-bridge.cjs');
const { URLSearchParams } = require('url');
const { WebSocketServer } = require('ws');
const {
  DEFAULT_LIST_SERVER,
  PROTOCOL_VERSION: BZFS_PROTOCOL_VERSION,
  GAME_OPTION_BITS,
  findPublicServer,
  fetchServerList,
  countServerBots,
  fetchWorldFromServer,
  probeGuestAccess,
  queryServerStatus,
  probeGlobalToken,
  decodeGameSettings,
  decodeQueryGame,
  parseWorldDatabase,
  buildBZWText,
  collectNonDefaultVariables,
  decodeSetVars,
} = require('./server/remote-world-import.cjs');
const { readReplay, writeReplay, PACKET_MODE: REPLAY_PACKET_MODE } = require('./server/bzfs-replay.cjs');
const {
  BroadcastBuffer, bufferToReplay, SERVER_PLAYER: BZO_RECORDER_PLAYER,
} = require('./server/bzo-recorder.cjs');


const { createUploadRecord } = require('./server/uploads.cjs');
const {
  ReplayRoom, summarizeReplay, fileListLines,
} = require('./server/bzfs-replay-room.cjs');
const {
  BLOWED_UP,
  PLAYER_STATUS: BZFS_PLAYER_STATUS,
  decodePlayerUpdate,
  decodeShotBegin,
  decodeGMUpdate,
} = require('./server/bzfs-session.cjs');
const {
  normalizeShotSlotCount,
  WORLD_WEAPON_PLAYER_ID,
  getWorldMissileLifetimeSeconds,
  WORLD_WEAPON_TEAM,
  normalizeShotLimit,
  getWorldReloadSeconds,
  getSlotReloadSeconds,
  findFreeShotSlot,
  countFreeShotSlots,
  shotIsActive,
  shockWaveHitsTank,
} = require('./server/shots.cjs');
const { getShotTankHit, getWorldWeaponDirection } = require('./server/shots.cjs');
const {
  BASE_SIZE,
  FLAG_ABBREVIATIONS,
  getFlagTuning,
  FLAG_CLEARANCE,
  FLAG_ENDURANCE,
  FLAG_GRAB_LEVEL_TOLERANCE,
  FLAG_GRAB_INTERVAL_MS,
  SHOCK_OUT_RADIUS,
  FLAG_RADIUS,
  FLAG_STATUS,
  findNearestGroundFlag,
  GM_TURN_ANGLE,
  TARGETING_ANGLE,
  MAX_FLAG_GRABS,
  DEFAULT_WINGS_JUMP_COUNT,
  DEFAULT_WINGS_SLIDE_TIME,
  SUPER_FLAG_HALF_LIFE_SECONDS,
  ANTIDOTE_PLACEMENT_ATTEMPTS,
  getFlagGrabRadius,
  computeFlagFlight,
  getAntidoteCoordinate,
  hasAirControl,
  shakeTimeoutTenths,
  shakeTimeoutSeconds,
  normalizeShakeWins,
  shotRicochets,
  shieldsAgainstShot,
  crushesOnContact,
  killsWholeTeam,
  getRunOverRadius,
  getRunOverSeparation,
  getFlagEndurance,
  getFlagGrabCount,
  getFlagThrownAltitude,
  getFlagType,
  setCustomFlagTypes,
  getShotEffects,
  getShockWaveRadius,
  drivesThroughBuildings,
  canRunOver,
  isCrushedByAnyone,
  getGroundLimit,
  getFiredShotFlag,
  isZoned,
  togglesZoneOnTeleport,
  canSeeTank,
  hidesFromRadar,
  seesThroughDisguises,
  getTankDimensionScale,
  getTeamFlagAbbreviation,
  formatFlagInfo,
  isTeamFlag,
  getFlagTeamIndex,
  configureFlagEffects,
  FLAG_ALTITUDE,
  FLAG_POLE_SIZE,
  VELOCITY_AD,
  ANGULAR_AD,
  TINY_FACTOR,
  OBESE_FACTOR,
  NARROW_FACTOR,
  AGILITY_AD_VEL,
  AGILITY_TIME_WINDOW,
  AGILITY_VEL_DELTA,
  SR_RADIUS_MULT,
  FLAG_EFFECT_TIME,
  GM_AD_LIFE,
  GM_ACTIVATION_TIME,
  BURROW_SPEED_AD,
  BURROW_ANGULAR_AD,
  RAPID_FIRE_AD_VEL,
  RAPID_FIRE_AD_RATE,
  THIEF_AD_SHOT_VEL,
  THIEF_AD_RATE,
  THIEF_AD_LIFE,
  THIEF_VEL_AD,
  THIEF_TINY_FACTOR,
  LASER_AD_VEL,
  LASER_AD_RATE,
  LASER_AD_LIFE,
  SHOCK_AD_LIFE,
  SHOCK_IN_RADIUS,
  MACHINE_GUN_AD_VEL,
  MACHINE_GUN_AD_RATE,
} = require('./public/js/flags.mjs');
const { steerGuidedShot, pickTargetInSights } = require('./public/js/flags.mjs');
const {
  documentTitle,
  escapeHtml,
  sanitizeHost,
  shortHostName,
} = require('./server/server-name.cjs');
const discovery = require('./server/discovery.cjs');
const l10n = require('./server/l10n.cjs');
const { localized, N_ } = require('./public/js/i18n.mjs');
const helpDocs = require('./server/help-docs.cjs');
const {
  SHOT_COLLISION_RADIUS,
  SHOT_BOUNCE_CLEARANCE,
  getBaseTeamAtPoint,
  getBaseTop,
  getShotTeleporterDims,
  findTankObstacle,
  findPhysicsSurfaceObstacle,
  resolvePhysicsDriverAt,
  getColliderLocalPoint,
  getObstacleBase,
  getObstacleHeight,
  getShotObstacleNormal,
  isOverFlatTop,
  reflectShotDirection,
  traceShotStep,
  buildCollisionColliders,
  configureTankDimensions,
  WORLD_WALL_HEIGHT,
  TANK,
} = require('./public/js/collision.mjs');
const {
  buildTeleporterIndex,
  getTeleportDestinationFace,
  rotateXY,
  transformShotThroughTeleporter,
} = require('./public/js/teleport.mjs');
const {
  findMapEdgeImpactPoint,
  traceBeam,
  traceShotThroughTeleporters,
} = require('./public/js/trace.mjs');
const {
  SPAWN_DROP_FUDGE,
  dropSpawnPosition: dropSpawnPositionOn,
  getRandomZonePoint,
  pickSpawnPosition,
  teamSpawnZones,
} = require('./public/js/spawn.mjs');
const { MAX_BUMP_HEIGHT: DEFAULT_MAX_BUMP_HEIGHT, normalizeAngle } = require('./public/js/motion.mjs');
const { packetVelocity } = require('./public/js/drive.mjs');
const { BZDB_DEFAULTS } = require('./public/js/bzdb-defaults.mjs');
const {
  BZDB_CONFIG_VARS,
  bzdbIsTrue,
  worldConfig,
} = require('./public/js/bzdb.mjs');
const { POLL_DEFAULTS, VotingArbiter, parseVoteAnswer } = require('./server/polls.cjs');
const { CustomZoneObject, createPluginHost, scanCustomMapObjects } = require('./server/plugins.cjs');
const { getKillScoreDeltas } = require('./public/js/scoring.mjs');
const { createBanStore, parseDuration } = require('./server/bans.cjs');
const {
  clampPlayingLimits,
  normalizeRabbitSelection,
  normalizeTeamLimits,
  resolveTeamMode,
  teamModeFromMaximums,
  getPlayerTeamColor,
  getInitialPlayerColor,
  getJoinPlayerColor,
  TEAM_SHADE_HUE_SPREAD,
  TEAM_SHADE_HUE_STEP,
  TEAM_SHADE_SAT_SPREAD,
  TEAM_SHADE_LIGHT_SPREAD,
  TEAM_SHADE_MIN_SATURATION,
  isColorTeam,
  isObserverTeam,
  isRabbitTeam,
  getTeamColorIndex,
  getTeamFromColorIndex,
  getTeamScoreDeltasForCapture,
  getTeamScoreDeltasForKill,
  getGameType,
  allowTeams,
  getPlayerRanking,
  pickNewRabbit,
  PLAYER_TEAM,
  PLAYER_TEAMS,
  BZFLAG_MP_TEAM_ORDER,
  BZFLAG_TEAM_ORDER,
  teamScoreMovesOnKill,
  areFoes,
} = require('./server/teams.cjs');
const { DEFAULT_TANK_SKIN } = require('./public/js/tank-skins.mjs');
const { parseProxies, proxyUrlKey } = require('./server/proxies.cjs');
const {
  ALL_PLAYERS,
  SERVER_PLAYER,
  ADMIN_PLAYERS,
  channelTeam,
  isRealPlayerId,
} = require('./server/player-ids.cjs');
const { createDiscordLink, discordLinkConfigured } = require('./server/discord.cjs');
const { createChatMirror, createDiscordToGame } = require('./server/discord-bridge.cjs');
const bzfsProxy = require('./server/bzfs-proxy.cjs');
const { sanitizeMotto, resolveProxyRequest, handleProxyConnection } = bzfsProxy;
const messagesVoice = require('./server/messages-voice.cjs');
const messagesChat = require('./server/messages-chat.cjs');
const messagesPlay = require('./server/messages-play.cjs');
const messagesOperator = require('./server/messages-operator.cjs');
// Every message a connection may send, by its `type`.
const MESSAGE_HANDLERS = Object.freeze({
  ...messagesVoice.MESSAGE_HANDLERS,
  ...messagesChat.MESSAGE_HANDLERS,
  ...messagesPlay.MESSAGE_HANDLERS,
  ...messagesOperator.MESSAGE_HANDLERS,
});
const { createGateway } = require('./server/discord-gateway.cjs');
const {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  parseCookies,
  isAdminSession,
  groupsGrantAdmin,
  isLocalAdminRequest,
  trustedClientAddress,
  isLoopbackAddress,
  parseAdminWhitelist,
  addressMatchesWhitelist,
  createSessionStore,
} = require('./server/sessions.cjs');
const { setSocketPeer } = require('./server/proxy-protocol.cjs');
const {
  KEY_MAX_AGE_MS: LIST_SERVER_KEY_MAX_AGE_MS,
  signListServerChallenge,
  verifyListServerChallenge,
  isKeyStale: isListServerKeyStale,
  createKeyStore: createListServerKeyStore,
} = require('./server/list-server.cjs');
const mapOverview = require('./server/map-overview.cjs');
const { createBzfsWorldTracker } = require('./server/bzfs-worlds.cjs');
const { createMapIndex } = require('./server/map-index.cjs');
const {
  createLagTracker,
  formatLagStats,
  compareByLag,
  PING_INTERVAL_MS,
} = require('./server/lag.cjs');
const { createServerStats, formatServerStats } = require('./server/server-stats.cjs');
const { createUpnpMapping, nameForAddress } = require('./server/upnp.cjs');
const { createUdpChannels } = require('./server/udp-channel.cjs');
const { createWebTransport } = require('./server/webtransport.cjs');
const serverStats = createServerStats();
const {
  COMMAND_TIER,
  parsePlayerTarget,
  azimuthToBearingName,
  parseMoveCoordinates,
  isCommandLine,
  parseCommandLine,
  parseHelpPrefix,
  formatCommandList,
  formatDuration,
  formatCTime,
  parseMsgCommand,
  formatUnknownCommand,
} = require('./server/commands.cjs');
const {
  missingTankParts,
  readObjObjectNames,
} = require('./public/js/tank-parts.mjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const os = require('os');

// One short hash over everything the client is served. A tab reconnects across
// a server restart rather than reloading -- deliberately, so multi-device
// testing stays cheap -- which means a restart that brought new client code
// would otherwise leave that tab running the old code indefinitely. The id
// rides in the init message and the client reloads when it changes.
//
// Hashed by content, not by mtime, so a rebuild or a checkout that changed
// nothing does not reload every client. `public/` is walked, so editing
// `server.json` or a map restarts the server without disturbing anyone -- plus
// Three's build directory, which is served from `node_modules` rather than from
// `public/` and would otherwise let a dependency bump slip past unnoticed.
// The same walk plans the brotli sidecars, because it is already holding every
// file's bytes and a sidecar is named for their digest -- see
// `server/precompress.cjs`. It only plans: nothing is compressed until `start`.
function computeClientBuild() {
  const hash = crypto.createHash('sha256');
  const hashTree = ({ root, urlPrefix }) => {
    precompress.walkFiles(root, (full, relative) => {
      const bytes = fs.readFileSync(full);
      hash.update(relative);
      hash.update(bytes);
      precompress.consider(`${urlPrefix}${relative.split(path.sep).join('/')}`, full, bytes);
    });
  };
  precompress.assetRoots().forEach(hashTree);
  return hash.digest('hex').slice(0, 12);
}
const { isHeadsetBrowserUA } = require('./public/js/headset.mjs');
const { clientTypeOf } = require('./server/client-type.cjs');
const { describeListenTarget, resolveListenTarget } = require('./server/listen-address.cjs');
const {
  createBzflagServer, publishToBzflagList, REJECT_IP_BANNED, REJECT_ID_BANNED, packGameSettings,
} = require('./server/bzflag-server.cjs');
const { generateWorldBzw } = require('./server/world-generator.cjs');
const { addCardinalLetters } = require('./server/bzflag-extras.cjs');
const {
  NativeTranslator, decodeEnter, decodeClientMessage, moveFromBzfs, shootFromBzfs,
} = require('./server/bzflag-native.cjs');
const { compileBzwWorld } = require('./server/bzw-compile.cjs');
const { packWorldDatabase, bzfsWorldHashOfBzw } = require('./server/bzflag-world.cjs');
const {
  DEFAULT_VOICE_CHANNEL,
  areVoicePeers,
} = require('./public/js/voice-channels.mjs');


// Neither console nor server.log should ever show this install's own
// absolute path -- a real disclosure (which user, which OS, which directory
// layout), not just clutter. Every path anything in this codebase logs lives
// under `__dirname`, including a stack trace's own frames, so stripping that
// one prefix here catches all of them -- current call sites and any future
// one that forgets to -- without hunting each down by hand.
function redactInstallPath(text) {
  return text.split(__dirname).join('.');
}

// Common log function: logs to console and to server.log
// One line of log arguments, for both `log` and `logError` -- shared rather
// than written twice, which is how the two drifted apart in the first place.
//
// An Error stringifies to `{}`, which is how a real failure reaches the log
// saying nothing at all: a world too large for `JSON.stringify` read as
// "Could not hash map x.bzw: {}". Its stack carries both the message and
// where it came from, and `redactInstallPath` takes the paths back out.
function formatLogArgs(args) {
  const render = (a) => {
    if (a instanceof Error) return a.stack || a.message || String(a);
    return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a);
  };
  return redactInstallPath(args.map(render).join(' '));
}

// A main thread that stops coming back to the event loop says so in the log
// (server/loop-watchdog.cjs), from a worker that keeps running when it does.
require('./server/loop-watchdog.cjs').startLoopWatchdog({ logPath, log: (...args) => log(...args) });

function log(...args) {
  const now = new Date();
  const timestamp = now.toISOString();
  const msg = formatLogArgs(args);
  const logMsg = `[${timestamp}] ${msg}`;
  // Write to console
  console.log(logMsg);
  // Append to server.log
  fs.appendFileSync(logPath, logMsg + '\n');
}

function logError(...args) {
  const now = new Date();
  const timestamp = now.toISOString();
  const msg = formatLogArgs(args);
  const logMsg = `[${timestamp}] [ERROR] ${msg}`;
  console.error(logMsg);
  fs.appendFileSync(logPath, logMsg + '\n');
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// `/login` is the one public route that costs something to serve: a callback
// carrying a token makes bzo ask my.bzflag.org about it, so an unmetered
// endpoint is an amplifier pointed at bzflag.org as much as at bzo. Ten a
// minute is far more than a login needs -- the round trip is two requests --
// and the ceiling is per address rather than per server so one player cannot
// spend everybody else's.
//
// Keyed on the address the proxy names rather than on `req.ip`, which behind the
// proxy the README describes is the *proxy* for every player at once: one bucket
// for the whole internet is a self-inflicted outage rather than a limit. The
// trusted address where the probe allows one (`trustedClientAddress`), and the
// header's own first entry until it does -- a key, not a verdict, which is the
// other reason the ceiling is generous.
function requestAddress(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const forwarded = typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : '';
  return trustedClientAddress(req.socket.remoteAddress, req.headers, forwardedForPolicy, forwardedProxyPeer)
    || forwarded || req.socket.remoteAddress || 'unknown';
}

const loginRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: requestAddress,
  // Answered by the key generator above, which reads the forwarded address
  // itself rather than leaving it to Express's `trust proxy`. That key is the
  // address exactly as read, so an address is a bucket whether it is v4 or v6.
  validate: { xForwardedForHeader: false },
  // Never silently, as with every other refusal: a player who cannot log in
  // should be findable in the log by the operator they are about to ask.
  handler: (req, res, _next, options) => {
    log(`[LOGIN] rate limited ${requestAddress(req)}:`
      + ` more than ${options.limit} requests in ${options.windowMs / 1000}s`);
    res.status(options.statusCode).type('text/plain')
      .send('Too many login requests. Try again in a minute.\n');
  },
});
// A checkout keeps what is the operator's own in `data/`, as the image keeps it
// on its `/data` volume: `server.json` and the state beside it, the cache, and
// the maps, replays and plugins it adds to the bundled ones. `./server.json`
// with no `data/server.json` is the layout from before that, read where it is
// until `npm run move-data` moves it.
const DATA_CONFIG_PATH = path.join(__dirname, 'data', 'server.json');
const LEGACY_CONFIG_PATH = path.join(__dirname, 'server.json');
const CONFIG_IS_LEGACY = !process.env.SERVER_CONFIG_PATH
  && !fs.existsSync(DATA_CONFIG_PATH) && fs.existsSync(LEGACY_CONFIG_PATH);
const CONFIG_PATH = process.env.SERVER_CONFIG_PATH
  ? path.resolve(process.env.SERVER_CONFIG_PATH)
  : (CONFIG_IS_LEGACY ? LEGACY_CONFIG_PATH : DATA_CONFIG_PATH);
if (CONFIG_IS_LEGACY) log(`Config: ${LEGACY_CONFIG_PATH} is the old layout; npm run move-data puts it in data/`);
const EXAMPLE_CONFIG_PATH = path.join(__dirname, 'example-server.json');

// The expensive things this server computes: parsed worlds and their overview
// pictures, the index naming them, and the world hashes the BZFlag tracker has
// collected. Expensive because rebuilding them means downloading every listed
// server's world again, which is the one part no amount of local CPU replaces
// -- the brotli sidecars stay with the image, since recompressing is only CPU. Beside the config file, the same
// way `RUNTIME_MAPS_DIR` sits beside it -- which puts it on the mounted volume
// in Docker (`/data/cache` for `/data/server.json`) rather than inside the
// image, where an upgrade would throw all of it away and make the next boot
// re-download every listed server's world. A checkout's is `data/cache`, as
// its config is `data/server.json`.
//
// `CACHE_PATH` overrides it, for an operator who wants this on a different
// disk from the config -- it is the larger of the two by far.
const CACHE_DIR = process.env.CACHE_PATH
  ? path.resolve(process.env.CACHE_PATH)
  : path.join(path.dirname(CONFIG_PATH), 'cache');

// Cache policy. Markup, styles and scripts must revalidate on every load: the
// client/server protocol is lockstep, so a client older than the running server
// is a desync, not a stale pixel. Only content that cannot change behaviour --
// textures, models, audio -- is cached without asking. Icons are not among
// them: a launcher captures one at install time and keeps it for the life of
// the installation, so a stale icon outlives every other kind.
const REVALIDATE = 'no-cache';
const ASSET_MAX_AGE = 604800; // 7 days

function setStaticHeaders(res, filePath) {
  // `MAP_CACHE_DIR` (below) is named for the file's own content hash, so
  // unlike everything else `express.static` serves here it can promise never
  // to change -- checked first because this same function is also the
  // `cacheControl` callback `precompress.middleware()` uses for its brotli
  // responses, and the two representations of a map file must agree.
  if (filePath.startsWith(MAP_CACHE_DIR) || filePath.startsWith(OVERVIEW_CACHE_DIR)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return;
  }
  if (/\.(?:html|css|js|mjs)$/.test(filePath) || filePath.includes(`${path.sep}icons${path.sep}`)) {
    res.setHeader('Cache-Control', REVALIDATE);
  } else {
    res.setHeader('Cache-Control', `public, max-age=${ASSET_MAX_AGE}`);
  }
}

// Wavefront geometry, named as itself. express's mime table maps `.obj` to
// TGIF's format and `.mtl` to raw bytes, which is wrong on its face and also
// hides the largest text the game serves from anything that compresses by type
// -- a proxy's list will never hold `application/x-tgif`. `express.static.mime`
// is the same instance `res.type` reads, so this reaches the identity response
// and the compressed one alike. The loader asks for text either way and does
// not consult the type.
express.static.mime.define({ 'model/obj': ['obj'], 'model/mtl': ['mtl'] });

// Every static handler below this line answers a request with a filesystem
// read -- the brotli sidecar here, the identity file in `express.static`
// further down -- and CodeQL is right to want a limit in front of that
// (`js/missing-rate-limiting`, issue #7): nothing otherwise stands between an
// unauthenticated request and repeated disk reads. Sized for a LAN party
// sharing one address rather than for a single player, the same reason
// `requestAddress` exists -- a cold join is a few dozen requests, so this
// leaves three orders of magnitude of headroom over anything an honest client
// reaches and only ever catches an actual flood.
const assetRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: requestAddress,
  validate: { xForwardedForHeader: false },
  handler: (req, res, _next, options) => {
    log(`[ASSETS] rate limited ${requestAddress(req)}:`
      + ` more than ${options.limit} requests in ${options.windowMs / 1000}s`);
    res.status(options.statusCode).type('text/plain')
      .send('Too many requests. Try again in a minute.\n');
  },
});
app.use(assetRateLimit);

// Ahead of every static handler, so a client that asks for `br` is answered
// with a sidecar wherever one has been built. The same freshness policy is
// handed over, because a compressed response and an identity one must promise
// the same thing. `cache/` is derived from `public/` and Three's build
// directory and is not in git.
const precompress = require('./server/precompress.cjs');
const { Worker } = require('worker_threads');
const {
  configureBzwParse,
  buildWorldFile,
  clientZones,
  parseBZWServerOptions,
  parseBZWMap,
  formatInstancing,
  getMaxObstacleTopY,
  addRequiredFlags,
  WORLD_FORMAT,
} = require('./server/bzw-parse.cjs');
// Beside the image's own files, not on the volume with `CACHE_DIR`: these
// sidecars are compressed copies of `public/`, they are built at image build
// time so a container needs nothing writable at runtime (see the Dockerfile),
// and a new image brings its own. The map sidecars underneath them are the
// one runtime-written part, and re-compressing those after an upgrade costs
// CPU rather than another download of every world.
precompress.configure({ cacheDir: path.join(__dirname, 'cache', 'br') });
app.use(precompress.middleware({ cacheControl: setStaticHeaders }));

// Serve Three.js from the installed dependency so the game has no third-party
// origins: an installed PWA on a headset or a LAN with no internet route still
// loads. `addons` is mounted first so the shorter path does not shadow it.
// Both directories are reached through three's own `exports` map, which is the
// only supported way in: it does not expose package.json.
const threeBuildDir = path.dirname(require.resolve('three'));
const threeAddonsDir = path.dirname(require.resolve('three/addons'));
app.use('/vendor/three/addons', express.static(threeAddonsDir, {
  setHeaders: (res) => res.setHeader('Cache-Control', REVALIDATE),
}));
app.use('/vendor/three', express.static(threeBuildDir, {
  setHeaders: (res) => res.setHeader('Cache-Control', REVALIDATE),
}));

// Content-hashed world files (see `MAP_REGISTRY` below) -- the filename is the
// hash, so a response can promise it will never change. `setStaticHeaders`
// (above) is what actually applies that promise, so it agrees with the
// brotli sidecar `precompress.middleware()` serves for the same path.
const MAP_CACHE_DIR = path.join(CACHE_DIR, 'maps');
app.use('/maps', express.static(MAP_CACHE_DIR, { setHeaders: setStaticHeaders }));

// The overview pictures this instance has drawn for *other* bzo instances'
// worlds (issue #147), kept apart from `MAP_CACHE_DIR` because that directory
// is swept against `MAP_REGISTRY` and none of these is a map this server
// holds. Named for the reporting instance's own map hash, which is a content
// hash, so the same immutable promise applies. Only the designated list
// server ever writes here; every other instance points an `<img>` at this
// route on the designated one, so the drawing happens once for everybody and
// the algorithm can change in one place.
// Which map file produced which cached world, so a restart knows what it
// already holds before the boot pass has re-read any of it
// (`server/map-index.cjs`).
const mapIndex = createMapIndex({
  statePath: path.join(CACHE_DIR, 'map-index.json'),
  overviewDir: path.join(CACHE_DIR, 'overviews'),
  log,
  logError,
});
mapIndex.load();

const OVERVIEW_CACHE_DIR = path.join(CACHE_DIR, 'overviews');
try {
  fs.mkdirSync(OVERVIEW_CACHE_DIR, { recursive: true });
} catch (error) {
  logError(`Could not create overview cache directory at ${OVERVIEW_CACHE_DIR}:`, error);
}
app.use('/overviews', express.static(OVERVIEW_CACHE_DIR, { setHeaders: setStaticHeaders }));
// Pictures drawn by a different `OVERVIEW_STYLE` go, once, so every world is
// drawn again the current way as it is next met: a local map in the boot
// pass, a bzo instance on its next report, a BZFlag world when the tracker
// finds it has no picture.
{
  const stylePath = path.join(OVERVIEW_CACHE_DIR, 'style');
  let drawnBy = null;
  try {
    drawnBy = fs.readFileSync(stylePath, 'utf8').trim();
  } catch {
    // Never recorded, which is also a different style.
  }
  if (drawnBy !== String(mapOverview.OVERVIEW_STYLE)) {
    let removed = 0;
    try {
      for (const name of fs.readdirSync(OVERVIEW_CACHE_DIR)) {
        if (!name.endsWith('.svg')) continue;
        fs.unlinkSync(path.join(OVERVIEW_CACHE_DIR, name));
        removed += 1;
      }
      fs.writeFileSync(stylePath, `${mapOverview.OVERVIEW_STYLE}\n`);
    } catch (error) {
      logError(`Could not clear ${OVERVIEW_CACHE_DIR} for a new overview style:`, error);
    }
    if (removed > 0) log(`[MAPS] cleared ${removed} overview(s) drawn in an older style`);
  }
}
// Every picture already here, planned for brotli before anything sweeps the
// sidecars: a picture is drawn once and then only read, so nothing else would
// name it to `precompress` this run, and a sidecar the plan does not name is
// swept as stale.
try {
  for (const name of fs.readdirSync(OVERVIEW_CACHE_DIR)) {
    if (!name.endsWith('.svg')) continue;
    const filePath = path.join(OVERVIEW_CACHE_DIR, name);
    precompress.consider(`/overviews/${name}`, filePath, fs.readFileSync(filePath));
  }
} catch (error) {
  logError(`Could not read ${OVERVIEW_CACHE_DIR}:`, error);
}
// Where precompress.cjs's own sidecar for a `/maps/<hash>.json` response
// lands -- `cache/br/<urlPath minus its leading slash>...`, see `consider()`.
const MAP_CACHE_BR_DIR = path.join(__dirname, 'cache', 'br', 'maps');

// After threeBuildDir, which it hashes.
const CLIENT_BUILD = computeClientBuild();
// `TimeKeeper::getStartTime()`, which is what /uptime is measured from.
const SERVER_START_TIME = Date.now();
// getAppVersion() for /serverquery. The client's version is the server's -- both
// ship from this repo -- and the build id is what actually distinguishes two
// servers running the same release, so both are said.
const SERVER_VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version);
  } catch {
    return 'unknown';
  }
})();

// How bzo introduces itself on every request it makes to somebody else's
// host: the release, the build that distinguishes two servers on it, and
// where to go to find out what it is. Nothing bzo dials should have to guess
// what called on it.
// What bzo calls itself where bzfs gives `getAppVersion()`: the list
// server's `build` and `/serverquery`. The release, then the build id, which
// is what tells two servers on one release apart.
const BZO_APP_VERSION = `bzo-${SERVER_VERSION}-${CLIENT_BUILD}`;
// What a map index entry was written by: the release, and the layout its
// world file is in, so a world written in an older one is parsed again.
const MAP_INDEX_VERSION = `${SERVER_VERSION}/world${WORLD_FORMAT}`;

const BZO_USER_AGENT =
  `bzo/${SERVER_VERSION} (${CLIENT_BUILD}; +https://github.com/timriker/bzo)`;

// index.html is rendered per request so the page is named after the host before
// any script runs. iOS reads `apple-mobile-web-app-title` for a home screen
// label, so it has to be in the markup that Safari parses, not added later by
// the client. Mounted ahead of the static handler, which would otherwise serve
// the untemplated file.
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
const INDEX_TITLE = '<title>Battlezone Online</title>';
const INDEX_APPLE_TITLE = '<meta name="apple-mobile-web-app-title" content="Battlezone Online">';
// The client needs the build id before it opens a socket, because the service
// worker's cache is keyed to it and registration happens at load.
const INDEX_BUILD = '<meta name="bzo-build" content="dev">';
// What a search engine, an AI or a link preview reads (`server/discovery.cjs`):
// the description, the Open Graph card and the structured data, with URLs
// absolute, so they are written for the host and scheme the page was asked
// for. The template's own description line is where they go.
const INDEX_DISCOVERY = '<meta name="description" content="Web based BZFlag like 3D multiplayer tank game, Battlezone Online">';
// The negotiated language: `lang` so screen readers and spellcheck are right
// from the first byte, and the catalog inlined so no frame is painted in the
// wrong one (docs/i18n-plan.md).
const INDEX_LANG = '<html lang="en">';
const INDEX_L10N = '<script type="application/json" id="bzo-l10n">{}</script>';
let indexTemplate = null;
let indexTemplateMtime = 0;

function readIndexTemplate() {
  const { mtimeMs } = fs.statSync(INDEX_PATH);
  if (indexTemplate === null || mtimeMs !== indexTemplateMtime) {
    const html = fs.readFileSync(INDEX_PATH, 'utf8');
    for (const marker of [INDEX_TITLE, INDEX_APPLE_TITLE, INDEX_BUILD, INDEX_DISCOVERY, INDEX_LANG, INDEX_L10N]) {
      if (!html.includes(marker)) {
        throw new Error(`public/index.html is missing the marker: ${marker}`);
      }
    }
    indexTemplate = html;
    indexTemplateMtime = mtimeMs;
  }
  return indexTemplate;
}

function renderIndex(host, scheme, locale, browserLocale) {
  const base = `${scheme}://${host}`;
  const title = documentTitle(host);
  const description = discovery.serverDescription(serverConfig.title, l10n.translator(locale));
  const head = discovery.pageHead({
    base, path: '/', title, description,
    jsonLd: [discovery.gameJsonLd({ base, name: title, description, version: SERVER_VERSION })],
  });
  return readIndexTemplate()
    .replace(INDEX_TITLE, `<title>${escapeHtml(title)}</title>`)
    .replace(INDEX_DISCOVERY, head.replace(/\n/g, '\n  '))
    .replace(
      INDEX_APPLE_TITLE,
      `<meta name="apple-mobile-web-app-title" content="${escapeHtml(shortHostName(host))}">`
    )
    .replace(INDEX_BUILD, `<meta name="bzo-build" content="${CLIENT_BUILD}">`)
    .replace(INDEX_LANG, `<html lang="${escapeHtml(l10n.languageTag(locale))}" dir="${l10n.textDirection(locale)}">`)
    .replace(INDEX_L10N, () => `<script type="application/json" id="bzo-l10n">${l10n.inlineJson(l10n.catalogFor(locale, browserLocale))}</script>`);
}

// The scheme and host a page was asked for, for the absolute URLs a preview,
// a sitemap or llms.txt has to carry: TLS here, or a proxy's word that the
// request reached it over TLS. Only those links depend on the scheme.
function requestBase(req) {
  const host = requestHost(req);
  if (!host) return null;
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  return `${req.secure || forwarded === 'https' ? 'https' : 'http'}://${host}`;
}

// The browser sets Host from the address the player typed, so it is the name
// they expect to see. X-Forwarded-Host is not consulted: any client can send it,
// and a proxy configured as the README describes already preserves Host.
function requestHost(req) {
  return sanitizeHost(req.get('host'));
}

app.get(['/', '/index.html'], (req, res) => {
  const host = requestHost(req);
  if (!host) {
    res.status(400).type('text/plain').send('Malformed Host header');
    return;
  }
  // res.send generates an ETag for this body, so an unchanged page still costs
  // one conditional request and a bodiless 304.
  res.set('Cache-Control', REVALIDATE);
  // Or a proxy hands one player's Spanish page to the next player.
  res.vary('Accept-Language').vary('Cookie');
  res.type('html').send(renderIndex(host, requestBase(req).split('://')[0], l10n.negotiateLocale(req),
    l10n.negotiateLocale(req, { cookie: false })));
});

// The same catalog the page inlines, for changing language without a reload.
app.get('/l10n/:locale.json', (req, res) => {
  const { locale } = req.params;
  if (!l10n.hasLocale(locale)) {
    res.status(404).type('text/plain').send('No such locale');
    return;
  }
  res.set('Cache-Control', REVALIDATE);
  res.json(l10n.catalogFor(locale));
});


// bzflag.org's global login. See docs/login.md for what it grants and
// AGENTS.md, "The global login", for the token-flow research it rests on.
//
// One route serves both halves of the round trip, below: with no `t` yet it
// is the redirect -- `misc/checkToken.php` requires that the site send the
// player to bzflag.org's own form rather than collecting a password itself,
// and a 302 from here is exactly that -- and with a `t` it is where
// bzflag.org sends them back.
const BZFLAG_LOGIN_URL = 'https://my.bzflag.org/weblogin.php';
const BZFLAG_LIST_SERVER_URL = 'https://my.bzflag.org/db/';

// CHECKTOKENS, deliberately without the `@<ip>` half. The address would have to
// be the one the *browser* used to reach my.bzflag.org, which publishes no AAAA
// record, while a browser reaching bzo prefers IPv6 where it can -- so the two
// are different families and can never match. Omitting it is what
// checkToken.php calls `checkIP` false.
//
// `groups` names the groups to ask about, joined by an already-encoded CRLF --
// `%0D%0A`, as both `checkToken.php` and bzfs's own ADD request write it. The
// membership comes back on the `TOKGOOD:` line, and only for groups named here.
async function checkGlobalToken(callsign, token, groups = []) {
  const url = `${BZFLAG_LIST_SERVER_URL}?action=CHECKTOKENS`
    + `&checktokens=${encodeURIComponent(callsign)}%3D${encodeURIComponent(token)}`
    + (groups.length > 0
      ? `&groups=${groups.map((group) => encodeURIComponent(group)).join('%0D%0A')}`
      : '');
  const response = await fetch(url, {
    headers: { 'User-Agent': BZO_USER_AGENT },
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.text();
  return { url, status: response.status, body };
}

// The reply is newline separated and each line names itself, exactly as
// ListServerConnection.cxx:118 and checkToken.php read it.
function parseGlobalTokenReply(body) {
  const result = { good: false, callsign: null, groups: [], bzid: null, lines: [] };
  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    result.lines.push(line);
    if (line.startsWith('TOKGOOD: ')) {
      result.good = true;
      // `TOKGOOD: callsign:GROUP:GROUP` -- the callsign, then a group per colon.
      const [callsign, ...groups] = line.slice('TOKGOOD: '.length).split(':');
      result.callsign = callsign;
      result.groups = groups;
    } else if (line.startsWith('BZID: ')) {
      // `BZID: <numeric id> <callsign>`, and a callsign may contain a space, so
      // only the first one separates the two.
      const [bzid, callsign] = line.slice('BZID: '.length).split(/\s+(.*)/s);
      result.bzid = bzid;
      if (callsign) result.callsign = callsign;
    }
  }
  return result;
}

// Where either ending of a login sends the browser: back to the page that
// started it, so `/list`'s own login button returns there rather than to `/`.
// A path segment on `/login` itself carries this rather than a query
// parameter, because the callback below already has to stay free of `&` --
// see the comment on `callback` -- and an extra path segment costs it
// nothing. Keyed by an allowlist rather than trusting whatever segment
// arrives: `/login/<anything>` reaching this far unrecognised would otherwise
// be an open redirect.
const LOGIN_RETURN_PATHS = Object.freeze({ list: '/list' });


// bzfs's own sentences come back over the wire, so they are read as data: only
// what a terminal-safe line can hold, and only as much of it as a verdict
// needs.
function sanitizeServerText(text) {
  return String(text).replace(/[^\x20-\x7e]/g, '').slice(0, 200);
}

// Which page a login comes back to, or undefined for a segment that names
// nothing. A proxy target is a return page of its own: a player signing in
// while watching a real server should come back to that match rather than to
// this server's own game, and `?proxy=` is the link that means that page (see
// `resolveProxyTarget`).
const PROXY_PROBE_PREFIX = 'probe-';

// A second segment may name the roam view to come back watching in, so a
// spectator link survives a login: `?view=` is the client's own parameter and
// it is the client that refuses one it does not recognise (`readAutoRoamView`
// in client.js, whose list is the roam cycle). Here it only has to be
// something safe to put back in a URL -- it lands in a query string on bzo's
// own page, never in a path or a host, so the shape is the whole check.
const RETURN_VIEW_PATTERN = /^[a-z][a-z-]{1,11}$/;

function resolveLoginReturnPath(segment, view, team) {
  if (segment === undefined) return '/';
  if (LOGIN_RETURN_PATHS[segment] !== undefined) return LOGIN_RETURN_PATHS[segment];
  if (!PROXY_TARGETS_BY_URL[segment]) return undefined;
  const watching = typeof view === 'string' && RETURN_VIEW_PATTERN.test(view)
    ? `&view=${encodeURIComponent(view)}`
    : '';
  // A third segment names the team to come back on. Signing in is what makes
  // playing possible at all on a target that has the callsign registered
  // (`playerAlive`, bzfs.cxx:3199), so a round trip that dropped the team
  // would answer the player's question and undo their choice in one move --
  // they would arrive verified and watching. Checked against the same list
  // `resolveProxyTarget` accepts, because it lands in the same parameter.
  const playing = (team === PLAYER_TEAM.AUTOMATIC || PLAYER_TEAMS.includes(team))
    ? `&team=${encodeURIComponent(team)}`
    : '';
  return `/?proxy=${encodeURIComponent(segment)}${watching}${playing}`;
}

// The token half of a login made on a proxied server's behalf, waiting for
// the WebSocket that will spend it. It is never checked here: `CHECKTOKENS`
// is answered once, so asking would spend the very thing the target needs,
// and bzfs is the one that should be verifying a player about to play there.
//
// The token is deliberately in memory and deliberately not in `sessions`: a
// session is written to `sessions.json`, and a live credential does not
// belong in a file. The *callsign* is a session, because it is not a
// credential -- it is what this browser is called over there, and it should
// survive a reconnect and a restart even though the verification cannot.
//
// One use. bzflag.org answers a token once, so the first `MsgEnter` that
// carries it is the only one it can verify.
const PROXY_LOGIN_COOKIE = 'bzo_proxy_login';
const PROXY_LOGIN_TTL_MS = 5 * 60 * 1000;
const pendingProxyLogins = new Map();

function stashProxyLogin(target, callsign, token, now = Date.now()) {
  for (const [id, pending] of pendingProxyLogins) {
    if (pending.expiresAt <= now) pendingProxyLogins.delete(id);
  }
  const id = crypto.randomBytes(18).toString('base64url');
  pendingProxyLogins.set(id, {
    target,
    callsign,
    token,
    expiresAt: now + PROXY_LOGIN_TTL_MS,
  });
  return id;
}

// Takes it, rather than reads it: whatever happens to the join, this token is
// spent.
function takeProxyToken(id, target, now = Date.now()) {
  const pending = typeof id === 'string' ? pendingProxyLogins.get(id) : undefined;
  if (!pending) return null;
  pendingProxyLogins.delete(id);
  if (pending.expiresAt <= now || pending.target !== target) return null;
  return pending;
}

// The other thing a `/login` segment may name: the forwarded-token probe of
// step 1, which is a diagnostic rather than a way in. It keeps a prefix of its
// own now that a bare target names the way back to that target's own page --
// the probe deliberately does *not* create a session here, because it spends
// the token on bzfs instead.
function resolveProbeTarget(segment) {
  if (typeof segment !== 'string' || !segment.startsWith(PROXY_PROBE_PREFIX)) return null;
  const key = segment.slice(PROXY_PROBE_PREFIX.length);
  const target = PROXY_TARGETS_BY_URL[key];
  return target ? { key, target } : null;
}

// Both endings of a login are a redirect back to `returnPath`, so the page
// reloads and comes back on a fresh socket -- there is no identity to migrate
// onto a live connection, and a failed login needs nothing beyond clearing the
// cookie.
//
// Failure is reported in the **fragment**. A fragment never reaches a server, so
// nothing lands in an access log or a `Referer`, and its value only picks a
// message: forging it achieves nothing.
//
// The cookie carries one opaque id and no attribute of the player. `HttpOnly`
// keeps it away from scripts, `Secure` from plain HTTP -- the callback is HTTPS
// by construction, since `/login` builds it that way -- `SameSite=Lax` off a
// cross-site WebSocket handshake, and no `Domain` keeps it host-only rather
// than shared with every sibling of this host.
function finishLogin(res, sessionId, returnPath = '/') {
  if (sessionId) {
    res.cookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS,
    });
    res.redirect(302, returnPath);
    return;
  }
  res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  res.redirect(302, `${returnPath}#login=failed`);
}

// One route for both halves, because the query string already says which is
// wanted: arriving with no `t` at all is someone who has not been to
// bzflag.org yet, and arriving with one is bzflag.org sending them back. The
// optional `:returnPage` segment is only ever `list` today (see
// `LOGIN_RETURN_PATHS`); both halves read it the same way, since bzflag.org's
// callback is this same URL with `t` filled in.
app.get('/login/:returnPage?/:returnView?/:returnTeam?', loginRateLimit, async (req, res) => {
  const probe = resolveProbeTarget(req.params.returnPage);
  const probeTarget = probe ? probe.target : undefined;
  const returnPath = resolveLoginReturnPath(req.params.returnPage, req.params.returnView, req.params.returnTeam);
  if (returnPath === undefined && probeTarget === undefined) {
    res.status(404).type('text/plain').send('Unknown login return page.\n');
    return;
  }
  // No `t` parameter: start the round trip.
  if (req.query.t === undefined) {
    const host = requestHost(req);
    if (!host) {
      res.status(400).type('text/plain').send('Malformed Host header');
      return;
    }
    // `%TOKEN%` and `%USERNAME%` are substituted by weblogin.php. Both ride in
    // one parameter, separated by a colon: an unencoded `&` in `url=` would
    // belong to weblogin.php's own query string rather than to this callback,
    // so a second parameter would never arrive. checkToken.php's alternative is
    // to encode the whole value, which would also encode the two placeholders,
    // and whether they still substitute is not documented -- so this is the
    // shape known to work. The return page rides in the *path* instead, for the
    // same reason: it costs no `&` either.
    // Every segment the round trip has to survive goes here, in order: a
    // segment left out is a choice the player has to make again after signing
    // in, and the team is the one they most often signed in *for*.
    // Stops at the first one missing, because the segments are positional:
    // a team behind an absent view would arrive as the view.
    let carried = '';
    for (const segment of [req.params.returnPage, req.params.returnView, req.params.returnTeam]) {
      if (!segment) break;
      carried += `/${segment}`;
    }
    const callback = `https://${host}/login${carried}?t=%TOKEN%:%USERNAME%`;
    const target = `${BZFLAG_LOGIN_URL}?action=weblogin&url=${callback}`;
    log(`[LOGIN] redirecting to bzflag.org, callback ${callback}`);
    // The header is set rather than sent through `res.redirect`, which runs the
    // URL through `encodeurl` and turns `%TOKEN%` into `%25TOKEN%25` -- a lone
    // `%` is not a valid escape, so it gets escaped, and weblogin.php then has
    // nothing it recognises to substitute.
    res.status(302).set('Location', target).end();
    return;
  }

  res.type('text/plain');
  // Plain text, and nothing the query string carried is echoed into it: a
  // malformed callback gets one of bzo's own fixed sentences below, never
  // bzflag.org's reply or anything reflected back from `t`. A reflected `t`
  // would be markup in a response of bzo's own making -- text/plain or not,
  // that is a page an attacker wrote -- and the `[LOGIN]` lines already record
  // the value for anybody diagnosing a real callback. A verified callback
  // never reaches this response at all: `finishLogin` redirects instead.
  //
  // A `t` that is present but unusable is an error rather than a fresh start.
  // Redirecting on it would send the player back to bzflag.org, which would
  // return them here with the same empty parameter, forever.
  const packed = typeof req.query.t === 'string' ? req.query.t : '';
  if (!packed) {
    res.status(400).send('Came back with an empty token. Start again at /login.\n');
    return;
  }
  // Express decodes `+` to a space, which is what a callsign with a space
  // arrives as. The token comes first and holds no colon, so the split is on
  // the first one only -- whatever follows is the callsign, colons and all.
  const separator = packed.indexOf(':');
  const token = separator === -1 ? packed : packed.slice(0, separator);
  const callsign = separator === -1 ? '' : packed.slice(separator + 1);
  log(`[LOGIN] callback token=${token} callsign="${callsign}"`);
  if (!callsign) {
    res.status(400).send('Got a token but no callsign. Start again at /login.\n');
    return;
  }

  // A login for a proxied server keeps its token for that server's own join.
  // Nothing is verified here, so nothing is claimed here: the browser comes
  // back to the match, and the next WebSocket it opens to that target carries
  // the token into `MsgEnter`. bzfs answers "Global login approved!" -- or
  // does not -- in the chat the player is already reading.
  if (probeTarget === undefined && PROXY_TARGETS_BY_URL[req.params.returnPage]) {
    const id = stashProxyLogin(req.params.returnPage, callsign, token);
    // And a session for the callsign alone, with no BZID, because bzo checked
    // nothing: it is what keeps the name across a reconnect or a restart,
    // once the token that could only be answered once is gone. A session this
    // browser already holds for the same callsign is kept instead, so a BZID
    // bzo verified at its own /login survives for `/origin`.
    const heldId = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    const held = sessions.get(heldId);
    const sessionId = held && held.callsign === callsign
      ? heldId
      : sessions.create({ bzid: null, callsign, groups: [] });
    log(`[PROXY] ${req.params.returnPage}: holding a login for "${callsign}"`);
    res.cookie(PROXY_LOGIN_COOKIE, id, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: PROXY_LOGIN_TTL_MS,
    });
    finishLogin(res, sessionId, returnPath);
    return;
  }

  // A probe target spends the token on bzfs rather than here. CHECKTOKENS is
  // deliberately not called first: a token is answered once, so asking would
  // be the proxy consuming the very thing it is trying to forward.
  if (probeTarget) {
    log(`[PROXY] probing ${probeTarget.host}:${probeTarget.port}`
      + ` as "${callsign}" with a forwarded token`);
    try {
      const result = await probeGlobalToken({
        host: probeTarget.host,
        port: probeTarget.port,
        callsign,
        token,
      });
      log(`[PROXY] ${probe.key} ${result.verdict}`
        + ` accepted=${result.accepted}`);
      for (const line of result.messages) log(`[PROXY] < ${sanitizeServerText(line)}`);
      // Plain text, never the HTML `res.send` assumes for a string: the lines
      // are the target's own words, and a target is a server nobody here runs.
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.set('X-Content-Type-Options', 'nosniff');
      res.send(`${probe.key}: ${result.verdict}\n`
        + `entered: ${result.accepted}\n`
        + (result.reason ? `reason: ${sanitizeServerText(result.reason)}\n` : '')
        + result.messages.map((line) => `< ${sanitizeServerText(line)}\n`).join(''));
    } catch (err) {
      logError('[PROXY] probe failed', err);
      res.status(502).type('text/plain').send('The probe could not finish. See the server log.\n');
    }
    return;
  }

  try {
    const { url, status, body } = await checkGlobalToken(callsign, token, ADMIN_GROUPS);
    const parsed = parseGlobalTokenReply(body);
    log(`[LOGIN] CHECKTOKENS ${status} good=${parsed.good} bzid=${parsed.bzid || 'none'}`
      + ` callsign="${parsed.callsign || ''}" groups=${parsed.groups.join(',') || 'none'}`);
    for (const line of parsed.lines) log(`[LOGIN] < ${line}`);
    if (!parsed.good || !parsed.bzid) {
      log(`[LOGIN] refused "${callsign}" (${url})`);
      finishLogin(res, null, returnPath);
      return;
    }
    // A group asked about and not named back is a group this player is not in,
    // which is the same answer as a group that does not exist -- so the
    // membership stored is the intersection with what the server asked, and
    // nothing else. `isAdminSession` reads it later against `ADMIN_GROUPS`.
    const sessionId = sessions.create({
      bzid: parsed.bzid,
      // The callsign bzflag.org confirmed, not the one the query string carried.
      callsign: parsed.callsign || callsign,
      groups: parsed.groups,
    });
    log(`[LOGIN] "${parsed.callsign || callsign}" bzid=${parsed.bzid} signed in`
      + `; admin=${isAdminSession(sessions.get(sessionId), ADMIN_GROUPS)}`
      + `; sessions=${sessions.size}`);
    finishLogin(res, sessionId, returnPath);
  } catch (err) {
    logError('[LOGIN] CHECKTOKENS failed', err);
    finishLogin(res, null, returnPath);
  }
});

// The other half of `finishLogin`: removes the stored session, if the cookie
// still names one, and clears it either way. Also a page navigation, for the
// same reason `/login` is one -- there is no identity to migrate onto a live
// connection, so the browser has to come back on a fresh socket to see it gone.
app.get('/logout/:returnPage?/:returnView?/:returnTeam?', (req, res) => {
  // The same allowlist `/login` returns through, for the same reason: signing
  // out while watching a proxied match should leave you watching it.
  const returnPath = resolveLoginReturnPath(req.params.returnPage, req.params.returnView, req.params.returnTeam);
  if (returnPath === undefined) {
    res.status(404).type('text/plain').send('Unknown logout return page.\n');
    return;
  }
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (sessionId && sessions.remove(sessionId)) {
    log(`[LOGIN] session removed via /logout; sessions=${sessions.size}`);
  }
  res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  res.redirect(302, returnPath);
});

// Which icon a launcher takes from the manifest is documented nowhere and the
// platforms disagree, so log the fetches: the pair of lines names the browser
// that asked and the file it settled on.
app.use((req, res, next) => {
  if (req.path === '/manifest.webmanifest' || req.path.startsWith('/icons/')) {
    log(`[INSTALL] ${req.path} ua="${req.get('user-agent') || ''}"`);
  }
  next();
});

// Serve static files
app.use(express.static('public', { setHeaders: setStaticHeaders }));

// Whether an OBJ carries the parts the renderer clones, keyed by file and
// mtime: the list is rebuilt on every request and on every setTankModel, and
// re-reading five files each time would be a parse per message. A model that
// fails is named once per version of the file, not once per lookup.
const tankModelPartsByFile = new Map();
const reportedBadTankModels = new Set();

function tankModelIsBuildable(filePath) {
  let stamp = '';
  try {
    stamp = String(fs.statSync(filePath).mtimeMs);
  } catch (error) {
    logError(`Failed to stat tank model ${path.basename(filePath)}:`, error.message || error);
    return false;
  }
  const cached = tankModelPartsByFile.get(filePath);
  if (cached && cached.stamp === stamp) return cached.buildable;

  let missing = ['a readable OBJ file'];
  try {
    missing = missingTankParts(readObjObjectNames(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    logError(`Failed to read tank model ${path.basename(filePath)}:`, error.message || error);
  }
  const buildable = missing.length === 0;
  tankModelPartsByFile.set(filePath, { stamp, buildable });

  const reportKey = `${filePath}@${stamp}`;
  if (!buildable && !reportedBadTankModels.has(reportKey)) {
    reportedBadTankModels.add(reportKey);
    logError(`Tank model ${path.basename(filePath)} is not offered: no ${missing.join(', no ')}.`
      + ' See docs/tank-model-format.md for the object names a model must carry.');
  }
  return buildable;
}

// Every OBJ in public/obj is a tank the player may choose, except two that are
// not -- `tank.obj`, upstream's own mesh that `split-bzflag-tank` reads, and
// `missile.obj`, the guided missile -- and the ones that cannot be drawn. A
// model missing its parts is left out rather than listed: the client builds
// tanks from the file alone, so offering one it cannot build would put a
// player in a tank nobody can see.
// A model's name in the picker where its file name does not spell it.
const TANK_MODEL_LABELS = {
  bzflag: 'BZFlag',
  'bzflag-notracks': 'BZFlag notracks',
  wheeled6: 'Wheeled 6',
};

function getAvailableTankModels() {
  const objDir = path.join(__dirname, 'public', 'obj');
  const hiddenModelFiles = new Set(['tank.obj', 'missile.obj']);
  try {
    return fs.readdirSync(objDir)
      .filter((fileName) => fileName.toLowerCase().endsWith('.obj'))
      .filter((fileName) => !hiddenModelFiles.has(fileName.toLowerCase()))
      .filter((fileName) => tankModelIsBuildable(path.join(objDir, fileName)))
      .map((fileName) => {
        const id = fileName.slice(0, -4).toLowerCase();
        const label = TANK_MODEL_LABELS[id] ?? id
          .split(/[-_\s]+/)
          .filter(Boolean)
          .map((part) => (part === 'bzflag' ? 'BZFlag' : part.charAt(0).toUpperCase() + part.slice(1)))
          .join(' ');
        return {
          id,
          path: `/obj/${fileName}`,
          label: label || id,
        };
      })
      .sort((left, right) => {
        if (left.id === 'bzflag') return -1;
        if (right.id === 'bzflag') return 1;
        return left.id.localeCompare(right.id);
      });
  } catch (error) {
    logError('Failed to list tank models:', error.message || error);
    return [];
  }
}

function isAllowedTankModel(modelId) {
  if (typeof modelId !== 'string') return false;
  const normalized = modelId.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(normalized)) return false;
  return getAvailableTankModels().some((model) => model.id === normalized);
}

function normalizeTankModelId(modelId) {
  const normalized = typeof modelId === 'string' ? modelId.trim().toLowerCase() : '';
  if (normalized === 'default') return 'bzflag';
  if (normalized === 'bzflag-tank') return 'bzflag';
  // The treads tank's own name before it became the stock one.
  if (normalized === 'bzflag-treads') return 'bzflag';
  if (normalized === 'tank') return 'bzflag';
  return normalized;
}

app.get('/api/tank-models', (req, res) => {
  res.json({ models: getAvailableTankModels() });
});

// Called only by this server, on itself, via `PUBLIC_URL` -- see
// probeAdminWhitelist. Echoes back exactly what the request looked like by the
// time it reached this process, which is what a real external connection would
// look like too, so that call can tell whether the proxy in front is safe to
// trust X-Forwarded-For through.
app.get('/api/_admin-probe', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    remoteAddress: req.socket.remoteAddress,
    xForwardedFor: req.headers['x-forwarded-for'] || null,
  });
});

// A position, a flag, a speed -- everything `/playerlist` doesn't say, for
// This instance's recordings, for the View dialog's "Local replays" table:
// what `/list` shows of each, less the file's own details. Public, as the
// list is; a replay is anyone's to watch.
app.get('/api/replays', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const replays = await listReplays();
    res.json({
      replays: replays.filter((entry) => entry.summary).map((entry) => ({
        name: entry.name,
        start: entry.summary.start,
        seconds: entry.summary.seconds,
        players: entry.summary.players.length,
        map: entry.map,
        viewers: entry.playing ? entry.playing.viewers : 0,
      })),
    });
  } catch (error) {
    logError('/api/replays failed:', error);
    res.status(500).json({ replays: [] });
  }
});

// Everyone in the game as a client sees them, for a site that polls servers
// (docs/api.md). Nothing here is private: every client is sent every tank's
// moves, flag and score, and Stealth and Cloaking only change what an
// unmodified client draws. A player's address is the one thing left out --
// that is for operators. Built at most every `PLAYERS_API_MS`, so a poller
// costs one build however often it asks.
const PLAYERS_API_MS = 500;
let playersApiCache = null;
function playersApiBody(now) {
  if (playersApiCache && now - playersApiCache.at < PLAYERS_API_MS) return playersApiCache.body;
  const body = JSON.stringify({
    now,
    players: [...players.values()].filter((player) => player.joined).map((player) => {
      const flag = getPlayerFlag(player.id);
      return {
        id: player.id,
        name: player.name,
        bzid: player.bzid ?? null,
        motto: player.motto || '',
        team: player.team,
        x: player.x,
        y: player.y,
        z: player.z,
        azimuth: player.azimuth,
        forwardSpeed: player.forwardSpeed,
        rotationSpeed: player.rotationSpeed,
        verticalVelocity: player.verticalVelocity,
        alive: player.alive,
        wins: player.wins,
        losses: player.losses,
        tks: player.tks,
        paused: player.paused,
        autopilot: player.autopilot === true,
        // When this connection was made, ms since 1970, as `now` is.
        connectedAt: player.connectDate ? player.connectDate.getTime() : null,
        flag: flag ? { type: flag.type, zoned: flag.zoned === true } : null,
        // The scoreboard's `T` column: client type, then UDP (`playerLink`).
        clientType: playerClientType(player),
        link: playerLink(player),
        // `/lagstats`, which any player may ask for.
        lag: player.lag.hasSamples() ? player.lag.getLag(now) : null,
        jitter: player.lag.hasSamples() ? player.lag.getJitter() : null,
        loss: player.lag.hasSamples() ? player.lag.getLoss() : null,
      };
    }),
  });
  playersApiCache = { at: now, body };
  return body;
}

app.get('/api/players', (req, res) => {
  res.set('Cache-Control', 'public, max-age=1');
  res.set('Access-Control-Allow-Origin', '*');
  res.type('application/json').send(playersApiBody(Date.now()));
});

// What only the map file knows about a world, for the viewer's summary: the
// file, the texture names that resolved to nothing, and the parse's warnings.
app.get('/api/world/:hash/summary', async (req, res) => {
  const { hash } = req.params;
  if (!/^[0-9a-f]{12}$/.test(hash)) {
    res.status(400).json({ error: 'bad request' });
    return;
  }
  const sources = await obstacleSourcesFor(hash);
  if (!sources) {
    res.status(404).json({ error: 'no map file for that world' });
    return;
  }
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    file: sources.fileName,
    lines: sources.text.split('\n').length,
    missingTextures: sources.missingTextures,
    warnings: sources.warnings,
  });
});

// A map's world by its file name, or `live` for the match being played, for
// pages that name a map rather than a hash (public/renderer-bench.html). An
// import is found while its world is held; a local map nobody has viewed is
// converted first, as `?viewmap=` would.
app.get('/api/world/file/:file', async (req, res) => {
  const { file } = req.params;
  const held = MAP_REGISTRY.get(file);
  const entry = file === 'live' ? LIVE_MAP_ENTRY
    : held && fs.existsSync(path.join(MAP_CACHE_DIR, `${held.hash}.json`)) ? held
      : await prepareMapForView(file);
  if (!entry || !entry.hash) {
    res.status(404).json({ error: 'no such map' });
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.json({ file: entry.fileName || MAP_SOURCE, hash: entry.hash, url: entry.url });
});

// One obstacle's block in its map file (`obstacleSourceFor`), by world hash
// and its index in that world's `obstacles`.
app.get('/api/world/:hash/obstacles/:index/source', async (req, res) => {
  const { hash } = req.params;
  const index = Number(req.params.index);
  if (!/^[0-9a-f]{12}$/.test(hash) || !Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: 'bad request' });
    return;
  }
  const source = await obstacleSourceFor(hash, index);
  if (!source) {
    res.status(404).json({ error: 'no source for that obstacle' });
    return;
  }
  res.set('Cache-Control', 'public, max-age=60');
  res.json(source);
});

// The cheapest thing a client can ask to find out whether the server is
// serving. A reload is what a restarted client does, and a reload that lands
// while the server is still coming back is a browser error page -- with no
// script left running, that tab is dead until somebody presses reload by hand.
// So the client waits on this first; see `reloadWhenServerIsUp` in client.js.
// No state, no headers worth caching, and it must stay that way: it is answered
// while the world is still being built.
app.get('/api/ready', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ready: true, build: CLIENT_BUILD });
});

// The ICE servers a player gets at join, for public/webrtc-test.html: a page
// with no game connection that still has to reach the same relay. The TURN
// credential is the same short-lived kind any visitor gets by joining.
// `?provider=test` answers server.json's `testIceServers` instead: another
// provider's relay, to tell a network's reaction to ours from its reaction to
// any relay at all.
app.get('/api/voice-ice', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.query.provider === 'test') {
    res.json({ iceServers: parseVoiceIceServers(serverConfig.testIceServers) });
    return;
  }
  // What a phone gets: the IPv4-only names, `voiceIceServersIpv4`.
  if (req.query.provider === 'ipv4') {
    const config = voiceRtcConfigFor('test');
    res.json({ iceServers: config.ipv4IceServers || config.iceServers });
    return;
  }
  // bzo's own relay reached over one address family alone, by its literal
  // address: `relay4`, `relay6`.
  if (req.query.provider === 'relay4' || req.query.provider === 'relay6') {
    const host = req.query.provider === 'relay4' ? '4.236.50.141' : '[2603:1030:501:14::2f]';
    const servers = voiceRtcConfigFor('test').iceServers
      .filter((server) => server.username !== undefined)
      .slice(0, 1)
      .map((server) => ({ ...server, urls: [`turn:${host}:3478?transport=udp`] }));
    res.json({ iceServers: servers });
    return;
  }
  // The same relay reached on UDP 3478 alone, the port bzo's own uses.
  if (req.query.provider === 'test3478') {
    const servers = parseVoiceIceServers(serverConfig.testIceServers)
      .filter((server) => server.username !== undefined)
      .slice(0, 1)
      .map((server) => ({ ...server, urls: [server.urls[0].replace(/:\d+(\?.*)?$/, ':3478?transport=udp')] }));
    res.json({ iceServers: servers });
    return;
  }
  res.json(voiceRtcConfigFor('test'));
});

// The test page's own log, into server.log: lines written while the device's
// connection was down arrive together once it is back, each with the page's
// own clock. Short lines only, and only from that page's shape of request.
app.post('/api/webrtc-test-log', (req, res) => {
  const lines = Array.isArray(req.body?.lines) ? req.body.lines.slice(0, 50) : [];
  // public/wt-test.html logs the same way, under its own tag.
  const tag = req.body?.page === 'wt-test' ? 'wt-test' : 'webrtc-test';
  const ip = (req.get('x-forwarded-for') || '').split(',')[0].trim() || req.socket.remoteAddress;
  lines.forEach((line) => {
    if (typeof line === 'string') log(`[${tag}] ${ip} ${line.slice(0, 200).replace(/[\r\n]/g, ' ')}`);
  });
  res.status(204).end();
});

// A server-rendered, standalone page -- not part of the game client bundle,
// no websocket -- listing what /list's data sources already are: the
// public BZFlag list server (`getRemoteServerList`, cached 5 minutes and
// shared across every visitor) and bzo's own maps/ directory. Both viewing
// and importing are open to anyone, but an import target must be an exact
// host:port in that public list -- a server that has left it can still be
// viewed from a copy already here, never fetched again. Importing costs this
// server one fetch and
// one file (capped in remote-world-import.cjs), viewing costs only the viewer's
// own client, so neither needs an operator -- only actually switching the live
// match (`setMap`, from the game itself) does. Sorting
// and filtering are a few lines of vanilla JS over the rows already in the
// page -- there is no client-side framework anywhere else in bzo and two
// short tables do not need one either.
// KB is plenty of precision for a table cell -- nobody sorting/scanning this
// page needs the exact byte count `performRemoteMapImport`'s own log line
// already carries.
// Compact on purpose: these sit several to a line in a readout pane, and a
// tenth of a kilobyte has never told anyone anything about a world.
function formatByteSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}k`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// Several sizes as one field. A missing one is a dash rather than a gap, so
// the reader can still tell which of them is missing; all missing is no
// field at all rather than a row of dashes.
function joinSizes(...sizes) {
  if (!sizes.some((size) => size > 0)) return '';
  return sizes.map((size) => (size > 0 ? formatByteSize(size) : '-')).join('/');
}

// The world facts a bzfs row carries to every other instance: bzfs's own hash
// and how many bytes it sent, then what bzo made of it. Exact byte counts --
// a reader that wants them rounded can round them, and one that wants to
// compare or sum them still can.
function publishWorldFacts(host, port) {
  const record = bzfsWorlds.recordFor(host, port);
  const measured = measureImportedWorld(host, port);
  // Measured where the files are still there, remembered where they are not:
  // an import is swept two hours after it was fetched, and the figures it had
  // were true when taken.
  bzfsWorlds.noteSizes(host, port, measured);
  const facts = {
    hash: record?.worldHash || '',
    sent: record?.worldCompressed || 0,
    inflated: record?.worldUncompressed || 0,
    bzw: measured.bzw || record?.bzw || 0,
    json: measured.json || record?.json || 0,
    brotli: measured.brotli || record?.brotli || 0,
    // Name to value, in the order the server sent them. Kept as pairs, read
    // either way (`variablePairs`): an instance from before this sent pairs.
    variables: record?.variables?.length ? Object.fromEntries(record.variables) : undefined,
    // bzfs's own `getAppVersion()`, from `/serverquery` on a visit.
    version: record?.serverVersion || undefined,
    // What an unregistered player may do there, where a visit has found out
    // (`server/bzfs-worlds.cjs`). Absent until it has.
    guestWatch: guestAnswer(record?.guest?.watch),
    guestChat: guestAnswer(record?.guest?.chat),
    guestSpawn: guestAnswer(record?.guest?.spawn),
  };
  return Object.values(facts).some((value) => value) ? facts : null;
}

// Whether a bzfs row's server lets an unregistered player spawn, as far as
// this instance knows.
function entryGuestSpawn(server) {
  return guestAnswer((server.world || publishWorldFacts(server.host, server.port) || {}).guestSpawn);
}

// A guest fact as a row may show it: an answer bzfs gave, or nothing. Applied
// to facts read off another instance's list too, which arrive unchecked.
function guestAnswer(value) {
  return value === 'yes' || value === 'no' ? value : undefined;
}

// What this server can measure of one imported world right now. Blank for any
// of it whose file has gone.
function measureImportedWorld(host, port) {
  const fileName = remoteMapFileName(host, port);
  const registered = MAP_REGISTRY.get(fileName);
  const bzwPath = resolveMapFilePath(fileName);
  return {
    bzw: bzwPath ? statSizeBytes(bzwPath) : 0,
    json: registered ? statSizeBytes(path.join(MAP_CACHE_DIR, `${registered.hash}.json`)) : 0,
    brotli: registered ? brotliSizeBytes(`${registered.hash}.json`) : 0,
  };
}

// What this instance's own live world costs, in the same terms the bzfs pane
// reports for an imported one (issue #147): the map file it was read from,
// the parsed world it produced, and what that world weighs on the wire once
// brotli has it. Reported to the list server rather than measured there --
// only the instance itself can see its own `maps/` directory, and the list
// server holding a copy of every instance's world just to weigh it is the
// download this whole arrangement exists to avoid.
//
// Raw byte counts, not formatted strings: a row is rendered where it is
// shown, and a number survives being compared or summed.
function measureLiveWorld() {
  if (!LIVE_MAP_ENTRY) return null;
  const sizeOf = (filePath) => {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  };
  // A generated world's `.bzw` is the text it was generated as.
  const mapFilePath = MAP_SOURCE === 'random' ? null : resolveMapFilePath(MAP_SOURCE);
  const brotliName = `${LIVE_MAP_ENTRY.hash}.json`;
  return {
    hash: LIVE_MAP_ENTRY.hash,
    bzw: mapFilePath ? sizeOf(mapFilePath) : (RANDOM_WORLD_BZW ? Buffer.byteLength(RANDOM_WORLD_BZW) : 0),
    json: sizeOf(path.join(MAP_CACHE_DIR, `${LIVE_MAP_ENTRY.hash}.json`)),
    brotli: sizeOf(path.join(MAP_CACHE_BR_DIR, brotliSidecarName(brotliName) || '\0')),
  };
}

// The sidecar's own file name, which carries a content digest as well as the
// path -- found by prefix rather than built, since there is one at most.
function brotliSidecarName(name) {
  try {
    const prefix = `${name}.`;
    return fs.readdirSync(MAP_CACHE_BR_DIR)
      .find((entry) => entry.startsWith(prefix) && entry.endsWith('.br')) || '';
  } catch {
    return '';
  }
}

// The brotli sidecar `server/precompress.cjs` wrote for one cached file. Its
// name carries the content digest as well as the path, so it is found by
// prefix rather than built -- there is one at most, since a stale one is
// swept when the digest moves.
function brotliSizeBytes(name) {
  const match = brotliSidecarName(name);
  if (!match) return 0;
  return statSizeBytes(path.join(MAP_CACHE_BR_DIR, match));
}

// A bzo instance's own reported world sizes, rendered into the same fields
// `describeRelayedWorld` produces for a bzfs row so one template draws both.
// `worldBytes`/`worldInflated` stay blank: those are what bzfs sent over its
// own wire, which an instance serving its own world never had.
function describeReportedWorld(world) {
  if (!world) return null;
  return {
    hash: world.hash || '',
    // What bzfs sent over its own wire, which an instance serving its own
    // world never had.
    sent: 0,
    inflated: 0,
    bzw: world.bzw || 0,
    json: world.json || 0,
    brotli: world.brotli || 0,
  };
}

// What this server holds of one BZFlag server's world, for its row's readout
// pane: the hash bzfs itself names it by and how many bytes it sent, then
// what bzo made of it -- the reconstructed `.bzw`, the parsed world, and what
// that world costs on the wire once brotli has it. A row nobody has imported
// has none of it, which is itself the answer.
function describeImportedWorld(host, port, t) {
  return describeRelayedWorld(publishWorldFacts(host, port) || {}, t);
}

// The same lines for an instance reading the merged list rather than holding
// the import itself: the designated server already measured them, so they
// arrive as text and are shown as they came.
// `host:port` as the two things the world tracker is keyed by. A target
// without a port is not one this server could have imported, so it gets a
// port nothing matches rather than a guess.
function splitHostPort(target) {
  const text = typeof target === 'string' ? target : '';
  const at = text.lastIndexOf(':');
  if (at < 0) return [text, 0];
  return [text.slice(0, at), Number.parseInt(text.slice(at + 1), 10) || 0];
}

// A bzo instance's own world, for its row. Not `describeRelayedWorld`'s
// labels: the hash is bzo's own, not the one bzfs names a world by, and
// "World sent"/"World inflated" describe a transfer that never happened --
// an instance serves the world it already has.
function describeOwnWorld(world, t) {
  if (!world) return [];
  return [
    [t('Map hash'), escapeHtml(world.hash || '')],
    ['bzw/json/br', escapeHtml(joinSizes(world.bzw, world.json, world.brotli))],
  ];
}

// Which of a world's variables bzo would ignore, as the map loader decides it:
// the same `-set` lines through the same parser, so the list cannot disagree
// with a load. Kept per variable list, since the page redraws every server.
const unreadVariableCache = new Map();
function getUnreadWorldVariables(variables) {
  const key = JSON.stringify(variables);
  let unread = unreadVariableCache.get(key);
  if (!unread) {
    const lines = ['options',
      ...variables.map(([name, value]) => `-set ${name} "${String(value).replace(/"/g, '')}"`),
      'end'];
    unread = new Set(parseBZWServerOptions(lines).unreadBZDBVars.map((entry) => entry.split('=')[0]));
    if (unreadVariableCache.size > 500) unreadVariableCache.clear();
    unreadVariableCache.set(key, unread);
  }
  return unread;
}

// `8/14 set`: how many of a world's variables bzo reads, of all it sets. A tap
// or a click opens the list -- read ones in the accent, ignored ones muted --
// which a hover title could not do on a phone.
// A world's variables as `[name, value]` pairs, from the name-to-value object
// the list carries or the pairs an older instance's list did.
function variablePairs(variables) {
  if (Array.isArray(variables)) return variables;
  return variables && typeof variables === 'object' ? Object.entries(variables) : [];
}

function describeVariableCount(given, t) {
  const variables = variablePairs(given);
  if (!variables.length) return '';
  const unread = getUnreadWorldVariables(variables);
  const read = variables.filter(([name]) => !unread.has(name)).length;
  const rows = variables.map(([name, value]) => `<li class="${unread.has(name) ? 'var-unread' : 'var-read'}"`
    + ` title="${escapeHtml(unread.has(name) ? t('ignored by bzo') : t('read by bzo'))}">`
    + `${escapeHtml(name)} ${escapeHtml(String(value))}</li>`).join('');
  return `<details class="vars"><summary>${escapeHtml(t('{read}/{total} set', { read, total: variables.length }))}</summary>`
    + `<ul>${rows}</ul></details>`;
}

// The bzflag.org account a server's key belongs to, as its forum profile: one
// account signs into both. By BZID where one is known, as the key table links
// it, since a callsign can change hands; by name otherwise, which is all the
// BZFlag list gives.
function describeOwner(owner, bzid) {
  if (!owner) return '';
  const query = isForumBzid(bzid) ? `u=${encodeURIComponent(bzid)}` : `un=${encodeURIComponent(owner)}`;
  const href = `https://forums.bzflag.org/memberlist.php?mode=viewprofile&${query}`;
  return `<a href="${escapeHtml(href)}">${escapeHtml(owner)}</a>`;
}

// A real forum BZID is numeric; `self` and the like are placeholders.
function isForumBzid(bzid) {
  return /^\d+$/.test(String(bzid ?? ''));
}

function describeRelayedWorld(world, t) {
  return [
    [t('Version'), escapeHtml(String(world.version || '').slice(0, 80))],
    [t('BZFlag hash'), escapeHtml(world.hash || '')],
    // A `t` hash is a world bzfs generated rather than read from a file, which
    // usually changes when that server restarts (`isBzfsWorldHash`).
    [t('World'), /^t/i.test(world.hash || '') ? escapeHtml(t('temporary')) : ''],
    // How many bzo reads of how many are set; the names open under it, and
    // are in the filter too (`v)`).
    [t('Variables'), describeVariableCount(world.variables, t)],
    [t('sent/inflated'), escapeHtml(joinSizes(world.sent, world.inflated))],
    ['bzw/json/br', escapeHtml(joinSizes(world.bzw, world.json, world.brotli))],
  ];
}

// Bytes, never text. A size is measured in one place, stored in one place
// and formatted where it is shown -- so what the tracker persists and what
// `/api/list-server/list` publishes are the exact numbers, and rounding is
// the display's business alone. 0 for a file that is not there.
function statSizeBytes(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

// ISO-ish (sorts correctly as plain text, no data-sort="num" needed) --
// `sweepStaleImports` ages a remote import out by this same mtime, so
// showing it here is what tells an operator when an import will next expire
// (`IMPORT_MAX_AGE_MS` after this timestamp), not just when it was written.
function statMtimeOrBlank(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return '';
  }
}

// Upstream does not spend a column on a fact, it spends a line on a server.
// One row says only what tells it apart -- game type, jumping, superflags,
// ricochet, and the shot count carried by the *colour* of its description --
// and a readout pane says everything about the one row you are looking at
// (`ServerMenu.cxx:400-476` for the row, `:545-745` for the pane). Both
// tables here were fifteen and fourteen columns, eight of them a single
// boolean apiece, which is what this replaces; see docs/list-server-plan.md.
//
// Nothing was lost with the sortable headers: upstream has no interactive
// sort either. Its list is always player-count descending
// (`ServerItem::getSortFactor`), which is the order `/list` already asks for.
// Paging is the one part deliberately not copied -- ten rows a page with
// PageUp/PageDown is how a fixed-height HUD shows a long list, and a web page
// scrolls.
const GAME_STYLE_NAMES = Object.freeze({
  ClassicCTF: N_('Classic Capture-the-Flag'),
  RabbitChase: N_('Rabbit Chase'),
  OpenFFA: N_('Open (Teamless) Free-For-All'),
  TeamFFA: N_('Free-style'),
});

// `BrightColors` (src/3D/FontManager.cxx:40) -- the RGB upstream's own ANSI
// colour codes draw as, so a row here is the colour a row in the game is.
const ANSI_RGB = Object.freeze({
  yellow: '#ffff00', red: '#ff0000', green: '#00ff00', blue: '#1a33ff',
  purple: '#ff00ff', white: '#ffffff', cyan: '#00ffff',
});
// Upstream's dim is 0.2 of the colour (`dimFactor`, FontManager.cxx:80), which
// for white is #333 -- at 14px on black that is not "off", it is invisible.
// This is the one colour lifted rather than copied: still plainly unlit beside
// a bright one, still legible as the letter it is.
const ANSI_DIM_WHITE = '#666';

// The `*` in front of a row *is* the game type -- one glyph whose colour says
// which of the four it is, which is the whole of what upstream puts there
// (`ServerMenu.cxx:424-441`, under its `listIcons` setting). Replay servers are
// recognised the way upstream recognises them: 16 observer slots and 200
// players is what a replay server advertises, not a flag it sets.
// Rarest first, so sorting on this column brings the unusual games up.
function listGameMark(entry) {
  if (entry.observerMax === 16 && entry.maxPlayers === 200) {
    return { color: ANSI_RGB.cyan, rank: 3, title: N_('Replay server') };
  }
  if (entry.style === 'ClassicCTF') {
    return { color: ANSI_RGB.red, rank: 2, title: N_('Classic Capture-the-Flag') };
  }
  if (entry.style === 'RabbitChase') {
    return { color: ANSI_RGB.white, rank: 1, title: N_('Rabbit Chase') };
  }
  return { color: ANSI_RGB.yellow, rank: 0, title: N_('Free-for-all') };
}

// The description's colour *is* the shot count: purple for zero through
// yellow for three, then graded orange into red above that
// (`ServerMenu.cxx:459-484`). Kept exactly, dark purple included -- it is a
// signal in a fixed vocabulary rather than body text, and the pane spells the
// number out anyway.
function listShotColor(maxShots) {
  if (!(maxShots > 0)) return '#660099';
  if (maxShots === 1) return '#4040ff';
  if (maxShots === 2) return '#40ff40';
  if (maxShots === 3) return '#ffff40';
  const shotScale = Math.min(1, Math.log10(maxShots - 3));
  const green = Math.round(255 * 0.4 * (1 - shotScale));
  const blue = Math.round(0.25 * 0.4 * (1 - shotScale) * 255);
  return `rgb(255, ${green}, ${blue})`;
}

// `J F R`, bright when on and unlit when off, in the letters and colours
// upstream uses (`ServerMenu.cxx:443-458`). `I` is bzo's own fourth letter and
// only the bzfs list has it: whether this server already holds an import of
// that map, which is the one fact about a row that is about *this* server
// rather than that one.
function listOptionLetter(text, on, onColor) {
  return `<span class="opt" style="color:${on ? onColor : ANSI_DIM_WHITE}">${text}</span>`;
}

// Lit when the row's world has a hash, which the pane spells out. Sorting on
// it groups rows sharing a world, and the filter box searches it (#155).
function listHashLetter(hash) {
  return listOptionLetter('H', Boolean(hash), ANSI_RGB.white);
}
function listHashHeader(t) {
  return `<button class="opt" data-field="hs" data-text`
    + ` title="${escapeHtml(t('World hash: sorts rows sharing a world together, unhashed last'))}">H</button>`;
}

function listOptionLetters(bits, imported) {
  const letter = (text, bit, onColor) => listOptionLetter(text, (bits & bit) !== 0, onColor);
  return letter('J', GAME_OPTION_BITS.jumping, ANSI_RGB.purple)
    + letter('F', GAME_OPTION_BITS.flags, ANSI_RGB.blue)
    + letter('R', GAME_OPTION_BITS.ricochet, ANSI_RGB.green)
    + (typeof imported === 'boolean'
      ? listOptionLetter('I', imported, ANSI_RGB.cyan)
      : '');
}

// How long a server has been up, from the timestamp the list server itself
// recorded on that server's last `boot` report (issue #106). Coarse on
// purpose: the interesting fact is "days" or "an hour", and a seconds-precise
// figure would only invite reading it as more exact than a report cadence can
// make it. Nothing at all when no boot has been observed -- a blank line is
// honest where a zero would not be.
function formatUptime(since, t, now = Date.now()) {
  if (!Number.isFinite(since)) return '';
  const minutes = Math.floor((now - since) / 60000);
  if (minutes < 1) return t('just started');
  if (minutes < 60) return t('{minutes}m', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('{hours}h {minutes}m', { hours, minutes: minutes % 60 });
  return t('{days}d {hours}h', { days: Math.floor(hours / 24), hours: hours % 24 });
}

// h:mm:ss, m:ss or 0:ss, as upstream formats a time limit
// (`ServerMenu.cxx:704-711`).
function formatMatchDuration(seconds) {
  if (!(seconds > 0)) return '';
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}`
      + `:${String(seconds % 60).padStart(2, '0')}`;
  }
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// One team's cell: nothing at all when the team is not offered, a bare count
// when its maximum is the whole server, and count/max otherwise -- upstream's
// own three cases (`ServerMenu.cxx:573-620`).
function listTeamCell(count, max, maxPlayers) {
  if (!(max > 0)) return '';
  if (typeof count !== 'number') return `?/${max}`;
  if (max >= maxPlayers) return String(count);
  return `${count}/${max}`;
}

const LIST_TEAM_LABELS = Object.freeze([N_('Rogue'), N_('Red'), N_('Green'), N_('Blue'), N_('Purple'), N_('Observers')]);

// How wide a numeric column has to be: its own header, or its widest value,
// whichever needs more characters. The rows are monospace, so `ch` is exact
// and the column takes no space it is not using -- a list where nobody is
// watching gives the observer count one character, and a server with 200
// players widens the player column to three without anything else moving.
function listColumnWidth(header, values) {
  const widest = values.reduce(
    (max, value) => Math.max(max, String(value ?? '').length), header.length,
  );
  return `${widest}ch`;
}

// What a section heading says it holds: how many servers, and how many people
// are playing on them. Observers are not players and are counted nowhere here
// -- the same line `-mp` itself draws, where the playing limit caps the tanks
// and says nothing about who is watching (CmdLineOptions.cxx:458).
function listHeadingCount(entries, t) {
  if (!entries.length) return t('none');
  const players = entries.reduce((sum, entry) => sum + (Number(entry.players) || 0), 0);
  const bots = entries.reduce((sum, entry) => sum + (Number(entry.bots) || 0), 0);
  const servers = entries.length;
  return (players === 1
    ? t('{servers} with {players} player', { servers, players })
    : t('{servers} with {players} players', { servers, players }))
    + (bots > 0 ? (bots === 1 ? t(', {bots} bot', { bots }) : t(', {bots} bots', { bots })) : '')
    + missingOverviewCount(entries, t);
}

// How many rows in a table are still waiting for their overview picture, said
// only when some are. A row with `undefined` is one that is not in the scheme
// at all and is not waiting for anything; `null` is one whose picture has not
// been drawn yet, which for a bzfs row means nobody has imported that world
// and for a bzo row that the list server has not fetched it.
function missingOverviewCount(entries, t) {
  const waiting = entries.filter((entry) => entry.overviewUrl === null).length;
  return waiting ? t(', {waiting} without overview', { waiting }) : '';
}

// The readout pane for one row: upstream's own panel, in upstream's order,
// plus the handful of fields only bzo has (`extras`).
function renderListReadout(entry, hidden, t) {
  const bits = entry.gameOptionsBits || 0;
  const has = (bit) => (bits & bit) !== 0;
  const counts = Array.isArray(entry.teamCounts) ? entry.teamCounts : [];
  const maxima = Array.isArray(entry.teamMaximums) ? entry.teamMaximums : [];
  // Every team, always, with a blank value where the team is not offered --
  // upstream keeps the label and empties the number (`ServerMenu.cxx:573-620`),
  // which is what stops the pane changing height as the selection moves down
  // the list.
  const teamRows = LIST_TEAM_LABELS.map((label, index) => `<div class="paneRow">`
    + `<span>${escapeHtml(t(label))}</span>`
    + `<span>${escapeHtml(listTeamCell(counts[index], maxima[index], entry.maxPlayers))}</span>`
    + `</div>`).join('');

  // The option words, present or absent, as upstream lists them -- a blank
  // line for an option that is off rather than a "No" beside it. Both shake
  // conditions show where upstream shows one: it writes the timeout and the
  // win count into the same readout slot (`ServerMenu.cxx:650-681`, listHUD[12]
  // twice), so the second always overwrites the first, and it takes the
  // timeout's plural from `shakeWins`.
  const words = [];
  if (has(GAME_OPTION_BITS.flags)) words.push(t('Super Flags'));
  if (has(GAME_OPTION_BITS.antidote)) words.push(t('Antidote Flags'));
  if (has(GAME_OPTION_BITS.shaking) && entry.shakeTimeout > 0) {
    const secs = (entry.shakeTimeout / 10).toFixed(1);
    words.push(entry.shakeTimeout === 10
      ? t('{secs} sec To Drop Bad Flag', { secs })
      : t('{secs} secs To Drop Bad Flag', { secs }));
  }
  if (has(GAME_OPTION_BITS.shaking) && entry.shakeWins > 0) {
    const wins = entry.shakeWins;
    words.push(wins === 1 ? t('{wins} Win Drops Bad Flag', { wins }) : t('{wins} Wins Drops Bad Flag', { wins }));
  }
  if (has(GAME_OPTION_BITS.noTeamKills)) words.push(t('No Teamkills'));
  if (has(GAME_OPTION_BITS.jumping)) words.push(t('Jumping'));
  if (has(GAME_OPTION_BITS.ricochet)) words.push(t('Ricochet'));
  if (has(GAME_OPTION_BITS.handicap)) words.push(t('Handicap'));
  if (has(GAME_OPTION_BITS.inertia)) words.push(t('Inertia'));
  // Upstream's one switch for both (`-disableBots`: "disallow clients from
  // using autopilot or robots"), so one word for both.
  if (entry.disableBots) words.push(t('No Bots'));
  // Whether a player without a bzflag.org login may play and talk there, which
  // no bzfs publishes and bzo learns by asking (`enterAndProbe`). Nothing at
  // all where it has not found out.
  if (entry.guestWatch === 'yes') words.push(t('Guests Watch'));
  if (entry.guestWatch === 'no') words.push(t('No Guests'));
  if (entry.guestSpawn === 'yes') words.push(t('Guests Play'));
  if (entry.guestSpawn === 'no') words.push(t('Registered Only'));
  if (entry.guestChat === 'yes') words.push(t('Guests Chat'));
  if (entry.guestChat === 'no') words.push(t('Guests Muted'));

  const limits = [
    [t('Time limit'), formatMatchDuration(entry.maxTime)],
    [t('Max team score'), entry.maxTeamScore > 0 ? String(entry.maxTeamScore) : ''],
    [t('Max player score'), entry.maxPlayerScore > 0 ? String(entry.maxPlayerScore) : ''],
    ...(entry.extras || []),
  ].filter(([, value]) => value)
    .map(([label, value]) => `<div class="paneRow"><span>${escapeHtml(label)}</span><span>${value}</span></div>`)
    .join('');

  const shots = entry.maxShots === 1
    ? t('{shots} Shot', { shots: 1 })
    : t('{shots} Shots', { shots: entry.maxShots || 0 });
  const style = GAME_STYLE_NAMES[entry.style] ? t(GAME_STYLE_NAMES[entry.style]) : (entry.style || '');
  // Two columns, as upstream's own panel has it: who is playing on the left,
  // what the game is on the right (`ServerMenu.cxx:214-238`), and for a row
  // that can have one, the world's overview picture third. `null` is a world
  // no picture has been drawn for yet and gets the waiting mark; `undefined`
  // is a row outside the scheme altogether -- a bzfs row off the public list
  // -- and gets no column, the bzfs table having none of these anywhere.
  return `<div class="pane" id="${escapeHtml(entry.id)}"${hidden ? ' hidden' : ''}>`
    + `<div class="paneMain"><div class="paneBody">`
    + `<p class="paneTitle">${escapeHtml(entry.desc || entry.addr)}</p>`
    + `<div class="paneCols">`
    + `<div class="paneCol">`
    // Players, not people: upstream's own panel sums the observers into this
    // (`ServerMenu.cxx:568-571`) and bzo does not, on the same line `-mp`
    // itself draws -- see `listHeadingCount`. The limit beside it stays the
    // one the server reports, which for a bzfs row is its own total including
    // whatever observer slots it holds. There is no reliable way to take
    // those back off: plenty of servers report an observer maximum equal to
    // `maxPlayers` outright, which would leave a playing limit of zero.
    + `<div class="paneRow"><span>${escapeHtml(t('Players'))}</span>`
    + `<span>${typeof entry.players === 'number' ? entry.players : '?'}/${entry.maxPlayers || 0}</span></div>`
    // A bzo instance reports these; a bzfs row's are its UDP ping less its
    // list row (`countServerBots`).
    + (entry.bots > 0 ? `<div class="paneRow"><span>${escapeHtml(t('Bots'))}</span><span>${entry.bots}</span></div>` : '')
    + teamRows
    + `</div>`
    + `<div class="paneCol">`
    + `<p class="paneWords">${escapeHtml(shots)} &middot; ${escapeHtml(style)}</p>`
    + (words.length ? `<p class="paneWords">${words.map(escapeHtml).join(' &middot; ')}</p>` : '')
    + limits
    + `</div>`
    + `</div></div>`
    + (entry.overviewUrl === undefined
      ? ''
      : renderOverview(entry.overviewUrl, entry.desc || entry.addr, t))
    + `</div></div>`;
}

// What you can do about the selected row, which rides on the filter bar rather
// than inside the pane: the pane says what a server *is*, and the way in wants
// to be in one fixed place instead of moving down the page as a pane grows or
// shrinks. Shown and hidden with its own pane, keyed off the same id.
function renderListActions(entry, hidden) {
  return `<div class="rowActions" id="${escapeHtml(entry.id)}-actions"${hidden ? ' hidden' : ''}>`
    + `<a class="action" href="${escapeHtml(entry.href)}">${escapeHtml(entry.action)}</a>`
    + (entry.actions || '')
    + `</div>`;
}

// The filter box over each list.
function listFilterInput(filterId, t) {
  return `<input id="${escapeHtml(filterId)}" class="clearable" type="text" placeholder="${escapeHtml(t('Filter…'))}">`;
}

// The local maps list, given the same shape as the two server lists above: one
// line per map, a readout pane for the selected one, a sortable header and the
// filter box. The row carries the three numbers the in-client View picker
// shows in columns (`populateViewMapTable`, public/js/client.js) and the pane
// carries the rest -- including what that picker only puts in a row tooltip.
// The pane's third column is the map's own overview picture
// (`server/map-overview.cjs`).
function renderMapList(listId, filterId, maps, t) {
  if (!maps.length) return `<p class="muted">${escapeHtml(t('None.'))}</p>`;
  const entries = maps.map((map) => {
    const registered = MAP_REGISTRY.get(map.fileName);
    const stats = registered ? registered.stats : null;
    const bzwPath = resolveMapFilePath(map.fileName);
    return {
      file: map.fileName,
      hashed: map.hashed,
      hash: registered ? registered.hash : '',
      stats,
      overviewUrl: localMapOverviewUrl(map.fileName),
      modified: bzwPath ? statMtimeOrBlank(bzwPath) : '',
      bzw: bzwPath ? statSizeBytes(bzwPath) : 0,
      json: registered ? statSizeBytes(path.join(MAP_CACHE_DIR, `${registered.hash}.json`)) : 0,
      brotli: registered ? brotliSizeBytes(`${registered.hash}.json`) : 0,
    };
  });

  // `a`, `d` and `hs` are the fields the filter box's own glob looks at, so on
  // this list typing a word matches a file name, a style or a hash. The `/` filter
  // language is about servers and is not offered here -- there is no `?`
  // beside this box.
  const data = entries.map((entry) => ({
    a: entry.file,
    d: entry.stats ? entry.stats.style || '' : '',
    n: entry.file.toLowerCase(),
    o: entry.stats ? entry.stats.objects || 0 : 0,
    fa: entry.stats ? entry.stats.faces || 0 : 0,
    sz: entry.stats ? entry.stats.size || 0 : 0,
    hs: entry.hash || '',
  }));

  const num = (value) => (Number.isFinite(value) ? String(value) : '');
  // A row is only here once it is registered, or while the background pass is
  // still working through the list -- which is the one case with no stats to
  // read a style off.
  const mapStyleLabel = (entry) => (entry.stats ? entry.stats.style || '' : t('hashing…'));
  const rows = entries.map((entry, index) => {
    const stats = entry.stats;
    // A map still being hashed has no cached world to show, so its row leads
    // nowhere yet -- the background pass registers it within seconds of boot
    // and a reload picks it up.
    const href = entry.hashed ? `/?viewmap=${encodeURIComponent(entry.file)}` : '#maps';
    return `<li>`
      + `<a class="srow${index === 0 ? ' selected' : ''}" href="${escapeHtml(href)}"`
      + ` data-pane="map-pane-${index}" data-i="${index}">`
      + `<span class="num col-obj">${stats ? num(stats.objects) : ''}</span>`
      + `<span class="num col-fa">${stats ? num(stats.faces) : ''}</span>`
      + `<span class="num col-sz">${stats ? num(stats.size) : ''}</span>`
      + listHashLetter(entry.hash)
      + `<span class="addr">${escapeHtml(entry.file)}</span>`
      + `<span class="desc dim">${escapeHtml(mapStyleLabel(entry))}</span>`
      + `</a></li>`;
  }).join('\n');

  const objLabel = t('Obj');
  const facesLabel = t('Faces');
  const sizeLabel = t('Size');
  const head = `<div class="shead">`
    + `<button class="num col-obj" data-field="o" title="${escapeHtml(t('Obstacles in the world'))}">${escapeHtml(objLabel)}</button>`
    + `<button class="num col-fa" data-field="fa" title="${escapeHtml(t('Mesh faces in the world'))}">${escapeHtml(facesLabel)}</button>`
    + `<button class="num col-sz" data-field="sz" title="${escapeHtml(t('World size'))}">${escapeHtml(sizeLabel)}</button>`
    + listHashHeader(t)
    + `<button class="name" data-field="n" data-text title="${escapeHtml(t('Map file name'))}">${escapeHtml(t('Name'))}</button>`
    + `<button class="name" data-field="d" data-text title="${escapeHtml(t('Game style the map sets'))}">${escapeHtml(t('Style'))}</button>`
    + `</div>`;

  // A map still being hashed has no numbers at all, so a blank contributes
  // nothing here and the header word is what sets each of these three.
  const widths = `--col-obj:${listColumnWidth(objLabel, data.map((entry) => entry.o || ''))};`
    + `--col-fa:${listColumnWidth(facesLabel, data.map((entry) => entry.fa || ''))};`
    + `--col-sz:${listColumnWidth(sizeLabel, data.map((entry) => entry.sz || ''))}`;
  return `<div class="listWrap" id="${escapeHtml(listId)}" style="${widths}">`
    + `<div class="panes">${entries
      .map((entry, index) => renderMapReadout(entry, index, index !== 0, t)).join('\n')}</div>`
    + `<div class="listBar">`
    + listFilterInput(filterId, t)
    + entries.map((entry, index) => `<div class="rowActions" id="map-pane-${index}-actions"`
      + `${index !== 0 ? ' hidden' : ''}>`
      + (entry.hashed
        ? `<a class="action" href="/?viewmap=${encodeURIComponent(entry.file)}">${escapeHtml(t('View map'))}</a>`
        : `<span class="muted">${escapeHtml(t('Still hashing'))}</span>`)
      + `</div>`).join('')
    + `</div>`
    + head
    + `<ul class="srows">\n${rows}\n</ul>`
    + `<script type="application/json" id="${escapeHtml(listId)}-data">`
    + `${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
    + `</div>`;
}

// The picture of a BZFlag server's world, when this instance holds an import
// of it -- `null` while it does not, which is the waiting mark. Named by
// `host:port`, as a proxy target and a bzfs row both spell it.
function importedOverviewUrl(hostPort) {
  const parsed = parseHostPort(hostPort);
  return parsed ? bzfsRowOverviewUrl(parsed.host, parsed.port) : null;
}

// Whether this instance draws and shows its own pictures of BZFlag worlds.
// Only one whose server lists are its own does: the list server, or an
// instance with none configured. Every other reads the list server's lists,
// which name the list server's picture of each world.
function drawsBzfsPictures() {
  return IS_DESIGNATED_LIST_SERVER || !LIST_SERVER_URL;
}

// A BZFlag server's picture, as a path on this server, or null: the one kept
// under its world's BZFlag hash, else a live import's own. Null where the
// list server's picture is the one to show (`drawsBzfsPictures`).
function bzfsRowOverviewUrl(host, port) {
  if (!drawsBzfsPictures()) return null;
  const record = bzfsWorlds.recordFor(host, port);
  if (record && bzfsOverviewPath(host, port, record.worldHash)) {
    return `/overviews/bzfs-${record.worldHash}.svg`;
  }
  return localMapOverviewUrl(remoteMapFileName(host, port));
}

// bzfs's MD5 of the world, which names that world exactly and so is a name a
// picture can be kept under. `p` is a world loaded from a file and stable
// across that server's restarts; `t` is one it generated, which usually
// changes on each restart (`bzfs.cxx:1211`) and is rechecked sooner for it
// (`server/bzfs-worlds.cjs`).
function isBzfsWorldHash(worldHash) {
  return /^[pt][0-9a-f]{32}$/i.test(worldHash || '');
}

// The picture of one BZFlag world, by its hash (issue #147): drawn once, by
// `registerMapFile`, when an import of that world registers, and then outliving
// the import, so every listed server keeps a picture without this server
// keeping every world -- imports still age out on `IMPORT_MAX_AGE_MS`. A new
// hash means a new picture, and `purgeUnreferencedOverviews` drops the old one
// once no server names it. Returns the path when the picture is held.
function bzfsOverviewPath(host, port, worldHash) {
  if (!isBzfsWorldHash(worldHash)) return null;
  const filePath = path.join(OVERVIEW_CACHE_DIR, `bzfs-${worldHash}.svg`);
  return fs.existsSync(filePath) ? filePath : null;
}

// What a map's picture is called in `OVERVIEW_CACHE_DIR`: an import of a
// BZFlag world by that world's own hash, which is the name anyone else knows
// it by, and every other map by bzo's hash of it.
function overviewNameFor(fileName, hash) {
  const imported = parseImportMapFileName(fileName);
  const worldHash = imported ? bzfsWorlds.recordFor(imported.host, imported.port)?.worldHash : null;
  return isBzfsWorldHash(worldHash) ? `bzfs-${worldHash}` : hash;
}

// A local map's drawn overview, as a path on this server, or null. The
// registry once the boot pass has read the map back, and the on-disk index
// before that, so a restart does not leave every row waiting for a picture
// that is already on disk.
function localMapOverviewUrl(fileName) {
  const registered = MAP_REGISTRY.get(fileName);
  if (registered) return registered.overviewUrl;
  const overview = mapIndex.overviewOf(fileName, resolveMapFilePath(fileName));
  return overview ? `/overviews/${overview}.svg` : null;
}

// The overview picture for a pane, or the app's own mark where there is not
// one yet -- a map is registered by a background trickle, so the first visitor
// after a boot can reach the page before the picture for a given map exists.
// The mark rather than a word: the slot is a picture, and a picture that says
// "not yet" without making anyone read anything is what belongs in it.
function renderOverview(url, label, t) {
  if (!url) {
    return `<div class="overview overviewWaiting">`
      + `<img src="/favicon.svg" alt="" width="64" height="64"></div>`;
  }
  return `<div class="overview"><img src="${escapeHtml(url)}" width="256"`
    + ` height="256" alt="${escapeHtml(t('Overview of {name}', { name: label }))}" loading="lazy"></div>`;
}

// A recording's moment, as the Local maps table writes a file's: UTC, to the
// second, so rows sort and read the same wherever the reader is.
function formatReplayDate(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '';
}

function formatReplayLength(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

// The Local replays list, the same shell as Local maps: one line per
// recording, a pane for the selected one, the sortable header and the filter
// box. A replay is local to this instance (docs/replay-plan.md), so this
// list is built here and never published to the list server.
function renderReplayList(listId, filterId, replays, t) {
  if (!replays.length) return `<p class="muted">${escapeHtml(t('None.'))}</p>`;
  const data = replays.map((entry) => ({
    a: entry.name,
    d: entry.map || '',
    hs: entry.summary?.worldHash || '',
    n: entry.name.toLowerCase(),
    t: entry.summary?.start || 0,
    len: entry.summary?.seconds || 0,
    pl: entry.summary?.players.length || 0,
  }));
  const rows = replays.map((entry, index) => {
    const summary = entry.summary;
    const desc = entry.error ? t('unreadable: {error}', { error: entry.error }) : (entry.map || '');
    const live = entry.playing ? t(' -- {viewers} watching', { viewers: entry.playing.viewers }) : '';
    return `<li>`
      + `<a class="srow${index === 0 ? ' selected' : ''}" href="/?replay=${encodeURIComponent(entry.name)}"`
      + ` data-pane="replay-pane-${index}" data-i="${index}">`
      + `<span class="num col-date">${escapeHtml(summary ? formatReplayDate(summary.start) : '')}</span>`
      + `<span class="num col-len">${escapeHtml(summary ? formatReplayLength(summary.seconds) : '')}</span>`
      + `<span class="num col-pl">${summary ? summary.players.length : ''}</span>`
      + `<span class="addr">${escapeHtml(entry.name)}</span>`
      + `<span class="desc dim">${escapeHtml(desc + live)}</span>`
      + `</a></li>`;
  }).join('\n');
  const playersLabel = t('Players');
  const head = `<div class="shead">`
    + `<button class="num col-date" data-field="t" title="${escapeHtml(t('When it was recorded (UTC)'))}">${escapeHtml(t('Date'))}</button>`
    + `<button class="num col-len" data-field="len" title="${escapeHtml(t('How long it runs'))}">${escapeHtml(t('Length'))}</button>`
    + `<button class="num col-pl" data-field="pl" title="${escapeHtml(t('Players in it, observers not counted'))}">`
    + `${escapeHtml(playersLabel)}</button>`
    + `<button class="name" data-field="n" data-text title="${escapeHtml(t('Replay file name'))}">${escapeHtml(t('Name'))}</button>`
    + `<button class="name" data-field="d" data-text title="${escapeHtml(t('The map it was played on'))}">${escapeHtml(t('Map'))}</button>`
    + `</div>`;
  const widths = `--col-pl:${listColumnWidth(playersLabel, data.map((entry) => entry.pl || ''))}`;
  return `<div class="listWrap" id="${escapeHtml(listId)}" style="${widths}">`
    + `<div class="panes">${replays
      .map((entry, index) => renderReplayReadout(entry, index, index !== 0, t)).join('\n')}</div>`
    + `<div class="listBar">`
    + listFilterInput(filterId, t)
    + replays.map((entry, index) => `<div class="rowActions" id="replay-pane-${index}-actions"`
      + `${index !== 0 ? ' hidden' : ''}>`
      + (entry.summary
        ? `<a class="action" href="/?replay=${encodeURIComponent(entry.name)}">${escapeHtml(t('Watch'))}</a>`
        : `<span class="muted">${escapeHtml(t('Unreadable'))}</span>`)
      + (entry.summary && replayLocalMapFile(entry.map)
        ? ` <a class="action" href="/?viewmap=${encodeURIComponent(replayLocalMapFile(entry.map))}">${escapeHtml(t('View map'))}</a>`
        : '')
      + `</div>`).join('')
    + `</div>`
    + head
    + `<ul class="srows">\n${rows}\n</ul>`
    + `<script type="application/json" id="${escapeHtml(listId)}-data">`
    + `${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
    + `</div>`;
}

// The local map file a replay row's map name is, where it is one: the View
// map action goes there. A server's `host:port` is not a file.
function replayLocalMapFile(mapName) {
  if (!mapName) return null;
  const fileName = `${mapName}.bzw`;
  return MAP_REGISTRY.has(fileName) && listLocalMapFiles().includes(fileName) ? fileName : null;
}

// One labelled line of a readout pane, both halves text.
function paneRow(label, value) {
  return `<div class="paneRow"><span>${escapeHtml(label)}</span>`
    + `<span>${escapeHtml(value === undefined || value === null ? '' : String(value))}</span></div>`;
}

// What the recording is on the left, who was in it on the right, and the map's
// picture beside them. A player who left early is listed with the score they
// left with.
function renderReplayReadout(entry, index, hidden, t) {
  const summary = entry.summary || { players: [], observers: [] };
  const playing = entry.playing
    ? t('{viewers} watching, at {time}', { viewers: entry.playing.viewers, time: formatReplayLength(entry.playing.played) })
    : '';
  const players = summary.players.map((player) => paneRow(
    player.callsign,
    `${player.wins - player.losses} (${player.wins}-${player.losses})`
      + ` ${getTeamFromColorIndex(player.team) || ''}`,
  )).join('');
  return `<div class="pane" id="replay-pane-${index}"${hidden ? ' hidden' : ''}>`
    + `<div class="paneMain"><div class="paneBody">`
    + `<p class="paneTitle">${escapeHtml(entry.name)}</p>`
    + `<div class="paneCols">`
    + `<div class="paneCol">`
    + paneRow(t('Date'), formatReplayDate(summary.start))
    + paneRow(t('Length'), formatReplayLength(summary.seconds))
    + paneRow(t('Map'), entry.map || '')
    + paneRow(t('Recorded by'), summary.recordedBy || '')
    + paneRow('bzfs', [summary.appVersion, summary.protocol].filter(Boolean).join(' '))
    + paneRow(t('Observers'), summary.observers.join(', '))
    + paneRow(t('Now'), playing)
    + paneRow(t('Size'), entry.size ? formatByteSize(entry.size) : '')
    + (entry.error ? paneRow(t('Error'), entry.error) : '')
    + `</div>`
    + `<div class="paneCol">${players || paneRow(t('Players'), t('none'))}</div>`
    + `</div></div>`
    + renderOverview(entry.overviewUrl, entry.name, t)
    + `</div></div>`;
}

// What the map is made of on the left, what it is on the right -- the same two
// columns a server's pane has -- and the overview picture beside them. Every
// label is always present, blank where the map says nothing, so the pane keeps
// its height as the selection moves.
function renderMapReadout(entry, index, hidden, t) {
  const stats = entry.stats || {};
  const counts = stats.counts || {};
  const count = (value) => (value ? String(value) : '');
  const featureNames = { water: t('water'), weather: t('weather'), ground: t('custom ground') };
  const features = ['water', 'weather', 'ground']
    .filter((key) => stats[key])
    .map((key) => featureNames[key])
    .join(', ');
  return `<div class="pane" id="map-pane-${index}"${hidden ? ' hidden' : ''}>`
    + `<div class="paneMain"><div class="paneBody">`
    + `<p class="paneTitle">${escapeHtml(entry.file)}</p>`
    + `<div class="paneCols">`
    + `<div class="paneCol">`
    + paneRow(t('Objects'), count(stats.objects))
    + paneRow(t('Faces'), count(stats.faces))
    + paneRow(t('Boxes'), count(counts.box))
    + paneRow(t('Pyramids'), count(counts.pyramid))
    + paneRow(t('Meshes'), count(counts.mesh))
    + paneRow(t('Bases'), count(stats.bases))
    + paneRow(t('Teleporters'), count(stats.teleporters))
    + `</div>`
    + `<div class="paneCol">`
    + paneRow(t('Style'), stats.style || '')
    + paneRow(t('World size'), count(stats.size))
    + paneRow(t('Has'), features)
    + paneRow(t('Hashed'), entry.file === 'random' ? t('generated at boot') : (entry.hashed ? t('yes') : t('not yet')))
    + paneRow(t('Hash'), entry.hash)
    + paneRow(t('Modified'), entry.modified)
    + paneRow('bzw/json/br', joinSizes(entry.bzw, entry.json, entry.brotli))
    + `</div>`
    + `</div></div>`
    + renderOverview(entry.overviewUrl, entry.file, t)
    + `</div></div>`;
}

// The filter syntax reference, which is upstream's language rather than one
// bzo invented (`ServerListFilter.cxx`) -- so this is the same table its own
// in-client help menu prints, in the place the person typing a filter is
// looking. Folded away until asked for: it is a page of syntax beside a box
// most visitors will type a word into.
function renderFilterHelp(listId, t) {
  const code = (text) => `<code>${text}</code>`;
  const group = (title, rows) => `<p class="helpGroup">${title}</p>`
    + rows.map(([names, what]) => `<div class="helpRow">`
      + `<span><code>${names}</code></span><span>${what}</span></div>`).join('');
  return `<div class="filterHelp" id="${escapeHtml(listId)}-help" hidden>`
    + `<p>${l10n.html(t('Plain text is a glob over the address, description, version, hash and owner -- {examples} -- and a word with no {star} or {query} in it is wrapped in both, so it matches anywhere.'), {
      examples: `${code('league')}, ${code('*.org')}, ${code('bz?.')}`, star: code('*'), query: code('?'),
    })}`
    + ` ${l10n.html(t('A leading {slash} starts filters instead: comma-separated, combined with {and}.'), {
      slash: code('/'), and: `<em>${escapeHtml(t('and'))}</em>`,
    })}`
    + ` ${l10n.html(t('A second {slash} starts another set, and a server matching either set is shown.'), { slash: code('/') })}`
    + ` ${l10n.html(t('{hash} begins a comment.'), { hash: code('#') })}</p>`
    + group(l10n.html(t('Booleans -- {on} for on, {off} for off'), { on: code('+name'), off: code('-name') }), [
      ['F ffa', escapeHtml(t('Free-for-all with teams'))],
      ['O offa', escapeHtml(t('Open free-for-all, no teams'))],
      ['C ctf', escapeHtml(t('Capture-the-flag'))],
      ['R rabbit', escapeHtml(t('Rabbit chase'))],
      ['j jump', escapeHtml(t('Tanks can jump unaided'))],
      ['r rico', escapeHtml(t('Shots ricochet'))],
      ['h handicap', escapeHtml(t('Score affects tank performance'))],
      ['i inertia', escapeHtml(t('Tanks have inertia'))],
      ['a antidote', escapeHtml(t('Antidote flags are spawned'))],
      ['P replay', escapeHtml(t('A replay server'))],
      ['ov overview', escapeHtml(t('The pane has a map overview'))],
      ['t temp', escapeHtml(t('A generated world, which usually changes on restart'))],
      ['b bots', escapeHtml(t('Autopilot and robots allowed'))],
      ['gw guestWatch', escapeHtml(t('Players with no bzflag.org login may join to observe'))],
      ['gu guests', escapeHtml(t('Players with no bzflag.org login may spawn'))],
      ['gc guestChat', escapeHtml(t('Players with no bzflag.org login may chat'))],
    ])
    + `<p>${l10n.html(t('For {bots}, {guestWatch}, {guests} and {guestChat}, a server bzo has not found out about matches neither {plus} nor {minus}.'), {
      bots: code('bots'), guestWatch: code('guestWatch'), guests: code('guests'), guestChat: code('guestChat'),
      plus: code('+'), minus: code('-'),
    })}</p>`
    + group(l10n.html(t('Numbers -- a name, then {operators}, then a number'), {
      operators: ['&lt;', '&lt;=', '&gt;', '&gt;=', '='].map(code).join(' '),
    }), [
      ['s shots', escapeHtml(t('Active shots a tank may have'))],
      ['p players', escapeHtml(t('Players now, observers excluded'))],
      ['bc botCount', escapeHtml(t('Bots now'))],
      ['f freeSlots', escapeHtml(t('Playing slots still free'))],
      ['vt validTeams', escapeHtml(t('Colour teams the server offers'))],
      ['mt maxTime', escapeHtml(t('Time limit, in seconds'))],
      ['mp maxPlayers', escapeHtml(t("The server's own player ceiling"))],
      ['mts maxTeamScore', escapeHtml(t('Team score that ends the game'))],
      ['mps maxPlayerScore', escapeHtml(t('Player score that ends the game'))],
      ['sw shakeWins', escapeHtml(t('Kills that shed a bad flag'))],
      ['st shakeTime', escapeHtml(t('Tenths of a second to shed a bad flag'))],
      ['Rp rp gp bp pp op', escapeHtml(t('Players on rogue, red, green, blue, purple, observer'))],
      ['Rm rm gm bm pm om', escapeHtml(t("That team's maximum"))],
      ['Rf rf gf bf pf of', escapeHtml(t("That team's free slots"))],
    ])
    + group(l10n.html(t('Patterns -- a name, then {glob} for a glob or {regex} for a regular expression'), {
      glob: code(')'), regex: code(']'),
    }), [
      ['a addr address', escapeHtml(t('The address, host and port'))],
      ['d desc description', escapeHtml(t('The description'))],
      ['ad addrdesc', escapeHtml(t('Either one'))],
      ['hs hash', escapeHtml(t('The world hash the pane shows'))],
      ['ve ver version', l10n.html(t("The server's version: {bzo} or bzfs's own build"), { bzo: code('bzo-*') })],
      ['ow owner', escapeHtml(t('The bzflag.org account that registered it'))],
      ['ip', escapeHtml(t('The IP address the list server has for it'))],
      ['v var', l10n.html(t('Any one world variable it sets, as {pair}'), { pair: code('name=value') })],
    ])
    + `<p>${l10n.html(t('A capitalised pattern name matches case-sensitively: {lower} ignores case, {upper} does not.'), {
      lower: code('d)league'), upper: code('D)League'),
    })}</p>`
    + group(escapeHtml(t('Examples')), [
      ['/p&gt;1,s&gt;1,s&lt;4', escapeHtml(t('Two or three shots, and somebody playing'))],
      ['/+ctf,vt=2', escapeHtml(t('Capture-the-flag between exactly two teams'))],
      ['/d)*league*', escapeHtml(t('Leagues, by description'))],
      ['/ve)bzo-*', escapeHtml(t('bzo servers only'))],
      ['/ve]^$', escapeHtml(t('No version known yet'))],
      ['/op&gt;0', escapeHtml(t('Somebody is watching'))],
      ['/+rabbit,+rico,s=3', escapeHtml(t('Rabbit chase, ricochet, three shots'))],
      ['/+ctf/+rabbit', escapeHtml(t('Either capture-the-flag or rabbit chase'))],
      ['/-overview', escapeHtml(t('No map overview yet'))],
      ['/v)_disableBots=*', l10n.html(t('Lists {variable} at all, on or off; {off} is the one that means off'), {
        variable: code('_disableBots'), off: code('-b'),
      })],
    ])
    + `</div>`;
}

// The list itself: one anchor-shaped row per server, each naming the pane it
// reveals. Selection is a class, so with scripting off every row still links
// straight to what it did before.
function renderServerList(listId, filterId, unsorted, t) {
  if (!unsorted.length) return `<p class="muted">${escapeHtml(t('None.'))}</p>`;
  // Most players first, which is the order the `P` header starts out marked as
  // and upstream's own (`ServerItem::getSortFactor`); then most observers and
  // most bots, so a server somebody is watching or bots are playing on comes
  // ahead of an empty one; then by name and address. Done here rather than
  // upstream of it so the mark cannot disagree with the rows: a bzo instance
  // and the servers it proxies arrive grouped, and each of those is its own
  // row with its own count.
  const count = (value) => (typeof value === 'number' ? value : -1);
  const label = (entry) => (entry.desc || entry.addr || '').toLowerCase();
  const entries = [...unsorted].sort((a, b) => (count(b.players) - count(a.players))
    || (count(b.observers) - count(a.observers))
    || (count(b.bots) - count(a.bots))
    || label(a).localeCompare(label(b))
    || String(a.addr || '').localeCompare(String(b.addr || ''), undefined, { numeric: true }));
  const bits = (entry) => entry.gameOptionsBits || 0;
  const set = (entry, bit) => ((bits(entry) & bit) !== 0 ? 1 : 0);
  // What sorting and the filter language judge a row by, as one JSON block
  // beside the list rather than thirty attributes per row -- a row names its
  // own entry with `data-i`. Short names because there is one of these per
  // server and the public list runs to a couple of hundred.
  const data = entries.map((entry) => ({
    a: entry.addr || '',
    d: entry.desc || '',
    s: entry.maxShots || 0,
    p: typeof entry.players === 'number' ? entry.players : 0,
    mp: entry.maxPlayers || 0,
    mt: entry.maxTime || 0,
    mts: entry.maxTeamScore || 0,
    mps: entry.maxPlayerScore || 0,
    sw: entry.shakeWins || 0,
    st: entry.shakeTimeout || 0,
    tc: Array.isArray(entry.teamCounts) ? entry.teamCounts : null,
    tm: Array.isArray(entry.teamMaximums) ? entry.teamMaximums : null,
    g: entry.style || '',
    rank: listGameMark(entry).rank,
    rep: listGameMark(entry).rank === 3 ? 1 : 0,
    j: set(entry, GAME_OPTION_BITS.jumping),
    fl: set(entry, GAME_OPTION_BITS.flags),
    r: set(entry, GAME_OPTION_BITS.ricochet),
    h: set(entry, GAME_OPTION_BITS.handicap),
    in: set(entry, GAME_OPTION_BITS.inertia),
    an: set(entry, GAME_OPTION_BITS.antidote),
    im: entry.imported ? 1 : 0,
    ov: entry.overviewUrl ? 1 : 0,
    tmp: /^t/i.test(entry.hash || '') ? 1 : 0,
    // Facts bzo may not have: 1 or 0 where it knows, null where it does not,
    // so neither `+name` nor `-name` claims a server it has not asked.
    bo: entry.disableBots ? 0 : (entry.botsKnown ? 1 : null),
    gs: entry.guestSpawn === 'yes' ? 1 : (entry.guestSpawn === 'no' ? 0 : null),
    gc: entry.guestChat === 'yes' ? 1 : (entry.guestChat === 'no' ? 0 : null),
    gw: entry.guestWatch === 'yes' ? 1 : (entry.guestWatch === 'no' ? 0 : null),
    ow: entry.owner || '',
    ip: entry.ip || '',
    v: Array.isArray(entry.variables) ? entry.variables.map(([name, value]) => `${name}=${value}`) : [],
    hs: entry.hash || '',
    ve: entry.version || '',
    ob: typeof entry.observers === 'number' ? entry.observers : null,
    bt: typeof entry.bots === 'number' ? entry.bots : null,
    // What the Name header sorts by: a server with no title sorts under its
    // address, which is what the row shows in that case anyway.
    n: (entry.desc || entry.addr || '').toLowerCase(),
  }));
  // Only the bzfs list has anything to import, so only it gets the column and
  // the header over it.
  const hasImports = entries.some((entry) => typeof entry.imported === 'boolean');
  const widths = `--col-p:${listColumnWidth('P', data.map((entry) => entry.p))};`
    + `--col-o:${listColumnWidth('O', data.map((entry) => entry.ob))};`
    + `--col-b:${listColumnWidth('B', data.map((entry) => entry.bt))}`;
  const rows = entries.map((entry, index) => {
    const mark = listGameMark(entry);
    const players = typeof entry.players === 'number' ? entry.players : 0;
    return `<li>`
      + `<a class="srow${index === 0 ? ' selected' : ''}" href="${escapeHtml(entry.href)}"`
      + ` data-pane="${escapeHtml(entry.id)}" data-i="${index}">`
      + `<span class="count col-p">${players}</span>`
      // Blank rather than zero when nobody has said: a bzo instance too old to
      // report per-team figures has no observer count to show, and a `0` there
      // would be a claim rather than a gap.
      + `<span class="count col-o">${typeof entry.observers === 'number' ? entry.observers : ''}</span>`
      + `<span class="count col-b">${typeof entry.bots === 'number' ? entry.bots : ''}</span>`
      + `<span class="mark" style="color:${mark.color}" title="${escapeHtml(t(mark.title))}">*</span>`
      + listOptionLetters(bits(entry), entry.imported)
      + listHashLetter(entry.hash)
      + `<span class="addr">${escapeHtml(entry.addr)}</span>`
      + `<span class="desc" style="color:${listShotColor(entry.maxShots)}">${escapeHtml(entry.desc || '')}</span>`
      + `</a></li>`;
  }).join('\n');
  // One character per column, each the header for the column under it. `P`
  // starts out the active one because the page arrives sorted by it -- which
  // is also the only order upstream ever shows
  // (`ServerItem::getSortFactor`).
  const title = (msgid) => `title="${escapeHtml(msgid)}"`;
  const head = `<div class="shead">`
    + `<button class="count col-p active" data-field="p" ${title(t('Players'))}>P</button>`
    + `<button class="count col-o" data-field="ob" ${title(t('Observers'))}>O</button>`
    + `<button class="count col-b" data-field="bt" ${title(t('Bots, blank where unknown'))}>B</button>`
    + `<button class="mark" data-field="rank"`
    + ` ${title(t('Game type: yellow free-for-all, red capture-the-flag, white rabbit chase, cyan replay'))}>*</button>`
    + `<button class="opt" data-field="j" ${title(t('Jumping'))}>J</button>`
    + `<button class="opt" data-field="fl" ${title(t('Superflags'))}>F</button>`
    + `<button class="opt" data-field="r" ${title(t('Ricochet'))}>R</button>`
    + (hasImports
      ? `<button class="opt" data-field="im" ${title(t('This server already holds an import of that map'))}>I</button>`
      : '')
    + listHashHeader(t)
    + `<button class="name" data-field="n" data-text`
    + ` ${title(t('The name, or the address when a server has none'))}>${escapeHtml(t('Name & Description'))}</button>`
    + `</div>`;
  // One column down the left, in the order you use it: the summary of the row
  // you picked, the filter that narrows what you are picking from, then the
  // list. The filter belongs inside this rather than beside the heading, so
  // the three stay together as one control.
  return `<div class="listWrap" id="${escapeHtml(listId)}" style="${widths}">`
    + `<div class="panes">${entries
      .map((entry, index) => renderListReadout(entry, index !== 0, t)).join('\n')}</div>`
    + `<div class="listBar">`
    + listFilterInput(filterId, t)
    + `<button type="button" data-help="${escapeHtml(listId)}-help"`
    + ` title="${escapeHtml(t('Filter syntax'))}">?</button>`
    + entries.map((entry, index) => renderListActions(entry, index !== 0)).join('')
    + `</div>`
    + `<p class="filterError" id="${escapeHtml(filterId)}Error" hidden></p>`
    + renderFilterHelp(listId, t)
    + head
    + `<ul class="srows">\n${rows}\n</ul>`
    + `<script type="application/json" id="${escapeHtml(listId)}-data">`
    + `${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
    + `</div>`;
}

// `/list`: bzo servers, bzfs servers, local maps, and (bottom) this
// instance's list-server key admin -- one page rather than the `/view` +
// `/list-server` split that predated this, since a visitor came here for
// "what's running" either way and the key admin is the one part that only
// ever applies to an operator, so it reads better last. See
// docs/list-server-plan.md.
// The page's three tables -- the bzo list, the BZFlag list and this server's
// own maps -- which are nearly all of what `/list` costs: 246 rows, each with
// what this server knows of that world on disk. Built at most every
// `LIST_TABLES_TTL_MS` for each kind of visitor (`canWatch` adds buttons to
// the BZFlag rows) rather than on every request, and built again at once when
// a map registers (`invalidateListTables`).
const LIST_TABLES_TTL_MS = 30 * 1000;
const listTablesCache = new Map();
function invalidateListTables() {
  listTablesCache.clear();
}

function renderListTables({ servers, bzoServers, canWatch, locale }) {
  const cacheKey = `${locale} ${canWatch}`;
  const cached = listTablesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LIST_TABLES_TTL_MS) return cached.tables;
  // `random` is in `listAvailableMapFiles` because it is a map an operator can
  // *serve* -- the instruction to generate a world, which the Operator panel's
  // own chooser needs. It is only a map anyone can *view* when it is the world
  // this server is actually playing, which is the one case `LIVE_MAP_ENTRY`
  // registers it for. Listed otherwise, its row linked to `?viewmap=random`
  // and the client dropped the request on the floor -- `availableViewMaps` is
  // `MAP_REGISTRY`, so the name was never in it and the link fell through to
  // an ordinary join (issue #152).
  const localMaps = listLocalMapFiles()
    .filter((fileName) => fileName !== 'random' || MAP_REGISTRY.has('random'))
    .map((fileName) => ({
      fileName,
      hashed: MAP_REGISTRY.has(fileName),
    }));

  // Both lists normalise into one entry shape, so there is one row renderer
  // and one pane renderer rather than a copy of each per table. `extras` are
  // the pane lines only one of the two has, and their values are HTML the
  // caller has already escaped -- a URL extra is a link.
  // A BZFlag list owner is only a name. Where the same account holds a bzo
  // key, that row carries its BZID, and the link can use it. bzflag.org
  // callsigns are unique regardless of case.
  const ownerBzids = new Map(bzoServers
    .filter((s) => s.owner && isForumBzid(s.ownerBzid))
    .map((s) => [s.owner.toLowerCase(), s.ownerBzid]));
  const ownerLink = (owner) => describeOwner(owner, ownerBzids.get(String(owner || '').toLowerCase()));
  const t = l10n.translator(locale);
  const action = (href, msgid) => `<a class="action" href="${escapeHtml(href)}">${escapeHtml(msgid)}</a>`;
  const bzfsEntries = servers.map((s, index) => {
    const info = s.info || {};
    const importFileName = remoteMapFileName(s.host, s.port);
    // The import file itself, registered or not: it is only parsed once
    // somebody views it (`listLocalMapFiles`).
    const importedPath = resolveMapFilePath(importFileName);
    const maxima = Array.isArray(info.teamMaximums) ? info.teamMaximums : [];
    const world = s.world || publishWorldFacts(s.host, s.port) || {};
    return {
      id: `bzfs-pane-${index}`,
      addr: `${s.host}:${s.port}`,
      hash: world.hash || '',
      owner: s.owner || '',
      ip: s.ip || '',
      variables: variablePairs(world.variables),
      // `_disableBots` read as BZDB.isTrue does.
      disableBots: variablePairs(world.variables)
        .some(([name, value]) => name === '_disableBots' && bzdbIsTrue(value)),
      // Only a server whose variables bzo has read can be said to allow bots.
      botsKnown: variablePairs(world.variables).length > 0,
      guestWatch: guestAnswer(world.guestWatch),
      guestChat: guestAnswer(world.guestChat),
      guestSpawn: guestAnswer(world.guestSpawn),
      desc: s.title,
      version: world.version || '',
      // Always the row's own link, imported or not -- `?viewmap=` already
      // imports on demand (`importMapForView`) the moment nothing this fresh
      // is registered yet, so there is no state where following it is wrong.
      href: `/?viewmap=${encodeURIComponent(importFileName)}`,
      action: t('View map'),
      // The picture of this server's world, when this instance holds an import
      // of it: an import is parsed and registered like any other map, so it
      // already has an overview drawn beside its JSON and there is nothing
      // extra to fetch or draw. `null` rather than `undefined` on a row with
      // no import -- the waiting mark, since following the row imports on
      // demand and the next visit has the picture.
      // This instance's own import first -- same origin, and it is the world
      // this server would actually show you. Otherwise whatever the list
      // server said, which is an absolute URL on the designated instance and
      // is how a server bzo has never imported still has a picture.
      overviewUrl: bzfsRowOverviewUrl(s.host, s.port) || s.overviewUrl || null,
      style: info.style,
      maxShots: info.maxShots,
      gameOptionsBits: info.gameOptionsBits,
      players: info.players,
      bots: s.bots,
      maxPlayers: info.maxPlayers,
      observers: Array.isArray(info.teamCounts) ? info.teamCounts[5] : undefined,
      observerMax: maxima[5],
      teamCounts: info.teamCounts,
      teamMaximums: maxima,
      shakeTimeout: info.shakeTimeout,
      shakeWins: info.shakeWins,
      maxTime: info.maxTime,
      maxTeamScore: info.maxTeamScore,
      maxPlayerScore: info.maxPlayerScore,
      // What a bzo row's own second column carries (map, version, URL), in the
      // terms a bzfs row has: where it is, and what this server holds of it.
      // The import's own timestamp rather than a bare "yes" -- a copy fetched
      // an hour ago is not the map that server is running now, and it is the
      // same mtime `sweepStaleImports` ages it out by.
      extras: [
        [t('Address'), escapeHtml(`${s.host}:${s.port}`)],
        ['IP', escapeHtml(s.ip || '')],
        [t('Owner'), ownerLink(s.owner)],
        [t('Imported'), escapeHtml(importedPath ? statMtimeOrBlank(importedPath) : '')],
        // What this server holds of that world, and what it cost -- see
        // `describeImportedWorld`.
        ...describeRelayedWorld(world, t),
      ],
      imported: Boolean(importedPath),
      // Watching is the live game rather than the map: a real observer
      // connection to that server (`docs/proxy.md`). The same offer the
      // in-client View list makes on the same test (`canWatchRemoteServers`),
      // so the two agree about who sees it -- and `?watch=` spells its target
      // `host_port`, since a colon in a query value makes a browser offer to
      // search for the address instead of showing it.
      // Hands the address to an installed BZFlag client, so it is offered to
      // everyone: nothing on this server is involved.
      actions: action(`bzflag://${s.host}:${s.port}`, t('Launch'))
        + (canWatch
          ? action(`/?watch=${encodeURIComponent(`${s.host}_${s.port}`)}`, t('Watch'))
            // Playing there as `bzo-<callsign>`, unregistered, which a server
            // that keeps guests out refuses (`guestSpawn`).
            + (entryGuestSpawn(s) === 'no' ? ''
              : action(`/?watch=${encodeURIComponent(`${s.host}_${s.port}`)}&team=play`, t('Play')))
          : '')
        + `<form method="post" action="/list/import" class="inlineForm">`
        + `<input type="hidden" name="host" value="${escapeHtml(s.host)}">`
        + `<input type="hidden" name="port" value="${s.port}">`
        + `<button type="submit">${escapeHtml(importedPath ? t('Re-import') : t('Import'))}</button></form>`,
    };
  });

  // bzo's own list server (docs/list-server-plan.md): read from the designated
  // instance's public endpoint rather than dialled the way a bzfs row above is.
  // One entry per game, which for an instance that proxies means one per
  // target as well as one for itself, carrying that target's own counts,
  // options and style rather than this instance's. The URL is the instance
  // either way and the link is its `?proxy=` for the target, so two instances
  // carrying one target read as two ways in rather than two servers
  // (`docs/proxy.md`).
  const bzoEntry = (s, proxy, index) => {
    const game = proxy || s;
    const maxima = Array.isArray(game.teamMaximums) ? game.teamMaximums : [];
    // The reported name is the identity (`host:port`); a link spells it the
    // way a URL should, which is the one derivation between the two.
    const href = proxy ? `${s.url}/?proxy=${encodeURIComponent(proxyUrlKey(proxy.target))}` : s.url;
    // The bzfs row for the same address, which on an instance reading the
    // merged list carries the figures and picture the list server measured.
    const relayed = proxy ? servers.find((b) => `${b.host}:${b.port}` === proxy.target) : null;
    const urlLink = `<a href="${escapeHtml(s.url)}">${escapeHtml(s.url)}</a>`;
    // Every name the carrier answers on, each linking into this target the way
    // the row does.
    const carriers = [s.url, ...(Array.isArray(s.alsoAt) ? s.alsoAt : [])]
      .map((url) => `<a href="${escapeHtml(proxy ? `${url}/?proxy=${encodeURIComponent(proxyUrlKey(proxy.target))}` : url)}">`
        + `${escapeHtml(url)}</a>`).join('<br>');
    return {
      id: `bzo-pane-${index}`,
      addr: proxy ? proxy.target : s.url,
      desc: proxy ? (proxy.title || proxy.target) : s.title,
      // A carried target is a bzfs, so its version is that server's.
      version: proxy
        ? ((relayed?.world || publishWorldFacts(...splitHostPort(proxy.target)) || {}).version || '')
        : (s.version || ''),
      hash: (proxy
        ? (relayed?.world || publishWorldFacts(...splitHostPort(proxy.target)) || {})
        : (s.world || {})).hash || '',
      href,
      owner: (proxy ? relayed?.owner : s.owner) || '',
      action: t('Enter game'),
      // A carried target is a real BZFlag server, so a BZFlag client can go
      // straight there. Playing it from a browser under a registered callsign
      // needs a global login bzfs can check itself (`playerAlive`,
      // bzfs.cxx:3199), so the carrier's own `/login/<target>/-/automatic`
      // takes the forum login first and comes back joining with its token.
      actions: proxy
        ? action(`${s.url}/login/${encodeURIComponent(proxyUrlKey(proxy.target))}/-/automatic`, t('Login and Play'))
          + action(`bzflag://${proxy.target}`, t('Launch'))
        : '',
      style: game.style,
      maxShots: game.maxShots,
      gameOptionsBits: game.gameOptionsBits,
      players: game.players,
      bots: game.bots,
      disableBots: game.disableBots === true,
      botsKnown: true,
      maxPlayers: game.maxPlayers,
      observers: Array.isArray(game.teamCounts) ? game.teamCounts[5] : undefined,
      observerMax: maxima[5],
      teamCounts: game.teamCounts,
      teamMaximums: maxima,
      shakeTimeout: game.shakeTimeout,
      shakeWins: game.shakeWins,
      maxTime: game.maxTime,
      maxTeamScore: game.maxTeamScore,
      maxPlayerScore: game.maxPlayerScore,
      // A row is one thing or the other: a game bzo is running on a map of its
      // own, or a real BZFlag server it is carrying. The map's extension is
      // the report's business, not a reader's.
      // A proxy row's world is the *target's* world, a real BZFlag one, so its
      // picture is that server's -- the same import a bzfs row for the same
      // address would show, when this instance holds one. Never
      // `s.overviewUrl`, which belongs to a different game on the same host.
      overviewUrl: proxy
        ? (importedOverviewUrl(proxy.target) || relayed?.overviewUrl || null)
        : (s.overviewUrl || null),
      extras: proxy
        ? [
          [t('BZFlag server'), escapeHtml(proxy.target)],
          [t('Owner'), ownerLink(relayed?.owner)],
          [t('Carried by'), carriers],
          // A proxy row's world is the target's, so the figures are the ones
          // a bzfs row for the same address shows -- what the list server
          // measured, or else this instance's own import, the way the picture
          // above is. Nothing here fetches, and a proxy row is not a reason to.
          ...(relayed?.world
            ? describeRelayedWorld(relayed.world, t)
            : describeImportedWorld(...splitHostPort(proxy.target), t)),
        ]
        : [
          [t('Map'), escapeHtml(String(s.map || '').replace(/\.bzw$/, ''))],
          [t('Version'), escapeHtml(s.version || '')],
          // Only a bzo row can have this: a bzfs server holds no key and sends
          // no report, and the public BZFlag list carries no uptime.
          [t('Up'), escapeHtml(formatUptime(s.upSince, t))],
          [t('Owner'), describeOwner(s.owner, s.ownerBzid)],
          [t('Voice chat'), s.voiceEnabled ? escapeHtml(t('configured')) : ''],
          ['URL', urlLink],
          [t('Also at'), (Array.isArray(s.alsoAt) ? s.alsoAt : [])
            .map((url) => `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`).join('<br>')],
          // What that instance says its own world costs. Reported rather
          // than measured here -- only the instance can see its own maps
          // directory -- and absent for one too old to be reporting it.
          ...describeOwnWorld(s.world, t),
        ],
    };
  };
  let bzoIndex = 0;
  const bzoEntries = bzoServers.flatMap((s) => {
    const proxies = Array.isArray(s.proxies) ? s.proxies : [];
    // An instance that proxies and hosts its own game shows both: the game is
    // real and so are the targets.
    return [bzoEntry(s, null, bzoIndex++), ...proxies.map((proxy) => bzoEntry(s, proxy, bzoIndex++))];
  });

  const tables = {
    bzoHeading: listHeadingCount(bzoEntries, t),
    bzoTable: renderServerList('bzoServerList', 'bzoServerFilter', bzoEntries, t),
    bzfsHeading: listHeadingCount(bzfsEntries, t),
    bzfsTable: renderServerList('serverList', 'serverFilter', bzfsEntries, t),
    mapsHeading: `${localMaps.length}${missingOverviewCount(localMaps.map(
      (map) => ({ overviewUrl: localMapOverviewUrl(map.fileName) }),
    ), t)}`,
    mapsTable: renderMapList('mapList', 'mapFilter', localMaps, t),
  };
  listTablesCache.set(cacheKey, { at: Date.now(), tables });
  return tables;
}

// The strings `public/js/list-page.js` writes itself, by the msgids it looks
// them up under, which the page embeds translated as `list-l10n`.
const LIST_PAGE_MSGIDS = l10n.scriptMsgids(path.join(__dirname, 'public', 'js', 'list-page.js'));

function renderListPage({
  servers, bzoServers, cacheAgeSeconds, imported, importError, session, admin, canWatch, replays = [],
  discoveryHead = '', locale,
}) {
  const tables = renderListTables({
    servers, bzoServers, canWatch, locale,
  });
  const t = l10n.translator(locale);
  const link = (href, text) => `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
  const code = (text) => `<code>${escapeHtml(text)}</code>`;

  // One nav line at the very top: a jump link to each section below, then
  // this instance's own login state last -- it authenticates this instance's
  // bzflag.org session either way, but only unlocks the key admin section
  // when this instance is the designated one.
  const identityBlock = session
    ? `<strong>${escapeHtml(session.callsign)}</strong>${admin ? ` ${escapeHtml(t('(admin)'))}` : ''}`
      + ` -- ${link('/logout', t('Log out'))}`
    : link('/login/list', IS_DESIGNATED_LIST_SERVER
      ? t('Log in with your bzflag.org account to register a server')
      : t('Log in with your bzflag.org account'));
  // "keys" is the one link here that is not always this page's own section:
  // key admin only exists on the designated instance, so anywhere else it
  // jumps straight to the real thing rather than to this page's own
  // redirect-to-there notice. bzo/bzflag/maps stay relative -- every
  // instance actually has those three itself.
  const keysHref = IS_DESIGNATED_LIST_SERVER || !LIST_SERVER_URL
    ? '#keys'
    : `${LIST_SERVER_URL}/list#keys`;
  // bzo and bzflag are names; the rest are words.
  const navBlock = `<p class="nav">`
    + `<a href="#bzo">bzo</a> | <a href="#bzflag">bzflag</a> | ${link('#maps', t('maps'))} | ${link('#replays', t('replays'))}`
    + ` | ${link(keysHref, t('keys'))} | ${link('/help', t('help'))}`
    + ` | ${identityBlock}</p>`;

  const flash = imported
    ? `<p class="flash success">${l10n.html(t('Imported {file} -- it is in the local maps table below.'), { file: code(imported) })}</p>`
    : importError
      ? `<p class="flash error">${escapeHtml(t('Import failed: {error}', { error: importError }))}</p>`
      : '';
  const listMessages = Object.fromEntries(LIST_PAGE_MSGIDS.map((msgid) => [msgid, t(msgid)]));

  return `<!doctype html>
<html lang="${escapeHtml(l10n.languageTag(locale))}" dir="${l10n.textDirection(locale)}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(t('bzo servers'))}</title>
${discoveryHead}
<link rel="icon" sizes="16x16 32x32 48x48" href="/favicon.ico">
<style>
  /* bzo's own palette (public/styles.css) -- this page links straight into the
     game (View, /?viewmap=), so it reads as the same product rather than a
     generic admin tool bolted on beside it. */
  body {
    font: 14px/1.4 Arial, sans-serif;
    margin: 2rem;
    color: #fff;
    background: #000;
  }
  h1 { font-size: 1.3rem; margin: 2rem 0 0.5rem; color: #4CAF50; }
  a { color: #66bb6a; }
  .muted { color: #999; font-size: 0.9em; }
  .nav { font-size: 1.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid #333; }
  code { color: #ccc; }
  input[type=text] {
    padding: 0.4rem 0.6rem;
    margin: 0.5rem 0;
    width: 20rem;
    max-width: 100%;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid #4CAF50;
    border-radius: 4px;
    color: #fff;
  }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 0.35rem 0.6rem; text-align: left; }
  th {
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
    color: #4CAF50;
    border-bottom: 2px solid #4CAF50;
  }
  th:hover { color: #66bb6a; }
  tbody tr:nth-child(even) { background: rgba(255, 255, 255, 0.05); }
  tbody tr:hover { background: rgba(76, 175, 80, 0.15); }
  tbody tr.clickable { cursor: pointer; }
  .inlineForm { display: inline; }
  button {
    padding: 0.2rem 0.7rem;
    background: rgba(76, 175, 80, 0.15);
    border: 1px solid #4CAF50;
    border-radius: 4px;
    color: #4CAF50;
    cursor: pointer;
  }
  button:hover { background: rgba(76, 175, 80, 0.35); border-color: #66bb6a; }
  .flash { padding: 0.5rem 0.8rem; border-radius: 4px; border: 1px solid; }
  .flash.success { background: #16321f; color: #b7e2c2; border-color: #4CAF50; }
  .flash.error { background: #3a1a17; color: #f0b8b2; border-color: #c0392b; }
  .stale { color: #f0b8b2; }
  /* A world's variables: read by bzo in the accent, ignored ones muted. */
  details.vars summary { cursor: pointer; }
  details.vars ul { margin: 0.3rem 0 0; padding: 0; list-style: none; font-family: monospace; font-size: 0.85em; }
  details.vars li { overflow-wrap: anywhere; }
  .var-read { color: #8fd19e; }
  .var-unread { color: #9a8f86; }
  /* The same themed scrollbar the game's own panels use (public/styles.css):
     accent thumb on a dark track, standard properties first and the WebKit
     pseudo-elements for the versions that predate them. This page has its own
     palette rather than the stylesheet's variables, so the two values are
     spelled out. */
  html {
    scrollbar-width: thin;
    scrollbar-color: #4CAF50 rgba(0, 0, 0, 0.5);
  }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: rgba(0, 0, 0, 0.5); border-radius: 5px; }
  ::-webkit-scrollbar-thumb {
    background: rgba(76, 175, 80, 0.35);
    border: 1px solid #4CAF50;
    border-radius: 5px;
  }
  ::-webkit-scrollbar-thumb:hover { background: #4CAF50; }
  ::-webkit-scrollbar-corner { background: transparent; }
  /* The list and its readout pane, side by side where there is room and
     stacked where there is not -- the pane is the row's own detail either
     way, so on a phone it belongs directly under the list. */
  /* Not full-page-wide: a row is one line of text and a pane is a short
     column of numbers, and neither reads better for being stretched across a
     desktop monitor. */
  .listWrap { max-width: 56rem; }
  /* Ten rows and then a scrollbar -- upstream's own page size
     (ServerMenu.cxx:34), which is why paging was not worth copying: a scroll
     box holding the same ten rows costs no PageUp/PageDown. Each row is
     exactly 1.5rem tall, so this is ten of them.
     NOTE: no backticks in this block -- see attachTable below. */
  .srows {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 15rem;
    overflow-y: auto;
  }
  /* Monospace so the J F R letters line up down the list the way they do in a
     fixed-width HUD -- that alignment is what makes the column scannable. */
  .srow {
    display: flex;
    gap: 0.45rem;
    align-items: baseline;
    height: 1.5rem;
    padding: 0 0.4rem;
    font-family: monospace;
    white-space: nowrap;
    text-decoration: none;
    color: #fff;
  }
  .srow:hover { background: rgba(76, 175, 80, 0.15); }
  .srow.selected { background: rgba(76, 175, 80, 0.3); outline: none; }
  .srow .mark { font-weight: bold; }
  .srow .addr { flex: none; }
  /* The header sits over the row it heads: same flex geometry, same column
     widths, and each button stripped back to the one character in it. */
  .shead {
    display: flex;
    gap: 0.45rem;
    padding: 0 0.4rem;
    font-family: monospace;
    border-bottom: 1px solid #4CAF50;
  }
  .shead button {
    padding: 0;
    background: none;
    border: none;
    border-radius: 0;
    font: inherit;
    text-align: inherit;
  }
  .shead button:hover { background: none; color: #66bb6a; }
  .shead button.active { text-decoration: underline; }
  /* Each numeric column is exactly as wide as its widest value needs, measured
     when the page is built (listColumnWidth) and carried as a custom property
     on the list itself. */
  .srow .count, .shead .count, .srow .num, .shead .num { flex: none; text-align: right; }
  .col-p { width: var(--col-p, 2ch); }
  .col-o { width: var(--col-o, 2ch); }
  .col-b { width: var(--col-b, 2ch); }
  .col-obj { width: var(--col-obj, 4ch); }
  .col-fa { width: var(--col-fa, 5ch); }
  .col-sz { width: var(--col-sz, 4ch); }
  .col-date { width: 19ch; }
  .col-len { width: 6ch; }
  .col-pl { width: var(--col-pl, 7ch); }
  .srow .dim { color: #999; }
  .srow .mark, .srow .opt, .shead .mark, .shead .opt {
    flex: none;
    width: 1ch;
    text-align: center;
  }
  .shead .name { flex: none; }
  .srow .desc { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .pane { border: 1px solid #333; border-radius: 4px; padding: 0.6rem 0.8rem; }
  .paneTitle { margin: 0 0 0.5rem; color: #4CAF50; font-weight: bold; }
  /* Everything a pane says on the left -- its title and both columns of words
     -- and the overview picture to the right of the lot. The text block is the
     one that flexes, so a long line of game words wraps inside its own column
     instead of growing the row until the picture drops underneath it. The
     picture only goes below on a screen too narrow to hold both. */
  .paneMain { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; align-items: flex-start; }
  .paneBody { flex: 1 1 20rem; min-width: 0; }
  /* Teams in the first column, the game in the second, wrapping onto one
     column where there is no room for two. */
  .paneCols { display: flex; flex-wrap: wrap; gap: 0.5rem 2rem; align-items: flex-start; }
  .paneCol { min-width: 0; }
  .paneCol:first-child { flex: none; }
  .paneCol:nth-child(2) { flex: 1 1 14rem; }
  .paneCol > :first-child { margin-top: 0; }
  /* The picture is square and drawn for 256 pixels, but it is an SVG, so a
     narrow screen may shrink it without it going soft. Pushed to the right
     edge of the pane, so it sits against the border rather than floating
     wherever the text happens to end. */
  .overview { flex: none; margin-left: auto; }
  .overview img { display: block; width: 256px; height: auto; max-width: 100%;
    border: 1px solid #333; border-radius: 4px; }
  /* Nothing to show yet: the app's own mark, dimmed, in a box the same size as
     the picture that will replace it, so the pane does not jump. */
  .overviewWaiting { width: 256px; aspect-ratio: 1; display: grid;
    place-items: center; border: 1px solid #333; border-radius: 4px;
    background: #12140f; }
  .overviewWaiting img { width: 64px; height: 64px; border: 0; opacity: 0.35; }
  .paneRow { display: flex; gap: 0.6rem; }
  .paneRow span:first-child { color: #999; min-width: 6rem; }
  .paneWords { margin: 0.5rem 0; color: #ccc; }
  .filterError { margin: 0.3rem 0; color: #f0b8b2; }
  /* The syntax reference, folded away until the "?" beside the filter asks for
     it. Two columns: what to type, and what it means.
     NOTE: no backticks in this block -- it lives inside server.js's own outer
     template literal, and one here would close it. */
  .filterHelp {
    max-width: 44rem;
    margin: 0.5rem 0;
    padding: 0.6rem 0.8rem;
    border: 1px solid #333;
    border-radius: 4px;
  }
  .filterHelp p { margin: 0.5rem 0; }
  .filterHelp .helpGroup { color: #4CAF50; margin: 0.8rem 0 0.3rem; }
  .filterHelp .helpRow { display: flex; gap: 0.6rem; }
  .filterHelp .helpRow span:first-child { flex: none; width: 11rem; }
  .filterHelp code { color: #66bb6a; }
  /* The filter and the selected row's own buttons share one line, and wrap
     onto a second rather than overflowing on a phone. */
  .listBar { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; }
  .rowActions { display: flex; gap: 0.5rem; align-items: center; }
  /* A filter box's clear button, inside its right edge; list-page.js shows it
     while there is something to clear. */
  .clearBox { position: relative; display: inline-flex; }
  .clearBox input { padding-right: 1.6rem; }
  .clearBox button {
    position: absolute; right: 0.2rem; top: 50%; transform: translateY(-50%);
    border: none; background: none; color: #999; cursor: pointer;
    font-size: 1rem; line-height: 1; padding: 0.1rem 0.3rem;
  }
  .clearBox button:hover { color: #eee; }
  .clearBox button[hidden] { display: none; }
  .rowActions[hidden] { display: none; }
  a.action {
    padding: 0.2rem 0.7rem;
    background: rgba(76, 175, 80, 0.15);
    border: 1px solid #4CAF50;
    border-radius: 4px;
    color: #4CAF50;
    text-decoration: none;
  }
  a.action:hover { background: rgba(76, 175, 80, 0.35); border-color: #66bb6a; }
</style>
</head>
<body>
${navBlock}
<h1 id="bzo">${escapeHtml(t('Public bzo servers - {count}', { count: tables.bzoHeading }))}<span id="bzoServerList-count"></span></h1>
<p class="muted">${l10n.html(t("From the designated bzo list server, {server} -- pick a row to read it; Enter, or the pane's own link, goes in."), {
    server: LIST_SERVER_URL ? link(`${LIST_SERVER_URL}/list`, LIST_SERVER_URL) : escapeHtml(t('disabled on this instance')),
  })}</p>
${tables.bzoTable}

<h1 id="bzflag">${escapeHtml(t('Public BZFlag servers - {count}', { count: tables.bzfsHeading }))}<span id="serverList-count"></span></h1>
<p class="muted">${l10n.html(t('From the public list server (my.bzflag.org), cached {seconds}s ago -- {refresh}.'), {
    seconds: cacheAgeSeconds, refresh: link('/list', t('refresh')),
  })}
${escapeHtml(t('Pick a row to read it; its link views that map, and does not enter that game.'))}</p>
${flash}
${tables.bzfsTable}

<h1 id="maps">${escapeHtml(t('Local maps - {count}', { count: tables.mapsHeading }))}<span id="mapList-count"></span></h1>
<p class="muted">${l10n.html(t("Already in this server's {directory} -- pick a row to read it; its link views that map."), {
    directory: code('maps/'),
  })}</p>
${tables.mapsTable}

<h1 id="replays">${escapeHtml(t('Local replays - {count}', { count: replays.length }))}<span id="replayList-count"></span></h1>
<p class="muted">${l10n.html(t("bzfs recordings in this server's {directory} -- pick a row to read it; Watch plays it to everyone watching that replay."), {
    directory: code('replays/'),
  })}</p>
${renderReplayList('replayList', 'replayFilter', replays, t)}

<!-- Sorting, selection and the filter language: public/js/list-page.js. A plain
     classic script, not a module, so it is defined before the key admin
     section's own inline script below calls attachTable. Its own words come
     translated in list-l10n, which has to be in the page before it runs. -->
<script type="application/json" id="list-l10n">${l10n.inlineJson(listMessages)}</script>
<script src="/js/list-page.js"></script>

${renderListServerKeyAdminSection({ session, admin, t })}

<footer class="muted">
<p>${escapeHtml(t('bzo {version} (build {build}): BZFlag in the browser, on desktop, phone and headset, and this list of the servers to play it on.', {
    version: SERVER_VERSION, build: CLIENT_BUILD,
  }))}</p>
<p>${l10n.html(t('Copyright (C) 2025-2026 Tim Riker. Free software under the {license}; source at {source}.'), {
    license: link('https://www.gnu.org/licenses/agpl-3.0.html', 'GNU AGPL v3'),
    source: link('https://github.com/timriker/bzo', 'github.com/timriker/bzo'),
  })}</p>
</footer>
</body>
</html>`;
}

// The list as a search engine reads it: the card, and every public bzo server
// as an entry with its own URL, so each is found from here.
function listDiscoveryHead(req, bzoServers) {
  const base = requestBase(req);
  if (!base) return '';
  const description = 'Every public Battlezone Online (bzo) server, and the BZFlag servers:'
    + ' who is playing, on what map, and a link straight into each game.';
  return discovery.pageHead({
    base,
    path: '/list',
    title: 'bzo servers -- Battlezone Online',
    description,
    jsonLd: [discovery.serverListJsonLd({
      base,
      servers: bzoServers.filter((server) => server.url).map((server) => ({
        url: server.url, title: server.title, description: server.description, players: server.players,
      })),
    })],
  });
}

app.get('/list', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.vary('Accept-Language').vary('Cookie');
  const locale = l10n.negotiateLocale(req);
  try {
    const lists = await getDisplayServerLists();
    const servers = [...lists.bzfs]
      .sort((a, b) => (b.info?.players ?? -1) - (a.info?.players ?? -1));
    const bzoServers = [...lists.bzo].sort((a, b) => (b.players ?? -1) - (a.players ?? -1));
    const session = sessionFromRequest(req);
    const admin = isLocalAdminHttp(req) || (session ? isAdminSession(session, ADMIN_GROUPS) : false);
    res.type('html').send(renderListPage({
      servers,
      bzoServers,
      cacheAgeSeconds: lists.bzfsCacheAgeSeconds,
      imported: typeof req.query.imported === 'string' ? req.query.imported : null,
      importError: typeof req.query.error === 'string' ? req.query.error : null,
      session,
      admin,
      // The same admins `authoriseProxyRequest` lets through. One with no
      // login claims no name on the remote: it watches and plays as a
      // `bzo-view-<tag>`, which says it is nobody in particular.
      canWatch: admin,
      replays: await listReplays(),
      discoveryHead: listDiscoveryHead(req, bzoServers),
      locale,
    }));
  } catch (error) {
    logError('/list failed to reach the list server:', error);
    const t = l10n.translator(locale);
    res.status(502).type('text/plain').send(`${t('Could not reach the BZFlag list server. Try again shortly.')}\n`);
  }
});

// `/view` and `/list-server` both merged into `/list` above -- redirected
// rather than removed outright, since either could be bookmarked.
app.get('/view', (req, res) => {
  const query = new URLSearchParams(req.query).toString();
  res.redirect(301, query ? `/list?${query}` : '/list');
});
app.get('/list-server', (req, res) => res.redirect(301, '/list#keys'));

app.post('/list/import', (req, res) => {
  const target = parseHostPort(`${req.body?.host || ''}:${req.body?.port || ''}`);
  if (!target) {
    res.redirect(302, `/list?${new URLSearchParams({ error: 'Expected host:port' })}`);
    return;
  }
  const { host, port } = target;
  log(`/list is importing a remote map from ${host}:${port}`);
  performRemoteMapImport(host, port).then(({ safeMapName, byteLength, reused }) => {
    log(reused
      ? `/list reused the cached copy of ${host}:${port}, ${safeMapName} (${byteLength} bytes)`
      : `Imported remote map ${host}:${port} as ${safeMapName} (${byteLength} bytes) via /list`);
    res.redirect(302, `/list?${new URLSearchParams({ imported: safeMapName })}`);
  }).catch((error) => {
    logError(`Remote map import from ${host}:${port} failed (via /list):`, error);
    res.redirect(302, `/list?${new URLSearchParams({ error: error.message })}`);
  });
});

// The pages a search engine or an AI reads (`server/discovery.cjs`, and
// docs/api.md, "Discovery"): /help from the help pages (docs/help/), robots.txt
// and a sitemap of the pages worth reading, and llms.txt.

function discoveryContext(req) {
  const base = requestBase(req);
  if (!base) return null;
  const host = requestHost(req);
  return {
    base,
    name: documentTitle(host),
    title: serverConfig.title || '',
    description: discovery.serverDescription(serverConfig.title),
    version: SERVER_VERSION,
    listServerUrl: IS_DESIGNATED_LIST_SERVER || !LIST_SERVER_URL ? base : LIST_SERVER_URL,
    helpMarkdown: helpDocs.helpMarkdown(),
    discordLink: Boolean(discordLink),
  };
}

function sendDiscovery(req, res, type, build) {
  const context = discoveryContext(req);
  if (!context) {
    res.status(400).type('text/plain').send('Malformed Host header');
    return;
  }
  res.set('Cache-Control', REVALIDATE);
  res.type(type).send(build(context));
}

// The help pages in the reader's language, all on one page or one at a time.
function sendHelp(req, res, slug) {
  const locale = l10n.negotiateLocale(req);
  const all = helpDocs.renderPages(locale);
  const pages = slug ? all.filter((page) => page.slug === slug) : all;
  if (!pages.length) {
    res.status(404).type('text/plain').send('No such help page');
    return;
  }
  res.vary('Accept-Language').vary('Cookie');
  const docLocale = helpDocs.docLocale(locale);
  sendDiscovery(req, res, 'html', (context) => discovery.helpPage({
    ...context,
    pages,
    path: slug ? `/help/${slug}` : '/help',
    lang: l10n.languageTag(docLocale),
    dir: l10n.textDirection(docLocale),
    t: l10n.translator(locale),
    description: discovery.serverDescription(serverConfig.title, l10n.translator(locale)),
  }));
}
app.get('/help', (req, res) => sendHelp(req, res, null));
// The in-game help panel's copy, `live` for the line about this world's
// ricochet rule that only the client can write.
app.get('/help.json', (req, res) => {
  const locale = l10n.negotiateLocale(req);
  res.set('Cache-Control', REVALIDATE);
  res.vary('Accept-Language').vary('Cookie');
  res.json({
    locale: helpDocs.docLocale(locale),
    pages: helpDocs.renderPages(locale, { live: true }),
  });
});
app.get('/help/:page', (req, res) => sendHelp(req, res, req.params.page));
app.get('/robots.txt', (req, res) => sendDiscovery(req, res, 'text/plain', ({ base }) => discovery.robotsTxt(base)));
app.get('/sitemap.xml', (req, res) => sendDiscovery(req, res, 'application/xml',
  ({ base }) => discovery.sitemapXml(base, new Date(SERVER_START_TIME).toISOString().slice(0, 10))));
app.get('/llms.txt', (req, res) => sendDiscovery(req, res, 'text/markdown; charset=utf-8', discovery.llmsTxt));
app.get('/llms-full.txt', (req, res) => sendDiscovery(req, res, 'text/markdown; charset=utf-8', discovery.llmsFullTxt));

// Safari, iMessage and link-preview crawlers ask the site root for these
// without reading the page, which links the 180 one under icons/.
app.get(['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png'], (req, res) => {
  res.set('Cache-Control', REVALIDATE);
  res.sendFile(path.join(__dirname, 'public', 'icons', 'apple-touch-icon-180.png'));
});

// The manifest is generated per request so the installed app is named after the
// host the client asked for, verbatim. Two hosts pointing at different servers
// then install as two separately-named apps. TLS terminates at a reverse proxy
// (see README), so the forwarded header carries the host the client sent.
//
// The icons vary by browser for a second reason, in `docs/icons.md`: a phone
// launcher crops a maskable icon and needs the art padded inside it, while a
// headset library letterboxes the same file and needs it padded not at all.
app.get('/manifest.webmanifest', (req, res) => {
  const host = requestHost(req);
  if (!host) {
    res.status(400).type('text/plain').send('Malformed Host header');
    return;
  }
  const headset = isHeadsetBrowserUA(req.get('user-agent'));
  // The icon URL carries the file's own timestamp: a browser that cached an
  // icon days ago holds a response it still considers fresh, and would not ask
  // again until it expired, long after the artwork changed.
  const icon = (file, size, purpose) => ({
    src: `/icons/${file}?v=${Math.floor(fs.statSync(path.join(__dirname, 'public', 'icons', file)).mtimeMs)}`,
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose,
  });
  // A shared cache must not hand one device the other's manifest.
  res.set('Vary', 'User-Agent');
  res.set('Cache-Control', REVALIDATE);
  res.type('application/manifest+json').send(JSON.stringify({
    id: '/',
    name: host,
    short_name: shortHostName(host),
    description: serverConfig.title || undefined,
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    display_override: ['fullscreen', 'standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#000000',
    theme_color: '#4caf50',
    categories: ['games'],
    launch_handler: { client_mode: 'focus-existing' },
    icons: [
      icon(headset ? 'tile-192.png' : 'any-192.png', 192, 'any'),
      icon(headset ? 'tile-512.png' : 'any-512.png', 512, 'any'),
      icon(headset ? 'tile-1024.png' : 'any-1024.png', 1024, 'any'),
      icon(headset ? 'tile-192.png' : 'maskable-192.png', 192, 'maskable'),
      icon(headset ? 'tile-512.png' : 'maskable-512.png', 512, 'maskable'),
    ],
  }, null, 2));
});

// AGPL §13: provide source code access to network users
app.get('/source', (req, res) => {
  res.redirect(302, 'https://github.com/timriker/bzo');
});
// --- Admin API Endpoints ---

// Errors that reach a server object have no per-socket owner. Left unhandled
// they throw the same way a socket error does.
process.on('uncaughtException', (err) => {
  logError(`Uncaught exception: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logError(`Unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
  process.exit(1);
});

// Built here, where the WebSocket server needs something to attach to, and
// bound further down once `server.json` has been read: which address to bind is
// a setting, and a setting cannot be honoured before the file it lives in has
// been loaded.
const server = http.createServer(app);

server.on('error', (err) => {
  logError(`HTTP server error: ${err.message}`);
  process.exit(1);
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on('error', (err) => {
  logError(`WebSocket server error: ${err.message}`);
});

// `https: { cert, key }`, PEM files beside server.json or absolute: the same
// app over TLS, answered on the BZFlag port alongside BZFlag and plain HTTP
// (docs/port-mux-plan.md). A headset will not run WebXR without it. HTTP/2
// where the browser offers it, so a page's many requests share one
// connection, and HTTP/1.1 otherwise -- which is also how a WebSocket comes,
// handed to the plain server's handler. Express runs on HTTP/2 through
// server/http2-bridge.cjs.
function loadHttpsServer() {
  const config = serverConfig.https;
  if (!config || typeof config !== 'object') return null;
  const read = (file) => fs.readFileSync(path.resolve(path.dirname(CONFIG_PATH), String(file)));
  try {
    const tlsServer = http2.createSecureServer({
      cert: read(config.cert), key: read(config.key), allowHTTP1: true,
    }, bridgeHttp2(app));
    // A PROXY header renamed the socket underneath (proxy-protocol.cjs); the
    // TLS socket over it asks the kernel instead, so it is told.
    tlsServer.on('secureConnection', (tlsSocket) => {
      const parent = tlsSocket._parent;
      if (parent && Object.hasOwn(parent, 'remoteAddress')) {
        setSocketPeer(tlsSocket, parent.remoteAddress, parent.remotePort);
      }
    });
    const wssTls = new WebSocketServer({ server: tlsServer });
    wssTls.on('connection', (ws, req) => wss.emit('connection', ws, req));
    wssTls.on('error', (err) => logError(`WebSocket server error: ${err.message}`));
    return tlsServer;
  } catch (error) {
    logError(`[HTTPS] off: ${error.message}`);
    return null;
  }
}

// Game constants
const GAME_CONFIG = {
  // `_worldSize` (global.cxx:184), which upstream defaults to 800 and states as
  // the full width -- so a world with no `world` block spans +/-400. A BZW
  // `world`'s `size` is the half width and `CustomWorld::read` doubles it
  // (CustomWorld.cxx:38), which is why the parser below does the same. Matching
  // upstream's default matters for any map that omits the block: `fountains.bzw`
  // puts towers at +/-200 with room to spare at 800 and straddling the boundary
  // wall at anything smaller.
  MAP_SIZE: 800,
  TANK_SPEED: 25.0, // BZFlag-like default (units per second)
  TANK_ROTATION_SPEED: 0.785398, // BZFlag _tankAngVel default (radians per second)
  REVERSE_SPEED_RATIO: 0.5, // Max reverse speed as fraction of forward speed
  // -a <vel> <rot> upstream: the acceleration limit, zero meaning none, which is
  // upstream's default and so bzo's. See the flags module for what the numbers
  // mean and why the linear one is scaled by 20.
  LINEAR_ACCELERATION: 0,
  ANGULAR_ACCELERATION: 0,
  SHOT_SPEED: 100, // BZFlag _shotSpeed default (units per second)
  SHOT_RANGE: 350, // BZFlag _shotRange default (world units)
  SHOT_DISTANCE: 350, // Legacy alias for client/radar code
  // ms; upstream's `_reloadTime`, which is how long a shot lives and the basis
  // the per-slot reload below is derived from. Null until a map states one,
  // which leaves upstream's own default of _shotRange / _shotSpeed standing.
  SHOT_LIFETIME: null,
  SHOT_RELOAD_TIME: null, // ms; derived below from BZFlag's _reloadTime / maxShots
  SHOT_COOLDOWN: null, // Legacy alias used by existing client fire gating
  SHOT_MAX_ACTIVE: 1, // BZFlag maxShots default
  SHOT_RADIUS: 0.5, // BZFlag _shotRadius default
  SHOT_TAIL_LENGTH: 4.0, // BZFlag _shotTailLength default
  SHOTS_KEEP_VERTICAL_VELOCITY: false, // BZFlag _shotsKeepVerticalVelocity default
  // ms between player updates when nothing has changed. bzo's own server
  // extrapolates between packets and keeps the socket alive with WebSocket
  // pings, so this only has to be often enough that a resting tank is not
  // mistaken for a gone one. A proxied connection overrides it, because a
  // bzfs measures silence against `_notRespondingTime` and takes the flag of
  // whoever exceeds it (`buildProxyInit`).
  MAX_UPDATE_INTERVAL: 5000,
  MAX_SPEED_TOLERANCE: 1.5, // Allow 50% tolerance for latency
  SHOT_POSITION_TOLERANCE: 2, // Max distance shot can be from claimed position
  // cmdPause() counts down five seconds before a pause takes hold, so a tank
  // about to be shot cannot become invulnerable on the frame it is hit.
  PAUSE_COUNTDOWN: 5000, // ms; BZFlag clientCommands.cxx:481
  PAUSE_DROP_TIME: 15000, // ms; BZFlag _pauseDropTime default
  // ms; BZFlag _explodeTime: how long a dead tank waits to spawn again
  // (`setSpawnDelay`, bzfs.cxx:3371), and how long its pieces tumble.
  RESPAWN_DELAY: 5000,
  // ms; BZFlag _rejoinTime: how long a player who left after playing waits to
  // spawn again on coming back (RejoinList.cxx). Null is upstream's default,
  // `_explodeTime`.
  REJOIN_TIME: null,
  JUMP_VELOCITY: 19, // BZFlag _jumpVelocity default
  GRAVITY: 9.8, // BZFlag _gravity magnitude (units per second squared)
  // Wings' four BZDB variables. Locked upstream, which means the server sets
  // them and the client obeys, so they travel with the rest of the world's
  // physics. The two nulls are upstream's own defaults, which are the strings
  // "_jumpVelocity" and "_gravity" rather than numbers; they are resolved to the
  // world's values below.
  WINGS_JUMP_COUNT: DEFAULT_WINGS_JUMP_COUNT, // BZFlag _wingsJumpCount
  MAX_FLAG_GRABS, // BZFlag _maxFlagGrabs
  MAX_BUMP_HEIGHT: DEFAULT_MAX_BUMP_HEIGHT, // BZFlag _maxBumpHeight
  WINGS_JUMP_VELOCITY: null, // BZFlag _wingsJumpVelocity; defaults to JUMP_VELOCITY
  WINGS_GRAVITY: null, // BZFlag _wingsGravity magnitude; defaults to GRAVITY
  WINGS_SLIDE_TIME: DEFAULT_WINGS_SLIDE_TIME, // BZFlag _wingsSlideTime
  // Machine Gun's three, locked upstream like the rest. The life is null for
  // upstream's default, "1.0 / _mGunAdRate" (`configureFlagEffects`).
  MGUN_AD_VEL: MACHINE_GUN_AD_VEL, // BZFlag _mGunAdVel
  MGUN_AD_RATE: MACHINE_GUN_AD_RATE, // BZFlag _mGunAdRate
  MGUN_AD_LIFE: null, // BZFlag _mGunAdLife
  LASER_AD_VEL, // BZFlag _laserAdVel
  LASER_AD_RATE, // BZFlag _laserAdRate
  LASER_AD_LIFE, // BZFlag _laserAdLife
  SHOCK_AD_LIFE, // BZFlag _shockAdLife
  SHOCK_IN_RADIUS, // BZFlag _shockInRadius
  SHOCK_OUT_RADIUS, // BZFlag _shockOutRadius
  GM_AD_LIFE, // BZFlag _gmAdLife
  GM_TURN_ANGLE, // BZFlag _gmTurnAngle
  GM_ACTIVATION_TIME, // BZFlag _gmActivationTime
  BURROW_SPEED_AD, // BZFlag _burrowSpeedAd
  BURROW_ANGULAR_AD, // BZFlag _burrowAngularAd
  RFIRE_AD_VEL: RAPID_FIRE_AD_VEL, // BZFlag _rFireAdVel
  RFIRE_AD_RATE: RAPID_FIRE_AD_RATE, // BZFlag _rFireAdRate
  RFIRE_AD_LIFE: null, // BZFlag _rFireAdLife; null follows the rate
  THIEF_AD_SHOT_VEL, // BZFlag _thiefAdShotVel
  THIEF_AD_RATE, // BZFlag _thiefAdRate
  THIEF_AD_LIFE, // BZFlag _thiefAdLife
  THIEF_VEL_AD, // BZFlag _thiefVelAd
  THIEF_TINY_FACTOR, // BZFlag _thiefTinyFactor
  THIEF_DROP_TIME: null, // BZFlag _thiefDropTime, seconds; null is _reloadTime * 0.5
  VELOCITY_AD, // BZFlag _velocityAd
  ANGULAR_AD, // BZFlag _angularAd
  TINY_FACTOR, // BZFlag _tinyFactor
  OBESE_FACTOR, // BZFlag _obeseFactor
  NARROW_FACTOR, // BZFlag _narrowFactor
  AGILITY_AD_VEL, // BZFlag _agilityAdVel
  AGILITY_TIME_WINDOW, // BZFlag _agilityTimeWindow
  AGILITY_VEL_DELTA, // BZFlag _agilityVelDelta
  SR_RADIUS_MULT, // BZFlag _srRadiusMult
  FLAG_EFFECT_TIME, // BZFlag _flagEffectTime
  SQUISH_FACTOR: 1.0, // BZFlag _squishFactor; how far a hard landing flattens a tank
  SQUISH_TIME: 1.0, // BZFlag _squishTime; how long it takes to stand back up
  NO_CLIMB: true, // BZFlag _noClimb; a jump from a slope goes straight up
  // The world's scene switches, which upstream locks: what a viewer may not
  // draw, and how long tread marks last (seconds; 0 draws none).
  DRAW_MOUNTAINS: true, // BZFlag _drawMountains
  DRAW_CLOUDS: true, // BZFlag _drawClouds
  DRAW_CELESTIAL: true, // BZFlag _drawCelestial
  DRAW_GROUND: true, // BZFlag _drawGround
  NO_SHADOWS: false, // BZFlag _noShadows
  TRACK_FADE: 3.0, // BZFlag _trackFade
  // BZFlag _radarLimit: the farthest the radar reaches, and with 0 or less
  // (`-noradar`) no radar at all. Null is upstream's default, the world size.
  RADAR_LIMIT: null,
  // Flags on the field (`flagTuning`): how high one is thrown, its pole.
  FLAG_ALTITUDE, // BZFlag _flagAltitude
  FLAG_POLE_SIZE, // BZFlag _flagPoleSize
  SPEED_CHECKS_LOG_ONLY: false, // BZFlag _speedChecksLogOnly
  DISABLE_SPEED_CHECKS: false, // BZFlag _disableSpeedChecks
  UPDATE_THROTTLE_RATE: 30, // BZFlag _updateThrottleRate, updates a second at most
  FORBID_MARKERS: false, // BZFlag _forbidMarkers
  // SpawnPolicy (`findSafeSpawn`): tank radii from a tank facing the spot, from
  // a Steamroller or Burrow, the share of a Shock Wave's reach, and ms to look.
  SPAWN_SAFE_RAD_MOD: 20, // BZFlag _spawnSafeRadMod
  SPAWN_SAFE_SR_MOD: 3, // BZFlag _spawnSafeSRMod
  SPAWN_SAFE_SW_MOD: 1.5, // BZFlag _spawnSafeSWMod
  SPAWN_MAX_COMP_TIME: 10, // BZFlag _spawnMaxCompTime
  // The tank itself (`configureTankDimensions`). Null radius and muzzle front
  // are upstream's own formulas, `0.72 * _tankLength` and `_tankRadius + 0.1`.
  TANK_LENGTH: 6.0, // BZFlag _tankLength
  TANK_WIDTH: 2.8, // BZFlag _tankWidth
  TANK_HEIGHT: 2.05, // BZFlag _tankHeight
  TANK_RADIUS: null, // BZFlag _tankRadius
  MUZZLE_HEIGHT: 1.57, // BZFlag _muzzleHeight
  MUZZLE_FRONT: null, // BZFlag _muzzleFront
  TANK_EXPLOSION_SIZE: 3.5 * 6.0, // BZFlag _tankExplosionSize, upstream's 3.5 * _tankLength
  // What a `box` or `pyramid` with no `size` line is, and what box walls tile
  // by (`0.2 * _boxHeight`, SceneBuilder.cxx:198). Upstream's defaults are
  // formulas over the tank: `6.0*_muzzleHeight`, `4.0*_tankHeight`,
  // `5.0*_tankHeight`.
  BOX_BASE: 30.0, // BZFlag _boxBase, a half width
  BOX_HEIGHT: 6.0 * 1.57, // BZFlag _boxHeight
  PYR_BASE: 4.0 * 2.05, // BZFlag _pyrBase, a half width
  PYR_HEIGHT: 5.0 * 2.05, // BZFlag _pyrHeight
  // How high the visible border wall stands, which is where a shot stops
  // bouncing off it. 0 is a world whose shots all leave it.
  WALL_HEIGHT: WORLD_WALL_HEIGHT, // BZFlag _wallHeight
  // How fast the sky's day runs against a real one: 1 is a real day, the 72
  // here a 20-minute one, 0 a sky that stands still. bzo's own clock, not
  // upstream's astronomy (AGENTS.md).
  DAY_SPEED: 72,
  JUMP_COOLDOWN: 500, // ms between jumps
  FOG_MODE: 'none', // BZFlag _fogMode default
  FOG_DENSITY: 0.001, // BZFlag _fogDensity default
  FOG_START: null, // Defaults to 0.5 * map size like BZFlag
  FOG_END: null, // Defaults to map size like BZFlag
  FOG_COLOR: [0.25, 0.25, 0.25], // BZFlag _fogColor default
  MIRROR: null, // BZFlag _mirror: [r, g, b, a] tint over a mirrored ground, null for none
  // BZFlag _skyColor, which tints the sky; null is upstream's "white", no tint.
  SKY_COLOR: null,
  // BZFlag _syncTime: 0 or more freezes every viewer's sky at that many seconds
  // past the Unix epoch, which `_longitude` (west positive, upstream's 122 by
  // default) turns into a local hour on bzo's clock. -1 lets the sky run.
  SYNC_TIME: -1,
  LONGITUDE: 122,
  // BZFlag _latitude, degrees north: where the upstream sky stands.
  LATITUDE: 37.5,
  // Which sky: upstream's sun, moon and stars at the world's place and the
  // real time (#166), or 'minecraft', bzo's day clock (`timeOfDay`,
  // `daySpeed`).
  SKY: 'upstream',
  VOICE_NEARBY_RADIUS: 60, // Maximum distance for the initial Nearby voice channel
  // -time upstream (CmdLineOptions.h:79), seconds until the match ends; 0 is no
  // limit, which is bzfs's own default -- see "Match end" in
  // docs/game-modes-plan.md and issue #66.
  TIME_LIMIT: 0,
  // -timemanual upstream: the clock above waits for /countdown instead of
  // starting the moment the server has a limit to run.
  TIME_MANUAL_START: false,
  // -mps/-mts upstream (CmdLineOptions.h): a player's or a colour team's wins
  // minus losses ending the match; 0 is no limit either way.
  MAX_PLAYER_SCORE: 0,
  MAX_TEAM_SCORE: 0,
};

// WebSocket keep-alive configuration
// One frame serves both purposes: it is what proves the socket is alive and
// what measures how long the answer takes. So the cadence is the measurement's
// rather than liveness's -- upstream's ten seconds (`nextping += 10.0`,
// LagInfo.cxx:263), because a connection that degrades is worth seeing while it
// is still degrading.
const WS_PING_INTERVAL = PING_INTERVAL_MS;
const WS_PONG_TIMEOUT = 60000; // Close connection if no pong after 60 seconds

// --- Map selection: load from config and maps/ directory ---
function ensureServerConfig(configPath) {
  if (fs.existsSync(configPath)) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (!fs.existsSync(EXAMPLE_CONFIG_PATH)) {
      throw new Error(`No example config found at ${EXAMPLE_CONFIG_PATH}`);
    }

    fs.copyFileSync(EXAMPLE_CONFIG_PATH, configPath);
    log(`Created default server config at ${configPath}`);
  } catch (error) {
    logError(`Could not create default server config at ${configPath}:`, error);
  }
}

const configPath = CONFIG_PATH;

// server.json as a person reads it: keys sorted at every level so a setting is
// found by name, and a final newline so `cat` leaves the prompt on its own line.
// Arrays keep their order, which can matter (`voiceIceServers`, map lists).
function sortJsonKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonKeys(value[key])]));
}

function writeServerConfig(config) {
  fs.writeFileSync(configPath, `${JSON.stringify(sortJsonKeys(config), null, 2)}\n`);
}
const BUNDLED_MAPS_DIR = path.join(__dirname, 'maps');
const RUNTIME_MAPS_DIR = process.env.MAPS_PATH
  ? path.resolve(process.env.MAPS_PATH)
  : path.join(path.dirname(configPath), 'maps');
// bzfs recordings, laid out as maps are: the runtime directory beside
// `server.json` first, then the bundled sample (docs/replay.md). Never under
// `public/`: a raw recording's hidden packets hold players' addresses.
const BUNDLED_REPLAYS_DIR = path.join(__dirname, 'replays');
const RUNTIME_REPLAYS_DIR = process.env.REPLAYS_PATH
  ? path.resolve(process.env.REPLAYS_PATH)
  : path.join(path.dirname(configPath), 'replays');
// Server plugins (docs/plugins-plan.md), laid out as maps are: the bundled
// ones, which an upgrade replaces, then the operator's beside `server.json`,
// which it keeps. An operator's plugin wins over a bundled one of the same
// name. The two are one directory only in the old layout (`CONFIG_IS_LEGACY`).
const BUNDLED_PLUGINS_DIR = path.join(__dirname, 'plugins');
// The plugin host, made last of all (below) so a plugin's Init finds the whole
// server defined; null until then, so a hook run during boot is a no-op.
let plugins = null;
const RUNTIME_PLUGINS_DIR = process.env.PLUGINS_PATH
  ? path.resolve(process.env.PLUGINS_PATH)
  : path.join(path.dirname(configPath), 'plugins');

// The Operator panel's "Import Remote Map" dropdown, and the public `/list`
// page below, both read this -- one POST to the public list server decodes
// every running server's live player count and game type (PingPacket's own
// hex blob, see remote-world-import.cjs), so populating either one never
// itself connects to any of the servers it lists. Cached and shared across
// every caller (one process-wide entry, not one per visitor): the list
// changes slowly enough that a few minutes stale is fine, and it keeps a
// public page from putting one request to my.bzflag.org per visitor.
const REMOTE_SERVER_LIST_TTL_MS = 5 * 60 * 1000;
let remoteServerListCache = { at: 0, servers: [] };

// Keeps each listed BZFlag server's world import fresh enough for its row on
// `/list` to have a picture, and no fresher (`server/bzfs-worlds.cjs`). The
// callbacks fire on its own timer rather than at construction, which is why it
// can name things defined much further down this file.
const bzfsWorlds = createBzfsWorldTracker({
  statePath: path.join(CACHE_DIR, 'bzfs-worlds.json'),
  queryServerStatus: (host, port) => queryServerStatus(host, port),
  importWorld: (host, port, guest) =>
    performRemoteMapImport(host, port, IMPORT_WORLD_BACKGROUND_TIMEOUT_MS, guest),
  probeGuestAccess: (host, port, { spawn }) =>
    probeGuestAccess(host, port, { spawn, motto: serverCheckMotto() }),
  // A world with a BZFlag hash has a picture once one is saved under that
  // hash, whether or not the import it was drawn from is still here. One with
  // none has nothing to key a picture by, so only a live import counts.
  hasPicture: (host, port, worldHash) => {
    if (isBzfsWorldHash(worldHash)) return Boolean(bzfsOverviewPath(host, port, worldHash));
    const fileName = remoteMapFileName(host, port);
    return MAP_REGISTRY.has(fileName) || mapIndex.has(fileName, resolveMapFilePath(fileName));
  },
  onPassComplete: () => purgeUnreferencedOverviews(),
  log,
  logError,
});

// What `cache/overviews/` holds that nothing points at any more: a bzo
// instance that has changed map leaves its old world's picture behind, and
// nothing else ever mentions that hash again.
//
// Only once the world tracker has a current answer for every listed server
// (`onPassComplete`), because before that an unreferenced picture may simply
// be one the pass has not reached. And only once nothing has referred to it
// for `OVERVIEW_UNUSED_MS`, counted from the first complete pass that found it
// unused, so a server briefly off the list or a report not yet landed never
// costs a picture. When each picture was first found unused is kept on disk,
// because a restart must not restart the count.
const OVERVIEW_UNUSED_MS = 24 * 60 * 60 * 1000;
const OVERVIEW_UNUSED_PATH = path.join(CACHE_DIR, 'overviews-unused.json');

function purgeUnreferencedOverviews() {
  // Every picture anything still shows: this server's own maps (its local
  // maps table, its own game among them), each bzo instance on the list, and
  // each BZFlag server on the list.
  const referenced = new Set();
  for (const entry of MAP_REGISTRY.values()) {
    if (entry.overviewUrl) referenced.add(path.basename(entry.overviewUrl, '.svg'));
  }
  // The bzo list as it is published: a key gone stale is off the list, so
  // its picture's day starts.
  for (const record of listServerKeys.listAll()) {
    if (record.live?.mapHash && !isListServerKeyStale(record)) referenced.add(record.live.mapHash);
  }
  for (const worldHash of bzfsWorlds.worldHashes()) referenced.add(`bzfs-${worldHash}`);
  const now = Date.now();
  let unusedSince = {};
  try {
    unusedSince = JSON.parse(fs.readFileSync(OVERVIEW_UNUSED_PATH, 'utf8')) || {};
  } catch {
    // None recorded yet: every unused picture starts its day now.
  }
  let names;
  try {
    names = fs.readdirSync(OVERVIEW_CACHE_DIR);
  } catch {
    return;
  }
  const stillUnused = {};
  let removed = 0;
  for (const name of names) {
    const hash = name.endsWith('.svg') ? name.slice(0, -4) : null;
    if (!hash || referenced.has(hash)) continue;
    const since = Number.isFinite(unusedSince[name]) ? unusedSince[name] : now;
    if (now - since < OVERVIEW_UNUSED_MS) {
      stillUnused[name] = since;
      continue;
    }
    try {
      fs.unlinkSync(path.join(OVERVIEW_CACHE_DIR, name));
      removed += 1;
    } catch (error) {
      logError(`Could not remove unreferenced overview ${name}:`, error);
      stillUnused[name] = since;
    }
  }
  try {
    fs.writeFileSync(OVERVIEW_UNUSED_PATH, JSON.stringify(stillUnused, null, 1) + '\n');
  } catch (error) {
    logError(`Could not write ${OVERVIEW_UNUSED_PATH}:`, error);
  }
  if (removed > 0) log(`[WORLDS] removed ${removed} overview(s) unused for a day`);
}

async function getRemoteServerList() {
  if (Date.now() - remoteServerListCache.at < REMOTE_SERVER_LIST_TTL_MS) {
    return remoteServerListCache.servers;
  }
  const servers = await fetchServerList(DEFAULT_LIST_SERVER, BZFS_PROTOCOL_VERSION);
  await countServerBots(servers);
  remoteServerListCache = { at: Date.now(), servers };
  // The one place the list is actually refreshed, so the one place worth
  // handing to the world tracker (`server/bzfs-worlds.cjs`): a row that is new
  // or whose listed configuration has changed becomes due for a world check
  // ahead of its daily schedule.
  bzfsWorlds.observe(servers);
  return servers;
}

// bzo's own list server's public read endpoint (docs/list-server-plan.md),
// for `/list`'s third table. Same cache shape as `getRemoteServerList` and
// the same reason: shared across every visitor rather than one fetch each.
let bzoServerListCache = { at: 0, lists: { bzfs: [], bzo: [], bzfsCacheAgeSeconds: 0 } };

// Both lists for `/list`, in one call where one call will do.
//
// The designated instance reads its own registry in-process and fetches the
// public list itself, as it always did. Every other instance asks the
// designated one for both at once: the bzo rows it alone holds, and the bzfs
// rows with each row's picture already named. Fetching the public list
// separately as well would be asking a second party for something the first
// already sent, fresher, and then matching the two by `host:port` across
// copies that aged apart.
//
// **Falling back is the point of keeping the direct fetch.** With no list
// server configured, or one that cannot be reached, or one too old to carry
// the bzfs half, this goes upstream itself and the page is exactly what it
// was before any of this -- minus the pictures, which were never the reason
// anyone came.
//
// `getRemoteServerList` stays the authority for the *import* check
// (`performRemoteMapImport`) whatever happens here. A relayed list must not
// be able to authorise this server into dialling a host upstream never
// listed.
async function getDisplayServerLists() {
  if (IS_DESIGNATED_LIST_SERVER || !LIST_SERVER_URL) {
    return {
      bzfs: await getRemoteServerList().catch((error) => {
        logError('/list could not reach the BZFlag list server:', error);
        return remoteServerListCache.servers;
      }),
      bzo: LIST_SERVER_URL ? listPublicListServerRows() : [],
      bzfsCacheAgeSeconds: Math.max(0, Math.round((Date.now() - remoteServerListCache.at) / 1000)),
    };
  }
  if (Date.now() - bzoServerListCache.at < REMOTE_SERVER_LIST_TTL_MS) {
    return bzoServerListCache.lists;
  }
  try {
    const response = await fetch(`${LIST_SERVER_URL}/api/list-server/list`, {
      headers: { 'User-Agent': BZO_USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const bzo = Array.isArray(body.servers) ? body.servers : [];
    const bzfs = Array.isArray(body.bzfs) && body.bzfs.length
      ? body.bzfs
      : await getRemoteServerList();
    const lists = {
      bzfs,
      bzo,
      bzfsCacheAgeSeconds: Number.isFinite(body.bzfsCacheAgeSeconds)
        ? body.bzfsCacheAgeSeconds : 0,
    };
    bzoServerListCache = { at: Date.now(), lists };
    return lists;
  } catch (error) {
    logError(`/list could not reach the bzo list server at ${LIST_SERVER_URL}:`, error.message || error);
    const cached = bzoServerListCache.lists;
    return {
      bzfs: cached.bzfs.length ? cached.bzfs : await getRemoteServerList().catch(() => []),
      bzo: cached.bzo,
      bzfsCacheAgeSeconds: Math.max(0, Math.round((Date.now() - remoteServerListCache.at) / 1000)),
    };
  }
}

// Parses "host:port", downloads that server's world over the real wire
// protocol, and saves it as an ordinary .bzw in RUNTIME_MAPS_DIR -- the one
// piece of work behind both the websocket `importMap` (used by the Operator
// panel) and the `/list` page's plain HTTP form below. Throws with a message
// safe to show the caller; does not hash the file or tell anyone about it --
// that is the caller's job, since a websocket reply and an HTTP redirect say
// it differently.
function parseHostPort(hostPort) {
  const trimmed = typeof hostPort === 'string' ? hostPort.trim() : '';
  const match = trimmed.match(/^([^\s:]+):(\d{1,5})$/);
  const port = match ? Number(match[2]) : NaN;
  if (!match || !(port >= 1 && port <= 65535)) return null;
  return { host: match[1], port };
}

// Shared with `/list`'s cross-reference below: the only place either one is
// allowed to name a remote server's import file, so a check there and the
// file `performRemoteMapImport` actually writes can never name it two ways.
function remoteMapFileName(host, port) {
  return `import-${host}_${port}`.replace(/[^A-Za-z0-9._-]/g, '_') + '.bzw';
}

// The inverse: recovers the host:port a `?viewmap=` link's own
// `import-<host>_<port>.bzw` name came from, so a shared link still says
// which server to (re-)ask once bzo has let its cached copy go
// (`IMPORT_REUSE_MS` below) or never fetched it in this process at all --
// see `importMapForView`. Re-asking needs that server to still be in the
// public list; a copy already here does not (`reuseCachedImport`). Sanitizing the host is lossy (any character
// outside [A-Za-z0-9._-] becomes '_'), so this only trusts a name that
// reproduces itself exactly when run back through `remoteMapFileName`: a
// real import's own name always does, and nothing else needs to.
function parseImportMapFileName(fileName) {
  const match = typeof fileName === 'string' ? fileName.match(/^import-(.+)_(\d{1,5})\.bzw$/) : null;
  if (!match) return null;
  const host = match[1];
  const port = Number(match[2]);
  if (!(port >= 1 && port <= 65535)) return null;
  return remoteMapFileName(host, port) === fileName ? { host, port } : null;
}

// How long a remote import is reused without asking its server anything: long
// enough that following the same shared link twice in a sitting costs nothing.
// Past it, a `?viewmap=` link asks the server's world hash first and keeps the
// copy when it has not changed (`confirmImportUnchanged`), so only a changed
// world is downloaded again. `maps/import-*.bzw` is a regeneratable cache (see
// .gitignore), and `parseImportMapFileName` above is what lets a link outlive
// this window rather than just going stale.
const IMPORT_REUSE_MS = 60 * 60 * 1000;

// Twice the reuse window: an import nobody has asked for again in the time
// that would have reused it is one `sweepStaleImports` (below) deletes rather
// than keeps "just in case" -- `performRemoteMapImport` recreates it from
// scratch, and easily, the moment it is actually asked for again.
const IMPORT_MAX_AGE_MS = IMPORT_REUSE_MS * 2;

// Turns whatever `parseBZWMap` couldn't process while reading a freshly
// imported map back into literal `-srvmsg` lines, appended to the `.bzw` file
// itself (a second `options` block -- `parseBZWServerOptions` already
// accumulates across as many of those as a file has, see the loop above) so
// the gap is on record in the file a mapper or operator can read, not just
// bzo's own console, and reaches a joining player through the exact same
// `-srvmsg` -> `messages` -> `announceWorldMessages` path a mapper's own
// `-srvmsg` line does. Deduplicated and capped: many of `parseBZWMap`'s
// warnings repeat once per instance (one broken teleporter link, one
// degenerate face, ...), and a wall of identical chat lines on join would
// bury the ones actually worth reading.
const IMPORT_WARNING_SRVMSG_LIMIT = 20;
function buildImportWarningOptionsBlock(warnedMessages) {
  const unique = Array.from(new Set(warnedMessages));
  if (unique.length === 0) return '';
  const shown = unique.slice(0, IMPORT_WARNING_SRVMSG_LIMIT);
  const toSrvmsg = (text) => `  -srvmsg "${text.replace(/"/g, '\'').replace(/[\r\n]+/g, ' ')}"`;
  // No header line: `announceWorldMessages` says each of these as its own
  // separate chat line, so a label saying only "there are lines below" would
  // be the one line here carrying no actual content -- every real line
  // already names the map and the specific thing dropped, and stands on its
  // own without one.
  const lines = ['options', ...shown.map(toSrvmsg)];
  if (unique.length > shown.length) {
    lines.push(toSrvmsg(`...and ${unique.length - shown.length} more (see server.log)`));
  }
  lines.push('end', '');
  return lines.join('\n');
}

// Two nearly-simultaneous requests for the same host:port (a double click, a
// page load racing an operator's own import) each used to run this whole
// function independently -- harmless back when it only ever overwrote the
// file wholesale, but now that a warning pass appends to it afterward
// (`buildImportWarningOptionsBlock`), two interleaved runs duplicate that
// append instead of one clean overwrite winning. Keyed by the file both
// would produce, so a second caller joins the first's own promise instead of
// starting a second one.
const inFlightRemoteImports = new Map();

// A copy this process already holds of a host:port it may no longer fetch.
// Reaching out to an unlisted server is what the public-list check refuses;
// a file already sitting in maps/ costs that server nothing, so a shared
// `?viewmap=` link to one that has since dropped `-public` still opens
// rather than dying on a check about a download it does not need to make.
// `MAP_REGISTRY`, not the file alone: a map is viewable only once it has
// been parsed and hashed (see `hashRemainingMapsInBackground`).
// Parses and registers an import still on disk and fetched inside
// `IMPORT_REUSE_MS`, by its mtime. Returns whether it did.
async function registerFreshImportFromDisk(fileName) {
  const filePath = path.join(RUNTIME_MAPS_DIR, fileName);
  try {
    if (Date.now() - fs.statSync(filePath).mtimeMs >= IMPORT_REUSE_MS) return false;
    return Boolean(await parseAndRegisterMap(fileName, filePath));
  } catch {
    return false;
  }
}

// The world hash an import was saved with: the `# world hash` line its header
// carries (remote-world-import.cjs), read without reading the whole world.
function importedWorldHash(fileName) {
  let fd = null;
  try {
    fd = fs.openSync(path.join(RUNTIME_MAPS_DIR, fileName), 'r');
    const head = Buffer.alloc(4096);
    const length = fs.readSync(fd, head, 0, head.length, 0);
    return head.toString('utf8', 0, length).match(/^# world hash ([pt][0-9a-f]{32})$/m)?.[1] || '';
  } catch {
    return '';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// An import past `IMPORT_REUSE_MS` whose server still runs the world it was
// saved from is not stale, it is only old: the hash says so for one short
// dial (`MsgWantWHash`), or for nothing when the world tracker asked inside
// the same window. Then the copy on disk is kept, its age reset, and the
// world is not downloaded again. A hash that differs or cannot be had --
// no header, a server that will not answer -- falls through to the download.
async function confirmImportUnchanged(fileName, host, port) {
  const saved = importedWorldHash(fileName);
  if (!isBzfsWorldHash(saved)) return false;
  const record = bzfsWorlds.recordFor(host, port);
  let current = record && Date.now() - (record.checkedAt || 0) < IMPORT_REUSE_MS ? record.worldHash : '';
  if (!current) {
    try {
      current = (await queryServerStatus(host, port)).worldHash;
    } catch {
      return false;
    }
  }
  if (current !== saved) return false;
  // What the tracker would have learned from the same dial.
  bzfsWorlds.noteImport(host, port, current);
  const filePath = path.join(RUNTIME_MAPS_DIR, fileName);
  try {
    const now = new Date();
    fs.utimesSync(filePath, now, now);
  } catch {
    return false;
  }
  // An entry only listed, never kept (`keptAt`), has no world JSON to serve.
  const registered = MAP_REGISTRY.get(fileName);
  if (registered?.keptAt && fs.existsSync(path.join(MAP_CACHE_DIR, `${registered.hash}.json`))) {
    registered.registeredAt = Date.now();
    registered.keptAt = Date.now();
    return true;
  }
  return Boolean(await parseAndRegisterMap(fileName, filePath));
}

// Converts a map file nobody is playing and registers it: quiet, because its
// own quirks are for whoever views or joins it to see, not a log line about a
// map nobody chose today. `keepWorld` as `registerWorldFile` takes it.
async function parseAndRegisterMap(fileName, filePath, { keepWorld = true } = {}) {
  const world = await convertMapFile(fileName, filePath, { keepWorld });
  const registered = registerWorldFile(fileName, world, { keepWorld });
  return registered ? { registered, instancing: world.instancing } : null;
}

// A local map's world JSON, written now for someone about to load it -- the
// same step a `?viewmap=` of a remote server's map takes once its import is
// on disk. Only the live map keeps its JSON otherwise. Returns the entry, or
// null where the file is not a listed map or will not parse.
// One conversion per file however many viewers ask for it at once.
const mapViewPreparations = new Map();
function prepareMapForView(fileName) {
  const existing = MAP_REGISTRY.get(fileName);
  if (existing && existing.keptAt && fs.existsSync(path.join(MAP_CACHE_DIR, `${existing.hash}.json`))) {
    existing.keptAt = Date.now();
    return Promise.resolve(existing);
  }
  if (!listLocalMapFiles().includes(fileName)) return Promise.resolve(null);
  const filePath = resolveMapFilePath(fileName);
  if (!filePath) return Promise.resolve(null);
  let pending = mapViewPreparations.get(fileName);
  if (!pending) {
    pending = parseAndRegisterMap(fileName, filePath)
      .then((parsed) => parsed?.registered || null)
      .catch((error) => {
        logError(`Could not convert map ${fileName} for viewing:`, error);
        return null;
      })
      .finally(() => mapViewPreparations.delete(fileName));
    mapViewPreparations.set(fileName, pending);
  }
  return pending;
}

// Where one obstacle of a registered world came from in its map file, for the
// world viewer (docs/editor-plan.md): the block's lines and text, and the
// `group` blocks that placed it, outermost first. The world JSON does not
// carry this; a worker parses the file again on the first ask for a world
// and the spans stay for the next few. Null when the world has no file (a
// generated one) or the file has changed since the world was built.
const OBSTACLE_SOURCE_WORLDS = 4;
const OBSTACLE_SOURCE_MAX_LINES = 400;
const obstacleSources = new Map();
function obstacleSourcesFor(hash) {
  const cached = obstacleSources.get(hash);
  if (cached) return cached;
  let entry = null;
  for (const candidate of MAP_REGISTRY.values()) {
    if (candidate.hash === hash) entry = candidate;
  }
  const filePath = entry && resolveMapFilePath(entry.fileName);
  if (!filePath) return Promise.resolve(null);
  const pending = new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'server', 'map-spans-worker.cjs'), {
      workerData: { filePath, gameConfigDefaults: GAME_CONFIG_DEFAULTS },
    });
    let result = null;
    worker.on('message', (message) => { result = message; });
    worker.on('error', (error) => logError(`Could not read source spans of ${entry.fileName}:`, error));
    worker.on('exit', () => {
      const current = result && (!entry.bzfsHash || result.bzfsHash === entry.bzfsHash);
      resolve(current ? {
        fileName: entry.fileName,
        text: result.text,
        spans: result.spans,
        missingTextures: result.missingTextures,
        warnings: result.warnings,
        materials: result.materials,
      } : null);
    });
  });
  obstacleSources.set(hash, pending);
  pending.then((sources) => {
    if (!sources) obstacleSources.delete(hash);
  });
  while (obstacleSources.size > OBSTACLE_SOURCE_WORLDS) {
    obstacleSources.delete(obstacleSources.keys().next().value);
  }
  return pending;
}

async function obstacleSourceFor(hash, index) {
  const sources = await obstacleSourcesFor(hash);
  const flat = sources?.spans[index];
  if (!flat) return null;
  const block = ([startLine, endLine, start, end]) => {
    const lines = sources.text.slice(start, end).replace(/\r?\n$/, '').split(/\r?\n/);
    // A member of a `define` reads from its own first column.
    const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)[0].length));
    for (let i = 0; i < lines.length; i += 1) lines[i] = lines[i].slice(Math.min(indent, /^[ \t]*/.exec(lines[i])[0].length));
    const shown = lines.slice(0, OBSTACLE_SOURCE_MAX_LINES);
    return {
      startLine,
      endLine,
      text: shown.join('\n'),
      ...(lines.length > shown.length ? { moreLines: lines.length - shown.length } : {}),
    };
  };
  const own = block(flat.slice(0, 4));
  const placedBy = [];
  for (let at = 4; at < flat.length; at += 4) placedBy.push(block(flat.slice(at, at + 4)));
  return { file: sources.fileName, ...own, placedBy, materials: referencedMaterials(sources, [own, ...placedBy], block) };
}

// Every material the blocks name with `matref`, and the materials those name
// in turn, each with its own block: a name as `findMaterial` reads it, a
// leading digit an index into the file's materials, the last of a name the
// one it finds. A name the file never defines comes back `missing`.
function referencedMaterials(sources, blocks, block) {
  const byName = new Map();
  sources.materials.forEach((material, index) => {
    if (material[0]) byName.set(material[0].toLowerCase(), index);
  });
  const found = [];
  const seen = new Set();
  const queue = blocks.map((b) => b.text);
  while (queue.length) {
    for (const match of queue.shift().matchAll(/\bmatref\s+"?([^\s"]+)/gi)) {
      const ref = match[1];
      if (ref === '-1' || seen.has(ref.toLowerCase())) continue;
      seen.add(ref.toLowerCase());
      const index = /^[0-9]/.test(ref) ? parseInt(ref, 10) : byName.get(ref.toLowerCase());
      const material = sources.materials[index];
      if (!material || !material[1]) {
        found.push({ ref, missing: true });
        continue;
      }
      const materialBlock = block(material.slice(1, 5));
      found.push({ ref, name: material[0], ...materialBlock });
      queue.push(materialBlock.text);
    }
  }
  return found;
}

function reuseCachedImport(host, port) {
  const safeMapName = remoteMapFileName(host, port);
  if (!MAP_REGISTRY.has(safeMapName)) return null;
  try {
    const { size } = fs.statSync(path.join(RUNTIME_MAPS_DIR, safeMapName));
    return { safeMapName, byteLength: size, reused: true };
  } catch {
    return null;
  }
}

// A proxy's own import, authorized by the operator's `proxies` map rather than
// by the public list: name from the key, address from the value, permission
// from the config. `performRemoteMapImport` below stays exactly as strict as
// it was -- the address there comes from a client-supplied `?viewmap=` name,
// and its public-list check is what stands between that name and an arbitrary
// outbound connection. This is a second caller of the same fetch, authorized
// differently, not a loosening of the first.
async function importProxyWorld(target) {
  const safeMapName = remoteMapFileName(target.displayHost, target.displayPort);
  // A copy this process already holds and has not let go stale. Same window as
  // a `?viewmap=` import: following two links to the same target in a sitting
  // should not fetch its world twice.
  const registered = MAP_REGISTRY.get(safeMapName);
  if (registered && Date.now() - registered.registeredAt < IMPORT_REUSE_MS) {
    return { safeMapName, reused: true };
  }
  const existing = inFlightRemoteImports.get(safeMapName);
  if (existing) return existing;
  const promise = performRemoteMapImportNow({
    host: target.displayHost,
    port: target.displayPort,
    dialHost: target.host,
    dialPort: target.port,
    // The list server's words about a public name, when it happens to have
    // any: a proxied target need not be listed at all, and its own title
    // arrives with the world either way.
    title: '',
    info: null,
  }, safeMapName).finally(() => inFlightRemoteImports.delete(safeMapName));
  inFlightRemoteImports.set(safeMapName, promise);
  return promise;
}

// A replay's name is its file's, less `.rec`: what `?replay=` carries and a
// list row shows. Only names that cannot climb out of the directory.
function replayFilePath(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(name)) return null;
  for (const dir of new Set([RUNTIME_REPLAYS_DIR, BUNDLED_REPLAYS_DIR])) {
    const filePath = path.join(dir, `${name}.rec`);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

// A whole recording, read for a room, which holds it for as long as anyone
// watches. Nothing else keeps one: a list row needs only `replaySummaryFor`.
async function loadReplay(name) {
  const filePath = replayFilePath(name);
  if (!filePath) return null;
  return readReplay(await fs.promises.readFile(filePath));
}

// Every recording this instance holds, by name: the runtime directory's over
// a bundled one of the same name, as `replayFilePath` resolves it.
function listReplayNames() {
  const names = new Set();
  for (const dir of new Set([RUNTIME_REPLAYS_DIR, BUNDLED_REPLAYS_DIR])) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.endsWith('.rec') ? entry.slice(0, -4) : null;
      if (name && replayFilePath(name)) names.add(name);
    }
  }
  return [...names].sort();
}

// What a list row says about one recording (`summarizeReplay`), kept per
// file and remade when the file changes. A file that does not read as a
// recording is listed with the reason, so an upload that went wrong is seen.
const replaySummaries = new Map();
async function replaySummaryFor(name) {
  const filePath = replayFilePath(name);
  if (!filePath) return null;
  const { mtimeMs, size } = await fs.promises.stat(filePath);
  const held = replaySummaries.get(name);
  if (held && held.mtimeMs === mtimeMs && held.size === size) return held;
  let entry;
  try {
    const replay = readReplay(await fs.promises.readFile(filePath));
    entry = { name, mtimeMs, size, summary: summarizeReplay(replay), error: null };
  } catch (error) {
    entry = { name, mtimeMs, size, summary: null, error: error.message };
  }
  replaySummaries.set(name, entry);
  return entry;
}

// The map a recording was played on: the local map whose world bzfs would
// hash the same (`bzfsHash`, from the map worker), else a server last seen
// running it. Empty when neither is known.
function replayMapName(worldHash) {
  if (!worldHash) return '';
  for (const entry of MAP_REGISTRY.values()) {
    if (entry.bzfsHash !== worldHash) continue;
    if (parseImportMapFileName(entry.fileName) || isReplayWorldFile(entry.fileName)) continue;
    return entry.fileName.replace(/\.bzw$/i, '');
  }
  return bzfsWorlds.serversWithWorld(worldHash)[0] || '';
}

// A recording's picture: bzfs's own world hash names it where this server has
// drawn that world, else the replay world's own once a room has registered it.
function replayOverviewUrl(worldHash) {
  if (isBzfsWorldHash(worldHash)
    && fs.existsSync(path.join(OVERVIEW_CACHE_DIR, `bzfs-${worldHash}.svg`))) {
    return `/overviews/bzfs-${worldHash}.svg`;
  }
  return MAP_REGISTRY.get(`import-replay-${worldHash}.bzw`)?.overviewUrl || null;
}

// Every recording as `/list` and the View dialog show it, with how far along
// a room playing it is.
async function listReplays() {
  const out = [];
  for (const name of listReplayNames()) {
    const entry = await replaySummaryFor(name);
    if (!entry) continue;
    const room = replayRooms.get(name);
    out.push({
      name,
      size: entry.size,
      modified: entry.mtimeMs,
      error: entry.error,
      summary: entry.summary,
      map: entry.summary ? replayMapName(entry.summary.worldHash) : '',
      overviewUrl: entry.summary ? replayOverviewUrl(entry.summary.worldHash) : null,
      playing: room ? room.progress() : null,
    });
  }
  return out;
}

// A recording's world, registered as a map so a room's `init` can name it, the
// way a proxied target's is. Filed by bzfs's world hash, so two recordings on
// one map share it, and under `import-` so its `.bzw` is swept and ignored
// like any other reconstruction (.gitignore). Its JSON is kept as a viewed
// map's is, for an hour from each join (`keptAt`, `sweepMapCache`); one swept
// already is rebuilt from the recording, which costs a parse.
const inFlightReplayImports = new Map();
async function importReplayWorld(name, replay) {
  const tag = isBzfsWorldHash(replay.worldHash) ? replay.worldHash : name;
  const safeMapName = `import-replay-${tag}`.replace(/[^A-Za-z0-9._-]/g, '_') + '.bzw';
  const registered = MAP_REGISTRY.get(safeMapName);
  if (registered && fs.existsSync(path.join(MAP_CACHE_DIR, `${registered.hash}.json`))) {
    registered.keptAt = Date.now();
    return { safeMapName };
  }
  const existing = inFlightReplayImports.get(safeMapName);
  if (existing) return existing;
  const promise = (async () => {
    const tree = parseWorldDatabase(replay.world);
    // The server's variables as of the first snapshot, for the map's `-set`
    // lines, and its settings out of the header (`worldSettings` is the whole
    // MsgGameSettings frame, four bytes of length and code first).
    const variables = new Map();
    for (const packet of replay.packets) {
      if (packet.mode === REPLAY_PACKET_MODE.REAL && variables.size > 0) break;
      if (packet.code === 'sv') decodeSetVars(packet.payload, variables);
    }
    tree.variables = variables.size > 0 ? variables : null;
    const settings = replay.worldSettings.subarray(4);
    if (settings.length >= 30) tree.gameSettings = decodeGameSettings(settings);
    if (tree.gameSettings) tree.worldSize = tree.gameSettings.worldSize;
    await writeImportedWorld({
      source: `replay ${name}.rec, recorded by ${replay.callsign || 'unknown'}`
        + ` on bzfs ${replay.appVersion || 'unknown'}`,
      version: replay.protocol,
      worldHash: replay.worldHash || '',
    }, tree, safeMapName);
    const entry = MAP_REGISTRY.get(safeMapName);
    if (entry) entry.keptAt = Date.now();
    return { safeMapName };
  })().finally(() => inFlightReplayImports.delete(safeMapName));
  inFlightReplayImports.set(safeMapName, promise);
  return promise;
}

// A recording's world file, as `importReplayWorld` names it.
function isReplayWorldFile(fileName) {
  return typeof fileName === 'string' && fileName.startsWith('import-replay-');
}

// The worlds being played to somebody now. Kept by both sweeps while a room
// plays them, and for `IMPORT_REUSE_MS` after its last viewer leaves.
function replayWorldsPlaying() {
  return new Set([...replayRooms.values()].map((room) => room.worldFile).filter(Boolean));
}

// A recording a little past upstream's own buffer default (`DefaultMaxBytes`,
// 16 MB), which is what a `/record save` of a full buffer comes to.
const REPLAY_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;

// `/replay list` and `/record list`: every recording here with its length,
// read the way `/list` reads them.
async function replayFileList() {
  return (await listReplays())
    .filter((entry) => entry.summary)
    .map((entry) => ({ name: entry.name, seconds: entry.summary.seconds }));
}

// One room per recording being watched, made by its first viewer and dropped
// when its last one leaves.
const replayRooms = new Map();
async function replayRoomFor(name) {
  const held = replayRooms.get(name);
  if (held) return held;
  const replay = await loadReplay(name);
  if (!replay) return null;
  // Another viewer may have made it while this one read the file.
  if (replayRooms.has(name)) return replayRooms.get(name);
  const room = new ReplayRoom({
    name,
    replay,
    listFiles: replayFileList,
    directory: 'replays/',
  });
  room.onEmpty = () => {
    if (replayRooms.get(name) === room) replayRooms.delete(name);
    const world = MAP_REGISTRY.get(room.worldFile);
    if (world) world.keptAt = Date.now();
    log(`[REPLAY] ${name}: last viewer left`);
  };
  replayRooms.set(name, room);
  return room;
}

// How long a world download may take. The interactive one is a person waiting
// on a page: too short and a league server's map can never be imported at all,
// too long and a failure looks like a hang. The background one is the world
// tracker (`server/bzfs-worlds.cjs`), where nothing is waiting and the only
// cost of patience is a slot in a queue that runs all day -- the maps that
// time out are exactly the big ones most worth having a picture of.
//
// The background figure is deliberately far past what any world should need,
// because the two failure modes are not symmetric. Waiting costs one slot in
// a queue with all day to spend. Giving up costs a six-hour cooldown that
// then *doubles* per consecutive failure up to a week
// (`failureCooldown`), so a server whose world is merely slow gets treated
// like one that is broken, and its row keeps the blank thumbnail that made
// it worth fetching in the first place. `bmbz.ducatileague.org:5187` is the
// shape of the problem: 158KB of `.bzw` and a definition of 9,176 faces.
const IMPORT_WORLD_TIMEOUT_MS = 3 * 60 * 1000;
const IMPORT_WORLD_BACKGROUND_TIMEOUT_MS = 10 * 60 * 1000;

// What the import's visitor says it is: this server's own /list page, where
// what it learned about the target is shown.
function serverCheckMotto() {
  return PUBLIC_URL ? `bzo server check -- ${PUBLIC_URL.replace(/\/+$/, '')}/list` : undefined;
}

async function performRemoteMapImport(host, port, timeout, guest = null) {
  let publicServers;
  try {
    publicServers = await getRemoteServerList();
  } catch (error) {
    publicServers = remoteServerListCache.servers;
    if (publicServers.length === 0) throw error;
  }
  const listedServer = findPublicServer(publicServers, host, port);
  if (!listedServer) {
    const cached = reuseCachedImport(host, port);
    if (cached) return cached;
    throw new Error('server is not in the public BZFlag server list');
  }

  const safeMapName = remoteMapFileName(listedServer.host, listedServer.port);
  const existing = inFlightRemoteImports.get(safeMapName);
  if (existing) return existing;
  const promise = performRemoteMapImportNow(listedServer, safeMapName, timeout, guest)
    .finally(() => inFlightRemoteImports.delete(safeMapName));
  inFlightRemoteImports.set(safeMapName, promise);
  return promise;
}

// `dialHost`/`dialPort` are where the world is fetched from; `host`/`port` are
// who it is *from*, which is what the file is named after and what the bzw
// header records. They are the same address for an import off the public list,
// and different for a proxied target, where the name a player sees is public
// and the address bzo reaches it on is private (`docs/proxy.md`).
async function performRemoteMapImportNow(listedServer, safeMapName, timeout, guestQuestions = null) {
  const { host, port, dialHost = host, dialPort = port } = listedServer;
  const { worldDatabase, gameSettings, queryGame, variables, worldHash, guest, serverVersion } =
    await fetchWorldFromServer(dialHost, dialPort, timeout || IMPORT_WORLD_TIMEOUT_MS,
      { guest: guestQuestions, motto: serverCheckMotto() });
  const tree = parseWorldDatabase(worldDatabase);
  // Whatever caused this import -- the tracker's own schedule, an operator, or
  // somebody following a `?viewmap=` link -- the world tracker learns the hash
  // and the sizes it just paid for, so its next check is a dial rather than
  // this download over again. After the parse, since the two sizes are the
  // world header's own and that is what reads them.
  bzfsWorlds.noteImport(host, port, worldHash, {
    byteLength: worldDatabase.length,
    compressedSize: tree.compressedSize,
    uncompressedSize: tree.uncompressedSize,
  }, variables ? collectNonDefaultVariables(variables) : null, guest, serverVersion);
  // The server's own world variables, for the `-set` lines in the exported
  // map. Null when the momentary observer join that carries them was refused
  // or timed out (see `fetchWorldFromServer`); the map imports either way.
  tree.variables = variables || null;
  if (gameSettings && gameSettings.length >= 30) tree.gameSettings = decodeGameSettings(gameSettings);
  if (queryGame && queryGame.length >= 44) tree.queryGame = decodeQueryGame(queryGame);
  if (tree.gameSettings) tree.worldSize = tree.gameSettings.worldSize;
  // Neither the title, the owner nor the per-team maximums travel over the
  // direct connection above -- all are the list server's own words about this
  // host:port (`fetchServerList`), carried in on the very record
  // `performRemoteMapImport` matched this target against. Read off that
  // record rather than looked up again here: the fetch above can take up to
  // 15 seconds, and the shared list cache can have expired and been
  // refreshed without this server on it by the time it returns.
  await writeImportedWorld({
    host,
    port,
    title: listedServer.title || '',
    owner: listedServer.owner || '',
    ip: listedServer.ip || '',
    version: BZFS_PROTOCOL_VERSION,
    worldHash: worldHash || '',
    listInfo: listedServer.info || null,
  }, tree, safeMapName);
  // `compressedSize`/`uncompressedSize` are bzfs's own figures out of the
  // world header, not bzo's measurement of the transfer -- the numbers
  // another client would see for the same world.
  return {
    safeMapName,
    byteLength: worldDatabase.length,
    compressedSize: tree.compressedSize,
    uncompressedSize: tree.uncompressedSize,
  };
}

// A parsed bzfs world, written out as a `.bzw` under `safeMapName` and
// registered, as every import of one is: off a server's wire or out of a
// recording (`importReplayWorld`).
async function writeImportedWorld(serverMeta, tree, safeMapName) {
  const text = buildBZWText(serverMeta, tree, new Date().toISOString());
  const filePath = path.join(RUNTIME_MAPS_DIR, safeMapName);
  await fs.promises.writeFile(filePath, text);
  // Converted now rather than left to the background trickle
  // (`hashRemainingMapsInBackground`): this is the one file that just
  // changed, and somebody is waiting to look at it.
  let world = await convertMapFile(safeMapName, filePath, { quiet: false });
  if (world.warnedMessages.length > 0) {
    await fs.promises.appendFile(filePath, `\n${buildImportWarningOptionsBlock(world.warnedMessages)}`);
    // Quiet: this is the same file the first parse above just fully logged,
    // plus the options block this very function appended -- converting it
    // again is only to pick up that block's own `-srvmsg` lines, not a
    // second, real pass worth repeating every warning to server.log for.
    world = await convertMapFile(safeMapName, filePath);
  }
  registerWorldFile(safeMapName, world);
}

function ensureRuntimeMapsDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    logError(`Could not ensure runtime maps directory at ${dirPath}:`, error);
  }
}

// This server's own maps: every file in `maps/` but a remote import, unless
// that import is the map it is serving. An import is a transient copy of a
// BZFlag server's world, fetched to be viewed or to draw its picture and swept
// two hours later; the bzfs list is what shows it, under that server's hash,
// so it is neither parsed at boot nor listed as a local map.
function listLocalMapFiles() {
  return listAvailableMapFiles()
    .filter((fileName) => fileName === MAP_SOURCE
      || (!parseImportMapFileName(fileName) && !isReplayWorldFile(fileName)));
}

function listAvailableMapFiles() {
  const mapFiles = new Set();
  const mapDirs = [RUNTIME_MAPS_DIR, BUNDLED_MAPS_DIR];

  for (const dirPath of mapDirs) {
    try {
      if (!fs.existsSync(dirPath)) {
        continue;
      }
      for (const fileName of fs.readdirSync(dirPath)) {
        if (fileName.endsWith('.bzw')) {
          mapFiles.add(fileName);
        }
      }
    } catch (error) {
      logError(`Failed to read maps from ${dirPath}:`, error);
    }
  }

  return ['random', ...Array.from(mapFiles).sort((left, right) => left.localeCompare(right))];
}

function resolveMapFilePath(mapFile) {
  if (!mapFile || mapFile === 'random') {
    return '';
  }

  const safeFileName = path.basename(mapFile);
  if (safeFileName !== mapFile) {
    return '';
  }

  const runtimePath = path.join(RUNTIME_MAPS_DIR, safeFileName);
  if (fs.existsSync(runtimePath)) {
    return runtimePath;
  }

  const bundledPath = path.join(BUNDLED_MAPS_DIR, safeFileName);
  if (fs.existsSync(bundledPath)) {
    return bundledPath;
  }

  return '';
}

let serverConfig = {};
ensureServerConfig(configPath);
ensureRuntimeMapsDir(RUNTIME_MAPS_DIR);
try {
  serverConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  logError(`Could not load server config at ${configPath}:`, e);
}

// `title`: the one line that says what this server is -- the entry dialog,
// both lists, the Operator panel. bzfs's `-publictitle`. Older configs said it
// as `serverName`, or as `publicTitle` in the `bzflag` block, and kept a
// `description` beside it that nothing needs now.
function readServerTitle(config) {
  const moved = [];
  let title = typeof config.title === 'string' ? config.title.trim() : '';
  for (const [key, value] of [['bzflag.publicTitle', config.bzflag?.publicTitle], ['serverName', config.serverName]]) {
    if (typeof value !== 'string' || !value.trim()) continue;
    moved.push(key);
    if (!title) title = value.trim();
  }
  if (moved.length > 0) log(`Config: server.json ${moved.join(' and ')} read as "title"; rename to "title"`);
  if (typeof config.description === 'string' && config.description.trim()) {
    log('Config: server.json "description" is no longer used; "title" says what the server is');
  }
  return title;
}
serverConfig.title = readServerTitle(serverConfig);

// Where to answer, decided in one place because the two halves of an address
// are one decision. The environment wins over `server.json` for both, which is
// what lets a container be told by its orchestration what a server is otherwise
// told by its file, and each falls back to answering everywhere on 5154,
// BZFlag's IANA port.
//
// A loopback address is how an operator behind a reverse proxy keeps anyone
// from stepping around it to the port and reaching the uncertificated,
// uncompressed path; `::` is every interface in both families, which is what a
// container and a LAN game both need.
// Ready to answer, which listening is not: the boot's map pass
// (`hashRemainingMapsInBackground`) holds the event loop for seconds, and a
// list server that calls back in that window -- the BZFlag list's connect
// test, bzo's own challenge -- times out and counts it against the server.
// So nothing is announced to either list until the pass is done, or a
// minute has gone by.
let serverIsReady = false;
let markServerReady;
const serverReady = new Promise((resolve) => {
  markServerReady = () => {
    if (serverIsReady) return;
    serverIsReady = true;
    resolve();
  };
});
setTimeout(() => markServerReady(), 60 * 1000).unref?.();

const { host: LISTEN_HOST, port: PORT, note: listenNote } = resolveListenTarget({
  envListen: process.env.LISTEN,
  envPort: process.env.PORT,
  configListen: serverConfig.listen,
  configPort: serverConfig.port,
});

// `listen` is the one port, TCP and UDP, opened below with the BZFlag server
// rather than here (docs/port-mux-plan.md): the web app plain or over TLS,
// WebTransport and WebRTC, and BZFlag clients unless `"bzflag": false`.
const LISTEN_IS_BZFLAG = serverConfig.bzflag !== false;
const onHttpListening = () => {
  if (listenNote) log(`[LISTEN] ${listenNote}`);
  log(`Server running on ${describeListenTarget(LISTEN_HOST, PORT)}${LISTEN_IS_BZFLAG ? ' and BZFlag' : ''},`
    + ` client build ${CLIENT_BUILD}`);
  // After the port is open, never before it: the game is playable while the
  // sidecars are built, and a request that arrives first is served identity.
  //
  // `drain`, not `start`: the map trickle has not run yet, so the plan names
  // only the static assets. Sweeping now would take the whole map cache's
  // sidecars with it -- every cached world would lose its compressed copy on
  // every restart, and have to earn it back. The sweep belongs at the end of
  // the trickle, where the plan is complete, and that is where it happens.
  precompress.drain({ log }).then(({ compressed, raw, br, ms }) => {
    log(`[BR] ${compressed} asset sidecar(s) built, ${Math.round(raw / 1024)}KB -> `
      + `${Math.round(br / 1024)}KB in ${(ms / 1000).toFixed(1)}s`);
  }).catch((error) => logError(`[BR] ${error.message}`));
  // Only the designated instance keeps BZFlag worlds fresh, for the same
  // reason it is the only one that draws bzo rows' pictures: every instance
  // doing it would mean every instance dialling every listed server, which is
  // the multiplication the list server exists to avoid. A non-designated
  // instance still shows a picture for any world it has imported on demand.
  if (BZFS_WORLD_THUMBNAILS && IS_DESIGNATED_LIST_SERVER) {
    log('[WORLDS] keeping BZFlag world imports fresh for /list thumbnails');
    bzfsWorlds.start();
  }
  serverReady.then(announceReadyServer);
};

// One report for both lists once ready, after the proxied targets have been
// dialled so it carries their rows.
function announceReadyServer() {
  // The admin probe goes through the public URL and its proxy, as the list
  // server's own check of this instance does, so it waits for the same moment.
  probeAdminWhitelist().catch((error) => logError(`[ADMIN] probe failed: ${error.message}`));
  log('[LISTSERVER] ready; announcing');
  refreshProxyStatuses().finally(() => reportToListServer('boot'));
  if (IS_DESIGNATED_LIST_SERVER) {
    // Excludes this instance's own self-report row: reportToListServer just
    // above already refreshed it in-process, and validating it here would
    // be a real HTTP round trip to itself for something already current.
    const cutoff = Date.now() - LIST_SERVER_RECENT_CHECK_WINDOW_MS;
    const recent = listServerKeys.listAll().filter((record) => !PUBLIC_URLS.includes(record.url)
      && (record.lastChecked ?? record.dateRequested) >= cutoff);
    log(`[LISTSERVER] polling ${recent.length} recently-active key(s) immediately after restart`);
    for (const record of recent) {
      validateListServerKey(record)
        .catch((error) => logError(`[LISTSERVER] boot poll failed for ${record.url}: ${error.message}`));
    }
  }
}


// Whether this instance keeps the listed BZFlag servers' world imports fresh
// so their `/list` rows have pictures (`server/bzfs-worlds.cjs`). On by
// default, and only ever active on the designated list server. Off is for an
// operator who does not want this server making outbound connections to
// servers they have no relationship with -- the rows still get pictures for
// whatever has been imported on demand, just not ahead of being asked.
const BZFS_WORLD_THUMBNAILS = serverConfig.bzfsWorldThumbnails !== false;

// `adminGroups` in `server.json`: the global groups this server would grant
// admin to. The list server answers about no group it was not asked about, so
// this list is both the question and the whole permission model -- a member of
// a group missing from it is indistinguishable from a non-member.
//
// **It comes from the config and nowhere else.** A group list a client could
// name is a permission a client could name, so neither the URL nor the browser
// has a say: every login asks exactly these.
//
// A name is kept exactly as configured, case and spaces included. bzflag's own
// groups are capitals with dots -- `BZADMIN`, `PLANNING.DEVELOPERS` -- but
// phpBB's are ordinary words like `Registered users`, and which spelling the
// list server answers to is not documented, so nothing here normalises one into
// the other. Two characters are refused, because both would collide with the
// wire format: `\r` and `\n` are what separates the names in the request, and
// `:` is what separates them in the `TOKGOOD:` reply, so a name carrying either
// could not be asked about or read back. A space needs neither -- it is simply
// percent-encoded on the way out.
function isAskableGroup(group) {
  return group.length > 0 && !/[\r\n:]/.test(group);
}

// `localAdmin` in server.json. Whether a connection from this machine counts as
// an operator without a bzflag.org login, which is what lets a test client drive
// the Operator panel and the server commands. Off unless asked for -- see
// isLocalAdminRequest for why that default is not timidity.
const LOCAL_ADMIN = serverConfig.localAdmin === true;
const ADMIN_GROUPS = Object.freeze(
  (Array.isArray(serverConfig.adminGroups) ? serverConfig.adminGroups : [])
    .map((group) => (typeof group === 'string' ? group.trim() : ''))
    .filter(isAskableGroup)
    .filter((group, index, all) => all.indexOf(group) === index)
);
log(`Admin groups: ${ADMIN_GROUPS.map((group) => `"${group}"`).join(', ') || 'none configured'}`);
const refusedAdminGroups = (Array.isArray(serverConfig.adminGroups) ? serverConfig.adminGroups : [])
  .filter((group) => typeof group !== 'string' || !isAskableGroup(group.trim()));
if (refusedAdminGroups.length > 0) {
  log(`Admin groups refused (a group name may not contain a colon or a newline):`
    + ` ${refusedAdminGroups.map((group) => JSON.stringify(group)).join(', ')}`);
}

// Discord Linked Roles (server/discord.cjs, docs/chat-bridge-plan.md), when
// server.json has a `discord` block with the app's credentials. The links are
// kept beside bans.json; the same sign-in path and the same admin groups as
// /login decide who is who.
const DISCORD_LINKS_PATH = path.join(path.dirname(CONFIG_PATH), 'discord-links.json');
const discordLink = discordLinkConfigured(serverConfig.discord)
  ? createDiscordLink({
    config: serverConfig.discord,
    checkToken: async (callsign, token) => {
      const { status, body } = await checkGlobalToken(callsign, token, ADMIN_GROUPS);
      const parsed = parseGlobalTokenReply(body);
      log(`[DISCORD] CHECKTOKENS ${status} good=${parsed.good} bzid=${parsed.bzid || 'none'}`
        + ` callsign="${parsed.callsign || ''}" groups=${parsed.groups.join(',') || 'none'}`);
      return parsed;
    },
    isAdmin: (groups) => groupsGrantAdmin(groups, ADMIN_GROUPS),
    store: {
      load: () => (fs.existsSync(DISCORD_LINKS_PATH)
        ? JSON.parse(fs.readFileSync(DISCORD_LINKS_PATH, 'utf8')) : {}),
      save: (links) => fs.writeFileSync(DISCORD_LINKS_PATH, `${JSON.stringify(links, null, 2)}\n`, { mode: 0o600 }),
    },
    log,
    logError,
  })
  : null;
if (discordLink) {
  const withHost = (handler) => (req, res) => {
    const host = requestHost(req);
    if (!host) {
      res.status(400).type('text/plain').send('Malformed Host header');
      return;
    }
    handler(req, res, host);
  };
  app.get('/discord/link', loginRateLimit, withHost(discordLink.start));
  app.get('/discord/link/callback', loginRateLimit, withHost(discordLink.discordCallback));
  app.get('/discord/link/bzflag/:key', loginRateLimit, (req, res) => discordLink.bzflagCallback(req, res));
  log(`Discord: Linked Roles on, ${discordLink.size} linked`);
  discordLink.registerMetadata().catch((err) => logError('[DISCORD] role metadata failed', err));
}

// Public chat mirrored to a Discord channel (server/discord-bridge.cjs), when
// `discord.bridge.webhookUrl` names that channel's webhook. Fed from
// `deliverChatMessage`'s all-players branch and nowhere else.
const DISCORD_BRIDGE_WEBHOOK = serverConfig.discord?.bridge?.webhookUrl;
const chatMirror = typeof DISCORD_BRIDGE_WEBHOOK === 'string'
  && DISCORD_BRIDGE_WEBHOOK.startsWith('https://discord.com/api/webhooks/')
  ? createChatMirror({
    webhookUrl: DISCORD_BRIDGE_WEBHOOK,
    serverName: serverConfig.title || 'bzo',
    log,
    logError,
  })
  : null;
if (chatMirror) log('Discord: public chat mirrored to a channel');

// And the channel's own messages back into the game, through the bot's
// gateway connection (server/discord-gateway.cjs), when there is a bot token
// as well. The channel is the one the mirror's webhook posts to, asked of the
// webhook itself. The gateway session is kept beside bans.json so a restart
// resumes it.
const DISCORD_GATEWAY_PATH = path.join(path.dirname(CONFIG_PATH), 'discord-gateway.json');
if (chatMirror && typeof serverConfig.discord?.botToken === 'string' && serverConfig.discord.botToken) {
  fetch(DISCORD_BRIDGE_WEBHOOK, { signal: AbortSignal.timeout(10000) })
    .then((response) => response.json())
    .then((webhook) => {
      if (!webhook.channel_id) throw new Error('the bridge webhook named no channel');
      const onMessage = createDiscordToGame({
        channelId: webhook.channel_id,
        nameFor: (message) => {
          const linked = discordLink?.linkFor(message.author?.id);
          if (linked) return `${linked.admin ? '@' : '+'}${linked.callsign}`;
          return message.member?.nick || message.author?.global_name || message.author?.username;
        },
        // A server message, so a native BZFlag client shows it as one; the
        // `discord` part is for bzo's own, which puts it with the chat.
        announce: ({ name, line, text }) => {
          log(`[CHAT] ${text}`);
          broadcastAll({
            type: 'message', src: SERVER_PLAYER, dst: ALL_PLAYERS, msgType: 'server', text,
            discord: { name, text: line }, ts: Date.now(),
          });
        },
        log,
      });
      createGateway({
        token: serverConfig.discord.botToken,
        onDispatch: (type, data) => {
          if (type === 'MESSAGE_CREATE') onMessage(data);
        },
        store: {
          load: () => (fs.existsSync(DISCORD_GATEWAY_PATH)
            ? JSON.parse(fs.readFileSync(DISCORD_GATEWAY_PATH, 'utf8')) : null),
          save: (session) => fs.writeFileSync(DISCORD_GATEWAY_PATH, JSON.stringify(session), { mode: 0o600 }),
        },
        log,
        logError,
      }).start();
      log('Discord: channel messages relayed into the game');
    })
    .catch((err) => logError('[DISCORD] could not start the channel relay', err));
}

// The bzfs servers this instance may proxy, from `proxies` in `server.json`
// (`server/proxies.cjs`). The map is the allowlist: a target not named there
// cannot be proxied, linked to, or logged in to, which is what keeps `?proxy=`
// from being an invitation to dial anywhere -- the same reason
// `LOGIN_RETURN_PATHS` is one.
const {
  targets: PROXY_TARGETS,
  // The same targets under the spelling a URL carries -- `host_port`, since a
  // `:` comes back as `%3A` in an address bar and a link is made to be
  // shared. `host:port` stays the identity everywhere it is read by a person.
  byUrlKey: PROXY_TARGETS_BY_URL,
  refused: refusedProxies,
  warnings: proxyWarnings,
} = parseProxies(serverConfig.proxies);
for (const target of Object.values(PROXY_TARGETS)) {
  log(`Proxy: "${target.key}" reached at ${target.host}:${target.port}`
    + `, linked as ?proxy=${target.urlKey}${target.originKey ? ', with an originKey' : ''}`);
}
for (const { key, reason } of proxyWarnings) {
  log(`Proxy: "${key}" -- ${reason}`);
}
for (const { key, reason } of refusedProxies) {
  logError(`Proxy: "${key}" refused -- ${reason}`);
}
if (Object.keys(PROXY_TARGETS).length === 0) log('Proxy: no servers configured');

// `adminWhitelist` in server.json: addresses beyond loopback that `localAdmin`
// should also cover, e.g. an operator's home network. Entries are addresses or
// CIDR blocks, IPv4 or IPv6; validated and logged the same way ADMIN_GROUPS is.
const { entries: ADMIN_WHITELIST, refused: refusedAdminWhitelist } =
  parseAdminWhitelist(serverConfig.adminWhitelist);
if (refusedAdminWhitelist.length > 0) {
  log(`Admin whitelist entries refused (not an address or CIDR block):`
    + ` ${refusedAdminWhitelist.map((entry) => JSON.stringify(entry)).join(', ')}`);
}
// The whitelist only widens `localAdmin`, so with that off it does nothing at
// all -- and nothing else would say so. Loopback entries are left out of the
// test: the example config lists them, and they are what `localAdmin` covers
// anyway.
const nonLoopbackWhitelist = (Array.isArray(serverConfig.adminWhitelist) ? serverConfig.adminWhitelist : [])
  .filter((entry) => typeof entry === 'string' && !isLoopbackAddress(entry.split('/')[0].trim()));
if (!LOCAL_ADMIN && nonLoopbackWhitelist.length > 0) {
  log(`Admin whitelist ignored: "localAdmin" is off in server.json, so`
    + ` ${nonLoopbackWhitelist.join(', ')} get no admin. Set "localAdmin": true to use it.`);
}

// `publicUrl` in server.json: this server's own externally-reachable address,
// e.g. `https://bz.rikers.org`, or a list of them. The first is the one the
// startup probe below calls and every link names; the designated list server
// lists each (`reportToListServer`).
const PUBLIC_URLS = (Array.isArray(serverConfig.publicUrl) ? serverConfig.publicUrl : [serverConfig.publicUrl])
  .filter((url) => typeof url === 'string' && url.trim() !== '').map((url) => url.trim());
const PUBLIC_URL = PUBLIC_URLS[0] || '';

// Whether a forwarded address can be trusted for `isLocalAdminRequest`, and
// how to read one if so. Stays 'distrust' -- unproxied loopback only -- until
// `probeAdminWhitelist` below proves otherwise; see isLocalAdminRequest for
// what each value means.
let forwardedForPolicy = 'distrust';
// The proxy's own address, as the probe's requests arrived from it: the one
// peer whose forwarding headers are read (`isLocalAdminRequest`).
let forwardedProxyPeer = null;

// issue #80: is whatever reverse proxy sits in front of this server (if any)
// safe to trust X-Forwarded-For through, and if so, does it overwrite the
// header on each hop or append to it? Answered empirically rather than
// assumed, by calling this server on its own PUBLIC_URL -- through real DNS
// and whatever proxy that resolves to, the same path an actual client takes --
// once plain and once with a poisoned X-Forwarded-For already attached.
//
// A trustworthy proxy never lets that poisoned value survive as the last
// entry: either it replaces the header outright (one value left, matching
// what the plain call saw), or it appends its own real contribution after it
// (multiple values, the last matching the plain call). If the poisoned value
// is still last, or the plain call's own contribution cannot be found there,
// the proxy cannot be trusted to say who a client really is, and the
// whitelist stays limited to unproxied loopback -- the one case that needs no
// proxy trust at all, because a remote client cannot manufacture it.
const ADMIN_PROBE_SENTINEL = '203.0.113.66'; // RFC 5737 TEST-NET-3: never a real peer.
// A live game loop shares this same process and thread, so the probe below can
// lose a race it would win on an idle box: an 8-second timeout is plenty of
// slack for two round trips through a healthy proxy, but not for one that lands
// while the loop is busy with real players (moving tanks, shots, precompress's
// own brotli pass on a cold cache -- both run at the same moment this does,
// right after `server.listen`'s callback fires). A single attempt made the
// whole server's lifetime hostage to whichever instant it happened to fire in:
// one unlucky window and `forwardedForPolicy` stayed 'distrust' -- silently
// refusing every proxied admin, whitelisted or not -- until the next restart,
// with nothing to explain why "it worked before". Retrying a few times with a
// real gap between attempts gives it several different instants to land in
// instead of one.
const ADMIN_PROBE_ATTEMPTS = 4;
const ADMIN_PROBE_RETRY_DELAY_MS = 5000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
function normalizeAddress(address) {
  return String(address || '').trim().replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '').toLowerCase();
}

// Every address this server answers as: its interfaces', the ones its public
// URL's name resolves to, and the public ones ip4.me and ip6.me see its
// traffic leave by -- a home network or a cloud's NAT, where a request to its
// own public URL comes back from the router. A CDN's edge names its own
// egress address, which is never the one its DNS publishes. A lookup that
// fails leaves the rest.
async function ownAddresses() {
  const own = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) own.add(normalizeAddress(entry.address));
  }
  try {
    const records = await require('dns').promises.lookup(new URL(PUBLIC_URL).hostname, { all: true });
    for (const record of records) own.add(normalizeAddress(record.address));
  } catch {
    // The others stand alone.
  }
  await Promise.all(['https://ip4.me/api/', 'https://ip6.me/api/'].map(async (url) => {
    try {
      // Uncompressed: some hosts' Node fails ip4.me's gzip with Z_BUF_ERROR.
      const response = await fetch(url, {
        headers: { 'User-Agent': BZO_USER_AGENT, 'Accept-Encoding': 'identity' },
        signal: AbortSignal.timeout(5000),
      });
      // "IPv4,203.0.113.7,v1.1,,,..." -- the second field.
      const address = (await response.text()).split(',')[1];
      if (address) own.add(normalizeAddress(address));
    } catch (error) {
      log(`[ADMIN] ${url} lookup failed (${error.cause?.code || error.message})`);
    }
  }));
  return own;
}

async function probeAdminWhitelist() {
  if (!LOCAL_ADMIN || !PUBLIC_URL) return;
  const probeUrl = `${PUBLIC_URL.replace(/\/+$/, '')}/api/_admin-probe`;
  const fetchProbe = async (forwardedFor) => {
    const response = await fetch(probeUrl, {
      headers: {
        'User-Agent': BZO_USER_AGENT,
        ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const splitChain = (value) => (typeof value === 'string' ? value : '')
    .split(',').map((part) => part.trim()).filter(Boolean);
  for (let attempt = 1; attempt <= ADMIN_PROBE_ATTEMPTS; attempt += 1) {
    try {
      const plain = await fetchProbe(null);
      const poisoned = await fetchProbe(ADMIN_PROBE_SENTINEL);
      const plainChain = splitChain(plain.xForwardedFor);
      const poisonedChain = splitChain(poisoned.xForwardedFor);
      const expected = plainChain[plainChain.length - 1] ?? null;
      const last = poisonedChain[poisonedChain.length - 1] ?? null;
      if (last === null || last === ADMIN_PROBE_SENTINEL || expected === null || last !== expected) {
        log(`[ADMIN] ${PUBLIC_URL} does not confirm its proxy replaces X-Forwarded-For`
          + ` (plain ${plain.xForwardedFor ?? 'none'}, forged ${poisoned.xForwardedFor ?? 'none'});`
          + ' admin whitelist stays limited to unproxied loopback');
        return;
      }
      // The probe's own request came from this server, so the proxy's entry
      // has to name it: one of this machine's addresses, or the public one
      // its traffic leaves by. A proxy in front of the proxy -- a CDN -- names
      // itself instead, the same on every request, and would hand every
      // player its address. docs/ban-plan.md.
      const own = await ownAddresses();
      if (!own.has(normalizeAddress(expected))) {
        log(`[ADMIN] ${PUBLIC_URL}'s proxy names ${expected} for this server's own request, which is`
          + ` not this server (${[...own].join(', ')}): another proxy is in front of it;`
          + ' admin whitelist stays limited to unproxied loopback');
        return;
      }
      if (!plain.remoteAddress || normalizeAddress(plain.remoteAddress) !== normalizeAddress(poisoned.remoteAddress)) {
        log(`[ADMIN] ${PUBLIC_URL}'s proxy reached this server from ${plain.remoteAddress} and then`
          + ` ${poisoned.remoteAddress}; admin whitelist stays limited to unproxied loopback`);
        return;
      }
      forwardedProxyPeer = normalizeAddress(plain.remoteAddress);
      forwardedForPolicy = poisonedChain.length === 1 ? 'trust-first' : 'trust-last';
      log(`[ADMIN] ${PUBLIC_URL}'s proxy at ${forwardedProxyPeer}`
        + ` ${forwardedForPolicy === 'trust-first' ? 'overwrites' : 'appends to'} X-Forwarded-For safely;`
        + ' admin whitelist active for loopback'
        + (ADMIN_WHITELIST.length > 0 ? ` and ${ADMIN_WHITELIST.length} whitelisted address(es)` : ''));
      return;
    } catch (error) {
      if (attempt === ADMIN_PROBE_ATTEMPTS) {
        log(`[ADMIN] Could not verify ${PUBLIC_URL}'s proxy handling of X-Forwarded-For after`
          + ` ${ADMIN_PROBE_ATTEMPTS} attempts (${error.message}); admin whitelist stays limited`
          + ' to unproxied loopback');
        return;
      }
      await sleep(ADMIN_PROBE_RETRY_DELAY_MS);
    }
  }
}

// Sessions from the global login. Held in a Map like every other piece of bzo's
// state, and written to one file beside the runtime maps so a restart does not
// log everybody out: this server restarts on every edit, a bzflag.org token is
// single use, and each re-login is a full round trip through my.bzflag.org.
//
// Debounced, because a login is rare but a prune is not, and neither is worth a
// synchronous write on the game loop's thread.
// Beside the config rather than in the maps directory: this is operator state
// like `server.json`, it follows `SERVER_CONFIG_PATH` into a deployment's own
// data directory, and the maps directory is a tracked part of the repo.
const SESSIONS_PATH = path.join(path.dirname(configPath), 'sessions.json');
// What the Operator panel uploaded, and so may delete (`server/uploads.cjs`).
const uploads = createUploadRecord(path.join(path.dirname(configPath), 'uploads.json'), { log });
let sessionWriteTimer = null;

function writeSessionsSoon() {
  if (sessionWriteTimer) return;
  sessionWriteTimer = setTimeout(() => {
    sessionWriteTimer = null;
    try {
      // Pretty-printed, the same reason list-server-keys.json is: an
      // operator reasonably opens this file by hand, and it stays small.
      fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions.serialize(), null, 2) + '\n', { mode: 0o600 });
    } catch (error) {
      logError(`Could not write sessions to ${SESSIONS_PATH}:`, error);
    }
  }, 1000);
  // Nothing waits on this file, so it must never hold the process open.
  sessionWriteTimer.unref?.();
}

const sessions = createSessionStore({ onChange: writeSessionsSoon });
try {
  if (fs.existsSync(SESSIONS_PATH)) {
    const loaded = sessions.load(JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')));
    log(`Sessions: restored ${loaded} of ${SESSION_TTL_MS / 3600000}h`);
  }
} catch (error) {
  // A session file that cannot be read is everybody logging in again, which is
  // a minor cost and the only safe reading of a file we cannot parse.
  logError(`Could not read sessions from ${SESSIONS_PATH}, starting empty:`, error);
}
// Expiry is only noticed on a read otherwise, and an expired session sitting in
// the file is an identity kept longer than it was granted for.
setInterval(() => sessions.prune(), 15 * 60 * 1000).unref?.();

// bzo's own list server (docs/list-server-plan.md, issue #46). `listServerUrl`
// names which instance is designated; unset defaults to bz.rikers.org, the
// same way bzfs itself defaults `-list` to my.bzflag.org rather than shipping
// with nothing to report to. An operator who wants the feature off entirely
// sets it to an empty string -- that is a choice, not the default.
const DEFAULT_LIST_SERVER_URL = 'https://bz.rikers.org';
const LIST_SERVER_URL = (typeof serverConfig.listServerUrl === 'string'
  ? serverConfig.listServerUrl
  : DEFAULT_LIST_SERVER_URL).trim().replace(/\/+$/, '');
// This server's own credential on the designated instance, pasted into the
// Operator panel (`listServerKey`) from the account the operator generated it
// under. Never sent to a client -- see `getOperatorConfigState`, which
// deliberately does not read this.
let LIST_SERVER_KEY = typeof serverConfig.listServerKey === 'string' ? serverConfig.listServerKey.trim() : '';

// Who the designated instance's own self-report row (see `reportToListServer`)
// is attributed to on the admin key table's Owner column. Unset defaults to
// the reserved "self" bzid and this server's own name -- a placeholder, not
// a real forum account, so it renders as plain text rather than a broken
// profile link. An operator who is also a registered bzflag.org user can name
// their own BZID here so their own server's row reads the same as everyone
// else's.
const LIST_SERVER_OWNER_BZID =
  typeof serverConfig.listServerOwnerBzid === 'string' ? serverConfig.listServerOwnerBzid.trim() : '';
const LIST_SERVER_OWNER_CALLSIGN =
  typeof serverConfig.listServerOwnerCallsign === 'string' ? serverConfig.listServerOwnerCallsign.trim() : '';

// A restart of the designated instance loses every row's `live` state at
// once (it is never persisted, see the key store) -- normally repaired
// gradually as each reporting instance's own boot/~15-minute/join-part
// cadence catches up. On a designated instance that itself restarts often
// (a dev box, mid-iteration), that means every registered server blinking
// off `/list` on every restart, not just once. Polling anything checked
// this recently, immediately on boot, is what makes that a few seconds
// instead of however long the slowest registered server's own cadence
// takes -- see "Speeding up a restart" in docs/list-server.md.
const LIST_SERVER_RECENT_CHECK_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

// Whether *this* instance is the one every other bzo server reports to.
// Decided by comparing its own advertised addresses, any of them, to the list
// server it is configured to report to -- `publicUrl`, which the
// admin-whitelist probe already uses -- rather than a second flag that could
// disagree with it.
const IS_DESIGNATED_LIST_SERVER = LIST_SERVER_URL !== ''
  && PUBLIC_URLS.some((url) => LIST_SERVER_URL === url.replace(/\/+$/, ''));

// The designated instance's key registry. Persisted beside sessions.json for
// the same reason: a restart should not silently revoke every operator's
// registration. Non-designated instances still create the (empty, unused)
// store -- simpler than threading its absence through every handler below --
// but never populate or read it.
const LIST_SERVER_KEYS_PATH = path.join(path.dirname(configPath), 'list-server-keys.json');
let listServerKeysWriteTimer = null;
function writeListServerKeysSoon() {
  if (listServerKeysWriteTimer) return;
  listServerKeysWriteTimer = setTimeout(() => {
    listServerKeysWriteTimer = null;
    try {
      // Pretty-printed, unlike sessions.json: an operator reasonably opens
      // this file by hand to check a registration, and it's small enough
      // that the extra bytes cost nothing.
      fs.writeFileSync(
        LIST_SERVER_KEYS_PATH, JSON.stringify(listServerKeys.serialize(), null, 2) + '\n', { mode: 0o600 });
    } catch (error) {
      logError(`Could not write list server keys to ${LIST_SERVER_KEYS_PATH}:`, error);
    }
  }, 1000);
  listServerKeysWriteTimer.unref?.();
}
const listServerKeys = createListServerKeyStore({ onChange: writeListServerKeysSoon });
if (IS_DESIGNATED_LIST_SERVER) {
  try {
    if (fs.existsSync(LIST_SERVER_KEYS_PATH)) {
      const loaded = listServerKeys.load(JSON.parse(fs.readFileSync(LIST_SERVER_KEYS_PATH, 'utf8')));
      log(`[LISTSERVER] restored ${loaded} registered key(s)`);
    }
  } catch (error) {
    logError(`Could not read list server keys from ${LIST_SERVER_KEYS_PATH}, starting empty:`, error);
  }
  log(`[LISTSERVER] this instance is the designated bzo list server (${PUBLIC_URLS.join(', ')})`);
} else if (LIST_SERVER_URL) {
  log(`[LISTSERVER] reporting to ${LIST_SERVER_URL}`
    + (LIST_SERVER_KEY ? '' : ' (no listServerKey configured yet -- reports will not be sent)'));
} else {
  log('[LISTSERVER] disabled (listServerUrl is empty)');
}

// Same ceiling as `/login` -- see "Abuse resistance" in docs/list-server-plan.md.
// Both are new places an anonymous or logged-in caller can make the list
// server do outbound work (the validation callback below), so both carry the
// same limit from day one rather than after something abuses it.
const listServerRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: requestAddress,
  validate: { xForwardedForHeader: false },
  handler: (req, res, _next, options) => {
    log(`[LISTSERVER] rate limited ${requestAddress(req)}:`
      + ` more than ${options.limit} requests in ${options.windowMs / 1000}s`);
    res.status(options.statusCode).type('text/plain')
      .send('Too many requests. Try again in a minute.\n');
  },
});

// The account UI and the registry endpoints below only exist on the
// designated instance -- see "`/list`" in docs/list-server-plan.md: a
// non-designated instance links out rather than duplicating either.
function requireDesignatedListServer(req, res) {
  if (IS_DESIGNATED_LIST_SERVER) return true;
  res.status(404).type('text/plain').send('This instance is not the designated bzo list server.\n');
  return false;
}

// The bzflag.org session a browser already holds from `/login`, read the same
// way `/logout` does -- there is no separate account system here, see
// "Accounts: reuse the existing login".
function sessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  return sessionId ? sessions.get(sessionId) : undefined;
}

// An operator reaching this instance from an address `adminWhitelist` covers
// (`localAdmin`, `docs/list-server.md`), which is the same test the WebSocket
// join already makes for a player. It stands in for a bzflag.org login when
// *reading* or *revoking* a key: those are the operator's own housekeeping on
// a server they demonstrably run. Creating one still needs a login, because a
// key is attributed to a BZID and an address is not one.
function isLocalAdminHttp(req) {
  return isLocalAdminRequest(req.socket.remoteAddress, req.headers, {
    enabled: LOCAL_ADMIN,
    whitelist: ADMIN_WHITELIST,
    forwardedForPolicy,
    proxyPeer: forwardedProxyPeer,
  });
}

// What `GET /api/list-server/keys` hands back. The key rides in full --
// `/api/list-server/keys` only ever returns a caller's own rows (`listForBzid`)
// or, for an admin, every row (`listAll`), and either caller is exactly who
// is allowed to hold that credential already: an owner pasting it into their
// own server's Operator panel, or a local admin who can already revoke any
// row here. Masking it from the one place that could otherwise copy it back
// out would just be security theatre.
function describeListServerKeyRow(record) {
  const stale = isListServerKeyStale(record);
  return {
    id: record.id,
    key: record.key,
    url: record.url,
    callsign: record.callsign,
    bzid: record.bzid,
    dateRequested: record.dateRequested,
    lastChecked: record.lastChecked,
    stale,
    // A stale row says why, the same way /list already reports "could not
    // reach the list server" rather than going silent.
    lastError: stale ? record.lastError : null,
    live: record.live ? { ...record.live } : null,
    expiresAt: (record.lastChecked ?? record.dateRequested) + LIST_SERVER_KEY_MAX_AGE_MS,
  };
}

// The list server never trusts a URL an ADD payload itself supplies -- it
// calls back the URL already on file for that key, with a nonce the target
// has to sign with the key it has configured. See "Validation" in the plan.
// Untrusted input either way -- a POST body from a reporting instance, or a
// challenge response from one being validated -- so both paths funnel
// through the same field-by-field parse rather than trusting either shape.
// A whole-number count, floored at zero and capped, from a number an
// untrusted instance sent. Used for every readout-pane field below: none of
// them is worth trusting and none of them is worth rejecting a report over.
function boundedReportCount(value, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.floor(number), max);
}

// Six per-team numbers in `-mp` order, or nothing at all -- an instance too
// old to report them shows no per-team lines rather than six zeroes, which
// would read as "no teams offered".
function boundedTeamArray(value) {
  if (!Array.isArray(value) || value.length !== 6) return null;
  return value.map((entry) => boundedReportCount(entry, 255));
}

const MAX_REPORTED_URLS = 4;
// A reported URL, as long as any URL an instance has; and the same URL
// without the slashes it may end with, counted off rather than matched.
const MAX_REPORTED_URL_LENGTH = 200;
function withoutTrailingSlashes(text) {
  let end = text.length;
  while (end > 0 && text[end - 1] === '/') end -= 1;
  return text.slice(0, end);
}

function sanitizeListServerStatus(body) {
  const players = Number(body?.players);
  const maxPlayers = Number(body?.maxPlayers);
  const gameOptionsBits = Number(body?.gameOptionsBits);
  const maxShots = Number(body?.maxShots);
  return {
    title: typeof body?.title === 'string' ? body.title.slice(0, 120) : '',
    description: typeof body?.description === 'string' ? body.description.slice(0, 500) : '',
    players: Number.isFinite(players) ? players : 0,
    maxPlayers: Number.isFinite(maxPlayers) ? maxPlayers : 0,
    // Only a bzo instance reports, and one before 1.3.5 sent its release bare,
    // so the prefix that tells bzo from bzfs on `/list` is added where missing.
    version: typeof body?.version === 'string' && body.version.trim()
      ? (/^bzo-/.test(body.version) ? body.version : `bzo-${body.version}`).slice(0, 40)
      : '',
    gameOptionsBits: Number.isFinite(gameOptionsBits) ? gameOptionsBits : 0,
    maxShots: Number.isFinite(maxShots) ? maxShots : 0,
    style: typeof body?.style === 'string' ? body.style.slice(0, 20) : '',
    // Which world the reporting instance is running, and which servers it
    // proxies. Both are read straight off `live` by `listPublicListServerRows`,
    // so a field dropped here is a field that instance can never show: this is
    // the only thing that writes `live` for a server reporting over HTTP.
    map: typeof body?.map === 'string' ? body.map.slice(0, 120) : '',
    // Exactly the shape `registerMapFile` produces, because it becomes a file
    // name here. Anything else is dropped rather than cleaned: a hash that
    // needed cleaning is not a hash.
    mapHash: /^[0-9a-f]{12}$/.test(body?.mapHash) ? body.mapHash : '',
    // Three byte counts an instance reports about its own world. Bounded and
    // coerced rather than trusted -- this is the edge an untrusted instance
    // reports at, and a size is only ever a display figure, so anything that
    // is not a sane number becomes zero rather than rejecting the report.
    world: sanitizeReportedWorld(body?.world),
    // Bounded here rather than trusted, since this is the edge an untrusted
    // instance reports at; `listPublicListServerRows` shapes each row again on
    // the way out, where it also drops the targets that were unreachable.
    proxies: Array.isArray(body?.proxies) ? body.proxies.slice(0, MAX_REPORTED_PROXIES) : [],
    voiceEnabled: body?.voiceEnabled === true,
    // Claimed, not trusted: `verifyListServerAlternates` calls each one back
    // before a row shows it.
    // Length first: a pattern run over a long run of slashes takes time in the
    // square of its length, and a report's body may be 100 KB.
    urls: Array.isArray(body?.urls)
      ? body.urls.filter((url) => typeof url === 'string' && url.length <= MAX_REPORTED_URL_LENGTH)
        .map(withoutTrailingSlashes)
        .filter((url) => /^https?:\/\/[^\s/]+$/.test(url))
        .slice(0, MAX_REPORTED_URLS)
      : [],
    ...sanitizeListServerReadout(body),
  };
}

// The readout-pane fields (`renderListReadout`), which a proxied target
// reports in exactly the same shape as the instance carrying it -- so both
// the top level above and each `proxies` entry below pass through this.
// Ceilings are the wire's own: every one of these is a `uint16` in the ping
// packet a bzfs row arrives as, and the two team arrays are `uint8` apiece.
// A reported world's three sizes. A byte count no larger than a terabyte,
// which is far past any real world and still short of anything that could
// make a row misrender.
const MAX_REPORTED_WORLD_BYTES = 1e12;
function sanitizeReportedWorld(world) {
  if (!world || typeof world !== 'object') return null;
  const size = (value) => (Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), MAX_REPORTED_WORLD_BYTES) : 0);
  const hash = /^[0-9a-f]{12}$/.test(world.hash) ? world.hash : '';
  const bzw = size(world.bzw);
  const json = size(world.json);
  const brotli = size(world.brotli);
  if (!hash && !bzw && !json && !brotli) return null;
  return {
    hash, bzw, json, brotli,
  };
}

function sanitizeListServerReadout(source) {
  return {
    bots: boundedReportCount(source?.bots, 255),
    disableBots: source?.disableBots === true,
    teamCounts: boundedTeamArray(source?.teamCounts),
    teamMaximums: boundedTeamArray(source?.teamMaximums),
    shakeTimeout: boundedReportCount(source?.shakeTimeout, 65535),
    shakeWins: boundedReportCount(source?.shakeWins, 65535),
    maxTime: boundedReportCount(source?.maxTime, 65535),
    maxTeamScore: boundedReportCount(source?.maxTeamScore, 65535),
    maxPlayerScore: boundedReportCount(source?.maxPlayerScore, 65535),
  };
}

// How much world JSON this instance will pull from another to draw its
// picture, and how long it will wait. The largest map bzo has locally is 74 MB
// of JSON (7.5 MB of `.bzw`, 81332 mesh faces), so the ceiling has to clear
// that or the maps most worth looking at are the ones with no picture. Past
// either limit there is simply no overview, which is the same state a row has
// before its first fetch.
//
// The timeout is generous because the transfer may not be compressed: brotli
// takes that map to about 14 MB, but a sidecar is built in the background on
// the far side and "a missing sidecar is not an error"
// (`server/precompress.cjs`), so a first fetch can get all 74 MB. Nothing
// waits on this -- it is fire-and-forget, once per world hash -- so a long
// ceiling costs nothing and a short one would just mean no picture.
const OVERVIEW_WORLD_MAX_BYTES = 96 * 1024 * 1024;
const OVERVIEW_FETCH_TIMEOUT_MS = 120000;

// One fetch per hash at a time. A boot-time poll validates every recently
// active key at once, and several instances running the same world would
// otherwise each start their own download of it.
const inFlightOverviews = new Map();

function overviewPathForHash(hash) {
  return path.join(OVERVIEW_CACHE_DIR, `${hash}.svg`);
}

// The public URL of a drawn overview, for `listPublicListServerRows` to hand
// to every instance's `/list`. `LIST_SERVER_URL` rather than this instance's
// own `publicUrl`: they are the same string on the designated instance (that
// is what `IS_DESIGNATED_LIST_SERVER` means), and naming the one every reader
// was already configured with keeps the row's URL and the row's origin the
// same thing.
// The absolute URL of a BZFlag server's picture, for a row this server is
// publishing to other instances. Only the one named by the world's BZFlag
// hash, which is a name any reader can find that world by again; an import's
// own picture is named by bzo's hash of a file that is gone in two hours.
// `LIST_SERVER_URL` for the same reason `instanceOverviewUrl` uses it: on the
// designated instance it is this server's own public URL, and it is the
// string every reader already holds.
function bzfsInstanceOverviewUrl(host, port) {
  const worldHash = bzfsWorlds.recordFor(host, port)?.worldHash;
  return bzfsOverviewPath(host, port, worldHash)
    ? `${LIST_SERVER_URL}/overviews/bzfs-${worldHash}.svg`
    : null;
}

function instanceOverviewUrl(hash) {
  if (!/^[0-9a-f]{12}$/.test(hash || '')) return null;
  // The designated instance's own world is here too: `registerMapFile` draws
  // every local map's picture into the same directory under the same hash.
  return fs.existsSync(overviewPathForHash(hash))
    ? `${LIST_SERVER_URL}/overviews/${hash}.svg`
    : null;
}

// Draws the overview for one reporting instance's world, once. The world comes
// from that instance's own `/maps/<hash>.json` -- public, immutable and
// already brotli-compressed by `server/precompress.cjs`, so this needs no new
// endpoint on the far side and costs it a cached file read.
//
// The hash is **rechecked here** rather than taken on trust: it is a SHA-256
// of the exact bytes `/maps/` serves (`registerMapFile`), so hashing what
// arrives and comparing proves the JSON is the world the report named. Without
// that, an instance could have its own picture filed under another instance's
// hash. It is why the report carries a hash and not a URL.
async function ensureInstanceOverview(instanceUrl, hash) {
  if (!/^[0-9a-f]{12}$/.test(hash || '')) return;
  const filePath = overviewPathForHash(hash);
  // A world this server holds as a local map already has its picture here,
  // which is also what catches another instance playing the same map as this
  // one: the hash is the same wherever the same build parses the same world.
  if (fs.existsSync(filePath)) return;
  if (inFlightOverviews.has(hash)) return inFlightOverviews.get(hash);

  const work = (async () => {
    const worldUrl = new URL(`maps/${hash}.json`, `${instanceUrl}/`).toString();
    const response = await fetch(worldUrl, {
      headers: { 'User-Agent': BZO_USER_AGENT, 'Accept-Encoding': 'br, gzip' },
      signal: AbortSignal.timeout(OVERVIEW_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > OVERVIEW_WORLD_MAX_BYTES) {
      throw new Error(`world JSON is ${body.length} bytes, over the limit`);
    }
    const actual = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
    if (actual !== hash) throw new Error(`world hashes to ${actual}, not the reported ${hash}`);
    const svg = mapOverview.buildMapOverviewSvg(JSON.parse(body.toString('utf8')));
    fs.writeFileSync(filePath, svg);
    precompress.consider(`/overviews/${hash}.svg`, filePath, Buffer.from(svg));
    log(`[LISTSERVER] drew the overview for ${instanceUrl}'s world ${hash}`);
  })().catch((error) => {
    log(`[LISTSERVER] no overview for ${instanceUrl}'s world ${hash}: ${error.message}`);
  }).finally(() => {
    inFlightOverviews.delete(hash);
  });

  inFlightOverviews.set(hash, work);
  return work;
}

// A server that has just booted reports at once and is then too busy to
// answer its own challenge in time, so a failed check is tried again a few
// times before its row waits for the next report. Keyed by URL: one retry
// chain per server, however many reports arrive meanwhile.
const LIST_SERVER_RETRY_DELAYS_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];
const listServerRetries = new Map();

function scheduleListServerRetry(record) {
  const pending = listServerRetries.get(record.url);
  if (pending?.timer) return;
  const attempt = pending ? pending.attempt : 0;
  if (attempt >= LIST_SERVER_RETRY_DELAYS_MS.length) {
    listServerRetries.delete(record.url);
    return;
  }
  const timer = setTimeout(() => {
    listServerRetries.set(record.url, { attempt: attempt + 1, timer: null });
    validateListServerKey(record, { retry: true })
      .catch((error) => logError(`[LISTSERVER] retry failed for ${record.url}: ${error.message}`));
  }, LIST_SERVER_RETRY_DELAYS_MS[attempt]);
  timer.unref?.();
  listServerRetries.set(record.url, { attempt, timer });
}

// The other names a validated instance reports (`urls`), each called back the
// way its key's own URL is and kept only when it answers with that key: a
// report can claim any host, and a row links to what it names.
async function verifyListServerAlternates(record) {
  const claimed = (record.live?.urls || []).filter((url) => url !== record.url);
  const verified = [];
  for (const url of claimed) {
    const nonce = crypto.randomBytes(16).toString('hex');
    try {
      const response = await fetch(
        `${url}/api/list-server/challenge?${new URLSearchParams({ nonce })}`,
        { headers: { 'User-Agent': BZO_USER_AGENT }, signal: AbortSignal.timeout(8000) },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!verifyListServerChallenge(record.key, nonce, body.signature)) throw new Error('signature mismatch');
      verified.push(url);
    } catch (error) {
      log(`[LISTSERVER] ${record.url} also names ${url}, which did not verify: ${error.message}`);
    }
  }
  record.alsoAt = verified;
}

async function validateListServerKey(record, { retry = false } = {}) {
  // A fresh report starts the retries over; a retry carries on its own count.
  if (!retry) {
    clearTimeout(listServerRetries.get(record.url)?.timer);
    listServerRetries.delete(record.url);
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  try {
    const response = await fetch(
      `${record.url}/api/list-server/challenge?${new URLSearchParams({ nonce })}`,
      { headers: { 'User-Agent': BZO_USER_AGENT }, signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!verifyListServerChallenge(record.key, nonce, body.signature)) {
      throw new Error('signature mismatch');
    }
    listServerKeys.markChecked(record, true);
    // The status rides with a valid signature -- restoring `live` here is
    // what makes a restart's boot-time poll (below) actually put a row back
    // on `/list` immediately, rather than just confirming it is reachable
    // and leaving the row missing until the target's own next report.
    if (body.status && typeof body.status === 'object') {
      listServerKeys.report(record, sanitizeListServerStatus(body.status));
    }
    listServerRetries.delete(record.url);
    await verifyListServerAlternates(record);
    log(`[LISTSERVER] validated ${record.url}`
      + (record.alsoAt?.length ? ` and ${record.alsoAt.join(', ')}` : ''));
    // Only from here, which is the boot/periodic path and the daily poll --
    // never from a bare join or part, on the same rule that keeps an active
    // game from costing an outbound round trip per player. A world already
    // drawn returns immediately, so the usual case is a file check.
    if (record.live?.mapHash) {
      ensureInstanceOverview(record.url, record.live.mapHash);
    }
  } catch (error) {
    listServerKeys.markChecked(record, false, error.message);
    const next = listServerRetries.get(record.url)?.attempt ?? 0;
    const retrying = next < LIST_SERVER_RETRY_DELAYS_MS.length;
    log(`[LISTSERVER] could not validate ${record.url}: ${error.message}`
      + (retrying ? `; trying again in ${LIST_SERVER_RETRY_DELAYS_MS[next] / 1000}s` : ''));
    scheduleListServerRetry(record);
  }
}

// "Adds a key" -- a logged-in bzflag.org user, from their own session, naming
// the server URL up front. Per-server, not per-account (bzfs's `-publickey`
// is per-server too): a leaked key compromises one row, not everything the
// operator runs.
app.post('/api/list-server/keys', listServerRateLimit, (req, res) => {
  if (!requireDesignatedListServer(req, res)) return;
  const session = sessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: 'Log in at /login first' });
    return;
  }
  let parsed;
  try {
    parsed = new URL(typeof req.body?.url === 'string' ? req.body.url.trim() : '');
  } catch {
    res.status(400).json({ error: "Enter the server's own https:// URL (its publicUrl)" });
    return;
  }
  if (parsed.protocol !== 'https:') {
    res.status(400).json({ error: 'The URL must be https://' });
    return;
  }
  const url = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  // One key per URL, not one per request: two active registrations for the
  // same server would both get validated and both get reported, which is
  // ambiguity `/list`'s bzo-servers table and the daily poll have no reason
  // to carry. Case-insensitively, since a host name is.
  const existing = listServerKeys.listAll()
    .find((candidate) => candidate.url.toLowerCase() === url.toLowerCase());
  if (existing) {
    res.status(409).json({
      error: existing.bzid === session.bzid
        ? 'You already have a key for this URL. Revoke it below before generating another.'
        : 'Another operator already holds a key for this URL.',
    });
    return;
  }
  const record = listServerKeys.requestKey({ bzid: session.bzid, callsign: session.callsign, url });
  log(`[LISTSERVER] "${session.callsign}" (bzid=${session.bzid}) generated a key for ${url}`);
  res.json({ key: record.key, url: record.url, dateRequested: record.dateRequested });
});

app.delete('/api/list-server/keys/:id', listServerRateLimit, (req, res) => {
  if (!requireDesignatedListServer(req, res)) return;
  const session = sessionFromRequest(req);
  const admin = isLocalAdminHttp(req) || (session ? isAdminSession(session, ADMIN_GROUPS) : false);
  if (!session && !admin) {
    res.status(401).json({ error: 'Log in at /login first' });
    return;
  }
  const record = listServerKeys.get(req.params.id);
  if (!record) {
    res.status(404).json({ error: 'No such key' });
    return;
  }
  if (!admin && record.bzid !== session.bzid) {
    res.status(403).json({ error: 'Not your key' });
    return;
  }
  listServerKeys.revoke(record.id);
  const who = session ? `"${session.callsign}"` : `${req.socket.remoteAddress} (localAdmin)`;
  log(`[LISTSERVER] ${who} revoked the key for ${record.url}`
    + (session && record.bzid === session.bzid ? '' : ' (another operator\'s key)'));
  res.json({ success: true });
});

app.get('/api/list-server/keys', (req, res) => {
  if (!requireDesignatedListServer(req, res)) return;
  res.set('Cache-Control', 'no-store');
  const session = sessionFromRequest(req);
  const admin = isLocalAdminHttp(req) || (session ? isAdminSession(session, ADMIN_GROUPS) : false);
  if (!session && !admin) {
    res.status(401).json({ error: 'Log in at /login first' });
    return;
  }
  const rows = admin ? listServerKeys.listAll() : listServerKeys.listForBzid(session.bzid);
  res.json({ admin, keys: rows.map(describeListServerKeyRow) });
});

// Every live row, exactly as a visitor sees it -- read by `/api/list-server/list`
// for other instances and by this instance's own `/list`, which reads the
// registry in process rather than round-tripping HTTPS to itself. One shaping
// function, because two copies of it is how one of them quietly stops
// carrying a field the other added.
//
// An instance reports what it likes, so everything here is read defensively:
// an older one reports no proxies at all.
function listPublicListServerRows() {
  return listServerKeys.listAll()
    // Only what a visitor could join. A row is an invitation, and an
    // instance bzo has stopped hearing from is not one -- the operator's own
    // diagnosis lives in the key table at the bottom of `/list`, which shows
    // every key's last check and last error to whoever owns it. Upstream
    // drops a server that stops re-ADDing for the same reason.
    .filter((record) => record.live !== null && !isListServerKeyStale(record))
    .map((record) => {
      return {
        url: record.url,
        // Verified, and still named by the latest report.
        alsoAt: (record.alsoAt || []).filter((url) => (record.live.urls || []).includes(url)),
        title: record.live.title,
        description: record.live.description,
        // Public, as the BZFlag list makes every bzfs server's owner. Only a
        // real account: an instance's own key with no operator BZID set
        // carries the server's name there instead.
        owner: isForumBzid(record.bzid) ? record.callsign : '',
        ownerBzid: isForumBzid(record.bzid) ? record.bzid : '',
        players: record.live.players,
        maxPlayers: record.live.maxPlayers,
        version: record.live.version,
        gameOptionsBits: record.live.gameOptionsBits,
        maxShots: record.live.maxShots,
        style: record.live.style,
        map: String(record.live.map || ''),
        // Where that instance's overview picture is, or null while this
        // server has not drawn one yet. An absolute URL on the designated
        // instance, stated here rather than assembled by each reader: this is
        // the only server that knows which pictures exist.
        overviewUrl: instanceOverviewUrl(record.live.mapHash),
        // Shaped the way `describeRelayedWorld` renders a bzfs row's, so
        // both panes read the same however the figures were come by: this
        // instance measured its own, the bzfs one was measured off an
        // import.
        world: describeReportedWorld(record.live.world),
        voiceEnabled: record.live.voiceEnabled,
        // Observed, never reported: `sanitizeListServerStatus` deliberately
        // does not read this from a payload, because a server claiming its own
        // uptime is the thing issue #106 said was worthless.
        upSince: record.upSince ?? null,
        ...sanitizeListServerReadout(record.live),
        // One entry per server this instance proxies, each describing that
        // target's own game rather than this instance's (`docs/proxy.md`).
        // A target the proxy could not reach on its last dial is left out on
        // the same rule as a stale instance: the row would lead nowhere.
        proxies: Array.isArray(record.live.proxies)
          ? record.live.proxies
            .filter((proxy) => proxy && proxy.reachable === true)
            .slice(0, MAX_REPORTED_PROXIES)
            .map((proxy) => ({
              target: String(proxy.target || '').slice(0, 128),
              title: String(proxy.title || '').slice(0, 128),
              players: Number(proxy.players) || 0,
              maxPlayers: Number(proxy.maxPlayers) || 0,
              maxShots: Number(proxy.maxShots) || 0,
              style: String(proxy.style || '').slice(0, 32),
              gameOptionsBits: Number(proxy.gameOptionsBits) || 0,
              ...sanitizeListServerReadout(proxy),
            }))
          : [],
      };
    });
}

// The reasons a report may name. `join`/`part` only update the live counts
// below; only `boot`/`periodic` also trigger the validation callback -- "an
// active game should not cost an outbound HTTPS round trip per player."
const LIST_SERVER_REPORT_REASONS = new Set(['boot', 'periodic', 'join', 'part', 'shutdown']);

// How many proxied targets one instance's row may contribute. An operator
// with more servers than this is not a case bzo has met; the cap is here so a
// report cannot grow the table without bound.
const MAX_REPORTED_PROXIES = 32;

// The ADD/REMOVE-equivalent every other bzo instance posts here. JSON, not
// bzfs's form-encoded body -- both ends are bzo, so there is no reason to
// mimic the wire format bzfs uses to talk to a server that predates JSON
// everywhere. See "Reporting" in the plan.
app.post('/api/list-server/report', listServerRateLimit, (req, res) => {
  if (!requireDesignatedListServer(req, res)) return;
  const key = typeof req.body?.key === 'string' ? req.body.key : '';
  const record = listServerKeys.getByKey(key);
  if (!record) {
    // Absolute, not relative: this response is read by another instance's
    // log line, not rendered on this one's own page, so a bare "/list#keys"
    // would be ambiguous about which server it names.
    res.status(403).json({ error: `Unknown or expired key. Generate a new one at ${LIST_SERVER_URL}/list#keys.` });
    return;
  }
  const reason = LIST_SERVER_REPORT_REASONS.has(req.body?.reason) ? req.body.reason : 'periodic';
  if (reason === 'shutdown') {
    listServerKeys.unreport(record);
    res.json({ success: true });
    return;
  }
  listServerKeys.report(record, sanitizeListServerStatus(req.body), Date.now(), reason);
  res.json({ success: true });
  // After the response, not before -- a reporting instance should not wait on
  // this any more than an ordinary ADD would.
  if (reason === 'boot' || reason === 'periodic') {
    validateListServerKey(record).catch((error) => logError(`[LISTSERVER] validation failed: ${error.message}`));
  }
});

// The public read endpoint every other instance's `/list` reads. It carries
// **both** lists: the bzo rows this server holds registrations for, and the
// public BZFlag list it already fetches and caches for its own page. One call
// where there were two, and the reason is not the round trip -- it is that
// only this server knows which rows have a picture, and joining that to a
// bzfs list each reader fetched separately would mean matching two copies of
// a list that aged apart.
//
// Only bzo rows that have reported at least once (`live`) -- a
// registered-but-never-run key names nobody to list.
app.get('/api/list-server/list', async (req, res) => {
  if (!requireDesignatedListServer(req, res)) return;
  res.set('Cache-Control', 'no-store');
  let bzfs = [];
  try {
    bzfs = await getRemoteServerList();
  } catch (error) {
    // The bzo half is this server's own registry and always available; the
    // bzfs half is somebody else's service. A reader that gets one and not
    // the other falls back to fetching upstream itself, which is what it did
    // before this endpoint carried the list at all.
    logError('/api/list-server/list could not reach the BZFlag list server:', error);
  }
  res.json({
    servers: listPublicListServerRows(),
    bzfs: bzfs.map((server) => ({
      host: server.host,
      port: server.port,
      title: server.title,
      info: server.info,
      owner: server.owner,
      ip: server.ip,
      bots: server.bots,
      // The picture of that server's world, when this instance holds an
      // import of it (`server/bzfs-worlds.cjs` keeps them fresh). Absolute,
      // because the reader is another origin -- and stated here rather than
      // derived, since this is the only server that knows.
      overviewUrl: bzfsInstanceOverviewUrl(server.host, server.port),
      // What this server knows of that world, measured once here rather than
      // by every reader -- a reader holds no import of it and could not
      // measure any of this for itself.
      world: publishWorldFacts(server.host, server.port),
    })),
    bzfsCacheAgeSeconds: Math.max(0, Math.round((Date.now() - remoteServerListCache.at) / 1000)),
  });
});

// The signed-challenge target every instance (designated or not) answers on,
// for whichever instance holds a key to validate against it -- "a signed
// challenge, not a round trip of the raw key."
app.get('/api/list-server/challenge', listServerRateLimit, (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!LIST_SERVER_KEY) {
    res.status(404).type('text/plain').send('No list server key configured.\n');
    return;
  }
  const nonce = typeof req.query.nonce === 'string' ? req.query.nonce : '';
  if (!nonce) {
    res.status(400).json({ error: 'Missing nonce' });
    return;
  }
  // The status rides along with the signature -- a caller who already knows
  // this server's key (the only one who could verify the signature meant
  // anything) gets the same fields a report would have carried, so a
  // validation poll can restore a row's live state, not just its
  // reachability. See "Speeding up a restart" in docs/list-server.md.
  res.json({ signature: signListServerChallenge(LIST_SERVER_KEY, nonce), status: computeListServerStatus() });
});

if (IS_DESIGNATED_LIST_SERVER) {
  // A backstop for a server that has gone quiet on the push side (a blocked
  // outbound leg, a missed restart) but is actually still reachable --
  // initiated by the list server itself rather than waited for.
  setInterval(() => {
    for (const record of listServerKeys.listAll()) {
      validateListServerKey(record)
        .catch((error) => logError(`[LISTSERVER] daily poll failed for ${record.url}: ${error.message}`));
    }
  }, 24 * 60 * 60 * 1000).unref?.();
  // Unused keys expire after 30 days -- see "Key lifetime". A failed check
  // marks a row stale (above); only this sweep ever deletes a registration.
  setInterval(() => {
    const dropped = listServerKeys.sweepExpired();
    if (dropped > 0) {
      log(`[LISTSERVER] ${dropped} key(s) expired`
        + ` (unused for ${Math.round(LIST_SERVER_KEY_MAX_AGE_MS / 86400000)} days)`);
    }
  }, 60 * 60 * 1000).unref?.();
}

// The bottom section of `/list` (docs/list-server-plan.md): this instance's
// own list-server key admin. Login lives at the top of the page now, not
// here -- this section only ever assumes a session exists when it needs one,
// for the register-a-key form.
function renderListServerKeyAdminSection({ session, admin, t }) {
  const code = (text) => `<code>${escapeHtml(text)}</code>`;
  if (!IS_DESIGNATED_LIST_SERVER) {
    return `<h1 id="keys">${escapeHtml(t('List server key'))}</h1>
${LIST_SERVER_URL
    ? `<p class="muted">${l10n.html(t("This instance is not the designated bzo list server. Manage this server's key at {link}."), {
      link: `<a href="${escapeHtml(LIST_SERVER_URL)}/list#keys">${escapeHtml(LIST_SERVER_URL)}/list</a>`,
    })}</p>`
    : `<p class="muted">${l10n.html(t('The list server is disabled on this instance ({setting} is empty).'), {
      setting: code('listServerUrl'),
    })}</p>`}`;
  }
  const formBlock = session
    ? `<form id="addForm">
<input id="urlInput" type="text" placeholder="https://your-server.example.com" required>
<button type="submit">${escapeHtml(t('Generate key'))}</button>
</form>
<p class="muted">${l10n.html(t("Enter the server's own {setting} -- the same address it already answers admin-whitelist probes on."), {
      setting: code('publicUrl'),
    })}
${escapeHtml(t('The list server calls this address back to validate a report; it never trusts one a report claims for itself.'))}</p>
<div id="newKeyFlash"></div>`
    : `<p class="muted">${escapeHtml(t('Log in above to register a server and generate a key.'))}</p>`;
  // What the table script below writes itself.
  const messages = {
    never: t('never'),
    stale: t('stale'),
    players: t('{players}/{max} players'),
    neverReported: t('never reported'),
    revoke: t('Revoke'),
    failed: t('Failed'),
    keyFor: t('Key for {url}: {key}'),
    paste: t("Paste this into that server's Operator panel -- also readable from the table above any time."),
  };
  return `<h1 id="keys">${escapeHtml(admin ? t('All registered keys') : t('Your keys'))}</h1>
<p class="muted">${l10n.html(t('This instance ({url}) is the designated bzo list server -- every other bzo instance reports here, so its own {list} can show the {table} above.'), {
    url: `<a href="${escapeHtml(LIST_SERVER_URL)}">${code(LIST_SERVER_URL)}</a>`,
    list: code('/list'),
    table: `<a href="#bzo">${escapeHtml(t('bzo servers table'))}</a>`,
  })}
${l10n.html(t("A {bzfs} server's key is a different one, from {link}."), {
    bzfs: code('bzfs'),
    link: '<a href="https://my.bzflag.org/listkeys/">my.bzflag.org/listkeys</a>',
  })}</p>
${listFilterInput('keyFilter', t)}
<table id="keyTable">
<thead><tr><th>URL</th>${admin ? `<th>${escapeHtml(t('Owner'))}</th>` : ''}<th>${escapeHtml(t('Key'))}</th>`
    + `<th>${escapeHtml(t('Requested'))}</th><th>${escapeHtml(t('Last checked'))}</th>
<th>${escapeHtml(t('Status'))}</th><th></th></tr></thead>
<tbody></tbody>
</table>
${formBlock}
<script>
var admin = ${admin ? 'true' : 'false'};
var L = ${l10n.inlineJson(messages)};
// ISO-ish, the same reason /list's own "Modified" column (Local maps table)
// is: it sorts correctly as plain text, unlike a locale-formatted string.
function fmt(ts) { return ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) : esc(L.never); }
// A row's url/callsign/lastError all come from whoever registered or ran
// that server, not from bzo itself -- escaped before going into innerHTML
// the same reason the server side does it with escapeHtml everywhere else.
function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\\'': '&#39;' }[c];
  });
}
function renderRows(keys) {
  var tbody = document.querySelector('#keyTable tbody');
  tbody.innerHTML = '';
  keys.forEach(function (row) {
    var tr = document.createElement('tr');
    var status = row.stale ? '<span class="stale">' + esc(L.stale) + (row.lastError ? ' (' + esc(row.lastError) + ')' : '') + '</span>'
      : row.live ? esc(L.players).replace('{players}', row.live.players).replace('{max}', row.live.maxPlayers)
        : esc(L.neverReported);
    // A real forum BZID is numeric -- linked to its profile so an admin can
    // see who they're looking at. (Two backslashes in this source: this text
    // is itself inside server.js's own template literal, which would eat a
    // single one.)
    var ownerCell = /^\\d+$/.test(row.bzid)
      ? '<a href="https://forums.bzflag.org/memberlist.php?mode=viewprofile&u=' + encodeURIComponent(row.bzid)
        + '" target="_blank" rel="noopener noreferrer">' + esc(row.callsign) + '</a>'
      : esc(row.callsign);
    tr.innerHTML = '<td><a href="' + esc(row.url) + '" target="_blank" rel="noopener noreferrer">' + esc(row.url) + '</a></td>'
      + (admin ? '<td>' + ownerCell + '</td>' : '')
      + '<td><code>' + row.key + '</code></td>'
      + '<td>' + fmt(row.dateRequested) + '</td>'
      + '<td>' + fmt(row.lastChecked) + '</td>'
      + '<td>' + status + '</td>'
      + '<td><button type="button" data-id="' + row.id + '">' + esc(L.revoke) + '</button></td>';
    tbody.appendChild(tr);
  });
}
function loadKeys() {
  fetch('/api/list-server/keys').then(function (r) { return r.ok ? r.json() : { keys: [] }; })
    .then(function (data) { renderRows(data.keys || []); });
}
// Sortable headers and the filter box, exactly like the three tables above --
// attachTable (defined in that earlier script) is safe here too: this
// table's rows carry no data-href, so the row-click-navigates behaviour it
// also wires never matches anything. (No backticks in this comment: this
// whole section is server.js's own template literal text.)
attachTable('keyTable', 'keyFilter');
document.querySelector('#keyTable tbody').addEventListener('click', function (e) {
  var button = e.target.closest('button[data-id]');
  if (!button) return;
  fetch('/api/list-server/keys/' + encodeURIComponent(button.dataset.id), { method: 'DELETE' })
    .then(loadKeys);
});
var addForm = document.getElementById('addForm');
if (addForm) {
  addForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var url = document.getElementById('urlInput').value.trim();
    fetch('/api/list-server/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url }),
    }).then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (result) {
        var flash = document.getElementById('newKeyFlash');
        if (!result.ok) {
          flash.innerHTML = '<p class="flash error">' + (result.data.error || esc(L.failed)) + '</p>';
          return;
        }
        flash.innerHTML = '<p class="flash success">'
          + esc(L.keyFor).replace('{url}', function () { return result.data.url; })
            .replace('{key}', function () { return '<code>' + result.data.key + '</code>'; })
          + '<br>' + esc(L.paste) + '</p>';
        // Left filled in, the field reads as "still registering this one" --
        // clearing it is what makes a second submit type a fresh URL instead
        // of appending to the one just registered.
        document.getElementById('urlInput').value = '';
        loadKeys();
      });
  });
}
loadKeys();
</script>`;
}

let MAP_SOURCE = serverConfig.mapFile || 'random';
let mapPath = '';

// Anti-cheat configuration
const ANTICHEAT_CONFIG = {
  mode: serverConfig.antiCheat?.mode || 'strict', // 'strict', 'warning', or 'disabled'
  linearDriftThreshold: serverConfig.antiCheat?.linearDriftThreshold || 3.0,
  linearDriftThresholdVelocityChanged: serverConfig.antiCheat?.linearDriftThresholdVelocityChanged || 20.0,
  angularDriftThreshold: serverConfig.antiCheat?.angularDriftThreshold || 0.5,
  // The server must be strictly more permissive than the client, or it rejects
  // moves an unmodified client legitimately made. Move packets quantize
  // position to 0.01 (client.js sends toFixed(2)), which is ~0.007 of radial
  // error in the XZ plane -- far more than the ~0.001 margin the client keeps
  // when it slides along a surface. Without slack the server rejects most of a
  // slide and the player rubber-bands down every slope.
  collisionSlack: serverConfig.antiCheat?.collisionSlack ?? 0.05,
};

// Move packets quantize `fs` and `rs` with toFixed(2), so a difference between
// two of them carries up to 0.02 that is rounding rather than a finding.
const SPEED_QUANTIZATION_SLACK = 0.02;

// The most a client-claimed interval -- the acceleration window's `sdt`, or
// the extrapolation window's absolute timestamp -- may widen past the gap the
// server itself measured between arrivals.
const SDT_JITTER_ALLOWANCE = 0.25;

// What GAME_CONFIG holds before server.json touches it, so the startup line
// can name only what an operator changed.
const GAME_CONFIG_DEFAULTS = { ...GAME_CONFIG };
configureBzwParse({ log, gameConfigDefaults: GAME_CONFIG_DEFAULTS });


// server.json's `bzdb`: upstream's command-line `-set`, by upstream's names and
// as upstream writes the values -- `"_tankSpeed": "30"`, `"_gravity": "-9.8"`,
// `"_shotRange": "_shotSpeed * 3.5"`. A map's own `-set` lines go over it, as a
// world file's go over the command line, and `/reset` takes a name back to
// upstream's default whichever of them set it.
//
// The keys server.json used to spell these by are read once more, as the
// variable each one always was, and named in the log so they can be moved.
const LEGACY_BZDB_KEYS = Object.freeze({
  tankSpeed: '_tankSpeed',
  tankRotationSpeed: '_tankAngVel',
  jumpVelocity: '_jumpVelocity',
  gravity: '_gravity',
  shotSpeed: '_shotSpeed',
  shotRange: '_shotRange',
  shotRadius: '_shotRadius',
  shotsKeepVerticalVelocity: '_shotsKeepVerticalVelocity',
  wingsJumpCount: '_wingsJumpCount',
  wingsJumpVelocity: '_wingsJumpVelocity',
  wingsGravity: '_wingsGravity',
  wingsSlideTime: '_wingsSlideTime',
  maxBumpHeight: '_maxBumpHeight',
  maxFlagGrabs: '_maxFlagGrabs',
  rejoinTime: '_rejoinTime',
  fogMode: '_fogMode',
  fogDensity: '_fogDensity',
  fogStart: '_fogStart',
  fogEnd: '_fogEnd',
  fogColor: '_fogColor',
  skyColor: '_skyColor',
});
function bzdbString(value) {
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}
function readServerBzdb(config) {
  const vars = new Map();
  const legacy = [];
  for (const [key, name] of Object.entries(LEGACY_BZDB_KEYS)) {
    if (config[key] === undefined || config[key] === null) continue;
    vars.set(name, bzdbString(config[key]));
    legacy.push(`${key} -> bzdb.${name}`);
  }
  // `shotDuration` and `shotDistance` were two more spellings of `_shotRange`,
  // the first as a time at the shot's speed.
  if (Number.isFinite(Number(config.shotDuration)) && config.shotDuration !== null) {
    vars.set('_shotRange', `_shotSpeed * ${Number(config.shotDuration)}`);
    legacy.push('shotDuration -> bzdb._shotRange');
  }
  if (Number.isFinite(Number(config.shotDistance)) && config.shotDistance !== null) {
    vars.set('_shotRange', String(Number(config.shotDistance)));
    legacy.push('shotDistance -> bzdb._shotRange');
  }
  const block = config.bzdb && typeof config.bzdb === 'object' && !Array.isArray(config.bzdb) ? config.bzdb : {};
  for (const [name, value] of Object.entries(block)) {
    if (typeof name === 'string' && name.startsWith('_') && value !== null && value !== undefined) {
      vars.set(name, bzdbString(value));
    }
  }
  if (legacy.length > 0) log(`Config: server.json keys read as BZDB, move them to "bzdb": ${legacy.join(', ')}`);
  return vars;
}
const SERVER_BZDB = readServerBzdb(serverConfig);
// bzo's own puff clouds, off unless server.json's `puffClouds` asks for them:
// upstream's sky is one flat cloud layer, which every client draws for itself
// (`_drawClouds`).
const PUFF_CLOUDS = serverConfig.puffClouds === true;

const configReverseSpeedRatio = Number(serverConfig.reverseSpeedRatio);
if (Number.isFinite(configReverseSpeedRatio) && configReverseSpeedRatio >= 0 && configReverseSpeedRatio <= 1) {
  GAME_CONFIG.REVERSE_SPEED_RATIO = configReverseSpeedRatio;
}

// `-a <vel> <rot>`, as `linearAcceleration` and `angularAcceleration`. Upstream
// clamps a negative to zero rather than refusing it, and so does this.
const configLinearAcceleration = Number(serverConfig.linearAcceleration);
if (Number.isFinite(configLinearAcceleration)) {
  GAME_CONFIG.LINEAR_ACCELERATION = Math.max(0, configLinearAcceleration);
}

const configAngularAcceleration = Number(serverConfig.angularAcceleration);
if (Number.isFinite(configAngularAcceleration)) {
  GAME_CONFIG.ANGULAR_ACCELERATION = Math.max(0, configAngularAcceleration);
}



// The sky's clock: `timeOfDay` is the hour it starts at, 0-24 (random when
// unset), and `daySpeed` how fast it runs.
const configTimeOfDay = Number(serverConfig.timeOfDay ?? NaN);
const configDaySpeed = Number(serverConfig.daySpeed ?? NaN);
if (Number.isFinite(configDaySpeed) && configDaySpeed >= 0) GAME_CONFIG.DAY_SPEED = configDaySpeed;
// `sky` in server.json: upstream's sky unless it asks for the day clock.
if (serverConfig.sky === 'minecraft') GAME_CONFIG.SKY = 'minecraft';



const configShotReloadTime = Number(serverConfig.shotReloadTime);
if (Number.isFinite(configShotReloadTime) && configShotReloadTime > 0) {
  GAME_CONFIG.SHOT_RELOAD_TIME = configShotReloadTime;
}

const configShotCooldown = Number(serverConfig.shotCooldown);
if (Number.isFinite(configShotCooldown) && configShotCooldown > 0) {
  GAME_CONFIG.SHOT_RELOAD_TIME = configShotCooldown;
}

// `>= 0`, not `> 0`: zero is upstream's own "tanks cannot shoot" (`-ms 0`),
// and `server.json` is where bzo keeps what upstream keeps on its command
// line, so an operator can ask for it here as a map can ask for it in its
// `options` block.
const configShotMaxActive = Number(serverConfig.shotMaxActive);
if (Number.isInteger(configShotMaxActive) && configShotMaxActive >= 0) {
  GAME_CONFIG.SHOT_MAX_ACTIVE = normalizeShotSlotCount(configShotMaxActive);
}


const configShotTailLength = Number(serverConfig.shotTailLength);
if (Number.isFinite(configShotTailLength) && configShotTailLength >= 0) {
  GAME_CONFIG.SHOT_TAIL_LENGTH = configShotTailLength;
}

const configuredVoiceNearbyRadius = Number(
  process.env.VOICE_NEARBY_RADIUS ?? serverConfig.voiceNearbyRadius
);
if (Number.isFinite(configuredVoiceNearbyRadius) && configuredVoiceNearbyRadius > 0) {
  GAME_CONFIG.VOICE_NEARBY_RADIUS = configuredVoiceNearbyRadius;
}

function parseVoiceIceServers(value) {
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch (error) {
      logError('Could not parse VOICE_ICE_SERVERS as JSON:', error.message || error);
      source = source.split(',').map((url) => url.trim()).filter(Boolean);
    }
  }

  const entries = Array.isArray(source) ? source : source ? [source] : [];
  return entries
    .map((entry) => {
      const candidate = typeof entry === 'string' ? { urls: [entry] } : entry;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
      const urls = Array.isArray(candidate.urls)
        ? candidate.urls
        : typeof candidate.urls === 'string'
          ? [candidate.urls]
          : [];
      const validUrls = urls
        .filter((url) => typeof url === 'string' && /^(?:stun|turn|turns):/i.test(url))
        .map((url) => url.slice(0, 2048));
      if (validUrls.length === 0) return null;

      const normalized = { urls: validUrls };
      if (typeof candidate.username === 'string' && candidate.username.length <= 256) {
        normalized.username = candidate.username;
      }
      if (typeof candidate.credential === 'string' && candidate.credential.length <= 2048) {
        normalized.credential = candidate.credential;
      }
      return normalized;
    })
    .filter(Boolean)
    .slice(0, 8);
}

const configuredVoiceIceServers = process.env.VOICE_ICE_SERVERS ?? serverConfig.voiceIceServers;
const VOICE_ICE_SERVERS = parseVoiceIceServers(configuredVoiceIceServers);

// coturn's `use-auth-secret`: a `turn:`/`turns:` entry with no username of its
// own gets one per connection, `<expiry>:<player>-<random>`, whose password is
// the base64 HMAC-SHA1 of it under the shared secret. coturn counts its
// `user-quota` against the part after the colon, and player numbers are
// reused: the relays a dropped connection leaves behind until they time out
// must not count against whoever gets its number next. The secret never leaves the server,
// and a leaked credential stops working at its expiry. coturn checks it on
// every allocation refresh, so it has to outlast a session.
const VOICE_TURN_SECRET = String(process.env.VOICE_TURN_SECRET ?? serverConfig.voiceTurnSecret ?? '');
const VOICE_TURN_CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;

// `voiceIceServersIpv4`: the same servers by names with no IPv6 address, for
// the clients that keep voice on IPv4 (phones -- see voice.js `ipFamily`). A
// relay reached over IPv6 would carry the call over IPv6 all the same.
const VOICE_ICE_SERVERS_IPV4 = parseVoiceIceServers(
  process.env.VOICE_ICE_SERVERS_IPV4 ?? serverConfig.voiceIceServersIpv4
);

// `webrtc` (#8, #189): the UDP channel, a WebRTC data channel on the BZFlag
// port (server/udp-channel.cjs, `startUdpChannels`). Its STUN servers learn
// the public address to offer: `webrtc.iceServers`, or the STUN half of the
// IPv4 voice servers.
const UDP_CHANNEL_STUN = Array.isArray(serverConfig.webrtc?.iceServers)
  ? serverConfig.webrtc.iceServers.filter((url) => typeof url === 'string')
  : VOICE_ICE_SERVERS_IPV4.flatMap((server) => server.urls).filter((url) => /^stun:/i.test(url));
// On unless `"webrtc": false`, where werift is installed.
const WEBRTC_ON = serverConfig.webrtc !== false;
let UDP_CHANNELS = null;
// A channel loses a move now and then, as UDP loses a MsgPlayerUpdate, and a
// lost stop would leave a tank coasting on every screen until its next
// update. Upstream's answer is an update at least once a second
// (`MaxUpdateTime`, Player.cxx:38), so a resting tank is corrected within one.
if (WEBRTC_ON || serverConfig.webtransport !== false) {
  GAME_CONFIG.MAX_UPDATE_INTERVAL = Math.min(GAME_CONFIG.MAX_UPDATE_INTERVAL, 1000);
}

function voiceRtcConfigFor(playerId) {
  if (!VOICE_TURN_SECRET) {
    return VOICE_ICE_SERVERS_IPV4.length > 0
      ? { iceServers: VOICE_ICE_SERVERS, ipv4IceServers: VOICE_ICE_SERVERS_IPV4 }
      : { iceServers: VOICE_ICE_SERVERS };
  }
  const username = `${Math.floor(Date.now() / 1000) + VOICE_TURN_CREDENTIAL_TTL_SECONDS}:${playerId}-${crypto.randomBytes(4).toString('hex')}`;
  const credential = crypto.createHmac('sha1', VOICE_TURN_SECRET).update(username).digest('base64');
  const withCredentials = (servers) => servers.map((server) => (
    server.username === undefined && server.urls.some((url) => /^turns?:/i.test(url))
      ? { ...server, username, credential }
      : server
  ));
  return VOICE_ICE_SERVERS_IPV4.length > 0
    ? { iceServers: withCredentials(VOICE_ICE_SERVERS), ipv4IceServers: withCredentials(VOICE_ICE_SERVERS_IPV4) }
    : { iceServers: withCredentials(VOICE_ICE_SERVERS) };
}


// BZFlag derives both numbers from _reloadTime, which itself defaults to
// _shotRange / _shotSpeed:
//   ShotPath.cxx:48    lifetime = _reloadTime
//   LocalPlayer.cxx:1311  forceReload(_reloadTime / numShots)
// So a shot lives for the full reload time while each slot comes back after
// _reloadTime / maxShots. Firing continuously then sustains exactly maxShots in
// flight. `worldConfig` derives it, unless the operator pinned `shotReloadTime`.
const SHOT_RELOAD_TIME_PINNED = GAME_CONFIG.SHOT_RELOAD_TIME !== null;


if (!Number.isFinite(GAME_CONFIG.FOG_START)) {
  GAME_CONFIG.FOG_START = 0.5 * GAME_CONFIG.MAP_SIZE;
}

if (!Number.isFinite(GAME_CONFIG.FOG_END)) {
  GAME_CONFIG.FOG_END = GAME_CONFIG.MAP_SIZE;
}

// One line for the whole of server.json's say: a setting at its default is
// not named, and a map's own overrides are logged when the map loads.
{
  const gameplay = [
    ['reverseSpeedRatio', 'REVERSE_SPEED_RATIO'],
    ['linearAcceleration', 'LINEAR_ACCELERATION'],
    ['angularAcceleration', 'ANGULAR_ACCELERATION'],
    ['shotMaxActive', 'SHOT_MAX_ACTIVE'],
    ['shotTailLength', 'SHOT_TAIL_LENGTH'],
  ].filter(([, key]) => GAME_CONFIG[key] !== GAME_CONFIG_DEFAULTS[key])
    .map(([name, key]) => `${name}=${GAME_CONFIG[key]}`);
  if (SHOT_RELOAD_TIME_PINNED) gameplay.push(`shotReloadTime=${GAME_CONFIG.SHOT_RELOAD_TIME}ms`);
  for (const [name, value] of SERVER_BZDB) gameplay.push(`${name}=${value}`);
  const maps = RUNTIME_MAPS_DIR === BUNDLED_MAPS_DIR
    ? RUNTIME_MAPS_DIR
    : `${RUNTIME_MAPS_DIR} + bundled ${BUNDLED_MAPS_DIR}`;
  log(`Config: anti-cheat ${ANTICHEAT_CONFIG.mode}; gameplay ${gameplay.join(', ') || 'defaults'};`
    + ` voice radius ${GAME_CONFIG.VOICE_NEARBY_RADIUS},`
    + ` ${VOICE_ICE_SERVERS.length} ICE; maps ${maps}`);
}
if (MAP_SOURCE !== 'random') {
  mapPath = resolveMapFilePath(MAP_SOURCE);
  if (!fs.existsSync(mapPath)) {
    logError(`Map file not found: ${MAP_SOURCE}. Reverting to random map.`);
    MAP_SOURCE = 'random';
  } else {
    // Watch the map file for changes and restart the server if it changes
    try {
      fs.watch(mapPath, (eventType, filename) => {
        if (eventType === 'change' || eventType === 'rename') {
          console.log(`\n📝 Map file changed: ${filename || path.basename(mapPath)}`);
          console.log('🔄 Restarting server due to map file change...\n');
          requestServerRestart('map file change');
        }
      });
    } catch (err) {
      logError(`Failed to watch map file: ${mapPath}`, err);
    }
  }
}

// The `options` block of a BZW file carries bzfs command-line switches. Team
// mode is read out of it by the `teams` pair, because both sides need it; these
// are the ones only the server acts on, so they stay here.
//
// Returns undefined for a switch the map does not mention, so the server config
// keeps its say.
// Seconds in, seconds out. Anything that is not a positive number is no limit,
// which is `-time`'s own absence.
function normalizeTimeLimit(seconds) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// A whole number of wins minus losses, for `-mps`/`-mts`. Anything that is not
// a positive integer is no limit, which is either switch's own absence.
function normalizeScoreLimit(score) {
  const value = Math.floor(Number(score));
  return Number.isFinite(value) && value > 0 ? value : 0;
}











































let OBSTACLES;
let TELEPORTER_GRAPH = { teleporters: [], links: [] };
let mapTeamMode = null;
let mapServerOptions = {};
// What the live map says to a player who joins it -- -srvmsg lines and the
// dropped-unsupported-feature tally (parseBZWMap), threaded into its
// MAP_REGISTRY entry below the same way any other map's is.
let mapMessages = [];
// The map's `zone` blocks, in map order, so a flag slot can name the one it
// belongs to by index the way upstream's `#<flagId>` qualifier does.
let MAP_ZONES = [];
// The map's `weapon` blocks. Upstream's `WorldWeapons` list, which is the
// world's and not any player's.
let WORLD_WEAPONS = [];
// The ceiling `hasFlagClearance` searches under for a flag to spawn --
// upstream's `_flagHeight` (default 10, CustomWorld.cxx:41-44), overridable by
// a map's own `flagHeight` line. Purely a spawn-positioning detail: flags are
// never predicted client-side, so unlike `MAP_SIZE` this never needs to leave
// the server.
let FLAG_HEIGHT = FLAG_CLEARANCE;
// `noWalls` -- skips the world border entirely. Read by the client from its
// own copy of the live map's JSON (see `registerMapFile`'s `noWalls` field),
// not sent here, the same way `MAP_SIZE` is not.
let mapNoWalls = false;
// `freeCtfSpawns` -- a colour team spawns in any of its zones on every life,
// not only the first and post-capture ones `restartOnBase` gates. Read by
// `getSpawnPosition` alone, so this stays a plain module variable rather than
// threading through `GAME_CONFIG` or the client's copy of the map.
let mapFreeCtfSpawns = false;
// The live world's physics drivers by upstream's index, for a BZFlag client's
// death-touch, which names one that way.
let mapPhysicsDrivers = [];
// `waterLevel` -- `null` when the map states none. Read by `validateMovement`
// for the kill-on-touch rule and by `findFlagSpawnPosition`/`dropSpawnPosition`
// to keep a flag or a spawn off the surface, the server-side half of what
// `noWalls` above is the client-side half of: this one also rides along in
// the live map's own JSON (`registerMapFile`) for the client to draw the
// plane itself.
let mapWaterLevel = null;
// `weather` -- `null` when the map states no `_rainType`. Purely a client
// render (see "Weather" in docs/bzw.md), so unlike `mapWaterLevel` this has no
// server-side reader of its own; it only rides along in the live map's own
// JSON (`registerMapFile`) the same way.
let mapWeather = null;
// `groundMaterial` -- `null` when the map states no `-gndtex` or explicit
// `GroundMaterial` block. Purely a client render, same as `weather` above:
// no server-side reader, it only rides along in the live map's own JSON
// (`registerMapFile`) for the client to texture the ground plane itself.
let mapGroundMaterial = null;
// The live map's own `group` templates and placements (#153). Like `weather`
// and `groundMaterial` above, no server-side reader: nothing collides with
// them, so they only ride along in the map's JSON for the client to draw.
let mapMeshTemplates = {};
let mapMeshInstances = [];
// A world with no map is generated (server/world-generator.cjs, after bzfs's
// own generators) as the `.bzw` it amounts to, and read exactly as a map file is
// -- and compiled from the same text for a BZFlag client (`getBzflagWorld`).
// Kept in memory rather than written out: each process has its own, and two
// on one checkout must not trade theirs. bzfs builds its team world, with
// bases, for capture-the-flag (`-c`, bzfs.cxx:1166); bzo's `-c` is its team
// mode, so the team world goes to a server with colour teams on, with a base
// for each colour that has player slots, as upstream checks `maxTeam > 0`.
// Resolved here from the config alone, since a generated world states no team
// options of its own; `TEAM_MODE` below comes to the same answer.
let RANDOM_WORLD_BZW = null;
if (MAP_SOURCE === 'random') {
  const maxPlayers = Number(serverConfig.maxPlayers);
  const configTeams = resolveTeamMode(serverConfig.teamMode, null,
    Number.isInteger(maxPlayers) && maxPlayers > 0 ? maxPlayers : 16, serverConfig.rabbit);
  const colourTeams = configTeams.enabled
    ? configTeams.teams
      .filter((team) => isColorTeam(team) && (configTeams.limits[team] || 0) > 0)
      .map((team) => BZFLAG_TEAM_ORDER.indexOf(team))
    : [];
  const randomWorld = serverConfig.randomWorld && typeof serverConfig.randomWorld === 'object'
    ? serverConfig.randomWorld : {};
  RANDOM_WORLD_BZW = generateWorldBzw({
    bzdb: SERVER_BZDB,
    teamWorld: colourTeams.length > 0,
    teams: colourTeams,
    options: {
      density: Number(randomWorld.density),
      teleporters: randomWorld.teleporters,
      randomHeights: randomWorld.randomHeights,
      randomCtf: randomWorld.randomCtf,
      randomBoxes: randomWorld.randomBoxes,
      randomSizes: randomWorld.randomSizes,
      floating: randomWorld.floating,
      upsideDown: randomWorld.upsideDown,
    },
  });
  log(`Generated a ${colourTeams.length > 0 ? `team world for ${colourTeams.length} colour(s)` : 'random world'}`
    + `, ${Buffer.byteLength(RANDOM_WORLD_BZW)} bytes of .bzw`);
}
{
  const mapData = RANDOM_WORLD_BZW !== null
    ? parseBZWMap('random', { text: RANDOM_WORLD_BZW })
    : parseBZWMap(mapPath);
  OBSTACLES = mapData.obstacles;
  TELEPORTER_GRAPH = mapData.teleporterGraph;
  mapTeamMode = mapData.teamMode;
  mapServerOptions = mapData.serverOptions;
  mapMessages = mapData.messages;
  MAP_ZONES = mapData.zones;
  // The map's `world size` directive. Applied here, at the one call site that
  // loads the *live* map, rather than as a side effect inside `parseBZWMap`
  // itself -- see that function's own comment on why.
  if (Number.isFinite(mapData.mapSize)) {
    GAME_CONFIG.MAP_SIZE = mapData.mapSize;
    log(`Map option world size: MAP_SIZE=${GAME_CONFIG.MAP_SIZE}`);
  }
  const flagHeight = Number.isFinite(mapData.flagHeight) ? mapData.flagHeight : mapData.serverOptions?.flagHeight;
  if (Number.isFinite(flagHeight)) {
    FLAG_HEIGHT = flagHeight;
    log(`Map option flagHeight: ${FLAG_HEIGHT}`);
  }
  mapNoWalls = mapData.noWalls;
  if (mapNoWalls) log('Map option noWalls: the world border will not be built');
  mapFreeCtfSpawns = mapData.freeCtfSpawns;
  mapPhysicsDrivers = mapData.physicsDrivers || [];
  if (mapFreeCtfSpawns) log('Map option freeCtfSpawns: a colour team spawns in any of its zones every life');
  mapWaterLevel = mapData.waterLevel || null;
  if (mapWaterLevel) log(`Map option waterLevel: height=${mapWaterLevel.height}`);
  mapWeather = mapData.weather || null;
  if (mapWeather) log(`Map option _rainType: ${mapWeather.type}`);
  mapMeshTemplates = mapData.meshTemplates || {};
  mapMeshInstances = mapData.meshInstances || [];
  mapGroundMaterial = mapData.groundMaterial || null;
  if (mapGroundMaterial) {
    log(`Map option -gndtex: ${mapGroundMaterial.texture || mapGroundMaterial.textureUrl}`);
  }
  WORLD_WEAPONS = mapData.weapons;
}


// Content-hashed, HTTP-cacheable world files, so a client fetches a map's
// static geometry once and an `immutable` response spares it a re-fetch on
// every reconnect -- the same win upstream gets from its MD5-keyed world
// cache (`WorldDownLoader`, playing.cxx), reached here through ordinary HTTP
// caching instead of a bespoke client-side cache file. `init` carries only a
// `{ hash, url }` reference to the live map's entry; Map Viewer (issue #68)
// reuses the same entries for maps nobody has joined into.
//
// filename ('random' for a generated world included) -> { fileName, hash, url,
// obstacles, teleporterGraph, teamMode, clouds, mapSize }.
const MAP_REGISTRY = new Map();
// GAME_CONFIG's own default (defaultBZDB.cxx's `worldSize`, doubled the same
// way `parseBZWMap` doubles a map's own `world size` line) -- what a map with
// no `world` block at all gets, both for the live match and for a Map
// Viewer's preview of one.
const DEFAULT_MAP_SIZE = 800;
try {
  fs.mkdirSync(MAP_CACHE_DIR, { recursive: true });
} catch (error) {
  logError(`Could not create map cache directory at ${MAP_CACHE_DIR}:`, error);
}

// Hashes what is actually served -- the parsed, cloud-decorated world data --
// rather than the source `.bzw` bytes, since nothing here needs to survive a
// restart and this is simpler. Queues the file straight into the existing
// brotli sidecar pipeline (`server/precompress.cjs`, already mounted globally
// at `app.use(precompress.middleware(...))`): map JSON is small enough that a
// second, brotli-only cache would only complicate the pipeline for no real
// disk saving, so this reuses it exactly as public/'s assets do, raw copy and
// negotiated fallback included.

// Builds the brotli sidecars for whatever was just written to the map cache.
// `precompress.start()` is the wrong call here: it sweeps first, and a sweep
// is only correct once every map has been considered -- mid-trickle it would
// delete the sidecars of every map the pass has not reached yet. Debounced,
// because the boot trickle registers a hundred maps back to back and this is
// meant to be one pass over the lot rather than a hundred.
//
// Without it a map imported while the server is up has no sidecar until the
// next restart, which is exactly the map whose `.json.br` size a `/list` row
// is being asked for.
let compressCacheTimer = null;
function compressNewCacheFilesSoon() {
  if (compressCacheTimer) return;
  compressCacheTimer = setTimeout(() => {
    compressCacheTimer = null;
    precompress.drain({ log }).then(({
      compressed, skipped, raw, br, ms,
    }) => {
      if (compressed > 0 || skipped > 0) {
        log(`[BR] ${compressed} map sidecar(s) built, ${Math.round(raw / 1024)}KB -> `
          + `${Math.round(br / 1024)}KB in ${(ms / 1000).toFixed(1)}s`
          + (skipped > 0 ? `, ${skipped} not written` : ''));
      }
    }).catch((error) => logError('[BR] map sidecars:', error));
  }, 5000);
  if (compressCacheTimer.unref) compressCacheTimer.unref();
}

// What `buildWorldFile` reckons a world against: this server's own config.
// An import is a BZFlag world, whose picture only an instance drawing its own
// lists keeps -- unless it is the map this instance serves, which its own
// Local maps row shows.
function worldBuildOptions(fileName) {
  return {
    gameConfig: { ...GAME_CONFIG },
    serverBzdb: SERVER_BZDB,
    puffClouds: PUFF_CLOUDS,
    defaultMapSize: DEFAULT_MAP_SIZE,
    withOverview: drawsBzfsPictures() || !parseImportMapFileName(fileName) || fileName === MAP_SOURCE,
  };
}

// A map parsed here, on the server's own thread: only the live map at boot,
// whose parse the game itself is built from. Every other map is converted on
// a worker (`convertMapFile`).
function registerMapFile(fileName, map, options) {
  const world = buildWorldFile(map, worldBuildOptions(fileName));
  // The worker hashes the maps it converts; this is the one parsed here, the
  // live map, and the hash bzo serves native clients is not its file's own
  // (it adds the compass letters).
  const filePath = fileName === 'random' ? null : resolveMapFilePath(fileName);
  if (filePath) world.bzfsHash = bzfsWorldHashOfBzw(fs.readFileSync(filePath, 'latin1'));
  return registerWorldFile(fileName, world, options);
}

// Parses and builds a map file on a worker thread (`server/map-convert-
// worker.cjs`), resolving to what `buildWorldFile` returns plus the parse's
// `instancing` and `warnedMessages`. The game goes on meanwhile; the worker
// ends with the map, and the memory it used with it.
// With `keepWorld` its JSON is written there too, and only the hash comes back.
function convertMapFile(fileName, filePath, { quiet = true, keepWorld = true } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'server', 'map-convert-worker.cjs'), {
      workerData: {
        filePath,
        quiet,
        gameConfigDefaults: GAME_CONFIG_DEFAULTS,
        build: worldBuildOptions(fileName),
        writeDir: keepWorld ? MAP_CACHE_DIR : null,
      },
    });
    let result = null;
    worker.on('message', (message) => {
      if (message.log) log(message.log);
      if (message.result) result = message.result;
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (result) resolve(result);
      else reject(new Error(`converting ${fileName} stopped with code ${code}`));
    });
  });
}

// A built world registered: its JSON written when `keepWorld` says somebody
// is about to load it, its picture when it has none yet, and its entry in
// the registry and the index.
function registerWorldFile(fileName, world, { keepWorld = true } = {}) {
  const { json, hash, stats } = world;
  const url = `/maps/${hash}.json`;
  const filePath = path.join(MAP_CACHE_DIR, `${hash}.json`);
  // Only a world somebody is about to load is written: the live one, an
  // import, or a map just asked for (`prepareMapForView`). A map registered
  // only to be listed needs its hash, picture and stats, and none of its JSON.
  // A worker that converted it has written it already (`world.written`).
  if (keepWorld && world.written) {
    precompress.consider(url, filePath, world.written);
    compressNewCacheFilesSoon();
  } else if (keepWorld) {
    try {
      fs.writeFileSync(filePath, json);
    } catch (error) {
      logError(`Could not write map cache file for ${fileName}:`, error);
      return null;
    }
    precompress.consider(url, filePath, Buffer.from(json));
    compressNewCacheFilesSoon();
  }

  // The overview picture (`server/map-overview.cjs`, issue #147), in the one
  // directory every picture lives in, under the name a reader knows the world
  // by (`overviewNameFor`). Written only when missing, because the name
  // already says which world it is.
  const overviewName = overviewNameFor(fileName, hash);
  const overviewUrl = `/overviews/${overviewName}.svg`;
  const overviewPath = path.join(OVERVIEW_CACHE_DIR, `${overviewName}.svg`);
  if (world.overviewError) logError(`Could not build map overview for ${fileName}: ${world.overviewError}`);
  let hasOverview = fs.existsSync(overviewPath);
  if (!hasOverview && world.svg) {
    try {
      fs.writeFileSync(overviewPath, world.svg);
      precompress.consider(overviewUrl, overviewPath, Buffer.from(world.svg));
      hasOverview = true;
    } catch (error) {
      logError(`Could not write map overview for ${fileName}:`, error);
    }
  }

  // What lists and serves a map, not the world itself: that is in its JSON
  // while one is kept (`keptAt`), and the live game holds its own copy.
  // `registeredAt` is `importMapForView`'s freshness check (`IMPORT_REUSE_MS`).
  const registered = {
    fileName,
    hash,
    url,
    registeredAt: Date.now(),
    keptAt: keepWorld ? Date.now() : 0,
    stats,
    // bzfs's hash of this world, for naming the map a recording was played
    // on (`replayMapName`). Null where the worker could not make it.
    bzfsHash: typeof world.bzfsHash === 'string' ? world.bzfsHash : null,
    // Whether the overview above got written, so `/list` can show the app's
    // own mark in the pane instead of an image that would not load.
    overviewUrl: hasOverview ? overviewUrl : null,
  };
  MAP_REGISTRY.set(fileName, registered);
  invalidateListTables();
  // So the next boot can list this file from its hash, picture and stats
  // without parsing it.
  mapIndex.note(fileName, hash, overviewName, resolveMapFilePath(fileName),
    { stats, version: MAP_INDEX_VERSION, bzfsHash: registered.bzfsHash });
  return registered;
}


// Anything left in `MAP_CACHE_DIR` that no current `MAP_REGISTRY` entry
// names -- a map since removed or edited, or (before clouds were seeded
// deterministically) simply a previous boot's copy of the same map. Run once
// the background trickle below has registered everything this process ever
// will, so a file mid-registration is never mistaken for an orphan.
function sweepMapCache() {
  // Pictures are not here: they live in `OVERVIEW_CACHE_DIR` and are cleared
  // by `purgeUnreferencedOverviews` on its own rule.
  // A world's JSON is kept for the live map, for an import (aged out with
  // its `.bzw` by `sweepStaleImports`), and for an hour after somebody last
  // asked to view it (`prepareMapForView`). A picture is kept for every map.
  const expected = new Set();
  const playing = replayWorldsPlaying();
  for (const entry of MAP_REGISTRY.values()) {
    if (entry.overviewUrl) expected.add(path.basename(entry.overviewUrl));
    const keep = entry.fileName === MAP_SOURCE || parseImportMapFileName(entry.fileName)
      || playing.has(entry.fileName)
      || (entry.keptAt && Date.now() - entry.keptAt < IMPORT_REUSE_MS);
    if (keep) expected.add(`${entry.hash}.json`);
    else entry.keptAt = 0;
  }
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(MAP_CACHE_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (expected.has(name)) continue;
    try {
      fs.unlinkSync(path.join(MAP_CACHE_DIR, name));
      removed += 1;
    } catch (error) {
      logError(`Could not remove stale map cache file ${name}:`, error);
    }
  }
  if (removed > 0) log(`Removed ${removed} stale map cache file(s) from ${MAP_CACHE_DIR}`);
  // The index names map files rather than cache files, so it is pruned
  // against the registry the sweep above was built from.
  mapIndex.prune(new Set(MAP_REGISTRY.keys()));

  // precompress's own sweep (server/precompress.cjs) can't catch this mid-
  // process: its `expected` set only ever grows, reset solely by the
  // `configure()` call this process makes once at boot -- so a sidecar
  // `consider()`-ed for a map this pass just deleted above stays "expected"
  // and immune to precompress's own sweep until the next restart. Asking the
  // same freshness question again here, against `cache/br/maps/` directly,
  // is what actually catches it in between.
  let brEntries;
  try {
    brEntries = fs.readdirSync(MAP_CACHE_BR_DIR);
  } catch {
    return;
  }
  let removedBr = 0;
  for (const name of brEntries) {
    // A sidecar is named `<source name>.<digest>.br` (`consider()`); the
    // source name is all that's expected, so the digest never has to agree
    // with anything -- only whether that source is still around at all.
    //
    // Both kinds, because a map hash names a world *and* its picture. A
    // pattern that knew only about `.json` did not merely miss the pictures'
    // sidecars -- it deleted every one of them on every sweep, since a name
    // it cannot parse falls through to the unlink below. They were rebuilt
    // on the next pass and deleted again on the one after, so the overviews
    // were served uncompressed no matter how often the pass ran.
    const match = name.match(/^(.+\.(?:json|svg))\.[0-9a-f]+\.br$/);
    if (match && expected.has(match[1])) continue;
    try {
      fs.unlinkSync(path.join(MAP_CACHE_BR_DIR, name));
      removedBr += 1;
    } catch (error) {
      logError(`Could not remove stale map cache sidecar ${name}:`, error);
    }
  }
  if (removedBr > 0) log(`Removed ${removedBr} stale map cache sidecar(s) from ${MAP_CACHE_BR_DIR}`);
}

// A remote import older than `IMPORT_MAX_AGE_MS` deleted off disk, its
// `MAP_REGISTRY` entry with it. Age is read off the file's own mtime, not
// `MAP_REGISTRY`'s `registeredAt` -- the background trickle above
// re-registers every file already on disk at every restart, which would
// reset `registeredAt` to "now" regardless of when the file was actually
// last fetched, and never let a restart-heavy server (this one) see one as
// stale. Bundled maps never match `parseImportMapFileName`, so this only
// ever touches a remote import.
function sweepStaleImports() {
  let removed = 0;
  const playing = replayWorldsPlaying();
  for (const fileName of listAvailableMapFiles()) {
    // A recording's world is rebuilt from the recording whenever it is
    // needed, so it goes an hour after its last room closes, however new the
    // file. While one plays it, never.
    const replayWorld = isReplayWorldFile(fileName);
    if (!replayWorld && !parseImportMapFileName(fileName)) continue;
    if (replayWorld && playing.has(fileName)) continue;
    // Never the map being played. An import ages out on mtime alone, and
    // nothing about hosting one touches the file, so a server left running on
    // an imported map for two hours would delete the map out from under
    // itself. The match survives on the obstacles it already holds, which is
    // what makes this quiet: the damage lands on the next restart, where
    // `resolveMapFilePath` finds nothing and the server comes back on a
    // random map instead.
    if (fileName === MAP_SOURCE) continue;
    const filePath = path.join(RUNTIME_MAPS_DIR, fileName);
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (replayWorld) {
      const lastUsed = Math.max(stats.mtimeMs, MAP_REGISTRY.get(fileName)?.keptAt || 0);
      if (Date.now() - lastUsed < IMPORT_REUSE_MS) continue;
    } else if (Date.now() - stats.mtimeMs < IMPORT_MAX_AGE_MS) {
      continue;
    }
    try {
      fs.unlinkSync(filePath);
      MAP_REGISTRY.delete(fileName);
      removed += 1;
    } catch (error) {
      logError(`Could not remove stale import ${fileName}:`, error);
    }
  }
  // The cache JSON an aged-out import leaves behind is exactly what
  // sweepMapCache already knows how to find: nothing in MAP_REGISTRY names it
  // once the entry above is gone.
  if (removed > 0) {
    log(`Removed ${removed} stale remote import(s) older than ${IMPORT_MAX_AGE_MS / 3600000}h`);
    sweepMapCache();
  }
}

const LIVE_MAP_ENTRY = registerMapFile(MAP_SOURCE, {
  obstacles: OBSTACLES,
  teleporterGraph: TELEPORTER_GRAPH,
  teamMode: mapTeamMode,
  mapSize: GAME_CONFIG.MAP_SIZE,
  messages: mapMessages,
  noWalls: mapNoWalls,
  waterLevel: mapWaterLevel,
  weather: mapWeather,
  groundMaterial: mapGroundMaterial,
  serverOptions: mapServerOptions,
  meshTemplates: mapMeshTemplates,
  meshInstances: mapMeshInstances,
  zones: MAP_ZONES,
});

// A Map Viewer's requested map file, checked against what this process has
// actually hashed -- the client fetched its preview from `init.viewableMaps`
// already, so this is bookkeeping (the roster, an operator's view of who is
// looking at what), never something the client is waiting on. `null` for
// anything unrecognized, which is what an ordinary observer join sends: it
// would be misleading to say a plain observer is "viewing" the live map, so
// nothing stands in for a missing choice.
function resolveViewMapChoice(requested) {
  const fileName = typeof requested === 'string' ? requested.trim() : '';
  return fileName && MAP_REGISTRY.has(fileName) ? fileName : null;
}

// Parses and registers every other known map file in the background, one at a
// time via `setTimeout` rather than in one synchronous burst -- today's maps
// parse in low single-digit ms (no mesh/BSP work in `parseBZWMap`), so this is
// about never letting a future oversized or uploaded map stall the game loop,
// not about today's sizes. A map is listable/servable only once it lands in
// `MAP_REGISTRY`: there is no "hashing in progress" state exposed to clients,
// so a request that arrives too soon just sees a shorter list, and refreshing
// sees more once this trickle catches up. `uploadMap` re-triggers this so a
// map added mid-session becomes viewable without a restart.
function hashRemainingMapsInBackground() {
  const pending = listLocalMapFiles()
    .filter((fileName) => fileName !== 'random' && !MAP_REGISTRY.has(fileName));
  const total = pending.length;
  let converted = 0;
  let restored = 0;
  const instancing = { instanced: 0, groups: 0, templates: 0, faces: 0, repeats: 0, repeatShapes: 0 };
  const step = async () => {
    const fileName = pending.shift();
    if (!fileName) {
      // One line for the whole pass rather than one per file (see `quiet`
      // above): still worth knowing the trickle ran and how much of it
      // landed, the same reasoning `sweepMapCache`'s own summary line below
      // already follows.
      markServerReady();
      if (converted > 0) {
        log(`Parsed ${converted} of ${total} bzw file(s) for the map list`
          + (instancing.groups > 0 ? `; ${formatInstancing(instancing)}` : ''));
      }
      if (restored > 0) log(`Listed ${restored} unchanged map(s) from the map index`);
      // Everyone already connected is holding whatever list this trickle had
      // reached when their `init` went out -- which, on a restart that
      // clients auto-rejoin into (see AGENTS.md), is routinely a short one.
      // Nothing else ever revisits it, so the picker would stay missing
      // maps until a reload. One push at the end of the pass fixes that for
      // every open client at once.
      if (converted + restored > 0) broadcastMapList();
      sweepMapCache();
      sweepStaleImports();
      // Where the world tracker runs it clears pictures once its own pass is
      // complete, since only then are all of a list's hashes known. Anywhere
      // else the registry is all that names a picture, and it is complete now.
      if (!(BZFS_WORLD_THUMBNAILS && IS_DESIGNATED_LIST_SERVER)) purgeUnreferencedOverviews();
      precompress.start({ log }).catch((error) => logError('[BR] map hashing pass failed:', error));
      return;
    }
    try {
      const filePath = resolveMapFilePath(fileName);
      // Listed from the index where it still holds, which is every map that
      // has not changed since a previous boot parsed it. Parsed otherwise, for
      // its hash, picture and stats only: nobody is playing it, and its world
      // is written when somebody views it (`prepareMapForView`).
      const known = filePath ? mapIndex.restore(fileName, filePath, MAP_INDEX_VERSION) : null;
      if (known) {
        MAP_REGISTRY.set(fileName, {
          fileName,
          hash: known.hash,
          url: `/maps/${known.hash}.json`,
          registeredAt: Date.now(),
          keptAt: 0,
          stats: known.stats,
          bzfsHash: known.bzfsHash,
          overviewUrl: `/overviews/${known.overview}.svg`,
        });
        restored += 1;
      } else if (filePath) {
        const parsed = await parseAndRegisterMap(fileName, filePath, { keepWorld: false });
        if (parsed) {
          converted += 1;
          if (parsed.instancing) {
            for (const key of Object.keys(instancing)) instancing[key] += parsed.instancing[key] || 0;
          }
        }
      }
    } catch (error) {
      logError(`Could not hash map ${fileName}:`, error);
    }
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}
hashRemainingMapsInBackground();
// The trickle above only runs once, at startup -- a long-lived process needs
// the same cycle repeated: pick up and precompress any map that appeared
// without going through registerMapFile's own synchronous path, delete a
// remote import old enough that nobody has asked for it again
// (sweepStaleImports, chained off hashRemainingMapsInBackground's own
// completion), and sweep both the map cache and its brotli sidecars for
// whatever either of those just removed. Same cadence as the session pruner.
setInterval(() => hashRemainingMapsInBackground(), 15 * 60 * 1000).unref?.();
// The live map's own game settings that are not BZDB -- its `-ms` -- which
// upstream sends apart from BZDB and bzo lays straight into the config.
{
  const applied = [];
  for (const [key, value] of Object.entries(mapServerOptions.gameplay || {})) {
    if (GAME_CONFIG[key] === value) continue;
    applied.push(`${key}=${value} (was ${GAME_CONFIG[key]})`);
    GAME_CONFIG[key] = value;
  }
  if (applied.length > 0) log(`Map options: ${applied.join(', ')}`);
  // Upstream prints "WARNING: tanks will not be able to shoot" the moment it
  // reads `-ms 0` (CmdLineOptions.cxx:904). Said here so that it covers a
  // server.json asking for it as well as a map, and is said once.
  if (GAME_CONFIG.SHOT_MAX_ACTIVE === 0) {
    log('Shots: no shot slots -- tanks cannot shoot on this world');
  }
}

// The config a client is given, `init` and every change after it alike.
function buildClientConfig(config) {
  return {
    ...Object.fromEntries(
      Object.entries(config).filter(([key]) => key !== 'MAP_SIZE'),
    ),
    // Sent for the same reason the proxy sends them, and with the same values
    // this server decides hits by: the client holds one copy of the hit rule
    // (`getShotTankHit`), and a rule it could only answer on one kind of
    // connection would be two rules wearing one name.
    NO_TEAM_KILLS,
    TEAMS_ALLOWED,
    // `-sl`, so the HUD knows whether to say anything about shots left at all.
    // This server's own: a proxied game's limits are its target's, unknown.
    SHOT_LIMITS: Object.fromEntries(SHOT_LIMITS),
  };
}

// The server's BZDB, as an upstream bzfs holds it: names to raw strings,
// starting from the live map's `-set` lines, with every `/set` since. The
// config the world plays by is `worldConfig` over it -- the same function a
// browser runs over the same strings, which `init` sends it raw and a
// `setVar` keeps up to date (MsgSetVar upstream).
//
// `worldBase` is everything that is not BZDB: bzo's defaults, server.json and
// the map's `-ms`. The keys BZDB can move are kept there as they stood before
// any BZDB touched them, with the reload and Wings' two left to derive unless
// server.json pinned them.
const liveBzdb = new Map([...SERVER_BZDB, ...(mapServerOptions.bzdbVars || [])]);
const BZDB_DRIVEN_KEYS = new Set([
  ...[...BZDB_CONFIG_VARS.values()].map(({ key }) => key),
  'SHOT_DISTANCE', 'SHOT_RELOAD_TIME', 'SHOT_COOLDOWN', 'WINGS_JUMP_VELOCITY', 'WINGS_GRAVITY',
]);
const preBzdbConfig = Object.fromEntries([...BZDB_DRIVEN_KEYS].map((key) => [key, GAME_CONFIG[key]]));
if (!SHOT_RELOAD_TIME_PINNED) preBzdbConfig.SHOT_RELOAD_TIME = null;
preBzdbConfig.WINGS_JUMP_VELOCITY = null;
preBzdbConfig.WINGS_GRAVITY = null;

function worldBase() {
  return { ...GAME_CONFIG, ...preBzdbConfig };
}

// Lays the world's BZDB over the base and tells every shared module the
// result. Returns the config keys that moved.
function applyWorldBzdb() {
  const next = worldConfig(worldBase(), liveBzdb);
  const moved = [];
  for (const key of BZDB_DRIVEN_KEYS) {
    if (JSON.stringify(GAME_CONFIG[key]) === JSON.stringify(next[key])) continue;
    GAME_CONFIG[key] = next[key];
    moved.push(key);
  }
  configureFlagEffects(GAME_CONFIG);
  configureTankDimensions(GAME_CONFIG);
  return moved;
}
{
  const moved = applyWorldBzdb();
  if (moved.length > 0) {
    log(`Map variables: ${moved.map((key) => `${key}=${JSON.stringify(GAME_CONFIG[key])}`).join(', ')}`);
  }
}

// One variable set (`raw` a value as `-set` would write it) or, with `raw`
// null, reset -- back to upstream's default, which is the BZDB with the name
// gone. Every client is told, as upstream's MsgSetVar tells it, and evaluates
// the change itself. Returns the config keys that moved.
function setWorldVariable(name, raw) {
  if (raw === null) liveBzdb.delete(name);
  else liveBzdb.set(name, raw);
  const moved = applyWorldBzdb();
  broadcastAll({ type: 'setVar', name, value: raw });
  pluginEvent('bz_eBZDBChange', () => ({ key: name, value: raw ?? worldVariableDefault(name) ?? '' }));
  return moved;
}

// `maxRealPlayers` upstream, which `-mp N` sets: how many tanks may play, and it
// excludes the observers (CmdLineOptions.cxx:458). bzo's `maxPlayers` is that
// number -- the default per-team limit, and the cap every playing team's own
// limit is clamped down to.
const configuredMaxPlayers = Number(serverConfig.maxPlayers);
const MAX_REAL_PLAYERS = Number.isInteger(configuredMaxPlayers) && configuredMaxPlayers > 0
  ? configuredMaxPlayers
  : 16;
const TEAM_MODE = resolveTeamMode(
  serverConfig.teamMode, mapTeamMode, MAX_REAL_PLAYERS, serverConfig.rabbit);
// `maxPlayers = maxRealPlayers + maxTeam[ObserverTeam]` (CmdLineOptions.cxx:458).
// Derived and never configured, which is why the panel offers a playing limit and
// an observer limit and not this: reaching it refuses a connection outright
// (bzfs.cxx:2339), where reaching the playing limit only turns an arrival into an
// observer. See docs/operator-panel-plan.md.
const MAX_TOTAL_PLAYERS = MAX_REAL_PLAYERS + (TEAM_MODE.limits[PLAYER_TEAM.OBSERVER] || 0);
log(`Player limits: playing=${MAX_REAL_PLAYERS};`
  + ` observers=${TEAM_MODE.limits[PLAYER_TEAM.OBSERVER] || 0}; total=${MAX_TOTAL_PLAYERS}`);
log(`Team mode: ${TEAM_MODE.enabled ? 'enabled' : 'disabled'}; autoTeam=${TEAM_MODE.autoTeam}; teams=${TEAM_MODE.teams.map((team) => `${team}:${TEAM_MODE.limits[team]}`).join(',')}`);
// RabbitChase upstream, `-rabbit [score|killer|random]`: one rabbit against every
// hunter, and null when the world is not playing it. Resolved here rather than
// beside GAME_TYPE because it is what decides whether the world has colour teams
// at all -- `resolveTeamMode` above has already zeroed them if it is on
// (CmdLineOptions.cxx:1586).
const RABBIT_SELECTION = TEAM_MODE.rabbitSelection;
if (RABBIT_SELECTION) {
  log(`Rabbit chase: on; selection=${RABBIT_SELECTION}`);
  // Upstream's own "only rogues are allowed in Rabbit Chase; zeroing out <team>".
  if (TEAM_MODE.colorTeamsRefused) {
    log('Rabbit chase: only hunters are allowed, so the configured colour teams are off');
  }
}

// Team scores follow bzfs: a team's score is wins minus losses, only colour
// teams keep one, and a team's tally resets when its first player joins an
// empty team (bzfs.cxx:2380) or when the world does (bzfs.cxx:1231).
const teamScores = new Map();

function getTeamScore(team) {
  let score = teamScores.get(team);
  if (!score) {
    score = { wins: 0, losses: 0 };
    teamScores.set(team, score);
  }
  return score;
}

function getTeamSizes() {
  const sizes = {};
  players.forEach((candidate) => {
    if (!candidate.joined) return;
    sizes[candidate.team] = (sizes[candidate.team] || 0) + 1;
  });
  return sizes;
}

// One entry per colour team the server offers, whatever its size: a team that
// empties mid-match keeps its score on screen until it is reset.
function getTeamScoreState() {
  const sizes = getTeamSizes();
  return TEAM_MODE.teams.filter(isColorTeam).map((team) => ({
    team,
    size: sizes[team] || 0,
    ...getTeamScore(team),
  }));
}

function broadcastTeamScores() {
  if (!TEAM_MODE.enabled) return;
  broadcastAll({ type: 'teamUpdate', teams: getTeamScoreState() });
}

// A capture moves the team score, and nothing else does outside a kill.
function recordTeamScoreForCapture(cappingTeam, cappedTeam) {
  if (!TEAM_MODE.enabled) return;
  const deltas = getTeamScoreDeltasForCapture(cappingTeam, cappedTeam);
  if (deltas.length === 0) return;
  deltas.forEach(({ team, wins, losses }) => {
    const score = getTeamScore(team);
    score.wins += wins;
    score.losses += losses;
  });
  broadcastTeamScores();
  checkTeamScoreLimit();
}

// `teamScoreMovesOnKill` is bzfs.cxx:3539's gate: a kill leaves the team score
// alone in ClassicCTF, where only a capture moves it.
function recordTeamScoreForKill(killer, victim) {
  if (!TEAM_MODE.enabled || !victim) return;
  if (!teamScoreMovesOnKill(GAME_TYPE)) return;
  const deltas = getTeamScoreDeltasForKill(killer?.team, victim.team, killer?.id === victim.id);
  if (!deltas.length) return;
  for (const delta of deltas) {
    const score = getTeamScore(delta.team);
    score.wins += delta.wins;
    score.losses += delta.losses;
  }
  broadcastTeamScores();
  checkTeamScoreLimit();
}

// Match end ("Match end" in docs/game-modes-plan.md, issue #66). `-time`'s
// clock: started automatically or by /countdown, pausable, and a hard stop at
// zero that holds the spawn until the next /countdown. Upstream's own
// "3...2...1...GO" pre-match delay is not reproduced -- /countdown starts the
// match at once, and `pause`/`resume` are the two verbs that still mean
// something without it.
let matchClock = {
  active: false,       // a match is running, whether or not it is paused
  paused: false,
  gameOver: false,
  startTime: null,      // Date.now() the match began; shifted forward on resume
  pauseStartedAt: null,
};

// bzfs.cxx:7182: timeLimit minus elapsed, clamped to zero. `-1` upstream's own
// paused value, and `null` for no clock running at all -- which is what a
// clockless world, or one waiting on /countdown, reports.
function getMatchTimeLeft() {
  if (!matchClock.active || !GAME_CONFIG.TIME_LIMIT) return null;
  if (matchClock.paused) return -1;
  const elapsed = (Date.now() - matchClock.startTime) / 1000;
  return Math.max(0, Math.ceil(GAME_CONFIG.TIME_LIMIT - elapsed));
}

// startCountdown() (bzfs.cxx:780). A fresh match: every score back to zero,
// the clock started if this server has one, and everyone told. Nothing but
// /countdown and the auto-start at boot calls this, so it is the one place a
// match begins.
//
// Not gated on `GAME_CONFIG.TIME_LIMIT`: a server with only a score limit
// still needs a way to start the next match once the last one ends, and a
// server with neither still gets a working reset out of /countdown. Only the
// clock-specific state below is conditional on one being configured.
function startMatch() {
  teamScores.clear();
  // resetPlayerScores (bzfs.cxx:695): everybody back to nothing, which every
  // browser does too on `matchStart`, and a BZFlag client hears as MsgScore.
  broadcastAll({ type: 'matchStart' });
  players.forEach((candidate) => {
    candidate.wins = 0;
    candidate.losses = 0;
    candidate.tks = 0;
    // Whoever the previous match's game-over held dead gets back in: nothing
    // else was going to lift that hold, since the respawn timeout that would
    // have revived them already saw `matchClock.gameOver` and gave up.
    if (!isObserverTeam(candidate.team) && !candidate.alive) bringBack(candidate);
  });
  matchClock.paused = false;
  matchClock.gameOver = false;
  broadcastTeamScores();
  if (GAME_CONFIG.TIME_LIMIT > 0) {
    matchClock.active = true;
    matchClock.startTime = Date.now();
    matchClock.pauseStartedAt = null;
    broadcastAll({ type: 'timeUpdate', timeLeft: GAME_CONFIG.TIME_LIMIT });
    broadcastAll({
      type: 'message', src: SERVER_PLAYER, dst: ALL_PLAYERS, msgType: 'server',
      ...localized('Match duration is {duration}', { duration: formatDuration(GAME_CONFIG.TIME_LIMIT) }), ts: Date.now(),
    });
    log(`Match started: ${GAME_CONFIG.TIME_LIMIT}s`);
  } else {
    matchClock.active = false;
    // Clears a client's stale "GAME OVER" from a previous score-limit ending,
    // which nothing else would: with no clock there is no zero-crossing
    // `timeUpdate` to double as that signal.
    broadcastAll({ type: 'timeUpdate', timeLeft: null });
    broadcastAll({
      type: 'message', src: SERVER_PLAYER, dst: ALL_PLAYERS, msgType: 'server', ...localized('Match started'), ts: Date.now(),
    });
    log('Match started (no time limit)');
  }
  return true;
}

function pauseMatch() {
  if (!matchClock.active || matchClock.gameOver || matchClock.paused) return false;
  matchClock.paused = true;
  matchClock.pauseStartedAt = Date.now();
  broadcastAll({ type: 'timeUpdate', timeLeft: -1 });
  log('Match paused');
  return true;
}

function resumeMatch() {
  if (!matchClock.active || !matchClock.paused) return false;
  matchClock.startTime += Date.now() - matchClock.pauseStartedAt;
  matchClock.paused = false;
  matchClock.pauseStartedAt = null;
  broadcastAll({ type: 'timeUpdate', timeLeft: getMatchTimeLeft() });
  log('Match resumed');
  return true;
}

// cleanupGameOver() (bzfs.cxx:3294). Kills every playing tank through the
// ordinary death path -- so the flag, the lock and the rabbit all resolve the
// way any other death does -- and holds the spawn: `applyDeath`'s own respawn
// timeout checks `matchClock.gameOver` and does nothing while it is set, and a
// fresh join reads the same flag. Deliberately does not reset scores; the
// standing result stays on the board until the next startMatch().
//
// Not gated on `matchClock.active`: a score limit (or /gameover) ends the
// match on a server with no clock at all, exactly as it does on one with a
// clock that simply has not started -- "Match end" ties to neither the clock
// nor team play in docs/game-modes-plan.md, and this is the one function every
// way to end a match funnels through.
//
// `winner` is `{ playerId } | { team }` for a score limit, upstream's own
// `MsgScoreOver` payload; omitted for a time-up or an operator's /gameover,
// which upstream's own client shows as "GAME OVER" with no winner named.
function endMatch(winner = null) {
  if (matchClock.gameOver) return false;
  matchClock.active = false;
  matchClock.paused = false;
  matchClock.gameOver = true;
  players.forEach((victim) => {
    if (isObserverTeam(victim.team) || !victim.alive) return;
    applyDeath(victim, WORLD_WEAPON_PLAYER_ID, {
      projectileId: null,
      reason: DEATH_REASON.GAME_OVER,
      victimFlag: getPlayerFlag(victim.id)?.type ?? null,
      shooterFlag: null,
      suicide: false,
    });
  });
  // Only a server with a clock concept has one to zero out; a score-limit
  // ending on a clockless server has nothing for this to mean.
  if (GAME_CONFIG.TIME_LIMIT > 0) broadcastAll({ type: 'timeUpdate', timeLeft: 0 });
  if (winner) {
    broadcastAll({ type: 'scoreOver', playerId: winner.playerId ?? null, team: winner.team ?? null });
    log(`Match ended: ${winner.team ? `the ${winner.team} team` : `player ${winner.playerId}`} reached the score limit`);
  } else {
    log('Match ended');
  }
  return true;
}

// Score::reached() (Score.cxx:108), asked of the killer after every ordinary
// kill: wins minus losses reaching `-mps` ends the match with that player as
// the winner.
function checkPlayerScoreLimit(player) {
  if (!GAME_CONFIG.MAX_PLAYER_SCORE) return;
  if ((player.wins - player.losses) >= GAME_CONFIG.MAX_PLAYER_SCORE) {
    endMatch({ playerId: player.id });
  }
}

// checkTeamScore (bzfs.cxx:3313): the same question asked of every colour
// team after any move to a team's score, capture or kill alike.
function checkTeamScoreLimit() {
  if (!GAME_CONFIG.MAX_TEAM_SCORE) return;
  for (const team of TEAM_MODE.teams) {
    if (!isColorTeam(team)) continue;
    const score = getTeamScore(team);
    if ((score.wins - score.losses) >= GAME_CONFIG.MAX_TEAM_SCORE) {
      endMatch({ team });
      return;
    }
  }
}

// `rabbitIndex` (bzfs.cxx:158). Who the rabbit is, or null when the world has no
// rabbit -- which happens between the last player leaving and the next one
// spawning, and whenever everybody who could hold it is paused or observing.
let rabbitPlayerId = null;

// anointNewRabbit (bzfs.cxx:2737). Run whenever the rabbit dies, pauses, leaves,
// goes to observer or rejoins, and whenever a player spawns while there is no
// rabbit. `killerId` is only read under `-rabbit killer`, where whoever shot the
// rabbit takes it if they can.
//
// Upstream also runs this when a client sends `MsgNewRabbit` to refuse the post
// while paused (bzfs.cxx:5196); bzo needs no such message, because the server
// already knows who is paused and `canBeRabbit` refuses them here.
function anointNewRabbit(killerId = null) {
  if (!RABBIT_SELECTION) return;

  const oldRabbitId = rabbitPlayerId;
  const candidates = [];
  players.forEach((candidate) => {
    if (!candidate.joined) return;
    candidates.push({
      id: candidate.id,
      paused: candidate.paused,
      observer: isObserverTeam(candidate.team),
      alive: candidate.alive,
      // PlayerInfo::isPlaying, `state > PlayerInLimbo`: in the game, alive or
      // not. A bzo player who is in the roster and has joined is exactly that.
      playing: true,
      // Score::ranking, or a random number under `-rabbit random` -- upstream
      // replaces the whole function for that mode (Score::setRandomRanking)
      // rather than branching inside the selection loop.
      ranking: RABBIT_SELECTION === 'random'
        ? Math.random()
        : getPlayerRanking(candidate.wins, candidate.losses),
    });
  });

  rabbitPlayerId = pickNewRabbit({
    candidates,
    oldRabbitId,
    killerId,
    selection: RABBIT_SELECTION,
  });

  let changed = rabbitPlayerId !== oldRabbitId;
  const oldRabbit = oldRabbitId !== null ? players.get(oldRabbitId) : null;
  // PlayerInfo::wasARabbit (PlayerInfo.cxx:419): a deposed rabbit becomes a
  // hunter and is marked, which is what excuses its shots until it spawns again.
  // Guarded on the team because the observer case gets here having already left
  // the rabbit team, and putting them back on it would undo the switch.
  if (oldRabbit && changed && isRabbitTeam(oldRabbit.team)) {
    oldRabbit.team = PLAYER_TEAM.HUNTER;
    oldRabbit.wasRabbit = true;
  }
  const rabbit = rabbitPlayerId !== null ? players.get(rabbitPlayerId) : null;
  // Also the rejoin case, where the same player keeps the post but arrived back
  // as a hunter: upstream broadcasts only on a change of holder, and bzo has to
  // broadcast a change of team as well because the team is what it draws.
  if (rabbit && !isRabbitTeam(rabbit.team)) {
    rabbit.team = PLAYER_TEAM.RABBIT;
    changed = true;
  }
  if (!changed) return;

  log(`Rabbit chase: ${rabbit ? `"${rabbit.name}" is now the rabbit` : 'no rabbit'}`);
  // MsgNewRabbit. One id, or none: the client paints that player the rabbit and
  // everybody else a hunter, as playing.cxx:2851 does.
  broadcastAll({ type: 'newRabbit', playerId: rabbitPlayerId });
}

// What every spawn does, the first one at join and each respawn after
// (`playerAlive`, bzfs.cxx:3287): the rabbit, then the plugins' spawn event.
function playerSpawned(player) {
  handleRabbitSpawn(player);
  pluginEvent('bz_ePlayerSpawnEvent', () => ({
    playerID: Number(player.id), team: bzTeam(player.team), state: pluginState(player),
  }));
}

// bz_eAllowSpawn (bzfs.cxx:3227), with upstream's defaults: a plugin may hold
// a tank dead. It is told once, and kicked if the plugin says so. A BZFlag
// client asks again to spawn; a bzo tank is respawned by the server, so the
// server asks again a respawn delay later. Returns true, false, or 'kicked'.
function spawnAllowed(player) {
  const asked = pluginEvent('bz_eAllowSpawn', () => ({
    playerID: Number(player.id), team: bzTeam(player.team), handled: false, allow: true,
    kickPlayer: true, kickReason: 'Not allowed to spawn',
    message: 'You are not allowed to spawn. Please contact an administrator.',
  }));
  clearTimeout(player.spawnRetryTimer);
  if (!asked || asked.allow) {
    player.notifiedOfSpawnable = false;
    return true;
  }
  if (!player.notifiedOfSpawnable) {
    replyToPlayer(player, asked.message);
    player.notifiedOfSpawnable = true;
  }
  if (asked.kickPlayer) {
    log(`Player ${player.id} "${player.name}" kicked: ${asked.kickReason}`);
    replyToPlayer(player, asked.kickReason);
    removeFromServer(player);
    return 'kicked';
  }
  player.spawnRetryTimer = setTimeout(() => {
    if (players.get(player.id) !== player || !player.joined || player.alive) return;
    if (matchClock.gameOver || isObserverTeam(player.team)) return;
    bringBack(player);
  }, GAME_CONFIG.RESPAWN_DELAY);
  return false;
}

// A dead tank comes back, if the plugins allow it.
function bringBack(player) {
  if (spawnAllowed(player) !== true) return;
  player.respawn();
  broadcastPlayerRecord('alive', player);
}

// bzfs.cxx:3287. Spawning closes the window in which a deposed rabbit's shots
// are nobody's team kill, and takes the rabbit if the world has none.
function handleRabbitSpawn(player) {
  if (!RABBIT_SELECTION) return;
  player.wasRabbit = false;
  if (rabbitPlayerId === null) anointNewRabbit();
}
// What the live world holds, and where its real object geometry is for
// whoever needs to read it back -- `LIVE_MAP_ENTRY` (above) already hashed and
// wrote it to `MAP_CACHE_DIR`/`<hash>.json` before this line runs, so the file
// is there to open directly instead of a multi-hundred-KB single log line.
log(`${MAP_SOURCE}: obstacles/meshes/links/zones/weapons  `
  + `${OBSTACLES.length}/${OBSTACLES.filter((obs) => obs.type === 'mesh').length}`
  + `/${TELEPORTER_GRAPH.links.length}/${MAP_ZONES.length}/${WORLD_WEAPONS.length}`
  + ` at ${path.join(MAP_CACHE_DIR, `${LIVE_MAP_ENTRY.hash}.json`)}`);

let TELEPORTER_OBSTACLES_BY_INDEX = new Map();
let TELEPORTER_LINKS_BY_SOURCE_FACE = new Map();
// Both, as the shared `teleport` module reads them.
let TELEPORTER_INDEX = { teleporters: TELEPORTER_OBSTACLES_BY_INDEX, links: TELEPORTER_LINKS_BY_SOURCE_FACE };

function rebuildTeleporterRuntimeState() {
  TELEPORTER_INDEX = buildTeleporterIndex(OBSTACLES, TELEPORTER_GRAPH.links);
  TELEPORTER_OBSTACLES_BY_INDEX = TELEPORTER_INDEX.teleporters;
  TELEPORTER_LINKS_BY_SOURCE_FACE = TELEPORTER_INDEX.links;
}

rebuildTeleporterRuntimeState();







// RejoinList (RejoinList.cxx): the callsigns that left after playing, and
// when. One of them coming back inside `_rejoinTime` spawns once the rest of
// that wait has passed -- by itself, since a bzo tank spawns without a key
// press -- and is told so, in upstream's words. It is what stops quitting to
// dodge a shot. A bot this server runs comes and goes with the fill, and is
// not on it.
const rejoinList = new Map();

function rejoinTimeMs() {
  return Number.isFinite(GAME_CONFIG.REJOIN_TIME) ? GAME_CONFIG.REJOIN_TIME : GAME_CONFIG.RESPAWN_DELAY;
}

function rejoinWaitMs(callsign, now = Date.now()) {
  const limit = rejoinTimeMs();
  for (const [key, leftAt] of rejoinList) {
    if (now - leftAt >= limit) rejoinList.delete(key);
  }
  const leftAt = rejoinList.get(String(callsign || '').toLowerCase());
  return leftAt === undefined ? 0 : Math.max(0, limit - (now - leftAt));
}

// allejo's ScoreRestorer (github.com/allejo/ScoreRestorer), which many bzfs
// servers load: a player who leaves with a score has it back on rejoining
// from the same address within `_scoreSaveTime` seconds, 120 unless a world
// says otherwise (`PLUGIN_BZDB_DEFAULTS`). Keyed by lower-case callsign. An observer coming back keeps
// the record waiting, timed again from when it leaves.
const savedScores = new Map();

function scoreSaveTimeMs() {
  const seconds = Number(GAME_CONFIG.SCORE_SAVE_TIME ?? PLUGIN_BZDB_DEFAULTS._scoreSaveTime);
  return (Number.isFinite(seconds) ? seconds : 0) * 1000;
}

// A server bot's record too: its name is its slot (`getBotPlayerNumber`), so
// the bot that takes that slot next is the same bot, and its record waits for
// it however long that takes.
function saveScore(player) {
  const key = String(player.name || '').toLowerCase();
  const saved = savedScores.get(key);
  if (saved && isObserverTeam(player.team)) {
    saved.leftAt = Date.now();
  } else if (player.wins || player.losses) {
    savedScores.set(key, {
      address: player.clientIP, wins: player.wins, losses: player.losses, tks: player.tks, leftAt: Date.now(),
      ...(player.serverBot ? { serverBot: true } : {}),
    });
  }
}

// A restart for new code -- nodemon, or a Docker upgrade -- is everyone leaving
// and coming straight back, so it keeps scores the way a leave does: what is
// waiting, and everyone still connected as the process goes, written to
// `scores.json` beside `bans.json` and read back on boot. A changed map or
// changed server options start a new game instead, as a bzfs started on them
// would: the scores are kept only when this process booted on the same
// `server.json` and the same world as the one that saved them.
const SCORES_PATH = path.join(path.dirname(configPath), 'scores.json');
const BOOT_GAME_FINGERPRINT = (() => {
  const hash = crypto.createHash('sha256');
  try {
    hash.update(fs.readFileSync(configPath));
  } catch {
    hash.update('no config');
  }
  hash.update('\0');
  try {
    hash.update(RANDOM_WORLD_BZW ?? (mapPath ? fs.readFileSync(mapPath) : MAP_SOURCE));
  } catch {
    hash.update(MAP_SOURCE);
  }
  return hash.digest('hex');
})();
let scoresSavedForRestart = false;

// When each player connected, kept across a restart the same way, matched by
// callsign and address, so `/api/players` says how long somebody has been on
// rather than how long since the last restart. A connection is not a game: a
// changed map keeps it. Only taken back within `CONNECT_CARRY_MS` of the save.
const CONNECT_CARRY_MS = 5 * 60 * 1000;
const savedConnects = new Map();

function restoreConnectTime(player, now = Date.now()) {
  const key = String(player.name || '').toLowerCase();
  const saved = savedConnects.get(key);
  if (!saved) return;
  savedConnects.delete(key);
  if (now - saved.savedAt > CONNECT_CARRY_MS) return;
  if ((saved.address ?? null) !== (player.clientIP ?? null)) return;
  if (Number.isFinite(saved.connectedAt)) player.connectDate = new Date(saved.connectedAt);
}

function saveScoresForRestart() {
  if (scoresSavedForRestart) return;
  scoresSavedForRestart = true;
  const savedAt = Date.now();
  const connects = [];
  for (const player of players.values()) {
    if (!player.joined) continue;
    saveScore(player);
    if (player.connectDate) {
      connects.push({
        key: String(player.name || '').toLowerCase(),
        address: player.clientIP ?? null,
        connectedAt: player.connectDate.getTime(),
        savedAt,
      });
    }
  }
  const records = [...savedScores].map(([key, record]) => ({ key, ...record }));
  try {
    if (records.length === 0 && connects.length === 0) fs.rmSync(SCORES_PATH, { force: true });
    else fs.writeFileSync(SCORES_PATH, JSON.stringify({ game: BOOT_GAME_FINGERPRINT, records, connects }));
  } catch (err) {
    logError(`[SCORES] could not save for the restart: ${err.message}`);
  }
}

function loadScoresAfterRestart() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(SCORES_PATH, 'utf8'));
  } catch {
    return;
  }
  fs.rmSync(SCORES_PATH, { force: true });
  for (const { key, ...connect } of Array.isArray(saved?.connects) ? saved.connects : []) {
    if (typeof key === 'string' && Number.isFinite(connect.savedAt)) savedConnects.set(key, connect);
  }
  if (saved?.game !== BOOT_GAME_FINGERPRINT || !Array.isArray(saved.records)) {
    log('[SCORES] not kept: the map or the server options changed');
    return;
  }
  for (const { key, ...record } of saved.records) {
    if (typeof key === 'string' && Number.isFinite(record.leftAt)) savedScores.set(key, record);
  }
  if (savedScores.size > 0) log(`[SCORES] ${savedScores.size} kept across the restart`);
}
loadScoresAfterRestart();
process.on('exit', saveScoresForRestart);

// The record's words to say to it, or null.
function restoreScore(player, now = Date.now()) {
  const key = String(player.name || '').toLowerCase();
  const saved = savedScores.get(key);
  if (!saved) return null;
  if (scoreSaveTimeMs() <= 0 || (!saved.serverBot && saved.leftAt + scoreSaveTimeMs() <= now)) {
    savedScores.delete(key);
    return null;
  }
  if (!saved.address || saved.address !== player.clientIP) return null;
  if (isObserverTeam(player.team)) return N_('Your score record will be saved while you are in observer mode.');
  player.wins = saved.wins;
  player.losses = saved.losses;
  player.tks = saved.tks;
  savedScores.delete(key);
  return N_('Your score has been restored.');
}

// bzfs.cxx:2939: on leaving, if they ever spawned and are not already waiting.
function noteRejoinWait(player) {
  if (bots.has(player.id) || !player.hasSpawned || isObserverTeam(player.team)) return;
  if (rejoinWaitMs(player.name) > 0) return;
  rejoinList.set(String(player.name || '').toLowerCase(), Date.now());
}

// Game state
const players = new Map();
const projectiles = new Map();
let projectileIdCounter = 0;
// Minecraft-style world time: 0-23999, 0 at 6:00 and 6000 at noon, a real
// day's worth at `DAY_SPEED` 1. Read off the wall clock rather than counted, so
// it is the same for every client that asks, however the game loop is paced.
const WORLD_TICKS_PER_DAY = 24000;
const WORLD_TICKS_PER_SECOND = WORLD_TICKS_PER_DAY / 86400;
// A world's `_syncTime` (`syncedHourOfDay`) holds the sky still at the hour it
// names, as upstream holds every client's at that instant.
const syncedHour = syncedHourOfDay(GAME_CONFIG);
if (syncedHour !== null) GAME_CONFIG.DAY_SPEED = 0;
const startHour = syncedHour ?? (Number.isFinite(configTimeOfDay) && configTimeOfDay >= 0 && configTimeOfDay <= 24
  ? configTimeOfDay
  : null);
const worldTimeStart = startHour !== null
  ? ((((startHour - 6) / 24) * WORLD_TICKS_PER_DAY) + WORLD_TICKS_PER_DAY) % WORLD_TICKS_PER_DAY
  : Math.floor(Math.random() * WORLD_TICKS_PER_DAY);
const worldTimeEpoch = Date.now();
// Upstream's `_syncTime` is seconds past the Unix epoch (`updateDaylight`,
// playing.cxx:4590), and its sun stands where that instant puts it at the
// world's longitude, west positive. bzo's sky is a clock rather than an
// almanac, so this keeps the local solar hour: `-synctime`'s 1 at upstream's
// default longitude is mid-afternoon, at longitude 0 midnight. Null where the
// world lets the sky run.
function syncedHourOfDay(config) {
  if (!(config.SYNC_TIME >= 0)) return null;
  const longitude = Number.isFinite(config.LONGITUDE) ? config.LONGITUDE : 122;
  const hour = ((config.SYNC_TIME / 3600) - (longitude / 15)) % 24;
  return hour < 0 ? hour + 24 : hour;
}

function currentWorldTime(now = Date.now()) {
  const elapsed = ((now - worldTimeEpoch) / 1000) * WORLD_TICKS_PER_SECOND * GAME_CONFIG.DAY_SPEED;
  return (worldTimeStart + elapsed) % WORLD_TICKS_PER_DAY;
}

// Get next available player number
// The lowest free slot, counting from zero as upstream does: bzfs hands a
// joining player the first empty index of its player array, and that index is
// what the scoreboard shows and what an id-taking command names. bzo's ids are
// the same numbers (`server/player-ids.cjs`), so the two agree about which
// slot is which -- including through a proxy, where they are literally the
// same slot.
// Numbers held for a native BZFlag client between its handshake, which has to
// name its id, and the player that MsgEnter creates with it.
const reservedPlayerNumbers = new Set();

function getNextPlayerNumber() {
  let num = 0;
  const takenNumbers = new Set([...Array.from(players.values()).map(p => p.playerNumber), ...reservedPlayerNumbers]);
  while (takenNumbers.has(num)) {
    num++;
  }
  return num;
}

// Player class
class Player {
  constructor(ws, name = null, playerNumber = null) {
    this.playerNumber = playerNumber !== null ? playerNumber : getNextPlayerNumber();
    this.id = this.playerNumber.toString();
    this.ws = ws;
    // Always assign a default name if none provided
    this.name = name && name.trim() ? name : `Player ${this.playerNumber}`;
    // Set from the session cookie on the handshake, and from nothing else. The
    // id is kept so a login on a second device can invalidate this one; it is
    // never sent to a client. See `isAdmin` and docs/login-plan.md.
    this.sessionId = null;
    // `hasStartedToNotRespond` (PlayerInfo.cxx): unheard from past
    // `notRespondingLimitMs`, until its next move.
    this.notResponding = false;
    this.lastHeardAt = Date.now();
    this.verified = false;
    this.bzid = null;
    this.globalCallsign = null;
    // Set from the socket on the handshake: a connection from this machine on a
    // server whose `localAdmin` is on. See isLocalAdminRequest for why it is not
    // simply "the peer is loopback".
    this.localAdmin = false;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.azimuth = 0;
    this.alive = false;
    // When each shot slot comes back, as an epoch time per slot. Upstream's
    // `shots[]` array with the shells left out: a slot is taken when it is
    // fired and comes back on its own reload, and a shell that stops early
    // never hands one back. See `findFreeShotSlot` in `server/shots.cjs`.
    this.shotSlotFreeAt = [];
    this.lastUpdate = Date.now();
    // The client's own clock (`message.ct`, seconds relative to that client's
    // own origin -- never an absolute time) as of the last *accepted* move,
    // null until one arrives. Paired with `lastUpdate` rather than derived
    // from `sdt`, so a move refused in strict mode (which leaves both fields
    // where they were) does not throw off the next accepted move's own
    // interval the way summing consecutive `sdt`s across a gap would. See
    // docs/lag-plan.md, "Extrapolate on the client's clock, not ours".
    this.lastClientTimestamp = null;
    // LagInfo (`src/game/LagInfo.cxx`): the round trip, how steady the sending
    // is, and how many pings went unanswered. Measured for every connection,
    // whether or not anybody asks for it, because an average is only worth
    // reading if it has been running.
    this.lag = createLagTracker();
    this.wins = 0;
    this.losses = 0;
    this.tks = 0;
    this.paused = false;
    this.pauseCountdownStart = 0;
    this.pauseTimer = null;
    this.pauseDropTimer = null;
    // Roger has the controls (`Player::autoPilot`). The client drives; the
    // server only says so to everyone else.
    this.autopilot = false;
    // Who is flying, shown as the motto meanwhile, and the motto it stands in
    // for.
    this.autopilotName = null;
    this.savedMotto = null;
    // Joined as a robot tank, upstream's `ComputerPlayer` (`PlayerInfo::isBot`).
    // Declared at join and never changed; autopilot does not make a bot.
    this.bot = false;
    // What the `T` column says this player is playing on
    // (server/client-type.cjs): a headset's browser, from the handshake; a
    // phone, from the join; and an XR session, for as long as one is open.
    this.headset = false;
    this.mobile = false;
    this.xr = false;
    this.verticalVelocity = 0;
    this.isJumping = false;
    this.lastJumpTime = 0;
    this.onObstacle = false;
    this.connectDate = new Date();
    this.tankModel = 'bzflag';
    this.skin = DEFAULT_TANK_SKIN;
    // A tagline the player writes for themselves, drawn beside their name on
    // the scoreboard. Upstream's `motto`, which is why it travels under that
    // name to a proxied target (`proxyMotto`) and arrives under it from one
    // (`decodeAddPlayer`).
    this.motto = '';
    // Teams are server-authoritative. Observer is receive-only and non-combatant.
    this.team = 'rogue';
    // A team asked for with `setTeam`, taken at the next spawn.
    this.nextTeam = null;
    // Set on a Map Viewer join (issue #68), cleared on any other -- see
    // `getState()`.
    this.viewMap = null;
    this.color = getInitialPlayerColor(TEAM_MODE, this.team, (team) => Player.pickDistinctColor(team));
    this.joined = false;
    // PlayerInfo::wasRabbit (PlayerInfo.h:204). Set when this player is deposed as
    // the rabbit and cleared on its next spawn. In that window its shots are
    // nobody's team kill, which is the whole of Rabbit Chase's exception to
    // hunters being team mates -- see isARabbitKill.
    this.wasRabbit = false;
    // PlayerAccessInfo's `talk` permission, revoked (BanCommands.cxx:215). A
    // muted player may still run commands and still hears everyone; only what
    // they say is dropped. It lasts the session, as upstream's does without a
    // ban file behind it.
    this.muted = false;
    // The address `/playerlist` reports, set from the handshake.
    this.clientIP = null;
    // PlayerInfo::restartOnBase. Set for every CTF spawn and after a capture.
    this.restartOnBase = false;
    // LocalPlayer::target, which upstream keeps on the shooter's own client and
    // bzo keeps here: the id of the tank this player has locked a guided missile
    // onto, or null. Every missile this player has in the air steers at it, as
    // upstream's every missile reads `myTank->getTarget()` afresh each frame --
    // which is the whole of "can lock on or retarget after firing".
    this.lockTargetId = null;
    // LocalPlayer::flagShakingWins, kept here because bzo's server owns the
    // score. Wins still owed before the bad flag in hand falls off; zero
    // whenever the switch is off or there is no bad flag.
    this.flagShakeWins = 0;
    // LocalPlayer::flagAntidotePos. Where this player's antidote flag stands
    // while they carry a bad flag, or null. Upstream's client picks its own; see
    // armBadFlagRelease for why bzo's server picks it instead.
    this.antidote = null;
    this.voiceMicEnabled = false;
    this.voiceChannel = DEFAULT_VOICE_CHANNEL;
    this.voiceRosterSignature = '';

    // Extrapolation state
    this.forwardSpeed = 0;
    this.rotationSpeed = 0;
    this.jumpAzimuth = null;
    this.slideAzimuth = undefined;
    this.airVelocityX = 0;
    this.airVelocityY = 0;
    this.teleportReentryBlockTeleporterIndex = null;
    this.teleportReentryBlockDistance = 0;
    this.teleportReentryBlockUntil = 0;
    this.teleportCooldownUntil = 0;

    // Keep-alive tracking
    this.lastPongTime = Date.now();
    this.isAlive = true;

    // Anti-cheat tracking
    this.cheatWarnings = {
      linearDrift: 0,
      angularDrift: 0,
      collision: 0,
      movedWhilePaused: 0,
      speedClamped: 0,
      shotRejected: 0,
      jumpRejected: 0,
      flagRejected: 0,
      totalWarnings: 0,
      lastWarningTime: 0,
    };
  }

  static colorIntToRgb(color) {
    return {
      r: (color >> 16) & 0xff,
      g: (color >> 8) & 0xff,
      b: color & 0xff
    };
  }

  static hslToRgb(h, s, l) {
    s /= 100;
    l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(Math.min(k(n) - 3, 9 - k(n)), 1));
    return {
      r: Math.round(255 * f(0)),
      g: Math.round(255 * f(8)),
      b: Math.round(255 * f(4))
    };
  }

  static rgbToColorInt({ r, g, b }) {
    return (r << 16) | (g << 8) | b;
  }

  static rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const light = (max + min) / 2;
    const delta = max - min;

    if (delta === 0) {
      return { hue: 0, sat: 0, light: light * 100 };
    }

    const sat = delta / (1 - Math.abs(2 * light - 1));
    let hue;
    switch (max) {
      case rn:
        hue = 60 * (((gn - bn) / delta) % 6);
        break;
      case gn:
        hue = 60 * ((bn - rn) / delta + 2);
        break;
      default:
        hue = 60 * ((rn - gn) / delta + 4);
        break;
    }
    if (hue < 0) hue += 360;
    return { hue, sat: sat * 100, light: light * 100 };
  }

  static hueDistance(a, b) {
    const diff = Math.abs(a - b) % 360;
    return Math.min(diff, 360 - diff);
  }

  static scoreCandidateColor(candidate, existingColors) {
    if (existingColors.length === 0) {
      return Number.POSITIVE_INFINITY;
    }

    let minScore = Number.POSITIVE_INFINITY;
    for (const existing of existingColors) {
      const dr = candidate.rgb.r - existing.rgb.r;
      const dg = candidate.rgb.g - existing.rgb.g;
      const db = candidate.rgb.b - existing.rgb.b;
      const rgbDistanceSq = dr * dr + dg * dg + db * db;
      const hueDistance = Player.hueDistance(candidate.hue, existing.hue);
      const satDistance = Math.abs(candidate.sat - existing.sat);
      const lightDistance = Math.abs(candidate.light - existing.light);
      const separationScore = rgbDistanceSq + hueDistance * 64 + satDistance * 12 + lightDistance * 10;
      if (separationScore < minScore) {
        minScore = separationScore;
      }
    }
    return minScore;
  }

  // Pick a pastel-ish color that is as far as practical from current players.
  // Without a team, the whole wheel: every player gets a colour of their own.
  // With one, a band around the team's colour and only team mates to stay clear
  // of, so a red tank is still unmistakably red. See getInitialPlayerColor in
  // server/teams.cjs for why bzo does this and upstream does not.
  //
  // Nothing is rebalanced when a player leaves. The gap they free is the one the
  // next joiner is most likely to take, and a tank that changed colour mid-match
  // would undo the only thing the shade is for. A restart starts over, which is
  // a new set of players to learn in any case.
  static pickDistinctColor(team = null, exclude = null) {
    const teamColor = team === null || team === undefined
      ? null
      : getPlayerTeamColor(team);
    // A team with no colour to shade -- observer's white -- keeps it as it is.
    const teamHsl = Number.isFinite(teamColor)
      ? (() => {
        const rgb = Player.colorIntToRgb(teamColor);
        return Player.rgbToHsl(rgb.r, rgb.g, rgb.b);
      })()
      : null;
    if (teamHsl && teamHsl.sat < TEAM_SHADE_MIN_SATURATION) return teamColor;

    const existingColors = Array.from(players.values())
      .filter((player) => player !== exclude)
      // Team mates are the only ones worth staying clear of: a red tank has no
      // reason to avoid looking like a particular blue one.
      .filter((player) => (teamHsl ? player.team === team : true))
      .map((player) => player.color)
      .filter((color) => Number.isFinite(color))
      .map((color) => {
        const rgb = Player.colorIntToRgb(color);
        const hsl = Player.rgbToHsl(rgb.r, rgb.g, rgb.b);
        return {
          rgb,
          hue: hsl.hue,
          sat: hsl.sat,
          light: hsl.light
        };
      });

    const clampPercent = (value) => Math.max(0, Math.min(100, value));
    const hues = [];
    const saturationOptions = [];
    const lightnessOptions = [];
    let hueStep;
    if (teamHsl) {
      hueStep = TEAM_SHADE_HUE_STEP;
      for (let offset = -TEAM_SHADE_HUE_SPREAD; offset <= TEAM_SHADE_HUE_SPREAD; offset += hueStep) {
        hues.push((teamHsl.hue + offset + 360) % 360);
      }
      // The team colours are fully saturated already, so saturation only has
      // room downwards; lightness has room both ways.
      for (const offset of [0, -TEAM_SHADE_SAT_SPREAD, -2 * TEAM_SHADE_SAT_SPREAD]) {
        saturationOptions.push(clampPercent(teamHsl.sat + offset));
      }
      for (const offset of [0, -TEAM_SHADE_LIGHT_SPREAD, TEAM_SHADE_LIGHT_SPREAD]) {
        lightnessOptions.push(clampPercent(teamHsl.light + offset));
      }
    } else {
      hueStep = 12;
      for (let hue = 0; hue < 360; hue += hueStep) hues.push(hue);
      saturationOptions.push(58, 66, 74);
      lightnessOptions.push(58, 64, 70);
    }

    const scoredCandidates = [];
    let bestScore = -1;

    for (const hue of hues) {
      for (const sat of saturationOptions) {
        for (const light of lightnessOptions) {
          const rgb = Player.hslToRgb(hue, sat, light);
          const candidate = { hue, sat, light, rgb };
          const score = Player.scoreCandidateColor(candidate, existingColors);
          scoredCandidates.push({ candidate, score });
          if (score > bestScore) {
            bestScore = score;
          }
        }
      }
    }

    if (scoredCandidates.length === 0) {
      if (teamHsl) return teamColor;
      const fallbackRgb = Player.hslToRgb(Math.floor(Math.random() * 360), 66, 64);
      return Player.rgbToColorInt(fallbackRgb);
    }

    const scoreThreshold = bestScore * 0.72;
    const topCandidates = scoredCandidates
      .filter(({ score }) => score >= scoreThreshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, 28);
    const chosen = topCandidates[Math.floor(Math.random() * topCandidates.length)] || scoredCandidates[0];
    return Player.rgbToColorInt(chosen.candidate.rgb);
  }

  respawn() {
    // A pause belongs to the life it was taken in. playing.cxx:6867 abandons a
    // countdown the moment the tank stops being alive, and a tank that comes
    // back from an explosion comes back playing.
    clearPauseTimers(this);
    this.paused = false;
    this.pauseCountdownStart = 0;
    // PlayerInfo::setAlive (PlayerInfo.cxx:110): a team asked for in the last
    // life is taken as the next one starts, before it picks where to spawn.
    if (this.nextTeam) changePlayerTeam(this, this.nextTeam);
    const spawnPos = getSpawnPosition(this);
    this.x = spawnPos.x;
    this.y = spawnPos.y;
    this.z = spawnPos.z;
    this.azimuth = spawnPos.azimuth;
    this.alive = true;
    this.hasSpawned = true;
    // A new life is heard from as it starts; its first move comes after.
    this.lastHeardAt = Date.now();
    this.notResponding = false;
    // `LocalPlayer::restart` (LocalPlayer.cxx:1052) deletes every shot the tank
    // had, so a tank that comes back comes back loaded. The life that fired
    // them is over; nothing is left in the air to hold a slot.
    this.shotSlotFreeAt = [];
    this.verticalVelocity = 0;
    this.isJumping = false;
    this.onObstacle = false;
    this.jumpAzimuth = null;
    this.slideAzimuth = undefined;
    this.forwardSpeed = 0;
    this.rotationSpeed = 0;
    this.airVelocityX = 0;
    this.airVelocityY = 0;
    this.teleportReentryBlockTeleporterIndex = null;
    this.teleportReentryBlockDistance = 0;
    this.teleportReentryBlockUntil = 0;
    this.teleportCooldownUntil = 0;
    playerSpawned(this);
  }

  // `forAdmin` adds the fields only an admin may see. It is the recipient's
  // permission, not the subject's, so the same player's record is two different
  // objects depending on who is being told about them -- which is why every
  // roster broadcast goes through `broadcastPlayerRecord` rather than
  // `broadcastAll`.
  getState(forAdmin = false) {
    const state = {
      id: this.id,
      name: this.name,
      x: this.x,
      y: this.y,
      z: this.z,
      azimuth: this.azimuth,
      alive: this.alive,
      wins: this.wins,
      losses: this.losses,
      tks: this.tks,
      paused: this.paused,
      notResponding: this.notResponding,
      autopilot: this.autopilot,
      bot: this.bot,
      clientType: playerClientType(this),
      link: playerLink(this),
      forwardSpeed: this.forwardSpeed,
      rotationSpeed: this.rotationSpeed,
      verticalVelocity: this.verticalVelocity,
      jumpAzimuth: this.jumpAzimuth,
      slideAzimuth: this.slideAzimuth,
      airVelocityX: this.airVelocityX,
      airVelocityY: this.airVelocityY,

      connectDate: this.connectDate ? this.connectDate.toISOString() : undefined,
      color: this.color,
      tankModel: this.tankModel,
      skin: this.skin,
      motto: this.motto,
      team: this.team,
      voiceMicEnabled: this.voiceMicEnabled,
      voiceChannel: this.voiceChannel,
      // Whether this player may speak on the admin channel and operate the
      // server. Sent rather than derived so the rule has one home -- see
      // `isAdmin` -- and so a client greying out a button is reading an answer
      // rather than keeping a second copy of the question.
      admin: isAdmin(this),
      // Authenticated with a bzflag.org global callsign. Upstream carries this
      // as one of three booleans in `MsgPlayerInfo` -- registered, verified,
      // admin -- which the client turns into the `-`, `+` and `@` it draws
      // beside a callsign (`ScoreboardRenderer.cxx:718`). bzo never reaches
      // `registered`: it learns nothing about a callsign unless a token
      // verifies, and a verified token means registered as well.
      verified: this.verified,
      // The name a verified session forces the join to. `name` itself does
      // not become this until `resolveJoinName` runs at join time, so the
      // entry dialog needs its own field to lock its name input to before
      // that -- see issue #75.
      globalCallsign: this.globalCallsign ?? null,
      teleportCooldownUntil: this.teleportCooldownUntil,
      // The map a Map Viewer chose (issue #68), null for everyone else -- the
      // roster's business is only which file, since the hash/url to render it
      // is already public in `init.viewableMaps`.
      viewMap: this.viewMap ?? null,
    };
    // The forum account behind a verified callsign, for the scoreboard's
    // admin-only BZID column. Upstream's scoreboard has no such column -- it
    // shows the slot number to an admin and nothing else -- but bzo's admins
    // already read a BZID off the list-server account page, and a name is the
    // one thing a player can change between sessions.
    if (forAdmin) state.bzid = this.bzid ?? null;
    return state;
  }

  /**
   * Get extrapolated position at a specific time based on last known state.
   * @param {number} atTime - Timestamp (ms) to extrapolate to
   * @param {number|null} dtOverrideSeconds - Use this interval instead of
   *   `atTime - lastUpdate`. `validateMovement` passes the client's own
   *   clamped interval here (see docs/lag-plan.md, "Extrapolate on the
   *   client's clock, not ours"); every other caller extrapolates as of the
   *   server's own clock and leaves this null.
   * @returns {{x: number, y: number, z: number, r: number}}
   */
  getExtrapolatedPosition(atTime, dtOverrideSeconds = null) {
    const dt = Number.isFinite(dtOverrideSeconds)
      ? dtOverrideSeconds
      : (atTime - this.lastUpdate) / 1000; // Convert to seconds
    if (dt <= 0 || this.paused) return { x: this.x, y: this.y, z: this.z, azimuth: this.azimuth };

    const rotSpeed = GAME_CONFIG.TANK_ROTATION_SPEED || 1.5;
    const speed = GAME_CONFIG.TANK_SPEED || 15;

    const isInAir = this.jumpAzimuth !== null && this.jumpAzimuth !== undefined;
    if (isInAir) {
      // A tank in the air coasts: its air velocity, or its jump's speed along
      // the direction it left on, and gravity on the way.
      const hasAirVelocity = Number.isFinite(this.airVelocityX) && Number.isFinite(this.airVelocityY);
      const moveAzimuth = this.slideAzimuth !== undefined ? this.slideAzimuth : this.jumpAzimuth;
      const dx = hasAirVelocity ? this.airVelocityX * dt : Math.cos(moveAzimuth) * this.forwardSpeed * speed * dt;
      const dy = hasAirVelocity ? this.airVelocityY * dt : Math.sin(moveAzimuth) * this.forwardSpeed * speed * dt;
      const gravity = hasAirControl(getPlayerFlag(this.id)?.type)
        ? GAME_CONFIG.WINGS_GRAVITY
        : GAME_CONFIG.GRAVITY;
      const vv = this.verticalVelocity - gravity * dt;
      const dz = (this.verticalVelocity + vv) / 2 * dt; // Average velocity over dt
      return {
        x: this.x + dx,
        y: this.y + dy,
        z: Math.max(getGroundLimit(getPlayerFlag(this.id)?.type ?? null), this.z + dz),
        azimuth: this.azimuth + this.rotationSpeed * rotSpeed * dt,
      };
    }

    const rs = this.rotationSpeed || 0;
    const fs = this.forwardSpeed || 0;
    // A tank sliding along something moves along the slide, not its heading.
    const moveAzimuth = this.slideAzimuth !== undefined ? this.slideAzimuth : this.azimuth;

    // A physics driver under the tank carries it.
    const driver = getSupportPhysicsDriver(this.x, this.y, this.z);
    const push = driver && driver.linear
      ? { x: driver.linear[0], y: driver.linear[1], z: driver.linear[2] } : null;
    const pushX = push ? push.x * dt : 0;
    const pushY = push ? push.y * dt : 0;
    const pushZ = push ? push.z * dt : 0;

    const omega = rs * rotSpeed;
    const v = fs * speed;
    if (Math.abs(rs) < 0.001) {
      return {
        x: this.x + (Math.cos(moveAzimuth) * v * dt) + pushX,
        y: this.y + (Math.sin(moveAzimuth) * v * dt) + pushY,
        z: this.z + pushZ,
        azimuth: this.azimuth + omega * dt,
      };
    }
    // Turning while driving: an arc. The heading turns at `omega` and the tank
    // travels along it, so the position is the integral of (cos, sin) of it.
    const a0 = this.azimuth;
    const a1 = this.azimuth + omega * dt;
    return {
      x: this.x + ((v / omega) * (Math.sin(a1) - Math.sin(a0))) + pushX,
      y: this.y + ((v / omega) * (Math.cos(a0) - Math.cos(a1))) + pushY,
      z: this.z + pushZ,
      azimuth: this.azimuth + omega * dt,
    };
  }
}

// A bzfs vec3 as a point.
function vec3Point(v) {
  return { x: v[0], y: v[1], z: v[2] };
}


// A shot's position, velocity and beam as `shotBegin` carries them.
function wireShot(proj) {
  return {
    x: proj.x,
    y: proj.y,
    z: proj.z,
    ...firedVelocity(proj),
    segments: proj.segments,
  };
}


function firedVelocity(proj) {
  const effects = getShotEffects(proj.flag);
  const speed = effects.shockwave ? 0
    : (effects.guided ? GAME_CONFIG.SHOT_SPEED : proj.speed / effects.velocityFactor);
  return {
    vx: proj.dirX * speed,
    vy: proj.dirY * speed,
    vz: proj.dirZ * speed,
  };
}

class Projectile {
  constructor(id, playerId, shotSlot, x, y, z, dirX, dirY, dirZ = 0, flag = null, now = Date.now(), speed = null) {
    this.id = id;
    this.playerId = playerId;
    this.shotSlot = shotSlot;
    // FiringInfo carries the firing flag upstream, and every shot variant reads
    // its behaviour off it. Resolved once, here, so no later step has to ask the
    // flag again -- and so a shot keeps the rules it was fired under even if the
    // shooter drops the flag while it is still in the air, which is what
    // upstream's per-shot ShotStrategy gives it for free.
    this.flag = flag;
    const effects = getShotEffects(flag);
    this.ricochet = shotRicochets(flag, GAME_CONFIG.ALL_SHOTS_RICOCHET);
    // A tank's shot carries its own speed, which its tank's velocity is part
    // of (`getShotFlight`); a world weapon has no tank, and fires at the
    // world's.
    this.speed = Number.isFinite(speed) ? speed : GAME_CONFIG.SHOT_SPEED * effects.velocityFactor;
    this.throughBuildings = effects.throughBuildings;
    // A beam does not fly: `traceShotBeam` walks its whole path when it is
    // fired and leaves it here, and the projectile is a clock from then on.
    this.beam = effects.beam;
    // A shock wave does not fly either, and has no path to walk: it sits where
    // the tank fired it and swells. `shockWaveResolved` is upstream's local
    // `endShot` after a shield saved somebody (playing.cxx:4032) -- a wave is
    // not stopped by a hit, so without it the same tank would meet the same wave
    // again on the next tick and the shield would be worth nothing.
    this.shockwave = effects.shockwave;
    this.shockWaveResolved = effects.shockwave ? new Set() : null;
    // A guided missile's heading is recomputed every step rather than fixed at
    // the muzzle, and it is inert for its first `_gmActivationTime`: the flag
    // that turns back toward a target beside its shooter must not kill the
    // shooter on the way round.
    this.guided = effects.guided;
    this.activationTime = effects.activationTime;
    // ThiefStrategy. A shot that takes the victim's flag and leaves the tank
    // alive -- so it answers to none of the rules that decide a death, and
    // `findShotPlayerHit` and `applyShotVictim` both branch on it.
    this.steals = effects.steals;
    this.points = null;
    this.bounces = 0;
    this.x = x;
    this.y = y;
    this.z = z || 2.2; // Default height if not specified (tank height + barrel height)
    this.dirX = dirX;
    this.dirY = dirY;
    this.dirZ = dirZ;
    this.createdAt = now;
    this.originX = x;
    this.originY = y;
    this.originZ = this.z;
    // GetShotLifetime (GameKeeper.cxx:401): the world's reload scaled by the
    // flag's own life factor. How long the *shell* lives, which is not how long
    // the slot that fired it is out of action -- see `getSlotReloadMs`. For an
    // ordinary shot the two are the same number, which is the coincidence the
    // pair used to be conflated on.
    this.lifetimeSeconds = getWorldReloadSeconds(GAME_CONFIG) * effects.lifeFactor;
    this.teleportReentryBlockTeleporterIndex = null;
    this.teleportReentryBlockDistance = 0;
  }
}

// Helper functions
// Returns a unique player name. If the given name is empty or taken, returns 'Player n' with the lowest available n.
// PlayerAccessInfo's `adminMessageSend` and `adminMessageReceive`, which is what
// upstream gates the admin channel on. Upstream reads them out of a permissions
// file keyed to a registered, password-checked callsign, and bzo now does the
// same thing by the same authority: **authenticated with a bzflag.org global
// callsign, and a member of at least one group named in `adminGroups`.**
//
// Both halves are required and neither is client-supplied. The session comes
// from the cookie on the WebSocket handshake and is looked up in the server's
// own store, so a forged cookie is anonymous rather than privileged; the groups
// come from what bzflag.org answered about the groups `server.json` asked
// about, so a player cannot name their own. A server that lists no
// `adminGroups` has no admins at all, and there is no way back in -- which is
// why `example-server.json` ships bzflag's own `DEVELOPERS` and `BZADMIN`
// rather than an empty list. An operator who wants nobody else's authority on
// their server empties it; an operator who never opens the file inherits
// bzflag's, which is a deliberate default and worth knowing about.
//
// A name-only gate (any name other than the default `Player <n>` placeholder
// counting as "deliberate") is deliberately not offered alongside this one:
// letting a typed name substitute for a real login would make the login
// requirement decorative.
//
// It is still checked on the server for every privileged message, so a modified
// client that draws itself the Operator panel cannot change the map.
function isAdmin(player) {
  if (!player || !player.joined) return false;
  // A connection from this machine, where the operator asked for that to count.
  // Decided once at connect because it is a property of the socket, not of a
  // session that can expire under it.
  if (player.localAdmin) return true;
  // Re-read the session rather than trusting the flag set at connect: an
  // 8 hour session can expire mid-game, and `sessions.get` is what knows.
  return isAdminSession(sessions.get(player.sessionId), ADMIN_GROUPS);
}

// The Operator panel's messages, refused for anyone who is not an admin. The
// client greys the panel out, but that is presentation: a modified client can
// draw itself whatever it likes, so every message behind it is checked here as
// well. Upstream gates the same ground on `PlayerAccessInfo`; see `isAdmin` for
// what stands in for that until bzo has a login.
//
// Returns true when the caller should stop.
function refuseNonOperator(ws, player, what) {
  if (isAdmin(player)) return false;
  log(`[OPERATOR] "${player.name}" refused ${what}: not an admin`);
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ error: 'You are not an operator on this server' }));
  }
  return true;
}

// One line of server chat to one player, which is how every command answers.
// `sendMessage(ServerPlayer, playerId, text)` upstream, and the same shape a
// map's `-srvmsg` already uses here.
// The reply in English, and with `params` its msgid beside it so a bzo client
// shows it in the player's language (`localized`); a reply with no params is
// a fixed sentence, which the client looks up whole.
function replyToPlayer(player, text, params) {
  sendToPlayer(player, {
    type: 'message',
    src: SERVER_PLAYER,
    dst: player.id,
    msgType: 'server',
    ...localized(text, params),
    ts: Date.now(),
  });
}

// `/me smiles` said as "Tim Riker smiles". Upstream reformats it in the *message*
// path rather than in commands.cxx, and says why in its own comment
// (bzfs.cxx:1490): "this is here instead of in commands.cxx to allow
// player-player/player-channel targeted messages". A command dispatcher has
// already thrown the destination away, so `/me` handled there could only ever
// reach one channel.
//
// The wire carries a *type*, not the words `/me`: upstream strips the command and
// sets `ActionMessage` (global.h:88), and bzo already had `msgType: 'action'` and
// a client that renders it as "<name> <text>". So this adds the entry point and
// nothing else -- see docs/commands-plan.md.
function deliverActionMessage(player, targetId, action) {
  const text = action.trim();
  if (text.length === 0) {
    // Upstream's sentence, which names the player because it is the only reply
    // in the set that does (bzfs.cxx:1498).
    // TRANSLATORS: /me is a command name; keep it as it is
    replyToPlayer(player, '{player}, the /me command requires an argument', { player: player.name });
    return;
  }
  deliverChatMessage(player, targetId, 'action', text);
}

// The server command table. Upstream makes each one a `ServerCommand` subclass
// carrying its name, its help and its permission (`src/bzfs/commands.cxx`); bzo
// keeps the three beside what the command does, because there is one of each and
// a class per command would be a class per line.
//
// `help` is upstream's own wording where the command is upstream's. `tier` is
// `COMMAND_TIER.OPEN` for a command anybody may run and `OPERATOR` for one
// behind `isAdmin` -- see docs/commands-plan.md for why bzo has two tiers where
// upstream has sixty permissions, and for the commands not here yet.
//
// A handler is `(player, args) => void` and answers through `replyToPlayer`.
const SERVER_COMMANDS = new Map();

function defineCommand(name, tier, help, run) {
  SERVER_COMMANDS.set(name, { name, tier, help, run });
}

// The built-in commands and the loaded plugins' together, by name. A plugin's
// takes the place of a built-in one it shares a name with, as it does when run
// (`handleServerCommand`). Upstream's `/?` and `/help` never list a plugin's
// commands; bzo's do, since Tab completes from this list too.
function allServerCommands() {
  const all = new Map(SERVER_COMMANDS);
  for (const command of plugins?.commands() ?? []) {
    all.set(command.name, {
      name: command.name,
      tier: command.operator ? COMMAND_TIER.OPERATOR : COMMAND_TIER.OPEN,
      help: command.help || `- from the ${command.plugin} plugin`,
      plugin: command.plugin,
    });
  }
  return all;
}

// CmdList (commands.cxx:467). The names only; `/<prefix>?` is what shows help.
defineCommand('/?', COMMAND_TIER.OPEN,
  '- display the list of server-side commands',
  (player) => {
    const names = [...allServerCommands().values()]
      .filter((command) => canRunCommand(player, command))
      .map((command) => command.name);
    for (const line of formatCommandList(names)) replyToPlayer(player, line);
  });

// HelpCommand (commands.cxx:2328) pages the help *files* named by `-helpmsg`,
// which docs/bzw.md already lists as not read -- so there are no pages here to
// list. bzo answers with the thing it does have: every command it will let this
// player run, with upstream's one line of help each. `/<prefix>?` narrows it,
// which is upstream's CmdHelp and the only per-command help either of us has.
defineCommand('/help', COMMAND_TIER.OPEN,
  '- display the commands you may run, with what each one does',
  (player) => {
    replyToPlayer(player, 'Commands (use /<command>? for one of them):');
    for (const command of [...allServerCommands().values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!canRunCommand(player, command)) continue;
      replyToPlayer(player, `${command.name} ${command.help}`);
    }
  });

// Listed so `/?` and `/help` find it, and reachable here as well -- the message
// path catches `/me` first and keeps the destination, and this is what it would
// mean without one. Not upstream's, which has no ServerCommand for `/me` at all
// and so never lists it.
defineCommand('/me', COMMAND_TIER.OPEN,
  '<action> - say something as an action: "/me smiles" reads as "<name> smiles"',
  (player, args) => deliverActionMessage(player, 0, args));

// RecordCommand (commands.cxx:3604), worded as upstream's. The buffer is on
// from boot, as `-recbuf` would have it, so `/record save` keeps a game
// after it happens. `/record file` marks where the file starts and writes it
// at `/record stop`, out of the same buffer, so it is only as long as the
// buffer holds; upstream streams it to disk as it goes.
const RECORD_USAGE = Object.freeze([
  'usage:',
  '  /record start',
  '  /record stop',
  '  /record size <Mbytes>',
  '  /record rate <seconds>',
  '  /record stats',
  '  /record save <filename> [seconds]',
  '  /record file <filename>',
  '  /record list [-t | -n | --] [pattern]',
]);

// A file name as `/record` takes one: the replay's name, `.rec` optional.
function recordingName(text) {
  const name = String(text || '').trim().replace(/\.rec$/i, '');
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(name) ? name : null;
}

defineCommand('/record', COMMAND_TIER.OPERATOR,
  '[start|stop|size|list|rate..] - manage the bzflag record system',
  async (player, args) => {
    const [sub = '', ...rest] = args.trim().split(/\s+/);
    const word = sub.toLowerCase();
    if (word === 'start') {
      recorder.start();
      replyToPlayer(player, 'Recording started');
    } else if (word === 'stop') {
      if (recordFile) {
        const { name, from } = recordFile;
        recordFile = null;
        try {
          await saveRecording(name, { from, callsign: player.name });
        } catch (error) {
          replyToPlayer(player, 'Could not open for writing: {name} ({error})', { name, error: error.message });
        }
      }
      recorder.stop();
      replyToPlayer(player, 'Recording stopped');
    } else if (word === 'size') {
      const mbytes = Number.parseInt(rest[0], 10);
      if (!Number.isFinite(mbytes) || mbytes < 1) {
        for (const line of RECORD_USAGE) replyToPlayer(player, line);
        return;
      }
      recorder.setMaxBytes(mbytes * 1024 * 1024);
      replyToPlayer(player, 'Record size set to {mbytes}', { mbytes });
    } else if (word === 'rate') {
      const seconds = Number.parseInt(rest[0], 10);
      if (!Number.isFinite(seconds) || seconds < 1) {
        for (const line of RECORD_USAGE) replyToPlayer(player, line);
        return;
      }
      recorder.setRateMs(seconds * 1000);
      replyToPlayer(player, 'Record rate set to {seconds}', { seconds });
    } else if (word === 'stats') {
      const stats = recorder.stats();
      if (!stats.recording) {
        replyToPlayer(player, 'Not Recording');
        return;
      }
      if (recordFile) {
        replyToPlayer(player, 'Filename:  {name}', { name: recordFile.name });
        replyToPlayer(player, '   saved:  {bytes} bytes / {packets} packets / {seconds} seconds', {
          bytes: stats.bytes,
          packets: stats.entries,
          seconds: ((Date.now() - recordFile.from) / 1000).toFixed(1),
        });
      } else {
        replyToPlayer(player, 'Buffered:  {bytes} bytes / {packets} packets / {seconds} seconds', {
          bytes: stats.bytes,
          packets: stats.entries,
          seconds: stats.seconds.toFixed(1),
        });
      }
    } else if (word === 'save') {
      const name = recordingName(rest[0]);
      if (!name) {
        for (const line of RECORD_USAGE) replyToPlayer(player, line);
        return;
      }
      const seconds = rest[1] === undefined ? null : Number.parseInt(rest[1], 10);
      if (!recorder.recording || recorder.entries.length === 0) {
        replyToPlayer(player, 'No buffer to save');
        return;
      }
      try {
        await saveRecording(name, { seconds, callsign: player.name });
        replyToPlayer(player, 'Record buffer saved to: {name}', { name });
        log(`[CMD] "${player.name}" saved recording ${name}`);
      } catch (error) {
        replyToPlayer(player, 'Could not open for writing: {name} ({error})', { name, error: error.message });
      }
    } else if (word === 'file') {
      const name = recordingName(rest[0]);
      if (!name) {
        for (const line of RECORD_USAGE) replyToPlayer(player, line);
        return;
      }
      recorder.start();
      recorder.takeSnapshot();
      recordFile = { name, from: Date.now() };
      replyToPlayer(player, 'Recording to file: {name}', { name });
    } else if (word === 'list') {
      const lines = fileListLines(await replayFileList(), args.trim().slice(4), 'replays/');
      for (const line of lines || RECORD_USAGE) replyToPlayer(player, line);
    } else {
      for (const line of RECORD_USAGE) replyToPlayer(player, line);
    }
  });

// UpTimeCommand (commands.cxx:1015). Upstream appends a full stop, which is the
// only punctuation in any of these replies and is kept for that reason.
defineCommand('/uptime', COMMAND_TIER.OPEN,
  "- show the server's uptime",
  (player) => {
    replyToPlayer(player, `${formatDuration((Date.now() - SERVER_START_TIME) / 1000)}.`);
  });

// ServerQueryCommand (commands.cxx:1000) answers "BZFS Version: <version>",
// in its words so a tool that reads the line still can; the version is
// `BZO_APP_VERSION`, which says it is bzo.
defineCommand('/serverquery', COMMAND_TIER.OPEN,
  '- show the server version',
  (player) => {
    replyToPlayer(player, 'BZFS Version: {version}', { version: BZO_APP_VERSION });
  });

// DateCommand and TimeCommand (commands.cxx:418) are one implementation under
// two names, both sending `ctime()` cut to 24 characters. Upstream gates them on
// a `date` permission; bzo does not, because the server's clock is not a secret
// and a permission per command is the model docs/commands-plan.md declines.
for (const name of ['/date', '/time']) {
  defineCommand(name, COMMAND_TIER.OPEN,
    "- show the server's date and time",
    (player) => replyToPlayer(player, formatCTime(new Date())));
}

// LagStatCommand (commands.cxx:1958). Open to everyone, as upstream's is
// (`nonAdminModes`, ServerCommandKey.cxx:24): who is lagging is not a secret,
// and it is the answer to half the complaints a game produces. An operator also
// gets the slot number, which is the only part upstream gates.
//
// Observers get a lag figure and nothing else -- they send no moves, so there
// is no interval to measure jitter from. A connection that has not answered a
// ping yet says so rather than reporting zero, which would read as perfect.
defineCommand('/lagstats', COMMAND_TIER.OPEN,
  '- show each player\'s lag and jitter',
  (player) => {
    const now = Date.now();
    const showIndex = isAdmin(player);
    const rows = [...players.values()]
      .filter((other) => other.joined)
      .map((other) => ({
        callsign: other.name,
        index: other.id,
        observer: isObserverTeam(other.team),
        measured: other.lag.hasSamples(),
        lag: other.lag.getLag(now),
        jitter: other.lag.getJitter(),
        loss: other.lag.getLoss(),
      }));
    if (rows.length === 0) {
      replyToPlayer(player, 'Nobody is here');
      return;
    }
    for (const row of rows.sort(compareByLag)) {
      replyToPlayer(player, formatLagStats({ ...row, showIndex }));
    }
    // The server's own share of everyone's lag, over the last PERF_LOG window.
    if (showIndex && lastServerStats) replyToPlayer(player, 'server: {stats}', { stats: formatServerStats(lastServerStats) });
  });

// Between playing teams, in place: the tank keeps whatever life it has, drops
// its flag, and takes the new team's colour. A browser rebuilds the tank from
// the record; a BZFlag client is sent its own MsgAddPlayer again, which a 2.4
// client answers by taking the team (`enteringServer`, playing.cxx:5058) -- see
// server/bzflag-native.cjs. `/setteam` calls it at once, and a player's own
// `setTeam` at their next spawn, as upstream's `changeTeam` (bzfs.cxx, master)
// does with `setNextTeam`.
function changePlayerTeam(subject, team) {
  const from = subject.team;
  subject.nextTeam = null;
  if (from === team) return;
  dropPlayerFlag(subject.id);
  // bzfs.cxx:2478 and :2966: a team's flag follows its population.
  const arrivingFirst = isColorTeam(team) && isTeamEmpty(getTeamColorIndex(team));
  subject.team = team;
  const color = getJoinPlayerColor(TEAM_MODE, team, from, (t) => Player.pickDistinctColor(t, subject));
  if (color !== null) subject.color = color;
  if (arrivingFirst) resetTeamFlags(getTeamColorIndex(team));
  if (isColorTeam(from)) retireTeamFlags(getTeamColorIndex(from));
  broadcastPlayerRecord('playerUpdated', subject);
  broadcastTeamScores();
  log(`Player ${subject.id} "${subject.name}" team ${from} -> ${team}`);
}

// The teams a tank may move between without a rejoin: not observer, which has
// no tank, and not Rabbit Chase's, which the server hands out.
function isSwitchableTeam(team) {
  return TEAM_MODE.teams.includes(team) && !isObserverTeam(team) && !isRabbitTeam(team)
    && team !== PLAYER_TEAM.HUNTER;
}

// `/setteam`, bzo's own: upstream 2.4 has no team change but a rejoin, and
// 2.5's MsgSetTeam is the client asking for itself (`setTeam` below).
defineCommand('/setteam', COMMAND_TIER.OPERATOR,
  '<#slot|PlayerName|"Player Name"> <team> - move a player to another team',
  (player, args) => {
    const target = resolveCommandTarget(args.trim());
    if (!target.id) {
      if (target.error) replyToPlayer(player, target.error);
      else replyToPlayer(player, 'Usage: /setteam <#slot|PlayerName> <team>');
      return;
    }
    const subject = players.get(target.id);
    const team = String(target.rest || '').trim().toLowerCase();
    if (!isSwitchableTeam(team)) {
      // TRANSLATORS: /setteam is a command name and {teams} lists team names as typed
      replyToPlayer(player, 'Usage: /setteam <#slot|PlayerName> <team> -- one of {teams}', {
        teams: TEAM_MODE.teams.filter(isSwitchableTeam).join(', '),
      });
      return;
    }
    if (!subject?.joined || !isSwitchableTeam(subject.team)) {
      replyToPlayer(player, '"{player}" is not on a team to move from', { player: subject?.name });
      return;
    }
    if (subject.team === team) {
      replyToPlayer(player, '"{player}" is already {team}', { player: subject.name, team: { msgid: team } });
      return;
    }
    const from = subject.team;
    changePlayerTeam(subject, team);
    log(`[CMD] "${player.name}" moved "${subject.name}" from ${from} to ${team}`);
    replyToPlayer(player, '"{player}" moved to {team}', { player: subject.name, team: { msgid: team } });
    if (subject !== player) replyToPlayer(subject, '@{player} moved you to {team}', { player: player.name, team: { msgid: team } });
  });

// `/mv` on an observer moves its roaming camera there, in free roam, with the
// pitch when one was given (public/js/roam.mjs). A camera flies through buildings,
// so the spot is taken as it is; no height means the ground. Nobody else draws
// an observer, so only the observer is told.
function moveObserverCamera(player, subject, parsed) {
  subject.x = parsed.x;
  subject.y = parsed.y;
  subject.z = parsed.z === null ? 0 : parsed.z;
  if (parsed.azimuth !== null) subject.azimuth = parsed.azimuth;
  sendToPlayer(subject, {
    type: 'positionCorrection',
    x: subject.x, y: subject.y, z: subject.z, a: subject.azimuth, vv: 0,
    moved: true,
    ...(parsed.pitch === undefined ? {} : { pitch: parsed.pitch }),
  });
  const tilt = parsed.pitch === undefined ? '' : ` pitch ${((parsed.pitch * 180) / Math.PI).toFixed(1)}`;
  const position = `${subject.x.toFixed(1)},${subject.y.toFixed(1)},${subject.z.toFixed(1)}`;
  const bearing = `${azimuthToBearingName(subject.azimuth)}${tilt}`;
  log(`[CMD] "${player.name}" moved "${subject.name}" to ${position} facing ${bearing}`);
  reportMove(player, subject, position, bearing);
}

// What `/mv` answers, the mover and the moved: `bearing` is a compass point,
// with an observer's pitch after it.
function reportMove(player, subject, position, bearing) {
  if (subject === player) {
    replyToPlayer(player, 'Moved to {position} facing {bearing}', { position, bearing });
    return;
  }
  replyToPlayer(player, '"{player}" moved to {position} facing {bearing}', { player: subject.name, position, bearing });
  replyToPlayer(subject, '@{player} moved you to {position} facing {bearing}', { player: player.name, position, bearing });
}

// MsgCommand (commands.cxx:916). The same private message the client can already
// send by picking a name in the chat entry, reachable by typing -- which is what
// makes it worth having: a script can send one, and so can a player who knows
// the callsign but does not want to open the dropdown.
defineCommand('/msg', COMMAND_TIER.OPEN,
  '<nick> text - Send text message to nick',
  (player, args) => {
    const parsed = parseMsgCommand(args, resolveCallsign, { ADMIN: -3, TEAM: -2 });
    if (parsed.error) {
      replyToPlayer(player, parsed.error);
      if (parsed.alsoUsage) replyToPlayer(player, 'Usage: /msg "some callsign" some message');
      return;
    }
    // Routed through the one function the `message` handler uses, so a typed
    // message and a picked one cannot behave differently -- and so the admin
    // channel's own permission check still applies to `/msg >admin`.
    deliverChatMessage(player, parsed.to, 'chat', parsed.text);
  });

// A callsign to a player id, case-insensitively, or null. Only players who have
// joined: an unjoined connection carries a placeholder name and is in nobody's
// roster, so it is not a thing any command can name. Every command that takes a
// callsign asks this, `/msg` included -- two copies of it would be two answers
// to "is that player here".
function resolveCallsign(callsign) {
  const wanted = callsign.trim().toLowerCase();
  for (const other of players.values()) {
    if (other.joined && other.name.toLowerCase() === wanted) return other.id;
  }
  return null;
}

// Who a command means by `<#slot|PlayerName|"Player Name">`. bzo's slots are
// its player ids, so `#3` is an id and anything else is a callsign.
//
// `/msg` reaches the same lookup through `parseMsgCommand` instead, because its
// destination may also be a team or the admin channel, and an unquoted callsign
// there is walked forward to the first space that resolves -- upstream's own
// behaviour, and the reason the two parsers are separate while the lookup is
// not.
function resolveCommandTarget(args) {
  return parsePlayerTarget(
    args,
    resolveCallsign,
    (slot) => (players.has(String(slot)) && players.get(String(slot)).joined ? String(slot) : null),
  );
}

// KillCommand (BanCommands.cxx:193). Upstream kills with `SelfDestruct` and
// tells the victim who did it, which is the part worth keeping -- a tank that
// exploded for no reason it can see is a bug report.
defineCommand('/kill', COMMAND_TIER.OPERATOR,
  '<#slot|PlayerName|"Player Name"> [reason] - kill a player',
  (player, args) => {
    const target = resolveCommandTarget(args);
    if (!target.id) {
      if (target.error) replyToPlayer(player, target.error);
      else replyToPlayer(player, 'Usage: /kill <#slot|PlayerName> [reason]');
      return;
    }
    const victim = players.get(target.id);
    if (!victim || victim.team === PLAYER_TEAM.OBSERVER) {
      replyToPlayer(player, 'An observer has no tank to kill');
      return;
    }
    if (!victim.alive) {
      replyToPlayer(player, '"{player}" is already dead', { player: victim.name });
      return;
    }
    // Through the one death path, so the flag, the lock, the rabbit and the
    // respawn all happen -- see applyDeath.
    killPlayer(victim, victim, DEATH_REASON.SELF_DESTRUCT);
    log(`[CMD] "${player.name}" killed "${victim.name}"${target.rest ? `: ${target.rest}` : ''}`);
    replyToPlayer(player, '"{player}" killed', { player: victim.name });
    if (target.rest) replyToPlayer(victim, 'You were killed by an operator: {reason}', { reason: target.rest });
    else replyToPlayer(victim, 'You were killed by an operator');
  });

// Bans (BanCommands.cxx): BZID bans, kept in bans.json beside sessions.json
// so a restart keeps them, and `/kick`. Address bans come with the address
// read through `forwardedForPolicy`. server.json's `banTime` is upstream's
// `-bantime`, the minutes a `short` or `default` ban lasts.
const BANS_PATH = path.join(path.dirname(configPath), 'bans.json');
const BAN_TIME_MINUTES = Number.isFinite(serverConfig.banTime) ? serverConfig.banTime : 300;
let bansWriteTimer = null;
function writeBansSoon() {
  if (bansWriteTimer) return;
  bansWriteTimer = setTimeout(() => {
    bansWriteTimer = null;
    try {
      fs.writeFileSync(BANS_PATH, JSON.stringify(bans.serialize(), null, 2) + '\n', { mode: 0o600 });
    } catch (error) {
      logError(`Could not write bans to ${BANS_PATH}:`, error);
    }
  }, 1000);
  bansWriteTimer.unref?.();
}
const bans = createBanStore({ onChange: writeBansSoon });
try {
  if (fs.existsSync(BANS_PATH)) log(`Bans: restored ${bans.load(JSON.parse(fs.readFileSync(BANS_PATH, 'utf8')))}`);
} catch (error) {
  logError(`Could not read bans from ${BANS_PATH}, starting empty:`, error);
}

// rejectPlayer's words for a BZID ban (bzfs.cxx:2257), less the colours.
function idBanRefusal(ban) {
  return `REFUSED:${ban.reason || 'General Ban'}${ban.bannedBy ? ` by ${ban.bannedBy}` : ''}`;
}

// removePlayer with its MsgSuperKill (bzfs.cxx:2907). `rejoin: false` keeps a
// browser from reconnecting by itself, which is what makes a kick stick: it
// comes back only when its player asks, as a BZFlag client's does.
function removeFromServer(victim) {
  sendToPlayer(victim, { type: 'superKill', rejoin: false });
  try {
    victim.ws.close();
  } catch (error) {
    logError(`Could not close the connection for "${victim.name}"`, error);
  }
}

// doBanKick (BanCommands.cxx): tell the player, tell the admins, remove it.
function banKick(victim, banner, reason) {
  replyToPlayer(victim, 'You were banned from this server');
  if (reason) replyToPlayer(victim, 'Reason given: {reason}', { reason });
  announceToAdmins(null, localized('{player} banned by {admin}, reason: {reason}', {
    player: victim.name, admin: banner.name, reason,
  }));
  removeFromServer(victim);
}

defineCommand('/kick', COMMAND_TIER.OPERATOR,
  '<#slot|PlayerName|"Player Name"> <reason> - kick a player off the server',
  (player, args) => {
    const target = resolveCommandTarget(args);
    if (!target.id || !target.rest) {
      if (target.id || !args.trim()) {
        replyToPlayer(player, 'Syntax: /kick <#slot | PlayerName | "Player Name"> <reason>');
        replyToPlayer(player, '\tPlease keep in mind that reason is displayed to the user.');
      } else {
        if (target.error) replyToPlayer(player, target.error);
        else replyToPlayer(player, 'player "{player}" not found', { player: args.trim() });
      }
      return;
    }
    const victim = players.get(target.id);
    replyToPlayer(victim, 'You were kicked off the server');
    replyToPlayer(victim, 'Reason given: {reason}', { reason: target.rest });
    announceToAdmins(null, localized('{player} kicked by {admin}, reason: {reason}', {
      player: victim.name, admin: player.name, reason: target.rest,
    }));
    log(`[CMD] "${player.name}" kicked "${victim.name}": ${target.rest}`);
    removeFromServer(victim);
  });

// BanCommand (BanCommands.cxx:718): a player, whose address and BZID are
// both banned, or an address or block. Anybody on at the time whom the new
// ban covers goes too.
defineCommand('/ban', COMMAND_TIER.OPERATOR,
  '<#slot|PlayerName|"Player Name"|ip> <duration> <reason> - ban a player, IP address or IP range off the server',
  (player, args) => {
    const syntax = () => {
      replyToPlayer(player, 'Syntax: /ban <#slot | PlayerName | "Player Name" | ip> <duration> <reason>');
      replyToPlayer(player, "\t<duration> can be 'short' or 'default' for the default ban time ");
      replyToPlayer(player, "\tor 'forever' or 'max' for infinite bans ");
      replyToPlayer(player, '\tor a time in the format <weeks>W<days>D<hours>H<minutes>M ');
      replyToPlayer(player, '\tor just a number of minutes ');
      replyToPlayer(player, '\tPlease keep in mind that reason is displayed to the user.');
    };
    const trimmed = args.trim();
    const target = resolveCommandTarget(trimmed);
    const victim = target.id ? players.get(target.id) : null;
    let mask;
    let rest;
    if (victim) {
      mask = victim.clientIP;
      rest = target.rest;
    } else {
      const split = trimmed.search(/\s/);
      mask = split === -1 ? trimmed : trimmed.slice(0, split);
      rest = split === -1 ? '' : trimmed.slice(split).trim();
    }
    const split = rest.search(/\s/);
    if (!trimmed || split === -1) {
      syntax();
      return;
    }
    const minutes = parseDuration(rest.slice(0, split));
    if (minutes === null) {
      replyToPlayer(player, 'Error: invalid ban duration');
      replyToPlayer(player, 'Duration examples:  30m 1h  1d  1w  and mixing: 1w2d4h 1w2d1m');
      return;
    }
    let reason = rest.slice(split).trim();
    if (victim && !reason.includes(victim.name)) reason = `(${victim.name}) ${reason}`;
    const length = minutes < 0 ? BAN_TIME_MINUTES : minutes;
    if (victim && !mask) {
      // Behind a proxy the probe has not vouched for, a browser's address is
      // its own claim (docs/ban-plan.md): its BZID can still go.
      replyToPlayer(player, '{player} has no trusted address to ban', { player: victim.name });
    }
    if (victim) {
      banKick(victim, player, reason);
      if (victim.bzid) {
        bans.idBan(victim.bzid, { bannedBy: player.name, minutes: length, reason });
        replyToPlayer(player, 'Pattern added to the BZID banlist');
      }
      if (!mask) return;
    }
    const stored = bans.ipBan(mask, { bannedBy: player.name, minutes: length, reason });
    if (!stored) {
      replyToPlayer(player, 'Malformed address or invalid Player/Slot: {target}', { target: trimmed.split(/\s/)[0] });
      return;
    }
    log(`[CMD] "${player.name}" banned ${stored} for ${length || 'ever'} minutes: ${reason}`);
    replyToPlayer(player, 'Pattern added to the IP banlist');
    for (const other of [...players.values()]) {
      if (other !== victim && other.joined && bans.ipBanned(other.clientIP)) banKick(other, player, reason);
    }
  });

defineCommand('/unban', COMMAND_TIER.OPERATOR,
  '<ip> - remove a ip pattern from the ban list',
  (player, args) => {
    if (bans.ipUnban(args.trim())) {
      log(`[CMD] "${player.name}" lifted the ban on ${args.trim()}`);
      replyToPlayer(player, 'Removed IP pattern from the ban list');
    } else {
      replyToPlayer(player, 'No pattern removed');
    }
  });

defineCommand('/banlist', COMMAND_TIER.OPERATOR,
  '[pattern] - List the IPs currently banned from this server',
  (player, args) => {
    for (const line of bans.listIpBans(args)) replyToPlayer(player, line);
  });

defineCommand('/checkip', COMMAND_TIER.OPERATOR,
  '<ip> - check if an IP address is banned and print corresponding ban info',
  (player, args) => {
    const address = args.trim().split(/\s+/)[0];
    if (!address) {
      replyToPlayer(player, 'Syntax: /checkip <ip>');
      return;
    }
    const ban = bans.ipBanned(address);
    if (!ban) {
      replyToPlayer(player, '{address} is not banned.', { address });
      return;
    }
    replyToPlayer(player, '{address} is banned:', { address });
    for (const line of bans.ipBanLines(ban)) replyToPlayer(player, line);
  });

defineCommand('/idban', COMMAND_TIER.OPERATOR,
  '<#slot|+id|PlayerName|"Player Name"> <duration> <reason> - ban using BZID',
  (player, args) => {
    const syntax = () => {
      replyToPlayer(player, 'Syntax: /idban <#slot|+id|PlayerName|"Player Name"> <duration> <reason>');
      replyToPlayer(player, '  Please keep in mind that reason is displayed to the user.');
    };
    let bzid;
    let victim = null;
    let rest;
    const trimmed = args.trim();
    if (trimmed.startsWith('+')) {
      const split = trimmed.search(/\s/);
      bzid = split === -1 ? trimmed.slice(1) : trimmed.slice(1, split);
      rest = split === -1 ? '' : trimmed.slice(split).trim();
      if (!bzid) {
        replyToPlayer(player, 'Error: invalid id pattern');
        return;
      }
      victim = [...players.values()].find((other) => other.joined && other.bzid === bzid) || null;
    } else {
      const target = resolveCommandTarget(trimmed);
      if (!target.id) {
        if (!trimmed) syntax();
        else replyToPlayer(player, 'could not find player ({player})', { player: trimmed.split(/\s/)[0] });
        return;
      }
      victim = players.get(target.id);
      if (!victim.bzid) {
        replyToPlayer(player, 'no BZID for player ({player})', { player: victim.name });
        return;
      }
      bzid = victim.bzid;
      rest = target.rest;
    }
    const split = rest.search(/\s/);
    if (split === -1) {
      syntax();
      return;
    }
    const minutes = parseDuration(rest.slice(0, split));
    if (minutes === null) {
      replyToPlayer(player, 'Error: invalid ban duration');
      replyToPlayer(player, 'Duration examples:  30m 1h  1d  1w  and mixing: 1w2d4h 1w2d1m');
      return;
    }
    let reason = rest.slice(split).trim();
    if (victim && !reason.includes(victim.name)) reason = `(${victim.name}) ${reason}`;
    if (victim) banKick(victim, player, reason);
    bans.idBan(bzid, { bannedBy: player.name, minutes: minutes < 0 ? BAN_TIME_MINUTES : minutes, reason });
    log(`[CMD] "${player.name}" banned BZID ${bzid} for ${minutes < 0 ? BAN_TIME_MINUTES : minutes || 'ever'}`
      + ` minutes: ${reason}`);
    replyToPlayer(player, 'Pattern added to the BZID banlist');
  });

defineCommand('/idunban', COMMAND_TIER.OPERATOR,
  '<id> - remove a BZID from the ban list',
  (player, args) => {
    if (bans.idUnban(args.trim())) {
      log(`[CMD] "${player.name}" lifted the ban on BZID ${args.trim()}`);
      replyToPlayer(player, 'Removed id from the ban list');
    } else {
      replyToPlayer(player, 'No pattern removed');
    }
  });

defineCommand('/idbanlist', COMMAND_TIER.OPERATOR,
  '[pattern] - List the BZIDs currently banned from this server',
  (player, args) => {
    for (const line of bans.listIdBans(args)) replyToPlayer(player, line);
  });

// Polls (commands.cxx:3064, bzfs.cxx:7267): `/poll kick|kill|set|flagreset`,
// `/vote` and `/veto`, counted by `server/polls.cjs`. server.json's `poll`
// block takes upstream's `-poll` settings (`voteTime`, `vetoTime`,
// `votesRequired`, `votePercentage`, `voteRepeatTime`); a `voteTime` of 0
// turns polls off. `ban` waits on address bans.
const POLL_SETTINGS = { ...POLL_DEFAULTS, ...(serverConfig.poll || {}) };
const pollArbiter = POLL_SETTINGS.voteTime > 0 ? new VotingArbiter(POLL_SETTINGS) : null;
const pollAnnounced = { opening: false, closure: false, results: false, heartbeatAt: -1 };

// What upstream's default groups allow (bzfs.cxx:5960): a signed-in player
// (VERIFIED) may poll, vote, and poll a kick, a ban or a flag reset; an
// admin may do all of it, kill and set polls and the veto included.
function pollRights(player) {
  const admin = isAdmin(player);
  const known = admin || player.verified === true;
  return {
    known, poll: known, vote: known, kick: known, ban: known, flagreset: known, kill: admin, set: admin, veto: admin,
  };
}

// `message` is what `localized` returns.
function announceToAll(message) {
  broadcastAll({ type: 'message', src: SERVER_PLAYER, dst: ALL_PLAYERS, msgType: 'server', ...message, ts: Date.now() });
}

function pollUsage(player) {
  const rights = pollRights(player);
  replyToPlayer(player, 'Usage: /poll vote yes|no');
  if (rights.ban) replyToPlayer(player, '    or /poll ban playername');
  if (rights.kick) replyToPlayer(player, '    or /poll kick playername');
  if (rights.kill) replyToPlayer(player, '    or /poll kill playername');
  if (rights.set) replyToPlayer(player, '    or /poll set variable value');
  if (rights.flagreset) replyToPlayer(player, '    or /poll flagreset');
}

defineCommand('/vote', COMMAND_TIER.OPEN,
  '<yes|no> - place a vote in favor or in opposition to the poll',
  (player, args) => {
    if (!pollRights(player).vote) {
      // TRANSLATORS: /vote is a command name; keep it as it is
      replyToPlayer(player, '{player}, you are presently not authorized to run /vote', { player: player.name });
      return;
    }
    if (!pollArbiter) {
      replyToPlayer(player, 'ERROR: the poll arbiter has disappeared (this should never happen)');
      return;
    }
    if (!pollArbiter.knowsPoll()) {
      replyToPlayer(player, 'A poll is not presently in progress.  There is nothing to vote on');
      return;
    }
    const { answer, vote } = parseVoteAnswer(args);
    if (!vote) {
      if (answer) replyToPlayer(player, '{player}, you did not vote in favor or in opposition', { player: player.name });
      else replyToPlayer(player, '{player}, you did not provide a vote answer', { player: player.name });
      replyToPlayer(player, 'Usage: /vote yes|no|y|n|1|0|yea|nay|si|ja|nein|oui|non|sim|nao');
      return;
    }
    const cast = vote === 'yes' ? pollArbiter.voteYes(player.name) : pollArbiter.voteNo(player.name);
    if (cast) {
      const params = { player: player.name, action: pollArbiter.action };
      // TRANSLATORS: {action} is a /poll keyword (ban, kick, kill, set, reset), sent as typed
      if (vote === 'yes') replyToPlayer(player, '{player}, your vote in favor of the {action} has been recorded', params);
      else replyToPlayer(player, '{player}, your vote in opposition of the {action} has been recorded', params);
    } else if (pollArbiter.hasVoted(player.name)) {
      replyToPlayer(player, '{player}, you have already voted on the poll to {action} {target}', {
        player: player.name, action: pollArbiter.action, target: pollArbiter.target,
      });
    } else {
      replyToPlayer(player, '{player}, there was an error while voting on the poll to {action} {target}', {
        player: player.name, action: pollArbiter.action, target: pollArbiter.target,
      });
    }
  });

defineCommand('/veto', COMMAND_TIER.OPEN,
  '- will cancel the poll if there is one active',
  (player) => {
    if (!pollRights(player).veto) {
      // TRANSLATORS: /veto is a command name; keep it as it is
      replyToPlayer(player, '{player}, you are presently not authorized to run /veto', { player: player.name });
      return;
    }
    if (!pollArbiter) {
      replyToPlayer(player, 'ERROR: the poll arbiter has disappeared (this should never happen)');
      return;
    }
    if (!pollArbiter.knowsPoll()) {
      replyToPlayer(player, '{player}, there is presently no active poll to veto', { player: player.name });
      return;
    }
    replyToPlayer(player, '{player}, you have cancelled the poll to {action} {target}', {
      player: player.name, action: pollArbiter.action, target: pollArbiter.target,
    });
    log(`[POLL] "${player.name}" vetoed the poll to ${pollArbiter.action} ${pollArbiter.target}`);
    pollArbiter.forgetPoll();
    resetPollAnnouncements();
    announceToAll(localized('The poll was cancelled by {player}', { player: player.name }));
  });

defineCommand('/poll', COMMAND_TIER.OPEN,
  '<ban|kick|kill|set|flagreset|vote|veto> <callsign> - interact and make requests of the bzflag voting system',
  (player, args) => {
    const rights = pollRights(player);
    if (!rights.poll) {
      // TRANSLATORS: /poll is a command name; keep it as it is
      replyToPlayer(player, '{player}, you are presently not authorized to run /poll', { player: player.name });
      return;
    }
    if (!pollArbiter) {
      replyToPlayer(player, 'ERROR: the poll arbiter has disappeared (this should never happen)');
      return;
    }
    const trimmed = args.trim();
    const split = trimmed.search(/\s/);
    const cmd = (split === -1 ? trimmed : trimmed.slice(0, split)).toLowerCase();
    const rest = split === -1 ? '' : trimmed.slice(split);
    if (cmd === 'vote') {
      SERVER_COMMANDS.get('/vote').run(player, rest);
      return;
    }
    if (cmd === 'veto') {
      SERVER_COMMANDS.get('/veto').run(player, rest);
      return;
    }
    if (pollArbiter.knowsPoll()) {
      replyToPlayer(player, 'A poll to {action} {target} is presently in progress', {
        action: pollArbiter.action, target: pollArbiter.target,
      });
      replyToPlayer(player, 'Unable to start a new poll until the current one is over');
      return;
    }
    const voters = [...players.values()].filter((other) => other.joined && pollRights(other).poll);
    if (voters.length - 1 < pollArbiter.votesRequired) {
      replyToPlayer(player, 'Unable to initiate a new poll.  There are not enough registered players playing.');
      const others = Math.max(0, voters.length - 1);
      const params = { required: pollArbiter.votesRequired, others };
      if (pollArbiter.votesRequired === 1) {
        if (others === 1) replyToPlayer(player, 'There needs to be at least {required} other player and only {others} is available.', params);
        else replyToPlayer(player, 'There needs to be at least {required} other player and only {others} are available.', params);
      } else if (others === 1) {
        replyToPlayer(player, 'There needs to be at least {required} other players and only {others} is available.', params);
      } else {
        replyToPlayer(player, 'There needs to be at least {required} other players and only {others} are available.', params);
      }
      return;
    }
    if (!['ban', 'kick', 'kill', 'set', 'flagreset'].includes(cmd)) {
      pollUsage(player);
      return;
    }
    if (!rest.trim() && cmd !== 'flagreset') {
      replyToPlayer(player, '/poll: incorrect syntax, argument required.');
      return;
    }
    // The rest of the line, a quote at either end dropped.
    const target = rest.trim().replace(/^"/, '').replace(/"$/, '');
    if (!target && cmd !== 'flagreset') {
      replyToPlayer(player, '{player}, no target was specified for the [{action}] vote', { player: player.name, action: cmd });
      // TRANSLATORS: /poll and {action} are a command as typed; keep them as they are
      replyToPlayer(player, 'Usage: /poll {action} target', { action: cmd });
      return;
    }
    if (!rights[cmd]) {
      // TRANSLATORS: /poll {action} is a command as typed; keep it as it is
      replyToPlayer(player, '{player}, you may not /poll {action} on this server', { player: player.name, action: cmd });
      return;
    }
    let started;
    if (cmd === 'ban' || cmd === 'kick' || cmd === 'kill') {
      const victim = players.get(resolveCallsign(target));
      if (!victim) {
        replyToPlayer(player, 'The player specified for a {action} vote is not here', { action: cmd });
        return;
      }
      if (cmd === 'kill' && isObserverTeam(victim.team)) {
        replyToPlayer(player, "You can't kill an observer!");
        return;
      }
      // An admin holds upstream's `antipoll`, which only another admin
      // overrides.
      if (!isAdmin(player) && isAdmin(victim)) {
        replyToPlayer(player, '{player} is protected from being polled against.', { player: victim.name });
        return;
      }
      if (cmd === 'ban' && !victim.clientIP) {
        replyToPlayer(player, '{player} has no trusted address to ban', { player: victim.name });
        return;
      }
      if (cmd === 'ban') started = pollArbiter.pollToBan(target, player.name, player.id, victim.clientIP);
      else if (cmd === 'kick') started = pollArbiter.pollToKick(target, player.name, player.id);
      else started = pollArbiter.pollToKill(target, player.name, player.id);
    } else if (cmd === 'set') {
      started = pollArbiter.pollToSet(target, player.name, player.id);
    } else {
      started = pollArbiter.pollToResetFlags(player.name, player.id);
    }
    if (!started) {
      replyToPlayer(player, 'You are not able to request a {action} poll right now, {player}', { action: cmd, player: player.name });
      return;
    }
    log(`[POLL] "${player.name}" asked to ${pollArbiter.action} ${pollArbiter.target}`);
    announceToAll(localized('A poll to {action} {target} has been requested by {player}', {
      action: cmd, target, player: player.name,
    }));
    const available = voters.length;
    const needed = Math.floor((pollArbiter.votePercentage / 100) * available);
    const tally = { available, needed, percentage: pollArbiter.votePercentage.toFixed(6) };
    if (available === 1) {
      announceToAll(needed === 1
        ? localized('{available} player is available, {needed} additional affirming vote required to pass the poll ({percentage} %)', tally)
        : localized('{available} player is available, {needed} additional affirming votes required to pass the poll ({percentage} %)', tally));
    } else {
      announceToAll(needed === 1
        ? localized('{available} players are available, {needed} additional affirming vote required to pass the poll ({percentage} %)', tally)
        : localized('{available} players are available, {needed} additional affirming votes required to pass the poll ({percentage} %)', tally));
    }
    pollArbiter.setAvailableVoters(available);
    for (const voter of voters) pollArbiter.grantSuffrage(voter.name);
    if (!pollArbiter.voteYes(player.name)) {
      replyToPlayer(player, 'Unable to automatically place your vote for some unknown reason');
    }
  });

function resetPollAnnouncements() {
  pollAnnounced.opening = false;
  pollAnnounced.closure = false;
  pollAnnounced.results = false;
  pollAnnounced.heartbeatAt = -1;
}

// What a successful poll does, once its veto time is over.
// "banned for 5 hours." (bzfs.cxx:7395).
function pollBanLength() {
  const hours = Math.floor(BAN_TIME_MINUTES / 60);
  const minutes = BAN_TIME_MINUTES % 60;
  return `banned for ${hours > 0 ? `${hours} hour${hours === 1 ? '.' : 's'}${minutes > 0 ? ' and ' : ''}` : ''}`
    + `${minutes > 0 ? `${minutes} minute${minutes > 1 ? 's' : ''}` : ''}.`;
}

function carryOutPoll(action, target, address) {
  if (action === 'ban') {
    // `acl.ban(realIP, target, banTime)`: whatever the victim is called now,
    // the address the poll was about.
    if (address) bans.ipBan(address, { bannedBy: target, minutes: BAN_TIME_MINUTES, reason: 'poll ban' });
    for (const victim of [...players.values()]) {
      if (!victim.joined || (victim.name !== target && !(address && victim.clientIP === address))) continue;
      replyToPlayer(victim, 'You have been temporarily banned due to sufficient votes to have you removed');
      removeFromServer(victim);
    }
  } else if (action === 'kick') {
    const victim = players.get(resolveCallsign(target));
    if (victim) {
      replyToPlayer(victim, 'You have been kicked due to sufficient votes to have you removed');
      removeFromServer(victim);
    }
  } else if (action === 'kill') {
    const victim = players.get(resolveCallsign(target));
    if (victim && victim.alive && !isObserverTeam(victim.team)) {
      replyToPlayer(victim, 'You have been killed due to sufficient votes');
      killPlayer(victim, victim, DEATH_REASON.SELF_DESTRUCT);
    }
  } else if (action === 'set') {
    const split = target.search(/\s/);
    const name = split === -1 ? target : target.slice(0, split);
    const value = split === -1 ? '' : target.slice(split).trim();
    if (value && worldVariableExists(name) && !READ_ONLY_VARIABLES.has(name)) setWorldVariable(name, value);
  } else if (action === 'reset') {
    flags.forEach((flag) => {
      if (flag.owner === null || flag.owner === undefined) resetFlag(flag);
    });
  }
  log(`[POLL] carried out: ${action} ${target}`);
}

// The poll's clock, as bzfs's main loop runs it (bzfs.cxx:7267): announce
// the opening, a reminder every fifteen seconds, the result, and once the
// veto time is over, the action.
function tickPoll() {
  if (!pollArbiter?.knowsPoll()) return;
  const { action, target } = pollArbiter;
  if (!pollAnnounced.opening) {
    announceToAll(localized('A poll to {action} {target} has begun.  Players have up to {seconds} seconds to vote.', {
      action, target, seconds: pollArbiter.voteTime,
    }));
    pollAnnounced.opening = true;
  }
  const elapsed = Math.floor(pollArbiter.elapsed());
  if ((pollArbiter.voteTime - elapsed - 1) % 15 === 0 && pollAnnounced.heartbeatAt !== elapsed
    && pollArbiter.timeRemaining() > 0) {
    announceToAll(localized('{seconds} seconds remain in the poll to {action} {target}.', {
      seconds: pollArbiter.timeRemaining(), action, target,
    }));
    pollAnnounced.heartbeatAt = elapsed;
  }
  if (!pollArbiter.isPollClosed()) {
    if (pollArbiter.isPollSuccessful()) {
      announceToAll(action !== 'flagreset'
        ? localized('Enough votes were collected to {action} {target} early.', { action, target })
        : localized('Enough votes were collected to reset all unused flags early.'));
      pollArbiter.closePoll();
    }
    return;
  }
  if (!pollAnnounced.results) {
    announceToAll(localized('Poll Results: {yes} in favor, {no} oppose, {abstain} abstain', {
      yes: pollArbiter.getYesCount(), no: pollArbiter.getNoCount(), abstain: pollArbiter.getAbstentionCount(),
    }));
    pollAnnounced.results = true;
  }
  const successful = pollArbiter.isPollSuccessful();
  if (!successful) {
    if (!pollAnnounced.closure) {
      announceToAll(localized('The poll to {action} {target} was not successful', { action, target }));
      log(`[POLL] failed: ${action} ${target}`);
      pollArbiter.forgetPoll();
      resetPollAnnouncements();
    }
    return;
  }
  if (!pollAnnounced.closure) {
    const closing = {
      ban: () => localized('The poll is now closed and was successful.  {target} is scheduled to be temporarily banned.', { target }),
      kick: () => localized('The poll is now closed and was successful.  {target} is scheduled to be kicked.', { target }),
      kill: () => localized('The poll is now closed and was successful.  {target} is scheduled to be killed.', { target }),
    }[action];
    announceToAll(closing ? closing()
      : localized('The poll is now closed and was successful.  {target} is scheduled to be {action}.', { target, action }));
    pollAnnounced.closure = true;
  }
  if (!pollArbiter.isPollExpired()) return;
  // The ban's length is upstream's own phrasing, pluralised in English, so
  // that line goes out as it is.
  const outcome = {
    ban: () => ({ text: `${target} has been ${pollBanLength()}` }),
    kick: () => localized('{target} has been kicked.', { target }),
    kill: () => localized('{target} has been killed.', { target }),
  }[action];
  announceToAll(outcome ? outcome() : localized('{target} has been {action}', { target, action }));
  carryOutPoll(action, target, pollArbiter.targetAddress);
  pollArbiter.forgetPoll();
  resetPollAnnouncements();
}
setInterval(tickPoll, 250).unref?.();

// ClientQueryCommand (commands.cxx:3539): every playing tank's client
// version, or one player's. Upstream's needs `clientQuery`, an admin's right.
// A BZFlag client's version is what it sent with MsgEnter; a browser's is
// this server's own build and the browser it runs in.
defineCommand('/clientquery', COMMAND_TIER.OPERATOR,
  '[#slot|PlayerName|"Player Name"] - show client versions',
  (player, args) => {
    const report = (other) => {
      replyToPlayer(player, "{player}'s client version:", { player: other.name });
      if (other.clientVersion) replyToPlayer(player, '  {version}', { version: other.clientVersion });
      else replyToPlayer(player, '  unknown');
    };
    if (args.trim()) {
      const target = resolveCommandTarget(args);
      const other = target.id ? players.get(target.id) : null;
      if (!other) {
        replyToPlayer(player, 'Player not found.');
        return;
      }
      report(other);
      return;
    }
    replyToPlayer(player, 'BZFS Version: {version}', { version: BZO_APP_VERSION });
    for (const other of players.values()) {
      if (other.joined && !isObserverTeam(other.team)) report(other);
    }
  });

// CountdownCommand (commands.cxx:1252), and bzfs's own count to the start
// (bzfs.cxx:7063). `/countdown <seconds>` counts down in chat once a second --
// "Start your engines!......", then "N..." -- and starts the match at zero;
// bare, it is upstream's ten where there is a clock to start and at once where
// there is not. Up to `COUNTDOWN_MAX_SECONDS`, as upstream clamps it. `cancel`
// stops a count, and `pause`/`resume` hold and release a running clock.
//
// Two departures, both for a server without limits, which upstream leaves no
// way to start fresh: it runs whether or not `-timemanual` was set, and it
// clears every player's score rather than only the teams'. A timed match
// already running is refused, as upstream refuses it.
const COUNTDOWN_DEFAULT_SECONDS = 10;
const COUNTDOWN_MAX_SECONDS = 120;
let countdown = null;

function cancelMatchCountdown(by) {
  if (!countdown) return false;
  clearInterval(countdown.timer);
  countdown = null;
  announceToAll(by ? localized('Countdown cancelled by {player}.', { player: by }) : localized('Countdown cancelled'));
  return true;
}

// The match begins: every score back to nothing, and the scores held for
// players who left as well (`savedScores`), so nobody comes back into this
// match with the last one's. Here and not in `startMatch`, whose boot
// auto-start must keep what a restart carried over.
function beginCountedMatch(starter) {
  countdown = null;
  const held = savedScores.size;
  savedScores.clear();
  startMatch();
  log(`[CMD] "${starter}" started the match${held ? `, clearing ${held} held score(s)` : ''}`);
}

defineCommand('/countdown', COMMAND_TIER.OPERATOR,
  '[<seconds>|pause|resume|cancel] - count down to a fresh match, or pause, resume or cancel',
  (player, args) => {
    const arg = args.trim().toLowerCase();
    if (arg === 'pause') {
      if (!pauseMatch()) {
        replyToPlayer(player, 'No match is running to pause');
        return;
      }
      log(`[CMD] "${player.name}" paused the match`);
      return;
    }
    if (arg === 'resume') {
      if (!resumeMatch()) {
        replyToPlayer(player, 'No paused match to resume');
        return;
      }
      log(`[CMD] "${player.name}" resumed the match`);
      return;
    }
    if (arg === 'cancel') {
      if (!cancelMatchCountdown(player.name)) replyToPlayer(player, 'There is no running countdown to cancel');
      else log(`[CMD] "${player.name}" cancelled the countdown`);
      return;
    }
    let seconds = GAME_CONFIG.TIME_LIMIT > 0 ? COUNTDOWN_DEFAULT_SECONDS : 0;
    if (arg) {
      seconds = Number(arg);
      if (!/^-?\d+$/.test(arg)) {
        replyToPlayer(player, 'Usage: /countdown [<seconds>|pause|resume|cancel]');
        return;
      }
    }
    if (countdown) {
      replyToPlayer(player, 'There is a countdown already in progress');
      return;
    }
    if (GAME_CONFIG.TIME_LIMIT > 0 && matchClock.active && !matchClock.gameOver) {
      replyToPlayer(player, 'A game is already in progress');
      return;
    }
    if (seconds > COUNTDOWN_MAX_SECONDS) {
      replyToPlayer(player, 'Countdown set to {seconds} instead of {asked}', { seconds: COUNTDOWN_MAX_SECONDS, asked: seconds });
      seconds = COUNTDOWN_MAX_SECONDS;
    } else if (seconds < 0) {
      replyToPlayer(player, 'Countdown set to {seconds} instead of {asked}', { seconds: 0, asked: seconds });
      seconds = 0;
    }
    if (seconds === 0) {
      beginCountedMatch(player.name);
      return;
    }
    // Upstream's words less "Team scores reset", which here happens at zero:
    // a count cancelled first resets nothing.
    announceToAll(localized('Countdown started by {player}.', { player: player.name }));
    announceToAll(localized('Match begins in about {duration}', { duration: formatDuration(seconds) }));
    log(`[CMD] "${player.name}" started a ${seconds}s countdown`);
    const starter = player.name;
    countdown = { left: seconds, first: true, timer: null };
    countdown.timer = setInterval(() => {
      if (!countdown) return;
      if (countdown.left <= 0) {
        clearInterval(countdown.timer);
        announceToAll(localized('The match has started!...Good Luck Teams!'));
        beginCountedMatch(starter);
        return;
      }
      if (countdown.first) announceToAll(localized('Start your engines!......'));
      countdown.first = false;
      announceToAll(localized('{seconds}...', { seconds: countdown.left }));
      countdown.left--;
    }, 1000);
  });

// GameOverCommand (commands.cxx). Upstream's own /gameover, alongside
// /superkill -- both reuse the same game-over machinery a time-up reaches on
// its own.
defineCommand('/gameover', COMMAND_TIER.OPERATOR,
  '- end the match now',
  (player) => {
    if (!endMatch()) {
      replyToPlayer(player, 'No match is running');
      return;
    }
    log(`[CMD] "${player.name}" ended the match`);
  });

// SayCommand (commands.cxx:458): a public message that comes from the server
// rather than from a player.
defineCommand('/say', COMMAND_TIER.OPERATOR,
  '[message] - generate a public message sent by the server',
  (player, args) => {
    if (args.length === 0) {
      replyToPlayer(player, 'Usage: /say <message>');
      return;
    }
    log(`[CMD] "${player.name}" said to ALL as the server: ${args}`);
    broadcastAll({ type: 'message', src: SERVER_PLAYER, dst: ALL_PLAYERS, msgType: 'server', text: args, ts: Date.now() });
  });

// MuteCommand, UnmuteCommand, MuteListCommand (BanCommands.cxx:215). Upstream
// removes the `talk` permission; bzo keeps a flag for the session, which is the
// same thing without a users file to write it to.
defineCommand('/mute', COMMAND_TIER.OPERATOR,
  '<#slot|PlayerName|"Player Name"> - remove the ability for a player to communicate with other players',
  (player, args) => {
    const target = resolveCommandTarget(args);
    if (!target.id) {
      if (target.error) replyToPlayer(player, target.error);
      else replyToPlayer(player, 'Usage: /mute <#slot|PlayerName>');
      return;
    }
    const victim = players.get(target.id);
    victim.muted = true;
    log(`[CMD] "${player.name}" muted "${victim.name}"`);
    replyToPlayer(player, '"{player}" is now muted', { player: victim.name });
    replyToPlayer(victim, 'You have been muted by an operator');
  });

defineCommand('/unmute', COMMAND_TIER.OPERATOR,
  '<#slot|PlayerName|"Player Name"> - restore the TALK permission to a previously muted player',
  (player, args) => {
    const target = resolveCommandTarget(args);
    if (!target.id) {
      if (target.error) replyToPlayer(player, target.error);
      else replyToPlayer(player, 'Usage: /unmute <#slot|PlayerName>');
      return;
    }
    const victim = players.get(target.id);
    victim.muted = false;
    log(`[CMD] "${player.name}" unmuted "${victim.name}"`);
    replyToPlayer(player, '"{player}" is no longer muted', { player: victim.name });
    replyToPlayer(victim, 'You are no longer muted');
  });

defineCommand('/mutelist', COMMAND_TIER.OPERATOR,
  'list the players current muted',
  (player) => {
    const muted = [...players.values()].filter((other) => other.joined && other.muted);
    if (muted.length === 0) {
      replyToPlayer(player, 'Nobody is muted');
      return;
    }
    for (const other of muted) replyToPlayer(player, `#${other.id} ${other.name}`);
  });

// PlayerListCommand (commands.cxx:274): "list player slots, names and IP
// addresses". bzo's address comes from a forwarding header on a proxied
// deployment, so it is reported as what it is -- see the note in
// docs/commands-plan.md about why a ban cannot rest on it as read.
defineCommand('/playerlist', COMMAND_TIER.OPEN,
  '- list player slots, names and IP addresses',
  (player) => {
    // Everybody may see their own connection, and only an admin everyone's
    // (PlayerListCommand, commands.cxx:2149).
    const joined = [...players.values()]
      .filter((other) => other.joined && (isAdmin(player) || other.id === player.id));
    if (joined.length === 0) {
      replyToPlayer(player, 'Nobody is here');
      return;
    }
    for (const other of joined) {
      const marks = [
        other.muted ? 'muted' : null,
        other.localAdmin ? 'local' : null,
        // Just "verified". Not "verified as <callsign>": `resolveJoinName`
        // returns the session's callsign for anyone signed in, ignoring the
        // name they asked for, so the two are the same string by construction
        // and naming it again says nothing. Upstream's own `/playerlist` is
        // `[id]callsign: host` with no such note at all (`commands.cxx`).
        other.verified ? 'verified' : null,
      ].filter(Boolean);
      // A BZFlag client's link as upstream's `/playerlist` says it
      // (`getPlayerHostInfo`): ` udp` once heard from on UDP, `+` once sent to.
      // A browser's UDP channel (#8) counts as its UDP, and says so the same way.
      // A browser's names which: ` h3` for WebTransport, ` rtc` for WebRTC,
      // ` turn` for WebRTC through a relay.
      const link = other.nativeLink;
      const udpIn = link ? link.udpIn() : Boolean(other.udpChannel && other.udpChannelHeard);
      const udpOut = link ? link.udpOut() : Boolean(other.udpChannel?.isOpen());
      const udpName = link ? 'udp' : (other.udpChannel?.kind || 'udp');
      const udp = `${udpIn ? ` ${udpName}` : ''}${udpOut ? '+' : ''}`;
      const address = other.clientIP || (other.claimedIP ? `${other.claimedIP} (unverified)` : 'unknown');
      replyToPlayer(player, `#${other.id} ${other.name} [${other.team}] ${address}${udp}`
        + (marks.length ? ` (${marks.join(', ')})` : ''));
    }
  });

// flagCommandHelp (commands.cxx:1378), which is what upstream answers a `/flag`
// with nothing it recognises. bzo's `reset` takes no argument, so its line says
// so; the rest are upstream's own wording.
const FLAG_COMMAND_HELP = Object.freeze([
  '/flag up',
  '/flag show',
  '/flag reset',
  '/flag take <#slot|PlayerName|"Player Name">',
  '/flag give <#slot|PlayerName|"Player Name"> <#flagId|FlagAbbr> [force]',
  '/flag drop [#slot|PlayerName|"Player Name"]',
]);

function flagCommandHelp(player) {
  FLAG_COMMAND_HELP.forEach((line) => replyToPlayer(player, line));
}

// `sendMessage(ServerPlayer, AdminPlayers, buffer)` after upstream's own
// `sendMessage(ServerPlayer, t, buffer)`: taking a flag off somebody or handing
// one out is the kind of thing the other operators should see happen. The actor
// is skipped because they already have the same sentence as their reply --
// upstream sends it to them twice.
function announceToAdmins(actor, message) {
  const payload = JSON.stringify({
    type: 'message',
    src: SERVER_PLAYER,
    dst: ADMIN_PLAYERS,
    msgType: 'server',
    ...message,
    ts: Date.now(),
  });
  for (const admin of getAdmins()) {
    if (admin === actor) continue;
    if (admin.ws && admin.ws.readyState === 1) admin.ws.send(payload);
  }
}

// FlagCommand (commands.cxx:156), `<up|show|reset|take|give>`. Upstream splits
// these over two permissions -- `flagMod` for the forms that act on the whole
// world and `flagMaster` for the ones that name a flag or a player -- which
// bzo's two tiers collapse into OPERATOR; see docs/commands-plan.md.
//
// bzo's `reset` still takes no argument and means upstream's `reset all`.
//
// `drop` is bzo's own, and is not `take` with a different name: `take` sends the
// flag back to a spawn point, `drop` throws it on the ground where the tank is
// standing. bzo is developed by driving it, and the move that costs a test run
// is being handed the wrong flag on the zone you meant to test -- so this is the
// other half of `/mv`: put the tank on the zone you want, drop what it is
// carrying, and take the one that is there.
defineCommand('/flag', COMMAND_TIER.OPERATOR,
  '<up|show|reset|take|give|drop> - see, reset, hand out or take away the flags',
  (player, args) => {
    const trimmed = args.trim();
    const split = trimmed.search(/\s/);
    const what = (split === -1 ? trimmed : trimmed.slice(0, split)).toLowerCase();
    const rest = split === -1 ? '' : trimmed.slice(split).trim();

    if (what === 'drop') {
      // No target is your own flag, which is the form worth typing: the player
      // holding the wrong flag is the one running the test.
      let subject = player;
      if (rest.length > 0) {
        const target = resolveCommandTarget(rest);
        if (!target.id) {
          if (target.error) replyToPlayer(player, target.error);
          else replyToPlayer(player, 'Usage: /flag drop [#slot|PlayerName]');
          return;
        }
        subject = players.get(target.id);
      }
      const flag = getPlayerFlag(subject.id);
      if (!flag) {
        if (subject === player) replyToPlayer(player, 'You are not carrying a flag');
        else replyToPlayer(player, '"{player}" is not carrying a flag', { player: subject.name });
        return;
      }
      // Whatever the flag's own rules say happens when it leaves a tank: a
      // sticky one is zapped rather than dropped, exactly as dying with it
      // would, so this cannot be used to plant a bad flag for somebody else.
      const abbreviation = flag.type || 'none';
      dropPlayerFlag(subject.id);
      log(`[CMD] "${player.name}" dropped ${abbreviation} from "${subject.name}"`);
      replyToPlayer(player, 'Dropped {flag} from "{player}"', { flag: abbreviation, player: subject.name });
      if (subject !== player) replyToPlayer(subject, 'Your {flag} flag was dropped', { flag: abbreviation });
      return;
    }
    if (what === 'up') {
      let count = 0;
      flags.forEach((flag) => {
        // Team flags stay: upstream's loop is over flags whose `flagTeam` is
        // NoTeam, because sending a team flag away would end a CTF game.
        if (flag.team !== null) return;
        if (flag.status === FLAG_STATUS.NO_EXIST) return;
        sendFlagUp(flag);
        count += 1;
      });
      log(`[CMD] "${player.name}" sent ${count} flags up`);
      replyToPlayer(player, '{count} flags sent up', { count });
      return;
    }
    if (what === 'reset') {
      let count = 0;
      flags.forEach((flag) => {
        resetFlag(flag);
        count += 1;
      });
      log(`[CMD] "${player.name}" reset ${count} flags`);
      replyToPlayer(player, '{count} flags reset', { count });
      return;
    }
    if (what === 'show') {
      if (flags.length === 0) {
        replyToPlayer(player, 'No flags are in the world');
        return;
      }
      // Every slot, including the empty ones: `s:0` is a slot waiting on the
      // insertion schedule, and which slots are waiting is half of what the
      // question is asking.
      // The text is the whole answer, as it is upstream: no flag update goes
      // with it. A superflag nobody is holding travels anonymous
      // (`getFlagState`), and what puts the identities on the field is the
      // client reading these same lines (`parseFlagInfo`) -- one reader, and
      // it works on a proxied server's reply too.
      flags.forEach((flag) => replyToPlayer(player, formatFlagInfo(describeFlagForCommand(flag))));
      return;
    }
    if (what === 'take') {
      const target = resolveCommandTarget(rest);
      if (!target.id) {
        if (target.error) replyToPlayer(player, target.error);
        else replyToPlayer(player, 'Usage: /flag take <#slot|PlayerName>');
        return;
      }
      const subject = players.get(target.id);
      const flag = getPlayerFlag(subject.id);
      if (!flag) {
        // TRANSLATORS: /flag take is a command name; keep it as it is
        replyToPlayer(player, '/flag take: player ({player}) does not have a flag', { player: subject.name });
        return;
      }
      const abbreviation = flag.type;
      const index = flag.index;
      // resetFlag, which is upstream's own choice here and the whole difference
      // from `/flag drop`: the flag goes back to a spawn point rather than onto
      // the ground the tank is standing on.
      resetFlag(flag);
      const notice = localized('{admin} took flag {flag}/{slot} from {player}', {
        admin: player.name, flag: abbreviation, slot: index, player: subject.name,
      });
      log(`[CMD] "${player.name}" took ${abbreviation}/${index} from "${subject.name}"`);
      replyToPlayer(player, notice.msgid, notice.params);
      announceToAdmins(player, notice);
      return;
    }
    if (what === 'give') {
      const target = resolveCommandTarget(rest);
      if (!target.id) {
        if (target.error) replyToPlayer(player, target.error);
        else replyToPlayer(player, 'Usage: /flag give <#slot|PlayerName> <#flagId|FlagAbbr> [force]');
        return;
      }
      const subject = players.get(target.id);
      const argv = target.rest.split(/\s+/).filter(Boolean);
      if (argv.length === 0) {
        flagCommandHelp(player);
        return;
      }
      const force = (argv[1] || '').toLowerCase() === 'force';

      let flag = null;
      if (argv[0].startsWith('#')) {
        const index = Number.parseInt(argv[0].slice(1), 10);
        flag = Number.isInteger(index) ? flags[index] || null : null;
        if (!flag) {
          replyToPlayer(player, 'flag {flag} is not in this world', { flag: argv[0] });
          return;
        }
        // Upstream drops a held flag on the floor here and answers nothing at
        // all; the sentence is the one its `give <abbreviation>` already has for
        // the same situation.
        if (flag.owner !== null && !force) {
          replyToPlayer(player, 'you may need to use the force');
          return;
        }
        // An empty pool slot has no type to hand over. Upstream gives it
        // anyway and the tank carries `Flags::Null`; bzo says so instead,
        // because a flag with no type is not a flag anyone asked for.
        if (!flag.type) {
          replyToPlayer(player, 'flag {flag} is an empty slot', { flag: argv[0] });
          return;
        }
      } else {
        const abbreviation = argv[0].toUpperCase();
        if (!getFlagType(abbreviation)) {
          replyToPlayer(player, 'bad flag type');
          return;
        }
        // The flag has to already be somewhere in this world -- upstream looks
        // for a slot *holding* that type rather than conjuring one, so a type
        // the pool has not rolled yet cannot be given.
        // A slot that has been sent away still counts, as it does upstream:
        // `/flag up` leaves a required slot holding its type with nothing in
        // the world, and giving that flag out is how it comes back before a
        // reset.
        let unused = null;
        let forced = null;
        for (const candidate of flags) {
          if (candidate.type !== abbreviation) continue;
          forced = candidate;
          if (candidate.owner === null) {
            unused = candidate;
            break;
          }
        }
        if (unused) flag = unused;
        else if (!forced) {
          replyToPlayer(player, 'flag type not found');
          return;
        } else if (!force) {
          replyToPlayer(player, 'you may need to use the force');
          return;
        } else flag = forced;
      }

      if (subject.team === PLAYER_TEAM.OBSERVER) {
        replyToPlayer(player, 'An observer has no tank to carry a flag');
        return;
      }
      // "do not give flags to dead players": the grab has to reach a tank that
      // is on the field, or the flag would be carried by nothing.
      if (!subject.alive) {
        // TRANSLATORS: /flag give is a command name; keep it as it is
        replyToPlayer(player, '/flag give: player ({player}) is not alive', { player: subject.name });
        return;
      }

      // What the tank is already carrying. A team flag is thrown where it
      // stands -- taking it out of the world would strand a capture -- and a
      // superflag goes back to a spawn point.
      const carried = getPlayerFlag(subject.id);
      if (carried) {
        if (carried.team !== null) dropFlag(carried);
        else resetFlag(carried);
      }
      // And whoever was holding the flag being given, for a forced give. The
      // flag changes hands rather than falling, so this is the drop message
      // without a landing.
      if (flag.owner !== null) sendFlagDrop(flag);

      const abbreviation = flag.type;
      // `grabFlag(index, flag, false)`: the position check is what the `false`
      // turns off, because an operator handing a flag out is not standing on it.
      grabFlag(subject, flag, Date.now(), { checkPos: false });
      const notice = localized('{admin} gave flag {flag}/{slot} to {player}', {
        admin: player.name, flag: abbreviation, slot: flag.index, player: subject.name,
      });
      log(`[CMD] "${player.name}" gave ${abbreviation}/${flag.index} to "${subject.name}"`);
      replyToPlayer(player, notice.msgid, notice.params);
      announceToAdmins(player, notice);
      return;
    }
    flagCommandHelp(player);
  });

// `/mv` is bzo's own: upstream has no command that moves a tank anywhere in
// bzfs, and no API call for it either. It is here because bzo is developed by
// driving it -- `testSpawn` in server.json does this on join, and this is the
// same thing without a restart. See parseMoveCoordinates for the grammar.
defineCommand('/mv', COMMAND_TIER.OPERATOR,
  '[player] <x,y|x,y,z|x,y,z,facing[,pitch]> [facing] - move a tank or an observer\'s camera; height optional, facing a compass point or degrees',
  (player, args) => {
    // A target is optional, so the first token is only a target if it does not
    // parse as coordinates.
    let subject = player;
    let rest = args.trim();
    const firstToken = rest.split(/\s+/)[0] || '';
    if (!/^-?[\d.]/.test(firstToken)) {
      const target = resolveCommandTarget(rest);
      if (!target.id) {
        if (target.error) replyToPlayer(player, target.error);
        else replyToPlayer(player, 'Usage: /mv [player] <x,y> [facing]');
        return;
      }
      subject = players.get(target.id);
      rest = target.rest;
    }

    const parsed = parseMoveCoordinates(rest);
    if (parsed.error) {
      replyToPlayer(player, parsed.error);
      return;
    }
    if (subject.team === PLAYER_TEAM.OBSERVER) {
      // A BZFlag client's camera is its own; there is nothing to say it with.
      if (subject.nativeLink) {
        replyToPlayer(player, 'An observer has no tank to move');
        return;
      }
      moveObserverCamera(player, subject, parsed);
      return;
    }

    // `parseMoveCoordinates` resolved it: a compass point and an angle are two
    // spellings of the same thing by the time it hands one back.
    const azimuth = parsed.azimuth === null ? subject.azimuth : parsed.azimuth;
    const at = { x: parsed.x, y: parsed.y, z: parsed.z };
    // A height that was *given* is honoured where the tank fits, so `/mv 0,30,0`
    // puts you thirty units up to watch yourself fall. Where it does not fit --
    // a coordinate inside an elevated obstacle -- `dropSpawnPosition` climbs to
    // the lowest surface above it, which is the same resolver `testSpawn` uses
    // and the reason it comes out on the roof rather than stuck in the box.
    //
    // No height means start from the ground, which is the form worth typing:
    // there it falls to the ground where the tank fits and climbs where it does
    // not, so `/mv 0,0` lands on the grass on `hix` and on top of the centre
    // block on `fountains`.
    //
    // Except for a tank that drives through buildings, which is placed exactly
    // where it was asked to go. Resolving the altitude for one of those would
    // refuse the only placement worth asking for -- being inside the wall is
    // where an Oscillation Overthruster tank is *supposed* to be able to sit,
    // and it is the one way to reach the sealed state on purpose. The tank
    // still falls out of it the moment the flag goes.
    const phased = isPlayerPhased(subject);
    let z;
    if (phased && at.z !== null) {
      z = at.z;
    } else if (phased) {
      // No height given still means the ground, which is where a tank driving
      // in through the side of a building would be.
      z = 0;
    } else if (at.z !== null
      && !checkCollision(at.x, at.y, at.z, 2, { azimuth, suppressLog: true })) {
      z = at.z;
    } else {
      z = dropSpawnPosition(at.x, at.y, at.z === null ? 0 : at.z, azimuth);
    }
    if (z === null) {
      replyToPlayer(player, 'Nowhere to stand at {x},{y}', { x: parsed.x, y: parsed.y });
      return;
    }

    subject.x = at.x;
    subject.y = at.y;
    subject.z = z;
    subject.azimuth = azimuth;
    // As the observer heartbeat does for the same reason: the tank arrives
    // stopped, and the drift check must not integrate the old velocities across
    // the jump.
    subject.forwardSpeed = 0;
    subject.rotationSpeed = 0;
    subject.verticalVelocity = 0;
    subject.airVelocityX = 0;
    subject.airVelocityY = 0;
    subject.jumpAzimuth = null;
    subject.slideAzimuth = undefined;
    subject.isJumping = false;
    subject.teleportReentryBlockTeleporterIndex = null;
    subject.teleportReentryBlockDistance = 0;
    subject.teleportReentryBlockUntil = 0;
    subject.teleportCooldownUntil = 0;
    subject.lastUpdate = Date.now();
    subject.lag.resetUpdateGap();

    // `positionCorrection` for the tank that moved -- it already clears the air
    // velocity, the jump state and the teleporter blocks on that client -- and a
    // plain `pm` for everyone else, which snaps the remote copy without the
    // teleporter sound a `pt` would play.
    sendToPlayer(subject, {
      type: 'positionCorrection',
      x: subject.x, y: subject.y, z: subject.z, a: subject.azimuth, vv: 0,
      // Said, so a BZFlag client -- which has no correction, only a spawn to
      // be placed by -- is placed by this one and by nothing else.
      moved: true,
    });
    broadcast({
      type: 'pm',
      id: subject.id,
      x: subject.x, y: subject.y, z: subject.z, a: subject.azimuth,
      fs: 0, rs: 0, vv: 0, vx: 0, vy: 0,
    }, subject.ws);

    const position = `${subject.x.toFixed(1)},${subject.y.toFixed(1)},${subject.z.toFixed(1)}`;
    const bearing = azimuthToBearingName(subject.azimuth);
    log(`[CMD] "${player.name}" moved "${subject.name}" to ${position} facing ${bearing}`);
    // Echoed because the height was resolved rather than given: seeing where the
    // tank actually landed is how a mistyped coordinate shows itself.
    reportMove(player, subject, position, bearing);
  });

// `/pos` is bzo's own, the read half of `/mv` -- for the same reason `/mv`
// exists at all: reporting a live bug ("I'm stuck") is much more useful with
// an exact, timestamped position than a screenshot, and `/api/players` needs
// a second terminal to poll while `/pos` lands right in server.log next to
// whatever else was happening at that moment. Open to everyone for their own
// tank -- any player hitting a bug should be able to log where it happened
// without needing operator status -- but pinpointing someone *else's* exact
// position is the same privacy line `/mv`/`/playerlist` already draw, so that
// still requires it.
defineCommand('/pos', COMMAND_TIER.OPEN,
  '[player] - log a tank\'s exact current position, for reporting exactly where a bug happened',
  (player, args) => {
    let subject = player;
    if (args.trim().length > 0) {
      if (!isAdmin(player)) {
        replyToPlayer(player, 'Checking another player\'s position requires operator status');
        return;
      }
      const target = resolveCommandTarget(args);
      if (!target.id) {
        if (target.error) replyToPlayer(player, target.error);
        else replyToPlayer(player, 'Usage: /pos [player]');
        return;
      }
      subject = players.get(target.id);
    }
    if (subject.team === PLAYER_TEAM.OBSERVER) {
      replyToPlayer(player, 'An observer has no tank position');
      return;
    }
    const where = `${subject.x.toFixed(2)},${subject.y.toFixed(2)},${subject.z.toFixed(2)}`;
    log(`[POS] "${player.name}" checked "${subject.name}": pos=(${where}), azimuth=${subject.azimuth.toFixed(2)},`
      + ` fs=${(subject.forwardSpeed || 0).toFixed(2)}, rs=${(subject.rotationSpeed || 0).toFixed(2)},`
      + ` vv=${(subject.verticalVelocity || 0).toFixed(2)}`);
    const bearing = azimuthToBearingName(subject.azimuth);
    if (subject === player) replyToPlayer(player, 'You are at {position} facing {bearing}', { position: where, bearing });
    else replyToPlayer(player, '"{player}" is at {position} facing {bearing}', { player: subject.name, position: where, bearing });
  });

// Which settings can be changed without starting a new game. Everything else is
// a new game -- the map today, and the game's shape when the panel grows into it
// -- because bzo resolves the world and the team layout once at boot. See
// docs/operator-panel-plan.md: a map change, a mode change and a match ending are
// one event, so they take one path.
// `timeLimit`/`timeManualStart` are live because changing them touches nothing
// the world resolves once at boot -- they only decide what the next
// `startMatch()` uses, the same way `/countdown` itself is a runtime action
// rather than a restart.
// `maxPlayerScore`/`maxTeamScore` are live for the same reason: they only
// decide what the next kill or capture checks against.
const LIVE_CONFIG_KEYS = Object.freeze([
  'title', 'motd', 'shotMaxActive', 'ricochet', 'timeLimit', 'timeManualStart', 'maxPlayerScore', 'maxTeamScore',
  'botFill', 'botPilot',
]);
// bzfs truncates `-publictitle` at 127 (CmdLineOptions.cxx:1044), and the
// BZFlag list's title has the map's name added to it; this leaves room for
// that, and stays under the 120 characters `/api/list-server/report` takes.
const SERVER_TITLE_MAX_LENGTH = 100;
// Upstream keeps no fixed ceiling on `-time`; this is the panel slider's own,
// so a drag has somewhere to stop. A map or `server.json` may still set a
// higher `timeLimit` directly -- the slider just cannot reach past an hour.
const OPERATOR_TIME_LIMIT_MAX = 3600;
// Same reasoning for `-mps`/`-mts`: a slider needs a ceiling to drag to, not a
// protocol limit. A hundred wins is well past any game bzo's own player counts
// would finish.
const OPERATOR_SCORE_LIMIT_MAX = 100;

// The panel's rows are flat where `server.json` is nested, so a team's limit is
// one key of its own -- `rogueLimit`, `observerLimit` -- and this is the mapping
// back. One row per team is also what makes them steppable in a headset.
const OPERATOR_TEAM_LIMIT_KEYS = Object.freeze(Object.fromEntries(
  PLAYER_TEAMS.map((team) => [`${team}Limit`, team])));
// `-rabbit [score|killer|random]`, plus the off position a `choice` row has to
// have and a command-line switch does not.
const RABBIT_SELECTIONS = Object.freeze(['off', 'score', 'killer', 'random']);
// Upstream's own ceiling on either number (`MaxPlayers`, CmdLineOptions.h:37).
const MAX_CONFIGURABLE_PLAYERS = 200;
// Every setting the panel may stage, which is what the `setOperatorConfig`
// handler accepts and what `init` reports the current value of.
const OPERATOR_CONFIG_KEYS = Object.freeze([
  ...LIVE_CONFIG_KEYS,
  'mapFile',
  'teams',
  'rabbit',
  'jumping',
  'maxPlayers',
  ...Object.keys(OPERATOR_TEAM_LIMIT_KEYS),
]);

// What the panel is looking at. Read from the config rather than from the
// resolved world, because the config is what the panel edits: a map's own
// `options` block still overrides it on the next boot, exactly as it does for
// the map row today.
function getOperatorConfigState() {
  // Clamped, because clamped is what the server is running: a per-team limit
  // above the playing limit is brought down when the world is resolved
  // (CmdLineOptions.cxx:453), and a row showing the config's larger number would
  // be describing a limit nobody is held to.
  const limits = clampPlayingLimits(
    normalizeTeamLimits(serverConfig.teamMode?.limits, PLAYER_TEAMS, MAX_REAL_PLAYERS),
    MAX_REAL_PLAYERS);
  return {
    title: serverConfig.title || '',
    motd: serverConfig.motd || '',
    shotMaxActive: GAME_CONFIG.SHOT_MAX_ACTIVE,
    ricochet: GAME_CONFIG.ALL_SHOTS_RICOCHET,
    mapFile: serverConfig.mapFile || '',
    teams: serverConfig.teamMode === true || serverConfig.teamMode?.enabled === true,
    rabbit: normalizeRabbitSelection(serverConfig.rabbit) || 'off',
    jumping: serverConfig.jumping !== false,
    timeLimit: GAME_CONFIG.TIME_LIMIT,
    timeManualStart: GAME_CONFIG.TIME_MANUAL_START,
    maxPlayerScore: GAME_CONFIG.MAX_PLAYER_SCORE,
    maxTeamScore: GAME_CONFIG.MAX_TEAM_SCORE,
    maxPlayers: MAX_REAL_PLAYERS,
    botFill,
    botPilot: botFillPilot,
    ...Object.fromEntries(Object.entries(OPERATOR_TEAM_LIMIT_KEYS)
      .map(([key, team]) => [key, limits[team]])),
    ...pluginOperatorState(),
  };
}

// The Plugins rows' state: `plugin:<id>`, whether each plugin is running.
// Live, as `LIVE_CONFIG_KEYS` are: Apply loads or unloads it at once.
const PLUGIN_KEY_PREFIX = 'plugin:';

function isPluginKey(key) {
  return typeof key === 'string' && key.startsWith(PLUGIN_KEY_PREFIX);
}

function isLiveConfigKey(key) {
  return LIVE_CONFIG_KEYS.includes(key) || isPluginKey(key);
}

function pluginOperatorState() {
  return Object.fromEntries((plugins?.list() ?? [])
    .map((entry) => [`${PLUGIN_KEY_PREFIX}${entry.id}`, entry.state === 'loaded']));
}

// What the Plugins rows show of each plugin, for admins only: its error can
// name a path on the server.
function pluginPanelList() {
  return (plugins?.list() ?? []).map(({ id, bundled, meta, state, error }) => ({
    id,
    bundled,
    name: meta?.name ?? id,
    version: meta?.version ?? '',
    author: meta?.author ?? '',
    description: meta?.description ?? '',
    license: meta?.license ?? '',
    state,
    error: error ?? null,
  }));
}

// `server.json`'s nested shape from the panel's flat one. `teamMode` may be a
// bare boolean in a hand-written config, so it is grown into an object before
// anything is written into it, and the team list follows the limits: a team
// limited to zero is off, which is how a map's `-mp 10,0,4,0,2,8` already reads
// (parseBZWTeamMode). One place decides whether a team exists.
function writeOperatorConfigFields(config, next) {
  const limitKeys = Object.keys(next).filter((key) => OPERATOR_TEAM_LIMIT_KEYS[key]);
  if ((limitKeys.length > 0 || next.teams !== undefined)
    && (!config.teamMode || typeof config.teamMode !== 'object')) {
    config.teamMode = { enabled: config.teamMode === true };
  }
  for (const [key, value] of Object.entries(next)) {
    const team = OPERATOR_TEAM_LIMIT_KEYS[key];
    if (team) {
      config.teamMode.limits = { ...config.teamMode.limits, [team]: value };
    } else if (key === 'teams') {
      config.teamMode.enabled = value;
    } else if (isPluginKey(key)) {
      // Its options stay where an operator wrote them; only whether it runs
      // changes.
      const id = key.slice(PLUGIN_KEY_PREFIX.length);
      const setting = config.plugins?.[id];
      config.plugins = {
        ...config.plugins,
        [id]: setting && typeof setting === 'object' ? { ...setting, enabled: value } : value,
      };
    } else if (key === 'botFill' || key === 'botPilot') {
      config.bots = { ...config.bots, [key === 'botFill' ? 'fill' : 'pilot']: value };
    } else if (key === 'rabbit') {
      // `false` is the config's own off position, and what resolveRabbitSelection
      // reads; `"off"` is the row's.
      config.rabbit = value === 'off' ? false : value;
    } else if (key === 'title') {
      // Written under its own name, and the old spellings go with it.
      config.title = value;
      delete config.serverName;
      if (config.bzflag && typeof config.bzflag === 'object') delete config.bzflag.publicTitle;
    } else {
      config[key] = value;
    }
  }
  if (limitKeys.length > 0) {
    const limits = normalizeTeamLimits(
      config.teamMode.limits, PLAYER_TEAMS, next.maxPlayers ?? MAX_REAL_PLAYERS);
    config.teamMode.teams = PLAYER_TEAMS.filter((team) => limits[team] > 0);
  }
}

// The settings an operator may change while the server runs, in the one place
// they are changed. Validated, written back to `server.json`, applied to the
// live config, and broadcast -- in that order, and as one transaction, so a
// panel save that touches three of them is one file write and one broadcast.
//
// The Operator panel and `/set` both come through here. They are one action with
// two front ends, and the moment they are two functions they will disagree about
// what a valid value is or forget to tell the clients.
//
// A change outside `LIVE_CONFIG_KEYS` restarts, which is what makes the panel's
// one button honest: it reads *Apply* while everything staged is live and
// *Restart* the moment something is not.
//
// Returns `{ error }` or `{ changed: [...], restarted }`.
function applyServerConfigChanges(requested, byWhom) {
  // What the panel was looking at when it staged these, so a value that is
  // already the server's own does not start a new game for nothing.
  const current = getOperatorConfigState();
  const has = (key) => Object.prototype.hasOwnProperty.call(requested, key);
  const next = {};
  if (has('title')) {
    if (typeof requested.title !== 'string') return { error: 'Invalid title value' };
    const title = requested.title.trim();
    if (!title) return { error: 'Title cannot be empty' };
    if (title.length > SERVER_TITLE_MAX_LENGTH) {
      return { error: `Title must be ${SERVER_TITLE_MAX_LENGTH} characters or fewer` };
    }
    next.title = title;
  }
  if (has('motd')) {
    if (typeof requested.motd !== 'string') return { error: 'Invalid motd value' };
    const motd = requested.motd.trim();
    if (motd.length > 140) return { error: 'MOTD must be 140 characters or fewer' };
    next.motd = motd;
  }
  if (has('shotMaxActive')) {
    const shots = Number(requested.shotMaxActive);
    if (!Number.isFinite(shots)) return { error: 'Invalid shot max active value' };
    next.shotMaxActive = normalizeShotSlotCount(Math.round(shots));
  }
  if (has('ricochet')) {
    if (typeof requested.ricochet !== 'boolean') return { error: 'Invalid ricochet value' };
    next.ricochet = requested.ricochet;
  }
  if (has('timeLimit')) {
    const seconds = Number(requested.timeLimit);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > OPERATOR_TIME_LIMIT_MAX) {
      return { error: `Time limit is 0 (no limit) to ${OPERATOR_TIME_LIMIT_MAX} seconds` };
    }
    next.timeLimit = normalizeTimeLimit(seconds);
  }
  if (has('timeManualStart')) {
    if (typeof requested.timeManualStart !== 'boolean') return { error: 'Invalid time manual start value' };
    next.timeManualStart = requested.timeManualStart;
  }
  if (has('maxPlayerScore')) {
    const score = Number(requested.maxPlayerScore);
    if (!Number.isFinite(score) || score < 0 || score > OPERATOR_SCORE_LIMIT_MAX) {
      return { error: `Player score limit is 0 (no limit) to ${OPERATOR_SCORE_LIMIT_MAX}` };
    }
    next.maxPlayerScore = normalizeScoreLimit(score);
  }
  if (has('maxTeamScore')) {
    const score = Number(requested.maxTeamScore);
    if (!Number.isFinite(score) || score < 0 || score > OPERATOR_SCORE_LIMIT_MAX) {
      return { error: `Team score limit is 0 (no limit) to ${OPERATOR_SCORE_LIMIT_MAX}` };
    }
    next.maxTeamScore = normalizeScoreLimit(score);
  }
  // Validated exactly as the standalone `setMap` did, since it is the same
  // choice arriving through the panel's one confirm instead of its own button.
  if (has('mapFile')) {
    const mapFile = typeof requested.mapFile === 'string' ? requested.mapFile.trim() : '';
    if (!mapFile || mapFile !== path.basename(mapFile)
      || (mapFile !== 'random' && !mapFile.endsWith('.bzw'))) {
      return { error: 'Invalid map file' };
    }
    if (mapFile !== 'random' && !resolveMapFilePath(mapFile)) {
      return { error: 'Map file not found' };
    }
    next.mapFile = mapFile;
  }
  // The game's shape, which is the new-game tier: bzo resolves the team layout
  // and the flag pool once at boot, so none of these can be applied live.
  if (has('teams')) {
    if (typeof requested.teams !== 'boolean') return { error: 'Invalid teams value' };
    next.teams = requested.teams;
  }
  if (has('rabbit')) {
    if (!RABBIT_SELECTIONS.includes(requested.rabbit)) {
      return { error: `Rabbit chase is one of ${RABBIT_SELECTIONS.join(', ')}` };
    }
    next.rabbit = requested.rabbit;
  }
  if (has('jumping')) {
    if (typeof requested.jumping !== 'boolean') return { error: 'Invalid jumping value' };
    next.jumping = requested.jumping;
  }
  // The playing limit, upstream's `-mp`: at least one tank, since a server that
  // allows none is a server nobody can play on.
  if (has('maxPlayers')) {
    const playing = Math.round(Number(requested.maxPlayers));
    if (!Number.isFinite(playing) || playing < 1 || playing > MAX_CONFIGURABLE_PLAYERS) {
      return { error: `The playing limit is 1 to ${MAX_CONFIGURABLE_PLAYERS}` };
    }
    next.maxPlayers = playing;
  }
  // A per-team limit may be zero, which turns that team off.
  for (const [key, team] of Object.entries(OPERATOR_TEAM_LIMIT_KEYS)) {
    if (!has(key)) continue;
    const limit = Math.round(Number(requested[key]));
    if (!Number.isFinite(limit) || limit < 0 || limit > MAX_CONFIGURABLE_PLAYERS) {
      return { error: `The ${team} limit is 0 to ${MAX_CONFIGURABLE_PLAYERS}` };
    }
    next[key] = limit;
  }

  // The server's own bots (`bots` in server.json): how many places they fill,
  // and which pilot flies them.
  if (has('botFill')) {
    const fill = Math.round(Number(requested.botFill));
    if (!Number.isFinite(fill) || fill < 0 || fill > MAX_REAL_PLAYERS) {
      return { error: `Bot fill is 0 to ${MAX_REAL_PLAYERS}` };
    }
    if (fill > 0 && botsDisabled()) return { error: 'Bots are disabled on this server (-disableBots)' };
    next.botFill = fill;
  }
  if (has('botPilot')) {
    if (typeof requested.botPilot !== 'string' || !findAutopilot(requested.botPilot)) {
      return { error: 'Invalid bot pilot' };
    }
    next.botPilot = requested.botPilot;
  }

  // A plugin on or off, by the id the Plugins rows name it by.
  const knownPlugins = new Set((plugins?.list() ?? []).map((entry) => entry.id));
  for (const key of Object.keys(requested).filter(isPluginKey)) {
    if (!knownPlugins.has(key.slice(PLUGIN_KEY_PREFIX.length))) return { error: 'No such plugin' };
    if (typeof requested[key] !== 'boolean') return { error: 'Invalid plugin value' };
    next[key] = requested[key];
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    writeOperatorConfigFields(config, next);
    writeServerConfig(config);
    serverConfig.plugins = config.plugins;
  } catch (error) {
    logError(`Failed to update config at ${configPath}:`, error);
    return { error: 'Failed to update config' };
  }

  const changed = [];
  if (next.title !== undefined) {
    serverConfig.title = next.title;
    changed.push('title');
    publishToBzflagListServer('title');
  }
  if (next.motd !== undefined) {
    serverConfig.motd = next.motd;
    changed.push('motd');
  }
  if (next.shotMaxActive !== undefined && next.shotMaxActive !== GAME_CONFIG.SHOT_MAX_ACTIVE) {
    serverConfig.shotMaxActive = next.shotMaxActive;
    GAME_CONFIG.SHOT_MAX_ACTIVE = next.shotMaxActive;
    changed.push('shotMaxActive');
  }
  if (next.ricochet !== undefined && next.ricochet !== GAME_CONFIG.ALL_SHOTS_RICOCHET) {
    serverConfig.ricochet = next.ricochet;
    GAME_CONFIG.ALL_SHOTS_RICOCHET = next.ricochet;
    applyRicochetGameStyle();
    // A rule everyone is about to be shot by is worth saying out loud.
    broadcastAll({
      type: 'message',
      src: SERVER_PLAYER,
      dst: ALL_PLAYERS,
      msgType: 'server',
      ...(next.ricochet ? localized('All shots now ricochet') : localized('Shots no longer ricochet')),
    });
    changed.push('ricochet');
  }
  if (next.timeLimit !== undefined && next.timeLimit !== GAME_CONFIG.TIME_LIMIT) {
    serverConfig.timeLimit = next.timeLimit;
    GAME_CONFIG.TIME_LIMIT = next.timeLimit;
    // bzfs.cxx:7180 re-broadcasts on any admin adjustment to the limit, not
    // just on the cadence -- a match already running should not wait up to 30
    // seconds to show the new number, and one that is not running has nothing
    // to re-broadcast.
    if (matchClock.active) broadcastAll({ type: 'timeUpdate', timeLeft: getMatchTimeLeft() });
    changed.push('timeLimit');
  }
  if (next.timeManualStart !== undefined && next.timeManualStart !== GAME_CONFIG.TIME_MANUAL_START) {
    serverConfig.timeManualStart = next.timeManualStart;
    GAME_CONFIG.TIME_MANUAL_START = next.timeManualStart;
    changed.push('timeManualStart');
  }
  if (next.maxPlayerScore !== undefined && next.maxPlayerScore !== GAME_CONFIG.MAX_PLAYER_SCORE) {
    serverConfig.maxPlayerScore = next.maxPlayerScore;
    GAME_CONFIG.MAX_PLAYER_SCORE = next.maxPlayerScore;
    changed.push('maxPlayerScore');
  }
  if (next.maxTeamScore !== undefined && next.maxTeamScore !== GAME_CONFIG.MAX_TEAM_SCORE) {
    serverConfig.maxTeamScore = next.maxTeamScore;
    GAME_CONFIG.MAX_TEAM_SCORE = next.maxTeamScore;
    changed.push('maxTeamScore');
  }

  if (next.botPilot !== undefined && next.botPilot !== botFillPilot) {
    botFillPilot = next.botPilot;
    changed.push('botPilot');
  }
  if (next.botFill !== undefined && next.botFill !== botFill) {
    botFill = next.botFill;
    changed.push('botFill');
  }
  if (changed.includes('botFill') || changed.includes('botPilot')) scheduleBotReconcile();

  let pluginsChanged = false;
  for (const key of Object.keys(next).filter(isPluginKey)) {
    if (next[key] === current[key]) continue;
    const id = key.slice(PLUGIN_KEY_PREFIX.length);
    if (next[key]) {
      plugins.discover();
      if (plugins.load(id)?.state !== 'loaded') return { error: 'Plugin load failed' };
    } else {
      plugins.unload(id);
    }
    changed.push(key);
    pluginsChanged = true;
  }
  if (pluginsChanged) announcePluginChange();

  // A new game rather than a live change: the world, the team layout and the flag
  // pool are resolved once at boot, so the only honest way to apply one of these
  // is to start over. Written to `server.json` above; this is what makes the
  // clients follow. A staged value that already matches is not one of them, so
  // pressing the button on a change and its own undo restarts nothing.
  const newGame = Object.keys(next)
    .filter((key) => !isLiveConfigKey(key) && next[key] !== current[key]);
  if (newGame.length > 0) {
    changed.push(...newGame);
    log(`Config changed by ${byWhom}: ${changed.join(', ')}; starting a new game`);
    requestServerRestart(`${byWhom} changed ${changed.join(', ')}`);
    return { changed, restarted: true };
  }

  broadcastAll({
    type: 'serverConfigUpdate',
    title: serverConfig.title || '',
    motd: serverConfig.motd || '',
    shotMaxActive: GAME_CONFIG.SHOT_MAX_ACTIVE,
    ricochet: GAME_CONFIG.ALL_SHOTS_RICOCHET,
    timeLimit: GAME_CONFIG.TIME_LIMIT,
    timeManualStart: GAME_CONFIG.TIME_MANUAL_START,
    maxPlayerScore: GAME_CONFIG.MAX_PLAYER_SCORE,
    maxTeamScore: GAME_CONFIG.MAX_TEAM_SCORE,
    botFill,
    botPilot: botFillPilot,
  });
  log(`Config changed by ${byWhom}: ${changed.length ? changed.join(', ') : 'nothing'}`);
  return { changed, restarted: false };
}

// bzo's own `/set` names: settings the Operator panel changes, written through
// the same functions it uses, which is the rule docs/commands-plan.md sets for
// a command that shares an action with the panel.
const SETTABLE_VARIABLES = Object.freeze({
  ricochet: {
    // Upstream's BZDB takes any of these for a boolean, and a typed command
    // should not care which one somebody reached for.
    apply: (value, player) => {
      const text = value.trim().toLowerCase();
      if (!['true', 'false', '1', '0', 'on', 'off'].includes(text)) {
        return { error: 'ricochet is on or off' };
      }
      return applyServerConfigChanges(
        { ricochet: ['true', '1', 'on'].includes(text) }, `"${player.name}" via /set`);
    },
    describe: () => String(GAME_CONFIG.ALL_SHOTS_RICOCHET),
  },
  shotMaxActive: {
    apply: (value, player) => applyServerConfigChanges(
      { shotMaxActive: Number(value) }, `"${player.name}" via /set`),
    describe: () => String(GAME_CONFIG.SHOT_MAX_ACTIVE),
  },
  motd: {
    apply: (value, player) => applyServerConfigChanges(
      { motd: value }, `"${player.name}" via /set`),
    describe: () => serverConfig.motd || '(none)',
  },
});

// SetCommand and ResetCommand (commands.cxx:1093, :1129) over cmdSet and
// cmdReset (bzfs.cxx:5625, :5669), in upstream's words: any world variable,
// formulas included, every player told who changed what, and `/reset` back to
// upstream's own default rather than to the map's. The three names above are
// bzo's own and keep working beside them.
//
// `poll` is the one variable upstream marks read-only.
const READ_ONLY_VARIABLES = new Set(['poll']);
// Variables a plugin registers on a bzfs that loads it, with the plugin's
// meaning and bzo's default, so `/set` finds them here as it would there.
// ScoreRestorer's is bzo's own; a loaded plugin adds its own to
// `pluginBzdbDefaults` (`bz_registerCustomBZDB*`).
const PLUGIN_BZDB_DEFAULTS = Object.freeze({
  _scoreSaveTime: '120',
});
const pluginBzdbDefaults = new Map();

function worldVariableDefault(name) {
  return BZDB_DEFAULTS[name] ?? PLUGIN_BZDB_DEFAULTS[name] ?? pluginBzdbDefaults.get(name);
}

function worldVariableExists(name) {
  return liveBzdb.has(name) || worldVariableDefault(name) !== undefined;
}

defineCommand('/set', COMMAND_TIER.OPERATOR,
  '<name> [<value>] - set a world variable to value, or show it',
  (player, args) => {
    const [name, ...valueParts] = args.trim().split(/\s+/).filter(Boolean);
    if (!name) {
      replyToPlayer(player, 'usage: set <name> [<value>]');
      replyToPlayer(player, "bzo's own: {variables}", { variables: Object.keys(SETTABLE_VARIABLES).join(', ') });
      return;
    }
    const spec = SETTABLE_VARIABLES[name];
    if (spec) {
      if (valueParts.length === 0) {
        replyToPlayer(player, `${name} ${spec.describe()}`);
        return;
      }
      const result = spec.apply(valueParts.join(' '), player);
      if (result && result.error) {
        replyToPlayer(player, result.error);
        return;
      }
      log(`[CMD] "${player.name}" set ${name} to ${spec.describe()}`);
      replyToPlayer(player, `${name} ${spec.describe()}`);
      return;
    }
    if (!worldVariableExists(name)) {
      // TRANSLATORS: /set is a command name; keep it as it is
      if (valueParts.length) replyToPlayer(player, '/set failed, reason: variable {name} does not exist', { name });
      else replyToPlayer(player, 'variable {name} does not exist', { name });
      return;
    }
    if (valueParts.length === 0) {
      replyToPlayer(player, '{name} is {value}', { name, value: liveBzdb.get(name) ?? worldVariableDefault(name) });
      return;
    }
    if (READ_ONLY_VARIABLES.has(name)) {
      // TRANSLATORS: /set is a command name; keep it as it is
      replyToPlayer(player, '/set failed, reason: variable {name} is not writeable', { name });
      return;
    }
    const value = valueParts.join(' ');
    const moved = setWorldVariable(name, value);
    log(`[CMD] "${player.name}" set ${name} ${value}${moved.length ? ` (${moved.join(', ')})` : ''}`);
    replyToPlayer(player, '{name} set', { name });
    announceToAll(localized('Variable Modification Notice by {player} of set {name} {value}', {
      player: player.name, name, value,
    }));
  });

defineCommand('/reset', COMMAND_TIER.OPERATOR,
  '<name|*> - reset a world variable, or every one, to its default',
  (player, args) => {
    const name = args.trim().split(/\s+/).filter(Boolean)[0];
    if (!name) {
      replyToPlayer(player, 'usage: reset <name>');
      return;
    }
    if (name === '*') {
      for (const variable of [...liveBzdb.keys()]) {
        if (!READ_ONLY_VARIABLES.has(variable)) setWorldVariable(variable, null);
      }
    } else if (!worldVariableExists(name)) {
      replyToPlayer(player, 'variable {name} does not exist', { name });
      return;
    } else if (READ_ONLY_VARIABLES.has(name)) {
      replyToPlayer(player, 'variable {name} is not writeable', { name });
      return;
    } else {
      setWorldVariable(name, null);
    }
    log(`[CMD] "${player.name}" reset ${name}`);
    if (name === '*') replyToPlayer(player, 'all variables reset');
    else replyToPlayer(player, '{name} reset', { name });
    // To admins only, as upstream says it (`AdminPlayers`).
    players.forEach((other) => {
      if (isAdmin(other)) {
        replyToPlayer(other, 'Variable Reset Notice by {player} of reset {name}', { player: player.name, name });
      }
    });
  });

function canRunCommand(player, command) {
  return command.tier === COMMAND_TIER.OPEN || isAdmin(player);
}

// parseServerCommand (commands.cxx:3880), which is the whole of bzo's step 1: a
// line beginning with `/` is a command or it is an error, and either way it is
// never said out loud -- a mistyped `/kick bob` must never reach the room as
// chat. Upstream reaches the "or it is an error" half by trying its table and
// answering "Unknown command".
//
// Returns true when the line was a command line, handled or not.
function handleServerCommand(player, text, channel = ALL_PLAYERS) {
  if (!isCommandLine(text)) return false;

  // CmdHelp (commands.cxx:476): `/co?` is the help for every command starting
  // with `co`. Asked before the table, since `/?` is itself a name.
  const commands = allServerCommands();
  const helpPrefix = commands.has(text.trim().toLowerCase()) ? null : parseHelpPrefix(text);
  if (helpPrefix !== null) {
    const matches = [...commands.values()]
      .filter((command) => command.name.startsWith(helpPrefix) && canRunCommand(player, command))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (matches.length === 0) {
      replyToPlayer(player, 'No command starting with {prefix}', { prefix: helpPrefix });
    } else {
      for (const command of matches) replyToPlayer(player, `${command.name} ${command.help}`);
    }
    log(`[CMD] "${player.name}": ${text}`);
    return true;
  }

  // A plugin's command goes before the built-in one of the same name, as
  // upstream's custom commands do (commands.cxx:3903).
  const pluginCommand = commands.get(parseCommandLine(text)?.name);
  if (pluginCommand?.plugin) {
    if (!canRunCommand(player, pluginCommand)) {
      log(`[CMD] "${player.name}": ${text} -- refused, not an admin`);
      replyToPlayer(player, 'You do not have permission to run the {command} command', { command: pluginCommand.name });
      return true;
    }
    if (plugins?.slashCommand(Number(player.id), Number(channel), text)) {
      log(`[CMD] "${player.name}": ${text}`);
      return true;
    }
  }

  const parsed = parseCommandLine(text);
  const command = parsed && SERVER_COMMANDS.get(parsed.name);
  if (!command) {
    log(`[CMD] "${player.name}": ${text} -- unknown`);
    // The whole line, not just the name: upstream's `message + 1` drops the
    // slash and keeps the arguments, so a player sees back exactly what they
    // typed.
    replyToPlayer(player, formatUnknownCommand(text));
    return true;
  }
  if (!canRunCommand(player, command)) {
    // Upstream's own sentence, per command
    // ("You do not have permission to run the /date command").
    log(`[CMD] "${player.name}": ${text} -- refused, not an admin`);
    replyToPlayer(player, 'You do not have permission to run the {command} command', { command: command.name });
    return true;
  }
  log(`[CMD] "${player.name}": ${text}`);
  command.run(player, parsed.args);
  return true;
}

// Chat delivery, for every destination bzo has. Extracted from the `message`
// handler so `/msg` reaches the same code: a typed message and one picked in the
// chat entry are one action, and the moment they are two functions the admin
// channel's permission check exists in only one of them.
//
// `targetId` is a player id, or one of upstream's addresses above them -- 254
// all, 253 the server's log, 252 the admin channel, 251 down to 244 a team
// (server/player-ids.cjs).
function deliverChatMessage(player, targetId, msgType, rawText) {
  const fromId = player.id;
  const fromName = player.name;

  // bz_eRawChatMessageEvent (bzfs.cxx sendChatMessage), before anything else
  // is asked of the line: a plugin may rewrite it, and one it empties is not
  // sent at all.
  const raw = pluginEvent('bz_eRawChatMessageEvent', () => {
    const team = channelTeam(targetId);
    return {
      from: Number(fromId),
      to: targetId === ALL_PLAYERS ? BZ_ALLUSERS : (isRealPlayerId(targetId) ? Number(targetId) : BZ_NULLUSER),
      team: targetId === ADMIN_PLAYERS ? 8 : (team === null ? -1 : bzTeam(getTeamFromColorIndex(team))),
      message: rawText,
      messageType: msgType === 'action' ? 1 : 0,
    };
  });
  const text = raw ? String(raw.message ?? '') : rawText;
  if (!text) return;

  // A muted player has no `talk` permission upstream, and this is upstream's own
  // sentence for it (bzfs.cxx:1667). The exception is upstream's too: somebody
  // who may still send on the admin channel does, which is what leaves a muted
  // player a way to ask about it.
  if (player.muted && !(targetId === ADMIN_PLAYERS && isAdmin(player))) {
    log(`[CHAT] "${fromName}" refused: muted`);
    replyToPlayer(player, "We're sorry, you are not allowed to talk!");
    return;
  }

  // How a chat destination is written in the log. A player is in quotes and a
  // team is in brackets, as they are everywhere else; ALL and SERVER are
  // neither, so they are bare. See the log conventions in AGENTS.md -- the
  // bracket is what says "team", so the word would be as redundant as "Player"
  // before a quoted name.
  const describeChatTarget = (id) => {
    if (id === ALL_PLAYERS) return 'ALL';
    if (id === SERVER_PLAYER) return 'SERVER';
    if (channelTeam(id) !== null) return `[${String(getTeamFromColorIndex(channelTeam(id))).toUpperCase()}]`;
    if (id === ADMIN_PLAYERS) return '[ADMIN]';
    return players.has(id) ? `"${players.get(id).name}"` : `"Player ${id}"`;
  };
  const toName = describeChatTarget(targetId);

  // Log locally only, for a line addressed to the server itself
  if (targetId === SERVER_PLAYER) {
    log(`[CHAT] "${fromName}"->${toName}: ${text}`);
    return;
  }

  if (targetId === ALL_PLAYERS) {
    log(`[CHAT] "${fromName}"->ALL: ${text}`);
    chatMirror?.relay(fromName, text, msgType, isAdmin(player) ? '@' : (player.verified ? '+' : ''));
    broadcastAll({
      type: 'message',
      src: fromId,
      dst: ALL_PLAYERS,
      msgType,
      text,
      ts: Date.now(),
    });
    return;
  }

  // Team chat, to the team the destination names (`FirstTeam - team`,
  // bzfs.cxx:1719). bzfs's own team dispatch sends to every player whose
  // `isTeam(_team)` matches it, with no exception for Rogue or Observer --
  // which is the rule the `voice-channels` module already spells out for the
  // Team voice channel, so both use it. The sender is included whatever their
  // team, as upstream includes them in a private message: a message you
  // cannot see you have sent is worse than one echoed back.
  const chatTeam = getTeamFromColorIndex(channelTeam(targetId));
  if (chatTeam) {
    log(`[CHAT] "${fromName}"->${toName}: ${text}`);
    const payload = {
      type: 'message',
      src: fromId,
      dst: targetId,
      msgType,
      text,
      ts: Date.now(),
    };
    const encoded = JSON.stringify(payload);
    players.forEach((other) => {
      if (other.team !== chatTeam && other !== player) return;
      if (other.ws && other.ws.readyState === 1) other.ws.send(encoded);
    });
    return;
  }

  // The admin channel. Upstream gates both ends of it and answers a sender with
  // no permission in its own words (bzfs.cxx:1546), rather than dropping the
  // message silently -- somebody typing into a channel nobody hears should be
  // told.
  if (targetId === ADMIN_PLAYERS) {
    if (!isAdmin(player)) {
      log(`[CHAT] "${fromName}"->[ADMIN] refused: not an admin`);
      replyToPlayer(player, 'You do not have permission to speak on the admin channel.');
      return;
    }
    log(`[CHAT] "${fromName}"->[ADMIN]: ${text}`);
    const payload = JSON.stringify({
      type: 'message',
      src: fromId,
      dst: ADMIN_PLAYERS,
      msgType,
      text,
      ts: Date.now(),
    });
    // The sender is included, as they are for team chat: a message you cannot
    // see you have sent is worse than one echoed back.
    for (const admin of getAdmins()) {
      if (admin.ws && admin.ws.readyState === 1) admin.ws.send(payload);
    }
    return;
  }

  // Send to specific player if id exists
  if (typeof targetId === 'string' && players.has(targetId)) {
    log(`[CHAT] "${fromName}"->${toName}: ${text}`);
    const targetPlayer = players.get(targetId);
    const payload = {
      type: 'message',
      src: fromId,
      dst: targetId,
      msgType,
      text,
      ts: Date.now(),
    };
    if (targetPlayer && targetPlayer.ws && targetPlayer.ws.readyState === 1) {
      targetPlayer.ws.send(JSON.stringify(payload));
    }
    if (player.ws && player.ws.readyState === 1 && targetId !== fromId) {
      player.ws.send(JSON.stringify(payload));
    }
    return;
  }

  // If targetId is invalid, ignore
}

// The admin channel's audience: everyone `adminMessageReceive` would allow.
function getAdmins() {
  const admins = [];
  players.forEach((candidate) => {
    if (isAdmin(candidate)) admins.push(candidate);
  });
  return admins;
}

// `@`, `+` and `-` are the authentication indicators upstream draws beside a
// callsign (`ScoreboardRenderer.cxx:718`), and bzo draws the same characters. A
// name may not start with one, so nobody can wear an indicator they were not
// given -- most of all where a name is written as plain text and there is no
// separate field to draw it in, like a chat line or the server log.
//
// Stripped rather than refused outright, so a name that only offends this rule
// still joins under something close to what was typed. `nameCheck` already
// substitutes rather than erroring everywhere else.
const NAME_INDICATOR_PREFIX = /^[@+-]+/;

function stripNameIndicators(requestedName) {
  return typeof requestedName === 'string' ? requestedName.replace(NAME_INDICATOR_PREFIX, '') : requestedName;
}

function nameCheck(requestedName, excludeId = null) {
  let name = stripNameIndicators(requestedName);
  name = name && name.trim() ? name.trim() : '';
  // Get the player number for excludeId
  let playerNumber = null;
  if (excludeId) {
    const playerObj = Array.from(players.values()).find(p => p.id === excludeId);
    if (playerObj) playerNumber = playerObj.playerNumber;
  }
  // If name is empty, assign 'Player n' for their own player number
  if (name.length === 0) {
    if (playerNumber !== null) {
      return `Player ${playerNumber}`;
    }
  }
  // Prevent picking a 'Player n' name unless n matches their player number
  const playerNameMatch = name.match(/^Player\s*(\d+)$/i);
  if (playerNameMatch) {
    const n = parseInt(playerNameMatch[1], 10);
    if (playerNumber === null || n !== playerNumber) {
      // Not allowed to pick a Player n name unless n matches their player number
      return `Player ${playerNumber !== null ? playerNumber : 1}`;
    }
  }
  // Check if name is already taken
  const nameTaken = Array.from(players.values()).some(p => p.id !== excludeId && !p.superseded && p.name && p.name.toLowerCase() === name.toLowerCase());
  if (nameTaken) {
    // Assign 'Player n' for their own player number
    if (playerNumber !== null) {
      return `Player ${playerNumber}`;
    }
  }
  return name;
}
// A page's reconnect carries the token its earlier connection joined with
// (client.js `PAGE_TOKEN`). That earlier connection is the same player, gone
// quiet on a network that dropped and still holding the name until the pong
// timeout: it is closed now, and left out of the name check before its close
// arrives.
function supersedeEarlierConnection(player, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return;
  player.pageToken = token;
  for (const other of players.values()) {
    if (other === player || other.superseded || other.pageToken !== token) continue;
    other.superseded = true;
    log(`"${other.name}" (#${other.playerNumber}) replaced by its own reconnect, player ${player.playerNumber}`);
    try {
      other.ws.terminate();
    } catch (error) {
      logError(`Could not close the connection for "${other.name}"`, error);
    }
  }
}

// What a joining player is called, once authentication can outrank a typed
// name. See docs/login-plan.md, "Name collisions".
//
// An authenticated player **is** their global callsign: not a name they asked
// for, not one with an indicator typed into it, and not a fallback if somebody
// else is standing on it. Upstream protects a registered callsign the same way,
// by refusing it to anyone who cannot prove it is theirs; bzo cannot ask that
// question of an unauthenticated player at all -- it learns nothing about a
// callsign without a token -- so the protection runs the other way round and
// the proof arrives with the claimant.
function resolveJoinName(player, requestedName) {
  const session = sessions.get(player.sessionId);
  if (!session) return nameCheck(requestedName, player.id);

  const callsign = session.callsign;
  for (const other of players.values()) {
    if (other.id === player.id || !other.joined || other.superseded) continue;
    if ((other.name || '').toLowerCase() !== callsign.toLowerCase()) continue;

    if (other.verified) {
      // Two authenticated players can only collide by being the same account on
      // a second device, and the newest device wins: signing in elsewhere to do
      // admin work is a real thing to want.
      //
      // The superseded session is dropped as well, and that is not optional --
      // bzo clients rejoin without waiting for a click, so a kicked device
      // would reconnect, authenticate as the same callsign, and kick whatever
      // kicked it, forever. Without its session it comes back as an ordinary
      // anonymous player.
      log(`"${callsign}" signed in again on another device;`
        + ` dropping player ${other.playerNumber} and its session`);
      if (other.sessionId) sessions.remove(other.sessionId);
      other.verified = false;
      other.bzid = null;
      other.sessionId = null;
      sendToPlayer(other, {
        type: 'message',
        src: SERVER_PLAYER,
        dst: other.id,
        msgType: 'server',
        ...localized('You signed in as {player} on another device.', { player: callsign }),
      });
      sendToPlayer(other, { type: 'superKill' });
      try {
        other.ws.close();
      } catch (error) {
        logError(`Could not close the superseded connection for "${callsign}"`, error);
      }
      continue;
    }

    // An unauthenticated player is renamed rather than disconnected: it frees
    // the name just as well and leaves them in the game they were in the
    // middle of.
    const assigned = `Player ${other.playerNumber}`;
    log(`"${other.name}" renamed to "${assigned}": "${callsign}" signed in and owns that name`);
    other.name = assigned;
    sendToPlayer(other, {
      type: 'message',
      src: SERVER_PLAYER,
      dst: other.id,
      msgType: 'server',
      ...localized('{player} signed in with that name, so yours is now {name}.', { player: callsign, name: assigned }),
    });
    broadcastPlayerRecord('playerUpdated', other);
  }

  if (requestedName && requestedName.trim() && requestedName.trim() !== callsign) {
    log(`"${requestedName.trim()}" ignored: player ${player.playerNumber} is signed in as "${callsign}"`);
  }
  return callsign;
}

function distance(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}


function getBoxCollisionDistanceSquared(localX, localZ, halfW, halfD) {
  const closestX = Math.max(-halfW, Math.min(localX, halfW));
  const closestZ = Math.max(-halfD, Math.min(localZ, halfD));
  const distX = localX - closestX;
  const distZ = localZ - closestZ;
  return distX * distX + distZ * distZ;
}


function getCollisionColliders() {
  return buildCollisionColliders(OBSTACLES, GAME_CONFIG.MAP_SIZE, mapNoWalls, GAME_CONFIG.WALL_HEIGHT);
}

// `options.rotation` selects BZFlag's two occupant shapes: a heading makes the
// occupant an oriented 2.8 x 6.0 box (Obstacle::inBox, used for tanks), and its
// absence keeps the cylinder (Obstacle::inCylinder, correct for projectiles).
// Every obstacle's top, teleporters included: the importer resolves a
// teleporter's frame into `w`/`d`/`h` so there is no special case left here.
function getColliderTopY(obs) {
  // A mesh has no `.h` at all -- see `getObstacleHeight`'s own same check --
  // so `baseY + h` silently answers `baseY` (the mesh's own *bottom*) for
  // one instead of its real top.
  if (!obs) return 0;
  if (obs.type === 'mesh' && obs.bounds) return getObstacleBase(obs) + getObstacleHeight(obs);
  return getObstacleBase(obs) + (Number.isFinite(obs.size?.[2]) ? obs.size[2] : 0);
}

// The solid an occupant is inside of, or false. The loop is `findTankObstacle`
// in the shared `collision` module and the client calls the same one: this says
// which world to look at, and logs, which the client has no reason to.
//
// `tankRadius` is the occupant's radius *and* its height -- 2 for a tank, much
// less for a projectile -- which is what every caller here means by it. A
// `rotation` in `options` takes the oriented tank box instead of the cylinder,
// and the rest of `options` passes straight through: `slack` (the server's own
// permissiveness about a quantized position), `tankScale`, `phased`,
// `ignoreTeleporters`.
//
// The vertical gate keeps the 0.15 it has always had here, and only here: it can
// only ever make the server *more* permissive than the client, which is the
// direction anticheat slack is allowed to run in.
function checkCollision(x, y, z, tankRadius = 2, options = {}) {
  const obs = findTankObstacle(getCollisionColliders(), x, y, z, {
    azimuth: options.azimuth,
    radius: tankRadius,
    height: options.height,
    slack: options.slack,
    tankScale: options.tankScale,
    phased: options.phased === true,
    // Never the reversing term: `fs` is measured from the displacement the tank
    // actually made, so a tank scraping backwards off a corner reports a reverse
    // it never asked for, and a server that expelled on that would rubber-band
    // an honest one. The looser answer is the safe direction for a check whose
    // whole job is catching a client that lied.
    reversingOnGround: false,
    ignoreTeleporters: options.ignoreTeleporters === true,
    verticalEpsilon: 0.15,
  });
  if (!obs) return false;
  if (options.suppressLog !== true) {
    const base = getObstacleBase(obs);
    // A mesh has no single position/rotation to report -- checked directly
    // against upstream: `MeshObstacle`'s own constructor never calls
    // `Obstacle`'s position-taking one, so it inherits the base `Obstacle()`
    // default (0, 0, rotation 0) and never relies on it for anything real
    // either. bzo's own mesh objects go further and carry no such field at
    // all, so `obs.pos`/`obs.angle` are `undefined` here rather
    // than a meaningless zero -- printing the bounds center in their place
    // for a mesh is at least a real point on the thing that was hit, which
    // upstream's own zero never was; `rotation` has no such stand-in, since
    // an arbitrary mesh has no one facing to report.
    // In upstream's frame, as the map states it.
    const posX = Number.isFinite(obs.pos?.[0]) ? obs.pos[0] : ((obs.bounds?.minX + obs.bounds?.maxX) / 2 || 0);
    const posY = Number.isFinite(obs.pos?.[1]) ? obs.pos[1] : ((obs.bounds?.minY + obs.bounds?.maxY) / 2 || 0);
    const angle = Number.isFinite(obs.angle) ? obs.angle : 0;
    log(`[COLLISION] ${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)} ${obs.name}:${obs.type}`
      + ` ${posX.toFixed(2)},${posY.toFixed(2)},${base.toFixed(2)} angle:${angle.toFixed(2)},`

      + ` h:${getObstacleHeight(obs).toFixed(2)}, top:${getColliderTopY(obs).toFixed(2)}`);
  }
  return obs;
}

// The one physics-driver lookup the server side needs -- `findPhysicsSurfaceObstacle`
// stands in for the "what is this tank currently resting on" concept the
// client tracks as `lastMotionObstacle` (`resolvePhysicsDriverAt` in the
// shared `collision` module is the rest of it, and is what guarantees the two
// sides can never disagree about which driver, if any, applies). Not
// `checkCollision`: that is an anti-cheat penetration test, deliberately
// forgiving of a tank resting exactly on solid ground, which is the one
// case this needs to catch. Used both to let an honest conveyor rider clear
// `validateMovement`'s drift check, and to find a `death` driver.
function getSupportPhysicsDriver(x, y, z) {
  const obs = findPhysicsSurfaceObstacle(getCollisionColliders(), x, y, z, 2, 2);
  return obs ? resolvePhysicsDriverAt(obs, x, y, z) : null;
}


// RandomSpawnPolicy::getPosition. A player waiting to restart at base spawns on
// a random point of one of their own team's bases, which is every spawn in CTF
// and every spawn after a capture. Rogue has no base to claim -- a `base`'s
// colour is always clamped to 1-4 -- so this is also the path a map's `team`
// zone answers: a colour team's own base always wins when it has one, and a
// zone only ever speaks for whoever a base left unanswered.
// Where a tank comes alive, which a plugin may move (bz_eGetPlayerSpawnPosEvent,
// bzfs.cxx:3263): the place chosen below is offered, and whatever it holds
// after the plugins have seen it is used.
function getSpawnPosition(player) {
  const chosen = chooseSpawnPosition(player);
  const asked = pluginEvent('bz_eGetPlayerSpawnPosEvent', () => ({
    playerID: Number(player.id), team: bzTeam(player.team), handled: false,
    pos: pluginPos(chosen), rot: chosen.azimuth,
  }));
  if (!asked) return chosen;
  const [x, y, z] = asked.pos.map(Number);
  if (![x, y, z, Number(asked.rot)].every(Number.isFinite)) return chosen;
  return { ...chosen, x, y, z, azimuth: Number(asked.rot) };
}

function chooseSpawnPosition(player) {
  const testSpawn = getTestSpawn(player.name);
  if (testSpawn) return testSpawn;

  const colorIndex = getTeamColorIndex(player.team);
  // `freeCtfSpawns` (RandomSpawnPolicy.cxx:49) drops this whole branch from
  // the choice rather than only skipping it once: `restartOnBase` is left set
  // rather than cleared, because upstream never consults it again while the
  // BZDB var is true, and a map may still flip it off mid-match.
  if (player.restartOnBase && !mapFreeCtfSpawns) {
    player.restartOnBase = false;
    const base = getRandomTeamBase(colorIndex);
    if (base) {
      return { ...getRandomBasePosition(base), azimuth: Math.random() * Math.PI * 2 };
    }
  }
  // SpawnPolicy::getPosition's `else` (SpawnPolicy.cxx:66-167): everything
  // that is not a base-priority restart asks the zone qualifier before it
  // falls to a plain random point. That is every ordinary death -- upstream
  // only forces `restartOnBase` back to true on a capture, never on a kill --
  // so a `team` zone is what a self-destructed or shot-down colour tank comes
  // back on, not only what rogue always does.
  const tanks = [...players.values()]
    .filter((other) => other !== player && other.joined && other.alive && !isObserverTeam(other.team))
    .map((other) => ({
      x: other.x, y: other.y, z: other.z, azimuth: other.azimuth, team: other.team,
      flag: getPlayerFlag(other.id)?.type ?? null,
    }));
  return pickSpawnPosition({
    colliders: getCollisionColliders(),
    mapSize: GAME_CONFIG.MAP_SIZE,
    waterLevel: mapWaterLevel?.height,
    zones: teamSpawnZones(MAP_ZONES, colorIndex),
    config: GAME_CONFIG,
    tanks,
    isFoe: (other) => areFoes(other.team, player.team, TEAMS_ALLOWED),
  });
}

// A fixed spawn for automated testing, so a probe always starts at a known
// distance from known geometry -- or on a known flag zone -- instead of
// somewhere random. Set `testSpawn` in server.json to enable; it is absent from
// example-server.json, so a normal server never has one.
//
// One entry or a list of them. A list is what a session doing both at once
// wants: a probe being moved from flag zone to flag zone should not cost the
// person testing beside it their own fixed spawn, and a single object made every
// change to one an edit to the other.
//
// The coordinates are written by hand against one map's geometry, so they are
// resolved against the world that actually loaded rather than trusted: see
// `dropSpawnPosition`.
function getTestSpawn(name) {
  return TEST_SPAWNS.get(name) || null;
}

// `dropSpawnPosition` in public/js/spawn.mjs, on this world.
function dropSpawnPosition(x, y, z, azimuth) {
  return dropSpawnPositionOn(getCollisionColliders(), x, y, z, azimuth, mapWaterLevel?.height);
}

// Resolved once, when the world is loaded, and held in memory for as long as
// that world is. `server.json` is the operator's own file and is never written
// back to: the coordinates they typed are what they meant, and this is only
// where those coordinates put a tank on the map that loaded.
const TEST_SPAWNS = new Map();

function rebuildTestSpawns() {
  TEST_SPAWNS.clear();
  const configured = serverConfig.testSpawn;
  const spawns = Array.isArray(configured) ? configured : (configured ? [configured] : []);
  for (const spawn of spawns) {
    if (typeof spawn?.name !== 'string') continue;
    // In upstream's frame, as `/pos` prints it: `azimuth` in radians.
    const x = Number(spawn.x) || 0;
    const y = Number(spawn.y) || 0;
    const z = Number(spawn.z) || 0;
    const at = { x, y, z };
    const azimuth = Number(spawn.azimuth) || 0;
    const droppedY = dropSpawnPosition(at.x, at.y, at.z, azimuth);

    if (droppedY === null) {
      log(
        `Test spawn "${spawn.name}" at ${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`
        + ' has nowhere to stand on this map; that player spawns at random instead'
      );
      continue;
    }
    if (Math.abs(droppedY - z) > SPAWN_DROP_FUDGE * 2) {
      log(
        `Test spawn "${spawn.name}" dropped from z ${z.toFixed(2)}`
        + ` to ${droppedY.toFixed(2)} at ${x.toFixed(2)},${y.toFixed(2)}`

      );
    }
    TEST_SPAWNS.set(spawn.name, { x: at.x, y: at.y, z: droppedY, azimuth });
  }
}

// Anti-cheat mode decides what happens to a packet the server believes an
// unmodified client could not have sent. `strict` refuses it. `warning` honours
// it and only writes the disagreement to the log, so a false positive shows up
// as a log line instead of as a rubber-band, a swallowed shot or a jump that
// never happens -- which is the whole point of the mode: you cannot work out
// why the server disbelieved a packet if the server has already changed the
// game to hide it. `disabled` does not look.
//
// A malformed packet is not an anti-cheat finding and does not come here: a
// non-finite position or a zero-length shot direction cannot be honoured in any
// mode, so those are refused everywhere and logged as MALFORMED.
//
// Every caller must route its rejection through this function and obey the
// return value. Returns true when the packet must be refused.
function reportCheat(player, kind, headline, detail = null, enforceable = true) {
  if (ANTICHEAT_CONFIG.mode === 'disabled') return false;

  const counters = player.cheatWarnings;
  if (counters[kind] !== undefined) counters[kind]++;
  counters.totalWarnings++;
  counters.lastWarningTime = Date.now();

  // A BZFlag client's tank is its own physics, which bzo cannot correct and
  // does not yet match, so a finding about one is reported, not refused.
  const refused = enforceable && ANTICHEAT_CONFIG.mode === 'strict' && !player.native;
  // One line per finding, the detail after the headline, so a finding is
  // one grep hit and never interleaves with another player's.
  const parts = [headline, ...(detail ? [].concat(detail) : [])];
  log(
    `[ANTICHEAT:${ANTICHEAT_CONFIG.mode.toUpperCase()}] "${player.name}" ${parts.join(' | ')}`
    + ` | ${refused ? 'REFUSED' : 'ALLOWED'} | Warnings: ${counters.totalWarnings}`
  );
  return refused;
}

// A position and heading as the drift findings print it: `x,y,z r`.
function formatCheatPose(x, y, z, r) {
  return `${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)} r${r.toFixed(2)}`;
}

// Every kind that fired at least once, so a new counter shows up in the summary
// and the disconnect line without either of them having to list them all.
function formatCheatWarnings(player) {
  const parts = Object.entries(player.cheatWarnings)
    .filter(([kind, count]) => kind !== 'totalWarnings' && kind !== 'lastWarningTime' && count > 0)
    .map(([kind, count]) => `${count} ${kind}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

// A packet the server cannot act on at all, in any mode. Not counted as an
// anti-cheat warning: nothing about it is a judgement call.
function logMalformed(player, what, detail) {
  log(`[ANTICHEAT] "${player.name}" MALFORMED ${what}: ${detail}`);
}

// Validate player movement
//
// `now` is the caller's own handler-entry clock, not a fresh read: re-reading
// Date.now() here would let the extrapolation below disagree with the interval
// it is being compared against by however long this call took to reach -- the
// "several checks inside one move handler read the clock independently" gap
// docs/lag-plan.md names.
//
// `extrapolationSeconds` is the interval `getExtrapolatedPosition` extrapolates
// over. The move handler passes the client's own clamped interval (see
// `clampToArrivalGap`) so the drift check compares against how far the tank's
// *own* clock says it travelled, not how long the packet happened to spend in
// the network -- docs/lag-plan.md, "Extrapolate on the client's clock, not
// ours". Every other caller has no client timestamp to offer and passes the
// server's own arrival gap instead.
function validateMovement(player, newX, newY, newZ, newAzimuth, extrapolationSeconds, velocityChanged = false, options = {}, now = Date.now()) {
  // A non-finite coordinate would poison the stored position and every
  // extrapolation made from it afterwards, so it is refused in every mode.
  if (!Number.isFinite(newX) || !Number.isFinite(newY)
    || !Number.isFinite(newZ) || !Number.isFinite(newAzimuth)) {
    logMalformed(player, 'MOVE', `(${newX}, ${newY}, ${newZ}, azimuth=${newAzimuth})`);
    return false;
  }

  // A paused tank is invulnerable, so driving while paused is worth a warning,
  // but an unmodified client also sends the odd in-flight move as the pause
  // takes effect. Warning mode wants to see how often that is what this is.
  // A paused tank still sends its heartbeat (`sendFrozenHeartbeat` in
  // client.js) from where it stands, which is no move at all: only a pose
  // that differs from the stored one, past the wire's rounding, is reported.
  const movedFromStored = Math.abs(newX - player.x) > 0.01
    || Math.abs(newY - player.y) > 0.01
    || Math.abs(newZ - player.z) > 0.01
    || Math.abs(normalizeAngle(newAzimuth - player.azimuth)) > 0.01;
  if (player.paused && movedFromStored && reportCheat(player, 'movedWhilePaused', 'MOVED WHILE PAUSED', [
    `Recvd: (${newX.toFixed(2)}, ${newY.toFixed(2)}, ${newZ.toFixed(2)}, azimuth=${newAzimuth.toFixed(2)})`,
  ])) {
    return false;
  }

  if (ANTICHEAT_CONFIG.mode !== 'disabled') {
    // Get extrapolated position based on last known velocities
    const timeSinceLastUpdate = Number.isFinite(extrapolationSeconds)
      ? extrapolationSeconds
      : (now - player.lastUpdate) / 1000;
    const extrapolated = player.getExtrapolatedPosition(now, timeSinceLastUpdate);

    // Compare to extrapolated position, not last stored position
    // With velocity-based dead reckoning, the client position should match extrapolated position
    // We allow a tolerance based on physics drift, network jitter, and rounding errors
    // If velocity changed, use much looser validation since extrapolation doesn't account for it
    const distMoved = distance(extrapolated.x, extrapolated.y, newX, newY);
    const maxDrift = velocityChanged ? ANTICHEAT_CONFIG.linearDriftThresholdVelocityChanged : ANTICHEAT_CONFIG.linearDriftThreshold;

    if (distMoved > maxDrift) {
      const exceedAmount = distMoved - maxDrift;
      const likelihood = Math.min(100, (exceedAmount / maxDrift) * 100).toFixed(1);

      const refused = reportCheat(player, 'linearDrift',
        `LINEAR DRIFT ${distMoved.toFixed(2)} > ${maxDrift.toFixed(2)} (${likelihood}%)`,
        [
          `stored ${formatCheatPose(player.x, player.y, player.z, player.azimuth)}`
          + ` extrap ${formatCheatPose(extrapolated.x, extrapolated.y, extrapolated.z, extrapolated.azimuth)}`
          + ` recvd ${formatCheatPose(newX, newY, newZ, newAzimuth)}`,
          `fs=${player.forwardSpeed.toFixed(2)} rs=${player.rotationSpeed.toFixed(2)}`
          + ` vv=${player.verticalVelocity.toFixed(2)} dt=${timeSinceLastUpdate.toFixed(2)}s`
          + `${velocityChanged ? ' velChanged' : ''}`,
        ]);
      if (refused) return false;
    }

    // Calculate rotation change from extrapolated rotation
    const rotDiff = Math.abs(normalizeAngle(newAzimuth - extrapolated.azimuth));
    const maxRotDrift = ANTICHEAT_CONFIG.angularDriftThreshold;

    if (rotDiff > maxRotDrift) {
      const exceedAmount = rotDiff - maxRotDrift;
      const likelihood = Math.min(100, (exceedAmount / maxRotDrift) * 100).toFixed(1);

      const refused = reportCheat(player, 'angularDrift',
        `ANGULAR DRIFT ${rotDiff.toFixed(2)} > ${maxRotDrift.toFixed(2)} (${likelihood}%)`,
        [
          `azimuth stored ${player.azimuth.toFixed(2)} extrap ${extrapolated.azimuth.toFixed(2)}`
          + ` recvd ${newAzimuth.toFixed(2)}`,
          `rs=${player.rotationSpeed.toFixed(2)} dt=${timeSinceLastUpdate.toFixed(2)}s`,
        ]);
      if (refused) return false;
    }
  }

  // Check collision against the unified collider set (map objects + border
  // colliders). A move that ends inside an obstacle is the client and the server
  // disagreeing about the shape of the world, which is the same class of finding
  // as position drift and is reported the same way -- in warning mode the move
  // stands and the disagreement goes to the log, because a refusal here is what
  // rubber-bands an honest player and hides the geometry bug that caused it.
  if (ANTICHEAT_CONFIG.mode !== 'disabled') {
    // Only Burrow has any ground below zero, and being down there is what makes
    // a tank impervious to a level shot -- the height gate in the hit test is
    // the whole of the immunity, so a client that lied about its z would be
    // handing itself the flag's entire effect without carrying it. Reported as
    // the same class of finding as a collision, because it is the same thing:
    // the two ends disagreeing about where this tank is allowed to be.
    // Two honest ways under without the flag, both upstream's: a tank killed
    // while burrowed explodes where it died, and one that loses the flag
    // creeps back up (`applyGroundLimitCreep`). The creep is checked, not just
    // allowed, so staying down is still reported.
    const groundLimit = getPlayerGroundLimit(player);
    if (newZ >= groundLimit - ANTICHEAT_GROUND_SLACK) player.groundCreep = null;
    else if (player.alive && !isCreepingUp(player, newZ, groundLimit, now)) {
      const refused = reportCheat(player, 'collision',
        `BELOW GROUND: z ${newZ.toFixed(2)} < ${groundLimit.toFixed(2)}`
        + ` carrying ${getPlayerFlag(player.id)?.type ?? 'no flag'}`);
      if (refused) return false;
    }

    const ignoreTeleporters = options.ignoreTeleporters === true;
    const collision = checkCollision(newX, newY, newZ, 2, {
      ignoreTeleporters,
      azimuth: newAzimuth,
      slack: ANTICHEAT_CONFIG.collisionSlack,
      tankScale: getPlayerTankScale(player),
      phased: isPlayerPhased(player),
    });

    if (collision) {
      const at = `p ${newX.toFixed(2)},${newY.toFixed(2)},${newZ.toFixed(2)}`;
      let headline;
      if (collision === true) {
        headline = `COLLISION with unknown object (${at})`;
      } else if (collision.collisionKind === 'boundary') {
        headline = `COLLISION with boundary (${at})`;
      } else if (collision.type === 'mesh') {
        // A mesh carries no `x`/`w`/`d`/`h`/`rotation` at all -- it is
        // vertices and faces, and `obs.bounds` is the only box it has. Reading
        // the box fields off one threw, which took the whole message handler
        // with it and dropped the movement update this line only meant to
        // describe.
        const b = collision.bounds;
        headline = b
          ? `COLLISION obs:${collision.name} mesh`
            + ` x:${b.minX.toFixed(2)}..${b.maxX.toFixed(2)},`
            + ` y:${b.minY.toFixed(2)}..${b.maxY.toFixed(2)},`
            + ` z:${b.minZ.toFixed(2)}..${b.maxZ.toFixed(2)} (${at})`
          : `COLLISION obs:${collision.name} mesh (${at})`;
      } else {
        const [x, y, base] = collision.pos;
        const [halfW, halfD, h] = collision.size;
        headline = `COLLISION obs:${collision.name} ${x.toFixed(2)},${y.toFixed(2)},${base.toFixed(2)},`
          + ` size:${halfW.toFixed(2)},${halfD.toFixed(2)},${h.toFixed(2)},`
          + ` angle:${collision.angle.toFixed(2)} (${at})`;

      }
      if (reportCheat(player, 'collision', headline)) return false;
    }
  }

  // A `death` physics driver -- checked regardless of anti-cheat mode, since
  // this is a map's own gameplay rule, not a cheat detection. No killer to
  // score (`killPlayer(player, null, ...)`, the same shape a world-weapon
  // kill already has), and the driver's own mapper-authored message rides
  // along as `deathMessage` rather than through `reason`, which every other
  // caller already uses as a fixed lookup key, not display text.
  const deathDriver = getSupportPhysicsDriver(newX, newY, newZ);
  if (deathDriver && deathDriver.death) {
    killPlayer(player, null, DEATH_REASON.PHYSICS_DRIVER, null, null, deathDriver);
  }

  // `waterLevel` -- upstream's own words for it: "Any tanks that move below
  // this height will be destroyed" (the porteighty BZW docs page), checked
  // client-side against `myTank`'s and every robot's own position
  // (`playing.cxx:4196`/`:4851`, `WaterDeath`) and self-reported the same way
  // `SelfDestruct` is there. bzo has no client that reports its own death, so
  // this is the server's own copy of that same test, in the same place and
  // under the same "gameplay rule, not a cheat detection" reasoning the death
  // driver above gets -- and `killPlayer`'s own already-dead guard is what
  // keeps a tank that is both on a death driver and underwater from dying
  // twice for it. `height > 0` is upstream's own guard too: a `waterLevel 0`
  // plane sits exactly on the ground every tank already stands on, so this
  // would otherwise kill on arrival.
  if (mapWaterLevel && mapWaterLevel.height > 0 && newZ <= mapWaterLevel.height) {
    killPlayer(player, null, DEATH_REASON.WATER);
  }

  return true;
}

// How far under its own floor a tank may report itself before the server calls
// it a disagreement. A burrowed tank rests exactly at `_burrowDepth` and a
// rounded packet lands a hundredth either side of it, so the slack is a frame's
// worth of settling rather than a tolerance for anything a client could use.
const ANTICHEAT_GROUND_SLACK = 0.2;
// How much of the time since a tank went under the creep is not counted on,
// for the jitter in when updates arrive.
const ANTICHEAT_CREEP_JITTER = 0.25;

// Whether a tank below its ground limit has come up at least as far as the
// creep takes it: `vz >= -z / 2 + 0.5` (LocalPlayer.cxx:376), which from `z0`
// over `t` seconds is at least `1 - (1 - z0) e^(-t/2)`. Measured from where
// and when it was first seen under, so a tank that holds still is reported
// however often it sends; a tank that arrives under is not creeping.
function isCreepingUp(player, toZ, groundLimit, now) {
  if (!(player.z < groundLimit)) return false;
  if (!player.groundCreep) player.groundCreep = { z: player.z, at: now };
  const elapsed = (now - player.groundCreep.at) / 1000;
  // Moves the client sent before it heard the flag was gone are still
  // burrowed ones, sinking as far as the burrow depth.
  if (elapsed <= ANTICHEAT_CREEP_JITTER) return toZ >= getGroundLimit('BU') - ANTICHEAT_GROUND_SLACK;
  const t = elapsed - ANTICHEAT_CREEP_JITTER;
  const floor = Math.min(groundLimit, 1 - ((1 - player.groundCreep.z) * Math.exp(-t / 2)));
  return toZ >= floor - ANTICHEAT_GROUND_SLACK;
}

// Validate shot
// Every rejection here is a client/server inconsistency: an unmodified client
// never fires a shot the server refuses. Return the reason so the caller can log
// all of them the same way rather than some paths logging and others going
// quiet. Returns null when the shot is good, otherwise `{ reason, fatal }`.
//
// `fatal` marks a shot the server cannot turn into a projectile at all, so it is
// refused in every mode. Everything else is a tolerance the server has drawn
// somewhere the client has not, and warning mode fires the shot anyway: a
// swallowed shot tells the player nothing and tells the log nothing about which
// side was wrong.
// `now` is the caller's own handler-entry clock (see validateMovement), reused
// below for the projectile this shot creates so the position check and the
// shot's own createdAt agree about when it was fired.
function getShotRejection(player, shotX, shotY, shotZ, now = Date.now()) {
  // Upstream's own cap on the muzzle is BZDB_MUZZLEFRONT = "_tankRadius + 0.1"
  // (global.cxx), because upstream's own tank-vs-wall collision keeps the
  // tank's *center* a full tankRadius off a wall it approaches head-on. bzo's
  // collision is box-precise rather than a bounding circle, so a tank driven
  // straight into a flat wall stops with its nose (TANK_HALF_LENGTH, half the
  // tank's own length) right at the surface -- a closer approach than
  // upstream's circle ever allows. The client now clamps its model-derived
  // muzzle offset the same way (render.js, MAX_MUZZLE_FORWARD, issue #83):
  // tied to *this* tank's actual closest approach, not upstream's looser one.
  // And it scales with the tank as `Player::getMuzzle` (Player.cxx:224) moves
  // the muzzle: Obesity, Tiny and Thief by their factor, Narrow not at all.
  const barrelLength = (TANK.halfLength * getPlayerTankScale(player).length) + 0.1;

  if (!Number.isFinite(shotX) || !Number.isFinite(shotY) || !Number.isFinite(shotZ)) {
    return { reason: `shot origin is not finite (${shotX}, ${shotY}, ${shotZ})`, fatal: true };
  }

  // An observer has no tank, so there is no barrel for the shot to leave and
  // nothing for a return shot to hit. Not a tolerance: refused in every mode.
  if (isObserverTeam(player.team)) {
    return { reason: 'observer cannot shoot', fatal: true };
  }

  // A world with no shot slots at all (`-ms 0`, upstream's "tanks will not be
  // able to shoot"). Refused here, beside the observer, rather than down at
  // the slot count: every check between the two is non-fatal, so reaching one
  // of those first would let warning mode fire a shot in a world that has no
  // shooting. An overrun of a real slot count stays non-fatal -- that is the
  // honest disagreement warning mode exists to measure.
  if (GAME_CONFIG.SHOT_MAX_ACTIVE === 0) {
    return { reason: 'this world has no shot slots', fatal: true };
  }

  // invalidPlayerAction() (bzfs.cxx:4352) kicks a paused player who shoots, and
  // a paused tank cannot be shot back at. Not fatal for the same reason the dead
  // check below is not: the pause takes hold on the server, and a shot already
  // in flight from the client crosses it.
  if (player.paused) {
    return { reason: 'paused player cannot shoot', fatal: false };
  }

  // A dead tank firing is usually the client's shot crossing the server's kill,
  // which is exactly the timing warning mode exists to measure.
  if (!player.alive) {
    return { reason: 'dead player cannot shoot', fatal: false };
  }

  // Fire rate is limited by shot slots alone, matching bzfs: GameKeeper.cxx
  // addShot() rejects a shot only when its own slot is still live, and there is
  // no elapsed-time check. Slots each expire independently a full reload after
  // they were filled, so consecutive shots never share a timer and network
  // jitter cannot make an honest shot look early. See the slot check below.

  // Use extrapolated position, not stored position
  const extrapolated = player.getExtrapolatedPosition(now);
  const dist = distance(extrapolated.x, extrapolated.y, shotX, shotY);

  // NOTE: bzfs is far more permissive here. bzfs.cxx shotFired() allows
  // (tankSpeed * _velocityAd + 2 * _muzzleFront), tens of units, deliberately
  // absorbing a frame of tank motion and flag effects. bzo allows ~5. Watch the
  // ANTICHEAT log for position rejections during testing and widen this if
  // honest shots are being refused.
  if (dist > barrelLength + GAME_CONFIG.SHOT_POSITION_TOLERANCE) {
    return {
      reason: `shot from invalid position: ${dist.toFixed(2)} units from the barrel,`
        + ` limit ${(barrelLength + GAME_CONFIG.SHOT_POSITION_TOLERANCE).toFixed(2)}`
        + ` (extrapolated ${formatShotPoint(extrapolated.x, extrapolated.y, extrapolated.z)},`
        + ` shot ${formatShotPoint(shotX, shotY, shotZ)})`,
      fatal: false,
    };
  }

  // LocalPlayer::fireShot's "make sure we're allowed to shoot" (:1220), whose
  // third term is `location == InBuilding`. Not fatal: the shot and the move
  // that carried the tank into the building cross on the wire, and warning mode
  // exists to measure exactly that.
  // "((location == InBuilding) && !isPhantomZoned())" -- the zoned tank is the
  // exception upstream writes into the test itself. A zoned tank is *meant* to
  // shoot from inside a building; that is what a phantom bullet is for, and it
  // can only hit another zoned tank anyway.
  if (!isPlayerZoned(player)
    && isPlayerInsideBuilding(player, extrapolated.x, extrapolated.y, extrapolated.z, player.azimuth)) {
    return { reason: 'cannot shoot from inside a building', fatal: false };
  }

  if (getAvailableShotSlot(player, now) < 0) {
    const soonest = Math.min(...player.shotSlotFreeAt.slice(0, GAME_CONFIG.SHOT_MAX_ACTIVE));
    return {
      reason: `every shot slot is still reloading (${GAME_CONFIG.SHOT_MAX_ACTIVE} slots,`
        + ` next in ${Math.max(0, soonest - now)}ms)`,
      fatal: false,
    };
  }

  return null;
}

// A rejected shot means the client believed it could fire and the server did
// not. That is the same class of client/server disagreement the drift checks
// report, so it is counted and reported the same way. Returns true when the shot
// must not be fired: always for a fatal reason, otherwise only in strict mode.
// bzfs's own check on a shot's speed (shotFired, bzfs.cxx:4191) is an upper
// bound -- no faster than the shot speed plus the fastest a tank can go --
// because bzfs has no idea how fast this tank was going. bzo has: a client
// sends a move with every shot (LocalPlayer.cxx:1268), so the server holds the
// tank's velocity at the trigger. Take it away, and what is left must be the
// world's shot speed, neither faster nor slower -- and level, unless the world
// keeps vertical velocity. Not fatal: an honest client measures its own
// velocity off the same move, so a disagreement is one for warning mode to
// show.
const SHOT_VELOCITY_TOLERANCE = 0.5;
// How recent the move a shot is checked against has to be: a client sends one
// with every shot, so anything older is a client that did not.
const SHOT_MOVE_FRESH_MS = 1000;
function getShotVelocityRejection(player, velocity, now) {
  const keepVertical = GAME_CONFIG.SHOTS_KEEP_VERTICAL_VELOCITY === true;
  if (!keepVertical && Math.abs(velocity.z) > SHOT_VELOCITY_TOLERANCE) {
    return `shot climbs at ${velocity.z.toFixed(2)} in a world that keeps shots level`;
  }
  // The move's own fields are the wire's, so its velocity comes back in bzo's
  // frame and crosses.
  const fields = player.lastMoveFields;
  const stated = fields && now - fields.at < SHOT_MOVE_FRESH_MS
    ? moveVelocity(fields) : null;
  const tank = stated
    ? { vx: stated.x, vy: stated.y, vz: stated.z }
    : getPlayerMotion(player, getPlayerFlag(player.id)?.type ?? null, now);
  const muzzleSpeed = Math.hypot(
    velocity.x - tank.vx,
    velocity.y - tank.vy,
    keepVertical ? velocity.z - tank.vz : 0,
  );

  if (Math.abs(muzzleSpeed - GAME_CONFIG.SHOT_SPEED) > SHOT_VELOCITY_TOLERANCE) {
    return `shot leaves the tank at ${muzzleSpeed.toFixed(2)}, not the world's ${GAME_CONFIG.SHOT_SPEED}`
      + ` (tank moving at (${tank.vx.toFixed(2)},${tank.vy.toFixed(2)},${tank.vz.toFixed(2)}))`;
  }
  return null;
}

// The tank's velocity as an accepted move states it: the air velocity for a
// tank the move says is in the air, and on the ground `fs` along the slide
// heading or the tank's own. `fields` is the move's own, `a`, `sd`, `vx`, `vy`.
function moveVelocity(fields) {
  return packetVelocity(fields, GAME_CONFIG);
}

function reportShotRejection(player, reason, message, fatal) {
  const detail = `player=${player.id} at=${formatShotPoint(player.x, player.y, player.z)}`
    + ` sent=${formatShotPoint(Number(message.x), Number(message.y), Number(message.z))}`
    + ` vel=(${Number(message.vx)},${Number(message.vy)},${Number(message.vz)})`;

  if (fatal) {
    logMalformed(player, 'SHOT', `${reason} | ${detail}`);
    return true;
  }

  return reportCheat(player, 'shotRejected', `SHOT REJECTED: ${reason}`, [detail]);
}

// LocalPlayer::doJump refuses the jump on the client, so an unmodified client
// never sends one from a tank that may not leave the ground. bzfs does not check
// this at all -- upstream trusts the client with jumping entirely -- but bzo's
// server is where the anti-cheat line is drawn, and free flight on a no-jump
// world is a larger prize than a little position drift.
// Returns true when the jump must be refused, which in warning mode it is not:
// a jump the server swallows leaves the client airborne on its own screen and
// every frame of the flight afterwards is reported as drift, burying the one
// line that says what actually went wrong.
function reportJumpRejection(player, flagType) {
  return reportCheat(player, 'jumpRejected',
    `JUMP REJECTED: jumping is off and the tank carries ${flagType || 'no flag'}`);
}

// How long the slot a shot of this flag fills stays out of action, in ms.
function getSlotReloadMs(flag) {
  const worldReload = getWorldReloadSeconds(GAME_CONFIG);
  return getSlotReloadSeconds(worldReload, getShotEffects(flag).rateFactor) * 1000;
}

function getAvailableShotSlot(player, now) {
  return findFreeShotSlot(player.shotSlotFreeAt, GAME_CONFIG.SHOT_MAX_ACTIVE, now);
}

// Take the slot. Nothing gives it back early -- not a hit, not the shot running
// out of range -- so this is the only place a slot's clock is ever set, and the
// respawn that clears them all is the only place it is unset.
function occupyShotSlot(player, slot, flag, now) {
  if (!Number.isInteger(slot) || slot < 0) return;
  player.shotSlotFreeAt[slot] = now + getSlotReloadMs(flag);
}

// bzo's own games, recorded as upstream's `-recbuf` records: everything
// broadcast, buffered, and a recording only when an operator saves one
// (`/record`, `server/bzo-recorder.cjs`). On from boot, as the plan has it,
// so a game worth keeping can be kept after it happens.
const recorder = new BroadcastBuffer({ snapshot: recorderSnapshot });
// `/record file`: where the file being "streamed" started, and its name. The
// buffer is what holds it, so it is as long as the buffer is.
let recordFile = null;

// The game as a joining observer would be told it, everyone's view of it.
function recorderSnapshot() {
  return {
    bzdb: clientBzdb(),
    flags: getFlagStates(),
    players: [...players.values()].filter((player) => player.joined).map((player) => player.getState(false)),
    teamScores: getTeamScoreState(),
    rabbitId: rabbitPlayerId,
  };
}

// One broadcast into the buffer, with what converting it later will need
// that the game will have forgotten by then: the scores a kill left (tallied
// before it is sent, `killPlayer`), and the guided missiles a lock steers.
function recordBroadcast(data, message) {
  if (!recorder.recording) return;
  const entry = recorder.record(data);
  if (!entry || !message) return;
  if (message.type === 'killed') {
    entry.extra = { scores: {} };
    for (const id of [message.victimId, message.shooterId]) {
      const player = id === null || id === undefined ? null : players.get(String(id));
      if (player) entry.extra.scores[player.id] = { wins: player.wins, losses: player.losses, tks: player.tks };
    }
  } else if (message.type === 'gmUpdate') {
    entry.extra = {
      guided: {
        [String(message.playerId)]: [...projectiles.values()]
          .filter((proj) => proj.guided && String(proj.playerId) === String(message.playerId))
          .map((proj) => ({
            id: proj.id, x: proj.x, y: proj.y, z: proj.z,
            dirX: proj.dirX, dirY: proj.dirY, dirZ: proj.dirZ, speed: proj.speed,
            team: players.get(String(proj.playerId))?.team ?? null,
          })),
      },
    };
  }
}

// What a saved recording carries besides its packets (`saveHeader`). The world
// is the map file's own, as bzfs would load it -- not the one bzo serves native
// clients, which adds compass letters -- so its hash names the map, and the
// recording matches one made with bzfs on the same file.
function recordingHeader(callsign) {
  const generated = MAP_SOURCE === 'random';
  const mapPath = generated ? null : resolveMapFilePath(MAP_SOURCE);
  const text = generated ? RANDOM_WORLD_BZW : (mapPath ? fs.readFileSync(mapPath, 'latin1') : null);
  if (!text) throw new Error(`no map file for ${MAP_SOURCE}`);
  const world = packWorldDatabase(compileBzwWorld(text));
  const settings = packGameSettings(bzflagGameSettings());
  const frame = Buffer.alloc(4 + settings.length);
  frame.writeUInt16BE(settings.length, 0);
  frame.write('gs', 2, 'latin1');
  settings.copy(frame, 4);
  // `packFlagTypes`: each type in play, by its two-letter code.
  const types = [...new Set(flags.map((flag) => flag.type).filter(Boolean))];
  const flagTypes = Buffer.alloc(types.length * 2);
  types.forEach((type, index) => flagTypes.write(String(type).slice(0, 2), index * 2, 'latin1'));
  return {
    player: BZO_RECORDER_PLAYER,
    callsign: callsign || 'SERVER',
    motto: '',
    protocol: BZFS_PROTOCOL_VERSION,
    appVersion: BZO_APP_VERSION,
    worldHash: `${generated ? 't' : 'p'}${crypto.createHash('md5').update(world).digest('hex')}`,
    worldSettings: frame,
    flagTypes,
    world,
  };
}

// The last `seconds` of the buffer, or all of it, to `replays/<name>.rec`.
// Recorded as an upload so the Operator panel may delete it.
async function saveRecording(name, { seconds = null, from = null, callsign = '' } = {}) {
  const entries = from === null ? recorder.slice(seconds) : recorder.entries.filter((entry, index, all) => {
    const start = all.findLastIndex((e) => e.snapshot && e.at <= from);
    return index >= Math.max(0, start);
  });
  if (entries.length === 0) throw new Error('No buffer to save');
  const replay = bufferToReplay(entries, {
    header: recordingHeader(callsign),
    translator: {
      teamIndex: bzflagTeamIndex,
      config: () => GAME_CONFIG,
      flagName: (type) => getFlagType(type)?.name || '',
    },
  });
  const bytes = writeReplay(replay);
  await fs.promises.mkdir(RUNTIME_REPLAYS_DIR, { recursive: true });
  const filePath = path.join(RUNTIME_REPLAYS_DIR, `${name}.rec`);
  await fs.promises.writeFile(filePath, bytes);
  uploads.add('replays', name);
  invalidateListTables();
  log(`[RECORD] saved ${filePath}: ${bytes.length} bytes, ${replay.packets.length} packets,`
    + ` ${(replay.fileTime / 1e6).toFixed(1)} s`);
  return { filePath, bytes: bytes.length, packets: replay.packets.length, seconds: replay.fileTime / 1e6 };
}

// Broadcast to all players except sender
function broadcast(message, excludeWs = null) {
  const data = JSON.stringify(message);
  recordBroadcast(data, message);
  players.forEach((player) => {
    if (player.ws !== excludeWs && player.ws.readyState === 1) {
      sendBroadcast(player.ws, data, message);
    }
  });
}

// A BZFlag client's socket translates the message object itself
// (`sendMessage`), so it is spared parsing the string every browser is sent.
// The object is shared by every recipient and must not be changed.
function sendBroadcast(ws, data, message) {
  if (ws.sendMessage) ws.sendMessage(message);
  else ws.send(data);
}

// What an in-process sender (a BZFlag client's link, a bot) says, as the
// message handler would have parsed it off a browser's wire: a number JSON
// cannot carry arrives as `null`, which every check already reads as missing.
function asIfFromWire(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(asIfFromWire);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (value[key] !== undefined) out[key] = asIfFromWire(value[key]);
    }
    return out;
  }
  return value;
}

// One player's record, to everyone, in the shape each recipient is allowed to
// see it. Two payloads rather than one because `getState` hides a field from a
// non-admin, and two `JSON.stringify` calls are cheaper than one per recipient.
function broadcastPlayerRecord(type, subject) {
  const forAdmins = JSON.stringify({ type, player: subject.getState(true) });
  const forEveryone = JSON.stringify({ type, player: subject.getState(false) });
  recordBroadcast(forEveryone, null);
  players.forEach((player) => {
    if (player.ws.readyState !== 1) return;
    player.ws.send(isAdmin(player) ? forAdmins : forEveryone);
  });
}

// Broadcast to all players including sender
function broadcastAll(message) {
  const data = JSON.stringify(message);
  recordBroadcast(data, message);
  const byChannel = UDP_CHANNEL_DOWN_TYPES.has(message.type) && data.length <= UDP_CHANNEL_CHUNK_BYTES;
  players.forEach((player) => {
    if (player.ws.readyState !== 1) return;
    if (byChannel && player.udpChannel?.send(data)) {
      serverStats.countOut(data.length);
      return;
    }
    sendBroadcast(player.ws, data, message);
  });
}

// What rides a UDP channel, both ways: upstream's UDP list (`NetHandler::
// pwrite`, NetHandler.cxx:533, and `ServerLink::send`, ServerLink.cxx:429) --
// player updates, shots, shot ends and guided missile updates. The lag ping
// stays on the WebSocket, whose own ping it is. Upstream's client also sends
// MsgGMUpdate; bzo's server steers its own missiles, so nothing goes up.
const UDP_CHANNEL_UP_TYPES = new Set(['m', 'shoot']);
const UDP_CHANNEL_DOWN_TYPES = new Set(['shotBegin', 'shotEnd', 'gmUpdate']);
// The most a channel message carries: one packet, since a message split
// across packets is lost if any piece is, and under the 1024 bytes Chrome
// takes in a WebTransport datagram. Anything larger -- a laser's
// many-segment shotBegin -- takes the WebSocket.
const UDP_CHANNEL_CHUNK_BYTES = 1000;

// --- Flags -------------------------------------------------------------
//
// Mirrors bzfs: the server owns every flag, and the client animates a flight
// from the numbers that came with the event that started it. See
// docs/flags.md, and FlagInfo.cxx / bzfs.cxx upstream.
//
// A superflag lying on the ground is sent with `type: null`, because bzfs hides
// the identity of an unheld superflag from every client (bzfs.cxx:361). Picking
// one up reveals it to everyone.

// The radius the flag drop test uses for its clearance cylinder, and the step it
// walks that cylinder in. DropGeometry uses the tank radius; bzo's is 2.
const FLAG_DROP_TEST_RADIUS = 2;
// Upstream's drop clearance radius is 0; the collision test sees nothing of
// no width, so a drop is tested this thin instead.
const FLAG_DROP_POINT_RADIUS = 0.05;
// launchPosition sits on top of the tank, not at its feet. Upstream reads
// tankHeight from BZDB; bzo's tanks are 2 units tall.
const FLAG_LAUNCH_TANK_HEIGHT = 2;

// Team bases, as bzfs keeps them in its `bases` map. A BZW `base` object carries
// a BZFlag colour index, which parseBZWMap already clamps to 1-4.
let BASES_BY_TEAM = new Map();

function rebuildTeamBases(obstacles = OBSTACLES) {
  BASES_BY_TEAM = new Map();
  obstacles.forEach((obs) => {
    if (obs.kind !== 'base') return;
    const bases = BASES_BY_TEAM.get(obs.team) || [];
    bases.push(obs);
    BASES_BY_TEAM.set(obs.team, bases);
  });
}

function getTeamBases(colorIndex) {
  return BASES_BY_TEAM.get(colorIndex) || [];
}

// One point per colour team, the mean of its bases, for weighing where the
// second team on a map is founded. A team with several bases is represented by
// their middle; a team with none is absent, which selectPlayerTeam reads as
// having nothing to weigh and falls back to an even pick.
function getTeamBaseCenters() {
  const centers = {};
  BASES_BY_TEAM.forEach((bases, colorIndex) => {
    const team = getTeamFromColorIndex(colorIndex);
    if (!team || bases.length === 0) return;
    let sumX = 0;
    let sumZ = 0;
    bases.forEach((base) => {
      // Only the distances between them are weighed, so any two ground axes
      // will do: upstream's x and y.
      sumX += base.pos[0];
      sumZ += base.pos[1];
    });
    centers[team] = { x: sumX / bases.length, z: sumZ / bases.length };
  });
  return centers;
}

function getRandomTeamBase(colorIndex) {
  const bases = getTeamBases(colorIndex);
  return bases.length === 0 ? null : bases[Math.floor(Math.random() * bases.length)];
}

// TeamBase::getRandomPosition. A point on the base's top surface, kept a tank
// radius clear of its edges.
function getRandomBasePosition(base) {
  const spanX = Math.max(0, (2 * base.size[0]) - (2 * FLAG_DROP_TEST_RADIUS));
  const spanY = Math.max(0, (2 * base.size[1]) - (2 * FLAG_DROP_TEST_RADIUS));
  const localX = spanX * (Math.random() - 0.5);
  const localY = spanY * (Math.random() - 0.5);
  const turned = rotateXY(localX, localY, base.angle);
  return {
    x: base.pos[0] + turned.x,
    y: base.pos[1] + turned.y,
    z: getBaseTop(base),
  };

}

rebuildTeamBases(OBSTACLES);
// Once the world is loaded, and only then: a hand-written spawn is resolved
// against the geometry that actually arrived.
rebuildTestSpawns();
// ClassicCTF upstream. Team flags need both a team game and bases to stand on,
// so a team-mode map with no bases plays without them.
const CTF_ENABLED = TEAM_MODE.enabled && BASES_BY_TEAM.size > 0;
// Upstream names the game once and several rules read that name rather than
// re-deriving it. `CTF_ENABLED` and `TEAM_MODE` stay the ones to ask about
// bases and about colour teams; this is for the rules upstream writes in terms
// of the type as a whole.
const GAME_TYPE = getGameType(TEAM_MODE.enabled, BASES_BY_TEAM.size > 0, Boolean(RABBIT_SELECTION));
log(`Game type: ${GAME_TYPE}`);
// allowTeams (bzfs.cxx:3334). Whether this world has sides at all, which is what
// every team-kill question actually asks. Not `TEAM_MODE.enabled`: Rabbit Chase
// has sides -- the rabbit against the hunters -- while having no colour teams,
// so the two come apart there and only there.
const TEAMS_ALLOWED = allowTeams(GAME_TYPE);
// World::allowJumping, upstream's -j: off until the switch turns it on.
// `jumping: true` in server.json is the server-config equivalent of an
// operator passing `-j` themselves, and a map's own `-j` can still turn it
// on the same way it can on a real bzfs -- but, matching upstream, neither
// switch is on by default. With jumping off, `JP` is the only way a tank
// leaves the ground (except `WG`, which never asks) and is forbidden the
// other way around, once jumping is already on for everyone.
const ALLOW_JUMPING = serverConfig.jumping === true || mapServerOptions.jumping === true;
GAME_CONFIG.ALLOW_JUMPING = ALLOW_JUMPING;
// The upward velocity that counts as leaving the ground; see `isJumpStart`.
const JUMP_START_VERTICAL_VELOCITY = Math.max(
  0.05, (Number(GAME_CONFIG.JUMP_VELOCITY) || 19) * 0.1);
// RicochetGameStyle upstream, `+r`. Every shot bounces off walls whatever flag
// fired it. `ricochet` in `server.json` and `+r` in a map's `options` block both
// reach it, and as with every bzfs switch a map may turn it on and nothing turns
// it back off. Unlike upstream an operator may also flip it while the server
// runs, which is why the flag pool is filtered per draw rather than at startup.
GAME_CONFIG.ALL_SHOTS_RICOCHET = serverConfig.ricochet === true
  || mapServerOptions.ricochet === true;
// NoTeamKillsGameStyle upstream, `-noTeamKills`: players on the same team are
// immune to each other, and rogue is excepted because every rogue is every other
// rogue's foe. Off by default, as upstream has it, and a map may turn it on
// where nothing turns it back off.
//
// Upstream refuses the hit on each client, in LocalPlayer::checkHit, and its
// server scores whatever the client reports. bzo's server is the only thing that
// decides a hit, so this is asked once, there.
// `-a` from a map's `options` block. Upstream reads that block through the same
// parser as its command line, so a map may set the world's inertia exactly as it
// sets `-ms` or `+r`; the map's number simply replaces whatever came before it.
if (Number.isFinite(mapServerOptions.linearAcceleration)) {
  GAME_CONFIG.LINEAR_ACCELERATION = mapServerOptions.linearAcceleration;
}
if (Number.isFinite(mapServerOptions.angularAcceleration)) {
  GAME_CONFIG.ANGULAR_ACCELERATION = mapServerOptions.angularAcceleration;
}

const NO_TEAM_KILLS = serverConfig.noTeamKills === true
  || mapServerOptions.noTeamKills === true;
// `-disableBots`, which upstream publishes as `_disableBots` so a client
// knows before it asks; a map may `-set` that directly instead, and `/set`
// changes it live. Off by default, as upstream has it.
preBzdbConfig.DISABLE_BOTS = serverConfig.disableBots === true
  || mapServerOptions.disableBots === true;
if (preBzdbConfig.DISABLE_BOTS) GAME_CONFIG.DISABLE_BOTS = true;
else GAME_CONFIG.DISABLE_BOTS = GAME_CONFIG.DISABLE_BOTS === true;
function botsDisabled() {
  return GAME_CONFIG.DISABLE_BOTS === true;
}
// `-tk`, which runs the opposite way round from its name: upstream kills a team
// killer *by default* (`teamKillerDies` starts true, CmdLineOptions.h:79) and
// `-tk` is what turns that off. So the default here is the strict one, and a map
// or a config saying `teamKillerDies: false` is what makes it lenient -- again
// only ever in the direction a bzfs switch moves.
//
// With friendly fire off there is no team kill left to answer for, so the two
// switches never both apply.
const TEAM_KILLER_DIES = serverConfig.teamKillerDies !== false
  && mapServerOptions.teamKillerDies !== false;
log(
  `Team wins: ${NO_TEAM_KILLS ? 'friendly fire off (-noTeamKills)' : 'friendly fire on'}` +
  `; a team killer ${TEAM_KILLER_DIES ? 'dies for it' : 'does not die (-tk)'}`
);
// -st upstream, the shake timeout: seconds a bad flag sticks before it falls off
// by itself. Off by default, as upstream has it, so a bad flag is otherwise
// carried until it kills you. `flagShakeTimeout` in `server.json` and `-st` in a
// map's `options` block both reach it, and as with every bzfs switch the map may
// turn it on where nothing turns it back off -- so the larger of the two wins.
// The client runs the countdown and the server re-asks; see canShakeFlag.
// Tenths of a second, as bzfs holds and sends it; `flagShakeTimeout` is
// seconds, as `-st` is.
const FLAG_SHAKE_TIMEOUT = Math.max(
  shakeTimeoutTenths(serverConfig.flagShakeTimeout),
  mapServerOptions.flagShakeTimeout || 0,
);
GAME_CONFIG.FLAG_SHAKE_TIMEOUT = FLAG_SHAKE_TIMEOUT;
// -sw upstream, the shake win count: kills that shed a bad flag. Off by default
// like the timeout, and reached the same two ways. Upstream counts this down on
// the client and asks for the drop (`LocalPlayer::changeScore`); bzo's server
// owns the score, so it counts and drops, and the client is simply told.
const FLAG_SHAKE_WINS = Math.max(
  normalizeShakeWins(serverConfig.flagShakeWins),
  normalizeShakeWins(mapServerOptions.flagShakeWins)
);
GAME_CONFIG.FLAG_SHAKE_WINS = FLAG_SHAKE_WINS;
// -sa upstream, antidote flags: a yellow flag put in the world for as long as
// you are carrying a bad one, which sheds it when you drive onto it.
const ANTIDOTE_FLAGS = serverConfig.antidoteFlags === true
  || mapServerOptions.antidoteFlags === true;
GAME_CONFIG.ANTIDOTE_FLAGS = ANTIDOTE_FLAGS;
// -sl upstream, shot limits: a flag of a limited type is used up after that
// many shots. `shotLimits` in `server.json` ({ "GM": 5 }) and `-sl GM 5` in a
// map's `options` block; the map's count for a flag replaces the config's, as
// upstream reads a map's options after the command line.
const SHOT_LIMITS = new Map();
for (const source of [serverConfig.shotLimits, mapServerOptions.shotLimits]) {
  if (!source || typeof source !== 'object') continue;
  for (const [abbreviation, count] of Object.entries(source)) {
    const type = String(abbreviation).toUpperCase();
    const limit = normalizeShotLimit(count);
    if (!getFlagType(type) || limit === null) {
      logError(`[CONFIG] shot limit ignored: ${abbreviation} ${count}`);
      continue;
    }
    SHOT_LIMITS.set(type, limit);
  }
}
// -time upstream, the match clock: seconds until the match ends. Off by
// default -- no limit -- and reached the same two ways as -st: a map may only
// raise it, never shrink an operator's own setting.
GAME_CONFIG.TIME_LIMIT = Math.max(
  normalizeTimeLimit(serverConfig.timeLimit),
  normalizeTimeLimit(mapServerOptions.timeLimit),
);
// -timemanual upstream: the clock waits for /countdown instead of starting the
// moment the server has a limit to run.
GAME_CONFIG.TIME_MANUAL_START = serverConfig.timeManualStart === true
  || mapServerOptions.timeManualStart === true;
// -mps upstream, a player score limit: `Score::reached()` is wins minus losses
// reaching this, asked of the killer after every kill. Reached the same two
// ways as -st and -time.
GAME_CONFIG.MAX_PLAYER_SCORE = Math.max(
  normalizeScoreLimit(serverConfig.maxPlayerScore),
  normalizeScoreLimit(mapServerOptions.maxPlayerScore),
);
// -mts upstream, a colour team score limit: `checkTeamScore` ends the game the
// moment any one team's wins minus losses reaches this.
GAME_CONFIG.MAX_TEAM_SCORE = Math.max(
  normalizeScoreLimit(serverConfig.maxTeamScore),
  normalizeScoreLimit(mapServerOptions.maxTeamScore),
);
// The three ways upstream lets you shed a bad flag, for the startup log and for
// the message a player gets when they pick one up. With none of them on, dying
// is the only way out -- which is upstream's default.
function describeBadFlagRelease() {
  const ways = [];
  if (FLAG_SHAKE_TIMEOUT > 0) ways.push(`after ${shakeTimeoutSeconds(FLAG_SHAKE_TIMEOUT)}s`);
  if (FLAG_SHAKE_WINS > 0) ways.push(`after ${FLAG_SHAKE_WINS} ${FLAG_SHAKE_WINS === 1 ? 'win' : 'wins'}`);
  if (ANTIDOTE_FLAGS) ways.push('on the antidote');
  return ways.length > 0 ? ways.join(' or ') : 'only on death';
}
// -f upstream. A map may take a flag type out of the pool by abbreviation, or a
// whole quality out with `good` or `bad`, and nothing puts one back -- which is
// how every other switch a map carries behaves. Settled at startup because the
// map does not change under a running server.
const MAP_FORBIDDEN_FLAGS = Object.freeze(mapServerOptions.forbiddenFlags || []);
// CmdLineOptions.cxx:1705. Upstream drops a flag that contradicts the game style
// from the pool outright rather than leaving it to confuse people. `JP` and `NJ`
// are the two ends of the jumping switch and exactly one of them is ever worth
// carrying: on a jumping world `JP` grants what every tank already has, and on
// one without it `NJ` takes away what no tank had. `R` goes the same way as
// `JP`: on a world where every shot already ricochets it grants nothing.
function getForbiddenFlags() {
  // -f upstream, whatever the map took out of the pool by name or by quality.
  const forbidden = [...MAP_FORBIDDEN_FLAGS];
  forbidden.push(ALLOW_JUMPING ? 'JP' : 'NJ');
  if (GAME_CONFIG.ALL_SHOTS_RICOCHET) forbidden.push('R');
  // "geno only works in team games :)" -- a world with no teams has no team to
  // wipe, so Genocide is an ordinary shot wearing a rare flag's name. Upstream
  // leaves it in the pool and lets it do nothing; bzo takes it out, as it
  // already takes out `JP` on a world that always jumps and `R` on one that
  // always bounces.
  //
  // Rabbit Chase reaches this through the same test rather than a second one:
  // upstream forbids `G` when no colour team has a limit (CmdLineOptions.cxx:1693)
  // and Rabbit Chase is what zeroes them all, so `TEAM_MODE.enabled` is already
  // false by the time this is asked.
  if (!TEAM_MODE.enabled) forbidden.push('G');
  // "if (OBSTACLEMGR.getTeles().size() == 0) forbidden.insert(Flags::PhantomZone)"
  // (CmdLineOptions.cxx:1714). Crossing a teleporter is the only thing that
  // zones a tank, so on a map with none the flag can never be switched on --
  // which is the same reason `JP` goes out on a world that always jumps.
  if (!OBSTACLES.some((obs) => obs.kind === 'teleporter')) forbidden.push('PZ');
  // `WA` Wide Angle has no effect in bzo (docs/flags.md), so like `JP` on a
  // world that always jumps it is taken out rather than handed out to do
  // nothing. A proxied or replayed target can still hand one over.
  forbidden.push('WA');
  // `CB` and `MQ` are upstream's other two teamless voids and are deliberately
  // not taken: upstream's team mates share one colour, so with no teams both
  // flags say nothing, while bzo gives every player a colour of its own and both
  // still work. See docs/flags.md.
  return forbidden;
}
// -fb upstream. Whether a superflag may spawn on, and come to rest on, a
// building. A map's `options` block may turn it on; nothing turns it back off,
// which is how a bzfs switch behaves.
//
// `waterLevel` also turns it on, unasked -- upstream's own `bzfs.cxx:1218-1223`,
// which warns and does the same: with the ground itself underwater, "off the
// ground" is the only kind of surface `findFlagSpawnPosition` has left to put
// a flag on.
const FLAGS_ON_BUILDINGS = mapServerOptions.flagsOnBuildings === true
  || serverConfig.flagsOnBuildings === true
  || !!(mapWaterLevel && mapWaterLevel.height > 0);
if (mapWaterLevel && mapWaterLevel.height > 0 && !(mapServerOptions.flagsOnBuildings === true || serverConfig.flagsOnBuildings === true)) {
  log('Map option waterLevel: enabling flag spawns on buildings, the ground is underwater');
}

// -tft upstream. How long a team flag survives once its team has emptied and
// nobody is carrying it.
const configuredTeamFlagTimeout = Number(serverConfig.teamFlagTimeout);
const TEAM_FLAG_TIMEOUT_SECONDS = Number.isFinite(configuredTeamFlagTimeout) && configuredTeamFlagTimeout >= 0
  ? configuredTeamFlagTimeout
  : 30;

const flags = [];
// Colour index -> when that team's abandoned flag stops existing.
const teamFlagTimeouts = new Map();
let nextSuperFlagInsertionAt = 0;

function isTeamEmpty(colorIndex) {
  const team = getTeamFromColorIndex(colorIndex);
  for (const candidate of players.values()) {
    if (candidate.joined && candidate.team === team) return false;
  }
  return true;
}


// Which flags a world carries beyond its zones and team flags. A map that
// names any (`+f`, `-s`, `+s`) decides them alone; one that names none -- a
// generated world, or a map written without flags -- takes the server's,
// server.json's `requiredFlags` (each a `+f` value, `["good", "bad"]` being
// bzfs's `+f good +f bad`) and `superFlags`.
const MAP_NAMES_ITS_FLAGS = Object.keys(mapServerOptions.requiredFlagCounts || {}).length > 0
  || Number.isInteger(mapServerOptions.superFlagCount);
const REQUIRED_FLAG_COUNTS = MAP_NAMES_ITS_FLAGS
  ? (mapServerOptions.requiredFlagCounts || {})
  : (Array.isArray(serverConfig.requiredFlags) ? serverConfig.requiredFlags : [])
    .reduce((into, spec) => addRequiredFlags(spec, into), {});

// +s/-s upstream: how many superflag slots the world carries, and which types
// may fill them. A server carries none unless it is asked, as upstream's
// `numExtraFlags(0)` does, so a map written without flags is played without
// them. A `superFlags` block naming no usable count is upstream's bare `-s`,
// which means sixteen. `allowed` defaults to every superflag in the shared flag
// table, so asking for slots without naming types fills them from all of them.
function normalizeSuperFlagConfig(value) {
  const requestedCount = Number(value?.count);
  const count = Number.isInteger(requestedCount) && requestedCount >= 0
    ? requestedCount
    : (value ? 16 : 0);
  const requestedTypes = Array.isArray(value?.allowed) ? value.allowed : FLAG_ABBREVIATIONS;
  const allowed = requestedTypes
    .map((abbreviation) => (typeof abbreviation === 'string' ? abbreviation.trim().toUpperCase() : ''))
    .filter((abbreviation) => getFlagType(abbreviation) && !isTeamFlag(abbreviation));
  return {
    count: allowed.length > 0 ? count : 0,
    allowed,
  };
}

// -s upstream, the superflag count. A map's number replaces the config's rather
// than only raising it, for the same reason `-ms` does: upstream reads a map's
// `options` block where `-world` sits on its own command line, so the map's
// number is simply the later assignment.
const SUPER_FLAGS = normalizeSuperFlagConfig(
  Number.isInteger(mapServerOptions.superFlagCount)
    ? { ...serverConfig.superFlags, count: mapServerOptions.superFlagCount }
    : (MAP_NAMES_ITS_FLAGS ? { ...serverConfig.superFlags, count: 0 } : serverConfig.superFlags)
);

// What a slot is actually drawn from: everything the config allows, less
// whatever the map and the game style forbid right now. The game style can
// change while the server runs, so this is asked per draw rather than settled at
// startup.
function getSuperFlagPool() {
  const forbidden = getForbiddenFlags();
  return SUPER_FLAGS.allowed.filter((abbreviation) => !forbidden.includes(abbreviation));
}

// The same option bits `/list` already computes for a remote bzfs row
// (GAME_OPTION_BITS, server/remote-world-import.cjs), read off this server's
// own resolved config instead of decoded off the wire. bzo has no handicap
// pool, so that bit never sets.
function computeLocalGameOptionsBits() {
  let bits = 0;
  // Upstream's own test (CmdLineOptions.cxx:1861, "super flags?") is "does
  // the resolved world have any flag beyond the ones a team's base forces",
  // not "is the -s pool non-empty" -- a map's zone flags count too. `flags`
  // is that resolved world: a team flag always carries a non-null `team`,
  // so anything else (a zone flag or a pool slot) is what upstream calls a
  // super flag here.
  if (flags.some((flag) => flag.team === null)) bits |= GAME_OPTION_BITS.flags;
  if (GAME_CONFIG.ALLOW_JUMPING) bits |= GAME_OPTION_BITS.jumping;
  if (GAME_CONFIG.LINEAR_ACCELERATION > 0 || GAME_CONFIG.ANGULAR_ACCELERATION > 0) bits |= GAME_OPTION_BITS.inertia;
  if (GAME_CONFIG.ALL_SHOTS_RICOCHET) bits |= GAME_OPTION_BITS.ricochet;
  if (FLAG_SHAKE_TIMEOUT > 0 || FLAG_SHAKE_WINS > 0) bits |= GAME_OPTION_BITS.shaking;
  if (GAME_CONFIG.ANTIDOTE_FLAGS) bits |= GAME_OPTION_BITS.antidote;
  if (NO_TEAM_KILLS) bits |= GAME_OPTION_BITS.noTeamKills;
  return bits;
}

// Reports this server to the designated list server -- docs/list-server-plan.md
// "Reporting". The designated instance about itself never leaves the process:
// there is no key to hold for a server reporting to itself, and no HTTPS round
// trip worth making to its own loopback.
// This server's own list-server row, as either a report's payload or a
// challenge response answers it -- the same fields either way, since a
// validation poll that already has to reach this server for its signature
// might as well come back with what a report would have said too. See
// "Speeding up a restart" in docs/list-server.md.
// What each proxied target is playing, as of the last dial. Refreshed on the
// same cadence as the report rather than per join or part: a report fires on
// every one of those for live counts, and dialling every target each time
// would turn one player's arrival into a round trip per target.
//
// One row per target, not one per instance: a proxy holds no game of its own,
// so its own counts and options describe nothing, while the target's describe
// the match a player is deciding whether to join (`docs/proxy.md`).
const proxyStatuses = new Map();

// The target's own game, for a browser that is about to be asked which team it
// wants. The poller below refreshes these on the report's cadence, which is
// plenty for team maxima -- they change when a bzfs restarts -- so a join
// reuses what is already held and only dials for a target nothing has asked
// about yet.
async function proxyTargetStatus(key, target) {
  const held = proxyStatuses.get(key);
  if (held && held.reachable) return held;
  try {
    const status = await queryServerStatus(target.host, target.port);
    proxyStatuses.set(key, { ...status, reachable: true, error: null, at: Date.now() });
    return status;
  } catch (error) {
    // Never fatal: the dialog falls back to Observer, which is the one team
    // the proxy can always deliver, and the world and roster are unaffected.
    log(`[PROXY] ${key}: could not ask what game it is running: ${error.message || error}`);
    return null;
  }
}

async function refreshProxyStatuses() {
  const targets = Object.values(PROXY_TARGETS);
  if (targets.length === 0) return;
  // The public list's word about any of these that are on it, for the row's
  // title -- the one thing a direct dial cannot ask for. Shared and cached
  // with `/list`'s own use of it, and a failure here costs the rows nothing
  // but a name they already have a fallback for.
  await getRemoteServerList().catch(() => {});
  await Promise.all(targets.map(async (target) => {
    try {
      const status = await queryServerStatus(target.host, target.port);
      proxyStatuses.set(target.key, { ...status, reachable: true, error: null, at: Date.now() });
    } catch (error) {
      // A proxy can be up with one of its targets down, so the row goes stale
      // on its own rather than taking the instance's with it.
      proxyStatuses.set(target.key, {
        reachable: false,
        error: error.message || String(error),
        at: Date.now(),
      });
      log(`Proxy: "${target.key}" did not answer: ${error.message || error}`);
    }
  }));
}

// The targets a browser may be sent to, for the entry dialog's destination
// selector (`docs/proxy-plan.md`). The same facts `/list` publishes, minus the
// live counts a picker does not need, plus the one thing it does: which teams
// the target would accept, so the team selector can follow the destination
// without a round trip to find out.
//
// Only targets that answered their last dial. A row for a server nothing can
// reach is an option that fails after the navigation rather than before it,
// which is the same rule the `/list` rows already apply.
function getProxyDestinations() {
  return Object.values(PROXY_TARGETS)
    .map((target) => {
      const status = proxyStatuses.get(target.key);
      if (!status || status.reachable !== true) return null;
      const listed = findPublicServer(
        remoteServerListCache.servers, target.displayHost, target.displayPort);
      return {
        key: target.urlKey,
        name: target.key,
        title: listed?.title || '',
        style: status.style || '',
        teams: teamModeFromMaximums(
          status.teamMaximums, status.maxPlayers ?? MAX_REAL_PLAYERS).teams,
      };
    })
    .filter(Boolean);
}

// The list rows for this instance's targets. The title is the public BZFlag
// list's word about a target that is on it; a target that is not listed shows
// under its own configured name, which is all anybody has for it.
function computeProxyRows() {
  return Object.values(PROXY_TARGETS).map((target) => {
    const status = proxyStatuses.get(target.key) || { reachable: false, error: 'not yet dialled' };
    const listed = findPublicServer(remoteServerListCache.servers, target.displayHost, target.displayPort);
    return {
      target: target.key,
      title: listed?.title || '',
      players: status.players ?? 0,
      maxPlayers: status.maxPlayers ?? 0,
      maxShots: status.maxShots ?? 0,
      style: status.style || '',
      gameOptionsBits: status.gameOptionsBits ?? 0,
      // What /list's readout pane shows for the target rather than for the
      // instance carrying it -- `queryServerStatus` already asks for all of
      // it on the same dial.
      teamCounts: status.teamCounts ?? null,
      teamMaximums: status.teamMaximums ?? null,
      shakeTimeout: status.shakeTimeout ?? null,
      shakeWins: status.shakeWins ?? null,
      maxTime: status.maxTime ?? 0,
      maxTeamScore: status.maxTeamScore ?? 0,
      maxPlayerScore: status.maxPlayerScore ?? 0,
      reachable: status.reachable === true,
      error: status.reachable ? null : (status.error || 'no response'),
    };
  });
}

function computeListServerStatus() {
  // Per-team, in `-mp` order, so a bzo row's readout pane reads the same as a
  // bzfs row's (`decodePingHex`'s `teamCounts`/`teamMaximums`). One pass:
  // this runs on every join and part, not just the periodic report.
  const joinedByTeam = new Map();
  let bots = 0;
  for (const player of players.values()) {
    if (!player.joined) continue;
    joinedByTeam.set(player.team, (joinedByTeam.get(player.team) || 0) + 1);
    if (player.bot && player.team !== PLAYER_TEAM.OBSERVER) bots++;
  }
  return {
    proxies: computeProxyRows(),
    // Which world this is, which a row had no way to say. `random` for a
    // generated one, as `MAP_SOURCE` itself spells it.
    map: MAP_SOURCE,
    // The live world's content hash, so the list server can draw this
    // instance's overview picture (issue #147). Just the hash, never a URL:
    // the list server derives `<this instance's registered url>/maps/<hash>
    // .json` from the URL it already validated, so a report can name a world
    // to fetch but can never name a host to fetch it from. `/maps/` is public
    // and immutable already, and the hash is what makes the answer checkable
    // -- see `ensureInstanceOverview`.
    mapHash: LIVE_MAP_ENTRY ? LIVE_MAP_ENTRY.hash : '',
    // What that world costs, so a bzo row can say the same things the bzfs
    // pane beside it says about an imported one.
    world: measureLiveWorld(),
    title: serverConfig.title || '',
    // People, which is what the list sorts on. Bots are in the team counts,
    // as upstream's ping has them, and counted on their own beside this.
    players: [...players.values()]
      .filter((p) => p.joined && p.team !== PLAYER_TEAM.OBSERVER && !p.bot).length,
    bots,
    maxPlayers: MAX_REAL_PLAYERS,
    version: BZO_APP_VERSION,
    gameOptionsBits: computeLocalGameOptionsBits(),
    // Whether bots are refused, autopilot included (`-disableBots`), which a
    // player choosing a server for its bots, or to fly one, wants to know first.
    disableBots: botsDisabled(),
    // The two fields the bzfs table on this same page already shows
    // (Shots, Style) that a bzo row was missing -- GAME_TYPE is already the
    // same vocabulary GAME_STYLES uses to decode a remote server's style.
    maxShots: GAME_CONFIG.SHOT_MAX_ACTIVE,
    style: GAME_TYPE,
    // Voice chat itself is not a switch bzo has -- every client offers the
    // mic -- but without at least one ICE server a peer connection across
    // anything but a LAN typically never completes, so this is "will voice
    // actually work here" rather than "does this build have the feature."
    voiceEnabled: VOICE_ICE_SERVERS.length > 0,
    // Every name this instance answers on (`publicUrl`). The list server
    // shows the ones it can verify beside the key's own.
    urls: PUBLIC_URLS,
    // The rest of what /list's readout pane shows. A bzfs row gets all of
    // this free from its ping packet, so without it a bzo row -- the one this
    // instance knows most about -- was the thinner of the two.
    teamCounts: BZFLAG_MP_TEAM_ORDER.map((team) => joinedByTeam.get(team) || 0),
    teamMaximums: BZFLAG_MP_TEAM_ORDER.map((team) => TEAM_MODE.limits[team] || 0),
    // Tenths of a second, the ping packet's own unit and bzo's.
    shakeTimeout: FLAG_SHAKE_TIMEOUT,
    shakeWins: FLAG_SHAKE_WINS,
    maxTime: GAME_CONFIG.TIME_LIMIT,
    maxTeamScore: GAME_CONFIG.MAX_TEAM_SCORE,
    maxPlayerScore: GAME_CONFIG.MAX_PLAYER_SCORE,
  };
}

function reportToListServer(reason) {
  // Before it can answer, a server says nothing (`serverReady`); the boot
  // report covers whatever joined meanwhile. Leaving is said at once.
  if (!serverIsReady && reason !== 'shutdown') return;
  publishToBzflagListServer(reason);
  if (!LIST_SERVER_URL) return;
  const payload = { reason, ...computeListServerStatus() };
  if (IS_DESIGNATED_LIST_SERVER) {
    // No key exists for "this server reporting to itself" -- report straight
    // into the registry instead. Found by `url` (this instance's own
    // PUBLIC_URL) rather than by a fabricated id or a fixed bzid: `requestKey`
    // always mints its own random UUID, so a restart that reloaded this same
    // row from disk cannot be found by any id chosen here, and the dedupe
    // check on `/api/list-server/keys` already guarantees no other row can
    // ever share this exact URL -- which also leaves bzid/callsign free to
    // change (`LIST_SERVER_OWNER_BZID`/`_CALLSIGN`, below) without breaking
    // the lookup.
    // One row, under the first name, with the rest beside it: this server
    // needs no call back to know its own names. A row under another of them
    // is this server's own from when that name came first, and is removed:
    // its key could never pass a check, since this server holds no key to
    // answer the challenge with.
    for (const url of PUBLIC_URLS.slice(1)) {
      const old = listServerKeys.listAll().find((record) => record.url === url);
      if (!old) continue;
      listServerKeys.revoke(old.id);
      log(`[LISTSERVER] removed the old row for ${url}, now listed under ${PUBLIC_URL}`);
    }
    if (!PUBLIC_URL) return;
    let self = listServerKeys.listAll().find((record) => record.url === PUBLIC_URL);
    if (!self) {
      self = listServerKeys.requestKey({
        bzid: LIST_SERVER_OWNER_BZID || 'self',
        callsign: LIST_SERVER_OWNER_CALLSIGN || serverConfig.title || '',
        url: PUBLIC_URL,
      });
      // Never expires like an ordinary key would: it is re-validated (by
      // this very call, below) every time it reports, exactly as if a daily
      // poll always passed.
    } else {
      // Kept in sync on every report, not just at creation, so an operator
      // who names their bzid after the row already exists sees it take
      // effect on the next boot rather than needing to revoke and re-create.
      self.bzid = LIST_SERVER_OWNER_BZID || 'self';
      self.callsign = LIST_SERVER_OWNER_CALLSIGN || serverConfig.title || '';
    }
    if (reason === 'shutdown') {
      listServerKeys.unreport(self);
    } else {
      listServerKeys.report(self, payload, Date.now(), reason);
      listServerKeys.markChecked(self, true);
      self.alsoAt = PUBLIC_URLS.slice(1);
    }
    return;
  }
  if (!LIST_SERVER_KEY) return;
  fetch(`${LIST_SERVER_URL}/api/list-server/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': BZO_USER_AGENT },
    body: JSON.stringify({ key: LIST_SERVER_KEY, ...payload }),
    signal: AbortSignal.timeout(8000),
  }).then(async (response) => {
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    log(`[LISTSERVER] reported (${reason}) to ${LIST_SERVER_URL}`);
  }).catch((error) => {
    log(`[LISTSERVER] report (${reason}) to ${LIST_SERVER_URL} failed: ${error.message}`);
  });
}
// Native BZFlag clients (issue #174, docs/bzflag-clients.md): server.json's
// `bzflag` block opens a bzfs-style port that answers queries and turns joins
// away, and publishes it to the BZFlag list server with bzfs's own key.
// The `bzflag` block's own settings -- list, UPnP, cache -- or none; BZFlag
// clients are taken unless it is `false` (`LISTEN_IS_BZFLAG`).
const BZFLAG_CONFIG = serverConfig.bzflag && typeof serverConfig.bzflag === 'object'
  ? serverConfig.bzflag : {};
// `let`: with `upnp` and no `publicAddr`, the gateway's external address
// fills it in, as bzfs's `-UPnP` does (`UPnP::setRemoteInterface`).
let bzflagPublicAddr = typeof BZFLAG_CONFIG?.publicAddr === 'string' ? BZFLAG_CONFIG.publicAddr.trim() : '';
const BZFLAG_PUBLIC_KEY = typeof BZFLAG_CONFIG?.publicKey === 'string' ? BZFLAG_CONFIG.publicKey.trim() : '';
const BZFLAG_LIST_URL = typeof BZFLAG_CONFIG?.listUrl === 'string' ? BZFLAG_CONFIG.listUrl : DEFAULT_LIST_SERVER;
const BZFLAG_PLAYER_TYPE = { TANK: 0, COMPUTER: 1 };

// The list row in a bzfs ping's terms (`getTeamCounts`, bzfs.cxx:830): only
// humans count, the rabbit and hunters count as rogues, and in Rabbit Chase
// the rogue limit is the hunters' (CmdLineOptions.cxx:1597). `withBots` is
// the UDP ping's and MsgQueryGame's count instead, whole team sizes.
function computeBzflagStatus({ withBots = false } = {}) {
  const status = computeListServerStatus();
  const rogueSlot = BZFLAG_MP_TEAM_ORDER.indexOf(PLAYER_TEAM.ROGUE);
  const counts = BZFLAG_MP_TEAM_ORDER.map(() => 0);
  for (const player of players.values()) {
    if (!player.joined || (player.bot && !withBots)) continue;
    const slot = player.team === PLAYER_TEAM.RABBIT || player.team === PLAYER_TEAM.HUNTER
      ? rogueSlot : BZFLAG_MP_TEAM_ORDER.indexOf(player.team);
    if (slot >= 0) counts[slot] += 1;
  }
  const maximums = [...status.teamMaximums];
  maximums[rogueSlot] = Math.max(maximums[rogueSlot] || 0, TEAM_MODE.limits[PLAYER_TEAM.HUNTER] || 0);
  return { ...status, teamCounts: counts, teamMaximums: maximums };
}

function bzflagTeamIndex(team) {
  const index = BZFLAG_TEAM_ORDER.indexOf(team);
  return index >= 0 ? index : 0;
}

let bzflagServer = null;
{
  // A BZFlag client hears from every tank at least once a second
  // (`MaxUpdateTime`, Player.cxx:38) and dead-reckons from that; bzo's own
  // five-second heartbeat would leave a resting bzo tank stale on its screen.
  // So with native clients in the game, every bzo client keeps upstream's
  // pace, as a proxied one already does (`PROXY_MAX_UPDATE_INTERVAL`).
  GAME_CONFIG.MAX_UPDATE_INTERVAL = 1000;
  const httpsServer = loadHttpsServer();
  // `proxyProtocolFrom`: the TCP proxies, addresses or CIDR blocks, that may
  // open a connection with a PROXY header naming the client.
  const { entries: proxyProtocolFrom, refused: refusedProxyProtocolFrom } =
    parseAdminWhitelist(serverConfig.proxyProtocolFrom);
  if (refusedProxyProtocolFrom.length > 0) {
    log(`proxyProtocolFrom entries refused (not an address or CIDR block):`
      + ` ${refusedProxyProtocolFrom.map((entry) => JSON.stringify(entry)).join(', ')}`);
  }
  bzflagServer = createBzflagServer({
    acceptBzflag: LISTEN_IS_BZFLAG,
    getCustomFlagTypes: () => pluginFlagTypes,
    trustsProxyHeader: (address) => addressMatchesWhitelist(address, proxyProtocolFrom),
    // The rest of what the port is asked: the web app, plain or over TLS.
    onHttp: (socket) => server.emit('connection', socket),
    onTls: httpsServer ? (socket) => httpsServer.emit('connection', socket) : null,
    countIn: (bytes) => serverStats.countIn(bytes),
    countOut: (bytes) => serverStats.countOut(bytes),
    getStatus: computeBzflagStatus,
    getPingStatus: () => computeBzflagStatus({ withBots: true }),
    getPlayers: () => [...players.values()]
      .filter((player) => player.joined)
      .map((player, index) => ({
        id: index,
        type: player.bot ? BZFLAG_PLAYER_TYPE.COMPUTER : BZFLAG_PLAYER_TYPE.TANK,
        team: bzflagTeamIndex(player.team),
        wins: player.wins,
        losses: player.losses,
        tks: player.tks,
        callsign: player.name,
        motto: player.motto,
      })),
    getTeams: () => {
      const sizes = getTeamSizes();
      return BZFLAG_TEAM_ORDER.map((team, index) => {
        const score = teamScores.get(team) || { wins: 0, losses: 0 };
        return { team: index, size: sizes[team] || 0, wins: score.wins, losses: score.losses };
      });
    },
    getGameSettings: bzflagGameSettings,
    getWorld: getBzflagWorld,
    getCacheUrl: bzflagCacheUrl,
    // The handshake's id is the player's bzo number, so every id a native
    // client sees is the one bzo's own scoreboard shows.
    reserveId: () => {
      const number = getNextPlayerNumber();
      if (number > 243) return 0xff;
      reservedPlayerNumbers.add(number);
      return number;
    },
    releaseId: (id) => reservedPlayerNumbers.delete(id),
    onEnter: (link, payload) => {
      seatNativeClient(link, payload).catch((error) => {
        logError(`[BZFLAG] seating ${link.address} failed: ${error.message}`);
        link.reject('server error');
      });
    },
    rejectReason: () => `This world can't be sent to BZFlag clients yet; play in a browser at ${PUBLIC_URL || 'this server\'s web page'}`,
    log,
  });
  bzflagServer.listen(LISTEN_HOST, PORT)
    .then(() => {
      onHttpListening();
      if (LISTEN_IS_BZFLAG && BZFLAG_CONFIG.upnp === true) startBzflagUpnp(PORT);
      if (serverConfig.webtransport !== false) startWebTransport();
      if (WEBRTC_ON) startUdpChannels();
    })
    .catch((error) => logError(`[BZFLAG] listen on ${describeListenTarget(LISTEN_HOST, PORT)} failed: ${error.message}`));
}

// WebTransport, unless `"webtransport": false`: HTTP/3 on the port's UDP,
// with the `https` certificate, which has to name the host a browser asks for
// -- QUIC does not pass through the reverse proxy (server/webtransport.cjs,
// #189). Off without `https` or the packages, saying so once.
let webTransport = null;
function startWebTransport() {
  const config = serverConfig.https;
  if (!config || typeof config !== 'object') {
    log('[WT] off: needs https');
    return;
  }
  const read = (file) => fs.readFileSync(path.resolve(path.dirname(CONFIG_PATH), String(file)), 'utf8');
  let cert;
  let key;
  try {
    cert = read(config.cert);
    key = read(config.key);
  } catch (error) {
    log(`[WT] off: ${error.message}`);
    return;
  }
  createWebTransport({
    socket: bzflagServer.udpSocket(),
    routeQuic: (handler) => bzflagServer.routeUdp('quic', handler),
    cert,
    key,
    claim: claimWebTransport,
    log,
  })
    .then((created) => { webTransport = created; })
    .catch((error) => logError(`[WT] off: ${error.message}`));
}

// `webrtc`: the UDP channel's WebRTC on the BZFlag port's socket, over werift
// (server/udp-channel.cjs). A connection from before it is up gets no data
// channel until its next `init`. `listen` once named a port of its own; any
// other value than `bzflag` is set aside, and said so.
function startUdpChannels() {
  const listen = serverConfig.webrtc?.listen;
  if (listen !== undefined && listen !== 'bzflag') {
    log(`[RTC] webrtc.listen "${listen}" ignored: the UDP channel is on the BZFlag port`);
  }
  // The relays' own addresses, so a channel that came through one says so.
  const relayAddresses = new Set();
  const relayHosts = new Set([...VOICE_ICE_SERVERS, ...VOICE_ICE_SERVERS_IPV4]
    .flatMap((server) => server.urls)
    .map((url) => /^turns?:\[?([^\]?/]+?)\]?(?::\d+)?(?:\?|$)/i.exec(url)?.[1])
    .filter(Boolean));
  for (const host of relayHosts) {
    require('dns').promises.lookup(host, { all: true })
      .then((records) => records.forEach((record) => relayAddresses.add(record.address)))
      .catch(() => {});
  }
  createUdpChannels({
    isRelay: (address) => relayAddresses.has(address),
    socket: bzflagServer.udpSocket(),
    routeUdp: (kind, handler) => bzflagServer.routeUdp(kind, handler),
    port: PORT,
    iceServers: UDP_CHANNEL_STUN,
    log,
  })
    .then((channels) => { UDP_CHANNELS = channels; })
    .catch((error) => logError(`[RTC] werift off: ${error.message}`));
}

// `bzflag.upnp`, bzfs's `-UPnP`: the gateway forwards `publicAddr`'s port
// (5154 without one, `UPnP::setPorts`) to the listening one, TCP and UDP.
let bzflagUpnp = null;
function startBzflagUpnp(localPort) {
  const publicPort = Number(/:(\d+)$/.exec(bzflagPublicAddr)?.[1]) || 5154;
  const mapping = createUpnpMapping({ publicPort, localPort, log });
  mapping.start()
    .then((externalAddress) => {
      bzflagUpnp = mapping;
      if (bzflagPublicAddr || !externalAddress) return;
      return nameForAddress(externalAddress).then((name) => {
        if (bzflagPublicAddr) return;
        bzflagPublicAddr = `${name || externalAddress}:${publicPort}`;
        log(`[UPNP] publicAddr ${bzflagPublicAddr}`);
        if (serverIsReady) publishToBzflagListServer('boot');
      });
    })
    .catch((error) => logError(`[UPNP] no port mapping: ${error.message}`));
}

// MsgGameSettings, as native clients and recordings are told it.
function bzflagGameSettings() {
  return {
    worldSize: GAME_CONFIG.MAP_SIZE,
    style: GAME_TYPE,
    gameOptionsBits: computeLocalGameOptionsBits(),
    maxShots: GAME_CONFIG.SHOT_MAX_ACTIVE,
    numFlags: flags.length,
    linearAcceleration: GAME_CONFIG.LINEAR_ACCELERATION,
    angularAcceleration: GAME_CONFIG.ANGULAR_ACCELERATION,
    shakeTimeout: FLAG_SHAKE_TIMEOUT,
    shakeWins: FLAG_SHAKE_WINS,
  };
}

// The world as bzfs packs it. server/bzw-compile.cjs compiles the map's
// `.bzw` the way bzfs does, and scripts/test-bzflag-world.mjs holds it to
// bzfs's own `-cacheout` byte for byte. bzfs itself is the fallback only for
// a map the compiler cannot reproduce, where it is installed; without it
// such a map is turned away rather than sent wrong. A generated world has
// no `.bzw` to compile.
let bzflagWorld = null;

function bzflagWorldFromBlob(blob, how, generated = false) {
  // `'p'` for a world from a file and `'t'` for one made up at start, which a
  // client caches only for the session; then the MD5 of the blob
  // (bzfs.cxx:1208).
  const hash = `${generated ? 't' : 'p'}${crypto.createHash('md5').update(blob).digest('hex')}`;
  log(`[BZFLAG] world for ${MAP_SOURCE} (${how}): ${blob.length} bytes, ${hash}`);
  return { blob, hash };
}

function bzfsCacheout(mapPath, reason) {
  const out = path.join(os.tmpdir(), `bzo-world-${process.pid}-${Date.now()}.bwc`);
  return new Promise((resolve) => {
    execFile('bzfs', ['-world', mapPath, '-cacheout', out], { timeout: 30000 }, (error) => {
      let blob = null;
      try {
        blob = fs.readFileSync(out);
      } catch {
        // No file is the answer whatever the reason.
      }
      fs.rm(out, { force: true }, () => {});
      if (!blob || blob.length === 0) {
        logError(`[BZFLAG] ${MAP_SOURCE} cannot be sent to BZFlag clients: ${reason}, and bzfs -cacheout`
          + ` failed${error ? `: ${error.message}` : ''}`);
        resolve(null);
        return;
      }
      resolve(bzflagWorldFromBlob(blob, `bzfs -cacheout, ${reason}`));
    });
  });
}

function getBzflagWorld() {
  if (bzflagWorld && bzflagWorld.mapHash === LIVE_MAP_ENTRY?.hash) return bzflagWorld.promise;
  const generated = MAP_SOURCE === 'random';
  const mapPath = generated ? null : resolveMapFilePath(MAP_SOURCE);
  if (!generated && !mapPath) return Promise.resolve(null);
  let promise;
  try {
    const text = generated ? RANDOM_WORLD_BZW : fs.readFileSync(mapPath, 'latin1');
    const tree = compileBzwWorld(text, { bzdb: SERVER_BZDB });
    if (tree.unsupported.length > 0) {
      promise = generated
        ? Promise.resolve(null)
        : bzfsCacheout(mapPath, `the compiler cannot reproduce ${[...new Set(tree.unsupported)].join(', ')}`);
    } else {
      // bzo's compass letters, which its browsers draw for themselves, at the
      // height they draw them (`_addCompassMarker`, public/js/render-world.js).
      const tallest = OBSTACLES.reduce((top, obstacle) => Math.max(top, obstacle.bounds?.maxZ ?? 0), 0);
      addCardinalLetters(tree, {
        mapSize: GAME_CONFIG.MAP_SIZE,
        height: Math.max((GAME_CONFIG.WALL_HEIGHT || 0) + 8, tallest + 5),
      });
      promise = Promise.resolve(bzflagWorldFromBlob(packWorldDatabase(tree), generated ? 'generated' : 'compiled', generated));
    }
  } catch (error) {
    promise = generated
      ? (logError(`[BZFLAG] the generated world did not compile: ${error.message}`), Promise.resolve(null))
      : bzfsCacheout(mapPath, `the compiler failed (${error.message})`);
  }
  bzflagWorld = { mapHash: LIVE_MAP_ENTRY?.hash, promise };
  return promise;
}

// bzfs's `-cacheurl` (CmdLineOptions.cxx:678): where a client may fetch the
// world over HTTP instead of a kilobyte per round trip. bzfs only points at a
// file its operator hosts; bzo is a web server, so by default it points at
// its own copy (`/bzflag/world/<md5>.bwc`). `cacheUrl` false turns it off,
// and a string is used as written, as bzfs uses it.
function bzflagCacheUrl(world) {
  const configured = BZFLAG_CONFIG?.cacheUrl;
  if (configured === false) return null;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  return PUBLIC_URL ? `${PUBLIC_URL}/bzflag/world/${world.hash.slice(1)}.bwc` : null;
}

app.get('/bzflag/world/:md5.bwc', (req, res) => {
  if (!bzflagServer || !LISTEN_IS_BZFLAG) {
    res.status(404).end();
    return;
  }
  Promise.resolve(getBzflagWorld()).then((world) => {
    if (!world || world.hash.slice(1) !== req.params.md5) {
      res.status(404).type('text/plain').send('No such world here.\n');
      return;
    }
    // The client's libcurl sends no user agent, so the address says who.
    const from = (req.get('x-forwarded-for') || '').split(',')[0].trim() || req.socket.remoteAddress;
    log(`[BZFLAG] world ${req.params.md5} fetched over HTTP by ${from}`);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('application/octet-stream').send(world.blob);
  }).catch(() => res.status(500).end());
});

// A native client that sent MsgEnter becomes a bzo player through the same
// door a bot uses (`createBotSocket`): its socket's `send` is the
// translator, and what it says arrives as a browser's message would. It
// watches for now; playing is the next phase of #174.
async function seatNativeClient(link, payload) {
  const enter = decodeEnter(payload);
  if (!enter || !enter.callsign.trim()) {
    link.reject('bad MsgEnter');
    return;
  }
  // addPlayer's address check (bzfs.cxx:2217), ahead of the BZID one. A
  // BZFlag client's address is its socket's own, which needs no proxy trust.
  const ipBan = bans.ipBanned(link.remoteAddress);
  if (ipBan) {
    log(`[BZFLAG] "${enter.callsign}" refused: ${link.remoteAddress} is banned (${ipBan.mask})`);
    link.reject(bans.ipBanRefusal(ipBan), REJECT_IP_BANNED);
    return;
  }
  // bzfs asks the list server about every callsign, token or none
  // (ListServerLink::addMe), and says what it heard (ListServerConnection.cxx:
  // 272-293). The token is spent here and never logged.
  let login = null;
  try {
    const { status, body } = await checkGlobalToken(enter.callsign, enter.token, ADMIN_GROUPS);
    const parsed = parseGlobalTokenReply(body);
    const bad = parsed.lines.some((line) => line.startsWith('TOKBAD: '));
    login = { ...parsed, registered: parsed.good || bad };
    log(`[BZFLAG] "${enter.callsign}" CHECKTOKENS ${status}: ${parsed.good ? `verified bzid=${parsed.bzid || 'none'}`
      : (bad ? 'registered, bad token' : 'not registered')}`
      + `${parsed.groups.length ? ` groups=${parsed.groups.join(',')}` : ''}`);
  } catch (error) {
    logError(`[BZFLAG] "${enter.callsign}" CHECKTOKENS failed: ${error.message}`);
  }
  if (link.closed) return;
  const socket = new EventEmitter();
  socket.OPEN = 1;
  socket.readyState = 1;
  socket.reservedPlayerNumber = link.id;
  const translator = new NativeTranslator({
    selfSlot: link.id,
    send: (code, body) => link.send(code, body),
    teamIndex: bzflagTeamIndex,
    config: () => GAME_CONFIG,
    flagName: (type) => getFlagType(type)?.name || '',
    addressOf: (id) => players.get(id)?.clientIP ?? null,
    scoreOf: (id) => {
      const player = players.get(id);
      return player ? { wins: player.wins, losses: player.losses, tks: player.tks } : null;
    },
    selfIsAdmin: () => Boolean(seated && isAdmin(seated)),
    guidedShots: (shooterId) => [...projectiles.values()]
      .filter((proj) => proj.guided && String(proj.playerId) === shooterId)
      .map((proj) => ({
        id: proj.id,
        x: proj.x,
        y: proj.y,
        z: proj.z,
        dirX: proj.dirX,
        dirY: proj.dirY,
        dirZ: proj.dirZ,
        speed: proj.speed,
        team: players.get(String(proj.playerId))?.team ?? null,
      })),
  });
  socket.send = (data) => socket.sendMessage(JSON.parse(data));
  // Corked until the event loop moves on, so everything sent this turn --
  // every move that arrived in the same poll -- leaves in one write rather
  // than one each, for no more delay than the rest of the turn.
  let corked = false;
  const uncork = () => {
    corked = false;
    link.uncork();
  };
  socket.sendMessage = (message) => {
    if (!corked) {
      corked = true;
      link.cork();
      setImmediate(uncork);
    }
    try {
      translator.handle(message);
    } catch (error) {
      logError(`[BZFLAG] "${enter.callsign}": ${error.message}`);
    }
  };
  // bzo's keep-alive ping (`server/lag.cjs`) as bzfs's own, MsgLagPing with
  // a sequence number the client echoes (`LagInfo::getNextPingSeqno`); the
  // echo is the pong, so a native player's lag is measured like anyone's.
  let lagPingSeqno = 0;
  let lagPingPending = null;
  socket.ping = () => {
    lagPingSeqno = (lagPingSeqno + 1) & 0xffff;
    lagPingPending = lagPingSeqno;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(lagPingSeqno, 0);
    link.send('pi', body);
  };
  let seated = null;
  const close = () => {
    if (socket.readyState !== 1) return;
    socket.readyState = 3;
    socket.emit('close');
    if (!link.closed) link.close();
    // No cookie carries it, so nothing could come back to it.
    if (seated?.sessionId) sessions.remove(seated.sessionId);
  };
  socket.close = close;
  socket.terminate = close;
  const say = (message) => socket.emit('message', asIfFromWire(message));
  link.onClose = close;
  link.onFrame = (code, body) => {
    if (code === 'ex') {
      close();
    } else if (code === 'mg') {
      const chat = decodeClientMessage(body);
      if (!chat || !chat.text.trim()) return;
      // A player id is bzo's own; the destinations above them are upstream's
      // numbers too (server/player-ids.cjs).
      const dst = chat.to <= 243 ? String(chat.to) : chat.to;
      say({ type: 'message', dst, text: chat.text, msgType: 'chat' });
    } else if (code === 'pu' || code === 'ps') {
      // Its own tank only, and only once it has one to drive.
      if (!seated?.joined || !seated.alive || isObserverTeam(seated.team)) return;
      let update;
      try {
        update = decodePlayerUpdate(body, code === 'ps');
      } catch {
        return;
      }
      if (update.id !== link.id) return;
      // An exploding tank keeps reporting as its pieces fly, with the alive
      // bit clear; that is not a tank bzo should move.
      if ((update.status & BZFS_PLAYER_STATUS.ALIVE) === 0) return;
      // A Phantom Zone holder zones itself crossing a teleporter and says so
      // only with `FlagActive` on its updates (LocalPlayer.cxx:729), naming no
      // face. The face is looked up along its path and checked as a browser's
      // `zone` is; a finding is logged and the toggle stands, since the client
      // is zoned on its own screen either way.
      const zonedFlag = getPlayerFlag(seated.id);
      const flagActive = (update.status & BZFS_PLAYER_STATUS.FLAG_ACTIVE) !== 0;
      if (zonedFlag && togglesZoneOnTeleport(zonedFlag.type) && zonedFlag.zoned !== flagActive) {
        const to = moveFromBzfs(update, GAME_CONFIG);
        const crossing = findCrossedTeleporterFace({ x: seated.x, y: seated.y, z: seated.z }, to);
        const refusal = crossing
          ? getZoneRefusal(seated, { ...crossing.at, azimuth: to.a }, crossing.faceId, Date.now())
          : 'its path crossed no teleporter';
        if (refusal) reportCheat(seated, 'flagRejected', `ZONE REJECTED: ${refusal}`);
        zonedFlag.zoned = flagActive;
        log(`"${seated.name}" ${flagActive ? 'zoned' : 'unzoned'}`);
        broadcastFlagUpdate(zonedFlag);
      }
      // The update after a MsgTeleport is the far side of it.
      if (seated.nativeTeleport) {
        applyNativeTeleport(seated, moveFromBzfs(update, GAME_CONFIG), seated.nativeTeleport);
        seated.nativeTeleport = null;
        return;
      }
      say(moveFromBzfs(update, GAME_CONFIG));
      // bzfs answers Identify on every update its holder sends
      // (`sendClosestFlagMessage`); the translator passes on only a change.
      searchFlag(seated);
    } else if (code === 'pi') {
      // Its echo of our MsgLagPing; one that is not the latest is stale.
      if (body.length >= 2 && body.readUInt16BE(0) === lagPingPending) {
        lagPingPending = null;
        socket.emit('pong');
      }
    } else if (code === 'tp') {
      // It went through a teleporter (`LocalPlayer::doUpdateMotion`,
      // LocalPlayer.cxx:764): which face it entered and which it left by,
      // upstream's teleporter index times two plus the face -- bzo's face
      // ids. Where it came out is the update that follows.
      if (!seated?.joined || !seated.alive || body.length < 4) return;
      seated.nativeTeleport = { from: body.readUInt16BE(0), to: body.readUInt16BE(2) };
    } else if (code === 'pa') {
      // Paused or not (`pausePlayer`, bzfs.cxx:2778). The client has already
      // counted its five seconds down, as upstream's does, so it takes hold
      // now; bzo's own countdown is for its browsers.
      if (!seated?.joined || !seated.alive || isObserverTeam(seated.team) || body.length < 1) return;
      const paused = body.readUInt8(0) !== 0;
      if (seated.paused !== paused) setPaused(seated, paused);
    } else if (code === 'au') {
      // Its autopilot (`autopilotPlayer`, bzfs.cxx:5217), which BZFlag's own
      // client calls Roger.
      if (body.length >= 1) say({ type: 'autopilot', on: body.readUInt8(0) !== 0, pilot: 'Roger' });
    } else if (code === 'gf') {
      // The flag its tank touched, by index; bzo decides, as for a browser.
      if (body.length >= 2) say({ type: 'grabFlag', index: body.readUInt16BE(0) });
    } else if (code === 'df') {
      // Where it let go is bzo's own reckoning (`dropFlag`), not the client's.
      say({ type: 'dropFlag' });
    } else if (code === 'cf') {
      // The team whose base it carried the flag into.
      if (body.length >= 2) say({ type: 'captureFlag', team: body.readUInt16BE(0) });
    } else if (code === 'gm') {
      // Its guided missile's target (`GuidedMissileStrategy::sendUpdate`).
      // bzo steers a shooter's missiles at its lock, so the lock is what moves.
      if (!seated?.joined) return;
      let update;
      try {
        update = decodeGMUpdate(body);
      } catch {
        return;
      }
      if (update.player !== link.id) return;
      const target = players.get(String(update.target));
      setLockTarget(seated, target && canLockOn(seated) && canLockOnto(target) ? target.id : null);
    } else if (code === 'sb') {
      // A shot it fired. bzo's server flies it and decides what it hits, as
      // it does for a browser's; the client's own id for it is kept so what
      // bzo later says about the shot names it the way the client does.
      if (!seated?.joined || !seated.alive || isObserverTeam(seated.team)) return;
      let shot;
      try {
        shot = decodeShotBegin(body);
      } catch {
        return;
      }
      if (shot.player !== link.id) return;
      translator.ownShotPending = shot.id;
      say(shootFromBzfs(shot));
      translator.ownShotPending = null;
    } else if (code === 'kl') {
      // It says it died: on its own screen, it is. Whichever of it and bzo's
      // server decides a death first, the other's word is then about a tank
      // already dead (`killPlayer`'s guard).
      translator.clientDead = true;
      if (seated?.joined && seated.alive) applyNativeDeath(seated, body, translator);
    } else if (code === 'al') {
      // MsgAlive from the client asks to spawn. bzo spawns players by itself,
      // as its browsers expect, so a request is answered only where the
      // client died on its own screen and bzo still has it alive -- told
      // where it is, it plays on. Otherwise bzo's own MsgAlive is coming.
      if (translator.clientDead && seated?.joined && seated.alive) translator.alive(seated.getState(false));
    }
  };
  acceptConnection(socket, {
    url: '/',
    headers: { 'user-agent': `BZFlag ${enter.version}` },
    socket: { remoteAddress: link.remoteAddress, remotePort: 0 },
  });
  const player = [...players.values()].find((candidate) => candidate.ws === socket);
  if (!player) return;
  seated = player;
  player.clientVersion = enter.version;
  // Its moves are its own client's physics, which bzo cannot correct and
  // does not yet match: a finding is logged, not refused (`reportCheat`).
  player.native = true;
  player.nativeLink = link;
  // What a browser's session gives it at `acceptConnection`, from the token
  // instead of a cookie. A session record, as `/login` makes, because
  // `isAdmin` re-reads the session every time it is asked; nothing sends its
  // id anywhere.
  if (login?.good && login.bzid) {
    const callsign = login.callsign || enter.callsign;
    player.sessionId = sessions.create({ bzid: login.bzid, callsign, groups: login.groups });
    player.verified = true;
    player.bzid = login.bzid;
    player.globalCallsign = callsign;
    player.admin = isAdminSession(sessions.get(player.sessionId), ADMIN_GROUPS);
  }
  // Turned away as bzfs turns a banned BZID away, with MsgReject.
  const idBan = bans.idBanned(player.bzid);
  if (idBan) {
    log(`[BZFLAG] "${enter.callsign}" refused: BZID ${player.bzid} is banned`);
    link.reject(idBanRefusal(idBan), REJECT_ID_BANNED);
    return;
  }
  // The team it asked for, by upstream's number (`TeamColor`, global.h:59):
  // AutomaticTeam is -2, and the rabbit and hunter teams are bzo's to assign.
  const askedTeam = enter.team === -2 || enter.team === 6 || enter.team === 7
    ? PLAYER_TEAM.AUTOMATIC
    : (BZFLAG_TEAM_ORDER[enter.team] ?? PLAYER_TEAM.AUTOMATIC);
  log(`[BZFLAG] "${enter.callsign}" entered from ${link.address} (${enter.version}) as ${askedTeam}`
    + `${player.verified ? `, bzid=${player.bzid} admin=${player.admin}` : ''}`);
  say({
    type: 'joinGame', name: enter.callsign, team: askedTeam, motto: enter.motto, tankModel: 'bzflag',
    // A robot from a BZFlag client is one here too (`PlayerInfo::isBot`).
    bot: enter.type === BZFLAG_PLAYER_TYPE.COMPUTER,
  });
  if (!player.joined) return;
  if (login?.good) {
    replyToPlayer(player, 'Global login approved!');
  } else if (login?.registered) {
    replyToPlayer(player, 'Global login rejected, bad token.');
  } else if (login) {
    replyToPlayer(player, 'This callsign is not registered.');
    replyToPlayer(player, 'You can register it at https://forums.bzflag.org/');
  }
}

// The title with the live map's name on the end, which bzfs has no way to
// say: `HiX 3 - bzo` on bzo.bzw. Held to bzfs's 127 characters
// (CmdLineOptions.cxx:1044), cutting the title rather than the map.
const BZFLAG_TITLE_MAX = 127;
function bzflagListTitle() {
  const base = String(serverConfig.title || '').trim();
  const suffix = ` - ${path.basename(MAP_SOURCE).replace(/\.bzw$/i, '')}`;
  return `${base.slice(0, Math.max(0, BZFLAG_TITLE_MAX - suffix.length))}${suffix}`;
}

// The far side of a native teleport: where the client says it came out, which
// bzo takes as it takes the client's moves, sent to every browser as bzo's
// own teleport move (`pt`) so it is drawn as one rather than a slide. A link
// bzo does not know -- a group-placed teleporter numbered differently -- is
// still a teleport, said with no faces. `move` is the wire's, as
// `moveFromBzfs` spells it.
function applyNativeTeleport(player, move, { from, to }) {
  const now = Date.now();
  const known = getTeleportDestinationFace(TELEPORTER_LINKS_BY_SOURCE_FACE, from) === to;
  player.x = move.x;
  player.y = move.y;
  player.z = move.z;
  player.azimuth = move.a;
  player.forwardSpeed = move.fs;
  player.rotationSpeed = move.rs;
  player.verticalVelocity = move.vv;
  player.airVelocityX = move.vx;
  player.airVelocityY = move.vy;
  player.jumpAzimuth = move.air ? move.a : null;
  player.slideAzimuth = move.sd;
  player.lastUpdate = now;
  if (Number.isFinite(move.ct)) player.lastClientTimestamp = move.ct;
  noteHeardFrom(player, now);
  const packet = {
    type: 'pt',
    id: player.id,
    x: player.x,
    y: player.y,
    z: player.z,
    a: player.azimuth,
    fs: player.forwardSpeed,
    rs: player.rotationSpeed,
    vv: player.verticalVelocity,
    vx: player.airVelocityX,
    vy: player.airVelocityY,
    fromFaceId: known ? from : null,
    toFaceId: known ? to : null,
    ja: player.jumpAzimuth,
  };
  if (player.slideAzimuth !== undefined) packet.sd = player.slideAzimuth;

  broadcastAll(packet);

  log(`[PLAYER_TP] player=${player.id} srcFace=${from} dstFace=${to}${known ? '' : ' (link not in bzo\'s map)'}`
    + ` pos=(${player.x.toFixed(2)},${player.y.toFixed(2)},${player.z.toFixed(2)}) native`);
}

// A native client's own MsgKilled (`ServerLink::sendKilled`): killer, reason,
// which shot, the killer's flag, and a physics driver for a death touch. Only
// ever about itself, so it can only cost its sender a life. The reasons the
// server decides -- a capture, genocide, the clock -- are bzo's already.
function applyNativeDeath(victim, body, translator) {
  if (body.length < 7) return;
  const killerId = String(body.readUInt8(0));
  const reason = body.readInt16BE(1);
  const shotId = body.readUInt16BE(3);
  // The flag of the shot that did it, and a death-touch's driver
  // (`MsgKilled`, bzfs.cxx:4884).
  const shotFlag = body.length >= 7 ? body.toString('latin1', 5, 7).replace(/\0.*$/s, '') : '';
  const phydrv = body.length >= 11 ? body.readInt32BE(7) : -1;
  const killer = players.get(killerId) || null;
  if (reason === BLOWED_UP.GOT_SHOT) {
    // The bzo shot the client means: the one it was told about under that id.
    const entry = [...translator.shots.entries()]
      .find(([, shot]) => shot.id === shotId && String(shot.shooter) === killerId);
    const projectileId = entry ? entry[0] : null;
    const proj = projectileId !== null ? projectiles.get(projectileId) : null;
    if (proj) {
      applyShotPlayerHit(proj, projectileId, victim, { x: victim.x, y: victim.y, z: victim.z });
    } else if (killer) {
      killPlayer(victim, killer, DEATH_REASON.SHOT, projectileId, killer.id);
      // The shot has already ended here, so Genocide is read off the flag the
      // client names, as bzfs's `playerKilled` reads it -- taken only when the
      // killer is firing it, so a client cannot name one into being.
      if (shotFlag && shotFlag === getShotFlagFor(killer)) {
        applyGenocide({ flag: shotFlag, playerId: killer.id }, victim);
      }
    }
  } else if (reason === BLOWED_UP.GOT_RUN_OVER && killer) {
    killPlayer(victim, killer, DEATH_REASON.RUN_OVER);
  } else if (reason === BLOWED_UP.SELF_DESTRUCT) {
    killPlayer(victim, victim, DEATH_REASON.SELF_DESTRUCT);
  } else if (reason === BLOWED_UP.WATER_DEATH) {
    killPlayer(victim, null, DEATH_REASON.WATER);
  } else if (reason === BLOWED_UP.DEATH_TOUCH) {
    killPlayer(victim, null, DEATH_REASON.PHYSICS_DRIVER, null, null, mapPhysicsDrivers[phydrv] ?? null);
  }
  if (victim.alive) log(`[BZFLAG] "${victim.name}" reported a death bzo did not take (reason ${reason})`);
}

// bzfs re-adds on every join and part and every `ListServerReAddTime`; the
// same moments bzo reports to its own list.
// `ListServerLink::queueMessage` (ListServerConnection.cxx:334): one request
// in flight, and whatever is asked for meanwhile collapses into one more, sent
// when it returns -- a burst of joins is two ADDs, not one each.
let bzflagListInFlight = false;
let bzflagListQueued = null;
function publishToBzflagListServer(reason) {
  if (!bzflagServer || !LISTEN_IS_BZFLAG || !bzflagPublicAddr || !BZFLAG_PUBLIC_KEY) return;
  if (bzflagListInFlight && reason !== 'shutdown') {
    bzflagListQueued = reason;
    return;
  }
  bzflagListInFlight = true;
  const action = reason === 'shutdown' ? 'REMOVE' : 'ADD';
  publishToBzflagList({
    listUrl: BZFLAG_LIST_URL,
    action,
    nameport: bzflagPublicAddr,
    key: BZFLAG_PUBLIC_KEY,
    title: bzflagListTitle(),
    status: computeBzflagStatus(),
    build: BZO_APP_VERSION,
    userAgent: BZO_USER_AGENT,
  }).then((reply) => {
    // The list prints `MSG: ADD` before it checks anything, so an error is
    // on a later line.
    const lines = reply.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const error = lines.find((line) => /^ERROR/i.test(line));
    if (error) logError(`[BZFLAG] list ${action} (${reason}): ${error}`);
    else log(`[BZFLAG] list ${action} (${reason}): ${lines[lines.length - 1] || '(empty reply)'}`);
  }).catch((error) => logError(`[BZFLAG] list ${action} (${reason}) failed: ${error.message}`))
    .finally(() => {
      bzflagListInFlight = false;
      const next = bzflagListQueued;
      bzflagListQueued = null;
      if (next) publishToBzflagListServer(next);
    });
}

// `ListServerReAddTime` upstream, bzfs.cxx:84 -- ~15 minutes, for live counts
// even when nobody has joined or left. The targets are dialled first, so the
// report carries counts from this pass rather than the last one.
setInterval(() => {
  refreshProxyStatuses().finally(() => reportToListServer('periodic'));
}, 15 * 60 * 1000).unref?.();
// And once at boot, so the first report is not a row of zeroes.

// DropGeometry::dropFlag tests a tank-radius cylinder _flagHeight tall, so a
// spawning flag never appears somewhere a tank could not drive to reach it.
// checkCollision tests a box as tall as the radius it is handed, so the cylinder
// is walked in those steps.
//
// Only spawning uses this. A drop goes through dropTeamFlag, whose radius is 0
// and which upstream's own comment calls "not a real clearance check".
// The flag's own spot is always tested: a map may make flags 0 tall (hix
// does), and upstream's cylinder of no height still finds a building it
// stands in. Each step is a test as tall as the spawn radius, whatever the
// radius, so a drop's thin one still reaches into what it stands in.
function hasFlagClearance(x, y, z, radius = FLAG_DROP_TEST_RADIUS) {
  let offset = 0;
  do {
    const options = { suppressLog: true, height: FLAG_DROP_TEST_RADIUS };
    if (checkCollision(x, y, z + offset, radius, options)) return false;
    offset += FLAG_DROP_TEST_RADIUS;
  } while (offset < FLAG_HEIGHT);
  return true;
}

// resetFlag() for a flag with no team: a random spot with room for the flag and
// for a tank to reach it. Upstream picks a random altitude as well as a random
// x and y, and lets the downward ray decide which surface under it the flag
// actually settles on. With flags on buildings off it passes maxZ = 0 instead,
// which skips the ray and forces the ground.
// WorldInfo::getFlagSpawnPoint. Upstream asks the flag-id qualifier `#<index>`
// first, which for a `zoneflag` slot names exactly one zone, then -- for a
// flag that is not a team's -- the type qualifier `f<abbv>` the `flag` keyword
// builds, which may name several: one of them is picked with a chance in
// proportion to its area (`EntryZones::calculateQualifierLists`). Zones of no
// area between them give no answer, as upstream's division by their total
// does, and the flag goes anywhere.
function getFlagSpawnZone(flag) {
  if (!flag) return null;
  if (flag.zoneIndex !== null && flag.zoneIndex !== undefined) return MAP_ZONES[flag.zoneIndex] || null;
  // The type the flag has now -- upstream asks before a reset clears it -- or,
  // for a required slot not yet in the world, the one it is pinned to.
  const type = flag.type ?? flag.requiredType ?? null;
  if (!type || isTeamFlag(type)) return null;
  const named = MAP_ZONES.filter((zone) => zone.flagTypes?.has(type));
  if (named.length === 0) return null;
  const area = (zone) => 4 * zone.halfWidth * zone.halfDepth;
  const total = named.reduce((sum, zone) => sum + area(zone), 0);
  if (!(total > 0)) return null;
  let pick = Math.random() * total;
  for (const zone of named) {
    pick -= area(zone);
    if (pick < 0) return zone;
  }
  return named[named.length - 1];
}

function findFlagSpawnPosition(flag = null) {
  let zone = null;
  const span = Math.max(1, GAME_CONFIG.MAP_SIZE - BASE_SIZE);
  const maxHeight = getMaxObstacleTopY(OBSTACLES);
  for (let attempt = 0; attempt < 10000; attempt++) {
    // Upstream re-asks getFlagSpawnPoint on every attempt and only falls back to
    // a random world point when it has no answer, so a zone flag re-rolls inside
    // its zones rather than escaping them once one proves crowded -- and a type
    // several zones name may land in a different one each time.
    zone = getFlagSpawnZone(flag);
    const spot = zone
      ? getRandomZonePoint(zone)
      : {
        x: span * (Math.random() - 0.5),
        y: span * (Math.random() - 0.5),
        z: maxHeight * Math.random(),
      };
    const z = FLAGS_ON_BUILDINGS ? findFlagLandingZ(spot.x, spot.y, spot.z) : 0;
    // `null` -- open water under this point, nothing to land on above the
    // waterline. Re-roll rather than spawn a flag there, the same as a point
    // `hasFlagClearance` refuses.
    if (z === null) continue;
    if (hasFlagClearance(spot.x, spot.y, z)) return { x: spot.x, y: spot.y, z };
  }
  log(`Unable to position flag ${flag ? flag.index : '?'} on this world.`);
  return zone ? { x: zone.x, y: zone.y, z: zone.z } : { x: 0, y: 0, z: getFlagFloorY() };

}

function getFlagOwner(flag) {
  return flag.owner === null ? null : players.get(flag.owner) || null;
}

// FlagInfo::pack. A superflag nobody is holding goes out without its type,
// with no exception for an operator: upstream hides it from everybody in
// every flag update, and what an operator asking `/flag show` gets is the
// text reply, which their client reads (`parseFlagInfo`).
function getFlagState(flag, now = Date.now()) {
  const hidden = flag.owner === null && flag.team === null;
  const flightTime = flag.flightStartedAt === 0
    ? 0
    : Math.min(flag.flightEnd, (now - flag.flightStartedAt) / 1000);
  return {
    index: flag.index,
    type: hidden ? null : flag.type,
    status: flag.status,
    owner: flag.owner,
    position: { ...flag.position },
    launchPosition: { ...flag.launchPosition },
    landingPosition: { ...flag.landingPosition },
    flightTime,
    flightEnd: flag.flightEnd,
    initialVelocity: flag.initialVelocity,
    // Phantom Zone's `PlayerState::FlagActive`. Sent as the state it is rather
    // than as a toggle, so a client that predicted its own crossing converges on
    // this instead of flipping a second time.
    zoned: flag.zoned === true,
  };
}

// The fields `/flag show` prints, read off a slot. `required` is upstream's
// own: a team flag is a required slot there (CmdLineOptions.cxx:1840), as is
// anything a map pinned to a type, and bzo carries the two separately.
function describeFlagForCommand(flag) {
  return {
    index: flag.index,
    type: flag.type,
    player: flag.owner === null ? -1 : flag.owner,
    required: flag.requiredType !== null || flag.team !== null,
    grabs: flag.grabs,
    status: flag.status,
    position: flag.position,
  };

}

function getFlagStates() {
  const now = Date.now();
  return flags.filter((flag) => flag.status !== FLAG_STATUS.NO_EXIST).map((flag) => getFlagState(flag, now));
}

function broadcastFlagUpdate(flag) {
  broadcastAll({ type: 'flagUpdate', flags: [getFlagState(flag)] });
}

// FlagInfo::addFlag, which only ever runs for a superflag slot: a team flag has
// a fixed identity and simply appears at its base. The flag enters the world
// hovering at _flagAltitude, fades in, then falls to the ground.
function addFlag(flag) {
  // FlagInfo::setRequiredFlag pins a slot to one type, which is what a
  // `zoneflag` slot is: it always comes back as the flag its zone declared, and
  // never draws from the pool.
  const pool = flag.requiredType === null ? getSuperFlagPool() : null;
  if (pool !== null && pool.length === 0) return;
  const flight = computeFlagFlight(getFlagTuning().flagAltitude, GAME_CONFIG.GRAVITY);
  flag.type = flag.requiredType ?? pool[Math.floor(Math.random() * pool.length)];
  flag.status = FLAG_STATUS.COMING;
  flag.owner = null;
  flag.grabbedAt = 0;
  flag.launchPosition = { ...flag.position };
  flag.landingPosition = { ...flag.position };
  flag.flightEnd = flight.flightEnd;
  flag.initialVelocity = flight.initialVelocity;
  flag.flightStartedAt = Date.now();
  // A bad flag is sticky and can only be shaken off; a good one may be dropped
  // freely and survives _maxFlagGrabs pickups. FlagInfo.cxx:134 gives a sticky
  // flag a single grab, so shaking one off spends it and the flag leaves the
  // world rather than lying in wait for the next tank -- and names Thief in the
  // same test, which is what makes a theft spend the flag that took it.
  flag.endurance = getFlagEndurance(flag.type);
  flag.grabs = getFlagGrabCount(flag.type, GAME_CONFIG.MAX_FLAG_GRABS);
}

// resetFlag(). Takes the flag off whoever holds it and sends it home: a team
// flag to the centre of the top of one of its team's bases, a superflag slot to
// a fresh random spot with its identity cleared for the insertion schedule.
function resetFlag(flag) {
  if (flag.status === FLAG_STATUS.ON_TANK) sendFlagDrop(flag);
  flag.owner = null;
  flag.flightStartedAt = 0;
  flag.grabbedAt = 0;

  if (flag.team === null) {
    flag.position = findFlagSpawnPosition(flag);
    // FlagInfo::resetFlag clears the type only for the random tail -- the slots
    // past `numFlags - numExtraFlags` -- so a required flag keeps its own.
    flag.type = flag.requiredType;
    flag.status = FLAG_STATUS.NO_EXIST;
    if (flag.requiredType !== null) {
      // "required flags mustn't just disappear": a required non-team flag goes
      // straight back into the world rather than waiting out the insertion
      // schedule an ordinary superflag slot waits on. addFlag sets the flight
      // from the position already chosen above.
      addFlag(flag);
      broadcastFlagUpdate(flag);
      return;
    }
  } else {
    // getFlagSpawnPoint upstream. With no flag spawn zones the flag returns to
    // the centre of the top of one of its team's bases.
    const base = getRandomTeamBase(flag.team);
    flag.position = base
      ? { x: base.pos[0], y: base.pos[1], z: getBaseTop(base) }

      : { x: 0, y: 0, z: 0 };
    // A team flag is `required`, so it does not fly in -- it simply appears.
    // While its team has nobody on it, it stays out of the world entirely.
    flag.status = isTeamEmpty(flag.team) ? FLAG_STATUS.NO_EXIST : FLAG_STATUS.ON_GROUND;
  }

  flag.launchPosition = { ...flag.position };
  flag.landingPosition = { ...flag.position };
  broadcastFlagUpdate(flag);
}

// zapFlag(). The flag does not fly anywhere -- it stops existing where it is,
// and resetFlag decides where it belongs next.
function zapFlag(flag) {
  sendFlagDrop(flag);
  flag.status = FLAG_STATUS.NO_EXIST;
  flag.flightStartedAt = 0;
  resetFlag(flag);
}

// The `up` half of FlagCommand (commands.cxx:1425). The flag leaves the world
// where it stands and stays gone: upstream sets FlagGoing and lets the next
// tick turn that into FlagNoExist, which for a flag already on the ground is
// the same tick, so bzo goes straight there.
//
// This is not zapFlag. A required slot keeps its type and waits for a `/flag
// reset` -- upstream's `if (!flag.required) flag.flag.type = Flags::Null` --
// which is the point of the command on a map of zone flags: it empties the
// thing you are standing on. A pool slot empties and the insertion schedule
// rolls it again in its own time.
function sendFlagUp(flag) {
  if (flag.status === FLAG_STATUS.ON_TANK) sendFlagDrop(flag);
  flag.owner = null;
  flag.status = FLAG_STATUS.NO_EXIST;
  flag.flightStartedAt = 0;
  flag.grabbedAt = 0;
  if (flag.requiredType === null) flag.type = null;
  broadcastFlagUpdate(flag);
}

// An operator switching the ricochet game style has to clear whatever the old
// style left behind. Upstream settles the style at startup and never revisits
// it; the one thing that cannot simply be left alone is an `R` flag in a world
// that now forbids it, because it would sit there granting nothing. Shots
// already in flight keep the behaviour they were fired with, which is what
// every client was told when they began.
function applyRicochetGameStyle() {
  if (!getForbiddenFlags().includes('R')) return;
  flags.forEach((flag) => {
    if (flag.type !== 'R') return;
    zapFlag(flag);
  });
}

// DropGeometry::dropIt with maxZ unbounded, which is what every drop passes: a
// downward ray from the drop point to the highest flat top at or below it, or
// the ground. `flagsOnBuildings` does not gate this -- it gates the maxZ that
// resetFlag passes when choosing where a flag *spawns*, and for a drop it only
// decides whether a superflag is allowed to stay where the ray put it.
// `waterLevel` -- upstream's own `minZ`, everywhere a flag drop or spawn asks
// for one (`RandomSpawnPolicy.cxx`, `bzfs.cxx`'s `resetFlag`/`dropFlag`, both
// through `DropGeometry::dropIt`'s `if (pos[2] < minZ) pos[2] = minZ`). `0`
// with no water on the map, since the ground itself is always a valid floor.
function getFlagFloorY() {
  return (mapWaterLevel && mapWaterLevel.height > 0) ? mapWaterLevel.height : 0;
}

// `DropGeometry::dropIt`'s own two-way split -- "check the ground" only when
// `minZ <= 0.0f`, otherwise a point with nothing above the floor found by the
// ray is `return false` outright, never the floor itself. `findFlagLandingZ`
// returns `null` for exactly that case: a real obstacle top always wins
// (bzo has no clearance/opposing-base test of its own on a bare surface,
// unlike upstream's `isValidClearance`, so any flat top at or below `fromY`
// still counts), but nothing found is the ground when there is no water and
// "no safe landing here" once there is -- an open stretch of water is not a
// place a flag may rest, any more than it is a place a tank may stand.
function findFlagLandingZ(x, y, fromZ) {
  const floorZ = getFlagFloorY();
  let landingZ = floorZ;
  let found = floorZ <= 0;
  for (const obs of getCollisionColliders()) {
    // isValidLanding() skips anything a tank can drive through, and the world
    // boundary is not somewhere a flag belongs.
    if (obs.collisionKind === 'boundary' || obs.kind === 'teleporter') continue;
    const top = getColliderTopY(obs);
    if (top > fromZ || top <= landingZ) continue;
    if (!isOverFlatTop(obs, x, y)) continue;
    landingZ = top;
    found = true;
  }
  return found ? landingZ : null;

}

// dropIt's other branch: a flag let go of inside a building -- by a Phantom
// Zoned tank, or one that came down on a pyramid -- climbs to the lowest flat
// top above it with room on it, and has nowhere to land when there is none.
// The radius is a drop's, `FLAG_DROP_POINT_RADIUS`.
function findFlagClimbZ(x, y, fromZ) {
  const tops = [];
  for (const obs of getCollisionColliders()) {
    if (obs.collisionKind === 'boundary' || obs.kind === 'teleporter') continue;
    const top = getColliderTopY(obs);
    if (top < fromZ || !isOverFlatTop(obs, x, y)) continue;
    tops.push(top);
  }
  tops.sort((a, b) => a - b);
  return tops.find((top) => hasFlagClearance(x, y, top, FLAG_DROP_POINT_RADIUS)) ?? null;
}

// isOpposingTeam(). A team flag may not come to rest on another team's base:
// anyone picking it up there would instantly have carried their own team flag
// into enemy territory and blown up their whole team.
function isOpposingBaseAt(position, colorIndex) {
  const baseTeam = getBaseTeamAtPoint(OBSTACLES, position.x, position.y, position.z);
  return baseTeam !== null && baseTeam !== colorIndex;
}

// WorldInfo::getFlagDropPoint / EntryZones::getClosePoint (CustomZone.cxx:
// 184-206, EntryZones.cxx:128-153): a zone's `safety <team...>` names it as a
// landing spot for that team's dropped flag. Unlike a spawn zone (weighted
// random among every match), a safety zone is chosen by proximity to where
// the flag actually came down, so it settles nearby rather than crossing the
// map -- only `dropFlag` asks this, when a team flag has landed somewhere
// unsafe (see `isOpposingBaseAt` above it in that chain).
function getSafetyZonePosition(colorIndex, position) {
  let closest = null;
  let closestDistSq = Infinity;
  for (const zone of MAP_ZONES) {
    if (!zone.safety.has(colorIndex)) continue;
    const dx = zone.x - position.x;
    const dy = zone.y - position.y;
    const dz = zone.z - position.z;
    const distSq = (dx * dx) + (dy * dy) + (dz * dz);
    if (distSq < closestDistSq) {
      closestDistSq = distSq;
      closest = zone;
    }
  }
  return closest ? getRandomZonePoint(closest) : null;
}

// bzfs.cxx:3820. The timeout starts when the last held flag of an already empty
// team is dropped. It is the only thing that clears a team flag an enemy carried
// off before that team emptied.
function startTeamFlagTimeoutIfAbandoned(flag) {
  if (!isTeamEmpty(flag.team)) return;
  const stillCarried = flags.some((other) => (
    other !== flag && other.team === flag.team && other.owner !== null
  ));
  if (stillCarried) return;
  teamFlagTimeouts.set(flag.team, Date.now() + (TEAM_FLAG_TIMEOUT_SECONDS * 1000));
}

// bzfs.cxx:2478. The first player on a team brings its flag back into the world.
function resetTeamFlags(colorIndex) {
  if (!CTF_ENABLED) return;
  teamFlagTimeouts.delete(colorIndex);
  flags.forEach((flag) => {
    if (flag.team !== colorIndex) return;
    if (flag.status !== FLAG_STATUS.NO_EXIST) return;
    resetFlag(flag);
  });
}

// bzfs.cxx:2966. The last player leaving a team takes its flag out of the world,
// unless an enemy is carrying it -- then the timeout above deals with it.
function retireTeamFlags(colorIndex) {
  if (!CTF_ENABLED) return;
  if (colorIndex === null) return;
  if (!isTeamEmpty(colorIndex)) return;
  flags.forEach((flag) => {
    if (flag.team !== colorIndex) return;
    if (flag.status === FLAG_STATUS.NO_EXIST) return;
    const owner = getFlagOwner(flag);
    if (owner && getTeamColorIndex(owner.team) !== colorIndex) return;
    zapFlag(flag);
  });
}

// sendDrop(). Detaches the flag from its holder without moving it; the callers
// decide where it goes next. The state is packed before the owner is cleared
// because MsgDropFlag names the flag -- upstream's pack() defaults to not
// hiding -- and only the flagUpdate that follows makes it anonymous again.
function sendFlagDrop(flag) {
  const owner = getFlagOwner(flag);
  const state = getFlagState(flag);
  flag.owner = null;
  if (!owner) return;
  clearFlagShedState(owner);
  broadcastAll({ type: 'dropFlag', playerId: owner.id, flag: state });
}

// What `armBadFlagRelease` set up, taken back down. Every way a flag leaves a
// tank goes through here -- thrown, shaken, zapped, captured, or stolen -- and a
// theft is the one that does not send a drop with it.
function clearFlagShedState(owner) {
  owner.flagShakeWins = 0;
  if (!owner.antidote) return;
  owner.antidote = null;
  sendToPlayer(owner, { type: 'antidoteFlag', position: null });
}

function getPlayerFlag(playerId) {
  return flags.find((flag) => flag.owner === playerId) || null;
}

// The size a tank is, from the flag it is carrying. Upstream eases this in over
// _flagEffectTime; bzo takes the target from the moment the flag changes hands,
// so the client and the server never disagree about a hitbox mid-ease. Only the
// drawn tank eases.
function getPlayerTankScale(player) {
  return getTankDimensionScale(getPlayerFlag(player?.id)?.type ?? null);
}

// Player::isPhantomZoned, server side. The state lives on the flag entry, which
// is where every other thing about a flag lives, so there is one copy of it and
// the client is told it the same way it is told everything else about a flag.
function isPlayerZoned(player) {
  const flag = getPlayerFlag(player?.id);
  return isZoned(flag?.type ?? null, flag?.zoned === true);
}

function isPlayerPhased(player) {
  const flag = getPlayerFlag(player?.id);
  return drivesThroughBuildings(flag?.type ?? null, flag?.zoned === true);
}

// LocalPlayer::doUpdateMotion's `groundLimit` for a player: how far below zero
// the server will follow this tank.
function getPlayerGroundLimit(player) {
  return getGroundLimit(getPlayerFlag(player?.id)?.type ?? null);
}

function getShotFlagFor(player) {
  const flag = getPlayerFlag(player?.id);
  return getFiredShotFlag(flag?.type ?? null, flag?.zoned === true);
}

// LocalPlayer's `InBuilding` location (LocalPlayer.cxx:672), asked of the
// server's own record of where a tank is. The client refuses to shoot or to drop
// a flag there and an unmodified one never asks; this is the same question asked
// where a modified client cannot answer it, and the cover a building gives a
// shooter is the largest prize `OO` has to offer.
//
// Only a phased tank is asked. Any other tank inside a building is a
// client/server disagreement about the world, which the collision check in
// `validateMove` already reports as itself -- refusing its shots as well would
// bury that finding under a second one.
function isPlayerInsideBuilding(player, x, y, z, azimuth) {
  if (!isPlayerPhased(player)) return false;
  return checkCollision(x, y, z, 2, {
    azimuth,
    slack: ANTICHEAT_CONFIG.collisionSlack,
    tankScale: getPlayerTankScale(player),
    suppressLog: true,
  }) !== false;
}

// grabFlag(). The client sweeps for flags it is driving over and asks; this
// check exists to catch a modified client, so it uses upstream's deliberately
// loose radius -- a tank's whole second of travel plus both radii -- and only
// rejects a distant grab when the two are on the same level, as bzfs does.
// `now` is the caller's handler-entry clock: the extrapolation below and
// `grabbedAt` must agree on when the grab happened, or the shake timeout the
// STICKY check counts against starts from a slightly different instant than
// the one the reach check used.
function grabFlag(player, flag, now = Date.now(), { checkPos = true } = {}) {
  if (isObserverTeam(player.team)) return;
  if (!player.alive || player.paused) return;
  if (getPlayerFlag(player.id)) return;
  // `checkPos` is upstream's own argument, and it guards exactly these two:
  // where the flag is and how far away the tank is. `/flag give` is the caller
  // that turns it off, because the operator handing the flag out is not the
  // tank receiving it, and the flag need not be lying on the ground.
  if (checkPos && flag.status !== FLAG_STATUS.ON_GROUND) return;
  // bz_eAllowFlagGrab (bzfs.cxx:3715), asked of a grab a tank made: a
  // plugin may refuse it.
  if (checkPos) {
    const allowed = pluginEvent('bz_eAllowFlagGrab', () => ({
      playerID: Number(player.id), flagID: flag.index, flagType: flag.type, allow: true,
    }));
    if (allowed && !allowed.allow) return;
  }

  const reach = GAME_CONFIG.TANK_SPEED + TANK.radius + FLAG_RADIUS;
  const extrapolated = player.getExtrapolatedPosition(now);
  const gap = distance(extrapolated.x, extrapolated.y, flag.position.x, flag.position.y);
  if (checkPos && Math.abs(extrapolated.z - flag.position.z) < FLAG_GRAB_LEVEL_TOLERANCE && gap > reach) {
    const refused = reportCheat(player, 'flagRejected',
      `FLAG GRAB REJECTED flag ${flag.index} `
      + `${flag.position.x.toFixed(2)},${flag.position.y.toFixed(2)} is ${gap.toFixed(2)} away`
      + ` (reach ${reach.toFixed(2)})`);
    if (refused) return;
  }

  flag.owner = player.id;
  flag.status = FLAG_STATUS.ON_TANK;
  flag.flightStartedAt = 0;
  flag.grabbedAt = now;
  flag.zoned = false;
  // FlagInfo::grab: a grab starts the shot count again.
  flag.shots = 0;
  armBadFlagRelease(player, flag);
  log(`"${player.name}" grabbed ${getFlagType(flag.type).name} flag ${flag.index}`);
  broadcastAll({ type: 'grabFlag', playerId: player.id, flag: getFlagState(flag) });
  sendShotsLeft(player, flag);
  pluginEvent('bz_eFlagGrabbedEvent', () => ({
    playerID: Number(player.id), flagID: flag.index, flagType: flag.type, pos: pluginPos(flag.position),
  }));
}

// The shots a held flag of a limited type has left, to its holder's HUD. A
// BZFlag client has no counter and is told in chat instead (countFlagShot).
function sendShotsLeft(player, flag) {
  const limit = SHOT_LIMITS.get(flag.type);
  if (limit === undefined || player.native) return;
  sendToPlayer(player, { type: 'shotsLeft', flag: flag.index, left: Math.max(0, limit - (flag.shots || 0)) });
}

// bzfs.cxx:4266. Every shot fired while holding a flag counts against it,
// whatever the shot itself turned out to be. Upstream's messages go out on the
// first shot, every fifth and each of the last three; the last shot drops the
// flag where the tank is, used up, so it leaves the world.
function countFlagShot(player) {
  const flag = getPlayerFlag(player.id);
  if (!flag) return;
  flag.shots = (flag.shots || 0) + 1;
  const limit = SHOT_LIMITS.get(flag.type);
  if (limit === undefined) return;
  const left = limit - flag.shots;
  if (left > 0) {
    if (player.native && (left % 5 === 0 || left <= 3 || left === limit - 1)) {
      if (left > 1) replyToPlayer(player, '{count} shots left', { count: left });
      else replyToPlayer(player, '1 shot left');
    }
    sendShotsLeft(player, flag);
    return;
  }
  if (left < 0) return;
  sendShotsLeft(player, flag);
  flag.grabs = 0;
  dropFlag(flag);
}

// LocalPlayer::setFlag's antidote placement, moved to the server. Upstream picks
// a random spot inside a square centred on the world -- half the world on a CTF
// map, the world less a base width otherwise -- and rejects anywhere a tank
// could not stand, giving up after a hundred tries and taking what it has.
function findAntidotePosition() {
  const worldSize = GAME_CONFIG.MAP_SIZE;
  let position = { x: 0, y: 0, z: 0 };
  for (let attempt = 0; attempt < ANTIDOTE_PLACEMENT_ATTEMPTS; attempt++) {
    position = {
      x: getAntidoteCoordinate(worldSize, BASE_SIZE, CTF_ENABLED, Math.random()),
      y: getAntidoteCoordinate(worldSize, BASE_SIZE, CTF_ENABLED, Math.random()),
      z: 0,
    };
    // inBuilding(pos, tankRadius, tankHeight) upstream: the test is whether a
    // tank fits, not whether a flag does, because you have to drive onto it.
    if (!checkCollision(position.x, position.y, position.z, 2)) break;
  }
  return position;
}

// Everything that has to be set up when a player takes a sticky flag, and torn
// down when they lose it. The shake timeout needs neither -- it runs off
// `flag.grabbedAt`, which the flag itself carries.
//
// **The server picks the antidote spot, which upstream's client does.** Upstream
// can leave it on the client because upstream's bzfs accepts any drop request;
// bzo's refuses a sticky one, so a client-chosen antidote would mean accepting
// every sticky drop from anyone with `-sa` on and would undo the shake timeout's
// validation. Picking it here costs one message and makes the antidote as
// server-authoritative as the timeout, and the flag is drawn from the same
// numbers either way.
//
// A BZFlag client picks and draws its own spot (LocalPlayer.cxx:1663) and asks
// to drop there, so it gets none from here: two spots, one it cannot see,
// would be two ways off.
function armBadFlagRelease(player, flag) {
  const sticky = flag.endurance === FLAG_ENDURANCE.STICKY;
  player.flagShakeWins = sticky ? FLAG_SHAKE_WINS : 0;
  const antidote = sticky && ANTIDOTE_FLAGS && !player.native ? findAntidotePosition() : null;
  if (antidote === null && player.antidote === null) return;
  player.antidote = antidote;
  sendToPlayer(player, { type: 'antidoteFlag', position: antidote });
}

// checkEnvironment()'s "see if I'm over my antidote" (LocalPlayer.cxx:867),
// server-side for the same reason the placement is. Runs off each accepted
// position update, and asks the same two questions the flag grab does: same
// level, and within a tank plus a flag radius.
function checkAntidote(player, now = Date.now()) {
  const antidote = player.antidote;
  if (!antidote) return;
  const flag = getPlayerFlag(player.id);
  if (!flag || flag.endurance !== FLAG_ENDURANCE.STICKY) return;
  if (!player.alive || player.paused) return;
  if (Math.abs(player.z - antidote.z) >= FLAG_GRAB_LEVEL_TOLERANCE) return;
  if (distance(player.x, player.y, antidote.x, antidote.y) > getFlagGrabRadius()) return;

  log(`"${player.name}" drove onto the antidote and shed ${getFlagType(flag.type).name}`);
  dropFlag(flag, now);
}

// LocalPlayer::changeScore. A win owed against a bad flag, counted down by the
// server because the server is what decides a kill happened. Upstream only ever
// counts a win, never a loss or a teamkill, and drops at zero.
function recordShakeWin(player) {
  if (player.flagShakeWins <= 0) return;
  const flag = getPlayerFlag(player.id);
  if (!flag || flag.endurance !== FLAG_ENDURANCE.STICKY) return;
  player.flagShakeWins -= 1;
  if (player.flagShakeWins > 0) return;
  log(`"${player.name}" shook off ${getFlagType(flag.type).name} on wins`);
  dropFlag(flag);
}

// searchFlag(), asked rather than pushed. Upstream sweeps for every player on
// every position update and sends the answer whether or not the client could
// already give it. bzo's client keeps what it has learned in its own flag record
// -- `keepFlagIdentity` -- so it names a flag it recognises itself and asks only
// about one it cannot, which is at most one packet per flag per world rather
// than one per flag per pass along a row of them.
//
// The sweep is still upstream's and still the server's: `findNearestGroundFlag`
// in the flags module, over the range and the states upstream uses, so a client
// cannot ask about a flag it is nowhere near or one that is not lying on the
// ground. What arrives from the client is the question, never the answer.
//
// A flag's identity stays hidden in `flagUpdate` regardless. Identify tells its
// carrier what one flag is; it does not reveal that flag to the world.
function searchFlag(player) {
  if (getPlayerFlag(player.id)?.type !== 'ID') return;
  if (!player.alive || player.paused) return;

  const closest = findNearestGroundFlag(flags, player.x, player.y, player.z, getFlagTuning().identifyRange);
  if (!closest) return;

  sendToPlayer(player, {
    type: 'nearFlag',
    index: closest.index,
    flagType: closest.type,
    position: { ...closest.position },
  });
}

// dropFlag(). Upstream takes the drop position from the client because the
// server's copy lags; bzo uses its own, which is already movement-validated.
// Where the tank was when it let go. Dead-reckoned, like every other position
// the server judges -- grabFlag, getShotRejection and the drift check all read
// the extrapolation rather than the stored position, because between packets the
// stored one is out of date by construction.
//
// It matters most in the air, which is where flags are most often dropped: the
// client sends nothing between takeoff and landing, since the heartbeat is gated
// on being on the ground and vertical velocity is extrapolated rather than
// reported. The stored y for a tank shot down mid-jump is therefore the height it
// took off from, and its flag would launch from the floor and land under the
// tank that dropped it.
//
// Upstream takes this position from the client instead -- `sendDropFlag` packs
// `myTank->getPosition()` and `dropFlag` clamps it only to the world bounds
// (`bzfs.cxx:3745`). bzo reaches the same place without trusting the client for
// it. The wire format already matches: the drop broadcast carries the launch,
// the landing and the flight, as upstream's `flag.pack` does, so every client
// animates the server's numbers rather than deriving them from the tank.
function getFlagDropPosition(owner, now = Date.now()) {
  // Past a whole jump of silence the server does not know where the tank is --
  // a connection that stopped sending is the usual reason, and it still carries
  // whatever speed it had -- so the stored position beats extrapolating seconds
  // of travel that may never have happened.
  const gravity = GAME_CONFIG.GRAVITY > 0 ? GAME_CONFIG.GRAVITY : 9.8;
  const maxSilence = (2 * GAME_CONFIG.JUMP_VELOCITY / gravity) * 1000;
  if (now - owner.lastUpdate > maxSilence) {
    return { x: owner.x, y: owner.y, z: owner.z };
  }
  const extrapolated = owner.getExtrapolatedPosition(now);
  return { x: extrapolated.x, y: extrapolated.y, z: extrapolated.z };
}

// `now = Date.now()` is evaluated once and reused for both the drop position's
// extrapolation and `flightStartedAt` below, so the flag does not fly from a
// position measured at one instant but timed from another.
function dropFlag(flag, now = Date.now()) {
  if (flag.status !== FLAG_STATUS.ON_TANK) return;
  const owner = getFlagOwner(flag);
  if (!owner) return;
  flag.grabbedAt = 0;
  flag.zoned = false;

  const from = getFlagDropPosition(owner, now);
  const half = GAME_CONFIG.MAP_SIZE / 2;
  const launch = {
    x: (from.x < -half || from.x > half) ? 0 : from.x,
    y: (from.y < -half || from.y > half) ? 0 : from.y,
    z: from.z + FLAG_LAUNCH_TANK_HEIGHT,
  };
  const teamFlag = flag.team !== null;
  // Both kinds ride the same downward ray, cast from the tank's feet rather than
  // from the flag's launch altitude: dropIt gets `dropPos` while
  // FlagInfo::dropFlag adds the tank height to the launch point separately.
  //
  // `landingY` is `null` for open water -- nothing above the waterline under
  // this point at all (`findFlagLandingZ`) -- and for a building it cannot
  // climb out of (`findFlagClimbZ`). `landing.y` itself always gets a
  // real number regardless -- upstream's own `dropIt` leaves `pos[2]` at
  // `minZ` in that same case (`if (pos[2] < minZ) pos[2] = minZ`), it just
  // also returns `false`, which is the signal both branches below act on.
  let landingY = findFlagLandingZ(launch.x, launch.y, from.z);
  if (landingY !== null && !hasFlagClearance(launch.x, launch.y, landingY, FLAG_DROP_POINT_RADIUS)) {
    landingY = findFlagClimbZ(launch.x, launch.y, from.z);
  }
  let landing = {
    x: launch.x,
    y: launch.y,
    z: landingY === null ? getFlagFloorY() : landingY,
  };
  let vanish = false;

  if (teamFlag) {
    // A team flag never vanishes, so when it has nowhere safe to land upstream
    // works down a chain: the closest `safety` zone for this team, then the
    // world centre, then its own base. Upstream's own trigger for the whole
    // chain is `!safelyDropped` (`DropGeometry::dropTeamFlag`), which is true
    // for an opposing base exactly as much as for "nothing above the
    // waterline here" -- both are "this landing is not one the flag may
    // rest at", so `landingY === null` joins `isOpposingBaseAt` as the same
    // question asked twice.
    if (landingY === null || isOpposingBaseAt(landing, flag.team)) {
      const safety = getSafetyZonePosition(flag.team, landing);
      if (safety) {
        landing = safety;
      } else {
        // The world centre, re-dropped rather than assumed flat ground:
        // upstream re-runs `dropTeamFlag` at `{0,0,0}` rather than trusting
        // it blindly, and on a water map the centre may itself be a platform
        // (`maps/water.bzw`'s own hub) rather than the bare ground at `y=0`.
        const centreY = findFlagLandingZ(0, 0, getMaxObstacleTopY(OBSTACLES));
        const centre = { x: 0, y: 0, z: centreY === null ? getFlagFloorY() : centreY };
        if (centreY === null || isOpposingBaseAt(centre, flag.team)) {
          const base = getRandomTeamBase(flag.team);
          landing = base ? { x: base.pos[0], y: base.pos[1], z: getBaseTop(base) } : centre;
        } else {
          landing = centre;
        }
      }
    }
    startTeamFlagTimeoutIfAbandoned(flag);
  } else {
    // A good superflag has a limited number of grabs in it. With flags on
    // buildings off -- upstream's default -- one dropped anywhere but the ground
    // also has nowhere it is allowed to stay, so it rises out of the world from
    // wherever the ray put it rather than falling to the floor. Open water is
    // the same kind of nowhere -- `landingY === null` -- whether or not
    // buildings are otherwise allowed.
    // bzfs.cxx:3764: a limited flag that has been fired is used up when it
    // is dropped, however many shots it had left.
    if (SHOT_LIMITS.has(flag.type) && flag.shots > 0) flag.grabs = 0;
    flag.grabs -= 1;
    if (flag.grabs <= 0 || landingY === null) {
      vanish = true;
      flag.grabs = 0;
    } else if (!FLAGS_ON_BUILDINGS && landing.z > 0) {
      vanish = true;
    }
  }

  const flight = computeFlagFlight(getFlagThrownAltitude(flag.type), GAME_CONFIG.GRAVITY);
  flag.status = vanish ? FLAG_STATUS.GOING : FLAG_STATUS.IN_AIR;
  flag.launchPosition = launch;
  flag.landingPosition = landing;
  flag.position = { ...landing };
  flag.flightEnd = flight.flightEnd;
  flag.initialVelocity = flight.initialVelocity;
  flag.flightStartedAt = now;
  log(
    `"${owner.name}" dropped ${getFlagType(flag.type).name} flag ${flag.index} ` +
    `at ${landing.x.toFixed(2)},${landing.y.toFixed(2)}${vanish ? ' (vanishing)' : ''}`

  );

  sendFlagDrop(flag);
  broadcastFlagUpdate(flag);
  pluginEvent('bz_eFlagDroppedEvent', () => ({
    playerID: Number(owner.id), flagID: flag.index, flagType: flag.type, pos: pluginPos(landing),
  }));
}

// captureFlag(). Either an enemy flag brought onto the player's own base, or the
// player's own flag carried onto an enemy base. `baseColorIndex` is the base the
// client says it reached; the team that loses the flag is always the flag's own,
// so capturing your own flag costs your team and wins nobody anything.
function captureFlag(player, baseColorIndex) {
  const flag = getPlayerFlag(player.id);
  if (!flag || flag.team === null) return;
  if (!player.alive || player.paused) return;
  const cappingIndex = getTeamColorIndex(player.team);
  if (!isColorTeam(player.team)) return;

  // Upstream's cheat check only logs, and so does this one: a legitimate capture
  // and a quantized position are hard to tell apart, and refusing an honest one
  // is worse than trusting a modified client about a base it has to drive to.
  const standingOn = getBaseTeamAtPoint(OBSTACLES, player.x, player.y, player.z);
  if (standingOn !== baseColorIndex) {
    reportCheat(player, 'flagRejected',
      `CAPTURE CLAIMED base ${baseColorIndex} `
      + `while standing on ${standingOn === null ? 'no base' : standingOn}`,
      null, false);
  }

  const cappedIndex = flag.team;
  const cappedTeam = getTeamFromColorIndex(cappedIndex);
  const ownGoal = cappedIndex === cappingIndex;
  // bz_eAllowCTFCaptureEvent (bzfs.cxx captureFlag): a plugin may refuse the
  // capture, or let it stand without killing the team that lost the flag.
  const capture = {
    teamCapped: cappedIndex, teamCapping: cappingIndex, playerCapping: Number(player.id),
    pos: pluginPos(player), rot: player.azimuth,
  };
  const allowed = pluginEvent('bz_eAllowCTFCaptureEvent', () => ({ ...capture, allow: true, killTeam: true }));
  if (allowed && !allowed.allow) return;
  const killTeam = !allowed || allowed.killTeam;
  log(
    `"${player.name}" captured the ${cappedTeam} flag ` +
    `on the ${getTeamFromColorIndex(baseColorIndex)} base${ownGoal ? ' (their own)' : ''}`
  );

  // The flag goes home first, as upstream does it, so the drop that detaches it
  // reaches the client before the capture that explains it and before any client
  // respawns on the base it now sits on.
  resetFlag(flag);
  // `MsgCaptureFlag`'s own three fields, and its own meaning for the third:
  // the team whose *territory* the flag was carried into. Which team lost it
  // is read off the flag at `index`, by bzo's client as by upstream's
  // (`playing.cxx:2767`) -- a team flag keeps its type through the reset
  // above, so the answer is there either way, and a proxied capture can be
  // passed straight through rather than translated.
  broadcastAll({
    type: 'captureFlag',
    playerId: player.id,
    index: flag.index,
    team: baseColorIndex,
  });
  recordTeamScoreForCapture(ownGoal ? null : player.team, cappedTeam);

  // Everyone on the losing team dies and comes back on their own base. Upstream
  // scores no deaths for them -- the team loss is the whole penalty.
  players.forEach((victim) => {
    if (!killTeam || victim.team !== cappedTeam) return;
    // Even for a tank that is already dead: the capture is what decides where it
    // comes back, whether or not it was standing when the flag went.
    victim.restartOnBase = true;
    if (!victim.alive) return;
    // `captured` rather than a reason, and no score at all -- that is the whole
    // of how a capture differs from any other death, and everything it has in
    // common with one is in applyDeath.
    applyDeath(victim, player.id, { captured: true });
  });
  pluginEvent('bz_eCaptureEvent', () => ({ ...capture }));
}

// zapFlagByPlayer(). Death, disconnect, a pause, or a self-destruct all give up
// the flag: a droppable one is thrown where the tank stood, a sticky one just
// goes away.
// Not responding: a playing tank unheard from for `_notRespondingTime`
// (global.cxx:103). bzo's idle heartbeat may be five seconds
// (`MAX_UPDATE_INTERVAL`), so the limit is never under two of those -- an
// honest idle tank would otherwise flicker. What bzfs does when one stops
// (bzfs.cxx:5808): a new rabbit, and its flag dropped where it was last seen.
// Browsers mark it `[nr]` and say so in chat, as upstream's client does.
function notRespondingLimitMs() {
  const seconds = Number(GAME_CONFIG.NOT_RESPONDING_TIME);
  return Math.max((Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000,
    2 * GAME_CONFIG.MAX_UPDATE_INTERVAL);
}

function checkNotResponding(now = Date.now()) {
  const limit = notRespondingLimitMs();
  players.forEach((player) => {
    if (player.notResponding || !player.joined || !player.alive || isObserverTeam(player.team)) return;
    if (now - player.lastHeardAt <= limit) return;
    player.notResponding = true;
    log(`"${player.name}" not responding (${((now - player.lastHeardAt) / 1000).toFixed(1)}s)`);
    if (RABBIT_SELECTION && rabbitPlayerId === player.id) anointNewRabbit();
    dropPlayerFlag(player.id);
    broadcastPlayerRecord('playerUpdated', player);
  });
}
setInterval(() => checkNotResponding(), 1000).unref?.();

function noteHeardFrom(player, now = Date.now()) {
  player.lastHeardAt = now;
  if (!player.notResponding) return;
  player.notResponding = false;
  log(`"${player.name}" okay`);
  broadcastPlayerRecord('playerUpdated', player);
}

function dropPlayerFlag(playerId) {
  const flag = getPlayerFlag(playerId);
  if (!flag) return;
  if (flag.endurance === FLAG_ENDURANCE.STICKY) zapFlag(flag);
  else dropFlag(flag);
}

// cmdPause() (clientCommands.cxx:424) and updatePauseCountdown()
// (playing.cxx:6863). Upstream runs the whole countdown on the client and tells
// bzfs only the result; bzo runs it on the server, because the server is what
// decides whether a tank may be hit, and a countdown the client owned would be
// a countdown a modified client could skip.
//
// Upstream's reasons for refusing, in its own words: pausing drops the team
// flag and stops the tank answering for where it is, so a tank may only pause
// somewhere it could still legally stand after losing everything it carries.
function getPauseRefusal(player) {
  if (player.jumpAzimuth !== null && player.jumpAzimuth !== undefined) {
    return 'Can\'t pause when you are in the air';
  }
  if (checkCollision(player.x, player.y, player.z, TANK.radius, { suppressLog: true })) {
    return 'Can\'t pause while inside a building';
  }
  return null;
}

function clearPauseTimers(player) {
  if (player.pauseTimer !== null) {
    clearTimeout(player.pauseTimer);
    player.pauseTimer = null;
  }
  if (player.pauseDropTimer !== null) {
    clearTimeout(player.pauseDropTimer);
    player.pauseDropTimer = null;
  }
}

// The countdown ending in anything other than a pause: the player pressed pause
// again, or the tank had moved somewhere it may not pause from. Upstream shows
// both on the same alert slot, so both travel as one message.
function cancelPauseCountdown(player, reason) {
  clearPauseTimers(player);
  player.pauseCountdownStart = 0;
  sendToPlayer(player, { type: 'pauseCancelled', playerId: player.id, reason });
}

function setPaused(player, paused) {
  clearPauseTimers(player);
  player.paused = paused;
  player.pauseCountdownStart = 0;
  // The clock restarts here so the drift check never reads the gap since the
  // last move through the stored velocities, which would carry a tank that was
  // rolling when it paused clean across the map. A paused tank's heartbeats
  // then arrive from where it stands, with no motion (`sendFrozenHeartbeat` in
  // client.js), and keep it from being marked not responding. The
  // velocities themselves are left alone, as LocalPlayer.cxx:284 leaves them
  // alone ("set dt to zero instead of clearing velocity ... for when we
  // resume"): both ends kept them, so both ends still agree.
  player.lastUpdate = Date.now();
  player.lag.resetUpdateGap();

  // bzfs.cxx:2802. A rabbit that pauses gives the post up, because a rabbit
  // nobody can shoot is not a rabbit; and a player coming back takes it if the
  // world has none, which is how a game where everybody paused recovers.
  if (RABBIT_SELECTION) {
    if (paused ? rabbitPlayerId === player.id : rabbitPlayerId === null) anointNewRabbit();
  }

  if (!paused) {
    broadcastAll({ type: 'playerUnpaused', playerId: player.id });
    return;
  }

  // playing.cxx:6913 gives up the team flag before the pause takes hold. A
  // paused tank cannot be shot, so a team flag it kept would be out of the game
  // for as long as its carrier stayed away.
  const flag = getPlayerFlag(player.id);
  if (flag && flag.team !== null) dropPlayerFlag(player.id);

  // LocalPlayer::doUpdate drops whatever is left after _pauseDropTime, which is
  // what stops a player parking a superflag somewhere nobody can take it back.
  player.pauseDropTimer = setTimeout(() => {
    player.pauseDropTimer = null;
    if (players.has(player.id) && player.paused) dropPlayerFlag(player.id);
  }, GAME_CONFIG.PAUSE_DROP_TIME);

  broadcastAll({
    type: 'playerPaused',
    playerId: player.id,
    x: player.x,
    y: player.y,
    z: player.z,
  });
}

// autopilotPlayer (bzfs.cxx:2820). Turning it off is always allowed. Upstream
// kicks a player who turns it on against `-disableBots`; bzo has no kick and
// its own client never asks, so the request is refused with upstream's words.
//
// The scoreboard says who is flying: the pilot's name stands in for the motto
// while it does, and the player's own comes back when it lands. Asking again
// with another pilot only changes the name.
function setAutopilot(player, on, pilot) {
  if (on && botsDisabled()) {
    replyToPlayer(player, "I'm sorry, we do not allow autopilot on this server.");
    return;
  }
  if (isObserverTeam(player.team)) return;
  if (!on && !player.autopilot) return;
  const changed = player.autopilot !== on;
  const previousName = player.autopilotName;
  if (on) {
    if (!player.autopilot) player.savedMotto = player.motto;
    player.autopilotName = sanitizeMotto(typeof pilot === 'string' && pilot ? pilot : 'Roger');
    player.motto = player.autopilotName;
  } else {
    player.motto = player.savedMotto ?? '';
    player.savedMotto = null;
    player.autopilotName = null;
  }
  player.autopilot = on;
  if (changed) {
    log(`Player ${player.id} "${player.name}" autopilot ${on ? `on (${player.autopilotName})` : 'off'}`);
  }
  // Said again when the pilot changes in flight, so everyone hears who has
  // the controls now.
  if (changed || on) {
    broadcastAll({ type: 'autopilot', playerId: player.id, on, pilot: on ? player.autopilotName : previousName });
  }
  if (player.joined) broadcastPlayerRecord('playerUpdated', player);
}

function requestPause(player) {
  // pausePlayer() (bzfs.cxx:2778) ignores a pause from a tank that is not alive,
  // and an observer has no tank to pause at all.
  if (isObserverTeam(player.team) || !player.alive) return;

  if (player.paused) {
    setPaused(player, false);
    return;
  }

  if (player.pauseCountdownStart > 0) {
    cancelPauseCountdown(player, 'Pause cancelled');
    return;
  }

  const refusal = getPauseRefusal(player);
  if (refusal) {
    sendToPlayer(player, { type: 'pauseCancelled', playerId: player.id, reason: refusal });
    return;
  }

  player.pauseCountdownStart = Date.now();
  // The life the countdown was started in. A tank that died and respawned inside
  // those five seconds is a tank that never asked to pause.
  const startedLife = player.losses;
  player.pauseTimer = setTimeout(() => {
    player.pauseTimer = null;
    if (!players.has(player.id) || player.losses !== startedLife || !player.alive) {
      player.pauseCountdownStart = 0;
      return;
    }
    // Checked again at the end, as upstream checks it again: the tank has had
    // five seconds to drive somewhere it may not pause from.
    const lateRefusal = getPauseRefusal(player);
    if (lateRefusal) {
      cancelPauseCountdown(player, lateRefusal);
      return;
    }
    setPaused(player, true);
  }, GAME_CONFIG.PAUSE_COUNTDOWN);

  broadcastAll({ type: 'pauseCountdown', playerId: player.id });
}

// A team flag's identity is fixed and never hidden; a superflag slot starts
// empty and the insertion schedule gives it one.
function createFlagSlot(index, teamColorIndex, { requiredType = null, zoneIndex = null } = {}) {
  return {
    index,
    team: teamColorIndex,
    // FlagInfo::setRequiredFlag. A slot with a required type always holds that
    // type; a `zoneflag` slot also names the zone it respawns in.
    requiredType,
    zoneIndex,
    type: teamColorIndex === null ? requiredType : getTeamFlagAbbreviation(teamColorIndex),
    status: FLAG_STATUS.NO_EXIST,
    endurance: teamColorIndex === null ? FLAG_ENDURANCE.UNSTABLE : FLAG_ENDURANCE.NORMAL,
    owner: null,
    grabs: 0,
    // When the current carrier picked it up, which is the shake clock the
    // server checks a sticky drop against. Zero whenever nobody holds it.
    grabbedAt: 0,
    // `PlayerState::FlagActive`, which only Phantom Zone reads. A flag arrives
    // in a tank's hands switched off, so picking `PZ` up gives you nothing until
    // you have driven through a teleporter.
    zoned: false,
    position: { x: 0, y: 0, z: 0 },
    launchPosition: { x: 0, y: 0, z: 0 },
    landingPosition: { x: 0, y: 0, z: 0 },
    flightEnd: 0,
    initialVelocity: 0,
    flightStartedAt: 0,
  };
}

function createFlags() {
  flags.length = 0;
  // Team flags come first, as they do upstream, so a team's flag index does not
  // move when the superflag count changes.
  const teamFlagTeams = CTF_ENABLED
    ? TEAM_MODE.teams.filter((team) => isColorTeam(team) && getTeamBases(getTeamColorIndex(team)).length > 0)
    : [];
  teamFlagTeams.forEach((team) => {
    flags.push(createFlagSlot(flags.length, getTeamColorIndex(team)));
  });
  // `+f` flags next: required types with no zone, so they spawn anywhere a
  // `flag` zone does not claim them. A forbidden type is skipped, as a zone's
  // is below.
  Object.entries(REQUIRED_FLAG_COUNTS).forEach(([abbreviation, count]) => {
    if (getForbiddenFlags().includes(abbreviation)) return;
    for (let slot = 0; slot < count; slot++) {
      flags.push(createFlagSlot(flags.length, null, { requiredType: abbreviation }));
    }
  });
  // Zone flags next, before the random slots, which is upstream's order in
  // finalizeParsing: team flags, then `+f` flags, then zone flags, then the `-s`
  // tail. Keeping it means a zone flag's index does not move when `-s` changes,
  // and the tail stays the part that draws from the pool.
  const zoneForbiddenFlags = getForbiddenFlags();
  const skippedZoneFlags = new Set();
  MAP_ZONES.forEach((zone) => {
    zone.unknownFlags.forEach((abbreviation) => skippedZoneFlags.add(abbreviation));
    zone.flagCounts.forEach((count, abbreviation) => {
      // Upstream skips a forbidden type here too, so a zone cannot put back what
      // the game style or a `-f` took out. A team type belongs to
      // addZoneTeamFlags, which bzo does not have: its team flags live on bases.
      if (zoneForbiddenFlags.includes(abbreviation) || isTeamFlag(abbreviation)) {
        skippedZoneFlags.add(abbreviation);
        return;
      }
      for (let slot = 0; slot < count; slot++) {
        flags.push(createFlagSlot(flags.length, null, {
          requiredType: abbreviation,
          zoneIndex: zone.index,
        }));
      }
    });
  });
  for (let slot = 0; slot < SUPER_FLAGS.count; slot++) {
    flags.push(createFlagSlot(flags.length, null));
  }

  flags.forEach((flag) => {
    // A team flag waits at its base for its team's first player; upstream starts
    // the superflag slots empty too and lets the insertion schedule fill them,
    // which would leave a fresh server flagless for a minute, so bzo spawns
    // those at once instead and a map always opens with its flags.
    if (flag.team !== null) {
      resetFlag(flag);
      return;
    }
    flag.position = findFlagSpawnPosition(flag);
    addFlag(flag);
  });

  if (teamFlagTeams.length > 0) log(`Flags: team flags for ${teamFlagTeams.join(', ')}`);
  const zoneFlagCount = flags.filter((flag) => flag.zoneIndex !== null).length;
  // A forbidden type is named once, on the forbidden list below; this names
  // only what bzo does not have and team types, which live on bases.
  const skippedUnforbidden = Array.from(skippedZoneFlags)
    .filter((abbreviation) => !zoneForbiddenFlags.includes(abbreviation)).sort();
  if (zoneFlagCount > 0 || skippedUnforbidden.length > 0) {
    log(
      `Flags: ${zoneFlagCount} zone flags from ${MAP_ZONES.length} zones`
      + (skippedUnforbidden.length > 0 ? `; skipped ${skippedUnforbidden.join(', ')}` : '')
    );
  }
  if (SUPER_FLAGS.count > 0) {
    log(
      `Flags: ${SUPER_FLAGS.count} superflag slots (${getSuperFlagPool().join(', ')});` +
      ` flagsOnBuildings=${FLAGS_ON_BUILDINGS}` +
      (MAP_FORBIDDEN_FLAGS.length > 0 ? `; map forbids ${MAP_FORBIDDEN_FLAGS.join(', ')}` : '')
    );
  }
  const forbidden = getForbiddenFlags();
  log(
    `Jumping: ${ALLOW_JUMPING ? 'allowed' : 'flag only'};`
    + ` ricochet: ${GAME_CONFIG.ALL_SHOTS_RICOCHET ? 'all shots' : 'flag only'};`
    + ` bad flags shake off ${describeBadFlagRelease()}`
    + (forbidden.length > 0 ? `; forbidden flags ${forbidden.join(', ')}` : '')
  );
  if (getSuperFlagPool().includes('WG')) {
    log(
      `Wings: jumpCount=${GAME_CONFIG.WINGS_JUMP_COUNT},`
      + ` jumpVelocity=${GAME_CONFIG.WINGS_JUMP_VELOCITY},`
      + ` gravity=${GAME_CONFIG.WINGS_GRAVITY}, slideTime=${GAME_CONFIG.WINGS_SLIDE_TIME}`
    );
  }
}

// FlagInfo::landing plus the superflag insertion from the bzfs main loop. A
// flight that has run its course either settles the flag or empties its slot;
// an empty slot refills on a halflife distribution.
function updateFlags(now) {
  flags.forEach((flag) => {
    if (flag.flightStartedAt === 0) return;
    if (flag.status !== FLAG_STATUS.IN_AIR
      && flag.status !== FLAG_STATUS.COMING
      && flag.status !== FLAG_STATUS.GOING) return;
    if ((now - flag.flightStartedAt) / 1000 < flag.flightEnd) return;

    if (flag.status === FLAG_STATUS.GOING) {
      resetFlag(flag);
      return;
    }
    flag.status = FLAG_STATUS.ON_GROUND;
    flag.position = { ...flag.landingPosition };
    flag.flightStartedAt = 0;
    broadcastFlagUpdate(flag);
  });

  teamFlagTimeouts.forEach((deadline, colorIndex) => {
    if (now < deadline) return;
    teamFlagTimeouts.delete(colorIndex);
    if (!isTeamEmpty(colorIndex)) return;
    flags.forEach((flag) => {
      if (flag.team !== colorIndex) return;
      if (flag.status === FLAG_STATUS.NO_EXIST || flag.owner !== null) return;
      log(`Flag timeout for ${getTeamFromColorIndex(colorIndex)} team`);
      zapFlag(flag);
    });
  });

  if (SUPER_FLAGS.count === 0) return;
  if (now < nextSuperFlagInsertionAt) return;
  // -logf(bzfrand()) / (-logf(0.5) / FlagHalfLife) seconds until the next one.
  const roll = Math.random() + 0.01;
  const flagExp = -Math.log(0.5) / SUPER_FLAG_HALF_LIFE_SECONDS;
  nextSuperFlagInsertionAt = now + ((-Math.log(roll) / flagExp) * 1000);
  // resetFlag already chose where the empty slot's next flag belongs, as
  // upstream does; the insertion only decides when it arrives.
  const empty = flags.find((flag) => flag.team === null && flag.status === FLAG_STATUS.NO_EXIST);
  if (!empty) return;
  addFlag(empty);
  broadcastFlagUpdate(empty);
}

// Nearby voice protocol. Clients send voiceState with { enabled }, and send
// voiceOffer/voiceAnswer with { targetId, description }. ICE messages use
// { targetId, candidate }, where candidate may be null for end-of-candidates.
// The legacy alias `to` is accepted for targetId so reconnecting clients can
// keep their peer-routing field without widening the server-side permissions.
// The server replies with voiceRoster, voiceState, voiceOffer, voiceAnswer,
// and voiceIceCandidate. Every server-to-client voice message includes the
// nearby channel name and signaling messages identify their sender in `from`.
// Signaling is forwarded only to eligible peers on the sender's own channel.
// Audio media remains on the WebRTC connection, not on this socket.
//
// The channel rides on every message. Which players a channel puts together is
// public/js/voice-channels.mjs, which both sides load, and the
// server is the side that enforces it: withholding the roster and the signalling
// is the only lever there is, because the media never passes through here.
const VOICE_ROSTER_REFRESH_INTERVAL = 200;
const MAX_VOICE_SDP_LENGTH = 128 * 1024;
const MAX_VOICE_CANDIDATE_LENGTH = 16 * 1024;

function sendToPlayer(player, message) {
  if (player?.ws?.readyState === 1) {
    player.ws.send(JSON.stringify(message));
  }
}

function normalizePlayerId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    return value;
  }
  return null;
}

// An observer's heartbeat, sent every MAX_UPDATE_INTERVAL by the client, and
// early only when the camera has drifted far enough that waiting out the rest of
// the interval would place it a whole earshot away. It has no tank: nothing
// collides with it, nothing it does originates a shot, and the only thing on the
// server that reads its position is the nearby voice roster. So the position is
// taken as sent. The one test is that the numbers are numbers, because a NaN
// would poison the distance maths -- that is parsing, not validation, and there
// is deliberately no validation here.
//
// Velocities are forced to zero rather than read, so no path extrapolates a
// camera between heartbeats. The position is simply five seconds stale at worst,
// and less than a quarter of the nearby radius wrong whatever the camera did.
//
// It goes out as an ordinary `pm`, because the other clients need it too: voice
// is peer to peer, so each client decides for itself how loud a peer is and
// where it stands, and it can only do that for an observer it can locate. Zero
// velocities mean the receiving end has nothing to extrapolate either, and the
// mesh it moves is the invisible one every observer already has while dead.
//
// What this allows is being heard from somewhere you are not, which is a small
// thing beside what an observer may already watch, and smaller still beside a
// modified client picking a channel that ignores distance.
function applyObserverHeartbeat(player, message, ws) {
  const x = Number(message.x);
  const y = Number(message.y);
  const z = Number(message.z);
  const a = Number(message.a);
  if (![x, y, z, a].every(Number.isFinite)) return;
  player.x = x;
  player.y = y;
  player.z = z;
  player.azimuth = a;
  player.forwardSpeed = 0;
  player.rotationSpeed = 0;
  player.verticalVelocity = 0;
  broadcast({
    type: 'pm',
    id: player.id,
    x, y, z, a,
    fs: 0,
    rs: 0,
    vv: 0,
    vx: 0,
    vy: 0,
  }, ws);

}

function isVoicePeer(source, target) {
  if (!source || !target || source.id === target.id) return false;
  if (!source.joined || !target.joined) return false;
  // A server bot has no browser behind it to answer an offer, so a connection
  // to one would only sit at `new` -- and take a place a person could have.
  if (bots.has(source.id) || bots.has(target.id)) return false;
  // Infinity rather than 0 for a player with no position yet: out of earshot is
  // the safe reading, and only Nearby consults it at all.
  const planar = Number.isFinite(source.x) && Number.isFinite(source.y)
    && Number.isFinite(target.x) && Number.isFinite(target.y)
    ? distance(source.x, source.y, target.x, target.y)

    : Infinity;
  return areVoicePeers(source, target, planar, GAME_CONFIG.VOICE_NEARBY_RADIUS);
}

function getVoicePeers(player) {
  return Array.from(players.values())
    .filter((candidate) => isVoicePeer(player, candidate))
    .sort((left, right) => Number(left.id) - Number(right.id));
}

function getVoicePeerState(peer) {
  return {
    id: peer.id,
    name: peer.name,
    team: peer.team,
    micEnabled: peer.voiceMicEnabled === true,
  };
}

function sendVoiceRoster(player, force = false) {
  if (!player.joined) return;

  const peers = getVoicePeers(player);
  // The player's own channel is in the signature because switching channels can
  // leave the peer set unchanged -- two teammates standing together, say -- and
  // the roster still has to go out saying which channel they are now on.
  const signature = [player.voiceChannel, ...peers
    .map((peer) => `${peer.id}:${peer.team}:${peer.voiceMicEnabled === true ? 1 : 0}`)]
    .join('|');
  if (!force && player.voiceRosterSignature === signature) return;

  player.voiceRosterSignature = signature;
  sendToPlayer(player, {
    type: 'voiceRoster',
    channel: player.voiceChannel,
    nearbyRadius: GAME_CONFIG.VOICE_NEARBY_RADIUS,
    peers: peers.map(getVoicePeerState),
  });
}

function refreshVoiceRosters(force = false) {
  players.forEach((player) => sendVoiceRoster(player, force));
}

function sendVoiceStateUpdate(player) {
  if (!player.joined) return;

  const stateMessage = {
    type: 'voiceState',
    channel: player.voiceChannel,
    playerId: player.id,
    team: player.team,
    enabled: player.voiceMicEnabled === true,
  };
  sendToPlayer(player, stateMessage);
  getVoicePeers(player).forEach((peer) => sendToPlayer(peer, stateMessage));
}

function getVoiceDescription(message, expectedType) {
  const description = message && message.description;
  if (!description || typeof description !== 'object' || Array.isArray(description)) return null;
  if (description.type !== expectedType || typeof description.sdp !== 'string') return null;
  if (description.sdp.length === 0 || description.sdp.length > MAX_VOICE_SDP_LENGTH) return null;
  return {
    type: expectedType,
    sdp: description.sdp,
  };
}

function getVoiceCandidate(message) {
  const candidate = message && message.candidate;
  if (candidate === null) return null;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  if (typeof candidate.candidate !== 'string' || candidate.candidate.length > MAX_VOICE_CANDIDATE_LENGTH) {
    return null;
  }
  if (candidate.sdpMid !== undefined && candidate.sdpMid !== null
    && (typeof candidate.sdpMid !== 'string' || candidate.sdpMid.length > 256)) {
    return null;
  }
  if (candidate.sdpMLineIndex !== undefined && candidate.sdpMLineIndex !== null
    && (!Number.isInteger(candidate.sdpMLineIndex) || candidate.sdpMLineIndex < 0)) {
    return null;
  }
  if (candidate.usernameFragment !== undefined && candidate.usernameFragment !== null
    && (typeof candidate.usernameFragment !== 'string' || candidate.usernameFragment.length > 256)) {
    return null;
  }
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    usernameFragment: candidate.usernameFragment ?? null,
  };
}

function forwardVoiceSignal(player, message) {
  if (!player.joined) return;

  const targetId = normalizePlayerId(message.targetId ?? message.to);
  const target = targetId ? players.get(targetId) : null;
  if (!target || !isVoicePeer(player, target)) return;

  if (message.type === 'voiceOffer' || message.type === 'voiceAnswer') {
    const description = getVoiceDescription(message, message.type === 'voiceOffer' ? 'offer' : 'answer');
    if (!description) return;
    sendToPlayer(target, {
      type: message.type,
      channel: player.voiceChannel,
      from: player.id,
      description,
    });
    return;
  }

  const candidate = getVoiceCandidate(message);
  if (candidate === null && message.candidate !== null) return;
  sendToPlayer(target, {
    type: 'voiceIceCandidate',
    channel: player.voiceChannel,
    from: player.id,
    candidate,
  });
}

// The teleporter's parts, read off the solid the parser already resolved. It
// computes nothing about the border any more: `w`/`d`/`h` are the frame, as they
// are for every other obstacle, and the only thing left to derive is the portal
// opening inside it -- upstream's scene generator does the same subtraction,
// `getBreadth() - border` and `getHeight() - border`.








const PLAYER_TELEPORT_REENTRY_BLOCK_DISTANCE = 5.0;
const PLAYER_TELEPORT_REENTRY_BLOCK_MIN_MS = 250;
const PLAYER_TELEPORT_EXIT_EPSILON = 0.08;
const PLAYER_TELEPORT_COOLDOWN_MS = 1000;

function isPlayerTeleportReentryBlocked(player, teleporterIndex, now) {
  if (!player || !Number.isInteger(teleporterIndex)) return false;
  if (player.teleportReentryBlockTeleporterIndex !== teleporterIndex) return false;
  return player.teleportReentryBlockDistance > 1e-6 || now < (player.teleportReentryBlockUntil || 0);
}

function decayPlayerTeleportReentryBlock(player, travelDistance, now) {
  if (!player) return;
  const moved = Math.max(0, Number(travelDistance) || 0);
  player.teleportReentryBlockDistance = Math.max(0, (player.teleportReentryBlockDistance || 0) - moved);
  if (player.teleportReentryBlockDistance <= 1e-6 && now >= (player.teleportReentryBlockUntil || 0)) {
    player.teleportReentryBlockTeleporterIndex = null;
    player.teleportReentryBlockDistance = 0;
    player.teleportReentryBlockUntil = 0;
  }
}

function isPointInsideTeleporterPortal(obs, x, y, z, tankRadius = 2) {
  if (!obs || obs.kind !== 'teleporter') return false;
  const obstacleBase = getObstacleBase(obs);
  const epsilon = 0.15;
  const tankTop = z + tankRadius;
  const { x: localX, y: localY } = getColliderLocalPoint(x, y, obs);
  const dims = getShotTeleporterDims(obs);
  const innerDistSquared = getBoxCollisionDistanceSquared(localX, localY, dims.halfW, dims.activeHalfD);
  const activeBottom = obstacleBase;
  const activeTop = obstacleBase + dims.activeH;
  const overlapsActiveVertical = tankTop > (activeBottom + epsilon) && z < (activeTop - epsilon);
  return overlapsActiveVertical && innerDistSquared < tankRadius * tankRadius;
}

// Why a zone toggle is refused, or null when it stands. A zoning tank does not
// move, so there is no destination to transform to and no cooldown of its own:
// the crossing is the whole claim, and it is checked the same way
// `applyPlayerTeleportMessage` checks the crossing of a tank that does move --
// against the point the client says it crossed at, never against wherever the
// server has since extrapolated the tank to. At tank speed a frame is several
// units, so the extrapolated position is past the portal by the time the
// message lands.
// The teleporter face a tank passed through between two positions, and the
// point where. A BZFlag client zones with no face named (only `FlagActive`),
// so the server finds the one its path crossed and checks it as it checks a
// browser's `zone`. The face is upstream's (`Teleporter::isTeleported`,
// Teleporter.cxx:365): 0 entered from the teleporter's own east, 1 from west.
function findCrossedTeleporterFace(from, to) {
  const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const steps = Math.min(200, Math.max(1, Math.ceil(length / 0.5)));
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const at = {
      x: from.x + ((to.x - from.x) * t),
      y: from.y + ((to.y - from.y) * t),
      z: from.z + ((to.z - from.z) * t),
    };
    for (const [index, obs] of TELEPORTER_OBSTACLES_BY_INDEX) {
      if (!isPointInsideTeleporterPortal(obs, at.x, at.y, at.z, 2)) continue;
      const side = getColliderLocalPoint(from.x, from.y, obs).x > 0 ? 0 : 1;
      return { faceId: (index * 2) + side, at };
    }
  }
  return null;
}

function getZoneRefusal(player, at, faceId, now) {
  if (!Number.isInteger(faceId)) return `face ${faceId} is not a teleporter face`;
  if (!Number.isFinite(at.x) || !Number.isFinite(at.y) || !Number.isFinite(at.z)) {
    return `crossing point is not finite (${at.x}, ${at.y}, ${at.z})`;
  }
  const obs = TELEPORTER_OBSTACLES_BY_INDEX.get(Math.floor(faceId / 2));
  if (!obs) return `no teleporter for face ${faceId}`;
  const azimuth = Number.isFinite(at.azimuth) ? at.azimuth : player.azimuth;
  const deltaTime = Math.max(0, (now - player.lastUpdate) / 1000);
  if (!validateMovement(player, at.x, at.y, at.z, azimuth, deltaTime, true, {}, now)) {
    return `crossing point ${formatShotPoint(at.x, at.y, at.z)} is not a place this tank could be`;
  }
  if (!isPointInsideTeleporterPortal(obs, at.x, at.y, at.z, 2)) {
    return `${formatShotPoint(at.x, at.y, at.z)} is not inside the portal of face ${faceId}`;
  }
  return null;
}

// `sourceState` is the crossing in upstream's frame, in a player's own field
// names, plus `vv`.
function applyPlayerTeleportMessage(player, sourceState, fromFaceId, toFaceId, now) {
  if (!player || !sourceState || !Number.isInteger(fromFaceId) || !Number.isInteger(toFaceId)) {
    return { ok: false, reason: 'invalid_packet' };
  }

  if (!Number.isFinite(sourceState.x) || !Number.isFinite(sourceState.y) || !Number.isFinite(sourceState.z)) {
    return { ok: false, reason: 'invalid_source_state' };
  }

  const sourceAzimuth = Number.isFinite(sourceState.azimuth) ? sourceState.azimuth : player.azimuth;
  const sourceVerticalVelocity = Number.isFinite(sourceState.vv) ? sourceState.vv : player.verticalVelocity;
  const sourceAirVelocityX = Number.isFinite(sourceState.airVelocityX) ? sourceState.airVelocityX : player.airVelocityX;
  const sourceAirVelocityY = Number.isFinite(sourceState.airVelocityY) ? sourceState.airVelocityY : player.airVelocityY;
  const hasSourceJumpAzimuth = sourceState.jumpAzimuth !== null && Number.isFinite(sourceState.jumpAzimuth);
  const sourceJumpAzimuth = hasSourceJumpAzimuth ? sourceState.jumpAzimuth : player.jumpAzimuth;

  if (now < (player.teleportCooldownUntil || 0)) {
    return { ok: false, reason: 'cooldown' };
  }

  const expectedToFaceId = getTeleportDestinationFace(TELEPORTER_LINKS_BY_SOURCE_FACE, fromFaceId);
  if (toFaceId !== expectedToFaceId) {
    return { ok: false, reason: 'invalid_link' };
  }

  const sourceTeleporterIndex = Math.floor(fromFaceId / 2);
  const destinationTeleporterIndex = Math.floor(toFaceId / 2);
  const sourceFace = fromFaceId % 2;
  const destinationFace = toFaceId % 2;
  const sourceObs = TELEPORTER_OBSTACLES_BY_INDEX.get(sourceTeleporterIndex);
  const destinationObs = TELEPORTER_OBSTACLES_BY_INDEX.get(destinationTeleporterIndex);
  if (!sourceObs || !destinationObs) {
    return { ok: false, reason: 'missing_teleporter' };
  }

  const deltaTime = Math.max(0, (now - player.lastUpdate) / 1000);
  if (!validateMovement(player, sourceState.x, sourceState.y, sourceState.z, sourceAzimuth, deltaTime, true, {}, now)) {
    return { ok: false, reason: 'invalid_source_state' };
  }

  if (!isPointInsideTeleporterPortal(sourceObs, sourceState.x, sourceState.y, sourceState.z, 2)) {
    return { ok: false, reason: 'not_in_source_portal' };
  }

  if (isPlayerTeleportReentryBlocked(player, sourceTeleporterIndex, now)) {
    return { ok: false, reason: 'reentry_block' };
  }

  player.x = sourceState.x;
  player.y = sourceState.y;
  player.z = sourceState.z;
  player.azimuth = sourceAzimuth;
  player.verticalVelocity = sourceVerticalVelocity;
  player.airVelocityX = sourceAirVelocityX;
  player.airVelocityY = sourceAirVelocityY;
  player.jumpAzimuth = sourceJumpAzimuth;

  const moveAzimuth = player.slideAzimuth !== undefined
    ? player.slideAzimuth
    : (player.jumpAzimuth !== null && player.jumpAzimuth !== undefined ? player.jumpAzimuth : player.azimuth);
  const dirIn = {
    x: Math.cos(moveAzimuth),
    y: Math.sin(moveAzimuth),
    z: 0,
  };

  const transformed = transformShotThroughTeleporter(
    { x: sourceState.x, y: sourceState.y, z: sourceState.z },
    dirIn,
    sourceObs,
    sourceFace,
    destinationObs,
    destinationFace,
  );

  const outX = transformed.pointOut.x + transformed.dirOut.x * PLAYER_TELEPORT_EXIT_EPSILON;
  const outY = transformed.pointOut.y + transformed.dirOut.y * PLAYER_TELEPORT_EXIT_EPSILON;
  const outZ = Math.max(0, transformed.pointOut.z + transformed.dirOut.z * PLAYER_TELEPORT_EXIT_EPSILON);

  // "Tank becomes very large.  Can't fit through teleporters." Obesity needs no
  // rule of its own for that: the portal interior is checked at full size, so a
  // tank too wide for the opening is simply blocked here.
  const destinationCollision = checkCollision(outX, outY, outZ, 2, {
    ignoreTeleporters: true,
    azimuth: player.azimuth,
    suppressLog: true,
    tankScale: getPlayerTankScale(player),
  });
  if (destinationCollision) {
    return { ok: false, reason: 'blocked_exit' };
  }

  // Upstream's turn between the two faces (`getPointWRT`'s `aOut`), a left turn.
  const { rotateDelta } = transformed;

  player.x = outX;
  player.y = outY;
  player.z = outZ;
  player.azimuth = normalizeAngle(player.azimuth + rotateDelta);
  if (player.slideAzimuth !== undefined) {
    player.slideAzimuth = normalizeAngle(player.slideAzimuth + rotateDelta);
  }
  if (player.jumpAzimuth !== null && player.jumpAzimuth !== undefined) {
    player.jumpAzimuth = normalizeAngle(player.jumpAzimuth + rotateDelta);
  }
  if (Number.isFinite(player.airVelocityX) && Number.isFinite(player.airVelocityY)) {
    const rotatedAirVelocity = rotateXY(player.airVelocityX, player.airVelocityY, rotateDelta);
    player.airVelocityX = rotatedAirVelocity.x;
    player.airVelocityY = rotatedAirVelocity.y;
  }


  player.teleportReentryBlockTeleporterIndex = destinationTeleporterIndex;
  player.teleportReentryBlockDistance = Math.max(
    PLAYER_TELEPORT_REENTRY_BLOCK_DISTANCE,
    (getShotTeleporterDims(destinationObs).halfW * 2) + 0.25,
  );
  player.teleportReentryBlockUntil = now + PLAYER_TELEPORT_REENTRY_BLOCK_MIN_MS;
  player.teleportCooldownUntil = now + PLAYER_TELEPORT_COOLDOWN_MS;
  player.lastUpdate = now;
  player.lag.resetUpdateGap();

  return {
    ok: true,
    fromFaceId,
    toFaceId,
  };
}


// WorldWeapons::add (WorldWeapons.cxx:192). A weapon's first shot is
// `initdelay` after the world was built -- upstream's `sync`, taken once so
// every weapon on the map shares one clock and a map can stagger them, which is
// what `fountains.bzw` does with 10, 13.3 and 16.6.
let worldWeaponsArmedAt = 0;

function armWorldWeapons(now) {
  worldWeaponsArmedAt = now;
  for (const weapon of WORLD_WEAPONS) {
    weapon.nextFireAt = now + (weapon.initDelay * 1000);
    weapon.nextDelayIndex = 0;
  }
}

// WorldWeapons::fire (WorldWeapons.cxx:164). One shot per weapon per tick at
// most, then the clock is caught up -- upstream's own "eat any shots that have
// been missed", which stops a server that stalled from firing a burst to make up
// for it.
function fireWorldWeapons(now) {
  if (WORLD_WEAPONS.length === 0) return;
  if (worldWeaponsArmedAt === 0) armWorldWeapons(now);
  for (const weapon of WORLD_WEAPONS) {
    if (weapon.nextFireAt > now) continue;
    fireWorldWeaponShot(weapon, now);
    while (weapon.nextFireAt <= now) {
      weapon.nextFireAt += weapon.delays[weapon.nextDelayIndex] * 1000;
      weapon.nextDelayIndex = (weapon.nextDelayIndex + 1) % weapon.delays.length;
    }
  }
}

// WorldWeapons::fireShot (WorldWeapons.cxx:31). The shot is an ordinary
// projectile in every respect but its shooter: `shot.player` is `ServerPlayer`,
// so there is no tank to answer for it, no shot slot to take and no reload to
// wait for. Its team is upstream's `teamColor`, which `CustomWeapon` leaves at
// rogue -- and a rogue shot is everybody's enemy, which is what a world weapon
// should be.
function fireWorldWeaponShot(weapon, now) {
  const direction = getWorldWeaponDirection(weapon.rotation, weapon.tilt);
  // The shot's team, since there is no player to read one off: the map's own
  // `color`, or rogue.
  fireServerShot(weapon.type, { x: weapon.x, y: weapon.y, z: weapon.z }, direction,
    weapon.team || WORLD_WEAPON_TEAM, now);
}

// A shot by the server itself, `ServerPlayer` (253): a map's world weapon, or
// a plugin's bz_fireServerShot. `direction` need not be a unit vector, and may
// be none at all for a shot that does not travel -- a shockwave.
// `target` is a player a guided one steers at, as upstream's names one in
// the MsgGMUpdate it sends after the shot (WorldWeapons.cxx:96): the shot's
// own, since the server has no lock of its own to steer by.
function fireServerShot(type, origin, direction, team, now = Date.now(), target = null) {
  const id = (++projectileIdCounter).toString();
  const proj = new Projectile(
    id,
    WORLD_WEAPON_PLAYER_ID,
    -1,
    origin.x,
    origin.y,
    origin.z,
    direction.x,
    direction.y,
    direction.z,
    type,
    now
  );
  proj.team = team;
  proj.targetId = proj.guided && target !== null ? String(target) : null;
  proj.lifetimeSeconds = getWorldMissileLifetimeSeconds(
    proj.playerId, proj.guided, GAME_CONFIG.MAP_SIZE, proj.speed,
  ) ?? proj.lifetimeSeconds;
  projectiles.set(id, proj);
  // A beam's whole path is walked when it is fired, as it is for a tank's, and a
  // world weapon can be a `L` Laser -- `fountains.bzw` mounts two.
  const beamHit = proj.beam ? traceShotBeam(proj, proj.createdAt) : null;
  broadcastAll({
    type: 'shotBegin',
    id: proj.id,
    playerId: proj.playerId,
    shotSlot: proj.shotSlot,
    ...wireShot(proj),
    flag: proj.flag,
    ricochet: proj.ricochet,
    // FiringInfo's `shot.team`, which a world weapon's shot is drawn in.

    team: proj.team,
    // A map's world weapon locks onto nobody; a plugin's may name a target.
    target: proj.targetId,
    createdAt: proj.createdAt,
  });
  if (beamHit) applyShotPlayerHit(proj, id, beamHit.player, beamHit.point);
  return id;
}

// checkEnvironment's squish loop (playing.cxx:4198), which is the only rule in
// the game that runs off nothing but where two tanks are -- so it gets a sweep
// of its own rather than a hook on something that was already happening.
//
// Upstream runs this on each client, for that client's own tank, in the same
// else-chain that decides it was not already killed by a shot, by death touch or
// by water. bzo's server decides every kill and so runs the whole sweep here;
// the outcome is the same and it is not asked once per client. Kills stay
// server-side deliberately: a client that decided it had been run over would be
// a client that could decide it had not.
//
// O(rollers x players) once a tick, and rollers is almost always zero, so the
// first pass is what this costs on a normal map.
function applySteamrollerSweep(now) {
  // Burrow is the other half of upstream's condition: a burrowed tank is
  // crushed by *anybody*, so with one in the world every tank above ground is a
  // roller. That is what this first pass is for -- it asks the cheap question,
  // off the flags alone, and the usual answer is that there is nothing to
  // sweep at all.
  let anyRoller = false;
  let anyCrushable = false;
  players.forEach((player) => {
    if (!player.alive || player.paused || isObserverTeam(player.team)) return;
    const flag = getPlayerFlag(player.id)?.type ?? null;
    if (crushesOnContact(flag)) anyRoller = true;
    if (isCrushedByAnyone(flag)) anyCrushable = true;
  });
  if (!anyRoller && !anyCrushable) return;

  const rollers = [];
  players.forEach((player) => {
    if (!player.alive || player.paused || isObserverTeam(player.team)) return;
    const flag = getPlayerFlag(player.id)?.type ?? null;
    if (!crushesOnContact(flag) && !anyCrushable) return;
    rollers.push({
      player,
      flag,
      zoned: isPlayerZoned(player),
      at: player.getExtrapolatedPosition(now),
    });
  });
  if (rollers.length === 0) return;

  players.forEach((victim) => {
    // A paused tank cannot be hit by a shot in bzo, so it cannot be run over
    // either. Upstream only checks the roller's pause; the victim is the local
    // tank and its own pause is read further up the same chain.
    if (!victim.alive || victim.paused || isObserverTeam(victim.team)) return;
    const victimFlag = getPlayerFlag(victim.id)?.type ?? null;
    const victimAt = victim.getExtrapolatedPosition(now);

    for (const roller of rollers) {
      if (roller.player.id === victim.id) continue;
      // Squashing is a kill like any other, so friendly fire governs it: the
      // guard is upstream's own, in this very loop (playing.cxx:4212).
      if (NO_TEAM_KILLS
        && !areFoes(roller.player.team, victim.team, TEAMS_ALLOWED)) continue;

      // Steamroller crushes what it touches; anybody at all crushes a burrowed
      // tank. Both need the roller above ground, which is what stops two
      // burrowed tanks killing each other the instant they meet.
      if (!canRunOver(roller.flag, victimFlag, roller.at.z, roller.zoned)) continue;
      const radius = getRunOverRadius(victimFlag, roller.flag, TANK.radius);
      // Across, up, across: the middle term is the one weighed as height.
      const separation = getRunOverSeparation(
        victimAt.x - roller.at.x,
        victimAt.y - roller.at.y,
        victimAt.z - roller.at.z,
      );
      if (separation >= radius) continue;

      log(
        `Run over: "${roller.player.name}" flattened "${victim.name}"` +
        ` at ${formatShotPoint(victimAt.x, victimAt.y, victimAt.z)}` +
        ` (${separation.toFixed(2)} < ${radius.toFixed(2)})`
      );
      killPlayer(victim, roller.player, DEATH_REASON.RUN_OVER);
      // One tank dies once, however many rollers reached it in the same tick.
      break;
    }
  });
}

const SHOT_SIM_STEP_SECONDS = 1 / 60;
const SHOT_SIM_MAX_STEPS_PER_LOOP = 8;

function formatShotPoint(x, y, z) {
  return `(${Number(x).toFixed(2)},${Number(y).toFixed(2)},${Number(z).toFixed(2)})`;
}

function logShotEnd(projectile, cause, point, details = '') {
  const extra = details ? ` ${details}` : '';
  log(
    `[shotEnd] id=${projectile.id} player=${projectile.playerId} slot=${projectile.shotSlot}` +
    ` cause=${cause} at=${formatShotPoint(point.x, point.y, point.z)}` +
    ` origin=${formatShotPoint(projectile.originX, projectile.originY, projectile.originZ)}` +
    ` dir=(${projectile.dirX.toFixed(4)},${(projectile.dirY || 0).toFixed(4)},${projectile.dirZ.toFixed(4)})${extra}`
  );
}

// The aim point a guided missile steers at. Upstream aims at the target's own
// `getMuzzleHeight()` -- "right between the eyes" (GuidedMissleStrategy.cxx:180)
// -- but a bzo tank has as many muzzle heights as it has models, and no client
// could agree with the server about which one. The mid-height of the cylinder
// the server hits with is a number every end already shares, and it is the point
// most of the tank is nearest to.
function getLockAimPoint(position) {
  return { x: position.x, y: position.y, z: position.z + (TANK.hitHeight / 2) };

}

// setTarget()'s eligibility (playing.cxx:4415). A missile may be locked onto a
// tank that is alive, unpaused and not stealthed -- and upstream refuses Stealth
// outright, with no `SE` exemption, because where a missile may fly is not a
// matter of what somebody can see.
//
// The rule is asked wherever the lock is *read* rather than only where it is
// set, so a target that dies, pauses or picks up `ST` stops being followed with
// no packet at all: every end applies the same rule to the same target id.
function canLockOnto(player) {
  if (!player || !player.joined) return false;
  if (isObserverTeam(player.team)) return false;
  if (!player.alive || player.paused) return false;
  // Not a lock target while it is not responding (playing.cxx:4426).
  if (player.notResponding) return false;
  // `ST` is one flag doing both jobs upstream: off the radar, and out of reach
  // of a lock.
  if (hidesFromRadar(getPlayerFlag(player.id)?.type ?? null)) return false;
  return true;
}

// Whichever tank this player's missiles are steering at, or null. A lock is only
// live while there is a missile for it to steer, which is the same test that
// allows one to be taken.
// A server shot's own target, under the rule a player's lock is held to.
function getServerShotTarget(proj) {
  const target = proj.targetId === null ? null : players.get(proj.targetId);
  return canLockOnto(target) ? target : null;
}

function getLockTarget(shooterId) {
  const shooter = players.get(shooterId);
  if (!shooter?.lockTargetId || !canLockOn(shooter)) return null;
  const target = players.get(shooter.lockTargetId);
  return canLockOnto(target) ? target : null;
}

// A lock lapses when there is nothing left for it to steer -- `GM` gone from the
// hand and the last missile out of the air -- or when its target stops being
// lockable, which upstream makes permanent rather than momentary
// (GuidedMissleStrategy.cxx:165 sets `lastTarget = NoPlayer`).
//
// Upstream never clears a target on a flag change at all: nothing in
// `LocalPlayer` does it, so its lock-on marker outlives the flag that earned it.
// bzo lets it go, because a bracket over a tank you have no way to shoot at is
// saying something that is no longer true.
function expireLockTargets() {
  players.forEach((player) => {
    if (player.lockTargetId === null) return;
    if (canLockOn(player) && canLockOnto(players.get(player.lockTargetId))) return;
    setLockTarget(player, null);
  });
}

// Every end steers a missile, so every end is told who it is steering at.
function setLockTarget(player, targetId) {
  const next = targetId ?? null;
  if (player.lockTargetId === next) return;
  player.lockTargetId = next;
  const target = next === null ? null : players.get(next);
  log(next === null
    ? `"${player.name}" lost the lock`
    : `"${player.name}" locked on "${target?.name ?? next}"`);
  broadcastAll({ type: 'gmUpdate', playerId: player.id, targetId: next });
}

// tankHasShotType() (playing.cxx:4376). Who may lock: the flag in hand, or a
// missile still in the air after the flag was dropped -- which is the second
// half of "can lock on or retarget after firing".
function canLockOn(player) {
  if (getPlayerFlag(player.id)?.type === 'GM') return true;
  for (const proj of projectiles.values()) {
    if (proj.guided && proj.playerId === player.id) return true;
  }
  return false;
}

// setTarget() (playing.cxx:4390). Upstream runs this on the shooter's own
// client; bzo runs it here, because a lock steers a real missile and a modified
// client must not be able to claim one it never earned. Nothing is lost by
// moving it: upstream's scan reads `myTank->getAngle()`, the tank's own heading
// rather than the camera's, and the server already knows that exactly.
//
// Two cones, one press. The tighter `_lockOnAngle` is a lock, and only for a
// player with a missile to steer; the wider `_targetingAngle` only names the
// tank, which is what identify does for everybody else. Upstream walks both in
// one loop and lets a nearer tank outside the lock cone shut out a further one
// inside it, purely because of the order the roster happens to be in; bzo asks
// the two questions separately, so the answer does not depend on that.
function setPlayerTarget(player) {
  const now = Date.now();
  const at = player.getExtrapolatedPosition(now);
  const eye = { x: at.x, y: at.y };
  const forward = { x: Math.cos(at.azimuth), y: Math.sin(at.azimuth) };
  const viewerFlag = getPlayerFlag(player.id)?.type ?? null;
  const seer = seesThroughDisguises(viewerFlag);

  const lockable = [];
  const visible = [];
  players.forEach((other) => {
    if (other.id === player.id || !other.joined) return;
    if (isObserverTeam(other.team) || !other.alive) return;
    // Not a tank this one can see at all, on the radar or out of the window
    // (`canSeeTank`): upstream's scan never asks, so a jammed tank names a
    // cloaked one it has no way to know is there.
    if (!canSeeTank(viewerFlag, getPlayerFlag(other.id)?.type ?? null)) return;
    const position = other.getExtrapolatedPosition(now);
    const candidate = { id: other.id, x: position.x, y: position.y };

    if (canLockOnto(other)) lockable.push(candidate);
    // The look refuses a stealthed tank too, but a seer sees through that one
    // (playing.cxx:4436) where a missile never does.
    if (seer || !hidesFromRadar(getPlayerFlag(other.id)?.type ?? null)) visible.push(candidate);
  });

  const locked = canLockOn(player)
    ? pickTargetInSights(eye, forward, lockable, getFlagTuning().lockOnAngle)
    : null;
  setLockTarget(player, locked);
  const targetId = locked ?? pickTargetInSights(eye, forward, visible, TARGETING_ANGLE);
  sendToPlayer(player, { type: 'identifyResult', targetId, locked: locked !== null });
}

// FiringInfo::shot.team, which upstream sets from the shooter at fire time and
// then admits it never reads ("FIXME team coloring of shot is never used").
// bzo asks the shooter instead, which differs only if somebody changed team
// mid-flight -- and a shot that turned friendly in the air would be the stranger
// of the two answers.
function getShotTeam(proj) {
  // A world weapon's shot carries its own: there is no player to ask.
  if (proj.team) return proj.team;
  return players.get(proj.playerId)?.team ?? null;
}

// The nearest tank a shot's segment reaches, with the point it reaches it at, or
// null. A shot is spent by the first tank it meets, so the sweep keeps the
// nearest rather than the last one it looked at; upstream never has this to
// decide, because each client tests only its own tank and one shot is one hit by
// construction.
function findShotPlayerHit(proj, from, to, now) {
  if (!shotIsActive(proj, now)) return null;

  // The shot as the rule sees it: everything about who fired it and what it
  // carries, with the team already resolved, because a world weapon has no
  // roster entry to take one from.
  const shot = {
    playerId: proj.playerId,
    flag: proj.flag,
    steals: proj.steals,
    bounces: proj.bounces,
    team: getShotTeam(proj),
  };
  const rules = {
    noTeamKills: NO_TEAM_KILLS,
    teamsAllowed: TEAMS_ALLOWED,
    shotRadius: GAME_CONFIG.SHOT_RADIUS,
  };

  let best = null;
  players.forEach((player) => {
    const hit = getShotTankHit(shot, from, to, {
      id: player.id,
      team: player.team,
      paused: player.paused,
      alive: player.alive,
      // Extrapolated, so the hit is tested where the tank is rather than where
      // its last update put it.
      position: player.getExtrapolatedPosition(now),
      flagType: getPlayerFlag(player.id)?.type ?? null,
      zoned: isPlayerZoned(player),
    }, rules);
    if (!hit) return;
    if (best && best.fraction <= hit.fraction) return;
    best = { player, fraction: hit.fraction, point: hit.point };
  });
  return best;
}

// Upstream's BlowedUpReason, as far as bzo has reasons: what the client is told
// killed a tank, so it can pick the sound and the notice. `captured` travels on
// its own field and predates this.
const DEATH_REASON = Object.freeze({
  SHOT: 'shot',           // GotShot
  RUN_OVER: 'runOver',    // GotRunOver
  GENOCIDE: 'genocide',   // GenocideEffect
  SELF_DESTRUCT: 'selfDestruct', // SelfDestruct
  GAME_OVER: 'gameOver', // playing.cxx:2212 -- the match clock reached zero.
  // A `death` physics driver -- no killer, and its own mapper-authored
  // message rather than a `deathPrefix`-templated one (client.js), the same
  // "whole phrase" treatment a world weapon's kill already gets.
  PHYSICS_DRIVER: 'physicsDriver',
  // `waterLevel` -- no killer, and a fixed message rather than a mapper's own:
  // "Tank Rusted" is upstream's own local-player alert for this
  // (`blowedUpMessage[WaterDeath]`, `playing.cxx:186-195`), kept verbatim
  // rather than smoothed into something that reads more like a cause, because
  // it already is upstream's joke about why the tank blew up.
  WATER: 'water',
});

// playerKilled() (bzfs.cxx:3345). One tank dies, for one reason, and everything
// that follows from it: the score, the flag it was carrying, the message, and
// the respawn. Every way to die in bzo but a capture comes through here -- a
// capture kills a whole team at once and scores nobody, which is a different
// rule rather than a repeat of this one.
// `shooterId` is for a killer that is not a player: a world weapon's shot
// carries `ServerPlayer`, which has no roster entry to take an id from, and the
// client needs the id to say what killed you.
// What a death *does*, as against what it costs: the tank stops, its lock goes
// with it, its flag goes, the rabbit is re-anointed if the rabbit is what died,
// the clients are told and the respawn is queued.
//
// The kills every client is told of, for the last `BOT_KILL_FEED_SECONDS`:
// who, whom, and with what flag in hand -- what a player reads off the kill
// messages, and what a bot's pilot weighs a camper by. A capture is not a kill.
const BOT_KILL_FEED_SECONDS = 300;
const botKillFeed = [];
function noteBotKill(victimId, killerId, hit) {
  if (hit.captured || killerId === WORLD_WEAPON_PLAYER_ID) return;
  const at = Date.now() / 1000;
  botKillFeed.push({ killerId, victimId, flag: hit.shooterFlag ?? null, at });
  while (botKillFeed.length && botKillFeed[0].at < at - BOT_KILL_FEED_SECONDS) botKillFeed.shift();
}

// Every death in bzo runs this and nothing runs a copy of it -- a shot and a
// self-destruct both call it, so the lock clearing, the flag drop, the rabbit
// reassignment and the respawn queue can never drift out of step between the
// two.
//
// `killerId` is who the clients are told did it, which is not always a player:
// a world weapon's shot carries `ServerPlayer`, and a capture carries whoever
// capped. `hit` is what killed the tank -- the one part that really does differ
// between a shot, a suicide and a capture -- spread over the message.
//
// What a death *costs* stays with the caller, because that is what differs:
// killPlayer scores it, and a capture deliberately scores nobody a death, "the
// team loss is the whole penalty".
function applyDeath(victim, killerId, hit) {
  victim.alive = false;
  noteBotKill(victim.id, killerId, hit);
  const heldFlag = getPlayerFlag(victim.id);
  // playing.cxx:3827. A dead tank has nothing locked, so the marker goes with
  // it and a respawn starts clean. Missiles already in the air fly straight from
  // here, which is what upstream's `setTarget(NULL)` does to them too.
  setLockTarget(victim, null);

  dropPlayerFlag(victim.id);

  broadcastAll({
    type: 'killed',
    victimId: victim.id,
    shooterId: killerId,
    projectileId: null,
    ...hit,
  });

  // bzfs.cxx:3537. Killing the rabbit is what deposes it, and under
  // `-rabbit killer` whoever did the killing takes it if they still can. Every
  // way to depose a rabbit by killing it arrives here, which is the point.
  // After MsgKilled, as upstream sends them, so every client scores the kill
  // with the victim still the rabbit (`getKillScoreDeltas`).
  if (RABBIT_SELECTION && victim.id === rabbitPlayerId) anointNewRabbit(killerId);

  pluginEvent('bz_ePlayerDieEvent', () => {
    const killer = players.get(String(killerId));
    return {
      playerID: Number(victim.id),
      team: bzTeam(victim.team),
      killerID: Number(killerId),
      killerTeam: killer ? bzTeam(killer.team) : -1,
      flagKilledWith: hit?.shooterFlag ?? '',
      shotID: Number.isInteger(hit?.projectileId) ? hit.projectileId : -1,
      driverID: hit?.phydrv ?? -1,
      state: pluginState(victim),
      flagHeldWhenKilled: heldFlag ? heldFlag.index : -1,
    };
  });

  setTimeout(() => {
    if (!players.has(victim.id)) return;
    // cleanupGameOver()'s hold: a tank that died into game over stays dead
    // until the next /countdown, which is what "the server refuses the spawn
    // while the game is over" (docs/game-modes-plan.md, "Match end") means for
    // a death already in flight when the clock hit zero.
    if (matchClock.gameOver) return;
    // Gone to observer, or back in through a join, since it died.
    if (isObserverTeam(victim.team) || victim.alive) return;
    bringBack(victim);
  }, GAME_CONFIG.RESPAWN_DELAY);
}

function addScore(player, delta) {
  player.wins += delta.wins;
  player.losses += delta.losses;
  player.tks += delta.tks;
}

function killPlayer(victim, killer, reason, projectileId = null, shooterId = null, physicsDriver = null) {
  // "victim was already dead. keep score." Upstream's own guard, and bzo needs
  // it for the same reason plus one of its own: genocide kills a team in a loop,
  // and a team killer who dies for the first of them must not die again for the
  // rest.
  if (!victim.alive) return;

  // areFoes(): a kill across teams, a rogue killing anyone, or any kill at all
  // on a world without teams. Everything else is a team kill.
  //
  // isARabbitKill (bzfs.cxx:3421) is Rabbit Chase's one exception. Hunters share
  // a team, so hunter-on-hunter fire *is* team killing -- except that shooting
  // the rabbit never is, and neither is anything a deposed rabbit does before its
  // next spawn. Decided before `applyDeath` below, because the anointing in
  // there is what stops the victim being the rabbit; upstream's order too.
  //
  // The tally itself is `getKillScoreDeltas`, which every browser runs on the
  // same `killed` to keep its own scoreboard. A team kill scores the killer a
  // death and a team kill, so it never counts towards shaking a bad flag.
  const deltas = getKillScoreDeltas({
    killerId: killer?.id ?? null,
    victimId: victim.id,
    killerTeam: killer?.team ?? null,
    victimTeam: victim.team,
    teamsAllowed: TEAMS_ALLOWED,
    killerWasRabbit: Boolean(killer?.wasRabbit),
  });
  const { teamKill } = deltas;
  addScore(victim, deltas.victim);
  if (deltas.killer) {
    addScore(killer, deltas.killer);
    if (!teamKill) {
      recordShakeWin(killer);
      // Score::reached() (Score.cxx:108), asked of the killer after every
      // ordinary kill -- not a team kill or a suicide, neither of which raises
      // anyone's score.
      checkPlayerScoreLimit(killer);
    }
  }
  // Killing yourself is a loss and nothing else, as self-destruct is.
  // getTeamScoreDeltasForKill already reads the two being the same player.
  recordTeamScoreForKill(killer, victim);

  // MsgKilled packs the flag (`buf = flagType->pack(buf)`, bzfs.cxx:3432) and
  // gotBlowedUp names it from the packet rather than from the world. It has to:
  // `applyDeath` drops the victim's flag before it broadcasts, so a client
  // composing "You killed X/ID" from live state would never see one. Read here,
  // while both tanks still hold what they held when it happened.
  //
  // Neither reveals anything: a flag on a tank has its type in every flag update
  // already (`getFlagState`), and it is only a flag lying unowned on the ground
  // that bzo hides.
  const killerId = killer ? killer.id : shooterId;
  applyDeath(victim, killerId, {
    projectileId,
    reason,
    // A death-touch's own message, and upstream's index for its driver, which
    // MsgKilled carries (`phydrv`).
    deathMessage: physicsDriver?.death ?? null,
    phydrv: Number.isInteger(physicsDriver?.index) ? physicsDriver.index : null,
    victimFlag: getPlayerFlag(victim.id)?.type ?? null,
    shooterFlag: killer ? (getPlayerFlag(killer.id)?.type ?? null) : null,
    // The client words its death notice from this, and derives the same thing
    // from the ids as a fallback (`victimId === shooterId`). Read off the
    // shooter of record rather than off `selfKill`, which is also true of a
    // world weapon's kill -- that has nobody to score and is nobody's suicide.
    suicide: killerId === victim.id,
  });

  // "-tk: player does not die when killing a teammate" -- so without it, they
  // do. Upstream kills the killer with the same reason the victim took
  // (`playerKilled(killerIndex, killerIndex, reason, ...)`), by their own hand
  // and for no score. The guard at the top of this function is what stops a
  // genocide that wiped the killer's own team killing them once per victim.
  if (teamKill && TEAM_KILLER_DIES) {
    log(`Team kill: "${killer.name}" killed "${victim.name}" and dies for it`);
    killPlayer(killer, killer, reason);
  } else if (teamKill) {
    log(`Team kill: "${killer.name}" killed "${victim.name}"`);
  }
}

// gotBlowedUp() for one tank a shot reached, and nothing about the shot's own
// fate -- an ordinary shell is spent by the tank it hits and a shock wave is
// spent by nobody, so the caller decides that. Returns what became of the tank.
function applyShotVictim(proj, id, player) {
  // A thief's shot is answered before anything that could kill: upstream tests
  // `killerFlag == Flags::Thief` ahead of `gotBlowedUp` (playing.cxx:4174), so a
  // shielded tank loses its Shield to the thief rather than being saved by it.
  if (proj.steals) return stealFlag(proj, player) || 'missed';

  // gotBlowedUp() with the shield flag: the tank keeps its life and the flag is
  // thrown as if the player had dropped it -- which is where _shieldFlight sends
  // it up extra high. Nobody scores, because nobody died.
  const carried = getPlayerFlag(player.id);
  if (carried && shieldsAgainstShot(carried.type)) {
    dropPlayerFlag(player.id);
    return 'shield';
  }

  killPlayer(player, players.get(proj.playerId), DEATH_REASON.SHOT, id, proj.playerId);

  // playing.cxx:2655. Genocide is decided off the *shot*, so it is asked here
  // rather than anywhere a tank happens to die: killing one tank kills its whole
  // team. Upstream asks it on every client, because each client reports its own
  // death; bzo asks it once, on the server that decided the kill.
  applyGenocide(proj, player);
  return 'killed';
}

// "blow up if killer has genocide flag and i'm on same team as victim (and we're
// not rogues)". Everyone left on the dead tank's team goes with it.
//
// Only on a world with teams -- "geno only works in team games :)" -- and never
// for rogue, whose players share a name rather than a side. The shooter's own
// team is not consulted: a Genocide shot that killed a team mate takes the rest
// of the shooter's team too, which is upstream's rule and reads as fair warning.
function applyGenocide(proj, victim) {
  if (!killsWholeTeam(proj.flag)) return;
  if (!TEAM_MODE.enabled) return;
  if (!isColorTeam(victim.team)) return;

  const killer = players.get(proj.playerId);
  players.forEach((other) => {
    if (other.id === victim.id) return;
    if (other.team !== victim.team) return;
    if (!other.alive) return;
    log(`Genocide: "${other.name}" goes with "${victim.name}" (${victim.team})`);
    killPlayer(other, killer, DEATH_REASON.GENOCIDE);
  });
}

// MsgTransferFlag (bzfs.cxx:5099), with the client's half of it folded in. A
// thief's beam takes the flag the victim is carrying and the victim keeps its
// life: upstream has the tank that was hit send the transfer and bzfs check that
// the tank being transferred *to* is really carrying Thief, which is a check bzo
// does not need -- the shot already carries the flag it was fired with, and the
// server is what decided it hit.
//
// Any flag can be stolen, a team flag included, and a theft spends the Thief
// flag itself: upstream zaps whatever the thief is holding before it hands the
// stolen flag over, and what the thief is holding is Thief.
// bz_FlagTransferredEventData_V1::Action.
const FLAG_TRANSFER = Object.freeze({ CONTINUE_STEAL: 0, CANCEL_STEAL: 1, DROP_THIEF: 2 });

// Returns what became of it -- 'stolen', or a plugin's 'cancelled' or
// 'dropped' -- or false when the victim had nothing to steal.
function stealFlag(proj, victim) {
  const thief = players.get(proj.playerId);
  const stolen = getPlayerFlag(victim.id);
  if (!thief || !stolen) return false;

  // bz_eFlagTransferredEvent (bzfs.cxx:5162): a plugin may let the steal go
  // on, cancel it, or spend the thief's flag without handing anything over.
  const transfer = pluginEvent('bz_eFlagTransferredEvent', () => ({
    fromPlayerID: Number(victim.id), toPlayerID: Number(thief.id), flagType: stolen.type,
    action: FLAG_TRANSFER.CONTINUE_STEAL,
  }));
  const action = transfer?.action ?? FLAG_TRANSFER.CONTINUE_STEAL;
  const held = getPlayerFlag(thief.id);
  if (held && action !== FLAG_TRANSFER.CANCEL_STEAL) zapFlag(held);
  if (action === FLAG_TRANSFER.CANCEL_STEAL) return 'cancelled';
  if (action === FLAG_TRANSFER.DROP_THIEF) return 'dropped';
  // The victim gives up everything the flag armed as well as the flag, which is
  // what `sendFlagDrop` does for every other way of losing one.
  clearFlagShedState(victim);
  stolen.owner = thief.id;
  stolen.status = FLAG_STATUS.ON_TANK;
  stolen.flightStartedAt = 0;
  stolen.grabbedAt = Date.now();
  // MsgTransferFlag hands over the flag as it is (bzfs.cxx:5177): a stolen
  // flag keeps the shots already fired from it.
  armBadFlagRelease(thief, stolen);
  log(`"${thief.name}" stole ${getFlagType(stolen.type).name} flag ${stolen.index} from "${victim.name}"`);
  broadcastAll({
    type: 'transferFlag',
    fromId: victim.id,
    toId: thief.id,
    flag: getFlagState(stolen),
  });
  sendShotsLeft(thief, stolen);
  return 'stolen';
}

// The tank a travelling shot reached. One hit and the shot is gone, whichever
// way the tank took it.
function applyShotPlayerHit(proj, id, player, point) {
  projectiles.delete(id);
  const outcome = applyShotVictim(proj, id, player);
  logShotEnd(proj, SHOT_END_LABEL[outcome], point, `victim=${player.id}`);
  // `Player::endShot(id, false, false)` -- upstream ends a thief's shot on the
  // tank it robbed with neither a hit nor an explosion, because nothing blew up.
  // Reason 1 is bzo's "faded", and it is what a theft looks like.
  const quiet = ['stolen', 'cancelled', 'dropped', 'missed'].includes(outcome);
  broadcastAll({ type: 'shotEnd', id, reason: quiet ? 1 : 0, x: point.x, y: point.y, z: point.z });
}

// What became of the tank, as the shot log says it.
const SHOT_END_LABEL = Object.freeze({
  killed: 'player_hit',
  shield: 'shield_hit',
  stolen: 'flag_stolen',
  cancelled: 'steal_cancelled',
  dropped: 'thief_dropped',
  missed: 'nothing_to_steal',
});

// ShockWaveStrategy::checkHit: "a shock wave can kill anything inside the
// radius, be it behind or in a building or even zoned". A plain sphere from the
// tank that fired it to the tank it reaches, and the one hit test in the game
// that asks nothing at all about the geometry in between -- no obstacle trace,
// no height gate, no tank radius. Upstream measures to the tank's own position
// and so does this, so a tank on a roof is as far away as the roof is high.
//
// Every tank inside is resolved, not just the nearest: the wave is not stopped
// by a hit. Each one is resolved once, and the wave carries the list -- see
// `shockWaveResolved` on the projectile.
function applyShockWaveHits(proj, id, radius, now) {
  const shot = {
    playerId: proj.playerId,
    team: getShotTeam(proj),
    x: proj.x,
    y: proj.y,
    z: proj.z,
    radius,
  };
  const rules = { noTeamKills: NO_TEAM_KILLS, teamsAllowed: TEAMS_ALLOWED };
  players.forEach((player) => {
    // A wave does not stop at a tank, so it would otherwise sweep the same one
    // again on every tick it is still swelling. This is the only guard the
    // shared rule does not carry: it is about this wave's history, not about
    // whether a wave may hit a tank.
    if (proj.shockWaveResolved.has(player.id)) return;

    const at = player.getExtrapolatedPosition(now);
    if (!shockWaveHitsTank(shot, {
      id: player.id,
      team: player.team,
      paused: player.paused,
      alive: player.alive,
      position: at,
    }, rules)) return;

    proj.shockWaveResolved.add(player.id);
    const point = { x: at.x, y: at.y, z: at.z };
    const outcome = applyShotVictim(proj, id, player);
    log(
      `[shockWave] id=${proj.id} player=${proj.playerId} ${outcome} victim=${player.id}` +
      ` at=${formatShotPoint(point.x, point.y, point.z)} radius=${radius.toFixed(2)}`
    );
  });
}


// A beam's whole path, walked when the trigger is pulled (`traceBeam` in the
// shared `trace` module, which a browser draws an unhanded beam by too), with the
// tanks it can reach as this server decides them. The segments go onto the
// projectile for the client to draw; the tank it reached comes back for the
// caller to resolve once `shotBegin` has gone out -- the client has to have the
// shot before it is told the shot killed somebody.
function traceShotBeam(proj, now) {
  const traced = traceBeam(
    { colliders: getCollisionColliders(), teleports: TELEPORTER_INDEX, mapSize: GAME_CONFIG.MAP_SIZE },
    { x: proj.x, y: proj.y, z: proj.z },
    { x: proj.dirX, y: proj.dirY || 0, z: proj.dirZ },
    proj.speed * proj.lifetimeSeconds,
    {
      ricochet: proj.ricochet,
      throughBuildings: proj.throughBuildings,
      findHit: (from, to) => findShotPlayerHit(proj, from, to, now),
      onTeleport: ({ sourceFaceId, destFaceId }) => log(
        `[SHOT_TP] id=${proj.id} beam srcFace=${sourceFaceId} dstFace=${destFaceId}`),
    },
  );
  proj.segments = traced.segments;
  proj.endReason = traced.endReason;
  proj.bounces += traced.bounces;
  return traced.hit;
}

function simulateProjectilesStep(stepSeconds, now) {
  const obstacles = getCollisionColliders();

  projectiles.forEach((proj, id) => {
    const deltaTime = (now - proj.createdAt) / 1000;

    // A shock wave never leaves the tank that fired it; what travels is its
    // radius. It kills everything it swells past over its whole life and then
    // fades at full size, which is `setExpired()` rather than an impact -- so it
    // ends on reason 1 and the client neither sparks nor booms.
    if (proj.shockwave) {
      const radius = getShockWaveRadius(deltaTime, proj.lifetimeSeconds);
      applyShockWaveHits(proj, id, radius, now);
      if (deltaTime >= proj.lifetimeSeconds) {
        const at = { x: proj.x, y: proj.y, z: proj.z };
        projectiles.delete(id);
        broadcastAll({ type: 'shotEnd', id, reason: 1, x: at.x, y: at.y, z: at.z });
        logShotEnd(proj, 'shockwave_faded', at,
          `lifetime=${deltaTime.toFixed(3)}/${proj.lifetimeSeconds.toFixed(3)}`);
      }
      return;
    }

    // A beam has no travel and its hits were resolved when it was fired, so all
    // that is left of it is the clock its slot runs on. It ends where it ended,
    // which is where the impact is drawn.
    if (proj.beam) {
      if (deltaTime > proj.lifetimeSeconds) {
        const end = proj.segments[proj.segments.length - 1]?.to
          ?? { x: proj.x, y: proj.y, z: proj.z };
        // A beam that ran out of range or left the world struck nothing, so it
        // fades rather than sparking, which is what reason 1 says.
        const spent = proj.endReason === 'range' || proj.endReason === 'out_of_bounds';
        projectiles.delete(id);
        broadcastAll({ type: 'shotEnd', id, reason: spent ? 1 : 0, x: end.x, y: end.y, z: end.z });
        logShotEnd(proj, `beam_${proj.endReason}`, end,
          `lifetime=${deltaTime.toFixed(3)}/${proj.lifetimeSeconds.toFixed(3)}`);
      }
      return;
    }

    // GuidedMissileStrategy::update turns the missile before it moves it, so the
    // step is taken along the heading the missile has just chosen. A shooter with
    // nothing locked -- or with a target that has died, paused or taken `ST` --
    // leaves the missile flying straight.
    if (proj.guided) {
      const target = proj.playerId === WORLD_WEAPON_PLAYER_ID
        ? getServerShotTarget(proj)
        : getLockTarget(proj.playerId);
      const steered = steerGuidedShot(
        { x: proj.dirX, y: proj.dirY || 0, z: proj.dirZ },
        { x: proj.x, y: proj.y, z: proj.z },
        target ? getLockAimPoint(target.getExtrapolatedPosition(now)) : null,
        getShotEffects('GM').turnAngle,
        stepSeconds,
      );
      proj.dirX = steered.x;
      proj.dirY = steered.y;
      proj.dirZ = steered.z;
    }

    // A shot variant's velocity is on the projectile, so a Rapid Fire shell and
    // an ordinary one advance by different amounts in the same step.
    const stepDistance = proj.speed * stepSeconds;
    const prevX = proj.x;
    const prevY = proj.y;
    const prevZ = proj.z;
    const traced = traceShotThroughTeleporters(
      TELEPORTER_INDEX,
      { x: prevX, y: prevY, z: prevZ },
      { x: proj.dirX, y: proj.dirY || 0, z: proj.dirZ },
      stepDistance,
      proj.teleportReentryBlockTeleporterIndex,
      proj.teleportReentryBlockDistance,
      ({ sourceFaceId, destFaceId, source, dest }) => log(`[SHOT_TP] id=${id} srcFace=${sourceFaceId}`
        + ` dstFace=${destFaceId} src=${source.linkName || source.name} dst=${dest.linkName || dest.name}`),
    );
    proj.dirX = traced.direction.x;
    proj.dirY = traced.direction.y;
    proj.dirZ = traced.direction.z;
    proj.teleportReentryBlockTeleporterIndex = traced.reentryBlockTeleporterIndex;
    proj.teleportReentryBlockDistance = traced.reentryBlockDistance;

    // ShotStrategy::getFirstBuilding treats a teleporter frame as an ordinary
    // building hit (Teleporter::isTeleported already ruled out the link), so
    // a ricocheting shot bounces off it the same as any wall -- only a shot
    // that does not ricochet stops here (issue #110).
    let frameBounceStart = null;
    if (traced.frameHit && !proj.throughBuildings) {
      const impact = traced.point;
      if (proj.ricochet) {
        const normal = getShotObstacleNormal(traced.frameHitObstacle, impact.x, impact.y, impact.z, SHOT_COLLISION_RADIUS);
        const reflected = reflectShotDirection(proj.dirX, proj.dirY, proj.dirZ, normal);
        proj.dirX = reflected.x;
        proj.dirY = reflected.y;
        proj.dirZ = reflected.z;
        proj.bounces++;
        frameBounceStart = {
          x: impact.x + (normal.x * SHOT_BOUNCE_CLEARANCE),
          y: impact.y + (normal.y * SHOT_BOUNCE_CLEARANCE),
          z: impact.z + (normal.z * SHOT_BOUNCE_CLEARANCE),
        };
      } else {
        const hitName = traced.frameHitObstacle?.name || 'teleporter frame';
        log(`Projectile ${id} hit obstacle "${hitName}" at (${impact.x.toFixed(2)}, ${impact.y.toFixed(2)}, ${impact.z.toFixed(2)})`);
        logShotEnd(proj, 'frame_hit', impact, `obstacle=${hitName}`);
        projectiles.delete(id);
        broadcastAll({ type: 'shotEnd', id, reason: 0, x: impact.x, y: impact.y, z: impact.z });
        return;
      }
    }

    // The teleporter trace says where the step ends, not what the shot met on
    // the way, and a step that crossed a portal ends on the far side of it. The
    // segment to test is therefore measured back from that endpoint along the
    // direction the shot is now travelling, which for a step with no teleport in
    // it is exactly where the shot already was. A frame bounce already has its
    // own start, clear of the surface it just reflected off.
    const stepStart = frameBounceStart || (traced.teleports > 0
      ? {
        x: traced.point.x - (proj.dirX * stepDistance),
        y: traced.point.y - (proj.dirY * stepDistance),
        z: traced.point.z - (proj.dirZ * stepDistance),
      }
      : { x: prevX, y: prevY, z: prevZ });

    const step = traceShotStep({
      // Upstream's `Through`: a super bullet is traced against nothing, so no
      // building is ever the first thing it reaches. The ground still stops it,
      // which is why the world's floor is not in this list to begin with.
      obstacles: proj.throughBuildings ? [] : obstacles,
      x: stepStart.x,
      y: stepStart.y,
      z: stepStart.z,
      dirX: proj.dirX,
      dirY: proj.dirY,
      dirZ: proj.dirZ,
      distance: frameBounceStart ? traced.frameHitRemaining : stepDistance,
      radius: SHOT_COLLISION_RADIUS,
      ricochet: proj.ricochet,
      justTeleported: frameBounceStart ? false : traced.teleports > 0,
    });
    proj.x = step.x;
    proj.y = step.y;
    proj.z = step.z;
    proj.dirX = step.dirX;
    proj.dirY = step.dirY;
    proj.dirZ = step.dirZ;
    proj.bounces += step.bounces;

    // Lifetime is time-based and does not shrink from teleports or bounces
    // based on straight-line displacement from spawn, which is BZFlag's rule.
    if (deltaTime > proj.lifetimeSeconds) {
      projectiles.delete(id);
      const removalPoint = { x: proj.x, y: proj.y, z: proj.z };
      broadcastAll({ type: 'shotEnd', id, reason: 1, x: removalPoint.x, y: removalPoint.y, z: removalPoint.z });
      logShotEnd(proj, 'timeout', removalPoint, `lifetime=${deltaTime.toFixed(3)}/${proj.lifetimeSeconds.toFixed(3)}`);
      log(`Projectile ${id} removed (expired)`);
      return;
    }

    // Check collision with players along the step the shot just took rather
    // than at the point it finished on. A Rapid Fire shell covers 2.5 units in a
    // step against a tank 4 units across, so a point sample can step past the
    // edge of one; upstream never can, because it tests the frame's whole ray.
    // The step has already been cut short at whatever it ran into, so this asks
    // the question in upstream's order: a tank standing in front of a wall is
    // reached before the wall is.
    //
    // A step that bounced is sampled at its end instead. The straight line from
    // where such a step started to where it finished cuts the corner, and a tank
    // the far side of the wall the shot bounced off did not just get hit.
    const hitFrom = step.bounces > 0 ? { x: proj.x, y: proj.y, z: proj.z } : stepStart;
    const hit = findShotPlayerHit(proj, hitFrom, { x: proj.x, y: proj.y, z: proj.z }, now);
    if (hit) {
      applyShotPlayerHit(proj, id, hit.player, hit.point);
      return;
    }

    if (step.obstacle) {
      const impact = { x: proj.x, y: proj.y, z: proj.z };
      if (step.obstacle.collisionKind === 'boundary') {
        log(`Projectile ${id} hit boundary at (${impact.x.toFixed(2)}, ${impact.y.toFixed(2)}, ${impact.z.toFixed(2)})`);
      } else {
        log(`Projectile ${id} hit obstacle "${step.obstacle.name || 'unnamed'}" at (${impact.x.toFixed(2)}, ${impact.y.toFixed(2)}, ${impact.z.toFixed(2)})`);
      }
      logShotEnd(proj, 'obstacle', impact, `obstacle=${step.obstacle.name || step.obstacle.collisionKind || 'unknown'}`);
      projectiles.delete(id);
      broadcastAll({ type: 'shotEnd', id, reason: 0, x: impact.x, y: impact.y, z: impact.z });
      return;
    }

    if (step.ground) {
      const impact = { x: proj.x, y: proj.y, z: proj.z };
      logShotEnd(proj, 'ground', impact);
      projectiles.delete(id);
      broadcastAll({ type: 'shotEnd', id, reason: 0, x: impact.x, y: impact.y, z: impact.z });
      return;
    }

    // The world border is an obstacle, so a ricocheting shot bounces off it and
    // never reaches this. A shot that does not bounce meets it first as a
    // boundary collider a shot radius short of the edge, and only leaves the
    // world outright on a step that skipped past that.
    const halfMap = GAME_CONFIG.MAP_SIZE / 2;
    if (Math.abs(proj.x) > halfMap || Math.abs(proj.y) > halfMap) {
      projectiles.delete(id);
      const removalPoint = findMapEdgeImpactPoint(
        stepStart.x, stepStart.y, stepStart.z, proj.x, proj.y, proj.z, halfMap
      );
      broadcastAll({ type: 'shotEnd', id, reason: 0, x: removalPoint.x, y: removalPoint.y, z: removalPoint.z });
      logShotEnd(proj, 'out_of_bounds', removalPoint, `lifetime=${deltaTime.toFixed(3)}/${proj.lifetimeSeconds.toFixed(3)}`);
      log(`Projectile ${id} removed (out of bounds)`);
      return;
    }

  });
}

// Game loop - update projectiles and check collisions
let lastGameLoopAt = Date.now();
let projectileSimAccumulator = 0;
let lastVoiceRosterRefreshAt = 0;

// Moves accepted since the last flush, one entry per player who sent one this
// tick. `broadcast(pmPacket, ws)` used to fire the moment each move was
// validated -- one WS frame per recipient per move. Collecting them here and
// sending one `pmBatch` per client per tick trades that for one frame per
// client, whatever the tick's move count.
let pendingMoveBroadcasts = [];
function flushMoveBroadcasts() {
  if (pendingMoveBroadcasts.length === 0) return;
  const moves = pendingMoveBroadcasts;
  pendingMoveBroadcasts = [];
  // To everyone, the mover included: a mover's own id can ride in the same
  // batch as everyone else's, since the client skips its own id on the way
  // in (see the 'pmBatch' case in client.js). BZFlag clients are skipped,
  // having had each move as it came (`sendMoveToBzflagClients`).
  // `n` orders batches for a browser hearing them on a channel that does
  // not keep them in order (see 'pmBatch' in client.js).
  moveBatchNumber += 1;
  const message = { type: 'pmBatch', n: moveBatchNumber, moves };
  const data = JSON.stringify(message);
  recordBroadcast(data, message);
  // Not to a BZFlag client nor to a browser with a UDP channel open: both
  // had each move as it was accepted (`sendMoveToBzflagClients`,
  // `queueChannelMove`).
  players.forEach((player) => {
    if (player.ws.readyState !== 1 || player.ws.sendMessage || player.udpChannel?.isOpen()) return;
    player.ws.send(data);
  });
}

// Moves for the UDP channels, sent once the event loop has taken what
// arrived with them -- no tick, as bzfs relays a MsgPlayerUpdate on arrival
// (`relayPlayerPacket`, bzfs.cxx:1036), and one message per tank's worth
// rather than one per move.
let pendingChannelMoves = [];
function queueChannelMove(pmPacket) {
  if (!UDP_CHANNELS) return;
  if (pendingChannelMoves.length === 0) setImmediate(flushChannelMoves);
  pendingChannelMoves.push(pmPacket);
}

function flushChannelMoves() {
  const moves = pendingChannelMoves;
  pendingChannelMoves = [];
  if (moves.length === 0) return;
  moveBatchNumber += 1;
  const n = moveBatchNumber;
  let chunks = null;
  players.forEach((player) => {
    if (player.ws.readyState !== 1 || player.ws.sendMessage || !player.udpChannel?.isOpen()) return;
    chunks = chunks || moveBatchChunks(n, moves);
    for (const chunk of chunks) {
      if (!player.udpChannel.send(chunk)) {
        // The channel went as this was sent: the WebSocket has it instead.
        player.ws.send(JSON.stringify({ type: 'pmBatch', n, moves }));
        return;
      }
      serverStats.countOut(chunk.length);
    }
  });
}

let moveBatchNumber = 0;

// A batch as data channel messages that each fit in one packet. A mover's
// moves stay in one message, in order.
function moveBatchChunks(n, moves) {
  const head = `{"type":"pmBatch","n":${n},"moves":[`;
  const chunks = [];
  let parts = [];
  let size = head.length + 2;
  let i = 0;
  while (i < moves.length) {
    let j = i + 1;
    while (j < moves.length && moves[j].id === moves[i].id) j += 1;
    const group = moves.slice(i, j).map((move) => JSON.stringify(move)).join(',');
    if (parts.length > 0 && size + group.length + 1 > UDP_CHANNEL_CHUNK_BYTES) {
      chunks.push(`${head}${parts.join(',')}]}`);
      parts = [];
      size = head.length + 2;
    }
    parts.push(group);
    size += group.length + 1;
    i = j;
  }
  if (parts.length > 0) chunks.push(`${head}${parts.join(',')}]}`);
  return chunks;
}

// One offer per this long from a player, so a page cannot churn peers.
const UDP_CHANNEL_OFFER_INTERVAL_MS = 2000;

// A player's peer for moves. What it brings in is a move or a shot
// (`UDP_CHANNEL_UP_TYPES`), handed to the same handler a WebSocket frame
// goes to -- except a move older than one already taken: on a channel that
// does not keep order, a late move would put the tank back where it was. The
// client's clock (`ct`) is what orders them, as `order` does a
// MsgPlayerUpdate (bzfs.cxx:5299).
function openUdpChannel(player, ws) {
  const session = UDP_CHANNELS.open({
    name: player.id,
    sendSignal: (signal) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'rtc', ...signal }));
    },
    // Usually before the join completes, while the name is still a placeholder.
    onOpen: (remote) => log(`[RTC] ${player.joined ? `"${player.name}"` : `#${player.id}`}${remote ? ` ${remote}` : ''}`),
    onClose: () => {
      if (player.udpChannel === session) {
        player.udpChannel = null;
        if (player.joined) log(`[RTC] "${player.name}" closed`);
      }
    },
    onMessage: (text) => udpChannelMessage(player, session, ws, text),
  });
  return session;
}

// What a player's UDP channel brought in, over WebRTC or WebTransport.
function udpChannelMessage(player, channel, ws, text) {
  serverStats.countIn(text.length);
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  if (!message || !UDP_CHANNEL_UP_TYPES.has(message.type)) return;
  if (player.udpChannel === channel) player.udpChannelHeard = true;
  const ct = Number(message.ct);
  if (message.type === 'm' && Number.isFinite(ct)) {
    if (Number.isFinite(player.udpChannelLastCt) && ct <= player.udpChannelLastCt) return;
    player.udpChannelLastCt = ct;
  }
  ws.emit('message', message);
}

// The UDP channel's TURN relays (#189): the IPv4 voice relays'
// `turn:...?transport=udp`, with this player's own credential. Not TCP or
// TLS: a relay over TCP holds back every message behind a lost one, which is
// what the WebSocket already does.
function udpChannelIceServers(playerId) {
  const config = voiceRtcConfigFor(playerId);
  return (config.ipv4IceServers || config.iceServers)
    .map((server) => ({ ...server, urls: server.urls.filter((url) => /^turn:/i.test(url) && /transport=udp/i.test(url)) }))
    .filter((server) => server.urls.length > 0 && server.username !== undefined);
}

// The scoreboard's `T` letter (server/client-type.cjs).
function playerClientType(player) {
  return clientTypeOf({
    serverBot: bots.has(player.id), bot: player.bot, native: player.native,
    xr: player.xr, headset: player.headset, mobile: player.mobile,
  });
}

// The scoreboard's word on a player's UDP, after its `T` letter: a BZFlag
// client's `u` once heard from on UDP and `+` once sent to there too, as
// `/playerlist`'s ` udp` and ` udp+`; a browser's `h` (WebTransport), `r`
// (WebRTC) or `t` (WebRTC through a TURN relay) once its channel is open,
// with `+` once heard on it.
function playerLink(player) {
  const native = player.nativeLink;
  if (native) {
    if (!native.udpIn()) return '';
    return native.udpOut() ? '+' : 'u';
  }
  const channel = player.udpChannel;
  if (!channel?.isOpen()) return '';
  const letter = { h3: 'h', turn: 't' }[channel.kind] || 'r';
  return player.udpChannelHeard ? `${letter}+` : letter;
}

// A change of link goes out as the player's record, checked each second
// rather than at every place a channel opens, closes or is first heard.
setInterval(() => {
  players.forEach((player) => {
    if (!player.joined) return;
    const link = playerLink(player);
    if (link === (player.lastLink ?? '')) return;
    player.lastLink = link;
    broadcastPlayerRecord('playerUpdated', player);
  });
}, 1000).unref?.();

// WebTransport's half (`startWebTransport`): each connection gets a token in
// its `init`, good while its WebSocket is open; a session that presents it
// becomes the player's UDP channel, in place of any WebRTC one.
const webTransportTokens = new Map();
function webTransportOffer(player) {
  if (!webTransport) return undefined;
  if (!player.webTransportToken) {
    player.webTransportToken = crypto.randomBytes(18).toString('base64url');
    webTransportTokens.set(player.webTransportToken, player);
  }
  const port = Number(/:(\d+)$/.exec(bzflagPublicAddr || '')?.[1]) || PORT;
  return { port, token: player.webTransportToken };
}
function claimWebTransport(token) {
  const player = webTransportTokens.get(token);
  if (!player || player.ws.readyState !== 1) return null;
  let channel = null;
  return {
    attach(created) {
      channel = created;
      if (player.udpChannel !== channel) player.udpChannel?.close();
      player.udpChannel = channel;
      player.udpChannelHeard = false;
      log(`[WT] ${player.joined ? `"${player.name}"` : `#${player.id}`}`);
    },
    onMessage: (text) => udpChannelMessage(player, channel, player.ws, text),
    onClose() {
      if (player.udpChannel !== channel) return;
      player.udpChannel = null;
      if (player.joined) log(`[WT] "${player.name}" closed`);
    },
  };
}

// A move to every BZFlag client the moment it is accepted, as bzfs relays a
// MsgPlayerUpdate on arrival. Batching saves them nothing -- each move is its
// own frame to them either way -- and waiting for the tick costs up to 16ms.
function sendMoveToBzflagClients(pmPacket) {
  let message = null;
  players.forEach((player) => {
    if (player.ws.readyState !== 1 || !player.ws.sendMessage) return;
    message = message || { type: 'pm', ...pmPacket };
    player.ws.sendMessage(message);
  });
}

function gameLoop() {

  const now = Date.now();
  const loopDeltaSeconds = Math.min(0.1, Math.max(0, (now - lastGameLoopAt) / 1000));
  lastGameLoopAt = now;

  if (now - lastVoiceRosterRefreshAt >= VOICE_ROSTER_REFRESH_INTERVAL) {
    refreshVoiceRosters();
    lastVoiceRosterRefreshAt = now;
  }

  // Simulate projectiles at a fixed step to avoid path jitter from loop timing variance.
  projectileSimAccumulator += loopDeltaSeconds;
  const maxAccumulated = SHOT_SIM_STEP_SECONDS * SHOT_SIM_MAX_STEPS_PER_LOOP;
  if (projectileSimAccumulator > maxAccumulated) {
    projectileSimAccumulator = maxAccumulated;
  }
  while (projectileSimAccumulator >= SHOT_SIM_STEP_SECONDS) {
    simulateProjectilesStep(SHOT_SIM_STEP_SECONDS, now);
    projectileSimAccumulator -= SHOT_SIM_STEP_SECONDS;
  }

  fireWorldWeapons(now);
  applySteamrollerSweep(now);
  expireLockTargets();
  updateFlags(now);
  tickMatchClock(now);
  flushMoveBroadcasts();
}

// bzfs.cxx:7180's cadence: every 30 seconds while the clock runs, and once
// more the instant it crosses zero, which is also what ends the match.
let lastMatchTimeBroadcastAt = 0;
function tickMatchClock(now) {
  if (!matchClock.active || matchClock.paused) return;
  const timeLeft = getMatchTimeLeft();
  // `null` means the limit was cleared out from under a running match (the
  // panel's slider can do this) rather than that it reached zero -- `null <= 0`
  // is true in JS, so this is not the same guard as skipping a paused clock.
  if (timeLeft === null) return;
  if (timeLeft <= 0) {
    log('Match clock reached zero');
    endMatch();
    return;
  }
  if (now - lastMatchTimeBroadcastAt >= 30000) {
    broadcastAll({ type: 'timeUpdate', timeLeft });
    lastMatchTimeBroadcastAt = now;
  }
}

createFlags();

// -time with no -timemanual starts the clock as soon as the world is ready,
// mirroring bzfs's own default -- a match server just plays. -timemanual
// leaves it stopped until an operator runs /countdown.
if (GAME_CONFIG.TIME_LIMIT > 0 && !GAME_CONFIG.TIME_MANUAL_START) {
  startMatch();
}

setInterval(gameLoop, 16); // ~60fps
// Buffering from the first moment there is a game to record.
recorder.start();

// The server's own load (`server/server-stats.cjs`), logged while anybody is
// playing so a slow evening can be read back against what the server was doing.
// Every PERF_LOG_INTERVAL_MS, and the latest is what `/lagstats` shows admins.
const PERF_LOG_INTERVAL_MS = 60000;
const serverStatsWindow = serverStats.window();
let lastServerStats = null;
setInterval(() => {
  lastServerStats = serverStatsWindow.read();
  const playing = [...players.values()].filter((player) => player.joined && !bots.has(player.id)).length;
  if (playing > 0) log(`[PERF] ${playing} player(s): ${formatServerStats(lastServerStats)}`);
}, PERF_LOG_INTERVAL_MS).unref?.();

// WebSocket keep-alive: periodically ping all clients and close dead connections
setInterval(() => {
  const now = Date.now();
  players.forEach((player) => {
    if (player.ws.readyState === 1) { // OPEN
      // Check if connection is dead (no pong response)
      if (now - player.lastPongTime > WS_PONG_TIMEOUT) {
        log(`"${player.name}" connection timeout (no pong for ${Math.floor((now - player.lastPongTime) / 1000)}s)`);
        player.ws.terminate();
        return;
      }

      // Mark as potentially dead and send ping
      player.isAlive = false;
      // Before the frame goes out, so a ping that laps an unanswered one counts
      // that one lost at send time rather than on a timeout.
      player.lag.pingSent(now);
      player.ws.ping();
    }
  });
}, WS_PING_INTERVAL);

// Anti-cheat monitoring: periodic summary report (every 5 minutes)
if (ANTICHEAT_CONFIG.mode !== 'disabled') {
  setInterval(() => {
    const now = Date.now();
    const playersWithWarnings = Array.from(players.values())
      .filter(p => p.cheatWarnings.totalWarnings > 0)
      .sort((a, b) => b.cheatWarnings.totalWarnings - a.cheatWarnings.totalWarnings);

    if (playersWithWarnings.length > 0) {
      log(`[ANTICHEAT SUMMARY] ${playersWithWarnings.length} player(s) with warnings:`);
      playersWithWarnings.forEach(p => {
        const timeSinceWarning = Math.floor((now - p.cheatWarnings.lastWarningTime) / 1000);
        log(`  "${p.name}": ${p.cheatWarnings.totalWarnings} total (${formatCheatWarnings(p)}) - last ${timeSinceWarning}s ago`);
      });
    }
  }, 300000); // 5 minutes
}

// -admsg (bzfs.cxx:7555-7591): a periodic advertisement, every 900 seconds --
// upstream's own static timer starts counting from server start, which
// `setInterval`'s first callback already does.
if (mapServerOptions.adMessages && mapServerOptions.adMessages.length > 0) {
  setInterval(() => {
    for (const line of mapServerOptions.adMessages) {
      broadcastAll({ type: 'message', src: SERVER_PLAYER, dst: ALL_PLAYERS, msgType: 'server', text: line, ts: Date.now() });
    }
  }, 900000); // 15 minutes
}

// Function to force all clients to reload
function forceClientReload() {
  log('Forcing all clients to reload...');
  broadcastAll({ type: 'reload' });

  // Close all connections after a short delay
  setTimeout(() => {
    players.forEach((player) => {
      if (player.ws.readyState === 1) {
        player.ws.close();
      }
    });
    players.clear();
  }, 500);
}

// Dropping everyone, as bzfs does with MsgSuperKill (bzfs.cxx:1029): the
// reason as a server message, then `superKill`, which a browser shows as a
// BZFlag client shows MsgSuperKill (playing.cxx:2115). BZFlag clients get the
// same message and then MsgSuperKill itself.
let serverGoingSaid = false;
// `message` is what `localized` returns.
function sayServerIsGoing(message) {
  if (serverGoingSaid) return;
  serverGoingSaid = true;
  broadcastAll({ type: 'message', src: SERVER_PLAYER, dst: ALL_PLAYERS, msgType: 'server', ...message, ts: Date.now() });
  broadcastAll({ type: 'superKill' });
  webTransport?.close();
  bzflagServer?.close();
}

function requestServerRestart(reason) {
  log(`Restart requested: ${reason}`);
  sayServerIsGoing(localized('Server restarting: {reason}', { reason }));
  forceClientReload();

  if (reason === 'server.js change') {
    return;
  }

  const runningUnderNodemon = process.env.NODEMON === 'true' || process.env.npm_lifecycle_event === 'dev';

  // In production (for example Docker running "node server.js"), there is no
  // nodemon watcher to react to timestamp touches. Exit so restart policies
  // relaunch the process and pick up the updated config.
  if (!runningUnderNodemon) {
    setTimeout(() => {
      log('Restarting process to apply config change...');
      process.exit(0);
    }, 1000);
    return;
  }

  // Touch server.js to update its timestamp and trigger nodemon file watcher
  // This causes nodemon to detect the "change" and restart immediately
  // without the "waiting for changes" message
  setTimeout(() => {
    try {
      const now = new Date();
      fs.utimesSync(__filename, now, now);
      log('Triggered nodemon restart via timestamp touch...');
    } catch (err) {
      logError('Failed to trigger restart:', err);
      process.exit(0);
    }
  }, 1000);
}

// Bounds any client-claimed interval to the server's own measured arrival gap,
// widened by at most SDT_JITTER_ALLOWANCE. The server's measure is the gap
// between packet arrivals, which is the send interval plus whatever the
// network did to it -- when jitter shortens it, an honest client's own account
// of the same span looks impossible by comparison. So the claim is bounded
// rather than believed: it may only widen what the server saw, never narrow
// it, and only by this much. A modified client buys at most that much benefit
// of the doubt, whether it is spending it on acceleration (below) or on
// extrapolation (`getExtrapolatedPosition`'s caller in `validateMovement`).
function clampToArrivalGap(arrivalGap, claimedSeconds) {
  if (!Number.isFinite(arrivalGap) || arrivalGap <= 0) return 0;
  const claimed = Number(claimedSeconds);
  if (!Number.isFinite(claimed) || claimed <= arrivalGap) return arrivalGap;
  return Math.min(claimed, arrivalGap + SDT_JITTER_ALLOWANCE);
}

// How long the client had to change its speeds, per its own `sdt` -- the
// interval it actually ramped over, which is the one number neither side can
// measure alone.
function getAccelerationWindow(arrivalGap, clientSendGap) {
  return clampToArrivalGap(arrivalGap, clientSendGap);
}



function getViewableMapsList() {
  return Array.from(MAP_REGISTRY.values())
    .map((entry) => ({
      file: entry.fileName,
      hash: entry.hash,
      url: entry.url,
      stats: entry.stats || null,
      // Whether its world is on disk to fetch. One that is not is asked for
      // first (`importMapForView`), which writes it.
      ready: Boolean(entry.keptAt),
    }))
    // Sorted here rather than left in registration order. The registry is
    // filled in whatever order maps arrive -- the served map first, because
    // it is registered before anything else, then the background trickle's
    // own alphabetical pass, then any remote import whenever it lands -- and
    // the entry dialog's picker steps through this list with left/right, so
    // registration order reads as no order at all once one map has jumped
    // the queue.
    .sort((left, right) => left.file.localeCompare(right.file));
}

// Every client at once -- see `hashRemainingMapsInBackground`'s own call.
function broadcastMapList() {
  for (const player of players.values()) {
    if (player.ws && player.ws.readyState === 1) sendMapList(player.ws);
  }
}

function sendMapList(ws) {
  ws.send(JSON.stringify({
    type: 'mapList',
    maps: listAvailableMapFiles(),
    // What the Operator panel may delete: its own uploads that are still here.
    uploads: {
      maps: uploads.list('maps').filter((name) => fs.existsSync(path.join(RUNTIME_MAPS_DIR, name))),
      replays: uploads.list('replays').filter((name) => fs.existsSync(path.join(RUNTIME_REPLAYS_DIR, `${name}.rec`))),
    },
    viewableMaps: getViewableMapsList(),
    currentMap: MAP_SOURCE,
    shotMaxActive: GAME_CONFIG.SHOT_MAX_ACTIVE,
    ricochet: GAME_CONFIG.ALL_SHOTS_RICOCHET,
  }));
}

// The roster a client is handed. bzfs sends one MsgAddPlayer per already-joined
// player (`bzfs.cxx:2395`) and never mentions a connection still in limbo, so
// neither does this -- except for the recipient itself, which needs its own
// limbo state to know its id and the name the server would give it.
function getRosterFor(recipient) {
  return Array.from(players.values())
    .filter((candidate) => candidate.joined || candidate.id === recipient.id)
    .map((candidate) => candidate.getState(isAdmin(recipient)));
}

// The bzfs proxy (server/bzfs-proxy.cjs), handed what it needs of the server.
// `MAP_SOURCE` and the forwarded-address policy change while the server runs,
// so they are read through getters rather than handed over once.
bzfsProxy.useServer({
  ADMIN_GROUPS,
  ADMIN_WHITELIST,
  bzfsWorlds,
  CLIENT_BUILD,
  currentWorldTime,
  getProxyDestinations,
  getRemoteServerList,
  getViewableMapsList,
  importProxyWorld,
  importReplayWorld,
  isLocalAdminHttp,
  LOCAL_ADMIN,
  log,
  logError,
  MAP_REGISTRY,
  MAX_REAL_PLAYERS,
  parseHostPort,
  PROXY_LOGIN_COOKIE,
  PROXY_TARGETS,
  PROXY_TARGETS_BY_URL,
  proxyTargetStatus,
  replayFilePath,
  replayRoomFor,
  SERVER_VERSION,
  sessions,
  takeProxyToken,
  TEAM_MODE,
  vec3Point,
  voiceRtcConfigFor,
  worldBase,
  get MAP_SOURCE() { return MAP_SOURCE; },
  get forwardedForPolicy() { return forwardedForPolicy; },
  get forwardedProxyPeer() { return forwardedProxyPeer; },
});


// The handshake's user agent, shortened only where its shape is one bzo
// already knows: stock desktop and Android Chrome, desktop Firefox and iPhone
// Safari, which say nothing past their browser, version and platform. Anything
// else -- a headset's browser, an Edge, a webview -- is logged whole, because a
// device nobody has seen yet is what the line is for.
const USER_AGENT_PLATFORMS = [
  ['X11; Linux aarch64', 'Linux arm64'],
  ['X11; Linux x86_64', 'Linux'],
  ['X11; Ubuntu; Linux x86_64', 'Linux'],
  ['Windows NT 10.0; Win64; x64', 'Windows'],
  ['Macintosh; Intel Mac OS X 10_15_7', 'Mac'],
  ['Macintosh; Intel Mac OS X 10.15', 'Mac'],
];
const platformName = (text) => USER_AGENT_PLATFORMS.find(([spelled]) => spelled === text)?.[1];
const KNOWN_USER_AGENTS = [
  [/^Mozilla\/5\.0 \(([^)]+)\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) ((?:Headless)?Chrome)\/(\d+)\.0\.0\.0 Safari\/537\.36$/,
    (m) => platformName(m[1]) && `${m[2]}/${m[3]} ${platformName(m[1])}`],
  [/^Mozilla\/5\.0 \(Linux; Android 10; K\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/(\d+)\.0\.0\.0 Mobile Safari\/537\.36$/,
    (m) => `Chrome/${m[1]} Android`],
  [/^Mozilla\/5\.0 \(([^)]+); rv:(\d+)\.0\) Gecko\/20100101 Firefox\/\2\.0$/,
    (m) => platformName(m[1]) && `Firefox/${m[2]} ${platformName(m[1])}`],
  [/^Mozilla\/5\.0 \(iPhone; CPU iPhone OS [\d_]+ like Mac OS X\) AppleWebKit\/605\.1\.15 \(KHTML, like Gecko\) Version\/([\d.]+) Mobile\/15E148 Safari\/604\.1$/,
    (m) => `Safari/${m[1]} iPhone`],
];

function shortUserAgent(userAgent) {
  for (const [pattern, format] of KNOWN_USER_AGENTS) {
    const match = pattern.exec(userAgent);
    const short = match && format(match);
    if (short) return short;
  }
  return userAgent;
}


// WebSocket connection handler
// When a new player connects, assign a default name and number. Named, because
// a server-run bot connects through it too (`addBot`).
wss.on('connection', (ws, req) => {
  // A browser's traffic, counted at the socket so every send is, whichever
  // of the many paths it took. BZFlag clients are counted by their listener.
  // Frames only: a move off the data channel is emitted here as an object,
  // already counted where it arrived.
  ws.on('message', (data) => {
    if (Buffer.isBuffer(data) || typeof data === 'string') serverStats.countIn(data.length);
  });
  const send = ws.send.bind(ws);
  ws.send = (data, ...rest) => {
    serverStats.countOut(data.length ?? 0);
    return send(data, ...rest);
  };
  acceptConnection(ws, req);
});

function acceptConnection(ws, req) {

  // A proxied or watched connection takes none of what follows: no `Player`,
  // no entry in `players`, no place in this server's game. The two spellings
  // are one path -- see `resolveProxyRequest`.
  const request = resolveProxyRequest(req.url);
  if (request) {
    void handleProxyConnection(ws, req, request);
    return;
  }


  let player = new Player(ws, null, ws.reservedPlayerNumber ?? null);
  reservedPlayerNumbers.delete(ws.reservedPlayerNumber);
  players.set(player.id, player);

  // Set player as not yet joined (not alive)
  player.alive = false;

  // A socket with no 'error' listener throws on the first protocol violation or
  // reset, killing the whole server. Any client can send a malformed frame, so
  // this listener is what keeps one bad peer from taking everyone down. ws
  // closes the socket itself afterwards; 'close' does the player cleanup.
  ws.on('error', (err) => {
    logError(`Player ${player.id} socket error: ${err.message}`);
  });

  // Handle pong responses for keep-alive
  ws.on('pong', () => {
    const now = Date.now();
    player.lastPongTime = now;
    player.isAlive = true;
    // `LagInfo::updatePingLag` (LagInfo.cxx:96). The keep-alive ping was already
    // making this round trip; recording when it went out is the whole of the
    // measurement, and costs no message of its own -- ping and pong are
    // WebSocket frames.
    // Logged to judge whether moves need a lossy transport (docs/lag-plan.md).
    const spike = player.lag.pongReceived(now);
    if (spike) log(`[LAG] "${player.name}" RTT spike ${spike.rttMs}ms (median ${spike.medianMs}ms)`);
    // The client is *shown* the answer, never asked for it (docs/lag-plan.md):
    // this is the player's own figure only, not a broadcast to the roster, so
    // it carries no anti-cheat weight -- it just fills in the debug HUD's ping.
    sendToPlayer(player, { type: 'lag', lagMs: player.lag.getLag(now), jitterMs: player.lag.getJitter() });
  });

  // Nobody is told about this player yet. bzfs's sendPlayerUpdate returns
  // early unless the player isPlaying() (`bzfs.cxx:518`), so a connection
  // sitting in limbo before MsgEnter is never in anyone's roster -- bzo's
  // limbo player is named `Player n`, but that name is never sent to anyone
  // else's scoreboard. The `joinGame` handler does the announcing, once
  // there is a name to announce.

  // Get client IP and port
  const forwardedFor = req.headers['x-forwarded-for'];
  const forwardedPort = req.headers['x-forwarded-port'];
  const clientIP = forwardedFor ? forwardedFor.split(',')[0].trim() : req.socket.remoteAddress;
  const clientPort = forwardedPort ? forwardedPort : req.socket.remotePort;
  const ipDisplay = forwardedFor ? `${clientIP} (via ${req.socket.remoteAddress})` : clientIP;
  if (forwardedFor && forwardedPort) {
    log(`Player ${player.playerNumber} connect from ${ipDisplay}:${clientPort} (x-forwarded-for + x-forwarded-port)`);
  } else if (forwardedFor) {
    log(`Player ${player.playerNumber} connect from ${ipDisplay}:${clientPort} (x-forwarded-for)`);
  } else {
    log(`Player ${player.playerNumber} connect from ${ipDisplay}:${clientPort}`);
  }
  // Never silently: an operator who turned this on should see it happen, and an
  // operator who did not mean to should see it too.
  // The address bans, saved scores and `/playerlist` rest on: read through the
  // startup probe's verdict on the proxy (`trustedClientAddress`), or null where
  // it cannot be trusted. The header's first entry, which the log line above
  // shows, is the client's own claim behind an appending proxy.
  // docs/ban-plan.md.
  player.clientIP = trustedClientAddress(req.socket.remoteAddress, req.headers, forwardedForPolicy, forwardedProxyPeer);
  player.claimedIP = clientIP;
  // What `/clientquery` says it runs: bzo's own build for a browser, and the
  // browser; a BZFlag client replaces it with what it sent (`seatNativeClient`).
  player.clientVersion = `${BZO_APP_VERSION} web, ${shortUserAgent(req.headers['user-agent'] || '')}`;
  player.headset = isHeadsetBrowserUA(req.headers['user-agent']);
  player.localAdmin = isLocalAdminRequest(req.socket.remoteAddress, req.headers, {
    enabled: LOCAL_ADMIN,
    whitelist: ADMIN_WHITELIST,
    forwardedForPolicy,
    proxyPeer: forwardedProxyPeer,
  });
  if (player.localAdmin) {
    log(`Player ${player.playerNumber} is an operator: connected from this machine (localAdmin)`);
  }
  //log(`Player ${player.playerNumber} user agent: ${userAgent}`);

  // What the handshake actually carried, per device, because the answer decides
  // whether an `Origin` check is worth having. A browser is supposed to send
  // `Origin` on a WebSocket upgrade and a non-browser client is not, and
  // `SameSite=Lax` is supposed to keep a cookie off a cross-site upgrade -- both
  // are worth reading off real phones and headsets rather than assuming. See
  // AGENTS.md, "What a real login would look like".
  //
  // Cookie *names* only. A session id in a log is a session id somebody can
  // read, and the question here is which cookies arrive, not what is in them.
  const cookies = parseCookies(req.headers.cookie);
  const cookieNames = Object.keys(cookies);
  log(`[WS] Player ${player.playerNumber} handshake`
    + ` origin=${req.headers.origin === undefined ? 'absent' : `"${req.headers.origin}"`}`
    + ` host="${req.headers.host || ''}"`
    + ` cookies=${cookieNames.length > 0 ? cookieNames.join(',') : 'none'}`
    + ` secure=${req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')}`
    + ` ua="${shortUserAgent(req.headers['user-agent'] || '')}"`);

  // The cookie is where identity binds, because the cookie is what the
  // handshake carries. Everything the player is comes out of the server's own
  // record: the id is only ever looked up, never parsed, so an invented one is
  // anonymous rather than merely unlikely to work.
  //
  // The session is read once, here, and the id is kept so a superseded login
  // can invalidate it. It is deliberately *not* sent to the client.
  player.sessionId = cookies[SESSION_COOKIE_NAME] || null;
  const session = sessions.get(player.sessionId);
  // A session with no BZID is one bzo did not verify -- a proxy login, whose
  // token went to the target instead (`docs/proxy.md`). It names a callsign
  // and grants nothing here.
  if (session && session.bzid) {
    player.verified = true;
    player.bzid = session.bzid;
    player.globalCallsign = session.callsign;
    player.admin = isAdminSession(session, ADMIN_GROUPS);
    log(`[WS] Player ${player.playerNumber} authenticated as "${session.callsign}"`
      + ` bzid=${session.bzid} admin=${player.admin}`);
  } else {
    player.sessionId = null;
  }

  // Every field but one: `MAP_SIZE` lives only in the map's own world file
  // from here on (see `MAP_REGISTRY`'s `mapSize`), which is what a Map
  // Viewer's preview is actually sized from. Sending it here too would give
  // the client two sources for the same fact -- exactly what let the
  // background map-hashing trickle silently resize the live match for issue
  // #68 in the first place, on the server side of the same mistake.
  // Everything that is not BZDB, and the BZDB itself, which the client
  // evaluates over it as this server does (`worldConfig`).
  const clientGameConfig = buildClientConfig(worldBase());

  // Send initial server state in init message
  ws.send(JSON.stringify({
    type: 'init',
    clientBuild: CLIENT_BUILD,
    // package.json's version, `/version`'s own answer -- shown in the
    // Operator panel's title so an operator glancing at the panel already
    // knows what they're running, without typing the chat command for it.
    serverVersion: SERVER_VERSION,
    player: player.getState(isAdmin(player)),
    players: getRosterFor(player),
    // The names the chat entry's Tab completes to, this server's own table
    // rather than a copy of it kept in the client -- upstream hardcodes the
    // list on the client side (`DefaultCompleter`, AutoCompleter.cxx:157) and
    // it drifts from bzfs. `operator` is the tier, so the client can drop the
    // ones this player may not run without being sent a second list when they
    // log in and may.
    commands: clientCommandList(),
    config: clientGameConfig,
    bzdb: clientBzdb(),
    // The flag types plugins registered (`bz_RegisterCustomFlag`).
    customFlagTypes: pluginFlagTypes,
    // The server's own `-set`s alone, which a Map Viewer preview lays its
    // map's over as the live world's are laid (`configForWorld`).
    serverBzdb: Object.fromEntries(SERVER_BZDB),
    teamMode: TEAM_MODE,
    teamScores: getTeamScoreState(),
    // Which settings the panel may change without starting a new game. Sent
    // rather than duplicated on the client, because the panel's one button reads
    // *Apply* or *Restart* from this list and a second copy would eventually
    // promise the wrong one -- see docs/operator-panel-plan.md.
    liveConfigKeys: LIVE_CONFIG_KEYS,
    // And what every one of them is set to, so the panel's rows start on the
    // server's own values rather than on a placeholder. The three live ones are
    // in here too, and the panel keeps reading those from the live config -- a
    // `serverConfigUpdate` moves them without an `init`.
    operatorConfig: getOperatorConfigState(),
    // Admin-only, and deliberately not part of `operatorConfig` above, which
    // this same message sends to every player: the key itself never appears
    // here, only whether one is configured, and `undefined` drops the whole
    // field for anyone `isAdmin` refuses -- see `setListServerKey`.
    listServer: player.admin ? {
      url: LIST_SERVER_URL,
      designated: IS_DESIGNATED_LIST_SERVER,
      keyConfigured: Boolean(LIST_SERVER_KEY),
    } : undefined,
    // bzfs.cxx:2437 sends MsgNewRabbit to a joining player for the same reason:
    // the rabbit is world state, not an event, so a client that arrives mid-game
    // has to be told who it is.
    rabbitId: rabbitPlayerId,
    // The match clock is world state for the same reason: a client that
    // arrives mid-match, mid-pause, or after time has expired has to be told,
    // not left to assume a clockless world. See "Match end" in
    // docs/game-modes-plan.md.
    timeLeft: getMatchTimeLeft(),
    gameOver: matchClock.gameOver,
    voiceRtcConfig: voiceRtcConfigFor(player.id),
    // A reference, not the world itself -- see `MAP_REGISTRY` above. The
    // client fetches `url` once; the hash-named, `immutable` response spares
    // a reconnect the re-fetch entirely.
    world: { hash: LIVE_MAP_ENTRY.hash, url: LIVE_MAP_ENTRY.url },
    // Which of `viewableMaps` the live match is being played on. `mapList`
    // carries the same field, but only in reply to `getMaps`, which nothing
    // asks for until somebody opens the View or Operator dialog -- so without
    // it here a client has no name for the world it is standing in.
    currentMap: MAP_SOURCE,
    // Every map hashed so far, for the join dialog's Map Viewer picker
    // (issue #68). A map still hashing in the background is simply absent
    // until a later `init` -- i.e. until the player reloads -- rather than
    // arriving as a push update; the View dialog avoids that by asking fresh
    // instead (`getMaps`/`mapList` carries the same list on demand).
    viewableMaps: getViewableMapsList(),
    // The bzfs servers this instance proxies, so a player in the local game
    // can reach one from the entry dialog rather than needing a link
    // (`docs/proxy-plan.md`, "A way in that is not a link"). Empty on an
    // instance that proxies nothing, which is what hides the selector.
    proxies: getProxyDestinations(),
    // This instance's own game, for the same selector: a proxied player
    // choosing "local" needs to know which teams they would land among, and
    // `teamMode` above describes wherever this connection currently is.
    localTeams: TEAM_MODE.teams,
    // And which map it is on, because that is what distinguishes this
    // instance's own game in a list beside a row of `host:port` targets. A
    // proxied connection's `currentMap` above is the *target's*, so the local
    // one has to be said separately.
    localMap: MAP_SOURCE,
    // Whether to offer a data channel for moves ('rtc'); a proxied game has
    // none, since its moves go on to a bzfs over its own UDP.
    udpChannel: Boolean(UDP_CHANNELS),
    udpChannelIceServers: UDP_CHANNELS ? udpChannelIceServers(player.id) : undefined,
    // WebTransport to the BZFlag port, tried before the data channel.
    webTransport: webTransportOffer(player),
    flags: getFlagStates(),
    worldTime: currentWorldTime(),
    title: serverConfig.title || '',
    motd: serverConfig.motd || '',
  }));

  // Handle messages
  ws.on('message', (data) => {
    try {
      // A browser's frame, or an object from an in-process sender (`say`).
      const message = Buffer.isBuffer(data) || typeof data === 'string' ? JSON.parse(data) : data;

      // The handler for this type of message (server/messages-*.cjs), if any.
      // Own properties only: a `type` such as `toString` names nothing here.
      if (Object.hasOwn(MESSAGE_HANDLERS, message.type)) MESSAGE_HANDLERS[message.type](player, ws, message);
    } catch (err) {
      logError('Error handling message:', err.stack || err.message);
    }
  });

  // Handle disconnect
  ws.on('close', () => {
    player.udpChannel?.close();
    webTransportTokens.delete(player.webTransportToken);
    const playerName = player.name;
    const playerNum = player.playerNumber;
    const playerWins = player.wins
    const playerLosses = player.losses;
    const cheatWarnings = player.cheatWarnings.totalWarnings;
    const wasJoined = player.joined;
    player.voiceMicEnabled = false;
    player.joined = false;
    clearPauseTimers(player);
    const leavingTeam = player.team;
    if (wasJoined) {
      noteRejoinWait(player);
      saveScore(player);
      pollArbiter?.retractVote(player.name);
    }
    clearTimeout(player.rejoinTimer);
    dropPlayerFlag(player.id);
    if (wasJoined) {
      pluginEvent('bz_ePlayerPartEvent', () => ({
        playerID: Number(player.id), record: pluginRecord(player), reason: '',
      }));
    }
    players.delete(player.id);
    if (wasJoined) reportToListServer('part');
    scheduleBotReconcile();
    // playing.cxx:1685. A lock onto a player who has gone is cleared rather than
    // left to expire, so nobody is told to steer at an id that no longer names
    // anyone.
    players.forEach((other) => {
      if (other.lockTargetId === player.id) setLockTarget(other, null);
    });
    // bzfs.cxx:3001. The rabbit leaving vacates the post. It is already out of
    // the roster here, so there is nobody to mark as the ex-rabbit -- which is
    // the same reason upstream reads it off `playerIndex` rather than the player.
    if (RABBIT_SELECTION && rabbitPlayerId === player.id) anointNewRabbit();
    retireTeamFlags(getTeamColorIndex(leavingTeam));

    let logMsg = `"${playerName}" (#${playerNum}) disconnected. ${playerWins} kills, ${playerLosses} deaths.`;
    const lagSummary = player.lag.getStallSummary();
    if (!bots.has(player.id) && (lagSummary.pings || lagSummary.updates)) {
      log(`[LAG] "${playerName}" left: ${lagSummary.rttSpikes} RTT spikes in ${lagSummary.pings} pings,`
        + ` ${lagSummary.stalls} stalls in ${lagSummary.updates} updates`
        + (lagSummary.stalls ? ` (worst ${lagSummary.worstStallMs}ms)` : ''));
    }
    if (cheatWarnings > 0 && ANTICHEAT_CONFIG.mode !== 'disabled') {
      logMsg += ` [ANTICHEAT: ${cheatWarnings} warnings (${formatCheatWarnings(player)})]`;
    }
    logMsg += ` Players: ${players.size}`;
    log(logMsg);

    // Nobody was told about a connection that never joined, so nobody needs
    // telling that it went.
    if (wasJoined) {
      broadcast({
        type: 'playerLeft',
        id: player.id,
      });
    }
    broadcastTeamScores();
    refreshVoiceRosters(true);
  });
}

// --- Server bots -----------------------------------------------------------
//
// docs/bots-plan.md, step 2. A bot is a client whose socket never leaves the
// process: `acceptConnection` takes it like any other, the bot joins, moves and
// shoots with the messages a browser sends, and everything the server does for
// a player it does for a bot. The pilots and tanks run on a worker
// (`server/bot-worker.cjs`, driving with `server/bots.cjs`); this is the game
// they are shown and the messages they send.
//
// `bots.fill` in server.json, or `/bot fill`, keeps the playing roster at that
// many: a bot for each place people leave empty, and none once people fill it.
// With nobody connected at all the bots idle -- nothing to think, move or send
// for -- until somebody arrives.
const { EventEmitter } = require('node:events');
const { planBotFill, pickBotToRemove } = require('./server/bots.cjs');

const BOT_TICK_SECONDS = 0.05;
// The longest step a bot's tank takes when the worker has fallen behind.
const BOT_MAX_TICK_SECONDS = 0.25;
const BOT_HEARTBEAT_MS = 1000;
let lastBotHeartbeatAt = 0;
const BOT_FAKE_REQUEST = Object.freeze({
  url: '/',
  headers: Object.freeze({ 'user-agent': 'bzo-bot' }),
  // Not a loopback address, so a bot is never a local admin.
  socket: Object.freeze({ remoteAddress: 'bot', remotePort: 0 }),
});
let AUTOPILOT_MODULE = null;
const bots = new Map();

// What the message handlers need of the server (server/messages-*.cjs), handed
// over before the first connection -- a bot connects in-process, so not before
// `bots`. `MESSAGE_SERVER` holds what changes while the server runs.
const MESSAGE_SERVER = {
  get LIST_SERVER_KEY() { return LIST_SERVER_KEY; },
  set LIST_SERVER_KEY(value) { LIST_SERVER_KEY = value; },
  get MAP_SOURCE() { return MAP_SOURCE; },
  get UDP_CHANNELS() { return UDP_CHANNELS; },
  get pendingMoveBroadcasts() { return pendingMoveBroadcasts; },
  get projectileIdCounter() { return projectileIdCounter; },
  set projectileIdCounter(value) { projectileIdCounter = value; },
  get rabbitPlayerId() { return rabbitPlayerId; },
  get serverConfig() { return serverConfig; },
};
messagesVoice.useServer({
  broadcastAll,
  forwardVoiceSignal,
  refreshVoiceRosters,
  sendVoiceStateUpdate,
});
messagesChat.useServer({
  deliverActionMessage,
  deliverChatMessage,
  handleServerCommand,
  log,
});
messagesPlay.useServer({
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
  pluginEvent,
  pluginRecord,
  pluginState,
  playerSpawned,
  spawnAllowed,
  bringBack,
  sendPluginsTo,
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
}, MESSAGE_SERVER);
messagesOperator.useServer({
  IMPORT_REUSE_MS,
  MAP_REGISTRY,
  OPERATOR_CONFIG_KEYS,
  REPLAY_UPLOAD_MAX_BYTES,
  RUNTIME_MAPS_DIR,
  RUNTIME_REPLAYS_DIR,
  applyServerConfigChanges,
  configPath,
  endMatch,
  getRemoteServerList,
  getViewableMapsList,
  hashRemainingMapsInBackground,
  invalidateListTables,
  log,
  logError,
  parseHostPort,
  parseImportMapFileName,
  pauseMatch,
  performRemoteMapImport,
  prepareMapForView,
  recorder,
  recordingName,
  refuseNonOperator,
  registerFreshImportFromDisk,
  confirmImportUnchanged,
  replayRooms,
  replaySummaries,
  replyToPlayer,
  reportToListServer,
  requestServerRestart,
  resolveMapFilePath,
  resumeMatch,
  saveRecording,
  sendMapList,
  startMatch,
  sweepMapCache,
  uploads,
  writeServerConfig,
}, MESSAGE_SERVER);
let botFill = Math.max(0, Math.floor(Number(serverConfig.bots?.fill) || 0));
// `bots.pilot`, or the pilots' own default once they load.
let botFillPilot = typeof serverConfig.bots?.pilot === 'string' ? serverConfig.bots.pilot : null;
let botsIdle = false;
let nextBotNumber = 1;

// The socket a bot's client holds: what the server sends it goes nowhere, and
// what it says arrives as a browser's message would.
function createBotSocket() {
  const socket = new EventEmitter();
  socket.OPEN = 1;
  socket.readyState = 1;
  socket.send = () => {};
  socket.ping = () => setTimeout(() => socket.emit('pong'), 0);
  const close = () => {
    if (socket.readyState !== 1) return;
    socket.readyState = 3;
    socket.emit('close');
  };
  socket.close = close;
  socket.terminate = close;
  socket.say = (message) => socket.emit('message', asIfFromWire(message));
  return socket;
}

function findAutopilot(id) {
  return AUTOPILOT_MODULE?.AUTOPILOTS.find((entry) => entry.id === id) ?? null;
}

// A person: neither a bot this server runs nor a client that joined as one.
// A connection still in the entry dialog has declared nothing yet, so counts.
function isRealPlayer(player) {
  return !bots.has(player.id) && !player.bot;
}

// A tank's motion now, from its last accepted move, by the same model the
// client draws it with.
function getPlayerMotion(player, flagType, now) {
  const airborne = player.jumpAzimuth !== null && player.jumpAzimuth !== undefined;
  const gravity = hasAirControl(flagType) ? GAME_CONFIG.WINGS_GRAVITY : GAME_CONFIG.GRAVITY;
  if (airborne) {
    const elapsed = Math.max(0, (now - player.lastUpdate) / 1000);
    return {
      airborne,
      gravity,
      vx: player.airVelocityX || 0,
      vy: player.airVelocityY || 0,
      vz: (player.verticalVelocity || 0) - (gravity * elapsed),
    };
  }
  const azimuth = player.slideAzimuth ?? player.azimuth;
  const speed = (player.forwardSpeed || 0) * GAME_CONFIG.TANK_SPEED;
  return {
    airborne, gravity, vx: Math.cos(azimuth) * speed, vy: Math.sin(azimuth) * speed, vz: 0,
  };
}

// The bot worker (`server/bot-worker.cjs`): every bot's pilot and tank, off
// this thread, started with the first bot and ended with the last. It holds
// the world once for every bot and is told the game a tick at a time
// (`botTickSnapshot`); what it sends back is what each bot's client would have
// said (`applyBotResults`).
let botWorker = null;
let botWorkerBusy = false;
let botWorkerConfig = '';
let lastBotTickAt = 0;

function startBotWorker() {
  if (botWorker) return botWorker;
  const worker = new Worker(path.join(__dirname, 'server', 'bot-worker.cjs'));
  botWorker = worker;
  botWorkerBusy = false;
  botWorkerConfig = '';
  lastBotTickAt = 0;
  worker.on('message', (message) => {
    if (worker !== botWorker) return;
    if (message.type === 'results') {
      botWorkerBusy = false;
      applyBotResults(message.bots);
    } else if (message.type === 'error') {
      const bot = message.id === null ? null : bots.get(message.id);
      logError(`[BOT] ${bot ? `"${bot.player.name}" ` : ''}${message.message}`);
    }
  });
  // A worker that dies takes every pilot's memory with it: a fresh one picks
  // the same bots up where the server last put them.
  worker.on('error', (error) => logError('[BOT] worker failed:', error));
  worker.on('exit', (code) => {
    if (worker !== botWorker) return;
    botWorker = null;
    if (bots.size === 0) return;
    log(`[BOT] worker stopped (${code}); restarting it`);
    startBotWorker();
    bots.forEach((bot) => botWorker.postMessage({ type: 'add', id: bot.player.id, pilotId: bot.pilotId }));
  });
  worker.postMessage({
    type: 'world',
    world: {
      obstacles: OBSTACLES,
      mapSize: GAME_CONFIG.MAP_SIZE,
      noWalls: mapNoWalls,
      wallHeight: GAME_CONFIG.WALL_HEIGHT,
      waterLevel: mapWaterLevel && mapWaterLevel.height > 0 ? mapWaterLevel.height : null,
      teleporterLinks: TELEPORTER_GRAPH.links,
      // The zones a client's world carries, as `buildWorldFile` writes them.
      ...clientZones(MAP_ZONES),
    },
  });
  log('[BOT] worker started');
  return worker;
}

function stopBotWorker() {
  if (!botWorker) return;
  const worker = botWorker;
  botWorker = null;
  worker.terminate();
  log('[BOT] worker stopped: no bots');
}

// The config, when it has moved since the worker last heard it.
function syncBotWorkerConfig() {
  const json = JSON.stringify(GAME_CONFIG);
  if (json === botWorkerConfig) return;
  botWorkerConfig = json;
  botWorker.postMessage({ type: 'config', config: GAME_CONFIG });
}

// What every bot sees alike, as much of the game as a client would see: a
// superflag on the ground keeps its type hidden (`getFlagState`), and the
// pilot's own memory is all it has to go on. Each bot leaves itself and its
// own shots out in the worker.
function botSharedView(now) {
  const others = [];
  for (const other of players.values()) {
    if (!other.joined || isObserverTeam(other.team)) continue;
    const flag = getPlayerFlag(other.id);
    const position = other.getExtrapolatedPosition(now);
    others.push({
      id: other.id,
      x: position.x,
      y: position.y,
      z: position.z,
      ...getPlayerMotion(other, flag?.type ?? null, now),
      team: other.team,
      alive: other.alive,
      paused: other.paused,
      notResponding: false,
      flag: flag?.type ?? null,
      flagIndex: flag?.index ?? null,
      flagTeam: getFlagTeamIndex(flag?.type ?? null),
      zoned: isZoned(flag?.type ?? null, flag?.zoned === true),
      // BZFlag's score: wins less losses.
      score: (other.wins || 0) - (other.losses || 0),
    });
  }
  const shots = [];
  // Every shot in the air by id, beams and waves too: what a player counts a
  // flag's shots by.
  const fired = [];
  for (const [id, proj] of projectiles) {
    fired.push({ id, ownerId: proj.playerId });
    if (proj.beam || proj.shockwave) continue;
    const owner = getPlayerFlag(proj.playerId);
    shots.push({
      ownerId: proj.playerId,
      ownerZoned: isZoned(owner?.type ?? null, owner?.zoned === true),
      flag: proj.flag ?? null,
      x: proj.x,
      y: proj.y,
      z: proj.z,
      vx: proj.dirX * proj.speed,
      vy: proj.dirY * proj.speed,
      vz: proj.dirZ * proj.speed,
      bounces: proj.bounces,
    });
  }
  let teamFlags = false;
  const viewFlags = [];
  for (const flag of flags) {
    if (flag.status === FLAG_STATUS.NO_EXIST) continue;
    const state = getFlagState(flag, now);
    const team = getFlagTeamIndex(flag.type);
    if (team !== null) teamFlags = true;
    viewFlags.push({
      index: state.index,
      type: state.type,
      team,
      onGround: state.status === FLAG_STATUS.ON_GROUND,
      x: state.position.x,
      y: state.position.y,
      z: state.position.z,
    });
  }
  return {
    now: now / 1000,
    players: others,
    shots,
    fired,
    kills: botKillFeed,
    flags: viewFlags,
    teamsAllowed: TEAMS_ALLOWED,
    // Each team's score, wins less losses, by team name.
    teamScores: Object.fromEntries([...teamScores].map(([team, score]) => [team, score.wins - score.losses])),
    world: {
      allowJumping: GAME_CONFIG.ALLOW_JUMPING === true,
      teamFlags,
      waterLevel: mapWaterLevel && mapWaterLevel.height > 0 ? mapWaterLevel.height : null,
      shotSpeed: GAME_CONFIG.SHOT_SPEED,
      maxShots: normalizeShotSlotCount(GAME_CONFIG.SHOT_MAX_ACTIVE),
      tankHeight: TANK.height,
      tankLength: TANK.halfLength * 2,
      tankAngVel: GAME_CONFIG.TANK_ROTATION_SPEED,
      tankSpeed: GAME_CONFIG.TANK_SPEED,
      shakeTimeout: shakeTimeoutSeconds(FLAG_SHAKE_TIMEOUT),
      jumpVelocity: GAME_CONFIG.JUMP_VELOCITY,
      gravity: GAME_CONFIG.GRAVITY,
      lockOnAngle: getFlagTuning().lockOnAngle,
      shotLimits: Object.fromEntries(SHOT_LIMITS),
      mapSize: GAME_CONFIG.MAP_SIZE,
      shockOutRadius: getShotEffects('SW').shockOutRadius,
      noTeamKills: NO_TEAM_KILLS,
    },
  };
}

// What is one bot's own: where the server has its tank, the flag it carries
// and what that does to its shots, and whether it may fire.
function botOwnView(bot, now) {
  const me = bot.player;
  const myFlag = getPlayerFlag(me.id);
  const myType = myFlag?.type ?? null;
  const maxShots = normalizeShotSlotCount(GAME_CONFIG.SHOT_MAX_ACTIVE);
  return {
    id: me.id,
    state: {
      alive: me.alive && me.joined, x: me.x, y: me.y, z: me.z, azimuth: me.azimuth,
    },
    // The flag it drives by, as a client's tank does: Burrow takes it under,
    // Agility gives it the burst, Wings flies it.
    flag: myFlag ? { type: myType, zoned: myFlag.zoned === true, index: myFlag.index } : null,
    antidote: me.antidote ? { x: me.antidote.x, y: me.antidote.y, z: me.antidote.z } : null,
    // What Identify names, as `searchFlag` tells a person carrying it: the
    // nearest flag on the ground in range, to this bot alone.
    identified: botIdentifiedFlag(me, myType),

    self: {
      id: me.id,
      flag: myType,
      flagIndex: myFlag?.index ?? null,
      flagTeam: getFlagTeamIndex(myType),
      teamColor: getTeamColorIndex(me.team),
      team: me.team,
      score: (me.wins || 0) - (me.losses || 0),
      zoned: isZoned(myType, myFlag?.zoned === true),
      shotSpeed: GAME_CONFIG.SHOT_SPEED * getShotEffects(myType).velocityFactor,
      shotLifetime: getWorldReloadSeconds(GAME_CONFIG) * getShotEffects(myType).lifeFactor,
      ricochet: shotRicochets(myType, GAME_CONFIG.ALL_SHOTS_RICOCHET),
      canFire: findFreeShotSlot(me.shotSlotFreeAt, maxShots, now) >= 0,
      freeShots: countFreeShotSlots(me.shotSlotFreeAt, maxShots, now),
    },
  };
}

function botIdentifiedFlag(me, myType) {
  if (myType !== 'ID' || !me.alive || me.paused) return null;
  const closest = findNearestGroundFlag(flags, me.x, me.y, me.z, getFlagTuning().identifyRange);
  return closest ? { index: closest.index, type: closest.type } : null;
}

// The bot a watcher follows, whose whole plan comes back with the tick.
function followedBotId() {
  for (const player of players.values()) {
    if (player.watchBotFollow === null || player.watchBotFollow === undefined) continue;
    const bot = [...bots.values()].find((candidate) => String(candidate.player.id) === player.watchBotFollow);
    if (bot) return bot.player.id;
  }
  return null;
}

// What each bot's client said this tick, said for it: the moves, then the
// checks a client makes with its tank where the move left it, then the shot.
function applyBotResults(results) {
  const now = Date.now();
  for (const result of results) {
    const bot = bots.get(result.id);
    if (!bot) continue;
    try {
      for (const message of result.pre) bot.socket.say(message);
      if (result.self) botCheckEnvironment(bot, result.self);
      for (const message of result.post) bot.socket.say(message);
    } catch (err) {
      logError(`[BOT] "${bot.player.name}" ${err.stack || err.message}`);
    }
    bot.lastOut = { mode: result.mode, reason: result.reason ?? null, targetId: result.targetId, intent: result.intent ?? null };
    if (result.report !== undefined) reportBot(bot, result.report);
  }
  broadcastBotIntents(now);
}

// checkEnvironment's two checks, as a client makes them for its own tank: drive
// over a flag and ask for it; carry a team flag onto a base and say so.
function botCheckEnvironment(bot, self) {
  const me = bot.player;
  const now = Date.now();
  if (now - bot.lastGrabAt < FLAG_GRAB_INTERVAL_MS) return;
  const carried = getPlayerFlag(me.id);
  if (carried) {
    const flagTeam = getFlagTeamIndex(carried.type);
    if (flagTeam === null) return;
    const baseTeam = getBaseTeamAtPoint(OBSTACLES, self.x, self.y, self.z);
    if (baseTeam === null) return;
    const myTeam = getTeamColorIndex(me.team);
    if ((flagTeam === myTeam) === (baseTeam === myTeam)) return;
    bot.lastGrabAt = now;
    bot.socket.say({ type: 'captureFlag', team: baseTeam });
    return;
  }
  if (self.inAir) return;
  for (const flag of flags) {
    if (flag.status !== FLAG_STATUS.ON_GROUND) continue;
    if (Math.abs(self.z - flag.position.z) >= FLAG_GRAB_LEVEL_TOLERANCE) continue;
    if (distance(self.x, self.y, flag.position.x, flag.position.y) >= getFlagGrabRadius()) continue;
    bot.lastGrabAt = now;
    bot.socket.say({ type: 'grabFlag', index: flag.index });
    return;
  }
}

// How many player slots a BZFlag 2.4 client holds (`maxRemotePlayers`,
// global.h:40): it files a player under its id and checks only for a negative
// one, so no id may reach this.
const BZFLAG_CLIENT_PLAYER_SLOTS = 216;

// A bot's slot: the highest free one under the server's player limit, counting
// down, where upstream gives a server-side player the lowest like anyone else.
// People count up from 0, so the two meet only on a nearly full server. A slot
// whose bot left a score waiting comes first, so the bot that went is the one
// that comes back -- the fill takes bots from the biggest team, not from the
// top, so the highest free slot need not be the one it emptied.
function getBotPlayerNumber(pilotName) {
  const taken = new Set([...players.values()].map((other) => other.playerNumber));
  for (const number of reservedPlayerNumbers) taken.add(number);
  let highest = null;
  for (let number = Math.min(MAX_TOTAL_PLAYERS, BZFLAG_CLIENT_PLAYER_SLOTS) - 1; number >= 0; number--) {
    if (taken.has(number)) continue;
    if (savedScores.get(`${pilotName}${number}`.toLowerCase())?.serverBot) return number;
    if (highest === null) highest = number;
  }
  return highest;
}

function addBot(pilotId = botFillPilot, team = PLAYER_TEAM.AUTOMATIC, { auto = false } = {}) {
  const entry = findAutopilot(pilotId);
  if (!entry) return { error: `no pilot "${pilotId}"` };
  if (botsDisabled()) return { error: 'bots are disabled on this server (-disableBots)' };
  const number = getBotPlayerNumber(entry.name);
  if (number === null) return { error: 'no free player slot for a bot' };
  const socket = createBotSocket();
  socket.reservedPlayerNumber = number;
  acceptConnection(socket, BOT_FAKE_REQUEST);
  const player = [...players.values()].find((candidate) => candidate.ws === socket);
  if (!player) return { error: 'the bot could not connect' };
  player.clientVersion = `${BZO_APP_VERSION} bot, ${entry.name}`;
  player.serverBot = true;
  // Named for its slot; a person already called that leaves the bot a counted
  // name instead, which keeps no record.
  let name = `${entry.name}${player.playerNumber}`;
  while ([...players.values()].some((other) => other !== player && other.name === name)) {
    name = `${entry.name}${player.playerNumber}-${nextBotNumber++}`;
  }
  const bot = {
    player,
    socket,
    pilotId: entry.id,
    auto,
    lastGrabAt: 0,
    reportAt: 0,
    reportedWins: 0,
    reportedLosses: 0,
  };
  bot.lastOut = null;
  startBotWorker().postMessage({ type: 'add', id: player.id, pilotId: entry.id });
  bots.set(player.id, bot);
  socket.say({
    type: 'joinGame', name, team, tankModel: 'bzflag', motto: entry.name, bot: true,
  });
  // A restored score is not this report period's kills and deaths.
  bot.reportedWins = player.wins;
  bot.reportedLosses = player.losses;
  return { bot };
}

// What a bot has been doing, every so often, in the log: the pilot's own
// account (`takeReport`, which the worker asks for) and the kills and deaths
// the server scored it.
function reportBot(bot, report) {
  const kills = bot.player.wins - bot.reportedWins;
  const deaths = bot.player.losses - bot.reportedLosses;
  bot.reportedWins = bot.player.wins;
  bot.reportedLosses = bot.player.losses;
  log(`[BOT] "${bot.player.name}" ${report}; kills ${kills}, deaths ${deaths}`);
}

function removeBot(bot) {
  bots.delete(bot.player.id);
  bot.socket.close();
  botWorker?.postMessage({ type: 'remove', id: bot.player.id });
  if (bots.size === 0) stopBotWorker();
}

// People playing, by the measure the fill counts: joined, on a team, and not a
// bot. An observer watches the bots rather than taking one's place.
function countRealPlayers() {
  let count = 0;
  players.forEach((player) => {
    if (isRealPlayer(player) && player.joined && !isObserverTeam(player.team)) count++;
  });
  return count;
}

function reconcileBots() {
  if (!AUTOPILOT_MODULE || botsDisabled()) return;
  const autoBots = [...bots.values()].filter((bot) => bot.auto);
  let change = planBotFill({ fill: botFill, humans: countRealPlayers(), bots: autoBots.length });
  while (change > 0) {
    const { error } = addBot(botFillPilot, PLAYER_TEAM.AUTOMATIC, { auto: true });
    if (error) {
      log(`[BOT] fill could not add a bot: ${error}`);
      return;
    }
    change--;
  }
  while (change < 0) {
    const teamSizes = new Map();
    players.forEach((player) => {
      if (player.joined && !isObserverTeam(player.team)) {
        teamSizes.set(player.team, (teamSizes.get(player.team) || 0) + 1);
      }
    });
    const candidates = [...bots.values()].filter((bot) => bot.auto)
      .map((bot) => ({ bot, team: bot.player.team, slot: bot.player.playerNumber }));
    const chosen = pickBotToRemove(candidates, teamSizes);
    if (!chosen) return;
    removeBot(chosen.bot);
    change++;
  }
}

// Joins and parts arrive from inside the handlers that cause them, so the
// roster is settled before anything is added or taken away.
let botReconcileQueued = false;
function scheduleBotReconcile() {
  if (botReconcileQueued) return;
  botReconcileQueued = true;
  setTimeout(() => {
    botReconcileQueued = false;
    reconcileBots();
  }, 0);
}

function hasRealConnection() {
  for (const player of players.values()) {
    if (isRealPlayer(player)) return true;
  }
  return false;
}

setInterval(() => {
  if (bots.size === 0) return;
  const idle = !hasRealConnection();
  if (!botWorker) return;
  if (idle !== botsIdle) {
    botsIdle = idle;
    log(`[BOT] ${idle ? 'idle: nobody connected' : 'awake'}`);
    lastBotHeartbeatAt = 0;
  }
  // Idle, a bot only stands still and says so once a second, as a client's
  // heartbeat, so the server does not take it for one that stopped
  // responding.
  if (idle) {
    const now = Date.now();
    if (botWorkerBusy || now - lastBotHeartbeatAt < BOT_HEARTBEAT_MS) return;
    lastBotHeartbeatAt = now;
    lastBotTickAt = 0;
    botWorkerBusy = true;
    syncBotWorkerConfig();
    botWorker.postMessage({ type: 'halt', bots: [...bots.values()].map((bot) => botOwnView(bot, now)) });
    return;
  }
  // One tick in flight at a time. A tick the worker is still thinking about
  // is not queued behind: the next one carries the time that went by, so a
  // slow plan costs a bot a late move rather than a slow tank.
  if (botWorkerBusy) return;
  const now = Date.now();
  const dt = lastBotTickAt ? Math.min((now - lastBotTickAt) / 1000, BOT_MAX_TICK_SECONDS) : BOT_TICK_SECONDS;
  lastBotTickAt = now;
  syncBotWorkerConfig();
  botWorkerBusy = true;
  botWorker.postMessage({
    type: 'tick',
    dt,
    shared: botSharedView(now),
    bots: [...bots.values()].map((bot) => botOwnView(bot, now)),
    followId: followedBotId(),
  });
}, BOT_TICK_SECONDS * 1000);

// What each server bot is doing and at whom, twice a second, to the clients
// that asked (`watchBots`) -- their debug labels show it on the bot's name.
const BOT_INTENT_INTERVAL_MS = 500;
let lastBotIntentsAt = 0;
function broadcastBotIntents(now) {
  if (now - lastBotIntentsAt < BOT_INTENT_INTERVAL_MS) return;
  lastBotIntentsAt = now;
  const watchers = [...players.values()]
    .filter((p) => (p.watchBots || p.watchBotFollow) && p.ws?.readyState === 1);
  if (watchers.length === 0) return;
  const summary = [...bots.values()].map((bot) => ({
    id: bot.player.id,
    mode: bot.lastOut?.mode ?? null,
    reason: bot.lastOut?.reason ?? null,
    targetId: bot.lastOut?.targetId ?? null,
  }));
  const plain = JSON.stringify({ type: 'botIntents', bots: summary });
  for (const watcher of watchers) {
    // A watcher following a bot gets its whole plan too: route, target,
    // landing and the shot it chose, as its own autopilot's overlay draws.
    const followed = watcher.watchBotFollow !== null && watcher.watchBotFollow !== undefined
      ? [...bots.values()].find((bot) => String(bot.player.id) === watcher.watchBotFollow) : null;
    if (!followed?.lastOut?.intent) {
      watcher.ws.send(plain);
      continue;
    }
    watcher.ws.send(JSON.stringify({
      type: 'botIntents',
      bots: summary,
      plan: { id: followed.player.id, intent: followed.lastOut.intent },
    }));
  }
}

import('./public/js/autopilot.mjs').then((module) => {
  AUTOPILOT_MODULE = module;
  botFillPilot = botFillPilot ?? module.DEFAULT_PILOT;
  if (botFill > 0) log(`[BOT] fill ${botFill} with ${botFillPilot}`);
  scheduleBotReconcile();
}).catch((err) => logError(`[BOT] pilots did not load: ${err.message}`));

function describeBots() {
  const list = [...bots.values()].map((bot) => `${bot.player.name} (${bot.pilotId}${bot.auto ? ', fill' : ''})`);
  return `fill ${botFill} with ${botFillPilot}; ${list.length ? list.join(', ') : 'no bots'}`
    + (botsIdle ? '; idle' : '');
}

defineCommand('/bot', COMMAND_TIER.OPERATOR,
  '[fill <n> [pilot] | add [pilot] [team] [count] | remove <name|all>] - server-run bots',
  (player, args) => {
    const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    if (!AUTOPILOT_MODULE) {
      replyToPlayer(player, 'The pilots have not loaded');
      return;
    }
    const pilots = AUTOPILOT_MODULE.AUTOPILOTS.map((entry) => entry.id).join('|');
    if (!verb) {
      replyToPlayer(player, describeBots());
      return;
    }
    if (verb === 'fill') {
      const count = Number(rest[0]);
      if (!Number.isInteger(count) || count < 0 || count > MAX_REAL_PLAYERS) {
        // TRANSLATORS: a command's syntax; keep it as it is
        replyToPlayer(player, 'Usage: /bot fill <0-{max}> [{pilots}]', { max: MAX_REAL_PLAYERS, pilots });
        return;
      }
      if (rest[1] && !findAutopilot(rest[1].toLowerCase())) {
        replyToPlayer(player, 'No pilot "{pilot}"; one of {pilots}', { pilot: rest[1], pilots });
        return;
      }
      // The Operator panel's own change, so the two cannot disagree and the
      // fill survives a restart.
      const result = applyServerConfigChanges(
        { botFill: count, ...(rest[1] ? { botPilot: rest[1].toLowerCase() } : {}) },
        `"${player.name}" via /bot`);
      replyToPlayer(player, result.error || describeBots());
      return;
    }
    if (verb === 'add') {
      let pilotId = botFillPilot;
      let team = PLAYER_TEAM.AUTOMATIC;
      let count = 1;
      for (const word of rest) {
        const lower = word.toLowerCase();
        if (findAutopilot(lower)) pilotId = lower;
        else if (PLAYER_TEAMS.includes(lower) && !isObserverTeam(lower)) team = lower;
        else if (/^\d+$/.test(word)) count = Math.min(Number(word), MAX_REAL_PLAYERS);
        else {
          // TRANSLATORS: a command's syntax; keep /bot add as it is
          replyToPlayer(player, 'Usage: /bot add [{pilots}] [team] [count]', { pilots });
          return;
        }
      }
      for (let i = 0; i < count; i++) {
        const { error } = addBot(pilotId, team);
        if (error) {
          replyToPlayer(player, error);
          return;
        }
      }
      log(`[CMD] "${player.name}" added ${count} ${pilotId} bot(s)`);
      replyToPlayer(player, describeBots());
      return;
    }
    if (verb === 'remove') {
      const target = rest.join(' ');
      const chosen = target === 'all'
        ? [...bots.values()]
        : [...bots.values()].filter((bot) => bot.player.name === target);
      if (!target || chosen.length === 0) {
        replyToPlayer(player, 'Usage: /bot remove <name|all>');
        return;
      }
      // A removed fill bot would only come straight back, so `all` empties the
      // fill too.
      if (target === 'all' && botFill > 0) applyServerConfigChanges({ botFill: 0 }, `"${player.name}" via /bot`);
      chosen.forEach(removeBot);
      log(`[CMD] "${player.name}" removed ${chosen.length} bot(s)`);
      replyToPlayer(player, describeBots());
      return;
    }
    // TRANSLATORS: a command's syntax; keep /bot, fill, add, remove and all as they are
    replyToPlayer(player, 'Usage: /bot [fill <n> [{pilots}] | add [{pilots}] [team] [count] | remove <name|all>]', { pilots });
  });

// Expose the forceClientReload function for manual triggering
// You can call this from the Node.js console or via a signal
global.forceReload = forceClientReload;

// Optional: Listen for SIGUSR1 signal to trigger reload
process.on('SIGUSR1', () => {
  console.log('Received SIGUSR1 signal');
  forceClientReload();
});

// REMOVE-equivalent on a clean shutdown -- docs/list-server-plan.md
// "Reporting". Registering a handler replaces Node's default terminate
// action for these signals, so the process.exit below is what actually ends
// it; a short grace period lets the outbound report go out rather than
// promising it resolves in that time.
let listServerShuttingDown = false;
function reportListServerShutdown(signal) {
  if (listServerShuttingDown) return;
  listServerShuttingDown = true;
  log(`[LISTSERVER] ${signal} received; reporting removal before exit`);
  reportToListServer('shutdown');
  // Not on a nodemon restart (SIGUSR2): the next process maps the same port
  // again, and a removal still in flight could undo its mapping.
  void bzflagUpnp?.stop();
  sayServerIsGoing(localized('Server shutting down'));
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', () => reportListServerShutdown('SIGTERM'));
process.on('SIGINT', () => reportListServerShutdown('SIGINT'));
// nodemon restarts with SIGUSR2: tell every client the server is going, then
// let the signal end the process as it would have.
process.once('SIGUSR2', () => {
  // The signal ends the process without an `exit` event, so the scores go now.
  saveScoresForRestart();
  sayServerIsGoing(localized('Server restarting'));
  setTimeout(() => process.kill(process.pid, 'SIGUSR2'), 100);
});

// bz_eTeamType (bzfsAPI.h:419), which numbers rabbit, hunter and observer
// differently from the TeamColor the wire uses.
const BZ_TEAM_ORDER = Object.freeze([
  PLAYER_TEAM.ROGUE, PLAYER_TEAM.RED, PLAYER_TEAM.GREEN, PLAYER_TEAM.BLUE,
  PLAYER_TEAM.PURPLE, PLAYER_TEAM.RABBIT, PLAYER_TEAM.HUNTER, PLAYER_TEAM.OBSERVER,
]);
// BZ_SERVER, BZ_ALLUSERS and BZ_NULLUSER (bzfsAPI.h:433).
const BZ_SERVER = -2;
const BZ_ALLUSERS = -1;
const BZ_NULLUSER = -3;

function bzTeam(team) {
  return BZ_TEAM_ORDER.indexOf(team);
}

// An event, built and sent only when a plugin registered for it: the call
// sites are hot paths, and with no plugin listening this is one Map lookup.
// Returns the data the plugins saw, which an allow event is read back from.
function pluginEvent(type, build) {
  if (!plugins?.listening(type)) return null;
  return plugins.callEvents(type, build());
}

function pluginPos(point) {
  return [point.x, point.y, point.z];
}

// bz_PlayerUpdateState, as much of it as bzo keeps on the server.
function pluginState(player) {
  return { pos: pluginPos(player), rotation: player.azimuth };
}

// bz_BasePlayerRecord (bzfsAPI.h), filled as bz_updatePlayerData fills it.
// `currentFlag` is upstream's label, "Shock Wave (+SW)"; `-1` and '' are
// upstream's "none".
function pluginRecord(player) {
  const flag = getPlayerFlag(player.id);
  const type = flag ? getFlagType(flag.type) : null;
  return {
    playerID: Number(player.id),
    callsign: player.name,
    team: bzTeam(player.team),
    ipAddress: player.clientIP ?? '',
    currentFlagID: flag ? flag.index : -1,
    currentFlag: type ? `${type.name} (${type.quality === 0 ? '+' : '-'}${type.abbreviation})` : '',
    spawned: player.alive === true,
    lastKnownState: pluginState(player),
    verified: player.verified === true,
    globalUser: player.verified === true,
    bzID: player.bzid ? String(player.bzid) : '',
    admin: isAdmin(player),
    wins: player.wins,
    losses: player.losses,
    teamKills: player.tks,
    clientVersion: player.clientVersion ?? '',
  };
}

// The world's variables as a client is told them: what is set, over the
// defaults loaded plugins registered, which a bzo client may act on before it
// asks -- `_disallowSelfCap` keeps it from asking for a capture the
// ctfOverseer plugin would refuse.
function clientBzdb() {
  return { ...Object.fromEntries(pluginBzdbDefaults), ...Object.fromEntries(liveBzdb) };
}

function bzdbValue(name) {
  return liveBzdb.get(name) ?? worldVariableDefault(name);
}

// The blocks of one custom object in the live map's own text
// (`scanCustomMapObjects`). A generated world has none.
function customMapObjects(name) {
  const file = MAP_SOURCE === 'random' ? null : resolveMapFilePath(MAP_SOURCE);
  if (!file) return [];
  try {
    return scanCustomMapObjects(fs.readFileSync(file, 'utf8'), name);
  } catch {
    return [];
  }
}

// What a plugin's `bz` reaches of the server, by upstream's names
// (include/bzfsAPI.h). Each plugin's own `bz` puts its registrations on top.
const PLUGIN_API = Object.freeze({
  BZ_SERVER, BZ_ALLUSERS, BZ_NULLUSER,
  eNoTeam: -1, eRogueTeam: 0, eRedTeam: 1, eGreenTeam: 2, eBlueTeam: 3, ePurpleTeam: 4,
  eRabbitTeam: 5, eHunterTeam: 6, eObservers: 7, eAdministrators: 8,

  bz_getCurrentTime: () => Date.now() / 1000,
  bz_getPlayerIndexList: () => [...players.values()].filter((player) => player.joined)
    .map((player) => Number(player.id)),
  bz_getPlayerCount: () => [...players.values()].filter((player) => player.joined).length,
  bz_getPlayerByIndex: (id) => {
    const player = players.get(String(id));
    return player?.joined ? pluginRecord(player) : null;
  },
  bz_getPlayerCallsign: (id) => players.get(String(id))?.name ?? null,
  bz_getPlayerTeam: (id) => {
    const player = players.get(String(id));
    return player ? bzTeam(player.team) : -1;
  },

  // bz_sendTextMessage(from, to, message). `to` is a player or BZ_ALLUSERS;
  // `from` is BZ_SERVER or a player. `params` is bzo's: with it, `message` is
  // a msgid with `{name}` slots, which a bzo client shows in its own language
  // (`localized`).
  bz_sendTextMessage: (from, to, message, params) => {
    const src = from === BZ_SERVER ? SERVER_PLAYER : String(from);
    const text = params ? localized(String(message), params) : { text: String(message) };
    const line = { type: 'message', src, msgType: from === BZ_SERVER ? 'server' : 'chat', ...text, ts: Date.now() };
    if (to === BZ_ALLUSERS) {
      broadcastAll({ ...line, dst: ALL_PLAYERS });
      return true;
    }
    const player = players.get(String(to));
    if (!player) return false;
    sendToPlayer(player, { ...line, dst: player.id });
    return true;
  },

  // bz_getTeamCount (bzfsAPI.cxx): players on a team, by bz_eTeamType.
  bz_getTeamCount: (team) => {
    const name = BZ_TEAM_ORDER[team];
    return name ? [...players.values()].filter((player) => player.joined && player.team === name).length : 0;
  },
  // bz_killPlayer(playerID, spawnOnBase, killerID = -1): killed by that
  // player, or by the server when there is none, as a world weapon kills.
  bz_killPlayer: (id, spawnOnBase = false, killerID = -1) => {
    const victim = players.get(String(id));
    if (!victim?.joined || !victim.alive) return false;
    const killer = killerID >= 0 ? players.get(String(killerID)) ?? null : null;
    if (spawnOnBase) victim.restartOnBase = true;
    killPlayer(victim, killer, DEATH_REASON.SHOT, null, killer ? killer.id : WORLD_WEAPON_PLAYER_ID);
    return true;
  },
  // The flag a player holds, by abbreviation, or null.
  bz_getPlayerFlag: (id) => getPlayerFlag(String(id))?.type ?? null,
  bz_getPlayerFlagID: (id) => getPlayerFlag(String(id))?.index ?? -1,
  // Flags by index, as upstream's FlagInfo table numbers them.
  bz_getNumFlags: () => flags.length,
  bz_getFlagName: (index) => flags[index]?.type ?? '',
  bz_flagPlayer: (index) => {
    const owner = flags[index]?.owner;
    return owner === null || owner === undefined ? -1 : Number(owner);
  },
  bz_getFlagPosition: (index) => (flags[index] ? pluginPos(flags[index].position) : null),
  bz_resetFlag: (index) => {
    const flag = flags[index];
    if (!flag) return false;
    resetFlag(flag);
    return true;
  },
  // bz_debugMessage(level, message): logged at level 1 and below, which is
  // what a bzfs run without -d shows of a plugin's own chatter.
  bz_debugMessage: (level, message) => {
    if (level <= 1) log(`[PLUGIN] ${message}`);
  },

  // bz_removePlayerFlag: the flag leaves the tank and goes back to its spawn,
  // as zapFlagByPlayer sends it.
  bz_removePlayerFlag: (id) => {
    const player = players.get(String(id));
    const flag = player?.alive ? getPlayerFlag(player.id) : null;
    if (!flag) return false;
    zapFlag(flag);
    return true;
  },

  // The map's blocks of a custom object, `[{ name, data: [line, ...] }]`, for
  // bz_registerCustomMapObject: what upstream's BZWReader hands a plugin's
  // MapObject while it reads the map. bzo has read it already, so it is read
  // again here for the one name.
  bz_customMapObjects: (name) => customMapObjects(name),

  // bz_setPlayerWins / Losses / TKs and the increments: a plugin's own
  // scoring, sent to every client as the player's record.
  bz_setPlayerWins: (id, value) => setPluginScore(id, 'wins', () => value),
  bz_setPlayerLosses: (id, value) => setPluginScore(id, 'losses', () => value),
  bz_setPlayerTKs: (id, value) => setPluginScore(id, 'tks', () => value),
  bz_incrementPlayerWins: (id, by) => setPluginScore(id, 'wins', (now) => now + by),
  bz_incrementPlayerLosses: (id, by) => setPluginScore(id, 'losses', (now) => now + by),
  bz_incrementPlayerTKs: (id, by) => setPluginScore(id, 'tks', (now) => now + by),

  // bz_RegisterCustomFlag(abbr, name, help, shotType, quality): a flag type
  // of the plugin's own. Its shots are ordinary, as 2.4's are -- the shot
  // type is accepted and not used -- and what it does is the plugin's, on
  // events like bz_eShotFiredEvent. There is no unregistering, as upstream
  // has none: "that would jack up connected clients".
  bz_RegisterCustomFlag: (abbr, name, help, _shotType, quality = 0) => registerPluginFlag(abbr, name, help, quality),
  eGoodFlag: 0,
  eBadFlag: 1,
  // bz_vectorFromRotations(tilt, rotation), in radians: the direction a world
  // weapon points, returned where upstream fills an array.
  bz_vectorFromRotations: (tilt, rotation) => [
    Math.cos(tilt) * Math.cos(rotation), Math.cos(tilt) * Math.sin(rotation), Math.sin(tilt),
  ],

  // bz_fireServerShot(shotType, origin, vector, color = eRogueTeam, target):
  // WorldWeapons::fireShot, with upstream's allow event first. `vector` is a
  // direction, scaled by the shot's speed as upstream scales it, and may be
  // all zeros for a shot that does not travel. A `GM` steers at `target`, a
  // player, if one is named. Returns the shot's id, or 0, upstream's
  // INVALID_SHOT_GUID.
  bz_fireServerShot: (shotType, origin, vector = [0, 0, 0], color = 0, targetPlayerId = -1) => {
    let type = shotType ? String(shotType) : null;
    if (type && !getFlagType(type)) return 0;
    if (!Array.isArray(origin) || origin.length < 3) return 0;
    const team = BZ_TEAM_ORDER[color] ?? WORLD_WEAPON_TEAM;
    const allowed = pluginEvent('bz_eAllowServerShotFiredEvent', () => ({
      flagType: type ?? '', speed: GAME_CONFIG.SHOT_SPEED, pos: [...origin], velocity: [...vector],
      team: color, allow: true, changed: false,
    }));
    if (allowed && !allowed.allow) return 0;
    if (allowed?.changed) {
      type = allowed.flagType || null;
      if (type && !getFlagType(type)) return 0;
    }
    const target = targetPlayerId >= 0 && players.has(String(targetPlayerId)) ? targetPlayerId : null;
    const id = fireServerShot(type, { x: origin[0], y: origin[1], z: origin[2] },
      { x: vector[0] || 0, y: vector[1] || 0, z: vector[2] || 0 }, team, Date.now(), target);
    return Number(id);
  },
  bz_CustomZoneObject: CustomZoneObject,

  bz_BZDBItemExists: (name) => bzdbValue(name) !== undefined,
  bz_getBZDBString: (name) => String(bzdbValue(name) ?? ''),
  bz_getBZDBDouble: (name) => Number(bzdbValue(name) ?? 0),
  bz_getBZDBInt: (name) => Math.trunc(Number(bzdbValue(name) ?? 0)),
  bz_getBZDBBool: (name) => bzdbIsTrue(bzdbValue(name) ?? '0'),
  // bz_registerCustomBZDB* (bzfsAPI.h:1771): the variable exists from now on,
  // with this default, until the server restarts.
  bz_registerCustomBZDBDouble: (name, value) => registerPluginBzdb(name, value),
  bz_registerCustomBZDBInt: (name, value) => registerPluginBzdb(name, Math.trunc(value)),
  bz_registerCustomBZDBBool: (name, value) => registerPluginBzdb(name, value ? 1 : 0),
  bz_registerCustomBZDBString: (name, value) => registerPluginBzdb(name, value),
  bz_removeCustomBZDBVariable: (name) => {
    if (!pluginBzdbDefaults.delete(name)) return false;
    if (!liveBzdb.has(name)) broadcastAll({ type: 'setVar', name, value: null });
    return true;
  },
});

function setPluginScore(id, field, next) {
  const player = players.get(String(id));
  const value = player?.joined ? Math.trunc(Number(next(player[field] || 0))) : NaN;
  if (!Number.isFinite(value)) return false;
  player[field] = value;
  broadcastPlayerRecord('playerUpdated', player);
  return true;
}

// The flag types plugins registered, in the shape MsgFlagType and a bzo
// client's `customFlagTypes` carry.
const pluginFlagTypes = [];

function registerPluginFlag(abbr, name, help, quality) {
  const abbreviation = String(abbr ?? '').trim();
  if (!/^[A-Za-z0-9*]{1,2}$/.test(abbreviation) || getFlagType(abbreviation)) return false;
  const type = {
    abbreviation,
    name: String(name || abbreviation),
    help: String(help || ''),
    quality: quality === 1 ? 1 : 0,
  };
  setCustomFlagTypes([type]);
  pluginFlagTypes.push(type);
  broadcastAll({ type: 'customFlagTypes', types: [type] });
  addPluginZoneFlags(abbreviation);
  log(`[PLUGIN] flag ${abbreviation} "${type.name}" registered`);
  return true;
}

// A map's `zoneflag` of a type nobody knew when the flags were laid out at
// boot, which a plugin has now registered: its slots join the world, as
// upstream's would have had the plugin loaded first.
function addPluginZoneFlags(abbreviation) {
  if (getForbiddenFlags().includes(abbreviation)) return;
  MAP_ZONES.forEach((zone) => {
    const count = zone.unknownFlagCounts?.get(abbreviation) || 0;
    for (let slot = 0; slot < count; slot++) {
      const flag = createFlagSlot(flags.length, null, { requiredType: abbreviation, zoneIndex: zone.index });
      flags.push(flag);
      resetFlag(flag);
    }
  });
}

function registerPluginBzdb(name, value) {
  if (typeof name !== 'string' || !name || BZDB_DEFAULTS[name] !== undefined) return false;
  pluginBzdbDefaults.set(name, String(value));
  if (!liveBzdb.has(name)) broadcastAll({ type: 'setVar', name, value: String(value) });
  return true;
}

// The command list a client completes from, with each command's tier.
function clientCommandList() {
  return [...allServerCommands().values()].map((command) => ({
    name: command.name,
    operator: command.tier === COMMAND_TIER.OPERATOR,
  }));
}

// After `/loadplugin` or `/unloadplugin`: what a client holds that a plugin
// changes -- the commands it completes and the translations it shows -- is
// sent again, where upstream's client has neither to refresh.
function announcePluginChange() {
  players.forEach((player) => {
    if (player.joined) sendPluginsTo(player);
  });
}

// The plugins as one client should see them: the commands it may complete,
// whether each runs, and, for an admin, the Plugins rows.
function sendPluginsTo(player) {
  sendToPlayer(player, {
    type: 'plugins',
    commands: clientCommandList(),
    state: pluginOperatorState(),
    list: isAdmin(player) ? pluginPanelList() : undefined,
  });
}

// The loaded plugins, as `/listplugins` and `/unloadplugin <number>` count
// them.
function loadedPlugins() {
  return plugins.list().filter((entry) => entry.state === 'loaded');
}

// bzfsPlugins.cxx's DynamicPluginCommands, in its words. Loading and
// unloading last until the server restarts, as upstream's do; `server.json`'s
// "plugins" is what a restart reads. bzo's admins hold both of upstream's
// permissions, LISTPLUGINS and PLUGINS.
defineCommand('/listplugins', COMMAND_TIER.OPERATOR,
  '- list the loaded plug-ins',
  (player) => {
    const loaded = loadedPlugins();
    if (loaded.length === 0) {
      replyToPlayer(player, 'No Plug-ins loaded.');
      return;
    }
    replyToPlayer(player, 'Plug-ins loaded:');
    loaded.forEach((entry, index) => replyToPlayer(player, `${index + 1} ${entry.id} ${entry.meta.version}`));
  });

defineCommand('/loadplugin', COMMAND_TIER.OPERATOR,
  '<plug-in>[,<options as JSON>] - load a plug-in until the server restarts',
  (player, args) => {
    const [name, ...rest] = args.trim().split(',');
    if (!name) {
      replyToPlayer(player, 'Usage: /loadplugin plug-in');
      return;
    }
    let config;
    if (rest.length > 0) {
      try {
        config = JSON.parse(rest.join(','));
      } catch {
        replyToPlayer(player, 'Plug-in load failed.');
        return;
      }
    }
    plugins.discover();
    const entry = plugins.load(name.trim(), { config });
    if (entry?.state === 'loaded') {
      log(`[CMD] "${player.name}" loaded plugin ${entry.id}`);
      replyToPlayer(player, 'Plug-in loaded.');
      announcePluginChange();
    } else {
      replyToPlayer(player, 'Plug-in load failed.');
    }
  });

defineCommand('/unloadplugin', COMMAND_TIER.OPERATOR,
  '<plug-in|number> - unload a plug-in until the server restarts',
  (player, args) => {
    let name = args.trim();
    if (!name) {
      replyToPlayer(player, 'Usage: /unloadplugin plug-in');
      return;
    }
    if (/^\d+$/.test(name)) name = loadedPlugins()[Number(name) - 1]?.id ?? name;
    if (plugins.unload(name)) {
      log(`[CMD] "${player.name}" unloaded plugin ${name}`);
      replyToPlayer(player, 'Plug-In {name} unloaded.', { name });
      announcePluginChange();
    } else {
      replyToPlayer(player, 'Plug-in {name} is not loaded.', { name });
    }
  });

// Last, so a plugin's Init finds the whole server defined.
plugins = createPluginHost({
  api: PLUGIN_API,
  dirs: [...new Set([BUNDLED_PLUGINS_DIR, RUNTIME_PLUGINS_DIR])],
  settings: () => serverConfig.plugins,
  log: (text) => log(`[PLUGIN] ${text}`),
});
plugins.loadAll();
l10n.usePluginMessages((locale) => plugins.messages(locale));

// Watch for file changes and auto-reload clients
const publicDir = path.join(__dirname, 'public');
console.log('Watching public/ for changes...');
fs.readdirSync(publicDir).forEach(file => {
  const filePath = path.join(publicDir, file);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    fs.watch(filePath, (eventType, filename) => {
      if (eventType === 'change') {
        console.log(`\n📝 File changed: ${filename || path.basename(filePath)}`);
        console.log('🔄 Reloading all clients...\n');
        forceClientReload();
      }
    });
  }
});

// Watch server.js for changes and restart server if modified
const serverJsPath = path.join(__dirname, 'server.js');
if (fs.existsSync(serverJsPath)) {
  fs.watch(serverJsPath, (eventType, filename) => {
    if (eventType === 'change') {
      console.log(`\n📝 server.js changed: ${filename || path.basename(serverJsPath)}`);
      console.log('🔄 Restarting server...\n');
      requestServerRestart('server.js change');
    }
  });
  console.log(`  ✓ Watching: server.js`);
}
