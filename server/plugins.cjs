/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// plugins.cjs - server plugins in JavaScript, shaped as bzfs's are
// (include/bzfsAPI.h) so a C++ plugin ports line for line; docs/plugins-plan.md.
//
// A plugin is one `.cjs` file exporting upstream's bz_Plugin methods and a
// `meta` that says what it is:
//
//   module.exports = {
//     meta: { name, version, author, description, license },
//     Init(bz, config) { bz.Register(bz.bz_ePlayerJoinEvent); },
//     Event(data) { if (data.eventType === 'bz_ePlayerJoinEvent') ... },
//     Cleanup() {},
//   };
//
// `bz` is the API, one per plugin, so what a plugin registers is taken away
// with it. `config` is the plugin's options from `server.json`, an object
// where upstream passes the `-loadplugin` string.
//
// Plugins run in-process and are trusted as bzfs trusts a `.so`; a worker could
// not answer the events that need a reply before the server goes on. What this
// module does guard against is a plugin that throws: it is logged and the
// server carries on.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// bz_eEventType (bzfsAPI.h:273), by upstream's names and in its order;
// `bz_eAuthenticatonComplete` is upstream's spelling.
const EVENT_TYPES = Object.freeze([
  'bz_eNullEvent', 'bz_eCaptureEvent', 'bz_ePlayerDieEvent',
  'bz_ePlayerSpawnEvent', 'bz_eZoneEntryEvent', 'bz_eZoneExitEvent',
  'bz_ePlayerJoinEvent', 'bz_ePlayerPartEvent', 'bz_eRawChatMessageEvent',
  'bz_eFilteredChatMessageEvent', 'bz_eUnknownSlashCommand',
  'bz_eGetPlayerSpawnPosEvent', 'bz_eGetAutoTeamEvent', 'bz_eAllowPlayer',
  'bz_eTickEvent', 'bz_eGetWorldEvent', 'bz_eGetPlayerInfoEvent', 'bz_eAllowSpawn',
  'bz_eListServerUpdateEvent', 'bz_eBanEvent', 'bz_eHostBanModifyEvent',
  'bz_eKickEvent', 'bz_eKillEvent', 'bz_ePlayerPausedEvent',
  'bz_eMessageFilteredEvent', 'bz_eGamePauseEvent', 'bz_eGameResumeEvent',
  'bz_eGameStartEvent', 'bz_eGameEndEvent', 'bz_eSlashCommandEvent',
  'bz_ePlayerAuthEvent', 'bz_eServerMsgEvent', 'bz_eShotFiredEvent',
  'bz_ePlayerUpdateEvent', 'bz_eNetDataSendEvent', 'bz_eNetDataReceiveEvent',
  'bz_eLoggingEvent', 'bz_eShotEndedEvent', 'bz_eFlagTransferredEvent',
  'bz_eFlagGrabbedEvent', 'bz_eFlagDroppedEvent', 'bz_eAllowCTFCaptureEvent',
  'bz_eMsgDebugEvent', 'bz_eNewNonPlayerConnection', 'bz_ePluginLoaded',
  'bz_ePluginUnloaded', 'bz_ePlayerScoreChanged', 'bz_eTeamScoreChanged',
  'bz_eWorldFinalized', 'bz_eReportFiledEvent', 'bz_eBZDBChange',
  'bz_eGetPlayerMotto', 'bz_eAllowConnection', 'bz_eAllowFlagGrab',
  'bz_eAuthenticatonComplete', 'bz_eServerAddPlayer', 'bz_eAllowPollEvent',
  'bz_ePollStartEvent', 'bz_ePollVoteEvent', 'bz_ePollVetoEvent',
  'bz_ePollEndEvent', 'bz_eComputeHandicapEvent', 'bz_eBeginHandicapRefreshEvent',
  'bz_eEndHandicapRefreshEvent', 'bz_eAutoPilotEvent', 'bz_eMuteEvent',
  'bz_eUnmuteEvent', 'bz_eServerShotFiredEvent', 'bz_ePermissionModificationEvent',
  'bz_eAllowServerShotFiredEvent', 'bz_ePlayerDeathFinalizedEvent',
]);
const EVENT_SET = new Set(EVENT_TYPES);

const META_FIELDS = Object.freeze(['name', 'version', 'author', 'description']);

// What a file needs before it is loaded at all.
function checkPlugin(plugin) {
  if (!plugin || typeof plugin !== 'object') return 'exports nothing';
  const meta = plugin.meta;
  if (!meta || typeof meta !== 'object') return 'has no meta';
  const missing = META_FIELDS.filter((field) => typeof meta[field] !== 'string' || !meta[field].trim());
  if (missing.length > 0) return `meta has no ${missing.join(', ')}`;
  if (typeof plugin.Init !== 'function') return 'has no Init';
  return null;
}

// `server.json`'s `plugins`: a plugin's id to `false` (off), `true` (on), or
// an object of its options (on). A plugin it does not name is on.
function pluginSetting(settings, id) {
  const value = settings && Object.hasOwn(settings, id) ? settings[id] : true;
  if (value === false) return { enabled: false, config: {} };
  if (value && typeof value === 'object') {
    const { enabled = true, ...config } = value;
    return { enabled: enabled !== false, config };
  }
  return { enabled: true, config: {} };
}

// The plugin files in `dirs`, the bundled directory first, by id. A later
// directory's file wins over an earlier one's, so an installed plugin can
// replace a bundled one; `replaces` names the file it hides, whose upgrades
// then never load.
function findPlugins(dirs) {
  const found = new Map();
  dirs.forEach((dir, index) => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.cjs')) continue;
      const id = name.slice(0, -'.cjs'.length);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
      const replaces = found.get(id)?.file || null;
      found.set(id, { id, file: path.join(dir, name), bundled: index === 0, replaces });
    }
  });
  return found;
}

function createPluginHost({
  dirs, settings = {}, api = {}, log = () => {}, timers = globalThis,
} = {}) {
  const entries = new Map(); // id -> { id, file, bundled, meta, state, error, plugin, events, ... }
  const listeners = new Map(); // event type -> Set of entries
  const slashCommands = new Map(); // command, lowercase, no slash -> { entry, handler }

  function report(entry, what, error) {
    log(`${entry.id}: ${what}: ${error?.stack || error}`);
  }

  function makeApi(entry) {
    const bz = Object.create(api);
    for (const type of EVENT_TYPES) bz[type] = type;
    bz.Register = (type) => {
      if (!EVENT_SET.has(type)) throw new Error(`unknown event ${type}`);
      entry.events.add(type);
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(entry);
      return true;
    };
    bz.Remove = (type) => {
      entry.events.delete(type);
      listeners.get(type)?.delete(entry);
      if (listeners.get(type)?.size === 0) listeners.delete(type);
      return true;
    };
    // bz_registerCustomSlashCommand (bzfsAPI.cxx:2648). A handler is upstream's
    // object with SlashCommand(playerID, channel, command, message, params), or
    // that function alone; it returns true when it handled the line.
    //
    // `options` is bzo's: `help`, the line `/help` shows after the name, and
    // `operator`, true for a command only admins may run. Upstream has neither;
    // its `/help` never lists a plugin's commands, and a plugin checks
    // permissions itself.
    bz.bz_registerCustomSlashCommand = (command, handler, options = {}) => {
      const name = String(command || '').replace(/^\//, '').toLowerCase();
      const run = typeof handler === 'function' ? handler : handler?.SlashCommand?.bind(handler);
      if (!name || typeof run !== 'function') return false;
      slashCommands.set(name, {
        entry,
        run,
        help: typeof options.help === 'string' ? options.help : '',
        operator: options.operator === true,
      });
      entry.commands.add(name);
      return true;
    };
    bz.bz_removeCustomSlashCommand = (command) => {
      const name = String(command || '').replace(/^\//, '').toLowerCase();
      if (slashCommands.get(name)?.entry !== entry) return false;
      slashCommands.delete(name);
      entry.commands.delete(name);
      return true;
    };
    // Not upstream's, whose plugins count ticks. Cleared when the plugin is.
    bz.setTimeout = (fn, ms, ...args) => track(entry, timers.setTimeout(guarded(entry, 'timer', fn), ms, ...args));
    bz.setInterval = (fn, ms, ...args) => track(entry, timers.setInterval(guarded(entry, 'timer', fn), ms, ...args));
    bz.clearTimer = (handle) => {
      entry.timers.delete(handle);
      timers.clearTimeout(handle);
      timers.clearInterval(handle);
    };
    bz.log = (text) => log(`${entry.id}: ${text}`);
    return bz;
  }

  function track(entry, handle) {
    handle?.unref?.();
    entry.timers.add(handle);
    return handle;
  }

  function guarded(entry, what, fn) {
    return (...args) => {
      try {
        return fn(...args);
      } catch (error) {
        report(entry, what, error);
        return undefined;
      }
    };
  }

  function forget(entry) {
    for (const type of entry.events) {
      listeners.get(type)?.delete(entry);
      if (listeners.get(type)?.size === 0) listeners.delete(type);
    }
    entry.events.clear();
    for (const name of entry.commands) {
      if (slashCommands.get(name)?.entry === entry) slashCommands.delete(name);
    }
    entry.commands.clear();
    for (const handle of entry.timers) {
      timers.clearTimeout(handle);
      timers.clearInterval(handle);
    }
    entry.timers.clear();
  }

  function load(id) {
    const entry = entries.get(id);
    if (!entry || entry.state === 'loaded') return entry || null;
    const setting = pluginSetting(settings, id);
    entry.error = null;
    let plugin;
    try {
      delete require.cache[require.resolve(entry.file)];
      plugin = require(entry.file);
    } catch (error) {
      entry.state = 'failed';
      entry.error = String(error?.message || error);
      report(entry, 'load', error);
      return entry;
    }
    const problem = checkPlugin(plugin);
    if (problem) {
      entry.state = 'failed';
      entry.error = problem;
      log(`${id}: not loaded, ${problem}`);
      return entry;
    }
    entry.meta = { license: '', ...plugin.meta };
    entry.plugin = plugin;
    try {
      plugin.Init(makeApi(entry), setting.config);
    } catch (error) {
      forget(entry);
      entry.plugin = null;
      entry.state = 'failed';
      entry.error = String(error?.message || error);
      report(entry, 'Init', error);
      return entry;
    }
    entry.state = 'loaded';
    log(`${id} ${entry.meta.version} loaded`);
    return entry;
  }

  function unload(id) {
    const entry = entries.get(id);
    if (!entry || entry.state !== 'loaded') return false;
    try {
      entry.plugin.Cleanup?.();
    } catch (error) {
      report(entry, 'Cleanup', error);
    }
    forget(entry);
    entry.plugin = null;
    entry.state = 'off';
    log(`${id} unloaded`);
    return true;
  }

  // Every plugin file in `dirs`, each loaded unless `server.json` turns it off.
  function loadAll() {
    for (const found of findPlugins(dirs).values()) {
      if (entries.get(found.id)?.state === 'loaded') continue;
      const entry = {
        ...found, meta: null, state: 'off', error: null, plugin: null,
        events: new Set(), commands: new Set(), timers: new Set(),
      };
      entries.set(found.id, entry);
      if (found.replaces) log(`${found.id}: ${found.file} replaces ${found.replaces}`);
      if (pluginSetting(settings, found.id).enabled) load(found.id);
    }
  }

  // Whether any plugin registered for `type`: a call site asks first, so an
  // event nobody listens to costs nothing to build.
  function listening(type) {
    return listeners.has(type);
  }

  // worldEventManager.callEvents: each plugin registered for the event, in the
  // order they loaded, gets the same data, so what one changes the next sees
  // and the caller reads back.
  function callEvents(type, data = {}) {
    const registered = listeners.get(type);
    data.eventType = type;
    if (!registered) return data;
    for (const entry of [...registered]) {
      try {
        entry.plugin.Event?.(data);
      } catch (error) {
        report(entry, type, error);
      }
    }
    return data;
  }

  // parseServerCommand's custom-command step (commands.cxx:3903): a plugin's
  // command is tried before the built-in one of the same name, and a handler
  // that returns false passes the line on to it.
  function slashCommand(playerID, channel, text) {
    const params = String(text || '').slice(1).split(' ').filter(Boolean);
    if (params.length === 0) return false;
    const found = slashCommands.get(params[0].toLowerCase());
    if (!found) return false;
    const command = params[0];
    const rest = String(text).slice(1);
    const message = rest.length > command.length ? rest.slice(command.length + 1) : '';
    try {
      return Boolean(found.run(playerID, channel, command, message, params.slice(1)));
    } catch (error) {
      report(found.entry, `/${command}`, error);
      return true;
    }
  }

  function list() {
    return [...entries.values()].map(({ id, file, bundled, replaces, meta, state, error }) => ({
      id, file, bundled, replaces, meta, state, error,
    }));
  }

  // The loaded plugins' commands, for `/?`, `/help` and the chat entry's Tab.
  function commands() {
    return [...slashCommands].map(([name, { entry, help, operator }]) => ({
      name: `/${name}`, help, operator, plugin: entry.id,
    }));
  }

  return { loadAll, load, unload, listening, callEvents, slashCommand, commands, list };
}

module.exports = { EVENT_TYPES, checkPlugin, createPluginHost, findPlugins, pluginSetting };
