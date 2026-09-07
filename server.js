/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

const express = require('express');
const logPath = require('path').join(__dirname, 'server.log');
// Clear server.log on restart
require('fs').writeFileSync(logPath, '');
const { WebSocketServer } = require('ws');
const { normalizeShotSlotCount } = require('./server/shots.cjs');
const {
  BASE_SIZE,
  BZFLAG_TANK_RADIUS,
  FLAG_ABBREVIATIONS,
  FLAG_ALTITUDE,
  FLAG_CLEARANCE,
  FLAG_ENDURANCE,
  FLAG_GRAB_LEVEL_TOLERANCE,
  FLAG_RADIUS,
  FLAG_STATUS,
  IDENTIFY_RANGE,
  MAX_FLAG_GRABS,
  DEFAULT_WINGS_JUMP_COUNT,
  DEFAULT_WINGS_SLIDE_TIME,
  SUPER_FLAG_HALF_LIFE_SECONDS,
  ANTIDOTE_PLACEMENT_ATTEMPTS,
  FLAG_GRAB_RADIUS,
  canJump,
  canShakeFlag,
  computeFlagFlight,
  getAntidoteCoordinate,
  hasAirControl,
  normalizeFlagGrabs,
  normalizeShakeTimeout,
  normalizeShakeWins,
  shotRicochets,
  shieldsAgainstShot,
  crushesOnContact,
  killsWholeTeam,
  getRunOverRadius,
  getRunOverSeparation,
  getFlagEndurance,
  getFlagThrownAltitude,
  getFlagType,
  getShotEffects,
  getMotionEffects,
  getAccelerationLimits,
  applyAccelerationLimit,
  getMaxAngVelFactor,
  getMaxSpeedFactor,
  getShockWaveRadius,
  cloaksTheTank,
  getTankDimensionScale,
  getTankHitRadiusScale,
  getTeamFlagAbbreviation,
  isBadFlag,
  isTeamFlag,
  usesNarrowHitBox,
} = require('./server/flags.cjs');
const {
  documentTitle,
  escapeHtml,
  sanitizeHost,
  shortHostName,
} = require('./server/server-name.cjs');
const {
  SHOT_COLLISION_RADIUS,
  findShotObstacle,
  findShotSegmentImpact,
  getBaseTeamAtPoint,
  getBaseTopY,
  getColliderLocalPoint,
  getObstacleHeight,
  getShotObstacleNormal,
  getTankLocalAngle,
  isOverFlatTop,
  pyramidIntersectsCylinder,
  getSegmentBoxHitFraction,
  pyramidIntersectsTank,
  reflectShotDirection,
  TANK_HALF_LENGTH,
  TANK_HEIGHT,
  testOrigRectTank,
  traceShotStep,
  WORLD_WALL_HEIGHT,
} = require('./server/collision.cjs');
const {
  normalizePlayerTeamSelection,
  parseBZWTeamMode,
  resolveTeamMode,
  selectPlayerTeam,
  getPlayerTeamColor,
  getInitialPlayerColor,
  TEAM_SHADE_HUE_SPREAD,
  TEAM_SHADE_HUE_STEP,
  TEAM_SHADE_SAT_SPREAD,
  TEAM_SHADE_LIGHT_SPREAD,
  TEAM_SHADE_MIN_SATURATION,
  isColorTeam,
  isObserverTeam,
  isColorTeamIndex,
  getTeamColorIndex,
  getTeamFromColorIndex,
  getTeamScoreDeltasForCapture,
  getTeamScoreDeltasForKill,
  areFoes,
} = require('./server/teams.cjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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
function computeClientBuild() {
  const hash = crypto.createHash('sha256');
  const hashTree = (root) => {
    const walk = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          hash.update(path.relative(root, full));
          hash.update(fs.readFileSync(full));
        }
      }
    };
    if (fs.existsSync(root)) walk(root);
  };
  hashTree(path.join(__dirname, 'public'));
  hashTree(threeBuildDir);
  return hash.digest('hex').slice(0, 12);
}
const { isHeadsetBrowserUA } = require('./server/headset.cjs');
const {
  DEFAULT_VOICE_CHANNEL,
  areVoicePeers,
  normalizeVoiceChannel,
} = require('./server/voice-channels.cjs');


// Common log function: logs to console and to server.log
function log(...args) {
  const now = new Date();
  const timestamp = now.toISOString();
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const logMsg = `[${timestamp}] ${msg}`;
  // Write to console
  console.log(logMsg);
  // Append to server.log
  fs.appendFileSync(path.join(__dirname, 'server.log'), logMsg + '\n');
}

function logError(...args) {
  const now = new Date();
  const timestamp = now.toISOString();
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const logMsg = `[${timestamp}] [ERROR] ${msg}`;
  console.error(logMsg);
  fs.appendFileSync(path.join(__dirname, 'server.log'), logMsg + '\n');
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = process.env.SERVER_CONFIG_PATH
  ? path.resolve(process.env.SERVER_CONFIG_PATH)
  : path.join(__dirname, 'server.json');
const EXAMPLE_CONFIG_PATH = path.join(__dirname, 'example-server.json');

// Cache policy. Markup, styles and scripts must revalidate on every load: the
// client/server protocol is lockstep, so a client older than the running server
// is a desync, not a stale pixel. Only content that cannot change behaviour --
// textures, models, audio -- is cached without asking. Icons are not among
// them: a launcher captures one at install time and keeps it for the life of
// the installation, so a stale icon outlives every other kind.
const REVALIDATE = 'no-cache';
const ASSET_MAX_AGE = 604800; // 7 days

function setStaticHeaders(res, filePath) {
  if (/\.(?:html|css|js|mjs)$/.test(filePath) || filePath.includes(`${path.sep}icons${path.sep}`)) {
    res.setHeader('Cache-Control', REVALIDATE);
  } else {
    res.setHeader('Cache-Control', `public, max-age=${ASSET_MAX_AGE}`);
  }
}

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

// After threeBuildDir, which it hashes.
const CLIENT_BUILD = computeClientBuild();

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
let indexTemplate = null;
let indexTemplateMtime = 0;

function readIndexTemplate() {
  const { mtimeMs } = fs.statSync(INDEX_PATH);
  if (indexTemplate === null || mtimeMs !== indexTemplateMtime) {
    const html = fs.readFileSync(INDEX_PATH, 'utf8');
    for (const marker of [INDEX_TITLE, INDEX_APPLE_TITLE, INDEX_BUILD]) {
      if (!html.includes(marker)) {
        throw new Error(`public/index.html is missing the marker: ${marker}`);
      }
    }
    indexTemplate = html;
    indexTemplateMtime = mtimeMs;
  }
  return indexTemplate;
}

function renderIndex(host) {
  return readIndexTemplate()
    .replace(INDEX_TITLE, `<title>${escapeHtml(documentTitle(host))}</title>`)
    .replace(
      INDEX_APPLE_TITLE,
      `<meta name="apple-mobile-web-app-title" content="${escapeHtml(shortHostName(host))}">`
    )
    .replace(INDEX_BUILD, `<meta name="bzo-build" content="${CLIENT_BUILD}">`);
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
  res.type('html').send(renderIndex(host));
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

function getAvailableTankModels() {
  const objDir = path.join(__dirname, 'public', 'obj');
  const hiddenModelFiles = new Set(['tank.obj']);
  try {
    return fs.readdirSync(objDir)
      .filter((fileName) => fileName.toLowerCase().endsWith('.obj'))
      .filter((fileName) => !hiddenModelFiles.has(fileName.toLowerCase()))
      .map((fileName) => {
        const id = fileName.slice(0, -4).toLowerCase();
        const label = id === 'bzflag'
          ? 'BZFlag'
          : id === 'wheeled6'
            ? 'Wheeled 6'
            : id
              .split(/[-_\s]+/)
              .filter(Boolean)
              .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
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
  if (normalized === 'tank') return 'bzflag';
  return normalized;
}

app.get('/api/tank-models', (req, res) => {
  res.json({ models: getAvailableTankModels() });
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
    description: serverConfig.description,
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

const server = app.listen(PORT, '::', () => {
  log(`Server running on http://[::]:${PORT}`);
  log(`Client build ${CLIENT_BUILD}`);
});

server.on('error', (err) => {
  logError(`HTTP server error: ${err.message}`);
  process.exit(1);
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on('error', (err) => {
  logError(`WebSocket server error: ${err.message}`);
});

// Game constants
const GAME_CONFIG = {
  MAP_SIZE: 400,
  TANK_SPEED: 25.0, // BZFlag-like default (units per second)
  TANK_ROTATION_SPEED: 0.785398, // BZFlag _tankAngVel default (radians per second)
  REVERSE_SPEED_RATIO: 0.5, // Max reverse speed as fraction of forward speed
  // -a <vel> <rot> upstream: the acceleration limit, zero meaning none, which is
  // upstream's default and so bzo's. See the flags pair for what the numbers
  // mean and why the linear one is scaled by 20.
  LINEAR_ACCELERATION: 0,
  ANGULAR_ACCELERATION: 0,
  SHOT_SPEED: 100, // BZFlag _shotSpeed default (units per second)
  SHOT_RANGE: 350, // BZFlag _shotRange default (world units)
  SHOT_DISTANCE: 350, // Legacy alias for client/radar code
  SHOT_RELOAD_TIME: null, // ms; derived below from BZFlag's _reloadTime / maxShots
  SHOT_COOLDOWN: null, // Legacy alias used by existing client fire gating
  SHOT_MAX_ACTIVE: 1, // BZFlag maxShots default
  SHOT_RADIUS: 0.5, // BZFlag _shotRadius default
  SHOT_TAIL_LENGTH: 4.0, // BZFlag _shotTailLength default
  SHOTS_KEEP_VERTICAL_VELOCITY: false, // BZFlag _shotsKeepVerticalVelocity default
  MAX_SPEED_TOLERANCE: 1.5, // Allow 50% tolerance for latency
  SHOT_POSITION_TOLERANCE: 2, // Max distance shot can be from claimed position
  // cmdPause() counts down five seconds before a pause takes hold, so a tank
  // about to be shot cannot become invulnerable on the frame it is hit.
  PAUSE_COUNTDOWN: 5000, // ms; BZFlag clientCommands.cxx:481
  PAUSE_DROP_TIME: 15000, // ms; BZFlag _pauseDropTime default
  RESPAWN_DELAY: 5000, // ms; BZFlag _explodeTime, which is also its _rejoinTime
  JUMP_VELOCITY: 19, // BZFlag _jumpVelocity default
  GRAVITY: 9.8, // BZFlag _gravity magnitude (units per second squared)
  // Wings' four BZDB variables. Locked upstream, which means the server sets
  // them and the client obeys, so they travel with the rest of the world's
  // physics. The two nulls are upstream's own defaults, which are the strings
  // "_jumpVelocity" and "_gravity" rather than numbers; they are resolved to the
  // world's values below.
  WINGS_JUMP_COUNT: DEFAULT_WINGS_JUMP_COUNT, // BZFlag _wingsJumpCount
  MAX_FLAG_GRABS, // BZFlag _maxFlagGrabs
  WINGS_JUMP_VELOCITY: null, // BZFlag _wingsJumpVelocity; defaults to JUMP_VELOCITY
  WINGS_GRAVITY: null, // BZFlag _wingsGravity magnitude; defaults to GRAVITY
  WINGS_SLIDE_TIME: DEFAULT_WINGS_SLIDE_TIME, // BZFlag _wingsSlideTime
  JUMP_COOLDOWN: 500, // ms between jumps
  FOG_MODE: 'none', // BZFlag _fogMode default
  FOG_DENSITY: 0.001, // BZFlag _fogDensity default
  FOG_START: null, // Defaults to 0.5 * map size like BZFlag
  FOG_END: null, // Defaults to map size like BZFlag
  VOICE_NEARBY_RADIUS: 60, // Maximum distance for the initial Nearby voice channel
};

// WebSocket keep-alive configuration
const WS_PING_INTERVAL = 30000; // Send ping every 30 seconds
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
const BUNDLED_MAPS_DIR = path.join(__dirname, 'maps');
const RUNTIME_MAPS_DIR = process.env.MAPS_PATH
  ? path.resolve(process.env.MAPS_PATH)
  : path.join(path.dirname(configPath), 'maps');

function ensureRuntimeMapsDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    logError(`Could not ensure runtime maps directory at ${dirPath}:`, error);
  }
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

// The most the client's own send interval may widen the acceleration window
// past the gap the server measured between arrivals.
const SDT_JITTER_ALLOWANCE = 0.25;

// Optional gameplay overrides from server config
const configTankSpeed = Number(serverConfig.tankSpeed);
if (Number.isFinite(configTankSpeed) && configTankSpeed > 0) {
  GAME_CONFIG.TANK_SPEED = configTankSpeed;
}

const configTankRotationSpeed = Number(serverConfig.tankRotationSpeed);
if (Number.isFinite(configTankRotationSpeed) && configTankRotationSpeed > 0) {
  GAME_CONFIG.TANK_ROTATION_SPEED = configTankRotationSpeed;
}

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

const configJumpVelocity = Number(serverConfig.jumpVelocity);
if (Number.isFinite(configJumpVelocity) && configJumpVelocity >= 0) {
  GAME_CONFIG.JUMP_VELOCITY = configJumpVelocity;
}

const configGravity = Number(serverConfig.gravity);
if (Number.isFinite(configGravity) && configGravity > 0) {
  GAME_CONFIG.GRAVITY = configGravity;
}

// `?? NaN` because Number(null) is 0, and a config that spells a key out as null
// is asking for the default rather than for zero.
const configWingsJumpCount = Number(serverConfig.wingsJumpCount ?? NaN);
if (Number.isInteger(configWingsJumpCount) && configWingsJumpCount >= 0) {
  GAME_CONFIG.WINGS_JUMP_COUNT = configWingsJumpCount;
}

const configFlagGrabs = Number(serverConfig.maxFlagGrabs ?? NaN);
if (Number.isFinite(configFlagGrabs)) {
  GAME_CONFIG.MAX_FLAG_GRABS = normalizeFlagGrabs(configFlagGrabs);
}

const configWingsJumpVelocity = Number(serverConfig.wingsJumpVelocity ?? NaN);
if (Number.isFinite(configWingsJumpVelocity) && configWingsJumpVelocity >= 0) {
  GAME_CONFIG.WINGS_JUMP_VELOCITY = configWingsJumpVelocity;
}

const configWingsGravity = Number(serverConfig.wingsGravity ?? NaN);
if (Number.isFinite(configWingsGravity) && configWingsGravity > 0) {
  GAME_CONFIG.WINGS_GRAVITY = configWingsGravity;
}

const configWingsSlideTime = Number(serverConfig.wingsSlideTime ?? NaN);
if (Number.isFinite(configWingsSlideTime) && configWingsSlideTime >= 0) {
  GAME_CONFIG.WINGS_SLIDE_TIME = configWingsSlideTime;
}

// _wingsJumpVelocity and _wingsGravity are aliases upstream, so a server that
// says nothing about them gets a wings jump identical to an ordinary one.
if (GAME_CONFIG.WINGS_JUMP_VELOCITY === null) {
  GAME_CONFIG.WINGS_JUMP_VELOCITY = GAME_CONFIG.JUMP_VELOCITY;
}
if (GAME_CONFIG.WINGS_GRAVITY === null) {
  GAME_CONFIG.WINGS_GRAVITY = GAME_CONFIG.GRAVITY;
}

const configShotSpeed = Number(serverConfig.shotSpeed);
if (Number.isFinite(configShotSpeed) && configShotSpeed > 0) {
  GAME_CONFIG.SHOT_SPEED = configShotSpeed;
}

const configShotRange = Number(serverConfig.shotRange);
if (Number.isFinite(configShotRange) && configShotRange > 0) {
  GAME_CONFIG.SHOT_RANGE = configShotRange;
}

const configShotDuration = Number(serverConfig.shotDuration);
if (Number.isFinite(configShotDuration) && configShotDuration > 0) {
  GAME_CONFIG.SHOT_RANGE = GAME_CONFIG.SHOT_SPEED * configShotDuration;
}

const configShotDistance = Number(serverConfig.shotDistance);
if (Number.isFinite(configShotDistance) && configShotDistance > 0) {
  GAME_CONFIG.SHOT_RANGE = configShotDistance;
}

const configShotReloadTime = Number(serverConfig.shotReloadTime);
if (Number.isFinite(configShotReloadTime) && configShotReloadTime > 0) {
  GAME_CONFIG.SHOT_RELOAD_TIME = configShotReloadTime;
}

const configShotCooldown = Number(serverConfig.shotCooldown);
if (Number.isFinite(configShotCooldown) && configShotCooldown > 0) {
  GAME_CONFIG.SHOT_RELOAD_TIME = configShotCooldown;
}

const configShotMaxActive = Number(serverConfig.shotMaxActive);
if (Number.isInteger(configShotMaxActive) && configShotMaxActive > 0) {
  GAME_CONFIG.SHOT_MAX_ACTIVE = normalizeShotSlotCount(configShotMaxActive);
}

const configShotRadius = Number(serverConfig.shotRadius);
if (Number.isFinite(configShotRadius) && configShotRadius > 0) {
  GAME_CONFIG.SHOT_RADIUS = configShotRadius;
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

if (typeof serverConfig.shotsKeepVerticalVelocity === 'boolean') {
  GAME_CONFIG.SHOTS_KEEP_VERTICAL_VELOCITY = serverConfig.shotsKeepVerticalVelocity;
}

GAME_CONFIG.SHOT_DISTANCE = GAME_CONFIG.SHOT_RANGE;

// BZFlag derives both numbers from _reloadTime, which itself defaults to
// _shotRange / _shotSpeed:
//   ShotPath.cxx:48    lifetime = _reloadTime
//   LocalPlayer.cxx:1311  forceReload(_reloadTime / numShots)
// So a shot lives for the full reload time while each slot comes back after
// _reloadTime / maxShots. Firing continuously then sustains exactly maxShots in
// flight. Only derive when the operator has not pinned shotReloadTime, which is
// why the answer to "did they pin it" is taken once, before the first derivation
// fills the field in: a map's `-ms` re-derives from the same basis later.
const SHOT_RELOAD_TIME_PINNED = GAME_CONFIG.SHOT_RELOAD_TIME !== null;
function deriveShotReloadTime() {
  if (!SHOT_RELOAD_TIME_PINNED) {
    const shotLifetimeMs = (GAME_CONFIG.SHOT_RANGE / GAME_CONFIG.SHOT_SPEED) * 1000;
    GAME_CONFIG.SHOT_RELOAD_TIME = shotLifetimeMs / GAME_CONFIG.SHOT_MAX_ACTIVE;
  }
  GAME_CONFIG.SHOT_COOLDOWN = GAME_CONFIG.SHOT_RELOAD_TIME;
}
deriveShotReloadTime();

const validFogModes = new Set(['none', 'linear', 'exp', 'exp2']);
const configFogMode = typeof serverConfig.fogMode === 'string' ? serverConfig.fogMode.trim().toLowerCase() : '';
if (validFogModes.has(configFogMode)) {
  GAME_CONFIG.FOG_MODE = configFogMode;
}

const configFogDensity = Number(serverConfig.fogDensity);
if (Number.isFinite(configFogDensity) && configFogDensity >= 0) {
  GAME_CONFIG.FOG_DENSITY = configFogDensity;
}

const configFogStart = Number(serverConfig.fogStart);
if (Number.isFinite(configFogStart) && configFogStart >= 0) {
  GAME_CONFIG.FOG_START = configFogStart;
}

const configFogEnd = Number(serverConfig.fogEnd);
if (Number.isFinite(configFogEnd) && configFogEnd >= 0) {
  GAME_CONFIG.FOG_END = configFogEnd;
}

if (!Number.isFinite(GAME_CONFIG.FOG_START)) {
  GAME_CONFIG.FOG_START = 0.5 * GAME_CONFIG.MAP_SIZE;
}

if (!Number.isFinite(GAME_CONFIG.FOG_END)) {
  GAME_CONFIG.FOG_END = GAME_CONFIG.MAP_SIZE;
}

log(`Anti-cheat mode: ${ANTICHEAT_CONFIG.mode}`);
log(
  `Gameplay config: tankSpeed=${GAME_CONFIG.TANK_SPEED}, tankRotationSpeed=${GAME_CONFIG.TANK_ROTATION_SPEED}, reverseSpeedRatio=${GAME_CONFIG.REVERSE_SPEED_RATIO}, linearAcceleration=${GAME_CONFIG.LINEAR_ACCELERATION}, angularAcceleration=${GAME_CONFIG.ANGULAR_ACCELERATION}, jumpVelocity=${GAME_CONFIG.JUMP_VELOCITY}, gravity=${GAME_CONFIG.GRAVITY}, shotSpeed=${GAME_CONFIG.SHOT_SPEED}, shotRange=${GAME_CONFIG.SHOT_RANGE}, shotReloadTime=${GAME_CONFIG.SHOT_RELOAD_TIME}ms, shotDuration≈${(GAME_CONFIG.SHOT_RANGE / GAME_CONFIG.SHOT_SPEED).toFixed(2)}s, shotMaxActive=${GAME_CONFIG.SHOT_MAX_ACTIVE}, shotRadius=${GAME_CONFIG.SHOT_RADIUS}, shotTailLength=${GAME_CONFIG.SHOT_TAIL_LENGTH}, shotsKeepVerticalVelocity=${GAME_CONFIG.SHOTS_KEEP_VERTICAL_VELOCITY}`
);
log(
  `Fog config: mode=${GAME_CONFIG.FOG_MODE}, density=${GAME_CONFIG.FOG_DENSITY}, start=${GAME_CONFIG.FOG_START}, end=${GAME_CONFIG.FOG_END}, color=time-of-day`
);
log(`Voice config: nearbyRadius=${GAME_CONFIG.VOICE_NEARBY_RADIUS}`);
log(`Voice ICE config: ${VOICE_ICE_SERVERS.length} server entr${VOICE_ICE_SERVERS.length === 1 ? 'y' : 'ies'}`);
log(`Map directories: runtime=${RUNTIME_MAPS_DIR}, bundled=${BUNDLED_MAPS_DIR}`);
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
          console.log(`\n📝 Map file changed: ${filename || mapPath}`);
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
function parseBZWServerOptions(lines) {
  let inOptions = false;
  // Every other field is left absent unless the map names it. `forbiddenFlags`
  // is the exception because `-f` may appear any number of times, and an empty
  // list says the same thing as no list.
  const options = { forbiddenFlags: [], unreadBZDBVars: [], serverMessages: [] };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (!inOptions) {
      if (line === 'options') inOptions = true;
      continue;
    }
    if (line === 'end') {
      inOptions = false;
      continue;
    }
    const [option, value, setValue] = line.split(/\s+/);
    // -fb: superflags may come to rest on buildings, and may spawn on them.
    if (option === '-fb') options.flagsOnBuildings = true;
    // -j: tanks may jump. bzo already defaults this on, so the switch only
    // matters on a server whose config has turned jumping off.
    if (option === '-j') options.jumping = true;
    // +r: every shot ricochets, whatever flag fired it.
    if (option === '+r') options.ricochet = true;
    // -st <seconds>: how long a bad flag sticks before it shakes off, and -sw
    // <kills>: how many wins shake one off. Both take a value.
    if (option === '-st') options.flagShakeTimeout = normalizeShakeTimeout(value);
    if (option === '-sw') options.flagShakeWins = normalizeShakeWins(value);
    // -sa: put an antidote flag in the world for whoever is carrying a bad one.
    if (option === '-sa') options.antidoteFlags = true;
    // -a <vel> <rot>: the world's acceleration limit, upstream's inertia switch.
    // The only option here that takes two values, which is why it reads
    // `setValue` as well.
    if (option === '-a') {
      const linear = Number(value);
      const angular = Number(setValue);
      if (Number.isFinite(linear)) options.linearAcceleration = Math.max(0, linear);
      if (Number.isFinite(angular)) options.angularAcceleration = Math.max(0, angular);
    }
    // -noTeamKills: "Players on the same team are immune to each other's shots.
    // Rogue is excepted." Friendly fire off, which upstream enforces on each
    // client in LocalPlayer::checkHit; bzo's server decides every hit, so it
    // enforces it in the one place instead.
    if (option === '-noTeamKills') options.noTeamKills = true;
    // -tk: "player does not die when killing a teammate". Note which way round
    // this runs -- upstream kills a team killer *by default*, and the switch is
    // what turns that off, so `-tk` is the lenient setting rather than the
    // strict one.
    if (option === '-tk') options.teamKillerDies = false;
    // -ms <count>: how many shots a tank may have in the air at once. Unlike the
    // switches above this carries a value, and upstream parses a map's options
    // where `-world` sits on the command line, so the map's number simply
    // replaces whatever came before it rather than only ever raising it.
    // A count of 0 means "tanks cannot shoot" upstream; bzo has no such mode, so
    // normalizeShotSlotCount clamps it to one shot as it clamps the config.
    if (option === '-ms') {
      const requestedShots = Number(value);
      if (Number.isFinite(requestedShots)) {
        options.shotMaxActive = normalizeShotSlotCount(Math.round(requestedShots));
      }
    }
    // -s <count>, and +s <count>: how many superflag slots the world holds,
    // upstream's numExtraFlags. The count is optional and anything that is not a
    // positive number means 16, which is upstream's own reading -- `atoi` gives 0
    // for a missing or unparseable count and 0 is turned into 16 outright, so
    // even `-s 0` is sixteen flags rather than none.
    //
    // `+s` additionally marks every slot `required`, so upstream keeps all of
    // them in the world at all times where `-s` lets a slot sit empty between
    // insertions. bzo has only the one behaviour -- a slot refills on the
    // insertion schedule -- so both spellings land in the same place.
    if (option === '-s' || option === '+s') {
      const requestedFlags = Math.round(Number(value));
      options.superFlagCount = Number.isFinite(requestedFlags) && requestedFlags > 0
        ? requestedFlags
        : 16;
    }
    // -f <abbreviation|good|bad>: take a flag type out of the pool a slot draws
    // from, upstream's flagDisallowed table. Disallows accumulate and nothing
    // puts one back, so this is a switch like the rest even though it names its
    // target. A type bzo does not implement is already absent from the pool, so
    // naming one is not an error -- it asks for nothing that was there.
    if (option === '-f' && value) {
      const disallowed = value.trim().toUpperCase();
      const disallowedQuality = disallowed === 'GOOD' || disallowed === 'BAD'
        ? disallowed === 'BAD'
        : null;
      for (const abbreviation of FLAG_ABBREVIATIONS) {
        if (isTeamFlag(abbreviation)) continue;
        const matches = disallowedQuality === null
          ? abbreviation === disallowed
          : isBadFlag(abbreviation) === disallowedQuality;
        if (matches && !options.forbiddenFlags.includes(abbreviation)) {
          options.forbiddenFlags.push(abbreviation);
        }
      }
    }
    // -srvmsg <text>: a line said to each player as they join. Upstream
    // accumulates every occurrence into one string separated by a literal `\n`
    // and splits it again on the way out (bzfs.cxx:2507), so a map may write
    // several lines either way -- one option each, or one option carrying `\n`.
    // The quotes a map wraps the text in are the option parser's, not the text's.
    if (option === '-srvmsg') {
      // Taken off the raw line rather than from the split tokens, because the
      // text's own spacing is part of it -- upstream's parseWorldOptions reads a
      // quoted argument as one token and never touches what is inside it.
      const rest = line.replace(/^\S+\s*/, '');
      const quoted = rest.match(/^"([\s\S]*)"$/);
      const text = quoted ? quoted[1] : rest;
      for (const messageLine of text.split('\\n')) options.serverMessages.push(messageLine);
    }
    // -set <variable> <value>: a BZDB assignment. bzo's world constants are
    // constants, so the only variable it can honour is one it already keeps a
    // configurable copy of. Every other name is collected and reported, because
    // a map that sets `_tankSpeed` and is quietly played at bzo's is worse than
    // a map that says so on load.
    if (option === '-set' && value) {
      if (value === '_maxFlagGrabs') {
        const grabs = Number(setValue);
        if (Number.isFinite(grabs)) options.maxFlagGrabs = normalizeFlagGrabs(grabs);
      } else if (value === '_wingsJumpCount') {
        // How many flaps `WG` Wings carries. Zero is meaningful -- a wings tank
        // that cannot flap -- so the floor is 0 rather than 1, which is also
        // what `wingsJumpCount` in server.json accepts.
        const flaps = Number(setValue);
        if (Number.isFinite(flaps) && Math.round(flaps) >= 0) {
          options.wingsJumpCount = Math.round(flaps);
        }
      } else {
        options.unreadBZDBVars.push(value);
      }
    }
  }

  return options;
}

// Parse a BZW file and convert to obstacle format
// WorldFileObstacle::read. Four bare keywords, no arguments and matched without
// regard to case as upstream's strcasecmp does, that say who an obstacle is solid
// to. `passable` is the pair of the first two together, and `ricochet` bounces
// even an ordinary shot -- upstream's third source of a bounce, after the world
// switch and the Ricochet flag.
//
// Every obstacle upstream reads inherits these, so a box, a pyramid, a base and
// a teleporter all take them, and so do bzo's.
// CustomGate's constructor defaults, in bzo's terms: BZW states half extents in
// x and y and a full height in z, so the half width 0.56 and half breadth 4.48
// double, and the height 2 * _teleportHeight carries over as it is.
const BZW_TELEPORTER_DEFAULTS = Object.freeze({
  w: 2 * 0.56,
  d: 2 * 4.48,
  h: 2 * 10.08,
  border: 2 * 0.56,
});

const BZW_PASSABILITY_KEYWORDS = new Map([
  ['drivethrough', { driveThrough: true }],
  ['shootthrough', { shootThrough: true }],
  ['passable', { driveThrough: true, shootThrough: true }],
  ['ricochet', { ricochet: true }],
]);

function parseBZWMap(filename) {
  const text = fs.readFileSync(filename, 'utf8');
  const lines = text.split(/\r?\n/);
  const teamMode = parseBZWTeamMode(lines);
  const serverOptions = parseBZWServerOptions(lines);
  const obstacles = [];
  const teleporters = [];
  const parsedLinks = [];
  const zones = [];
  let current = null;
  let currentLink = null;
  let currentZone = null;
  // Which zone keywords a map asked for that bzo does not act on, gathered so
  // the load can say so once rather than for every zone. `zone` blocks are
  // otherwise the one place a map states something invisible: a spawn zone that
  // is skipped moves every tank in the world.
  const unreadZoneKeywords = new Set();

  function getTeleporterEndpointName(teleporter, face) {
    return `${teleporter.linkName}:${face === 0 ? 'f' : 'b'}`;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function globMatch(pattern, candidate) {
    const source = `^${escapeRegExp(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`;
    return new RegExp(source, 'i').test(candidate);
  }

  function normalizeEndpointPattern(value) {
    if (typeof value !== 'string') return '';
    let endpoint = value.trim();
    if (!endpoint) return '';
    if (endpoint.startsWith(':')) {
      endpoint = endpoint.slice(1);
    }
    const last = endpoint.slice(-1);
    if (last === 'F' || last === 'B') {
      endpoint = `${endpoint.slice(0, -1)}${last.toLowerCase()}`;
    }
    return endpoint;
  }

  function resolveNumericFace(faceId) {
    if (!Number.isInteger(faceId) || faceId < 0 || faceId >= teleporters.length * 2) {
      return [];
    }
    return [faceId];
  }

  function resolveNamedFaces(pattern) {
    const normalizedPattern = normalizeEndpointPattern(pattern);
    if (!normalizedPattern) return [];
    const matches = [];
    for (const teleporter of teleporters) {
      const frontName = getTeleporterEndpointName(teleporter, 0);
      const backName = getTeleporterEndpointName(teleporter, 1);
      if (globMatch(normalizedPattern, frontName)) {
        matches.push(teleporter.teleporterIndex * 2);
      }
      if (globMatch(normalizedPattern, backName)) {
        matches.push(teleporter.teleporterIndex * 2 + 1);
      }
    }
    return matches;
  }

  function resolveEndpointFaces(endpoint) {
    if (!endpoint || typeof endpoint.value !== 'string') return [];
    if (endpoint.kind === 'numeric') {
      return resolveNumericFace(endpoint.faceId);
    }
    return resolveNamedFaces(endpoint.value);
  }

  function parseLinkEndpoint(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      return {
        kind: 'numeric',
        value: raw,
        faceId: parseInt(raw, 10),
      };
    }
    return {
      kind: 'named',
      value: raw,
      pattern: normalizeEndpointPattern(raw),
    };
  }

  function faceIdToEndpoint(faceId) {
    const teleporterIndex = Math.floor(faceId / 2);
    const face = faceId % 2;
    const teleporter = teleporters[teleporterIndex];
    if (!teleporter) return null;
    return {
      faceId,
      teleporterIndex,
      face,
      endpoint: getTeleporterEndpointName(teleporter, face),
    };
  }

  function buildTeleporterLinks() {
    const linksBySource = new Map();

    for (const link of parsedLinks) {
      const srcFaces = resolveEndpointFaces(link.from);
      const dstFaces = resolveEndpointFaces(link.to);

      if (!srcFaces.length || !dstFaces.length) {
        log(`Ignoring broken teleporter link from "${link.from?.value || ''}" to "${link.to?.value || ''}" in ${filename}`);
        continue;
      }

      for (const sourceFaceId of srcFaces) {
        if (!linksBySource.has(sourceFaceId)) {
          linksBySource.set(sourceFaceId, new Set());
        }
        const destinationSet = linksBySource.get(sourceFaceId);
        for (const destFaceId of dstFaces) {
          destinationSet.add(destFaceId);
        }
      }
    }

    // Match BZFlag link behavior: any unlinked source face defaults to
    // passing through to the opposite face on the same teleporter.
    for (let sourceFaceId = 0; sourceFaceId < teleporters.length * 2; sourceFaceId++) {
      if (!linksBySource.has(sourceFaceId) || linksBySource.get(sourceFaceId).size === 0) {
        const oppositeFaceId = (Math.floor(sourceFaceId / 2) * 2) + (1 - (sourceFaceId % 2));
        linksBySource.set(sourceFaceId, new Set([oppositeFaceId]));
      }
    }

    const normalizedLinks = [];
    for (const [sourceFaceId, destinationSet] of linksBySource.entries()) {
      const source = faceIdToEndpoint(sourceFaceId);
      if (!source) continue;

      for (const destFaceId of destinationSet) {
        const destination = faceIdToEndpoint(destFaceId);
        if (!destination) continue;

        normalizedLinks.push({
          sourceFaceId,
          sourceEndpoint: source.endpoint,
          sourceTeleporter: source.teleporterIndex,
          sourceFace: source.face,
          destFaceId,
          destEndpoint: destination.endpoint,
          destTeleporter: destination.teleporterIndex,
          destFace: destination.face,
        });
      }
    }

    normalizedLinks.sort((a, b) => {
      if (a.sourceFaceId !== b.sourceFaceId) return a.sourceFaceId - b.sourceFaceId;
      return a.destFaceId - b.destFaceId;
    });

    return {
      teleporters: teleporters.map((teleporter) => ({
        teleporterIndex: teleporter.teleporterIndex,
        name: teleporter.linkName,
        obstacleName: teleporter.obstacle.name,
        frontFaceId: teleporter.teleporterIndex * 2,
        backFaceId: teleporter.teleporterIndex * 2 + 1,
        frontEndpoint: `${teleporter.linkName}:f`,
        backEndpoint: `${teleporter.linkName}:b`,
      })),
      links: normalizedLinks,
    };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    // Every keyword upstream reads it reads with strcasecmp, and it reads the
    // first whitespace-delimited token rather than a prefix of the line -- so
    // `Position` is a position and `basey` is not a base.
    const token = line.split(/\s+/)[0].toLowerCase();

    if (currentLink && token === 'end') {
      if (currentLink.from && currentLink.to) {
        parsedLinks.push(currentLink);
      } else {
        log(`Ignoring incomplete link block in ${filename}`);
      }
      currentLink = null;
      continue;
    }

    if (currentLink && token === 'from') {
      const [, ...fromParts] = line.split(/\s+/);
      currentLink.from = parseLinkEndpoint(fromParts.join(' ').replace(/"/g, '').trim());
      continue;
    }

    if (currentLink && token === 'to') {
      const [, ...toParts] = line.split(/\s+/);
      currentLink.to = parseLinkEndpoint(toParts.join(' ').replace(/"/g, '').trim());
      continue;
    }

    if (!current && token === 'link') {
      currentLink = { from: null, to: null };
      continue;
    }

    // CustomZone. A zone is not an obstacle -- nothing collides with it and
    // nothing draws it -- so it goes to its own list rather than through
    // `current`. Upstream ships zones to clients only so the client's
    // `World::writeWorld` can write the map back out; no gameplay on either side
    // reads them, so bzo keeps them on the server and sends nothing.
    if (currentZone) {
      if (token === 'end') {
        currentZone.index = zones.length;
        zones.push(currentZone);
        currentZone = null;
        continue;
      }
      if (token === 'position' || token === 'pos') {
        const [, x, y, z] = line.split(/\s+/);
        currentZone.x = parseFloat(x) || 0;
        currentZone.z = -(parseFloat(y) || 0);
        currentZone.y = parseFloat(z) || 0;
        continue;
      }
      if (token === 'size') {
        // Half extents in BZW's own x/y, kept in those axes because
        // getRandomZonePoint rotates the offset the way upstream does and
        // converts only the result.
        const [, x, y] = line.split(/\s+/);
        currentZone.halfWidth = Math.abs(parseFloat(x) || 0);
        currentZone.halfDepth = Math.abs(parseFloat(y) || 0);
        continue;
      }
      if (token === 'rotation' || token === 'rot') {
        // Left in BZW's frame -- degrees counter-clockwise about +Z -- for the
        // same reason the size is.
        const [, deg] = line.split(/\s+/);
        currentZone.rotation = (parseFloat(deg) || 0) * Math.PI / 180;
        continue;
      }
      if (token === 'zoneflag') {
        // zoneflag <abbreviation|good|bad> [count]. The count is optional and
        // upstream defaults it to 1 when it does not parse; a count given as 0
        // really does mean none. Repeats accumulate, as addZoneFlagCount does.
        const [, requested, rawCount] = line.split(/\s+/);
        if (!requested) continue;
        const parsedCount = Number(rawCount);
        const count = Number.isFinite(parsedCount) ? Math.max(0, Math.round(parsedCount)) : 1;
        const wanted = requested.trim().toUpperCase();
        const wantedQuality = wanted === 'GOOD' || wanted === 'BAD' ? wanted === 'BAD' : null;
        for (const abbreviation of FLAG_ABBREVIATIONS) {
          if (isTeamFlag(abbreviation)) continue;
          const matches = wantedQuality === null
            ? abbreviation === wanted
            : isBadFlag(abbreviation) === wantedQuality;
          if (!matches) continue;
          currentZone.flagCounts.set(
            abbreviation,
            (currentZone.flagCounts.get(abbreviation) || 0) + count
          );
        }
        // A type bzo does not implement is counted so the load can say how much
        // of the map it left out, which for a flag test map is most of it.
        if (wantedQuality === null && !getFlagType(wanted)) {
          currentZone.unknownFlags.add(wanted);
        }
        continue;
      }
      // `flag`, `team` and `safety` are the rest of CustomZone::read: a spawn
      // area for a team, a safety spot for a Phantom Zone tank, and a zone that
      // any flag of a named type spawns in. None are read yet.
      if (token === 'flag' || token === 'team' || token === 'safety') {
        unreadZoneKeywords.add(token);
        continue;
      }
      continue;
    }

    if (!current && !currentLink && token === 'zone') {
      currentZone = {
        index: zones.length,
        x: 0,
        y: 0,
        z: 0,
        halfWidth: 0,
        halfDepth: 0,
        rotation: 0,
        flagCounts: new Map(),
        unknownFlags: new Set(),
      };
      continue;
    }

    if (token === 'world') {
      // Look ahead for size
      for (let j = i + 1; j < lines.length; j++) {
        const wline = lines[j].trim();
        if (wline.split(/\s+/)[0].toLowerCase() === 'size') {
          const [, size] = wline.split(/\s+/);
          if (size) {
            GAME_CONFIG.MAP_SIZE = parseFloat(size) * 2;
          }
          break;
        }
        if (wline.toLowerCase() === 'end') break;
      }
    } else if (token === 'box') {
      current = { type: 'box' };
    } else if (token === 'pyramid') {
      current = { type: 'pyramid' };
    } else if (token === 'base') {
      current = { type: 'box', kind: 'base', team: 1 };
    } else if (token === 'teleporter') {
      current = { type: 'box', kind: 'teleporter' };
      const [, ...teleporterNameParts] = line.split(/\s+/);
      const inlineTeleporterName = teleporterNameParts.join(' ').replace(/"/g, '').trim();
      if (inlineTeleporterName) {
        current.name = inlineTeleporterName;
      }
    } else if (current && BZW_PASSABILITY_KEYWORDS.has(token)) {
      Object.assign(current, BZW_PASSABILITY_KEYWORDS.get(token));
    } else if (current && token === 'name') {
      // name <string>
      const [, ...nameParts] = line.split(/\s+/);
      const name = nameParts.join(' ').replace(/"/g, '').trim();
      if (name) current.name = name;
    } else if (current && (token === 'position' || token === 'pos')) {
      // position x y z, or its `pos` alias (WorldFileLocation::read).
      // BZFlag +Y north maps to our -Z north.
      const [, x, y, z] = line.split(/\s+/);
      current.x = parseFloat(x);
      current.z = -parseFloat(y); // BZFlag +Y (north) -> our -Z (north)
      current.baseY = parseFloat(z) || 0;
    } else if (current && token === 'size') {
      // size w d h (BZFlag x/y are center-to-edge half extents, z is full height)
      const [, w, d, h] = line.split(/\s+/);
      const rawW = parseFloat(w);
      const rawD = parseFloat(d);
      const rawH = parseFloat(h);
      current.w = Math.abs(rawW) * 2;
      current.d = Math.abs(rawD) * 2;
      current.h = Math.abs(rawH);
      if (current.type === 'pyramid') {
        // A negative height is upstream's ZFlip, and `flipz` says the same thing
        // outright. Either may come first, so neither clears the other.
        current.inverted = rawH < 0 || current.inverted === true;
      }
    } else if (current && (token === 'rotation' || token === 'rot')) {
      // BZFlag rotation is CCW around +Z; our world maps BZFlag +Y (north) to -Z,
      // which flips the depth axis. The correct conversion is +deg + π.
      const [, deg] = line.split(/\s+/);
      current.rotation = (parseFloat(deg) || 0) * Math.PI / 180 + Math.PI;
    } else if (current && current.type === 'pyramid' && token === 'flipz') {
      current.inverted = true;
    } else if (current && token === 'border') {
      const [, border] = line.split(/\s+/);
      current.border = Math.abs(parseFloat(border) || 0);
    } else if (current && current.kind === 'base' && token === 'color') {
      const [, color] = line.split(/\s+/);
      const team = parseInt(color, 10);
      current.team = Number.isInteger(team) ? Math.max(1, Math.min(4, team)) : 1;
    } else if (current && token === 'end') {
      // Use BZW name if present, otherwise assign a generated name
      if (!current.name) {
        if (current.kind === 'teleporter') {
          current.name = `t${teleporters.length}`;
        } else {
          current.name = `${current.type[0].toUpperCase()}${obstacles.length}`;
        }
      }

      if (current.kind === 'teleporter') {
        // CustomGate's constructor, for a teleporter that gave no size or
        // border of its own: half width 0.5 * _teleportWidth, half breadth
        // _teleportBreadth, height 2 * _teleportHeight, and a border twice the
        // half width. Filled in here rather than left to each reader, because a
        // dimension left undefined is not a small teleporter -- it is NaN, and
        // testOrigRectRect answers "overlapping" for a NaN half extent, since
        // every comparison against NaN is false and the corner is classified
        // into the obstacle. One sizeless obstacle then supports a tank
        // anywhere in the world.
        if (!Number.isFinite(current.w)) current.w = BZW_TELEPORTER_DEFAULTS.w;
        if (!Number.isFinite(current.d)) current.d = BZW_TELEPORTER_DEFAULTS.d;
        if (!Number.isFinite(current.h)) current.h = BZW_TELEPORTER_DEFAULTS.h;
        if (!Number.isFinite(current.border)) current.border = BZW_TELEPORTER_DEFAULTS.border;
        // Teleporter::finalize (Teleporter.cxx). The border grows the solid --
        // `size[1] = origSize[1] + border * 2`, `size[2] = origSize[2] + border`
        // -- and those grown values *are* the obstacle's extents, so they are
        // what collides, what supports a tank and what is drawn.
        //
        // Applied here, once, so `w`/`d`/`h` on a teleporter mean the same thing
        // they mean on a box: the solid. Three separate readers each open-coded
        // this and two of them got it wrong, because the stated size is the hole
        // rather than the frame and reading it directly is the easy mistake.
        // getShotTeleporterDims is now a reader rather than a calculator.
        const statedBorder = Math.max(0.12, current.border);
        const statedHalfWidth = Math.max(0.25, current.w / 2);
        const statedHalfBreadth = Math.max(0.25, current.d / 2);
        const statedHeight = Math.max(1.0, current.h);
        current.border = statedBorder;
        // Upstream takes the larger of the border half-width and the stated
        // width for the x extent, which is its own line in finalize().
        current.w = Math.max(statedBorder * 0.5, statedHalfWidth) * 2;
        current.d = (statedHalfBreadth + (statedBorder * 2)) * 2;
        current.h = statedHeight + statedBorder;
        const teleporterIndex = teleporters.length;
        const linkName = current.name || `teleporter_${teleporterIndex}`;
        current.teleporterIndex = teleporterIndex;
        current.linkName = linkName;
        teleporters.push({
          teleporterIndex,
          linkName,
          obstacle: current,
        });
      }

      obstacles.push(current);
      current = null;
    }
  }

  if (unreadZoneKeywords.size > 0) {
    log(
      `Ignoring zone keywords bzo does not read in ${filename}:`
      + ` ${Array.from(unreadZoneKeywords).sort().join(', ')}`
    );
  }

  const teleporterGraph = buildTeleporterLinks();
  return {
    obstacles,
    teleporterGraph,
    teamMode,
    serverOptions,
    zones,
  };
}

// Generate random obstacles on server start
function generateObstacles() {
  const obstacles = [];
  GAME_CONFIG.MAP_SIZE = 100;
  const mapSize = GAME_CONFIG.MAP_SIZE;
  const numBoxes = Math.floor(mapSize * mapSize / 2000 + Math.random() * 3);
  const numPyramids = Math.floor(numBoxes / 2);
  const minDistance = 15; // Minimum distance from center and other obstacles

  // Helper to check overlap for both types
  function isTooClose(x, z, w, d, others) {
    for (const other of others) {
      const dist = Math.sqrt(Math.pow(x - other.x, 2) + Math.pow(z - other.z, 2));
      if (dist < (w + other.w) / 2 + minDistance) {
        return true;
      }
    }
    return false;
  }

  // Place one obstacle at random, retrying until it clears the centre and every
  // obstacle already placed. Boxes and pyramids differ only in what is built.
  function placeObstacles(count, build) {
    for (let i = 0; i < count; i++) {
      for (let attempts = 0; attempts < 50; attempts++) {
        const x = (Math.random() - 0.5) * (mapSize * 0.8);
        const z = (Math.random() - 0.5) * (mapSize * 0.8);
        const w = 6 + Math.random() * 6;
        const d = 6 + Math.random() * 6;

        if (Math.sqrt(x * x + z * z) < minDistance) continue;
        if (isTooClose(x, z, w, d, obstacles)) continue;

        // Most sit on the ground; the rest float, leaving a gap to drive under.
        const grounded = Math.random() < 0.6;
        const h = grounded ? 4 + Math.random() * 4 : 3 + Math.random() * 2;
        const baseY = grounded ? 0 : 3 + Math.random() * 3;

        obstacles.push(build({ x, z, w, d, h, baseY, rotation: Math.random() * Math.PI * 2 }, i));
        break;
      }
    }
  }

  placeObstacles(numBoxes, (shape, i) => ({ ...shape, name: `O${i}`, type: 'box' }));
  placeObstacles(numPyramids, (shape, i) => ({
    ...shape,
    name: `P${i}`,
    type: 'pyramid',
    inverted: Math.random() < 0.2, // 20% chance for random inverted pyramid
  }));

  return obstacles;
}

let OBSTACLES;
let TELEPORTER_GRAPH = { teleporters: [], links: [] };
let mapTeamMode = null;
let mapServerOptions = {};
// The map's `zone` blocks, in map order, so a flag slot can name the one it
// belongs to by index the way upstream's `#<flagId>` qualifier does.
let MAP_ZONES = [];
if (MAP_SOURCE === 'random') {
  OBSTACLES = generateObstacles();
  TELEPORTER_GRAPH = { teleporters: [], links: [] };
  log(`Generated ${OBSTACLES.length} random obstacles`);
} else {
  const mapData = parseBZWMap(mapPath);
  OBSTACLES = mapData.obstacles;
  TELEPORTER_GRAPH = mapData.teleporterGraph;
  mapTeamMode = mapData.teamMode;
  mapServerOptions = mapData.serverOptions;
  MAP_ZONES = mapData.zones;
  log(`Loaded ${OBSTACLES.length} obstacles from ${mapPath}`);
  log(`Loaded ${TELEPORTER_GRAPH.links.length} teleporter face links from ${mapPath}`);
  if (MAP_ZONES.length > 0) log(`Loaded ${MAP_ZONES.length} zones from ${mapPath}`);
}
// -ms upstream. The map is read after the shot config above, so its shot slot
// count lands here, and the reload time is derived a second time from it -- each
// slot comes back after _reloadTime / maxShots, so changing one without the
// other would leave a tank reloading at the wrong rate.
if (Number.isInteger(mapServerOptions.shotMaxActive)
  && mapServerOptions.shotMaxActive !== GAME_CONFIG.SHOT_MAX_ACTIVE) {
  const previousShotMaxActive = GAME_CONFIG.SHOT_MAX_ACTIVE;
  GAME_CONFIG.SHOT_MAX_ACTIVE = mapServerOptions.shotMaxActive;
  deriveShotReloadTime();
  log(
    `Map option -ms: shotMaxActive=${GAME_CONFIG.SHOT_MAX_ACTIVE} (was ${previousShotMaxActive}), `
    + `shotReloadTime=${GAME_CONFIG.SHOT_RELOAD_TIME}ms`
  );
}
// -set _maxFlagGrabs upstream. A plain BZDB assignment, so as with `-ms` the
// map's number replaces the config's rather than only raising it. It is read on
// every grab (FlagInfo.cxx:137) and spent on every drop, so the server is the
// only thing that acts on it -- but it rides `GAME_CONFIG` into the `init`
// payload anyway, which is bzo's equivalent of upstream shipping every BZDB var
// to clients whether the client reads it or not.
if (Number.isInteger(mapServerOptions.maxFlagGrabs)
  && mapServerOptions.maxFlagGrabs !== GAME_CONFIG.MAX_FLAG_GRABS) {
  const previousFlagGrabs = GAME_CONFIG.MAX_FLAG_GRABS;
  GAME_CONFIG.MAX_FLAG_GRABS = mapServerOptions.maxFlagGrabs;
  log(`Map option -set _maxFlagGrabs: ${GAME_CONFIG.MAX_FLAG_GRABS} (was ${previousFlagGrabs})`);
}
// -set _wingsJumpCount upstream, and the same assignment rule as the rest: the
// map's number replaces the config's. It rides GAME_CONFIG to the client, which
// is what refills the flaps on landing.
if (Number.isInteger(mapServerOptions.wingsJumpCount)
  && mapServerOptions.wingsJumpCount !== GAME_CONFIG.WINGS_JUMP_COUNT) {
  const previousFlaps = GAME_CONFIG.WINGS_JUMP_COUNT;
  GAME_CONFIG.WINGS_JUMP_COUNT = mapServerOptions.wingsJumpCount;
  log(`Map option -set _wingsJumpCount: ${GAME_CONFIG.WINGS_JUMP_COUNT} (was ${previousFlaps})`);
}
if (mapServerOptions.unreadBZDBVars?.length > 0) {
  log(
    `Ignoring -set variables bzo does not read:`
    + ` ${Array.from(new Set(mapServerOptions.unreadBZDBVars)).sort().join(', ')}`
  );
}
const configuredMaxPlayers = Number(serverConfig.maxPlayers);
const defaultTeamLimit = Number.isInteger(configuredMaxPlayers) && configuredMaxPlayers > 0
  ? configuredMaxPlayers
  : 16;
const TEAM_MODE = resolveTeamMode(serverConfig.teamMode, mapTeamMode, defaultTeamLimit);
log(`Team mode: ${TEAM_MODE.enabled ? 'enabled' : 'disabled'}; autoTeam=${TEAM_MODE.autoTeam}; teams=${TEAM_MODE.teams.map((team) => `${team}:${TEAM_MODE.limits[team]}`).join(',')}`);

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
}

function recordTeamScoreForKill(killer, victim) {
  if (!TEAM_MODE.enabled || !victim) return;
  const deltas = getTeamScoreDeltasForKill(killer?.team, victim.team, killer?.id === victim.id);
  if (!deltas.length) return;
  for (const delta of deltas) {
    const score = getTeamScore(delta.team);
    score.wins += delta.wins;
    score.losses += delta.losses;
  }
  broadcastTeamScores();
}
log(OBSTACLES);

let TELEPORTER_OBSTACLES_BY_INDEX = new Map();
let TELEPORTER_LINKS_BY_SOURCE_FACE = new Map();

function rebuildTeleporterRuntimeState() {
  TELEPORTER_OBSTACLES_BY_INDEX = new Map();
  TELEPORTER_LINKS_BY_SOURCE_FACE = new Map();

  for (const obs of OBSTACLES) {
    if (obs?.kind !== 'teleporter') continue;
    if (!Number.isInteger(obs.teleporterIndex)) continue;
    TELEPORTER_OBSTACLES_BY_INDEX.set(obs.teleporterIndex, obs);
  }

  for (const link of TELEPORTER_GRAPH.links || []) {
    if (!Number.isInteger(link?.sourceFaceId) || !Number.isInteger(link?.destFaceId)) continue;
    if (!TELEPORTER_LINKS_BY_SOURCE_FACE.has(link.sourceFaceId)) {
      TELEPORTER_LINKS_BY_SOURCE_FACE.set(link.sourceFaceId, []);
    }
    TELEPORTER_LINKS_BY_SOURCE_FACE.get(link.sourceFaceId).push(link.destFaceId);
  }

  for (const [sourceFaceId, destinations] of TELEPORTER_LINKS_BY_SOURCE_FACE.entries()) {
    destinations.sort((a, b) => a - b);
    TELEPORTER_LINKS_BY_SOURCE_FACE.set(sourceFaceId, Array.from(new Set(destinations)));
  }
}

rebuildTeleporterRuntimeState();

function getMaxObstacleTopY(obstacles = []) {
  return obstacles.reduce((maxTop, obstacle) => {
    const baseY = Number.isFinite(obstacle?.baseY) ? obstacle.baseY : 0;
    const height = Number.isFinite(obstacle?.h) ? obstacle.h : 4;
    return Math.max(maxTop, baseY + height);
  }, 0);
}

// How high a tank can get, which is where the clouds have to start. Wings
// out-climbs an ordinary jump wherever a server raises _wingsJumpCount, because
// a flap taken at the top of the last one adds another whole apex. Upstream asks
// the same question in getMaxWorldHeight (bzfs.cxx:1264) and answers it with a
// deliberately generous over-estimate; this is the arithmetic behind it.
function getJumpApexHeight() {
  const apex = (velocity, gravity) => (velocity * velocity) / (2 * gravity);
  return Math.max(
    apex(GAME_CONFIG.JUMP_VELOCITY, GAME_CONFIG.GRAVITY),
    GAME_CONFIG.WINGS_JUMP_COUNT * apex(GAME_CONFIG.WINGS_JUMP_VELOCITY, GAME_CONFIG.WINGS_GRAVITY)
  );
}

// Generate random clouds with fractal patter.
function generateClouds(obstacles = OBSTACLES) {
  const clouds = [];
  const numClouds = 15;
  const maxObstacleTopY = getMaxObstacleTopY(obstacles);
  const jumpApexHeight = getJumpApexHeight();
  const cloudBaseY = maxObstacleTopY + jumpApexHeight;

  for (let i = 0; i < numClouds; i++) {
    // Random position in sky
    const x = (Math.random() - 0.5) * 200;
    const y = cloudBaseY + Math.random() * 40;
    const z = (Math.random() - 0.5) * 200;

    // Fractal puffs (multiple spheres clustered together)
    const puffs = [];
    const numPuffs = 5 + Math.floor(Math.random() * 8);

    for (let j = 0; j < numPuffs; j++) {
      puffs.push({
        offsetX: (Math.random() - 0.5) * 10,
        offsetY: (Math.random() - 0.5) * 3,
        offsetZ: (Math.random() - 0.5) * 10,
        radius: 2 + Math.random() * 4
      });
    }

    clouds.push({ x, y, z, puffs });
  }

  return clouds;
}

// Game state
const players = new Map();
const projectiles = new Map();
let projectileIdCounter = 0;
// Minecraft-style world time (0-23999, 20 min per day, 20 ticks/sec)
let worldTime = Math.floor(Math.random() * 24000); // randomize start

// Get next available player number
function getNextPlayerNumber() {
  let num = 1;
  const takenNumbers = new Set(Array.from(players.values()).map(p => p.playerNumber));
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
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.rotation = 0;
    this.health = 0;
    this.lastUpdate = Date.now();
    this.kills = 0;
    this.deaths = 0;
    this.paused = false;
    this.pauseCountdownStart = 0;
    this.pauseTimer = null;
    this.pauseDropTimer = null;
    this.verticalVelocity = 0;
    this.isJumping = false;
    this.lastJumpTime = 0;
    this.onObstacle = false;
    this.connectDate = new Date();
    this.tankModel = 'bzflag';
    // Teams are server-authoritative. Observer is receive-only and non-combatant.
    this.team = 'rogue';
    this.color = getInitialPlayerColor(TEAM_MODE, this.team, (team) => Player.pickDistinctColor(team));
    this.joined = false;
    // PlayerInfo::restartOnBase. Set for every CTF spawn and after a capture.
    this.restartOnBase = false;
    // GameKeeper::Player::lastIdFlag. Which flag the Identify flag last named,
    // so the answer is sent once rather than on every position update.
    this.lastIdFlag = null;
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
    this.jumpDirection = null;
    this.slideDirection = undefined;
    this.airVelocityX = 0;
    this.airVelocityZ = 0;
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
    const spawnPos = getSpawnPosition(this);
    this.x = spawnPos.x;
    this.y = spawnPos.y;
    this.z = spawnPos.z;
    this.rotation = spawnPos.rotation;
    this.health = 100;
    this.verticalVelocity = 0;
    this.isJumping = false;
    this.onObstacle = false;
    this.jumpDirection = null;
    this.slideDirection = undefined;
    this.forwardSpeed = 0;
    this.rotationSpeed = 0;
    this.airVelocityX = 0;
    this.airVelocityZ = 0;
    this.teleportReentryBlockTeleporterIndex = null;
    this.teleportReentryBlockDistance = 0;
    this.teleportReentryBlockUntil = 0;
    this.teleportCooldownUntil = 0;
  }

  getState() {
    return {
      id: this.id,
      name: this.name,
      x: this.x,
      y: this.y,
      z: this.z,
      rotation: this.rotation,
      health: this.health,
      kills: this.kills,
      deaths: this.deaths,
      paused: this.paused,
      forwardSpeed: this.forwardSpeed,
      rotationSpeed: this.rotationSpeed,
      verticalVelocity: this.verticalVelocity,
      jumpDirection: this.jumpDirection,
      slideDirection: this.slideDirection,
      airVelocityX: this.airVelocityX,
      airVelocityZ: this.airVelocityZ,
      connectDate: this.connectDate ? this.connectDate.toISOString() : undefined,
      color: this.color,
      tankModel: this.tankModel,
      team: this.team,
      voiceMicEnabled: this.voiceMicEnabled,
      voiceChannel: this.voiceChannel,
      teleportCooldownUntil: this.teleportCooldownUntil,
    };
  }

  /**
   * Get extrapolated position at a specific time based on last known state.
   * @param {number} atTime - Timestamp (ms) to extrapolate to
   * @returns {{x: number, y: number, z: number, r: number}}
   */
  getExtrapolatedPosition(atTime) {
    const dt = (atTime - this.lastUpdate) / 1000; // Convert to seconds
    if (dt <= 0) return { x: this.x, y: this.y, z: this.z, r: this.rotation };
    // getDeadReckoning (Player.cxx:1127) does not move a paused tank, whatever
    // it was doing when the pause landed.
    if (this.paused) return { x: this.x, y: this.y, z: this.z, r: this.rotation };

    // Apply rotation
    const rotSpeed = GAME_CONFIG.TANK_ROTATION_SPEED || 1.5;
    const newR = this.rotation + this.rotationSpeed * rotSpeed * dt;

    // Determine if player is in air based on jumpDirection
    const isInAir = this.jumpDirection !== null && this.jumpDirection !== undefined;

    if (isInAir) {
      const hasAirVelocity = Number.isFinite(this.airVelocityX) && Number.isFinite(this.airVelocityZ);
      const speed = GAME_CONFIG.TANK_SPEED || 15;
      const moveDirection = this.slideDirection !== undefined ? this.slideDirection : this.jumpDirection;
      const dx = hasAirVelocity ? this.airVelocityX * dt : -Math.sin(moveDirection) * this.forwardSpeed * speed * dt;
      const dz = hasAirVelocity ? this.airVelocityZ * dt : -Math.cos(moveDirection) * this.forwardSpeed * speed * dt;

      // Apply gravity to vertical velocity. A wings tank falls at _wingsGravity,
      // which is the world's own unless a server has said otherwise, so
      // extrapolating it at the world's would read as vertical drift.
      const gravity = hasAirControl(getPlayerFlag(this.id)?.type)
        ? GAME_CONFIG.WINGS_GRAVITY
        : GAME_CONFIG.GRAVITY;
      const vv = this.verticalVelocity - gravity * dt;
      const dy = (this.verticalVelocity + vv) / 2 * dt; // Average velocity over dt

      return {
        x: this.x + dx,
        y: Math.max(0, this.y + dy), // Don't go below ground
        z: this.z + dz,
        r: newR
      };
    }

    // On ground: check for circular vs straight motion
    const speed = GAME_CONFIG.TANK_SPEED || 15;
    const rs = this.rotationSpeed || 0;
    const fs = this.forwardSpeed || 0;

    // Use slide direction if present, otherwise use rotation
    const moveDirection = this.slideDirection !== undefined ? this.slideDirection : this.rotation;

    if (Math.abs(rs) < 0.001) {
      // Straight line motion (or sliding)
      const dx = -Math.sin(moveDirection) * fs * speed * dt;
      const dz = -Math.cos(moveDirection) * fs * speed * dt;
      return { x: this.x + dx, y: this.y, z: this.z + dz, r: newR };
    } else {
      // Circular arc motion
      // Radius of curvature: R = |linear_velocity / angular_velocity|
      const R = Math.abs((fs * speed) / (rs * rotSpeed));

      // Arc angle traveled
      const theta = rs * rotSpeed * dt;

      // Center of circle in world space
      // Forward is (-sin(r), -cos(r)), perpendicular at r - π/2
      const perpAngle = this.rotation - Math.PI / 2;
      const centerSign = -(rs * fs); // Negated to match correct circular motion
      const cx = this.x + Math.sign(centerSign) * R * (-Math.sin(perpAngle));
      const cz = this.z + Math.sign(centerSign) * R * (-Math.cos(perpAngle));

      // New position rotated around center
      // Negate theta for clockwise rotation (rs > 0 means turn right = clockwise)
      const dx = this.x - cx;
      const dz = this.z - cz;
      const cosTheta = Math.cos(-theta);
      const sinTheta = Math.sin(-theta);
      const newDx = dx * cosTheta - dz * sinTheta;
      const newDz = dx * sinTheta + dz * cosTheta;

      return {
        x: cx + newDx,
        y: this.y,
        z: cz + newDz,
        r: this.rotation + theta
      };
    }
  }
}

// Projectile class
class Projectile {
  constructor(id, playerId, shotSlot, x, y, z, dirX, dirZ, dirY = 0, flag = null) {
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
    this.speed = GAME_CONFIG.SHOT_SPEED * effects.velocityFactor;
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
    this.points = null;
    this.bounces = 0;
    this.x = x;
    this.y = y || 2.2; // Default height if not specified (tank height + barrel height)
    this.z = z;
    this.dirX = dirX;
    this.dirY = dirY;
    this.dirZ = dirZ;
    this.createdAt = Date.now();
    this.originX = x;
    this.originY = this.y;
    this.originZ = z;
    // GetShotLifetime (GameKeeper.cxx:401): the world's reload interval scaled by
    // the flag's own life factor. The slot this shot holds frees with it, which
    // is how Rapid Fire and Machine Gun get their rate -- their life is declared
    // as the reciprocal of it.
    this.lifetimeSeconds = (GAME_CONFIG.SHOT_SPEED > 0
      ? (GAME_CONFIG.SHOT_RANGE / GAME_CONFIG.SHOT_SPEED)
      : 10) * effects.lifeFactor;
    this.teleportReentryBlockTeleporterIndex = null;
    this.teleportReentryBlockDistance = 0;
  }
}

// Helper functions
// Returns a unique player name. If the given name is empty or taken, returns 'Player n' with the lowest available n.
function nameCheck(requestedName, excludeId = null) {
  let name = requestedName && requestedName.trim() ? requestedName.trim() : '';
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
  const nameTaken = Array.from(players.values()).some(p => p.id !== excludeId && p.name && p.name.toLowerCase() === name.toLowerCase());
  if (nameTaken) {
    // Assign 'Player n' for their own player number
    if (playerNumber !== null) {
      return `Player ${playerNumber}`;
    }
  }
  return name;
}
function distance(x1, z1, x2, z2) {
  return Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);
}

function normalizeAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function getBoxCollisionDistanceSquared(localX, localZ, halfW, halfD) {
  const closestX = Math.max(-halfW, Math.min(localX, halfW));
  const closestZ = Math.max(-halfD, Math.min(localZ, halfD));
  const distX = localX - closestX;
  const distZ = localZ - closestZ;
  return distX * distX + distZ * distZ;
}

// Upstream's border is one WallObstacle a side doing two jobs at once.
// WallObstacle::inCylinder and inBox ignore height entirely, so it is an
// infinite half-space that stops a tank at any altitude; makeSegments then
// ignores a bouncing shot's hit on it above getHeight() (`ignoreHit`) and lets
// the shot fly over rather than back into the arena. So the wall you can see
// bounces shots and the invisible barrier above it does not.
//
// bzo says that with two colliders a side rather than a special case in the shot
// path, each doing one of the two jobs and standing aside from the other with one
// of upstream's own per-obstacle flags:
//
//   - the barrier, a thousand units high -- taller than any map bzo has to hold
//     -- is the tank collider, and is `shootThrough`. It is upstream's wall as
//     tanks meet it: a height-ignoring half-space with no roof.
//   - the visible wall, `_wallHeight` tall, is the shot collider, and is
//     `driveThrough`. It exists to give a shot a height to stop bouncing at.
//
// The flag on the visible wall is what makes the split correct rather than what
// papers over it. Tanks are held by the barrier at the same inner edge, so they
// never reach the wall, and the wall's roof -- which upstream's WallObstacle does
// not have at all, `getHitNormal` only ever answering with the plane -- is not a
// surface any collision code has to reason about.
//
// Both flags are the ones a map's `shootthrough` and `drivethrough` keywords
// set, which is what makes this the compatible way to say it.
function getWorldBorderColliders() {
  const halfMap = GAME_CONFIG.MAP_SIZE / 2;
  const thickness = 4;
  const barrierHeight = 1000;
  const span = GAME_CONFIG.MAP_SIZE + thickness * 2;
  const sides = [
    { name: 'north', x: 0, z: -halfMap - thickness / 2, w: span, d: thickness },
    { name: 'south', x: 0, z: halfMap + thickness / 2, w: span, d: thickness },
    { name: 'east', x: halfMap + thickness / 2, z: 0, w: thickness, d: span },
    { name: 'west', x: -halfMap - thickness / 2, z: 0, w: thickness, d: span },
  ];
  const colliders = [];
  for (const side of sides) {
    // The barrier that stops a tank at any altitude a map can reach, and lets
    // every shot through.
    colliders.push({
      type: 'box',
      name: `boundary_${side.name}`,
      collisionKind: 'boundary',
      shootThrough: true,
      x: side.x,
      z: side.z,
      w: side.w,
      d: side.d,
      h: barrierHeight,
      baseY: 0,
      rotation: 0,
    });
    // And the wall a player can see, which is what a shot bounces off below
    // `_wallHeight` and nothing at all above it. Tanks are the barrier's job.
    colliders.push({
      type: 'box',
      name: `boundary_${side.name}_wall`,
      collisionKind: 'boundary',
      driveThrough: true,
      x: side.x,
      z: side.z,
      w: side.w,
      d: side.d,
      h: WORLD_WALL_HEIGHT,
      baseY: 0,
      rotation: 0,
    });
  }
  return colliders;
}

function getCollisionColliders() {
  return [...OBSTACLES, ...getWorldBorderColliders()];
}

// `options.rotation` selects BZFlag's two occupant shapes: a heading makes the
// occupant an oriented 2.8 x 6.0 box (Obstacle::inBox, used for tanks), and its
// absence keeps the cylinder (Obstacle::inCylinder, correct for projectiles).
// Every obstacle's top, teleporters included: the importer resolves a
// teleporter's frame into `w`/`d`/`h` so there is no special case left here.
function getColliderTopY(obs) {
  return (obs?.baseY || 0) + (Number.isFinite(obs?.h) ? obs.h : 0);
}

function checkCollision(x, y, z, tankRadius = 2, options = {}) {
  const ignoreTeleporters = options.ignoreTeleporters === true;
  const suppressLog = options.suppressLog === true;
  const useTankBox = Number.isFinite(options.rotation);
  // Shrinks the tested radius only. Height is untouched, and the teleporter
  // portal interior keeps the full radius so slack can never make a portal
  // harder to pass through.
  const slack = Math.max(0, Math.min(options.slack || 0, tankRadius));
  const effectiveRadius = tankRadius - slack;
  // Phase 7's dimension flags. Only the oriented-box path can express a length
  // and a width separately, which is the path a tank always takes; the cylinder
  // is for projectiles, which carry no flag.
  const tankScale = options.tankScale || null;
  for (const obs of getCollisionColliders()) {
    if (ignoreTeleporters && obs?.kind === 'teleporter') continue;
    // `drivethrough` in a `.bzw`, `Obstacle::isDriveThrough` upstream: an
    // obstacle a tank passes straight through. Nothing sets it yet -- it is here
    // so that a map which names it has nowhere else to be honoured -- and
    // `shootThrough`, which the world border does use, is its other half.
    if (obs?.driveThrough) continue;
    const obstacleHeight = getObstacleHeight(obs);
    const obstacleBase = obs.baseY || 0;
    const obstacleTop = getColliderTopY(obs);
    const epsilon = 0.15;
    // Scale height based on radius (tanks are 2 units tall, projectiles much smaller)
    const tankHeight = tankRadius; // For tanks (radius=2), height=2; for projectiles (radius=0.1), height=0.1
    // Only check if tank top is below obstacle top and tank base is above obstacle base
    const tankTop = y + tankHeight;
    if (tankTop <= obstacleBase + epsilon) continue;
    if (y >= obstacleTop - epsilon) continue;

    const halfW = obs.w / 2;
    const halfD = obs.d / 2;
    const { x: localX, z: localZ } = getColliderLocalPoint(x, z, obs);
    const tankAngle = useTankBox ? getTankLocalAngle(options.rotation, obs.rotation) : 0;
    const hitsRect = (rectHalfW, rectHalfD, rectSlack) => (useTankBox
      ? testOrigRectTank(rectHalfW, rectHalfD, localX, localZ, tankAngle, rectSlack, tankScale)
      : getBoxCollisionDistanceSquared(localX, localZ, rectHalfW, rectHalfD)
        < (tankRadius - rectSlack) * (tankRadius - rectSlack));

    if (obs.type === 'box' || !obs.type) {
      // Teleporter boxes are only solid on the frame. The inner active portal
      // area must remain non-colliding so crossing can trigger teleport.
      if (obs?.kind === 'teleporter') {
        const dims = getShotTeleporterDims(obs);
        if (hitsRect(dims.halfW, dims.halfD, slack)) {
          const activeBaseY = obstacleBase;
          const activeTopY = obstacleBase + dims.activeH;
          const overlapsActiveVertical = tankTop > (activeBaseY + epsilon) && y < (activeTopY - epsilon);
          // The portal interior keeps the full shape, so slack can never make a
          // portal harder to pass through.
          const inPortalInterior = overlapsActiveVertical
            && hitsRect(dims.halfW, dims.activeHalfD, 0);
          if (inPortalInterior) {
            continue;
          }

          if (!suppressLog) {
            log(`[COLLISION] ${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)} ${obs.name}:${obs.type} ${obs.x.toFixed(2)},${obstacleBase.toFixed(2)},${obs.z.toFixed(2)} rot:${(obs.rotation || 0).toFixed(2)}, h:${obstacleHeight.toFixed(2)}, top:${obstacleTop.toFixed(2)}`);
          }
          return obs;
        }
      } else {
        if (hitsRect(halfW, halfD, slack)) {
          if (!suppressLog) {
            log(`[COLLISION] ${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)} ${obs.name}:${obs.type} ${obs.x.toFixed(2)},${obstacleBase.toFixed(2)},${obs.z.toFixed(2)} rot:${(obs.rotation || 0).toFixed(2)}, h:${obstacleHeight.toFixed(2)}, top:${obstacleTop.toFixed(2)}`);
          }
          return obs;
        }
      }
    } else if (obs.type === 'pyramid') {
      // Mirrors BZFlag PyramidBuilding::inBox: the pyramid's cross-section at
      // the occupant's height is the base rectangle scaled by shrinkFactor.
      // The previous 8-point sample never consulted obs.inverted, so the server
      // treated every inverted pyramid as upright and disagreed with the client
      // about roughly a fifth of the volume around it.
      const hitsPyramid = useTankBox
        ? pyramidIntersectsTank(obs, x, y, z, options.rotation, tankHeight, slack, tankScale)
        : pyramidIntersectsCylinder(obs, x, y, z, effectiveRadius, tankHeight);
      if (hitsPyramid) {
        if (!suppressLog) {
          log(`[COLLISION] ${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)} ${obs.name}:${obs.type} ${obs.x.toFixed(2)},${obstacleBase.toFixed(2)},${obs.z.toFixed(2)} rot:${(obs.rotation || 0).toFixed(2)}, h:${obstacleHeight.toFixed(2)}, top:${obstacleTop.toFixed(2)}`);
        }
        return obs;
      }
    }
  }
  return false;
}

function findMapEdgeImpactPoint(prevX, prevY, prevZ, nextX, nextY, nextZ, halfMap) {
  const prevInside = Math.abs(prevX) <= halfMap && Math.abs(prevZ) <= halfMap;
  const nextInside = Math.abs(nextX) <= halfMap && Math.abs(nextZ) <= halfMap;

  // Expected case: inside -> outside. Fall back to current position otherwise.
  if (!prevInside || nextInside) {
    return { x: nextX, y: nextY, z: nextZ };
  }

  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) * 0.5;
    const mx = prevX + (nextX - prevX) * mid;
    const mz = prevZ + (nextZ - prevZ) * mid;
    const inside = Math.abs(mx) <= halfMap && Math.abs(mz) <= halfMap;
    if (inside) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const t = lo;
  return {
    x: prevX + (nextX - prevX) * t,
    y: prevY + (nextY - prevY) * t,
    z: prevZ + (nextZ - prevZ) * t,
  };
}

// RandomSpawnPolicy::getPosition. A player waiting to restart at base spawns on
// a random point of one of their own team's bases, which is every spawn in CTF
// and every spawn after a capture; everyone else spawns anywhere valid.
function getSpawnPosition(player) {
  const testSpawn = getTestSpawn(player.name);
  if (testSpawn) return testSpawn;

  if (player.restartOnBase) {
    player.restartOnBase = false;
    const base = getRandomTeamBase(getTeamColorIndex(player.team));
    if (base) {
      return { ...getRandomBasePosition(base), rotation: Math.random() * Math.PI * 2 };
    }
  }
  return findValidSpawnPosition();
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
function getTestSpawn(name) {
  const configured = serverConfig.testSpawn;
  const spawns = Array.isArray(configured) ? configured : (configured ? [configured] : []);
  const spawn = spawns.find((candidate) => candidate?.name === name);
  if (!spawn) return null;
  return {
    x: Number(spawn.x) || 0,
    y: Number(spawn.y) || 0,
    z: Number(spawn.z) || 0,
    rotation: Number(spawn.rotation) || 0,
  };
}

function findValidSpawnPosition(tankRadius = 2) {
  const halfMap = GAME_CONFIG.MAP_SIZE / 2;
  const maxAttempts = 100;
  const y = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = Math.random() * (GAME_CONFIG.MAP_SIZE - tankRadius * 4) - (halfMap - tankRadius * 2);
    const z = Math.random() * (GAME_CONFIG.MAP_SIZE - tankRadius * 4) - (halfMap - tankRadius * 2);
    const rotation = Math.random() * Math.PI * 2;

    if (!checkCollision(x, y, z, tankRadius, { rotation })) {
      return { x, y, z, rotation };
    }
  }

  // If we couldn't find a valid position after many attempts, return a safe default
  return { x: 0, y: 0, z: 0, rotation: 0 };
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

  const refused = enforceable && ANTICHEAT_CONFIG.mode === 'strict';
  log(
    `[ANTICHEAT:${ANTICHEAT_CONFIG.mode.toUpperCase()}] "${player.name}" ${headline}`
    + ` | ${refused ? 'REFUSED' : 'ALLOWED'} | Warnings: ${counters.totalWarnings}`
  );
  if (detail) {
    for (const line of [].concat(detail)) log(`  ${line}`);
  }
  return refused;
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
function validateMovement(player, newX, newY, newZ, newRotation, deltaTime, velocityChanged = false, options = {}) {
  // A non-finite coordinate would poison the stored position and every
  // extrapolation made from it afterwards, so it is refused in every mode.
  if (!Number.isFinite(newX) || !Number.isFinite(newY)
    || !Number.isFinite(newZ) || !Number.isFinite(newRotation)) {
    logMalformed(player, 'MOVE', `(${newX}, ${newY}, ${newZ}, r=${newRotation})`);
    return false;
  }

  // A paused tank is invulnerable, so driving while paused is worth a warning,
  // but an unmodified client also sends the odd in-flight move as the pause
  // takes effect. Warning mode wants to see how often that is what this is.
  if (player.paused && reportCheat(player, 'movedWhilePaused', 'MOVED WHILE PAUSED', [
    `Recvd: (${newX.toFixed(2)}, ${newY.toFixed(2)}, ${newZ.toFixed(2)}, r=${newRotation.toFixed(2)})`,
  ])) {
    return false;
  }

  if (ANTICHEAT_CONFIG.mode !== 'disabled') {
    // Get extrapolated position based on last known velocities
    const now = Date.now();
    const timeSinceLastUpdate = (now - player.lastUpdate) / 1000;
    const extrapolated = player.getExtrapolatedPosition(now);

    // Compare to extrapolated position, not last stored position
    // With velocity-based dead reckoning, the client position should match extrapolated position
    // We allow a tolerance based on physics drift, network jitter, and rounding errors
    // If velocity changed, use much looser validation since extrapolation doesn't account for it
    const distMoved = distance(extrapolated.x, extrapolated.z, newX, newZ);
    const maxDrift = velocityChanged ? ANTICHEAT_CONFIG.linearDriftThresholdVelocityChanged : ANTICHEAT_CONFIG.linearDriftThreshold;

    if (distMoved > maxDrift) {
      const exceedAmount = distMoved - maxDrift;
      const likelihood = Math.min(100, (exceedAmount / maxDrift) * 100).toFixed(1);

      const refused = reportCheat(player, 'linearDrift',
        `LINEAR DRIFT: ${distMoved.toFixed(2)} > ${maxDrift.toFixed(2)} (+${exceedAmount.toFixed(2)})`
        + ` | Likelihood: ${likelihood}%`,
        [
          `Stored: (${player.x.toFixed(2)}, ${player.y.toFixed(2)}, ${player.z.toFixed(2)}, r=${player.rotation.toFixed(2)})`,
          `Extrap: (${extrapolated.x.toFixed(2)}, ${extrapolated.y.toFixed(2)}, ${extrapolated.z.toFixed(2)}, r=${extrapolated.r.toFixed(2)})`,
          `Recvd:  (${newX.toFixed(2)}, ${newY.toFixed(2)}, ${newZ.toFixed(2)}, r=${newRotation.toFixed(2)})`,
          `Vels: fs=${player.forwardSpeed.toFixed(2)}, rs=${player.rotationSpeed.toFixed(2)}, vv=${player.verticalVelocity.toFixed(2)}, dt=${timeSinceLastUpdate.toFixed(2)}s, velChanged=${velocityChanged}`,
        ]);
      if (refused) return false;
    }

    // Calculate rotation change from extrapolated rotation
    const rotDiff = Math.abs(normalizeAngle(newRotation - extrapolated.r));
    const maxRotDrift = ANTICHEAT_CONFIG.angularDriftThreshold;

    if (rotDiff > maxRotDrift) {
      const exceedAmount = rotDiff - maxRotDrift;
      const likelihood = Math.min(100, (exceedAmount / maxRotDrift) * 100).toFixed(1);

      const refused = reportCheat(player, 'angularDrift',
        `ANGULAR DRIFT: ${rotDiff.toFixed(2)} > ${maxRotDrift.toFixed(2)} (+${exceedAmount.toFixed(2)})`
        + ` | Likelihood: ${likelihood}%`,
        [
          `stored: ${player.rotation.toFixed(2)}, extrapolated: ${extrapolated.r.toFixed(2)},`
          + ` received: ${newRotation.toFixed(2)}, rs=${player.rotationSpeed.toFixed(2)},`
          + ` dt=${timeSinceLastUpdate.toFixed(2)}s`,
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
    const ignoreTeleporters = options.ignoreTeleporters === true;
    const collision = checkCollision(newX, newY, newZ, 2, {
      ignoreTeleporters,
      rotation: newRotation,
      slack: ANTICHEAT_CONFIG.collisionSlack,
      tankScale: getPlayerTankScale(player),
    });

    if (collision) {
      const at = `p ${newX.toFixed(2)},${newY.toFixed(2)},${newZ.toFixed(2)}`;
      let headline;
      if (collision === true) {
        headline = `COLLISION with unknown object (${at})`;
      } else if (collision.collisionKind === 'boundary') {
        headline = `COLLISION with boundary (${at})`;
      } else {
        const { x, z, w, d, h, baseY, rotation } = collision;
        headline = `COLLISION obs:${collision.name} ${x.toFixed(2)},${baseY.toFixed(2)},${z.toFixed(2)},`
          + ` w:${w.toFixed(2)}, d:${d.toFixed(2)}, h:${h.toFixed(2)}, rot:${rotation.toFixed(2)} (${at})`;
      }
      if (reportCheat(player, 'collision', headline)) return false;
    }
  }

  return true;
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
function getShotRejection(player, shotX, shotY, shotZ) {
  // Shot originates from barrel end, which is ~3 units from tank center
  const barrelLength = 3.0;
  const now = Date.now();

  if (!Number.isFinite(shotX) || !Number.isFinite(shotY) || !Number.isFinite(shotZ)) {
    return { reason: `shot origin is not finite (${shotX}, ${shotY}, ${shotZ})`, fatal: true };
  }

  // An observer has no tank, so there is no barrel for the shot to leave and
  // nothing for a return shot to hit. Not a tolerance: refused in every mode.
  if (player.team === 'observer') {
    return { reason: 'observer cannot shoot', fatal: true };
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
  if (player.health <= 0) {
    return { reason: `dead player cannot shoot (health=${player.health})`, fatal: false };
  }

  // Fire rate is limited by shot slots alone, matching bzfs: GameKeeper.cxx
  // addShot() rejects a shot only when its own slot is still live, and there is
  // no elapsed-time check. Slots each expire independently a full shot lifetime
  // after they were filled, so consecutive shots never share a timer and network
  // jitter cannot make an honest shot look early. See the slot check below.

  // Use extrapolated position, not stored position
  const extrapolated = player.getExtrapolatedPosition(now);
  const dist = distance(extrapolated.x, extrapolated.z, shotX, shotZ);

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

  let activeShotCount = 0;
  projectiles.forEach((proj) => {
    if (proj.playerId === player.id) activeShotCount++;
  });

  if (activeShotCount >= GAME_CONFIG.SHOT_MAX_ACTIVE) {
    return {
      reason: `exceeded active shot slots (${activeShotCount}/${GAME_CONFIG.SHOT_MAX_ACTIVE})`,
      fatal: false,
    };
  }

  return null;
}

// A rejected shot means the client believed it could fire and the server did
// not. That is the same class of client/server disagreement the drift checks
// report, so it is counted and reported the same way. Returns true when the shot
// must not be fired: always for a fatal reason, otherwise only in strict mode.
function reportShotRejection(player, reason, message, fatal) {
  const detail = `player=${player.id} at=${formatShotPoint(player.x, player.y, player.z)}`
    + ` sent=${formatShotPoint(Number(message.x), Number(message.y), Number(message.z))}`
    + ` dir=(${Number(message.dirX)},${Number(message.dirY)},${Number(message.dirZ)})`;

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

function getAvailableShotSlot(playerId) {
  const occupiedSlots = new Set();
  projectiles.forEach((proj) => {
    if (proj.playerId === playerId && Number.isInteger(proj.shotSlot) && proj.shotSlot >= 0) {
      occupiedSlots.add(proj.shotSlot);
    }
  });
  for (let slot = 0; slot < GAME_CONFIG.SHOT_MAX_ACTIVE; slot++) {
    if (!occupiedSlots.has(slot)) return slot;
  }
  return -1;
}

// Broadcast to all players except sender
function broadcast(message, excludeWs = null) {
  const data = JSON.stringify(message);
  players.forEach((player) => {
    if (player.ws !== excludeWs && player.ws.readyState === 1) {
      player.ws.send(data);
    }
  });
}

// Broadcast to all players including sender
function broadcastAll(message) {
  const data = JSON.stringify(message);
  players.forEach((player) => {
    if (player.ws.readyState === 1) {
      player.ws.send(data);
    }
  });
}

// --- Flags -------------------------------------------------------------
//
// Mirrors bzfs: the server owns every flag, and the client animates a flight
// from the numbers that came with the event that started it. See
// docs/flags-plan.md, and FlagInfo.cxx / bzfs.cxx upstream.
//
// A superflag lying on the ground is sent with `type: null`, because bzfs hides
// the identity of an unheld superflag from every client (bzfs.cxx:361). Picking
// one up reveals it to everyone.

// The radius the flag drop test uses for its clearance cylinder, and the step it
// walks that cylinder in. DropGeometry uses the tank radius; bzo's is 2.
const FLAG_DROP_TEST_RADIUS = 2;
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
      sumX += base.x;
      sumZ += base.z;
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
  const spanX = Math.max(0, base.w - (2 * FLAG_DROP_TEST_RADIUS));
  const spanZ = Math.max(0, base.d - (2 * FLAG_DROP_TEST_RADIUS));
  const localX = spanX * (Math.random() - 0.5);
  const localZ = spanZ * (Math.random() - 0.5);
  const rotated = rotateXZ(localX, localZ, -(base.rotation || 0));
  return {
    x: base.x + rotated.x,
    y: getBaseTopY(base),
    z: base.z + rotated.z,
  };
}

rebuildTeamBases(OBSTACLES);
// ClassicCTF upstream. Team flags need both a team game and bases to stand on,
// so a team-mode map with no bases plays without them.
const CTF_ENABLED = TEAM_MODE.enabled && BASES_BY_TEAM.size > 0;
// World::allowJumping, upstream's -j. Upstream has jumping off until the switch
// turns it on; bzo has had it on since before there was a switch, so the default
// stays on and `jumping: false` in server.json is what turns it off. A map's
// `-j` can still turn it back on, because a bzfs switch never turns anything
// off. With jumping on the `JP` flag has nothing to offer and is forbidden, and
// with it off `JP` is the only way a tank leaves the ground -- except `WG`,
// which never asks.
const ALLOW_JUMPING = serverConfig.jumping !== false || mapServerOptions.jumping === true;
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
  `Team kills: ${NO_TEAM_KILLS ? 'friendly fire off (-noTeamKills)' : 'friendly fire on'}` +
  `; a team killer ${TEAM_KILLER_DIES ? 'dies for it' : 'does not die (-tk)'}`
);
// -st upstream, the shake timeout: seconds a bad flag sticks before it falls off
// by itself. Off by default, as upstream has it, so a bad flag is otherwise
// carried until it kills you. `flagShakeTimeout` in `server.json` and `-st` in a
// map's `options` block both reach it, and as with every bzfs switch the map may
// turn it on where nothing turns it back off -- so the larger of the two wins.
// The client runs the countdown and the server re-asks; see canShakeFlag.
const FLAG_SHAKE_TIMEOUT = Math.max(
  normalizeShakeTimeout(serverConfig.flagShakeTimeout),
  normalizeShakeTimeout(mapServerOptions.flagShakeTimeout)
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
// The three ways upstream lets you shed a bad flag, for the startup log and for
// the message a player gets when they pick one up. With none of them on, dying
// is the only way out -- which is upstream's default.
function describeBadFlagRelease() {
  const ways = [];
  if (FLAG_SHAKE_TIMEOUT > 0) ways.push(`after ${FLAG_SHAKE_TIMEOUT}s`);
  if (FLAG_SHAKE_WINS > 0) ways.push(`after ${FLAG_SHAKE_WINS} ${FLAG_SHAKE_WINS === 1 ? 'win' : 'wins'}`);
  if (ANTIDOTE_FLAGS) ways.push('on the antidote');
  return ways.length > 0 ? ways.join(' or ') : 'only on death';
}
// -srvmsg upstream. What the world says to each player as they arrive, in the
// order the map wrote it. Upstream sends these as ordinary server chat rather
// than as part of the world (bzfs.cxx:2507), so bzo does too -- which is also
// why it is separate from `motd`, the label the entry dialog shows before anyone
// has joined at all.
const MAP_SERVER_MESSAGES = Object.freeze(mapServerOptions.serverMessages || []);
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
  if (!TEAM_MODE.enabled) forbidden.push('G');
  return forbidden;
}
// -fb upstream. Whether a superflag may spawn on, and come to rest on, a
// building. A map's `options` block may turn it on; nothing turns it back off,
// which is how a bzfs switch behaves.
const FLAGS_ON_BUILDINGS = mapServerOptions.flagsOnBuildings === true
  || serverConfig.flagsOnBuildings === true;

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

// +s/-s upstream: how many superflag slots the world carries, and which types
// may fill them. Upstream needs the switch to have any superflags at all; bzo
// defaults them on, and defaults `allowed` to every superflag in the shared
// flag table.
function normalizeSuperFlagConfig(value) {
  const requestedCount = Number(value?.count);
  const count = Number.isInteger(requestedCount) && requestedCount >= 0 ? requestedCount : 16;
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
    : serverConfig.superFlags
);

// What a slot is actually drawn from: everything the config allows, less
// whatever the map and the game style forbid right now. The game style can
// change while the server runs, so this is asked per draw rather than settled at
// startup.
function getSuperFlagPool() {
  const forbidden = getForbiddenFlags();
  return SUPER_FLAGS.allowed.filter((abbreviation) => !forbidden.includes(abbreviation));
}

// DropGeometry::dropFlag tests a tank-radius cylinder _flagHeight tall, so a
// spawning flag never appears somewhere a tank could not drive to reach it.
// checkCollision tests a box as tall as the radius it is handed, so the cylinder
// is walked in those steps.
//
// Only spawning uses this. A drop goes through dropTeamFlag, whose radius is 0
// and which upstream's own comment calls "not a real clearance check".
function hasFlagClearance(x, y, z) {
  for (let offset = 0; offset < FLAG_CLEARANCE; offset += FLAG_DROP_TEST_RADIUS) {
    if (checkCollision(x, y + offset, z, FLAG_DROP_TEST_RADIUS, { suppressLog: true })) return false;
  }
  return true;
}

// resetFlag() for a flag with no team: a random spot with room for the flag and
// for a tank to reach it. Upstream picks a random altitude as well as a random
// x and y, and lets the downward ray decide which surface under it the flag
// actually settles on. With flags on buildings off it passes maxZ = 0 instead,
// which skips the ray and forces the ground.
// CustomZone::getRandomPoint. A point anywhere in the zone's footprint, at the
// zone's own altitude. Upstream picks the offset in BZW's axes and rotates it
// there, so bzo does the same and converts only the result -- BZW's +Y north is
// bzo's -Z north, which is why the depth term is subtracted.
function getRandomZonePoint(zone) {
  const offsetX = ((Math.random() * 2) - 1) * zone.halfWidth;
  const offsetY = ((Math.random() * 2) - 1) * zone.halfDepth;
  const cos = Math.cos(zone.rotation);
  const sin = Math.sin(zone.rotation);
  return {
    x: zone.x + ((offsetX * cos) - (offsetY * sin)),
    y: zone.y,
    z: zone.z - ((offsetX * sin) + (offsetY * cos)),
  };
}

// WorldInfo::getFlagSpawnPoint. Upstream asks the flag-id qualifier `#<index>`
// first, which for a `zoneflag` slot names exactly one zone, then the type
// qualifier `f<abbv>` that the `flag` keyword builds. bzo does not read `flag`,
// so the first question is the only one there is.
function getFlagSpawnZone(flag) {
  if (!flag || flag.zoneIndex === null) return null;
  return MAP_ZONES[flag.zoneIndex] || null;
}

function findFlagSpawnPosition(flag = null) {
  const zone = getFlagSpawnZone(flag);
  const span = Math.max(1, GAME_CONFIG.MAP_SIZE - BASE_SIZE);
  const maxHeight = getMaxObstacleTopY(OBSTACLES);
  for (let attempt = 0; attempt < 10000; attempt++) {
    // Upstream re-asks getFlagSpawnPoint on every attempt and only falls back to
    // a random world point when it has no answer, so a zone flag re-rolls inside
    // its own zone rather than escaping it once the zone proves crowded.
    const spot = zone
      ? getRandomZonePoint(zone)
      : {
        x: span * (Math.random() - 0.5),
        y: maxHeight * Math.random(),
        z: span * (Math.random() - 0.5),
      };
    const y = FLAGS_ON_BUILDINGS ? findFlagLandingY(spot.x, spot.z, spot.y) : 0;
    if (hasFlagClearance(spot.x, y, spot.z)) return { x: spot.x, y, z: spot.z };
  }
  log(`Unable to position flag ${flag ? flag.index : '?'} on this world.`);
  return zone ? { x: zone.x, y: zone.y, z: zone.z } : { x: 0, y: 0, z: 0 };
}

function getFlagOwner(flag) {
  return flag.owner === null ? null : players.get(flag.owner) || null;
}

// FlagInfo::pack. A superflag nobody is holding goes out without its type.
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
  const flight = computeFlagFlight(FLAG_ALTITUDE, GAME_CONFIG.GRAVITY);
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
  // freely and survives _maxFlagGrabs pickups. FlagInfo.cxx:135 gives a sticky
  // flag a single grab, so shaking one off spends it and the flag leaves the
  // world rather than lying in wait for the next tank.
  flag.endurance = getFlagEndurance(flag.type);
  flag.grabs = flag.endurance === FLAG_ENDURANCE.STICKY ? 1 : GAME_CONFIG.MAX_FLAG_GRABS;
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
      ? { x: base.x, y: getBaseTopY(base), z: base.z }
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
function findFlagLandingY(x, z, fromY) {
  let landingY = 0;
  for (const obs of getCollisionColliders()) {
    // isValidLanding() skips anything a tank can drive through, and the world
    // boundary is not somewhere a flag belongs.
    if (obs.collisionKind === 'boundary' || obs.kind === 'teleporter') continue;
    const top = (obs.baseY || 0) + (obs.h || 0);
    if (top > fromY || top <= landingY) continue;
    if (!isOverFlatTop(obs, x, z)) continue;
    landingY = top;
  }
  return landingY;
}

// isOpposingTeam(). A team flag may not come to rest on another team's base:
// anyone picking it up there would instantly have carried their own team flag
// into enemy territory and blown up their whole team.
function isOpposingBaseAt(position, colorIndex) {
  const baseTeam = getBaseTeamAtPoint(OBSTACLES, position.x, position.y, position.z);
  return baseTeam !== null && baseTeam !== colorIndex;
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
  // The one place a flag leaves a tank, whether it was thrown, shaken, zapped or
  // captured, so it is where the shed state that was armed with it is torn down.
  owner.flagShakeWins = 0;
  if (owner.antidote) {
    owner.antidote = null;
    sendToPlayer(owner, { type: 'antidoteFlag', position: null });
  }
  broadcastAll({ type: 'dropFlag', playerId: owner.id, flag: state });
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

// grabFlag(). The client sweeps for flags it is driving over and asks; this
// check exists to catch a modified client, so it uses upstream's deliberately
// loose radius -- a tank's whole second of travel plus both radii -- and only
// rejects a distant grab when the two are on the same level, as bzfs does.
function grabFlag(player, flag) {
  if (player.team === 'observer') return;
  if (player.health <= 0 || player.paused) return;
  if (getPlayerFlag(player.id)) return;
  if (flag.status !== FLAG_STATUS.ON_GROUND) return;

  const reach = GAME_CONFIG.TANK_SPEED + BZFLAG_TANK_RADIUS + FLAG_RADIUS;
  const extrapolated = player.getExtrapolatedPosition(Date.now());
  const gap = distance(extrapolated.x, extrapolated.z, flag.position.x, flag.position.z);
  if (Math.abs(extrapolated.y - flag.position.y) < FLAG_GRAB_LEVEL_TOLERANCE && gap > reach) {
    const refused = reportCheat(player, 'flagRejected',
      `FLAG GRAB REJECTED flag ${flag.index} `
      + `${flag.position.x.toFixed(2)},${flag.position.z.toFixed(2)} is ${gap.toFixed(2)} away`
      + ` (reach ${reach.toFixed(2)})`);
    if (refused) return;
  }

  flag.owner = player.id;
  flag.status = FLAG_STATUS.ON_TANK;
  flag.flightStartedAt = 0;
  flag.grabbedAt = Date.now();
  armBadFlagRelease(player, flag);
  log(`"${player.name}" grabbed ${getFlagType(flag.type).name} flag ${flag.index}`);
  broadcastAll({ type: 'grabFlag', playerId: player.id, flag: getFlagState(flag) });
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
      y: 0,
      z: getAntidoteCoordinate(worldSize, BASE_SIZE, CTF_ENABLED, Math.random()),
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
function armBadFlagRelease(player, flag) {
  const sticky = flag.endurance === FLAG_ENDURANCE.STICKY;
  player.flagShakeWins = sticky ? FLAG_SHAKE_WINS : 0;
  const antidote = sticky && ANTIDOTE_FLAGS ? findAntidotePosition() : null;
  if (antidote === null && player.antidote === null) return;
  player.antidote = antidote;
  sendToPlayer(player, { type: 'antidoteFlag', position: antidote });
}

// checkEnvironment()'s "see if I'm over my antidote" (LocalPlayer.cxx:867),
// server-side for the same reason the placement is. Runs off each accepted
// position update, as searchFlag does, and asks the same two questions the flag
// grab does: same level, and within a tank plus a flag radius.
function checkAntidote(player) {
  const antidote = player.antidote;
  if (!antidote) return;
  const flag = getPlayerFlag(player.id);
  if (!flag || flag.endurance !== FLAG_ENDURANCE.STICKY) return;
  if (player.health <= 0 || player.paused) return;
  if (Math.abs(player.y - antidote.y) >= FLAG_GRAB_LEVEL_TOLERANCE) return;
  if (distance(player.x, player.z, antidote.x, antidote.z) > FLAG_GRAB_RADIUS) return;
  log(`"${player.name}" drove onto the antidote and shed ${getFlagType(flag.type).name}`);
  dropFlag(flag);
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

// searchFlag(). The whole of the Identify flag: while a player carries `ID`,
// name the nearest flag resting on the ground within `_identifyRange` for them
// alone. Runs off each accepted position update, as upstream runs it off
// MsgPlayerUpdate, so it costs nothing for a player who is not moving.
//
// A flag's identity stays hidden in `flagUpdate` regardless. Identify tells its
// carrier what one flag is; it does not reveal that flag to the world.
function searchFlag(player) {
  const playerFlag = getPlayerFlag(player.id);
  if (playerFlag?.type !== 'ID') {
    // Upstream leaves lastIdFlag alone here, so re-taking Identify beside the
    // same flag stays silent. Clearing it means the answer arrives again, which
    // is what a player who just picked the flag up is waiting for.
    player.lastIdFlag = null;
    return;
  }
  if (player.health <= 0 || player.paused) return;

  let closest = null;
  let closestDistanceSquared = IDENTIFY_RANGE * IDENTIFY_RANGE;
  for (const flag of flags) {
    if (flag.status !== FLAG_STATUS.ON_GROUND) continue;
    const dx = player.x - flag.position.x;
    const dy = player.y - flag.position.y;
    const dz = player.z - flag.position.z;
    const distanceSquared = (dx * dx) + (dy * dy) + (dz * dz);
    if (distanceSquared >= closestDistanceSquared) continue;
    closestDistanceSquared = distanceSquared;
    closest = flag;
  }

  if (!closest) {
    player.lastIdFlag = null;
    return;
  }
  // One message per flag, not one per update: the answer only changes when a
  // different flag becomes the nearest one.
  if (closest.index === player.lastIdFlag) return;
  player.lastIdFlag = closest.index;
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

function dropFlag(flag) {
  if (flag.status !== FLAG_STATUS.ON_TANK) return;
  const owner = getFlagOwner(flag);
  if (!owner) return;
  flag.grabbedAt = 0;

  const from = getFlagDropPosition(owner);
  const half = GAME_CONFIG.MAP_SIZE / 2;
  const launch = {
    x: (from.x < -half || from.x > half) ? 0 : from.x,
    y: from.y + FLAG_LAUNCH_TANK_HEIGHT,
    z: (from.z < -half || from.z > half) ? 0 : from.z,
  };
  const teamFlag = flag.team !== null;
  // Both kinds ride the same downward ray, cast from the tank's feet rather than
  // from the flag's launch altitude: dropIt gets `dropPos` while
  // FlagInfo::dropFlag adds the tank height to the launch point separately.
  let landing = {
    x: launch.x,
    y: findFlagLandingY(launch.x, launch.z, from.y),
    z: launch.z,
  };
  let vanish = false;

  if (teamFlag) {
    // A team flag never vanishes, so when it has nowhere safe to land upstream
    // works down a chain: a drop zone, which bzo has none of, then the world
    // centre, then its own base.
    if (isOpposingBaseAt(landing, flag.team)) {
      const centre = { x: 0, y: 0, z: 0 };
      if (isOpposingBaseAt(centre, flag.team)) {
        const base = getRandomTeamBase(flag.team);
        landing = base ? { x: base.x, y: getBaseTopY(base), z: base.z } : centre;
      } else {
        landing = centre;
      }
    }
    startTeamFlagTimeoutIfAbandoned(flag);
  } else {
    // A good superflag has a limited number of grabs in it. With flags on
    // buildings off -- upstream's default -- one dropped anywhere but the ground
    // also has nowhere it is allowed to stay, so it rises out of the world from
    // wherever the ray put it rather than falling to the floor.
    flag.grabs -= 1;
    if (flag.grabs <= 0) {
      vanish = true;
      flag.grabs = 0;
    } else if (!FLAGS_ON_BUILDINGS && landing.y > 0) {
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
  flag.flightStartedAt = Date.now();
  log(
    `"${owner.name}" dropped ${getFlagType(flag.type).name} flag ${flag.index} ` +
    `at ${landing.x.toFixed(2)},${landing.z.toFixed(2)}${vanish ? ' (vanishing)' : ''}`
  );

  sendFlagDrop(flag);
  broadcastFlagUpdate(flag);
}

// captureFlag(). Either an enemy flag brought onto the player's own base, or the
// player's own flag carried onto an enemy base. `baseColorIndex` is the base the
// client says it reached; the team that loses the flag is always the flag's own,
// so capturing your own flag costs your team and wins nobody anything.
function captureFlag(player, baseColorIndex) {
  const flag = getPlayerFlag(player.id);
  if (!flag || flag.team === null) return;
  if (player.health <= 0 || player.paused) return;
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
  log(
    `"${player.name}" captured the ${cappedTeam} flag ` +
    `on the ${getTeamFromColorIndex(baseColorIndex)} base${ownGoal ? ' (their own)' : ''}`
  );

  // The flag goes home first, as upstream does it, so the drop that detaches it
  // reaches the client before the capture that explains it and before any client
  // respawns on the base it now sits on.
  resetFlag(flag);
  broadcastAll({
    type: 'captureFlag',
    playerId: player.id,
    index: flag.index,
    flagTeam: cappedIndex,
    baseTeam: baseColorIndex,
  });
  recordTeamScoreForCapture(ownGoal ? null : player.team, cappedTeam);

  // Everyone on the losing team dies and comes back on their own base. Upstream
  // scores no deaths for them -- the team loss is the whole penalty.
  players.forEach((victim) => {
    if (victim.team !== cappedTeam) return;
    victim.restartOnBase = true;
    if (victim.health <= 0) return;
    victim.health = 0;
    dropPlayerFlag(victim.id);
    broadcastAll({
      type: 'playerHit',
      victimId: victim.id,
      shooterId: player.id,
      projectileId: null,
      captured: true,
    });
    setTimeout(() => {
      if (!players.has(victim.id)) return;
      victim.respawn();
      broadcastAll({ type: 'playerRespawned', player: victim.getState() });
    }, GAME_CONFIG.RESPAWN_DELAY);
  });
}

// zapFlagByPlayer(). Death, disconnect, a pause, or a self-destruct all give up
// the flag: a droppable one is thrown where the tank stood, a sticky one just
// goes away.
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
  if (player.jumpDirection !== null && player.jumpDirection !== undefined) {
    return 'Can\'t pause when you are in the air';
  }
  if (checkCollision(player.x, player.y, player.z, BZFLAG_TANK_RADIUS, { suppressLog: true })) {
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
  // A paused tank sends no position updates, so the first move message after a
  // pause arrives however long the pause lasted after the last one -- and the
  // drift check reads that whole gap through the stored velocities, which would
  // carry a tank that was rolling when it paused clean across the map. The
  // velocities themselves are left alone, as LocalPlayer.cxx:284 leaves them
  // alone ("set dt to zero instead of clearing velocity ... for when we
  // resume"): both ends kept them, so both ends still agree.
  player.lastUpdate = Date.now();

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

function requestPause(player) {
  // pausePlayer() (bzfs.cxx:2778) ignores a pause from a tank that is not alive,
  // and an observer has no tank to pause at all.
  if (player.team === 'observer' || player.health <= 0) return;

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
  const startedLife = player.deaths;
  player.pauseTimer = setTimeout(() => {
    player.pauseTimer = null;
    if (!players.has(player.id) || player.deaths !== startedLife || player.health <= 0) {
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
  if (zoneFlagCount > 0 || skippedZoneFlags.size > 0) {
    log(
      `Flags: ${zoneFlagCount} zone flags from ${MAP_ZONES.length} zones`
      + (skippedZoneFlags.size > 0
        ? `; skipped ${skippedZoneFlags.size} type${skippedZoneFlags.size === 1 ? '' : 's'}`
          + ` bzo does not have or the game style forbids`
          + ` (${Array.from(skippedZoneFlags).sort().join(', ')})`
        : '')
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
// server/voice-channels.cjs, mirrored to public/voice-channels.mjs, and the
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

// An observer's heartbeat, sent every MAX_UPDATE_INTERVAL by the client. It has
// no tank: nothing collides with it, nothing it does originates a shot, and the
// only thing on the server that reads its position is the nearby voice roster.
// So the position is taken as sent. The one test is that the numbers are
// numbers, because a NaN would poison the distance maths -- that is parsing, not
// validation, and there is deliberately no validation here.
//
// Velocities are forced to zero rather than read, so no path extrapolates a
// camera between heartbeats. The position is simply five seconds stale at worst.
//
// It goes out as an ordinary `pm`, because the other clients need it too: voice
// is peer to peer, so each client decides for itself how loud a peer is and
// where it stands, and it can only do that for an observer it can locate. Zero
// velocities mean the receiving end has nothing to extrapolate either, and the
// mesh it moves is the invisible one every observer already has at health 0.
//
// What this allows is being heard from somewhere you are not, which is a small
// thing beside what an observer may already watch, and smaller still beside a
// modified client picking a channel that ignores distance.
function applyObserverHeartbeat(player, message, ws) {
  const x = Number(message.x);
  const y = Number(message.y);
  const z = Number(message.z);
  const r = Number(message.r);
  if (![x, y, z, r].every(Number.isFinite)) return;
  player.x = x;
  player.y = y;
  player.z = z;
  player.rotation = r;
  player.forwardSpeed = 0;
  player.rotationSpeed = 0;
  player.verticalVelocity = 0;
  broadcast({
    type: 'pm',
    id: player.id,
    x, y, z, r,
    fs: 0,
    rs: 0,
    vv: 0,
    vx: 0,
    vz: 0,
  }, ws);
}

function isVoicePeer(source, target) {
  if (!source || !target || source.id === target.id) return false;
  if (!source.joined || !target.joined) return false;
  // Infinity rather than 0 for a player with no position yet: out of earshot is
  // the safe reading, and only Nearby consults it at all.
  const planar = Number.isFinite(source.x) && Number.isFinite(source.z)
    && Number.isFinite(target.x) && Number.isFinite(target.z)
    ? distance(source.x, source.z, target.x, target.z)
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
function getShotTeleporterDims(obs) {
  const halfW = obs.w / 2;
  const halfD = obs.d / 2;
  const h = obs.h;
  const border = obs.border;
  return {
    halfW,
    halfD,
    h,
    border,
    activeHalfD: Math.max(0.1, halfD - border),
    activeH: Math.max(0.2, h - border),
  };
}

const BZFLAG_TELEPORT_TOLERANCE = 1e-6;

function getSegmentBoxEntryTime(localStart, localEnd, bounds) {
  const delta = {
    x: localEnd.x - localStart.x,
    y: localEnd.y - localStart.y,
    z: localEnd.z - localStart.z,
  };

  let tMin = 0;
  let tMax = 1;
  const axes = ['x', 'y', 'z'];

  for (const axis of axes) {
    const start = localStart[axis];
    const d = delta[axis];
    const min = bounds.min[axis];
    const max = bounds.max[axis];

    if (Math.abs(d) < 1e-9) {
      if (start < min || start > max) return null;
      continue;
    }

    let t1 = (min - start) / d;
    let t2 = (max - start) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }

    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }

  if (tMax < 0 || tMin > 1) return null;
  return Math.max(0, tMin);
}

function getShotTeleporterCrossing(start, end, obs) {
  const dims = getShotTeleporterDims(obs);
  const startLocalXZ = getColliderLocalPoint(start.x, start.z, obs);
  const endLocalXZ = getColliderLocalPoint(end.x, end.z, obs);

  const localStart = {
    x: startLocalXZ.x,
    y: start.y - (obs.baseY || 0),
    z: startLocalXZ.z,
  };
  const localEnd = {
    x: endLocalXZ.x,
    y: end.y - (obs.baseY || 0),
    z: endLocalXZ.z,
  };

  const outerBounds = {
    min: { x: -dims.halfW, y: 0, z: -dims.halfD },
    max: { x: dims.halfW, y: dims.h, z: dims.halfD },
  };
  const innerBounds = {
    min: { x: -dims.halfW, y: 0, z: -dims.activeHalfD },
    max: { x: dims.halfW, y: dims.activeH, z: dims.activeHalfD },
  };

  const tOuter = getSegmentBoxEntryTime(localStart, localEnd, outerBounds);
  const tInner = getSegmentBoxEntryTime(localStart, localEnd, innerBounds);
  if (tInner === null || tInner < 0 || tInner > 1) return null;

  // Match BZFlag Teleporter::isTeleported behavior: if the outer frame
  // is hit before the inner active slab, this is a frame hit (no teleport).
  if (tOuter !== null && (tInner - tOuter) > BZFLAG_TELEPORT_TOLERANCE) return null;

  const hitLocalX = localStart.x + (localEnd.x - localStart.x) * tInner;
  const face = hitLocalX > 0 ? 0 : 1;
  const sourceFaceId = obs.teleporterIndex * 2 + face;

  return {
    t: tInner,
    face,
    sourceFaceId,
    tOuter,
    point: {
      x: start.x + (end.x - start.x) * tInner,
      y: start.y + (end.y - start.y) * tInner,
      z: start.z + (end.z - start.z) * tInner,
    },
  };
}

function getShotTeleporterFrameHit(start, end, obs) {
  const dims = getShotTeleporterDims(obs);
  const startLocalXZ = getColliderLocalPoint(start.x, start.z, obs);
  const endLocalXZ = getColliderLocalPoint(end.x, end.z, obs);

  const localStart = {
    x: startLocalXZ.x,
    y: start.y - (obs.baseY || 0),
    z: startLocalXZ.z,
  };
  const localEnd = {
    x: endLocalXZ.x,
    y: end.y - (obs.baseY || 0),
    z: endLocalXZ.z,
  };

  const outerBounds = {
    min: { x: -dims.halfW, y: 0, z: -dims.halfD },
    max: { x: dims.halfW, y: dims.h, z: dims.halfD },
  };
  const innerBounds = {
    min: { x: -dims.halfW, y: 0, z: -dims.activeHalfD },
    max: { x: dims.halfW, y: dims.activeH, z: dims.activeHalfD },
  };

  const tOuter = getSegmentBoxEntryTime(localStart, localEnd, outerBounds);
  if (tOuter === null || tOuter < 0 || tOuter > 1) return null;

  const tInner = getSegmentBoxEntryTime(localStart, localEnd, innerBounds);
  if (tInner !== null && tInner >= 0 && tInner <= 1 && (tInner - tOuter) <= BZFLAG_TELEPORT_TOLERANCE) {
    return null;
  }

  return {
    t: tOuter,
    point: {
      x: start.x + (end.x - start.x) * tOuter,
      y: start.y + (end.y - start.y) * tOuter,
      z: start.z + (end.z - start.z) * tOuter,
    },
  };
}

function rotateXZ(x, z, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: cos * x - sin * z,
    z: sin * x + cos * z,
  };
}

function transformShotThroughTeleporter(pointIn, dirIn, sourceObs, sourceFace, destObs, destFace) {
  const srcDims = getShotTeleporterDims(sourceObs);
  const dstDims = getShotTeleporterDims(destObs);

  const radians1 = (sourceObs.rotation || 0) + (sourceFace === 0 ? 0 : Math.PI);
  const radians2 = (destObs.rotation || 0) + (destFace === 1 ? 0 : Math.PI);

  const relativeX = pointIn.x - sourceObs.x;
  const relativeZ = pointIn.z - sourceObs.z;
  const relativeY = pointIn.y - (sourceObs.baseY || 0);
  const local = rotateXZ(relativeX, relativeZ, -radians1);

  const breadthScale = srcDims.activeHalfD > 1e-6 ? (dstDims.activeHalfD / srcDims.activeHalfD) : 1;
  const heightScale = srcDims.activeH > 1e-6 ? (dstDims.activeH / srcDims.activeH) : 1;

  const localOut = {
    x: -dstDims.halfW,
    z: local.z * breadthScale,
    y: relativeY * heightScale,
  };

  const rotatedOut = rotateXZ(localOut.x, localOut.z, radians2);
  const pointOut = {
    x: destObs.x + rotatedOut.x,
    y: (destObs.baseY || 0) + localOut.y,
    z: destObs.z + rotatedOut.z,
  };

  const rotateDelta = radians2 - radians1;
  const dirRotated = rotateXZ(dirIn.x, dirIn.z, rotateDelta);
  const dirOut = {
    x: dirRotated.x,
    y: dirIn.y,
    z: dirRotated.z,
  };

  return { pointOut, dirOut };
}

function getShotTeleportDestinationFace(sourceFaceId) {
  const destinations = TELEPORTER_LINKS_BY_SOURCE_FACE.get(sourceFaceId);
  if (destinations && destinations.length > 0) return destinations[0];
  const teleIndex = Math.floor(sourceFaceId / 2);
  const oppositeFace = (teleIndex * 2) + (1 - (sourceFaceId % 2));
  return oppositeFace;
}

const SHOT_TELEPORT_REENTRY_BLOCK_DISTANCE = 0.5;
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
  const obstacleBase = obs.baseY || 0;
  const epsilon = 0.15;
  const tankTop = y + tankRadius;
  const { x: localX, z: localZ } = getColliderLocalPoint(x, z, obs);
  const dims = getShotTeleporterDims(obs);
  const innerDistSquared = getBoxCollisionDistanceSquared(localX, localZ, dims.halfW, dims.activeHalfD);
  const activeBaseY = obstacleBase;
  const activeTopY = obstacleBase + dims.activeH;
  const overlapsActiveVertical = tankTop > (activeBaseY + epsilon) && y < (activeTopY - epsilon);
  return overlapsActiveVertical && innerDistSquared < tankRadius * tankRadius;
}

function applyPlayerTeleportMessage(player, sourceState, fromFaceId, toFaceId, now) {
  if (!player || !sourceState || !Number.isInteger(fromFaceId) || !Number.isInteger(toFaceId)) {
    return { ok: false, reason: 'invalid_packet' };
  }

  if (!Number.isFinite(sourceState.x) || !Number.isFinite(sourceState.y) || !Number.isFinite(sourceState.z)) {
    return { ok: false, reason: 'invalid_source_state' };
  }

  const sourceRotation = Number.isFinite(sourceState.r) ? sourceState.r : player.rotation;
  const sourceVerticalVelocity = Number.isFinite(sourceState.vv) ? sourceState.vv : player.verticalVelocity;
  const sourceAirVelocityX = Number.isFinite(sourceState.vx) ? sourceState.vx : player.airVelocityX;
  const sourceAirVelocityZ = Number.isFinite(sourceState.vz) ? sourceState.vz : player.airVelocityZ;
  const hasSourceJumpDirection = sourceState.jd !== null && Number.isFinite(sourceState.jd);
  const sourceJumpDirection = hasSourceJumpDirection ? sourceState.jd : player.jumpDirection;

  if (now < (player.teleportCooldownUntil || 0)) {
    return { ok: false, reason: 'cooldown' };
  }

  const expectedToFaceId = getShotTeleportDestinationFace(fromFaceId);
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
  if (!validateMovement(player, sourceState.x, sourceState.y, sourceState.z, sourceRotation, deltaTime, true)) {
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
  player.rotation = sourceRotation;
  player.verticalVelocity = sourceVerticalVelocity;
  player.airVelocityX = sourceAirVelocityX;
  player.airVelocityZ = sourceAirVelocityZ;
  player.jumpDirection = sourceJumpDirection;

  const moveDirection = player.slideDirection !== undefined
    ? player.slideDirection
    : (player.jumpDirection !== null && player.jumpDirection !== undefined ? player.jumpDirection : player.rotation);
  const dirIn = {
    x: -Math.sin(moveDirection),
    y: 0,
    z: -Math.cos(moveDirection),
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
  const outY = Math.max(0, transformed.pointOut.y + transformed.dirOut.y * PLAYER_TELEPORT_EXIT_EPSILON);
  const outZ = transformed.pointOut.z + transformed.dirOut.z * PLAYER_TELEPORT_EXIT_EPSILON;

  // "Tank becomes very large.  Can't fit through teleporters." Obesity needs no
  // rule of its own for that: the portal interior is checked at full size, so a
  // tank too wide for the opening is simply blocked here.
  const destinationCollision = checkCollision(outX, outY, outZ, 2, {
    ignoreTeleporters: true,
    rotation: player.rotation,
    suppressLog: true,
    tankScale: getPlayerTankScale(player),
  });
  if (destinationCollision) {
    return { ok: false, reason: 'blocked_exit' };
  }

  const radians1 = (sourceObs.rotation || 0) + (sourceFace === 0 ? 0 : Math.PI);
  const radians2 = (destinationObs.rotation || 0) + (destinationFace === 1 ? 0 : Math.PI);
  const rotateDelta = radians2 - radians1;

  player.x = outX;
  player.y = outY;
  player.z = outZ;
  player.rotation = normalizeAngle(player.rotation + rotateDelta);
  if (player.slideDirection !== undefined) {
    player.slideDirection = normalizeAngle(player.slideDirection + rotateDelta);
  }
  if (player.jumpDirection !== null && player.jumpDirection !== undefined) {
    player.jumpDirection = normalizeAngle(player.jumpDirection + rotateDelta);
  }
  if (Number.isFinite(player.airVelocityX) && Number.isFinite(player.airVelocityZ)) {
    const rotatedAirVelocity = rotateXZ(player.airVelocityX, player.airVelocityZ, rotateDelta);
    player.airVelocityX = rotatedAirVelocity.x;
    player.airVelocityZ = rotatedAirVelocity.z;
  }

  player.teleportReentryBlockTeleporterIndex = destinationTeleporterIndex;
  player.teleportReentryBlockDistance = Math.max(
    PLAYER_TELEPORT_REENTRY_BLOCK_DISTANCE,
    (getShotTeleporterDims(destinationObs).halfW * 2) + 0.25,
  );
  player.teleportReentryBlockUntil = now + PLAYER_TELEPORT_REENTRY_BLOCK_MIN_MS;
  player.teleportCooldownUntil = now + PLAYER_TELEPORT_COOLDOWN_MS;
  player.lastUpdate = now;

  return {
    ok: true,
    fromFaceId,
    toFaceId,
  };
}

function traceShotThroughTeleporters(start, dir, travelDistance, projectileId, reentryBlockTeleporterIndex = null, reentryBlockDistance = 0) {
  let point = { ...start };
  let direction = { ...dir };
  let remaining = travelDistance;
  let teleports = 0;
  let blockedTeleporterIndex = Number.isInteger(reentryBlockTeleporterIndex) ? reentryBlockTeleporterIndex : null;
  let blockedDistance = Math.max(0, Number(reentryBlockDistance) || 0);
  const maxTeleportsPerTick = 8;

  while (remaining > 1e-6 && teleports < maxTeleportsPerTick) {
    const end = {
      x: point.x + direction.x * remaining,
      y: point.y + direction.y * remaining,
      z: point.z + direction.z * remaining,
    };

    let earliest = null;
    for (const obs of TELEPORTER_OBSTACLES_BY_INDEX.values()) {
      const crossing = getShotTeleporterCrossing(point, end, obs);
      if (crossing) {
        if (blockedTeleporterIndex !== null && blockedDistance > 1e-6 && obs.teleporterIndex === blockedTeleporterIndex) {
          // Ignore immediate re-entry to the just-exited teleporter.
        } else if (!earliest || crossing.t < earliest.event.t) {
          earliest = { obs, type: 'teleport', event: crossing };
        }
      }

      const frameHit = getShotTeleporterFrameHit(point, end, obs);
      if (frameHit && (!earliest || frameHit.t < earliest.event.t)) {
        earliest = { obs, type: 'frameHit', event: frameHit };
      }
    }

    if (!earliest) {
      blockedDistance = Math.max(0, blockedDistance - remaining);
      if (blockedDistance <= 1e-6) blockedTeleporterIndex = null;
      point = end;
      break;
    }

    if (earliest.type === 'frameHit') {
      return {
        point: earliest.event.point,
        direction,
        teleports,
        reentryBlockTeleporterIndex: blockedTeleporterIndex,
        reentryBlockDistance: Math.max(0, blockedDistance - (remaining * earliest.event.t)),
        frameHit: true,
        frameHitObstacle: earliest.obs,
      };
    }

    const sourceObs = earliest.obs;
    const sourceFaceId = earliest.event.sourceFaceId;
    const destFaceId = getShotTeleportDestinationFace(sourceFaceId);
    const destTeleporterIndex = Math.floor(destFaceId / 2);
    const destFace = destFaceId % 2;
    const sourceFace = sourceFaceId % 2;
    const destObs = TELEPORTER_OBSTACLES_BY_INDEX.get(destTeleporterIndex);

    if (!destObs) {
      break;
    }

    const transformed = transformShotThroughTeleporter(
      earliest.event.point,
      direction,
      sourceObs,
      sourceFace,
      destObs,
      destFace,
    );

    const consumedDistance = remaining * earliest.event.t;
    blockedDistance = Math.max(0, blockedDistance - consumedDistance);
    if (blockedDistance <= 1e-6) blockedTeleporterIndex = null;
    remaining = Math.max(0, remaining - consumedDistance);
    point = {
      x: transformed.pointOut.x + transformed.dirOut.x * 0.02,
      y: transformed.pointOut.y + transformed.dirOut.y * 0.02,
      z: transformed.pointOut.z + transformed.dirOut.z * 0.02,
    };
    direction = transformed.dirOut;
    blockedTeleporterIndex = destTeleporterIndex;
    blockedDistance = Math.max(
      SHOT_TELEPORT_REENTRY_BLOCK_DISTANCE,
      (getShotTeleporterDims(destObs).activeHalfD * 2) + 0.05,
    );
    teleports++;

    log(`[SHOT_TP] id=${projectileId} srcFace=${sourceFaceId} dstFace=${destFaceId} src=${sourceObs.linkName || sourceObs.name} dst=${destObs.linkName || destObs.name}`);
  }

  return {
    point,
    direction,
    teleports,
    reentryBlockTeleporterIndex: blockedTeleporterIndex,
    reentryBlockDistance: blockedDistance,
    frameHit: false,
    frameHitObstacle: null,
  };
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
  const rollers = [];
  players.forEach((player) => {
    if (player.health <= 0 || player.paused || player.team === 'observer') return;
    if (!crushesOnContact(getPlayerFlag(player.id)?.type ?? null)) return;
    rollers.push({ player, at: player.getExtrapolatedPosition(now) });
  });
  if (rollers.length === 0) return;

  players.forEach((victim) => {
    // A paused tank cannot be hit by a shot in bzo, so it cannot be run over
    // either. Upstream only checks the roller's pause; the victim is the local
    // tank and its own pause is read further up the same chain.
    if (victim.health <= 0 || victim.paused || victim.team === 'observer') return;
    const victimFlag = getPlayerFlag(victim.id)?.type ?? null;
    const victimAt = victim.getExtrapolatedPosition(now);

    for (const roller of rollers) {
      if (roller.player.id === victim.id) continue;
      // Squashing is a kill like any other, so friendly fire governs it: the
      // guard is upstream's own, in this very loop (playing.cxx:4212).
      if (NO_TEAM_KILLS
        && !areFoes(roller.player.team, victim.team, TEAM_MODE.enabled)) continue;

      const rollerFlag = getPlayerFlag(roller.player.id)?.type ?? null;
      const radius = getRunOverRadius(victimFlag, rollerFlag, TANK_HIT_RADIUS);
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
    ` origin=${formatShotPoint(projectile.originX, projectile.y, projectile.originZ)}` +
    ` dir=(${projectile.dirX.toFixed(4)},${(projectile.dirY || 0).toFixed(4)},${projectile.dirZ.toFixed(4)})${extra}`
  );
}

// FiringInfo::shot.team, which upstream sets from the shooter at fire time and
// then admits it never reads ("FIXME team coloring of shot is never used").
// bzo asks the shooter instead, which differs only if somebody changed team
// mid-flight -- and a shot that turned friendly in the air would be the stranger
// of the two answers.
function getShotTeam(proj) {
  return players.get(proj.playerId)?.team ?? null;
}

// The tank a shot's hit test sees: bzo's own radius, which is not upstream's
// `_tankRadius` 4.32, and `_tankHeight` from the collision pair, which is.
// Phase 7's dimension flags scale the radius, following upstream's own basis --
// `Player::getRadius` is `dimensionsScale[0] * _tankRadius`, the length scale on
// the base radius -- so the factors are upstream's and the base stays bzo's.
const TANK_HIT_RADIUS = 2;
const TANK_HIT_HEIGHT = TANK_HEIGHT;

// How far along a segment a shot first comes within a tank radius of one tank's
// centre, or null if it never does. This is SegmentedShotStrategy::checkHit's
// ray test reduced to bzo's upright cylinder: upstream tests the frame's whole
// ray rather than sampling a point on it, which is what lets a Rapid Fire shell
// -- 2.5 units of travel a step against a tank 4 units across -- hit the edge of
// a tank instead of stepping past it.
//
// A shot that starts the segment already inside the radius strikes where it
// started, which is what a beam fired point blank does.
function getSegmentTankHitFraction(from, to, tank, flagType = null) {
  // SegmentedShotStrategy::checkHit's two shapes. Narrow is the exception and
  // upstream says why in place: the box is "shell radius" wide rather than tank
  // width, "so you can actually hit narrow tank head on". Its length is the
  // tank's full length, unscaled, because Narrow does not touch that axis.
  if (usesNarrowHitBox(flagType)) {
    return getSegmentBoxHitFraction(
      from.x, from.z, to.x, to.z,
      tank.x, tank.z,
      // getExtrapolatedPosition names the heading `r`; a tank object straight off
      // a player names it `rotation`. Both reach here.
      getTankLocalAngle(Number.isFinite(tank.r) ? tank.r : (tank.rotation || 0)),
      GAME_CONFIG.SHOT_RADIUS,
      TANK_HALF_LENGTH
    );
  }
  // Every other flag, and no flag, meets the sphere -- scaled by the length
  // factor, which is the axis Player::getRadius reads.
  const radius = TANK_HIT_RADIUS * getTankHitRadiusScale(flagType);
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const fx = from.x - tank.x;
  const fz = from.z - tank.z;
  const a = (dx * dx) + (dz * dz);
  const b = (fx * dx) + (fz * dz);
  const c = (fx * fx) + (fz * fz) - (radius * radius);
  if (a < 1e-12) return c <= 0 ? 0 : null;
  const discriminant = (b * b) - (a * c);
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const near = (-b - root) / a;
  if (near > 1) return null;
  if (near < 0) return ((-b + root) / a) < 0 ? null : 0;
  return near;
}

// The nearest tank a shot's segment reaches, with the point it reaches it at, or
// null. A shot is spent by the first tank it meets, so the sweep keeps the
// nearest rather than the last one it looked at; upstream never has this to
// decide, because each client tests only its own tank and one shot is one hit by
// construction.
function findShotPlayerHit(proj, from, to, now) {
  let best = null;
  players.forEach((player) => {
    // LocalPlayer::checkHit tests a player's own shots too -- "Don't shoot
    // yourself!" is the Ricochet flag's own help text -- but only once one has
    // bounced. Before that a shot leaves the muzzle beyond the hit radius and
    // outruns the tank it came from.
    if (player.id === proj.playerId && proj.bounces === 0) return;
    if (player.team === 'observer') return; // Observers are non-combatants
    if (player.paused) return; // Can't hit paused players
    if (player.health <= 0) return; // Can't hit dead players

    // "-noTeamKills: Players on the same team are immune to each other's shots.
    // Rogue is excepted." Upstream refuses this on the victim's own client
    // (LocalPlayer.cxx:1616); bzo refuses it here, where hits are decided. Your
    // own shot still reaches you once it has bounced -- upstream excepts the
    // shooter too (`source != this`), because a ricochet you drove into is
    // nobody's team kill.
    if (NO_TEAM_KILLS && player.id !== proj.playerId
      && !areFoes(getShotTeam(proj), player.team, TEAM_MODE.enabled)) return;

    // LocalPlayer::checkHit (LocalPlayer.cxx:1630): "laser can't hit a cloaked
    // tank". The one rule in phase 13 that is not a matter of what somebody can
    // see -- a cloaked tank is genuinely immune to a beam, so it has to be the
    // server's answer rather than each client's. It is also the reason `CL` is a
    // good flag rather than a cosmetic one.
    if (proj.flag === 'L' && cloaksTheTank(getPlayerFlag(player.id)?.type ?? null)) return;

    // Use extrapolated position for accurate hit detection
    const extrapolated = player.getExtrapolatedPosition(now);
    const playerFlagType = getPlayerFlag(player.id)?.type ?? null;
    const fraction = getSegmentTankHitFraction(from, to, extrapolated, playerFlagType);
    if (fraction === null) return;
    if (best && best.fraction <= fraction) return;

    // The tank's height gate, asked where the shot entered its footprint.
    const y = from.y + ((to.y - from.y) * fraction);
    if (y < extrapolated.y || y > extrapolated.y + TANK_HIT_HEIGHT) return;

    best = {
      player,
      fraction,
      point: {
        x: from.x + ((to.x - from.x) * fraction),
        y,
        z: from.z + ((to.z - from.z) * fraction),
      },
    };
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
});

// playerKilled() (bzfs.cxx:3345). One tank dies, for one reason, and everything
// that follows from it: the score, the flag it was carrying, the message, and
// the respawn. Every way to die in bzo but a capture comes through here -- a
// capture kills a whole team at once and scores nobody, which is a different
// rule rather than a repeat of this one.
function killPlayer(victim, killer, reason, projectileId = null) {
  // "victim was already dead. keep score." Upstream's own guard, and bzo needs
  // it for the same reason plus one of its own: genocide kills a team in a loop,
  // and a team killer who dies for the first of them must not die again for the
  // rest.
  if (victim.health <= 0) return;

  victim.health = 0;
  victim.deaths++;

  // areFoes(): a kill across teams, a rogue killing anyone, or any kill at all
  // on a world without teams. Everything else is a team kill.
  const selfKill = !killer || killer.id === victim.id;
  const teamKill = !selfKill && !areFoes(killer.team, victim.team, TEAM_MODE.enabled);
  if (!selfKill) {
    if (teamKill) {
      // Upstream scores the killer a death rather than a kill for it
      // (`killerData->score.killedBy()`), so a team kill never counts towards
      // shaking a bad flag either.
      killer.deaths++;
    } else {
      killer.kills++;
      recordShakeWin(killer);
    }
  }
  // Killing yourself is a loss and nothing else, as self-destruct is.
  // getTeamScoreDeltasForKill already reads the two being the same player.
  recordTeamScoreForKill(killer, victim);

  dropPlayerFlag(victim.id);

  broadcastAll({
    type: 'playerHit',
    victimId: victim.id,
    shooterId: killer ? killer.id : null,
    projectileId,
    reason,
  });

  setTimeout(() => {
    if (players.has(victim.id)) {
      victim.respawn();
      broadcastAll({
        type: 'playerRespawned',
        player: victim.getState(),
      });
    }
  }, GAME_CONFIG.RESPAWN_DELAY);

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
  // gotBlowedUp() with the shield flag: the tank keeps its life and the flag is
  // thrown as if the player had dropped it -- which is where _shieldFlight sends
  // it up extra high. Nobody scores, because nobody died.
  const carried = getPlayerFlag(player.id);
  if (carried && shieldsAgainstShot(carried.type)) {
    dropPlayerFlag(player.id);
    return 'shield';
  }

  killPlayer(player, players.get(proj.playerId), DEATH_REASON.SHOT, id);

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
    if (other.health <= 0) return;
    log(`Genocide: "${other.name}" goes with "${victim.name}" (${victim.team})`);
    killPlayer(other, killer, DEATH_REASON.GENOCIDE);
  });
}

// The tank a travelling shot reached. One hit and the shot is gone, whichever
// way the tank took it.
function applyShotPlayerHit(proj, id, player, point) {
  projectiles.delete(id);
  const outcome = applyShotVictim(proj, id, player);
  logShotEnd(proj, outcome === 'shield' ? 'shield_hit' : 'player_hit', point, `victim=${player.id}`);
  broadcastAll({ type: 'shotEnd', id, reason: 0, x: point.x, y: point.y, z: point.z });
}

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
  const radiusSquared = radius * radius;
  players.forEach((player) => {
    // "my own shock wave cannot kill me" (LocalPlayer.cxx:1612). Unlike a
    // ricochet there is no bounce that could ever earn it.
    if (player.id === proj.playerId) return;
    if (player.team === 'observer') return;
    if (player.paused) return;
    if (player.health <= 0) return;
    if (proj.shockWaveResolved.has(player.id)) return;
    // Friendly fire, as for any other shot: upstream's team-kill guard is one
    // test in one loop over every shot the shooter owns, and a shock wave is one
    // of them.
    if (NO_TEAM_KILLS && !areFoes(getShotTeam(proj), player.team, TEAM_MODE.enabled)) return;

    const at = player.getExtrapolatedPosition(now);
    const dx = at.x - proj.x;
    const dy = at.y - proj.y;
    const dz = at.z - proj.z;
    if (((dx * dx) + (dy * dy) + (dz * dz)) > radiusSquared) return;

    proj.shockWaveResolved.add(player.id);
    const point = { x: at.x, y: at.y, z: at.z };
    const outcome = applyShotVictim(proj, id, player);
    log(
      `[shockWave] id=${proj.id} player=${proj.playerId} ${outcome} victim=${player.id}` +
      ` at=${formatShotPoint(point.x, point.y, point.z)} radius=${radius.toFixed(2)}`
    );
  });
}

// The first teleporter event on one segment: the portal a shot enters, or the
// frame it hits. traceShotThroughTeleporters asks the same two questions over a
// whole simulation step; a beam has to ask them a segment at a time, because
// over a laser's range a wall stands between the muzzle and a portal far more
// often than not.
function findSegmentTeleporterEvent(from, to, blockedTeleporterIndex, blockedDistance, ignoreFrames) {
  let earliest = null;
  for (const obs of TELEPORTER_OBSTACLES_BY_INDEX.values()) {
    const crossing = getShotTeleporterCrossing(from, to, obs);
    if (crossing) {
      const blocked = blockedTeleporterIndex !== null
        && blockedDistance > 1e-6
        && obs.teleporterIndex === blockedTeleporterIndex;
      if (!blocked && (!earliest || crossing.t < earliest.event.t)) {
        earliest = { obs, type: 'teleport', event: crossing };
      }
    }
    // A frame is a building, and a shot that goes through buildings goes through
    // this one too.
    if (ignoreFrames) continue;
    const frameHit = getShotTeleporterFrameHit(from, to, obs);
    if (frameHit && (!earliest || frameHit.t < earliest.event.t)) {
      earliest = { obs, type: 'frameHit', event: frameHit };
    }
  }
  return earliest;
}

// A beam's whole path, walked when the trigger is pulled. `_laserAdVel` 1000
// puts the shell 1666 units downrange inside one simulation step -- further than
// any bzo world is wide -- so there is nothing left to interpolate, and upstream
// says the same thing by building its laser's entire segment list in
// LaserStrategy's constructor and drawing along it.
//
// Takes whichever of a building, the ground, a teleporter, the world edge and a
// tank the beam reaches first, as makeSegments does, and leaves the segments on
// the projectile for the client to draw. Returns the tank it reached, if any,
// for the caller to resolve once `shotBegin` has gone out: the client has to
// have the shot before it is told the shot killed somebody.
// makeSegments' own maxSegment. A straight beam is one segment; a ricocheting
// one is as many as it can fit into its range, which on an enclosed map is what
// ends it rather than the range doing so.
const MAX_BEAM_SEGMENTS = 100;
// How far off a surface the next segment is traced from, along that surface's
// normal. It has to clear SHOT_COLLISION_RADIUS: within that distance the shot
// still counts as inside the obstacle, and a segment that starts inside
// something is carried straight through it -- so a smaller clearance sent the
// beam through the first wall it bounced off and out of the world. The drawn
// segment still starts at the impact point, so there is no gap to see.
const BEAM_SURFACE_CLEARANCE = SHOT_COLLISION_RADIUS * 4;

function traceShotBeam(proj, now) {
  const obstacles = proj.throughBuildings ? [] : getCollisionColliders();
  const halfMap = GAME_CONFIG.MAP_SIZE / 2;
  let point = { x: proj.x, y: proj.y, z: proj.z };
  // Where the segment is drawn from, which is the surface it bounced off rather
  // than the clearance point the next segment is traced from.
  let drawFrom = { ...point };
  let direction = { x: proj.dirX, y: proj.dirY || 0, z: proj.dirZ };
  let remaining = proj.speed * proj.lifetimeSeconds;
  let blockedTeleporterIndex = null;
  let blockedDistance = 0;
  proj.segments = [];

  for (let segment = 0; segment < MAX_BEAM_SEGMENTS && remaining > 1e-6; segment++) {
    const far = {
      x: point.x + (direction.x * remaining),
      y: point.y + (direction.y * remaining),
      z: point.z + (direction.z * remaining),
    };

    // makeSegments narrows one `t` across the ground, the first building and the
    // first teleporter, so whichever is nearest is what the segment ended on.
    // This is that in bzo's terms: the ground and the buildings are asked over
    // the whole reach, the nearer of the two truncates the segment, and the
    // teleporters are asked over what is left -- a portal behind a wall is not
    // one the beam ever reaches.
    const groundFraction = (direction.y < 0 && far.y < 0)
      ? (0 - point.y) / (direction.y * remaining)
      : Infinity;
    // traceShotStep's rule for a shot that begins inside something: carry it
    // through, because there is no surface between where it is and where it came
    // from to stop it.
    const impact = findShotObstacle(obstacles, point.x, point.y, point.z, SHOT_COLLISION_RADIUS)
      ? null
      : findShotSegmentImpact(obstacles, point, far, SHOT_COLLISION_RADIUS);
    const obstacleFraction = impact ? impact.fraction : Infinity;

    let reason = 'range';
    let obstacle = null;
    let fraction = 1;
    if (obstacleFraction <= groundFraction && obstacleFraction < 1) {
      reason = 'obstacle';
      obstacle = impact.obstacle;
      fraction = obstacleFraction;
    } else if (groundFraction < 1) {
      reason = 'ground';
      fraction = groundFraction;
    }
    let end = {
      x: point.x + ((far.x - point.x) * fraction),
      y: reason === 'ground' ? 0 : point.y + ((far.y - point.y) * fraction),
      z: point.z + ((far.z - point.z) * fraction),
    };

    const teleporterEvent = findSegmentTeleporterEvent(
      point, end, blockedTeleporterIndex, blockedDistance, proj.throughBuildings
    );
    if (teleporterEvent) {
      end = { ...teleporterEvent.event.point };
      reason = teleporterEvent.type === 'frameHit' ? 'frame_hit' : 'teleport';
      obstacle = teleporterEvent.type === 'frameHit' ? teleporterEvent.obs : null;
    }

    if (Math.abs(end.x) > halfMap || Math.abs(end.z) > halfMap) {
      end = findMapEdgeImpactPoint(point.x, point.y, point.z, end.x, end.y, end.z, halfMap);
      reason = 'out_of_bounds';
      obstacle = null;
    }

    const tankHit = findShotPlayerHit(proj, point, end, now);
    if (tankHit) {
      proj.segments.push({ from: { ...drawFrom }, to: { ...tankHit.point }, end: 'player_hit' });
      proj.endReason = 'player_hit';
      return tankHit;
    }

    // Each segment carries what ended it, which is what tells the client to
    // play a ricochet where the next one starts.
    proj.segments.push({ from: { ...drawFrom }, to: { ...end }, end: reason });
    const travelled = Math.hypot(end.x - point.x, end.y - point.y, end.z - point.z);
    remaining = Math.max(0, remaining - travelled);
    blockedDistance = Math.max(0, blockedDistance - travelled);
    if (blockedDistance <= 1e-6) blockedTeleporterIndex = null;
    proj.endReason = reason;

    if (reason === 'teleport') {
      const sourceFaceId = teleporterEvent.event.sourceFaceId;
      const destFaceId = getShotTeleportDestinationFace(sourceFaceId);
      const destTeleporterIndex = Math.floor(destFaceId / 2);
      const destObs = TELEPORTER_OBSTACLES_BY_INDEX.get(destTeleporterIndex);
      if (!destObs) break;
      const transformed = transformShotThroughTeleporter(
        end, direction, teleporterEvent.obs, sourceFaceId % 2, destObs, destFaceId % 2
      );
      point = {
        x: transformed.pointOut.x + (transformed.dirOut.x * BEAM_SURFACE_CLEARANCE),
        y: transformed.pointOut.y + (transformed.dirOut.y * BEAM_SURFACE_CLEARANCE),
        z: transformed.pointOut.z + (transformed.dirOut.z * BEAM_SURFACE_CLEARANCE),
      };
      direction = transformed.dirOut;
      drawFrom = { ...point };
      blockedTeleporterIndex = destTeleporterIndex;
      blockedDistance = Math.max(
        SHOT_TELEPORT_REENTRY_BLOCK_DISTANCE,
        (getShotTeleporterDims(destObs).activeHalfD * 2) + 0.05,
      );
      log(`[SHOT_TP] id=${proj.id} beam srcFace=${sourceFaceId} dstFace=${destFaceId}`);
      continue;
    }

    // makeSegments promotes Stop to Reflect on a world where every shot bounces,
    // so a laser fired there is a beam that bends. Both surfaces bounce it: a
    // building about its own normal, the ground about straight up. A teleporter
    // frame is the one surface that does not, as it is for a flying shot.
    if (proj.ricochet && (reason === 'obstacle' || reason === 'ground')) {
      const normal = reason === 'ground'
        ? { x: 0, y: 1, z: 0 }
        : getShotObstacleNormal(obstacle, end.x, end.y, end.z, SHOT_COLLISION_RADIUS);
      direction = reflectShotDirection(direction.x, direction.y, direction.z, normal);
      // The next segment is traced from clear of the surface, along its normal
      // rather than along the new direction: a grazing bounce leaves almost no
      // perpendicular gap, and it is the perpendicular gap that decides whether
      // the shot still reads as inside. The beam is still drawn from the impact.
      drawFrom = { ...end };
      point = {
        x: end.x + (normal.x * BEAM_SURFACE_CLEARANCE),
        y: end.y + (normal.y * BEAM_SURFACE_CLEARANCE),
        z: end.z + (normal.z * BEAM_SURFACE_CLEARANCE),
      };
      proj.bounces++;
      continue;
    }

    break;
  }

  return null;
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

    // A shot variant's velocity is on the projectile, so a Rapid Fire shell and
    // an ordinary one advance by different amounts in the same step.
    const stepDistance = proj.speed * stepSeconds;
    const prevX = proj.x;
    const prevY = proj.y;
    const prevZ = proj.z;
    const traced = traceShotThroughTeleporters(
      { x: prevX, y: prevY, z: prevZ },
      { x: proj.dirX, y: proj.dirY || 0, z: proj.dirZ },
      stepDistance,
      id,
      proj.teleportReentryBlockTeleporterIndex,
      proj.teleportReentryBlockDistance,
    );
    proj.dirX = traced.direction.x;
    proj.dirY = traced.direction.y;
    proj.dirZ = traced.direction.z;
    proj.teleportReentryBlockTeleporterIndex = traced.reentryBlockTeleporterIndex;
    proj.teleportReentryBlockDistance = traced.reentryBlockDistance;

    if (traced.frameHit && !proj.throughBuildings) {
      const impact = traced.point;
      const hitName = traced.frameHitObstacle?.name || 'teleporter frame';
      log(`Projectile ${id} hit obstacle "${hitName}" at (${impact.x.toFixed(2)}, ${impact.y.toFixed(2)}, ${impact.z.toFixed(2)})`);
      logShotEnd(proj, 'frame_hit', impact, `obstacle=${hitName}`);
      projectiles.delete(id);
      broadcastAll({ type: 'shotEnd', id, reason: 0, x: impact.x, y: impact.y, z: impact.z });
      return;
    }

    // The teleporter trace says where the step ends, not what the shot met on
    // the way, and a step that crossed a portal ends on the far side of it. The
    // segment to test is therefore measured back from that endpoint along the
    // direction the shot is now travelling, which for a step with no teleport in
    // it is exactly where the shot already was.
    const stepStart = traced.teleports > 0
      ? {
        x: traced.point.x - (proj.dirX * stepDistance),
        y: traced.point.y - (proj.dirY * stepDistance),
        z: traced.point.z - (proj.dirZ * stepDistance),
      }
      : { x: prevX, y: prevY, z: prevZ };

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
      distance: stepDistance,
      radius: SHOT_COLLISION_RADIUS,
      ricochet: proj.ricochet,
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
    if (Math.abs(proj.x) > halfMap || Math.abs(proj.z) > halfMap) {
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
function gameLoop() {

  // Advance world time (20 ticks/sec, 24000 ticks/day)
  worldTime = (worldTime + 1) % 24000;
  const now = Date.now();
  const loopDeltaSeconds = Math.min(0.1, Math.max(0, (now - lastGameLoopAt) / 1000));
  lastGameLoopAt = now;
  // No need to broadcast worldTime periodically; clients track it locally at 20 ticks/sec.

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

  applySteamrollerSweep(now);
  updateFlags(now);
}

createFlags();

setInterval(gameLoop, 16); // ~60fps

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
      player.ws.ping();
    }
  });
}, WS_PING_INTERVAL);

// Anti-cheat monitoring: periodic summary report (every 5 minutes)
if (ANTICHEAT_CONFIG.mode !== 'disabled') {
  setInterval(() => {
    const playersWithWarnings = Array.from(players.values())
      .filter(p => p.cheatWarnings.totalWarnings > 0)
      .sort((a, b) => b.cheatWarnings.totalWarnings - a.cheatWarnings.totalWarnings);

    if (playersWithWarnings.length > 0) {
      log(`[ANTICHEAT SUMMARY] ${playersWithWarnings.length} player(s) with warnings:`);
      playersWithWarnings.forEach(p => {
        const timeSinceWarning = Math.floor((Date.now() - p.cheatWarnings.lastWarningTime) / 1000);
        log(`  "${p.name}": ${p.cheatWarnings.totalWarnings} total (${formatCheatWarnings(p)}) - last ${timeSinceWarning}s ago`);
      });
    }
  }, 300000); // 5 minutes
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

function requestServerRestart(reason) {
  log(`Restart requested: ${reason}`);
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

// How long the client had to change its speeds. The server's own measure is the
// gap between packet arrivals, which is the send interval plus whatever the
// network did to it -- when jitter shortens it, an honest ramp looks like an
// impossible one. The client reports the interval it actually ramped over
// (`sdt`), which is the one number neither side can measure alone.
//
// This is a client-asserted input to a cheat check, so it is bounded rather than
// believed: it may only widen the window, and only by SDT_JITTER_ALLOWANCE. A
// modified client buys at most that much extra acceleration, and the drift check
// still bounds where the tank ends up.
function getAccelerationWindow(arrivalGap, clientSendGap) {
  if (!Number.isFinite(arrivalGap) || arrivalGap <= 0) return 0;
  const claimed = Number(clientSendGap);
  if (!Number.isFinite(claimed) || claimed <= arrivalGap) return arrivalGap;
  return Math.min(claimed, arrivalGap + SDT_JITTER_ALLOWANCE);
}


// Helper to send the map list and current map to a given websocket
function sendMapList(ws) {
  ws.send(JSON.stringify({
    type: 'mapList',
    maps: listAvailableMapFiles(),
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
    .map((candidate) => candidate.getState());
}

// WebSocket connection handler
// When a new player connects, assign a default name and number
wss.on('connection', (ws, req) => {

  let player = new Player(ws);
  players.set(player.id, player);

  // Set player as not yet joined (health = 0)
  player.health = 0;

  // A socket with no 'error' listener throws on the first protocol violation or
  // reset, killing the whole server. Any client can send a malformed frame, so
  // this listener is what keeps one bad peer from taking everyone down. ws
  // closes the socket itself afterwards; 'close' does the player cleanup.
  ws.on('error', (err) => {
    logError(`Player ${player.id} socket error: ${err.message}`);
  });

  // Handle pong responses for keep-alive
  ws.on('pong', () => {
    player.lastPongTime = Date.now();
    player.isAlive = true;
  });

  // Nobody is told about this player yet. bzfs's sendPlayerUpdate returns
  // early unless the player isPlaying() (`bzfs.cxx:518`), so a connection
  // sitting in limbo before MsgEnter is never in anyone's roster -- and bzo's
  // limbo player is named `Player n`, which is exactly the placeholder that
  // used to appear on everyone else's scoreboard. The `joinGame` handler does
  // the announcing, once there is a name to announce.

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
  //log(`Player ${player.playerNumber} user agent: ${userAgent}`);

  // Send initial server state in init message
  const clouds = generateClouds(OBSTACLES);
  ws.send(JSON.stringify({
    type: 'init',
    clientBuild: CLIENT_BUILD,
    player: player.getState(),
    players: getRosterFor(player),
    config: GAME_CONFIG,
    teamMode: TEAM_MODE,
    teamScores: getTeamScoreState(),
    voiceRtcConfig: { iceServers: VOICE_ICE_SERVERS },
    obstacles: OBSTACLES,
    teleporterGraph: TELEPORTER_GRAPH,
    flags: getFlagStates(),
    worldTime,
    clouds: clouds,
    serverName: serverConfig.serverName || '',
    description: serverConfig.description || '',
    motd: serverConfig.motd || '',
  }));

  // Handle messages
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {

        case 'message': {
          const rawTarget = message.dst ?? message.to;
          const isAllTarget = rawTarget === 0 || rawTarget === '0' || rawTarget === null || rawTarget === undefined || rawTarget === '';
          const isServerTarget = rawTarget === -1 || rawTarget === '-1';
          const targetId = isAllTarget || isServerTarget ? Number(rawTarget) : String(rawTarget);
          const fromId = player.id;
          const fromName = player.name;
          const msgType = message.msgType === 'action' ? 'action' : 'chat';
          const text = typeof message.text === 'string' ? message.text.trim() : '';
          if (text.length === 0) break;

          function getPlayerName(id) {
            if (id === 0) return 'ALL';
            if (id === -1) return 'SERVER';
            return players.has(id) ? players.get(id).name : `Player ${id}`;
          }
          const toName = getPlayerName(targetId);

          // Log locally only if to == -1
          if (isServerTarget) {
            log(`[CHAT] ${fromName}->${toName}: ${text}`);
            break;
          }

          // Broadcast to all if to == 0
          if (isAllTarget) {
            log(`[CHAT] ${fromName}->ALL: ${text}`);
            broadcastAll({
              type: 'message',
              src: fromId,
              dst: 0,
              msgType,
              text,
              ts: Date.now(),
            });
            break;
          }

          // Send to specific player if id exists
          if (typeof targetId === 'string' && players.has(targetId)) {
            log(`[CHAT] ${fromName}->${toName}: ${text}`);
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
            break;
          }

          // If targetId is invalid, ignore
          break;
        }
        case 'voiceState': {
          if (!player.joined) break;

          // An unrecognized channel normalizes to the default rather than being
          // rejected, so an older or newer client lands somewhere valid instead
          // of silently having no voice at all.
          if (message.channel !== undefined) {
            player.voiceChannel = normalizeVoiceChannel(message.channel);
          }
          player.voiceMicEnabled = message.enabled === true;
          sendVoiceStateUpdate(player);
          // A channel change rewrites other players' rosters too, not just this
          // one's, so every roster is reconsidered rather than only the sender's.
          refreshVoiceRosters();
          break;
        }
        case 'voiceOffer':
        case 'voiceAnswer':
        case 'voiceIceCandidate': {
          forwardVoiceSignal(player, message);
          break;
        }
        case 'debug': {
          // Log debug messages from clients
          const payloadName = typeof message.name === 'string' ? message.name.trim() : '';
          const debugFrom = payloadName || player.name || `Player ${player.playerNumber}`;
          log(`[DEBUG] "${debugFrom}": ${message.message || ''}`);
          break;
        }
        case 'tp': {
          if (player.team === 'observer') break;

          const now = Date.now();
          const sourceState = {
            x: Number(message.x),
            y: Number(message.y),
            z: Number(message.z),
            r: Number(message.r),
            vv: Number(message.vv),
            vx: Number(message.vx),
            vz: Number(message.vz),
            jd: message.jd === null ? null : Number(message.jd),
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
              r: player.rotation,
              vv: player.verticalVelocity || 0,
            }));
            if (teleportResult.reason !== 'cooldown' && teleportResult.reason !== 'reentry_block') {
              log(`[PLAYER_TP_REJECT] player=${player.id} fromFace=${fromFaceId} toFace=${toFaceId} reason=${teleportResult.reason}`);
            }
            break;
          }

          const ptPacket = {
            type: 'pt',
            id: player.id,
            x: player.x,
            y: player.y,
            z: player.z,
            r: player.rotation,
            fs: player.forwardSpeed || 0,
            rs: player.rotationSpeed || 0,
            vv: player.verticalVelocity || 0,
            vx: player.airVelocityX || 0,
            vz: player.airVelocityZ || 0,
            fromFaceId: teleportResult.fromFaceId,
            toFaceId: teleportResult.toFaceId,
            jd: player.jumpDirection,
          };
          if (player.slideDirection !== undefined) {
            ptPacket.d = player.slideDirection;
          }

          broadcastAll(ptPacket);
          log(
            `[PLAYER_TP] player=${player.id} srcFace=${teleportResult.fromFaceId} ` +
            `dstFace=${teleportResult.toFaceId} pos=(${player.x.toFixed(2)},${player.y.toFixed(2)},${player.z.toFixed(2)})`
          );
          break;
        }
        case 'm': {
          if (player.team === 'observer') {
            applyObserverHeartbeat(player, message, ws);
            break;
          }

          const now = Date.now();
          // Calculate deltaTime based on server's last update time
          const deltaTime = (now - player.lastUpdate) / 1000;
          // DON'T update player.lastUpdate here - it breaks extrapolation in validateMovement!

          // Only accept new compact field names
          let x = Number(message.x);
          let y = Number(message.y);
          let z = Number(message.z);
          let r = Number(message.r);
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
            break;
          }

          // The client sends the speed it actually reached, not the key it is
          // holding, so a speed that changed faster than the tank can change
          // speed is a disagreement worth reporting. Only strict mode rewrites
          // it: silently substituting the server's value in warning mode moves
          // the tank the client never asked to move, and then reports the
          // difference back as drift.
          const accelWindow = getAccelerationWindow(deltaTime, message.sdt);
          // A third thing the acceleration model has no term for, beside the two
          // in "The acceleration check cannot see the stick": air control. A
          // `WG` tank steers in mid air, and with `_wingsSlideTime` 0 -- which is
          // upstream's default and bzo's -- its velocity follows the stick with
          // no ramp at all, so a full reversal in one frame is correct rather
          // than impossible. No acceleration bound can describe that, so while
          // such a tank is off the ground the bound does not apply. Refusing it
          // in strict mode would rubber-band the one flag whose whole point is
          // steering where nothing else can.
          const airborne = player.jumpDirection !== null && player.jumpDirection !== undefined;
          const steeringInAir = airborne && hasAirControl(getPlayerFlag(player.id)?.type ?? null);
          if (ANTICHEAT_CONFIG.mode !== 'disabled' && accelWindow > 0 && !steeringInAir) {
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
              const refused = reportCheat(player, 'speedClamped',
                `SPEED CHANGED TOO FAST: fs ${(player.forwardSpeed || 0).toFixed(2)}->${requestedFS.toFixed(2)}`
                + ` (limit ${limitedFS.toFixed(2)}),`
                + ` rs ${(player.rotationSpeed || 0).toFixed(2)}->${requestedRS.toFixed(2)}`
                + ` (limit ${limitedRS.toFixed(2)}),`
                + ` window=${accelWindow.toFixed(3)}s (arrival ${deltaTime.toFixed(3)}s, client ${message.sdt})`);
              if (refused) {
                fs = limitedFS;
                rs = limitedRS;
              }
            } else {
              fs = limitedFS;
              rs = limitedRS;
            }
          }

          let d = message.d !== undefined ? Number(message.d) : undefined; // Optional slide direction
          let vx = message.vx !== undefined ? Number(message.vx) : undefined;
          let vz = message.vz !== undefined ? Number(message.vz) : undefined;
          const hasAirVelocity = Number.isFinite(vx) && Number.isFinite(vz);

          const previousState = {
            x: player.x,
            y: player.y,
            z: player.z,
            r: player.rotation,
          };

          const teleportReentryActive = player.teleportReentryBlockTeleporterIndex !== null
            && (player.teleportReentryBlockDistance > 1e-6 || now < (player.teleportReentryBlockUntil || 0));

          // Track jump direction for extrapolation
          const oldVV = player.verticalVelocity || 0;
          // A tank that was not already climbing and now is has jumped: a
          // grounded one reports exactly 0 and a falling one reports negative,
          // both quantized to two decimals by the sender.
          //
          // The threshold used to be a flat 10, which predated `BY` Bouncy --
          // whose bounce is a random quarter-to-full of the world's jump
          // velocity and starts as low as 4.75 at bzo's default. The server
          // missed those jumps entirely and went on extrapolating the tank along
          // the ground while it was in the air. A tenth of the world's own jump
          // velocity is clear of the quantization and under anything that could
          // be a real jump, and it follows a server that has tuned the jump.
          const isJumpStart = oldVV <= 0 && vv > JUMP_START_VERTICAL_VELOCITY;
          const isLanding = player.jumpDirection !== null && vv === 0; // Transition from air to ground
          const isFallStart = player.jumpDirection === null && vv < 0; // Started falling (drove off edge)

          // Log jump/land/fall events but DON'T update jumpDirection yet - must validate first
          if (isJumpStart) {
            // Calculate expected landing position (assuming ~2 second flight)
            const jumpTime = 2.05; // Approximate jump duration
            const speed = GAME_CONFIG.TANK_SPEED || 15;
            const rotSpeed = GAME_CONFIG.TANK_ROTATION_SPEED || 1.5;
            const dx = -Math.sin(r) * fs * speed * jumpTime;
            const dz = -Math.cos(r) * fs * speed * jumpTime;
            const expectedLandX = x + dx;
            const expectedLandZ = z + dz;
            const expectedLandR = r + rs * rotSpeed * jumpTime;
            log(`[JUMP] "${player.name}" jumped: pos=(${x.toFixed(2)},${z.toFixed(2)}), r=${r.toFixed(2)}, fs=${fs.toFixed(2)}, rs=${rs.toFixed(2)}, vv=${vv.toFixed(2)}`);
            log(`[JUMP] Expected landing: pos=(${expectedLandX.toFixed(2)},${expectedLandZ.toFixed(2)}), r=${expectedLandR.toFixed(2)}`);
          } else if (isLanding) {
            log(`[LAND] "${player.name}" landed: pos=(${x.toFixed(2)},${z.toFixed(2)}), r=${r.toFixed(2)}, fs=${fs.toFixed(2)}, rs=${rs.toFixed(2)}, vv=${vv.toFixed(2)}`);
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
            && !canJump(carriedFlagType, ALLOW_JUMPING, false, GAME_CONFIG.WINGS_JUMP_COUNT);
          const jumpRefused = mayNotJump && reportJumpRejection(player, carriedFlagType);

          // Use actual deltaTime for validation since we compare to extrapolated position
          // The extrapolated position accounts for the full time interval using OLD velocities
          if (!jumpRefused && validateMovement(
            player,
            x,
            y,
            z,
            r,
            deltaTime,
            velocityChanged,
            { ignoreTeleporters: teleportReentryActive }
          )) {
            // Validation passed - now update jumpDirection
            if (isJumpStart) {
              player.jumpDirection = r; // Store rotation at jump start
            } else if (isFallStart) {
              player.jumpDirection = r; // Store rotation at fall start (same as jump)
            } else if (isLanding) {
              player.jumpDirection = null; // Clear jump direction on landing
            }

            // Update position/rotation AND velocities for next extrapolation
            player.x = x;
            player.y = y;
            player.z = z;
            player.rotation = r;
            player.forwardSpeed = fs;
            player.rotationSpeed = rs;
            player.verticalVelocity = vv;
            player.slideDirection = d; // Store slide direction (undefined if not sliding)
            if (hasAirVelocity) {
              player.airVelocityX = vx;
              player.airVelocityZ = vz;
            } else if (player.jumpDirection !== null) {
              const speed = GAME_CONFIG.TANK_SPEED || 15;
              const moveDirection = d !== undefined ? d : player.jumpDirection;
              player.airVelocityX = -Math.sin(moveDirection) * fs * speed;
              player.airVelocityZ = -Math.cos(moveDirection) * fs * speed;
            } else {
              player.airVelocityX = 0;
              player.airVelocityZ = 0;
            }

            const movedPlanarDistance = Math.hypot(player.x - previousState.x, player.z - previousState.z);
            decayPlayerTeleportReentryBlock(player, movedPlanarDistance, now);

            player.lastUpdate = now; // Update timestamp AFTER accepting the move

            const pmPacket = {
              type: 'pm',
              id: player.id,
              x,
              y,
              z,
              r,
              fs,
              rs,
              vv,
              vx: player.airVelocityX,
              vz: player.airVelocityZ,
            };

            // Include optional slide direction if present
            if (d !== undefined) {
              pmPacket.d = d;
            }

            broadcast(pmPacket, ws);

            searchFlag(player);
            checkAntidote(player);
          } else {
            // Validation failed - jumpDirection unchanged (no update needed)
            // Send correction back to client
            // Reset velocities and timestamp so next extrapolation starts from corrected state
            player.forwardSpeed = 0;
            player.rotationSpeed = 0;
            player.verticalVelocity = 0;
            player.airVelocityX = 0;
            player.airVelocityZ = 0;
            player.lastUpdate = now;
            ws.send(JSON.stringify({
              type: 'positionCorrection',
              x: player.x,
              y: player.y,
              z: player.z,
              r: player.rotation,
              vv: 0,
            }));
          }
          break;
        }

        case 'shoot': {
          // message: { type: 'shot', x, y, z, dirX, dirZ }
          const shotRejection = getShotRejection(player, message.x, message.y, message.z);
          if (shotRejection
            && reportShotRejection(player, shotRejection.reason, message, shotRejection.fatal)) {
            break;
          }
          const rawDirX = Number(message.dirX);
          const rawDirZ = Number(message.dirZ);
          const rawDirY = Number(message.dirY);
          if (!Number.isFinite(rawDirX) || !Number.isFinite(rawDirZ)) {
            reportShotRejection(player, 'shot direction is not a finite number', message, true);
            break;
          }
          const planarLength = Math.hypot(rawDirX, rawDirZ);
          if (planarLength < 1e-6) {
            reportShotRejection(player, `shot direction has no horizontal component (${planarLength})`, message, true);
            break;
          }
          const shotDirX = rawDirX / planarLength;
          const shotDirZ = rawDirZ / planarLength;
          const shotDirY = Number.isFinite(rawDirY) ? rawDirY : 0;
          // A shot allowed past the slot check in warning mode has no slot left
          // to take. It flies with slot -1: the reload bar ignores it, and the
          // log above already says the client thought it had one.
          const shotSlot = getAvailableShotSlot(player.id);
          const id = (++projectileIdCounter).toString();
          const proj = new Projectile(
            id,
            player.id,
            shotSlot,
            message.x,
            message.y,
            message.z,
            shotDirX,
            shotDirZ,
            shotDirY,
            getPlayerFlag(player.id)?.type ?? null
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
            ` flag=${proj.flag || 'none'}${proj.ricochet ? ' ricochet' : ''}` +
            (proj.beam ? ` beam=${proj.segments.length}seg end=${proj.endReason}` : '') +
            (proj.shockwave ? ` shockwave life=${proj.lifetimeSeconds.toFixed(3)}s` : '')
          );
          broadcastAll({
            type: 'shotBegin',
            id: proj.id,
            playerId: proj.playerId,
            x: proj.x,
            y: proj.y,
            z: proj.z,
            shotSlot: proj.shotSlot,
            dirX: proj.dirX,
            dirY: proj.dirY,
            dirZ: proj.dirZ,
            flag: proj.flag,
            ricochet: proj.ricochet,
            segments: proj.segments,
            createdAt: proj.createdAt
          });
          if (beamHit) applyShotPlayerHit(proj, id, beamHit.player, beamHit.point);
          break;
        }

        // MsgQueryPlayers (`bzfs.cxx:3145`). Upstream answers it with the team
        // table and one MsgAddPlayer per player -- the whole roster, on demand.
        // Its game client never asks, because its world arrives before it
        // enters and nothing can land in between; a bzo client builds the world
        // after it is already receiving, so it asks once it is ready to draw
        // everyone, and that is what guarantees a full scoreboard however the
        // reconnects raced.
        case 'queryPlayers': {
          ws.send(JSON.stringify({
            type: 'playerList',
            players: getRosterFor(player),
          }));
          // sendQueryPlayers sends the team table with the roster, directed at
          // the one player who asked rather than broadcast.
          if (TEAM_MODE.enabled) {
            ws.send(JSON.stringify({ type: 'teamUpdate', teams: getTeamScoreState() }));
          }
          break;
        }

        case 'grabFlag': {
          if (!player.joined) break;
          const requestedIndex = Number(message.index);
          if (!Number.isInteger(requestedIndex)) break;
          const flag = flags[requestedIndex];
          if (!flag) break;
          grabFlag(player, flag);
          break;
        }

        case 'captureFlag': {
          if (!player.joined) break;
          const baseTeam = Number(message.team);
          if (!isColorTeamIndex(baseTeam)) break;
          captureFlag(player, baseTeam);
          break;
        }

        case 'dropFlag': {
          if (!player.joined) break;
          if (player.health <= 0) break;
          const flag = getPlayerFlag(player.id);
          if (!flag) break;
          // A sticky flag cannot be dropped on request; only its shake timeout
          // or a kill gets rid of it. The client runs the countdown, as upstream
          // does, so the server runs the same clock against the moment it saw
          // the grab -- otherwise a modified client sheds a bad flag on contact.
          if (flag.endurance === FLAG_ENDURANCE.STICKY) {
            const held = (Date.now() - flag.grabbedAt) / 1000;
            if (!canShakeFlag(flag.type, FLAG_SHAKE_TIMEOUT, held)) {
              const refused = reportCheat(player, 'flagRejected',
                `SHAKE REJECTED ${getFlagType(flag.type).name} held ${held.toFixed(2)}s `
                + `of ${FLAG_SHAKE_TIMEOUT}s`);
              if (refused) break;
            }
            log(`"${player.name}" shook off ${getFlagType(flag.type).name} after ${held.toFixed(2)}s`);
          }
          dropFlag(flag);
          break;
        }

        case 'selfDestruct': {
          if (player.team === 'observer') break;
          if (player.health <= 0) break;
          player.health = 0;
          player.deaths++;
          recordTeamScoreForKill(player, player);
          dropPlayerFlag(player.id);
          log(`"${player.name}" self-destructed.`);

          broadcastAll({
            type: 'playerHit',
            victimId: player.id,
            shooterId: player.id,
            projectileId: null,
            suicide: true,
          });

          setTimeout(() => {
            if (players.has(player.id)) {
              player.respawn();
              broadcastAll({
                type: 'playerRespawned',
                player: player.getState(),
              });
            }
          }, GAME_CONFIG.RESPAWN_DELAY);
          break;
        }

        case 'joinGame': {
          let joinName = nameCheck(message.name, player.id);
          const requestedTankModel = typeof message.tankModel === 'string'
            ? normalizeTankModelId(message.tankModel)
            : 'bzflag';
          const previousTeam = player.joined ? player.team : null;
          const requestedTeam = normalizePlayerTeamSelection(message.team);
          if (requestedTeam !== 'automatic' && !TEAM_MODE.teams.includes(requestedTeam)) {
            ws.send(JSON.stringify({ error: `Team is not available: ${requestedTeam}` }));
            break;
          }
          const teamCounts = {};
          // What the players on each team have scored between them, which is
          // what auto-assignment balances on. Not the team score.
          const teamPlayerScores = {};
          players.forEach((candidate) => {
            if (!candidate.joined || candidate.id === player.id) return;
            teamCounts[candidate.team] = (teamCounts[candidate.team] || 0) + 1;
            teamPlayerScores[candidate.team] = (teamPlayerScores[candidate.team] || 0) + candidate.kills - candidate.deaths;
          });
          const assignedTeam = selectPlayerTeam(
            requestedTeam, TEAM_MODE, teamCounts, teamPlayerScores, getTeamBaseCenters());
          if (!assignedTeam) {
            ws.send(JSON.stringify({ error: `Team is full: ${requestedTeam}` }));
            break;
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
          player.name = joinName;
          player.tankModel = isAllowedTankModel(requestedTankModel)
            ? requestedTankModel
            : 'bzflag';
          player.team = assignedTeam;
          if (TEAM_MODE.enabled) {
            // A shade inside the new team's band, not the flat team colour:
            // the player is already in the roster here, so they are excluded
            // from the colours to stay clear of.
            player.color = Player.pickDistinctColor(player.team, player);
            // bzfs.cxx:2377 resets a team the moment its size becomes one.
            // `teamCounts` excludes this player, so a lone player rejoining
            // their own team resets it too, as a leave and join would upstream.
            if (!teamCounts[assignedTeam] && isColorTeam(assignedTeam)) {
              teamScores.delete(assignedTeam);
            }
          }
          player.voiceMicEnabled = false;
          player.joined = true;
          player.voiceRosterSignature = '';
          // An observer never comes alive. health 0 is the state the join flow
          // already renders as a scoreboard entry with an invisible tank, which
          // is exactly what an observer wants, and it leaves every path that
          // tests health refusing on its own.
          //
          // It still gets a spawn position, because that is where its camera
          // starts: an observer should arrive standing on the field facing the
          // way a tank would, not hovering at the origin. After that the camera
          // lives on the client and reports itself every five seconds; see
          // applyObserverHeartbeat.
          const joinAsObserver = isObserverTeam(assignedTeam);
          player.health = joinAsObserver ? 0 : 100;
          // PlayerInfo::resetPlayer(ctf) puts every CTF spawn on the team base.
          player.restartOnBase = !joinAsObserver && CTF_ENABLED;
          const spawnPos = getSpawnPosition(player);
          player.x = spawnPos.x;
          player.y = spawnPos.y;
          player.z = spawnPos.z;
          player.rotation = spawnPos.rotation;
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
          player.jumpDirection = null;
          player.slideDirection = undefined;
          player.airVelocityX = 0;
          player.airVelocityZ = 0;
          player.teleportReentryBlockTeleporterIndex = null;
          player.teleportReentryBlockDistance = 0;
          player.teleportReentryBlockUntil = 0;
          player.teleportCooldownUntil = 0;
          player.lastUpdate = Date.now();
          player.deaths = 0;
          player.kills = 0;
          if (message.isMobile) {
            log(`Player ${player.id} joining as "${joinName}" [${player.team.toUpperCase()}] [MOBILE]`);
          } else {
            log(`Player ${player.id} joining as "${joinName}" [${player.team.toUpperCase()}]`);
          }

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

          broadcastAll({
            type: 'playerJoined',
            player: player.getState(),
          });
          broadcastTeamScores();
          refreshVoiceRosters(true);
          // The world's greeting, said only to whoever just arrived. Upstream
          // sends it after the join is complete, so a player is in the roster
          // and can answer before the server has finished talking.
          for (const text of MAP_SERVER_MESSAGES) {
            sendToPlayer(player, {
              type: 'message',
              src: -1,
              dst: player.id,
              msgType: 'server',
              text,
            });
          }
          break;
        }

        case 'setTankModel': {
          const requestedTankModel = typeof message.tankModel === 'string'
            ? normalizeTankModelId(message.tankModel)
            : '';
          if (!isAllowedTankModel(requestedTankModel)) {
            ws.send(JSON.stringify({ error: 'Invalid tank model' }));
            break;
          }

          if (player.tankModel !== requestedTankModel) {
            player.tankModel = requestedTankModel;
            // Same rule as sendPlayerUpdate: nobody hears about a player who is
            // not in the game. A tank picked in the entry dialog before joining
            // travels with the join itself.
            if (player.joined) {
              broadcastAll({
                type: 'playerUpdated',
                player: player.getState(),
              });
            }
          }
          break;
        }

        case 'pause':
          requestPause(player);
          break;

        case 'getMaps': {
          // Reply with all .bzw files in maps/ plus 'random', and indicate current map
          sendMapList(ws);
          break;
        }
        case 'setMap': {
          // Admin: set map
          const mapFile = typeof message.mapFile === 'string' ? message.mapFile.trim() : '';
          const safeMapFile = path.basename(mapFile);
          if (!mapFile || mapFile !== safeMapFile || (mapFile !== 'random' && !mapFile.endsWith('.bzw'))) {
            ws.send(JSON.stringify({ error: 'Invalid map file' }));
            break;
          }
          if (mapFile !== 'random') {
            const selectedMapPath = resolveMapFilePath(mapFile);
            if (!selectedMapPath) {
              ws.send(JSON.stringify({ error: 'Map file not found' }));
              break;
            }
          }
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            config.mapFile = mapFile;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            ws.send(JSON.stringify({ success: true }));
            log(`Admin set map to ${mapFile}. Server restart required.`);
            requestServerRestart(`admin map change to ${mapFile}`);
          } catch (error) {
            logError(`Failed to update config at ${configPath}:`, error);
            ws.send(JSON.stringify({ error: 'Failed to update config' }));
          }
          break;
        }
        case 'uploadMap': {
          // Admin: upload map
          const { mapName, mapContent } = message;
          const normalizedMapName = typeof mapName === 'string' ? mapName.trim() : '';
          const safeMapName = path.basename(normalizedMapName);
          if (!normalizedMapName || normalizedMapName !== safeMapName || !safeMapName.endsWith('.bzw') || !mapContent) {
            ws.send(JSON.stringify({ error: 'Invalid map upload' }));
            break;
          }
          const uploadMapPath = path.join(RUNTIME_MAPS_DIR, safeMapName);
          fs.writeFile(uploadMapPath, mapContent, err => {
            if (err) {
              logError('Map upload failed:', err);
              ws.send(JSON.stringify({ error: 'Failed to save map' }));
              return;
            }
            log(`Admin uploaded new map: ${safeMapName}`);
            ws.send(JSON.stringify({ success: true }));
            // Send direct chat message to uploader
            ws.send(JSON.stringify({
              type: 'message',
              src: -1, // SERVER
              dst: player.id,
              msgType: 'server',
              text: `Upload ${safeMapName} with ${Buffer.byteLength(mapContent, 'utf8')} bytes`
            }));
            // Send updated map list (mapList reply)
            sendMapList(ws);
          });
          break;
        }
        case 'setOperatorConfig': {
          const hasMotd = Object.prototype.hasOwnProperty.call(message, 'motd');
          const hasShotMaxActive = Object.prototype.hasOwnProperty.call(message, 'shotMaxActive');
          const hasRicochet = Object.prototype.hasOwnProperty.call(message, 'ricochet');
          if (!hasMotd && !hasShotMaxActive && !hasRicochet) {
            ws.send(JSON.stringify({ error: 'No supported operator setting provided' }));
            break;
          }

          let nextMotd = serverConfig.motd || '';
          let nextShotMaxActive = GAME_CONFIG.SHOT_MAX_ACTIVE;
          let nextRicochet = GAME_CONFIG.ALL_SHOTS_RICOCHET;

          if (hasMotd) {
            if (typeof message.motd !== 'string') {
              ws.send(JSON.stringify({ error: 'Invalid motd value' }));
              break;
            }
            nextMotd = message.motd.trim();
            if (nextMotd.length > 140) {
              ws.send(JSON.stringify({ error: 'MOTD must be 140 characters or fewer' }));
              break;
            }
          }

          if (hasShotMaxActive) {
            const requestedShotMaxActive = Number(message.shotMaxActive);
            if (!Number.isFinite(requestedShotMaxActive)) {
              ws.send(JSON.stringify({ error: 'Invalid shot max active value' }));
              break;
            }
            nextShotMaxActive = normalizeShotSlotCount(Math.round(requestedShotMaxActive));
          }

          if (hasRicochet) {
            if (typeof message.ricochet !== 'boolean') {
              ws.send(JSON.stringify({ error: 'Invalid ricochet value' }));
              break;
            }
            nextRicochet = message.ricochet;
          }

          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (hasMotd) config.motd = nextMotd;
            if (hasShotMaxActive) config.shotMaxActive = nextShotMaxActive;
            if (hasRicochet) config.ricochet = nextRicochet;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

            if (hasMotd) serverConfig.motd = nextMotd;
            if (hasShotMaxActive) {
              serverConfig.shotMaxActive = nextShotMaxActive;
              GAME_CONFIG.SHOT_MAX_ACTIVE = nextShotMaxActive;
            }
            if (hasRicochet && nextRicochet !== GAME_CONFIG.ALL_SHOTS_RICOCHET) {
              serverConfig.ricochet = nextRicochet;
              GAME_CONFIG.ALL_SHOTS_RICOCHET = nextRicochet;
              applyRicochetGameStyle();
              // A rule everyone is about to be shot by is worth saying out loud.
              broadcastAll({
                type: 'message',
                src: -1,
                dst: 0,
                msgType: 'server',
                text: nextRicochet ? 'All shots now ricochet' : 'Shots no longer ricochet',
              });
            }

            broadcastAll({
              type: 'serverConfigUpdate',
              motd: serverConfig.motd || '',
              shotMaxActive: GAME_CONFIG.SHOT_MAX_ACTIVE,
              ricochet: GAME_CONFIG.ALL_SHOTS_RICOCHET,
            });
            sendMapList(ws);
            ws.send(JSON.stringify({ success: true }));
            log(
              `Operator updated config: motd=${hasMotd ? 'yes' : 'no'} ` +
              `shotMaxActive=${hasShotMaxActive ? String(nextShotMaxActive) : 'unchanged'} ` +
              `ricochet=${hasRicochet ? String(nextRicochet) : 'unchanged'}`
            );
          } catch (error) {
            logError(`Failed to update config at ${configPath}:`, error);
            ws.send(JSON.stringify({ error: 'Failed to update config' }));
          }
          break;
        }
      }
    } catch (err) {
      logError('Error handling message:', err.message);
    }
  });

  // Handle disconnect
  ws.on('close', () => {
    const playerName = player.name;
    const playerNum = player.playerNumber;
    const playerKills = player.kills
    const playerDeaths = player.deaths;
    const cheatWarnings = player.cheatWarnings.totalWarnings;
    const wasJoined = player.joined;
    player.voiceMicEnabled = false;
    player.joined = false;
    clearPauseTimers(player);
    const leavingTeam = player.team;
    dropPlayerFlag(player.id);
    players.delete(player.id);
    retireTeamFlags(getTeamColorIndex(leavingTeam));

    let logMsg = `"${playerName}" (#${playerNum}) disconnected. ${playerKills} kills, ${playerDeaths} deaths.`;
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
});

// Expose the forceClientReload function for manual triggering
// You can call this from the Node.js console or via a signal
global.forceReload = forceClientReload;

// Optional: Listen for SIGUSR1 signal to trigger reload
process.on('SIGUSR1', () => {
  console.log('Received SIGUSR1 signal');
  forceClientReload();
});

// Watch for file changes and auto-reload clients
const publicDir = path.join(__dirname, 'public');
console.log('Watching public/ for changes...');
fs.readdirSync(publicDir).forEach(file => {
  const filePath = path.join(publicDir, file);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    fs.watch(filePath, (eventType, filename) => {
      if (eventType === 'change') {
        console.log(`\n📝 File changed: ${filename || filePath}`);
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
      console.log(`\n📝 server.js changed: ${filename || serverJsPath}`);
      console.log('🔄 Restarting server...\n');
      requestServerRestart('server.js change');
    }
  });
  console.log(`  ✓ Watching: server.js`);
}
