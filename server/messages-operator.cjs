/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The Operator panel: maps, uploads, recordings, imports, match control and
// the server's settings. Each handler takes the player who sent the message,
// their socket and the message; acceptConnection (server.js) calls it by the
// message's `type`, through MESSAGE_HANDLERS.

const { SERVER_PLAYER } = require('./player-ids.cjs');
const fs = require('fs');
const path = require('path');
const { readReplay } = require('./bzfs-replay.cjs');
const { localized } = require('../public/js/i18n.mjs');

// What the handlers need of server.js, from `useServer`. `MAP_SOURCE`,
// `serverConfig`, `LIST_SERVER_KEY` change while the server runs, so they are
// read and written through `server` each time instead.
let server = null;
let IMPORT_REUSE_MS;
let MAP_REGISTRY;
let OPERATOR_CONFIG_KEYS;
let REPLAY_UPLOAD_MAX_BYTES;
let RUNTIME_MAPS_DIR;
let RUNTIME_REPLAYS_DIR;
let applyServerConfigChanges;
let configPath;
let endMatch;
let getRemoteServerList;
let getViewableMapsList;
let hashRemainingMapsInBackground;
let invalidateListTables;
let log;
let logError;
let parseHostPort;
let parseImportMapFileName;
let pauseMatch;
let performRemoteMapImport;
let prepareMapForView;
let recorder;
let recordingName;
let refuseNonOperator;
let registerFreshImportFromDisk;
let confirmImportUnchanged;
let replayRooms;
let replaySummaries;
let replyToPlayer;
let reportToListServer;
let requestServerRestart;
let resolveMapFilePath;
let resumeMatch;
let saveRecording;
let sendMapList;
let startMatch;
let sweepMapCache;
let uploads;
let writeServerConfig;

function useServer(deps, live) {
  server = live;
  ({
    IMPORT_REUSE_MS,
    MAP_REGISTRY,
    OPERATOR_CONFIG_KEYS,
    REPLAY_UPLOAD_MAX_BYTES,
    RUNTIME_MAPS_DIR,
    RUNTIME_REPLAYS_DIR,
    applyServerConfigChanges,
    configPath,
    endMatch,
    getRemoteServerList,
    getViewableMapsList,
    hashRemainingMapsInBackground,
    invalidateListTables,
    log,
    logError,
    parseHostPort,
    parseImportMapFileName,
    pauseMatch,
    performRemoteMapImport,
    prepareMapForView,
    recorder,
    recordingName,
    refuseNonOperator,
    registerFreshImportFromDisk,
    confirmImportUnchanged,
    replayRooms,
    replaySummaries,
    replyToPlayer,
    reportToListServer,
    requestServerRestart,
    resolveMapFilePath,
    resumeMatch,
    saveRecording,
    sendMapList,
    startMatch,
    sweepMapCache,
    uploads,
    writeServerConfig,
  } = deps);
}

function handleGetMaps(player, ws) {
  // Reply with all .bzw files in maps/ plus 'random', and indicate current map.
  // Open to every player -- browsing and the View dialog need this list, and
  // only `setMap` (switching the live match) stays operator-only below.
  sendMapList(ws);
  return;
}

function handleSetMap(player, ws, message) {
  if (refuseNonOperator(ws, player, 'setMap')) return;
  // Admin: set map
  const mapFile = typeof message.mapFile === 'string' ? message.mapFile.trim() : '';
  const safeMapFile = path.basename(mapFile);
  if (!mapFile || mapFile !== safeMapFile || (mapFile !== 'random' && !mapFile.endsWith('.bzw'))) {
    ws.send(JSON.stringify({ error: 'Invalid map file' }));
    return;
  }
  if (mapFile !== 'random') {
    const selectedMapPath = resolveMapFilePath(mapFile);
    if (!selectedMapPath) {
      ws.send(JSON.stringify({ error: 'Map file not found' }));
      return;
    }
  }
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.mapFile = mapFile;
    writeServerConfig(config);
    ws.send(JSON.stringify({ success: true }));
    log(`Admin set map to ${mapFile}. Server restart required.`);
    requestServerRestart(`admin map change to ${mapFile}`);
  } catch (error) {
    logError(`Failed to update config at ${configPath}:`, error);
    ws.send(JSON.stringify({ error: 'Failed to update config' }));
  }
  return;
}

// The Operator panel's Match Timer buttons and their XR equivalents.
// `/countdown`/`/gameover` reach the same four functions from the chat
// entry; this is the panel's front end for them.
function handleMatchControl(player, ws, message) {
  if (refuseNonOperator(ws, player, 'matchControl')) return;
  const actions = {
    start: startMatch,
    pause: pauseMatch,
    resume: resumeMatch,
    gameover: endMatch,
  };
  const run = actions[message.action];
  if (!run) {
    ws.send(JSON.stringify({ error: 'Invalid match control action' }));
    return;
  }
  if (!run()) {
    replyToPlayer(player, 'No change: check the time limit and the match state');
    return;
  }
  log(`[OPERATOR] "${player.name}" used the panel's match control: ${message.action}`);
  return;
}

// A server line on the operator's own socket; `message` is what `localized`
// returns.
function sayToOperator(ws, player, message) {
  ws.send(JSON.stringify({ type: 'message', src: SERVER_PLAYER, dst: player.id, msgType: 'server', ...message }));
}

function handleUploadMap(player, ws, message) {
  if (refuseNonOperator(ws, player, 'uploadMap')) return;
  // Admin: upload map
  const { mapName, mapContent } = message;
  const normalizedMapName = typeof mapName === 'string' ? mapName.trim() : '';
  const safeMapName = path.basename(normalizedMapName);
  if (!normalizedMapName || normalizedMapName !== safeMapName || !safeMapName.endsWith('.bzw') || !mapContent) {
    ws.send(JSON.stringify({ error: 'Invalid map upload' }));
    return;
  }
  const uploadMapPath = path.join(RUNTIME_MAPS_DIR, safeMapName);
  fs.writeFile(uploadMapPath, mapContent, err => {
    if (err) {
      logError('Map upload failed:', err);
      ws.send(JSON.stringify({ error: 'Failed to save map' }));
      return;
    }
    log(`Admin uploaded new map: ${safeMapName}`);
    uploads.add('maps', safeMapName);
    ws.send(JSON.stringify({ success: true }));
    // Send direct chat message to uploader
    sayToOperator(ws, player, localized('Upload {map} with {bytes} bytes', {
      map: safeMapName, bytes: Buffer.byteLength(mapContent, 'utf8'),
    }));
    // Send updated map list (mapList reply)
    sendMapList(ws);
    // Queue the new file for hashing so it becomes viewable (issue
    // #68) without a restart -- setMap still needs one, this doesn't.
    hashRemainingMapsInBackground();
  });
  return;
}

// A bzfs recording, base64 over the socket since it is binary. Read
// before it is kept, so a file that is not a recording is refused here
// rather than listed as unreadable.
function handleUploadReplay(player, ws, message) {
  if (refuseNonOperator(ws, player, 'uploadReplay')) return;
  const said = (message) => sayToOperator(ws, player, message);
  const name = typeof message.replayName === 'string'
    ? path.basename(message.replayName.trim()).replace(/\.rec$/i, '') : '';
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(name) || typeof message.content !== 'string') {
    said(localized('Upload refused: a replay name is letters, digits, ".", "_" and "-".'));
    return;
  }
  const bytes = Buffer.from(message.content, 'base64');
  if (bytes.length > REPLAY_UPLOAD_MAX_BYTES) {
    said(localized('Upload refused: {name} is over {megabytes} MB.', { name, megabytes: REPLAY_UPLOAD_MAX_BYTES / (1024 * 1024) }));
    return;
  }
  try {
    readReplay(bytes);
  } catch (error) {
    said(localized('Upload refused: {name} is not a bzfs recording ({error}).', { name, error: error.message }));
    return;
  }
  if (replayRooms.has(name)) {
    said(localized('Upload refused: {name} is being watched.', { name }));
    return;
  }
  fs.promises.mkdir(RUNTIME_REPLAYS_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(path.join(RUNTIME_REPLAYS_DIR, `${name}.rec`), bytes))
    .then(() => {
      uploads.add('replays', name);
      log(`Admin "${player.name}" uploaded replay ${name}.rec, ${bytes.length} bytes`);
      said(localized('Uploaded replay {name} with {bytes} bytes', { name, bytes: bytes.length }));
      invalidateListTables();
      sendMapList(ws);
    })
    .catch((error) => {
      logError('Replay upload failed:', error);
      said(localized('Upload failed: {error}', { error: error.message }));
    });
  return;
}

// The panel's Save Recording: `/record save`, answered the same way.
function handleSaveRecording(player, ws, message) {
  if (refuseNonOperator(ws, player, 'saveRecording')) return;
  const said = (message) => sayToOperator(ws, player, message);
  const name = recordingName(message.name);
  const seconds = Number.isInteger(message.seconds) && message.seconds > 0 ? message.seconds : null;
  if (!name) {
    said(localized('Save refused: a recording name is letters, digits, ".", "_" and "-".'));
    return;
  }
  if (!recorder.recording || recorder.entries.length === 0) {
    said(localized('No buffer to save'));
    return;
  }
  saveRecording(name, { seconds, callsign: player.name })
    .then(() => {
      said(localized('Record buffer saved to: {name}', { name }));
      log(`[OPERATOR] "${player.name}" saved recording ${name}`);
      sendMapList(ws);
    })
    .catch((error) => said(localized('Could not open for writing: {name} ({error})', { name, error: error.message })));
  return;
}

// What the Operator panel uploaded, and only that (`uploads`): never
// a bundled file, never the map being played, never a replay being
// watched.
function handleDeleteUpload(player, ws, message) {
  if (refuseNonOperator(ws, player, 'deleteUpload')) return;
  const said = (message) => sayToOperator(ws, player, message);
  const kind = message.kind === 'replays' ? 'replays' : (message.kind === 'maps' ? 'maps' : null);
  const name = typeof message.name === 'string' ? message.name : '';
  if (!kind || !uploads.has(kind, name)) {
    said(name
      ? localized('Delete refused: {name} was not uploaded here.', { name })
      : localized('Delete refused: that was not uploaded here.'));
    return;
  }
  if (kind === 'maps' && name === server.MAP_SOURCE) {
    said(localized('Delete refused: {name} is the map being played.', { name }));
    return;
  }
  if (kind === 'replays' && replayRooms.has(name)) {
    said(localized('Delete refused: {name} is being watched.', { name }));
    return;
  }
  const filePath = kind === 'maps'
    ? path.join(RUNTIME_MAPS_DIR, name)
    : path.join(RUNTIME_REPLAYS_DIR, `${name}.rec`);
  fs.promises.rm(filePath, { force: true })
    .then(() => {
      uploads.remove(kind, name);
      if (kind === 'maps') {
        MAP_REGISTRY.delete(name);
        sweepMapCache();
      } else {
        replaySummaries.delete(name);
      }
      invalidateListTables();
      log(`Admin "${player.name}" deleted ${kind === 'maps' ? 'map' : 'replay'} ${name}`);
      said(kind === 'maps' ? localized('Deleted map {name}', { name }) : localized('Deleted replay {name}', { name }));
      sendMapList(ws);
    })
    .catch((error) => {
      logError(`Deleting ${name} failed:`, error);
      said(localized('Delete failed: {error}', { error: error.message }));
    });
  return;
}

// The View dialog's remote-server list -- decoded entirely from the
// list server's own reply, so this never connects to any of the
// servers it names. Open to every player, same as `getMaps`: viewing
// and importing cost the requester (a fetch, a render), not the live
// match, so only `setMap` needs an operator.
function handleListRemoteServers(player, ws) {
  getRemoteServerList().then((servers) => {
    const summarized = servers
      .map((s) => ({
        host: s.host,
        port: s.port,
        title: s.title,
        style: s.info?.style ?? null,
        players: s.info?.players ?? null,
        maxPlayers: s.info?.maxPlayers ?? null,
      }))
      .sort((a, b) => (b.players ?? -1) - (a.players ?? -1));
    ws.send(JSON.stringify({ type: 'remoteServerList', servers: summarized }));
  }).catch((error) => {
    logError('Fetching the remote server list failed:', error);
    ws.send(JSON.stringify({ error: 'Could not reach the BZFlag list server' }));
  });
  return;
}

// Downloads a live BZFlag server's world over the real wire protocol
// (see server/remote-world-import.cjs) and saves it as an ordinary
// .bzw -- one step, same as `uploadMap`. Open to every player, but
// `performRemoteMapImport` fetches only from an exact host:port in
// the public list. It costs this server one fetch and one file (capped by
// MAX_WORLD_DATABASE_BYTES in remote-world-import.cjs), not the live
// match, so there is nothing here that needs an operator. It does not
// touch the live match or select the new file anywhere -- switching
// the match to it is still `setMap`, still operator-only.
// `performRemoteMapImport` hashes the file synchronously, so it is
// viewable the moment this reply arrives, not after a background
// trickle or a reload.
function handleImportMap(player, ws, message) {
  const target = parseHostPort(message.hostPort);
  if (!target) {
    ws.send(JSON.stringify({ error: 'Expected host:port' }));
    return;
  }
  const { host, port } = target;
  log(`"${player.name}" is importing a remote map from ${host}:${port}`);
  performRemoteMapImport(host, port).then(({ safeMapName, byteLength, reused }) => {
    log(reused
      ? `"${player.name}" reused the cached copy of ${host}:${port}, ${safeMapName} (${byteLength} bytes)`
      : `"${player.name}" imported remote map ${host}:${port} as ${safeMapName} (${byteLength} bytes)`);
    ws.send(JSON.stringify({ type: 'importMapResult', success: true, file: safeMapName }));
    const params = { server: `${host}:${port}`, map: safeMapName, bytes: byteLength };
    if (reused) {
      replyToPlayer(player,
        '{server} is no longer in the public list, so {map} is the copy already here ({bytes} bytes). It is ready to View now.',
        params);
    } else {
      replyToPlayer(player, 'Imported {map} from {server} ({bytes} bytes). It is ready to View now.', params);
    }
    sendMapList(ws);
  }).catch((error) => {
    logError(`Remote map import from ${host}:${port} failed:`, error);
    ws.send(JSON.stringify({ error: `Import failed: ${error.message}` }));
  });
  return;
}

// A `?viewmap=` link's own answer to "the file it named isn't
// registered": the name is `import-<host>_<port>.bzw`
// (`remoteMapFileName`), so it still says which server to ask even
// once bzo has let its cached copy go, or never fetched it in this
// process at all. Reused rather than re-fetched inside
// `IMPORT_REUSE_MS` of its last import -- the same server's world is
// not worth downloading twice in the same sitting -- otherwise this
// is `performRemoteMapImport` again, including its public-list check
// -- which an unlisted server's own already-cached file satisfies,
// so a link outlives the target leaving the list, not just bzo's
// reuse window -- just triggered by a link instead of a click.
function handleImportMapForView(player, ws, message) {
  const file = typeof message.file === 'string' ? message.file : '';
  // `reason`, not `error`: a bare top-level `error` string is the
  // generic admin-response shortcut (handleServerMessage's own
  // "Some admin/operator responses are sent without a message type"
  // check) and would short-circuit past `type` entirely, so this
  // reply would never reach `handleImportMapForViewResult` and the
  // client's pending join would wait forever.
  const reply = (success, extra = {}) => {
    ws.send(JSON.stringify({ type: 'importMapForViewResult', file, success, ...extra }));
  };
  const target = parseImportMapFileName(file);
  if (!target) {
    // One of this server's own maps: the same request and the same
    // reply, with the conversion standing where the download would.
    prepareMapForView(file).then((prepared) => {
      if (prepared) reply(true, { viewableMaps: getViewableMapsList() });
      else reply(false, { reason: 'no such map' });
    });
    return;
  }
  const { host, port } = target;
  const existing = MAP_REGISTRY.get(file);
  if (existing && (Date.now() - existing.registeredAt) < IMPORT_REUSE_MS) {
    reply(true, { viewableMaps: getViewableMapsList() });
    return;
  }
  // Not parsed at boot (`listLocalMapFiles`), but a copy fetched inside
  // the reuse window is still on disk: read it back rather than
  // download the same world again. Older than that, a copy whose server
  // still reports the same world hash is kept too.
  const kept = existing ? Promise.resolve(false) : registerFreshImportFromDisk(file);
  kept
    .then((fromDisk) => fromDisk || confirmImportUnchanged(file, host, port).then((same) => {
      if (same) log(`Viewmap link kept the cached copy of ${host}:${port}: its world hash is unchanged`);
      return same;
    }))
    .then((reusable) => {
      if (reusable) {
        reply(true, { viewableMaps: getViewableMapsList() });
        return null;
      }
      log(`A viewmap link is importing a remote map from ${host}:${port}`);
      return performRemoteMapImport(host, port).then(({ safeMapName, byteLength, reused }) => {
        log(reused
          ? `Viewmap link reused the cached copy of ${host}:${port}, ${safeMapName} (${byteLength} bytes)`
          : `Viewmap link imported remote map ${host}:${port} as ${safeMapName} (${byteLength} bytes)`);
        reply(true, { viewableMaps: getViewableMapsList() });
      });
    })
    .catch((error) => {
      logError(`Remote map import from ${host}:${port} for a viewmap link failed:`, error);
      reply(false, { reason: error.message });
    });
  return;
}

function handleSetOperatorConfig(player, ws, message) {
  if (refuseNonOperator(ws, player, 'setOperatorConfig')) return;
  const requested = {};
  for (const key of OPERATOR_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(message, key)) requested[key] = message[key];
  }
  // The Plugins rows, one `plugin:<id>` each; the server checks the id.
  for (const key of Object.keys(message)) {
    if (key.startsWith('plugin:')) requested[key] = message[key];
  }
  if (Object.keys(requested).length === 0) {
    ws.send(JSON.stringify({ error: 'No supported operator setting provided' }));
    return;
  }
  const outcome = applyServerConfigChanges(requested, `operator "${player.name}"`);
  if (outcome.error) {
    ws.send(JSON.stringify({ error: outcome.error }));
    return;
  }
  // Nothing to send after a restart: the clients are already reloading,
  // and a map list for a world that is going away is noise.
  if (!outcome.restarted) sendMapList(ws);
  ws.send(JSON.stringify({ success: true, restarted: Boolean(outcome.restarted) }));
  return;
}

// Deliberately not part of `setOperatorConfig`/`OPERATOR_CONFIG_KEYS`:
// that state rides in `init.operatorConfig`, sent to every connecting
// player (see getOperatorConfigState), and this server's own list
// server credential must never reach a client that is not this
// operator. Applied live -- "no restart, no new auth surface" -- and
// only ever echoed back as whether a key is now configured, never the
// value itself.
function handleSetListServerKey(player, ws, message) {
  if (refuseNonOperator(ws, player, 'setListServerKey')) return;
  const key = typeof message.key === 'string' ? message.key.trim() : '';
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.listServerKey = key;
    writeServerConfig(config);
  } catch (error) {
    logError(`Failed to update config at ${configPath}:`, error);
    ws.send(JSON.stringify({ error: 'Failed to update config' }));
    return;
  }
  server.LIST_SERVER_KEY = key;
  server.serverConfig.listServerKey = key;
  log(`[LISTSERVER] key ${key ? 'configured' : 'cleared'} by operator "${player.name}"`);
  if (key) reportToListServer('boot');
  ws.send(JSON.stringify({ success: true, listServerKeyConfigured: Boolean(key) }));
  return;
}

const MESSAGE_HANDLERS = Object.freeze({
  getMaps: handleGetMaps,
  setMap: handleSetMap,
  matchControl: handleMatchControl,
  uploadMap: handleUploadMap,
  uploadReplay: handleUploadReplay,
  saveRecording: handleSaveRecording,
  deleteUpload: handleDeleteUpload,
  listRemoteServers: handleListRemoteServers,
  importMap: handleImportMap,
  importMapForView: handleImportMapForView,
  setOperatorConfig: handleSetOperatorConfig,
  setListServerKey: handleSetListServerKey,
});

module.exports = { useServer, MESSAGE_HANDLERS };
