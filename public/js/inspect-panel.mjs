/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The world viewer's panel (docs/editor-plan.md): what one obstacle is, from
// the world the client already holds, and the block it came from in the map
// file, asked of the server (`/api/world/<hash>/obstacles/<index>/source`);
// or the whole world's summary (`world-summary.mjs`).

import { obstacleTextures } from './world-summary.mjs';
import { failedTextureUrls } from './texture.js';

const SUMMARY_TEXTURES = 20;

const number = (value) => (Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '?');
const triple = (values) => values.map(number).join(' ');
const degrees = (radians) => number(((radians || 0) * 180) / Math.PI);

let panel = null;
let shownKey = null;
// What the panel's own buttons ask the game for: the summary of the world on
// screen, and an obstacle picked from it.
let handlers = { onWorld: null, onPick: null };

export function setInspectHandlers(next) {
  handlers = { ...handlers, ...next };
}

// A texture as a person reads it: a URL without its scheme.
const textureLabel = (texture) => texture.replace(/^(https?:)?\/\//, '');

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
  const textures = obstacleTextures(obs);
  if (textures.length) rows.push(['Textures', textures.map(textureLabel).join('\n')]);
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

function button(text, className, onClick) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

// The panel emptied and titled, with a World button unless it is the world.
function openPanel(titleText, key, { world = false } = {}) {
  const root = ensurePanel();
  shownKey = key;
  root.replaceChildren();
  const title = element('div', 'inspectTitle');
  title.appendChild(element('span', '', titleText));
  const buttons = element('span', 'inspectButtons');
  if (!world && handlers.onWorld) buttons.appendChild(button('World', 'inspectWorldBtn', () => handlers.onWorld()));
  buttons.appendChild(button('\u00d7', 'closeBtn', hideInspectPanel));
  title.appendChild(buttons);
  root.appendChild(title);
  return root;
}

function rowsTable(rows) {
  const table = element('dl', 'inspectRows');
  for (const [label, value] of rows) {
    table.appendChild(element('dt', '', label));
    table.appendChild(element('dd', '', value));
  }
  return table;
}

// `hash` is the world's, null when the client does not know it (then there
// is no source to ask for).
export function showInspectPanel(obs, index, hash) {
  const key = `${hash}/${index}`;
  const root = openPanel(obs.name || `unnamed ${obs.kind || obs.type}`, key);
  const table = rowsTable(describe(obs));
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
      // What the file wrote, where the world has only the result: the shape a
      // mesh was made from, and the materials named.
      const shape = /^\s*(\S+)/.exec(found.text)?.[1]?.toLowerCase();
      const extra = [];
      if (shape && obs.type === 'mesh' && shape !== 'mesh') extra.push(['Shape', shape]);
      const materials = found.materials || [];
      if (materials.length) {
        extra.push(['Materials', materials.map((m) => (m.missing ? `${m.ref} (not defined)`
          : m.name && m.name.toLowerCase() !== m.ref.toLowerCase() ? `${m.ref} (${m.name})` : m.ref)).join('\n')]);
      }
      for (const [label, value] of extra) {
        table.appendChild(element('dt', '', label));
        table.appendChild(element('dd', '', value));
      }
      const blocks = [sourceBlock(found.file, found)];
      // Outermost last, so the block nearest the obstacle reads first.
      found.placedBy.slice().reverse().forEach((group) => blocks.push(sourceBlock('placed by', group)));
      for (const material of materials) {
        if (!material.missing) blocks.push(sourceBlock(`material ${material.name || material.ref}`, material));
      }
      source.replaceWith(...blocks);
    });
}

// The whole world, from `summarizeWorld`, and what the server knows of its
// file. Each of the largest meshes picks that mesh.
export function showWorldSummary(summary, hash) {
  const key = `${hash}/world`;
  const root = openPanel('World', key, { world: true });
  const rows = [['Obstacles', String(summary.obstacles)]];
  for (const [type, count] of summary.types) rows.push([type, String(count)]);
  if (summary.meshFaces) rows.push(['Mesh faces', String(summary.meshFaces)]);
  if (summary.instances) rows.push(['Batched', `${summary.instances} placements of ${summary.templates} definitions`]);
  if (summary.teleporterLinks) rows.push(['Links', String(summary.teleporterLinks)]);
  const zones = Object.entries(summary.zones).filter(([, count]) => count).map(([kind, count]) => `${count} ${kind}`);
  if (zones.length) rows.push(['Zones', zones.join(', ')]);
  if (summary.mapSize) rows.push(['Map size', String(summary.mapSize)]);
  const fileRow = element('div', 'inspectSourceLabel', hash ? 'Reading the map file...' : 'No map file for this world');
  root.appendChild(rowsTable(rows));
  root.appendChild(fileRow);

  if (summary.textures.length) {
    root.appendChild(element('div', 'inspectSourceLabel', `Textures (${summary.textures.length}), by obstacles using each`));
    const list = element('dl', 'inspectRows');
    for (const [texture, uses] of summary.textures.slice(0, SUMMARY_TEXTURES)) {
      list.appendChild(element('dt', '', String(uses)));
      list.appendChild(element('dd', failedTextureUrls.has(texture) ? 'inspectMissing' : '',
        failedTextureUrls.has(texture) ? `${textureLabel(texture)} (failed to load)` : textureLabel(texture)));
    }
    root.appendChild(list);
    if (summary.textures.length > SUMMARY_TEXTURES) {
      root.appendChild(element('div', 'inspectSourceLabel', `${summary.textures.length - SUMMARY_TEXTURES} more`));
    }
  }
  if (summary.largestMeshes.length) {
    root.appendChild(element('div', 'inspectSourceLabel', 'Largest meshes, by faces'));
    const list = element('div', 'inspectPicks');
    for (const mesh of summary.largestMeshes) {
      list.appendChild(button(`${mesh.faces}  ${mesh.name || `unnamed mesh #${mesh.index}`}`, 'inspectPick',
        () => handlers.onPick && handlers.onPick(mesh.index)));
    }
    root.appendChild(list);
  }
  root.hidden = false;
  fitPanel();
  if (!hash) return;
  fetch(`/api/world/${hash}/summary`)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .then((found) => {
      if (shownKey !== key) return;
      if (!found) {
        fileRow.textContent = 'No map file for this world';
        return;
      }
      const fileRows = [['File', `${found.file}, ${found.lines} lines`]];
      if (found.missingTextures.length) fileRows.push(['Missing', found.missingTextures.join('\n')]);
      const parts = [rowsTable(fileRows)];
      if (found.warnings.length) {
        parts.push(element('div', 'inspectSourceLabel', `Warnings (${found.warnings.length})`));
        parts.push(element('pre', 'inspectWarnings', found.warnings.join('\n')));
      }
      fileRow.replaceWith(...parts);
    });
}
