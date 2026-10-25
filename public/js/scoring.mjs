/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// What one kill does to the scoreboard, shared by the client and the server so
// that both tally the same match from the same events and never need to send
// a score. Upstream's server tallies it (`playerKilled`, bzfs.cxx:3437) and
// sends every client the result, which bzo does only for BZFlag clients.
import { areFoes, isRabbitTeam } from './teams.mjs';

// The victim takes a loss. A killer who is not the victim takes a win for a
// foe, or a loss and a team kill for a team mate (`killedBy` and `tK`) --
// except a rabbit kill, which is never a team kill (PlayerInfo::isARabbitKill:
// the victim is the rabbit, or the killer is a rabbit deposed and not yet
// spawned again). No killer is a world weapon or the world, nobody's to score.
// Teams are as they stood when the shot landed.
export function getKillScoreDeltas(kill) {
  const {
    killerId = null, victimId, killerTeam = null, victimTeam = null, teamsAllowed = true, killerWasRabbit = false,
  } = kill;
  const victim = { wins: 0, losses: 1, tks: 0 };
  if (killerId === null || killerId === undefined || killerId === victimId) {
    return { victim, killer: null, teamKill: false };
  }
  const rabbitKill = killerWasRabbit || isRabbitTeam(victimTeam);
  const teamKill = !areFoes(killerTeam, victimTeam, teamsAllowed) && !rabbitKill;
  return {
    victim,
    killer: teamKill ? { wins: 0, losses: 1, tks: 1 } : { wins: 1, losses: 0, tks: 0 },
    teamKill,
  };
}
