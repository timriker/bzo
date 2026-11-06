/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// discord.cjs - a game server and its Discord channel, the job upstream's
// ircRelay did for IRC: public chat mirrored into the channel, the channel's
// messages back into the game, and Linked Roles, which let a member prove
// which BZFlag account is theirs. Each part runs when its options are there.
// See docs/discord.md; the parts are in plugins/discord/.
//
// Options, from server.json's "plugins": { "discord": { ... } }:
//   webhookUrl     the channel's webhook: the chat mirror
//   botToken       the app's bot: the channel back into the game, with
//                  webhookUrl; Linked Roles, with the two below
//   applicationId, clientSecret
//                  the app: Linked Roles, at /plugins/discord/link
//   guildId        the Discord server whose nicknames become callsigns

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createDiscordLink, discordLinkConfigured } = require('./discord/link.cjs');
const { createChatMirror, createDiscordToGame } = require('./discord/bridge.cjs');
const { createGateway } = require('./discord/gateway.cjs');

const WEBHOOK_PREFIX = 'https://discord.com/api/webhooks/';

let running = null;

// A JSON file beside server.json, readable only by the server's user: the
// links name BZIDs, and the gateway session can be resumed by whoever holds it.
function jsonStore(bz, file, empty, spacing) {
  const full = path.join(bz.bz_getDataDir(), file);
  return {
    load: () => (fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : empty),
    save: (value) => fs.writeFileSync(full, `${JSON.stringify(value, null, spacing)}${spacing ? '\n' : ''}`,
      { mode: 0o600 }),
  };
}

// Linked Roles' two pages, behind a BZID login the server keeps for the
// round trip through Discord.
function linkPages(bz, link, log) {
  const codes = { 200: bz.e200OK, 302: bz.e302Found, 403: bz.e403Forbiden, 500: bz.e500ServerError };
  const answer = (response, outcome) => {
    response.ReturnCode = codes[outcome.status];
    if (outcome.location) response.RedirectLocation = outcome.location;
    if (outcome.text) {
      response.AddHeader('Content-Type', 'text/plain; charset=utf-8');
      response.AddHeader('X-Content-Type-Options', 'nosniff');
      response.AddBodyData(`${outcome.text}\n`);
    }
    return bz.ePageDone;
  };
  return {
    VDirName: () => 'discord',
    VDirDescription: () => 'Link a Discord account to a bzflag.org one',
    RequiredAuthentiction: bz.eBZID,
    CacheAuthentication: true,
    async GeneratePage(request, response) {
      const page = request.Resource.replace(/^\/plugins\/discord\/?/i, '');
      const base = `https://${request.GetHeader('host')}`;
      const who = {
        base,
        bzid: request.BZID,
        callsign: request.BZIDCallsign,
        // bzfs's own test for an admin (PlayerAccessInfo::isAdmin).
        admin: request.UserHasPerm('ban') || request.UserHasPerm('shortBan'),
      };
      if (page === '' || page === 'link') return answer(response, link.start(who));
      if (page === 'callback') {
        return answer(response, await link.callback({
          ...who,
          params: { state: request.GetParamater('state'), code: request.GetParamater('code') },
        }));
      }
      log(`no page ${page}`);
      return bz.eNoPage;
    },
    GenerateNoAuthPage(request, response) {
      answer(response, { status: 403, text: 'bzflag.org did not accept that sign-in. Start again from Discord.' });
      return true;
    },
  };
}

module.exports = {
  meta: {
    name: 'Discord',
    version: '1.0',
    author: 'Tim Riker',
    description: 'Public chat to and from a Discord channel, and Discord Linked Roles',
    license: 'AGPL-3.0',
  },

  Init(bz, config) {
    const log = (text) => bz.log(text);
    const logError = (what, error) => bz.log(`${what}: ${error?.message || error}`);
    const state = { bz, stopped: false, gateway: null, mirror: null, link: null };
    running = state;

    if (discordLinkConfigured(config)) {
      state.link = createDiscordLink({
        config, store: jsonStore(bz, 'discord-links.json', {}, 2), log, logError,
      });
      bz.bzhttp_RegisterVDir(linkPages(bz, state.link, log));
      log(`Linked Roles on, ${state.link.size} linked`);
      state.link.registerMetadata().catch((error) => logError('role metadata failed', error));
    }

    const webhookUrl = typeof config.webhookUrl === 'string' && config.webhookUrl.startsWith(WEBHOOK_PREFIX)
      ? config.webhookUrl : null;
    if (!webhookUrl) return;
    state.mirror = createChatMirror({
      webhookUrl,
      serverName: bz.bz_getPublicDescription() || 'bzo',
      log,
      logError,
      setTimer: bz.setTimeout,
    });
    bz.Register(bz.bz_eFilteredChatMessageEvent);
    log('public chat mirrored to a channel');

    // The channel's own messages back into the game, through the bot's
    // gateway. The channel is the one the webhook posts to, asked of the
    // webhook itself.
    if (typeof config.botToken !== 'string' || !config.botToken) return;
    fetch(webhookUrl, { signal: AbortSignal.timeout(10000) })
      .then((response) => response.json())
      .then((webhook) => {
        if (state.stopped) return;
        if (!webhook.channel_id) throw new Error('the webhook named no channel');
        const onMessage = createDiscordToGame({
          channelId: webhook.channel_id,
          nameFor: (message) => {
            const linked = state.link?.linkFor(message.author?.id);
            if (linked) return `${linked.admin ? '@' : '+'}${linked.callsign}`;
            return message.member?.nick || message.author?.global_name || message.author?.username;
          },
          announce: ({ name, line }) => bz.bz_sendRelayMessage('Discord', name, line),
          log,
        });
        state.gateway = createGateway({
          token: config.botToken,
          onDispatch: (type, data) => {
            if (type === 'MESSAGE_CREATE') onMessage(data);
          },
          store: jsonStore(bz, 'discord-gateway.json', null),
          log,
          logError,
          setTimer: bz.setTimeout,
          clearTimer: bz.clearTimer,
        });
        state.gateway.start();
        log('channel messages relayed into the game');
      })
      .catch((error) => logError('could not start the channel relay', error));
  },

  // Public chat, as every player read it, to the channel: with BZFlag's
  // scoreboard mark, `@` for an admin and `+` for a signed-in player.
  Event(data) {
    if (data.eventType !== 'bz_eFilteredChatMessageEvent' || !running?.mirror) return;
    const { bz, mirror } = running;
    if (data.to !== bz.BZ_ALLUSERS) return;
    const record = bz.bz_getPlayerByIndex(data.from);
    if (!record) return;
    mirror.relay(record.callsign, data.message, data.messageType === bz.eActionMessage ? 'action' : 'chat',
      record.admin ? '@' : (record.verified ? '+' : ''));
  },

  Cleanup() {
    if (!running) return;
    running.stopped = true;
    running.gateway?.stop();
    running = null;
  },

  l10n: {},
};
