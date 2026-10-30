/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// ctfOverseer.cjs - allejo's ctfOverseer (github.com/allejo/ctfOverseer), which
// many CTF servers load, written again for bzo. Off until server.json's
// "plugins" turns it on; on, it does what allejo's does by default, and its
// two BZDB variables tune it from a world or `/set`:
//
// - `_disallowSelfCap`, 1: refuse a capture of the capper's own flag.
// - `_delayTeamFlagGrab`, 20: keep a team flag from enemy hands for that many
//   seconds after it was captured; its own team may still take it. The
//   refusal is said at most every five seconds, in the plugin's words.

'use strict';

const WARN_INTERVAL_MS = 5000;
// A team flag's abbreviation, by the bz_eTeamType it belongs to.
const TEAM_FLAGS = Object.freeze({ 'R*': 1, 'G*': 2, 'B*': 3, 'P*': 4 });
const TEAM_NAMES = Object.freeze({ 1: 'Red', 2: 'Green', 3: 'Blue', 4: 'Purple' });

module.exports = {
  meta: {
    name: 'ctfOverseer',
    version: '1.0',
    author: 'Tim Riker, after allejo',
    description: 'no capturing your own flag, and a wait before an enemy may grab a team flag just captured',
    license: 'AGPL-3.0',
    enabled: false,
  },

  Init(bz) {
    this.bz = bz;
    this.cappedAt = new Map();
    this.warnedAt = new Map();
    bz.bz_registerCustomBZDBBool('_disallowSelfCap', true);
    bz.bz_registerCustomBZDBInt('_delayTeamFlagGrab', 20);
    bz.Register(bz.bz_eAllowCTFCaptureEvent);
    bz.Register(bz.bz_eCaptureEvent);
    bz.Register(bz.bz_eAllowFlagGrab);
    bz.Register(bz.bz_ePlayerPartEvent);
  },

  Event(data) {
    const { bz } = this;
    switch (data.eventType) {
      case bz.bz_eAllowCTFCaptureEvent:
        if (data.teamCapped === data.teamCapping && bz.bz_getBZDBBool('_disallowSelfCap')) data.allow = false;
        break;
      case bz.bz_eCaptureEvent:
        this.cappedAt.set(data.teamCapped, Date.now());
        break;
      case bz.bz_eAllowFlagGrab:
        if (!this.grabAllowed(data.playerID, data.flagType)) data.allow = false;
        break;
      case bz.bz_ePlayerPartEvent:
        this.warnedAt.delete(data.playerID);
        break;
      default:
    }
  },

  grabAllowed(playerID, flagType) {
    const { bz } = this;
    const team = TEAM_FLAGS[flagType];
    const delay = bz.bz_getBZDBDouble('_delayTeamFlagGrab');
    if (team === undefined || !(delay > 0) || bz.bz_getPlayerTeam(playerID) === team) return true;
    const cappedAt = this.cappedAt.get(team);
    const now = Date.now();
    if (cappedAt === undefined || now >= cappedAt + (delay * 1000)) return true;
    if (now > (this.warnedAt.get(playerID) ?? -Infinity) + WARN_INTERVAL_MS) {
      this.warnedAt.set(playerID, now);
      bz.bz_sendTextMessage(bz.BZ_SERVER, playerID,
        'Team flags cannot be grabbed for {seconds} seconds after they were last capped.', { seconds: delay });
      bz.bz_sendTextMessage(bz.BZ_SERVER, playerID,
        'You cannot grab the {team} team flag for another ~{seconds} seconds', {
          team: { msgid: TEAM_NAMES[team] },
          seconds: Math.round((cappedAt + (delay * 1000) - now) / 1000),
        });
    }
    return false;
  },
};
