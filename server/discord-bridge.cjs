/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A game's public chat, mirrored into one Discord channel through that
// channel's webhook. See docs/chat-bridge-plan.md, "Game to Discord" (issue #193).
//
// Only what `deliverChatMessage` sends to every player arrives here: team
// chat, private messages, the admin channel, a muted player and every command
// line are refused or routed before it. Nothing comes back the other way.
//
// A webhook takes about 30 posts a minute, so lines queue and go at most one
// post every `FLUSH_MS`. A post from one player carries their callsign as its
// sender; lines from several players in one window go as one post under the
// server's own name, each line led by its speaker. Mentions are switched off,
// so no line can ping `@everyone`, a role or a member. A speaker's name carries
// BZFlag's scoreboard mark: `@` for an admin, `+` for a signed-in player.

const FLUSH_MS = 2000;
// Discord's own limits: a post's text and a webhook sender's name.
const CONTENT_LIMIT = 2000;
const NAME_LIMIT = 80;
// Lines held while Discord is not answering, beyond which the oldest go.
const QUEUE_LIMIT = 200;

// Text as Discord shows it: no BZFlag colour codes (`ESC[...m`, whole) and no
// other control characters.
function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

// A sender name Discord accepts for a webhook post: it refuses one naming
// Discord or Clyde, and a few characters, so those are taken out.
function senderName(name, fallback) {
  const cleaned = plain(name).replace(/discord|clyde/gi, '').replace(/[@#:`]/g, '').trim().slice(0, NAME_LIMIT);
  return cleaned || fallback;
}

// A speaker's name in a shared post, with Markdown's own characters escaped
// so a callsign stays a callsign.
function boldName(name) {
  return `**${plain(name).replace(/([\\*_~`|>])/g, '\\$1')}**`;
}

function createChatMirror({
  webhookUrl, serverName, log, logError,
  fetchImpl = fetch, setTimer = setTimeout, now = Date.now,
}) {
  const queue = [];
  let timer = null;
  let pausedUntil = 0;

  const schedule = (delay = FLUSH_MS) => {
    if (timer || queue.length === 0) return;
    timer = setTimer(() => {
      timer = null;
      flush().catch((err) => logError('[DISCORD] chat mirror failed', err));
    }, delay);
  };

  // What one post says: one speaker's lines under their name, or several
  // speakers' under the server's.
  function compose(lines) {
    const speakers = new Set(lines.map((line) => `${line.mark}${line.name}`));
    const one = speakers.size === 1;
    const text = lines.map((line) => {
      const said = line.action ? `*${line.text}*` : line.text;
      return one ? said : `${boldName(`${line.mark}${line.name}`)}: ${said}`;
    }).join('\n');
    return {
      username: one ? `${lines[0].mark}${senderName(lines[0].name, serverName)}` : senderName(serverName, 'bzo'),
      content: text.length > CONTENT_LIMIT ? `${text.slice(0, CONTENT_LIMIT - 1)}…` : text,
      allowed_mentions: { parse: [] },
    };
  }

  async function flush() {
    if (queue.length === 0) return;
    if (now() < pausedUntil) {
      schedule(pausedUntil - now());
      return;
    }
    // One speaker is one name *and* one mark: a player who signs in mid-window
    // is two speakers.
    const lines = queue.splice(0, queue.length);
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(compose(lines)),
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 429) {
      // Rate limited: the lines go back to the front, and wait as long as
      // Discord says.
      const body = await response.json().catch(() => ({}));
      pausedUntil = now() + Math.ceil((Number(body.retry_after) || 2) * 1000);
      queue.unshift(...lines);
      log(`[DISCORD] chat mirror rate limited for ${pausedUntil - now()}ms`);
    } else if (!response.ok) {
      log(`[DISCORD] chat mirror dropped ${lines.length} line(s): ${response.status}`);
    }
    schedule();
  }

  return {
    // One public chat line, from `name`, with `mark` ('@', '+' or '') before
    // it. `msgType` 'action' is `/me`.
    relay(name, text, msgType, mark = '') {
      const said = plain(text);
      if (!said) return;
      queue.push({ name, text: said, action: msgType === 'action', mark });
      if (queue.length > QUEUE_LIMIT) queue.splice(0, queue.length - QUEUE_LIMIT);
      schedule();
    },
    flush,
    get pending() { return queue.length; },
  };
}

// How many lines of one Discord message reach the game, and how long each may
// be: a chat line is short, and a long post is better read in Discord.
const GAME_LINES = 3;
const GAME_LINE_LIMIT = 200;

// Discord's own markup for a mention, a channel and a custom emoji, as the
// name a reader would see.
function readable(content, mentions) {
  const names = new Map((mentions || []).map((user) => [user.id, user.global_name || user.username]));
  return String(content)
    .replace(/<@!?(\d+)>/g, (whole, id) => `@${names.get(id) || 'someone'}`)
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<a?:(\w+):\d+>/g, ':$1:');
}

// Messages in the bridged channel, as game lines. `nameFor(message)` is the
// speaker's name in game -- their linked callsign where there is one, with its
// mark: `@` for a link made by an admin, `+` for any other link.
// `announce({ name, line, text })` says a line to every player: `text` is the
// whole of it, `[Discord] name: line`, for a client that shows it as is.
function createDiscordToGame({ channelId, nameFor, announce, log }) {
  return function onMessage(message) {
    if (message.channel_id !== channelId) return;
    // A bot's post, or the mirror's own webhook: never back into the game.
    if (message.webhook_id || message.author?.bot) return;
    const name = plain(nameFor(message)) || 'someone';
    let text = readable(message.content || '', message.mentions);
    if (!text.trim() && message.attachments?.length) text = '[attachment]';
    if (text.trim().startsWith('/')) {
      log(`[DISCORD] "${name}" sent a command, not relayed: ${plain(text).slice(0, 80)}`);
      return;
    }
    const lines = text.split('\n').map(plain).filter(Boolean);
    if (lines.length === 0) return;
    const shown = lines.slice(0, GAME_LINES).map((line) => (line.length > GAME_LINE_LIMIT
      ? `${line.slice(0, GAME_LINE_LIMIT - 1)}…` : line));
    if (lines.length > GAME_LINES) shown[GAME_LINES - 1] += ' (more in Discord)';
    for (const line of shown) announce({ name, line, text: `[Discord] ${name}: ${line}` });
  };
}

module.exports = { createChatMirror, senderName, createDiscordToGame, readable };
