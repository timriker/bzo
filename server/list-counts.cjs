/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// list-counts.cjs - Who a server list counts, for bzo's own list and for the
// BZFlag list. Per team in `-mp` order (`teamOrder`, rogue to observer), with
// the rabbit and the hunters as rogues, as `getTeamCounts` has them
// (bzfs.cxx:830).
'use strict';

const { PLAYER_TEAM } = require('./teams.cjs');

function teamSlot(team, teamOrder) {
  const counted = team === PLAYER_TEAM.RABBIT || team === PLAYER_TEAM.HUNTER ? PLAYER_TEAM.ROGUE : team;
  return teamOrder.indexOf(counted);
}

// bzo's own list: `players` is people at the controls, observers aside;
// `bots` and `autopilot` are counted beside it; `teamCounts` is every tank,
// as upstream's ping has them.
function listCounts(players, teamOrder) {
  const teamCounts = teamOrder.map(() => 0);
  let people = 0;
  let bots = 0;
  let autopilot = 0;
  for (const player of players) {
    if (!player.joined) continue;
    const slot = teamSlot(player.team, teamOrder);
    if (slot >= 0) teamCounts[slot] += 1;
    if (player.team === PLAYER_TEAM.OBSERVER) continue;
    if (player.bot) bots += 1;
    else if (player.autopilot) autopilot += 1;
    else people += 1;
  }
  return { players: people, bots, autopilot, teamCounts };
}

// The BZFlag list's per-team counts: humans at the controls only -- unlike
// bzfs, which counts a person on autopilot -- or, `withBots`, every tank, as
// the UDP ping and MsgQueryGame count.
function bzflagTeamCounts(players, teamOrder, { withBots = false } = {}) {
  const counts = teamOrder.map(() => 0);
  for (const player of players) {
    if (!player.joined || ((player.bot || player.autopilot) && !withBots)) continue;
    const slot = teamSlot(player.team, teamOrder);
    if (slot >= 0) counts[slot] += 1;
  }
  return counts;
}

module.exports = { listCounts, bzflagTeamCounts };
