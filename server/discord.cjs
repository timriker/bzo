/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Discord Linked Roles: a Discord member proves which BZFlag account is theirs,
// and the Discord server can make roles that require it. See
// docs/chat-bridge-plan.md (issue #193).
//
// Three requests, each one leg of a round trip through somebody else's login:
//
//   /discord/link           -> Discord's OAuth2 consent
//   /discord/link/callback  <- Discord, with a code; -> bzflag.org weblogin
//   /discord/link/bzflag/K  <- bzflag.org, with a token; the link is made
//
// Nothing is trusted from the browser. The Discord ID comes from Discord's own
// API with the token its code buys; the BZID comes from CHECKTOKENS. What the
// browser carries between the legs is a random key to a record kept here, as
// a login session's cookie is (sessions.cjs). The Discord token is spent on
// the role connection and dropped: nothing kept here can act on a member's
// Discord account afterwards.

const crypto = require('crypto');
const { URLSearchParams } = require('url');

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const BZFLAG_LOGIN_URL = 'https://my.bzflag.org/weblogin.php';
// How long a member has to finish each leg, and how many unfinished ones are
// held at once: enough for a busy evening, too few to fill memory with.
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

// `config` is server.json's `discord` block. `checkToken(callsign, token)`
// resolves to CHECKTOKENS's parsed reply; `isAdmin(groups)` says whether the
// groups it named grant admin; `store` loads and saves the links.
function createDiscordLink({
  config, checkToken, isAdmin, store, log, logError,
  fetchImpl = fetch, now = Date.now,
}) {
  const applicationId = config.applicationId;
  const links = new Map(Object.entries(store.load() || {}));
  const consents = createPending(now);
  const signIns = createPending(now);

  const text = (res, status, body) => {
    res.status(status).set('Content-Type', 'text/plain; charset=utf-8')
      .set('X-Content-Type-Options', 'nosniff').send(`${body}\n`);
  };
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
    log(`[DISCORD] role metadata: ${ROLE_METADATA.map((entry) => entry.key).join(', ')}`);
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
      log(`[DISCORD] nickname for ${discordId} set to "${callsign}"`);
      return true;
    } catch (err) {
      log(`[DISCORD] nickname for ${discordId} not set: ${err.message}`);
      return false;
    }
  }

  function start(req, res, host) {
    const state = consents.add({});
    const params = new URLSearchParams({
      client_id: applicationId,
      redirect_uri: `https://${host}/discord/link/callback`,
      response_type: 'code',
      scope: 'identify role_connections.write',
      state,
      prompt: 'consent',
    });
    res.redirect(302, `${DISCORD_AUTHORIZE}?${params}`);
  }

  async function discordCallback(req, res, host) {
    if (!consents.take(req.query.state)) {
      text(res, 400, 'That link has expired or was already used. Start again from Discord.');
      return;
    }
    if (typeof req.query.code !== 'string' || !req.query.code) {
      text(res, 400, 'Discord did not say yes. Start again from Discord if you meant to.');
      return;
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
          code: req.query.code,
          redirect_uri: `https://${host}/discord/link/callback`,
        }),
      });
      accessToken = grant.access_token;
      member = await discordJson('/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch (err) {
      logError('[DISCORD] sign-in failed', err);
      text(res, 502, 'Discord could not be reached just now. Start again from Discord.');
      return;
    }
    const key = signIns.add({ discordId: member.id, discordName: member.username, accessToken });
    // `%TOKEN%` and `%USERNAME%` ride in one parameter and the key in the path,
    // for the same reason as /login's callback: weblogin.php's own `&`.
    const callback = `https://${host}/discord/link/bzflag/${key}?t=%TOKEN%:%USERNAME%`;
    log(`[DISCORD] "${member.username}" (${member.id}) on to bzflag.org`);
    // Set rather than `res.redirect`, which would escape the placeholders.
    res.status(302).set('Location', `${BZFLAG_LOGIN_URL}?action=weblogin&url=${callback}`).end();
  }

  async function bzflagCallback(req, res) {
    const pending = signIns.take(req.params.key);
    if (!pending) {
      text(res, 400, 'That link has expired or was already used. Start again from Discord.');
      return;
    }
    const packed = typeof req.query.t === 'string' ? req.query.t : '';
    const separator = packed.indexOf(':');
    const token = separator === -1 ? '' : packed.slice(0, separator);
    const callsign = separator === -1 ? '' : packed.slice(separator + 1);
    if (!token || !callsign) {
      text(res, 400, 'bzflag.org did not sign you in. Start again from Discord.');
      return;
    }
    let reply;
    try {
      reply = await checkToken(callsign, token);
    } catch (err) {
      logError('[DISCORD] CHECKTOKENS failed', err);
      text(res, 502, 'bzflag.org could not be reached just now. Start again from Discord.');
      return;
    }
    if (!reply.good || !reply.bzid) {
      log(`[DISCORD] "${pending.discordName}" refused by bzflag.org as "${callsign}"`);
      text(res, 403, 'bzflag.org did not accept that sign-in. Start again from Discord.');
      return;
    }
    const record = {
      bzid: reply.bzid,
      callsign: reply.callsign || callsign,
      admin: Boolean(isAdmin(reply.groups)),
      discordName: pending.discordName,
      linkedAt: new Date(now()).toISOString(),
    };
    try {
      await discordJson(`/users/@me/applications/${applicationId}/role-connection`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${pending.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform_name: 'BZFlag',
          platform_username: record.callsign,
          // As text, which is how Discord documents a role connection's values.
          metadata: { verified: '1', bzflag_admin: record.admin ? '1' : '0' },
        }),
      });
    } catch (err) {
      logError('[DISCORD] role connection failed', err);
      text(res, 502, 'Discord did not take the link just now. Start again from Discord.');
      return;
    }
    links.set(pending.discordId, record);
    try {
      store.save(Object.fromEntries(links));
    } catch (err) {
      logError('[DISCORD] could not save links', err);
    }
    log(`[DISCORD] linked "${pending.discordName}" (${pending.discordId}) to "${record.callsign}"`
      + ` bzid=${record.bzid}${record.admin ? ' admin' : ''}`);
    const renamed = await setNickname(pending.discordId, record.callsign);
    text(res, 200, `Linked: Discord "${pending.discordName}" is BZFlag "${record.callsign}".`
      + (renamed ? ' Your nickname there is now your callsign.' : '')
      + ' You can close this and go back to Discord.');
  }

  return {
    registerMetadata,
    start,
    discordCallback,
    bzflagCallback,
    linkFor: (discordId) => links.get(discordId) || null,
    get size() { return links.size; },
  };
}

// Whether server.json's `discord` block has what Linked Roles needs.
function discordLinkConfigured(config) {
  return Boolean(config && ['applicationId', 'clientSecret', 'botToken']
    .every((key) => typeof config[key] === 'string' && config[key].length > 0));
}

module.exports = { createDiscordLink, discordLinkConfigured, ROLE_METADATA };
