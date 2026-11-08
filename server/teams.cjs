/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// `MAP_VIEWER` (issue #68) is deliberately absent from every list below --
// upstream's `TeamColor`/`-mp` has no seventh slot for a bzo-only concept, so
// bzo does not invent one either. A Map Viewer is Observer on the wire: same
// team limit, same team chat, same white scoreboard colour, same every gate
// in this file, distinguished only by the `viewMap` field the join carries
// alongside it (see `resolveViewMapChoice` in server.js). The client is the
// only place `mapviewer` exists as a string, purely to drive its own dialog
// and camera before translating the choice to `observer` at join time.
const PLAYER_TEAM = Object.freeze({
  AUTOMATIC: 'automatic',
  ROGUE: 'rogue',
  OBSERVER: 'observer',
  RED: 'red',
  BLUE: 'blue',
  GREEN: 'green',
  PURPLE: 'purple',
  RABBIT: 'rabbit',
  HUNTER: 'hunter',
});

// The teams a player may *ask* to join. Rabbit and hunter are missing on
// purpose: Rabbit Chase assigns both, so neither is ever requested and neither
// is offered in the entry dialog. See ALL_PLAYER_TEAMS for the teams a player
// may be *on*.
const PLAYER_TEAMS = Object.freeze([
  PLAYER_TEAM.ROGUE,
  PLAYER_TEAM.OBSERVER,
  PLAYER_TEAM.RED,
  PLAYER_TEAM.BLUE,
  PLAYER_TEAM.GREEN,
  PLAYER_TEAM.PURPLE,
]);
// Every team a player may be on, which is upstream's whole TeamColor enum bar
// the two pseudo-teams (`NumTeams` is 8, `global.h:59`). Rabbit and hunter are
// teams for colour and friend-or-foe purposes and hold no base, no flag and no
// score, which `isColorTeam` already answers for them.
const ALL_PLAYER_TEAMS = Object.freeze([
  ...PLAYER_TEAMS,
  PLAYER_TEAM.RABBIT,
  PLAYER_TEAM.HUNTER,
]);
const NON_TEAM_MODE_TEAMS = Object.freeze([PLAYER_TEAM.ROGUE, PLAYER_TEAM.OBSERVER]);
// BZFlag's TeamColor numbering (global.h:59). A BZW `base` object names one of
// these in its `color` line, a team flag carries one as its team, and `-mp`
// lists its player counts in this order. bzo's own team order differs, so the
// two are mapped rather than assumed to agree.
const BZFLAG_TEAM_ORDER = Object.freeze([
  PLAYER_TEAM.ROGUE,
  PLAYER_TEAM.RED,
  PLAYER_TEAM.GREEN,
  PLAYER_TEAM.BLUE,
  PLAYER_TEAM.PURPLE,
  PLAYER_TEAM.OBSERVER,
  PLAYER_TEAM.RABBIT,
  PLAYER_TEAM.HUNTER,
]);
// The teams `-mp` lists a count for, which stops at observer: Rabbit Chase
// derives both of its limits from the rogue count rather than reading them
// (`CmdLineOptions.cxx:1596`), so a map cannot name them.
const BZFLAG_MP_TEAM_ORDER = Object.freeze(BZFLAG_TEAM_ORDER.slice(0, 6));
// The teams the playing limit counts and caps: rogue and the four colour teams,
// which is upstream's `CtfTeams` span. Observers are outside it on purpose --
// `-mp 8` caps the tanks and says nothing about who is watching, so the total a
// server holds is the playing limit plus the observer limit
// (CmdLineOptions.cxx:458).
const PLAYING_TEAMS = Object.freeze(BZFLAG_TEAM_ORDER.slice(0, 5));
const PLAYER_TEAM_COLORS = Object.freeze({
  [PLAYER_TEAM.ROGUE]: 0xffff00,
  [PLAYER_TEAM.OBSERVER]: 0xffffff,
  [PLAYER_TEAM.RED]: 0xff0000,
  [PLAYER_TEAM.BLUE]: 0x1a33ff,
  [PLAYER_TEAM.GREEN]: 0x00ff00,
  [PLAYER_TEAM.PURPLE]: 0xff00ff,
  // Team::tankColor's last two rows (Team.cxx:27): rabbit light grey, hunter
  // orange. bzo paints the rabbit's, and only the rabbit's -- hunters keep the
  // per-player colours every bzo player has, since one colour for the crowd is
  // what hunter orange was for and bzo has a better answer to it. The rabbit is
  // the one thing in the world that has to be identifiable at a glance, so it is
  // the one thing with a reserved colour.
  [PLAYER_TEAM.RABBIT]: 0xcccccc,
  [PLAYER_TEAM.HUNTER]: 0xff8000,
});

// Team::radarColor (Team.cxx:30). Deliberately not the tank colours: red, green
// and purple are lifted so a team reads against a dark radar, where the tank
// colours sink into it. Upstream uses these for everything it draws on the
// radar, so bzo does too.
const PLAYER_TEAM_RADAR_COLORS = Object.freeze({
  [PLAYER_TEAM.ROGUE]: 0xffff00,
  [PLAYER_TEAM.OBSERVER]: 0xffffff,
  [PLAYER_TEAM.RED]: 0xff2626,
  [PLAYER_TEAM.BLUE]: 0x1440ff,
  [PLAYER_TEAM.GREEN]: 0x33e633,
  [PLAYER_TEAM.PURPLE]: 0xff66ff,
  // The rabbit reads white on the radar rather than grey, which is upstream's
  // own choice (Team.cxx:38) and the same reasoning as the other four: the
  // radar's colours are lifted so a team reads against a dark panel.
  [PLAYER_TEAM.RABBIT]: 0xffffff,
  [PLAYER_TEAM.HUNTER]: 0xff8000,
});

function normalizePlayerTeam(team) {
  const normalized = typeof team === 'string' ? team.trim().toLowerCase() : '';
  return ALL_PLAYER_TEAMS.includes(normalized) ? normalized : PLAYER_TEAM.ROGUE;
}

function isRabbitTeam(team) {
  return normalizePlayerTeam(team) === PLAYER_TEAM.RABBIT;
}

function normalizePlayerTeamSelection(team) {
  const normalized = typeof team === 'string' ? team.trim().toLowerCase() : '';
  return normalized === PLAYER_TEAM.AUTOMATIC ? PLAYER_TEAM.AUTOMATIC : normalizePlayerTeam(normalized);
}

function normalizeTeamList(teams, fallback = PLAYER_TEAMS) {
  if (!Array.isArray(teams)) return [...fallback];
  const requested = new Set(teams
    .map((team) => typeof team === 'string' ? team.trim().toLowerCase() : '')
    .filter((team) => PLAYER_TEAMS.includes(team)));
  const normalized = PLAYER_TEAMS.filter((team) => requested.has(team));
  return normalized.length > 0 ? normalized : [...fallback];
}

function normalizeTeamLimits(limits, teams, defaultLimit) {
  return Object.fromEntries(teams.map((team) => {
    const configured = Number(limits?.[team]);
    return [team, Number.isInteger(configured) && configured >= 0 ? configured : defaultLimit];
  }));
}

function normalizeServerTeamMode(value, defaultLimit = Number.MAX_SAFE_INTEGER) {
  if (typeof value === 'boolean') {
    const teams = value ? [...PLAYER_TEAMS] : [...NON_TEAM_MODE_TEAMS];
    return {
      enabled: value,
      autoTeam: false,
      teams,
      limits: normalizeTeamLimits(null, teams, defaultLimit),
    };
  }

  const enabled = value?.enabled === true;
  const teams = enabled
    ? normalizeTeamList(value?.teams)
    : [...NON_TEAM_MODE_TEAMS];
  return {
    enabled,
    autoTeam: enabled && value?.autoTeam === true,
    teams,
    limits: normalizeTeamLimits(value?.limits, teams, defaultLimit),
  };
}

function parseBZWTeamMode(lines) {
  let inOptions = false;
  let touched = false;
  let hasExplicitMode = false;
  const override = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (!inOptions && line === 'options') {
      inOptions = true;
      continue;
    }
    if (!inOptions) continue;
    if (line === 'end') {
      inOptions = false;
      continue;
    }

    const [option, value] = line.split(/\s+/, 2);
    if (option === '-c') {
      override.enabled = true;
      hasExplicitMode = true;
      touched = true;
    } else if (option === '-rabbit') {
      // `-rabbit [score|killer|random]`. Upstream's style argument is optional
      // and a bare switch means `score`; an argument it does not recognise is
      // left unconsumed rather than rejected, which comes to the same thing
      // (CmdLineOptions.cxx:1096). Rabbit Chase and `-c` are mutually exclusive
      // and Rabbit Chase wins whichever order they arrive in, which resolveTeamMode
      // below is where that happens.
      override.rabbitSelection = normalizeRabbitSelection(value ?? true);
      hasExplicitMode = true;
      touched = true;
    } else if (option === '-offa') {
      override.enabled = false;
      hasExplicitMode = true;
      touched = true;
    } else if (option === '-autoTeam') {
      override.autoTeam = true;
      touched = true;
    } else if (option === '-mp' && value?.includes(',')) {
      const counts = value.split(',').map((count) => Number.parseInt(count, 10));
      const enabledSet = new Set(BZFLAG_MP_TEAM_ORDER.filter((team, index) => counts[index] > 0));
      override.teams = PLAYER_TEAMS.filter((team) => enabledSet.has(team));
      override.limits = Object.fromEntries(BZFLAG_MP_TEAM_ORDER.map((team, index) => [
        team,
        Number.isInteger(counts[index]) && counts[index] >= 0 ? counts[index] : 0,
      ]));
      touched = true;
    }
  }

  if (!hasExplicitMode && override.teams?.some((team) => (
    team !== PLAYER_TEAM.ROGUE && team !== PLAYER_TEAM.OBSERVER
  ))) {
    override.enabled = true;
  }

  return touched ? override : null;
}

// `rabbit` in server.json and `-rabbit` in a map's options block, which name one
// of upstream's three RabbitSelection values (CmdLineOptions.cxx:1106). `false`,
// absent or unreadable is Rabbit Chase off; anything else falls back to `score`,
// as a bare `-rabbit` does upstream.
const RABBIT_SELECTIONS = Object.freeze(['score', 'killer', 'random']);

function normalizeRabbitSelection(value) {
  if (value === undefined || value === null || value === false) return null;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'false' || normalized === 'off' || normalized === 'none') return null;
  return RABBIT_SELECTIONS.includes(normalized) ? normalized : 'score';
}

// A map switch only ever turns something on, as every other bzfs switch in an
// options block does, so a map may pick Rabbit Chase or change its selection
// style and nothing in a map turns it back off.
function resolveRabbitSelection(serverValue, mapValue) {
  return normalizeRabbitSelection(mapValue) ?? normalizeRabbitSelection(serverValue);
}

// CmdLineOptions.cxx:453. A playing team may not be allowed more players than
// the whole game is, so `-mp N` clamps every one of their limits down to it.
// Applied where the limits are resolved, which is what makes the playing limit
// the number that bites rather than one the per-team rows can talk past.
function clampPlayingLimits(limits, maxRealPlayers) {
  const clamped = { ...limits };
  for (const team of PLAYING_TEAMS) {
    if (clamped[team] > maxRealPlayers) clamped[team] = maxRealPlayers;
  }
  return clamped;
}

// A proxied target's own team limits, read off the wire rather than inferred
// from its switches. `MsgQueryGame` packs the six `-mp` maxima in
// `BZFLAG_MP_TEAM_ORDER` (`decodeQueryGame`, server/remote-world-import.cjs),
// and `maxTeam[t]` is the very number bzfs tests before it accepts a join --
// `team[t].size >= clOptions->maxTeam[t]` is a `RejectTeamFull`
// (`bzfs.cxx:2345`). So a team the target reports as zero is a team it would
// refuse, and offering it in the entry dialog would be offering a rejection.
//
// This is the whole gate, which is why the game type is not consulted: Rabbit
// Chase zeroes every colour and moves the rogue limit to the hunters
// (`CmdLineOptions.cxx:1586-1597`), and an `-offa` operator zeroes them with
// `-mp`, so both arrive here already counted. A target that answered nothing
// leaves only Observer, which is the one team every server has room for and
// the one this proxy can always deliver.
function teamModeFromMaximums(teamMaximums, maxRealPlayers = Number.MAX_SAFE_INTEGER) {
  const counts = Array.isArray(teamMaximums) ? teamMaximums : [];
  const limits = Object.fromEntries(BZFLAG_MP_TEAM_ORDER.map((team, index) => [
    team,
    Number.isInteger(counts[index]) && counts[index] > 0 ? counts[index] : 0,
  ]));
  const offered = PLAYER_TEAMS.filter((team) => limits[team] > 0);
  const teams = offered.length > 0 ? offered : [PLAYER_TEAM.OBSERVER];
  return {
    // bzo's `enabled` is "there are colour teams to pick between", which is
    // what the target's own maxima say rather than anything configured here.
    enabled: teams.some((team) => (
      team !== PLAYER_TEAM.ROGUE && team !== PLAYER_TEAM.OBSERVER
    )),
    // The target runs its own `autoTeamSelect` on every join
    // (`bzfs.cxx:2299`), so bzo never picks a team for a proxied player.
    autoTeam: false,
    rabbitSelection: null,
    colorTeamsRefused: false,
    maxRealPlayers,
    teams,
    limits,
  };
}

// `maxRealPlayers` is the configured playing limit -- upstream's `-mp` -- and it
// is both the default per-team limit and the cap on every playing team's own.
function resolveTeamMode(serverValue, mapOverride = null, maxRealPlayers = Number.MAX_SAFE_INTEGER, serverRabbit = null) {
  const serverMode = normalizeServerTeamMode(serverValue, maxRealPlayers);
  const rabbitSelection = resolveRabbitSelection(serverRabbit, mapOverride?.rabbitSelection);
  const requestedEnabled = typeof mapOverride?.enabled === 'boolean'
    ? mapOverride.enabled
    : serverMode.enabled;

  // CmdLineOptions.cxx:1586. Rabbit Chase zeroes every colour team's limit --
  // "only rogues are allowed in Rabbit Chase" -- gives the rabbit a limit of one
  // and the hunters whatever the rogue limit was. It is the last word on the game
  // type whichever order the switches arrived in, which is what makes it and `-c`
  // mutually exclusive; `colorTeamsRefused` is what the caller logs about it.
  if (rabbitSelection) {
    const rogueLimit = Math.min(maxRealPlayers, normalizeTeamLimits(
      serverMode.limits, [PLAYER_TEAM.ROGUE], maxRealPlayers)[PLAYER_TEAM.ROGUE]);
    const teams = [PLAYER_TEAM.OBSERVER, PLAYER_TEAM.HUNTER];
    return {
      enabled: false,
      autoTeam: false,
      rabbitSelection,
      colorTeamsRefused: requestedEnabled,
      maxRealPlayers,
      teams,
      limits: {
        ...normalizeTeamLimits(serverMode.limits, [PLAYER_TEAM.OBSERVER], maxRealPlayers),
        // Only the hunter limit is ever consulted -- anointing does not ask
        // whether the rabbit team has room, since deposing the old rabbit is what
        // makes it. The rabbit's one is carried because it is a field of the ping
        // packet a published server reports, and because it says the shape out
        // loud.
        [PLAYER_TEAM.RABBIT]: 1,
        [PLAYER_TEAM.HUNTER]: rogueLimit,
      },
    };
  }

  if (!requestedEnabled) {
    const teams = [...NON_TEAM_MODE_TEAMS];
    return {
      enabled: false,
      autoTeam: false,
      rabbitSelection: null,
      colorTeamsRefused: false,
      maxRealPlayers,
      teams,
      limits: clampPlayingLimits(
        normalizeTeamLimits(serverMode.limits, teams, maxRealPlayers), maxRealPlayers),
    };
  }

  const teams = mapOverride?.teams
    ? normalizeTeamList(mapOverride.teams, serverMode.teams)
    : serverMode.teams;
  return {
    enabled: true,
    autoTeam: mapOverride?.autoTeam ?? serverMode.autoTeam,
    rabbitSelection: null,
    colorTeamsRefused: false,
    maxRealPlayers,
    teams,
    limits: clampPlayingLimits(
      normalizeTeamLimits(mapOverride?.limits ?? serverMode.limits, teams, maxRealPlayers),
      maxRealPlayers),
  };
}

// Upstream picks evenly among the teams that tie (autoTeamSelect, bzfs.cxx:1902),
// which leaves the second player on an empty map more likely to be founded
// beside the first than across from them: two of the three remaining teams are
// neighbours, so the far one comes up a third of the time.
//
// bzo weighs that one case by how far apart the two bases are, squared. On a map
// with its bases at the compass points the far team is exactly twice as likely
// as either neighbour -- 50/25/25 rather than 33/33/33 -- and the exponent is
// the only thing to turn if that is not enough.
//
// Only that case. Once two teams are populated there is no single team across
// the map, and a player joining teams that already exist is picked as before.
// Distance never overrides the balancing above it either: this only reorders
// candidates that already tie on size and on score. Whichever team has no base
// on the map, or a map with no bases at all, falls back to the even pick.
function pickByBaseDistance(candidates, teamCounts, basePositions, random) {
  if (!basePositions) return null;
  const populated = BZFLAG_TEAM_ORDER.slice(1, 5).filter((team) => (teamCounts[team] || 0) > 0);
  if (populated.length !== 1) return null;
  if (candidates.some((team) => (teamCounts[team] || 0) > 0)) return null;

  const from = basePositions[populated[0]];
  if (!from) return null;
  const weights = candidates.map((team) => {
    const to = basePositions[team];
    if (!to) return 0;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    return (dx * dx) + (dz * dz);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return null;

  let roll = random() * total;
  for (let index = 0; index < candidates.length; index += 1) {
    roll -= weights[index];
    if (roll < 0) return candidates[index];
  }
  return candidates[candidates.length - 1];
}

// `basePositions` is one point per colour team, `{ red: { x, z }, ... }`, and is
// only consulted for the second team on the map. `random` follows it so the
// tests can drive both.
function selectPlayerTeam(requestedTeam, teamMode, teamCounts = {}, teamScores = {}, basePositions = null, random = Math.random) {
  const requested = normalizePlayerTeamSelection(requestedTeam);
  const automatic = requested === PLAYER_TEAM.AUTOMATIC;
  const hasRoom = (team) => (teamCounts[team] || 0) < teamMode.limits[team];

  // autoTeamSelect (bzfs.cxx:1885), and its order: "asking for Observer gives
  // observer", whatever else the world is doing. Ahead of Rabbit Chase because
  // observer is the one team anybody may ask for there.
  if (requested === PLAYER_TEAM.OBSERVER) {
    return hasRoom(PLAYER_TEAM.OBSERVER) ? PLAYER_TEAM.OBSERVER : null;
  }

  // bzfs.cxx:1898: "if no player are available, join as Observer". The playing
  // limit counts tanks and not observers, so a game whose tanks are all taken
  // turns an arrival into a spectator rather than refusing it -- what refuses a
  // connection is the total, which the caller asks about.
  const playing = ALL_PLAYER_TEAMS.reduce((total, team) => (
    team === PLAYER_TEAM.OBSERVER ? total : total + (teamCounts[team] || 0)), 0);
  if (playing >= (teamMode.maxRealPlayers ?? Number.MAX_SAFE_INTEGER)) {
    return hasRoom(PLAYER_TEAM.OBSERVER) ? PLAYER_TEAM.OBSERVER : null;
  }

  // autoTeamSelect (bzfs.cxx:1923): "if we're running rabbit chase, all
  // non-observers start as hunters". There is no team to pick in Rabbit Chase --
  // the rabbit is anointed rather than joined -- so a request for a colour team
  // is honoured as "play" rather than refused, which is what upstream does.
  if (teamMode.rabbitSelection) {
    return hasRoom(PLAYER_TEAM.HUNTER) ? PLAYER_TEAM.HUNTER : null;
  }

  if (!automatic && !teamMode.teams.includes(requested)) return null;

  if (!automatic && (requested === PLAYER_TEAM.ROGUE || !teamMode.autoTeam)) {
    return hasRoom(requested) ? requested : null;
  }

  // "not putting in not enabled teams" (bzfs.cxx:1935): a team whose limit is
  // zero is off, and it is left out before the balancing rather than filtered
  // for room later -- otherwise the all-empty case below would found a team
  // nobody is allowed to be on.
  let candidates = BZFLAG_TEAM_ORDER.slice(1, 5)
    .filter((team) => teamMode.teams.includes(team) && teamMode.limits[team] > 0)
    .sort((left, right) => (teamCounts[right] || 0) - (teamCounts[left] || 0));
  if (candidates.length === 0) return hasRoom(PLAYER_TEAM.ROGUE) ? PLAYER_TEAM.ROGUE : null;

  const largestCount = teamCounts[candidates[0]] || 0;
  if (largestCount > 0) {
    candidates = candidates.filter(hasRoom);
    if (candidates.length === 0) return hasRoom(PLAYER_TEAM.ROGUE) ? PLAYER_TEAM.ROGUE : null;

    const smallestCount = teamCounts[candidates[candidates.length - 1]] || 0;
    if (smallestCount < largestCount) {
      if (largestCount === 1 && candidates.length >= 2 && (teamCounts[candidates[1]] || 0) === 1) {
        candidates = candidates.filter((team) => (teamCounts[team] || 0) > 0);
      } else {
        candidates = candidates.filter((team) => (teamCounts[team] || 0) !== largestCount);
        if ((teamCounts[candidates[0]] || 0) > 0) {
          candidates = candidates.filter((team) => (teamCounts[team] || 0) > 0);
          const smallestExistingCount = teamCounts[candidates[candidates.length - 1]] || 0;
          candidates = candidates.filter((team) => (teamCounts[team] || 0) === smallestExistingCount);
        }
      }
    }
  }

  if (candidates.includes(requested)) return requested;
  const lowestScore = Math.min(...candidates.map((team) => teamScores[team] || 0));
  candidates = candidates.filter((team) => (teamScores[team] || 0) === lowestScore);
  return pickByBaseDistance(candidates, teamCounts, basePositions, random)
    || candidates[Math.floor(random() * candidates.length)];
}

function isObserverTeam(team) {
  return normalizePlayerTeam(team) === PLAYER_TEAM.OBSERVER;
}

// Team::isColorTeam upstream, which is red through purple and nothing else.
// Every other team carries no team score: a rogue kill feeds nobody's tally and
// neither does dying as one, and the same goes for the rabbit and the hunters,
// which is half of why Rabbit Chase never moves a team score.
function isColorTeam(team) {
  return isColorTeamIndex(getTeamColorIndex(normalizePlayerTeam(team)));
}

// bzfs.cxx:3540. A kill across teams wins one for the killer's team and loses
// one for the victim's. A kill inside a team only loses: two for killing a team
// mate, one for killing yourself. Rogues and observers score for nobody, so a
// rogue's kill feeds no tally and a rogue's death costs none.
//
// Returned rather than applied so the rule can be tested against upstream's
// without a server around it.
// areFoes (bzfs.cxx:3042). Who may legitimately kill whom. Everyone is a foe on
// a world with no teams, and a rogue is everyone's foe even on one that has
// them -- which is why upstream's own `-noTeamKills` help says "Rogue is
// excepted".
//
// Both ends ask it, as upstream does: bzo's server refuses a teammate's shot
// where it decides every hit, and the client asks the same question of its own
// tank on a proxied connection, where bzfs expects the victim to report the
// kill.
function areFoes(teamA, teamB, teamsAllowed) {
  if (!teamsAllowed) return true;
  return teamA !== teamB || teamA === PLAYER_TEAM.ROGUE;
}

// GameType (global.h:94), by the questions bzo already asks about a world.
// Upstream picks the type with a switch and derives nothing; bzo has a switch
// only for Rabbit Chase, and otherwise `-c`/`-offa` decide whether there are
// colour teams and the map decides whether there are bases, which between them
// say the same thing.
//
// Rabbit Chase is asked first because it is the switch that turns the colour
// teams off, so a world that has it can answer nothing else -- which is exactly
// upstream's own "Capture the flag incompatible with Rabbit Chase".
//
// Server-only: the type decides scoring and spawning, which are the server's.
function getGameType(teamsEnabled, hasBases, rabbitChase = false) {
  if (rabbitChase) return 'RabbitChase';
  if (!teamsEnabled) return 'OpenFFA';
  return hasBases ? 'ClassicCTF' : 'TeamFFA';
}

// World::allowTeams / bzfs's own allowTeams (bzfs.cxx:3334): every game type but
// OpenFFA has sides. It is asked of the game type rather than of `TEAM_MODE`
// because Rabbit Chase has sides -- the rabbit and the hunters -- while having no
// colour teams at all, so the two questions come apart there and nowhere else.
function allowTeams(gameType) {
  return gameType !== 'OpenFFA';
}

// bzfs.cxx:3539. A kill moves the team score in the two free-for-all types and
// not in ClassicCTF, where a capture is the only thing that moves it -- which is
// what makes a capture worth crossing the map for. In OpenFFA there are no
// colour teams to score anyway, so the deltas come back empty and the gate is
// upstream's belt to that braces.
function teamScoreMovesOnKill(gameType) {
  return gameType === 'TeamFFA' || gameType === 'OpenFFA';
}

// Score::ranking (Score.cxx:42). A win *rate* rather than a win count,
// discounted for how short the record is. The penalty term `1 - 0.5/sqrt(sum)`
// multiplies, so it pulls a rank towards **zero** rather than towards the middle:
// 0.5 after one game, 0.75 after four, 0.9 after twenty-five, 0.95 after a
// hundred. A rank therefore always sits below the rate it came from and rises
// towards it as the record lengthens -- 4-2 and 40-20 are both a 0.67 rate and
// rank 0.53 and 0.62 -- and 1.0 is unreachable.
//
// The `sum == 0` answer of 0.5 is the one value the formula never produces, and
// it is deliberately generous: it beats every even record (1-1 is 0.32, 50-50 is
// 0.47), so a player who has just arrived is near the front of the queue for the
// rabbit until their first death, which with no wins to divide takes them to 0.
// Upstream's own note on the curve is "IIRC that is how wide is the gaussian".
//
// This decides who becomes the rabbit, and it is also what the scoreboard sorts
// by in Rabbit Chase -- upstream keeps a second copy of the arithmetic on the
// client for that (`rabbitRank`, Player.cxx:157), so the pair keeps one.
function getPlayerRanking(wins, losses) {
  const sum = wins + losses;
  if (sum === 0) return 0.5;
  return (wins / sum) * (1 - (0.5 / Math.sqrt(sum)));
}

function getTeamScoreDeltasForKill(killerTeam, victimTeam, selfKill = false) {
  const deltas = [];
  if (killerTeam && killerTeam === victimTeam) {
    if (isColorTeam(victimTeam)) deltas.push({ team: victimTeam, wins: 0, losses: selfKill ? 1 : 2 });
    return deltas;
  }
  if (isColorTeam(killerTeam)) deltas.push({ team: killerTeam, wins: 1, losses: 0 });
  if (isColorTeam(victimTeam)) deltas.push({ team: victimTeam, wins: 0, losses: 1 });
  return deltas;
}

// null rather than rogue for anything that is not a team, so a caller cannot
// mistake an unknown name for team zero.
function getTeamColorIndex(team) {
  const normalized = typeof team === 'string' ? team.trim().toLowerCase() : '';
  const index = BZFLAG_TEAM_ORDER.indexOf(normalized);
  return index >= 0 ? index : null;
}

function getTeamFromColorIndex(colorIndex) {
  return BZFLAG_TEAM_ORDER[colorIndex] || null;
}

// Team::isColorTeam by index: red, green, blue and purple are the teams that
// hold bases and flags.
function isColorTeamIndex(colorIndex) {
  return Number.isInteger(colorIndex) && colorIndex >= 1 && colorIndex <= 4;
}

// bzfs.cxx:4010. A capture wins one for the capping team and loses one for the
// team whose flag it was. Carrying your own flag onto an enemy base wins nobody
// anything -- the capper is on the team that just lost it -- so `cappingTeam` is
// null for that case.
//
// Returned rather than applied so the rule can be tested against upstream's
// without a server around it, as the kill rule above is.
function getTeamScoreDeltasForCapture(cappingTeam, cappedTeam) {
  const deltas = [];
  if (cappingTeam && cappingTeam !== cappedTeam && isColorTeam(cappingTeam)) {
    deltas.push({ team: cappingTeam, wins: 1, losses: 0 });
  }
  if (isColorTeam(cappedTeam)) deltas.push({ team: cappedTeam, wins: 0, losses: 1 });
  return deltas;
}


function getPlayerTeamRadarColor(team) {
  return PLAYER_TEAM_RADAR_COLORS[normalizePlayerTeam(team)];
}

function getPlayerTeamColor(team) {
  return PLAYER_TEAM_COLORS[normalizePlayerTeam(team)];
}

module.exports = {
  PLAYER_TEAM_COLORS,
  PLAYER_TEAM,
  PLAYER_TEAMS,
  ALL_PLAYER_TEAMS,
  BZFLAG_TEAM_ORDER,
  BZFLAG_MP_TEAM_ORDER,
  getTeamColorIndex,
  getTeamFromColorIndex,
  isColorTeamIndex,
  NON_TEAM_MODE_TEAMS,
  normalizePlayerTeam,
  normalizePlayerTeamSelection,
  normalizeServerTeamMode,
  normalizeTeamLimits,
  clampPlayingLimits,
  parseBZWTeamMode,
  resolveTeamMode,
  teamModeFromMaximums,
  selectPlayerTeam,
  getPlayerTeamColor,
  getPlayerTeamRadarColor,
  isColorTeam,
  isObserverTeam,
  isRabbitTeam,
  areFoes,
  allowTeams,
  getGameType,
  normalizeRabbitSelection,
  resolveRabbitSelection,
  getPlayerRanking,
  teamScoreMovesOnKill,
  getTeamScoreDeltasForKill,
  getTeamScoreDeltasForCapture,
};
