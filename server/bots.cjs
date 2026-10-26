/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Bots this server runs itself (docs/bots-plan.md, step 2): upstream's
// `bz_ServerSidePlayerHandler` with one of `public/js/autopilot.mjs`'s pilots as
// its brain. A bot is a client in every way the server can see -- it joins,
// moves and shoots through the same messages a browser sends, on a socket that
// never leaves the process -- so validation, broadcast, scoring and the list
// treat it as any other player. What lives here is only what a browser does
// for itself: drive the tank and say so.

// The tank itself is `public/js/bot-driver.mjs`, which offline play drives its
// bots by too.
const { BotDriver } = require('../public/js/bot-driver.mjs');

// The fill rule: bots make up the playing roster to `fill`, and there are none
// once the people do. Returns how many to add (positive) or take away
// (negative).
function planBotFill({ fill, humans, bots }) {
  const wanted = Math.max(0, Math.floor(fill || 0) - humans);
  return wanted - bots;
}

// The team a bot leaves when the roster has one too many: the biggest, so a
// person joining a team leaves the game as even as it was.
function pickBotToRemove(bots, teamSizes) {
  let best = null;
  for (const bot of bots) {
    const size = teamSizes.get(bot.team) || 0;
    // Within a team, the lowest slot: bots are added from the top down, so the
    // last one added is the first to go.
    if (!best || size > best.size || (size === best.size && (bot.slot ?? 0) < (best.bot.slot ?? 0))) {
      best = { bot, size };
    }
  }
  return best ? best.bot : null;
}

module.exports = {
  planBotFill,
  pickBotToRemove,
  BotDriver,
};
