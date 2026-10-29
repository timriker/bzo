/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import { N_, t, onLocaleChange } from './i18n.mjs';

export const SETTINGS_MENU_ITEMS = Object.freeze([
  { id: 'playerOptionsBtn', label: N_('Player Options'), kind: 'submenu' },
  { id: 'cameraBtn', label: N_('Camera'), kind: 'choice' },
  // `pick` is the one row kind whose two axes mean different things: left and
  // right change *which* player the row is about, select marks or unmarks them.
  // Every other kind does the same thing whichever way you press -- a `choice`
  // steps forward on select, a `toggle` toggles -- so this one wears its
  // chevrons around the value rather than at the row's edges, to say outright
  // that it is not one of those. See getMenuClickZone in menus.js.
  { id: 'huntBtn', label: N_('Hunt'), kind: 'pick' },
  // Left and right choose the pilot, select flies it -- or lands, on `None` or
  // on the one already flying.
  { id: 'autopilotBtn', label: N_('Autopilot'), kind: 'pick' },
  { id: 'radarZoomBtn', label: N_('Radar Range'), kind: 'choice' },
  // Upstream's Options menu has the same row. Automatic follows the browser.
  { id: 'languageBtn', label: N_('Language'), kind: 'choice' },
  { id: 'mouseBtn', label: N_('Mouse Steering'), kind: 'toggle' },
  { id: 'virtualControlsBtn', label: N_('Virtual Controls'), kind: 'toggle' },
  { id: 'rumbleBtn', label: N_('Rumble'), kind: 'toggle' },
  { id: 'fullscreenBtn', label: N_('Fullscreen'), kind: 'toggle' },
  { id: 'installBtn', label: N_('Install App'), kind: 'action' },
  { id: 'debugBtn', label: N_('Debug HUD'), kind: 'toggle' },
  { id: 'debugGeometryBtn', label: N_('Debug Geometry'), kind: 'toggle' },
  { id: 'debugLabelsBtn', label: N_('Debug Labels'), kind: 'toggle' },
  { id: 'wireframeBtn', label: N_('Wireframe'), kind: 'toggle' },
  { id: 'dynamicLightingBtn', label: N_('Dynamic Lighting'), kind: 'toggle' },
  { id: 'anaglyphBtn', label: N_('Anaglyph 3D'), kind: 'toggle' },
  { id: 'audioBtn', label: N_('Audio Settings'), kind: 'submenu' },
  { id: 'helpBtn', label: N_('Help'), kind: 'submenu' },
  { id: 'operatorBtn', label: N_('Operator'), kind: 'submenu' },
  { id: 'viewBtn', label: N_('View'), kind: 'submenu' },
  { id: 'shareViewBtn', label: N_('Share View Link'), kind: 'action' },
  { id: 'xrBtn', label: N_('VR Mode'), kind: 'action' },
  { id: 'closeSettingsHud', label: N_('Close'), kind: 'action' },
]);

function ensureRowContent(button) {
  let label = button.querySelector('.settingsMenuLabel');
  let value = button.querySelector('.settingsMenuValue');
  if (label && value) return { label, value };

  label = document.createElement('span');
  label.className = 'settingsMenuLabel';
  value = document.createElement('span');
  value.className = 'settingsMenuValue';
  button.replaceChildren(label, value);
  return { label, value };
}

function defaultValue(item) {
  if (item.kind === 'submenu') return N_('Open >');
  if (item.id === 'closeSettingsHud') return '';
  if (item.kind === 'action') return N_('Activate');
  return '';
}

// A row's label and value as shown. Toggle, submenu and action values are a
// fixed vocabulary and are translated here; a `choice` or `pick` row's value
// is composed by its owner, who translates the words and leaves any callsign
// in it alone. `state` is the untranslated value, for the On/Off colouring.
export function settingsRowText(item, value) {
  const raw = value ?? defaultValue(item);
  const fixed = item.kind === 'toggle' || item.kind === 'submenu' || item.kind === 'action';
  return { label: t(item.label), value: fixed && raw ? t(raw) : raw, state: raw };
}

// `pick` rows carry their state glyph inside the value, so the On/Off colouring
// below must not try to read them, and the chevrons are drawn by CSS around the
// same span. Kept as a predicate rather than an id list so a second pick row
// needs nothing here.
function isPickRow(item) {
  return item.kind === 'pick';
}

export function initSettingsMenu({ root, getValue, onAdjust }) {
  if (!root) return null;

  const list = root.querySelector('.settingsMenuList');
  const items = SETTINGS_MENU_ITEMS.map((item) => ({
    ...item,
    button: document.getElementById(item.id),
  })).filter((item) => item.button);

  items.forEach((item) => {
    list?.appendChild(item.button);
    item.button.classList.add('settingsMenuRow');
    item.button.dataset.menuRow = item.id;
    item.button.dataset.menuKind = item.kind;
    item.button.setAttribute('role', 'menuitem');
  });

  const refresh = () => {
    items.forEach((item) => {
      const { label, value } = ensureRowContent(item.button);
      const currentValue = typeof getValue === 'function' ? getValue(item.id, item) : undefined;
      const text = settingsRowText(item, currentValue);
      label.textContent = text.label;
      value.textContent = text.value;
      // Only On/Off rows carry a state colour. Rows that read "Open >", "Long"
      // or "First Person" are not on or off, so they keep the neutral styling.
      if (!isPickRow(item) && (text.state === 'On' || text.state === 'Off')) {
        item.button.dataset.menuState = text.state.toLowerCase();
      } else {
        delete item.button.dataset.menuState;
      }
      item.button.setAttribute('aria-label', text.value ? `${text.label}: ${text.value}` : text.label);
    });
  };

  root.addEventListener('click', () => {
    Promise.resolve().then(refresh);
    window.setTimeout(refresh, 150);
  });
  // What a row is worth adjusting to is the input layer's business, not the
  // renderer's; this hands it the row and reports back whether it took it.
  root.addEventListener('menuadjust', (event) => {
    const button = event.target.closest?.('[data-menu-row]');
    if (!button || button.disabled || typeof onAdjust !== 'function') return;
    if (onAdjust(button.dataset.menuRow, event.detail.direction)) {
      event.preventDefault();
      refresh();
    }
  });

  onLocaleChange(refresh);
  refresh();
  return { refresh, items };
}