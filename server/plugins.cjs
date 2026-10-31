/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// plugins.cjs - server plugins in JavaScript, shaped as bzfs's are
// (include/bzfsAPI.h) so a C++ plugin ports line for line; docs/plugins-plan.md.
//
// A plugin is one `.cjs` file exporting upstream's bz_Plugin methods, a
// `meta` that says what it is, and the translations of what it says:
//
//   module.exports = {
//     meta: { name, version, author, description, license },
//     Init(bz, config) { bz.Register(bz.bz_ePlayerJoinEvent); },
//     Event(data) { if (data.eventType === 'bz_ePlayerJoinEvent') ... },
//     Cleanup() {},
//     l10n: { de: { 'Hello, {player}': 'Hallo, {player}' } },
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

// How often bz_eTickEvent fires while a plugin listens for it. Upstream's comes
// once per pass of bzfs's main loop, whose wait a plugin may shorten
// (`MaxWaitTime`); bzo has no such loop, and a tenth of a second is what bzfs's
// own timers are written against. Nothing runs while nobody listens.
const TICK_MS = 100;

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
// an object of its options (on). A plugin it does not name is on, unless its
// own `meta.enabled` is false -- a sample, which upstream ships but no server
// loads until asked -- and then `fallback` is false.
function pluginSetting(settings, id, fallback = true) {
  const value = settings && Object.hasOwn(settings, id) ? settings[id] : fallback;
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

// The blocks of one custom object in a map's text, as upstream's BZWReader
// collects them for a plugin's MapObject: from a line whose first word is
// `name`, in any case, to its `end`, each line trimmed and stripped of a
// comment. `name` comes back upper case, as upstream's does.
function scanCustomMapObjects(text, name) {
  const wanted = String(name).toLowerCase();
  if (!wanted) return [];
  const blocks = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const first = line.split(/\s+/)[0].toLowerCase();
    if (current) {
      if (first === 'end') {
        blocks.push(current);
        current = null;
      } else {
        current.data.push(line);
      }
    } else if (first === wanted) {
      current = { name: String(name).toUpperCase(), data: [] };
    }
  }
  return blocks;
}

// bz_CustomZoneObject (bzfsAPI.cxx:3107): a box or a cylinder read from a
// custom object's lines -- `position`, `size`, `rotation`, `radius`,
// `height`, or the older `bbox` and `cylinder` -- and whether a point is in
// it.
class CustomZoneObject {
  constructor() {
    this.box = false;
    this.xMax = 0; this.xMin = 0; this.yMax = 0; this.yMin = 0; this.zMax = 0; this.zMin = 0;
    this.radius = 0; this.rotation = 0;
    this.cX = 0; this.cY = 0; this.hh = 0; this.hw = 0;
    this.sinVal = 0; this.cosVal = 1;
  }

  handleDefaultOptions(info) {
    let deprecated = false;
    const pos = [0, 0, 0];
    const size = [5, 5, 5];
    let radius = 5;
    let height = 5;
    let rotation = 0;
    for (const line of info?.data ?? []) {
      const nubs = String(line).trim().split(/\s+/);
      if (nubs.length < 2) continue;
      const key = nubs[0].toUpperCase();
      const n = (i) => Number.parseFloat(nubs[i]) || 0;
      if (key === 'BBOX' && nubs.length > 6) {
        this.box = true;
        deprecated = true;
        [this.xMin, this.xMax, this.yMin, this.yMax, this.zMin, this.zMax] = [n(1), n(2), n(3), n(4), n(5), n(6)];
        this.cX = (this.xMax + this.xMin) / 2;
        this.cY = (this.yMax + this.yMin) / 2;
        this.hh = Math.abs(this.yMax - this.yMin) / 2;
        this.hw = Math.abs(this.xMax - this.xMin) / 2;
      } else if (key === 'CYLINDER' && nubs.length > 5) {
        this.box = false;
        deprecated = true;
        [this.xMax, this.yMax, this.zMin, this.zMax, this.radius] = [n(1), n(2), n(3), n(4), n(5)];
        this.cX = this.xMax;
        this.cY = this.yMax;
      } else if ((key === 'POSITION' || key === 'POS') && nubs.length > 3) {
        [pos[0], pos[1], pos[2]] = [n(1), n(2), n(3)];
        this.cX = pos[0];
        this.cY = pos[1];
      } else if (key === 'SIZE' && nubs.length > 3) {
        this.box = true;
        [size[0], size[1], size[2]] = [n(1), n(2), n(3)];
        this.hw = size[0];
        this.hh = size[1];
      } else if (key === 'ROTATION' || key === 'ROT') {
        rotation = n(1);
        this.cosVal = Math.cos(rotation * Math.PI / 180);
        this.sinVal = Math.sin(rotation * Math.PI / 180);
      } else if (key === 'RADIUS' || key === 'RAD') {
        this.box = false;
        radius = n(1);
      } else if (key === 'HEIGHT') {
        height = n(1);
      }
    }
    if (deprecated) return;
    if (this.box) {
      this.xMin = pos[0] - size[0];
      this.xMax = pos[0] + size[0];
      this.yMin = pos[1] - size[1];
      this.yMax = pos[1] + size[1];
      this.zMin = pos[2];
      this.zMax = pos[2] + size[2];
      this.rotation = rotation > 0 && rotation < 360 ? rotation : 0;
    } else {
      this.radius = radius;
      this.xMax = pos[0];
      this.yMax = pos[1];
      this.zMin = pos[2];
      this.zMax = pos[2] + height;
    }
  }

  pointInZone(pos) {
    let px = pos[0] - this.cX;
    let py = pos[1] - this.cY;
    if (this.box) {
      if (this.rotation === 90 || this.rotation === 270) {
        [px, py] = [py, px];
      } else if (this.rotation !== 0 && this.rotation !== 180) {
        const rx = px * this.cosVal + py * this.sinVal;
        const ry = -px * this.sinVal + py * this.cosVal;
        px = rx;
        py = ry;
      }
      if (Math.abs(px) > this.hw || Math.abs(py) > this.hh) return false;
    } else if (px * px + py * py > this.radius * this.radius) {
      return false;
    }
    return !(pos[2] > this.zMax || pos[2] < this.zMin);
  }
}


function createPluginHost({
  dirs, settings = {}, api = {}, log = () => {}, timers = globalThis,
} = {}) {
  // `settings` may be a function, so `server.json`'s "plugins" is read as it
  // is now rather than as it was at boot.
  const currentSettings = typeof settings === 'function' ? settings : () => settings;
  const entries = new Map(); // id -> { id, file, bundled, meta, state, error, plugin, events, ... }
  const listeners = new Map(); // event type -> Set of entries
  const slashCommands = new Map(); // command, lowercase, no slash -> { entry, handler }
  let tickTimer = null;

  function syncTick() {
    const wanted = listeners.has('bz_eTickEvent');
    if (wanted && !tickTimer) {
      tickTimer = timers.setInterval(() => callEvents('bz_eTickEvent', { eventTime: Date.now() / 1000 }), TICK_MS);
      tickTimer?.unref?.();
    } else if (!wanted && tickTimer) {
      timers.clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function report(entry, what, error) {
    log(`${entry.id}: ${what}: ${error?.stack || error}`);
  }

  function makeApi(entry) {
    // A copy, since the server's API is frozen and each plugin's own `bz`
    // replaces some of its names.
    const bz = { ...api };
    for (const type of EVENT_TYPES) bz[type] = type;
    bz.Register = (type) => {
      if (!EVENT_SET.has(type)) throw new Error(`unknown event ${type}`);
      entry.events.add(type);
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(entry);
      syncTick();
      return true;
    };
    bz.Remove = (type) => {
      entry.events.delete(type);
      listeners.get(type)?.delete(entry);
      if (listeners.get(type)?.size === 0) listeners.delete(type);
      syncTick();
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
    // A plugin's BZDB variables go when it does, as upstream plugins remove
    // theirs in Cleanup (bz_removeCustomBZDBVariable).
    for (const kind of ['Double', 'Int', 'Bool', 'String']) {
      const register = api[`bz_registerCustomBZDB${kind}`];
      if (typeof register !== 'function') continue;
      bz[`bz_registerCustomBZDB${kind}`] = (name, ...rest) => {
        const done = register(name, ...rest);
        if (done) entry.bzdb.add(name);
        return done;
      };
    }
    // bz_registerCustomMapObject (bzfsAPI.h:2030). Upstream's reader hands a
    // plugin each block of its object as it reads the map, so a plugin
    // registers in Init; bzo has the map already, and hands them over here.
    // A handler is upstream's object with MapObject(name, data), or that
    // function alone; `data.data` is the block's lines.
    bz.bz_registerCustomMapObject = (name, handler) => {
      const run = typeof handler === 'function' ? handler : handler?.MapObject?.bind(handler);
      if (!name || typeof run !== 'function') return false;
      for (const block of api.bz_customMapObjects?.(name) ?? []) run(block.name, block);
      return true;
    };
    // Nothing to take back: the map is read once.
    bz.bz_removeCustomMapObject = () => true;
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
    syncTick();
    for (const name of entry.commands) {
      if (slashCommands.get(name)?.entry === entry) slashCommands.delete(name);
    }
    entry.commands.clear();
    for (const handle of entry.timers) {
      timers.clearTimeout(handle);
      timers.clearInterval(handle);
    }
    entry.timers.clear();
    for (const name of entry.bzdb) api.bz_removeCustomBZDBVariable?.(name);
    entry.bzdb.clear();
  }

  // `ifEnabled` leaves a plugin `server.json` or its own meta turns off read
  // but not started, so its meta is still there to list. `config` is the
  // options to start it with, in place of `server.json`'s.
  function load(id, { ifEnabled = false, config } = {}) {
    const entry = entries.get(id);
    if (!entry || entry.state === 'loaded') return entry || null;
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
    const setting = pluginSetting(currentSettings(), id, plugin.meta.enabled !== false);
    if (ifEnabled && !setting.enabled) {
      entry.state = 'off';
      return entry;
    }
    entry.plugin = plugin;
    try {
      plugin.Init(makeApi(entry), config ?? setting.config);
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

  // The plugin files in `dirs` now, so one added since boot can be loaded.
  // Returns the ones not seen before.
  function discover() {
    const added = [];
    for (const found of findPlugins(dirs).values()) {
      if (entries.get(found.id)?.state === 'loaded') continue;
      if (entries.get(found.id)?.file === found.file) continue;
      entries.set(found.id, {
        ...found, meta: null, state: 'off', error: null, plugin: null,
        events: new Set(), commands: new Set(), timers: new Set(), bzdb: new Set(),
      });
      if (found.replaces) log(`${found.id}: ${found.file} replaces ${found.replaces}`);
      added.push(found.id);
    }
    return added;
  }

  // Every plugin file in `dirs`, each loaded unless `server.json` or its meta
  // turns it off.
  function loadAll() {
    for (const id of discover()) {
      if (pluginSetting(currentSettings(), id).enabled) load(id, { ifEnabled: true });
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
    // bz_EventData's own field: when the event happened, in seconds.
    data.eventTime ??= Date.now() / 1000;
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

  // The loaded plugins' translations for one locale, from each one's `l10n`
  // object (`{ locale: { msgid: msgstr } }`), in load order: a plugin carries
  // its own, so they are there while it runs and nowhere else.
  function messages(locale) {
    const merged = {};
    for (const entry of entries.values()) {
      if (entry.state !== 'loaded') continue;
      const strings = entry.plugin.l10n?.[locale];
      if (!strings || typeof strings !== 'object') continue;
      for (const [msgid, msgstr] of Object.entries(strings)) {
        if (typeof msgstr === 'string' && msgstr && !(msgid in merged)) merged[msgid] = msgstr;
      }
    }
    return merged;
  }

  // The loaded plugins' commands, for `/?`, `/help` and the chat entry's Tab.
  function commands() {
    return [...slashCommands].map(([name, { entry, help, operator }]) => ({
      name: `/${name}`, help, operator, plugin: entry.id,
    }));
  }

  return { discover, loadAll, load, unload, listening, callEvents, slashCommand, commands, messages, list };
}

module.exports = {
  CustomZoneObject, EVENT_TYPES, checkPlugin, createPluginHost, findPlugins, pluginSetting, scanCustomMapObjects,
};
