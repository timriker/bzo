/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The bzfs proxy: a browser playing on a real BZFlag server, or watching a
// recording, through this one (docs/proxy-plan.md, docs/replay.md). What it
// needs of the server it is handed by `useServer`, once, before the first
// connection.

const crypto = require('crypto');
const { URLSearchParams } = require('url');
const {
  ADMIN_PLAYERS,
  ALL_PLAYERS,
  FIRST_TEAM,
  isRealPlayerId,
  LAST_REAL_PLAYER,
  NO_PLAYER,
  SERVER_PLAYER,
} = require('./player-ids.cjs');
const {
  allowTeams,
  getPlayerTeamColor,
  getTeamColorIndex,
  getTeamFromColorIndex,
  isColorTeamIndex,
  PLAYER_TEAM,
  PLAYER_TEAMS,
  teamModeFromMaximums,
} = require('./teams.cjs');
const {
  AUTOMATIC_TEAM,
  COMPUTER_PLAYER,
  decodeGameSettings,
  findPublicServer,
  GAME_OPTION_BITS,
  GAME_STYLES,
  guestReply,
  TANK_PLAYER,
} = require('./remote-world-import.cjs');
const {
  BLOWED_UP,
  ACTION_MESSAGE: BZFS_ACTION_MESSAGE,
  NO_PLAYER: BZFS_NO_PLAYER,
  PLAYER_STATUS: BZFS_PLAYER_STATUS,
  SERVER_PLAYER_ID: BZFS_SERVER_PLAYER,
  BzfsSession,
  CHAT_TEXT_MAX,
  splitBzfsChat,
  toBzfsChatText,
} = require('./bzfs-session.cjs');
const { bzdbIsTrue, evalBzdb, worldConfig } = require('../public/js/bzdb.mjs');
const { CLIENT_TYPE, clientTypeOf } = require('./client-type.cjs');
const { DEFAULT_VOICE_CHANNEL } = require('../public/js/voice-channels.mjs');
const {
  isAdminSession,
  isLocalAdminRequest,
  parseCookies,
  SESSION_COOKIE_NAME,
} = require('./sessions.cjs');
const { isHeadsetBrowserUA } = require('../public/js/headset.mjs');
const { proxyUrlKey } = require('./proxies.cjs');
const { ReplaySession } = require('./bzfs-replay-room.cjs');
const { sanitizeHost } = require('./server-name.cjs');
const {
  FLAG_STATUS,
  FLAG_TYPES,
  getFlagTeamIndex,
  shotRicochets,
  togglesZoneOnTeleport,
} = require('../public/js/flags.mjs');

// What it needs of server.js, from `useServer`. The three that change while
// the server runs -- `MAP_SOURCE`, `forwardedForPolicy`, `forwardedProxyPeer`
// -- are read through `server` each time instead.
let server = null;
let ADMIN_GROUPS;
let ADMIN_WHITELIST;
let bzfsWorlds;
let CLIENT_BUILD;
let currentWorldTime;
let getProxyDestinations;
let getRemoteServerList;
let getViewableMapsList;
let importProxyWorld;
let importReplayWorld;
let isLocalAdminHttp;
let LOCAL_ADMIN;
let log;
let logError;
let MAP_REGISTRY;
let MAX_REAL_PLAYERS;
let parseHostPort;
let PROXY_LOGIN_COOKIE;
let PROXY_TARGETS;
let PROXY_TARGETS_BY_URL;
let proxyTargetStatus;
let replayFilePath;
let replayRoomFor;
let SERVER_VERSION;
let sessions;
let takeProxyToken;
let TEAM_MODE;
let vec3Point;
let voiceRtcConfigFor;
let worldBase;

function useServer(deps) {
  server = deps;
  ({
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
  } = deps);
  PROXY_CLIENT_VERSION = `${SERVER_VERSION}.${CLIENT_BUILD}-bzo-web`;
}

// ---------------------------------------------------------------------------
// Proxy mode: a browser watching a real bzfs through bzo. docs/proxy.md.
//
// A proxy connection is not a player in this server's own game. It is never in
// `players`, so nothing here simulates for it, broadcasts to it or scores it --
// bzo stops being a game server for that socket and becomes a codec. What it
// gets instead is a `BzfsSession` of its own and an `init` synthesized from
// what that session's target says to a joining player.
//
// Ids are the target's, unchanged. bzfs allots a `PlayerId` per connection and
// names every player by it, and bzo numbers players out of the same space
// (`server/player-ids.cjs`), so a proxied roster needs no table and no shift --
// the slot the target calls 3 is the slot bzo calls 3.
// ---------------------------------------------------------------------------

// What a target's player list calls bzo, in the shape `getAppVersion()` builds
// (`buildDate.cxx:138-150`): the release, the build that distinguishes two
// servers on it, then what this client is. bzfs reads the first three numbers
// with `sscanf(..., "%d.%d.%d", ...)` and keeps the rest as typed
// (`PlayerInfo::processEnter`, PlayerInfo.cxx:156-162) -- it neither validates
// them nor gates on them, and `/clientquery` prints the whole string, so the
// release a proxied player is actually running is the useful thing to put
// here. Capped at `VersionLen` 60 (`global.h:34`), which this cannot reach.
// `MaxUpdateTime` (`Player.cxx:38`), in ms: how long a native client will go
// without reporting, whatever its tank is doing.
const PROXY_MAX_UPDATE_INTERVAL = 1000;
// Set by `useServer`, which has the release and build.
let PROXY_CLIENT_VERSION = null;
// The motto a target's player list shows beside the callsign: which bzo this
// player came through, taken from the Host they reached it on. That is the one
// fact the operator on the other end cannot work out for themselves -- several
// instances may proxy the same server (see docs/proxy.md) -- and it is
// what a native client sees with `showMotto`.
// How long a player's own motto may be. bzo's own, and shorter than
// upstream's 128-byte `MOTTO_LEN` because nothing carries it off this server:
// it is drawn on a scoreboard row beside a name, a flag and several marks,
// and a long one crowds all of them out.
const MAX_MOTTO_LENGTH = 40;

// Bounded rather than trusted: a motto reaches every other player's
// scoreboard, and a proxied one is carried to a target with its own
// `MOTTO_LEN` to respect. Control characters go because this is drawn as text
// on two surfaces and packed into a fixed-width field on a third.
function sanitizeMotto(value) {
  if (typeof value !== 'string') return '';
  let clean = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f) clean += ch;
  }
  return clean.trim().slice(0, MAX_MOTTO_LENGTH);
}

// What a target's player list is told about this connection. Deliberately
// *only* the attribution: a player's own motto is not forwarded, because this
// field is one of the few ways a proxied connection announces itself at all
// and sharing it would be giving that away for decoration.
function proxyMotto(req) {
  const host = sanitizeHost(req.headers.host);
  if (!host) return 'via bzo';
  // The same reading of the handshake the connect log makes: a bzo behind the
  // README's proxy is reached over TLS and says so, one reached directly on
  // plain HTTP does not claim otherwise.
  const secure = req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
  return `via ${secure ? 'https' : 'http'}://${host}`;
}
// Chat, both ways. The two wires name the same destinations with different
// numbers: bzo spends small negatives on everything that is not a player
// (`docs/network.md`), where bzfs counts down from 251 for teams and reserves
// the top of the byte for "all" and "admin".
// Chat, both ways. The two wires now number the same things the same way
// (`server/player-ids.cjs`), so this is a translation in one place only:
// which team. Upstream names the team a line went to and bzo says only "mine".
function proxyChatSource(from) {
  return isRealPlayerId(from) ? String(from) : from;
}

function proxyChatDestination(to) {
  // Anything above the last real player and below `AdminPlayers` is one of
  // the eight teams, and a proxied client can only be on one of them.
  if (isRealPlayerId(to)) return String(to);
  return to <= FIRST_TEAM && to > LAST_REAL_PLAYER ? FIRST_TEAM : to;
}

// The other direction, for a line the browser typed. `team` is this viewer's
// own team index on the target, since that is the only team it can address.
function bzfsChatDestination(target, team) {
  if (target === FIRST_TEAM) return FIRST_TEAM - team;
  // bzo's SERVER destination is a line the server itself answers, and a proxy
  // has no answers of its own -- so it goes to the target like anything else.
  if (target === SERVER_PLAYER) return ALL_PLAYERS;
  if (isRealPlayerId(target)) return Number(target);
  return target === ADMIN_PLAYERS ? ADMIN_PLAYERS : ALL_PLAYERS;
}

// A callsign for a viewer who has not signed in. The name a target sees is
// never the client's to choose (docs/proxy.md, "What a proxy connection
// is"), so an anonymous browser is given one. A target refuses a callsign
// already on it, so the name has to differ from every other viewer's -- this
// server's, a restarted one's still timing out there, and every other bzo's
// -- which a counter alone cannot promise and a random tag can.
function proxyViewerCallsign() {
  return `bzo-view-${crypto.randomBytes(3).toString('hex')}`;
}

// Which target a WebSocket is for, or null for an ordinary connection to this
// server's own game. Read off the handshake's own query string, because `init`
// is sent the moment a socket opens -- long before a client could say which
// server it wanted.
//
// `?proxy=<target>` on the page, and the same parameter on the socket. A path
// segment would have been the tidier URL and is what `/login/<target>` uses,
// but the page is one file of relative asset references: served at
// `/proxy/...` every one of them resolves a directory deep and 404s. A query
// parameter is also the shape `?viewmap=` already established for "the same
// client, pointed somewhere else".
// Which game a socket is for. Two spellings, one shape: `?proxy=` names a
// target the operator configured and may ask for any team it offers, and
// `?watch=` names any server on the public BZFlag list and is always an
// observer. A watch is a proxy with the team forced and the token withheld,
// so everything past this point is the same code -- only `kind` differs, and
// only for how the request is authorised (`authoriseProxyRequest`).
//
// Both travel as `host_port` rather than `host:port` (`proxyUrlKey`): a colon
// in a query value makes a browser offer to search for the address instead of
// showing it. `host:port` stays the identity everywhere else.
function resolveProxyRequest(url) {
  if (typeof url !== 'string') return null;
  const query = url.indexOf('?');
  if (query === -1) return null;
  const params = new URLSearchParams(url.slice(query + 1));

  // One of this instance's own recordings, always watched: nothing is dialled,
  // and the room stands in for the target (`ReplaySession`).
  const replayName = params.get('replay');
  if (replayName) {
    return {
      kind: 'replay',
      key: replayName,
      team: PLAYER_TEAM.OBSERVER,
      target: Object.freeze({
        key: replayName,
        urlKey: replayName,
        displayHost: 'replay',
        displayPort: 0,
        host: 'replay',
        port: 0,
      }),
    };
  }

  const watchSpec = params.get('watch');
  if (watchSpec) {
    const parsed = parseHostPort(watchSpec.replace(/_(\d+)$/, ':$1'));
    const key = parsed ? `${parsed.host}:${parsed.port}` : watchSpec;
    const asked = params.get('team');
    return {
      kind: 'watch',
      key,
      // An observer, unless a team is asked for: then an admin plays, under a
      // name nobody has registered (`guestCallsign`), since the forum callsign
      // would need a token bzfs cannot check from here.
      team: (asked === PLAYER_TEAM.AUTOMATIC || PLAYER_TEAMS.includes(asked))
        ? asked
        : PLAYER_TEAM.OBSERVER,
      target: parsed ? Object.freeze({
        key,
        urlKey: proxyUrlKey(key),
        displayHost: parsed.host,
        displayPort: parsed.port,
        host: parsed.host,
        port: parsed.port,
      }) : null,
    };
  }

  const key = params.get('proxy');
  if (!key) return null;
  // The team rides on the socket's own URL because bzfs fixes it at
  // `MsgEnter` and has no message for changing it afterwards -- there is no
  // `MsgSetTeam` in the protocol. So picking a team is opening a connection,
  // the same way picking a target is, and a team bzo does not recognise
  // watches rather than guessing at a colour.
  const asked = params.get('team');
  return {
    kind: 'proxy',
    key,
    target: PROXY_TARGETS_BY_URL[key] || null,
    // `automatic` is the entry dialog's own first option and upstream's
    // `AutomaticTeam`, so it travels as itself rather than being resolved
    // here: the target runs `autoTeamSelect` on every join (`bzfs.cxx:2299`)
    // and knows its own team sizes, which this proxy does not.
    team: (asked === PLAYER_TEAM.AUTOMATIC || PLAYER_TEAMS.includes(asked))
      ? asked
      : PLAYER_TEAM.OBSERVER,
    // `?bot`, the browser's own join as a robot tank, carried to the target.
    bot: params.has('bot'),
  };
}

// Whether this socket may have the game it asked for, and under what name.
// The only place the two kinds differ.
//
// A proxied target is the operator's own configuration, so naming the ones
// that exist turns a dead link into a signpost. A watched one is any server
// on the public list -- the same rule the map importer applies, since
// watching *is* that connection held open -- but only for an admin of this
// instance who is signed in: the login is what makes the forum name sendable
// at all, and admin is the gate on connecting somewhere the operator never
// configured (`docs/list-server-plan.md`).
async function authoriseProxyRequest(req, request) {
  // Anyone may watch a replay this instance holds, as anyone may view its maps.
  if (request.kind === 'replay') {
    return replayFilePath(request.key)
      ? { allowed: true }
      : { allowed: false, error: 'This server has no replay by that name.' };
  }
  if (request.kind !== 'watch') {
    if (request.target) return { allowed: true };
    const offered = Object.values(PROXY_TARGETS).map((target) => target.urlKey);
    return {
      allowed: false,
      error: offered.length > 0
        ? `This server does not proxy that server. It proxies: ${offered.join(', ')}`
        : 'This server does not proxy any servers.',
    };
  }

  const cookies = parseCookies(req.headers.cookie);
  const session = sessions.get(cookies[SESSION_COOKIE_NAME]);
  const callsign = session && typeof session.callsign === 'string' ? session.callsign : '';
  // This server's own operator, on this machine, is an admin here without a
  // login, as everywhere else (`localAdmin`).
  const localAdmin = isLocalAdminRequest(req.socket.remoteAddress, req.headers, {
    enabled: LOCAL_ADMIN,
    whitelist: ADMIN_WHITELIST,
    forwardedForPolicy: server.forwardedForPolicy,
    proxyPeer: server.forwardedProxyPeer,
  });
  if (!callsign && !localAdmin) return { allowed: false, error: 'Watching needs a global login.' };
  if (!localAdmin && !isAdminSession(session, ADMIN_GROUPS)) {
    return { allowed: false, error: "Watching is limited to this server's admins." };
  }
  if (!request.target) return { allowed: false, error: 'Expected watch=<host>_<port>' };

  // Never a bare catch into "allow": a list that could not be fetched is a
  // check that did not happen.
  let listed = false;
  try {
    const servers = await getRemoteServerList();
    listed = Boolean(findPublicServer(servers, request.target.host, request.target.port));
  } catch (error) {
    return { allowed: false, error: `Could not reach the BZFlag list server: ${error.message}` };
  }
  if (!listed) {
    return { allowed: false, error: `${request.key} is not in the public BZFlag server list` };
  }
  // Watching: the forum name bzo verified, sent as itself. The remote cannot
  // check the claim and marks the player unverified regardless, so the motto
  // naming this instance is what an operator actually has to act on.
  // Playing: an unregistered name, which is the only kind that spawns without
  // a token, and that still says whose it is.
  if (request.team !== PLAYER_TEAM.OBSERVER) {
    return { allowed: true, callsign: guestCallsign(callsign), guest: true };
  }
  // No login, no name: a random `bzo-view-<6 hex>` like any anonymous viewer
  // (`proxyViewerCallsign`).
  return { allowed: true, callsign: callsign || null };
}

// `bzo-<callsign>`, for an admin playing on a server outside this one's
// network. A forum callsign is registered, and bzfs removes a registered name
// that has not identified the moment it tries to spawn (`playerAlive`,
// bzfs.cxx:3199); a token cannot be forwarded to it from here, because
// my.bzflag.org compares it with the browser's address (docs/proxy.md). One
// byte short of `CallSignLen`, which bzfs needs for the NUL.
function guestCallsign(callsign) {
  return callsign ? `bzo-${callsign}`.slice(0, 31) : proxyViewerCallsign();
}

// `own` is this connection's own seat and the `T` letter its browser has
// earned, because the target only knows it as a `TankPlayer`.
function proxyPlayerRecord(player, motion = null, own = null) {
  const team = getTeamFromColorIndex(player.team) || PLAYER_TEAM.OBSERVER;
  const position = motion ? { x: motion.pos[0], y: motion.pos[1], z: motion.pos[2] } : { x: 0, y: 0, z: 0 };
  return {
    id: String(player.id),
    name: player.callsign,
    // The tagline a player set on the target. `MsgAddPlayer` has always
    // carried it (`decodeAddPlayer`) and bzo simply never passed it on;
    // upstream draws it beside the callsign on its own scoreboard
    // (`ScoreboardRenderer.cxx:766`).
    motto: typeof player.motto === 'string' ? player.motto : '',
    // Watching a replay live rather than in the recording (`ReplaySession`).
    ...(player.watching ? { watching: true } : {}),
    // Only ever present when the target chose to tell this connection
    // (`MsgAdminInfo`), which it does for a holder of `playerList` and nobody
    // else. `clientIP` is the name bzo's own roster already uses.
    clientIP: typeof player.address === 'string' ? player.address : null,
    x: round2(position.x),
    y: round2(position.y),
    z: round2(position.z),
    azimuth: motion ? round2(motion.azimuth) : 0,
    alive: motion ? motion.alive : false,
    wins: player.wins,
    losses: player.losses,
    tks: player.tks,
    paused: motion ? motion.paused : false,
    autopilot: player.autopilot === true,
    // `MsgAddPlayer` says robot or not and nothing else, and anyone on a
    // bzfs is a BZFlag client until something says otherwise.
    clientType: player.type === COMPUTER_PLAYER ? CLIENT_TYPE.ROBOT
      : (own && String(player.id) === String(own.id) ? own.type : CLIENT_TYPE.BZFLAG),
    forwardSpeed: 0,
    rotationSpeed: 0,
    verticalVelocity: motion ? round3(motion.velocity[2]) : 0,
    jumpAzimuth: null,
    slideAzimuth: undefined,
    airVelocityX: 0,
    airVelocityY: 0,
    // Upstream gives every tank on a team the one team colour
    // (`Team::getTankColor`); bzo's own shading apart of team mates is this
    // server's idea about its own players, and a proxied roster is not that.
    color: getPlayerTeamColor(team),
    tankModel: 'bzflag',
    team,
    voiceMicEnabled: false,
    voiceChannel: DEFAULT_VOICE_CHANNEL,
    // What a player is on the target is the target's to say, and it says so
    // in `MsgPlayerInfo`: these are the `-`, `+` and `@` upstream's own
    // scoreboard draws beside a callsign.
    admin: player.admin === true,
    verified: player.verified === true,
    globalCallsign: null,
    teleportCooldownUntil: 0,
    viewMap: null,
  };
}

// `MsgTeamUpdate` as the scoreboard's team rows. Rogue is in the message and
// not in this list for the same reason `getTeamScoreState` leaves it out: it
// holds no base, no flag and no team score.
function proxyTeamScores(teams) {
  const scores = [];
  teams.forEach((team, index) => {
    if (!team || !isColorTeamIndex(index)) return;
    scores.push({
      team: getTeamFromColorIndex(index),
      size: team.size,
      wins: team.wins,
      losses: team.losses,
    });
  });
  return scores;
}

// Two decimals on a position or an angle, three on a speed: what bzo's own
// move packets carry, and the whole of its compression story
// (`docs/network.md`). Worth keeping here too, since these are the messages
// that arrive many times a second.
function round2(value) {
  return Math.round(value * 100) / 100;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

// One of the target's `MsgPlayerUpdate`s as a bzo move. bzfs sends the
// velocity itself; bzo's `fs` and `rs` are the *inputs* a client would have
// held to produce it, as a fraction of the tank's top speed and turn rate,
// because that is what the receiving client dead-reckons with between
// updates. So the fraction is recovered against the very numbers that client
// will multiply back by -- this server's config with the map's own overlaid,
// which is where the target's `-set` lines already are.
function proxyMove(id, motion, physics) {
  const a = motion.azimuth;
  const [x, y, z] = motion.pos;
  const [vx, vy, vv] = motion.velocity;
  return {
    id: String(id),
    x: round2(x),
    y: round2(y),
    z: round2(z),
    a: round2(a),
    fs: round3((vx * Math.cos(a) + vy * Math.sin(a)) / physics.tankSpeed),
    rs: round3(motion.angVel / physics.tankAngVel),
    vv: round3(vv),
    vx: round3(vx),
    vy: round3(vy),
  };
}

// `proxyMove` inverted: what the browser says about its own tank, in the shape
// bzfs takes it. This is the one thing a proxied player is authoritative about
// today -- upstream has no `positionCorrection` because a client's own
// position is simply believed (`docs/proxy-plan.md`).
//
// bzo's `m` carries a forward speed as a fraction of the world's tank speed
// rather than a velocity, because that is all its own server needs to
// extrapolate. bzfs wants the vector, so it is rebuilt from the heading the
// same way `proxyMove` decomposed it.
function proxyOutboundMotion(message, physics, status) {
  // `PlayerState::Falling` is the target's business as well as the browser's:
  // `shotFired` skips the vertical part of its origin check for a falling
  // tank (`bzfs.cxx:4210`), so a shot fired mid-jump is dropped without it.
  // The browser says whether it is airborne because on a proxied connection
  // it is the authority on that (`air` in client.js's move packet).
  if (message.air) status |= BZFS_PLAYER_STATUS.FALLING;
  const x = Number(message.x) || 0;
  const y = Number(message.y) || 0;
  const z = Number(message.z) || 0;
  const a = Number(message.a) || 0;
  // The velocity the browser is actually moving at, read the way this
  // server's own `getPlayerMotion` reads it: in the air the air velocity the
  // packet carries, which keeps the speed and direction the tank left the
  // ground with whatever it has turned to since; on the ground `fs` -- the
  // speed it achieved, not the one asked for -- along the slide direction
  // where it is sliding, and its heading otherwise. A native client dead
  // reckons from exactly this between updates, so a velocity along the wrong
  // line puts the tank somewhere else on their screen until the next one.
  const airVX = Number(message.vx);
  const airVY = Number(message.vy);
  let vx;
  let vy;
  if (message.air && Number.isFinite(airVX) && Number.isFinite(airVY)) {
    vx = airVX;
    vy = airVY;
  } else {
    const slide = Number(message.sd);
    const azimuth = Number.isFinite(slide) ? slide : a;
    const speed = (Number(message.fs) || 0) * physics.tankSpeed;
    vx = Math.cos(azimuth) * speed;
    vy = Math.sin(azimuth) * speed;
  }
  return {
    pos: [x, y, z],
    velocity: [vx, vy, Number(message.vv) || 0],
    azimuth: a,

    angVel: (Number(message.rs) || 0) * physics.tankAngVel,
    status,
  };
}

// The speeds the *client* will use, which is what `proxyMove` divides by and
// `proxyOutboundMotion` multiplies back: the target's own BZDB over this
// server's base, exactly as the client evaluates it (`worldConfig`).
function proxyPhysics(session) {
  const config = worldConfig(worldBase(), session.state.vars);
  return { tankSpeed: config.TANK_SPEED, tankAngVel: config.TANK_ROTATION_SPEED };
}

// One of the target's flags as a bzo flag state. The two agree about almost
// all of it -- `FlagStatus` is the same enum on both sides, and bzo took the
// team flags' own abbreviations from upstream -- so this is the coordinate
// conversion plus two rules.
//
// Whether a flag is carried is its *status*, not its owner: bzfs leaves the
// packed owner where the last carrier left it, so a flag lying on the ground
// still names whoever dropped it. Upstream's own client reads the owner only
// for `FlagOnTank`, and so does this.
//
// A superflag nobody is carrying is also unidentified, which bzo says with a
// null type and bzfs says by packing the flag as Phantom Zone
// (`Flag::fakePack`). Asking the status rather than the owner is what makes
// the two agree about which flags those are. A real PZ lying on the ground is
// indistinguishable from a hidden one at this end -- and is one bzo would
// have hidden anyway.
function proxyFlagState(flag, zonedOf = () => false) {
  const carried = flag.status === FLAG_STATUS.ON_TANK && flag.owner !== NO_PLAYER;
  const hidden = !carried && !TEAM_FLAG_ABBREVIATIONS.has(flag.type);
  return {
    index: flag.index,
    type: hidden ? null : flag.type,
    status: flag.status,
    owner: carried ? String(flag.owner) : null,
    position: vec3Point(flag.position),
    launchPosition: vec3Point(flag.launchPosition),
    landingPosition: vec3Point(flag.landingPosition),
    flightTime: flag.flightTime,
    flightEnd: flag.flightEnd,
    initialVelocity: flag.initialVelocity,
    // Phantom Zone's own `PlayerState::FlagActive`, which rides on the
    // carrier's update rather than on the flag -- so it is read off them.
    zoned: carried && zonedOf(flag.owner),
  };
}

// `_shotRange / _shotSpeed`, upstream's own default, for a target that sends
// a shot with no lifetime of its own.
const PROXY_DEFAULT_SHOT_LIFETIME = 3.5;

// How long until a shot crosses the world's boundary, in seconds, or Infinity
// for one that never will. Only the two horizontal axes: a shot leaves
// through a wall, and the world has no ceiling to leave through.
// The four team flags, by the abbreviations both bzo and BZFlag give them.
const TEAM_FLAG_ABBREVIATIONS = new Set(['R*', 'G*', 'B*', 'P*']);

// One of the target's shots as a bzo one. The differences are three.
//
// The id: upstream's is a per-player slot plus a counter that makes a reused
// slot a different shot, where bzo wants one id unique across the world, so
// the two halves are spelled out. The slot itself still travels as
// `shotSlot`, which is the same idea under bzo's own name.
//
// The velocity: bzfs sends the one the shooter fired with and leaves each
// screen to make of it what the flag says, where bzo sends the result, a
// heading and a speed (`getShotFlight`). A missile's speed is the world's, so it
// is left to the client, which knows the target's.
//
// And when: `dt` is how long ago it was fired, so a shot that reached this
// proxy late is drawn from where it started rather than from now.
// The pilot each bzo browser on a target flies, by target and player id.
// MsgAutoPilot carries only on or off, so a native client says "Roger" for
// every autopilot; a browser that came through this server told it which
// pilot, and every session on that target can name it.
const proxyPilotNames = new Map();

function proxyShot(shot, ricochetAll) {
  const velocity = vec3Point(shot.velocity);
  const position = vec3Point(shot.pos);
  const flag = shot.flag || null;
  return {
    type: 'shotBegin',
    id: `${shot.player}-${shot.id}`,
    playerId: String(shot.player),
    // FiringInfo's `shot.team`, which a world weapon's shot is drawn in.
    team: getTeamFromColorIndex(shot.team),
    x: round2(position.x),
    y: round2(position.y),
    z: round2(position.z),
    shotSlot: shot.slot,
    vx: round2(velocity.x),
    vy: round2(velocity.y),
    vz: round2(velocity.z),
    flag,
    ricochet: shotRicochets(flag, ricochetAll),
    // A beam's path is walked by whoever owns the simulation, and that is the
    // target -- which sends no path, because its own clients each trace it.
    // So a proxied Laser arrives as the shot it is, without the segments bzo
    // draws a beam from.
    segments: null,
    target: null,
    createdAt: Date.now() - Math.round((shot.dt || 0) * 1000),
  };
}

// Upstream's `BlowedUpReason` (`playing.h:128`) as bzo's own reason strings,
// which carry the same names because bzo took them from there. `GotCaptured`
// has no bzo equivalent -- a capture kills a whole team at once there, which
// is a different rule rather than a death reason -- so it falls through to
// the generic one.
const PROXY_DEATH_REASONS = Object.freeze([
  'shot', 'shot', 'runOver', 'shot', 'genocide', 'selfDestruct', 'water',
]);

// The same table read the other way, for a proxied browser reporting its own
// death. Not the inverse of the list above, which maps several reasons onto
// `'shot'` and could not be inverted: this is the reason bzo's client can
// actually be the first to know, each named by what upstream would have sent.
// `shielded` is not a death at all -- it is a hit a Shield flag absorbed, which
// upstream reports as an ended shot and a dropped flag and no kill -- so it is
// here to be recognised rather than to be packed.
const PROXY_KILL_REASONS = Object.freeze({
  shot: BLOWED_UP.GOT_SHOT,
  runOver: BLOWED_UP.GOT_RUN_OVER,
  genocide: BLOWED_UP.GENOCIDE_EFFECT,
  selfDestruct: BLOWED_UP.SELF_DESTRUCT,
  water: BLOWED_UP.WATER_DEATH,
  physicsDriver: BLOWED_UP.DEATH_TOUCH,
  shielded: BLOWED_UP.GOT_SHOT,
});

// The one message an ordinary connection gets on open, built from a target's
// answer to `MsgEnter` instead of from this server's own game.
// `MsgGameSettings` as its option bits, or null before it has arrived.
function proxyGameOptions(session) {
  const settings = session.state.gameSettings;
  if (!settings || settings.length < 30) return null;
  return decodeGameSettings(settings).gameOptionsBits;
}

// A player id a browser named, as a number the wire can carry, or null for
// "nobody". Its own function because `Number(null)` is 0 and 0 is a real player
// -- so a missile told to chase nobody, or a death with no killer, would name
// whoever holds the first slot instead.
function proxyNamedPlayerId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 && id < BZFS_NO_PLAYER ? id : null;
}

// The flag this connection's own tank is carrying, as the target last said --
// the abbreviation, or null for a tank carrying nothing.
function proxyCarriedFlagType(session) {
  const carried = session.state.flags.find((flag) => flag
    && flag.owner === session.playerId
    && flag.status === FLAG_STATUS.ON_TANK);
  return carried?.type ?? null;
}

// The target's GameType by the name `allowTeams` asks for, for the one question
// bzo asks of it: whether colour teams exist at all, which is what decides who
// may shoot whom. A target that has not sent its settings yet reads as TeamFFA,
// the type upstream's own `-c`/`-offa`/`-rabbit` are all departures from.
function proxyGameType(session) {
  const settings = session.state.gameSettings;
  if (!settings || settings.length < 30) return GAME_STYLES[0];
  return GAME_STYLES[decodeGameSettings(settings).gameType] || GAME_STYLES[0];
}

// bzfs names the nearest flag by its *name* ("Identify"), where bzo's client
// wants the abbreviation every other flag surface is keyed by. Both tables
// come from the same upstream one, so the names line up exactly; a name that
// does not is a flag this bzo has never heard of, and is left alone rather
// than guessed at.
const PROXY_FLAG_ABBREVIATIONS = new Map(
  Object.values(FLAG_TYPES).map((type) => [type.name, type.abbreviation]),
);

// `MsgGameSettings`' own `maxShots`, or null before it has arrived.
function proxyMaxShots(session) {
  const settings = session.state.gameSettings;
  if (!settings || settings.length < 30) return null;
  return decodeGameSettings(settings).maxShots;
}

function buildProxyInit(session, mapEntry, viewer, status, enterTeam, zonedOf, own = null) {
  const players = [...session.state.players.values()]
    .map((player) => proxyPlayerRecord(player, session.state.motion.get(player.id), own));
  const self = players.find((record) => record.id === String(session.playerId));
  return {
    type: 'init',
    clientBuild: CLIENT_BUILD,
    serverVersion: SERVER_VERSION,
    // A proxied session's chat goes to the target, and so do its commands --
    // bzo's own table is not what answers them, and this server has no list of
    // the target's. Completion falls back to the client's local commands and
    // the callsigns it can see.
    commands: [],
    // The target knows this viewer under the callsign it was given and on the
    // team it entered with, and the browser is told exactly that -- including
    // the name, which is why the entry dialog cannot rename it.
    player: {
      ...(self || proxyPlayerRecord({
        id: session.playerId,
        // Only ever reached before the target has answered with our own
        // record, so an `automatic` join has no colour to name yet.
        team: getTeamColorIndex(
          enterTeam === PLAYER_TEAM.AUTOMATIC ? PLAYER_TEAM.OBSERVER : enterTeam,
        ),
        wins: 0,
        losses: 0,
        tks: 0,
        callsign: viewer.callsign,
      })),
      // `verified` is not claimed here: it is whatever `MsgPlayerInfo` said,
      // which is the target's own answer and the only one that means anything
      // on a proxied server. bzfs holds the join until the token check lands
      // (docs/proxy.md), so by the time this is built it knows.
      globalCallsign: viewer.globalCallsign,
    },
    players,
    // This server's own settings that are not BZDB, over which the client
    // evaluates the target's own BZDB (`bzdb` below), every variable bzfs
    // sent, as an upstream client does.
    //
    // Ricochet is read read off the live connection rather than the
    // import: a target's `-r` can be switched on without its world changing,
    // so nothing would re-import, and the client decides with this whether a
    // shot it is flying bounces.
    config: {
      ...Object.fromEntries(
        Object.entries(worldBase()).filter(([key]) => key !== 'MAP_SIZE'),
      ),
      ALL_SHOTS_RICOCHET: proxyGameOptions(session) !== null
        && (proxyGameOptions(session) & GAME_OPTION_BITS.ricochet) !== 0,
      // The two rules the client needs to decide a hit on *itself*, which is
      // what a proxied connection asks of it: bzfs takes the victim's word for
      // a death, so the browser answers `LocalPlayer::checkHit` and has to know
      // what upstream's own `World::allowTeamKills` knows (`World.h:217`).
      // Read off the live connection rather than the import, like ricochet
      // above -- a cached world can be older than the server's own options.
      NO_TEAM_KILLS: proxyGameOptions(session) !== null
        && (proxyGameOptions(session) & GAME_OPTION_BITS.noTeamKills) !== 0,
      TEAMS_ALLOWED: allowTeams(proxyGameType(session)),
      // `_disableBots`, which bzfs publishes so a client never asks: its
      // answer to asking anyway is a kick (`bzfs.cxx:2828`). Read as
      // `BZDB.isTrue` reads it.
      DISABLE_BOTS: bzdbIsTrue(session.state.vars.get('_disableBots')),
      // What a native client does: `MaxUpdateTime` is one second, and
      // `isDeadReckoningWrong` returns true past it whatever the tank is doing
      // -- "otherwise always send at least one packet per second"
      // (`Player.cxx:38`, `:1251`). Not a number derived from the timeout it
      // has to beat, because upstream already answered this.
      //
      // The timeout is why it matters. bzfs refreshes `lastupdate` from
      // `MsgPlayerUpdate` and nothing else (`GameKeeper.cxx:503`), and a
      // player silent for `_notRespondingTime` has the flag they were holding
      // dropped (`bzfs.cxx:5806-5824`). bzo's own default is five seconds,
      // which is that timeout exactly, so a parked tank on a proxy raced it
      // and lost about half the time.
      MAX_UPDATE_INTERVAL: PROXY_MAX_UPDATE_INTERVAL,
    },
    // Nothing here simulates a shot: upstream leaves a shot's path to each
    // client and so does this connection, which is what the proxy cannot do
    // for it -- the target never says where a shell stopped.
    clientTracesShots: true,
    bzdb: Object.fromEntries(session.state.vars),
    // The target's teams, not this instance's. bzo's own `teamMode` describes
    // the game this server hosts, which a proxied player is not in, and the
    // imported map's describes a world whose `-mp` line the target may have
    // overridden on its command line. What the entry dialog has to offer is
    // what the target would accept, which only the target can say
    // (`teamModeFromMaximums`).
    teamMode: teamModeFromMaximums(status?.teamMaximums, status?.maxPlayers ?? MAX_REAL_PLAYERS),
    teamScores: proxyTeamScores(session.state.teams),
    liveConfigKeys: [],
    operatorConfig: {},
    rabbitId: session.state.rabbitId === null ? null : String(session.state.rabbitId),
    // `MsgTimeUpdate` only reaches a joining player on a server that is
    // counting down, so a target with no clock leaves this null rather than
    // inventing a match length.
    timeLeft: session.state.timeLeft,
    gameOver: false,
    voiceRtcConfig: voiceRtcConfigFor(session.playerId),
    // The target's own world, imported and hashed exactly as Map Viewer's is.
    world: { hash: mapEntry.hash, url: mapEntry.url },
    currentMap: mapEntry.fileName,
    viewableMaps: getViewableMapsList(),
    // Every target this instance carries, this one included, so a proxied
    // player can move between them and back to the local game without a link.
    proxies: getProxyDestinations(),
    // This instance's own game, for the same selector: a proxied player
    // choosing "local" needs to know which teams they would land among, and
    // `teamMode` above describes wherever this connection currently is.
    localTeams: TEAM_MODE.teams,
    // And which map it is on, because that is what distinguishes this
    // instance's own game in a list beside a row of `host:port` targets. A
    // proxied connection's `currentMap` above is the *target's*, so the local
    // one has to be said separately.
    localMap: server.MAP_SOURCE,
    flags: session.state.flags.filter(Boolean).map((flag) => proxyFlagState(flag, zonedOf)),
    worldTime: currentWorldTime(),
    title: `${viewer.key} (${viewer.kind === 'replay' ? 'replay' : 'proxied'})`,
    motd: '',
  };
}

// A proxy connection, from the handshake to the socket closing. The browser is
// answered only after the target has answered us: an `init` that named an
// empty world would be a lie a reload could not fix.
async function handleProxyConnection(ws, req, request) {
  const { kind, key, target, team, bot = false } = request;
  const send = (message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };

  // The one place the two kinds differ. Everything below is shared.
  const allowed = await authoriseProxyRequest(req, request);
  if (!allowed.allowed) {
    // The string the caller sent is not echoed back -- it chose that value,
    // and bzo's own sentence is the one worth putting in front of whoever
    // reads it; the log has it.
    log(`[${kind.toUpperCase()}] refused "${key}": ${allowed.error}`);
    send({ error: allowed.error });
    ws.close();
    return;
  }
  if (ws.readyState !== ws.OPEN) return;
  const options = { watch: kind === 'watch', callsign: allowed.callsign, guest: allowed.guest === true };
  const cookies = parseCookies(req.headers.cookie);
  // A login held for this target, if the browser has just been through one.
  // Taken rather than read: the token is answered once whatever happens next.
  const pendingLogin = takeProxyToken(cookies[PROXY_LOGIN_COOKIE], key);
  const loginSession = sessions.get(cookies[SESSION_COOKIE_NAME]);
  const viewer = {
    key,
    kind,
    // In order: the callsign the weblogin just named, which is the only one
    // that goes with the token; then the session's, which is that same name
    // on every connection after the first, since a token cannot be answered
    // twice but a name costs nothing to keep; then a numbered one for a
    // browser that has never signed in. Never the client's own choosing, at
    // any step (docs/proxy.md).
    // A watcher's name is decided before it gets here: it is the forum
    // callsign bzo verified, and the whole point of the mode is that the
    // remote sees it (`handleWatchConnection`).
    callsign: options.callsign
      || (pendingLogin
        ? pendingLogin.callsign
        : (loginSession ? loginSession.callsign : proxyViewerCallsign())),
    // A guest is unregistered by construction, whatever the browser signed
    // in as here.
    globalCallsign: options.guest ? null : (pendingLogin
      ? pendingLogin.callsign
      : (loginSession ? loginSession.callsign : null)),
    token: options.guest || !pendingLogin ? '' : pendingLogin.token,
  };
  // What this connection learns about the target's guests, where it is one:
  // a spawn or a refusal is as good an answer as a probe's (`noteGuest`).
  const unregistered = !viewer.token && viewer.globalCallsign === null;
  const noteGuest = (fact) => {
    if (unregistered && target && kind !== 'replay') bzfsWorlds.noteGuest(target.displayHost, target.displayPort, fact);
  };
  log(`[PROXY] ${key}: viewer "${viewer.callsign}" connecting`
    + ` to ${target.host}:${target.port} as ${team}${bot ? ' [BOT]' : ''}`
    + `${pendingLogin ? ' with a forwarded token' : ''}`);

  let session = null;
  // What this browser is playing on, for its own `T` letter: the target only
  // knows it as a BZFlag client.
  const ownClient = { headset: isHeadsetBrowserUA(req.headers['user-agent']), mobile: false, xr: false };
  const ownSeat = () => ({ id: session?.playerId, type: clientTypeOf(ownClient) });
  // Reached from the browser's own message handler, which is outside the try
  // below: what a proxied player may say depends on the team its connection
  // entered on, and how its motion converts depends on the target's world.
  let physics = null;
  let playingTeam = false;
  // Whether the target thinks this browser's own tank is standing. Not read off
  // `announcedAlive`, which deliberately skips our own id -- that map is about
  // what the *browser* has been told, and our own liveness is what we tell the
  // *target*.
  let selfAlive = false;
  // Whether this browser's own tank is phantom zoned: the browser says so as it
  // crosses a teleporter (`zone`), and the target hears it as `FlagActive` on
  // our updates, which is all upstream's client sends (LocalPlayer.cxx:729).
  let proxyZoned = false;
  // Who on the target is zoned: our own from the above, everybody else's from
  // the `FlagActive` on their updates.
  const proxyZonedOf = (id) => (id === session?.playerId
    ? proxyZoned
    : session?.state.motion.get(id)?.zoned === true);
  // What the target will accept of a shot, read off its own BZDB rather than
  // assumed: `shotFired` compares the lifetime against its `_reloadTime` within
  // an epsilon and drops a shot that misses without telling anyone
  // (bzfs.cxx:4178). Both are expressions on a stock server, so they are
  // evaluated (`evalBzdb`).
  let shotLifetime = 0;
  let shotSpeed = 0;
  // `ShotUpdate::id`'s low byte is the slot, and bzfs refuses a slot outside
  // the target's own `maxShots` (`bzfs.cxx:4896`). bzo's server hands out
  // slots for its own game; a proxied player keeps its own count.
  let maxShots = 1;
  let nextShotSlot = 0;
  let enteredTeamIndex = 0;
  ws.on('error', (err) => logError(`[PROXY] ${key}: socket error`, err));
  ws.on('close', () => {
    log(`[PROXY] ${key}: viewer "${viewer.callsign}" gone`);
    if (session) session.close();
  });

  try {
    // The world first, because it is the slow half and because an `init` needs
    // it. This is the same import Map Viewer serves and the same cache: a
    // target imported within the hour costs nothing to proxy.
    // Asked for alongside the world, not after it: both are the target's own
    // answer about the game, and the browser is told nothing until it has both.
    // A replay's world is the recording's own, and there is no server to ask
    // what game it runs: the header's settings are what a session reads.
    const room = kind === 'replay' ? await replayRoomFor(key) : null;
    if (kind === 'replay' && !room) throw new Error(`no replay ${key}`);
    const [{ safeMapName }, targetStatus] = await Promise.all(room
      ? [importReplayWorld(key, room.replay), null]
      : [importProxyWorld(target), proxyTargetStatus(key, target)]);
    if (room) room.worldFile = safeMapName;
    const mapEntry = MAP_REGISTRY.get(safeMapName);
    if (!mapEntry) throw new Error(`imported ${safeMapName} is not registered`);
    if (ws.readyState !== ws.OPEN) return;

    // A team the target has no room for is refused at `MsgEnter` with a
    // sentence of its own (`RejectTeamFull`, bzfs.cxx:2345), which would cost
    // this browser its whole connection over a choice it could have been
    // talked out of. Where the target has already said the team is zero, that
    // is settled here instead and the player watches.
    const offered = teamModeFromMaximums(
      targetStatus?.teamMaximums, targetStatus?.maxPlayers ?? MAX_REAL_PLAYERS,
    ).teams;
    // Only a verified player plays. A connection carrying no global login
    // watches, whatever team its link asked for.
    //
    // This is a courtesy to the target's operator rather than a restriction
    // bzfs imposes: it would admit an unregistered player itself. What it buys
    // them is that every proxied *player* is answerable by a BZID, so `/idban`
    // reaches one of them instead of `/ban` reaching all of them -- which is a
    // stronger guarantee than a native client gives (`docs/proxy.md`, "What a
    // target operator sees"). An operator who does not want it edits their own
    // bzo; it is a default, not a boundary.
    //
    // It is also the honest answer for a registered callsign, which cannot
    // spawn without a token at all -- `playerAlive` removes one that has not
    // identified (`bzfs.cxx:3199`). A bzo restart lands here: the session
    // outlives it, and the single-use token held in memory does not.
    //
    // A target configured with `requireLogin: false` lets an unregistered
    // name play. A registered one still cannot without its token.
    const cannotSpawn = !viewer.token && (target.requireLogin || viewer.globalCallsign !== null);
    const wanted = cannotSpawn ? PLAYER_TEAM.OBSERVER : team;
    // A playing team the target does not run is a player still wanting to
    // play -- a Play link carries the team they keep in Player Options, made
    // for some other server -- so the target places them.
    const enterTeam = (wanted === PLAYER_TEAM.AUTOMATIC || offered.includes(wanted))
      ? wanted
      : (wanted === PLAYER_TEAM.OBSERVER ? PLAYER_TEAM.OBSERVER : PLAYER_TEAM.AUTOMATIC);
    if (cannotSpawn && team !== PLAYER_TEAM.OBSERVER && !options.watch) {
      log(`[PROXY] ${key}: "${viewer.callsign}" carries no global login,`
        + ` so watching rather than ${team}`);
    }
    if (enterTeam !== team) {
      log(`[PROXY] ${key}: "${viewer.callsign}" asked for ${team}, which it does not run`);
    }

    session = room ? new ReplaySession({
      room,
      callsign: viewer.callsign,
      motto: proxyMotto(req),
      // Upstream's REPLAY permission, which is this server's operators: the
      // same test `/list` makes of a browser.
      operator: isLocalAdminHttp(req) || (loginSession ? isAdminSession(loginSession, ADMIN_GROUPS) : false),
    }) : new BzfsSession({
      host: target.host,
      port: target.port,
      callsign: viewer.callsign,
      motto: proxyMotto(req),
      version: PROXY_CLIENT_VERSION,
      // `TeamColor` by upstream's own numbering (`global.h:59`), which is what
      // `MsgEnter` packs and what decides whether this connection may shoot,
      // grab or die at all: bzfs kicks an observer that tries any of them
      // (`invalidPlayerAction`, bzfs.cxx:4352).
      team: enterTeam === PLAYER_TEAM.AUTOMATIC
        ? AUTOMATIC_TEAM
        : getTeamColorIndex(enterTeam),
      // A bot enters as one, except to watch: bzfs refuses a robot observer
      // ("This game is full", bzfs.cxx:2333), so one joins as a person.
      type: bot && enterTeam !== PLAYER_TEAM.OBSERVER ? COMPUTER_PLAYER : TANK_PLAYER,
      // The forwarded global login, unspent. It only verifies because bzfs
      // sees this connection arrive from a private address and asks the list
      // server without one (docs/proxy.md, "A proxy runs inside its
      // target's network").
      token: viewer.token,
    });
    // Registered before the join, because a target that hangs up during it
    // has to reach the browser rather than leave it on a socket nothing will
    // ever send to again.
    session.on('close', (err) => {
      log(`[PROXY] ${key}: target hung up${err ? `: ${err.message}` : ''}`);
      send({ error: `${key} closed the connection` });
      ws.close();
    });

    const state = await session.connect();
    if (ws.readyState !== ws.OPEN) {
      session.close();
      return;
    }
    log(`[PROXY] ${key}: joined as id ${session.playerId},`
      + ` ${state.players.size} players, ${state.flags.filter(Boolean).length} flags,`
      + ` world ${mapEntry.fileName}`);
    noteGuest({ watch: 'yes', watchDetail: '' });
    send(buildProxyInit(session, mapEntry, viewer, targetStatus, enterTeam, proxyZonedOf, ownSeat()));
    // What the target said to us on the way in -- its own greeting, and
    // whether the callsign we gave it is registered there.
    for (const text of state.messages) {
      send({ type: 'message', src: SERVER_PLAYER, dst: ALL_PLAYERS, msgType: 'server', text, ts: Date.now() });
    }
    // Said once, because being quietly seated on a team you did not pick is
    // worse than being refused out loud. A global login is spent the first
    // time it is offered, so a bzo restart leaves the name behind and takes
    // the proof with it.
    if (cannotSpawn && team !== PLAYER_TEAM.OBSERVER && !options.watch) {
      send({
        type: 'message',
        src: SERVER_PLAYER,
        dst: ALL_PLAYERS,
        msgType: 'server',
        text: `Watching: playing on ${key} through this proxy needs a global`
          + ' login, so the target knows who every player is. Sign in and'
          + ' rejoin to play.',
        ts: Date.now(),
      });
    }

    // Only now: `init` is a snapshot, and anything that reached the browser
    // before it would be about a world the client has not been given yet --
    // which it answers by clearing every tank it holds. The session has been
    // keeping its state through the burst either way, so what these forward
    // is only what changes from here.
    physics = proxyPhysics(session);
    playingTeam = enterTeam !== PLAYER_TEAM.OBSERVER;
    shotLifetime = evalBzdb(session.state.vars, '_reloadTime');
    shotSpeed = evalBzdb(session.state.vars, '_shotSpeed');
    maxShots = Math.max(1, proxyMaxShots(session) || 1);
    const ownRecord = session.state.players.get(session.playerId);
    enteredTeamIndex = ownRecord ? ownRecord.team : getTeamColorIndex(PLAYER_TEAM.OBSERVER);
    // Which of upstream's switches the target has on (`MsgGameSettings`, asked
    // for on the way in). Ricochet is the one a forwarded shot needs.
    const gameOptions = proxyGameOptions(session) ?? 0;

    // One batch a tick rather than a frame per update, which is what bzo's own
    // game loop does with the same messages (`flushMoveBroadcasts`) and at the
    // same 20Hz. A target with eight tanks moving sends eight times that many
    // updates a second, and each one is its own TCP frame on the way in.
    let pendingMoves = [];
    const flushMoves = () => {
      if (pendingMoves.length === 0) return;
      const moves = pendingMoves;
      pendingMoves = [];
      send({ type: 'pmBatch', moves });
    };
    const moveTimer = setInterval(flushMoves, 50);
    ws.on('close', () => clearInterval(moveTimer));


    // What the browser has been told about who is alive. A `pmBatch` carries
    // where a tank is and not whether it is in the game, so a tank that was
    // already alive when this connection opened -- one whose `MsgAlive` we
    // were never there to hear -- would stay dead on the roster forever, and
    // a dead tank is one the roaming views refuse to follow.
    const announcedAlive = new Map();
    for (const [id, motion] of session.state.motion) announcedAlive.set(id, motion.alive);

    const announcedZoned = new Map();
    session.on('motion', ({ id, motion }) => {
      // Our own tank is the browser's to place once it can play; until then
      // this connection is an observer and has none.
      if (id === session.playerId) return;
      // Zoning is a flag fact on bzo's side and a status bit on bzfs's, so a
      // change of the bit is a change of the carried flag.
      if ((announcedZoned.get(id) ?? false) !== motion.zoned) {
        announcedZoned.set(id, motion.zoned);
        const carried = session.state.flags.find((flag) => flag
          && flag.owner === id && flag.status === FLAG_STATUS.ON_TANK);
        if (carried) send({ type: 'flagUpdate', flags: [proxyFlagState(carried, proxyZonedOf)] });
      }
      if (announcedAlive.get(id) !== motion.alive) {
        announcedAlive.set(id, motion.alive);
        const player = session.state.players.get(id);
        if (player) send({ type: 'playerUpdated', player: proxyPlayerRecord(player, motion, ownSeat()) });
      }
      // One entry per mover per batch, newest wins -- an update that has been
      // superseded inside 50ms is one nobody needs to draw.
      const move = proxyMove(id, motion, physics);
      const existing = pendingMoves.findIndex((entry) => entry.id === move.id);
      if (existing === -1) pendingMoves.push(move);
      else pendingMoves[existing] = move;
    });

    // A target's own `/set`, as it reaches every native client.
    session.on('vars', (changed) => {
      physics = proxyPhysics(session);
      shotLifetime = evalBzdb(session.state.vars, '_reloadTime');
      shotSpeed = evalBzdb(session.state.vars, '_shotSpeed');
      for (const [name, value] of changed) send({ type: 'setVar', name, value });
    });

    session.on('alive', (spawn) => {
      const player = session.state.players.get(spawn.id);
      if (!player) return;
      announcedAlive.set(spawn.id, true);
      if (spawn.id === session.playerId) {
        selfAlive = true;
        noteGuest({ spawn: 'yes', spawnDetail: '' });
      }
      send({
        type: 'alive',
        player: proxyPlayerRecord(player, session.state.motion.get(spawn.id), ownSeat()),
      });
    });

    session.on('killed', (death) => {
      announcedAlive.set(death.victim, false);
      // Ask to come back. Upstream leaves a dead player dead until they press
      // something -- `restart` is what sends `MsgAlive`
      // (`clientCommands.cxx:379`) -- where bzo respawns on a timer and never
      // asks, which is deliberate (`docs/proxy.md`). So the asking happens
      // here, once, and the target does the waiting: `MsgAlive` only sets
      // `wantsToSpawn`, and bzfs holds the spawn until the `_explodeTime` that
      // `playerKilled` just stamped on this player has passed
      // (`bzfs.cxx:3371`, `PlayerInfo.h:334-348`). Sending it immediately is
      // therefore not sending it early.
      if (death.victim === session.playerId) {
        selfAlive = false;
        if (playingTeam) session.sendAlive();
      }
      const victim = session.state.players.get(death.victim);
      const killer = session.state.players.get(death.killer);
      send({
        type: 'killed',
        victimId: String(death.victim),
        shooterId: String(death.killer),
        // The killing bolt, by the same name the forwarded `shotBegin` gave
        // it. Upstream packs the shot id signed and spends -1 on a death no
        // shot caused, which is the one value that names nothing.
        projectileId: death.shotId === -1 ? null : `${death.killer}-${death.shotId & 0xffff}`,
        reason: PROXY_DEATH_REASONS[death.reason] || 'shot',
        suicide: death.victim === death.killer,
        // What each tank was holding when it happened, which is why upstream
        // carries the flag in this message rather than reading it off the
        // world: the victim's has been dropped by now.
        shooterFlag: death.flag || null,
        victimFlag: null,
        // Where the explosion goes: the victim's last known position, since
        // upstream's own `MsgKilled` carries none -- the update that put the
        // tank there is what the client already drew it at.
        ...(session.state.motion.has(death.victim)
          ? (() => {
            const at = vec3Point(session.state.motion.get(death.victim).pos);
            return { x: round2(at.x), y: round2(at.y), z: round2(at.z) };
          })()
          : { x: 0, y: 0, z: 0 }),
      });
      if (victim) {
        send({ type: 'playerUpdated', player: proxyPlayerRecord(victim, session.state.motion.get(death.victim), ownSeat()) });
      }
      if (killer && killer !== victim) {
        send({ type: 'playerUpdated', player: proxyPlayerRecord(killer, session.state.motion.get(death.killer), ownSeat()) });
      }
    });

    session.on('autopilot', ({ id, on }) => {
      const callsign = session.state.players.get(id)?.callsign ?? id;
      log(`[PROXY] ${key}: "${callsign}" autopilot ${on ? 'on' : 'off'}`);
      send({ type: 'autopilot', playerId: String(id), on, pilot: proxyPilotNames.get(`${key}#${id}`) });
    });

    session.on('pause', ({ id, paused }) => {
      const motion = session.state.motion.get(id);
      const position = motion ? vec3Point(motion.pos) : { x: 0, y: 0, z: 0 };
      send(paused
        ? {
          type: 'playerPaused',
          playerId: String(id),
          x: round2(position.x),
          y: round2(position.y),
          z: round2(position.z),
        }
        : { type: 'playerUnpaused', playerId: String(id) });
    });

    // A score change is a roster change here: bzo carries wins and losses on
    // the player record rather than in a message of their own.
    session.on('scores', (scores) => {
      for (const score of scores) {
        const player = session.state.players.get(score.id);
        if (!player) continue;
        send({
          type: 'playerUpdated',
          player: proxyPlayerRecord(player, session.state.motion.get(score.id), ownSeat()),
        });
      }
    });

    session.on('info', (info) => {
      for (const entry of info) {
        const player = session.state.players.get(entry.id);
        if (!player) continue;
        send({
          type: 'playerUpdated',
          player: proxyPlayerRecord(player, session.state.motion.get(entry.id), ownSeat()),
        });
      }
    });

    // Identify's answer, which the target volunteers off its own `searchFlag`
    // on every player update it gets (`bzfs.cxx:5509`) -- so a proxied player
    // carrying ID gets these the moment its position is going up, and bzo's
    // own `nearFlag` request has nothing to ask for.
    //
    // Two things have to be filled in. bzfs sends the flag's name where bzo's
    // client keys everything by abbreviation, and it sends no index at all,
    // because upstream's client only wants something to print. bzo writes the
    // answer into the flag record, so the index is found by matching the
    // position the message carries against the flags the target has already
    // described -- the same numbers, from the same connection.
    session.on('nearFlag', ({ pos, name }) => {
      const flagType = PROXY_FLAG_ABBREVIATIONS.get(name);
      if (!flagType) return;
      const found = session.state.flags.find((flag) => flag
        && flag.status === FLAG_STATUS.ON_GROUND
        && Math.abs(flag.position[0] - pos[0]) < 0.01
        && Math.abs(flag.position[1] - pos[1]) < 0.01
        && Math.abs(flag.position[2] - pos[2]) < 0.01);
      if (!found) return;
      send({
        type: 'nearFlag',
        index: found.index,
        flagType,
        position: vec3Point(pos),
      });
    });

    session.on('flags', (flags) => {
      send({ type: 'flagUpdate', flags: flags.map((flag) => proxyFlagState(flag, proxyZonedOf)) });
    });

    session.on('grab', ({ id, flag }) => {
      if (id === session.playerId) proxyZoned = false;
      send({ type: 'grabFlag', playerId: String(id), flag: proxyFlagState(flag, proxyZonedOf) });
    });

    session.on('drop', ({ id, flag }) => {
      if (id === session.playerId) proxyZoned = false;
      send({ type: 'dropFlag', playerId: String(id), flag: proxyFlagState(flag, proxyZonedOf) });
    });

    session.on('transfer', ({ from, to, flag }) => {
      send({
        type: 'transferFlag',
        fromId: String(from),
        toId: String(to),
        flag: proxyFlagState(flag, proxyZonedOf),
      });
    });

    // The same three fields with the same meanings on both wires, so there is
    // nothing to translate.
    session.on('capture', ({ id, index, team }) => {
      send({ type: 'captureFlag', playerId: String(id), index, team });

      // "everyone on losing team is dead" -- and bzfs tells nobody. It calls
      // `setDead()` on each of them and broadcasts `MsgCaptureFlag` alone
      // (`captureFlag`, bzfs.cxx), leaving every client to reach its own
      // conclusion. Upstream's does, in the one branch of `gotBlowedUp` that
      // sends no `MsgKilled` back: `GotCaptured` is the target's own doing, so
      // reporting it would be telling bzfs what it already decided.
      //
      // So the deaths are synthesized here, in the shape bzo's own server
      // broadcasts them -- `captured: true`, no reason, no score -- and the
      // browser dies from a capture through the one path it already has.
      //
      // The losing team is read off the *flag*, as bzfs reads it
      // (`flag.teamIndex()`), not off the message's `team`: that one carries
      // what the capturing client claimed, where the flag says whose it was.
      const cappedTeam = getFlagTeamIndex(session.state.flags[index]?.type ?? null);
      if (cappedTeam === null) return;
      session.state.players.forEach((player) => {
        if (player.team !== cappedTeam) return;
        if (announcedAlive.get(player.id) === false) return;
        announcedAlive.set(player.id, false);
        const motion = session.state.motion.get(player.id);
        const at = motion ? vec3Point(motion.pos) : { x: 0, y: 0, z: 0 };
        send({
          type: 'killed',
          victimId: String(player.id),
          shooterId: String(id),
          projectileId: null,
          captured: true,
          x: round2(at.x),
          y: round2(at.y),
          z: round2(at.z),
        });
      });

      // And ask to come back, for the same reason a shot death does: bzfs
      // stamped a spawn delay on everyone it just killed but set no
      // `wantsToSpawn`, so a tank that does not ask stays down for good. The
      // target holds the spawn until `_explodeTime` has passed by itself.
      if (cappedTeam === enteredTeamIndex) {
        selfAlive = false;
        if (playingTeam) session.sendAlive();
      }
    });

    // Where a shot was and how fast, for two things neither wire carries.
    //
    // `MsgShotEnd` has no position, because every upstream client has already
    // drawn the shot for itself and knows where it got to; bzo's `shotEnd`
    // says where the explosion goes.
    //
    // And a shot that simply runs out of life ends with no message at all up
    // there -- each client stops drawing it when its `lifetime` is up --
    // where bzo's client removes a projectile only when the server ends it.
    // So the proxy keeps the clock and sends the ending bzo needs. This is
    // the shape of the whole job: one end's silence is the other end's
    // missing message.
    const shotsInFlight = new Map();
    const ricochetAll = (gameOptions & GAME_OPTION_BITS.ricochet) !== 0;

    const endShot = (shotId, reason) => {
      const shot = shotsInFlight.get(shotId);
      if (!shot) return;
      shotsInFlight.delete(shotId);
      clearTimeout(shot.expiry);
      const flown = (Date.now() - shot.at) / 1000;
      send({
        type: 'shotEnd',
        id: shotId,
        reason,
        x: round2(shot.x + shot.vx * flown),
        y: round2(shot.y + shot.vy * flown),
        z: round2(shot.z + shot.vz * flown),
      });
    };

    session.on('shotBegin', (shot) => {
      const message = proxyShot(shot, ricochetAll);
      // A lifetime of zero would be a shot that never ends; upstream's own
      // default stands in for a target that sends one.
      const lifetime = shot.lifetime > 0 ? shot.lifetime : PROXY_DEFAULT_SHOT_LIFETIME;
      const velocity = vec3Point(shot.velocity);
      shotsInFlight.set(message.id, {
        x: message.x,
        y: message.y,
        z: message.z,
        vx: velocity.x,
        vy: velocity.y,
        vz: velocity.z,
        at: message.createdAt,
        // Only to forget it: a shot that runs out of life is retired by the
        // client that flew it, at the life its flag really has rather than
        // the reload time the wire carries.
        expiry: setTimeout(() => shotsInFlight.delete(message.id), lifetime * 1000),
      });
      send(message);
    });

    // Upstream's reason travels as it is: `reason == 0` is "show the
    // explosion" on both sides of this proxy.
    // A guided missile's lock. bzo's own server decides who a missile is
    // steering at and tells everyone (`setLockTarget`); a target decides it
    // for itself and says so here, under the same name bzo's client already
    // answers to (`gmUpdate`). Without this a native's
    // missile flies straight on a proxied screen while it is chasing
    // somebody on theirs.
    //
    // The position and velocity it also carries are left alone: bzo's client
    // steers a missile it was given rather than being told where it is, and
    // upstream only sends these because its own receivers re-anchor. Worth
    // revisiting if a proxied missile is seen to drift.
    session.on('gmUpdate', ({ player, target }) => {
      // Not our own back at us. bzfs rebroadcasts a GM update to everyone
      // including the sender (`shotUpdate`, bzfs.cxx), and on this connection
      // the sender is the browser -- which decided the lock in the first place
      // and is the only thing entitled to clear it. Echoing it would undo
      // every lapse the moment it happened.
      if (player === session.playerId) return;
      send({
        type: 'gmUpdate',
        playerId: String(player),
        targetId: target === BZFS_NO_PLAYER ? null : String(target),
      });
    });

    session.on('shotEnd', ({ player, id, reason }) => {
      endShot(`${player}-${id}`, reason);
    });

    ws.on('close', () => {
      proxyPilotNames.delete(`${key}#${session.playerId}`);
      for (const shot of shotsInFlight.values()) clearTimeout(shot.expiry);
      shotsInFlight.clear();
    });

    session.on('time', (timeLeft) => {
      send({ type: 'timeUpdate', timeLeft });
    });

    session.on('rabbit', (id) => {
      send({ type: 'newRabbit', playerId: String(id) });
    });

    session.on('player', (player) => {
      if (player.id === session.playerId) return;
      send({
        type: 'playerJoined',
        player: proxyPlayerRecord(player, session.state.motion.get(player.id), ownSeat()),
      });
    });
    // Addresses, for a proxied connection privileged enough to be told them.
    // A watcher never is -- no token means no `playerList` permission -- so
    // this stays empty for one and the roster simply carries no address, the
    // same as it does on this server for a non-admin.
    // A tank went through a teleporter. bzo's own `pt` carries a position
    // because its server decides the landing; a target's does not, and one is
    // not needed -- the player updates either side already move the tank, and
    // upstream's own handler plays a sound and nothing else
    // (`playing.cxx:3085`). Without this a proxied screen shows a tank simply
    // appearing somewhere else, silently.
    session.on('teleport', ({ id }) => {
      send({ type: 'teleport', playerId: String(id) });
    });

    session.on('adminInfo', (info) => {
      for (const entry of info) {
        const player = session.state.players.get(entry.id);
        if (!player) continue;
        send({
          type: 'playerUpdated',
          player: proxyPlayerRecord(player, session.state.motion.get(entry.id), ownSeat()),
        });
      }
    });

    session.on('playerLeft', (player) => {
      announcedAlive.delete(player.id);
      proxyPilotNames.delete(`${key}#${player.id}`);
      send({ type: 'playerLeft', id: String(player.id) });
    });
    session.on('teams', (teams) => {
      send({ type: 'teamUpdate', teams: proxyTeamScores(teams) });
    });
    session.on('message', (message) => {
      if (message.from === session.playerId) noteGuest({ chat: 'yes', chatDetail: '' });
      else if (message.from === SERVER_PLAYER) {
        const reply = guestReply(message.text);
        if (reply?.spawn === 'no') noteGuest({ spawn: 'no', spawnDetail: reply.detail });
        if (reply?.chat) noteGuest({ chat: reply.chat, chatDetail: reply.detail });
      }
      send({
        type: 'message',
        src: proxyChatSource(message.from),
        dst: proxyChatDestination(message.to),
        // A line from the target itself is bzo's `server` kind, which is what
        // the client draws in the server's own colour. Everything else is a
        // player talking, and upstream has only the two kinds.
        msgType: message.from === SERVER_PLAYER
          ? 'server'
          : (message.kind === BZFS_ACTION_MESSAGE ? 'action' : 'chat'),
        text: message.text,
        ts: Date.now(),
      });
    });
  } catch (err) {
    logError(`[PROXY] ${key}: could not proxy: ${err && err.message}`, err);
    send({ error: `Could not reach ${key}: ${err.message}` });
    ws.close();
    return;
  }

  // Said once: a player typing in a language with accents would otherwise be
  // told on every line.
  let warnedAboutChatText = false;
  let warnedAboutChatLength = false;
  // The last state the browser reported, resent immediately before a shot so
  // the target measures the muzzle against where the tank actually is.
  let lastMotion = null;
  // What this browser last told the target about being paused. bzfs holds the
  // flag; this is only what to send next and which status bit to set.
  let proxyPaused = false;
  let warnedAboutShots = false;

  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    // A join here is the browser saying it is ready to look, not asking for a
    // seat: the seat was taken when the socket opened, under a callsign the
    // client does not get to choose. Confirming it with the record the target
    // gave us is what lets the client out of its entry dialog.
    if (message.type === 'joinGame') {
      ownClient.mobile = message.isMobile === true;
      ownClient.xr = message.xr === true;
      const self = session.state.players.get(session.playerId);
      if (!self) return;
      send({
        type: 'playerJoined',
        player: {
          ...proxyPlayerRecord(self, session.state.motion.get(session.playerId), ownSeat()),
          globalCallsign: viewer.globalCallsign,
        },
      });
      // Where a tank spawns is the target's to decide: `MsgAlive` goes up
      // empty and bzfs answers with the position, which reaches the browser
      // through the `alive` handler like any other player's. bzo's own server
      // spawns a player as part of the join; a proxied one has to ask.
      //
      // Except when the answer would be an eviction. A callsign the target has
      // registered, carried without a token, fails
      // `accessInfo.isAllowedToEnter()` and bzfs removes the player outright
      // for "unidentified" (`playerAlive`, bzfs.cxx:3199-3205) -- joining is
      // allowed, spawning is not. That is a kick the browser answers by
      // reconnecting, so asking anyway costs a join-and-part loop rather than
      // one refusal. The target says which players are registered and which
      // are verified (`MsgPlayerInfo`), so this is answered before it is
      // asked, and the player is told the one thing that fixes it.
      if (!playingTeam) return;
      if (self.registered && !self.verified) {
        log(`[PROXY] ${key}: "${viewer.callsign}" is registered there and not signed in`);
        send({
          type: 'message',
          src: SERVER_PLAYER,
          dst: ALL_PLAYERS,
          msgType: 'server',
          text: `${key} has "${viewer.callsign}" registered, so playing needs a global`
            + ' login. Sign in and rejoin, or watch as an observer.',
          ts: Date.now(),
        });
        return;
      }
      session.sendAlive();
      return;
    }
    // Chat goes straight out to the target, including a line that starts with
    // `/`: bzo's own commands are about bzo's own game, and a proxied player
    // is not in it. `/flag`, `/report` and the rest are the target's, which is
    // also how an upstream client sends them -- an ordinary chat line that
    // bzfs reads as a command.
    if (message.type === 'message') {
      const typed = typeof message.text === 'string' ? message.text.trim() : '';
      if (typed.length === 0) return;
      // bzfs reads a chat line byte by byte and kicks for anything its own
      // character classes do not recognise, which is everything above ASCII
      // (`toBzfsChatText`). So the line is converted rather than the player
      // disconnected, and they are told once that it happens here.
      const text = toBzfsChatText(typed);
      if (text !== typed && !warnedAboutChatText) {
        warnedAboutChatText = true;
        send({
          type: 'message',
          src: SERVER_PLAYER,
          dst: ALL_PLAYERS,
          msgType: 'server',
          text: `${key} takes plain ASCII chat only, so accents are stripped on the way out.`,
          ts: Date.now(),
        });
      }
      if (text.length === 0) return;
      const self = session.state.players.get(session.playerId);
      const target = message.dst ?? message.to ?? 0;
      const destination = bzfsChatDestination(typeof target === 'string' && /^-?\d+$/.test(target)
        ? Number(target) : target, self ? self.team : 5);
      // `/me` is upstream's own reformatting of an action message, and it does
      // it at the server (bzfs.cxx:1490), so the line travels as typed.
      const action = message.msgType === 'action' || text.startsWith('/me ');
      const body = text.startsWith('/me ') ? text.slice(4) : text;
      // A command is one line or it is nothing: a second piece would arrive
      // as ordinary chat. It goes whole and bzfs keeps what fits, as an
      // upstream client's own input would have stopped it there.
      if (!action && body.startsWith('/')) {
        if (body.length > CHAT_TEXT_MAX && !warnedAboutChatLength) {
          warnedAboutChatLength = true;
          send({
            type: 'message',
            src: SERVER_PLAYER,
            dst: ALL_PLAYERS,
            msgType: 'server',
            text: `${key} takes ${CHAT_TEXT_MAX} characters a line, so a longer command is cut short.`,
            ts: Date.now(),
          });
        }
        session.sendChat(destination, body);
        return;
      }
      // bzfs carries a line of at most `MessageLen` bytes, so a longer one goes
      // as several, each broken between words (#169) -- an action's pieces
      // each say `/me` again, or only the first would read as one.
      const prefix = action ? '/me ' : '';
      for (const piece of splitBzfsChat(body, CHAT_TEXT_MAX - prefix.length)) {
        session.sendChat(destination, `${prefix}${piece}`);
      }
      return;
    }
    // The browser's own tank, which is the one thing a proxied player is
    // authoritative about: bzfs believes a client's position outright, which
    // is why it has no `positionCorrection` (`docs/proxy-plan.md`). An
    // observer has no tank to report and bzfs would not read one from it.
    if (message.type === 'm') {
      if (playingTeam && physics) {
        // The status says whether the tank is standing, and a dead one says so
        // -- `DeadStatus = 0` (`PlayerState.h:24`). Every other client reads
        // this to decide whether to draw the tank at all, so claiming `Alive`
        // while dead would leave a corpse driving around on their screens for
        // the whole respawn wait.
        //
        // The updates keep flowing while dead, which is upstream's own
        // behaviour and not an oversight: `sendUpdate` is
        // `myTank->isDeadReckoningWrong()` with no test of life
        // (`playing.cxx:7412`), and it has to be -- bzfs reads `lastupdate`
        // from `MsgPlayerUpdate` alone, so a tank that went quiet while dead
        // would be marked not responding within `_notRespondingTime`.


        lastMotion = proxyOutboundMotion(
          message,
          physics,
          (selfAlive ? BZFS_PLAYER_STATUS.ALIVE : 0)
            | (proxyPaused ? BZFS_PLAYER_STATUS.PAUSED : 0)
            | (proxyZoned ? BZFS_PLAYER_STATUS.FLAG_ACTIVE : 0),
        );
        session.sendPlayerUpdate(lastMotion);
      }
      return;
    }
    // A shot is the shooter's to declare: bzfs checks it and relays, it does
    // not decide it. Three of those checks are worth knowing about, because a
    // shot that fails any of them is dropped without a word (`shotFired`,
    // bzfs.cxx:4178-4221):
    //
    // The lifetime must be the world's `_reloadTime` within an epsilon -- the
    // reload, not the life the flag's own shot has. The speed may not exceed
    // `_shotSpeed` plus the tank's. And the origin has to be within
    // `_tankSpeed * _velocityAd + 2 * _muzzleFront` of the shooter's last
    // reported state, which is why upstream sends a player update immediately
    // before every shot (`LocalPlayer::fireShot`) and why this does too: the
    // browser has just moved to the muzzle it is firing from, and the target
    // is still holding wherever the last 20Hz batch left it.
    if (message.type === 'shoot') {
      if (!playingTeam || !physics) return;
      if (!Number.isFinite(shotLifetime) || !Number.isFinite(shotSpeed)) {
        if (!warnedAboutShots) {
          warnedAboutShots = true;
          log(`[PROXY] ${key}: cannot fire -- _reloadTime/_shotSpeed did not evaluate`);
        }
        return;
      }
      if (lastMotion) session.sendPlayerUpdate(lastMotion);
      const x = Number(message.x) || 0;
      const y = Number(message.y) || 0;
      const z = Number(message.z) || 0;
      // A velocity converts the way a position does, being a difference of
      // two of them over time.
      const velocity = [Number(message.vx) || 0, Number(message.vy) || 0, Number(message.vz) || 0];
      const slot = nextShotSlot;
      nextShotSlot = (nextShotSlot + 1) % maxShots;
      const firingFlag = proxyCarriedFlagType(session) || '';

      // "move shot origin under tank and make it stationary"
      // (`LocalPlayer::fireShot`, LocalPlayer.cxx:1230-1240). A wave does not
      // fly, and the target enforces that rather than assuming it: `shotFired`
      // zeroes both `shotSpeed` and `tankSpeed` for one, so any velocity at all
      // fails its speed check and the shot is dropped without a word.
      const wave = firingFlag === 'SW';
      const origin = wave && lastMotion ? lastMotion.pos : [x, y, z];

      session.sendShot({
        slot,
        pos: origin,
        // The browser's own, which is upstream's: the tank's velocity plus
        // the target's `_shotSpeed` along the barrel, level unless the target
        // keeps vertical velocity (`getMuzzleVelocity`).
        velocity: wave ? [0, 0, 0] : velocity,
        // The flag the *target* has on record for us, not the one the browser
        // thinks it is holding and not nothing.
        //
        // Claiming nothing looks safe and is not. bzfs does fill the real flag
        // into its own `firingInfo` (`shotFired`, bzfs.cxx) -- but it only
        // re-packs the packet it rebroadcasts when `repack` is set, and that
        // fill-in does not set it. So the buffer every other client receives,
        // and the echo that comes back here, is the one that was sent: a shot
        // with no flag -- an ordinary bullet by the time it reaches any client,
        // whatever the shooter is really holding.
        //
        // Reading it off `session.state.flags` is what makes claiming it safe:
        // that is bzfs's own answer echoed back, so it cannot disagree with
        // what `checkShotMismatch` compares against. A native client claims
        // the flag its own copy of the same messages says it holds, and races
        // a grab or a drop exactly the same way.
        flag: firingFlag,
        lifetime: shotLifetime,
        team: enteredTeamIndex,
      });
      return;
    }
    // Flags are declared, not requested: upstream's client says it grabbed
    // one, dropped one or capped with one, and bzfs checks and relays rather
    // than deciding (`docs/proxy-plan.md`). bzo's own client already speaks in
    // exactly those three messages -- it names the flag index it drove over
    // and the base team it capped on -- so there is nothing to translate
    // beyond letting them through.
    if (message.type === 'grabFlag') {
      const index = Number(message.index);
      // The indices are the target's own, forwarded untouched by
      // `proxyFlagState`, so the number the browser names is the number bzfs
      // knows it by.
      if (playingTeam && Number.isInteger(index) && index >= 0) session.sendGrabFlag(index);
      return;
    }
    if (message.type === 'dropFlag') {
      // bzfs takes the position the tank let go at, and the browser's last
      // report is where it is (`ServerLink.cxx:749`).
      if (playingTeam && lastMotion) session.sendDropFlag(lastMotion.pos);
      return;
    }
    if (message.type === 'captureFlag') {
      const team = Number(message.team);
      // Upstream's own `TeamColor` numbering on both sides of this hop
      // (`docs/network.md`, "Player ids"), so the base the browser names is
      // the base bzfs scores.
      if (playingTeam && isColorTeamIndex(team)) session.sendCaptureFlag(team);
      return;
    }
    // `nearFlag` is bzo's own: its server searches for a flag under the tank
    // and answers. A target does no such thing -- the client decides it drove
    // over one and says so above -- so there is nothing to ask and nobody to
    // ask it of.
    // A teleport is declared, like a grab or a shot. bzo's client already
    // works out which faces it went between and says so -- the proxy was
    // dropping it -- and bzo's face ids are upstream's numbering exactly
    // (`teleporterIndex * 2 + face`), on a world imported from this very
    // target, so the numbers mean the same thing at both ends.
    if (message.type === 'tp') {
      const from = Number(message.fromFaceId);
      const to = Number(message.toFaceId);
      if (playingTeam && Number.isInteger(from) && Number.isInteger(to)
        && from >= 0 && to >= 0) {
        session.sendTeleport(from, to);
      }
      return;
    }
    // A lock is declared, like everything else a client is authoritative about
    // here. bzo's own server decides who a missile is chasing and broadcasts
    // it, because there the missile is the server's; on a target the missile
    // belongs to the browser, and upstream's own client says who it is after
    // from the missile itself (`GuidedMissileStrategy::sendUpdate`).
    //
    // The browser sends one only when a missile's target changes, which is
    // upstream's `needUpdate`, so this is not a per-frame packet.
    if (message.type === 'lockTarget') {
      if (!playingTeam) return;
      const parts = typeof message.shotId === 'string' ? message.shotId.split('-') : null;
      if (!parts || parts.length !== 2) return;
      // Only this player's own missiles: the id carries the shooter, and a
      // browser claiming to steer somebody else's missile would be claiming
      // something bzfs has no reason to believe.
      if (Number(parts[0]) !== session.playerId) return;
      const shotId = Number(parts[1]);
      if (!Number.isInteger(shotId) || shotId < 0) return;

      const speed = Number(message.speed) || 0;
      // A direction converts the way a position does, being a difference of
      // two of them.
      const velocity = [
        (Number(message.dirX) || 0) * speed,
        (Number(message.dirY) || 0) * speed,
        (Number(message.dirZ) || 0) * speed,
      ];
      session.sendGMUpdate({
        player: session.playerId,
        shotId,
        pos: [Number(message.x) || 0, Number(message.y) || 0, Number(message.z) || 0],
        velocity,
        // `lastTarget` is `NoPlayer` when a missile is chasing nobody, which is
        // how upstream spells a lock that has lapsed.
        target: proxyNamedPlayerId(message.targetId) ?? BZFS_NO_PLAYER,
        team: enteredTeamIndex,
      });
      return;
    }
    if (message.type === 'nearFlag') return;
    if (message.type === 'xrSession') {
      ownClient.xr = message.on === true;
      const self = session.state.players.get(session.playerId);
      if (self) {
        send({
          type: 'playerUpdated',
          player: proxyPlayerRecord(self, session.state.motion.get(session.playerId), ownSeat()),
        });
      }
      return;
    }
    // bzo's pause is a request its own server answers by flipping a flag; a
    // target keeps that flag itself, so the browser's toggle is applied here
    // and declared. Without it a "paused" browser is still alive on the
    // target -- shootable, scoreable, and no longer moving, which is worse
    // than having no pause at all.
    // MsgAutoPilot: the browser flies the tank either way, and bzfs only
    // records and relays that it is (`bzfs.cxx:2820`).
    if (message.type === 'autopilot') {
      if (!playingTeam) return;
      // Kept through the release too, which names the pilot letting go.
      if (message.on === true && typeof message.pilot === 'string' && message.pilot) {
        proxyPilotNames.set(`${key}#${session.playerId}`, sanitizeMotto(message.pilot));
      }
      session.sendAutoPilot(message.on === true);
      return;
    }
    // Crossing a teleporter with Phantom Zone, which upstream's client says
    // only with `FlagActive` from its next update on. The target relays that
    // to everybody else and tells us nothing, so the browser hears it here.
    if (message.type === 'zone') {
      if (!playingTeam || !selfAlive || !togglesZoneOnTeleport(proxyCarriedFlagType(session))) return;
      proxyZoned = !proxyZoned;
      const carried = session.state.flags.find((flag) => flag
        && flag.owner === session.playerId && flag.status === FLAG_STATUS.ON_TANK);
      if (carried) send({ type: 'flagUpdate', flags: [proxyFlagState(carried, proxyZonedOf)] });
      return;
    }
    if (message.type === 'pause') {
      if (!playingTeam) return;
      proxyPaused = !proxyPaused;
      session.sendPause(proxyPaused);
      return;
    }
    // A death is declared, like a shot or a grab -- and on a target it is the
    // *victim* who declares it, which is the whole reason the browser has to
    // decide its own (`checkOwnShotHit`, client.js). bzfs asks nothing and
    // checks nothing beyond the shot id being a real slot (`bzfs.cxx:4893`).
    //
    // Upstream's order, from `checkEnvironment` into `gotBlowedUp`, and every
    // step of it earns its place:
    //
    //   1. `sendEndShot(killer, shotId, 1)` -- but only for a shot, and
    //      upstream's own reason is "force shot to terminate locally
    //      immediately ... to ensure that we don't get shot again by the same
    //      shot after dropping our shield flag" (playing.cxx:4164-4169).
    //   2. `sendDropFlag(position)` -- "you can't take it with you"
    //      (playing.cxx:3893), before the kill so bzfs records where the flag
    //      fell rather than where the tank respawns.
    //   3. `sendKilled(...)` -- unless a Shield saved the tank, in which case
    //      upstream sends the first two and no kill at all (:3918).
    //
    // The order is also what keeps the `endShot` anti-cheat balanced, which is
    // the part that bites if it is got wrong. `MsgShotEnd` raises
    // `endShotCredit` and notes a Shield the sender is *currently* holding as
    // `endShotShieldCredit` (bzfs.cxx:4962-4971); `MsgKilled` lowers the credit
    // again (:4899), and so does dropping that Shield (:3881). So an ordinary
    // death nets zero, and a shielded save nets zero only because the shot is
    // ended while the flag is still in hand. Drop first and the credit leaks --
    // three saves and the target kicks the player for "wrong end shots".
    // bzo's own client spells a suicide as its own message rather than as a
    // death it reports, because on bzo's server it is a *request* -- the server
    // decides it and kills the tank. A target has no such message and no such
    // opinion: upstream's suicide is `gotBlowedUp(myTank, SelfDestruct,
    // myTank->getId())` (playing.cxx:6966), a death the victim declares like
    // any other. So it becomes one here rather than growing a second path.
    if (message.type === 'killed' || message.type === 'selfDestruct') {
      if (!playingTeam) return;
      const reason = message.type === 'selfDestruct'
        ? BLOWED_UP.SELF_DESTRUCT
        : PROXY_KILL_REASONS[message.reason];
      if (reason === undefined) return;

      // `<player>-<shotId>`, the id this proxy built for the shot on its way in
      // (`proxyShot`), handed back untouched. Parsed here because here is where
      // that shape is decided. A death with a killer but no shot id is a shock
      // wave, which has a shooter to credit and no bolt to name.
      const parts = typeof message.shotId === 'string' ? message.shotId.split('-') : null;
      const shotId = parts && parts.length === 2 ? Number(parts[1]) : -1;
      const hasShot = Number.isInteger(shotId) && shotId >= 0;
      const named = proxyNamedPlayerId(parts && parts.length === 2 ? parts[0] : message.killerId);
      // Upstream's own choice of killer for each: the shooter for a shot or a
      // wave, *yourself* for a suicide (`gotBlowedUp(myTank, SelfDestruct,
      // myTank->getId())`), and `ServerPlayer` for water and a death pad,
      // which nobody scores for.
      const killer = named
        ?? (message.type === 'selfDestruct' ? session.playerId : BZFS_SERVER_PLAYER);

      // Only a shot that is *stopped* by hitting something is ended here. A
      // laser, a thief's beam and a shock wave all pass through their victim
      // (`isStoppedByHit`, false in those three strategies and true in the
      // base one), and ending one would be claiming it stopped when everyone
      // else on the target can still see it going. The browser reads that off
      // the shot's own flag and says so.
      if (hasShot && message.stoppedByHit !== false) session.sendShotEnd(killer, shotId, 1);

      // Only if there is one to drop. bzfs reads `MsgDropFlag` against the flag
      // it has recorded for this player and does nothing when that is none, but
      // a drop nobody asked for is still a message claiming something happened.
      const carried = session.state.flags.some((flag) => flag
        && flag.owner === session.playerId && flag.status === FLAG_STATUS.ON_TANK);
      if (carried && lastMotion) session.sendDropFlag(lastMotion.pos);

      // A Shield save is the whole of it: the shot is spent and the flag is
      // gone, and the tank is still standing.
      if (message.reason === 'shielded') return;

      session.sendKilled({
        killer,
        reason,
        // bzfs sanity-checks this against the world's slot count unless the
        // killer is `ServerPlayer`, and lets -1 through either way
        // (bzfs.cxx:4893-4899) -- which is what a wave, a drowning and a death
        // pad all send.
        shotId: hasShot ? shotId : -1,
        // `hit->getFlag()` -- the flag the *shot* carried, not the one the
        // victim was holding (`gotBlowedUp`, playing.cxx:3886).
        flag: typeof message.flag === 'string' ? message.flag : '',
        // Upstream sends `myTank->getDeathPhysicsDriver()`, an index into its
        // own driver table, which the browser's driver carries.
        phydrv: Number.isInteger(message.phydrv) ? message.phydrv : -1,
      });
      return;
    }
    if (message.type === 'debug') {
      // Capped, since the browser chose it, but long enough for a whole
      // `renderer.stats` line -- the reason a watcher sends one at all.
      log(`[PROXY] ${key}: "${viewer.callsign}" ${String(message.message).slice(0, 4000)}`);
    }
    // Everything else a client can say is about playing, and playing is step
    // 5. Dropped rather than answered, so nothing here pretends to a target
    // that a browser did something.
  });
}

module.exports = {
  useServer,
  PROXY_MAX_UPDATE_INTERVAL,
  sanitizeMotto,
  proxyMotto,
  resolveProxyRequest,
  authoriseProxyRequest,
  buildProxyInit,
  handleProxyConnection,
};
