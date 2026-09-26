/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const logPath = require('path').join(__dirname, 'server.log');
// Clear server.log on restart
require('fs').writeFileSync(logPath, '');
const http = require('http');
const { URLSearchParams } = require('url');
const { WebSocketServer } = require('ws');
const {
  DEFAULT_LIST_SERVER,
  PROTOCOL_VERSION: BZFS_PROTOCOL_VERSION,
  GAME_OPTION_BITS,
  findPublicServer,
  fetchServerList,
  fetchWorldFromServer,
  decodeGameSettings,
  decodeQueryGame,
  parseWorldDatabase,
  buildBZWText,
} = require('./server/remote-world-import.cjs');
const {
  normalizeShotSlotCount,
  WORLD_WEAPON_PLAYER_ID,
  WORLD_WEAPON_TEAM,
  getWorldWeaponDirection,
  WORLD_WEAPON_DEFAULT_DELAY,
  normalizeWorldWeaponDelays,
} = require('./server/shots.cjs');
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
  findNearestGroundFlag,
  GM_TURN_ANGLE,
  LOCK_ON_ANGLE,
  TARGETING_ANGLE,
  pickTargetInSights,
  steerGuidedShot,
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
  getFlagGrabCount,
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
  drivesThroughBuildings,
  canRunOver,
  isCrushedByAnyone,
  getGroundLimit,
  getFiredShotFlag,
  isZoned,
  shotPassesThroughTank,
  togglesZoneOnTeleport,
  hidesFromRadar,
  seesThroughDisguises,
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
  SHOT_BOUNCE_CLEARANCE,
  findShotEmbeddedObstacle,
  findShotSegmentImpact,
  getBaseTeamAtPoint,
  getBaseTopY,
  getShotTeleporterDims,
  findTankObstacle,
  findPhysicsSurfaceObstacle,
  resolvePhysicsDriverAt,
  getColliderLocalPoint,
  getObstacleHeight,
  getShotObstacleNormal,
  getTankLocalAngle,
  isOverFlatTop,
  meshFlatTopYsAt,
  isPyramidFlatTop,
  getSegmentBoxHitFraction,
  reflectShotDirection,
  TANK_HALF_LENGTH,
  TANK_HEIGHT,
  traceShotStep,
  WORLD_WALL_HEIGHT,
} = require('./server/collision.cjs');
const { MAX_BUMP_HEIGHT: DEFAULT_MAX_BUMP_HEIGHT } = require('./server/motion.cjs');
const {
  normalizePlayerTeamSelection,
  clampPlayingLimits,
  normalizeRabbitSelection,
  normalizeTeamLimits,
  parseBZWTeamMode,
  resolveTeamMode,
  selectPlayerTeam,
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
  isColorTeamIndex,
  isRabbitTeam,
  getTeamColorIndex,
  getTeamFromColorIndex,
  getTeamScoreDeltasForCapture,
  getTeamScoreDeltasForKill,
  getGameType,
  allowTeams,
  getPlayerRanking,
  pickNewRabbit,
  isARabbitKill,
  PLAYER_TEAM,
  PLAYER_TEAMS,
  teamScoreMovesOnKill,
  areFoes,
} = require('./server/teams.cjs');
const {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  parseCookies,
  isAdminSession,
  isLocalAdminRequest,
  isLoopbackAddress,
  parseAdminWhitelist,
  createSessionStore,
} = require('./server/sessions.cjs');
const {
  KEY_MAX_AGE_MS: LIST_SERVER_KEY_MAX_AGE_MS,
  signListServerChallenge,
  verifyListServerChallenge,
  isKeyStale: isListServerKeyStale,
  createKeyStore: createListServerKeyStore,
} = require('./server/list-server.cjs');
const {
  createLagTracker,
  formatLagStats,
  compareByLag,
  PING_INTERVAL_MS,
} = require('./server/lag.cjs');
const {
  COMMAND_TIER,
  parsePlayerTarget,
  rotationToBearingName,
  parseMoveCoordinates,
  formatFlagInfo,
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
} = require('./server/tank-parts.cjs');
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
const { isHeadsetBrowserUA } = require('./server/headset.cjs');
const { describeListenTarget, resolveListenTarget } = require('./server/listen-address.cjs');
const {
  DEFAULT_VOICE_CHANNEL,
  areVoicePeers,
  normalizeVoiceChannel,
} = require('./server/voice-channels.cjs');


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
function log(...args) {
  const now = new Date();
  const timestamp = now.toISOString();
  const msg = redactInstallPath(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
  const logMsg = `[${timestamp}] ${msg}`;
  // Write to console
  console.log(logMsg);
  // Append to server.log
  fs.appendFileSync(path.join(__dirname, 'server.log'), logMsg + '\n');
}

function logError(...args) {
  const now = new Date();
  const timestamp = now.toISOString();
  const msg = redactInstallPath(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
  const logMsg = `[${timestamp}] [ERROR] ${msg}`;
  console.error(logMsg);
  fs.appendFileSync(path.join(__dirname, 'server.log'), logMsg + '\n');
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
// for the whole internet is a self-inflicted outage rather than a limit. Same
// derivation the handshake logs and `/playerlist` use, and only as trustworthy
// as the proxy -- which is the other reason the ceiling is generous.
function requestAddress(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const forwarded = typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : '';
  return forwarded || req.socket.remoteAddress || 'unknown';
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
  // `MAP_CACHE_DIR` (below) is named for the file's own content hash, so
  // unlike everything else `express.static` serves here it can promise never
  // to change -- checked first because this same function is also the
  // `cacheControl` callback `precompress.middleware()` uses for its brotli
  // responses, and the two representations of a map file must agree.
  if (filePath.startsWith(MAP_CACHE_DIR)) {
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
const MAP_CACHE_DIR = path.join(__dirname, 'cache', 'maps');
app.use('/maps', express.static(MAP_CACHE_DIR, { setHeaders: setStaticHeaders }));
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
    headers: { 'User-Agent': `bzo ${CLIENT_BUILD}` },
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
app.get('/login/:returnPage?', loginRateLimit, async (req, res) => {
  const returnPath = req.params.returnPage === undefined
    ? '/'
    : LOGIN_RETURN_PATHS[req.params.returnPage];
  if (returnPath === undefined) {
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
    const callback = `https://${host}/login${req.params.returnPage ? `/${req.params.returnPage}` : ''}`
      + `?t=%TOKEN%:%USERNAME%`;
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
app.get('/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (sessionId && sessions.remove(sessionId)) {
    log(`[LOGIN] session removed via /logout; sessions=${sessions.size}`);
  }
  res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  res.redirect(302, '/');
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

// Every OBJ in public/obj is a tank the player may choose, except the ones that
// cannot be drawn. A model missing its parts is left out rather than listed:
// the client builds tanks from the file alone, so offering one it cannot build
// would put a player in a tank nobody can see.
function getAvailableTankModels() {
  const objDir = path.join(__dirname, 'public', 'obj');
  const hiddenModelFiles = new Set(['tank.obj']);
  try {
    return fs.readdirSync(objDir)
      .filter((fileName) => fileName.toLowerCase().endsWith('.obj'))
      .filter((fileName) => !hiddenModelFiles.has(fileName.toLowerCase()))
      .filter((fileName) => tankModelIsBuildable(path.join(objDir, fileName)))
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
// whoever is watching from this machine while testing rather than typing
// `/mv` and `/lagstats` and squinting at server.log. Loopback only, and not
// gated behind `localAdmin`: a position is not an admin power, but it is
// exactly what a wallhack wants, so the same untamperable signal
// `isLocalAdminRequest` uses -- loopback, and no proxy hop -- applies
// regardless of that setting.
app.get('/api/players', (req, res) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)
    || Object.keys(req.headers).some((name) => /^x-forwarded-/i.test(name))) {
    res.status(404).end();
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    players: [...players.values()].filter((player) => player.joined).map((player) => {
      const flag = getPlayerFlag(player.id);
      return {
        id: player.id,
        name: player.name,
        team: player.team,
        x: player.x,
        y: player.y,
        z: player.z,
        rotation: player.rotation,
        forwardSpeed: player.forwardSpeed,
        rotationSpeed: player.rotationSpeed,
        verticalVelocity: player.verticalVelocity,
        alive: player.alive,
        wins: player.wins,
        losses: player.losses,
        paused: player.paused,
        flag: flag ? { type: flag.type, zoned: flag.zoned === true } : null,
      };
    }),
  });
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
function formatByteSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function statSizeOrBlank(filePath) {
  try {
    return formatByteSize(fs.statSync(filePath).size);
  } catch {
    return '';
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

// `/list`: bzo servers, bzfs servers, local maps, and (bottom) this
// instance's list-server key admin -- one page rather than the `/view` +
// `/list-server` split that predated this, since a visitor came here for
// "what's running" either way and the key admin is the one part that only
// ever applies to an operator, so it reads better last. See
// docs/list-server-plan.md.
function renderListPage({
  servers, bzoServers, cacheAgeSeconds, imported, importError, session, admin,
}) {
  const localMaps = listAvailableMapFiles().map((fileName) => ({
    fileName,
    hashed: fileName === 'random' || MAP_REGISTRY.has(fileName),
  }));

  // One nav line at the very top: a jump link to each section below, then
  // this instance's own login state last -- it authenticates this instance's
  // bzflag.org session either way, but only unlocks the key admin section
  // when this instance is the designated one.
  const identityBlock = session
    ? `<strong>${escapeHtml(session.callsign)}</strong>${admin ? ' (admin)' : ''}`
      + ` -- <a href="/logout">Log out</a>`
    : `<a href="/login/list">Log in with your bzflag.org account</a>`
      + `${IS_DESIGNATED_LIST_SERVER ? ' to register a server' : ''}`;
  // "keys" is the one link here that is not always this page's own section:
  // key admin only exists on the designated instance, so anywhere else it
  // jumps straight to the real thing rather than to this page's own
  // redirect-to-there notice. bzo/bzflag/maps stay relative -- every
  // instance actually has those three itself.
  const keysHref = IS_DESIGNATED_LIST_SERVER || !LIST_SERVER_URL
    ? '#keys'
    : `${escapeHtml(LIST_SERVER_URL)}/list#keys`;
  const navBlock = `<p class="nav">`
    + `<a href="#bzo">bzo</a> | <a href="#bzflag">bzflag</a> | <a href="#maps">maps</a> | <a href="${keysHref}">keys</a>`
    + ` | ${identityBlock}</p>`;

  const serverRows = servers.map((s) => {
    const players = s.info && typeof s.info.players === 'number' ? String(s.info.players) : '';
    const maxPlayers = s.info && typeof s.info.maxPlayers === 'number' ? String(s.info.maxPlayers) : '';
    const maxShots = s.info && typeof s.info.maxShots === 'number' ? String(s.info.maxShots) : '';
    const hasOption = (bit) => (s.info && (s.info.gameOptionsBits & bit) !== 0 ? 'Yes' : '');
    const importFileName = remoteMapFileName(s.host, s.port);
    // Always the row's own link, imported or not -- `?viewmap=` already
    // imports on demand (`importMapForView`) the moment nothing this fresh is
    // registered yet, so there is no state where clicking the row is wrong.
    const viewmapHref = `/?viewmap=${encodeURIComponent(importFileName)}`;
    const alreadyImported = MAP_REGISTRY.has(importFileName);
    const importCell = `<form method="post" action="/list/import" class="inlineForm">`
      + `<input type="hidden" name="host" value="${escapeHtml(s.host)}">`
      + `<input type="hidden" name="port" value="${s.port}">`
      + `<button type="submit">${alreadyImported ? 'Re-import' : 'Import'}</button></form>`;
    return `<tr class="clickable" data-href="${viewmapHref}"><td>${players}</td><td>${maxPlayers}</td><td>${maxShots}</td>`
      + `<td>${escapeHtml(s.info ? s.info.style : '')}</td>`
      + `<td>${hasOption(GAME_OPTION_BITS.jumping)}</td><td>${hasOption(GAME_OPTION_BITS.flags)}</td>`
      + `<td>${hasOption(GAME_OPTION_BITS.ricochet)}</td><td>${hasOption(GAME_OPTION_BITS.antidote)}</td>`
      + `<td>${hasOption(GAME_OPTION_BITS.handicap)}</td><td>${hasOption(GAME_OPTION_BITS.noTeamKills)}</td>`
      + `<td>${escapeHtml(s.title)}</td><td>${escapeHtml(s.host)}</td><td>${s.port}</td>`
      + `<td>${importCell}</td></tr>`;
  }).join('\n');

  // bzo's own list server (docs/list-server-plan.md): a third table, read
  // from the designated instance's public endpoint rather than dialled the
  // way a bzfs row above is. Clicking a row navigates the browser there
  // directly (`location.href`) -- each one is its own origin and its own
  // websocket, not something to import a map from.
  const bzoServerRows = bzoServers.map((s) => {
    const hasOption = (bit) => ((s.gameOptionsBits & bit) !== 0 ? 'Yes' : '');
    const status = s.stale
      ? `<span class="stale" title="${escapeHtml(s.staleReason || '')}">stale</span>`
      : 'up';
    return `<tr class="clickable" data-href="${escapeHtml(s.url)}"><td>${s.players}</td><td>${s.maxPlayers}</td>`
      + `<td>${s.maxShots}</td><td>${escapeHtml(s.style)}</td>`
      + `<td>${hasOption(GAME_OPTION_BITS.jumping)}</td><td>${hasOption(GAME_OPTION_BITS.flags)}</td>`
      + `<td>${hasOption(GAME_OPTION_BITS.ricochet)}</td><td>${hasOption(GAME_OPTION_BITS.antidote)}</td>`
      + `<td>${hasOption(GAME_OPTION_BITS.noTeamKills)}</td>`
      + `<td>${s.voiceEnabled ? 'Yes' : ''}</td>`
      + `<td>${escapeHtml(s.title)}</td><td>${escapeHtml(s.version)}</td>`
      + `<td>${escapeHtml(s.url)}</td><td>${status}</td></tr>`;
  }).join('\n');

  const mapRows = localMaps.map((m) => {
    const entry = MAP_REGISTRY.get(m.fileName);
    const hash = entry ? entry.hash : '';
    const bzwPath = resolveMapFilePath(m.fileName);
    const modified = bzwPath ? statMtimeOrBlank(bzwPath) : '';
    const bzwSize = bzwPath ? statSizeOrBlank(bzwPath) : '';
    const jsonSize = entry ? statSizeOrBlank(path.join(MAP_CACHE_DIR, `${entry.hash}.json`)) : '';
    const rowAttrs = m.hashed ? ` class="clickable" data-href="/?viewmap=${encodeURIComponent(m.fileName)}"` : '';
    return `<tr${rowAttrs}><td>${escapeHtml(m.fileName)}</td>`
      + `<td>${m.hashed ? 'yes' : 'hashing…'}</td>`
      + `<td>${escapeHtml(hash)}</td><td>${escapeHtml(modified)}</td>`
      + `<td>${bzwSize}</td><td>${jsonSize}</td></tr>`;
  }).join('\n');

  const flash = imported
    ? `<p class="flash success">Imported <code>${escapeHtml(imported)}</code> -- it is in the local maps table below.</p>`
    : importError
      ? `<p class="flash error">Import failed: ${escapeHtml(importError)}</p>`
      : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>bzo servers</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
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
</style>
</head>
<body>
${navBlock}
<h1 id="bzo">Public bzo servers</h1>
<p class="muted">From the designated list server, ${LIST_SERVER_URL
    ? `<a href="${escapeHtml(LIST_SERVER_URL)}/list">${escapeHtml(LIST_SERVER_URL)}</a>`
    : 'disabled on this instance'} --
click a row to go there; see "keys" above to manage a key.</p>
<input id="bzoServerFilter" type="text" placeholder="Filter…">
<table id="bzoServerTable">
<thead><tr><th data-sort="num">Players</th><th data-sort="num">Max</th><th data-sort="num">Shots</th><th>Style</th>
<th title="Jumping">Jump</th><th title="Superflags">Flag</th><th title="Ricochet">Rico</th>
<th title="Antidote flag">Anti</th><th title="No Team Kills (friendly fire off)">TK</th>
<th title="Voice chat has at least one ICE server configured">Voice</th>
<th>Title</th><th>Version</th><th>URL</th><th>Status</th></tr></thead>
<tbody>
${bzoServerRows}
</tbody>
</table>

<h1 id="bzflag">Public BZFlag servers</h1>
<p class="muted">From the public list server (my.bzflag.org), cached ${cacheAgeSeconds}s ago --
<a href="/list">refresh</a>. Click a column heading to sort.</p>
${flash}
<input id="serverFilter" type="text" placeholder="Filter…">
<table id="serverTable">
<thead><tr><th data-sort="num">Players</th><th data-sort="num">Max</th><th data-sort="num">Shots</th><th>Style</th>
<th title="Jumping">Jump</th><th title="Superflags">Flag</th><th title="Ricochet">Rico</th>
<th title="Antidote flag">Anti</th><th title="Handicap">Hcap</th><th title="No Team Kills (friendly fire off)">TK</th>
<th>Title</th><th>Host</th><th data-sort="num">Port</th><th></th></tr></thead>
<tbody>
${serverRows}
</tbody>
</table>

<h1 id="maps">Local maps</h1>
<p class="muted">Already in this server's <code>maps/</code>, including anything imported above. Click a row to view it.</p>
<input id="mapFilter" type="text" placeholder="Filter…">
<table id="mapTable">
<thead><tr><th>File</th><th>Hashed</th><th>Hash</th><th title="A remote import expires and re-fetches once this is older than IMPORT_MAX_AGE_MS">Modified</th><th data-sort="num">.bzw size</th><th data-sort="num">.json size</th></tr></thead>
<tbody>
${mapRows}
</tbody>
</table>

<script>
// A row's own data-href -- clicking anywhere on it goes to that map's
// viewmap link, except a click on the Import/Re-import form, which needs
// its own click (stopPropagation there would work too, but this reads
// clearer from the row's side: "unless it's the form"). A table with no
// data-href rows at all (the key table) just never matches, so the same
// function serves it for sorting and filtering without also wiring
// navigation it never asked for.
// Global (not per-page-load scoped) so the key admin section's own script,
// which runs later in the same page for a fetched-in table, can call it too.
// NOTE: no backticks in this comment block -- it lives inside server.js's
// own outer template literal, and an unescaped backtick here would close it.
window.attachTable = function attachTable(tableId, filterId) {
  var table = document.getElementById(tableId);
  if (!table) return;
  var tbody = table.tBodies[0];
  tbody.addEventListener('click', function (e) {
    if (e.target.closest('.inlineForm') || e.target.closest('button')) return;
    var row = e.target.closest('tr[data-href]');
    if (row) window.location.href = row.dataset.href;
  });
  Array.prototype.forEach.call(table.tHead.rows[0].cells, function (th, colIndex) {
    var dir = 1;
    th.addEventListener('click', function () {
      var numeric = th.dataset.sort === 'num';
      var rows = Array.prototype.slice.call(tbody.rows);
      rows.sort(function (a, b) {
        var av = a.cells[colIndex].textContent.trim();
        var bv = b.cells[colIndex].textContent.trim();
        if (numeric) { av = parseFloat(av); bv = parseFloat(bv); av = isNaN(av) ? -Infinity : av; bv = isNaN(bv) ? -Infinity : bv; return (av - bv) * dir; }
        return av.localeCompare(bv) * dir;
      });
      dir *= -1;
      rows.forEach(function (row) { tbody.appendChild(row); });
    });
  });
  var filterInput = filterId && document.getElementById(filterId);
  if (filterInput) {
    filterInput.addEventListener('input', function () {
      var q = filterInput.value.toLowerCase();
      Array.prototype.forEach.call(tbody.rows, function (row) {
        row.style.display = row.textContent.toLowerCase().indexOf(q) === -1 ? 'none' : '';
      });
    });
  }
};
attachTable('serverTable', 'serverFilter');
attachTable('bzoServerTable', 'bzoServerFilter');
attachTable('mapTable', 'mapFilter');
</script>

${renderListServerKeyAdminSection({ session, admin })}
</body>
</html>`;
}

app.get('/list', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const [servers, bzoServers] = await Promise.all([
      getRemoteServerList().then((list) => [...list]
        .sort((a, b) => (b.info?.players ?? -1) - (a.info?.players ?? -1))),
      getBzoServerList().then((list) => [...list].sort((a, b) => (b.players ?? -1) - (a.players ?? -1))),
    ]);
    const session = sessionFromRequest(req);
    res.type('html').send(renderListPage({
      servers,
      bzoServers,
      cacheAgeSeconds: Math.max(0, Math.round((Date.now() - remoteServerListCache.at) / 1000)),
      imported: typeof req.query.imported === 'string' ? req.query.imported : null,
      importError: typeof req.query.error === 'string' ? req.query.error : null,
      session,
      admin: session ? isAdminSession(session, ADMIN_GROUPS) : false,
    }));
  } catch (error) {
    logError('/list failed to reach the list server:', error);
    res.status(502).type('text/plain').send('Could not reach the BZFlag list server. Try again shortly.\n');
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
  // upstream's default and so bzo's. See the flags pair for what the numbers
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
  MAX_BUMP_HEIGHT: DEFAULT_MAX_BUMP_HEIGHT, // BZFlag _maxBumpHeight
  WINGS_JUMP_VELOCITY: null, // BZFlag _wingsJumpVelocity; defaults to JUMP_VELOCITY
  WINGS_GRAVITY: null, // BZFlag _wingsGravity magnitude; defaults to GRAVITY
  WINGS_SLIDE_TIME: DEFAULT_WINGS_SLIDE_TIME, // BZFlag _wingsSlideTime
  JUMP_COOLDOWN: 500, // ms between jumps
  FOG_MODE: 'none', // BZFlag _fogMode default
  FOG_DENSITY: 0.001, // BZFlag _fogDensity default
  FOG_START: null, // Defaults to 0.5 * map size like BZFlag
  FOG_END: null, // Defaults to map size like BZFlag
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
const BUNDLED_MAPS_DIR = path.join(__dirname, 'maps');
const RUNTIME_MAPS_DIR = process.env.MAPS_PATH
  ? path.resolve(process.env.MAPS_PATH)
  : path.join(path.dirname(configPath), 'maps');

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

async function getRemoteServerList() {
  if (Date.now() - remoteServerListCache.at < REMOTE_SERVER_LIST_TTL_MS) {
    return remoteServerListCache.servers;
  }
  const servers = await fetchServerList(DEFAULT_LIST_SERVER, BZFS_PROTOCOL_VERSION);
  remoteServerListCache = { at: Date.now(), servers };
  return servers;
}

// bzo's own list server's public read endpoint (docs/list-server-plan.md),
// for `/list`'s third table. Same cache shape as `getRemoteServerList` and
// the same reason: shared across every visitor rather than one fetch each.
let bzoServerListCache = { at: 0, servers: [] };

async function getBzoServerList() {
  if (!LIST_SERVER_URL) return [];
  // The designated instance already holds this in-process -- no reason to
  // round-trip HTTPS to itself for its own `/list`, and no reason to cache
  // it either: unlike the fetch below, reading the registry costs nothing,
  // and caching it would only add a window where a fresher report already
  // landed but `/list` still shows the stale snapshot.
  if (IS_DESIGNATED_LIST_SERVER) {
    return listServerKeys.listAll()
      .filter((record) => record.live !== null)
      .map((record) => {
        const stale = isListServerKeyStale(record);
        return {
          url: record.url, title: record.live.title, description: record.live.description,
          players: record.live.players, maxPlayers: record.live.maxPlayers,
          version: record.live.version, gameOptionsBits: record.live.gameOptionsBits,
          maxShots: record.live.maxShots, style: record.live.style,
          voiceEnabled: record.live.voiceEnabled,
          stale, staleReason: stale ? (record.lastError || 'no response') : null,
        };
      });
  }
  if (Date.now() - bzoServerListCache.at < REMOTE_SERVER_LIST_TTL_MS) {
    return bzoServerListCache.servers;
  }
  try {
    const response = await fetch(`${LIST_SERVER_URL}/api/list-server/list`, {
      headers: { 'User-Agent': `bzo ${CLIENT_BUILD}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const servers = Array.isArray(body.servers) ? body.servers : [];
    bzoServerListCache = { at: Date.now(), servers };
    return servers;
  } catch (error) {
    logError(`/list could not reach the bzo list server at ${LIST_SERVER_URL}:`, error.message || error);
    return bzoServerListCache.servers;
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

// How long a remote import is worth reusing rather than fetched again: long
// enough that following the same shared link twice in a sitting never
// re-downloads, short enough that the file is not worth keeping past it --
// `maps/import-*.bzw` is a regeneratable cache (see .gitignore), not
// something worth pruning on its own schedule, since `parseImportMapFileName`
// above is what lets a link outlive this window instead of just going stale.
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

async function performRemoteMapImport(host, port) {
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
  const promise = performRemoteMapImportNow(listedServer, safeMapName)
    .finally(() => inFlightRemoteImports.delete(safeMapName));
  inFlightRemoteImports.set(safeMapName, promise);
  return promise;
}

async function performRemoteMapImportNow(listedServer, safeMapName) {
  const { host, port } = listedServer;
  const { worldDatabase, gameSettings, queryGame, variables } =
    await fetchWorldFromServer(host, port, 15000);
  const tree = parseWorldDatabase(worldDatabase);
  // The server's own world variables, for the `-set` lines in the exported
  // map. Null when the momentary observer join that carries them was refused
  // or timed out (see `fetchWorldFromServer`); the map imports either way.
  tree.variables = variables || null;
  if (gameSettings && gameSettings.length >= 30) tree.gameSettings = decodeGameSettings(gameSettings);
  if (queryGame && queryGame.length >= 44) tree.queryGame = decodeQueryGame(queryGame);
  if (tree.gameSettings) tree.worldSize = tree.gameSettings.worldSize;
  // Neither the title nor the per-team maximums travel over the direct
  // connection above -- both are the list server's own words about this
  // host:port (`fetchServerList`), carried in on the very record
  // `performRemoteMapImport` matched this target against. Read off that
  // record rather than looked up again here: the fetch above can take up to
  // 15 seconds, and the shared list cache can have expired and been
  // refreshed without this server on it by the time it returns.
  const text = buildBZWText(
    { host, port, title: listedServer.title || '', listInfo: listedServer.info || null },
    tree,
    new Date().toISOString(),
  );
  const filePath = path.join(RUNTIME_MAPS_DIR, safeMapName);
  await fs.promises.writeFile(filePath, text);
  // Hashed synchronously rather than left to the background trickle
  // (`hashRemainingMapsInBackground`): this is the one file that just
  // changed, so there is no reason to make the caller wait on a queue that
  // also revisits everything else already sitting in maps/.
  let mapData = parseBZWMap(filePath);
  if (mapData.warnedMessages.length > 0) {
    await fs.promises.appendFile(filePath, `\n${buildImportWarningOptionsBlock(mapData.warnedMessages)}`);
    // Quiet: this is the same file the first parse above just fully logged,
    // plus the options block this very function appended -- re-parsing it
    // is only to pick up that block's own `-srvmsg` lines in `mapData`, not
    // a second, real pass worth repeating every warning to server.log for.
    mapData = parseBZWMap(filePath, { quiet: true });
  }
  registerMapFile(
    safeMapName, mapData.obstacles, mapData.teleporterGraph, mapData.teamMode, mapData.mapSize,
    mapData.messages, mapData.noWalls, mapData.waterLevel, mapData.weather, mapData.groundMaterial,
    mapData.serverOptions.gameplay
  );
  return { safeMapName, byteLength: worldDatabase.length };
}

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

// Where to answer, decided in one place because the two halves of an address
// are one decision. The environment wins over `server.json` for both, which is
// what lets a container be told by its orchestration what a server is otherwise
// told by its file, and each falls back to answering everywhere on 3000.
//
// A loopback address is how an operator behind a reverse proxy keeps anyone
// from stepping around it to the port and reaching the uncertificated,
// uncompressed path; `::` is every interface in both families, which is what a
// container and a LAN game both need.
const { host: LISTEN_HOST, port: PORT, note: listenNote } = resolveListenTarget({
  envListen: process.env.LISTEN,
  envPort: process.env.PORT,
  configListen: serverConfig.listen,
  configPort: serverConfig.port,
});

server.listen(PORT, LISTEN_HOST, () => {
  if (listenNote) log(`[LISTEN] ${listenNote}`);
  log(`Server running on ${describeListenTarget(LISTEN_HOST, PORT)}`);
  log(`Client build ${CLIENT_BUILD}`);
  // After the port is open, never before it: the game is playable while the
  // sidecars are built, and a request that arrives first is served identity.
  precompress.start({ log }).catch((error) => logError(`[BR] ${error.message}`));
  probeAdminWhitelist().catch((error) => logError(`[ADMIN] probe failed: ${error.message}`));
  reportToListServer('boot');
  if (IS_DESIGNATED_LIST_SERVER) {
    // Excludes this instance's own self-report row: reportToListServer just
    // above already refreshed it in-process, and validating it here would
    // be a real HTTP round trip to itself for something already current.
    const cutoff = Date.now() - LIST_SERVER_RECENT_CHECK_WINDOW_MS;
    const recent = listServerKeys.listAll().filter((record) => record.url !== PUBLIC_URL
      && (record.lastChecked ?? record.dateRequested) >= cutoff);
    log(`[LISTSERVER] polling ${recent.length} recently-active key(s) immediately after restart`);
    for (const record of recent) {
      validateListServerKey(record)
        .catch((error) => logError(`[LISTSERVER] boot poll failed for ${record.url}: ${error.message}`));
    }
  }
});

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

// `adminWhitelist` in server.json: addresses beyond loopback that `localAdmin`
// should also cover, e.g. an operator's home network. Entries are addresses or
// IPv4 CIDR blocks; validated and logged the same way ADMIN_GROUPS is.
const { entries: ADMIN_WHITELIST, refused: refusedAdminWhitelist } =
  parseAdminWhitelist(serverConfig.adminWhitelist);
if (refusedAdminWhitelist.length > 0) {
  log(`Admin whitelist entries refused (not an address or IPv4 CIDR block):`
    + ` ${refusedAdminWhitelist.map((entry) => JSON.stringify(entry)).join(', ')}`);
}

// `publicUrl` in server.json: this server's own externally-reachable address,
// e.g. `https://bz.rikers.org`. Used only for the startup probe below; nothing
// else on this server needs to know its own public name.
const PUBLIC_URL = typeof serverConfig.publicUrl === 'string' ? serverConfig.publicUrl.trim() : '';

// Whether a forwarded address can be trusted for `isLocalAdminRequest`, and
// how to read one if so. Stays 'distrust' -- unproxied loopback only -- until
// `probeAdminWhitelist` below proves otherwise; see isLocalAdminRequest for
// what each value means.
let forwardedForPolicy = 'distrust';

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
async function probeAdminWhitelist() {
  if (!LOCAL_ADMIN || !PUBLIC_URL) return;
  const probeUrl = `${PUBLIC_URL.replace(/\/+$/, '')}/api/_admin-probe`;
  const fetchProbe = async (forwardedFor) => {
    const response = await fetch(probeUrl, {
      headers: {
        'User-Agent': `bzo ${CLIENT_BUILD}`,
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
        log(`[ADMIN] ${PUBLIC_URL} does not confirm its proxy replaces X-Forwarded-For;`
          + ' admin whitelist stays limited to unproxied loopback');
        return;
      }
      forwardedForPolicy = poisonedChain.length === 1 ? 'trust-first' : 'trust-last';
      log(`[ADMIN] ${PUBLIC_URL}'s proxy ${forwardedForPolicy === 'trust-first' ? 'overwrites' : 'appends to'}`
        + ' X-Forwarded-For safely; admin whitelist active for loopback'
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
let sessionWriteTimer = null;

function writeSessionsSoon() {
  if (sessionWriteTimer) return;
  sessionWriteTimer = setTimeout(() => {
    sessionWriteTimer = null;
    try {
      // Pretty-printed, the same reason list-server-keys.json is: an
      // operator reasonably opens this file by hand, and it stays small.
      fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions.serialize(), null, 2), { mode: 0o600 });
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
// Decided by comparing its own advertised address to the list server it is
// configured to report to -- the same `publicUrl` the admin-whitelist probe
// already uses -- rather than a second flag that could disagree with it.
const IS_DESIGNATED_LIST_SERVER =
  LIST_SERVER_URL !== '' && PUBLIC_URL !== ''
  && LIST_SERVER_URL === PUBLIC_URL.trim().replace(/\/+$/, '');

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
        LIST_SERVER_KEYS_PATH, JSON.stringify(listServerKeys.serialize(), null, 2), { mode: 0o600 });
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
  log(`[LISTSERVER] this instance is the designated list server (${PUBLIC_URL})`);
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
  res.status(404).type('text/plain').send('This instance is not the designated list server.\n');
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
    version: typeof body?.version === 'string' ? body.version.slice(0, 40) : '',
    gameOptionsBits: Number.isFinite(gameOptionsBits) ? gameOptionsBits : 0,
    maxShots: Number.isFinite(maxShots) ? maxShots : 0,
    style: typeof body?.style === 'string' ? body.style.slice(0, 20) : '',
    voiceEnabled: body?.voiceEnabled === true,
  };
}

async function validateListServerKey(record) {
  const nonce = crypto.randomBytes(16).toString('hex');
  try {
    const response = await fetch(
      `${record.url}/api/list-server/challenge?${new URLSearchParams({ nonce })}`,
      { headers: { 'User-Agent': `bzo ${CLIENT_BUILD}` }, signal: AbortSignal.timeout(8000) },
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
    log(`[LISTSERVER] validated ${record.url}`);
  } catch (error) {
    listServerKeys.markChecked(record, false, error.message);
    log(`[LISTSERVER] could not validate ${record.url}: ${error.message}`);
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
  if (!session) {
    res.status(401).json({ error: 'Log in at /login first' });
    return;
  }
  const record = listServerKeys.get(req.params.id);
  if (!record) {
    res.status(404).json({ error: 'No such key' });
    return;
  }
  const admin = isAdminSession(session, ADMIN_GROUPS);
  if (record.bzid !== session.bzid && !admin) {
    res.status(403).json({ error: 'Not your key' });
    return;
  }
  listServerKeys.revoke(record.id);
  log(`[LISTSERVER] "${session.callsign}" revoked the key for ${record.url}`
    + (record.bzid !== session.bzid ? ' (admin revoking another operator\'s key)' : ''));
  res.json({ success: true });
});

app.get('/api/list-server/keys', (req, res) => {
  if (!requireDesignatedListServer(req, res)) return;
  res.set('Cache-Control', 'no-store');
  const session = sessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: 'Log in at /login first' });
    return;
  }
  const admin = isAdminSession(session, ADMIN_GROUPS);
  const rows = admin ? listServerKeys.listAll() : listServerKeys.listForBzid(session.bzid);
  res.json({ admin, keys: rows.map(describeListServerKeyRow) });
});

// The reasons a report may name. `join`/`part` only update the live counts
// below; only `boot`/`periodic` also trigger the validation callback -- "an
// active game should not cost an outbound HTTPS round trip per player."
const LIST_SERVER_REPORT_REASONS = new Set(['boot', 'periodic', 'join', 'part', 'shutdown']);

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
    res.status(403).json({ error: `Unknown or expired key. Generate a new one at ${PUBLIC_URL}/list#keys.` });
    return;
  }
  const reason = LIST_SERVER_REPORT_REASONS.has(req.body?.reason) ? req.body.reason : 'periodic';
  if (reason === 'shutdown') {
    listServerKeys.unreport(record);
    res.json({ success: true });
    return;
  }
  listServerKeys.report(record, sanitizeListServerStatus(req.body));
  res.json({ success: true });
  // After the response, not before -- a reporting instance should not wait on
  // this any more than an ordinary ADD would.
  if (reason === 'boot' || reason === 'periodic') {
    validateListServerKey(record).catch((error) => logError(`[LISTSERVER] validation failed: ${error.message}`));
  }
});

// The public read endpoint every instance's `/list` third table fetches from
// the designated one. Only rows that have reported at least once (`live`) --
// a registered-but-never-run key names nobody to list.
app.get('/api/list-server/list', (req, res) => {
  if (!requireDesignatedListServer(req, res)) return;
  res.set('Cache-Control', 'no-store');
  const servers = listServerKeys.listAll()
    .filter((record) => record.live !== null)
    .map((record) => {
      const stale = isListServerKeyStale(record);
      return {
        url: record.url,
        title: record.live.title,
        description: record.live.description,
        players: record.live.players,
        maxPlayers: record.live.maxPlayers,
        version: record.live.version,
        gameOptionsBits: record.live.gameOptionsBits,
        maxShots: record.live.maxShots,
        style: record.live.style,
        voiceEnabled: record.live.voiceEnabled,
        stale,
        staleReason: stale ? (record.lastError || 'no response') : null,
      };
    });
  res.json({ servers });
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
function renderListServerKeyAdminSection({ session, admin }) {
  if (!IS_DESIGNATED_LIST_SERVER) {
    return `<h1 id="keys">List server key</h1>
${LIST_SERVER_URL
    ? `<p class="muted">This instance is not the designated list server. Manage this server's key at `
      + `<a href="${escapeHtml(LIST_SERVER_URL)}/list#keys">${escapeHtml(LIST_SERVER_URL)}/list</a>.</p>`
    : `<p class="muted">The list server is disabled on this instance (<code>listServerUrl</code> is empty).</p>`}`;
  }
  const formBlock = session
    ? `<form id="addForm">
<input id="urlInput" type="text" placeholder="https://your-server.example.com" required>
<button type="submit">Generate key</button>
</form>
<p class="muted">Enter the server's own <code>publicUrl</code> -- the same address it already answers
admin-whitelist probes on. The list server calls this address back to validate a report; it never
trusts one a report claims for itself.</p>
<div id="newKeyFlash"></div>`
    : `<p class="muted">Log in above to register a server and generate a key.</p>`;
  return `<h1 id="keys">${admin ? 'All registered keys' : 'Your keys'}</h1>
<p class="muted">This instance (<code>${escapeHtml(PUBLIC_URL)}</code>) is the designated list server --
every other bzo instance reports here, so its own <code>/list</code> can show the bzo servers
table above.</p>
<input id="keyFilter" type="text" placeholder="Filter…">
<table id="keyTable">
<thead><tr><th>URL</th>${admin ? '<th>Owner</th>' : ''}<th>Key</th><th>Requested</th><th>Last checked</th>
<th>Status</th><th></th></tr></thead>
<tbody></tbody>
</table>
${formBlock}
<script>
var admin = ${admin ? 'true' : 'false'};
// ISO-ish, the same reason /list's own "Modified" column (Local maps table)
// is: it sorts correctly as plain text, unlike a locale-formatted string.
function fmt(ts) { return ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) : 'never'; }
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
    var status = row.stale ? '<span class="stale">stale' + (row.lastError ? ' (' + esc(row.lastError) + ')' : '') + '</span>'
      : row.live ? (row.live.players + '/' + row.live.maxPlayers + ' players') : 'never reported';
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
      + '<td><button type="button" data-id="' + row.id + '">Revoke</button></td>';
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
          flash.innerHTML = '<p class="flash error">' + (result.data.error || 'Failed') + '</p>';
          return;
        }
        flash.innerHTML = '<p class="flash success">Key for ' + result.data.url + ': <code>' + result.data.key
          + '</code><br>Paste this into that server\\'s Operator panel -- also readable from the table above any time.</p>';
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

// Zero is meaningful here too -- a world with no bump-climbing at all, upstream's
// own `-set _maxBumpHeight 0` -- so the floor is 0 rather than 1.
const configMaxBumpHeight = Number(serverConfig.maxBumpHeight ?? NaN);
if (Number.isFinite(configMaxBumpHeight) && configMaxBumpHeight >= 0) {
  GAME_CONFIG.MAX_BUMP_HEIGHT = configMaxBumpHeight;
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
// Whether the operator said anything is remembered rather than re-derived: the
// map is read long after this, and a map that states `_gravity` has to move
// the alias with it without overwriting a value the operator did pin.
const WINGS_JUMP_VELOCITY_PINNED = GAME_CONFIG.WINGS_JUMP_VELOCITY !== null;
const WINGS_GRAVITY_PINNED = GAME_CONFIG.WINGS_GRAVITY !== null;
function resolveWingsAliases() {
  if (!WINGS_JUMP_VELOCITY_PINNED) GAME_CONFIG.WINGS_JUMP_VELOCITY = GAME_CONFIG.JUMP_VELOCITY;
  if (!WINGS_GRAVITY_PINNED) GAME_CONFIG.WINGS_GRAVITY = GAME_CONFIG.GRAVITY;
}
resolveWingsAliases();

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

// `>= 0`, not `> 0`: zero is upstream's own "tanks cannot shoot" (`-ms 0`),
// and `server.json` is where bzo keeps what upstream keeps on its command
// line, so an operator can ask for it here as a map can ask for it in its
// `options` block.
const configShotMaxActive = Number(serverConfig.shotMaxActive);
if (Number.isInteger(configShotMaxActive) && configShotMaxActive >= 0) {
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
  // No slots, no reload to derive -- and `SHOT_RELOAD_TIME` rides `GAME_CONFIG`
  // into `init`, where `JSON.stringify(Infinity)` would reach the client as
  // `null` and read as "the server forgot to say" rather than "there is no
  // shooting here". Zero is the honest answer: nothing is ever waiting on it.
  if (GAME_CONFIG.SHOT_MAX_ACTIVE === 0) {
    GAME_CONFIG.SHOT_RELOAD_TIME = 0;
    GAME_CONFIG.SHOT_COOLDOWN = 0;
    return;
  }
  if (!SHOT_RELOAD_TIME_PINNED) {
    // `_reloadTime` when the map states one, upstream's own default basis of
    // _shotRange / _shotSpeed when it does not (ShotPath.cxx:48).
    const shotLifetimeMs = Number.isFinite(GAME_CONFIG.SHOT_LIFETIME)
      && GAME_CONFIG.SHOT_LIFETIME > 0
      ? GAME_CONFIG.SHOT_LIFETIME
      : (GAME_CONFIG.SHOT_RANGE / GAME_CONFIG.SHOT_SPEED) * 1000;
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

// Top-level BZW keywords a real map may use that bzo does not read at all --
// not a passability keyword inside a box, a zone keyword, or anything else
// already partially supported, but whole obstacle/animation types with no bzo
// equivalent yet (docs/bzw.md is the full account of what is and is not
// read). None of these ever set `current`/`currentLink`/`currentZone`/
// `currentWeapon`, so their own inner lines already fall through the rest of
// parseBZWMap's dispatch untouched -- this only has to recognize the
// *opening* keyword to say how many of each a map asked for.
// `WorldInfo::makeWaterMaterial`'s own texture matrix (`WorldInfo.cxx:150-153`):
// `texmat->setDynamicShift(0.05f, 0.0f)`, a scroll along U alone, forever --
// `TextureMatrix::update`'s `ushf = fmod(t * uShiftFreq, 1.0)` is the same
// continuous cycle `applyTextureMatrix` in `render.js` already ports for every
// other `texmat` reference. Shared rather than rebuilt per map: nothing ever
// mutates the object itself, only replaces a `currentWaterLevel.textureMatrix`
// reference that pointed at it (a `texmat` line on the block does that, the
// same as any other material property overriding this default).
const DEFAULT_WATER_TEXTURE_MATRIX = Object.freeze({
  name: 'WaterMaterial',
  fixedShiftU: 0, fixedShiftV: 0, fixedScaleU: 1, fixedScaleV: 1, fixedSpin: 0,
  fixedCenterU: 0.5, fixedCenterV: 0.5,
  shiftU: 0.05, shiftV: 0, spin: 0, scaleUFreq: 0, scaleVFreq: 0,
  scaleU: 1, scaleV: 1, centerU: 0.5, centerV: 0.5,
});

const UNSUPPORTED_TOP_LEVEL_KEYWORDS = new Set([
  'transform',
]);

// Material keywords bzo reads and deliberately drops, because none of them
// can change what a real bzflag client draws either -- see
// `applyBzwMaterialToken` for the reason behind each. Inside a `material`
// block, a mesh or one of the mesh primitives that helper already consumes
// them; this set is how a plain `box` or `pyramid` (whose own branch reads
// only the handful of properties bzo's box model has a place for) reaches
// the same answer instead of reporting them as gaps it does not have.
const BZW_INERT_MATERIAL_KEYWORDS = new Set([
  'ambient', 'groupalpha', 'noculling',
  // `BzMaterial` parses and stores these three, and nothing in the whole
  // upstream tree ever reads them back -- `getShader`/`getShaderCount` have
  // no caller outside `BzMaterial` itself, confirmed by grep. Dead in a real
  // bzflag client, so dead here.
  'shader', 'addshader', 'noshaders',
]);

// `MeshTransform` (`src/game/MeshTransform.cxx`), the `shift`/`scale`/
// `shear`/`spin` sequence a `mesh` block states about itself. Upstream reads
// them in `WorldFileLocation::read` (`:95-135`) as an ordered list rather
// than as four independent settings, and `MeshTransform::Tool` folds that
// list into one 4x4 as it walks it -- so two `spin`s about different axes,
// or a `scale` before and after a `shift`, all mean what reading them in
// order says they mean. Ported here rather than approximated, because unlike
// a box (whose `shift`/`spin` bzo maps onto `position`/`rotation`, see
// docs/bzw.md "Groups") a mesh is a bag of arbitrary points: every one of
// these has an exact answer on it, including the `shear` and the off-vertical
// `spin` that have no place in bzo's axis-aligned box model.
//
// Everything here is in upstream's own frame (Z up), not bzo's --
// `applyMeshTransform` converts each point across and back, so the matrix
// and the map text agree axis for axis.

// `multiply` (`MeshTransform.cxx:154-168`), which composes the new transform
// on the *left*: after `m = multiply(m, t)` the accumulated matrix applies
// `t` last, so a vertex sees the list in the order the map wrote it.
function multiplyMeshTransform(m, n) {
  const t = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      t[i][j] = (m[0][j] * n[i][0]) + (m[1][j] * n[i][1])
        + (m[2][j] * n[i][2]) + (m[3][j] * n[i][3]);
    }
  }
  return t;
}

const MESH_TRANSFORM_IDENTITY = [
  [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1],
];

// `shift`/`scale`/`shear`/`spin` (`MeshTransform.cxx:169-236`), each as the
// 4x4 upstream multiplies in. `shear`'s own off-diagonal placement is
// upstream's exactly -- it is not the symmetric shear it looks like it should
// be, and copying it rather than deriving it is the point.
function meshTransformStep(op) {
  const [a, b, c] = op.data;
  if (op.type === 'shift') {
    return [[1, 0, 0, a], [0, 1, 0, b], [0, 0, 1, c], [0, 0, 0, 1]];
  }
  if (op.type === 'scale') {
    return [[a, 0, 0, 0], [0, b, 0, 0], [0, 0, c, 0], [0, 0, 0, 1]];
  }
  if (op.type === 'shear') {
    return [[1, 0, a, 0], [0, 1, b, 0], [c, 0, 1, 0], [0, 0, 0, 1]];
  }
  // `spin <degrees> <ax> <ay> <az>` -- Rodrigues about an arbitrary axis, and
  // a zero-length axis is skipped rather than producing NaNs, same as
  // `MeshTransform.cxx:203-210`.
  const lenSq = (a * a) + (b * b) + (c * c);
  if (!(lenSq > 0)) return null;
  const inv = 1 / Math.sqrt(lenSq);
  const nx = a * inv; const ny = b * inv; const nz = c * inv;
  const radians = op.data[3];
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const icos = 1 - cos;
  return [
    [(nx * nx * icos) + cos, (nx * ny * icos) - (nz * sin), (nx * nz * icos) + (ny * sin), 0],
    [(ny * nx * icos) + (nz * sin), (ny * ny * icos) + cos, (ny * nz * icos) - (nx * sin), 0],
    [(nz * nx * icos) - (ny * sin), (nz * ny * icos) + (nx * sin), (nz * nz * icos) + cos, 0],
    [0, 0, 0, 1],
  ];
}

// `MeshTransform::Tool`'s constructor (`:242-305`): the folded vertex matrix,
// the cofactor matrix normals go through instead (so a non-uniform scale
// leaves them perpendicular), and the determinant's sign, which says whether
// the transform turned the mesh inside out and every normal has to flip.
function buildMeshTransformTool(ops) {
  if (!ops || ops.length === 0) return null;
  let vm = MESH_TRANSFORM_IDENTITY;
  for (const op of ops) {
    const step = meshTransformStep(op);
    if (step) vm = multiplyMeshTransform(vm, step);
  }
  const normalMatrix = [
    [
      (vm[1][1] * vm[2][2]) - (vm[1][2] * vm[2][1]),
      (vm[1][2] * vm[2][0]) - (vm[1][0] * vm[2][2]),
      (vm[1][0] * vm[2][1]) - (vm[1][1] * vm[2][0]),
    ],
    [
      (vm[2][1] * vm[0][2]) - (vm[2][2] * vm[0][1]),
      (vm[2][2] * vm[0][0]) - (vm[2][0] * vm[0][2]),
      (vm[2][0] * vm[0][1]) - (vm[2][1] * vm[0][0]),
    ],
    [
      (vm[0][1] * vm[1][2]) - (vm[0][2] * vm[1][1]),
      (vm[0][2] * vm[1][0]) - (vm[0][0] * vm[1][2]),
      (vm[0][0] * vm[1][1]) - (vm[0][1] * vm[1][0]),
    ],
  ];
  const determinant = (vm[0][0] * normalMatrix[0][0])
    + (vm[0][1] * normalMatrix[0][1])
    + (vm[0][2] * normalMatrix[0][2]);
  return { vertexMatrix: vm, normalMatrix, inverted: determinant < 0 };
}

// `MeshDrawInfo`'s own draw commands (`MeshDrawInfo.cxx:681-694`), each an
// OpenGL primitive over a list of *corner* indices. bzo draws polygons, so
// every surface mode is expanded here into the faces it stands for and the
// two line modes and `points` are dropped -- they describe no surface, and
// upstream's own renderer draws them as lines and points rather than as part
// of the solid (`DrawCmd::draw`).
//
// The windings are GL's, not a guess: a strip alternates so every triangle
// faces the same way, a fan pivots on its first corner, and a quad strip
// takes its four corners in the order that keeps the quad convex.
function expandMeshDrawCommand(mode, indices) {
  const polys = [];
  if (indices.length < 3) return polys;
  if (mode === 'tris') {
    for (let i = 0; i + 2 < indices.length; i += 3) {
      polys.push([indices[i], indices[i + 1], indices[i + 2]]);
    }
  } else if (mode === 'tristrip') {
    for (let i = 0; i + 2 < indices.length; i++) {
      polys.push(i % 2 === 0
        ? [indices[i], indices[i + 1], indices[i + 2]]
        : [indices[i + 1], indices[i], indices[i + 2]]);
    }
  } else if (mode === 'trifan') {
    for (let i = 1; i + 1 < indices.length; i++) {
      polys.push([indices[0], indices[i], indices[i + 1]]);
    }
  } else if (mode === 'quads') {
    for (let i = 0; i + 3 < indices.length; i += 4) {
      polys.push([indices[i], indices[i + 1], indices[i + 2], indices[i + 3]]);
    }
  } else if (mode === 'quadstrip') {
    for (let i = 0; i + 3 < indices.length; i += 2) {
      polys.push([indices[i], indices[i + 1], indices[i + 3], indices[i + 2]]);
    }
  } else if (mode === 'polygon') {
    polys.push(indices.slice());
  }
  return polys;
}

// Every mode `setupDrawModeMap` knows, so an unrecognized word inside a draw
// set is reported rather than silently dropped.
const MESH_DRAW_MODES = new Set([
  'points', 'lines', 'lineloop', 'linestrip',
  'tris', 'tristrip', 'trifan', 'quads', 'quadstrip', 'polygon',
]);

// `WorldFileLocation::read`'s own transform lines (`:88-135`), shared by
// every block that builds a mesh of its own -- `mesh`, and the `tetra`,
// `cone`/`meshpyr`, `arc`/`meshbox` and `sphere` primitives, whose
// `writeToGroupDef` is shaped exactly like `CustomMesh`'s. Returns whether
// the token was one of them, so a caller falls through for anything else.
function readMeshTransformToken(target, token, words) {
  if (token === 'shift' || token === 'scale' || token === 'shear') {
    const [a, b, c] = words.slice(1).map(Number);
    target.transformOps.push({ type: token, data: [a || 0, b || 0, c || 0, 0] });
    return true;
  }
  if (token === 'spin') {
    const [deg, ax, ay, az] = words.slice(1).map(Number);
    target.transformOps.push({
      type: 'spin', data: [ax || 0, ay || 0, az || 0, (deg || 0) * Math.PI / 180],
    });
    return true;
  }
  return false;
}

// bzo stores a mesh's points already turned into its own frame (BZW x stays
// x, BZW z becomes up, BZW y becomes -z -- see the `vertex` line in the mesh
// parser). The transform is upstream's and reads in upstream's frame, so each
// point crosses over, moves, and crosses back rather than the matrix being
// rewritten into bzo's axes: one conversion either side, stated once, instead
// of a similarity transform nobody can check against the map text.
function applyMeshTransform(mesh) {
  const tool = buildMeshTransformTool(mesh.transformOps);
  if (!tool) return mesh;
  const vm = tool.vertexMatrix;
  const nm = tool.normalMatrix;

  const movePoint = (p) => {
    const x = p.x; const y = -p.z; const z = p.y;
    const tx = (x * vm[0][0]) + (y * vm[0][1]) + (z * vm[0][2]) + vm[0][3];
    const ty = (x * vm[1][0]) + (y * vm[1][1]) + (z * vm[1][2]) + vm[1][3];
    const tz = (x * vm[2][0]) + (y * vm[2][1]) + (z * vm[2][2]) + vm[2][3];
    return { x: tx, y: tz, z: -ty };
  };

  // `Tool::modifyNormal` (`:380-411`) -- cofactor, renormalize, and flip on a
  // mirroring transform. A normal that collapses to zero length falls back to
  // straight up, upstream's own "dunno, going with Z" case.
  const moveNormal = (n) => {
    const x = n.x; const y = -n.z; const z = n.y;
    let tx = (x * nm[0][0]) + (y * nm[0][1]) + (z * nm[0][2]);
    let ty = (x * nm[1][0]) + (y * nm[1][1]) + (z * nm[1][2]);
    let tz = (x * nm[2][0]) + (y * nm[2][1]) + (z * nm[2][2]);
    const len = Math.hypot(tx, ty, tz);
    if (len > 0) {
      tx /= len; ty /= len; tz /= len;
    } else {
      tx = 0; ty = 0; tz = 1;
    }
    if (tool.inverted) {
      tx = -tx; ty = -ty; tz = -tz;
    }
    return { x: tx, y: tz, z: -ty };
  };

  mesh.vertices = mesh.vertices.map(movePoint);
  mesh.normals = mesh.normals.map(moveNormal);
  mesh.checkPoints = mesh.checkPoints.map((p) => ({ ...movePoint(p), inside: p.inside }));
  // A `drawInfo` block that brought pools of its own is a second copy of the
  // same surface and moves with it.
  if (mesh.drawVertices) mesh.drawVertices = mesh.drawVertices.map(movePoint);
  if (mesh.drawNormals) mesh.drawNormals = mesh.drawNormals.map(moveNormal);
  return mesh;
}

// The `BzMaterial` flags that decide how a face blends -- `nosorting`,
// `notexalpha`, `notexcolor`, read by `applyBzwMaterialToken` below -- pulled
// off any material-shaped object onto a face bound for the renderer.
// `BzMaterial::reset`'s own defaults are all "ordinary": sort translucent
// faces, and use both the texture's alpha and the material's own colour,
// which is what a material that never stated any of them reads back as here.
// `noculling` is not among them: it is read and dropped, for the reason
// `applyBzwMaterialToken` gives.
const bzwMaterialFlags = (m) => ({
  noSorting: !!m.noSorting,
  useTextureAlpha: m.useTextureAlpha !== false,
  useColorOnTexture: m.useColorOnTexture !== false,
});

// Everything a face carries off the material it names. The four generated
// meshes -- `tetra`, `cone`/`meshpyr`, `arc`/`meshbox` and `sphere` -- resolve
// a material per side and then assemble ordinary faces from it field by field,
// so a field this does not name is silently dropped on the way. A hand-written
// `mesh` face never had that problem: it starts from the mesh's own material
// and keeps what it does not overwrite. Naming the whole set in one place is
// what stops the two routes drifting apart again -- `texmat` and `dyncol` were
// dead on an `arc` while the same material animated on a `mesh` beside it, and
// the lighting properties went the same way.
const bzwFaceMaterial = (m) => ({
  texture: m.texture,
  textureUrl: m.textureUrl,
  color: m.color,
  noRadar: m.noRadar,
  noLighting: m.noLighting,
  dynamicColor: m.dynamicColor ?? null,
  textureMatrix: m.textureMatrix ?? null,
  specular: m.specular ?? null,
  emission: m.emission ?? null,
  shininess: m.shininess ?? null,
  alphaThreshold: m.alphaThreshold ?? null,
  ...bzwMaterialFlags(m),
});

// `TetraBuilding::makeMesh`'s own fixed face topology (`MeshUtils.h`'s
// `addFace` calls, `TetraBuilding.cxx:110-121`): four triangles, each
// omitting one vertex, always in this order regardless of how a mapper
// wrote the four `vertex` lines. `TetraBuilding::checkVertexOrder` swaps
// vertices 1 and 2 first (and their own face-material slots along with
// them) whenever the raw order given would make every face point inward
// instead of out -- bzo(x,y,z) is a proper rotation of upstream's own
// (x,y,z) (see `getColliderLocalPoint`'s own comment in the collision
// pair), so the same cross/dot sign test applies unchanged here. Module
// scope rather than nested in `parseBZWMap`: neither this nor
// `buildTetraMesh` below closes over anything of its own, and nesting a
// `const` after the line-parsing loop that can call `buildTetraMesh` mid-
// loop is a temporal-dead-zone crash waiting to happen -- module scope
// initializes once, well before `parseBZWMap` is ever called at all.
const TETRA_FACE_TOPOLOGY = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]];

function buildTetraMesh(tetra) {
  const v = tetra.vertexPositions.slice();
  const mats = tetra.faceMaterials.slice();
  const edgeA = { x: v[1].x - v[0].x, y: v[1].y - v[0].y, z: v[1].z - v[0].z };
  const edgeB = { x: v[2].x - v[0].x, y: v[2].y - v[0].y, z: v[2].z - v[0].z };
  const edgeC = { x: v[3].x - v[0].x, y: v[3].y - v[0].y, z: v[3].z - v[0].z };
  const cross = {
    x: (edgeA.y * edgeB.z) - (edgeA.z * edgeB.y),
    y: (edgeA.z * edgeB.x) - (edgeA.x * edgeB.z),
    z: (edgeA.x * edgeB.y) - (edgeA.y * edgeB.x),
  };
  const dot = (cross.x * edgeC.x) + (cross.y * edgeC.y) + (cross.z * edgeC.z);
  if (dot < 0) {
    [v[1], v[2]] = [v[2], v[1]];
    [mats[1], mats[2]] = [mats[2], mats[1]];
  }

  // Every face is solid regardless of the tetra's own `drivethrough`/
  // `shootthrough`/`ricochet` -- upstream's own `addFace` call hardcodes
  // all three false per face (`TetraBuilding.cxx:115-121`), the same way
  // `MeshUtils.h`'s shared helper always does for this shape. The whole
  // object's own passability -- set below, from the BZW keywords a
  // mapper actually wrote -- is what a tetra answers with instead,
  // exactly as `findTankObstacle`'s `if (obs.driveThrough) continue;`
  // already reads for every other obstacle type.
  const faces = TETRA_FACE_TOPOLOGY.map((vertexIndices, i) => ({
    vertexIndices, normalIndices: [], texcoordIndices: [],
    phydrv: null, noclusters: false, smoothBounce: false,
    driveThrough: false, shootThrough: false, ricochet: false,
    ...bzwFaceMaterial(mats[i]),
  }));

  const center = {
    x: (v[0].x + v[1].x + v[2].x + v[3].x) / 4,
    y: (v[0].y + v[1].y + v[2].y + v[3].y) / 4,
    z: (v[0].z + v[1].z + v[2].z + v[3].z) / 4,
  };

  return {
    type: 'mesh', name: tetra.name, definedIn: tetra.definedIn,
    vertices: v, normals: [], texcoords: [], faces,
    checkPoints: [{ ...center, inside: true }],
    phydrv: null, noclusters: false, smoothBounce: false, decorative: false,
    driveThrough: tetra.driveThrough, shootThrough: tetra.shootThrough, ricochet: tetra.ricochet,
    texture: null, textureUrl: null, color: null, noRadar: false, noLighting: false,
  };
}

// `ConeObstacle::makeMesh` (ConeObstacle.cxx:86-329), ported the same way as
// `buildTetraMesh` above: every position/size/angle stays in upstream's own
// BZW terms (Z up, degrees where upstream reads degrees) through the whole
// generator, and only the finished vertices/normals are rotated into bzo's
// axes at the very end -- `toBzo` below, the same single-purpose conversion
// `buildTetraMesh` uses. `meshpyr` is the same generator upstream itself
// reuses (`CustomCone(true)`, `BZWReader.cxx`): 4 divisions, defaults pulled
// from BZDB's `_pyrBase`/`_pyrHeight` (4x/5x `_tankHeight`, 2.05 -- 8.2 and
// 10.25 here, since bzo has no BZDB to read them from live), and upstream
// rebuilds it at the origin with a 45-degree internal twist and a sqrt(2)
// size scale (so the circle-inscribed square lands axis-aligned) before
// spinning it out to the mapper's own `rotation` and shifting to `position`
// -- see the call site below for why this port skips that transform stack
// and gets the same shape a simpler way.
const CONE_MIN_SIZE = 1e-6;
// `_pyrBase`/`_pyrHeight` (BZDB, `4.0*_tankHeight`/`5.0*_tankHeight`,
// `_tankHeight` = 2.05) -- `meshpyr`'s own default `size` when a mapper
// gives none, same as a plain `pyramid`'s.
const MESHPYR_DEFAULT_BASE = 4.0 * 2.05;
const MESHPYR_DEFAULT_HEIGHT = 5.0 * 2.05;

function buildConeMesh(cone) {
  const rawSize = cone.sizeBzf;
  // `meshpyr` rebuilds with a sqrt(2)-scaled footprint (upstream's own
  // `CustomCone::writeToGroupDef` computes this `newSize` before ever
  // constructing the `ConeObstacle` that `makeMesh` below is ported from, so
  // by the time upstream's own generator math runs, this -- not the
  // mapper's own `size` -- is already all it ever sees). `z` only ever gets
  // `fabsf`'d, never scaled.
  const sz = cone.isPyramid
    ? { x: Math.abs(rawSize.x) * Math.SQRT2, y: Math.abs(rawSize.y) * Math.SQRT2, z: Math.abs(rawSize.z) }
    : { x: Math.abs(rawSize.x), y: Math.abs(rawSize.y), z: Math.abs(rawSize.z) };
  let texU = cone.texsize.u;
  let texV = cone.texsize.v;
  if (sz.x < CONE_MIN_SIZE || sz.y < CONE_MIN_SIZE || sz.z < CONE_MIN_SIZE
    || Math.abs(texU) < CONE_MIN_SIZE || Math.abs(texV) < CONE_MIN_SIZE) {
    return null;
  }

  // Ramanujan's ellipse-circumference approximation, rounded to an integral
  // tile count so the wrap seam lines up -- upstream's own comment, and its
  // own math, verbatim.
  if (texU < 0) {
    const circ = Math.PI * ((3 * (sz.x + sz.y))
      - Math.sqrt((sz.x + (3 * sz.y)) * (sz.y + (3 * sz.x))));
    texU = -Math.floor(circ / texU);
  }
  if (texV < 0) texV = -(sz.z / texV);

  // `meshpyr` also rebuilds at the origin with a fixed 45-degree twist,
  // then spins to `rotation` and shifts to `position` as a whole extra
  // transform afterward. Baking straight into world space here skips that
  // stack: generate with `rotation` already folded into the sweep's own
  // start angle (exactly like a plain `cone` always does), then shift by
  // `position` once at the end -- the same net shape, since the 45-degree
  // twist never itself reads `position` or `rotation`.
  const baseHeading = cone.isPyramid ? (Math.PI / 4) : cone.rotationRad;

  let r = baseHeading;
  let a = cone.sweepDeg;
  if (a > 360) a = 360;
  if (a < -360) a = -360;
  a *= Math.PI / 180;
  if (a < 0) {
    r += a;
    a = -a;
  }

  if (cone.divisions <= Math.floor((a + CONE_MIN_SIZE) / Math.PI)) return null;

  const isCircle = Math.abs(Math.PI - (((a + Math.PI) % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI))
    < CONE_MIN_SIZE;

  const { divisions } = cone;
  const astep = a / divisions;

  // A flipped `meshpyr` (`flipz`, or a negative `size` height) is the same
  // shape upside down -- swapping which end sits at `position`'s own height
  // and which sits `sz.z` above it reads the same as upstream's own
  // scale-then-shift flip, without needing that transform's own ordering.
  // `flipz`/a negative height are gated to `pyramidStyle` upstream, so a
  // plain `cone` never reaches this.
  const flipped = cone.isPyramid && (cone.flipz || rawSize.z < 0);
  const ringZ = flipped ? sz.z : 0;
  const apexZ = flipped ? 0 : sz.z;

  const ringVertsLocal = [];
  const ringNormsLocal = cone.useNormals ? [] : null;
  const ringTexcoords = [];

  for (let i = 0; i <= divisions; i++) {
    const ang = r + (astep * i);
    const cosv = Math.cos(ang);
    const sinv = Math.sin(ang);
    if (!isCircle || i !== divisions) {
      ringVertsLocal.push({ x: cosv * sz.x, y: sinv * sz.y, z: ringZ });
      if (cone.useNormals) {
        let nx = cosv / sz.x;
        let ny = sinv / sz.y;
        let nz = 1 / sz.z;
        const len = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz)) || 1;
        nx /= len; ny /= len; nz /= len;
        ringNormsLocal.push({ x: nx, y: ny, z: flipped ? -nz : nz });
      }
    }
    ringTexcoords.push({ u: texU * (0.5 + (0.5 * cosv)), v: texV * (0.5 + (0.5 * sinv)) });
  }

  const centralNormsLocal = [];
  if (cone.useNormals) {
    for (let i = 0; i < divisions; i++) {
      const ang = r + (astep * (0.5 + i));
      let nx = Math.cos(ang) / sz.x;
      let ny = Math.sin(ang) / sz.y;
      let nz = 1 / sz.z;
      const len = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz)) || 1;
      nx /= len; ny /= len; nz /= len;
      centralNormsLocal.push({ x: nx, y: ny, z: flipped ? -nz : nz });
    }
  }

  // Local (pre-`position`) coordinates so far. A `meshpyr`'s own `rotation`
  // never went into `baseHeading` above -- that is upstream's fixed
  // 45-degree twist -- because upstream applies the mapper's own heading as
  // a genuine second transform on top of that (`xform.addSpin(rotation,
  // zAxis)`, CustomCone.cxx, right before `xform.addShift(pos)`), the same
  // outer `MeshTransform` a `group` instance's own rotation goes through.
  // Composing that as a real transform stack is more machinery than baking
  // one more rotation into this same local-frame convention, so it lands
  // here instead: spin around the vertical axis, then shift, then convert --
  // a plain `cone`'s own `rotation` is already spent as `baseHeading`, so it
  // spins by nothing extra here.
  const pos = { ...cone.posBzf };
  const spinAngle = cone.isPyramid ? cone.rotationRad : 0;
  const cosSpin = Math.cos(spinAngle);
  const sinSpin = Math.sin(spinAngle);
  const spin = (p) => (spinAngle === 0 ? p : {
    x: (p.x * cosSpin) - (p.y * sinSpin), y: (p.x * sinSpin) + (p.y * cosSpin), z: p.z,
  });
  const toBzo = (p) => {
    const s = spin(p);
    return { x: s.x + pos.x, y: s.z + pos.z, z: -(s.y + pos.y) };
  };
  const toBzoDir = (n) => {
    const s = spin(n);
    return { x: s.x, y: s.z, z: -s.y };
  };

  const vertices = ringVertsLocal.map(toBzo);
  const vlen = vertices.length;
  const vbotIndex = vlen;
  const vtopIndex = vlen + 1;
  vertices.push(toBzo({ x: 0, y: 0, z: ringZ }));
  vertices.push(toBzo({ x: 0, y: 0, z: apexZ }));

  const normals = cone.useNormals
    ? ringNormsLocal.map(toBzoDir).concat(centralNormsLocal.map(toBzoDir))
    : [];

  const texcoords = ringTexcoords.slice();
  const tmidIndex = divisions + 1;
  texcoords.push({ u: texU * 0.5, v: texV * 0.5 });
  let t00Index = -1; let t10Index = -1; let t11Index = -1; let t01Index = -1;
  if (!isCircle) {
    t00Index = texcoords.length; texcoords.push({ u: 0, v: 0 });
    t10Index = texcoords.length; texcoords.push({ u: texU, v: 0 });
    t11Index = texcoords.length; texcoords.push({ u: texU, v: texV });
    t01Index = texcoords.length; texcoords.push({ u: 0, v: texV });
  }

  const faceBase = {
    phydrv: cone.phydrv, noclusters: false, smoothBounce: false,
    driveThrough: false, shootThrough: false, ricochet: false,
  };
  const matFields = bzwFaceMaterial;
  const [edgeMat, bottomMat, startMat, endMat] = cone.materials;

  // Every face below is wound the way upstream's own index math winds it,
  // which faces outward for the ordinary apex-up shape. A flipped `meshpyr`
  // swapped which physical end `ringZ`/`apexZ` sit at instead of mirroring
  // through a transform, and that swap inverts every face's own winding
  // (verified by hand: the edge face's cross product flips from
  // (+x,+y,+z)-ish to (-x,-y,+z)-ish between the two) -- swapping each
  // face's own last two corners undoes exactly that, corner-for-corner
  // across its vertex/normal/texcoord indices together.
  const pushFace = (vertexIndices, normalIndices, texcoordIndices, mat) => {
    const order = flipped ? [0, 2, 1] : [0, 1, 2];
    faces.push({
      ...faceBase,
      vertexIndices: order.map((k) => vertexIndices[k]),
      normalIndices: normalIndices.length ? order.map((k) => normalIndices[k]) : [],
      texcoordIndices: order.map((k) => texcoordIndices[k]),
      ...matFields(mat),
    });
  };

  const faces = [];
  for (let i = 0; i < divisions; i++) {
    const V = (x) => (x + i) % vlen;
    const T = (x) => x + i;
    const TI = (x) => divisions - T(x);
    pushFace(
      [vtopIndex, V(0), V(1)],
      cone.useNormals ? [vlen + i, V(0), V(1)] : [],
      [tmidIndex, T(0), T(1)],
      edgeMat,
    );
    // The bottom cap is always flat -- upstream's own shared `addFace`
    // helper never passes it a normal list regardless of `useNormals`,
    // since a flat disc has nothing for a smooth normal to interpolate.
    pushFace(
      [vbotIndex, V(1), V(0)],
      [],
      [tmidIndex, TI(1), TI(0)],
      bottomMat,
    );
  }
  if (!isCircle) {
    pushFace([vbotIndex, 0, vtopIndex], [], [t00Index, t10Index, t01Index], startMat);
    pushFace([vlen - 1, vbotIndex, vtopIndex], [], [t00Index, t10Index, t11Index], endMat);
  }

  const checkLocal = isCircle
    ? { x: 0, y: 0 }
    : { x: Math.cos(r + (0.5 * a)) * sz.x * 0.25, y: Math.sin(r + (0.5 * a)) * sz.y * 0.25 };
  const checkPoint = toBzo({ x: checkLocal.x, y: checkLocal.y, z: (ringZ + apexZ) * 0.5 });

  return {
    type: 'mesh', name: cone.name, definedIn: cone.definedIn,
    vertices, normals, texcoords, faces,
    checkPoints: [{ ...checkPoint, inside: true }],
    phydrv: cone.phydrv, noclusters: false, smoothBounce: cone.smoothBounce, decorative: false,
    driveThrough: cone.driveThrough, shootThrough: cone.shootThrough, ricochet: cone.ricochet,
    texture: null, textureUrl: null, color: null, noRadar: false, noLighting: false,
  };
}

// `ArcObstacle::makeMesh` (ArcObstacle.cxx:93-182), ported the same way as
// `buildConeMesh` above. Unlike a cone, an arc never tapers -- its cross-
// section is the same at every height -- and it has a `ratio` (0..1) between
// its inner and outer radius: `ratio=1` (the default) collapses the inner
// radius to zero, `isPie` in upstream's own terms, an ordinary solid wedge;
// anything less is a genuinely hollow tube with its own `inside` wall.
// `meshbox` is the exact same generator upstream itself reuses
// (`CustomArc(true)`, `BZWReader.cxx`): 4 divisions, defaults pulled from
// BZDB's `_boxBase`/`_boxHeight` (30 and `6*_muzzleHeight` = 9.42 here,
// bzo having no BZDB to read them from live), and upstream rebuilds it at
// the origin with a 45-degree internal twist and a sqrt(2) size scale --
// see `buildConeMesh`'s own comment for why this port folds that into the
// sweep's own start angle instead of composing upstream's transform stack.
// `checkPoints` is upstream's own aid for telling a mesh's inside from its
// outside on an arbitrary, possibly non-convex shape -- bzo's own collision
// never reads a mesh's `checkPoints` at all (every test here is per-face),
// so this keeps one simple, always-correct point rather than porting
// upstream's own six-point `CheckOutside` ring verbatim for something
// nothing downstream looks at.
const ARC_MIN_SIZE = 1e-6;
// `_boxBase`/`_boxHeight` (BZDB, `30.0`/`6.0*_muzzleHeight`, `_muzzleHeight`
// = 1.57) -- `meshbox`'s own default `size` when a mapper gives none, same
// as a plain `box`'s.
const MESHBOX_DEFAULT_BASE = 30.0;
const MESHBOX_DEFAULT_HEIGHT = 6.0 * 1.57;
// `CustomArc.h`'s own material enum order, and the side names
// `parseMaterialsByName` matches a line's first word against.
const ARC_SIDE_NAMES = new Map([
  ['top', 0], ['bottom', 1], ['inside', 2], ['outside', 3], ['startside', 4], ['endside', 5],
]);

// A solid wedge (`ratio` collapses the inner radius to ~0) -- `ArcObstacle::
// makePie` (ArcObstacle.cxx:185-365). All in the arc's own local frame (no
// `position` yet, heading already folded into `r`); the edge ring's own
// vertices/normals/texcoords come first, then the two disc centres, matching
// upstream's own array layout exactly since the face index math below
// depends on it.
function buildArcPieLocal(a, r, h, radius, squish, texU, texV, texDiscU, texDiscV, divisions, useNormals, isCircle) {
  const astep = a / divisions;
  const ringVerts = [];
  const ringNorms = useNormals ? [] : null;
  const texcoords = [];

  for (let i = 0; i <= divisions; i++) {
    const ang = r + (astep * i);
    const cosv = Math.cos(ang);
    const sinv = Math.sin(ang);
    if (!isCircle || i !== divisions) {
      const dx = cosv * radius;
      const dy = sinv * radius * squish;
      ringVerts.push({ x: dx, y: dy, z: 0 });
      ringVerts.push({ x: dx, y: dy, z: h });
      if (useNormals) {
        let nx = cosv * squish;
        let ny = sinv;
        const len = Math.sqrt((nx * nx) + (ny * ny)) || 1;
        nx /= len; ny /= len;
        ringNorms.push({ x: nx, y: ny, z: 0 });
      }
    }
    const t0 = texU * (i / divisions);
    texcoords.push({ u: t0, v: 0 });
    texcoords.push({ u: t0, v: texV });
  }
  // The disc's own radial UV -- always from angle zero, regardless of the
  // sweep's own start angle `r`; upstream's own `astep * i`, not `r + ...`.
  for (let i = 0; i <= divisions; i++) {
    const ang = astep * i;
    texcoords.push({
      u: texDiscU * (0.5 + (0.5 * Math.cos(ang))),
      v: texDiscV * (0.5 + (0.5 * Math.sin(ang))),
    });
  }

  const vertices = ringVerts;
  const vlen = vertices.length;
  const vbotIndex = vlen;
  const vtopIndex = vlen + 1;
  vertices.push({ x: 0, y: 0, z: 0 });
  vertices.push({ x: 0, y: 0, z: h });

  const normals = useNormals ? ringNorms : [];
  const nlen = normals.length;

  const tmidIndex = texcoords.length;
  texcoords.push({ u: texDiscU * 0.5, v: texDiscV * 0.5 });

  const faces = [];
  for (let i = 0; i < divisions; i++) {
    const PV = (x) => (x + (i * 2)) % vlen;
    const PN = (x) => (x + i) % nlen;
    const PTO = (x) => x + (i * 2);
    const PTC = (x) => ((divisions + 1) * 2) + x + i;
    const PTCI = (x) => ((divisions + 1) * 3) - x - i - 1;

    faces.push({
      vertexIndices: [PV(0), PV(2), PV(3), PV(1)],
      normalIndices: useNormals ? [PN(0), PN(1), PN(1), PN(0)] : [],
      texcoordIndices: [PTO(0), PTO(2), PTO(3), PTO(1)],
      side: 3, // Outside_
    });
    faces.push({
      vertexIndices: [vtopIndex, PV(1), PV(3)],
      normalIndices: [],
      texcoordIndices: [tmidIndex, PTC(0), PTC(1)],
      side: 0, // Top
    });
    faces.push({
      vertexIndices: [vbotIndex, PV(2), PV(0)],
      normalIndices: [],
      texcoordIndices: [tmidIndex, PTCI(1), PTCI(0)],
      side: 1, // Bottom
    });
  }
  if (!isCircle) {
    const tc = divisions * 2;
    faces.push({
      vertexIndices: [vbotIndex, 0, 1, vtopIndex],
      normalIndices: [], texcoordIndices: [0, tc, tc + 1, 1], side: 4, // StartFace
    });
    const e = divisions * 2;
    faces.push({
      vertexIndices: [e, vbotIndex, vtopIndex, e + 1],
      normalIndices: [], texcoordIndices: [0, tc, tc + 1, 1], side: 5, // EndFace
    });
  }

  const checkLocal = isCircle
    ? { x: 0, y: 0 }
    : { x: Math.cos(r + (0.5 * a)) * radius * 0.5, y: Math.sin(r + (0.5 * a)) * radius * 0.5 * squish };
  return {
    vertices, normals, texcoords, faces,
    checkPoint: { x: checkLocal.x, y: checkLocal.y, z: 0.5 * h },
  };
}

// A hollow tube -- `ArcObstacle::makeRing` (ArcObstacle.cxx:368-558). Same
// local-frame convention as the pie builder above; every ring index pushes
// four vertices (inside-bottom, inside-top, outside-bottom, outside-top) and
// two normals (inside, outside) rather than the pie's two and one, and has
// no disc centre or radial UV at all -- a hollow tube's top and bottom are
// plain quads between the inside and outside walls, not a fan to a point.
function buildArcRingLocal(a, r, h, inrad, outrad, squish, texU, texV, divisions, useNormals, isCircle) {
  const astep = a / divisions;
  const vertices = [];
  const norms = useNormals ? [] : null;
  const texcoords = [];

  for (let i = 0; i <= divisions; i++) {
    const ang = r + (astep * i);
    const cosv = Math.cos(ang);
    const sinv = Math.sin(ang);
    if (!isCircle || i !== divisions) {
      const ix = cosv * inrad;
      const iy = squish * sinv * inrad;
      const ox = cosv * outrad;
      const oy = squish * sinv * outrad;
      vertices.push({ x: ix, y: iy, z: 0 });
      vertices.push({ x: ix, y: iy, z: h });
      vertices.push({ x: ox, y: oy, z: 0 });
      vertices.push({ x: ox, y: oy, z: h });
      if (useNormals) {
        let nx = -cosv * squish;
        let ny = -sinv;
        const len = Math.sqrt((nx * nx) + (ny * ny)) || 1;
        nx /= len; ny /= len;
        norms.push({ x: nx, y: ny, z: 0 });
        norms.push({ x: -nx, y: -ny, z: 0 });
      }
    }
    const t0 = texU * (i / divisions);
    texcoords.push({ u: t0, v: 0 });
    texcoords.push({ u: t0, v: texV });
  }

  const vlen = vertices.length;
  const normals = useNormals ? norms : [];
  const nlen = normals.length;

  const faces = [];
  for (let i = 0; i < divisions; i++) {
    const RV = (x) => (x + (i * 4)) % vlen;
    const RN = (x) => (x + (i * 2)) % nlen;
    const RT = (x) => x + (i * 2);
    const RIT = (x) => ((divisions + (x % 2)) * 2) - (x + (i * 2));

    faces.push({
      vertexIndices: [RV(4), RV(0), RV(1), RV(5)],
      normalIndices: useNormals ? [RN(2), RN(0), RN(0), RN(2)] : [],
      texcoordIndices: [RIT(2), RIT(0), RIT(1), RIT(3)],
      side: 2, // Inside
    });
    faces.push({
      vertexIndices: [RV(2), RV(6), RV(7), RV(3)],
      normalIndices: useNormals ? [RN(1), RN(3), RN(3), RN(1)] : [],
      texcoordIndices: [RT(0), RT(2), RT(3), RT(1)],
      side: 3, // Outside_
    });
    faces.push({
      vertexIndices: [RV(3), RV(7), RV(5), RV(1)],
      normalIndices: [],
      texcoordIndices: [RT(0), RT(2), RT(3), RT(1)],
      side: 0, // Top
    });
    faces.push({
      vertexIndices: [RV(0), RV(4), RV(6), RV(2)],
      normalIndices: [],
      texcoordIndices: [RT(0), RT(2), RT(3), RT(1)],
      side: 1, // Bottom
    });
  }
  if (!isCircle) {
    const tc = divisions * 2;
    faces.push({
      vertexIndices: [0, 2, 3, 1],
      normalIndices: [], texcoordIndices: [0, tc, tc + 1, 1], side: 4, // StartFace
    });
    const e = divisions * 4;
    faces.push({
      vertexIndices: [e + 2, e, e + 1, e + 3],
      normalIndices: [], texcoordIndices: [0, tc, tc + 1, 1], side: 5, // EndFace
    });
  }

  const midAng = isCircle ? r : (r + (0.5 * a));
  const midRad = (inrad + outrad) * 0.5;
  return {
    vertices, normals, texcoords, faces,
    checkPoint: { x: Math.cos(midAng) * midRad, y: Math.sin(midAng) * midRad * squish, z: 0.5 * h },
  };
}

function buildArcMesh(arc) {
  const rawSize = arc.sizeBzf;
  const sz = arc.isBox
    ? { x: Math.abs(rawSize.x) * Math.SQRT2, y: Math.abs(rawSize.y) * Math.SQRT2, z: Math.abs(rawSize.z) }
    : { x: Math.abs(rawSize.x), y: Math.abs(rawSize.y), z: Math.abs(rawSize.z) };

  let texU = arc.texsize.u;
  let texV = arc.texsize.v;
  let texDiscU = arc.texsize.du;
  let texDiscV = arc.texsize.dv;
  if (sz.x < ARC_MIN_SIZE || sz.y < ARC_MIN_SIZE || sz.z < ARC_MIN_SIZE
    || Math.abs(texU) < ARC_MIN_SIZE || Math.abs(texV) < ARC_MIN_SIZE
    || Math.abs(texDiscU) < ARC_MIN_SIZE || Math.abs(texDiscV) < ARC_MIN_SIZE
    || arc.ratio < 0 || arc.ratio > 1) {
    return null;
  }

  if (texU < 0) {
    const circ = Math.PI * ((3 * (sz.x + sz.y))
      - Math.sqrt((sz.x + (3 * sz.y)) * (sz.y + (3 * sz.x))));
    texU = -Math.floor(circ / texU);
  }
  if (texV < 0) texV = -(sz.z / texV);

  const baseHeading = arc.isBox ? (Math.PI / 4) : arc.rotationRad;
  let r = baseHeading;
  let a = arc.sweepDeg;
  if (a > 360) a = 360;
  if (a < -360) a = -360;
  a *= Math.PI / 180;
  if (a < 0) {
    r += a;
    a = -a;
  }
  if (arc.divisions <= Math.floor((a + ARC_MIN_SIZE) / Math.PI)) return null;
  const isCircle = Math.abs(Math.PI - (((a + Math.PI) % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI))
    < ARC_MIN_SIZE;

  let inrad = sz.x * (1 - arc.ratio);
  let outrad = sz.x;
  if (inrad > outrad) {
    const tmp = inrad;
    inrad = outrad;
    outrad = tmp;
  }
  if (outrad < ARC_MIN_SIZE || (outrad - inrad) < ARC_MIN_SIZE) return null;
  const isPie = inrad < ARC_MIN_SIZE;
  const squish = sz.y / sz.x;
  if (isPie) {
    if (texDiscU < 0) texDiscU = -((2 * outrad) / texDiscU);
    if (texDiscV < 0) texDiscV = -((2 * outrad * squish) / texDiscV);
  }

  const built = isPie
    ? buildArcPieLocal(a, r, sz.z, outrad, squish, texU, texV, texDiscU, texDiscV, arc.divisions, arc.useNormals, isCircle)
    : buildArcRingLocal(a, r, sz.z, inrad, outrad, squish, texU, texV, arc.divisions, arc.useNormals, isCircle);

  // See `buildConeMesh`'s own comment on `spinAngle` -- the same reasoning
  // applies here: a `meshbox`'s own `rotation` is upstream's own second
  // transform on top of the fixed 45-degree twist, not part of `baseHeading`.
  const pos = { ...arc.posBzf };
  const spinAngle = arc.isBox ? arc.rotationRad : 0;
  const cosSpin = Math.cos(spinAngle);
  const sinSpin = Math.sin(spinAngle);
  const spin = (p) => (spinAngle === 0 ? p : {
    x: (p.x * cosSpin) - (p.y * sinSpin), y: (p.x * sinSpin) + (p.y * cosSpin), z: p.z,
  });
  const toBzo = (p) => {
    const s = spin(p);
    return { x: s.x + pos.x, y: s.z + pos.z, z: -(s.y + pos.y) };
  };
  const toBzoDir = (n) => {
    const s = spin(n);
    return { x: s.x, y: s.z, z: -s.y };
  };

  const vertices = built.vertices.map(toBzo);
  const normals = built.normals.map(toBzoDir);
  const { texcoords } = built;

  const faceBase = {
    phydrv: arc.phydrv, noclusters: false, smoothBounce: false,
    driveThrough: false, shootThrough: false, ricochet: false,
  };
  const matFields = bzwFaceMaterial;
  const faces = built.faces.map(({ side, ...face }) => ({
    ...faceBase, ...face, ...matFields(arc.materials[side]),
  }));

  const checkPoint = toBzo(built.checkPoint);

  return {
    type: 'mesh', name: arc.name, definedIn: arc.definedIn,
    vertices, normals, texcoords, faces,
    checkPoints: [{ ...checkPoint, inside: true }],
    phydrv: arc.phydrv, noclusters: false, smoothBounce: arc.smoothBounce, decorative: false,
    driveThrough: arc.driveThrough, shootThrough: arc.shootThrough, ricochet: arc.ricochet,
    texture: null, textureUrl: null, color: null, noRadar: false, noLighting: false,
  };
}

// `SphereObstacle::makeMesh` (SphereObstacle.cxx:86-433), the least like any
// of the other three -- not a swept cross-section at all, but a recursive
// triangular subdivision of a quarter-sphere, mirrored four ways around
// (the `q` loop) and, for a full sphere, once more top-to-bottom (`factor`
// doubling every ring vertex except the shared equator). Ported the same
// way as the others (local frame, upstream's own variable names kept as
// close as JS allows so this can be checked against the source line for
// line), but this one earned real hand-verification before trusting it at
// all: traced `divisions=1` by hand, vertex by vertex and face by face,
// checked every one of its 8 faces against the octant it sits in, before
// ever running it -- the index math (`((k*k)+k)*2`, `ringOffset`,
// `lastStrip`/`lastCircle`) is upstream's own triangular-number recursion,
// not something to trust by inspection alone. The fuzz sweep afterward
// (see the `cone`/`arc` entries above for the method) is what actually
// confirms it across every `divisions` this hand trace didn't cover.
const SPHERE_MIN_SIZE = 1e-6;
const SPHERE_SIDE_NAMES = new Map([['edge', 0], ['bottom', 1]]);

function buildSphereMesh(sphere) {
  const factor = sphere.hemisphere ? 1 : 2;
  const sz = {
    x: Math.abs(sphere.sizeBzf.x), y: Math.abs(sphere.sizeBzf.y), z: Math.abs(sphere.sizeBzf.z),
  };
  let texU = sphere.texsize.u;
  let texV = sphere.texsize.v;
  if (texU < 0) {
    const circ = Math.PI * ((3 * (sz.x + sz.y))
      - Math.sqrt((sz.x + (3 * sz.y)) * (sz.y + (3 * sz.x))));
    texU = -Math.floor(circ / texU);
  }
  if (texV < 0) texV = -((2 * sz.z) / texV);

  const { divisions } = sphere;
  if (divisions < 1 || Math.abs(texU) < SPHERE_MIN_SIZE || Math.abs(texV) < SPHERE_MIN_SIZE
    || sz.x < SPHERE_MIN_SIZE || sz.y < SPHERE_MIN_SIZE || sz.z < SPHERE_MIN_SIZE) {
    return null;
  }

  const r = sphere.rotationRad;
  const { useNormals, hemisphere } = sphere;
  const vertices = [];
  const normals = useNormals ? [] : null;
  const texcoords = [];

  vertices.push({ x: 0, y: 0, z: sz.z });
  if (!hemisphere) vertices.push({ x: 0, y: 0, z: -sz.z });
  if (useNormals) {
    normals.push({ x: 0, y: 0, z: 1 });
    if (!hemisphere) normals.push({ x: 0, y: 0, z: -1 });
  }
  texcoords.push({ u: 0.5, v: 1.0 });
  if (!hemisphere) texcoords.push({ u: 0.5, v: 0.0 });

  for (let i = 0; i < divisions; i++) {
    const ringCount = 4 * (i + 1);
    for (let j = 0; j < ringCount; j++) {
      const hAngle = (((2 * Math.PI) * j) / ringCount) + r;
      const vAngle = ((Math.PI / 2) * (divisions - i - 1)) / divisions;
      const cosV = Math.cos(vAngle);
      const ux = Math.cos(hAngle) * cosV;
      const uy = Math.sin(hAngle) * cosV;
      const uz = Math.sin(vAngle);
      vertices.push({ x: sz.x * ux, y: sz.y * uy, z: sz.z * uz });

      let nx = 0; let ny = 0; let nz = 0;
      if (useNormals) {
        nx = ux / sz.x; ny = uy / sz.y; nz = uz / sz.z;
        const len = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz)) || 1;
        nx /= len; ny /= len; nz /= len;
        normals.push({ x: nx, y: ny, z: nz });
      }

      let vFrac = (divisions - i - 1) / divisions;
      if (!hemisphere) vFrac = 0.5 + (0.5 * vFrac);
      const scaledV = vFrac * texV;
      texcoords.push({ u: (j / ringCount) * texU, v: scaledV });

      if (!hemisphere && i !== divisions - 1) {
        vertices.push({ x: sz.x * ux, y: sz.y * uy, z: -sz.z * uz });
        if (useNormals) normals.push({ x: nx, y: ny, z: -nz });
        texcoords.push({ u: (j / ringCount) * texU, v: texV - scaledV });
      }
    }
  }

  // The closing strip -- one more texcoord per ring (and the two poles) for
  // the seam where `j` wraps from the last position back to zero, needing
  // U at the *far* edge (`texU`) rather than wrapping back to the near one.
  const texStripOffset = texcoords.length;
  texcoords.push({ u: texU * 0.5, v: texV });
  if (!hemisphere) texcoords.push({ u: texU * 0.5, v: 0 });
  for (let i = 0; i < divisions; i++) {
    let vFrac = (divisions - i - 1) / divisions;
    if (!hemisphere) vFrac = 0.5 + (0.5 * vFrac);
    const scaledV = texV * vFrac;
    texcoords.push({ u: texU, v: scaledV });
    if (!hemisphere && i !== divisions - 1) {
      texcoords.push({ u: texU, v: texV - scaledV });
    }
  }

  // A hemisphere's own flat bottom cap, textured like a cone/arc's disc.
  const bottomTexOffset = texcoords.length;
  if (hemisphere) {
    const astep = (2 * Math.PI) / (divisions * 4);
    for (let i = 0; i < divisions * 4; i++) {
      const ang = astep * i;
      texcoords.push({
        u: texU * (0.5 + (0.5 * Math.cos(ang))), v: texV * (0.5 + (0.5 * Math.sin(ang))),
      });
    }
  }

  const faces = [];
  const kLast = divisions - 1;
  const ringOffset = hemisphere ? 0 : 1 + (((kLast * kLast) + kLast) * 2);

  for (let q = 0; q < 4; q++) {
    for (let i = 0; i < divisions; i++) {
      for (let j = 0; j < i + 1; j++) {
        const lastStrip = q === 3 && j === i;
        const lastCircle = i === divisions - 1;

        let a;
        if (i > 0) {
          const k = i - 1;
          a = lastStrip
            ? 1 + (((k * k) + k) * 2)
            : 1 + (((k * k) + k) * 2) + (q * (k + 1)) + j;
        } else {
          a = 0;
        }
        let b = 1 + (((i * i) + i) * 2) + (q * (i + 1)) + j;
        let c = lastStrip ? 1 + (((i * i) + i) * 2) : b + 1;
        const kNext = i + 1;
        let d = 1 + (((kNext * kNext) + kNext) * 2) + (q * (kNext + 1)) + (j + 1);

        a *= factor;
        if (!lastCircle) {
          b *= factor;
          c *= factor;
        } else {
          b += ringOffset;
          c += ringOffset;
        }
        if (i !== divisions - 2) d *= factor;
        else d += ringOffset;

        let ta;
        let tc;
        if (!lastStrip) {
          ta = a;
          tc = c;
        } else {
          ta = texStripOffset + (i * factor);
          tc = texStripOffset + ((i + 1) * factor);
        }

        faces.push({ vertexIndices: [a, b, c], normalIndices: useNormals ? [a, b, c] : [], texcoordIndices: [ta, b, tc], side: 0 });
        if (!lastCircle) {
          faces.push({ vertexIndices: [b, d, c], normalIndices: useNormals ? [b, d, c] : [], texcoordIndices: [b, d, tc], side: 0 });
        }

        if (!hemisphere) {
          a += 1;
          ta += 1;
          if (!lastCircle) {
            b += 1;
            c += 1;
            tc += 1;
          }
          if (i !== divisions - 2) d += 1;
          faces.push({ vertexIndices: [a, c, b], normalIndices: useNormals ? [a, c, b] : [], texcoordIndices: [ta, tc, b], side: 0 });
          if (!lastCircle) {
            faces.push({ vertexIndices: [b, c, d], normalIndices: useNormals ? [b, c, d] : [], texcoordIndices: [b, tc, d], side: 0 });
          }
        }
      }
    }
  }

  if (hemisphere) {
    const offset = 1 + (((kLast * kLast) + kLast) * 2);
    const discVertexIndices = [];
    const discTexcoordIndices = [];
    for (let i = 0; i < divisions * 4; i++) {
      const vv = (divisions * 4) - i - 1;
      discVertexIndices.push(vv + offset);
      discTexcoordIndices.push(i + bottomTexOffset);
    }
    faces.push({
      vertexIndices: discVertexIndices, normalIndices: [], texcoordIndices: discTexcoordIndices, side: 1,
    });
  }

  const pos = { ...sphere.posBzf };
  const toBzo = (p) => ({ x: p.x + pos.x, y: p.z + pos.z, z: -(p.y + pos.y) });
  const toBzoDir = (n) => ({ x: n.x, y: n.z, z: -n.y });

  const outVertices = vertices.map(toBzo);
  const outNormals = useNormals ? normals.map(toBzoDir) : [];

  const faceBase = {
    phydrv: sphere.phydrv, noclusters: false, smoothBounce: false,
    driveThrough: false, shootThrough: false, ricochet: false,
  };
  const matFields = bzwFaceMaterial;
  const outFaces = faces.map(({ side, ...face }) => ({
    ...faceBase, ...face, ...matFields(sphere.materials[side]),
  }));

  const checkLocal = { x: 0, y: 0, z: hemisphere ? 0.5 * sz.z : 0 };
  const checkPoint = toBzo(checkLocal);

  return {
    type: 'mesh', name: sphere.name, definedIn: sphere.definedIn,
    vertices: outVertices, normals: outNormals, texcoords, faces: outFaces,
    checkPoints: [{ ...checkPoint, inside: true }],
    phydrv: sphere.phydrv, noclusters: false, smoothBounce: sphere.smoothBounce, decorative: false,
    driveThrough: sphere.driveThrough, shootThrough: sphere.shootThrough, ricochet: sphere.ricochet,
    texture: null, textureUrl: null, color: null, noRadar: false, noLighting: false,
  };
}

// `_rainType` (`WeatherRenderer.cxx`): the preset names upstream recognizes.
// bzo picks one rendering path per effects-menu.md's rule -- textured, spun or
// billboarded, roof-culled and puddled -- and builds every preset on it rather
// than porting `doLineRain`'s plain streaks, so "rain" gets the same textured
// look as "fatrain" rather than upstream's `GL_LINES` streak. See "Weather" in
// docs/bzw.md.
// `-set` variables that describe how the world drives and shoots, mapped onto
// the `GAME_CONFIG` fields that already hold each one. Every one of these is
// `StateDatabase::Locked` upstream (`globalDBItems`, src/common/global.cxx),
// so the server owns the value and the client is told it -- which is exactly
// bzo's own arrangement, and why a map may state them at all.
//
// The flag variables (`_wings*`, `_maxFlagGrabs`) are read elsewhere and stay
// there: they belong to superflags, which a Map Viewer preview never has.
// `-j` and `+r` are not here either -- bzo forces jumping and ricochet on
// (see "The options block" in docs/bzw.md), so a map cannot turn them off.
const MAP_PHYSICS_VARS = new Map([
  ['_tankSpeed', { key: 'TANK_SPEED' }],
  ['_tankAngVel', { key: 'TANK_ROTATION_SPEED' }],
  // Upstream states gravity as a negative acceleration and bzo keeps the
  // magnitude, so a map's `-9.81` and its `9.81` mean the same thing here.
  ['_gravity', { key: 'GRAVITY', transform: Math.abs }],
  ['_jumpVelocity', { key: 'JUMP_VELOCITY' }],
  ['_shotSpeed', { key: 'SHOT_SPEED' }],
  ['_shotRange', { key: 'SHOT_RANGE' }],
  ['_shotRadius', { key: 'SHOT_RADIUS' }],
  // Seconds upstream, milliseconds here. Upstream defaults it to
  // `_explodeTime` and bzo keeps the one number for both, so only the
  // rejoin spelling is read -- `_explodeTime` on its own is how long the
  // explosion is drawn for, which is not what this delay is.
  ['_rejoinTime', { key: 'RESPAWN_DELAY', transform: (n) => n * 1000 }],
  // Seconds upstream, milliseconds here, and it is the *basis* a reload is
  // derived from rather than the reload itself -- see `deriveShotReloadTime`.
  ['_reloadTime', { key: 'SHOT_LIFETIME', transform: (n) => n * 1000 }],
]);

const WEATHER_RAIN_TYPES = new Set(['rain', 'snow', 'fatrain', 'frog', 'particle', 'bubble']);

// The single-value `_rain*` variables that still mean something once
// `doLineRain`/`useRainBillboards`/`userRainScale` are gone -- `_rainBaseColor`
// and `_rainTopColor` are dropped for the same reason: both tint upstream's
// line-rain vertices alone (`drawDrop`'s non-line branch always draws white),
// so they would be no-ops here. Mapped to the `weather` field bzo's own JSON
// uses, not upstream's BZDB name, since the client never reads a BZDB var.
const WEATHER_RAIN_NUMERIC_VARS = new Map([
  ['_rainDensity', 'density'],
  ['_rainSpread', 'spread'],
  ['_rainSpeed', 'speed'],
  ['_rainSpeedMod', 'speedMod'],
  ['_rainStartZ', 'startZ'],
  ['_rainEndZ', 'endZ'],
  ['_rainMaxPuddleTime', 'maxPuddleTime'],
  ['_rainPuddleSpeed', 'puddleSpeed'],
  ['_rainRoofs', 'roofs'],
]);

// Options in a map's `options` block that `parseBZWTeamMode`
// (server/teams.cjs) reads rather than `parseBZWServerOptions` below. Kept so
// the unread-option tally does not report an option bzo does in fact act on;
// `test-team-mode.mjs` holds it to what that parser really claims.
const TEAM_MODE_OPTIONS = new Set(['-c', '-offa', '-rabbit', '-autoTeam', '-mp']);

function parseBZWServerOptions(lines) {
  let inOptions = false;
  // Every other field is left absent unless the map names it. `forbiddenFlags`
  // is the exception because `-f` may appear any number of times, and an empty
  // list says the same thing as no list.
  const options = {
    // Server options in the map's own `options` block that no test above
    // claims, by option, so a map says which of its settings bzo ignored.
    unreadOptions: new Map(),
    forbiddenFlags: [], unreadBZDBVars: [], serverMessages: [], adMessages: [], gameplay: {},
  };

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
    const [option, value, rawSetValue] = line.split(/\s+/);
    // `-set <name> "<value>"`: upstream has world variables whose value is a
    // list (`_ambientLight` and the other colours), and a remote import
    // writes those back out quoted rather than dropping them. Nothing else in
    // this block takes a quoted value, so the quotes are unwrapped here and
    // every reader below sees the plain string either way.
    const quotedSetValue = option === '-set' ? line.match(/^-set\s+\S+\s+"([^"]*)"\s*$/) : null;
    const setValue = quotedSetValue ? quotedSetValue[1] : rawSetValue;
    // Each option below is tested through this, so an option no test claims
    // is an option bzo does not read -- recorded rather than passed over, the
    // same as `unreadBZDBVars` already does for a `-set` variable.
    let optionRead = false;
    const readOption = (name) => {
      if (option !== name) return false;
      optionRead = true;
      return true;
    };
    // -fb: superflags may come to rest on buildings, and may spawn on them.
    if (readOption('-fb')) options.flagsOnBuildings = true;
    // -j: tanks may jump. bzo already defaults this on, so the switch only
    // matters on a server whose config has turned jumping off.
    if (readOption('-j')) options.jumping = true;
    // +r: every shot ricochets, whatever flag fired it.
    if (readOption('+r')) options.ricochet = true;
    // -st <seconds>: how long a bad flag sticks before it shakes off, and -sw
    // <kills>: how many wins shake one off. Both take a value.
    if (readOption('-st')) options.flagShakeTimeout = normalizeShakeTimeout(value);
    if (readOption('-sw')) options.flagShakeWins = normalizeShakeWins(value);
    // -sa: put an antidote flag in the world for whoever is carrying a bad one.
    if (readOption('-sa')) options.antidoteFlags = true;
    // -time <seconds>: the match clock. Upstream also reads an `h:mm:ss`
    // clock-time form; bzo does not.
    if (readOption('-time')) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) options.timeLimit = seconds;
    }
    // -timemanual: the clock above waits for /countdown rather than starting
    // on its own.
    if (readOption('-timemanual')) options.timeManualStart = true;
    // -mps <score>: ends the match the moment any player's wins minus losses
    // reaches it.
    if (readOption('-mps')) {
      const score = Number(value);
      if (Number.isFinite(score) && score > 0) options.maxPlayerScore = score;
    }
    // -mts <score>: ends the match the moment any colour team's wins minus
    // losses reaches it.
    if (readOption('-mts')) {
      const score = Number(value);
      if (Number.isFinite(score) && score > 0) options.maxTeamScore = score;
    }
    // -a <vel> <rot>: the world's acceleration limit, upstream's inertia switch.
    // The only option here that takes two values, which is why it reads
    // `setValue` as well.
    if (readOption('-a')) {
      const linear = Number(value);
      const angular = Number(setValue);
      if (Number.isFinite(linear)) options.linearAcceleration = Math.max(0, linear);
      if (Number.isFinite(angular)) options.angularAcceleration = Math.max(0, angular);
    }
    // -noTeamKills: "Players on the same team are immune to each other's shots.
    // Rogue is excepted." Friendly fire off, which upstream enforces on each
    // client in LocalPlayer::checkHit; bzo's server decides every hit, so it
    // enforces it in the one place instead.
    if (readOption('-noTeamKills')) options.noTeamKills = true;
    // -tk: "player does not die when killing a teammate". Note which way round
    // this runs -- upstream kills a team killer *by default*, and the switch is
    // what turns that off, so `-tk` is the lenient setting rather than the
    // strict one.
    if (readOption('-tk')) options.teamKillerDies = false;
    // -ms <count>: how many shots a tank may have in the air at once. Unlike the
    // switches above this carries a value, and upstream parses a map's options
    // where `-world` sits on the command line, so the map's number simply
    // replaces whatever came before it rather than only ever raising it.
    // A count of 0 means "tanks cannot shoot" upstream; bzo has no such mode, so
    // normalizeShotSlotCount clamps it to one shot as it clamps the config.
    if (readOption('-ms')) {
      const requestedShots = Number(value);
      if (Number.isFinite(requestedShots)) {
        options.shotMaxActive = normalizeShotSlotCount(Math.round(requestedShots));
        // Also part of how this map shoots, so a Map Viewer preview reloads at
        // its rate rather than the live match's -- see `deriveMapGameplay`.
        options.gameplay.SHOT_MAX_ACTIVE = options.shotMaxActive;
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
    if (readOption('-s') || readOption('+s')) {
      const requestedFlags = Math.round(Number(value));
      options.superFlagCount = Number.isFinite(requestedFlags) && requestedFlags > 0
        ? requestedFlags
        : 16;
    }
    // -f <abbreviation|good|bad>: take a flag type out of the pool a slot draws
    // from, upstream's flagDisallowed table. Disallows accumulate and nothing
    // puts one back, so this is a switch like the rest even though it names its
    // target. `WA`, the one type bzo does not carry, is already absent from the
    // pool, so naming it is not an error -- it asks for nothing that was there.
    if (readOption('-f') && value) {
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
    // -gndtex <name>: the map's ground texture. Upstream's own bzfs option
    // (`CmdLineOptions.cxx:785-792`) never calls `checkFromWorldFile` for
    // it, so unlike most options here it is legal both on the command line
    // and inside a map's own `options` block; it registers a material
    // literally named `GroundMaterial` holding that one texture, the same
    // name `BackgroundRenderer::setupGroundMaterials`
    // (`BackgroundRenderer.cxx:265-303`) looks up to draw the ground, and
    // the same name a mapper can write an explicit `material` block under
    // instead (resolved against `materialsByName` once the whole file is
    // read; see the `groundMaterial` build below).
    if (readOption('-gndtex') && value) options.groundTexture = value;
    // -srvmsg <text>: a line said to each player as they join. Upstream
    // accumulates every occurrence into one string separated by a literal `\n`
    // and splits it again on the way out (bzfs.cxx:2507), so a map may write
    // several lines either way -- one option each, or one option carrying `\n`.
    // The quotes a map wraps the text in are the option parser's, not the text's.
    if (readOption('-srvmsg')) {
      // Taken off the raw line rather than from the split tokens, because the
      // text's own spacing is part of it -- upstream's parseWorldOptions reads a
      // quoted argument as one token and never touches what is inside it.
      const rest = line.replace(/^\S+\s*/, '');
      const quoted = rest.match(/^"([\s\S]*)"$/);
      const text = quoted ? quoted[1] : rest;
      for (const messageLine of text.split('\\n')) options.serverMessages.push(messageLine);
    }
    // -admsg <text>: the same accumulation and `\n` splitting as -srvmsg
    // above, but said periodically to everyone already playing rather than
    // once to a player as they join (bzfs.cxx:7555-7591, every 900 seconds).
    // Upstream also takes a file-backed multi-line form (`-helpmsg`'s sibling
    // in `textChunker`); bzo has only the inline-text form, the same limit
    // `docs/bzw.md` already notes for `-helpmsg` itself.
    if (readOption('-admsg')) {
      const rest = line.replace(/^\S+\s*/, '');
      const quoted = rest.match(/^"([\s\S]*)"$/);
      const text = quoted ? quoted[1] : rest;
      for (const messageLine of text.split('\\n')) options.adMessages.push(messageLine);
    }
    // -set <variable> <value>: a BZDB assignment. bzo's world constants are
    // constants, so the only variable it can honour is one it already keeps a
    // configurable copy of. Every other name is collected and reported, because
    // a map that sets `_tankSpeed` and is quietly played at bzo's is worse than
    // a map that says so on load.
    if (readOption('-set') && value) {
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
      } else if (value === '_maxBumpHeight') {
        // How high a step a tank may climb without jumping. Zero is meaningful
        // -- a world with no bump-climbing at all -- so the floor is 0 rather
        // than some positive minimum.
        const bump = Number(setValue);
        if (Number.isFinite(bump) && bump >= 0) {
          options.maxBumpHeight = bump;
        }
      } else if (value === '_rainType') {
        // The one weather variable whose value is a preset name rather than a
        // number. Nothing here turns weather on without it -- a map that sets
        // only `_rainDensity` or another tuning variable below is read but has
        // nothing to apply it to, upstream's own `rainType`-less path being an
        // edge case not worth reproducing.
        const type = (setValue || '').trim().toLowerCase();
        if (WEATHER_RAIN_TYPES.has(type)) {
          options.weather = { ...(options.weather || {}), type };
        } else if (type && type !== 'none') {
          options.unreadBZDBVars.push(`_rainType=${setValue}`);
        }
      } else if (WEATHER_RAIN_NUMERIC_VARS.has(value)) {
        const num = Number(setValue);
        if (Number.isFinite(num)) {
          options.weather = { ...(options.weather || {}), [WEATHER_RAIN_NUMERIC_VARS.get(value)]: num };
        }
      } else if (value === '_useRainPuddles' || value === '_rainSpins') {
        // `BZDB.isTrue`'s own reading: `atoi(value) != 0`, so "true" is false
        // and only a nonzero number is true.
        const parsed = parseInt(setValue, 10);
        const truthy = Number.isFinite(parsed) && parsed !== 0;
        const field = value === '_useRainPuddles' ? 'puddles' : 'spin';
        options.weather = { ...(options.weather || {}), [field]: truthy };
      } else if (value === '_rainTexture' || value === '_rainPuddleTexture') {
        const textureName = (setValue || '').trim().toLowerCase();
        if (BZW_STOCK_TEXTURES.has(textureName)) {
          const field = value === '_rainTexture' ? 'texture' : 'puddleTexture';
          options.weather = { ...(options.weather || {}), [field]: textureName };
        }
      } else if (MAP_PHYSICS_VARS.has(value)) {
        // The world's own physics. Upstream locks every one of these, which
        // means the server states them and each client obeys -- so a map that
        // names one is naming how it is meant to be driven and shot on, and
        // bzo reads it the same way it already reads `-a` and `-ms`. Kept out
        // of the flag variables next to them on purpose: those describe
        // superflags, and a Map Viewer preview has no flags in it (see
        // "Map physics" in docs/bzw.md).
        const { key, transform } = MAP_PHYSICS_VARS.get(value);
        const num = Number(setValue);
        if (Number.isFinite(num)) {
          const applied = transform ? transform(num) : num;
          if (applied > 0) options.gameplay[key] = applied;
        }
      } else {
        options.unreadBZDBVars.push(value);
      }
    }

    // `parseBZWTeamMode` (server/teams.cjs) is the other reader of this same
    // block, and it owns everything about who plays on which side. An option
    // it claims is read by bzo even though nothing here claimed it, so it is
    // not a gap -- naming that list here is the price of the block having two
    // readers, and the tests hold the two in step.
    if (!optionRead && !TEAM_MODE_OPTIONS.has(option)) {
      options.unreadOptions.set(option, (options.unreadOptions.get(option) || 0) + 1);
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

// `cone`/`meshpyr`'s own four material slots, in `CustomCone.h`'s own enum
// order (`Edge, Bottom, StartFace, EndFace`) -- naming one of these first on
// a line applies only to that slot (`parseMaterialsByName`); anything else
// recognized applies to all four at once (`parseMaterials`), same as a bare
// material line before a `tetra`'s first `vertex`.
const CONE_SIDE_NAMES = new Map([
  ['edge', 0], ['bottom', 1], ['startside', 2], ['endside', 3],
]);

// A material property may name the faces it applies to first, and upstream's own
// names for a box's faces are these, with `top`, `bottom`, `sides` and
// `outside` as extras over the six (CustomBox.cxx:34 and :104). bzo draws a box
// as two groups -- its four walls and its two caps -- so a selector lands on one
// of the two: the upright faces are walls and the flat ones are caps. Naming a
// single wall tints all four, which is as finely as bzo's geometry divides.
//
// Upstream's z is up where bzo's y is, so `z+` and `z-` are the caps.
const BZW_FACE_GROUPS = new Map([
  ['x+', 'walls'],
  ['x-', 'walls'],
  ['y+', 'walls'],
  ['y-', 'walls'],
  ['sides', 'walls'],
  ['outside', 'walls'],
  ['z+', 'caps'],
  ['z-', 'caps'],
  ['top', 'caps'],
  ['bottom', 'caps'],
]);

// `color`, and `diffuse` which is the same thing under the name bzflag itself
// writes (ParseMaterial.cxx:90). Three or four numbers, which is upstream's
// numeric colour (ParseColor.cxx): the fourth is alpha, read so that a map
// stating it is not turned away, and then dropped, because an obstacle bzo draws
// is opaque. Upstream also takes an X11 colour name in the same place; bzo does
// not, and a map using one keeps the untinted texture.
function parseBzwColor(words) {
  const values = words.slice(0, 4).map(Number);
  if (values.length < 3) return null;
  if (values.some((value) => !Number.isFinite(value))) return null;
  const [r, g, b, a] = values;
  // Alpha kept alongside RGB (rather than dropped) so a material that is
  // meant to be invisible -- `diffuse 0 0 0 0`, a common "solid for
  // collision/radar, drawn as nothing" trick -- actually renders as nothing
  // in bzo too, instead of the fully opaque black RGB-only would otherwise
  // produce (see `_buildMeshObject` in public/render.js, the one reader of
  // this fourth value).
  return [r, g, b, a === undefined ? 1 : a].map((value) => Math.max(0, Math.min(1, value)));
}

// Every stock texture name upstream's own `data/` ships an asset for --
// not just the handful `material`/`matref`/`addtexture` names most often in
// the wild (docs/bzw-plan.md's "Evidence from real maps"), because there is
// no way to predict which one a map maker reaches for. bzo runtime-colours a
// tank/shot's own grey base per team rather than shipping one file per
// colour (`loadTintedTexture`/`getBaseTeamTint`, public/texture.js) -- but a
// material block names a *file*, not a game concept, so a map that puts
// "the blue shot" on a wall as decoration needs `blue_bolt` to be a real
// picture regardless of how bzo's own shot rendering gets its colour.
// Kept in sync with `STOCK_MATERIAL_TEXTURE_FILES` in `public/texture.js`,
// which is the other half of this: this set decides what a map is *allowed*
// to name, that one decides what picture the name actually draws.
//
// A name not in this set -- anything not shipped in upstream's own `data/`,
// or an external URL a map links a texture in from -- resolves to nothing:
// no network fetch, no CORS/CSP surface, and the obstacle keeps its type's
// plain default texture.
const BZW_STOCK_TEXTURES = new Set([
  'automatic_icon', 'blend_flash', 'blue_basetop', 'blue_basewall', 'blue_bolt', 'blue_icon',
  'blue_laser', 'blue_super_bolt', 'blue_tank', 'boxwall', 'bubble', 'bzflag-256x256',
  'bzflag-48x48', 'caution', 'clouds', 'dusty_flare', 'explode1', 'explode2', 'flag', 'frog',
  'green_basetop', 'green_basewall', 'green_bolt', 'green_icon', 'green_laser',
  'green_super_bolt', 'green_tank', 'hunter_bolt', 'hunter_laser', 'hunter_super_bolt',
  'hunter_tank', 'jumpjets', 'menu_arrow', 'mesh', 'missile', 'moon', 'mountain1', 'mountain2',
  'mountain3', 'mountain4', 'mountain5', 'observer_icon', 'puddle', 'puffs', 'purple_basetop',
  'purple_basewall', 'purple_bolt', 'purple_icon', 'purple_laser', 'purple_super_bolt',
  'purple_tank', 'pyrwall', 'rabbit_bolt', 'rabbit_laser', 'rabbit_super_bolt', 'rabbit_tank',
  'radar', 'raindrop', 'red_basetop', 'red_basewall', 'red_bolt', 'red_icon', 'red_laser',
  'red_super_bolt', 'red_tank', 'rogue_bolt', 'rogue_icon', 'rogue_laser', 'rogue_super_bolt',
  'rogue_tank', 'roof', 'shot_tail', 'snowflake', 'std_ground', 'telelink', 'tetrawall', 'thief',
  'title', 'treads', 'wall', 'water', 'zone_ground',
]);

// A texture name as a `material`/`addtexture`/`texture` line states it --
// upstream's own bare stock name, or a mapper's own file name or URL -- down
// to whichever of bzo's local assets it might match: no path, no extension,
// case-folded, the way upstream's TextureManager itself keys textures by name.
function resolveBzwStockTexture(rawName) {
  if (!rawName) return null;
  const bare = rawName.trim().split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  return BZW_STOCK_TEXTURES.has(bare) ? bare : null;
}

// An absolute `http`/`https` URL, the other thing a real map's `addtexture`
// names (docs/bzw-plan.md's "Evidence from real maps" found exactly one:
// `http://images.bzflag.org/astevens/pine.png`). This is a syntax check
// only -- the server never fetches it, upstream's `ftp` is dropped since no
// browser still fetches it for an image, and whether the picture actually
// *loads* is `isExternalTextureUrlLoadable` in `public/texture.js`, a
// separate decision made in the browser rather than here (every host is
// attempted; see that file for why), so bzo's own server is never the one
// making an outbound request on a mapper's say-so.
function parseBzwTextureUrl(rawName) {
  if (!rawName) return null;
  // A protocol-relative URL (`//host/path`) has no scheme of its own to
  // validate here -- only the browser that eventually loads it has a page
  // to resolve one against, so this borrows a throwaway scheme just to
  // confirm the rest still parses as a real URL, and forwards the original
  // protocol-relative string rather than the resolved one. Each connected
  // client re-resolves it against its own `window.location.href`
  // (`isExternalTextureUrlLoadable`, public/texture.js), which is what lets
  // the same map serve `http://` on a plain local server and `https://` on
  // one that terminates TLS, from the one line a mapper wrote.
  if (rawName.startsWith('//')) {
    try {
      return new URL(`https:${rawName}`).host ? rawName : null;
    } catch {
      return null;
    }
  }
  try {
    const parsed = new URL(rawName);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // Real bzflag's own downloader needs a literal scheme to parse a texture
    // URL at all (a mapper-written `//host/path` line, confirmed earlier,
    // fails there outright) -- but confirmed directly against a real client
    // that it only reliably follows `http://`, not `https://`, so a `.bzw`
    // file should write `http://` for a mapper-hosted texture from here on.
    // bzo's own browser clients would then hit mixed-content blocking
    // loading `http://` from an `https://` page (bz.rikers.org, most
    // notably), so this strips the scheme down to protocol-relative before
    // forwarding -- exactly the form a mapper-written `//host/path` line
    // already takes above, and each client already re-resolves against its
    // own page's protocol (`isExternalTextureUrlLoadable`, public/texture.js).
    return rawName.replace(/^https?:/i, '');
  } catch {
    return null;
  }
}

// Classifies one `addtexture`/`texture` argument -- a material's own, or a
// bare one straight on an obstacle -- into whichever of the two things bzo
// can do with it, or neither.
function resolveBzwTextureName(rawName) {
  const stock = resolveBzwStockTexture(rawName);
  if (stock) return { stock };
  const url = parseBzwTextureUrl(rawName);
  if (url) return { url };
  return null;
}

function parseBZWMap(filename, { quiet = false, extraMessages = [] } = {}) {
  // Diagnostic detail about this one file -- which refs, textures, or spins
  // it dropped -- worth an operator's attention for the live map and for one
  // just imported, but not for the hundred cached maps
  // `hashRemainingMapsInBackground` revisits on every restart purely to keep
  // the Map Viewer's hash list current. `quiet` is how a caller that is not
  // loading a map anyone is about to play says so -- it only silences the
  // console line; every warning is still collected into `warnedMessages`
  // below so a caller that DOES want them (a remote import writing them back
  // as `-srvmsg` lines, see `performRemoteMapImport`) always can, regardless
  // of `quiet`.
  //
  // `warnedMessages` is the one list, for the one reason -- every one of
  // these is "here is a thing bzo does not do", console and player alike:
  // `warn` both logs it (unless `quiet`) and collects it, and `messages`
  // below is built directly from this same list rather than each caller
  // re-wording the same fact a second time for a chat line.
  const warnedMessages = [];
  const warn = (message) => { warnedMessages.push(message); if (!quiet) log(message); };
  // `extraMessages` -- a fact only knowable outside this function's own text
  // parsing (a remote import's own wire-protocol decode -- `performRemote
  // MapImportNow`) fed through the exact same `warn`, so it is logged,
  // collected, and (once baked back into the file as its own `-srvmsg` line)
  // shown to a player the same way as everything this function detects on
  // its own.
  extraMessages.forEach(warn);
  // The map's own name is all a warning needs to say -- `filename` itself is
  // always this same process's own absolute `maps/` path, which only repeats
  // noise a reader already knows on every line.
  const mapLabel = path.basename(filename);
  const text = fs.readFileSync(filename, 'utf8');
  const lines = text.split(/\r?\n/);
  const teamMode = parseBZWTeamMode(lines);
  const serverOptions = parseBZWServerOptions(lines);
  const obstacles = [];
  const teleporters = [];
  const parsedLinks = [];
  const zones = [];
  // A `mesh` block's own vertex/normal/texcoord pools and face list, parsed
  // in full (CustomMesh.cxx, CustomMeshFace.cxx) and merged into `obstacles`
  // below (see the merge just above the dropped-feature tally) -- a mesh
  // renders, collides (tank and shot alike, oriented tank box included),
  // shows on radar and gets a debug label the same as a box or a pyramid
  // now, so it counts as a supported obstacle rather than a dropped one.
  // What is still missing is in `docs/bzw-plan.md`'s "Mesh geometry": mainly
  // the `meshbox`/`meshpyr`/`arc`/`cone`/`sphere`/`tetra` generators, which
  // still fall through to the generic dropped-token tally below like any
  // other unhandled keyword.
  const meshes = [];
  // The map's `world size` directive, applied to `GAME_CONFIG.MAP_SIZE` only
  // at the call site that loads the live map -- never inside this function,
  // which the background map-hashing trickle (see `MAP_REGISTRY`) also calls
  // for every other map on the server. Mutating the shared config here would
  // let whichever map that trickle parses last silently resize the live
  // match for every later connection.
  let mapSize = null;
  // `flagHeight`, `noWalls` and `freeCtfSpawns` on the `world` block --
  // CustomWorld.cxx:41-49. `mapFlagHeight` is applied at the live-map call
  // site the same way `mapSize` is, since `GAME_CONFIG.FLAG_HEIGHT` is shared
  // state the background map-hashing trickle must not touch. `noWalls` and
  // `freeCtfSpawns` ride along in this function's own return value instead --
  // one because the client needs it in the map's own JSON (see `noWalls` in
  // `registerMapFile`), the other because it only ever matters to
  // `getSpawnPosition`, which already reads `mapServerOptions`.
  let mapFlagHeight = null;
  let mapNoWalls = false;
  let mapFreeCtfSpawns = false;
  // `waterLevel` / `end` (`CustomWaterLevel.cxx`) -- a map-wide singleton
  // like `noWalls`, not an obstacle, so it fills in one variable on `end`
  // rather than collecting into a registry a `matref` looks up later.
  // Carried out through this function's own return value the same way
  // `noWalls` is, for the same two reasons: the client needs it to draw the
  // plane, and `validateMovement` needs it for the kill-on-touch rule.
  let mapWaterLevel = null;
  let currentWaterLevel = null;
  let current = null;
  let currentLink = null;
  let currentZone = null;
  // The one `face` / `endface` block currently open inside a `mesh` --
  // a second scope nested inside `current` (still the mesh itself), since a
  // face's own properties start from the mesh's defaults at the moment
  // `face` was read (`CustomMeshFace`'s constructor snapshot) and nothing
  // else parsed here has that shape.
  let currentMeshFace = null;
  // The `drawInfo { ... }` block a mesh may carry -- upstream's
  // `MeshDrawInfo`, the render-optimized copy of the same surface, and the
  // only place upstream reads `angvel` from. Non-null exactly while one is
  // open; `depth` walks its own nested `lod`/`matref` blocks so their `end`
  // lines close them rather than the mesh around them, which is what used to
  // cut a mesh short at the first one.
  let currentDrawInfo = null;
  // `define <name>` / `enddef`. Everything closed while this is set collects
  // into its obstacle list instead of `obstacles`, keyed by name so any number
  // of `group` instances can place transformed copies of it later.
  let currentDefine = null;
  const defineTemplates = new Map();
  // A `group <name>` instance is recorded here rather than expanded in place --
  // `group` may reference a `define` the file states later, the same deferred
  // resolution upstream gives it -- and expanded once the whole file is read.
  const groupInstanceRequests = [];
  const unknownGroupDefs = new Set();
  // A definition that names itself again while still being placed, directly
  // or through others -- `GroupDefinition::makeGroups`'s own `active` guard,
  // logged the same way upstream does ("avoided recursion") rather than
  // hanging or overflowing the stack. Ordinary, non-cyclic nesting recurses
  // freely; this is only ever a cycle.
  const groupCycleWarnings = new Set();
  // A `spin <deg> <ax> <ay> <az>` line whose axis isn't the map's own
  // vertical -- tips the shape off bzo's axis-aligned box/pyramid model the
  // same way `shear` always does, so it is counted here and named once
  // rather than applied wrong. A spin about the vertical is read like
  // `rotation` (see the `spin` branch below); this is only the rest of it.
  let nonVerticalSpinCount = 0;
  // Which zone keywords a map asked for that bzo does not act on, gathered so
  // the load can say so once rather than for every zone. `zone` blocks are
  // otherwise the one place a map states something invisible: a spawn zone that
  // is skipped moves every tank in the world.
  const unreadZoneKeywords = new Set();
  // A world weapon occupies nothing, so it is not an obstacle.
  const weapons = [];
  let currentWeapon = null;
  const unreadWeaponKeywords = new Set();
  const unreadWeaponTypes = new Set();
  // `material` / `end` (CustomMaterial.cxx, ParseMaterial.cxx). A material is
  // not an obstacle either -- it is a named bundle of a texture and a tint
  // that a `matref` line looks up later, so it collects into its own registry
  // the same way a zone or a weapon does. Keyed case-insensitively, the way
  // upstream's own MaterialManager looks a name up.
  let currentMaterial = null;
  const materialsByName = new Map();
  // Every material in file order, so `findMaterial`'s own digit-first branch
  // (`BzMaterial.cxx:79-86`, upstream) can resolve a numeric `matref` as an
  // index into this list -- how a `material` block with no `name` line at
  // all is still reachable, a common map-editor export style
  // (`import-bz4.rikers.org_5154.bzw`'s 18 materials, 17 of them unnamed and
  // referenced as `matref 0` through `matref 17`).
  // See the `end` handler below for why this is plain file order rather than
  // upstream's own dedup-on-add.
  const materialRegistry = [];
  // A `matref` naming a material this file never defined.
  const unresolvedMaterialRefs = new Set();
  // `physics` / `end` (`CustomPhysicsDriver.cxx`, `PhysicsDriver.cxx`). A
  // physics driver is not an obstacle either -- it is a named velocity (and,
  // separately, a named instant-kill message) a `phydrv` line looks up
  // later, collected the same way a material is. `findDriver`'s own
  // digit-first branch (`PhysicsDriver.cxx:78-89`) is the exact same
  // convention `BzMaterial::findMaterial` uses for `matref`, so this keeps
  // the same file-order registry plus case-insensitive name map.
  let currentPhysicsDriver = null;
  const physicsDriversByName = new Map();
  const physicsDriverRegistry = [];
  // A `phydrv` naming a driver this file never defined.
  const unresolvedPhysicsDriverRefs = new Set();
  // `angular`/`radial`/`slide` lines inside a `physics` block -- read as far
  // as recognizing the keyword so it never falls through as a stray unknown
  // token, but not applied to motion: no real map sampled uses any of the
  // three (`docs/bzw-plan.md`, "Physics drivers"), and upstream's own
  // `radial` has no consumer anywhere in its renderer either. Counted the
  // same way `unsupportedCounts` tracks any other partially-read block.
  const unreadPhysicsDriverKeywords = new Set();
  // `dynamicColor` / `end` (`CustomDynamicColor.cxx`, `DynamicColor.cxx`). A
  // named, time-varying RGBA a `material`'s own `dyncol <name>` line pulls
  // in -- collected the same way a material or a physics driver is, with the
  // same digit-first-then-name resolution (`DynamicColor.cxx:80-101`).
  let currentDynamicColor = null;
  const dynamicColorsByName = new Map();
  const dynamicColorRegistry = [];
  // A `dyncol` naming a dynamic color this file never defined.
  const unresolvedDynamicColorRefs = new Set();
  // `textureMatrix` / `end` (`CustomTextureMatrix.cxx`, `TextureMatrix.cxx`).
  // A named, time-varying UV transform a `material`'s own `texmat <name>`
  // line pulls in -- collected and resolved the same way.
  let currentTextureMatrix = null;
  const textureMatricesByName = new Map();
  const textureMatrixRegistry = [];
  // A `texmat` naming a texture matrix this file never defined.
  const unresolvedTextureMatrixRefs = new Set();
  // A texture name (on a `material` or straight on an obstacle) bzo has no
  // local asset for -- see `resolveBzwStockTexture` -- named on load rather
  // than silently kept at the obstacle's plain default.
  const unresolvedTextureNames = new Set();
  // An absolute `http`/`https` texture URL a map names -- forwarded to the
  // client as-is (see `resolveBzwTextureName`) rather than resolved here:
  // the server never fetches one, and whether it actually loads is each
  // client's own decision (`isExternalTextureUrlLoadable` in
  // `public/texture.js` -- every host is attempted, so this is a CORS/
  // load-failure outcome, not a host it refused to try). Named on load so
  // it is visible that a map asked for one at all.
  const externalTextureUrls = new Set();
  // How many of each UNSUPPORTED_TOP_LEVEL_KEYWORDS block this map asked for,
  // by keyword -- what turns into the player-facing chat message below and
  // (with `serverOptions.serverMessages`, i.e. -srvmsg) this function's
  // `messages` return value.
  const unsupportedCounts = new Map();
  // Keywords no branch of the parser recognises, by keyword. Separate from
  // `unsupportedCounts` above, which counts whole blocks bzo deliberately
  // declines: these are words nobody has taught it, and the difference
  // matters to whoever reads the warning.
  const unreadKeywordCounts = new Map();

  function getTeleporterEndpointName(teleporter, face) {
    return `${teleporter.linkName}:${face === 0 ? 'f' : 'b'}`;
  }

  // CustomGate's constructor, for a teleporter that gave no size or border of
  // its own: half width 0.5 * _teleportWidth, half breadth _teleportBreadth,
  // height 2 * _teleportHeight, and a border twice the half width. Filled in
  // here rather than left to each reader, because a dimension left undefined
  // is not a small teleporter -- it is NaN, and testOrigRectRect answers
  // "overlapping" for a NaN half extent, since every comparison against NaN
  // is false and the corner is classified into the obstacle. One sizeless
  // obstacle then supports a tank anywhere in the world.
  //
  // Applied once, at parse time, whether the teleporter is a plain top-level
  // one or a `define` template member -- upstream resolves a `CustomGate`'s
  // dimensions the same way regardless, before any group instance ever
  // copies or transforms it (`ObstacleMgr.cxx`'s `copyWithTransform`).
  function applyTeleporterDefaults(teleporter) {
    if (!Number.isFinite(teleporter.w)) teleporter.w = BZW_TELEPORTER_DEFAULTS.w;
    if (!Number.isFinite(teleporter.d)) teleporter.d = BZW_TELEPORTER_DEFAULTS.d;
    if (!Number.isFinite(teleporter.h)) teleporter.h = BZW_TELEPORTER_DEFAULTS.h;
    if (!Number.isFinite(teleporter.border)) teleporter.border = BZW_TELEPORTER_DEFAULTS.border;
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
    const statedBorder = Math.max(0.12, teleporter.border);
    const statedHalfWidth = Math.max(0.25, teleporter.w / 2);
    const statedHalfBreadth = Math.max(0.25, teleporter.d / 2);
    const statedHeight = Math.max(1.0, teleporter.h);
    teleporter.border = statedBorder;
    // Upstream takes the larger of the border half-width and the stated
    // width for the x extent, which is its own line in finalize().
    teleporter.w = Math.max(statedBorder * 0.5, statedHalfWidth) * 2;
    teleporter.d = (statedHalfBreadth + (statedBorder * 2)) * 2;
    teleporter.h = statedHeight + statedBorder;
  }

  // Gives a teleporter its place in the world's flat teleporter list -- a
  // sequential face index and an entry `buildTeleporterLinks` can match a
  // `link` block's endpoint name against. Called once per *real* placement,
  // whether that is an ordinary top-level teleporter or one a `group`
  // instance places from a `define` -- never for a template member still
  // sitting in `defineTemplates`, which is not a placement yet.
  function registerTeleporter(teleporter) {
    const teleporterIndex = teleporters.length;
    const linkName = teleporter.name || `teleporter_${teleporterIndex}`;
    teleporter.teleporterIndex = teleporterIndex;
    teleporter.linkName = linkName;
    teleporters.push({
      teleporterIndex,
      linkName,
      obstacle: teleporter,
    });
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
        warn(`Ignoring broken teleporter link from "${link.from?.value || ''}" to "${link.to?.value || ''}" in ${mapLabel}`);
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

  // The one texture/tint/flag bundle a `material` block, a mesh's own
  // defaults, and a mesh face's own overrides all read the same way --
  // `matref`/`color`/`diffuse`/`addtexture`/`texture`/`notextures`/
  // `noradar`/`nolighting` -- each setting `target`'s own texture/
  // textureUrl/color/noRadar/noLighting fields in the same read-order-wins
  // sequence every caller already gives its own block. Returns whether
  // `token` was one of these, so a caller falls through to whatever else
  // its own block reads for anything this returns false for.
  function applyBzwMaterialToken(target, token, words) {
    if (token === 'matref') {
      const rawRef = words[1] || '';
      // `findMaterial`'s own check (`BzMaterial.cxx:79`) looks at the
      // target's first character alone, before it ever tries a name match --
      // so a `matref` that starts with a digit is always an index, never a
      // name, matching upstream exactly rather than only as a fallback.
      let referenced;
      if (/^[0-9]/.test(rawRef)) {
        const index = parseInt(rawRef, 10);
        referenced = materialRegistry[index] || null;
      } else {
        referenced = materialsByName.get(rawRef.toLowerCase()) || null;
      }
      // `-1` is upstream's own spelling of "no material", not a name it
      // failed to find: every caller suppresses its own warning for exactly
      // that string (`CustomGroup.cxx:87`, `ObstacleModifier`, and the
      // `phydrv`/`texmat` readers beside them), so it is left unreported
      // here too rather than named on load as a map's mistake.
      if (referenced) {
        target.texture = referenced.texture;
        target.textureUrl = referenced.textureUrl;
        target.color = referenced.color;
        target.noRadar = referenced.noRadar;
        target.noLighting = referenced.noLighting;
        target.noShadow = referenced.noShadow;
        target.dynamicColor = referenced.dynamicColor;
        target.textureMatrix = referenced.textureMatrix;
        target.specular = referenced.specular;
        target.emission = referenced.emission;
        target.shininess = referenced.shininess;
        target.alphaThreshold = referenced.alphaThreshold;
        target.noCulling = referenced.noCulling;
        target.noSorting = referenced.noSorting;
        target.useTextureAlpha = referenced.useTextureAlpha;
        target.useColorOnTexture = referenced.useColorOnTexture;
      } else if (rawRef && rawRef !== '-1') {
        unresolvedMaterialRefs.add(rawRef.toLowerCase());
      }
      return true;
    }
    if (token === 'dyncol') {
      // `BzMaterial::setDynamicColor` -- replaces the whole material's own
      // diffuse with the named `dynamicColor`'s live RGBA (resolved fully
      // below, not just a name) rather than tinting it, matching
      // `MeshSceneNode.cxx:487-491`'s `mat->colorPtr = dyncol->getColor()`.
      const rawRef = words[1] || '';
      const referenced = /^[0-9]/.test(rawRef)
        ? dynamicColorRegistry[parseInt(rawRef, 10)] || null
        : dynamicColorsByName.get(rawRef.toLowerCase()) || null;
      if (referenced) {
        target.dynamicColor = referenced;
      } else if (rawRef && rawRef !== '-1') {
        unresolvedDynamicColorRefs.add(rawRef.toLowerCase());
      }
      return true;
    }
    if (token === 'texmat') {
      // `BzMaterial::setTextureMatrix` -- a UV transform applied in the
      // texture-coordinate stage (`OpenGLGState.cxx:536-544`), independent of
      // whatever baked tiling the geometry itself already carries. Upstream
      // attaches it to whichever texture slot was added most recently
      // (`textures[textureCount - 1].matrix = matrix`, `BzMaterial.cxx:
      // 850-855`) and silently does nothing if no texture has been added yet
      // -- real for a fresh `material` block (`textureCount` starts at 0
      // there, confirmed against `import-Planet-MoFo.com_4202.bzw`'s own
      // `addtexture`-then-`texmat` convention, "Animated materials" in
      // docs/bzw.md) but genuinely unclear for an inline box/mesh-face
      // property with no `material` block at all, where the obstacle's own
      // constructor may pre-seed a stock texture first. Not replicated here
      // pending that answer -- bzo stays order-independent for `texmat`
      // rather than risk dropping a reference upstream would actually keep.
      const rawRef = words[1] || '';
      const referenced = /^[0-9]/.test(rawRef)
        ? textureMatrixRegistry[parseInt(rawRef, 10)] || null
        : textureMatricesByName.get(rawRef.toLowerCase()) || null;
      if (referenced) {
        target.textureMatrix = referenced;
      } else if (rawRef && rawRef !== '-1') {
        unresolvedTextureMatrixRefs.add(rawRef.toLowerCase());
      }
      return true;
    }
    if (token === 'color' || token === 'diffuse') {
      const tint = parseBzwColor(words.slice(1));
      if (tint) target.color = tint;
      return true;
    }
    if (token === 'addtexture' || token === 'texture') {
      // Upstream keeps every texture a material names, in order --
      // `BzMaterial::addTexture` (`BzMaterial.cxx:812-822`) always appends a
      // new slot, while `texture`'s `setTexture` (`:833-838`) replaces the
      // *last* one instead (or creates the first, if the list is still
      // empty). But every renderer that draws a material -- `OpenGLUtils.cxx`,
      // `MeshSceneNode.cxx`, `MeshSceneNodeGenerator.cxx`,
      // `BackgroundRenderer.cxx` -- reads only slot 0
      // (`getTextureLocal(0)`/`getUseColorOnTexture(0)`/`getTextureMatrix(0)`),
      // with no exception anywhere in the tree. A stacked second or third
      // `addtexture` is therefore inert in real play: only the first texture
      // a material names is ever drawn. bzo has no multi-texture model, so an
      // `addtexture` once a texture is already set is the same no-op it is
      // upstream, and only a `texture` line (or the first `addtexture`,
      // `notextures` having cleared the slot) actually changes what shows.
      if (token === 'addtexture' && (target.texture || target.textureUrl)) {
        return true;
      }
      const rawName = words.slice(1).join(' ');
      const resolved = resolveBzwTextureName(rawName);
      if (resolved?.stock) {
        target.texture = resolved.stock;
        target.textureUrl = null;
      } else if (resolved?.url) {
        target.textureUrl = resolved.url;
        target.texture = null;
        externalTextureUrls.add(resolved.url);
      } else if (rawName) {
        unresolvedTextureNames.add(rawName);
      }
      return true;
    }
    if (token === 'notextures') {
      target.texture = null;
      target.textureUrl = null;
      return true;
    }
    if (token === 'noradar') {
      target.noRadar = true;
      return true;
    }
    if (token === 'nolighting') {
      target.noLighting = true;
      return true;
    }
    if (token === 'noshadow') {
      target.noShadow = true;
      return true;
    }
    if (token === 'alphathresh') {
      // `BzMaterial::reset` defaults this to 0, and upstream reads 0 as "no
      // alpha test at all" rather than as a threshold of zero
      // (`MeshSceneNode.cxx:525`: `if (alphaThreshold != 0.0f)`). Kept the
      // same way here so a map that states 0 explicitly means what upstream
      // means by it, and `render.js` can tell "stated" from "not stated".
      const value = Number(words[1]);
      target.alphaThreshold = Number.isFinite(value) ? value : 0;
      return true;
    }
    if (token === 'noculling') {
      // `BzMaterial::setNoCulling`. Kept, but it reaches the renderer down
      // one path only, which is upstream's rule rather than a bzo limit.
      //
      // A plain `mesh` face draws through `MeshPolySceneNode`, and both it
      // (`MeshPolySceneNode.cxx:255-261`) and its base `WallSceneNode::cull`
      // (`:87-95`) open with "cull if eye is behind (or on) plane" and return
      // true -- the node never reaches a render list, so the
      // `disableCulling()` this sets (`WallSceneNode.cxx:371-372`) never
      // runs. A box's or a pyramid's quad faces go the same way. A map
      // wanting a two-sided surface writes the face twice with reversed
      // winding, which is what real maps do and what `maps/bzo.bzw`'s own
      // billboards do.
      //
      // The exception is a mesh drawn from its own `drawInfo` block, where
      // `MeshSceneNode::cull` (`:287-300`) is bounding-box alone with no
      // plane test at all and the flag really does show the far side. bzo
      // carries it onto those faces and nowhere else -- see
      // `buildMeshDrawFaces`.
      target.noCulling = true;
      return true;
    }
    if (token === 'nosorting') {
      // `BzMaterial::setNoSorting` -- keeps a translucent material out of
      // upstream's own back-to-front ordered pass (`MeshSceneNode.cxx:520`),
      // which is the one pass `SceneRenderer::doRender` draws under
      // `glDepthMask(GL_FALSE)`. What that means for a single-list renderer
      // like bzo's is exactly the depth mask: a `nosorting` face goes on
      // writing depth even once its texture or its tint turns it
      // transparent. See `applyTextureAlpha` in `render.js`.
      target.noSorting = true;
      return true;
    }
    if (token === 'notexalpha') {
      // `BzMaterial::setUseTextureAlpha(false)` -- upstream looks at a
      // texture's own alpha channel only while this is set
      // (`MeshSceneNode.cxx:429-433`, `MeshSceneNodeGenerator.cxx:471-477`,
      // both feeding `setBlending` alone), so a picture that happens to
      // carry alpha draws fully opaque instead of blending. It says nothing
      // about the alpha *test*: `alphathresh` reaches `GL_GEQUAL` whatever
      // this flag said (`WallSceneNode.cxx:369-370`), so a material stating
      // both still cuts its transparent pixels away. See `render.js`.
      target.useTextureAlpha = false;
      return true;
    }
    if (token === 'notexcolor') {
      // `BzMaterial::setUseColorOnTexture(false)` -- upstream stops
      // modulating the texture by the material's own diffuse and uses plain
      // white in its place (`MeshSceneNode.cxx:428`, `:470-481`), which is
      // what a mapper wants where a material's tint exists for the
      // untextured fallback rather than for the picture. Only ever reached
      // with a texture actually on the material, upstream and here alike.
      target.useColorOnTexture = false;
      return true;
    }
    if (token === 'shader' || token === 'addshader' || token === 'noshaders') {
      // `BzMaterial` parses and stores a material's shader list, and nothing
      // anywhere upstream ever reads it back -- `getShader`/`getShaderCount`
      // have no caller outside `BzMaterial` itself. Read and dropped, the
      // same as `ambient` below.
      return true;
    }
    if (token === 'groupalpha') {
      // `BzMaterial::setGroupAlpha`. Its only reader anywhere upstream
      // (`MeshSceneNodeGenerator.cxx:213-215`) decides whether a translucent
      // face gets a scene node of its own -- sorted against the world
      // individually -- or is collated into one node with the faces sharing
      // its material; `MeshSceneNode.cxx:517-519` states outright that it
      // does not use the flag, because everything there is grouped already.
      // bzo builds one merged geometry group per material and draws the
      // whole mesh as a single object, which *is* the collated case, so a
      // map stating this asks for what bzo does regardless. Read and
      // dropped, the same as `ambient` below -- not a parity gap to report.
      return true;
    }
    if (token === 'specular' || token === 'emission' || token === 'shininess') {
      // `BzMaterial::reset` defaults for a component this line leaves
      // unstated: specular/emission `0 0 0 1`, shininess `0`. These are the
      // three of `BzMaterial`'s four lighting coefficients that reach real
      // GL state upstream (`OpenGLMaterial`, fed from
      // `MeshSceneNode.cxx:463-465`), which is why `render.js` mirrors them
      // with `MeshPhongMaterial`'s `specular`/`shininess`/`emissive` --
      // see `hasRealSpecular` there.
      const defaults = token === 'shininess' ? [0] : [0, 0, 0, 1];
      const values = words.slice(1).map(Number);
      const resolved = defaults.map((def, i) => (Number.isFinite(values[i]) ? values[i] : def));
      target[token] = token === 'shininess' ? resolved[0] : resolved;
      return true;
    }
    if (token === 'ambient') {
      // `BzMaterial::reset`'s own default (`0.2 0.2 0.2 1`) is exactly
      // OpenGL's compiled-in material ambient, and nothing upstream ever
      // calls `glMaterial(..., GL_AMBIENT, ...)` anywhere in its tree --
      // confirmed by grep across the whole source. A mapper's own `ambient`
      // line is therefore just as inert in a real bzflag client as it would
      // be here, matching `BzMaterial.cxx:652`'s own comment on the field:
      // "not really used". Read and dropped like any other property this
      // parser recognizes but does not act on -- not a bzo gap to report.
      return true;
    }
    return false;
  }

  // The `options` block and the `world` block are each read by a pass of their
  // own -- the map options parser, and the lookahead in the `world` branch
  // below -- and this loop walks their lines again on the way past. Naming the
  // block being skipped keeps a keyword another pass already read out of the
  // unread tally, where it would otherwise look like a gap that is not there.
  let consumedBlock = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    // Every keyword upstream reads it reads with strcasecmp, and it reads the
    // first whitespace-delimited token rather than a prefix of the line -- so
    // `Position` is a position and `basey` is not a base.
    const token = line.split(/\s+/)[0].toLowerCase();

    // A `drawInfo { ... }` block owns every line until its own `end`.
    // Upstream reads it by consuming the stream outright
    // (`MeshDrawInfo::parse`), and bzo has to claim it just as early: half
    // its vocabulary is shared with the top level, and a `sphere` bounding
    // hint inside a draw set would otherwise open a sphere obstacle in the
    // middle of a mesh and throw the mesh away with it
    // (`ahs3_Paradise_Valley.bzw`, whose largest mesh vanished exactly that
    // way). Opened from the mesh branch below, which is the only place one
    // can appear.
    if (currentDrawInfo) {
      readMeshDrawInfoLine(current, currentDrawInfo, token, line.split(/\s+/));
      if (currentDrawInfo.closed) currentDrawInfo = null;
      continue;
    }

    if (currentLink && token === 'end') {
      if (currentLink.from && currentLink.to) {
        parsedLinks.push(currentLink);
      } else {
        warn(`Ignoring incomplete link block in ${mapLabel}`);
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
        // A type with no `FLAG_TYPES` row matched nothing above, so it is
        // recorded here for the load to name. That is `WA`, which bzo does not
        // carry and will not (see docs/flags.md), or a typo in the map.
        if (wantedQuality === null && !getFlagType(wanted)) {
          currentZone.unknownFlags.add(wanted);
        }
        continue;
      }
      // team <n> [n ...]. CustomZone::read's spawn-area qualifier: n is a
      // BZFlag team index, 0 rogue and 1-4 red/green/blue/purple, and a zone
      // may list more than one either on one line or across repeats -- upstream
      // accumulates both ways, since each is just another qualifier pushed onto
      // the same zone.
      if (token === 'team') {
        const [, ...rest] = line.split(/\s+/);
        for (const raw of rest) {
          const teamIndex = parseInt(raw, 10);
          if (Number.isInteger(teamIndex) && teamIndex >= 0 && teamIndex <= 4) {
            currentZone.teams.add(teamIndex);
          }
        }
        continue;
      }
      // `safety <n> [n ...]` -- CustomZone.cxx:184-206, the same accumulation
      // as `team` above (upstream reads them in one shared branch), but a
      // landing spot for a *dropped team flag*, not a spawn qualifier: see
      // `getSafetyZonePosition`, used from `dropFlag`.
      if (token === 'safety') {
        const [, ...rest] = line.split(/\s+/);
        for (const raw of rest) {
          const teamIndex = parseInt(raw, 10);
          if (Number.isInteger(teamIndex) && teamIndex >= 0 && teamIndex <= 4) {
            currentZone.safety.add(teamIndex);
          }
        }
        continue;
      }
      // `flag` is the rest of CustomZone::read: a zone that any flag of a
      // named type spawns in. Not read yet.
      if (token === 'flag') {
        unreadZoneKeywords.add(token);
        continue;
      }
      continue;
    }

    // CustomWeapon (CustomWeapon.cxx). A world weapon is not an obstacle -- it
    // occupies nothing and is drawn as nothing -- so it collects in its own list
    // rather than in `obstacles`, and `end` closes it the way a zone's does.
    if (!current && !currentLink && !currentZone && token === 'weapon') {
      currentWeapon = {
        x: 0,
        y: 0,
        z: 0,
        rotation: 0,
        tilt: 0,
        type: null,
        initDelay: WORLD_WEAPON_DEFAULT_DELAY,
        delays: [],
      };
      continue;
    }
    if (currentWeapon) {
      if (token === 'end') {
        // A weapon with no readable type fires upstream's Null flag, which is an
        // ordinary shell -- `Flags::Null` is CustomWeapon's own default.
        currentWeapon.delays = normalizeWorldWeaponDelays(currentWeapon.delays);
        weapons.push(currentWeapon);
        currentWeapon = null;
        continue;
      }
      if (token === 'position' || token === 'pos') {
        const [, x, y, z] = line.split(/\s+/);
        currentWeapon.x = parseFloat(x) || 0;
        // BZFlag +Y north maps to bzo -Z north, as it does for an obstacle.
        currentWeapon.z = -(parseFloat(y) || 0);
        currentWeapon.y = parseFloat(z) || 0;
        continue;
      }
      if (token === 'rotation' || token === 'rot') {
        const [, deg] = line.split(/\s+/);
        currentWeapon.rotation = (parseFloat(deg) || 0) * Math.PI / 180;
        continue;
      }
      if (token === 'tilt') {
        const [, deg] = line.split(/\s+/);
        currentWeapon.tilt = (parseFloat(deg) || 0) * Math.PI / 180;
        continue;
      }
      if (token === 'type') {
        const [, abbreviation] = line.split(/\s+/);
        const wanted = (abbreviation || '').trim().toUpperCase();
        // Flag::getDescFromAbbreviation, which leaves the type Null when it does
        // not recognise the name. `WA` reaches here as any other unknown does.
        if (getFlagType(wanted) && !isTeamFlag(wanted)) currentWeapon.type = wanted;
        else if (wanted) unreadWeaponTypes.add(wanted);
        continue;
      }
      if (token === 'initdelay') {
        const [, seconds] = line.split(/\s+/);
        const value = Number(seconds);
        if (Number.isFinite(value)) currentWeapon.initDelay = Math.max(0, value);
        continue;
      }
      if (token === 'delay') {
        // A list, which upstream cycles a shot at a time.
        const [, ...values] = line.split(/\s+/);
        currentWeapon.delays = values;
        continue;
      }
      // `trigger` and `eventteam` make an event-fired weapon rather than a timed
      // one (CustomWeapon.cxx:100). bzo has no event hooks to hang one on, so a
      // map using them is named on load rather than quietly firing on a timer it
      // never asked for.
      if (token === 'trigger' || token === 'eventteam') {
        unreadWeaponKeywords.add(token);
        continue;
      }
      continue;
    }

    // `material` / `end`. Registered by name for `matref` to look up, the way
    // upstream's `CustomMaterial::writeToManager` adds it to the
    // `MaterialManager` for later `matref` lookups to find.
    //
    // A `define` does not scope this, and the same goes for the `physics`,
    // `dynamicColor` and `textureMatrix` blocks below. Upstream's
    // `parseNormalObject` (`BZWReader.cxx:139-184`) builds the object before
    // the reader's own `define`/`enddef` branches ever run and without
    // consulting the group definition, and on `end` the block takes the
    // `usesManager()` path (`:250-253`) into one global registry rather than
    // the `usesGroupDef()` path an obstacle takes. So a material written
    // inside a definition is visible to every `matref` in the file, exactly
    // as if it had been written at the top level -- real maps rely on it
    // (`tricolor.bzw` states seven that way).
    if (!current && !currentLink && !currentZone && !currentWeapon
      && !currentMaterial && !currentPhysicsDriver && !currentDynamicColor && !currentTextureMatrix
      && !currentWaterLevel
      && token === 'material') {
      currentMaterial = {
        name: null, texture: null, textureUrl: null, color: null, noRadar: false, noLighting: false,
        dynamicColor: null, textureMatrix: null,
        specular: null, emission: null, shininess: null, alphaThreshold: null,
        noSorting: false, useTextureAlpha: true, useColorOnTexture: true,
      };
      continue;
    }
    if (currentMaterial) {
      if (token === 'end') {
        // Upstream's own `MaterialManager` (`BzMaterialManager::addMaterial`)
        // reuses an existing entry instead of appending a second one for a
        // block whose properties already match one it already holds --
        // fully, on every field it parses, some of which (`ambient`, a full
        // multi-layer `addtexture` list, ...) bzo itself never keeps.
        // Approximating that dedup against only the fields bzo
        // *does* keep collapses distinct upstream entries whose difference
        // lives entirely in a dropped field -- checked directly against
        // `import-bz4.rikers.org_5154.bzw`'s own 18 materials, where two
        // pairs share their final `addtexture` layer once bzo has already
        // discarded the layer before it (no multi-texture model -- see
        // "Materials" in docs/bzw.md) but nothing else, and collapsing them
        // shifted every later index enough to break that map's own highest
        // `matref`s. Every material this file (or any other sampled) writes
        // is otherwise distinct, so appending unconditionally reproduces
        // upstream's real numbering exactly for real maps, at the cost of
        // drifting by one from wherever a map writes two blocks that
        // genuinely are identical on every field upstream tracks.
        materialRegistry.push(currentMaterial);
        if (currentMaterial.name) {
          materialsByName.set(currentMaterial.name.toLowerCase(), currentMaterial);
        }
        currentMaterial = null;
        continue;
      }
      if (token === 'name') {
        const [, ...nameParts] = line.split(/\s+/);
        const materialName = nameParts.join(' ').replace(/"/g, '').trim();
        if (materialName) currentMaterial.name = materialName;
        continue;
      }
      // `matref`/`color`/`diffuse`/`addtexture`/`texture`/`notextures`/
      // `noradar`/`nolighting`/`noshadow`/`dyncol`/`texmat` -- a material's
      // own `matref <name>` copies another already-defined material wholesale
      // (BzMaterial's plain struct assignment), which a property stated
      // after it then overrides, the same sequential-read semantics as
      // everything else in this block. `applyBzwMaterialToken` is the same
      // read a mesh's own defaults and a mesh face's own overrides use.
      if (applyBzwMaterialToken(currentMaterial, token, line.split(/\s+/))) {
        continue;
      }
      // Everything else a material block can say -- ambient and groupAlpha
      // (both read and dropped; see `applyBzwMaterialToken` above),
      // shader/addshader/noshaders, occluder, spheremap, resetmat -- is
      // dropped, and counted on the way out. A material keyword bzo does not read changes
      // what a map looks like, so the map should say which ones it wanted
      // rather than leaving it to be discovered by surveying the tree.
      unreadKeywordCounts.set(token, (unreadKeywordCounts.get(token) || 0) + 1);
      continue;
    }

    // `physics` / `end` (`CustomPhysicsDriver.cxx`). Registered by name (or
    // left to resolve by file-order index, the same as a `material` with no
    // `name`) for `phydrv` to look up later.
    if (!current && !currentLink && !currentZone && !currentWeapon
      && !currentMaterial && !currentPhysicsDriver && !currentDynamicColor && !currentTextureMatrix
      && !currentWaterLevel
      && token === 'physics') {
      currentPhysicsDriver = { name: null, linear: null, death: null };
      continue;
    }
    if (currentPhysicsDriver) {
      if (token === 'end') {
        physicsDriverRegistry.push(currentPhysicsDriver);
        if (currentPhysicsDriver.name) {
          physicsDriversByName.set(currentPhysicsDriver.name.toLowerCase(), currentPhysicsDriver);
        }
        currentPhysicsDriver = null;
        continue;
      }
      if (token === 'name') {
        const [, ...nameParts] = line.split(/\s+/);
        const driverName = nameParts.join(' ').replace(/"/g, '').trim();
        if (driverName) currentPhysicsDriver.name = driverName;
        continue;
      }
      if (token === 'linear') {
        // BZFlag (x, y, z) -> bzo (x, y=vertical, z=-y): the same remap
        // `position`/`shift` already apply, since a velocity and a
        // displacement share the same axis convention.
        const [, vx, vy, vz] = line.split(/\s+/).map(Number);
        currentPhysicsDriver.linear = [
          Number.isFinite(vx) ? vx : 0,
          Number.isFinite(vz) ? vz : 0,
          Number.isFinite(vy) ? -vy : 0,
        ];
        continue;
      }
      if (token === 'death') {
        // `CustomPhysicsDriver.cxx` reads the rest of the line verbatim as
        // the message shown to whoever dies on this surface.
        const [, ...rest] = line.split(/\s+/);
        currentPhysicsDriver.death = rest.join(' ').trim() || null;
        continue;
      }
      if (token === 'angular' || token === 'radial' || token === 'slide') {
        unreadPhysicsDriverKeywords.add(token);
        continue;
      }
      continue;
    }

    // `dynamicColor` / `end` (`CustomDynamicColor.cxx`, `DynamicColor.cxx`).
    // A named, time-varying RGBA -- registered by name (or file-order index)
    // for a `material`'s own `dyncol` to look up later, the same as a
    // `physics` block is for `phydrv`.
    if (!current && !currentLink && !currentZone && !currentWeapon
      && !currentMaterial && !currentPhysicsDriver && !currentDynamicColor && !currentTextureMatrix
      && !currentWaterLevel
      && token === 'dynamiccolor') {
      currentDynamicColor = {
        name: null,
        channels: {
          red: { min: 0, max: 1, sinusoids: [], clampUps: [], clampDowns: [], sequence: null },
          green: { min: 0, max: 1, sinusoids: [], clampUps: [], clampDowns: [], sequence: null },
          blue: { min: 0, max: 1, sinusoids: [], clampUps: [], clampDowns: [], sequence: null },
          alpha: { min: 0, max: 1, sinusoids: [], clampUps: [], clampDowns: [], sequence: null },
        },
      };
      continue;
    }
    if (currentDynamicColor) {
      if (token === 'end') {
        dynamicColorRegistry.push(currentDynamicColor);
        if (currentDynamicColor.name) {
          dynamicColorsByName.set(currentDynamicColor.name.toLowerCase(), currentDynamicColor);
        }
        currentDynamicColor = null;
        continue;
      }
      if (token === 'name') {
        const [, ...nameParts] = line.split(/\s+/);
        const dcName = nameParts.join(' ').replace(/"/g, '').trim();
        if (dcName) currentDynamicColor.name = dcName;
        continue;
      }
      if (token === 'red' || token === 'green' || token === 'blue' || token === 'alpha') {
        // `DynamicColor::read` -- each channel line names its own sub-type
        // (`limits`, `sinusoid`, `clampup`/`clampdown`, `sequence`), any
        // number of times each; `update` (`public/render.js`) combines
        // every one of them each frame rather than the last stated winning.
        const [, sub, ...nums] = line.split(/\s+/);
        const values = nums.map(Number);
        const channel = currentDynamicColor.channels[token];
        const subtype = (sub || '').toLowerCase();
        if (subtype === 'limits') {
          const [min, max] = values;
          if (Number.isFinite(min)) channel.min = Math.max(0, Math.min(1, min));
          if (Number.isFinite(max)) channel.max = Math.max(0, Math.min(1, max));
        } else if (subtype === 'sinusoid') {
          const [period, offset, weight] = values;
          if (Number.isFinite(period) && period >= 0.01 && Number.isFinite(weight) && weight > 0) {
            channel.sinusoids.push({ period, offset: Number.isFinite(offset) ? offset : 0, weight });
          }
        } else if (subtype === 'clampup' || subtype === 'clampdown') {
          const [period, offset, width] = values;
          if (Number.isFinite(period) && period >= 0.01) {
            const list = subtype === 'clampup' ? channel.clampUps : channel.clampDowns;
            list.push({
              period,
              offset: Number.isFinite(offset) ? offset : 0,
              width: Number.isFinite(width) ? width : 0,
            });
          }
        } else if (subtype === 'sequence') {
          const [period, offset, ...states] = values;
          if (Number.isFinite(period) && period >= 0.01 && states.length > 0) {
            channel.sequence = {
              period,
              offset: Number.isFinite(offset) ? offset : 0,
              // `DynamicColor::finalize` clamps every raw state into
              // colorMin(0)/colorMid(1)/colorMax(2) -- a stray 3+ (or
              // negative) in the file reads as whichever end it is closer to
              // rather than an out-of-range index client-side.
              states: states.map((v) => Math.max(0, Math.min(2, Math.round(v)))),
            };
          }
        }
        continue;
      }
      continue;
    }

    // `textureMatrix` / `end` (`CustomTextureMatrix.cxx`, `TextureMatrix.cxx`).
    // A named, time-varying UV transform -- registered the same way, for a
    // `material`'s own `texmat` to look up.
    if (!current && !currentLink && !currentZone && !currentWeapon
      && !currentMaterial && !currentPhysicsDriver && !currentDynamicColor && !currentTextureMatrix
      && !currentWaterLevel
      && token === 'texturematrix') {
      currentTextureMatrix = {
        name: null,
        fixedShiftU: 0,
        fixedShiftV: 0,
        fixedScaleU: 1,
        fixedScaleV: 1,
        fixedSpin: 0,
        fixedCenterU: 0.5,
        fixedCenterV: 0.5,
        shiftU: 0,
        shiftV: 0,
        spin: 0,
        scaleUFreq: 0,
        scaleVFreq: 0,
        scaleU: 1,
        scaleV: 1,
        centerU: 0.5,
        centerV: 0.5,
      };
      continue;
    }
    if (currentTextureMatrix) {
      if (token === 'end') {
        textureMatrixRegistry.push(currentTextureMatrix);
        if (currentTextureMatrix.name) {
          textureMatricesByName.set(currentTextureMatrix.name.toLowerCase(), currentTextureMatrix);
        }
        currentTextureMatrix = null;
        continue;
      }
      if (token === 'name') {
        const [, ...nameParts] = line.split(/\s+/);
        const tmName = nameParts.join(' ').replace(/"/g, '').trim();
        if (tmName) currentTextureMatrix.name = tmName;
        continue;
      }
      if (token === 'fixedshift') {
        const [, u, v] = line.split(/\s+/).map(Number);
        if (Number.isFinite(u)) currentTextureMatrix.fixedShiftU = u;
        if (Number.isFinite(v)) currentTextureMatrix.fixedShiftV = v;
        continue;
      }
      if (token === 'fixedscale') {
        // `TextureMatrix::setFixedScale` -- 0 leaves the prior value (1)
        // alone rather than zeroing the scale out.
        const [, u, v] = line.split(/\s+/).map(Number);
        if (Number.isFinite(u) && u !== 0) currentTextureMatrix.fixedScaleU = u;
        if (Number.isFinite(v) && v !== 0) currentTextureMatrix.fixedScaleV = v;
        continue;
      }
      if (token === 'fixedspin') {
        const [, deg] = line.split(/\s+/).map(Number);
        if (Number.isFinite(deg)) currentTextureMatrix.fixedSpin = deg;
        continue;
      }
      if (token === 'fixedcenter') {
        const [, u, v] = line.split(/\s+/).map(Number);
        if (Number.isFinite(u)) currentTextureMatrix.fixedCenterU = u;
        if (Number.isFinite(v)) currentTextureMatrix.fixedCenterV = v;
        continue;
      }
      if (token === 'shift') {
        const [, uFreq, vFreq] = line.split(/\s+/).map(Number);
        if (Number.isFinite(uFreq)) currentTextureMatrix.shiftU = uFreq;
        if (Number.isFinite(vFreq)) currentTextureMatrix.shiftV = vFreq;
        continue;
      }
      if (token === 'spin') {
        const [, freq] = line.split(/\s+/).map(Number);
        if (Number.isFinite(freq)) currentTextureMatrix.spin = freq;
        continue;
      }
      if (token === 'scale') {
        // `TextureMatrix::setScale` -- a uScale/vScale under 1.0 leaves the
        // prior value (1, no scaling) alone rather than shrinking below it.
        const [, uFreq, vFreq, uScale, vScale] = line.split(/\s+/).map(Number);
        if (Number.isFinite(uFreq)) currentTextureMatrix.scaleUFreq = uFreq;
        if (Number.isFinite(vFreq)) currentTextureMatrix.scaleVFreq = vFreq;
        if (Number.isFinite(uScale) && uScale >= 1.0) currentTextureMatrix.scaleU = uScale;
        if (Number.isFinite(vScale) && vScale >= 1.0) currentTextureMatrix.scaleV = vScale;
        continue;
      }
      if (token === 'center') {
        const [, u, v] = line.split(/\s+/).map(Number);
        if (Number.isFinite(u)) currentTextureMatrix.centerU = u;
        if (Number.isFinite(v)) currentTextureMatrix.centerV = v;
        continue;
      }
      continue;
    }

    // `waterLevel` / `end` (`CustomWaterLevel.cxx`). One plane, the whole
    // width of the world, at a fixed height -- a map-wide singleton like
    // `noWalls`, not an obstacle, so this fills in `mapWaterLevel` directly on
    // `end` rather than collecting into a registry a `matref` looks up later.
    if (!current && !currentLink && !currentZone && !currentWeapon && !currentDefine
      && !currentMaterial && !currentPhysicsDriver && !currentDynamicColor && !currentTextureMatrix
      && !currentWaterLevel
      && token === 'waterlevel') {
      currentWaterLevel = {
        height: 0,
        // `WorldInfo::makeWaterMaterial` (`WorldInfo.cxx:147-170`) -- the
        // default a map's own material lines (read below, the same as a
        // `material` block's own) overwrite as they're read. bzo has no
        // alpha channel on a plain `color`/`diffuse` line (docs/bzw.md,
        // "Colour"), so the 0.9 alpha upstream's own default carries is
        // water's own fixed translucency in `render.js` instead of part of
        // this tint.
        texture: 'water', textureUrl: null, color: [0.65, 1.0, 0.5],
        noRadar: true, noLighting: false, dynamicColor: null,
        textureMatrix: DEFAULT_WATER_TEXTURE_MATRIX,
      };
      continue;
    }
    if (currentWaterLevel) {
      if (token === 'end') {
        mapWaterLevel = currentWaterLevel;
        currentWaterLevel = null;
        continue;
      }
      if (token === 'height') {
        // BZW's height is bzo's own vertical axis already (`position x y z`'s
        // `baseY = z`, docs/bzw.md's coordinate table) -- no sign flip, unlike
        // the two horizontal axes.
        const [, height] = line.split(/\s+/).map(Number);
        if (Number.isFinite(height)) currentWaterLevel.height = height;
        continue;
      }
      if (applyBzwMaterialToken(currentWaterLevel, token, line.split(/\s+/))) {
        continue;
      }
      // `name`, and everything else a plain `WorldFileObject` reads
      // (`passable` and friends) -- meaningless on a plane that always
      // covers the whole world, and upstream's own `writeToWorld` never
      // reads any of them back either.
      continue;
    }

    if (consumedBlock) {
      if (token === 'end') consumedBlock = null;
      continue;
    }
    if (token === 'options') {
      consumedBlock = 'options';
      continue;
    }

    // `define <name>` / `enddef` (CustomGroup's template registry). Upstream
    // refuses to nest one define inside another (BZWReader.cxx warns and skips
    // it), so a `define` seen while one is already open is dropped the same way.
    if (!current && !currentLink && !currentZone && !currentWeapon && !currentDefine && !currentWaterLevel
      && token === 'define') {
      const [, name] = line.split(/\s+/);
      if (name) {
        currentDefine = { name, obstacles: [], groupInstances: [], meshes: [] };
      } else {
        warn(`Ignoring "define" with no name in ${mapLabel}`);
      }
      continue;
    }
    if (currentDefine && !current && token === 'enddef') {
      if (defineTemplates.has(currentDefine.name)) {
        warn(`Duplicate group definition "${currentDefine.name}" in ${mapLabel}, using the newest`);
      }
      defineTemplates.set(currentDefine.name, {
        obstacles: currentDefine.obstacles,
        groupInstances: currentDefine.groupInstances,
        meshes: currentDefine.meshes,
      });
      // A definition's own meshes reach `meshes` only once a `group`
      // instance actually places it (below), same as its box/pyramid
      // members already reach `obstacles` -- a definition nothing ever
      // instantiates contributes nothing, meshes included.
      currentDefine = null;
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
        teams: new Set(),
        safety: new Set(),
      };
      continue;
    }

    if (token === 'world') {
      consumedBlock = 'world';
      // Look ahead through the block for every field bzo reads on it, rather
      // than stopping at the first one found -- a map may state `size` after
      // `noWalls`, and upstream's own `WorldFileLocation::read` has no
      // ordering requirement either.
      for (let j = i + 1; j < lines.length; j++) {
        const wline = lines[j].trim();
        const wtoken = wline.split(/\s+/)[0].toLowerCase();
        if (wtoken === 'end') break;
        if (wtoken === 'size') {
          const [, size] = wline.split(/\s+/);
          if (size) {
            mapSize = parseFloat(size) * 2;
          }
        } else if (wtoken === 'flagheight') {
          // No lower bound upstream (CustomWorld.cxx:39-42 sets `_fHeight`
          // straight from the stream) -- 0 is a real value, not "unset", the
          // same reasoning `docs/bzw.md` already gives box/pyramid `size` for
          // "A zero height is a real height."
          const [, height] = wline.split(/\s+/);
          const parsed = parseFloat(height);
          if (Number.isFinite(parsed) && parsed >= 0) mapFlagHeight = parsed;
        } else if (wtoken === 'nowalls') {
          mapNoWalls = true;
        } else if (wtoken === 'freectfspawns') {
          mapFreeCtfSpawns = true;
        }
      }
    // `rotation` is stated here rather than left to whether the block carries a
    // `rotation` line, because everything downstream turns it into a cosine: a
    // box or a pyramid with no rotation is a box at rotation 0, and saying so
    // once is what lets the client, the collision pair and every log read the
    // field instead of guessing a default for it. The rest of the shape has the
    // same treatment further down, where `end` fills in what the block left out.
    } else if (token === 'box') {
      current = { type: 'box', rotation: 0 };
    } else if (token === 'pyramid') {
      current = { type: 'pyramid', rotation: 0 };
    } else if (token === 'base') {
      current = { type: 'box', kind: 'base', team: 1, rotation: 0 };
    } else if (token === 'teleporter') {
      current = { type: 'box', kind: 'teleporter', rotation: 0 };
      const [, ...teleporterNameParts] = line.split(/\s+/);
      const inlineTeleporterName = teleporterNameParts.join(' ').replace(/"/g, '').trim();
      if (inlineTeleporterName) {
        current.name = inlineTeleporterName;
      }
    } else if (token === 'group') {
      // `spin` is the group's own rotation kept in raw radians (no +π) --
      // `rotation` below is the +π one every obstacle's own facing carries, and
      // placing a member is a position rotation, a different operator. See the
      // `rotation`/`rot` branch, where both get set from the same line.
      const [, groupDefName] = line.split(/\s+/);
      current = { type: 'group', groupDefName: groupDefName || '', rotation: 0, spin: 0, scale: [1, 1, 1] };
    } else if (token === 'tetra') {
      // CustomTetra's own defaults (CustomTetra.cxx:27-38): `drivethrough`/
      // `shootthrough`/`ricochet` are WorldFileObstacle's usual false, and
      // each of the four triangular faces defaults to upstream's own stock
      // "mesh" texture independently -- a material line before the first
      // `vertex` sets all four at once, one stated after the Nth sets only
      // that vertex's own face slot (CustomTetra::read's `vc = vertexCount
      // - 1`, clamped to 3 once all four are read) -- see the branch below.
      current = {
        type: 'tetra', name: null,
        definedIn: currentDefine ? currentDefine.name : null,
        vertexPositions: [],
        transformOps: [],
        faceMaterials: [0, 1, 2, 3].map(() => (
          { texture: 'mesh', textureUrl: null, color: null, noRadar: false, noLighting: false }
        )),
        driveThrough: false, shootThrough: false, ricochet: false,
      };
    } else if (current && current.type === 'tetra') {
      // A `tetra`'s own grammar: up to four `vertex` lines (no shared pool,
      // unlike `mesh` -- CustomTetra keeps its own four-slot array), each
      // one's own material read either before any vertex (every face) or
      // right after it (that face alone). `normals`/`texcoords` are read
      // and discarded rather than wired to a face: upstream's own
      // `TetraBuilding::makeMesh` never attaches them either (`MeshUtils.h`'s
      // shared `addFace` helper always receives empty normal/texcoord index
      // lists for a tetra's four faces, `TetraBuilding.cxx:110-121`), so a
      // tetra always falls back to bzo's generic per-face auto-planar UV --
      // matching real bzflag exactly, not a gap on bzo's side.
      const words = line.split(/\s+/);
      if (token === 'end') {
        if (current.vertexPositions.length < 4) {
          warn(`Not creating tetrahedron in ${mapLabel}, not enough vertices (${current.vertexPositions.length})`);
        } else {
          const tetraMesh = buildTetraMesh(current);
          tetraMesh.transformOps = current.transformOps;
          applyMeshTransform(tetraMesh);
          if (currentDefine) {
            currentDefine.meshes.push(tetraMesh);
          } else {
            meshes.push(finalizeMeshGeometry(tetraMesh));
          }
        }
        current = null;
      } else if (token === 'vertex') {
        if (current.vertexPositions.length >= 4) {
          warn(`Extra tetrahedron vertex in ${mapLabel}, ignoring`);
        } else {
          const [x, y, z] = words.slice(1).map(Number);
          current.vertexPositions.push({ x: x || 0, y: z || 0, z: -(y || 0) });
        }
      } else if (readMeshTransformToken(current, token, words)) {
        // See the same arm on `cone`/`arc`/`sphere` below.
      } else if (token === 'normals' || token === 'texcoords') {
        // See the comment above -- intentionally a no-op.
      } else if (BZW_PASSABILITY_KEYWORDS.has(token)) {
        Object.assign(current, BZW_PASSABILITY_KEYWORDS.get(token));
      } else if (token === 'name') {
        const [, ...nameParts] = words;
        const name = nameParts.join(' ').replace(/"/g, '').trim();
        if (name) current.name = name;
      } else {
        const vc = Math.min(Math.max(current.vertexPositions.length - 1, 0), 3);
        if (current.vertexPositions.length === 0) {
          current.faceMaterials.forEach((mat) => applyBzwMaterialToken(mat, token, words));
        } else {
          applyBzwMaterialToken(current.faceMaterials[vc], token, words);
        }
      }
    } else if (token === 'cone' || token === 'meshpyr') {
      // `CustomCone`'s own defaults (CustomCone.cxx:43-75): `meshpyr` is the
      // exact same generator as `cone`, just constructed with `pyramid=true`
      // (`BZWReader.cxx`'s own `new CustomCone(true)` for the keyword) --
      // 4 divisions instead of 16, flat shading instead of smooth, its own
      // default size pulled from a plain pyramid's (`_pyrBase`/`_pyrHeight`),
      // and every one of its four faces defaulting to "pyrwall" rather than
      // a cone's own boxwall/roof/wall/wall. `position`/`size`/`rotation`
      // are kept in upstream's own raw BZW terms (see `buildConeMesh`) --
      // this parses the same as every other obstacle's, it's only the
      // *storage* that differs, until the generator converts once at `end`.
      const isPyramid = token === 'meshpyr';
      current = {
        type: 'cone', name: null,
        definedIn: currentDefine ? currentDefine.name : null,
        isPyramid,
        posBzf: { x: 0, y: 0, z: 0 },
        transformOps: [],
        sizeBzf: isPyramid
          ? { x: MESHPYR_DEFAULT_BASE, y: MESHPYR_DEFAULT_BASE, z: MESHPYR_DEFAULT_HEIGHT }
          : { x: 10, y: 10, z: 10 },
        rotationRad: 0,
        sweepDeg: 360,
        divisions: isPyramid ? 4 : 16,
        texsize: { u: -8, v: -8 },
        useNormals: !isPyramid,
        flipz: false,
        smoothBounce: false,
        phydrv: null,
        driveThrough: false, shootThrough: false, ricochet: false,
        materials: isPyramid
          ? [0, 1, 2, 3].map(() => ({ texture: 'pyrwall', textureUrl: null, color: null, noRadar: false, noLighting: false }))
          : ['boxwall', 'roof', 'wall', 'wall'].map((texture) => (
            { texture, textureUrl: null, color: null, noRadar: false, noLighting: false }
          )),
      };
    } else if (current && current.type === 'cone') {
      const words = line.split(/\s+/);
      if (token === 'end') {
        const coneMesh = buildConeMesh(current);
        if (!coneMesh) {
          warn(`Not creating ${current.isPyramid ? 'meshpyr' : 'cone'} in ${mapLabel}, invalid size/divisions/texsize`);
        } else {
          coneMesh.transformOps = current.transformOps;
          applyMeshTransform(coneMesh);
          if (currentDefine) {
            currentDefine.meshes.push(coneMesh);
          } else {
            meshes.push(finalizeMeshGeometry(coneMesh));
          }
        }
        current = null;
      } else if (token === 'position' || token === 'pos') {
        const [x, y, z] = words.slice(1).map(Number);
        current.posBzf = { x: x || 0, y: y || 0, z: z || 0 };
      } else if (readMeshTransformToken(current, token, words)) {
        // `shift`/`scale`/`shear`/`spin` -- the ordered transform list,
        // folded into one matrix and applied to the finished mesh at `end`,
        // after this block's own `position`/`size`/`rotation`. That is
        // upstream's order: `writeToGroupDef` builds the trio into a
        // `MeshTransform` and then `append`s the stated list to it.
      } else if (token === 'size') {
        const [x, y, z] = words.slice(1).map(Number);
        current.sizeBzf = { x: x || 0, y: y || 0, z: z || 0 };
      } else if (token === 'rotation' || token === 'rot') {
        // Upstream's own raw convention -- degrees CCW about +Z, no sign or
        // offset fixup -- since `buildConeMesh` bakes this straight into the
        // sweep math in the same BZW terms everything else there uses.
        current.rotationRad = (parseFloat(words[1]) || 0) * Math.PI / 180;
      } else if (token === 'divisions') {
        const n = parseInt(words[1], 10);
        if (Number.isInteger(n)) current.divisions = n;
      } else if (token === 'angle') {
        // The sweep, not the heading -- `rotation` above is the heading.
        const deg = parseFloat(words[1]);
        if (!Number.isNaN(deg)) current.sweepDeg = deg;
      } else if (token === 'texsize') {
        const [, u, v] = words;
        current.texsize = { u: parseFloat(u) || current.texsize.u, v: parseFloat(v) || current.texsize.v };
      } else if (token === 'phydrv') {
        current.phydrv = words[1] || null;
      } else if (token === 'smoothbounce') {
        current.smoothBounce = true;
      } else if (token === 'flatshading') {
        current.useNormals = false;
      } else if (current.isPyramid && token === 'flipz') {
        current.flipz = true;
      } else if (BZW_PASSABILITY_KEYWORDS.has(token)) {
        Object.assign(current, BZW_PASSABILITY_KEYWORDS.get(token));
      } else if (token === 'name') {
        const [, ...nameParts] = words;
        const name = nameParts.join(' ').replace(/"/g, '').trim();
        if (name) current.name = name;
      } else if (CONE_SIDE_NAMES.has(token)) {
        const subWords = words.slice(1);
        applyBzwMaterialToken(current.materials[CONE_SIDE_NAMES.get(token)], (subWords[0] || '').toLowerCase(), subWords);
      } else {
        current.materials.forEach((mat) => applyBzwMaterialToken(mat, token, words));
      }
    } else if (token === 'arc' || token === 'meshbox') {
      // `CustomArc`'s own defaults (CustomArc.cxx:44-73): `meshbox` is the
      // exact same generator as `arc`, just constructed with `box=true`
      // (`BZWReader.cxx`'s own `new CustomArc(true)` for the keyword) -- 4
      // divisions instead of 16, flat shading instead of smooth, its own
      // default size pulled from a plain box's (`_boxBase`/`_boxHeight`),
      // but the *same* default materials as a plain `arc` -- unlike
      // `meshpyr`, `CustomArc`'s constructor never branches on `boxStyle` to
      // change them. `ratio` (1 collapses the inner radius to zero, an
      // ordinary solid wedge; less than that is a genuinely hollow tube)
      // and a 4-value `texsize` (edge U, edge V, disc U, disc V -- the last
      // two only used by the solid case) are `arc`'s own two differences
      // from `cone`.
      const isBox = token === 'meshbox';
      current = {
        type: 'arc', name: null,
        definedIn: currentDefine ? currentDefine.name : null,
        isBox,
        posBzf: { x: 0, y: 0, z: 0 },
        transformOps: [],
        sizeBzf: isBox
          ? { x: MESHBOX_DEFAULT_BASE, y: MESHBOX_DEFAULT_BASE, z: MESHBOX_DEFAULT_HEIGHT }
          : { x: 10, y: 10, z: 10 },
        rotationRad: 0,
        sweepDeg: 360,
        ratio: 1,
        divisions: isBox ? 4 : 16,
        texsize: {
          u: -8, v: -8, du: -8, dv: -8,
        },
        useNormals: !isBox,
        smoothBounce: false,
        phydrv: null,
        driveThrough: false, shootThrough: false, ricochet: false,
        materials: ['roof', 'roof', 'boxwall', 'boxwall', 'wall', 'wall'].map((texture) => (
          { texture, textureUrl: null, color: null, noRadar: false, noLighting: false }
        )),
      };
    } else if (current && current.type === 'arc') {
      const words = line.split(/\s+/);
      if (token === 'end') {
        const arcMesh = buildArcMesh(current);
        if (!arcMesh) {
          warn(`Not creating ${current.isBox ? 'meshbox' : 'arc'} in ${mapLabel}, invalid size/divisions/ratio/texsize`);
        } else {
          arcMesh.transformOps = current.transformOps;
          applyMeshTransform(arcMesh);
          if (currentDefine) {
            currentDefine.meshes.push(arcMesh);
          } else {
            meshes.push(finalizeMeshGeometry(arcMesh));
          }
        }
        current = null;
      } else if (token === 'position' || token === 'pos') {
        const [x, y, z] = words.slice(1).map(Number);
        current.posBzf = { x: x || 0, y: y || 0, z: z || 0 };
      } else if (readMeshTransformToken(current, token, words)) {
        // `shift`/`scale`/`shear`/`spin` -- the ordered transform list,
        // folded into one matrix and applied to the finished mesh at `end`,
        // after this block's own `position`/`size`/`rotation`. That is
        // upstream's order: `writeToGroupDef` builds the trio into a
        // `MeshTransform` and then `append`s the stated list to it.
      } else if (token === 'size') {
        const [x, y, z] = words.slice(1).map(Number);
        current.sizeBzf = { x: x || 0, y: y || 0, z: z || 0 };
      } else if (token === 'rotation' || token === 'rot') {
        current.rotationRad = (parseFloat(words[1]) || 0) * Math.PI / 180;
      } else if (token === 'divisions') {
        const n = parseInt(words[1], 10);
        if (Number.isInteger(n)) current.divisions = n;
      } else if (token === 'angle') {
        const deg = parseFloat(words[1]);
        if (!Number.isNaN(deg)) current.sweepDeg = deg;
      } else if (token === 'ratio') {
        const ratio = parseFloat(words[1]);
        if (!Number.isNaN(ratio)) current.ratio = ratio;
      } else if (token === 'texsize') {
        const [, u, v, du, dv] = words;
        current.texsize = {
          u: parseFloat(u) || current.texsize.u,
          v: parseFloat(v) || current.texsize.v,
          du: parseFloat(du) || current.texsize.du,
          dv: parseFloat(dv) || current.texsize.dv,
        };
      } else if (token === 'phydrv') {
        current.phydrv = words[1] || null;
      } else if (token === 'smoothbounce') {
        current.smoothBounce = true;
      } else if (token === 'flatshading') {
        current.useNormals = false;
      } else if (BZW_PASSABILITY_KEYWORDS.has(token)) {
        Object.assign(current, BZW_PASSABILITY_KEYWORDS.get(token));
      } else if (token === 'name') {
        const [, ...nameParts] = words;
        const name = nameParts.join(' ').replace(/"/g, '').trim();
        if (name) current.name = name;
      } else if (ARC_SIDE_NAMES.has(token)) {
        const subWords = words.slice(1);
        applyBzwMaterialToken(current.materials[ARC_SIDE_NAMES.get(token)], (subWords[0] || '').toLowerCase(), subWords);
      } else {
        current.materials.forEach((mat) => applyBzwMaterialToken(mat, token, words));
      }
    } else if (token === 'sphere') {
      // `CustomSphere`'s own defaults (CustomSphere.cxx:34-47) -- notably a
      // default `position` of `0 0 10` (not the usual origin), so a mapper
      // who never writes one still gets a radius-10 sphere resting on the
      // ground rather than centred on it, and `divisions` defaulting to 4
      // rather than a cone's 16 (this generator's own face count grows with
      // the *square* of `divisions`, `divisions**2 * 8`, not linearly).
      current = {
        type: 'sphere', name: null,
        definedIn: currentDefine ? currentDefine.name : null,
        posBzf: { x: 0, y: 0, z: 10 },
        transformOps: [],
        sizeBzf: { x: 10, y: 10, z: 10 },
        rotationRad: 0,
        divisions: 4,
        hemisphere: false,
        texsize: { u: -4, v: -4 },
        useNormals: true,
        smoothBounce: false,
        phydrv: null,
        driveThrough: false, shootThrough: false, ricochet: false,
        materials: ['boxwall', 'roof'].map((texture) => (
          { texture, textureUrl: null, color: null, noRadar: false, noLighting: false }
        )),
      };
    } else if (current && current.type === 'sphere') {
      const words = line.split(/\s+/);
      if (token === 'end') {
        const sphereMesh = buildSphereMesh(current);
        if (!sphereMesh) {
          warn(`Not creating sphere in ${mapLabel}, invalid size/divisions/texsize`);
        } else {
          sphereMesh.transformOps = current.transformOps;
          applyMeshTransform(sphereMesh);
          if (currentDefine) {
            currentDefine.meshes.push(sphereMesh);
          } else {
            meshes.push(finalizeMeshGeometry(sphereMesh));
          }
        }
        current = null;
      } else if (token === 'position' || token === 'pos') {
        const [x, y, z] = words.slice(1).map(Number);
        current.posBzf = { x: x || 0, y: y || 0, z: z || 0 };
      } else if (readMeshTransformToken(current, token, words)) {
        // `shift`/`scale`/`shear`/`spin` -- the ordered transform list,
        // folded into one matrix and applied to the finished mesh at `end`,
        // after this block's own `position`/`size`/`rotation`. That is
        // upstream's order: `writeToGroupDef` builds the trio into a
        // `MeshTransform` and then `append`s the stated list to it.
      } else if (token === 'size') {
        const [x, y, z] = words.slice(1).map(Number);
        current.sizeBzf = { x: x || 0, y: y || 0, z: z || 0 };
      } else if (token === 'radius') {
        const radius = parseFloat(words[1]);
        if (!Number.isNaN(radius)) current.sizeBzf = { x: radius, y: radius, z: radius };
      } else if (token === 'rotation' || token === 'rot') {
        current.rotationRad = (parseFloat(words[1]) || 0) * Math.PI / 180;
      } else if (token === 'divisions') {
        const n = parseInt(words[1], 10);
        if (Number.isInteger(n)) current.divisions = n;
      } else if (token === 'hemi' || token === 'hemisphere') {
        current.hemisphere = true;
      } else if (token === 'texsize') {
        const [, u, v] = words;
        current.texsize = { u: parseFloat(u) || current.texsize.u, v: parseFloat(v) || current.texsize.v };
      } else if (token === 'phydrv') {
        current.phydrv = words[1] || null;
      } else if (token === 'smoothbounce') {
        current.smoothBounce = true;
      } else if (token === 'flatshading') {
        current.useNormals = false;
      } else if (BZW_PASSABILITY_KEYWORDS.has(token)) {
        Object.assign(current, BZW_PASSABILITY_KEYWORDS.get(token));
      } else if (token === 'name') {
        const [, ...nameParts] = words;
        const name = nameParts.join(' ').replace(/"/g, '').trim();
        if (name) current.name = name;
      } else if (SPHERE_SIDE_NAMES.has(token)) {
        const subWords = words.slice(1);
        applyBzwMaterialToken(current.materials[SPHERE_SIDE_NAMES.get(token)], (subWords[0] || '').toLowerCase(), subWords);
      } else {
        current.materials.forEach((mat) => applyBzwMaterialToken(mat, token, words));
      }
    } else if (token === 'mesh') {
      // CustomMesh's own defaults -- a mesh's default texture is upstream's
      // stock "mesh" (a wireframe/grid picture, unrelated to mesh geometry --
      // see the callout in docs/bzw.md's Materials section), and driveThrough/
      // shootThrough/ricochet/phydrv/noclusters/smoothBounce all start unset,
      // the same as `WorldFileObstacle`'s own obstacle defaults.
      current = {
        type: 'mesh', name: null,
        // Which `define` this mesh was read inside, if any -- kept on a
        // placed copy too (see `applyGroupInstanceTransformToMesh`) purely
        // for debugging which template a mesh reaching the client came from.
        definedIn: currentDefine ? currentDefine.name : null,
        vertices: [], normals: [], texcoords: [], faces: [], checkPoints: [],
        phydrv: null, noclusters: false, smoothBounce: false, decorative: false,
        driveThrough: false, shootThrough: false, ricochet: false,
        texture: 'mesh', textureUrl: null, color: null, noRadar: false, noLighting: false,
        specular: null, emission: null, shininess: null, alphaThreshold: null,
        noSorting: false, useTextureAlpha: true, useColorOnTexture: true,
        // `MeshTransform`'s own ordered `shift`/`scale`/`shear`/`spin`
        // list, plus the `position`/`size`/`rotation` trio that is shorthand
        // for one of each -- both folded into one matrix at `end`, below.
        transformOps: [],
        xformPos: null, xformSize: null, xformRotation: 0,
        // `drawInfo`'s own render-only surface, and the pools it may bring
        // with it -- see `readMeshDrawInfoLine`. Null unless a map states one.
        drawFaces: null, drawVertices: null, drawNormals: null, drawTexcoords: null,
        // `MeshDrawInfo`'s own `angvel` (#88, degrees/sec) -- upstream states
        // it inside an unrelated render-optimization sub-block bzo does not
        // otherwise read (`drawInfo { ... }`, see `server/remote-world-
        // import.cjs`'s `printMesh`), so bzo takes it as a plain mesh
        // property instead. 0 (no spin) unless a mesh states it.
        angvel: 0,
      };
      currentMeshFace = null;
    } else if (current && current.type === 'mesh') {
      // A mesh's own grammar -- its vertex/normal/texcoord pools, its
      // checkpoints, its own defaults, and the `face`/`endface` blocks that
      // read off them -- kept self-contained here rather than folded into
      // the generic per-obstacle branches below, since nothing else parsed
      // in this function has a face nested inside it.
      const words = line.split(/\s+/);
      if (token === 'drawinfo') {
        currentDrawInfo = {
          depth: 0, closed: false,
          corners: [], vertices: [], normals: [], texcoords: [],
          // Only the first `lod` is kept. Upstream picks one per frame by
          // `lengthPerPixel` against the screen size (`MeshSceneNode::
          // notifyStyleChange`); bzo has no LOD machinery, so it takes the
          // one a map lists first, which is the highest detail.
          lod: null, set: null,
        };
      } else if (currentMeshFace) {
        // Inside `face` / `endface`. Every property here is scoped to this
        // one face, which already started from the mesh's own defaults at
        // the moment `face` was read, below -- CustomMeshFace's own
        // constructor snapshot.
        if (token === 'endface') {
          if (currentMeshFace.vertexIndices.length < 3) {
            warn(`Ignoring a mesh face with fewer than 3 vertices in ${mapLabel}`);
          } else {
            current.faces.push(currentMeshFace);
          }
          currentMeshFace = null;
        } else if (token === 'vertices') {
          currentMeshFace.vertexIndices = words.slice(1).map(Number).filter(Number.isInteger);
        } else if (token === 'normals') {
          currentMeshFace.normalIndices = words.slice(1).map(Number).filter(Number.isInteger);
        } else if (token === 'texcoords') {
          currentMeshFace.texcoordIndices = words.slice(1).map(Number).filter(Number.isInteger);
        } else if (token === 'phydrv') {
          currentMeshFace.phydrv = words[1] || null;
        } else if (token === 'smoothbounce') {
          currentMeshFace.smoothBounce = true;
        } else if (token === 'noclusters') {
          currentMeshFace.noclusters = true;
        } else if (BZW_PASSABILITY_KEYWORDS.has(token)) {
          Object.assign(currentMeshFace, BZW_PASSABILITY_KEYWORDS.get(token));
        } else {
          applyBzwMaterialToken(currentMeshFace, token, words);
        }
      } else if (token === 'end') {
        // A supported obstacle now (see the note on `meshes` above), so this
        // does not touch `unsupportedCounts` -- but still does not fold into
        // the generic `current && token === 'end'` obstacle-closing branch
        // below, which assumes a finished box/pyramid/group.
        // A mesh with vertices but zero faces draws and collides as nothing
        // -- not a mapper error bzo can see in the text (a real `mesh`
        // block, correctly closed), but the signature a source mesh built
        // with BZFlag's MeshDrawInfo optimization leaves once reconstructed
        // from a remote server's wire protocol, which does not carry that
        // format's actual geometry at all (see `parseMesh` in
        // `server/remote-world-import.cjs`). Worth a warning either way: an
        // operator who hand-wrote a genuinely empty mesh gets the same nudge
        // to remove it.
        if (current.vertices.length > 0 && current.faces.length === 0
          && !(current.drawFaces && current.drawFaces.length > 0)) {
          warn(`Ignoring mesh "${current.name || current.definedIn || '(unnamed)'}" in ${mapLabel}, `
            + `${current.vertices.length} vertices with no faces`);
        }
        // The mesh's own transform, baked into its points here -- upstream
        // hands the same folded matrix to `MeshObstacle`'s constructor
        // (`CustomMesh::writeToGroupDef`), so it is part of what the mesh
        // *is* before anything places it. A `group` instance's own transform
        // then applies on top, the same order as upstream's, where the
        // instance's modifier runs at `makeGroups` time.
        //
        // `position`/`size`/`rotation` are the older spelling of one scale,
        // one spin about the vertical and one shift, in that order, and
        // upstream prepends them to whatever the explicit list already holds
        // (`xform.append(transform)`) rather than replacing it -- so a mesh
        // may state both, and the trio happens first.
        if (current.xformSize || current.xformRotation || current.xformPos) {
          const oldStyle = [];
          const size = current.xformSize;
          if (size && (size[0] !== 1 || size[1] !== 1 || size[2] !== 1)) {
            oldStyle.push({ type: 'scale', data: [size[0], size[1], size[2], 0] });
          }
          if (current.xformRotation) {
            oldStyle.push({ type: 'spin', data: [0, 0, 1, current.xformRotation] });
          }
          const pos = current.xformPos;
          if (pos && (pos[0] !== 0 || pos[1] !== 0 || pos[2] !== 0)) {
            oldStyle.push({ type: 'shift', data: [pos[0], pos[1], pos[2], 0] });
          }
          current.transformOps = [...oldStyle, ...current.transformOps];
        }
        applyMeshTransform(current);
        if (currentDefine) {
          // Still a template in its own local frame -- `finalizeMeshGeometry`
          // runs later, once a `group` instance places it (or not at all, if
          // nothing ever does), never here.
          currentDefine.meshes.push(current);
        } else {
          meshes.push(finalizeMeshGeometry(current));
        }
        current = null;
      } else if (token === 'vertex') {
        const [x, y, z] = words.slice(1).map(Number);
        current.vertices.push({ x: x || 0, y: z || 0, z: -(y || 0) });
      } else if (token === 'normal') {
        const [x, y, z] = words.slice(1).map(Number);
        current.normals.push({ x: x || 0, y: z || 0, z: -(y || 0) });
      } else if (token === 'texcoord') {
        const [u, v] = words.slice(1).map(Number);
        current.texcoords.push({ u: u || 0, v: v || 0 });
      } else if (token === 'inside' || token === 'outside') {
        const [x, y, z] = words.slice(1).map(Number);
        current.checkPoints.push({ x: x || 0, y: z || 0, z: -(y || 0), inside: token === 'inside' });
      } else if (token === 'phydrv') {
        current.phydrv = words[1] || null;
      } else if (token === 'smoothbounce') {
        current.smoothBounce = true;
      } else if (token === 'noclusters') {
        current.noclusters = true;
      } else if (token === 'decorative') {
        current.decorative = true;
      } else if (token === 'angvel') {
        current.angvel = Number(words[1]) || 0;
      } else if (readMeshTransformToken(current, token, words)) {
        // `shift`/`scale`/`shear`/`spin` -- one ordered list, folded into a
        // matrix at `end`. Unlike a box or a `group`, where bzo takes only a
        // spin about the map's own vertical (nothing else survives an
        // axis-aligned model), a mesh spins about any axis at all: its
        // vertices are arbitrary points and the matrix is exact.
      } else if (token === 'position' || token === 'pos') {
        const [x, y, z] = words.slice(1).map(Number);
        current.xformPos = [x || 0, y || 0, z || 0];
      } else if (token === 'size') {
        const [x, y, z] = words.slice(1).map(Number);
        current.xformSize = [x ?? 1, y ?? 1, z ?? 1];
      } else if (token === 'rotation' || token === 'rot') {
        current.xformRotation = (Number(words[1]) || 0) * Math.PI / 180;
      } else if (token === 'face') {
        // CustomMeshFace's own constructor -- a snapshot of the mesh's
        // defaults as they stand right now, not a live reference to them:
        // a mesh-level line stated after this `face` affects only a later
        // face, never one already open or already closed.
        currentMeshFace = {
          vertexIndices: [], normalIndices: [], texcoordIndices: [],
          phydrv: current.phydrv, noclusters: current.noclusters,
          smoothBounce: current.smoothBounce,
          driveThrough: current.driveThrough, shootThrough: current.shootThrough,
          ricochet: false,
          texture: current.texture, textureUrl: current.textureUrl,
          color: current.color, noRadar: current.noRadar, noLighting: current.noLighting,
          specular: current.specular, emission: current.emission, shininess: current.shininess,
          alphaThreshold: current.alphaThreshold,
          ...bzwMaterialFlags(current),
        };
      } else if (BZW_PASSABILITY_KEYWORDS.has(token)) {
        Object.assign(current, BZW_PASSABILITY_KEYWORDS.get(token));
      } else if (token === 'name') {
        const [, ...nameParts] = words;
        const name = nameParts.join(' ').replace(/"/g, '').trim();
        if (name) current.name = name;
      } else if (!applyBzwMaterialToken(current, token, words)) {
        // `lod`, `drawInfo`, and a mesh's own position/size/rotation (its
        // transform -- not read yet, see docs/bzw-plan.md) all fall here,
        // along with any material property a mesh states inline that bzo has
        // no handling for. Counted rather than dropped in silence: a mesh is
        // where a map states `noculling` or `nosorting` on a billboard, and
        // those change what the map looks like.
        unreadKeywordCounts.set(token, (unreadKeywordCounts.get(token) || 0) + 1);
      }
    } else if (current && current.type === 'group' && (token === 'size' || token === 'scale')) {
      // A group's `size` is CustomGroup's own name for what WorldFileLocation
      // itself calls `scale` (MeshTransform::addScale) -- both spellings are
      // read here, and a mapper may state either -- not a box's
      // half-extent: 1 1 1 leaves every member at its own size.
      const [, sx, sy, sz] = line.split(/\s+/);
      const parsedX = parseFloat(sx);
      const parsedY = parseFloat(sy);
      const parsedZ = parseFloat(sz);
      current.scale = [
        Number.isFinite(parsedX) ? parsedX : 1,
        Number.isFinite(parsedY) ? parsedY : 1,
        Number.isFinite(parsedZ) ? parsedZ : 1,
      ];
    } else if (current && BZW_PASSABILITY_KEYWORDS.has(token)) {
      Object.assign(current, BZW_PASSABILITY_KEYWORDS.get(token));
    } else if (current && token === 'name') {
      // name <string>
      const [, ...nameParts] = line.split(/\s+/);
      const name = nameParts.join(' ').replace(/"/g, '').trim();
      if (name) current.name = name;
    } else if (current && (token === 'position' || token === 'pos' || token === 'shift')) {
      // position x y z, its `pos` alias, or `shift` -- WorldFileLocation's own
      // translate primitive, which `position` is shorthand for composing
      // with `size`/`rotation` (CustomGroup.cxx, CustomBox.cxx). A pure
      // translation never distorts a shape, so reading it the same as
      // `position` is exact, not an approximation -- unlike `scale`/`spin`,
      // which only line up with `size`/`rotation` on a `group` (see the
      // branches for each). BZFlag +Y north maps to our -Z north.
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
        // Deferred to `end` (see its own comment) -- whether a negative
        // height here means a real flip depends on whether a per-face
        // command shows up anywhere else in this same block, which may
        // still be ahead of this line.
        current.rawH = rawH;
      }
    } else if (current && (token === 'rotation' || token === 'rot')) {
      // BZFlag rotation is CCW around +Z; our world maps BZFlag +Y (north) to -Z,
      // which flips the depth axis. The correct conversion is +deg + π.
      const [, deg] = line.split(/\s+/);
      current.rotation = (parseFloat(deg) || 0) * Math.PI / 180 + Math.PI;
      if (current.type === 'group') {
        current.spin = (parseFloat(deg) || 0) * Math.PI / 180;
      }
    } else if (current && token === 'spin') {
      // spin <deg> <ax> <ay> <az> (WorldFileLocation::read) -- the more
      // general primitive `rotation` is shorthand for, about the map's own
      // vertical axis. About any other axis it tips the shape off bzo's
      // axis-aligned box/pyramid model the same way `shear` always does, so
      // only a spin about the vertical is read here; any other axis is
      // counted for the load to name, same as an unresolved matref.
      const [, rawAngle, rawAx, rawAy, rawAz] = line.split(/\s+/).map(Number);
      const isVertical = Math.abs(rawAx || 0) < 1e-6 && Math.abs(rawAy || 0) < 1e-6
        && Math.abs(rawAz || 0) > 1e-6;
      if (isVertical) {
        const signedDeg = (rawAngle || 0) * Math.sign(rawAz);
        current.rotation = (signedDeg * Math.PI / 180) + Math.PI;
        if (current.type === 'group') {
          current.spin = signedDeg * Math.PI / 180;
        }
      } else {
        nonVerticalSpinCount++;
      }
    } else if (current && current.type === 'pyramid' && token === 'flipz') {
      // Deferred to `end` -- see its own comment on why `flipz` alone means
      // something different once a per-face command also shows up.
      current.explicitFlipZ = true;
    } else if (current && token === 'border') {
      const [, border] = line.split(/\s+/);
      current.border = Math.abs(parseFloat(border) || 0);
    } else if (current && token === 'phydrv'
      && (current.type === 'box' || current.type === 'pyramid' || current.type === 'group')) {
      // A plain box/pyramid's own whole-obstacle driver (`CustomBox.cxx`),
      // or a `group` instance's own only-if-unset override onto each member
      // (`CustomGroup.cxx:70-82`) -- applied to the members themselves
      // where a `group` instance is expanded, below.
      const [, driverName] = line.split(/\s+/);
      current.phydrv = driverName || null;
      if (current.type === 'pyramid') {
        // CustomPyramid.cxx: `phydrv` also flips `isOldPyramid` false, same
        // as any per-face command -- see the `end` handler.
        current.hasFaceCommand = true;
      }
    } else if (current && current.kind === 'base' && token === 'color') {
      const [, color] = line.split(/\s+/);
      const team = parseInt(color, 10);
      current.team = Number.isInteger(team) ? Math.max(1, Math.min(4, team)) : 1;
    } else if (current && current.type === 'group' && token === 'tint') {
      // `CustomGroup::read`'s own `tint` (`CustomGroup.cxx:58-67`) -- not a
      // material property at all, and read nowhere else in a map. It
      // multiplies each mesh face's diffuse RGBA component-wise
      // (`getTintedMaterial`, `ObstacleModifier.cxx:158-176`; ambient,
      // specular and emission are left alone there on purpose), and it is
      // applied *after* whatever `matref`/`addtexture` the same instance
      // states, so an instance can both replace a material and tint the
      // replacement. Two nested instances multiply, which falls out of
      // applying each level's own tint as the nesting unwinds.
      const tint = parseBzwColor(line.split(/\s+/).slice(1));
      if (tint) current.tint = tint;
    } else if (current && current.type === 'group'
      && (token === 'matref' || token === 'addtexture' || token === 'texture'
        || token === 'dyncol' || token === 'texmat')) {
      // A group instance's own material override -- unlike a box/pyramid's
      // walls/caps split just below, this is one plain material applied
      // wholesale to a mesh member's every face (`ObstacleModifier::execute`,
      // `ObstacleModifier.cxx:189-208`: `face->bzMaterial = material`,
      // unconditional), so it is kept as one resolved material object rather
      // than the wallTexture/capTexture pair a box reads the same tokens
      // into. `applyGroupMeshModifiers` (above `applyGroupInstanceTransform`)
      // is what actually applies it, once the member is known.
      current.materialOverride ??= {
        texture: null, textureUrl: null, color: null, noRadar: false, noLighting: false,
        dynamicColor: null, textureMatrix: null,
        specular: null, emission: null, shininess: null, alphaThreshold: null,
        noSorting: false, useTextureAlpha: true, useColorOnTexture: true,
      };
      applyBzwMaterialToken(current.materialOverride, token, line.split(/\s+/));
    } else if (current && (BZW_FACE_GROUPS.has(token) || token === 'color' || token === 'diffuse'
      || token === 'matref' || token === 'addtexture' || token === 'texture'
      || token === 'noradar' || token === 'nolighting' || token === 'dyncol' || token === 'texmat')
      && current.kind !== 'base' && current.kind !== 'teleporter') {
      // The colour, texture or material a map paints an obstacle with, which
      // the branch above reads as a team on a base -- upstream's CustomBase
      // takes the word that way too -- and which a teleporter has no use for,
      // since bzo's carries its own materials. Everything else a material
      // block can say is skipped here rather than rejected: `top texsize 4 4`
      // names a face bzo understands and a property it does not, and arrives
      // as an untextured box either way.
      if (current.type === 'pyramid') {
        // CustomPyramid.cxx: any per-face command (sides/edge/bottom/a named
        // face, or that face's own matref/texture/color) flips isOldPyramid
        // to false -- see the `end` handler for what that changes.
        current.hasFaceCommand = true;
      }
      const words = line.split(/\s+/);
      const group = BZW_FACE_GROUPS.get(token);
      const keyword = (group ? words[1] || '' : words[0]).toLowerCase();
      if (keyword === 'color' || keyword === 'diffuse') {
        const tint = parseBzwColor(words.slice(group ? 2 : 1));
        if (tint) {
          if (group !== 'caps') current.wallColor = tint;
          if (group !== 'walls') current.capColor = tint;
        }
      } else if (keyword === 'matref') {
        // `matref <name>` pulls in a whole named material -- its texture, its
        // tint and its noRadar/noLighting flags -- in one line, the same
        // only-if-stated way a plain `addtexture`/`color` line does below.
        // Read at this point in the sequence, so a property line stated after
        // it (upstream's own read order) still overrides what the material gave.
        const refName = (words[group ? 2 : 1] || '').toLowerCase();
        const material = materialsByName.get(refName);
        if (material) {
          if (group !== 'caps') {
            if (material.texture) { current.wallTexture = material.texture; current.wallTextureUrl = null; }
            else if (material.textureUrl) { current.wallTextureUrl = material.textureUrl; current.wallTexture = null; }
            if (material.color) current.wallColor = material.color;
            if (material.noLighting) current.wallNoLighting = true;
            if (material.dynamicColor) current.wallDynamicColor = material.dynamicColor;
            if (material.textureMatrix) current.wallTextureMatrix = material.textureMatrix;
            if (material.specular) current.wallSpecular = material.specular;
            if (material.emission) current.wallEmission = material.emission;
            if (material.shininess != null) current.wallShininess = material.shininess;
          }
          if (group !== 'walls') {
            if (material.texture) { current.capTexture = material.texture; current.capTextureUrl = null; }
            else if (material.textureUrl) { current.capTextureUrl = material.textureUrl; current.capTexture = null; }
            if (material.color) current.capColor = material.color;
            if (material.noLighting) current.capNoLighting = true;
            if (material.dynamicColor) current.capDynamicColor = material.dynamicColor;
            if (material.textureMatrix) current.capTextureMatrix = material.textureMatrix;
            if (material.specular) current.capSpecular = material.specular;
            if (material.emission) current.capEmission = material.emission;
            if (material.shininess != null) current.capShininess = material.shininess;
          }
          if (material.noRadar) current.noRadar = true;
        } else if (refName && refName !== '-1') {
          unresolvedMaterialRefs.add(refName);
        }
      } else if (keyword === 'addtexture' || keyword === 'texture') {
        const rawName = words.slice(group ? 2 : 1).join(' ');
        const resolved = resolveBzwTextureName(rawName);
        if (resolved?.stock) {
          if (group !== 'caps') { current.wallTexture = resolved.stock; current.wallTextureUrl = null; }
          if (group !== 'walls') { current.capTexture = resolved.stock; current.capTextureUrl = null; }
        } else if (resolved?.url) {
          if (group !== 'caps') { current.wallTextureUrl = resolved.url; current.wallTexture = null; }
          if (group !== 'walls') { current.capTextureUrl = resolved.url; current.capTexture = null; }
          externalTextureUrls.add(resolved.url);
        } else if (rawName) {
          unresolvedTextureNames.add(rawName);
        }
      } else if (keyword === 'dyncol') {
        const refName = (words[group ? 2 : 1] || '');
        const referenced = /^[0-9]/.test(refName)
          ? dynamicColorRegistry[parseInt(refName, 10)] || null
          : dynamicColorsByName.get(refName.toLowerCase()) || null;
        if (referenced) {
          if (group !== 'caps') current.wallDynamicColor = referenced;
          if (group !== 'walls') current.capDynamicColor = referenced;
        } else if (refName && refName !== '-1') {
          unresolvedDynamicColorRefs.add(refName.toLowerCase());
        }
      } else if (keyword === 'texmat') {
        const refName = (words[group ? 2 : 1] || '');
        const referenced = /^[0-9]/.test(refName)
          ? textureMatrixRegistry[parseInt(refName, 10)] || null
          : textureMatricesByName.get(refName.toLowerCase()) || null;
        if (referenced) {
          if (group !== 'caps') current.wallTextureMatrix = referenced;
          if (group !== 'walls') current.capTextureMatrix = referenced;
        } else if (refName && refName !== '-1') {
          unresolvedTextureMatrixRefs.add(refName.toLowerCase());
        }
      } else if (keyword === 'noradar') {
        current.noRadar = true;
      } else if (keyword === 'nolighting') {
        if (group !== 'caps') current.wallNoLighting = true;
        if (group !== 'walls') current.capNoLighting = true;
      }
    } else if (current && token === 'end') {
      if (current.type === 'group') {
        // No geometry of its own to place yet -- a `group` may name a `define`
        // the file hasn't reached, the same deferred resolution upstream gives
        // it, so every instance waits for the expansion pass below, once every
        // `define` in the file is known. One found inside a `define` block is
        // itself a template entry rather than a placement -- upstream's own
        // `GroupDefinition` holds its nested `group` instances the same way,
        // recursing into them only once something actually places *this*
        // definition (`GroupDefinition::makeGroups`).
        const instanceRequest = {
          groupDefName: current.groupDefName,
          name: current.name || null,
          x: current.x || 0,
          z: current.z || 0,
          baseY: current.baseY || 0,
          rotation: current.rotation || 0,
          spin: current.spin || 0,
          scale: current.scale || [1, 1, 1],
          driveThrough: !!current.driveThrough,
          shootThrough: !!current.shootThrough,
          ricochet: !!current.ricochet,
          phydrv: current.phydrv || null,
          materialOverride: current.materialOverride || null,
          tint: current.tint || null,
        };
        if (currentDefine) {
          currentDefine.groupInstances.push(instanceRequest);
        } else {
          groupInstanceRequests.push(instanceRequest);
        }
        current = null;
      } else {
        // CustomPyramid.cxx:319-350: a plain pyramid (no per-face command
        // anywhere in its block) builds a `PyramidBuilding` straight from
        // `fabsf()` of each size component, and negative height there really
        // is `setZFlip()` -- an actual, visible inversion. But the moment a
        // pyramid uses even one per-face command -- `sides`/`edge`/`bottom`/
        // an individual face name, a face's own `matref`/texture/color,
        // `texsize`, `texoffset`, or `phydrv` -- upstream's own `isOldPyramid`
        // flag goes false and it switches to building a `MeshTransform`
        // instead, scaled by the *signed*, non-`fabsf`'d size. `hix.bzw`
        // gives every one of its pyramids `sides matref`, so every one of
        // them takes this second path in real bzflag, and on this path a
        // negative height is not a flip at all: `position`'s own Z anchors
        // whichever end the sign points at (the apex when height is
        // negative, the base otherwise), and the shape extends by `|height|`
        // toward the other end -- so it is always apex-up, base-down, however
        // its height's sign was chosen for the map author's own convenience
        // in anchoring the piece. The one condition that still produces a
        // real, visible inversion here is upstream's own literal `flipz`
        // command with a *non-negative* height (`flipActive` below true from
        // `explicitFlipZ` alone) -- confirmed against `bz4.rikers.org:5154`'s
        // own wire-protocol geometry for this exact map's support struts:
        // its cap pieces (negative height, no `flipz`) come back apex at the
        // stated position and base below it, base-down like every other
        // pyramid there.
        if (current.type === 'pyramid' && current.hasFaceCommand) {
          const rawH = Number.isFinite(current.rawH) ? current.rawH : current.h;
          const statedZ = current.baseY || 0;
          const flipActive = current.explicitFlipZ === true || rawH < 0;
          const apexZ = flipActive ? statedZ : statedZ + rawH;
          const baseZ = flipActive ? statedZ + rawH : statedZ;
          current.baseY = Math.min(apexZ, baseZ);
          current.inverted = apexZ < baseZ;
          // `h` is already `Math.abs(rawH)` from the `size` line -- unchanged.
        } else if (current.type === 'pyramid') {
          // Old-style pyramid (no per-face command at all): upstream's own
          // `isOldPyramid` path, unchanged from bzo's original behavior --
          // `position` is the base, and a negative height or literal `flipz`
          // really does mean `setZFlip()`. `baseY` stays exactly as parsed.
          const rawH = Number.isFinite(current.rawH) ? current.rawH : current.h;
          current.inverted = rawH < 0 || current.explicitFlipZ === true;
        }

        // BaseBuilding::inMovingBox (BaseBuilding.cxx:77), in upstream's own words:
        // "if a base is just the ground (z == 0 && height == 0) no collision --
        // ground is already handled". A pad with no height is not something
        // anything can hit, so no map has to say so: a flush base or box is
        // passable by construction, to shots as much as to tanks.
        //
        // Upstream writes that guard on the base alone, because a zero-height box
        // is vanishingly rare there. Its *box* arithmetic has none, and the case
        // that exposes the difference is a burrowed tank: it drives below zero, so
        // its own span reaches up through a pad's [0, 0] and it stops dead on one.
        // `bzo.bzw` puts a pad under every flag zone, which turned that into
        // forty-two places a `BU` tank came to a halt.
        //
        // Read from the dimensions rather than from the keyword, so it is true of
        // every flush pad and not only of the ones somebody remembered to mark.
        // Teleporters are excluded because theirs are not final yet -- the block
        // below fills in a sizeless one from CustomGate's defaults.
        if (current.kind !== 'teleporter' && current.h === 0 && (current.baseY || 0) === 0) {
          current.driveThrough = true;
          current.shootThrough = true;
        }

        if (currentDefine) {
          // A define's contents are a template, not finished obstacles --
          // names and teleporter registration wait for a `group` instance to
          // place a copy, in the expansion pass below (matching upstream:
          // `GroupDefinition::makeGroups` calls `makeTeleName` and adds a
          // teleporter to the world's teleporter list once per real
          // placement, not once per template). Its own dimensions are
          // resolved now regardless -- see `applyTeleporterDefaults`.
          if (current.kind === 'teleporter') {
            applyTeleporterDefaults(current);
          }
          currentDefine.obstacles.push(current);
          current = null;
        } else {
          // Use BZW name if present, otherwise assign a generated name
          if (!current.name) {
            if (current.kind === 'teleporter') {
              current.name = `t${teleporters.length}`;
            } else {
              current.name = `${current.type[0].toUpperCase()}${obstacles.length}`;
            }
          }

          if (current.kind === 'teleporter') {
            applyTeleporterDefaults(current);
            registerTeleporter(current);
          }

          obstacles.push(current);
          current = null;
        }
      }
    } else if (!current && !currentLink && !currentZone && !currentWeapon
      && UNSUPPORTED_TOP_LEVEL_KEYWORDS.has(token)) {
      unsupportedCounts.set(token, (unsupportedCounts.get(token) || 0) + 1);
    } else if (current && BZW_INERT_MATERIAL_KEYWORDS.has(token)) {
      // Read and dropped rather than tallied -- a box or pyramid stating one
      // of these gets exactly what upstream gives it, which is nothing.
    } else {
      // Nothing above claimed this line. Every branch that reads a keyword is
      // one of the arms this falls off the end of, so reaching here means bzo
      // has no handling for the word at all -- which is worth counting rather
      // than dropping in silence. `alphathresh` went unread in 26 of the maps
      // in `maps/` without any of them ever saying so.
      unreadKeywordCounts.set(token, (unreadKeywordCounts.get(token) || 0) + 1);
    }
  }

  // One line inside a `drawInfo { ... }` block (`MeshDrawInfo::parse`,
  // `MeshDrawInfo.cxx:874-1029`, with `parseDrawLod`/`parseDrawSet` for the
  // two nested levels). The block is upstream's render-optimized copy of the
  // same surface the mesh's own `face` list describes -- a flat corner table
  // plus GL draw commands over it -- and a real map may state *only* this,
  // with no faces at all, which is how `RatsNest.bzw`'s own tank models are
  // written and why bzo used to draw them as nothing.
  //
  // A corner is `vertex normal texcoord`, indexing the mesh's own pools --
  // unless the block states pools of its own, which replace them for drawing
  // (`MeshDrawInfo::clientSetup`, `:464-478`). Draw commands index corners.
  function readMeshDrawInfoLine(mesh, info, token, words) {
    // Inside a draw set: the commands themselves, and the per-set hints bzo
    // has no use for.
    if (info.depth === 2) {
      if (token === 'end') {
        info.set = null;
        info.depth = 1;
        return;
      }
      if (token === 'dlist' || token === 'sphere') return;
      if (MESH_DRAW_MODES.has(token)) {
        const indices = words.slice(1).map(Number).filter(Number.isInteger);
        if (info.set) info.set.commands.push({ mode: token, indices });
        return;
      }
      unreadKeywordCounts.set(token, (unreadKeywordCounts.get(token) || 0) + 1);
      return;
    }
    // Inside a lod: its own screen-size threshold, and one draw set per
    // material.
    if (info.depth === 1) {
      if (token === 'end') {
        info.depth = 0;
        return;
      }
      if (token === 'length' || token === 'lengthperpixel') return;
      if (token === 'matref') {
        const set = { materialRef: words[1] || '', commands: [] };
        if (info.lod) info.lod.sets.push(set);
        info.set = set;
        info.depth = 2;
        return;
      }
      unreadKeywordCounts.set(token, (unreadKeywordCounts.get(token) || 0) + 1);
      return;
    }
    // The block's own body.
    if (token === 'end') {
      info.closed = true;
      buildMeshDrawFaces(mesh, info);
      return;
    }
    if (token === 'angvel') {
      // Upstream's own home for it (`:910-926`). A mesh-level `angvel` is
      // bzo's own spelling of the same thing (see the `mesh` branch above),
      // and a map stating it here is stating it where bzflag reads it.
      mesh.angvel = Number(words[1]) || 0;
      return;
    }
    if (token === 'corner') {
      const [v, n, t] = words.slice(1).map(Number);
      info.corners.push({
        vertex: Number.isInteger(v) ? v : -1,
        normal: Number.isInteger(n) ? n : -1,
        texcoord: Number.isInteger(t) ? t : -1,
      });
      return;
    }
    if (token === 'vertex') {
      const [x, y, z] = words.slice(1).map(Number);
      info.vertices.push({ x: x || 0, y: z || 0, z: -(y || 0) });
      return;
    }
    if (token === 'normal') {
      const [x, y, z] = words.slice(1).map(Number);
      info.normals.push({ x: x || 0, y: z || 0, z: -(y || 0) });
      return;
    }
    if (token === 'texcoord') {
      const [u, v] = words.slice(1).map(Number);
      info.texcoords.push({ u: u || 0, v: v || 0 });
      return;
    }
    if (token === 'lod' || token === 'radarlod') {
      // `radarlod` is a second, coarser copy for the radar alone. bzo draws
      // its radar from the obstacle's own footprint rather than from mesh
      // geometry, so it is walked for its `end` lines and otherwise dropped.
      const lod = { sets: [] };
      if (token === 'lod' && !info.lod) info.lod = lod;
      info.depth = 1;
      return;
    }
    // `extents`/`center`/`sphere` are bounds upstream precomputes and bzo
    // derives itself; `option` is a renderer hint; `dlist` asks for a display
    // list, which WebGL has no equivalent of. All read and dropped.
    if (token === 'extents' || token === 'center' || token === 'sphere'
      || token === 'option' || token === 'dlist') {
      return;
    }
    unreadKeywordCounts.set(token, (unreadKeywordCounts.get(token) || 0) + 1);
  }

  // Turns a finished `drawInfo` block into the faces bzo draws it with. These
  // are render-only, kept apart from the mesh's own `faces`: upstream draws
  // from `drawInfo` and collides against the face list, and a mesh that
  // states only a `drawInfo` -- every tank in `RatsNest.bzw` -- is decoration
  // a tank drives straight through, which falls out of leaving `faces` empty.
  function buildMeshDrawFaces(mesh, info) {
    if (!info.lod || info.corners.length === 0) return;
    // Pools of its own replace the mesh's for drawing, all three together
    // (`clientSetup` switches on `rawVertCount` alone).
    if (info.vertices.length > 0) {
      mesh.drawVertices = info.vertices;
      mesh.drawNormals = info.normals;
      mesh.drawTexcoords = info.texcoords;
    }
    const drawFaces = [];
    for (const set of info.lod.sets) {
      // The set's own material, resolved the way every other `matref` is.
      const material = {
        texture: null, textureUrl: null, color: null, noRadar: false, noLighting: false,
        dynamicColor: null, textureMatrix: null,
        specular: null, emission: null, shininess: null, alphaThreshold: null,
        noSorting: false, useTextureAlpha: true, useColorOnTexture: true,
      };
      applyBzwMaterialToken(material, 'matref', ['matref', set.materialRef]);
      for (const command of set.commands) {
        for (const poly of expandMeshDrawCommand(command.mode, command.indices)) {
          const corners = poly.map((index) => info.corners[index]).filter(Boolean);
          if (corners.length < 3) continue;
          drawFaces.push({
            vertexIndices: corners.map((corner) => corner.vertex),
            normalIndices: corners.every((corner) => corner.normal >= 0)
              ? corners.map((corner) => corner.normal) : [],
            texcoordIndices: corners.every((corner) => corner.texcoord >= 0)
              ? corners.map((corner) => corner.texcoord) : [],
            texture: material.texture,
            textureUrl: material.textureUrl,
            color: material.color,
            noRadar: material.noRadar,
            noLighting: material.noLighting,
            specular: material.specular,
            emission: material.emission,
            shininess: material.shininess,
            alphaThreshold: material.alphaThreshold,
            dynamicColor: material.dynamicColor,
            textureMatrix: material.textureMatrix,
            // Only here: this is the one route on which upstream's own
            // renderer honours `noculling` -- see `applyBzwMaterialToken`.
            noCulling: !!material.noCulling,
            ...bzwMaterialFlags(material),
          });
        }
      }
    }
    if (drawFaces.length > 0) mesh.drawFaces = drawFaces;
  }

  // Applies one `group` instance's composed transform (scale, then spin, then
  // shift -- CustomGroup::writeToGroupDef's order) to a list of members
  // already resolved in the frame the instance itself sits in -- either a
  // definition's own plain obstacles, or a nested instance's own already-
  // placed output, one level in. Applying it once per level as nesting
  // unwinds is what makes recursion work without composing an N-level
  // transform up front.
  // A group instance's own `phydrv`/`matref`/`addtexture` never touch a
  // plain box or pyramid member at all -- `ObstacleModifier::execute`
  // (`ObstacleModifier.cxx:179-223`) gates both behind `obstacle->getType()
  // == MeshObstacle::getClassName()`, full stop. On a mesh member the two
  // are opposite rules, not the same "only if unset" shape a member's own
  // passability gets: a matref/addtexture override *replaces* every face's
  // material outright (`face->bzMaterial = material`, unconditional), while
  // a phydrv override only ever touches a face that *already* names some
  // driver (upstream's own comment: "only modify faces that already have a
  // physics driver") -- a face with none stays driver-less under a moving
  // group. A `tint` is mesh-only for the same reason, and multiplies each
  // face's diffuse rather than replacing it, after any material override the
  // same instance states. Building new face objects rather than mutating the
  // member's own:
  // the same `define` this member came from may be instantiated again
  // elsewhere with a different override, and that later instance must not
  // see this one's.
  function applyGroupMeshModifiers(member, request) {
    if (member.type !== 'mesh') return member;
    const hasPhydrvOverride = !!request.phydrv;
    const hasMaterialOverride = !!request.materialOverride;
    const tint = request.tint || null;
    if (!hasPhydrvOverride && !hasMaterialOverride && !tint) return member;
    return {
      ...member,
      faces: member.faces.map((face) => {
        const next = { ...face };
        if (hasPhydrvOverride && face.phydrv) next.phydrv = request.phydrv;
        if (hasMaterialOverride) {
          next.texture = request.materialOverride.texture;
          next.textureUrl = request.materialOverride.textureUrl;
          next.color = request.materialOverride.color;
          next.noRadar = request.materialOverride.noRadar;
          next.noLighting = request.materialOverride.noLighting;
          next.specular = request.materialOverride.specular;
          next.emission = request.materialOverride.emission;
          next.shininess = request.materialOverride.shininess;
          next.alphaThreshold = request.materialOverride.alphaThreshold;
          Object.assign(next, bzwMaterialFlags(request.materialOverride));
        }
        // `tint` last, over whatever the material override just wrote --
        // `ObstacleModifier::execute` tints the face's *replacement*
        // material, not the one it replaced. A face with no diffuse of its
        // own starts from `BzMaterial::reset`'s own opaque white, so
        // multiplying leaves the tint itself.
        if (tint) {
          const base = next.color || [1, 1, 1, 1];
          next.color = tint.map((component, i) => component * (base[i] ?? 1));
        }
        return next;
      }),
    };
  }

  function applyGroupInstanceTransform(members, request, instanceLabel) {
    const [scaleX, scaleY, scaleZ] = request.scale;
    const cos = Math.cos(request.spin);
    const sin = Math.sin(request.spin);

    return members.map((member, memberIndex) => {
      // BZFlag's y (north) is bzo's z, so the group's scale.y stretches a
      // member's z position and depth the way scale.x stretches x and width.
      const localX = (member.x || 0) * scaleX;
      const localZ = (member.z || 0) * scaleY;
      const localY = (member.baseY || 0) * scaleZ;
      // The same local-to-world rotation render.js/collision.cjs already use
      // for an obstacle's own facing (`getColliderLocalPoint`'s inverse), here
      // rotating a member's position around the group's origin rather than
      // orienting a single shape -- a different operator, so it takes the raw
      // spin rather than the +π `rotation` a facing carries.
      const worldX = (localX * cos) + (localZ * sin);
      const worldZ = (-localX * sin) + (localZ * cos);

      return {
        ...member,
        x: request.x + worldX,
        z: request.z + worldZ,
        baseY: request.baseY + localY,
        // Composing two already-+π-adjusted facings by addition is off by one
        // extra π from the true sum -- invisible here, since every shape a
        // define may hold (box, pyramid) is symmetric under exactly that half
        // turn, the same reason a box with no stated `rotation` line (0, not
        // +π) already renders identically to one with an explicit `rotation 0`.
        // The same holds at every nesting depth, for the same reason.
        rotation: (member.rotation || 0) + request.rotation,
        w: (member.w || 0) * Math.abs(scaleX),
        d: (member.d || 0) * Math.abs(scaleY),
        h: (member.h || 0) * Math.abs(scaleZ),
        // The group's own passability only adds permission -- true on every
        // member type, unlike matref/phydrv below, which upstream restricts
        // to a mesh member's own faces.
        driveThrough: !!member.driveThrough || request.driveThrough,
        shootThrough: !!member.shootThrough || request.shootThrough,
        ricochet: !!member.ricochet || request.ricochet,
        // A member already named -- one that came back from a nested `group`,
        // already carrying its own instance prefix -- keeps that name; only a
        // still-bare plain obstacle falls back to its place in the
        // definition, `t<n>` for a teleporter (upstream's own default,
        // `GroupDefinition::makeTeleName`) rather than a type-letter one.
        name: `${instanceLabel}:${member.name
          || (member.kind === 'teleporter' ? `t${memberIndex}` : `${(member.type || 'O')[0].toUpperCase()}${memberIndex}`)}`,
      };
    }).map((member) => applyGroupMeshModifiers(member, request));
  }

  // A group instance's own scale/spin, applied to one point in the
  // definition's local frame -- a mesh vertex or checkpoint (translated by
  // `request.x`/`baseY`/`z` after this, the same as a member's own position
  // above) or a mesh normal (left untranslated, `scaleX`/`Y`/`Z` all 1 --
  // a direction has no position to scale, and no rigorous inverse-transpose
  // for a non-uniform one either; real local usage only ever scales a mesh
  // uniformly, so a plain rotation is exact there and a close approximation
  // otherwise).
  function transformGroupPoint(point, scaleX, scaleY, scaleZ, cos, sin) {
    const localX = (point.x || 0) * scaleX;
    const localZ = (point.z || 0) * scaleY;
    const localY = (point.y || 0) * scaleZ;
    return {
      x: (localX * cos) + (localZ * sin),
      y: localY,
      z: (-localX * sin) + (localZ * cos),
    };
  }

  // The mesh equivalent of `applyGroupInstanceTransform` above -- same
  // scale/spin/shift, applied per vertex/checkpoint (and per normal, minus
  // the translation) rather than to one obstacle position, since a mesh's
  // geometry is many points rather than a position plus a size.
  function applyGroupInstanceTransformToMesh(mesh, request, instanceLabel) {
    const [scaleX, scaleY, scaleZ] = request.scale;
    const cos = Math.cos(request.spin);
    const sin = Math.sin(request.spin);
    const placePoint = (point) => {
      const local = transformGroupPoint(point, scaleX, scaleY, scaleZ, cos, sin);
      return { x: request.x + local.x, y: request.baseY + local.y, z: request.z + local.z };
    };
    const placedMesh = {
      ...mesh,
      name: `${instanceLabel}:${mesh.name || 'Mesh'}`,
      vertices: mesh.vertices.map(placePoint),
      normals: mesh.normals.map((n) => transformGroupPoint(n, 1, 1, 1, cos, sin)),
      checkPoints: mesh.checkPoints.map((p) => ({ ...placePoint(p), inside: p.inside })),
      // Fresh face objects, never the template's own -- the same definition
      // may be placed more than once, each with its own transform, and
      // `finalizeMeshGeometry` below writes a world-space `plane` onto each
      // face in place. Reusing the template's array would let the last
      // instance placed overwrite every earlier one's collision plane.
      faces: mesh.faces.map((face) => ({ ...face })),
      drawFaces: mesh.drawFaces ? mesh.drawFaces.map((face) => ({ ...face })) : null,
      drawVertices: mesh.drawVertices ? mesh.drawVertices.map(placePoint) : null,
      drawNormals: mesh.drawNormals
        ? mesh.drawNormals.map((n) => transformGroupPoint(n, 1, 1, 1, cos, sin))
        : null,
      // The point a spinning mesh (`angvel`, #88) rotates about -- upstream
      // has no per-mesh pivot of its own (a hand-authored `drawInfo` spins
      // about world origin), so this is just the mesh's own local (0,0,0)
      // carried through the same placement every vertex above gets. Treating
      // a definition already placed once (nested `group`s) as one more local
      // point rather than always restarting from world origin here is what
      // makes an arbitrarily deep nesting land in the right place.
      spinPivot: mesh.angvel ? placePoint(mesh.spinPivot || { x: 0, y: 0, z: 0 }) : mesh.spinPivot,
    };
    finalizeMeshGeometry(placedMesh);
    // The instance's own `phydrv`/`matref` override, same rule and same
    // helper `applyGroupInstanceTransform` uses for a nested plain-obstacle
    // group whose member happens to be a mesh -- this is the direct path a
    // top-level `group <meshDefine> \n matref <name> \n end` instance
    // actually takes (`resolveDefineMeshes`, above), so it needs the same
    // application, not just the indirect one.
    return applyGroupMeshModifiers(placedMesh, request);
  }

  // A vertex pool's own axis-aligned bounding box -- `MeshObstacle::finalize`
  // builds the same thing by expanding over every face's extents, and prints
  // it back as a real map's own `# mins`/`# maxs` comment. Used as a cheap
  // whole-mesh reject before a collision check ever looks at an individual
  // face -- see `meshIntersectsCylinder` in the collision pair -- so a tank
  // nowhere near a 100-face mesh costs one bounds check, not 100 polygon ones.
  function computeMeshBounds(vertices) {
    if (!vertices.length) return null;
    let minX = Infinity; let maxX = -Infinity;
    let minY = Infinity; let maxY = -Infinity;
    let minZ = Infinity; let maxZ = -Infinity;
    for (const v of vertices) {
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.z > maxZ) maxZ = v.z;
    }
    return { minX, maxX, minY, maxY, minZ, maxZ };
  }

  // The plane a mesh face's own vertices define, as `[nx, ny, nz, d]` with
  // `nx*x + ny*y + nz*z + d === 0` on the plane -- `MeshFace::finalize`'s own
  // best-of-every-triple search, kept for the same reason: three corners that
  // happen to be near-collinear give a plane close to (0,0,0), and the
  // largest cross product among every triple is the one least likely to be
  // that unlucky, on an otherwise-valid but oddly-ordered polygon. Returns
  // null for a face with no real plane at all -- upstream's own "invalid mesh
  // face" case (bzo.bzw's own real-bzfs pass turned up the same failure mode
  // on a flush, tinted box; see docs/bzw.md, "A pad flush with the ground").
  function computeMeshFacePlane(vertices, vertexIndices) {
    let bestLenSq = 0;
    let bestCross = null;
    let bestAt = null;
    const n = vertexIndices.length;
    for (let i = 0; i < n - 2; i++) {
      const vi = vertices[vertexIndices[i]];
      for (let j = i + 1; j < n - 1; j++) {
        const vj = vertices[vertexIndices[j]];
        const edge2 = { x: vi.x - vj.x, y: vi.y - vj.y, z: vi.z - vj.z };
        for (let k = j + 1; k < n; k++) {
          const vk = vertices[vertexIndices[k]];
          const edge1 = { x: vk.x - vj.x, y: vk.y - vj.y, z: vk.z - vj.z };
          const cx = (edge1.y * edge2.z) - (edge1.z * edge2.y);
          const cy = (edge1.z * edge2.x) - (edge1.x * edge2.z);
          const cz = (edge1.x * edge2.y) - (edge1.y * edge2.x);
          const lenSq = (cx * cx) + (cy * cy) + (cz * cz);
          if (lenSq > bestLenSq) {
            bestLenSq = lenSq;
            bestCross = { cx, cy, cz };
            bestAt = vj;
          }
        }
      }
    }
    if (!bestCross || bestLenSq < 1e-20) return null;
    const len = Math.sqrt(bestLenSq);
    const nx = bestCross.cx / len;
    const ny = bestCross.cy / len;
    const nz = bestCross.cz / len;
    const d = -((nx * bestAt.x) + (ny * bestAt.y) + (nz * bestAt.z));
    return [nx, ny, nz, d];
  }

  // A face's own per-edge "fence" planes -- `MeshFace::finalize`'s own
  // precomputation (MeshFace.cxx:201-214): one plane per polygon edge, each
  // containing that edge and perpendicular to the face's own plane, oriented
  // so the polygon's interior is its negative side. A point actually inside a
  // convex face's real 3D area sits on the negative side of every one of
  // these, which needs no 2D projection at all -- unlike a flattened
  // point-in-polygon test, it cannot be fooled by a thin, steeply angled
  // polygon (a cone's narrow wedge face, near its own shared apex) into
  // accepting a point that was never really on it. Returns `[]` alongside a
  // `null` plane -- a degenerate face has no edges worth fencing either.
  function computeMeshFaceEdgePlanes(vertices, vertexIndices, plane) {
    if (!plane) return [];
    const [pnx, pny, pnz] = plane;
    const n = vertexIndices.length;
    const edgePlanes = [];
    for (let v = 0; v < n; v++) {
      const vv = vertices[vertexIndices[v]];
      const vn = vertices[vertexIndices[(v + 1) % n]];
      const ex = vn.x - vv.x;
      const ey = vn.y - vv.y;
      const ez = vn.z - vv.z;
      let nx = (ey * pnz) - (ez * pny);
      let ny = (ez * pnx) - (ex * pnz);
      let nz = (ex * pny) - (ey * pnx);
      const len = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz)) || 1;
      nx /= len; ny /= len; nz /= len;
      const d = -((nx * vv.x) + (ny * vv.y) + (nz * vv.z));
      edgePlanes.push([nx, ny, nz, d]);
    }
    return edgePlanes;
  }

  // Whether a planar face's own vertices wind consistently convex -- the
  // same test upstream's `MeshFace::finalize` runs (MeshFace.cxx:139-151)
  // before it trusts a face's whole polygon: for every vertex, the turn
  // from the incoming edge to the outgoing one must agree with the face's
  // own plane normal. Upstream never plays a mapper's non-convex face as
  // broken, though -- it falls back to triangulating it
  // (`MeshObstacle::addFace`, MeshObstacle.cxx:181-249) rather than either
  // dropping it or handing it to a collision test that assumes convexity,
  // which is exactly what `computeMeshFaceEdgePlanes`'s own per-edge
  // "fence" planes do (a point inside a concave face's real area can sit
  // outside one of those, since a concave shape is not the intersection of
  // its edges' own half-spaces the way a convex one is). `triangulateFace`
  // below is that same fallback, not upstream's exact algorithm (its own
  // scoring picks prettier strips; this only needs a correct, gap-free
  // covering).
  function isFaceConvex(vertices, vertexIndices, plane) {
    const n = vertexIndices.length;
    if (n <= 3) return true;
    const [pnx, pny, pnz] = plane;
    for (let i = 0; i < n; i++) {
      const v0 = vertices[vertexIndices[i]];
      const v1 = vertices[vertexIndices[(i + 1) % n]];
      const v2 = vertices[vertexIndices[(i + 2) % n]];
      const e0x = v1.x - v0.x; const e0y = v1.y - v0.y; const e0z = v1.z - v0.z;
      const e1x = v2.x - v1.x; const e1y = v2.y - v1.y; const e1z = v2.z - v1.z;
      const cx = (e0y * e1z) - (e0z * e1y);
      const cy = (e0z * e1x) - (e0x * e1z);
      const cz = (e0x * e1y) - (e0y * e1x);
      const d = (cx * pnx) + (cy * pny) + (cz * pnz);
      if (d <= 0) return false;
    }
    return true;
  }

  // Ear-clipping a simple (non-self-intersecting) planar polygon into
  // triangles -- upstream's own fallback for a face that fails
  // `isFaceConvex` above. Repeatedly clips a convex corner whose triangle
  // holds none of the polygon's other corners, until three vertices are
  // left, projecting to 2D by dropping whichever axis the face's own plane
  // normal points along most (the ear test only needs positions within the
  // face's own flat plane). Returns `null` -- caller keeps the original
  // face rather than risk a wrong cut -- if no valid ear is ever found,
  // which a genuinely simple polygon should never do.
  function triangulateFacePolygon(vertices, indices, plane) {
    const [pnx, pny, pnz] = plane;
    const ax = Math.abs(pnx); const ay = Math.abs(pny); const az = Math.abs(pnz);
    // Drop whichever axis the normal points along most, keeping the other two
    // in whichever cyclic order (x->y->z->x) makes a positive-signed
    // component project a CCW polygon to a CCW one -- a negative component
    // needs the pair swapped instead, or the ear test's sign convention
    // silently flips for half of all possible face orientations (every axis
    // this picks the same way `computeMeshFacePlane`'s own right-hand-rule
    // cross product already does, just projected rather than kept in 3D).
    let pt;
    if (ax >= ay && ax >= az) {
      pt = (i) => { const v = vertices[i]; return pnx >= 0 ? [v.y, v.z] : [v.z, v.y]; };
    } else if (ay >= ax && ay >= az) {
      pt = (i) => { const v = vertices[i]; return pny >= 0 ? [v.z, v.x] : [v.x, v.z]; };
    } else {
      pt = (i) => { const v = vertices[i]; return pnz >= 0 ? [v.x, v.y] : [v.y, v.x]; };
    }
    const cross2 = (o, a, b) => (((a[0] - o[0]) * (b[1] - o[1])) - ((a[1] - o[1]) * (b[0] - o[0])));

    const remaining = indices.slice();
    const triangles = [];
    let guard = (remaining.length * remaining.length) + 8;
    while (remaining.length > 3 && guard-- > 0) {
      const n = remaining.length;
      let clipped = false;
      for (let i = 0; i < n; i++) {
        const iPrev = (i + n - 1) % n;
        const iNext = (i + 1) % n;
        const a = pt(remaining[iPrev]);
        const b = pt(remaining[i]);
        const c = pt(remaining[iNext]);
        if (cross2(a, b, c) <= 0) continue;
        let containsOther = false;
        for (let j = 0; j < n; j++) {
          if (j === iPrev || j === i || j === iNext) continue;
          const p = pt(remaining[j]);
          const c1 = cross2(a, b, p);
          const c2 = cross2(b, c, p);
          const c3 = cross2(c, a, p);
          if ((c1 >= 0 && c2 >= 0 && c3 >= 0) || (c1 <= 0 && c2 <= 0 && c3 <= 0)) { containsOther = true; break; }
        }
        if (containsOther) continue;
        triangles.push([remaining[iPrev], remaining[i], remaining[iNext]]);
        remaining.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped) return null;
    }
    if (remaining.length === 3) triangles.push(remaining);
    return triangles;
  }

  // A non-convex face split into triangles, each a shallow copy of the
  // original carrying its own three vertices/texcoords/normals -- every
  // other property (texture, matref-resolved fields, passability, phydrv)
  // stays shared, the same as upstream's own triangles all keeping the
  // one face's own material. Falls back to the untouched original,
  // singly, if `triangulateFacePolygon` can't safely clip it.
  function triangulateMeshFace(vertices, face) {
    const tris = triangulateFacePolygon(vertices, face.vertexIndices, face.plane);
    if (!tris) return [face];
    const hasTex = face.texcoordIndices && face.texcoordIndices.length === face.vertexIndices.length;
    const hasNorm = face.normalIndices && face.normalIndices.length === face.vertexIndices.length;
    const posOf = (globalVertexIndex) => face.vertexIndices.indexOf(globalVertexIndex);
    return tris.map((triVertexIndices) => ({
      ...face,
      vertexIndices: triVertexIndices,
      texcoordIndices: hasTex ? triVertexIndices.map((gi) => face.texcoordIndices[posOf(gi)]) : [],
      normalIndices: hasNorm ? triVertexIndices.map((gi) => face.normalIndices[posOf(gi)]) : [],
    }));
  }

  // Bounds plus a per-face plane (and its edge planes), computed once a
  // mesh's vertices are in their final world positions -- a top-level mesh
  // right when it closes, or a `group`-placed one right after its own
  // transform, never on a `define`'s own still-local template
  // (`resolveDefineMeshes` holds those unfinalized, since the same
  // definition may be placed more than once, each landing somewhere
  // different). `baseY` matches every other obstacle's own field, so
  // `getObstacleHeight`/the collision pair's height gate read a mesh the
  // same way they already read a box or a pyramid. A face that fails
  // `isFaceConvex` is replaced here by its own triangulation, root and
  // branch, rather than finalized as-is -- so nothing downstream of this
  // function ever sees a concave face at all, the same guarantee upstream
  // gives every one of its own collision/rendering paths.
  function finalizeMeshGeometry(mesh) {
    mesh.bounds = computeMeshBounds(mesh.vertices);
    mesh.baseY = mesh.bounds ? mesh.bounds.minY : 0;
    // A mesh placed directly in the world, never through any `group`
    // instance, never runs `applyGroupInstanceTransformToMesh`'s own
    // `spinPivot` line above -- give it the same default that line would
    // have (world origin, matching upstream's own hand-authored `drawInfo`).
    if (mesh.angvel && !mesh.spinPivot) mesh.spinPivot = { x: 0, y: 0, z: 0 };
    const finalFaces = [];
    for (const face of mesh.faces) {
      face.plane = computeMeshFacePlane(mesh.vertices, face.vertexIndices);
      if (face.plane && face.vertexIndices.length > 3
        && !isFaceConvex(mesh.vertices, face.vertexIndices, face.plane)) {
        const triFaces = triangulateMeshFace(mesh.vertices, face);
        if (triFaces.length > 1) {
          for (const triFace of triFaces) {
            triFace.plane = computeMeshFacePlane(mesh.vertices, triFace.vertexIndices);
            triFace.edgePlanes = computeMeshFaceEdgePlanes(mesh.vertices, triFace.vertexIndices, triFace.plane);
            finalFaces.push(triFace);
          }
          continue;
        }
        log(`Could not triangulate a non-convex mesh face in ${mesh.name || '(unnamed mesh)'}, using it as-is`);
      }
      face.edgePlanes = computeMeshFaceEdgePlanes(mesh.vertices, face.vertexIndices, face.plane);
      finalFaces.push(face);
    }
    mesh.faces = finalFaces;
    return mesh;
  }

  // Resolves a `define` into the meshes it holds, the same way `resolveDefine`
  // below resolves its plain obstacles -- its own meshes, plus every nested
  // `group` instance's own definition recursively resolved and placed by that
  // instance's transform. A definition `resolveDefine` already found unknown
  // or cyclic reports it for both; this only ever returns fewer meshes in
  // that case, never a second warning for the same thing.
  function resolveDefineMeshes(defName, visiting) {
    const template = defineTemplates.get(defName);
    if (!template || visiting.has(defName)) return [];
    visiting.add(defName);

    const resolved = [...template.meshes];
    const nestedOrdinals = new Map();
    for (const nestedRequest of template.groupInstances) {
      const ordinal = nestedOrdinals.get(nestedRequest.groupDefName) || 0;
      nestedOrdinals.set(nestedRequest.groupDefName, ordinal + 1);
      const nestedLabel = nestedRequest.name || `${nestedRequest.groupDefName}#${ordinal}`;
      const nestedMeshes = resolveDefineMeshes(nestedRequest.groupDefName, visiting);
      resolved.push(...nestedMeshes.map((m) => applyGroupInstanceTransformToMesh(m, nestedRequest, nestedLabel)));
    }

    visiting.delete(defName);
    return resolved;
  }

  // Resolves a `define` into the obstacles it holds, in its own local frame --
  // its plain obstacles as written, plus every nested `group` instance's own
  // definition recursively resolved and placed by that instance's transform.
  // This is real recursion, matching `GroupDefinition::makeGroups`, not the
  // flat single level bzo read before: a `group` found while parsing inside a
  // `define` is a template entry (see the `token === 'group'` branch above),
  // expanded only once something actually places *this* definition.
  //
  // `visiting` is this one call's own root-to-here path, mirroring
  // `GroupDefinition`'s own `active` flag: a definition already on this path
  // is a cycle (through itself, or through others), not ordinary reuse -- two
  // independent instances of the same definition, the way `bzo.bzw`'s two
  // `Watchtower`s are, never touch it, since each starts its own empty path.
  function resolveDefine(defName, visiting) {
    const template = defineTemplates.get(defName);
    if (!template) {
      unknownGroupDefs.add(defName);
      return [];
    }
    if (visiting.has(defName)) {
      groupCycleWarnings.add(defName);
      return [];
    }
    visiting.add(defName);

    const resolved = [...template.obstacles];
    // Ordinal counting is local to this one definition's own nested
    // instances, not shared with the world's top-level list or any other
    // definition's -- `GroupDefinition::appendGroupName` counts only within
    // the one `groups` vector a definition owns, so the same definition
    // placed from two different parents independently starts back at `#0`.
    const nestedOrdinals = new Map();
    for (const nestedRequest of template.groupInstances) {
      const ordinal = nestedOrdinals.get(nestedRequest.groupDefName) || 0;
      nestedOrdinals.set(nestedRequest.groupDefName, ordinal + 1);
      const nestedLabel = nestedRequest.name || `${nestedRequest.groupDefName}#${ordinal}`;
      const nestedMembers = resolveDefine(nestedRequest.groupDefName, visiting);
      resolved.push(...applyGroupInstanceTransform(nestedMembers, nestedRequest, nestedLabel));
    }

    visiting.delete(defName);
    return resolved;
  }

  // Expand every top-level `group` instance now that the whole file (and
  // every `define` in it, however late) has been read -- `group` may name a
  // `define` the file states later, the same deferred resolution upstream
  // gives it.
  const topGroupOrdinals = new Map();
  for (const request of groupInstanceRequests) {
    const ordinal = topGroupOrdinals.get(request.groupDefName) || 0;
    topGroupOrdinals.set(request.groupDefName, ordinal + 1);
    const instanceLabel = request.name || `${request.groupDefName}#${ordinal}`;
    const members = resolveDefine(request.groupDefName, new Set());
    const placed = applyGroupInstanceTransform(members, request, instanceLabel);
    // A teleporter only becomes a real, linkable placement here, at the
    // outermost instance -- one full pass through every enclosing transform,
    // however many levels deep it started. `buildTeleporterLinks` (below,
    // once every instance in the file has run this) glob-matches a `link`
    // block's endpoint names against this list the same way upstream's own
    // `LinkManager::doLinking` does against `OBSTACLEMGR.getTeles()` -- a
    // `link` is never itself scoped inside a `define` (`CustomLink::
    // usesGroupDef` is false upstream), so one written with a wildcard
    // matches every instance uniformly rather than needing one per instance.
    for (const member of placed) {
      if (member.kind === 'teleporter') registerTeleporter(member);
    }
    obstacles.push(...placed);

    // Same instance, its definition's own meshes rather than its box/pyramid
    // members -- `resolveDefineMeshes`/`applyGroupInstanceTransformToMesh`
    // are `resolveDefine`/`applyGroupInstanceTransform`'s own mesh
    // equivalents, so a `group` placing a mesh-only definition (real local
    // maps do this -- `import-Planet-MoFo.com_4202.bzw`'s "base_pillar")
    // reaches `meshes` the same way a box/pyramid one reaches `obstacles`.
    const definedMeshes = resolveDefineMeshes(request.groupDefName, new Set());
    meshes.push(...definedMeshes.map((m) => applyGroupInstanceTransformToMesh(m, request, instanceLabel)));
  }
  if (unknownGroupDefs.size > 0) {
    warn(
      `Ignoring "group" instances naming a "define" not in ${mapLabel}:`
      + ` ${Array.from(unknownGroupDefs).sort().join(', ')}`
    );
  }
  if (groupCycleWarnings.size > 0) {
    warn(
      `Avoided recursion in ${mapLabel}: definition(s) `
      + `${Array.from(groupCycleWarnings).sort().join(', ')} reference themselves `
      + 'through a group instance, directly or through others'
    );
  }

  if (nonVerticalSpinCount > 0) {
    warn(
      `Ignoring ${nonVerticalSpinCount} "spin" line(s) about an axis other than `
      + `vertical in ${mapLabel} -- bzo's box/pyramid model can't tip that way`
    );
  }
  if (unreadZoneKeywords.size > 0) {
    warn(
      `Ignoring zone keywords bzo does not read in ${mapLabel}:`
      + ` ${Array.from(unreadZoneKeywords).sort().join(', ')}`
    );
  }
  if (unreadWeaponKeywords.size > 0) {
    warn(
      `Ignoring weapon keywords bzo does not read in ${mapLabel}:`
      + ` ${Array.from(unreadWeaponKeywords).sort().join(', ')}`
      + ' (those weapons fire on their timer instead)'
    );
  }
  if (unreadWeaponTypes.size > 0) {
    warn(
      `Weapon types bzo does not have in ${mapLabel}:`
      + ` ${Array.from(unreadWeaponTypes).sort().join(', ')}`
      + ' (those weapons fire an ordinary shell)'
    );
  }
  if (unresolvedMaterialRefs.size > 0) {
    warn(
      `Ignoring "matref" naming a material not defined in ${mapLabel}:`
      + ` ${Array.from(unresolvedMaterialRefs).sort().join(', ')}`
    );
  }
  if (unresolvedDynamicColorRefs.size > 0) {
    warn(
      `Ignoring "dyncol" naming a dynamicColor not defined in ${mapLabel}:`
      + ` ${Array.from(unresolvedDynamicColorRefs).sort().join(', ')}`
    );
  }
  if (unresolvedTextureMatrixRefs.size > 0) {
    warn(
      `Ignoring "texmat" naming a textureMatrix not defined in ${mapLabel}:`
      + ` ${Array.from(unresolvedTextureMatrixRefs).sort().join(', ')}`
    );
  }
  if (unresolvedTextureNames.size > 0) {
    warn(
      `Texture name(s) bzo has no local asset for in ${mapLabel}, kept at the `
      + `obstacle's plain default: ${Array.from(unresolvedTextureNames).sort().join(', ')}`
    );
  }
  if (externalTextureUrls.size > 0) {
    // Counted by host, not listed one URL at a time -- a real map can name a
    // few dozen of these (every one of `import-xs.bzexcess.com_5155.bzw`'s
    // own materials does), and every client already attempts every host
    // regardless (`isExternalTextureUrlLoadable`, public/texture.js) -- what
    // is worth a player's attention on join is which hosts this map trusted,
    // not each individual picture.
    const hostCounts = new Map();
    for (const url of externalTextureUrls) {
      let host = 'local';
      try {
        host = new URL(`https:${url}`).host || 'local';
      } catch {
        host = 'local';
      }
      hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
    }
    const summary = Array.from(hostCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([host, count]) => `${count} - ${host}`)
      .join(', ');
    warn(`${mapLabel} textures: ${summary}`);
  }

  // Joined into `obstacles` before the tally below, so "included" counts a
  // mesh along with everything else that actually collides, renders, and
  // shows on radar now -- the same list a client draws from, so the radar,
  // the buried-face test and the box/pyramid fragment builder all see one
  // obstacle list and only have to skip a shape they don't handle, not learn
  // a second array.
  obstacles.push(...meshes);

  // A world-space AABB for every obstacle, in the same `{minX, maxX, minY,
  // maxY, minZ, maxZ}` shape a mesh's own `.bounds` (`computeMeshBounds`,
  // above) already has -- computed once, here, rather than re-derived from
  // `x`/`z`/`w`/`d`/`rotation` inside a hot collision loop every time a
  // query happens to reach this obstacle. `xspan`/`zspan` is upstream's own
  // rotated-rectangle extent formula (`Obstacle::setExtents`,
  // `Obstacle.cxx:87-98`): the half-extent a box or a pyramid's own bounding
  // rectangle needs on each axis to contain every corner at any rotation,
  // exact rather than a looser circle. A mesh already has a real one from
  // its own vertices and is left alone. This is what lets the shared
  // `findTankObstacle` loop (`server/collision.cjs`/`public/collision.mjs`)
  // reject an obstacle that is entirely out of range on any one axis --
  // above, below, or to any one side -- the same one-line way regardless of
  // which of these shapes it actually is.
  for (const obstacle of obstacles) {
    if (obstacle.bounds) continue;
    const x = obstacle.x || 0;
    const z = obstacle.z || 0;
    const rotation = obstacle.rotation || 0;
    const halfW = (obstacle.w || 0) / 2;
    const halfD = (obstacle.d || 0) / 2;
    const cos = Math.abs(Math.cos(rotation));
    const sin = Math.abs(Math.sin(rotation));
    const xSpan = (cos * halfW) + (sin * halfD);
    const zSpan = (cos * halfD) + (sin * halfW);
    const baseY = obstacle.baseY || 0;
    obstacle.bounds = {
      minX: x - xSpan,
      maxX: x + xSpan,
      minY: baseY,
      maxY: baseY + getObstacleHeight(obstacle),
      minZ: z - zSpan,
      maxZ: z + zSpan,
    };
  }

  // Resolves every obstacle's (and every mesh face's) raw `phydrv` string
  // against the driver registry above, the same digit-first-then-name check
  // `matref` uses. Deferred to one pass over the whole obstacle list, rather
  // than resolved inline the way `matref` is, since `phydrv` is set across
  // many different shapes (box, pyramid, a group member, every mesh
  // generator, and a mesh's own per-face default) and one shared pass here
  // is simpler than teaching each of them the same lookup. This also makes
  // bzo strictly more lenient than upstream, which requires a `physics`
  // block to appear before anything referencing it -- no sampled map
  // depends on that stricter order, since a real map always defines its
  // drivers first regardless.
  function resolvePhysicsDriverRef(rawRef) {
    if (!rawRef) return null;
    const driver = /^[0-9]/.test(rawRef)
      ? physicsDriverRegistry[parseInt(rawRef, 10)] || null
      : physicsDriversByName.get(rawRef.toLowerCase()) || null;
    if (!driver) unresolvedPhysicsDriverRefs.add(rawRef.toLowerCase());
    return driver;
  }
  for (const obstacle of obstacles) {
    if (typeof obstacle.phydrv === 'string') {
      obstacle.phydrv = resolvePhysicsDriverRef(obstacle.phydrv);
    }
    if (Array.isArray(obstacle.faces)) {
      for (const face of obstacle.faces) {
        if (typeof face.phydrv === 'string') {
          face.phydrv = resolvePhysicsDriverRef(face.phydrv);
        }
      }
    }
  }
  if (unresolvedPhysicsDriverRefs.size > 0) {
    warn(
      `Ignoring "phydrv" naming a physics driver not defined in ${mapLabel}:`
      + ` ${Array.from(unresolvedPhysicsDriverRefs).sort().join(', ')}`
    );
  }
  if (unreadPhysicsDriverKeywords.size > 0) {
    warn(
      `Physics driver keywords bzo does not read in ${mapLabel}:`
      + ` ${Array.from(unreadPhysicsDriverKeywords).sort().join(', ')}`
    );
  }

  if (unsupportedCounts.size > 0) {
    const dropped = Array.from(unsupportedCounts.values()).reduce((sum, n) => sum + n, 0);
    const droppedList = Array.from(unsupportedCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([keyword, count]) => `${count} ${keyword}`)
      .join(', ');
    warn(`${mapLabel} ignored: ${dropped} unsupported block${dropped === 1 ? '' : 's'} (${droppedList})`);
  }

  if (serverOptions.unreadOptions && serverOptions.unreadOptions.size > 0) {
    const unreadOptionList = Array.from(serverOptions.unreadOptions.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([option, count]) => (count > 1 ? `${option} x${count}` : option))
      .join(', ');
    warn(`${mapLabel} ignored options: ${unreadOptionList}`);
  }

  if (serverOptions.unreadBZDBVars && serverOptions.unreadBZDBVars.length > 0) {
    warn(
      `${mapLabel} ignored -set variables: `
      + Array.from(new Set(serverOptions.unreadBZDBVars)).sort().join(', ')
    );
  }

  if (unreadKeywordCounts.size > 0) {
    const unreadList = Array.from(unreadKeywordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([keyword, count]) => `${keyword} x${count}`)
      .join(', ');
    warn(`${mapLabel} ignored: ${unreadList}`);
  }

  // What a player actually sees when they view or join this map -- not just
  // server.log. `-srvmsg` (serverOptions.serverMessages) reads as a message
  // the *map* says to whoever arrives on it (bzfs.cxx:2507); every "bzo does
  // not do this" fact this function found is the same kind of thing, so it
  // rides along in the same list rather than a separate, re-worded one --
  // `warnedMessages` already carries the exact line each one was logged
  // with. Deduplicated: a second parse of the same file (see
  // `performRemoteMapImportNow`, after baking these back in as `-srvmsg`)
  // re-detects the same facts fresh *and* reads them back off
  // `serverOptions.serverMessages`, so without this every line would say
  // itself twice. Built here, once, per file (see `registerMapFile`): the
  // client reads this from the map's own registry entry and says it locally
  // the moment a player actually starts viewing that map, never during the
  // entry dialog's preview-while-choosing.
  const messages = Array.from(new Set([...serverOptions.serverMessages, ...warnedMessages]));

  // Ground texture (issue #81) -- the one surface that is never an
  // obstacle, so it gets no `matref`d registry entry of its own the way
  // box/pyramid/mesh materials do. Upstream reads either spelling into the
  // same registry entry (see the `-gndtex` comment above), so a map's own
  // explicit `material name GroundMaterial ... end` block -- fuller, since
  // it can also carry a tint `BackgroundRenderer::setupGroundMaterials`
  // reads for `groundColor` -- wins when a map somehow writes both.
  let mapGroundMaterial = null;
  const groundMaterialBlock = materialsByName.get('groundmaterial') || null;
  if (groundMaterialBlock
    && (groundMaterialBlock.texture || groundMaterialBlock.textureUrl || groundMaterialBlock.color)) {
    mapGroundMaterial = {
      texture: groundMaterialBlock.texture,
      textureUrl: groundMaterialBlock.textureUrl,
      color: groundMaterialBlock.color,
      // A `GroundMaterial`'s own `dyncol`/`texmat` (resolved above like any
      // other material's) -- `render.js`'s `buildGround` registers these
      // with `_animatedMaterials` the same way `buildWater` already does.
      dynamicColor: groundMaterialBlock.dynamicColor,
      textureMatrix: groundMaterialBlock.textureMatrix,
    };
  } else if (serverOptions.groundTexture) {
    const resolved = resolveBzwTextureName(serverOptions.groundTexture);
    if (resolved) {
      mapGroundMaterial = { texture: resolved.stock || null, textureUrl: resolved.url || null, color: null };
    }
  }

  const teleporterGraph = buildTeleporterLinks();
  return {
    obstacles,
    teleporterGraph,
    teamMode,
    serverOptions,
    zones,
    weapons,
    mapSize,
    flagHeight: mapFlagHeight,
    noWalls: mapNoWalls,
    freeCtfSpawns: mapFreeCtfSpawns,
    waterLevel: mapWaterLevel,
    weather: serverOptions.weather || null,
    groundMaterial: mapGroundMaterial,
    messages,
    warnedMessages,
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
  mapMessages = mapData.messages;
  MAP_ZONES = mapData.zones;
  // The map's `world size` directive. Applied here, at the one call site that
  // loads the *live* map, rather than as a side effect inside `parseBZWMap`
  // itself -- see that function's own comment on why.
  if (Number.isFinite(mapData.mapSize)) {
    GAME_CONFIG.MAP_SIZE = mapData.mapSize;
    log(`Map option world size: MAP_SIZE=${GAME_CONFIG.MAP_SIZE}`);
  }
  if (Number.isFinite(mapData.flagHeight)) {
    FLAG_HEIGHT = mapData.flagHeight;
    log(`Map option flagHeight: ${FLAG_HEIGHT}`);
  }
  mapNoWalls = mapData.noWalls;
  if (mapNoWalls) log('Map option noWalls: the world border will not be built');
  mapFreeCtfSpawns = mapData.freeCtfSpawns;
  if (mapFreeCtfSpawns) log('Map option freeCtfSpawns: a colour team spawns in any of its zones every life');
  mapWaterLevel = mapData.waterLevel || null;
  if (mapWaterLevel) log(`Map option waterLevel: height=${mapWaterLevel.height}`);
  mapWeather = mapData.weather || null;
  if (mapWeather) log(`Map option _rainType: ${mapWeather.type}`);
  mapGroundMaterial = mapData.groundMaterial || null;
  if (mapGroundMaterial) {
    log(`Map option -gndtex: ${mapGroundMaterial.texture || mapGroundMaterial.textureUrl}`);
  }
  log(`Loaded ${OBSTACLES.length} obstacles from ${mapPath}`);
  const meshObstacleCount = OBSTACLES.filter((obs) => obs.type === 'mesh').length;
  if (meshObstacleCount > 0) {
    log(`${meshObstacleCount} of those are meshes from ${mapPath}`);
  }
  log(`Loaded ${TELEPORTER_GRAPH.links.length} teleporter face links from ${mapPath}`);
  if (MAP_ZONES.length > 0) log(`Loaded ${MAP_ZONES.length} zones from ${mapPath}`);
  WORLD_WEAPONS = mapData.weapons;
  if (WORLD_WEAPONS.length > 0) {
    log(`Loaded ${WORLD_WEAPONS.length} world weapons from ${mapPath}`);
  }
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
// What a map says about how it is driven and shot on, ready for a client to
// lay over its own `gameConfig` -- the map's own `MAP_PHYSICS_VARS` values
// plus whatever those imply. A key the map never states is absent, and the
// viewer keeps the value it already had, which is how upstream reads a BZDB
// variable a world leaves alone.
function deriveMapGameplay(gameplay) {
  if (!gameplay || Object.keys(gameplay).length === 0) return null;
  const overlay = { ...gameplay };
  // `SHOT_DISTANCE` is the client/radar name for the same number, and the
  // reload comes off the same basis the live match derives it from -- both
  // kept here rather than in the client so there is one derivation, not two.
  if (overlay.SHOT_RANGE !== undefined) overlay.SHOT_DISTANCE = overlay.SHOT_RANGE;
  const range = overlay.SHOT_RANGE ?? GAME_CONFIG.SHOT_RANGE;
  const speed = overlay.SHOT_SPEED ?? GAME_CONFIG.SHOT_SPEED;
  const lifetime = overlay.SHOT_LIFETIME ?? GAME_CONFIG.SHOT_LIFETIME;
  if (overlay.SHOT_LIFETIME !== undefined || overlay.SHOT_RANGE !== undefined
    || overlay.SHOT_SPEED !== undefined || overlay.SHOT_MAX_ACTIVE !== undefined) {
    const shotLifetimeMs = Number.isFinite(lifetime) && lifetime > 0
      ? lifetime
      : (range / speed) * 1000;
    overlay.SHOT_RELOAD_TIME = shotLifetimeMs
      / (overlay.SHOT_MAX_ACTIVE ?? GAME_CONFIG.SHOT_MAX_ACTIVE);
    overlay.SHOT_COOLDOWN = overlay.SHOT_RELOAD_TIME;
  }
  return overlay;
}

function registerMapFile(
  fileName, obstacles, teleporterGraph, teamMode, mapSize, messages, noWalls, waterLevel, weather,
  groundMaterial, gameplay
) {
  // Seeded from the map's own geometry (not from `fileName`, so a map that is
  // renamed but not edited still lands on the same clouds and the same hash)
  // -- deterministic across processes, unlike `MAP_SOURCE === 'random'`'s
  // obstacles, which are expected to roll a new hash every boot along with
  // everything else about them.
  const seed = crypto.createHash('sha256')
    .update(JSON.stringify({ obstacles, teleporterGraph })).digest().readUInt32BE(0);
  const entry = {
    obstacles,
    teleporterGraph,
    teamMode,
    clouds: generateClouds(obstacles, seededRandom(seed)),
    // A Map Viewer's ground plane, boundary walls and mountains (issue #68)
    // need to match whichever map it is looking at, not the live match's --
    // see the client's `applyWorldData`.
    mapSize: Number.isFinite(mapSize) ? mapSize : DEFAULT_MAP_SIZE,
    // `noWalls` -- read here rather than derived from `mapSize`, since a Map
    // Viewer preview builds this same border from this same JSON (see
    // `applyWorldData`/`createMapBoundaries` in client.js/render.js) and has
    // no other way to know a map asked for none.
    noWalls: !!noWalls,
    // `waterLevel` -- a Map Viewer preview draws the plane from this same
    // JSON too (see `applyWorldData`/`buildWater` in client.js/render.js),
    // `null` when the map states none.
    waterLevel: waterLevel || null,
    // `weather` -- a Map Viewer preview draws it from this same JSON too (see
    // `applyWorldData`/`buildWeather` in client.js/render.js), `null` when the
    // map states no `_rainType`. Purely a client render: no collision, so
    // there is no server-side equivalent of `mapWaterLevel`'s kill check.
    weather: weather || null,
    // `groundMaterial` -- a Map Viewer preview draws it from this same JSON
    // too (see `applyWorldData`/`buildGround` in client.js/render.js),
    // `null` when the map states no `-gndtex` or `GroundMaterial` block.
    groundMaterial: groundMaterial || null,
    // `gameplay` -- how this map drives and shoots, for a Map Viewer preview
    // to lay over its own `gameConfig` (see `applyWorldData` in client.js).
    // Only what the map itself states, so a preview of a map that says
    // nothing about physics plays by whatever the viewer already had.
    // Deliberately no jumping or ricochet in here (bzo forces both on) and no
    // flag variables (a preview has no flags to grab).
    gameplay: deriveMapGameplay(gameplay),
    // What this map says to a player who arrives on it -- -srvmsg lines and
    // the dropped-unsupported-feature tally, both from parseBZWMap. Read by
    // the client only at the moment it actually starts viewing this map
    // (never during the entry dialog's preview-while-choosing); see
    // `announceWorldMessages` in client.js.
    messages: Array.isArray(messages) ? messages : [],
  };
  const json = JSON.stringify(entry);
  const hash = crypto.createHash('sha256').update(json).digest('hex').slice(0, 12);
  const url = `/maps/${hash}.json`;
  const filePath = path.join(MAP_CACHE_DIR, `${hash}.json`);
  try {
    fs.writeFileSync(filePath, json);
  } catch (error) {
    logError(`Could not write map cache file for ${fileName}:`, error);
    return null;
  }
  precompress.consider(url, filePath, Buffer.from(json));
  // Outside `entry`, not inside it: this runs every time the file is
  // (re-)registered, including on an unchanged re-import, and folding it into
  // the hashed JSON would make an identical map hash differently call to
  // call. `importMapForView`'s freshness check (`IMPORT_REUSE_MS`) is the one
  // reader; nothing else needs a map's age.
  const registered = { fileName, hash, url, registeredAt: Date.now(), ...entry };
  MAP_REGISTRY.set(fileName, registered);
  return registered;
}

// Anything left in `MAP_CACHE_DIR` that no current `MAP_REGISTRY` entry
// names -- a map since removed or edited, or (before clouds were seeded
// deterministically) simply a previous boot's copy of the same map. Run once
// the background trickle below has registered everything this process ever
// will, so a file mid-registration is never mistaken for an orphan.
function sweepMapCache() {
  const expected = new Set(Array.from(MAP_REGISTRY.values(), (entry) => `${entry.hash}.json`));
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
    const match = name.match(/^(.+\.json)\.[0-9a-f]+\.br$/);
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
  for (const fileName of listAvailableMapFiles()) {
    if (!parseImportMapFileName(fileName)) continue;
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
    if (Date.now() - stats.mtimeMs < IMPORT_MAX_AGE_MS) continue;
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

const LIVE_MAP_ENTRY = MAP_SOURCE === 'random'
  ? registerMapFile(
    'random', OBSTACLES, TELEPORTER_GRAPH, mapTeamMode, GAME_CONFIG.MAP_SIZE, mapMessages, mapNoWalls,
    mapWaterLevel, null, null, null
  )
  : registerMapFile(
    MAP_SOURCE, OBSTACLES, TELEPORTER_GRAPH, mapTeamMode, GAME_CONFIG.MAP_SIZE, mapMessages, mapNoWalls,
    mapWaterLevel, mapWeather, mapGroundMaterial, mapServerOptions.gameplay
  );

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
  const pending = listAvailableMapFiles()
    .filter((fileName) => fileName !== 'random' && !MAP_REGISTRY.has(fileName));
  const total = pending.length;
  let converted = 0;
  const step = () => {
    const fileName = pending.shift();
    if (!fileName) {
      // One line for the whole pass rather than one per file (see `quiet`
      // above): still worth knowing the trickle ran and how much of it
      // landed, the same reasoning `sweepMapCache`'s own summary line below
      // already follows.
      if (total > 0) log(`Converted ${converted} of ${total} bzw file(s) to cached json`);
      // Everyone already connected is holding whatever list this trickle had
      // reached when their `init` went out -- which, on a restart that
      // clients auto-rejoin into (see AGENTS.md), is routinely a short one.
      // Nothing else ever revisits it, so the picker would stay missing
      // maps until a reload. One push at the end of the pass fixes that for
      // every open client at once.
      if (converted > 0) broadcastMapList();
      sweepMapCache();
      sweepStaleImports();
      precompress.start({ log }).catch((error) => logError('[BR] map hashing pass failed:', error));
      return;
    }
    try {
      const filePath = resolveMapFilePath(fileName);
      if (filePath) {
        // Nobody is playing this file -- it is only here to keep the Map
        // Viewer's hash list current -- so its own quirks are for whoever
        // actually views or joins it to see (`mapData.messages`, still
        // built either way), not a log line about a map nobody chose today.
        const mapData = parseBZWMap(filePath, { quiet: true });
        if (registerMapFile(
          fileName, mapData.obstacles, mapData.teleporterGraph, mapData.teamMode, mapData.mapSize,
          mapData.messages, mapData.noWalls, mapData.waterLevel, mapData.weather, mapData.groundMaterial,
          mapData.serverOptions.gameplay
        )) {
          converted += 1;
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
// How the live map says it is driven and shot on: its `MAP_PHYSICS_VARS`
// variables and its `-ms`, which upstream's own map files state side by side
// and which bzo applies together for the same reason -- each shot slot comes
// back after _reloadTime / maxShots, so changing one without the other leaves
// a tank reloading at the wrong rate. `deriveShotReloadTime` runs once, after
// the whole block, rather than once per variable.
//
// A Map Viewer preview gets the same set from its own map instead, per map
// (`deriveMapGameplay`), which is the only place the two can disagree.
{
  const applied = [];
  for (const [key, value] of Object.entries(mapServerOptions.gameplay || {})) {
    if (GAME_CONFIG[key] === value) continue;
    applied.push(`${key}=${value} (was ${GAME_CONFIG[key]})`);
    GAME_CONFIG[key] = value;
  }
  if (applied.length > 0) {
    GAME_CONFIG.SHOT_DISTANCE = GAME_CONFIG.SHOT_RANGE;
    deriveShotReloadTime();
    resolveWingsAliases();
    log(`Map physics: ${applied.join(', ')}, shotReloadTime=${GAME_CONFIG.SHOT_RELOAD_TIME}ms`);
  }
  // Upstream prints "WARNING: tanks will not be able to shoot" the moment it
  // reads `-ms 0` (CmdLineOptions.cxx:904). Said here instead of there so
  // that it covers a `server.json` asking for it as well as a map, and so it
  // is said once rather than once per source.
  if (GAME_CONFIG.SHOT_MAX_ACTIVE === 0) {
    log('Shots: no shot slots -- tanks cannot shoot on this world');
  }
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
// -set _maxBumpHeight upstream (LocalPlayer.cxx:534). Purely a client value --
// bzo's own bump-climb is client-side only, `server.js` never resolves tank
// motion -- but it rides `GAME_CONFIG` to the client the same way every other
// BZDB-backed number here does.
if (Number.isFinite(mapServerOptions.maxBumpHeight)
  && mapServerOptions.maxBumpHeight !== GAME_CONFIG.MAX_BUMP_HEIGHT) {
  const previousBumpHeight = GAME_CONFIG.MAX_BUMP_HEIGHT;
  GAME_CONFIG.MAX_BUMP_HEIGHT = mapServerOptions.maxBumpHeight;
  log(`Map option -set _maxBumpHeight: ${GAME_CONFIG.MAX_BUMP_HEIGHT} (was ${previousBumpHeight})`);
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
  players.forEach((candidate) => {
    candidate.wins = 0;
    candidate.losses = 0;
    // Whoever the previous match's game-over held dead gets back in: nothing
    // else was going to lift that hold, since the respawn timeout that would
    // have revived them already saw `matchClock.gameOver` and gave up.
    if (!isObserverTeam(candidate.team) && !candidate.alive) {
      candidate.respawn();
      broadcastPlayerRecord('alive', candidate);
    }
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
      type: 'message', src: -1, dst: 0, msgType: 'server',
      text: `Match duration is ${formatDuration(GAME_CONFIG.TIME_LIMIT)}`, ts: Date.now(),
    });
    log(`Match started: ${GAME_CONFIG.TIME_LIMIT}s`);
  } else {
    matchClock.active = false;
    // Clears a client's stale "GAME OVER" from a previous score-limit ending,
    // which nothing else would: with no clock there is no zero-crossing
    // `timeUpdate` to double as that signal.
    broadcastAll({ type: 'timeUpdate', timeLeft: null });
    broadcastAll({
      type: 'message', src: -1, dst: 0, msgType: 'server', text: 'Match started', ts: Date.now(),
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

// bzfs.cxx:3287. Spawning closes the window in which a deposed rabbit's shots
// are nobody's team kill, and takes the rabbit if the world has none.
function handleRabbitSpawn(player) {
  if (!RABBIT_SELECTION) return;
  player.wasRabbit = false;
  if (rabbitPlayerId === null) anointNewRabbit();
}
// The live world's real object geometry, for whoever needs to read it back --
// `LIVE_MAP_ENTRY` (above) already hashed and wrote it to
// `MAP_CACHE_DIR`/`<hash>.json` before this line runs, so the file is there
// to open directly instead of a multi-hundred-KB single log line.
log(`World obstacles cached at ${path.join(MAP_CACHE_DIR, `${LIVE_MAP_ENTRY.hash}.json`)} (${LIVE_MAP_ENTRY.url})`);

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
    // A mesh (a plain `mesh`, or any of the six generators, all of which
    // finish as `type: 'mesh'`) has no `.h` at all -- its real extent is
    // `.bounds`, the world-space vertex box `computeMeshBounds` already
    // computed. Falling through to the box/pyramid-style `baseY + h` below
    // for one of these silently answers 4 units tall regardless of its real
    // height (a tree, a tall building), which is short enough that clouds
    // end up level with a real map's own rooftops instead of above them.
    if (obstacle?.bounds && Number.isFinite(obstacle.bounds.maxY)) {
      return Math.max(maxTop, obstacle.bounds.maxY);
    }
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

// Generate random clouds with fractal patter. `random` defaults to `Math.random`
// but `registerMapFile` passes a seeded one: clouds ride into the hashed,
// cached world file (see `MAP_REGISTRY`), and a hash that changed every boot
// for the same map -- because the decoration on top of it kept re-rolling --
// would defeat the whole reason that cache exists.
function generateClouds(obstacles = OBSTACLES, random = Math.random) {
  const clouds = [];
  const numClouds = 15;
  const maxObstacleTopY = getMaxObstacleTopY(obstacles);
  const jumpApexHeight = getJumpApexHeight();
  const cloudBaseY = maxObstacleTopY + jumpApexHeight;

  for (let i = 0; i < numClouds; i++) {
    // Random position in sky
    const x = (random() - 0.5) * 200;
    const y = cloudBaseY + random() * 40;
    const z = (random() - 0.5) * 200;

    // Fractal puffs (multiple spheres clustered together)
    const puffs = [];
    const numPuffs = 5 + Math.floor(random() * 8);

    for (let j = 0; j < numPuffs; j++) {
      puffs.push({
        offsetX: (random() - 0.5) * 10,
        offsetY: (random() - 0.5) * 3,
        offsetZ: (random() - 0.5) * 10,
        radius: 2 + random() * 4
      });
    }

    clouds.push({ x, y, z, puffs });
  }

  return clouds;
}

// A small, deterministic PRNG (mulberry32) seeded from the map's own
// obstacles/teleporters, so the same map always rolls the same clouds --
// across a restart, not just within one process -- which is what lets its
// world file keep the same hash and never orphan the one before it.
function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
    // Set from the session cookie on the handshake, and from nothing else. The
    // id is kept so a login on a second device can invalidate this one; it is
    // never sent to a client. See `isAdmin` and docs/login-plan.md.
    this.sessionId = null;
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
    this.rotation = 0;
    this.alive = false;
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
    this.verticalVelocity = 0;
    this.isJumping = false;
    this.lastJumpTime = 0;
    this.onObstacle = false;
    this.connectDate = new Date();
    this.tankModel = 'bzflag';
    // Teams are server-authoritative. Observer is receive-only and non-combatant.
    this.team = 'rogue';
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
    this.alive = true;
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
    handleRabbitSpawn(this);
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
      rotation: this.rotation,
      alive: this.alive,
      wins: this.wins,
      losses: this.losses,
      tks: this.tks,
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
        // Don't go below this tank's own ground, which for Burrow is
        // `_burrowDepth`: getDeadReckoning clamps to the same limit
        // (Player.cxx:1333), and a server that clamped at zero would put a
        // burrowed tank's hit box a metre and a third above where it is.
        y: Math.max(getGroundLimit(getPlayerFlag(this.id)?.type ?? null), this.y + dy),
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

    // A physics driver's push, the same shared lookup the client's own
    // motion step uses (`resolvePhysicsDriverAt`) -- so an honest client
    // riding a conveyor still extrapolates to roughly where it actually
    // ends up, and `validateMovement`'s drift check does not mistake the
    // push for cheating. Vertical always applies, matching `linear`'s own
    // z-component upstream adds unconditionally; horizontal only while on
    // ground, which this branch already is.
    const driver = getSupportPhysicsDriver(this.x, this.y, this.z);
    const driverLinear = (driver && driver.linear) || null;
    const driverDx = driverLinear ? driverLinear[0] * dt : 0;
    const driverDy = driverLinear ? driverLinear[1] * dt : 0;
    const driverDz = driverLinear ? driverLinear[2] * dt : 0;

    if (Math.abs(rs) < 0.001) {
      // Straight line motion (or sliding)
      const dx = -Math.sin(moveDirection) * fs * speed * dt;
      const dz = -Math.cos(moveDirection) * fs * speed * dt;
      return { x: this.x + dx + driverDx, y: this.y + driverDy, z: this.z + dz + driverDz, r: newR };
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
        x: cx + newDx + driverDx,
        y: this.y + driverDy,
        z: cz + newDz + driverDz,
        r: this.rotation + theta
      };
    }
  }
}

// Projectile class
class Projectile {
  constructor(id, playerId, shotSlot, x, y, z, dirX, dirZ, dirY = 0, flag = null, now = Date.now()) {
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
    this.y = y || 2.2; // Default height if not specified (tank height + barrel height)
    this.z = z;
    this.dirX = dirX;
    this.dirY = dirY;
    this.dirZ = dirZ;
    this.createdAt = now;
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
function replyToPlayer(player, text) {
  sendToPlayer(player, {
    type: 'message',
    src: -1,
    dst: player.id,
    msgType: 'server',
    text,
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
    replyToPlayer(player, `${player.name}, the /me command requires an argument`);
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

// CmdList (commands.cxx:467). The names only; `/<prefix>?` is what shows help.
defineCommand('/?', COMMAND_TIER.OPEN,
  '- display the list of server-side commands',
  (player) => {
    const names = [...SERVER_COMMANDS.values()]
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
    for (const command of [...SERVER_COMMANDS.values()].sort((a, b) => a.name.localeCompare(b.name))) {
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

// UpTimeCommand (commands.cxx:1015). Upstream appends a full stop, which is the
// only punctuation in any of these replies and is kept for that reason.
defineCommand('/uptime', COMMAND_TIER.OPEN,
  "- show the server's uptime",
  (player) => {
    replyToPlayer(player, `${formatDuration((Date.now() - SERVER_START_TIME) / 1000)}.`);
  });

// ServerQueryCommand (commands.cxx:1000) answers "BZFS Version: <version>". bzo
// is not bzfs and says so, and adds the build id: two bzo servers on the same
// release differ by that and by nothing else a player can see.
defineCommand('/serverquery', COMMAND_TIER.OPEN,
  '- show the server version',
  (player) => {
    replyToPlayer(player, `bzo Version: ${SERVER_VERSION} (build ${CLIENT_BUILD})`);
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
  });

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
      replyToPlayer(player, target.error || 'Usage: /kill <#slot|PlayerName> [reason]');
      return;
    }
    const victim = players.get(target.id);
    if (!victim || victim.team === PLAYER_TEAM.OBSERVER) {
      replyToPlayer(player, 'An observer has no tank to kill');
      return;
    }
    if (!victim.alive) {
      replyToPlayer(player, `"${victim.name}" is already dead`);
      return;
    }
    // Through the one death path, so the flag, the lock, the rabbit and the
    // respawn all happen -- see applyDeath.
    killPlayer(victim, victim, DEATH_REASON.SELF_DESTRUCT);
    log(`[CMD] "${player.name}" killed "${victim.name}"${target.rest ? `: ${target.rest}` : ''}`);
    replyToPlayer(player, `"${victim.name}" killed`);
    replyToPlayer(victim, target.rest
      ? `You were killed by an operator: ${target.rest}`
      : 'You were killed by an operator');
  });

// CountdownCommand (commands.cxx:1252). Upstream's own pre-match delay -- the
// "3...2...1...GO" chat countdown before the clock actually starts -- is not
// reproduced here; the bare form starts the match at once. `pause`/`resume`
// are the two upstream verbs that still mean something without it.
defineCommand('/countdown', COMMAND_TIER.OPERATOR,
  '[pause|resume] - (re)start, pause, or resume the match clock',
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
    if (arg) {
      replyToPlayer(player, 'Usage: /countdown [pause|resume]');
      return;
    }
    startMatch();
    log(`[CMD] "${player.name}" started the match`);
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
    broadcastAll({ type: 'message', src: -1, dst: 0, msgType: 'server', text: args, ts: Date.now() });
  });

// MuteCommand, UnmuteCommand, MuteListCommand (BanCommands.cxx:215). Upstream
// removes the `talk` permission; bzo keeps a flag for the session, which is the
// same thing without a users file to write it to.
defineCommand('/mute', COMMAND_TIER.OPERATOR,
  '<#slot|PlayerName|"Player Name"> - remove the ability for a player to communicate with other players',
  (player, args) => {
    const target = resolveCommandTarget(args);
    if (!target.id) {
      replyToPlayer(player, target.error || 'Usage: /mute <#slot|PlayerName>');
      return;
    }
    const victim = players.get(target.id);
    victim.muted = true;
    log(`[CMD] "${player.name}" muted "${victim.name}"`);
    replyToPlayer(player, `"${victim.name}" is now muted`);
    replyToPlayer(victim, 'You have been muted by an operator');
  });

defineCommand('/unmute', COMMAND_TIER.OPERATOR,
  '<#slot|PlayerName|"Player Name"> - restore the TALK permission to a previously muted player',
  (player, args) => {
    const target = resolveCommandTarget(args);
    if (!target.id) {
      replyToPlayer(player, target.error || 'Usage: /unmute <#slot|PlayerName>');
      return;
    }
    const victim = players.get(target.id);
    victim.muted = false;
    log(`[CMD] "${player.name}" unmuted "${victim.name}"`);
    replyToPlayer(player, `"${victim.name}" is no longer muted`);
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
defineCommand('/playerlist', COMMAND_TIER.OPERATOR,
  '- list player slots, names and IP addresses',
  (player) => {
    const joined = [...players.values()].filter((other) => other.joined);
    if (joined.length === 0) {
      replyToPlayer(player, 'Nobody is here');
      return;
    }
    for (const other of joined) {
      const marks = [
        other.muted ? 'muted' : null,
        other.localAdmin ? 'local' : null,
        other.verified ? `verified as ${other.globalCallsign}` : null,
      ].filter(Boolean);
      replyToPlayer(player, `#${other.id} ${other.name} [${other.team}] ${other.clientIP || 'unknown'}`
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
function announceToAdmins(actor, text) {
  const payload = JSON.stringify({
    type: 'message',
    src: -1,
    dst: -3,
    msgType: 'server',
    text,
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
          replyToPlayer(player, target.error || 'Usage: /flag drop [#slot|PlayerName]');
          return;
        }
        subject = players.get(target.id);
      }
      const flag = getPlayerFlag(subject.id);
      if (!flag) {
        replyToPlayer(player, subject === player
          ? 'You are not carrying a flag'
          : `"${subject.name}" is not carrying a flag`);
        return;
      }
      // Whatever the flag's own rules say happens when it leaves a tank: a
      // sticky one is zapped rather than dropped, exactly as dying with it
      // would, so this cannot be used to plant a bad flag for somebody else.
      const abbreviation = flag.type || 'none';
      dropPlayerFlag(subject.id);
      log(`[CMD] "${player.name}" dropped ${abbreviation} from "${subject.name}"`);
      replyToPlayer(player, `Dropped ${abbreviation} from "${subject.name}"`);
      if (subject !== player) replyToPlayer(subject, `Your ${abbreviation} flag was dropped`);
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
      replyToPlayer(player, `${count} flags sent up`);
      return;
    }
    if (what === 'reset') {
      let count = 0;
      flags.forEach((flag) => {
        resetFlag(flag);
        count += 1;
      });
      log(`[CMD] "${player.name}" reset ${count} flags`);
      replyToPlayer(player, `${count} flags reset`);
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
      flags.forEach((flag) => replyToPlayer(player, formatFlagInfo(describeFlagForCommand(flag))));
      // bzo's own half of the answer. A superflag nobody is holding travels
      // anonymous (`getFlagState`) and a client remembers every identity it is
      // ever told (`keepFlagIdentity`), so the same reply also sends this one
      // operator the unhidden states: the text says what flag #7 is, and this
      // says which of the flags on the field is #7.
      const now = Date.now();
      sendToPlayer(player, {
        type: 'flagUpdate',
        flags: flags.map((flag) => getFlagState(flag, now, { reveal: true })),
      });
      return;
    }
    if (what === 'take') {
      const target = resolveCommandTarget(rest);
      if (!target.id) {
        replyToPlayer(player, target.error || 'Usage: /flag take <#slot|PlayerName>');
        return;
      }
      const subject = players.get(target.id);
      const flag = getPlayerFlag(subject.id);
      if (!flag) {
        replyToPlayer(player, `/flag take: player (${subject.name}) does not have a flag`);
        return;
      }
      const abbreviation = flag.type;
      const index = flag.index;
      // resetFlag, which is upstream's own choice here and the whole difference
      // from `/flag drop`: the flag goes back to a spawn point rather than onto
      // the ground the tank is standing on.
      resetFlag(flag);
      const notice = `${player.name} took flag ${abbreviation}/${index} from ${subject.name}`;
      log(`[CMD] "${player.name}" took ${abbreviation}/${index} from "${subject.name}"`);
      replyToPlayer(player, notice);
      announceToAdmins(player, notice);
      return;
    }
    if (what === 'give') {
      const target = resolveCommandTarget(rest);
      if (!target.id) {
        replyToPlayer(player, target.error
          || 'Usage: /flag give <#slot|PlayerName> <#flagId|FlagAbbr> [force]');
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
          replyToPlayer(player, `flag ${argv[0]} is not in this world`);
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
          replyToPlayer(player, `flag ${argv[0]} is an empty slot`);
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
        replyToPlayer(player, `/flag give: player (${subject.name}) is not alive`);
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
      const notice = `${player.name} gave flag ${abbreviation}/${flag.index} to ${subject.name}`;
      log(`[CMD] "${player.name}" gave ${abbreviation}/${flag.index} to "${subject.name}"`);
      replyToPlayer(player, notice);
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
  '[player] <x,z|x,y,z|x,y,z,facing> [facing] - move a tank to a position; height optional, facing a compass point or degrees',
  (player, args) => {
    // A target is optional, so the first token is only a target if it does not
    // parse as coordinates.
    let subject = player;
    let rest = args.trim();
    const firstToken = rest.split(/\s+/)[0] || '';
    if (!/^-?[\d.]/.test(firstToken)) {
      const target = resolveCommandTarget(rest);
      if (!target.id) {
        replyToPlayer(player, target.error || 'Usage: /mv [player] <x,z> [facing]');
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
      replyToPlayer(player, 'An observer has no tank to move');
      return;
    }

    // `parseMoveCoordinates` resolved it: a compass point and an angle are two
    // spellings of the same thing by the time it hands one back.
    const rotation = parsed.rotation === null ? subject.rotation : parsed.rotation;
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
    let y;
    if (parsed.y !== null
      && !checkCollision(parsed.x, parsed.y, parsed.z, 2, { rotation, suppressLog: true })) {
      y = parsed.y;
    } else {
      y = dropSpawnPosition(parsed.x, parsed.y === null ? 0 : parsed.y, parsed.z, rotation);
    }
    if (y === null) {
      replyToPlayer(player, `Nowhere to stand at ${parsed.x},${parsed.z}`);
      return;
    }

    subject.x = parsed.x;
    subject.y = y;
    subject.z = parsed.z;
    subject.rotation = rotation;
    // As the observer heartbeat does for the same reason: the tank arrives
    // stopped, and the drift check must not integrate the old velocities across
    // the jump.
    subject.forwardSpeed = 0;
    subject.rotationSpeed = 0;
    subject.verticalVelocity = 0;
    subject.airVelocityX = 0;
    subject.airVelocityZ = 0;
    subject.jumpDirection = null;
    subject.slideDirection = undefined;
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
      x: subject.x, y: subject.y, z: subject.z, r: subject.rotation, vv: 0,
    });
    broadcast({
      type: 'pm',
      id: subject.id,
      x: subject.x, y: subject.y, z: subject.z, r: subject.rotation,
      fs: 0, rs: 0, vv: 0, vx: 0, vz: 0,
    }, subject.ws);

    const where = `${subject.x.toFixed(1)},${subject.y.toFixed(1)},${subject.z.toFixed(1)}`
      + ` facing ${rotationToBearingName(subject.rotation)}`;
    log(`[CMD] "${player.name}" moved "${subject.name}" to ${where}`);
    // Echoed because the height was resolved rather than given: seeing where the
    // tank actually landed is how a mistyped coordinate shows itself.
    replyToPlayer(player, subject === player
      ? `Moved to ${where}`
      : `"${subject.name}" moved to ${where}`);
    if (subject !== player) replyToPlayer(subject, `An operator moved you to ${where}`);
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
        replyToPlayer(player, target.error || 'Usage: /pos [player]');
        return;
      }
      subject = players.get(target.id);
    }
    if (subject.team === PLAYER_TEAM.OBSERVER) {
      replyToPlayer(player, 'An observer has no tank position');
      return;
    }
    const where = `${subject.x.toFixed(2)},${subject.y.toFixed(2)},${subject.z.toFixed(2)}`;
    log(`[POS] "${player.name}" checked "${subject.name}": pos=(${where}), r=${subject.rotation.toFixed(2)},`
      + ` fs=${(subject.forwardSpeed || 0).toFixed(2)}, rs=${(subject.rotationSpeed || 0).toFixed(2)},`
      + ` vv=${(subject.verticalVelocity || 0).toFixed(2)}`);
    replyToPlayer(player, subject === player
      ? `You are at ${where} facing ${rotationToBearingName(subject.rotation)}`
      : `"${subject.name}" is at ${where} facing ${rotationToBearingName(subject.rotation)}`);
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
  'serverName', 'motd', 'shotMaxActive', 'ricochet', 'timeLimit', 'timeManualStart', 'maxPlayerScore', 'maxTeamScore',
]);
// A server's own name, not upstream's -- bzfs has no such thing to cap.
// Well under the 120 characters `/api/list-server/report` accepts for the
// same value as its `title` field, so a name typed here is never silently
// truncated on the way to `/list`.
const SERVER_NAME_MAX_LENGTH = 60;
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
    serverName: serverConfig.serverName || '',
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
    ...Object.fromEntries(Object.entries(OPERATOR_TEAM_LIMIT_KEYS)
      .map(([key, team]) => [key, limits[team]])),
  };
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
    } else if (key === 'rabbit') {
      // `false` is the config's own off position, and what resolveRabbitSelection
      // reads; `"off"` is the row's.
      config.rabbit = value === 'off' ? false : value;
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
  if (has('serverName')) {
    if (typeof requested.serverName !== 'string') return { error: 'Invalid server name value' };
    const serverName = requested.serverName.trim();
    if (!serverName) return { error: 'Server name cannot be empty' };
    if (serverName.length > SERVER_NAME_MAX_LENGTH) {
      return { error: `Server name must be ${SERVER_NAME_MAX_LENGTH} characters or fewer` };
    }
    next.serverName = serverName;
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

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    writeOperatorConfigFields(config, next);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (error) {
    logError(`Failed to update config at ${configPath}:`, error);
    return { error: 'Failed to update config' };
  }

  const changed = [];
  if (next.serverName !== undefined) {
    serverConfig.serverName = next.serverName;
    changed.push('serverName');
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
      src: -1,
      dst: 0,
      msgType: 'server',
      text: next.ricochet ? 'All shots now ricochet' : 'Shots no longer ricochet',
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

  // A new game rather than a live change: the world, the team layout and the flag
  // pool are resolved once at boot, so the only honest way to apply one of these
  // is to start over. Written to `server.json` above; this is what makes the
  // clients follow. A staged value that already matches is not one of them, so
  // pressing the button on a change and its own undo restarts nothing.
  const newGame = Object.keys(next)
    .filter((key) => !LIVE_CONFIG_KEYS.includes(key) && next[key] !== current[key]);
  if (newGame.length > 0) {
    changed.push(...newGame);
    log(`Config changed by ${byWhom}: ${changed.join(', ')}; starting a new game`);
    requestServerRestart(`${byWhom} changed ${changed.join(', ')}`);
    return { changed, restarted: true };
  }

  broadcastAll({
    type: 'serverConfigUpdate',
    serverName: serverConfig.serverName || '',
    motd: serverConfig.motd || '',
    shotMaxActive: GAME_CONFIG.SHOT_MAX_ACTIVE,
    ricochet: GAME_CONFIG.ALL_SHOTS_RICOCHET,
    timeLimit: GAME_CONFIG.TIME_LIMIT,
    timeManualStart: GAME_CONFIG.TIME_MANUAL_START,
    maxPlayerScore: GAME_CONFIG.MAX_PLAYER_SCORE,
    maxTeamScore: GAME_CONFIG.MAX_TEAM_SCORE,
  });
  log(`Config changed by ${byWhom}: ${changed.length ? changed.join(', ') : 'nothing'}`);
  return { changed, restarted: false };
}

// SetCommand and ResetCommand (commands.cxx:120, :129). Upstream's `/set` walks
// the whole of BZDB; bzo's world constants are constants (see AGENTS.md), so the
// honest set is the one the Operator panel already changes *and propagates* --
// anything else would move on the server and leave every client predicting
// against the old value.
//
// The panel and this write through the same two functions, which is the rule
// docs/commands-plan.md sets for a command that shares an action with the panel.
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

defineCommand('/set', COMMAND_TIER.OPERATOR,
  '[ var [ value ] ] - set a server variable to value, or display variables',
  (player, args) => {
    const [name, ...valueParts] = args.trim().split(/\s+/).filter(Boolean);
    if (!name) {
      replyToPlayer(player, 'Settable variables (use /set <var> <value>):');
      for (const [variable, spec] of Object.entries(SETTABLE_VARIABLES)) {
        replyToPlayer(player, `${variable} ${spec.describe()}`);
      }
      // Said rather than left to be discovered: bzo's other world values are
      // compiled-in constants and a `/set` that silently did nothing would be
      // worse than one that explains itself.
      replyToPlayer(player, 'Everything else is a world constant on this server');
      return;
    }
    const spec = SETTABLE_VARIABLES[name];
    if (!spec) {
      replyToPlayer(player, `"${name}" is not settable on this server`);
      return;
    }
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
function handleServerCommand(player, text) {
  if (!isCommandLine(text)) return false;

  // CmdHelp (commands.cxx:476): `/co?` is the help for every command starting
  // with `co`. Asked before the table, since `/?` is itself a name.
  const helpPrefix = SERVER_COMMANDS.has(text.trim().toLowerCase()) ? null : parseHelpPrefix(text);
  if (helpPrefix !== null) {
    const matches = [...SERVER_COMMANDS.values()]
      .filter((command) => command.name.startsWith(helpPrefix) && canRunCommand(player, command))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (matches.length === 0) {
      replyToPlayer(player, `No command starting with ${helpPrefix}`);
    } else {
      for (const command of matches) replyToPlayer(player, `${command.name} ${command.help}`);
    }
    log(`[CMD] "${player.name}": ${text}`);
    return true;
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
    replyToPlayer(player, `You do not have permission to run the ${command.name} command`);
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
// `targetId` is a player id, or one of bzo's small negatives -- 0 all, -1 the
// server's log, -2 team, -3 the admin channel.
function deliverChatMessage(player, targetId, msgType, text) {
  const fromId = player.id;
  const fromName = player.name;

  // A muted player has no `talk` permission upstream, and this is upstream's own
  // sentence for it (bzfs.cxx:1667). The exception is upstream's too: somebody
  // who may still send on the admin channel does, which is what leaves a muted
  // player a way to ask about it.
  if (player.muted && !(targetId === -3 && isAdmin(player))) {
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
    if (id === 0) return 'ALL';
    if (id === -1) return 'SERVER';
    if (id === -2) return `[${player.team.toUpperCase()}]`;
    if (id === -3) return '[ADMIN]';
    return players.has(id) ? `"${players.get(id).name}"` : `"Player ${id}"`;
  };
  const toName = describeChatTarget(targetId);

  // Log locally only if to == -1
  if (targetId === -1) {
    log(`[CHAT] "${fromName}"->${toName}: ${text}`);
    return;
  }

  // Broadcast to all if to == 0
  if (targetId === 0) {
    log(`[CHAT] "${fromName}"->ALL: ${text}`);
    broadcastAll({
      type: 'message',
      src: fromId,
      dst: 0,
      msgType,
      text,
      ts: Date.now(),
    });
    return;
  }

  // Team chat. bzfs's own team dispatch sends to every player whose
  // `isTeam(_team)` matches the destination, with no exception for Rogue or
  // Observer -- which is the rule the `voice-channels` pair already spells out
  // for the Team voice channel, so both use it. The sender is included: a
  // message you cannot see you have sent is worse than one echoed back.
  if (targetId === -2) {
    log(`[CHAT] "${fromName}"->${toName}: ${text}`);
    const payload = {
      type: 'message',
      src: fromId,
      dst: -2,
      msgType,
      text,
      ts: Date.now(),
    };
    const encoded = JSON.stringify(payload);
    players.forEach((other) => {
      if (other.team !== player.team) return;
      if (other.ws && other.ws.readyState === 1) other.ws.send(encoded);
    });
    return;
  }

  // The admin channel. Upstream gates both ends of it and answers a sender with
  // no permission in its own words (bzfs.cxx:1546), rather than dropping the
  // message silently -- somebody typing into a channel nobody hears should be
  // told.
  if (targetId === -3) {
    if (!isAdmin(player)) {
      log(`[CHAT] "${fromName}"->[ADMIN] refused: not an admin`);
      replyToPlayer(player, 'You do not have permission to speak on the admin channel.');
      return;
    }
    log(`[CHAT] "${fromName}"->[ADMIN]: ${text}`);
    const payload = JSON.stringify({
      type: 'message',
      src: fromId,
      dst: -3,
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
  const nameTaken = Array.from(players.values()).some(p => p.id !== excludeId && p.name && p.name.toLowerCase() === name.toLowerCase());
  if (nameTaken) {
    // Assign 'Player n' for their own player number
    if (playerNumber !== null) {
      return `Player ${playerNumber}`;
    }
  }
  return name;
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
    if (other.id === player.id || !other.joined) continue;
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
        src: -1,
        dst: other.id,
        msgType: 'server',
        text: `You signed in as ${callsign} on another device.`,
      });
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
      src: -1,
      dst: other.id,
      msgType: 'server',
      text: `${callsign} signed in with that name, so yours is now ${assigned}.`,
    });
    broadcastPlayerRecord('playerUpdated', other);
  }

  if (requestedName && requestedName.trim() && requestedName.trim() !== callsign) {
    log(`"${requestedName.trim()}" ignored: player ${player.playerNumber} is signed in as "${callsign}"`);
  }
  return callsign;
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
  if (mapNoWalls) return [];
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
  // A mesh has no `.h` at all -- see `getObstacleHeight`'s own same check --
  // so `baseY + h` silently answers `baseY` (the mesh's own *bottom*) for
  // one instead of its real top.
  if (obs?.type === 'mesh' && obs.bounds) return obs.bounds.maxY;
  return (obs?.baseY || 0) + (Number.isFinite(obs?.h) ? obs.h : 0);
}

// The solid an occupant is inside of, or false. The loop is `findTankObstacle`
// in the shared `collision` pair and the client calls the same one: this says
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
    rotation: options.rotation,
    radius: tankRadius,
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
    const base = obs.baseY || 0;
    // A mesh has no single position/rotation to report -- checked directly
    // against upstream: `MeshObstacle`'s own constructor never calls
    // `Obstacle`'s position-taking one, so it inherits the base `Obstacle()`
    // default (0, 0, rotation 0) and never relies on it for anything real
    // either. bzo's own mesh objects go further and carry no such field at
    // all, so `obs.x`/`obs.z`/`obs.rotation` are `undefined` here rather
    // than a meaningless zero -- printing the bounds center in their place
    // for a mesh is at least a real point on the thing that was hit, which
    // upstream's own zero never was; `rotation` has no such stand-in, since
    // an arbitrary mesh has no one facing to report.
    const posX = Number.isFinite(obs.x) ? obs.x : ((obs.bounds?.minX + obs.bounds?.maxX) / 2 || 0);
    const posZ = Number.isFinite(obs.z) ? obs.z : ((obs.bounds?.minZ + obs.bounds?.maxZ) / 2 || 0);
    const rotation = Number.isFinite(obs.rotation) ? obs.rotation : 0;
    log(`[COLLISION] ${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)} ${obs.name}:${obs.type}`
      + ` ${posX.toFixed(2)},${base.toFixed(2)},${posZ.toFixed(2)} rot:${rotation.toFixed(2)},`
      + ` h:${getObstacleHeight(obs).toFixed(2)}, top:${getColliderTopY(obs).toFixed(2)}`);
  }
  return obs;
}

// The one physics-driver lookup the server side needs -- `findPhysicsSurfaceObstacle`
// stands in for the "what is this tank currently resting on" concept the
// client tracks as `lastMotionObstacle` (`resolvePhysicsDriverAt` in the
// shared `collision` pair is the rest of it, and is what guarantees the two
// sides can never disagree about which driver, if any, applies). Not
// `checkCollision`: that is an anti-cheat penetration test, deliberately
// forgiving of a tank resting exactly on solid ground, which is the one
// case this needs to catch. Used both to let an honest conveyor rider clear
// `validateMovement`'s drift check, and to find a `death` driver.
function getSupportPhysicsDriver(x, y, z) {
  const obs = findPhysicsSurfaceObstacle(getCollisionColliders(), x, y, z, 2, 2);
  return obs ? resolvePhysicsDriverAt(obs, x, y, z) : null;
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
// and every spawn after a capture. Rogue has no base to claim -- a `base`'s
// colour is always clamped to 1-4 -- so this is also the path a map's `team`
// zone answers: a colour team's own base always wins when it has one, and a
// zone only ever speaks for whoever a base left unanswered.
function getSpawnPosition(player) {
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
      return { ...getRandomBasePosition(base), rotation: Math.random() * Math.PI * 2 };
    }
  }
  // SpawnPolicy::getPosition's `else` (SpawnPolicy.cxx:66-167): everything
  // that is not a base-priority restart asks the zone qualifier before it
  // falls to a plain random point. That is every ordinary death -- upstream
  // only forces `restartOnBase` back to true on a capture, never on a kill --
  // so a `team` zone is what a self-destructed or shot-down colour tank comes
  // back on, not only what rogue always does.
  const zoneSpawn = getTeamZoneSpawnPosition(colorIndex);
  if (zoneSpawn) return zoneSpawn;
  return findValidSpawnPosition();
}

// WorldInfo::getPlayerSpawnPoint, picked uniformly among every zone that
// listed this team -- not area-weighted, the same simplification
// `getRandomTeamBase` already makes among a team's bases. Dropped onto
// whatever the zone actually sits on, since a zone's own y is only ever a
// mapper's guess at the ground.
function getTeamZoneSpawnPosition(colorIndex) {
  if (colorIndex === null) return null;
  const matches = MAP_ZONES.filter((zone) => zone.teams.has(colorIndex));
  if (matches.length === 0) return null;
  const zone = matches[Math.floor(Math.random() * matches.length)];
  // findFlagSpawnPosition's own re-roll: a crowded zone is not a reason to
  // leave it after one unlucky point, so this tries several before giving up
  // to the map-wide random search.
  for (let attempt = 0; attempt < 20; attempt++) {
    const spot = getRandomZonePoint(zone);
    const rotation = Math.random() * Math.PI * 2;
    const droppedY = dropSpawnPosition(spot.x, spot.y, spot.z, rotation);
    if (droppedY !== null) return { x: spot.x, y: droppedY, z: spot.z, rotation };
  }
  return null;
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

// DropGeometry::dropPlayer (DropGeometry.cxx:67), for a hand-written spawn. The
// tank's own height and radius, plus upstream's `fudge` so a tank does not spawn
// welded to the surface it landed on.
// Upstream's is a float epsilon, because a `MeshFace` there is infinitely thin
// and a tank resting exactly on one is clear of it. bzo's collision reads a tank
// sitting exactly on a surface as inside it -- see the "resting exactly on a
// surface" note in AGENTS.md, which is unfixed -- so a drop tested at the
// surface height rejects every real landing and falls through to the ground.
// Five centimetres is under the height a tank settles through in one frame, and
// it is the one place that behaviour has to be worked around rather than
// inherited: the alternative is every spawn landing under a mesh floor.
const SPAWN_DROP_FUDGE = 0.05;

// Where a tank put at this point would actually stand. Upstream's `dropIt`
// (DropGeometry.cxx:210) has two branches and both matter here:
//
//   - the point is **clear**, so the tank falls: take the highest flat top
//     under it, or the ground.
//   - the point is **blocked**, so the tank climbs: take the lowest flat top at
//     or above it that the tank fits on.
//
// The second is the one a hand-written coordinate needs. A `testSpawn` is typed
// against a map's coordinates, and a point inside a building spawns a tank that
// cannot move -- which is what `server.json`'s own spawn at the origin does on
// `fountains.bzw`, where a 60-unit box sits there. Upstream climbs it out onto
// the roof, and so does this.
//
// Returns the resolved y, or null when there is nowhere: the caller falls back
// to a random spawn rather than putting a tank somewhere it is stuck.
function dropSpawnPosition(x, y, z, rotation) {
  const clearance = (atY) => !checkCollision(x, atY, z, 2, {
    rotation,
    suppressLog: true,
  });

  // isValidLanding(): a flat top that is not drive-through. The world boundary
  // and a teleporter are not surfaces a tank is put on, which is the same set
  // `findFlagLandingY` refuses.
  const tops = [];
  for (const obs of getCollisionColliders()) {
    if (obs.driveThrough) continue;
    if (obs.collisionKind === 'boundary' || obs.kind === 'teleporter') continue;
    if (obs.type === 'pyramid' && !isPyramidFlatTop(obs)) continue;
    // A mesh offers one landing per flat face, which is what upstream's ray
    // gets back: each face is an obstacle of its own there. Asking this one for
    // `baseY + height` answers the top of the whole object instead -- the peak
    // of a mountain range rather than the valley floor under the tank.
    if (obs.type === 'mesh') {
      for (const top of meshFlatTopYsAt(obs, x, z)) tops.push(top);
      continue;
    }
    if (!isOverFlatTop(obs, x, z)) continue;
    tops.push((obs.baseY || 0) + getObstacleHeight(obs));
  }

  // `waterLevel` -- a floating-point tank has no ground to fall to under a
  // map with one; upstream's own `minZ = waterLevel` for exactly this search
  // (`RandomSpawnPolicy.cxx:93-96`, `SpawnPolicy.cxx:116-119`), so bzo's own
  // "else the ground" floor moves up to the water's own surface rather than
  // leaving one that only ever resolves to an instant `WaterDeath`.
  const groundLevel = (mapWaterLevel && mapWaterLevel.height > 0) ? mapWaterLevel.height : 0;

  if (clearance(y)) {
    // Falling: highest top below the start, else the ground.
    const below = tops.filter((top) => top <= y).sort((a, b) => b - a);
    for (const top of below) {
      if (clearance(top + SPAWN_DROP_FUDGE)) return top + SPAWN_DROP_FUDGE;
    }
    if (y >= groundLevel && clearance(groundLevel + SPAWN_DROP_FUDGE)) {
      return groundLevel + SPAWN_DROP_FUDGE;
    }
    return y + SPAWN_DROP_FUDGE;
  }

  // Climbing: lowest top at or above the start that the tank fits on.
  const above = tops.filter((top) => top >= y).sort((a, b) => a - b);
  for (const top of above) {
    if (clearance(top + SPAWN_DROP_FUDGE)) return top + SPAWN_DROP_FUDGE;
  }
  return null;
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
    const x = Number(spawn.x) || 0;
    const y = Number(spawn.y) || 0;
    const z = Number(spawn.z) || 0;
    const rotation = Number(spawn.rotation) || 0;
    const droppedY = dropSpawnPosition(x, y, z, rotation);
    if (droppedY === null) {
      log(
        `Test spawn "${spawn.name}" at ${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`
        + ' has nowhere to stand on this map; that player spawns at random instead'
      );
      continue;
    }
    if (Math.abs(droppedY - y) > SPAWN_DROP_FUDGE * 2) {
      log(
        `Test spawn "${spawn.name}" dropped from y ${y.toFixed(2)}`
        + ` to ${droppedY.toFixed(2)} at ${x.toFixed(2)},${z.toFixed(2)}`
      );
    }
    TEST_SPAWNS.set(spawn.name, { x, y: droppedY, z, rotation });
  }
}

// SpawnPolicy::getPosition's random search (SpawnPolicy.cxx:97-124): a random
// point on the map, a random height over it, and then a drop. The drop is the
// part bzo went without -- it spawned every tank on the flat world ground, which
// is correct only on a map whose ground *is* the floor. On a mesh-terrain map
// the floor is the mesh, tens of units up, and a mesh is a shell rather than a
// solid: a tank at ground level under one collides with nothing, so the spot
// passed and the tank spawned beneath the world.
function findValidSpawnPosition(tankRadius = 2) {
  const halfMap = GAME_CONFIG.MAP_SIZE / 2;
  const maxAttempts = 100;
  // `waterLevel`, as `dropSpawnPosition`'s own floor is.
  const groundLevel = (mapWaterLevel && mapWaterLevel.height > 0) ? mapWaterLevel.height : 0;
  const ceiling = getWorldMaxHeight();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = Math.random() * (GAME_CONFIG.MAP_SIZE - tankRadius * 4) - (halfMap - tankRadius * 2);
    const z = Math.random() * (GAME_CONFIG.MAP_SIZE - tankRadius * 4) - (halfMap - tankRadius * 2);
    const rotation = Math.random() * Math.PI * 2;
    // `bzfrand() * maxHeight`, so a multi-level map is entered at every level
    // rather than only on its roof.
    const startY = Math.random() * ceiling;

    const y = dropSpawnPosition(x, startY, z, rotation);
    if (y === null) continue;
    // The one place bzo refuses what upstream would accept. Starting below the
    // terrain, `dropIt` skips every surface above the start and lands on bare
    // ground -- under the world, which is the bug being fixed rather than
    // behaviour worth copying. Landing on a real surface at any level is still
    // allowed, so a tank may still spawn under a bridge.
    if (y <= groundLevel + 1 && hasFlatTopAbove(x, z, y)) continue;
    if (!checkCollision(x, y, z, tankRadius, { rotation })) {
      return { x, y, z, rotation };
    }
  }

  // If we couldn't find a valid position after many attempts, return a safe default
  return { x: 0, y: groundLevel, z: 0, rotation: 0 };
}

// Whether the world puts anything drivable over this point, which is what
// separates "standing on the map's ground" from "standing under the map".
function hasFlatTopAbove(x, z, y) {
  for (const obs of getCollisionColliders()) {
    if (obs.driveThrough) continue;
    if (obs.collisionKind === 'boundary' || obs.kind === 'teleporter') continue;
    if (obs.type === 'mesh') {
      if (meshFlatTopYsAt(obs, x, z).some((top) => top > y + 1)) return true;
      continue;
    }
    if (obs.type === 'pyramid' && !isPyramidFlatTop(obs)) continue;
    if (!isOverFlatTop(obs, x, z)) continue;
    if ((obs.baseY || 0) + getObstacleHeight(obs) > y + 1) return true;
  }
  return false;
}

// `world->getMaxWorldHeight()` -- how high the drop starts looking from.
function getWorldMaxHeight() {
  let max = 0;
  for (const obs of getCollisionColliders()) {
    if (obs.collisionKind === 'boundary') continue;
    const top = getColliderTopY(obs);
    if (Number.isFinite(top) && top > max) max = top;
  }
  return max;
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
function validateMovement(player, newX, newY, newZ, newRotation, extrapolationSeconds, velocityChanged = false, options = {}, now = Date.now()) {
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
    const timeSinceLastUpdate = Number.isFinite(extrapolationSeconds)
      ? extrapolationSeconds
      : (now - player.lastUpdate) / 1000;
    const extrapolated = player.getExtrapolatedPosition(now, timeSinceLastUpdate);

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
    // Only Burrow has any ground below zero, and being down there is what makes
    // a tank impervious to a level shot -- the height gate in the hit test is
    // the whole of the immunity, so a client that lied about its z would be
    // handing itself the flag's entire effect without carrying it. Reported as
    // the same class of finding as a collision, because it is the same thing:
    // the two ends disagreeing about where this tank is allowed to be.
    const groundLimit = getPlayerGroundLimit(player);
    if (newY < groundLimit - ANTICHEAT_GROUND_SLACK) {
      const refused = reportCheat(player, 'collision',
        `BELOW GROUND: y ${newY.toFixed(2)} < ${groundLimit.toFixed(2)}`
        + ` carrying ${getPlayerFlag(player.id)?.type ?? 'no flag'}`);
      if (refused) return false;
    }

    const ignoreTeleporters = options.ignoreTeleporters === true;
    const collision = checkCollision(newX, newY, newZ, 2, {
      ignoreTeleporters,
      rotation: newRotation,
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
      } else {
        const { x, z, w, d, h, baseY, rotation } = collision;
        headline = `COLLISION obs:${collision.name} ${x.toFixed(2)},${baseY.toFixed(2)},${z.toFixed(2)},`
          + ` w:${w.toFixed(2)}, d:${d.toFixed(2)}, h:${h.toFixed(2)},`
          + ` rot:${rotation.toFixed(2)} (${at})`;
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
    killPlayer(player, null, DEATH_REASON.PHYSICS_DRIVER, null, null, deathDriver.death);
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
  if (mapWaterLevel && mapWaterLevel.height > 0 && newY <= mapWaterLevel.height) {
    killPlayer(player, null, DEATH_REASON.WATER);
  }

  return true;
}

// How far under its own floor a tank may report itself before the server calls
// it a disagreement. A burrowed tank rests exactly at `_burrowDepth` and a
// rounded packet lands a hundredth either side of it, so the slack is a frame's
// worth of settling rather than a tolerance for anything a client could use.
const ANTICHEAT_GROUND_SLACK = 0.2;

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
  const barrelLength = TANK_HALF_LENGTH + 0.1;

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

  // LocalPlayer::fireShot's "make sure we're allowed to shoot" (:1220), whose
  // third term is `location == InBuilding`. Not fatal: the shot and the move
  // that carried the tank into the building cross on the wire, and warning mode
  // exists to measure exactly that.
  // "((location == InBuilding) && !isPhantomZoned())" -- the zoned tank is the
  // exception upstream writes into the test itself. A zoned tank is *meant* to
  // shoot from inside a building; that is what a phantom bullet is for, and it
  // can only hit another zoned tank anyway.
  if (!isPlayerZoned(player)
    && isPlayerInsideBuilding(player, extrapolated.x, extrapolated.y, extrapolated.z, player.rotation)) {
    return { reason: 'cannot shoot from inside a building', fatal: false };
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

// One player's record, to everyone, in the shape each recipient is allowed to
// see it. Two payloads rather than one because `getState` hides a field from a
// non-admin, and two `JSON.stringify` calls are cheaper than one per recipient.
function broadcastPlayerRecord(type, subject) {
  const forAdmins = JSON.stringify({ type, player: subject.getState(true) });
  const forEveryone = JSON.stringify({ type, player: subject.getState(false) });
  players.forEach((player) => {
    if (player.ws.readyState !== 1) return;
    player.ws.send(isAdmin(player) ? forAdmins : forEveryone);
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
// docs/flags.md, and FlagInfo.cxx / bzfs.cxx upstream.
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
  const rotated = rotateXZ(localX, localZ, -base.rotation);
  return {
    x: base.x + rotated.x,
    y: getBaseTopY(base),
    z: base.z + rotated.z,
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
  if (FLAG_SHAKE_TIMEOUT > 0) ways.push(`after ${FLAG_SHAKE_TIMEOUT}s`);
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
function computeListServerStatus() {
  return {
    title: serverConfig.serverName || '',
    description: serverConfig.description || '',
    players: [...players.values()].filter((p) => p.joined && p.team !== PLAYER_TEAM.OBSERVER).length,
    maxPlayers: MAX_REAL_PLAYERS,
    version: SERVER_VERSION,
    gameOptionsBits: computeLocalGameOptionsBits(),
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
  };
}

function reportToListServer(reason) {
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
    if (!PUBLIC_URL) return;
    let self = listServerKeys.listAll().find((record) => record.url === PUBLIC_URL);
    if (!self) {
      self = listServerKeys.requestKey({
        bzid: LIST_SERVER_OWNER_BZID || 'self',
        callsign: LIST_SERVER_OWNER_CALLSIGN || serverConfig.serverName || '',
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
      self.callsign = LIST_SERVER_OWNER_CALLSIGN || serverConfig.serverName || '';
    }
    if (reason === 'shutdown') {
      listServerKeys.unreport(self);
    } else {
      listServerKeys.report(self, payload);
      listServerKeys.markChecked(self, true);
    }
    return;
  }
  if (!LIST_SERVER_KEY) return;
  fetch(`${LIST_SERVER_URL}/api/list-server/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': `bzo ${CLIENT_BUILD}` },
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
// `ListServerReAddTime` upstream, bzfs.cxx:84 -- ~15 minutes, for live counts
// even when nobody has joined or left.
setInterval(() => reportToListServer('periodic'), 15 * 60 * 1000).unref?.();

// DropGeometry::dropFlag tests a tank-radius cylinder _flagHeight tall, so a
// spawning flag never appears somewhere a tank could not drive to reach it.
// checkCollision tests a box as tall as the radius it is handed, so the cylinder
// is walked in those steps.
//
// Only spawning uses this. A drop goes through dropTeamFlag, whose radius is 0
// and which upstream's own comment calls "not a real clearance check".
function hasFlagClearance(x, y, z) {
  for (let offset = 0; offset < FLAG_HEIGHT; offset += FLAG_DROP_TEST_RADIUS) {
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
    // `null` -- open water under this point, nothing to land on above the
    // waterline. Re-roll rather than spawn a flag there, the same as a point
    // `hasFlagClearance` refuses.
    if (y === null) continue;
    if (hasFlagClearance(spot.x, y, spot.z)) return { x: spot.x, y, z: spot.z };
  }
  log(`Unable to position flag ${flag ? flag.index : '?'} on this world.`);
  return zone ? { x: zone.x, y: zone.y, z: zone.z } : { x: 0, y: getFlagFloorY(), z: 0 };
}

function getFlagOwner(flag) {
  return flag.owner === null ? null : players.get(flag.owner) || null;
}

// FlagInfo::pack. A superflag nobody is holding goes out without its type.
// `reveal` is `pack`'s `hide` argument turned off, which only `/flag show`
// passes: an operator asking what is on the field is told.
function getFlagState(flag, now = Date.now(), { reveal = false } = {}) {
  const hidden = !reveal && flag.owner === null && flag.team === null;
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
// ray is `return false` outright, never the floor itself. `findFlagLandingY`
// returns `null` for exactly that case: a real obstacle top always wins
// (bzo has no clearance/opposing-base test of its own on a bare surface,
// unlike upstream's `isValidClearance`, so any flat top at or below `fromY`
// still counts), but nothing found is the ground when there is no water and
// "no safe landing here" once there is -- an open stretch of water is not a
// place a flag may rest, any more than it is a place a tank may stand.
function findFlagLandingY(x, z, fromY) {
  const floorY = getFlagFloorY();
  let landingY = floorY;
  let found = floorY <= 0;
  for (const obs of getCollisionColliders()) {
    // isValidLanding() skips anything a tank can drive through, and the world
    // boundary is not somewhere a flag belongs.
    if (obs.collisionKind === 'boundary' || obs.kind === 'teleporter') continue;
    const top = getColliderTopY(obs);
    if (top > fromY || top <= landingY) continue;
    if (!isOverFlatTop(obs, x, z)) continue;
    landingY = top;
    found = true;
  }
  return found ? landingY : null;
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
function isPlayerInsideBuilding(player, x, y, z, rotation) {
  if (!isPlayerPhased(player)) return false;
  return checkCollision(x, y, z, 2, {
    rotation,
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

  const reach = GAME_CONFIG.TANK_SPEED + BZFLAG_TANK_RADIUS + FLAG_RADIUS;
  const extrapolated = player.getExtrapolatedPosition(now);
  const gap = distance(extrapolated.x, extrapolated.z, flag.position.x, flag.position.z);
  if (checkPos && Math.abs(extrapolated.y - flag.position.y) < FLAG_GRAB_LEVEL_TOLERANCE && gap > reach) {
    const refused = reportCheat(player, 'flagRejected',
      `FLAG GRAB REJECTED flag ${flag.index} `
      + `${flag.position.x.toFixed(2)},${flag.position.z.toFixed(2)} is ${gap.toFixed(2)} away`
      + ` (reach ${reach.toFixed(2)})`);
    if (refused) return;
  }

  flag.owner = player.id;
  flag.status = FLAG_STATUS.ON_TANK;
  flag.flightStartedAt = 0;
  flag.grabbedAt = now;
  flag.zoned = false;
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
// position update, and asks the same two questions the flag grab does: same
// level, and within a tank plus a flag radius.
function checkAntidote(player, now = Date.now()) {
  const antidote = player.antidote;
  if (!antidote) return;
  const flag = getPlayerFlag(player.id);
  if (!flag || flag.endurance !== FLAG_ENDURANCE.STICKY) return;
  if (!player.alive || player.paused) return;
  if (Math.abs(player.y - antidote.y) >= FLAG_GRAB_LEVEL_TOLERANCE) return;
  if (distance(player.x, player.z, antidote.x, antidote.z) > FLAG_GRAB_RADIUS) return;
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
// in the flags pair, over the range and the states upstream uses, so a client
// cannot ask about a flag it is nowhere near or one that is not lying on the
// ground. What arrives from the client is the question, never the answer.
//
// A flag's identity stays hidden in `flagUpdate` regardless. Identify tells its
// carrier what one flag is; it does not reveal that flag to the world.
function searchFlag(player) {
  if (getPlayerFlag(player.id)?.type !== 'ID') return;
  if (!player.alive || player.paused) return;

  const closest = findNearestGroundFlag(flags, player.x, player.y, player.z, IDENTIFY_RANGE);
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
    y: from.y + FLAG_LAUNCH_TANK_HEIGHT,
    z: (from.z < -half || from.z > half) ? 0 : from.z,
  };
  const teamFlag = flag.team !== null;
  // Both kinds ride the same downward ray, cast from the tank's feet rather than
  // from the flag's launch altitude: dropIt gets `dropPos` while
  // FlagInfo::dropFlag adds the tank height to the launch point separately.
  //
  // `landingY` is `null` for open water: nothing above the waterline under
  // this point at all (`findFlagLandingY`). `landing.y` itself always gets a
  // real number regardless -- upstream's own `dropIt` leaves `pos[2]` at
  // `minZ` in that same case (`if (pos[2] < minZ) pos[2] = minZ`), it just
  // also returns `false`, which is the signal both branches below act on.
  const landingY = findFlagLandingY(launch.x, launch.z, from.y);
  let landing = {
    x: launch.x,
    y: landingY === null ? getFlagFloorY() : landingY,
    z: launch.z,
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
        const centreY = findFlagLandingY(0, 0, getMaxObstacleTopY(OBSTACLES));
        const centre = { x: 0, y: centreY === null ? getFlagFloorY() : centreY, z: 0 };
        if (centreY === null || isOpposingBaseAt(centre, flag.team)) {
          const base = getRandomTeamBase(flag.team);
          landing = base ? { x: base.x, y: getBaseTopY(base), z: base.z } : centre;
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
    flag.grabs -= 1;
    if (flag.grabs <= 0 || landingY === null) {
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
  flag.flightStartedAt = now;
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
    // Even for a tank that is already dead: the capture is what decides where it
    // comes back, whether or not it was standing when the flag went.
    victim.restartOnBase = true;
    if (!victim.alive) return;
    // `captured` rather than a reason, and no score at all -- that is the whole
    // of how a capture differs from any other death, and everything it has in
    // common with one is in applyDeath.
    applyDeath(victim, player.id, { captured: true });
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

  const radians1 = sourceObs.rotation + (sourceFace === 0 ? 0 : Math.PI);
  const radians2 = destObs.rotation + (destFace === 1 ? 0 : Math.PI);

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

// Why a zone toggle is refused, or null when it stands. A zoning tank does not
// move, so there is no destination to transform to and no cooldown of its own:
// the crossing is the whole claim, and it is checked the same way
// `applyPlayerTeleportMessage` checks the crossing of a tank that does move --
// against the point the client says it crossed at, never against wherever the
// server has since extrapolated the tank to. At tank speed a frame is several
// units, so the extrapolated position is past the portal by the time the
// message lands.
function getZoneRefusal(player, at, faceId, now) {
  if (!Number.isInteger(faceId)) return `face ${faceId} is not a teleporter face`;
  if (!Number.isFinite(at.x) || !Number.isFinite(at.y) || !Number.isFinite(at.z)) {
    return `crossing point is not finite (${at.x}, ${at.y}, ${at.z})`;
  }
  const obs = TELEPORTER_OBSTACLES_BY_INDEX.get(Math.floor(faceId / 2));
  if (!obs) return `no teleporter for face ${faceId}`;
  const rotation = Number.isFinite(at.r) ? at.r : player.rotation;
  const deltaTime = Math.max(0, (now - player.lastUpdate) / 1000);
  if (!validateMovement(player, at.x, at.y, at.z, rotation, deltaTime, true, {}, now)) {
    return `crossing point ${formatShotPoint(at.x, at.y, at.z)} is not a place this tank could be`;
  }
  if (!isPointInsideTeleporterPortal(obs, at.x, at.y, at.z, 2)) {
    return `${formatShotPoint(at.x, at.y, at.z)} is not inside the portal of face ${faceId}`;
  }
  return null;
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
  if (!validateMovement(player, sourceState.x, sourceState.y, sourceState.z, sourceRotation, deltaTime, true, {}, now)) {
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

  const radians1 = sourceObs.rotation + (sourceFace === 0 ? 0 : Math.PI);
  const radians2 = destinationObs.rotation + (destinationFace === 1 ? 0 : Math.PI);
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
  player.lag.resetUpdateGap();

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
        frameHitRemaining: remaining * (1 - earliest.event.t),
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
  const id = (++projectileIdCounter).toString();
  const proj = new Projectile(
    id,
    WORLD_WEAPON_PLAYER_ID,
    -1,
    weapon.x,
    weapon.y,
    weapon.z,
    direction.x,
    direction.z,
    direction.y,
    weapon.type,
    now
  );
  // The shot's team, since there is no player to read one off.
  proj.team = WORLD_WEAPON_TEAM;
  projectiles.set(id, proj);
  // A beam's whole path is walked when it is fired, as it is for a tank's, and a
  // world weapon can be a `L` Laser -- `fountains.bzw` mounts two.
  const beamHit = proj.beam ? traceShotBeam(proj, proj.createdAt) : null;
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
    // A world weapon locks onto nobody: upstream targets a `GM` world weapon
    // through the API rather than from a map, which bzo has no equivalent of.
    target: null,
    createdAt: proj.createdAt,
  });
  if (beamHit) applyShotPlayerHit(proj, id, beamHit.player, beamHit.point);
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
      if (!canRunOver(roller.flag, victimFlag, roller.at.y, roller.zoned)) continue;
      const radius = getRunOverRadius(victimFlag, roller.flag, TANK_HIT_RADIUS);
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

// The aim point a guided missile steers at. Upstream aims at the target's own
// `getMuzzleHeight()` -- "right between the eyes" (GuidedMissleStrategy.cxx:180)
// -- but a bzo tank has as many muzzle heights as it has models, and no client
// could agree with the server about which one. The mid-height of the cylinder
// the server hits with is a number every end already shares, and it is the point
// most of the tank is nearest to.
function getLockAimPoint(position) {
  return { x: position.x, y: position.y + (TANK_HIT_HEIGHT / 2), z: position.z };
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
  // `ST` is one flag doing both jobs upstream: off the radar, and out of reach
  // of a lock.
  if (hidesFromRadar(getPlayerFlag(player.id)?.type ?? null)) return false;
  return true;
}

// Whichever tank this player's missiles are steering at, or null. A lock is only
// live while there is a missile for it to steer, which is the same test that
// allows one to be taken.
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
  broadcastAll({ type: 'lockTarget', playerId: player.id, targetId: next });
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
  const eye = { x: at.x, z: at.z };
  const forward = { x: -Math.sin(at.r), z: -Math.cos(at.r) };
  const seer = seesThroughDisguises(getPlayerFlag(player.id)?.type ?? null);

  const lockable = [];
  const visible = [];
  players.forEach((other) => {
    if (other.id === player.id || !other.joined) return;
    if (isObserverTeam(other.team) || !other.alive) return;
    const position = other.getExtrapolatedPosition(now);
    const candidate = { id: other.id, x: position.x, z: position.z };
    if (canLockOnto(other)) lockable.push(candidate);
    // The look refuses a stealthed tank too, but a seer sees through that one
    // (playing.cxx:4436) where a missile never does.
    if (seer || !hidesFromRadar(getPlayerFlag(other.id)?.type ?? null)) visible.push(candidate);
  });

  const locked = canLockOn(player)
    ? pickTargetInSights(eye, forward, lockable, LOCK_ON_ANGLE)
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

// The tank a shot's hit test sees: bzo's own radius, which is not upstream's
// `_tankRadius` 4.32, and `_tankHeight` from the collision pair, which is.
// The dimension flags scale the radius, following upstream's own basis --
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
  // GuidedMissileStrategy::checkHit (:318): "GM is not active until activation
  // time passes (for any tank)". The tank the rule is really for is the one that
  // fired it -- a missile locked onto a target two lengths away comes round
  // through its own shooter.
  if (proj.activationTime > 0
    && ((now - proj.createdAt) / 1000) < proj.activationTime) return null;

  let best = null;
  players.forEach((player) => {
    // LocalPlayer::checkHit tests a player's own shots too -- "Don't shoot
    // yourself!" is the Ricochet flag's own help text -- but only once one has
    // bounced. Before that a shot leaves the muzzle beyond the hit radius and
    // outruns the tank it came from.
    // "my own shock wave cannot kill me ... or Thief" (LocalPlayer.cxx:1612).
    // Unlike a ricochet, no bounce ever earns a thief its own flag back.
    if (player.id === proj.playerId && (proj.steals || proj.bounces === 0)) return;
    if (isObserverTeam(player.team)) return; // No tank to hit
    if (player.paused) return; // Can't hit paused players
    if (!player.alive) return; // Can't hit dead players

    // "-noTeamKills: Players on the same team are immune to each other's shots.
    // Rogue is excepted." Upstream refuses this on the victim's own client
    // (LocalPlayer.cxx:1616); bzo refuses it here, where hits are decided. Your
    // own shot still reaches you once it has bounced -- upstream excepts the
    // shooter too (`source != this`), because a ricochet you drove into is
    // nobody's team kill.
    //
    // "Thief can still take a teammate's flag" -- upstream excepts it from the
    // guard by name (LocalPlayer.cxx:1617), because nothing about a theft is a
    // kill and a team mate carrying the flag you want is exactly who you rob.
    if (NO_TEAM_KILLS && !proj.steals && player.id !== proj.playerId
      && !areFoes(getShotTeam(proj), player.team, TEAMS_ALLOWED)) return;

    // `ThiefStrategy::isStoppedByHit` returns false: a thief's beam is not spent
    // by a tank, so a tank with nothing to take does not block it. bzo stops it
    // at the first tank it can actually rob instead, which is the one place it
    // does not simply follow upstream -- upstream lets every client along the
    // beam report its own theft, and the thief keeps only the last of them while
    // bzfs zaps the rest. Robbing one tank per shot loses nothing anybody wanted
    // and destroys nothing.
    if (proj.steals && !getPlayerFlag(player.id)) return;

    // LocalPlayer::checkHit (LocalPlayer.cxx:1630): "laser can't hit a cloaked
    // tank". The one per-viewer rule that is not a matter of what somebody can
    // see -- a cloaked tank is genuinely immune to a beam, so it has to be the
    // server's answer rather than each client's. It is also the reason `CL` is a
    // good flag rather than a cosmetic one.
    if (proj.flag === 'L' && cloaksTheTank(getPlayerFlag(player.id)?.type ?? null)) return;

    // LocalPlayer::checkHit's phantom pair (LocalPlayer.cxx:1622 and :1634): a
    // zoned tank is only reached by a super bullet, a shock wave or another
    // zoned tank's bullet, and a zoned bullet reaches nobody else. Upstream asks
    // this on the victim's own client; bzo asks it here, for the same reason it
    // decides every other kill here.
    if (shotPassesThroughTank(proj.flag, isPlayerZoned(player))) return;

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
  // playing.cxx:3827. A dead tank has nothing locked, so the marker goes with
  // it and a respawn starts clean. Missiles already in the air fly straight from
  // here, which is what upstream's `setTarget(NULL)` does to them too.
  setLockTarget(victim, null);

  // bzfs.cxx:3537. Killing the rabbit is what deposes it, and under
  // `-rabbit killer` whoever did the killing takes it if they still can. Every
  // way to depose a rabbit by killing it arrives here, which is the point.
  if (RABBIT_SELECTION && victim.id === rabbitPlayerId) anointNewRabbit(killerId);

  dropPlayerFlag(victim.id);

  broadcastAll({
    type: 'killed',
    victimId: victim.id,
    shooterId: killerId,
    projectileId: null,
    ...hit,
  });

  setTimeout(() => {
    if (!players.has(victim.id)) return;
    // cleanupGameOver()'s hold: a tank that died into game over stays dead
    // until the next /countdown, which is what "the server refuses the spawn
    // while the game is over" (docs/game-modes-plan.md, "Match end") means for
    // a death already in flight when the clock hit zero.
    if (matchClock.gameOver) return;
    victim.respawn();
    broadcastPlayerRecord('alive', victim);
  }, GAME_CONFIG.RESPAWN_DELAY);
}

function killPlayer(victim, killer, reason, projectileId = null, shooterId = null, deathMessage = null) {
  // "victim was already dead. keep score." Upstream's own guard, and bzo needs
  // it for the same reason plus one of its own: genocide kills a team in a loop,
  // and a team killer who dies for the first of them must not die again for the
  // rest.
  if (!victim.alive) return;

  victim.losses++;

  // areFoes(): a kill across teams, a rogue killing anyone, or any kill at all
  // on a world without teams. Everything else is a team kill.
  //
  // isARabbitKill (bzfs.cxx:3421) is Rabbit Chase's one exception. Hunters share
  // a team, so hunter-on-hunter fire *is* team killing -- except that shooting
  // the rabbit never is, and neither is anything a deposed rabbit does before its
  // next spawn. Decided before `applyDeath` below, because the anointing in
  // there is what stops the victim being the rabbit; upstream's order too.
  //
  // Note this is not the same question as "was it a suicide" for the notice
  // below: a world weapon has no killer to score, and is nobody's suicide.
  const selfKill = !killer || killer.id === victim.id;
  const teamKill = !selfKill && !areFoes(killer.team, victim.team, TEAMS_ALLOWED)
    && !isARabbitKill(killer, victim);
  if (!selfKill) {
    if (teamKill) {
      // Upstream scores the killer a death rather than a kill for it
      // (`killerData->score.killedBy()`), so a team kill never counts towards
      // shaking a bad flag either. `killerData->score.tK()` is the same call's
      // other half, tallied on the killer for the scoreboard's `[NN]` column.
      killer.losses++;
      killer.tks++;
    } else {
      killer.wins++;
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
    deathMessage,
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
  if (proj.steals) return stealFlag(proj, player) ? 'stolen' : 'missed';

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
function stealFlag(proj, victim) {
  const thief = players.get(proj.playerId);
  const stolen = getPlayerFlag(victim.id);
  if (!thief || !stolen) return false;

  const held = getPlayerFlag(thief.id);
  if (held) zapFlag(held);
  // The victim gives up everything the flag armed as well as the flag, which is
  // what `sendFlagDrop` does for every other way of losing one.
  clearFlagShedState(victim);
  stolen.owner = thief.id;
  stolen.status = FLAG_STATUS.ON_TANK;
  stolen.flightStartedAt = 0;
  stolen.grabbedAt = Date.now();
  armBadFlagRelease(thief, stolen);
  log(`"${thief.name}" stole ${getFlagType(stolen.type).name} flag ${stolen.index} from "${victim.name}"`);
  broadcastAll({
    type: 'transferFlag',
    fromId: victim.id,
    toId: thief.id,
    flag: getFlagState(stolen),
  });
  return true;
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
  const quiet = outcome === 'stolen' || outcome === 'missed';
  broadcastAll({ type: 'shotEnd', id, reason: quiet ? 1 : 0, x: point.x, y: point.y, z: point.z });
}

// What became of the tank, as the shot log says it.
const SHOT_END_LABEL = Object.freeze({
  killed: 'player_hit',
  shield: 'shield_hit',
  stolen: 'flag_stolen',
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
  const radiusSquared = radius * radius;
  players.forEach((player) => {
    // "my own shock wave cannot kill me" (LocalPlayer.cxx:1612). Unlike a
    // ricochet there is no bounce that could ever earn it.
    if (player.id === proj.playerId) return;
    if (isObserverTeam(player.team)) return;
    if (player.paused) return;
    if (!player.alive) return;
    if (proj.shockWaveResolved.has(player.id)) return;
    // Friendly fire, as for any other shot: upstream's team-kill guard is one
    // test in one loop over every shot the shooter owns, and a shock wave is one
    // of them.
    if (NO_TEAM_KILLS && !areFoes(getShotTeam(proj), player.team, TEAMS_ALLOWED)) return;

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
// normal -- `traceShotStep`'s own `SHOT_BOUNCE_CLEARANCE` (collision.cjs),
// shared so a beam's bounce and an ordinary shot's agree. It has to clear
// SHOT_COLLISION_RADIUS: within that distance the shot still counts as inside
// the obstacle, and a segment that starts inside something is carried
// straight through it -- so a smaller clearance sent the beam through the
// first wall it bounced off and out of the world. The drawn segment still
// starts at the impact point, so there is no gap to see.
const BEAM_SURFACE_CLEARANCE = SHOT_BOUNCE_CLEARANCE;

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
  // Scopes the "already inside, carry it through" read below to an actual
  // teleport exit, the same way traceShotStep's own `justTeleported` does
  // (issue #83): true only for the segment starting right after a teleport
  // transform, never for the muzzle's own starting point or after an
  // ordinary bounce.
  let justTeleported = false;
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
    // traceShotStep's rule for a shot that begins inside something because it
    // just exited a teleporter: carry it through, because there is no surface
    // between where it is and where it came from to stop it. Anything else
    // that started embedded -- the muzzle's own spawn point overlapping a
    // thin wall (issue #83) -- is an immediate hit right there instead.
    const embeddedObstacle = findShotEmbeddedObstacle(obstacles, point.x, point.y, point.z, SHOT_COLLISION_RADIUS);
    const impact = embeddedObstacle
      ? (justTeleported ? null : { fraction: 0, obstacle: embeddedObstacle, face: null })
      : findShotSegmentImpact(obstacles, point, far, SHOT_COLLISION_RADIUS);
    const obstacleFraction = impact ? impact.fraction : Infinity;
    justTeleported = false;

    let reason = 'range';
    let obstacle = null;
    let obstacleFace = null;
    let fraction = 1;
    if (obstacleFraction <= groundFraction && obstacleFraction < 1) {
      reason = 'obstacle';
      obstacle = impact.obstacle;
      obstacleFace = impact.face ?? null;
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
      obstacleFace = null;
    }

    if (Math.abs(end.x) > halfMap || Math.abs(end.z) > halfMap) {
      end = findMapEdgeImpactPoint(point.x, point.y, point.z, end.x, end.y, end.z, halfMap);
      reason = 'out_of_bounds';
      obstacle = null;
      obstacleFace = null;
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
      justTeleported = true;
      blockedTeleporterIndex = destTeleporterIndex;
      blockedDistance = Math.max(
        SHOT_TELEPORT_REENTRY_BLOCK_DISTANCE,
        (getShotTeleporterDims(destObs).activeHalfD * 2) + 0.05,
      );
      log(`[SHOT_TP] id=${proj.id} beam srcFace=${sourceFaceId} dstFace=${destFaceId}`);
      continue;
    }

    // makeSegments promotes Stop to Reflect on a world where every shot bounces,
    // so a laser fired there is a beam that bends. All three surfaces bounce
    // it: a building about its own normal, the ground about straight up, and
    // a teleporter frame about its nearest border column's normal (issue #110
    // -- upstream's ShotStrategy::getFirstBuilding treats a frame hit as an
    // ordinary building hit, same as a flying shot).
    if (proj.ricochet && (reason === 'obstacle' || reason === 'ground' || reason === 'frame_hit')) {
      const normal = reason === 'ground'
        ? { x: 0, y: 1, z: 0 }
        : getShotObstacleNormal(obstacle, end.x, end.y, end.z, SHOT_COLLISION_RADIUS, obstacleFace);
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

    // GuidedMissileStrategy::update turns the missile before it moves it, so the
    // step is taken along the heading the missile has just chosen. A shooter with
    // nothing locked -- or with a target that has died, paused or taken `ST` --
    // leaves the missile flying straight.
    if (proj.guided) {
      const target = getLockTarget(proj.playerId);
      const steered = steerGuidedShot(
        { x: proj.dirX, y: proj.dirY || 0, z: proj.dirZ },
        { x: proj.x, y: proj.y, z: proj.z },
        target ? getLockAimPoint(target.getExtrapolatedPosition(now)) : null,
        GM_TURN_ANGLE,
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
  // broadcastAll, not `broadcast`: a mover's own id can ride in the same
  // batch as everyone else's, since the client skips its own id on the way
  // in (see the 'pmBatch' case in client.js) -- the same exclusion `broadcast`
  // used to give for free by skipping the origin socket.
  broadcastAll({ type: 'pmBatch', moves });
}

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
      broadcastAll({ type: 'message', src: -1, dst: 0, msgType: 'server', text: line, ts: Date.now() });
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


// Helper to send the map list and current map to a given websocket
// The same shape `init.viewableMaps` sends -- a map still hashing in the
// background is simply absent until the next call, same caveat as `init`'s
// own copy. Shared so the View dialog (which asks fresh, on demand, rather
// than waiting for a reconnect) and `init` never compute this two ways.
function getViewableMapsList() {
  return Array.from(MAP_REGISTRY.values())
    .map((entry) => ({ file: entry.fileName, hash: entry.hash, url: entry.url }))
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

// WebSocket connection handler
// When a new player connects, assign a default name and number
wss.on('connection', (ws, req) => {

  let player = new Player(ws);
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
    player.lag.pongReceived(now);
    // The client is *shown* the answer, never asked for it (docs/lag-plan.md):
    // this is the player's own figure only, not a broadcast to the roster, so
    // it carries no anti-cheat weight -- it just fills in the debug HUD's ping.
    sendToPlayer(player, { type: 'lag', lagMs: player.lag.getLag(now) });
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
  // Kept for `/playerlist`, which is upstream's "list player slots, names and IP
  // addresses". It is the forwarded address where there is one, so it is only as
  // trustworthy as the proxy -- see docs/commands-plan.md on why a ban cannot
  // rest on it as read.
  player.clientIP = clientIP;
  player.localAdmin = isLocalAdminRequest(req.socket.remoteAddress, req.headers, {
    enabled: LOCAL_ADMIN,
    whitelist: ADMIN_WHITELIST,
    forwardedForPolicy,
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
    + ` ua="${req.headers['user-agent'] || ''}"`);

  // The cookie is where identity binds, because the cookie is what the
  // handshake carries. Everything the player is comes out of the server's own
  // record: the id is only ever looked up, never parsed, so an invented one is
  // anonymous rather than merely unlikely to work.
  //
  // The session is read once, here, and the id is kept so a superseded login
  // can invalidate it. It is deliberately *not* sent to the client.
  player.sessionId = cookies[SESSION_COOKIE_NAME] || null;
  const session = sessions.get(player.sessionId);
  if (session) {
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
  const clientGameConfig = Object.fromEntries(
    Object.entries(GAME_CONFIG).filter(([key]) => key !== 'MAP_SIZE'),
  );

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
    config: clientGameConfig,
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
    voiceRtcConfig: { iceServers: VOICE_ICE_SERVERS },
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
    flags: getFlagStates(),
    worldTime,
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
          const isTeamTarget = rawTarget === -2 || rawTarget === '-2';
          // Upstream's `AdminPlayers` destination. bzo spends small negatives on
          // the destinations that are not players, so this is one more of them
          // rather than upstream's reserved PlayerId 252.
          const isAdminTarget = rawTarget === -3 || rawTarget === '-3';
          const targetId = isAllTarget || isServerTarget || isTeamTarget || isAdminTarget
            ? Number(rawTarget)
            : String(rawTarget);
          const msgType = message.msgType === 'action' ? 'action' : 'chat';
          const text = typeof message.text === 'string' ? message.text.trim() : '';
          if (text.length === 0) break;

          // `/me` before the command dispatcher, because it is the one `/` line
          // that keeps its destination: upstream reformats it here for exactly
          // that reason (bzfs.cxx:1490). `/mefoo` is not `/me` and falls through
          // to the dispatcher -- upstream's "don't intercept other messages
          // beginning with /me...".
          if (/^\/me(\s|$)/i.test(text)) {
            deliverActionMessage(player, targetId, text.slice(3));
            break;
          }

          // Step 1 of docs/commands-plan.md, and the reason it goes first: a line
          // beginning with `/` is a command whatever channel it was aimed at, and
          // it is never said out loud -- a mistyped `/kick bob` must never
          // announce itself to the room as chat.
          if (handleServerCommand(player, text)) break;

          deliverChatMessage(player, targetId, msgType, text);
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
          // sendVoiceStateUpdate only reaches this player's current voice
          // peers, because that message is also what negotiates the WebRTC
          // roster. The scoreboard's mic glyph is for every player in the
          // match, on any channel or out of Nearby range alike, so it needs
          // its own broadcast rather than reusing that one.
          broadcastAll({
            type: 'voiceMicToggled', playerId: player.id, enabled: player.voiceMicEnabled,
          });
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
          if (isObserverTeam(player.team)) break;

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
          if (isObserverTeam(player.team)) {
            applyObserverHeartbeat(player, message, ws);
            break;
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
          // `LagInfo::updateLag` (LagInfo.cxx:214). Upstream differences the
          // client's absolute timestamp against its own arrival time; bzo has
          // the same two intervals already -- how long the server waited for
          // this packet, and how long the client says it took to send it -- so
          // jitter needs no field the move does not carry. Measured whatever
          // the anti-cheat mode is: it is a statistic, not a judgement.
          player.lag.recordUpdate(now, Number(message.sdt));
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
          // The threshold is a tenth of the world's own jump velocity rather
          // than a fixed number, because `BY` Bouncy's bounce is a random
          // quarter-to-full of that velocity and starts as low as 4.75 at bzo's
          // default -- a fixed threshold high enough to clear the quantization
          // would miss those jumps and go on extrapolating the tank along the
          // ground while it was in the air. A tenth is clear of the
          // quantization, under anything that could be a real jump, and follows
          // a server that has tuned the jump.
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
            log(`[JUMP] "${player.name}" jumped: pos=(${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}), r=${r.toFixed(2)}, fs=${fs.toFixed(2)}, rs=${rs.toFixed(2)}, vv=${vv.toFixed(2)}`);
            log(`[JUMP] Expected landing: pos=(${expectedLandX.toFixed(2)},${expectedLandZ.toFixed(2)}), r=${expectedLandR.toFixed(2)}`);
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
            if (Number.isFinite(clientTimestamp)) player.lastClientTimestamp = clientTimestamp;

            const pmPacket = {
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

            // Queued rather than broadcast here: one WS frame per move meant
            // one per recipient per move, O(players^2) frames a tick. Batched
            // in `flushMoveBroadcasts`, called once from `gameLoop`, so a busy
            // tick costs one frame per connected client instead.
            pendingMoveBroadcasts.push(pmPacket);

            checkAntidote(player, now);
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
          const now = Date.now();
          const shotRejection = getShotRejection(player, message.x, message.y, message.z, now);
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
            // ShotPath::FiringInfo (ShotPath.cxx:46): an unzoned Phantom Zone
            // tank fires ordinary shells, so the flag a shot is fired under is
            // not always the flag its shooter is holding.
            getShotFlagFor(player),
            now
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
            // Who the shooter has locked, so a client that has not seen a
            // `lockTarget` for them yet still steers this missile from its first
            // frame -- and so the tank being shot at learns of it, which is when
            // upstream warns them rather than when the lock was taken.
            target: proj.guided ? (getLockTarget(proj.playerId)?.id ?? null) : null,
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
        // setTarget() on upstream's `identify` binding (ActionBinding.cxx:97).
        // An observer picks its roaming target on its own client, where the free
        // camera it aims with lives; a tank asks here, because the answer steers
        // a guided missile.
        case 'identify': {
          if (isObserverTeam(player.team) || !player.alive || player.paused) break;
          setPlayerTarget(player);
          break;
        }

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

        // The Identify flag asking what the nearest flag is. The client sweeps
        // for itself and only asks about one it cannot already name, so this
        // arrives once per flag rather than on every position update the way
        // upstream's own push does.
        case 'nearFlag': {
          if (!player.joined) break;
          searchFlag(player);
          break;
        }

        case 'grabFlag': {
          if (!player.joined) break;
          const requestedIndex = Number(message.index);
          if (!Number.isInteger(requestedIndex)) break;
          const flag = flags[requestedIndex];
          if (!flag) break;
          grabFlag(player, flag, Date.now());
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
          if (!player.alive) break;
          const flag = getPlayerFlag(player.id);
          if (!flag) break;
          const now = Date.now();
          // A sticky flag cannot be dropped on request; only its shake timeout
          // or a kill gets rid of it. The client runs the countdown, as upstream
          // does, so the server runs the same clock against the moment it saw
          // the grab -- otherwise a modified client sheds a bad flag on contact.
          if (flag.endurance === FLAG_ENDURANCE.STICKY) {
            const held = (now - flag.grabbedAt) / 1000;
            if (!canShakeFlag(flag.type, FLAG_SHAKE_TIMEOUT, held)) {
              const refused = reportCheat(player, 'flagRejected',
                `SHAKE REJECTED ${getFlagType(flag.type).name} held ${held.toFixed(2)}s `
                + `of ${FLAG_SHAKE_TIMEOUT}s`);
              if (refused) break;
            }
            log(`"${player.name}" shook off ${getFlagType(flag.type).name} after ${held.toFixed(2)}s`);
          }
          // cmdDrop's `!myTank->isPhantomZoned()`: a zoned tank cannot put the
          // flag down at all. Dropping it would leave the tank phased with
          // nothing to unphase it, since only the flag can cross a teleporter.
          if (isPlayerZoned(player)) {
            const refused = reportCheat(player, 'flagRejected', 'DROP REJECTED: zoned');
            if (refused) break;
          }
          // cmdDrop (clientCommands.cxx:355): a flag dropped inside a building
          // would land inside it, where nothing could reach it again. The client
          // refuses the control, so this only catches a modified one.
          if (isPlayerInsideBuilding(player, player.x, player.y, player.z, player.rotation)) {
            const refused = reportCheat(player, 'flagRejected',
              'DROP REJECTED: inside a building');
            if (refused) break;
          }
          dropFlag(flag, now);
          break;
        }

        // doUpdateMotion's teleporter branch (LocalPlayer.cxx:729). A Phantom
        // Zone tank crossing a teleporter is not moved: the zone toggles
        // instead. The client detects the crossing, as it does for an ordinary
        // teleport, and this is the server agreeing to it -- the state is the
        // server's because being zoned is what decides who can shoot you.
        case 'zone': {
          if (!player.joined) break;
          if (!player.alive) break;
          const flag = getPlayerFlag(player.id);
          if (!flag || !togglesZoneOnTeleport(flag.type)) {
            reportCheat(player, 'flagRejected',
              `ZONE REJECTED: carrying ${flag ? getFlagType(flag.type).name : 'no flag'}`);
            break;
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
            r: Number(message.r),
          };
          const now = Date.now();
          const zoneRefusal = getZoneRefusal(player, zoneAt, Number(message.fromFaceId), now);
          if (zoneRefusal) {
            reportCheat(player, 'flagRejected', `ZONE REJECTED: ${zoneRefusal}`);
            break;
          }
          flag.zoned = !flag.zoned;
          log(`"${player.name}" ${flag.zoned ? 'zoned' : 'unzoned'}`);
          broadcastFlagUpdate(flag);
          break;
        }

        case 'selfDestruct': {
          // An observer has no tank to destroy. The dead tank is killPlayer's own
          // guard, and it is only repeated here so a request that will do nothing
          // is not logged as though it did.
          if (isObserverTeam(player.team)) break;
          if (!player.alive) break;
          log(`"${player.name}" self-destructed.`);
          // playing.cxx:6966 is `gotBlowedUp(myTank, SelfDestruct, myTank->getId())`
          // -- upstream's suicide is a kill whose killer is the victim, and it goes
          // through playerKilled like every other death. So this is one call into
          // the one death path: the loss, the flag, the lock, the rabbit and the
          // respawn all happen there, and cannot be forgotten here.
          killPlayer(player, player, DEATH_REASON.SELF_DESTRUCT);
          break;
        }

        case 'joinGame': {
          let joinName = resolveJoinName(player, message.name);
          const requestedTankModel = typeof message.tankModel === 'string'
            ? normalizeTankModelId(message.tankModel)
            : 'bzflag';
          const previousTeam = player.joined ? player.team : null;
          const requestedTeam = normalizePlayerTeamSelection(message.team);
          // autoTeamSelect (bzfs.cxx:1923) refuses nothing in Rabbit Chase: asking
          // for observer gives observer and asking for anything else means "play",
          // which is a hunter. So the availability check is skipped there and
          // selectPlayerTeam answers on its own.
          if (!RABBIT_SELECTION && requestedTeam !== 'automatic'
            && !TEAM_MODE.teams.includes(requestedTeam)) {
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
            break;
          }
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
          player.voiceRosterSignature = '';
          reportToListServer('join');
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
          player.lag.resetUpdateGap();
          player.losses = 0;
          player.wins = 0;
          // The tank is named here as well as on a later change, so a join
          // line says what a player is driving without the log having to be
          // read backwards for a change that may never have happened.
          const joinTags = [`[${player.team.toUpperCase()}]`, `[${player.tankModel}]`];
          if (message.isMobile) joinTags.push('[MOBILE]');
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
          if (RABBIT_SELECTION && rabbitPlayerId === player.id) anointNewRabbit();
          handleRabbitSpawn(player);
          broadcastTeamScores();
          refreshVoiceRosters(true);
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
          break;
        }

        case 'pause':
          requestPause(player);
          break;

        case 'getMaps': {
          // Reply with all .bzw files in maps/ plus 'random', and indicate current map.
          // Open to every player -- browsing and the View dialog need this list, and
          // only `setMap` (switching the live match) stays operator-only below.
          sendMapList(ws);
          break;
        }
        case 'setMap': {
          if (refuseNonOperator(ws, player, 'setMap')) break;
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
        // The Operator panel's Match Timer buttons and their XR equivalents.
        // `/countdown`/`/gameover` reach the same four functions from the chat
        // entry; this is the panel's front end for them.
        case 'matchControl': {
          if (refuseNonOperator(ws, player, 'matchControl')) break;
          const actions = {
            start: startMatch,
            pause: pauseMatch,
            resume: resumeMatch,
            gameover: endMatch,
          };
          const run = actions[message.action];
          if (!run) {
            ws.send(JSON.stringify({ error: 'Invalid match control action' }));
            break;
          }
          if (!run()) {
            replyToPlayer(player, 'No change: check the time limit and the match state');
            break;
          }
          log(`[OPERATOR] "${player.name}" used the panel's match control: ${message.action}`);
          break;
        }

        case 'uploadMap': {
          if (refuseNonOperator(ws, player, 'uploadMap')) break;
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
            // Queue the new file for hashing so it becomes viewable (issue
            // #68) without a restart -- setMap still needs one, this doesn't.
            hashRemainingMapsInBackground();
          });
          break;
        }

        // The View dialog's remote-server list -- decoded entirely from the
        // list server's own reply, so this never connects to any of the
        // servers it names. Open to every player, same as `getMaps`: viewing
        // and importing cost the requester (a fetch, a render), not the live
        // match, so only `setMap` needs an operator.
        case 'listRemoteServers': {
          getRemoteServerList().then((servers) => {
            const summarized = servers
              .map((s) => ({
                host: s.host,
                port: s.port,
                title: s.title,
                style: s.info?.style ?? null,
                players: s.info?.players ?? null,
                maxPlayers: s.info?.maxPlayers ?? null,
              }))
              .sort((a, b) => (b.players ?? -1) - (a.players ?? -1));
            ws.send(JSON.stringify({ type: 'remoteServerList', servers: summarized }));
          }).catch((error) => {
            logError('Fetching the remote server list failed:', error);
            ws.send(JSON.stringify({ error: 'Could not reach the BZFlag list server' }));
          });
          break;
        }

        // Downloads a live BZFlag server's world over the real wire protocol
        // (see server/remote-world-import.cjs) and saves it as an ordinary
        // .bzw -- one step, same as `uploadMap`. Open to every player, but
        // `performRemoteMapImport` fetches only from an exact host:port in
        // the public list. It costs this server one fetch and one file (capped by
        // MAX_WORLD_DATABASE_BYTES in remote-world-import.cjs), not the live
        // match, so there is nothing here that needs an operator. It does not
        // touch the live match or select the new file anywhere -- switching
        // the match to it is still `setMap`, still operator-only.
        // `performRemoteMapImport` hashes the file synchronously, so it is
        // viewable the moment this reply arrives, not after a background
        // trickle or a reload.
        case 'importMap': {
          const target = parseHostPort(message.hostPort);
          if (!target) {
            ws.send(JSON.stringify({ error: 'Expected host:port' }));
            break;
          }
          const { host, port } = target;
          log(`"${player.name}" is importing a remote map from ${host}:${port}`);
          performRemoteMapImport(host, port).then(({ safeMapName, byteLength, reused }) => {
            log(reused
              ? `"${player.name}" reused the cached copy of ${host}:${port}, ${safeMapName} (${byteLength} bytes)`
              : `"${player.name}" imported remote map ${host}:${port} as ${safeMapName} (${byteLength} bytes)`);
            ws.send(JSON.stringify({ type: 'importMapResult', success: true, file: safeMapName }));
            replyToPlayer(player, reused
              ? `${host}:${port} is no longer in the public list, so ${safeMapName} is the copy already `
                + `here (${byteLength} bytes). It is ready to View now.`
              : `Imported ${safeMapName} from ${host}:${port} (${byteLength} bytes). It is ready to View now.`);
            sendMapList(ws);
          }).catch((error) => {
            logError(`Remote map import from ${host}:${port} failed:`, error);
            ws.send(JSON.stringify({ error: `Import failed: ${error.message}` }));
          });
          break;
        }

        // A `?viewmap=` link's own answer to "the file it named isn't
        // registered": the name is `import-<host>_<port>.bzw`
        // (`remoteMapFileName`), so it still says which server to ask even
        // once bzo has let its cached copy go, or never fetched it in this
        // process at all. Reused rather than re-fetched inside
        // `IMPORT_REUSE_MS` of its last import -- the same server's world is
        // not worth downloading twice in the same sitting -- otherwise this
        // is `performRemoteMapImport` again, including its public-list check
        // -- which an unlisted server's own already-cached file satisfies,
        // so a link outlives the target leaving the list, not just bzo's
        // reuse window -- just triggered by a link instead of a click.
        case 'importMapForView': {
          const file = typeof message.file === 'string' ? message.file : '';
          // `reason`, not `error`: a bare top-level `error` string is the
          // generic admin-response shortcut (handleServerMessage's own
          // "Some admin/operator responses are sent without a message type"
          // check) and would short-circuit past `type` entirely, so this
          // reply would never reach `handleImportMapForViewResult` and the
          // client's pending join would wait forever.
          const reply = (success, extra = {}) => {
            ws.send(JSON.stringify({ type: 'importMapForViewResult', file, success, ...extra }));
          };
          const target = parseImportMapFileName(file);
          if (!target) {
            reply(false, { reason: 'not a remote server\'s import file' });
            break;
          }
          const { host, port } = target;
          const existing = MAP_REGISTRY.get(file);
          if (existing && (Date.now() - existing.registeredAt) < IMPORT_REUSE_MS) {
            reply(true, { viewableMaps: getViewableMapsList() });
            break;
          }
          log(`A viewmap link is importing a remote map from ${host}:${port}`);
          performRemoteMapImport(host, port).then(({ safeMapName, byteLength, reused }) => {
            log(reused
              ? `Viewmap link reused the cached copy of ${host}:${port}, ${safeMapName} (${byteLength} bytes)`
              : `Viewmap link imported remote map ${host}:${port} as ${safeMapName} (${byteLength} bytes)`);
            reply(true, { viewableMaps: getViewableMapsList() });
          }).catch((error) => {
            logError(`Remote map import from ${host}:${port} for a viewmap link failed:`, error);
            reply(false, { reason: error.message });
          });
          break;
        }

        case 'setOperatorConfig': {
          if (refuseNonOperator(ws, player, 'setOperatorConfig')) break;
          const requested = {};
          for (const key of OPERATOR_CONFIG_KEYS) {
            if (Object.prototype.hasOwnProperty.call(message, key)) requested[key] = message[key];
          }
          if (Object.keys(requested).length === 0) {
            ws.send(JSON.stringify({ error: 'No supported operator setting provided' }));
            break;
          }
          const outcome = applyServerConfigChanges(requested, `operator "${player.name}"`);
          if (outcome.error) {
            ws.send(JSON.stringify({ error: outcome.error }));
            break;
          }
          // Nothing to send after a restart: the clients are already reloading,
          // and a map list for a world that is going away is noise.
          if (!outcome.restarted) sendMapList(ws);
          ws.send(JSON.stringify({ success: true, restarted: Boolean(outcome.restarted) }));
          break;
        }

        // Deliberately not part of `setOperatorConfig`/`OPERATOR_CONFIG_KEYS`:
        // that state rides in `init.operatorConfig`, sent to every connecting
        // player (see getOperatorConfigState), and this server's own list
        // server credential must never reach a client that is not this
        // operator. Applied live -- "no restart, no new auth surface" -- and
        // only ever echoed back as whether a key is now configured, never the
        // value itself.
        case 'setListServerKey': {
          if (refuseNonOperator(ws, player, 'setListServerKey')) break;
          const key = typeof message.key === 'string' ? message.key.trim() : '';
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            config.listServerKey = key;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
          } catch (error) {
            logError(`Failed to update config at ${configPath}:`, error);
            ws.send(JSON.stringify({ error: 'Failed to update config' }));
            break;
          }
          LIST_SERVER_KEY = key;
          serverConfig.listServerKey = key;
          log(`[LISTSERVER] key ${key ? 'configured' : 'cleared'} by operator "${player.name}"`);
          if (key) reportToListServer('boot');
          ws.send(JSON.stringify({ success: true, listServerKeyConfigured: Boolean(key) }));
          break;
        }
      }
    } catch (err) {
      logError('Error handling message:', err.stack || err.message);
    }
  });

  // Handle disconnect
  ws.on('close', () => {
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
    dropPlayerFlag(player.id);
    players.delete(player.id);
    if (wasJoined) reportToListServer('part');
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
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', () => reportListServerShutdown('SIGTERM'));
process.on('SIGINT', () => reportListServerShutdown('SIGINT'));

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
