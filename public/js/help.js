/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The help panel: the pages in docs/help/, as /help.json renders them in the
// player's language, one at a time with a button for each, and a search over
// all of them. Fetched the first time the panel opens rather than at load,
// since most sessions never open it.

import { getLocale, onLocaleChange, t } from './i18n.mjs';

let pages = null;
let loading = null;
let currentSlug = null;
let onPageShown = () => {};

const nav = () => document.getElementById('helpNav');
const content = () => document.getElementById('helpContent');
const search = () => document.getElementById('helpSearch');

function pageButton(page) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'settingsHudBtn';
  button.dataset.helpPage = page.slug;
  button.textContent = page.title;
  button.addEventListener('click', () => showPage(page.slug));
  return button;
}

function renderNav() {
  nav().querySelectorAll('[data-help-page]').forEach((button) => button.remove());
  const field = search();
  for (const page of pages) nav().insertBefore(pageButton(page), field);
}

export function showPage(slug, anchor = null) {
  if (!pages) return;
  const page = pages.find((entry) => entry.slug === slug) || pages[0];
  currentSlug = page.slug;
  const heading = document.createElement('h2');
  heading.textContent = page.title;
  const body = document.createElement('div');
  // Our own markdown, rendered by our own server; nothing a player wrote.
  body.innerHTML = page.html;
  content().replaceChildren(heading, body);
  for (const button of nav().querySelectorAll('[data-help-page]')) {
    if (button.dataset.helpPage === page.slug) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  onPageShown(content());
  const found = anchor && document.getElementById(anchor);
  const target = found && content().contains(found) ? found : null;
  if (target) {
    target.scrollIntoView({ block: 'start' });
  } else {
    // The panel or its content scrolls, depending on the screen.
    document.getElementById('helpPanel').scrollTop = 0;
    content().scrollTop = 0;
  }
}

// Every heading, paragraph, item and row that holds the words, from every
// page, each opening its page at that spot.
function showResults(query) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    showPage(currentSlug);
    return;
  }
  const results = [];
  for (const page of pages) {
    const scratch = document.createElement('div');
    scratch.innerHTML = page.html;
    let lastId = null;
    for (const element of scratch.querySelectorAll('h3, h4, h5, p, li, tr')) {
      if (element.id) lastId = element.id;
      if (!element.textContent.toLowerCase().includes(needle)) continue;
      results.push({ page, anchor: element.id || lastId, text: element.textContent.replace(/\s+/g, ' ').trim() });
    }
  }
  const list = results.map(({ page, anchor, text }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settingsHudBtn helpResult';
    button.textContent = `${page.title}: ${text.length > 140 ? `${text.slice(0, 140)}…` : text}`;
    button.addEventListener('click', () => {
      search().value = '';
      showPage(page.slug, anchor);
    });
    return button;
  });
  const summary = document.createElement('p');
  summary.textContent = results.length ? '' : t('Nothing found');
  content().replaceChildren(summary, ...list);
}

async function load() {
  const response = await fetch(`/help.json?lang=${encodeURIComponent(getLocale())}`);
  if (!response.ok) throw new Error(`help: HTTP ${response.status}`);
  pages = (await response.json()).pages;
  renderNav();
  showPage(currentSlug);
}

// Called as the panel opens. A failed fetch is tried again on the next open.
export function ensureHelpLoaded() {
  if (pages || loading) return loading;
  loading = load()
    .catch((error) => {
      content().textContent = t('Help is unavailable: {error}', { error: error.message });
    })
    .finally(() => { loading = null; });
  return loading;
}

// `onShown(container)` runs after each page is put in the panel, which is how
// the flag list -- built from the world the player is in -- finds its place.
export function initHelpPanel({ onShown }) {
  onPageShown = onShown;
  // A link to another page, or within one, stays in the panel.
  content().addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    const page = /^\/help\/([\w-]+)(?:#(.*))?$/.exec(href);
    if (page) {
      event.preventDefault();
      showPage(page[1], page[2] || null);
    } else if (href.startsWith('#')) {
      event.preventDefault();
      showPage(currentSlug, href.slice(1));
    } else {
      link.target = '_blank';
      link.rel = 'noopener';
    }
  });
  search().addEventListener('input', () => {
    if (pages) showResults(search().value);
  });
  onLocaleChange(() => {
    if (!pages) return;
    pages = null;
    ensureHelpLoaded();
  });
}
