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
const { WebSocketServer } = require('ws');
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
  findShotObstacle,
  findShotSegmentImpact,
  getBaseTeamAtPoint,
  getBaseTopY,
  getShotTeleporterDims,
  findTankObstacle,
  getColliderLocalPoint,
  getObstacleHeight,
  getShotObstacleNormal,
  getTankLocalAngle,
  isOverFlatTop,
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
  createSessionStore,
} = require('./server/sessions.cjs');
const {
  createLagTracker,
  formatLagStats,
  compareByLag,
  PING_INTERVAL_MS,
} = require('./server/lag.cjs');
const {
  COMMAND_TIER,
  parsePlayerTarget,
  bearingToRotation,
  rotationToBearingName,
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

// bzflag.org's global login, as a probe rather than a feature. Nothing here
// grants anything: it answers whether the weblogin round trip and the token
// check work for a server like bzo, and it prints what came back. See
// AGENTS.md, "What a real login would look like".
//
// Two routes because the flow has two halves. `/login/start` is the redirect
// -- `misc/checkToken.php` requires that the site send the player to
// bzflag.org's own form rather than collecting a password itself, and a 302
// from here is exactly that. `/login` is where bzflag.org sends them back.
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

// Both endings of a login are a redirect to `/`, so the page reloads and comes
// back on a fresh socket -- there is no identity to migrate onto a live
// connection, and a failed login needs nothing beyond clearing the cookie.
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
function finishLogin(res, sessionId) {
  if (sessionId) {
    res.cookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS,
    });
    res.redirect(302, '/');
    return;
  }
  res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  res.redirect(302, '/#login=failed');
}

// One route for both halves, because the query string already says which is
// wanted: arriving with no `t` at all is someone who has not been to
// bzflag.org yet, and arriving with one is bzflag.org sending them back.
app.get('/login', loginRateLimit, async (req, res) => {
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
    // shape known to work.
    const callback = `https://${host}/login?t=%TOKEN%:%USERNAME%`;
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
  // Plain text, and nothing the query string carried is echoed into it: what
  // comes back is either a fixed sentence or bzflag.org's own reply, which is
  // the raw material the probe exists to show. A reflected `t` would be markup
  // in a response of bzo's own making -- text/plain or not, that is a page an
  // attacker wrote -- and the log line below already records the value for
  // anybody diagnosing a real callback.
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
      finishLogin(res, null);
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
    finishLogin(res, sessionId);
  } catch (err) {
    logError('[LOGIN] CHECKTOKENS failed', err);
    finishLogin(res, null);
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
        health: player.health,
        kills: player.kills,
        deaths: player.deaths,
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
      fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions.serialize()), { mode: 0o600 });
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
    // target. `WA`, the one type bzo does not carry, is already absent from the
    // pool, so naming it is not an error -- it asks for nothing that was there.
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
      } else if (value === '_maxBumpHeight') {
        // How high a step a tank may climb without jumping. Zero is meaningful
        // -- a world with no bump-climbing at all -- so the floor is 0 rather
        // than some positive minimum.
        const bump = Number(setValue);
        if (Number.isFinite(bump) && bump >= 0) {
          options.maxBumpHeight = bump;
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
  return values.slice(0, 3).map((value) => Math.max(0, Math.min(1, value)));
}

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
  // A world weapon occupies nothing, so it is not an obstacle.
  const weapons = [];
  let currentWeapon = null;
  const unreadWeaponKeywords = new Set();
  const unreadWeaponTypes = new Set();

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
        // A type with no `FLAG_TYPES` row matched nothing above, so it is
        // recorded here for the load to name. That is `WA`, which bzo does not
        // carry and will not (see docs/flags.md), or a typo in the map.
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
    } else if (current && (BZW_FACE_GROUPS.has(token) || token === 'color' || token === 'diffuse')
      && current.kind !== 'base' && current.kind !== 'teleporter') {
      // The colour a map paints an obstacle, which the branch above reads as a
      // team on a base -- upstream's CustomBase takes the word that way too --
      // and which a teleporter has no use for, since bzo's carries its own
      // materials. Everything else a material block can say is skipped here
      // rather than rejected: `top texture foo` names faces bzo understands and
      // a property it does not, and arrives as an untextured box either way.
      const words = line.split(/\s+/);
      const group = BZW_FACE_GROUPS.get(token);
      const keyword = (group ? words[1] || '' : words[0]).toLowerCase();
      if (keyword === 'color' || keyword === 'diffuse') {
        const tint = parseBzwColor(words.slice(group ? 2 : 1));
        if (tint) {
          if (group !== 'caps') current.wallColor = tint;
          if (group !== 'walls') current.capColor = tint;
        }
      }
    } else if (current && token === 'end') {
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
  if (unreadWeaponKeywords.size > 0) {
    log(
      `Ignoring weapon keywords bzo does not read in ${filename}:`
      + ` ${Array.from(unreadWeaponKeywords).sort().join(', ')}`
      + ' (those weapons fire on their timer instead)'
    );
  }
  if (unreadWeaponTypes.size > 0) {
    log(
      `Weapon types bzo does not have in ${filename}:`
      + ` ${Array.from(unreadWeaponTypes).sort().join(', ')}`
      + ' (those weapons fire an ordinary shell)'
    );
  }

  const teleporterGraph = buildTeleporterLinks();
  return {
    obstacles,
    teleporterGraph,
    teamMode,
    serverOptions,
    zones,
    weapons,
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
// The map's `weapon` blocks. Upstream's `WorldWeapons` list, which is the
// world's and not any player's.
let WORLD_WEAPONS = [];
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
  WORLD_WEAPONS = mapData.weapons;
  if (WORLD_WEAPONS.length > 0) {
    log(`Loaded ${WORLD_WEAPONS.length} world weapons from ${mapPath}`);
  }
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
if (mapServerOptions.unreadBZDBVars?.length > 0) {
  log(
    `Ignoring -set variables bzo does not read:`
    + ` ${Array.from(new Set(mapServerOptions.unreadBZDBVars)).sort().join(', ')}`
  );
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
      alive: candidate.health > 0,
      // PlayerInfo::isPlaying, `state > PlayerInLimbo`: in the game, alive or
      // not. A bzo player who is in the roster and has joined is exactly that.
      playing: true,
      // Score::ranking, or a random number under `-rabbit random` -- upstream
      // replaces the whole function for that mode (Score::setRandomRanking)
      // rather than branching inside the selection loop.
      ranking: RABBIT_SELECTION === 'random'
        ? Math.random()
        : getPlayerRanking(candidate.kills, candidate.deaths),
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
    this.health = 0;
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
    handleRabbitSpawn(this);
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
      teleportCooldownUntil: this.teleportCooldownUntil,
    };
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
// This replaced a courtesy gate: any name that was not `Player <n>` used to
// count, on the reasoning that a typed name was at least deliberate. It is gone
// rather than kept alongside, because a player who never logged in being an
// admin would make the login decorative.
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
        observer: other.team === 'observer',
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
    if (victim.health <= 0) {
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

// FlagCommand (commands.cxx:156), `<reset|up|show>`. Upstream's `up` sends every
// superflag away and leaves the slots to refill; `reset` puts them all back;
// `show` reports each one.
// `drop` is bzo's own. Upstream's FlagCommand takes `<reset|up|show>`
// (commands.cxx:593) and has no way to take a flag off one player: `up` sends
// every superflag in the world away, which on a map built for testing flags
// empties the thing you are standing on. bzo is developed by driving it, and the
// move that costs a test run is being handed the wrong flag -- so this is the
// other half of `/mv`: put the tank on the zone you want, drop what it is
// carrying, and take the one that is there.
defineCommand('/flag', COMMAND_TIER.OPERATOR,
  '<reset|up|show|drop [player]> - reset, remove or show the flags, or drop one player\'s',
  (player, args) => {
    const trimmed = args.trim();
    const what = trimmed.toLowerCase();
    if (what === 'drop' || what.startsWith('drop ')) {
      const rest = trimmed.slice(4).trim();
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
        zapFlag(flag);
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
      let shown = 0;
      flags.forEach((flag) => {
        if (flag.status === FLAG_STATUS.NO_EXIST) return;
        const owner = flag.owner !== null && players.has(flag.owner)
          ? ` on "${players.get(flag.owner).name}"`
          : '';
        replyToPlayer(player, `#${flag.index} ${flag.type || 'none'}`
          + ` at ${flag.position.x.toFixed(0)},${flag.position.y.toFixed(0)},${flag.position.z.toFixed(0)}${owner}`);
        shown += 1;
      });
      if (shown === 0) replyToPlayer(player, 'No flags are in the world');
      return;
    }
    replyToPlayer(player, 'Usage: /flag <reset|up|show|drop [player]>');
  });

// `/mv` is bzo's own: upstream has no command that moves a tank anywhere in
// bzfs, and no API call for it either. It is here because bzo is developed by
// driving it -- `testSpawn` in server.json does this on join, and this is the
// same thing without a restart. See parseMoveCoordinates for the grammar.
defineCommand('/mv', COMMAND_TIER.OPERATOR,
  '[player] <x,z|x,y,z|x,y,z,facing> [facing] - move a tank to a position; height and facing are optional',
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

    const rotation = parsed.bearing === null
      ? subject.rotation
      : bearingToRotation(parsed.bearing);
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

// Which settings can be changed without starting a new game. Everything else is
// a new game -- the map today, and the game's shape when the panel grows into it
// -- because bzo resolves the world and the team layout once at boot. See
// docs/operator-panel-plan.md: a map change, a mode change and a match ending are
// one event, so they take one path.
const LIVE_CONFIG_KEYS = Object.freeze(['motd', 'shotMaxActive', 'ricochet']);

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
    motd: serverConfig.motd || '',
    shotMaxActive: GAME_CONFIG.SHOT_MAX_ACTIVE,
    ricochet: GAME_CONFIG.ALL_SHOTS_RICOCHET,
    mapFile: serverConfig.mapFile || '',
    teams: serverConfig.teamMode === true || serverConfig.teamMode?.enabled === true,
    rabbit: normalizeRabbitSelection(serverConfig.rabbit) || 'off',
    jumping: serverConfig.jumping !== false,
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
    motd: serverConfig.motd || '',
    shotMaxActive: GAME_CONFIG.SHOT_MAX_ACTIVE,
    ricochet: GAME_CONFIG.ALL_SHOTS_RICOCHET,
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
// never said out loud. Upstream reaches that by trying its table and answering
// "Unknown command"; the reason it matters here is that bzo used to broadcast
// the line, so a mistyped `/kick bob` announced itself to the room.
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
    broadcastAll({ type: 'playerUpdated', player: other.getState() });
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
    log(`[COLLISION] ${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)} ${obs.name}:${obs.type}`
      + ` ${obs.x.toFixed(2)},${base.toFixed(2)},${obs.z.toFixed(2)} rot:${obs.rotation.toFixed(2)},`
      + ` h:${getObstacleHeight(obs).toFixed(2)}, top:${getColliderTopY(obs).toFixed(2)}`);
  }
  return obs;
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
const SPAWN_DROP_FUDGE = 0.001;

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
    if (!isOverFlatTop(obs, x, z)) continue;
    tops.push((obs.baseY || 0) + getObstacleHeight(obs));
  }

  if (clearance(y)) {
    // Falling: highest top below the start, else the ground.
    const below = tops.filter((top) => top <= y).sort((a, b) => b - a);
    for (const top of below) {
      if (clearance(top)) return top + SPAWN_DROP_FUDGE;
    }
    if (y >= 0 && clearance(0)) return SPAWN_DROP_FUDGE;
    return y + SPAWN_DROP_FUDGE;
  }

  // Climbing: lowest top at or above the start that the tank fits on.
  const above = tops.filter((top) => top >= y).sort((a, b) => a - b);
  for (const top of above) {
    if (clearance(top)) return top + SPAWN_DROP_FUDGE;
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
// server's own arrival gap, which is what this function used to compute
// unconditionally.
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
  // Shot originates from barrel end, which is ~3 units from tank center
  const barrelLength = 3.0;

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
    // Phantom Zone's `PlayerState::FlagActive`. Sent as the state it is rather
    // than as a toggle, so a client that predicted its own crossing converges on
    // this instead of flipping a second time.
    zoned: flag.zoned === true,
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
function grabFlag(player, flag, now = Date.now()) {
  if (player.team === 'observer') return;
  if (player.health <= 0 || player.paused) return;
  if (getPlayerFlag(player.id)) return;
  if (flag.status !== FLAG_STATUS.ON_GROUND) return;

  const reach = GAME_CONFIG.TANK_SPEED + BZFLAG_TANK_RADIUS + FLAG_RADIUS;
  const extrapolated = player.getExtrapolatedPosition(now);
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
  if (player.health <= 0 || player.paused) return;
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
  if (player.health <= 0 || player.paused) return;

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
    // Even for a tank that is already dead: the capture is what decides where it
    // comes back, whether or not it was standing when the flag went.
    victim.restartOnBase = true;
    if (victim.health <= 0) return;
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
    if (player.health <= 0 || player.paused || player.team === 'observer') return;
    const flag = getPlayerFlag(player.id)?.type ?? null;
    if (crushesOnContact(flag)) anyRoller = true;
    if (isCrushedByAnyone(flag)) anyCrushable = true;
  });
  if (!anyRoller && !anyCrushable) return;

  const rollers = [];
  players.forEach((player) => {
    if (player.health <= 0 || player.paused || player.team === 'observer') return;
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
    if (victim.health <= 0 || victim.paused || victim.team === 'observer') return;
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
  if (player.team === 'observer') return false;
  if (player.health <= 0 || player.paused) return false;
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
    if (other.team === 'observer' || other.health <= 0) return;
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
    if (player.team === 'observer') return; // Observers are non-combatants
    if (player.paused) return; // Can't hit paused players
    if (player.health <= 0) return; // Can't hit dead players

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
// Every death in bzo runs this and nothing runs a copy of it. It used to have
// three copies -- a shot, a self-destruct and a capture -- and two of them had
// already drifted: neither the self-destruct nor the capture cleared the lock,
// so a missile kept steering at a tank that was already exploding, and the
// self-destruct had to be told about the rabbit separately. That is what a
// second copy of a list like this costs, so there is one.
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
  victim.health = 0;
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
    type: 'playerHit',
    victimId: victim.id,
    shooterId: killerId,
    projectileId: null,
    ...hit,
  });

  setTimeout(() => {
    if (!players.has(victim.id)) return;
    victim.respawn();
    broadcastAll({ type: 'playerRespawned', player: victim.getState() });
  }, GAME_CONFIG.RESPAWN_DELAY);
}

function killPlayer(victim, killer, reason, projectileId = null, shooterId = null) {
  // "victim was already dead. keep score." Upstream's own guard, and bzo needs
  // it for the same reason plus one of its own: genocide kills a team in a loop,
  // and a team killer who dies for the first of them must not die again for the
  // rest.
  if (victim.health <= 0) return;

  victim.deaths++;

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
    if (other.health <= 0) return;
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
    if (player.team === 'observer') return;
    if (player.paused) return;
    if (player.health <= 0) return;
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

  fireWorldWeapons(now);
  applySteamrollerSweep(now);
  expireLockTargets();
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
    const now = Date.now();
    player.lastPongTime = now;
    player.isAlive = true;
    // `LagInfo::updatePingLag` (LagInfo.cxx:96). The keep-alive ping was already
    // making this round trip; recording when it went out is the whole of the
    // measurement, and costs no message of its own -- ping and pong are
    // WebSocket frames.
    player.lag.pongReceived(now);
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
  // Never silently: an operator who turned this on should see it happen, and an
  // operator who did not mean to should see it too.
  // Kept for `/playerlist`, which is upstream's "list player slots, names and IP
  // addresses". It is the forwarded address where there is one, so it is only as
  // trustworthy as the proxy -- see docs/commands-plan.md on why a ban cannot
  // rest on it as read.
  player.clientIP = clientIP;
  player.localAdmin = isLocalAdminRequest(LOCAL_ADMIN, req.socket.remoteAddress, req.headers);
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
    // bzfs.cxx:2437 sends MsgNewRabbit to a joining player for the same reason:
    // the rabbit is world state, not an event, so a client that arrives mid-game
    // has to be told who it is.
    rabbitId: rabbitPlayerId,
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
          // it is never said out loud. A mistyped `/kick bob` used to announce
          // itself to the room.
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
          if (player.team === 'observer' || player.health <= 0 || player.paused) break;
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
          if (player.health <= 0) break;
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
          if (player.health <= 0) break;
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
          if (player.team === 'observer') break;
          if (player.health <= 0) break;
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
            teamPlayerScores[candidate.team] = (teamPlayerScores[candidate.team] || 0) + candidate.kills - candidate.deaths;
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
          player.lag.resetUpdateGap();
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
          if (refuseNonOperator(ws, player, 'getMaps')) break;
          // Reply with all .bzw files in maps/ plus 'random', and indicate current map
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
