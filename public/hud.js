/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// hud.js - Handles HUD and debug display logic

import { normalizeShotSlotCount } from './shots.mjs';
import {
  PLAYER_TEAM,
  PLAYER_TEAM_COLORS,
  PLAYER_TEAM_LABELS,
  getPlayerRanking,
  getPlayerTeamColor,
  isColorTeam,
  isObserverTeam,
  isRabbitTeam,
  normalizePlayerTeam,
} from './teams.mjs';

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
//
// `segments` is optional and works exactly as a chat line's does: `[{ text,
// color }]`, where a segment with no colour of its own takes the alert's. `text`
// is still the whole line as one string, so a renderer that ignores segments
// draws something correct. It is how an alert naming a player wears the same
// colours the scoreboard gives that player -- see formatPlayerLabel.
export function setHudAlert(index, text, durationSeconds, warning = false, segments = null) {
  const slot = Math.max(0, Math.min(MAX_HUD_ALERTS - 1, index | 0));
  if (!text) {
    hudAlerts[slot] = null;
    return;
  }
  hudAlerts[slot] = {
    text: String(text),
    warning: Boolean(warning),
    segments: Array.isArray(segments) && segments.length > 0 ? segments : null,
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
    active.push({ text: alert.text, warning: alert.warning, segments: alert.segments });
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
  // changes a few times a minute. The colours are part of the key as well as the
  // words: two alerts can read the same and be about differently coloured
  // players.
  const key = active.map((alert) => (
    `${alert.warning ? 'w' : 'n'}:${alert.segments
      ? alert.segments.map((segment) => `${segment.color || ''}\u0000${segment.text}`).join('\u0001')
      : alert.text}`
  )).join('\n');
  if (key === lastAlertHudKey) return;
  lastAlertHudKey = key;

  alertHudElement.replaceChildren();
  active.forEach((alert) => {
    const line = document.createElement('div');
    line.className = 'alertHudLine';
    line.style.color = getHudAlertColor(alert.warning);
    if (alert.segments) {
      // A segment with no colour inherits the line's, which is the alert's own,
      // exactly as a chat line's segments inherit the kind's.
      alert.segments.forEach((segment) => {
        const span = document.createElement('span');
        span.textContent = segment.text;
        if (segment.color) span.style.color = colorToCSS(segment.color);
        line.appendChild(span);
      });
    } else {
      line.textContent = alert.text;
    }
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

// HUDRenderer.cxx:975: H:MM:SS once past an hour, otherwise M:SS, with no
// leading zero on the leftmost unit. `-1` (upstream's paused value) and `null`
// (no clock configured) both blank rather than print a number -- upstream
// reserves several negative timer values the same way to mean "show nothing".
export function formatMatchClock(seconds) {
  if (seconds === null || seconds === undefined || seconds < 0) return null;
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function updateMatchClock(timeLeft, gameOver) {
  const el = document.getElementById('matchClock');
  if (!el) return;
  // No clock configured and no game to be over is the one case with nothing
  // to show -- a score limit can end a clockless match too (`scoreOver` sets
  // `gameOver` without ever setting a `timeLeft`), and that still belongs on
  // the board.
  if ((timeLeft === null || timeLeft === undefined) && !gameOver) {
    el.classList.add('matchClockHidden');
    return;
  }
  el.classList.remove('matchClockHidden');
  // The board keeps saying so after the transient alert times out, until the
  // next /countdown's timeUpdate clears it.
  el.textContent = gameOver ? 'GAME OVER' : (formatMatchClock(timeLeft) || '');
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
  // newSortedList's default case (ScoreboardRenderer.cxx:1003) sorts by
  // `getRabbitScore()` rather than `getScore()` on a Rabbit Chase world, so the
  // board is ordered by who is next in line for the rabbit rather than by wins
  // minus losses. The two agree often enough to hide the difference and then
  // disagree: a player with no record at all ranks 0.5, above anyone whose rate
  // is worse than even however far ahead they are on kills.
  //
  // `rank` is only set on a Rabbit Chase world, so this test is also the
  // `allowRabbit()` that upstream asks -- and it is asked here rather than
  // passed in so that every surface that orders players, the roaming leader
  // included, cannot order them differently.
  if (typeof a.rank === 'number' && typeof b.rank === 'number' && a.rank !== b.rank) {
    return b.rank - a.rank;
  }
  const aScore = (a.kills || 0) - (a.deaths || 0);
  const bScore = (b.kills || 0) - (b.deaths || 0);
  if (bScore !== aScore) return bScore - aScore;
  if ((b.kills || 0) !== (a.kills || 0)) return b.kills - a.kills;
  if ((a.deaths || 0) !== (b.deaths || 0)) return (a.deaths || 0) - (b.deaths || 0);
  return a.connectDate - b.connectDate;
}

// The authentication indicator, `ScoreboardRenderer.cxx:712`. Upstream builds it
// as a field of its own beside the callsign rather than as part of the name, in
// cyan, and picks exactly one character: `@` for an admin, else `+` for a player
// who authenticated this session, else `-` for a registered callsign that did
// not, else nothing at all.
//
// bzo reaches two of the three. It learns nothing about a callsign unless a
// token verifies, and a verified token means registered as well, so `-` has no
// state to describe here -- which is also why a name may not begin with one.
export const SCOREBOARD_STATUS_COLOR = 0x00ffff;

// getRabbitScore() is `rabbitRank(...) * 100` truncated to a short, and upstream
// prints it `%2d%%`.
export function formatRabbitRank(rank) {
  return `${Math.trunc(rank * 100)}%`;
}

// The score columns as a row draws them, or an empty string for an observer --
// upstream wraps both columns in `if (player->getTeam() != ObserverTeam)`
// (ScoreboardRenderer.cxx:829) and draws the callsign alone. Shared so the flat
// board and the headset's cannot show a different set of columns.
// What the stats column is called. Upstream keeps the rank inside a column it
// labels only "Score" (`scoreLabel`, ScoreboardRenderer.cxx:36) and never names
// the rank at all, which leaves a reader to guess what the percentage in front of
// their kills is. bzo names it, because an unlabelled column is a question rather
// than an answer.
// `abbreviated` is the headset's, where the panel is a few hundred pixels wide
// and 'Kills / Deaths' would crowd the names it sits over.
export function getScoreboardStatsHeader(rabbitChase = false, abbreviated = false) {
  const score = abbreviated ? 'K/D' : 'Kills / Deaths';
  return rabbitChase ? `Rank ${score}` : score;
}

export function formatScoreboardStats(player) {
  if (player.isObserver) return '';
  const score = `${player.kills} / ${player.deaths}`;
  return typeof player.rank === 'number'
    ? `${formatRabbitRank(player.rank)} ${score}`
    : score;
}

// Rabbit Chase marks the rabbit's row so the scoreboard says who everyone is
// hunting. Upstream marks the *hunted* row instead, as part of the hunt feature
// bzo does not have, so this is the marker without the feature -- the radar ring
// in client.js is its other half. In the rabbit's own tank colour, which ties
// the row to the one tank in the world wearing a reserved colour.
export const SCOREBOARD_RABBIT_MARK = Object.freeze({
  label: '(rabbit)',
  color: PLAYER_TEAM_COLORS[PLAYER_TEAM.RABBIT],
});

// The one place a player's name, the flag they carry and the Rabbit Chase mark
// are composed into a single string. The scoreboard draws the three as separate
// elements because it colours each one; anything writing a line of plain text --
// an Identify alert, a chat notice -- takes the same composition from here, so
// two surfaces cannot describe the same tank differently.
//
// Upstream's Identify writes `<callsign> (<Team>) with <Flag name>`
// (playing.cxx:4488). bzo names the team only where it says something: in Rabbit
// Chase, where `(rabbit)` is exactly upstream's `(Rabbit)`. Every bzo player has
// a colour of their own, so `(Rogue)` on every line of an OpenFFA server would
// be noise rather than information, and the flag keeps the scoreboard's
// abbreviation rather than upstream's full name for the same reason -- it is the
// form a player reads everywhere else in bzo.
export function formatPlayerLabel({ name, nameColor = null, flag = null, mark = null }) {
  const segments = [{ text: String(name), color: nameColor }];
  if (flag) segments.push({ text: `/${flag.label}`, color: flag.color });
  if (mark) segments.push({ text: ` ${mark.label}`, color: mark.color });
  return {
    text: segments.map((segment) => segment.text).join(''),
    segments,
  };
}

// The `(<Team>)` upstream puts after a callsign in a message (playing.cxx:4016
// and :4488), for the teams where it says something.
//
// A colour team names itself, because a shade inside that team's band is not
// something a reader can name from one line of text however clearly it reads on
// a tank. The rabbit names itself, because it is the one thing in the world
// everybody is hunting. Rogue, observer and hunter name nothing: every bzo player
// has a colour of their own, so `(Rogue)` on every line of an OpenFFA server
// would be noise, and in Rabbit Chase everyone who is not the rabbit is a hunter.
export function getPlayerTeamMark(team) {
  const normalized = normalizePlayerTeam(team);
  if (isRabbitTeam(normalized)) return SCOREBOARD_RABBIT_MARK;
  if (!isColorTeam(normalized)) return null;
  return {
    label: `(${PLAYER_TEAM_LABELS[normalized].replace(/ Team$/, '')})`,
    color: getPlayerTeamColor(normalized),
  };
}

export function getPlayerStatusIndicator(state) {
  if (!state) return '';
  if (state.admin) return '@';
  if (state.verified) return '+';
  return '';
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
  // Whether this world plays Rabbit Chase, which is upstream's `allowRabbit()`.
  // It changes what the board is sorted by and adds the rank column, and nothing
  // else on the row.
  rabbitChase = false,
}) {
  const rows = [];
  const addRow = (id, name, state, isCurrent) => {
    if (!state) return;
    rows.push({
      id,
      name,
      kills: state.kills || 0,
      deaths: state.deaths || 0,
      // No rank for an observer, on a Rabbit Chase world or any other. An
      // observer can never be anointed -- `canBeRabbit` refuses one outright --
      // so a rank would read as a place in a queue it cannot be picked from.
      // Upstream reaches the same answer by drawing no score column for an
      // observer at all (ScoreboardRenderer.cxx:829), the rank being part of
      // that column's string.
      rank: rabbitChase && !isObserverTeam(state.team)
        ? getPlayerRanking(state.kills || 0, state.deaths || 0)
        : null,
      connectDate: state.connectDate ? new Date(state.connectDate) : new Date(0),
      color: state.color,
      flag: getPlayerFlagLabel(id),
      status: getPlayerStatusIndicator(state),
      rabbit: isRabbitTeam(state.team) ? SCOREBOARD_RABBIT_MARK : null,
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
  // ScoreboardRenderer.cxx:562 drops a blank line in front of the first
  // observer. Sorting them last says where they are; the gap is what says they
  // are a separate group rather than the worst players on the board. Marked on
  // the row rather than measured by each renderer, so the flat board and the
  // headset's cannot disagree about where the break falls -- and not marked at
  // all when there is nobody above it to be separated from.
  const firstObserver = rows.findIndex((row) => row.isObserver);
  if (firstObserver > 0) rows[firstObserver].startsObservers = true;
  return rows;
}

// The roster as the flat HUD draws it. Everything it needs arrives already
// assembled, so this decides only how the rows look -- see the model builder in
// `client.js`, which is the one entry point every repaint goes through.
export function updateScoreboard({
  rows,
  teamRows,
  // Whether this world plays Rabbit Chase, which decides only what the stats
  // column is called -- the rows already carry their own rank or not.
  rabbitChase = false,
  // Set while roaming: the id being watched, and the callback a row click
  // reports a new choice to. Absent for a playing tank, which leaves the rows
  // inert.
  roamTargetId = null,
  onSelectRoamTarget = null,
  // Seconds left on the match clock, extrapolated by the caller the same way
  // HUDRenderer does upstream; null with no clock configured, -1 while paused.
  timeLeft = null,
  gameOver = false,
}) {
  updateMatchClock(timeLeft, gameOver);
  updateTeamScoreboard(teamRows);
  const statsHeader = document.getElementById('scoreboardStatsHeader');
  if (statsHeader) statsHeader.textContent = getScoreboardStatsHeader(rabbitChase);
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
      + (isRoamTarget ? ' roamTarget' : '')
      + (player.startsObservers ? ' startsObservers' : '');
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
    // Before the name and in cyan, which is where and how upstream draws it.
    // Its own element, so it is never part of the name it sits beside.
    const statusSpan = document.createElement('span');
    statusSpan.className = 'scoreboardStatus';
    statusSpan.textContent = player.status || '';
    statusSpan.style.color = colorToCSS(SCOREBOARD_STATUS_COLOR);
    const nameSpan = document.createElement('span');
    nameSpan.className = 'scoreboardName';
    const flagSpan = document.createElement('span');
    flagSpan.className = 'scoreboardFlag';
    // The row already carries the player's colour; only the flag differs.
    writePlayerLabel(nameSpan, flagSpan, { name: player.name, flag: player.flag });
    // After the flag, so the pair upstream draws tight together stays tight and
    // the mark reads as something said about the row rather than part of a name.
    const rabbitSpan = document.createElement('span');
    rabbitSpan.className = 'scoreboardRabbit';
    rabbitSpan.textContent = player.rabbit ? player.rabbit.label : '';
    rabbitSpan.style.color = player.rabbit ? colorToCSS(player.rabbit.color) : '';
    labelSpan.append(statusSpan, nameSpan, flagSpan, rabbitSpan);

    const statsSpan = document.createElement('span');
    statsSpan.className = 'scoreboardStats';
    // `%2d%% %4d %3d-%-3d` on a Rabbit Chase world (ScoreboardRenderer.cxx:675):
    // upstream puts the rank in front of the score, because the rank is what the
    // board is sorted by and a column nobody can see makes the order look
    // arbitrary.
    //
    // An observer gets neither column, which is upstream's own `if (player
    // ->getTeam() != ObserverTeam)` around both (:829). It cannot kill or die, so
    // `0 / 0` is the absence of a score rather than a score.
    statsSpan.textContent = formatScoreboardStats(player);

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

export function updateShotStatus({ myPlayerId, projectiles, gameConfig, now = Date.now() }) {
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
  // A `display: none` element still returns a rect -- all zeros, and truthy --
  // so testing the object was never enough. While dead the control box is hidden
  // (`client.js` sets it none for the death camera), the zeros put this canvas at
  // `right + width + 16, top - height/2`, and it went to the top left corner
  // wearing whatever it last painted. The bar belongs beside the control box, so
  // when there is no control box to be beside there is no bar: upstream only
  // draws these while playing. See issue #37.
  const boxVisible = Boolean(boxRect) && (boxRect.width > 0 || boxRect.height > 0);
  if (!boxVisible) {
    if (shotStatusRenderState.hidden !== true) {
      shotStatusRenderState.hidden = true;
      shotStatus.style.visibility = 'hidden';
    }
    return;
  }
  if (shotStatusRenderState.hidden !== false) {
    shotStatusRenderState.hidden = false;
    shotStatus.style.visibility = '';
  }
  {
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

  // HUDRenderer.cxx:1988. A bar reads the shot in its own slot and nothing else:
  // an empty slot is 1.0, full, with no global term anywhere in it. Upstream's
  // one global gate -- `jamTime`, set by `forceReload(_reloadTime / numShots)`
  // after every shot -- reaches `getReloadTime()`, and `getReloadTime` feeds the
  // "Reloaded in %.1f" *text* at HUDRenderer.cxx:1012. It never touches the bars.
  //
  // bzo used to apply that gate as a ceiling over every bar, which is what made
  // one shot turn every bar red at once and refill them together: the display
  // said all slots had been fired when one had. See issue #36.
  //
  // Then sorted, as upstream sorts, ascending. The bars are a tally of how ready
  // the slots are and not a row of named slots, so sorting stops a bar jumping
  // between rows as slots are used out of order -- which is the other half of
  // "the first one moves more slowly and then skips ahead".
  slotProgress.sort((a, b) => a - b);

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
