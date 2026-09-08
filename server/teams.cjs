/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

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

function resolveTeamMode(serverValue, mapOverride = null, defaultLimit = Number.MAX_SAFE_INTEGER, serverRabbit = null) {
  const serverMode = normalizeServerTeamMode(serverValue, defaultLimit);
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
    const rogueLimit = normalizeTeamLimits(
      serverMode.limits, [PLAYER_TEAM.ROGUE], defaultLimit)[PLAYER_TEAM.ROGUE];
    const teams = [PLAYER_TEAM.OBSERVER, PLAYER_TEAM.HUNTER];
    return {
      enabled: false,
      autoTeam: false,
      rabbitSelection,
      colorTeamsRefused: requestedEnabled,
      teams,
      limits: {
        ...normalizeTeamLimits(serverMode.limits, [PLAYER_TEAM.OBSERVER], defaultLimit),
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
      teams,
      limits: normalizeTeamLimits(serverMode.limits, teams, defaultLimit),
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
    teams,
    limits: normalizeTeamLimits(mapOverride?.limits ?? serverMode.limits, teams, defaultLimit),
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

  // autoTeamSelect (bzfs.cxx:1923): "if we're running rabbit chase, all
  // non-observers start as hunters". There is no team to pick in Rabbit Chase --
  // asking for observer gives observer and everything else gives hunter, the
  // rabbit being anointed rather than joined. So a request for a colour team is
  // honoured as "play" rather than refused, which is what upstream does with it.
  if (teamMode.rabbitSelection) {
    const team = requested === PLAYER_TEAM.OBSERVER ? PLAYER_TEAM.OBSERVER : PLAYER_TEAM.HUNTER;
    return hasRoom(team) ? team : null;
  }

  if (!automatic && !teamMode.teams.includes(requested)) return null;

  if (!automatic && (requested === PLAYER_TEAM.OBSERVER || requested === PLAYER_TEAM.ROGUE || !teamMode.autoTeam)) {
    return hasRoom(requested) ? requested : null;
  }

  let candidates = BZFLAG_TEAM_ORDER.slice(1, 5)
    .filter((team) => teamMode.teams.includes(team))
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
// Server-only. Upstream asks this on both ends -- each client refuses a
// teammate's shot in `LocalPlayer::checkHit` and bzfs asks again to score the
// team kill -- but bzo's server is the only thing that decides a hit, so there
// is one copy and it lives here.
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

// PlayerInfo::canBeRabbit (PlayerInfo.cxx:504). A paused or observing player
// cannot hold it, and it wants someone alive -- `relaxing` is the pass that will
// settle for a dead player in the game, which anointRabbit below makes when
// nobody alive qualifies.
//
// A candidate is `{ paused, observer, alive, playing }`. Upstream also refuses a
// `notResponding` player; bzo has no such state, because a client that stops
// answering has a socket that closes and leaves the roster outright.
//
// Server-only.
function canBeRabbit(candidate, relaxing = false) {
  if (!candidate) return false;
  if (candidate.paused || candidate.observer) return false;
  return relaxing ? Boolean(candidate.playing) : Boolean(candidate.alive);
}

// GameKeeper::Player::anointRabbit (GameKeeper.cxx:145). The best candidate by
// ranking, preferring anyone alive who is not the old rabbit: a "good" rabbit
// beats every not-good one however they rank, and among equals the ranking
// decides. Settling for the old rabbit or for a dead player is the fallback that
// keeps a two-player game moving.
//
// `candidates` is one entry per player, `{ id, paused, observer, alive, playing,
// ranking }`, with the ranking already computed -- upstream swaps the whole
// ranking function out for `-rabbit random` (Score::setRandomRanking) rather
// than branching inside the loop, so the caller owns that choice here too.
// Returns the new rabbit's id, or null if nobody at all may hold it.
//
// Server-only.
function anointRabbit(candidates, oldRabbitId = null) {
  let chosenId = null;
  let topRanking = -Infinity;
  let goodRabbitChosen = false;

  for (const candidate of candidates) {
    if (!canBeRabbit(candidate, true)) continue;
    const good = candidate.id !== oldRabbitId && Boolean(candidate.alive);
    if (goodRabbitChosen && !good) continue;
    if (good && !goodRabbitChosen) {
      goodRabbitChosen = true;
    } else if (!(candidate.ranking > topRanking)) {
      continue;
    }
    topRanking = candidate.ranking;
    chosenId = candidate.id;
  }

  return chosenId;
}

// The selection half of anointNewRabbit (bzfs.cxx:2737), without the broadcast:
// under `-rabbit killer` whoever just killed the rabbit takes it if they are
// still around and still eligible, and otherwise -- and for the other two styles
// -- anointRabbit picks. Upstream asks the killer for the strict `canBeRabbit()`,
// so a killer who died in the same exchange does not inherit it.
//
// Server-only.
function pickNewRabbit({ candidates, oldRabbitId = null, killerId = null, selection = 'score' } = {}) {
  if (selection === 'killer' && killerId !== null && killerId !== oldRabbitId) {
    const killer = candidates.find((candidate) => candidate.id === killerId);
    if (killer?.playing && canBeRabbit(killer)) return killerId;
  }
  return anointRabbit(candidates, oldRabbitId);
}

// PlayerInfo::isARabbitKill (PlayerInfo.h:324) -- `wasRabbit || victim is the
// rabbit`. Shooting the rabbit is never a team kill, and neither is anything the
// deposed rabbit does before its next spawn: hunters are team mates, so
// hunter-on-hunter fire *is* team killing, and this one window is the whole
// exception to that. `wasRabbit` is set the moment a rabbit is deposed and
// cleared when it spawns again (bzfs.cxx:3287).
//
// Server-only.
function isARabbitKill(killer, victim) {
  return Boolean(killer?.wasRabbit) || isRabbitTeam(victim?.team);
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

// How far a team mate's shade may sit from the team colour, for
// getInitialPlayerColor below. The hue spread is bounded by the closest pair of
// team colours -- red at 0 and purple at 300, 60 degrees apart -- so ten degrees
// either side leaves 40 of clearance and no red is ever within reach of a
// purple. `check:team-shade-bands` asserts that against the table above rather
// than trusting this comment. Most of the separation comes from lightness for
// that reason, and because the team colours are already fully saturated and can
// only move down.
const TEAM_SHADE_HUE_SPREAD = 10;
const TEAM_SHADE_HUE_STEP = 5;
const TEAM_SHADE_SAT_SPREAD = 12;
const TEAM_SHADE_LIGHT_SPREAD = 14;
// Below this there is no hue to shade: observer's white would only go grey.
const TEAM_SHADE_MIN_SATURATION = 15;

function getPlayerTeamRadarColor(team) {
  return PLAYER_TEAM_RADAR_COLORS[normalizePlayerTeam(team)];
}

function getPlayerTeamColor(team) {
  return PLAYER_TEAM_COLORS[normalizePlayerTeam(team)];
}

// Upstream gives every tank on a team the one team colour (Team::getTankColor,
// Team.cxx:30) and has nothing per player -- do not go looking for it there.
// bzo shades team mates apart inside a band around that colour, for the same
// reason it gives every player a distinct colour outside team mode: so a player
// can tell two team mates apart at a range where the labels are unreadable. The
// team is still what the colour says first; the band is narrow enough that no
// shade of one team reads as another.
//
// Observer is the exception at both ends: it keeps upstream's flat white on every
// server, whatever the team mode. An observer has no tank to tell apart from
// another observer's -- it is never drawn -- and its scoreboard row is read by
// name, so there is nothing for a distinct colour to distinguish. With colour
// teams on `pickDistinctColor` already answers white for it, white having no hue
// to shade; this makes it true with them off as well.
function getInitialPlayerColor(teamMode, team, pickDistinctColor) {
  if (isObserverTeam(team)) return PLAYER_TEAM_COLORS[PLAYER_TEAM.OBSERVER];
  return pickDistinctColor(teamMode.enabled ? team : null);
}

// What colour a player takes when a join puts them on `team`, having been on
// `previousTeam` (null for a first join). `null` means the colour they already
// have stands, which is what a rejoin on a world with no colour teams gets: a
// tank that changed colour mid-match would undo the only thing a distinct colour
// is for.
//
// Server-only. The constructor uses getInitialPlayerColor above, before any team
// has been chosen; this is the one that sees a real team.
function getJoinPlayerColor(teamMode, team, previousTeam, pickDistinctColor) {
  if (isObserverTeam(team)) return PLAYER_TEAM_COLORS[PLAYER_TEAM.OBSERVER];
  // A shade inside the new team's band rather than the flat team colour.
  if (teamMode.enabled) return pickDistinctColor(team);
  // Coming back from observer on a world with no colour teams, where the
  // constructor's colour is long gone: the white it was wearing is nobody's, so
  // it takes a fresh one off the whole wheel rather than staying white.
  if (isObserverTeam(previousTeam)) return pickDistinctColor(null);
  return null;
}

module.exports = {
  PLAYER_TEAM_COLORS,
  TEAM_SHADE_HUE_SPREAD,
  TEAM_SHADE_HUE_STEP,
  TEAM_SHADE_SAT_SPREAD,
  TEAM_SHADE_LIGHT_SPREAD,
  TEAM_SHADE_MIN_SATURATION,
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
  parseBZWTeamMode,
  resolveTeamMode,
  selectPlayerTeam,
  getPlayerTeamColor,
  getPlayerTeamRadarColor,
  getInitialPlayerColor,
  getJoinPlayerColor,
  isColorTeam,
  isObserverTeam,
  isRabbitTeam,
  areFoes,
  allowTeams,
  getGameType,
  normalizeRabbitSelection,
  resolveRabbitSelection,
  getPlayerRanking,
  canBeRabbit,
  anointRabbit,
  pickNewRabbit,
  isARabbitKill,
  teamScoreMovesOnKill,
  getTeamScoreDeltasForKill,
  getTeamScoreDeltasForCapture,
};
