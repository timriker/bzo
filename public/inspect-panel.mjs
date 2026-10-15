/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The world viewer's panel (docs/editor-plan.md): what one obstacle is, from
// the world the client already holds, and the block it came from in the map
// file, asked of the server (`/api/world/<hash>/obstacles/<index>/source`).

const number = (value) => (Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '?');
const triple = (values) => values.map(number).join(' ');
const degrees = (radians) => number(((radians || 0) * 180) / Math.PI);

let panel = null;
let shownKey = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Down to just above chat, or with chat closed to the bottom of the screen,
// keeping the margin chat keeps there.
function fitPanel() {
  if (!panel || panel.hidden) return;
  const margin = parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue('--hud-edge')) || 10;
  const chat = document.getElementById('chatBody');
  const chatOpen = chat && !document.body.classList.contains('chat-collapsed') && chat.offsetParent !== null;
  const bottom = chatOpen ? chat.getBoundingClientRect().top - margin : window.innerHeight - margin;
  panel.style.maxHeight = `${Math.max(120, bottom - panel.getBoundingClientRect().top)}px`;
}

function ensurePanel() {
  if (panel) return panel;
  panel = element('div', 'inspectPanel');
  panel.id = 'inspectPanel';
  panel.hidden = true;
  document.body.appendChild(panel);
  window.addEventListener('resize', fitPanel);
  new window.MutationObserver(fitPanel).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return panel;
}

// What the world says about an obstacle, as rows of label and value.
function describe(obs) {
  const rows = [['Type', obs.kind || obs.type]];
  if (obs.type === 'mesh') {
    const b = obs.bounds;
    if (b) rows.push(['Bounds', `${triple([b.minX, b.minY, b.minZ])} to ${triple([b.maxX, b.maxY, b.maxZ])}`]);
    rows.push(['Faces', String(obs.arrays?.faceCount ?? obs.faces?.length ?? '?')]);
  } else {
    if (obs.pos) rows.push(['Position', triple(obs.pos)]);
    if (obs.size) rows.push(['Size', triple(obs.size)]);
    rows.push(['Rotation', degrees(obs.angle)]);
  }
  if (obs.team !== undefined && obs.team !== null) rows.push(['Team', String(obs.team)]);
  const passes = ['driveThrough', 'shootThrough', 'ricochet'].filter((field) => obs[field]);
  if (obs.inverted) passes.push('inverted');
  if (passes.length) rows.push(['Flags', passes.join(' ').toLowerCase()]);
  const textures = new Set();
  if (obs.texture) textures.add(obs.texture);
  for (const material of obs.arrays?.materials || []) {
    if (material?.texture) textures.add(material.texture);
  }
  if (textures.size) rows.push(['Textures', [...textures].join(' ')]);
  if (obs.phydrv !== undefined && obs.phydrv !== null) rows.push(['Physics', String(obs.phydrv)]);
  return rows;
}

function sourceBlock(label, block) {
  const wrap = element('div', 'inspectSource');
  const lines = block.startLine === block.endLine
    ? `line ${block.startLine}` : `lines ${block.startLine}-${block.endLine}`;
  wrap.appendChild(element('div', 'inspectSourceLabel', `${label} ${lines}`));
  const pre = element('pre', '', block.text);
  wrap.appendChild(pre);
  if (block.moreLines) wrap.appendChild(element('div', 'inspectSourceLabel', `${block.moreLines} more lines`));
  return wrap;
}

export function hideInspectPanel() {
  if (panel) panel.hidden = true;
  shownKey = null;
}

export function isInspectPanelShown() {
  return !!panel && !panel.hidden;
}

// `hash` is the world's, null when the client does not know it (then there
// is no source to ask for).
export function showInspectPanel(obs, index, hash) {
  const root = ensurePanel();
  const key = `${hash}/${index}`;
  shownKey = key;
  root.replaceChildren();
  const title = element('div', 'inspectTitle');
  title.appendChild(element('span', '', obs.name || `unnamed ${obs.kind || obs.type}`));
  const close = element('button', 'closeBtn', '×');
  close.type = 'button';
  close.addEventListener('click', hideInspectPanel);
  title.appendChild(close);
  root.appendChild(title);
  const table = element('dl', 'inspectRows');
  for (const [label, value] of describe(obs)) {
    table.appendChild(element('dt', '', label));
    table.appendChild(element('dd', '', value));
  }
  root.appendChild(table);
  const source = element('div', 'inspectSourceLabel', hash ? 'Reading the map file...' : 'No map file for this world');
  root.appendChild(source);
  root.hidden = false;
  fitPanel();
  if (!hash) return;
  fetch(`/api/world/${hash}/obstacles/${index}/source`)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .then((found) => {
      if (shownKey !== key) return;
      if (!found) {
        source.textContent = 'No source for this obstacle';
        return;
      }
      const blocks = [sourceBlock(found.file, found)];
      // Outermost last, so the block nearest the obstacle reads first.
      found.placedBy.slice().reverse().forEach((group) => blocks.push(sourceBlock('placed by', group)));
      source.replaceWith(...blocks);
    });
}
