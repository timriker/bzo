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
const { createRoster } = require('./bridge/lines.cjs');

const WEBHOOK_PREFIX = 'https://discord.com/api/webhooks/';
const DISCORD_API = 'https://discord.com/api/v10';
// Discord's limit on a message's text.
const REPLY_LIMIT = 2000;

// `/bzo`, a slash command of the app's: in the guild, where a change shows at
// once, or everywhere the app is.
async function registerCommand(config) {
  const where = config.guildId ? `/guilds/${config.guildId}` : '';
  const response = await fetch(`${DISCORD_API}/applications/${config.applicationId}${where}/commands`, {
    method: 'POST',
    headers: { Authorization: `Bot ${config.botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'bzo',
      description: 'Run a command on this game server, as your linked BZFlag account',
      options: [{ type: 3, name: 'command', description: 'The command without its slash, as playerlist', required: true }],
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
}

// A direct message from the bot; false where Discord will not deliver one.
async function directMessage(config, userId, content) {
  const headers = { Authorization: `Bot ${config.botToken}`, 'Content-Type': 'application/json' };
  const opened = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: 'POST', headers, body: JSON.stringify({ recipient_id: userId }), signal: AbortSignal.timeout(10000),
  });
  if (!opened.ok) return false;
  const { id } = await opened.json();
  const sent = await fetch(`${DISCORD_API}/channels/${id}/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10000),
  });
  return sent.ok;
}

// A server command from a member, `/bzo <command>` or `!command` in the
// bridged channel: run as their linked BZFlag account. Resolves to what to
// tell them -- the answer, or why there is none.
async function runFor(bz, link, user, asked) {
  const linked = link?.linkFor(user.id);
  if (!linked) return 'Link your BZFlag account first, through the BZFlag player role in this server.';
  const line = `/${String(asked).trim().replace(/^[/!]/, '')}`;
  const replies = await bz.bz_runCommand(line, {
    callsign: linked.callsign, bzid: linked.bzid, admin: linked.admin, via: 'Discord',
  });
  const content = [line, ...(replies.length ? replies : ['(no reply)'])].join('\n');
  return content.length > REPLY_LIMIT ? `${content.slice(0, REPLY_LIMIT - 1)}…` : content;
}

// `/bzo <command>`: the answer in a direct message, since it may name
// addresses. Where the member takes no direct messages from the server's
// members, it stays in the reply only they see, never the channel. Deferred
// first: Discord wants an answer within three seconds.
async function answerCommand(bz, config, link, interaction) {
  const callback = (body) => fetch(`${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  await callback({ type: 5, data: { flags: 64 } });
  const user = interaction.member?.user || interaction.user || {};
  const asked = interaction.data.options?.find((option) => option.name === 'command')?.value || '';
  let content = await runFor(bz, link, user, asked);
  if (await directMessage(config, user.id, content)) content = 'Sent you the answer in a direct message.';
  await fetch(`${DISCORD_API}/webhooks/${config.applicationId}/${interaction.token}/messages/@original`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10000),
  });
}

// `!command` in the channel: the answer in a direct message, and with none
// to be had, nothing in the channel -- only the log says so.
async function answerBang(bz, config, link, message, text, log) {
  const content = await runFor(bz, link, message.author || {}, text);
  if (await directMessage(config, message.author?.id, content)) return;
  log(`no direct message to ${message.author?.username}; ${text} not answered`);
}

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
    bz.Register(bz.bz_ePlayerJoinEvent);
    bz.Register(bz.bz_ePlayerPartEvent);
    state.roster = createRoster({
      bz, store: jsonStore(bz, 'discord-roster.json', null), say: (line) => state.mirror.event(line),
      setTimer: bz.setTimeout,
    });
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
          onCommand: ({ message, text }) => answerBang(bz, config, state.link, message, text, log)
            .catch((error) => logError(text, error)),
          log,
        });
        state.gateway = createGateway({
          token: config.botToken,
          onDispatch: (type, data) => {
            if (type === 'MESSAGE_CREATE') onMessage(data);
            if (type === 'INTERACTION_CREATE' && data.type === 2 && data.data?.name === 'bzo'
              && data.channel_id === webhook.channel_id) {
              answerCommand(bz, config, state.link, data).catch((error) => logError('/bzo', error));
            }
          },
          store: jsonStore(bz, 'discord-gateway.json', null),
          log,
          logError,
          setTimer: bz.setTimeout,
          clearTimer: bz.clearTimer,
        });
        state.gateway.start();
        log('channel messages relayed into the game');
        if (config.applicationId) {
          registerCommand(config).then(() => log('/bzo registered'), (error) => logError('/bzo not registered', error));
        }
      })
      .catch((error) => logError('could not start the channel relay', error));
  },

  // Public chat, as every player read it, to the channel: with BZFlag's
  // scoreboard mark, `@` for an admin and `+` for a signed-in player.
  Event(data) {
    if (!running?.mirror) return;
    const { bz, mirror, roster } = running;
    // A person coming or going, with who is in now; bots come and go unsaid.
    if (data.eventType === 'bz_ePlayerJoinEvent' || data.eventType === 'bz_ePlayerPartEvent') {
      roster.heard(data.record, data.eventType === 'bz_ePlayerJoinEvent');
      return;
    }
    if (data.eventType !== 'bz_eFilteredChatMessageEvent') return;
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
