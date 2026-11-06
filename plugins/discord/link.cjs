/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Discord Linked Roles: a Discord member proves which BZFlag account is theirs,
// and the Discord server can make roles that require it. See docs/discord.md.
//
// Two pages of the plugin's web directory, which asks for a BZID login
// (eBZID) and keeps it, so both know who is signed in:
//
//   /plugins/discord/link      -> Discord's OAuth2 consent
//   /plugins/discord/callback  <- Discord, with a code; the link is made
//
// Nothing is trusted from the browser. The BZID comes from CHECKTOKENS, before
// either page is made; the Discord ID from Discord's own API with the token
// its code buys. What the browser carries to Discord and back is a random key
// to a record kept here. The Discord token is spent on the role connection
// and dropped: nothing kept here can act on a member's Discord account
// afterwards.

const crypto = require('crypto');
const { URLSearchParams } = require('url');

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
// How long a member has to say yes to Discord, and how many unfinished links
// are held at once: enough for a busy evening, too few to fill memory with.
const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_LIMIT = 500;

// What the app vouches for, as Discord's role connection metadata. Type 7 is
// BOOLEAN_EQUAL: a role requiring it needs the value to be 1.
const ROLE_METADATA = Object.freeze([
  Object.freeze({
    type: 7, key: 'verified', name: 'BZFlag player',
    description: 'Signed in with a bzflag.org account',
  }),
  Object.freeze({
    type: 7, key: 'bzflag_admin', name: 'BZFlag admin',
    description: 'In one of the bzo server\'s admin groups at bzflag.org',
  }),
]);

// Short-lived records keyed by a random id, dropped on first use or when old.
function createPending(now) {
  const records = new Map();
  const prune = () => {
    const cutoff = now() - PENDING_TTL_MS;
    for (const [key, record] of records) if (record.at < cutoff) records.delete(key);
    while (records.size >= PENDING_LIMIT) records.delete(records.keys().next().value);
  };
  return {
    add(record) {
      prune();
      const key = crypto.randomBytes(24).toString('base64url');
      records.set(key, { ...record, at: now() });
      return key;
    },
    take(key) {
      if (typeof key !== 'string') return null;
      const record = records.get(key);
      records.delete(key);
      if (!record || record.at < now() - PENDING_TTL_MS) return null;
      return record;
    },
  };
}

// `config` is the plugin's options; `store` loads and saves the links.
function createDiscordLink({ config, store, log, logError, fetchImpl = fetch, now = Date.now }) {
  const applicationId = config.applicationId;
  const links = new Map(Object.entries(store.load() || {}));
  const consents = createPending(now);

  const text = (status, body) => ({ status, text: body });
  const discordJson = async (path, init) => {
    const response = await fetchImpl(`${DISCORD_API}${path}`, { ...init, signal: AbortSignal.timeout(10000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${path} ${response.status} ${body.message || body.error || ''}`.trim());
    return body;
  };

  // The roles a Discord server can require, declared when Discord's copy
  // differs from ROLE_METADATA. Read first: a dev server restarts on every
  // edit, and declaring on each start soon meets Discord's rate limit.
  async function registerMetadata() {
    const path = `/applications/${applicationId}/role-connections/metadata`;
    const auth = { Authorization: `Bot ${config.botToken}` };
    const shape = (list) => JSON.stringify((Array.isArray(list) ? list : []).map(({ type, key, name, description }) => ({
      type, key, name, description,
    })));
    const held = await discordJson(path, { headers: auth });
    if (shape(held) === shape(ROLE_METADATA)) return;
    await discordJson(path, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(ROLE_METADATA),
    });
    log(`role metadata: ${ROLE_METADATA.map((entry) => entry.key).join(', ')}`);
  }

  // A linked member's nickname in the Discord server is their callsign, set by
  // the bot, which needs Manage Nicknames and a role above the member's. Best
  // effort: the link stands whether or not this works, and Discord refuses it
  // outright for the server's owner. Nicknames are 32 characters at most.
  async function setNickname(discordId, callsign) {
    if (!config.guildId) return false;
    try {
      await discordJson(`/guilds/${config.guildId}/members/${discordId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bot ${config.botToken}`,
          'Content-Type': 'application/json',
          'X-Audit-Log-Reason': 'Linked BZFlag callsign',
        },
        body: JSON.stringify({ nick: callsign.slice(0, 32) }),
      });
      log(`nickname for ${discordId} set to "${callsign}"`);
      return true;
    } catch (err) {
      log(`nickname for ${discordId} not set: ${err.message}`);
      return false;
    }
  }

  // `/link`, signed in: off to Discord to say who they are there.
  function start({ base, bzid, callsign, admin }) {
    const state = consents.add({ bzid, callsign, admin });
    const params = new URLSearchParams({
      client_id: applicationId,
      redirect_uri: `${base}/plugins/discord/callback`,
      response_type: 'code',
      scope: 'identify role_connections.write',
      state,
      prompt: 'consent',
    });
    log(`"${callsign}" on to Discord`);
    return { status: 302, location: `${DISCORD_AUTHORIZE}?${params}` };
  }

  // `/callback`, signed in as the same BZID that started.
  async function callback({ base, bzid, params }) {
    const pending = consents.take(params.state);
    if (!pending || pending.bzid !== bzid) {
      return text(403, 'That link has expired or was already used. Start again from Discord.');
    }
    if (typeof params.code !== 'string' || !params.code) {
      return text(403, 'Discord did not say yes. Start again from Discord if you meant to.');
    }
    let member;
    let accessToken;
    try {
      const grant = await discordJson('/oauth2/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${applicationId}:${config.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: params.code,
          redirect_uri: `${base}/plugins/discord/callback`,
        }),
      });
      accessToken = grant.access_token;
      member = await discordJson('/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch (err) {
      logError('sign-in failed', err);
      return text(500, 'Discord could not be reached just now. Start again from Discord.');
    }
    const record = {
      bzid: pending.bzid,
      callsign: pending.callsign,
      admin: Boolean(pending.admin),
      discordName: member.username,
      linkedAt: new Date(now()).toISOString(),
    };
    try {
      await discordJson(`/users/@me/applications/${applicationId}/role-connection`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform_name: 'BZFlag',
          platform_username: record.callsign,
          // As text, which is how Discord documents a role connection's values.
          metadata: { verified: '1', bzflag_admin: record.admin ? '1' : '0' },
        }),
      });
    } catch (err) {
      logError('role connection failed', err);
      return text(500, 'Discord did not take the link just now. Start again from Discord.');
    }
    links.set(member.id, record);
    try {
      store.save(Object.fromEntries(links));
    } catch (err) {
      logError('could not save links', err);
    }
    log(`linked "${member.username}" (${member.id}) to "${record.callsign}"`
      + ` bzid=${record.bzid}${record.admin ? ' admin' : ''}`);
    const renamed = await setNickname(member.id, record.callsign);
    return text(200, `Linked: Discord "${member.username}" is BZFlag "${record.callsign}".`
      + (renamed ? ' Your nickname there is now your callsign.' : '')
      + ' You can close this and go back to Discord.');
  }

  return {
    registerMetadata,
    start,
    callback,
    linkFor: (discordId) => links.get(discordId) || null,
    get size() { return links.size; },
  };
}

// Whether the options have what Linked Roles needs.
function discordLinkConfigured(config) {
  return Boolean(config && ['applicationId', 'clientSecret', 'botToken']
    .every((key) => typeof config[key] === 'string' && config[key].length > 0));
}

module.exports = { createDiscordLink, discordLinkConfigured, ROLE_METADATA };
