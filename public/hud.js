/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// hud.js - Handles HUD and debug display logic

import { normalizeShotSlotCount } from './shots.mjs';
import { PLAYER_TEAM_LABELS, getPlayerTeamColor, isColorTeam, isObserverTeam } from './teams.mjs';

const degreeBarRenderState = {
  canvas: null,
  controlBox: null,
  width: 0,
  height: 0,
  dpr: 0,
  topPx: null,
  centerDegKey: null,
  colorKey: ''
};

const altimeterRenderState = {
  canvas: null,
  controlBox: null,
  width: 0,
  height: 0,
  dpr: 0,
  tankYKey: null,
  colorKey: ''
};

const shotStatusRenderState = {
  canvas: null,
  controlBox: null,
  width: 0,
  height: 0,
  dpr: 0,
  topPx: null,
  leftPx: null,
  stateKey: '',
  colorKey: ''
};

function getHudCanvasContext(cache, canvasId, controlBoxId = 'controlBox') {
  if (!cache.canvas) {
    cache.canvas = document.getElementById(canvasId);
  }
  if (!cache.controlBox) {
    cache.controlBox = document.getElementById(controlBoxId);
  }
  if (!cache.canvas) {
    return null;
  }
  return {
    canvas: cache.canvas,
    controlBox: cache.controlBox,
    ctx: cache.canvas.getContext('2d')
  };
}

function resizeHudCanvasIfNeeded(cache, canvas, width, height, dpr) {
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  const resized = cache.width !== width || cache.height !== height || cache.dpr !== dpr ||
    canvas.width !== pixelWidth || canvas.height !== pixelHeight;
  if (resized) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    cache.width = width;
    cache.height = height;
    cache.dpr = dpr;
  }
  return resized;
}

// Converts a color int or string to a CSS color string
// Trim a string to what fits `maxWidth` in the context's current font, with an
// ellipsis when anything was taken off. Both canvas HUDs -- the XR settings menu
// and the XR chat panel -- lay text out in pixels rather than in characters, so
// neither has to guess how wide a character is.
export function fitText(context, text, maxWidth) {
  const source = String(text || '');
  if (context.measureText(source).width <= maxWidth) return source;
  let result = source;
  while (result.length > 1 && context.measureText(`${result}...`).width > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}...`;
}

export function colorToCSS(color) {
  if (typeof color === 'string') return color;
  if (typeof color === 'number') return `#${color.toString(16).padStart(6, '0')}`;
  if (color && typeof color.getHexString === 'function') return `#${color.getHexString()}`;
  return '#888';
}

// Trace a rounded rectangle as the current path. Every 2D panel bzo paints --
// HUD, XR overlay, XR menu -- draws its background this way.
export function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

// Toggle debug labels over objects
export function toggleDebugLabels({ debugLabelsEnabled, setDebugLabelsEnabled, updateHudButtons, showMessage }) {
  setDebugLabelsEnabled(!debugLabelsEnabled);
  localStorage.setItem('debugLabelsEnabled', (!debugLabelsEnabled).toString());
  updateHudButtons();
  showMessage(`Debug Labels: ${!debugLabelsEnabled ? 'ON' : 'OFF'}`);
}
// Set button active/inactive and update title
export function setActive(btn, active, activeTitle, inactiveTitle) {
  if (!btn) return;
  if (active) {
    btn.classList.add('active');
    if (activeTitle) btn.title = activeTitle;
  } else {
    btn.classList.remove('active');
    if (inactiveTitle) btn.title = inactiveTitle;
  }
}

// Read a persisted on/off HUD preference.
export function readStoredFlag(key, fallback = false) {
  const saved = localStorage.getItem(key);
  return saved === null ? fallback : saved === 'true';
}

// Wire a HUD toggle button to a value it does not own: read it, flip it on
// click, persist it when the caller names a storage key, and keep the class and
// title in step. `available` is re-read on every refresh, so a gate that changes
// during play -- entering VR -- lands without a second listener; the returned
// refresh is what such a listener calls. A button whose gate is closed goes
// dead rather than promising what the context cannot do.
export function bindToggleButton(btn, {
  get,
  set,
  onTitle,
  offTitle,
  storageKey = null,
  available = () => true,
  unavailableTitle = '',
  forceOffWhenUnavailable = false,
  onChange = null,
}) {
  if (!btn) return () => {};

  const refresh = () => {
    const usable = available();
    if (!usable && forceOffWhenUnavailable && get()) set(false);
    btn.disabled = !usable;
    setActive(btn, get());
    btn.title = usable ? (get() ? onTitle : offTitle) : unavailableTitle;
  };

  btn.addEventListener('click', () => {
    if (!available()) return;
    const next = !get();
    set(next);
    if (storageKey) localStorage.setItem(storageKey, next.toString());
    if (onChange) onChange(next);
    refresh();
  });

  refresh();
  return refresh;
}

// HUDRenderer::setAlert and renderAlerts (HUDRenderer.cxx:398, :767). Three
// slots, each with its own clock, drawn large and centred near the top of the
// screen with slot 0 highest. A warning takes the warning colour. Upstream lets
// these sit over whatever is behind them, and so does bzo: an alert is short
// lived, and being readable matters more than what it briefly covers.
export const MAX_HUD_ALERTS = 3;
export const HUD_ALERT_WARNING_COLOR = '#ff5a4a';
const HUD_ALERT_COLOR = '#ffffff';
const hudAlerts = new Array(MAX_HUD_ALERTS).fill(null);

// A null or empty string clears the slot, which is what setAlert(i, NULL) does.
export function setHudAlert(index, text, durationSeconds, warning = false) {
  const slot = Math.max(0, Math.min(MAX_HUD_ALERTS - 1, index | 0));
  if (!text) {
    hudAlerts[slot] = null;
    return;
  }
  hudAlerts[slot] = {
    text: String(text),
    warning: Boolean(warning),
    expiresAt: performance.now() + durationSeconds * 1000,
  };
}

// Shared by the DOM HUD and the XR panel so the two never disagree about what is
// showing or for how long.
export function getActiveHudAlerts(now = performance.now()) {
  const active = [];
  for (let i = 0; i < MAX_HUD_ALERTS; i++) {
    const alert = hudAlerts[i];
    if (!alert) continue;
    if (alert.expiresAt <= now) {
      hudAlerts[i] = null;
      continue;
    }
    active.push({ text: alert.text, warning: alert.warning });
  }
  return active;
}

export function getHudAlertColor(warning) {
  return warning ? HUD_ALERT_WARNING_COLOR : HUD_ALERT_COLOR;
}

let alertHudElement;
let lastAlertHudKey = '';

export function updateAlertHud(now = performance.now()) {
  if (alertHudElement === undefined) alertHudElement = document.getElementById('alertHud');
  if (!alertHudElement) return;
  const active = getActiveHudAlerts(now);
  // Rebuilding three lines every frame would thrash the DOM for text that
  // changes a few times a minute.
  const key = active.map((alert) => `${alert.warning ? 'w' : 'n'}:${alert.text}`).join('\n');
  if (key === lastAlertHudKey) return;
  lastAlertHudKey = key;

  alertHudElement.replaceChildren();
  active.forEach((alert) => {
    const line = document.createElement('div');
    line.className = 'alertHudLine';
    line.textContent = alert.text;
    line.style.color = getHudAlertColor(alert.warning);
    alertHudElement.appendChild(line);
  });
}

// Update HUD button states
export function updateHudButtons({
  mouseBtn,
  mouseControlEnabled,
  mouseAvailable = true,
  mouseUnavailableTitle = '',
  debugBtn,
  debugEnabled,
  fullscreenBtn,
  cameraBtn,
  cameraMode,
}) {
  // A row that cannot steer goes dead rather than inert: it stays on the menu,
  // reads Unavailable, and the focus walks past it. Same as the rows gated on
  // what the renderer can draw.
  if (mouseBtn) mouseBtn.disabled = !mouseAvailable;
  setActive(mouseBtn, mouseControlEnabled, 'Disable Mouse Steering (M)', 'Enable Mouse Steering (M)');
  if (mouseBtn && !mouseAvailable && mouseUnavailableTitle) mouseBtn.title = mouseUnavailableTitle;
  // The motion box wears the mode, set from here because this is what every
  // change to the mode already goes through.
  document.getElementById('controlBox')?.classList.toggle('keyboard-mode', !mouseControlEnabled);
  setActive(debugBtn, debugEnabled, 'Hide Debug HUD (`)', 'Show Debug HUD (`)');
  setActive(fullscreenBtn, document.fullscreenElement, 'Exit Fullscreen (F)', 'Toggle Fullscreen (F)');
  if (cameraBtn) {
    // While roaming this arrives already spelled as a view name, because an
    // observer's camera modes are the roaming views rather than these three.
    const CAMERA_MODE_LABELS = {
      'first-person': 'First Person',
      'third-person': 'Third Person',
      overview: 'Overview',
    };
    let camTitle = 'Toggle Camera View (C)';
    if (typeof cameraMode !== 'undefined') {
      camTitle = `Camera: ${CAMERA_MODE_LABELS[cameraMode] || cameraMode} (C)`;
    }
    cameraBtn.title = camTitle;
  }
}

// Toggle debug HUD
export function toggleDebugHud({ debugEnabled, setDebugEnabled, updateHudButtons, showMessage, updateDebugDisplay, getDebugState }) {
  // The panel is shown or hidden first: anything reacting to the new state --
  // the chat layout that keeps clear of it, for one -- reads the panel itself,
  // and would otherwise see the state it had before this toggle.
  const debugHud = document.getElementById('debugHud');
  if (debugHud) debugHud.style.display = !debugEnabled ? 'block' : 'none';
  setDebugEnabled(!debugEnabled);
  localStorage.setItem('debugEnabled', (!debugEnabled).toString());
  if (!debugEnabled && !window.debugUpdateInterval) {
    window.debugUpdateInterval = setInterval(() => updateDebugDisplay(getDebugState()), 500);
  } else if (debugEnabled && window.debugUpdateInterval) {
    clearInterval(window.debugUpdateInterval);
    window.debugUpdateInterval = null;
  }
  updateHudButtons();
  showMessage(`Debug Mode: ${!debugEnabled ? 'ON' : 'OFF'}`);
}

// Formats world time (0-23999 ticks) as HH:MM. Minecraft: 0 = 6:00, 6000 = noon.
function formatWorldTime(worldTime) {
  if (typeof worldTime !== 'number') return '';
  const ticks = worldTime % 24000;
  const totalMinutes = Math.floor((ticks / 1000) * 60); // 1000 ticks = 1 hour
  let hours = Math.floor(totalMinutes / 60) + 6; // 0 ticks = 6:00
  if (hours >= 24) hours -= 24;
  const minutes = totalMinutes % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

// Triangle counts run to the millions, and a row that wraps is a row nobody
// reads on a phone.
function formatCount(value) {
  if (!Number.isFinite(value)) return '';
  if (value < 10000) return String(value);
  if (value < 10000000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1000000).toFixed(1)}M`;
}

// Updates the debug HUD with current stats
export function updateDebugDisplay({
  fps,
  latency,
  packetsSent,
  packetsReceived,
  sentBps,
  receivedBps,
  playerX,
  playerY,
  playerZ,
  playerRotation,
  myTank,
  cameraMode,
  OBSTACLES,
  clouds,
  latestOrientation,
  worldTime,
  gamepadConnected,
  gamepadInfo,
  renderStats,
  framePhases,
  voice
}) {
  const debugContent = document.getElementById('debugContent');
  if (!debugContent) return;

  let html = '<div style="margin-bottom: 10px; font-weight: bold;">PLAYER STATUS:</div>';
  if (typeof latency !== 'undefined') {
    html += `<div><span class="label">FPS/Ping:</span><span class="value">${fps?.toFixed(1) ?? ''}/${Math.round(latency)} ms</span></div>`;
  }
  html += `<div><span class="label">Bytes Sent/Recv/s:</span><span class="value">${sentBps ?? ''}/${receivedBps ?? ''}</span></div>`;
  if (myTank && myTank.userData) {
    html += `<div><span class="label">Linear/Angular:</span><span class="value">${myTank.userData.forwardSpeed?.toFixed(2) ?? '0'}u/${myTank.userData.rotationSpeed?.toFixed(2) ?? '0'}rad</span></div>`;
    if (myTank.userData.verticalSpeed !== undefined) {
      html += `<div><span class="label">Vertical:</span><span class="value">${myTank.userData.verticalSpeed.toFixed(2)} u/s</span></div>`;
    }
    html += `<div><span class="label">Position:</span><span class="value">(${playerX?.toFixed(1) ?? ''}, ${playerY?.toFixed(1) ?? ''}, ${playerZ?.toFixed(1) ?? ''})</span></div>`;
    html += `<div><span class="label">Rotation:</span><span class="value">${playerRotation?.toFixed(2) ?? ''} rad</span></div>`;
  }
  html += `<div><span class="label">Camera:</span><span class="value">${cameraMode ?? ''}</span></div>`;
  html += `<div><span class="label">Obs/Clouds:</span><span class="value">${OBSTACLES?.length ?? ''}/${clouds?.length ?? ''}</span></div>`;
  if (renderStats) {
    html += `<div><span class="label">Draws/Tris:</span><span class="value">${formatCount(renderStats.calls)}/${formatCount(renderStats.triangles)}</span></div>`;
    // The window in brackets is what the program count did over the last
    // second. A moving count is a recompile, not a bigger scene.
    const programs = renderStats.programsWindow
      ? `${formatCount(renderStats.programs)} [${renderStats.programsWindow}]`
      : formatCount(renderStats.programs);
    html += `<div><span class="label">Prog/Tex/Geo:</span><span class="value">${programs}/${formatCount(renderStats.textures)}/${formatCount(renderStats.geometries)}</span></div>`;
  }
  if (framePhases) {
    // Dearest phase first: the row is read to find what to attack.
    const ranked = Object.entries(framePhases)
      .filter(([, ms]) => ms > 0)
      .sort((left, right) => right[1] - left[1]);
    const total = ranked.reduce((sum, [, ms]) => sum + ms, 0);
    html += `<div><span class="label">Frame ms:</span><span class="value">${total.toFixed(1)}</span></div>`;
    ranked.forEach(([name, ms]) => {
      html += `<div><span class="label">&nbsp;&nbsp;${name}:</span><span class="value">${ms.toFixed(2)} ms</span></div>`;
    });
  }
  if (typeof worldTime !== 'undefined') {
    html += `<div><span class="label">World Time:</span><span class="value">${worldTime.toFixed(1)} (${formatWorldTime(worldTime)})</span></div>`;
  }

  // Voice is peer to peer, so a link can fail for one player and nobody else.
  // The per-peer row is the only place that shows up.
  if (voice) {
    const peers = voice.peers || [];
    const connected = peers.filter((peer) => peer.connection === 'connected').length;
    html += `<div><span class="label">Voice:</span><span class="value">${voice.channel}, mic ${voice.transmitting ? 'on' : 'off'}</span></div>`;
    html += `<div><span class="label">Voice Peers:</span><span class="value">${connected}/${peers.length} connected</span></div>`;
    peers.forEach((peer) => {
      const audio = peer.audio ? 'audio' : 'no audio';
      html += `<div><span class="label">&nbsp;&nbsp;${peer.label}:</span><span class="value">${peer.connection}/${peer.ice}, ${audio}</span></div>`;
    });
  }

  if (latestOrientation && latestOrientation.status) {
    html += `<div><span class="label">Orientation Status:</span><span class="value">${latestOrientation.status}</span></div>`;
    if (latestOrientation.alpha !== null && latestOrientation.beta !== null && latestOrientation.gamma !== null) {
      html += `<div><span class="label">Orientation α:</span><span class="value">${latestOrientation.alpha.toFixed(1)}</span></div>`;
      html += `<div><span class="label">Orientation β:</span><span class="value">${latestOrientation.beta.toFixed(1)}</span></div>`;
      html += `<div><span class="label">Orientation γ:</span><span class="value">${latestOrientation.gamma.toFixed(1)}</span></div>`;
    }
  }

  // Gamepad info
  if (gamepadConnected && gamepadInfo) {
    html += `<div><span class="label">Gamepad:</span><span class="value">Connected</span></div>`;
    html += `<div><span class="label">Gamepad ID:</span><span class="value">${gamepadInfo.id.substring(0, 30)}...</span></div>`;
    html += `<div><span class="label">Mapping:</span><span class="value">${gamepadInfo.mapping || 'unknown'}</span></div>`;
    html += `<div><span class="label">Buttons/Axes:</span><span class="value">${gamepadInfo.buttons}/${gamepadInfo.axes}</span></div>`;
  } else {
    html += `<div><span class="label">Gamepad:</span><span class="value">Not connected</span></div>`;
  }

  // Packets sent/received
  if (packetsSent) {
    html += '<div style="margin: 10px 0; border-top: 1px solid #444; padding-top: 10px; font-weight: bold;">PACKETS SENT:</div>';
    const sentTypes = Array.from(packetsSent.entries()).sort((a, b) => b[1] - a[1]);
    sentTypes.forEach(([type, count]) => {
      html += `<div><span class="label">${type}:</span><span class="value">${count}</span></div>`;
    });
  }
  if (packetsReceived) {
    html += '<div style="margin: 10px 0; border-top: 1px solid #444; padding-top: 10px; font-weight: bold;">PACKETS RECEIVED:</div>';
    const receivedTypes = Array.from(packetsReceived.entries()).sort((a, b) => b[1] - a[1]);
    receivedTypes.forEach(([type, count]) => {
      html += `<div><span class="label">${type}:</span><span class="value">${count}</span></div>`;
    });
  }
  debugContent.innerHTML = html;
}

// Updates the scoreboard with current player stats
// ScoreboardRenderer::renderTeamScores. A team's score is its wins minus its
// losses, rows sort by it, and a team with nobody on it is left out. Upstream
// tells the teams apart by colour alone; a name column costs nothing here and
// survives a player who cannot.
export function getTeamScoreRows(teamScores) {
  return (teamScores || [])
    .filter((entry) => entry && entry.size > 0 && isColorTeam(entry.team))
    .map((entry) => ({
      ...entry,
      label: PLAYER_TEAM_LABELS[entry.team] || entry.team,
      score: entry.wins - entry.losses,
    }))
    .sort((a, b) => b.score - a.score);
}

// The same contents bzfs shows: score, the wins and losses behind it, and the
// number of players on the team.
export function formatTeamScore(row) {
  return `${row.score} (${row.wins}-${row.losses}) ${row.size}`;
}

function updateTeamScoreboard(rows) {
  const container = document.getElementById('teamScoreboard');
  if (!container) return;
  container.innerHTML = '';
  container.classList.toggle('teamScoreboardEmpty', rows.length === 0);
  if (!rows.length) return;

  const header = document.createElement('div');
  header.className = 'teamScoreHeader';
  const headerName = document.createElement('span');
  headerName.className = 'scoreboardName';
  headerName.textContent = 'Team Score';
  const headerStats = document.createElement('span');
  headerStats.className = 'scoreboardStats';
  headerStats.textContent = 'Score (W-L) Size';
  header.appendChild(headerName);
  header.appendChild(headerStats);
  container.appendChild(header);

  rows.forEach((row) => {
    const entry = document.createElement('div');
    entry.className = 'scoreboardEntry teamScoreEntry';
    entry.style.color = colorToCSS(getPlayerTeamColor(row.team));

    const nameSpan = document.createElement('span');
    nameSpan.className = 'scoreboardName';
    nameSpan.textContent = row.label;

    const statsSpan = document.createElement('span');
    statsSpan.className = 'scoreboardStats';
    statsSpan.textContent = formatTeamScore(row);

    entry.appendChild(nameSpan);
    entry.appendChild(statsSpan);
    container.appendChild(entry);
  });
}

// Observers last, as `ScoreboardRenderer::newSortedList` puts them under
// `obsLast`: they score for nobody, so ranking them among the players says
// something untrue. Then by (kills - deaths) descending, then kills descending,
// then deaths ascending, then connectDate ascending (oldest first).
//
// Exported because roaming follows the leader when it has no explicit target,
// and upstream reads that off the scoreboard's own order
// (`ScoreboardRenderer::getLeader`) -- two orderings would let the tracked
// player and the top row disagree.
export function compareScoreboardPlayers(a, b) {
  if (Boolean(a.isObserver) !== Boolean(b.isObserver)) return a.isObserver ? 1 : -1;
  const aScore = (a.kills || 0) - (a.deaths || 0);
  const bScore = (b.kills || 0) - (b.deaths || 0);
  if (bScore !== aScore) return bScore - aScore;
  if ((b.kills || 0) !== (a.kills || 0)) return b.kills - a.kills;
  if ((a.deaths || 0) !== (b.deaths || 0)) return (a.deaths || 0) - (b.deaths || 0);
  return a.connectDate - b.connectDate;
}

// One shape for a player's name and the flag they carry, wherever it is written.
// Upstream builds a single string -- the callsign, then "/", then the flag's
// abbreviation, with the colour changing at the slash and no space anywhere
// (ScoreboardRenderer::drawPlayerScore) -- so the two sit tight here too and
// only the colour changes between them. Both the panel's title and every row go
// through this, which is what keeps them the same.
function writePlayerLabel(nameEl, flagEl, { name, nameColor, flag } = {}) {
  if (nameEl) {
    if (name !== undefined) nameEl.textContent = name;
    if (nameColor !== undefined) nameEl.style.color = nameColor ? colorToCSS(nameColor) : '';
  }
  if (flagEl) {
    flagEl.textContent = flag ? `/${flag.label}` : '';
    flagEl.style.color = flag ? colorToCSS(flag.color) : '';
  }
}

// One row per player, in scoreboard order, for however many surfaces draw the
// roster. The flat scoreboard and the headset's canvas panel both read these,
// so a player's colour, carried flag and place in the order cannot differ
// between them -- and gathering the inputs in one place is what stops a caller
// leaving one out and silently dropping a column.
//
// `getPlayerFlagLabel` is a lookup rather than something read here, because the
// flag list belongs to client.js. ScoreboardRenderer::drawPlayerScore puts the
// carried flag after the callsign, in the flag's own colour.
export function buildScoreboardRows({
  myPlayerId,
  myPlayerName,
  myTank,
  tanks,
  getPlayerFlagLabel = () => null,
}) {
  const rows = [];
  const addRow = (id, name, state, isCurrent) => {
    if (!state) return;
    rows.push({
      id,
      name,
      kills: state.kills || 0,
      deaths: state.deaths || 0,
      connectDate: state.connectDate ? new Date(state.connectDate) : new Date(0),
      color: state.color,
      flag: getPlayerFlagLabel(id),
      isObserver: isObserverTeam(state.team),
      isCurrent,
    });
  };

  if (myPlayerId && myTank) addRow(myPlayerId, myPlayerName, myTank.userData.playerState, true);
  tanks.forEach((tank, id) => {
    if (id === myPlayerId) return;
    addRow(id, tank.userData.playerState?.name || 'Player', tank.userData.playerState, false);
  });

  rows.sort(compareScoreboardPlayers);
  return rows;
}

// The roster as the flat HUD draws it. Everything it needs arrives already
// assembled, so this decides only how the rows look -- see the model builder in
// `client.js`, which is the one entry point every repaint goes through.
export function updateScoreboard({
  rows,
  teamRows,
  // Set while roaming: the id being watched, and the callback a row click
  // reports a new choice to. Absent for a playing tank, which leaves the rows
  // inert.
  roamTargetId = null,
  onSelectRoamTarget = null,
}) {
  updateTeamScoreboard(teamRows);
  const scoreboardList = document.getElementById('scoreboardList');
  if (!scoreboardList) return;
  scoreboardList.innerHTML = '';
  const playerData = rows;

  // The panel's title is the player's own name, and it now carries the colour
  // their tank is drawn in and the flag they are holding, in the same shape a
  // row uses. Both were otherwise readable only by finding your own row, and the
  // colour in particular is worth having to hand now that team mates are shaded
  // apart -- "which red am I" is a question the roster cannot answer at a
  // glance. The flag lives in its own element because the title's text is
  // written from several places and a child span would not survive them.
  const current = playerData.find((player) => player.isCurrent);
  writePlayerLabel(
    document.getElementById('playerName'),
    document.getElementById('playerFlag'),
    // The name is written from elsewhere; only the colour and the flag belong
    // to this.
    { nameColor: current?.color ?? null, flag: current?.flag },
  );

  // Create scoreboard entries
  playerData.forEach(player => {
    const entry = document.createElement('div');
    // ScoreboardRenderer::drawRoamTarget marks the row the observer is watching.
    const isRoamTarget = player.id === roamTargetId;
    entry.className = 'scoreboardEntry'
      + (player.isCurrent ? ' current' : '')
      + (isRoamTarget ? ' roamTarget' : '');
    if (onSelectRoamTarget && !player.isCurrent) {
      // The one target gesture that works on a phone as well as a desktop.
      // Tapping the row already being watched releases back to the leader.
      entry.classList.add('selectable');
      entry.addEventListener('click', () => onSelectRoamTarget(isRoamTarget ? null : player.id));
    }
    if (player.color) {
      entry.style.color = colorToCSS(player.color);
    }
    // Name and flag are one item, so the row's spacing pushes the score away
    // from the pair rather than the flag away from the name.
    const labelSpan = document.createElement('span');
    labelSpan.className = 'playerLabel';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'scoreboardName';
    const flagSpan = document.createElement('span');
    flagSpan.className = 'scoreboardFlag';
    // The row already carries the player's colour; only the flag differs.
    writePlayerLabel(nameSpan, flagSpan, { name: player.name, flag: player.flag });
    labelSpan.append(nameSpan, flagSpan);

    const statsSpan = document.createElement('span');
    statsSpan.className = 'scoreboardStats';
    statsSpan.textContent = `${player.kills} / ${player.deaths}`;

    entry.append(labelSpan, statsSpan);
    scoreboardList.appendChild(entry);
  });
}

// HUDRenderer::addMarker and the block that draws the markers
// (HUDRenderer.cxx:1531). A marker rides the heading tape: a diamond standing on
// the tape where its bearing falls inside the visible span, or an arrow pinned
// to whichever edge it is past. Upstream puts those edge arrows just outside the
// tape, inside a scissor that gives it the room; bzo's canvas is exactly as wide
// as the tape, so they point outward from inside the edge instead.
const HUD_MARKER_SIZE = 8;

function drawHeadingMarkers(ctx, markers, { barWidth, barBottom, pxPerDeg, halfSpanDeg }) {
  const half = HUD_MARKER_SIZE / 2;
  markers.forEach((marker) => {
    ctx.fillStyle = marker.color;
    ctx.beginPath();
    if (Math.abs(marker.relDeg) <= halfSpanDeg) {
      // The tape runs with greater headings to the left, so a marker does too.
      const px = (barWidth / 2) - (marker.relDeg * pxPerDeg);
      ctx.moveTo(px, barBottom);
      ctx.lineTo(px + half, barBottom - half);
      ctx.lineTo(px, barBottom - HUD_MARKER_SIZE);
      ctx.lineTo(px - half, barBottom - half);
    } else if (marker.relDeg > 0) {
      ctx.moveTo(half, barBottom);
      ctx.lineTo(half, barBottom - HUD_MARKER_SIZE);
      ctx.lineTo(0, barBottom - half);
    } else {
      ctx.moveTo(barWidth - half, barBottom);
      ctx.lineTo(barWidth - half, barBottom - HUD_MARKER_SIZE);
      ctx.lineTo(barWidth, barBottom - half);
    }
    ctx.closePath();
    ctx.fill();
  });
}

// Where each marker's bearing falls relative to the middle of the tape, wrapped
// to the nearer way round. Computed before the redraw check so a marker that has
// moved forces one.
function resolveHeadingMarkers(markers, centerDeg) {
  return markers.map((marker) => {
    let relDeg = ((marker.heading * 180 / Math.PI) % 360) - centerDeg;
    while (relDeg > 180) relDeg -= 360;
    while (relDeg <= -180) relDeg += 360;
    return { relDeg, color: marker.color };
  });
}

// Draws a degree bar above the control box
export function updateDegreeBar({ myTank, playerRotation, markers = [] }) {
  const hud = getHudCanvasContext(degreeBarRenderState, 'degreeBar');
  if (!hud || !hud.controlBox || !myTank) return;
  const { canvas: degreeBar, controlBox, ctx } = hud;
  const barRect = degreeBar.getBoundingClientRect();
  const barWidth = Math.round(barRect.width);
  const barHeight = Math.round(barRect.height);
  if (!barWidth || !barHeight) return;
  const dpr = window.devicePixelRatio || 1;
  const resized = resizeHudCanvasIfNeeded(degreeBarRenderState, degreeBar, barWidth, barHeight, dpr);
  // Align bottom of degreeBar to top of controlBox
  const topPx = Math.round(controlBox.getBoundingClientRect().top - barHeight + 1);
  if (degreeBarRenderState.topPx !== topPx) {
    degreeBar.style.top = `${topPx}px`;
    degreeBarRenderState.topPx = topPx;
  }

  // Get controlBox border color for bar/labels
  let barColor = '#4CAF50';
  let labelColor = '#4CAF50';
  const style = window.getComputedStyle(controlBox);
  const borderColor = style.borderColor;
  barColor = borderColor;
  labelColor = borderColor;
  if (controlBox.classList.contains('keyboard-mode')) {
    barColor = 'rgba(255, 152, 0, 0.6)';
    labelColor = 'rgba(255, 152, 0, 0.9)';
  }

  // Bar spans 45 degrees, centered on playerRotation (in radians)
  const degSpan = 45;
  const centerDeg = ((playerRotation || 0) * 180 / Math.PI) % 360;
  const pxPerDeg = barWidth / degSpan;
  const centerDegKey = Math.round(centerDeg * pxPerDeg * 2) / 2;
  const colorKey = `${barColor}|${labelColor}|${controlBox.classList.contains('keyboard-mode')}`;
  // A marker moves as the player drives, not only as they turn, so the tape has
  // to redraw for that too -- at the same half-pixel resolution as the ticks.
  const resolvedMarkers = resolveHeadingMarkers(markers, centerDeg);
  const markerKey = resolvedMarkers
    .map((marker) => `${Math.round(marker.relDeg * pxPerDeg * 2) / 2}|${marker.color}`)
    .join(',');
  if (!resized
    && degreeBarRenderState.centerDegKey === centerDegKey
    && degreeBarRenderState.colorKey === colorKey
    && degreeBarRenderState.markerKey === markerKey) {
    return;
  }
  degreeBarRenderState.centerDegKey = centerDegKey;
  degreeBarRenderState.colorKey = colorKey;
  degreeBarRenderState.markerKey = markerKey;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // scale for HiDPI
  ctx.clearRect(0, 0, barWidth, barHeight);

  // Reverse direction: as player turns right, bar moves left
  const startDeg = centerDeg + degSpan / 2;
  const endDeg = centerDeg - degSpan / 2;

  ctx.save();
  ctx.strokeStyle = barColor;
  ctx.lineWidth = 2;
  ctx.font = '13px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  // Draw ticks and labels for every 5 degrees in the visible span
  // Ticks connect to controlBox top edge responsively
  const barBottom = barHeight - 4;
  for (let deg = Math.ceil(startDeg / 5) * 5; deg >= endDeg; deg -= 5) {
    let normDeg = ((deg % 360) + 360) % 360;
    const px = (startDeg - deg) * pxPerDeg;
    const isMajor = normDeg % 10 === 0;
    // Shorter ticks, like altimeter
    const y1 = barBottom;
    const y2 = isMajor ? barBottom - barHeight * 0.45 : barBottom - barHeight * 0.35;
    ctx.beginPath();
    ctx.moveTo(px, y1);
    ctx.lineTo(px, y2);
    ctx.stroke();
    if (isMajor) {
      ctx.fillStyle = labelColor;
      // Place number above the tick
      ctx.textBaseline = 'bottom';
      ctx.fillText(normDeg.toFixed(0), px, y2 - 2);
      ctx.textBaseline = 'top'; // restore for safety
    }
  }
  drawHeadingMarkers(ctx, resolvedMarkers, {
    barWidth,
    barBottom,
    pxPerDeg,
    halfSpanDeg: degSpan / 2,
  });
  ctx.restore();
}

// Draws on the right side of the control box
export function updateAltimeter({ myTank, tickSpacing = 5 }) {
  const hud = getHudCanvasContext(altimeterRenderState, 'altimeter');
  if (!hud || !myTank) return;
  const { canvas: altimeter, controlBox, ctx } = hud;
  const altRect = altimeter.getBoundingClientRect();
  const altWidth = Math.round(altRect.width);
  const altHeight = Math.round(altRect.height);
  if (!altWidth || !altHeight) return;
  const boxRect = controlBox ? controlBox.getBoundingClientRect() : null;
  const dpr = window.devicePixelRatio || 1;
  const resized = resizeHudCanvasIfNeeded(altimeterRenderState, altimeter, altWidth, altHeight, dpr);

  // Show 30 units from top to bottom
  const unitsVisible = 30;
  const pixelsPerUnit = altHeight / unitsVisible;
  const tankY = myTank.position.y;
  const centerY = altHeight / 2;

  // Get controlBox border color for altimeter lines/numbers
  let tickColor = '#4CAF50'; // fallback to green
  let numberColor = '#4CAF50';
  if (controlBox) {
    const style = window.getComputedStyle(controlBox);
    const borderColor = style.borderColor;
    tickColor = borderColor;
    numberColor = borderColor;
    if (controlBox.classList.contains('keyboard-mode')) {
      tickColor = 'rgba(255, 152, 0, 0.6)';
      numberColor = 'rgba(255, 152, 0, 0.9)';
    }
  }
  const tankYKey = Math.round(tankY * pixelsPerUnit * 2) / 2;
  const colorKey = `${tickColor}|${numberColor}|${controlBox?.classList.contains('keyboard-mode') ?? false}`;
  if (!resized && altimeterRenderState.tankYKey === tankYKey && altimeterRenderState.colorKey === colorKey) {
    return;
  }
  altimeterRenderState.tankYKey = tankYKey;
  altimeterRenderState.colorKey = colorKey;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // scale for HiDPI
  ctx.clearRect(0, 0, altWidth, altHeight);

  // Draw ticks and numbers relative to tankY at center, with smooth scrolling
  ctx.save();
  ctx.strokeStyle = tickColor;
  ctx.lineWidth = 2;
  ctx.font = '12px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  // Ticks start at the left edge of the altimeter, which should abut the controlBox
  let tickStart = 0;
  let tickEnd = Math.max(8, altWidth * 0.28); // short, responsive
  let numberOffset = tickEnd + 4;
  // If controlBox is present, align tickStart to the edge closest to controlBox
  if (boxRect && altRect) {
    // If altimeter is to the right of controlBox, align left edge
    if (altRect.left > boxRect.right - 5) {
      tickStart = 0;
    } else if (altRect.right < boxRect.left + 5) {
      // If altimeter is to the left, align right edge
      tickStart = altWidth;
      tickEnd = altWidth - Math.max(8, altWidth * 0.28);
      numberOffset = tickEnd - 4;
    }
  }

  // Find the first tick below the current Y (may be fractional)
  const firstTick = Math.floor((tankY - unitsVisible / 2) / tickSpacing) * tickSpacing;
  const lastTick = Math.ceil((tankY + unitsVisible / 2) / tickSpacing) * tickSpacing;

  for (let alt = firstTick; alt <= lastTick; alt += tickSpacing) {
    if (alt < 0) continue;
    // Compute y position with smooth scrolling
    const y = centerY - (alt - tankY) * pixelsPerUnit;
    ctx.beginPath();
    ctx.moveTo(tickStart, y);
    ctx.lineTo(tickEnd, y);
    ctx.stroke();
    if ((alt / tickSpacing) % 2 === 0) {
      ctx.fillStyle = numberColor;
      ctx.fillText(alt.toString(), numberOffset, y);
    }
  }
  ctx.restore();

  // Draw current altitude indicator (shorter center line)
  ctx.save();
  ctx.strokeStyle = '#ff0';
  ctx.lineWidth = 3;
  // Make the yellow line even shorter than the tick lines
  const centerLineStart = 0;
  const centerLineEnd = altWidth * 0.22; // shorter than tickEnd
  ctx.beginPath();
  ctx.moveTo(centerLineStart, centerY);
  ctx.lineTo(centerLineEnd, centerY);
  ctx.stroke();
  ctx.restore();
}

export function updateShotStatus({ myPlayerId, projectiles, gameConfig, reloadProgress = 1, now = Date.now() }) {
  const hud = getHudCanvasContext(shotStatusRenderState, 'shotStatus');
  if (!hud || !myPlayerId || !gameConfig) return;
  const { canvas: shotStatus, controlBox, ctx } = hud;
  const maxSlots = normalizeShotSlotCount(gameConfig.SHOT_MAX_ACTIVE);
  const indicatorWidth = Math.max(18, Math.round(window.innerWidth / 50));
  const indicatorHeight = Math.max(8, Math.round(window.innerHeight / 80));
  const indicatorSpace = Math.max(2, Math.round(indicatorHeight / 10) + 2);
  const totalHeight = (indicatorHeight * maxSlots) + (indicatorSpace * Math.max(0, maxSlots - 1));
  if (shotStatus.style.width !== `${indicatorWidth}px`) {
    shotStatus.style.width = `${indicatorWidth}px`;
  }
  if (shotStatus.style.height !== `${totalHeight}px`) {
    shotStatus.style.height = `${totalHeight}px`;
  }
  const statusRect = shotStatus.getBoundingClientRect();
  const statusWidth = Math.round(statusRect.width);
  const statusHeight = Math.round(statusRect.height);
  if (!statusWidth || !statusHeight) return;
  const dpr = window.devicePixelRatio || 1;
  const resized = resizeHudCanvasIfNeeded(shotStatusRenderState, shotStatus, statusWidth, statusHeight, dpr);
  const boxRect = controlBox?.getBoundingClientRect();
  if (boxRect) {
    const topPx = Math.round(boxRect.top + ((boxRect.height - totalHeight) / 2));
    const leftPx = Math.round(boxRect.right + indicatorWidth + 16);
    if (shotStatusRenderState.topPx !== topPx) {
      shotStatus.style.top = `${topPx}px`;
      shotStatusRenderState.topPx = topPx;
    }
    if (shotStatusRenderState.leftPx !== leftPx) {
      shotStatus.style.left = `${leftPx}px`;
      shotStatusRenderState.leftPx = leftPx;
    }
  }

  const shotSpeed = Number.isFinite(gameConfig.SHOT_SPEED) ? gameConfig.SHOT_SPEED : 100;
  const shotRange = Number.isFinite(gameConfig.SHOT_RANGE)
    ? gameConfig.SHOT_RANGE
    : (Number.isFinite(gameConfig.SHOT_DISTANCE) ? gameConfig.SHOT_DISTANCE : 350);
  const slotLifetimeMs = shotSpeed > 0 ? (shotRange / shotSpeed) * 1000 : 0;
  const slotProgress = new Array(maxSlots).fill(1);
  if (projectiles && typeof projectiles.forEach === 'function') {
    projectiles.forEach((projectile) => {
      if (projectile?.userData?.playerId !== myPlayerId) return;
      const slotIndex = Number.isInteger(projectile?.userData?.shotSlot) ? projectile.userData.shotSlot : -1;
      if (slotIndex < 0 || slotIndex >= maxSlots) return;
      const createdAt = Number.isFinite(projectile?.userData?.createdAt) ? projectile.userData.createdAt : now;
      const ageMs = Math.max(0, now - createdAt);
      // GetShotLifetime: a shot variant holds its slot for its own life, not the
      // world's, which is what makes a Machine Gun's slots come back ten times
      // as fast.
      const lifeFactor = Number.isFinite(projectile?.userData?.lifeFactor)
        ? projectile.userData.lifeFactor
        : 1;
      const lifetimeMs = slotLifetimeMs * lifeFactor;
      const progress = lifetimeMs > 0 ? Math.max(0, Math.min(1, ageMs / lifetimeMs)) : 0;
      slotProgress[slotIndex] = progress;
    });
  }

  // bzo spaces its shots over one world reload interval instead of giving every
  // slot a timer of its own, so that interval is a floor under every bar: an
  // empty slot is still not one you can fire from until the interval has run.
  // Laser is what makes the difference visible -- its shot is long gone before
  // its reload is up.
  const reloadFloor = Math.max(0, Math.min(1, Number.isFinite(reloadProgress) ? reloadProgress : 1));
  for (let i = 0; i < maxSlots; i++) {
    slotProgress[i] = Math.min(slotProgress[i], reloadFloor);
  }

  const stateKey = `${maxSlots}:${slotProgress.map((value) => value.toFixed(2)).join('|')}`;
  const colorKey = 'bzflag-shot-slots';
  if (!resized && shotStatusRenderState.stateKey === stateKey && shotStatusRenderState.colorKey === colorKey) {
    return;
  }
  shotStatusRenderState.stateKey = stateKey;
  shotStatusRenderState.colorKey = colorKey;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, statusWidth, statusHeight);

  const slotHeight = indicatorHeight;
  const slotWidth = indicatorWidth;
  const readyColor = 'rgba(255, 255, 255, 0.5)';
  const reloadBaseColor = 'rgba(255, 0, 0, 0.5)';
  const reloadFillColor = 'rgba(0, 255, 0, 0.5)';

  ctx.save();
  for (let i = 0; i < maxSlots; i++) {
    const x = 0;
    const y = i * (slotHeight + indicatorSpace);
    const progress = slotProgress[i];
    const available = progress >= 1;

    if (available) {
      ctx.fillStyle = readyColor;
      ctx.fillRect(x, y, slotWidth, slotHeight);
    } else {
      ctx.fillStyle = reloadBaseColor;
      ctx.fillRect(x, y, slotWidth, slotHeight);
      ctx.fillStyle = reloadFillColor;
      ctx.fillRect(x, y, slotWidth * progress, slotHeight);
    }
  }
  ctx.restore();
}
