/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// What a player is playing on, as the one letter the scoreboard's `T` column
// draws (issue #185). Upstream has no such column; its only player type is
// `TankPlayer` or `ComputerPlayer` (global.h), which `r` and the rest split.
//
// First match wins, so a bot is a bot whatever browser it runs in, and a
// headset is a headset even though its browser also says it is a phone.
const CLIENT_TYPE = Object.freeze({
  SERVER_BOT: 's', // one of this server's own bots (server/bots.cjs)
  ROBOT: 'r', // upstream's ComputerPlayer: a `?bot` browser or a BZFlag robot
  BZFLAG: 'b', // a BZFlag client
  VR: 'v', // in an XR session, or a headset's own browser
  MOBILE: 'm', // a phone or tablet
  DESKTOP: 'd', // anything else
});

function clientTypeOf({ serverBot, bot, native, xr, headset, mobile } = {}) {
  if (serverBot) return CLIENT_TYPE.SERVER_BOT;
  if (bot) return CLIENT_TYPE.ROBOT;
  if (native) return CLIENT_TYPE.BZFLAG;
  if (xr || headset) return CLIENT_TYPE.VR;
  if (mobile) return CLIENT_TYPE.MOBILE;
  return CLIENT_TYPE.DESKTOP;
}

module.exports = { CLIENT_TYPE, clientTypeOf };
