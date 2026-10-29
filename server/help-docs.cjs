/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

'use strict';

// The help pages, `docs/help/*.md`: one source for `/help`, the in-game help
// panel and llms-full.txt (docs/i18n-plan.md, "Help Is Documents"). A page is
// translated a paragraph at a time from `l10n/doc_<locale>.po`, and any
// paragraph without a translation is the English one.
//
// Rendered at request time by discovery's markdown renderer rather than a
// build step, so an edited page shows on the next load, as a catalog does.

const fs = require('fs');
const path = require('path');
const { escapeHtml, markdownToHtml } = require('./discovery.cjs');
const l10n = require('./l10n.cjs');
const { flagHelpGroups } = require('../public/js/flags.mjs');

const HELP_DIR = path.join(__dirname, '..', 'docs', 'help');
// The order the panel and /help list them in.
const HELP_PAGES = Object.freeze(['controls', 'flags', 'scoreboard', 'voice', 'about']);

const sources = new Map();

function pageMarkdown(slug) {
  const file = path.join(HELP_DIR, `${slug}.md`);
  let mtimeMs;
  try {
    ({ mtimeMs } = fs.statSync(file));
  } catch {
    // A missing page is left out rather than failing the rest.
    return null;
  }
  const cached = sources.get(slug);
  if (cached && cached.mtimeMs === mtimeMs) return cached.text;
  const text = fs.readFileSync(file, 'utf8');
  sources.set(slug, { mtimeMs, text });
  return text;
}

function splitTitle(markdown) {
  const match = /^# (.*)\n/.exec(markdown);
  return { title: match ? match[1] : '', body: match ? markdown.slice(match[0].length) : markdown };
}

// The flag list, for `flags.md`'s `<!-- flags -->`. A flag is listed by its
// abbreviation and English name, which is where the abbreviation comes from,
// then by its name and help in the reader's language, from the interface
// catalog that names flags everywhere else (docs/i18n-plan.md, "Not
// Localized"). A team flag's name is in its team's colour, a bad one's in the
// warning colour it wears in the world.
function flagListHtml(t) {
  const out = [];
  for (const group of flagHelpGroups()) {
    out.push(`<h3>${escapeHtml(t(group.title))}</h3>`);
    if (group.help) out.push(`<p>${escapeHtml(t(group.help))}</p>`);
    const items = group.flags.map((flag) => {
      const tone = flag.team ? `flagTeam${flag.team}` : group.kind === 'bad' ? 'flagBad' : 'flagGood';
      const local = t(flag.name);
      return `<li><strong>${escapeHtml(flag.abbreviation)}</strong> — <span class="${tone}">${escapeHtml(flag.name)}</span>`
        + `${local !== flag.name ? ` — ${escapeHtml(local)}` : ''}`
        + `${group.help ? '' : ` — ${escapeHtml(t(flag.help).replace(/\s+/g, ' '))}`}</li>`;
    });
    out.push(`<ul class="flagList">${items.join('')}</ul>`);
  }
  return out.join('\n');
}

// The same list in English Markdown, for llms-full.txt.
function flagListMarkdown() {
  const cell = (text) => String(text).replace(/\s+/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  return flagHelpGroups().map((group) => [
    `## ${group.title}`,
    '',
    ...(group.help ? [group.help, ''] : []),
    group.help ? '| Flag | Name |' : '| Flag | Name | What it does |',
    group.help ? '| --- | --- |' : '| --- | --- | --- |',
    ...group.flags.map((flag) => (group.help
      ? `| ${cell(flag.abbreviation)} | ${cell(flag.name)} |`
      : `| ${cell(flag.abbreviation)} | ${cell(flag.name)} | ${cell(flag.help)} |`)),
  ].join('\n')).join('\n\n');
}

// Each page as `{ slug, title, html }` in `locale`. The panel's copy is
// `live`: under the flag list it leaves the place the client says what this
// server's ricochet rule is, which only the world it is in knows.
function renderPages(locale, { live = false } = {}) {
  const messages = l10n.catalogMessages(locale, 'doc');
  const translate = (text) => messages[text] || text;
  const interfaceMessages = l10n.catalogMessages(locale);
  const t = (text) => interfaceMessages[text] || text;
  const markers = { flags: flagListHtml(t) + (live ? '\n<p id="helpRicochet"></p>' : '') };
  const pages = [];
  for (const slug of HELP_PAGES) {
    const markdown = pageMarkdown(slug);
    if (markdown === null) continue;
    const { title, body } = splitTitle(markdown);
    pages.push({
      slug,
      title: translate(title),
      html: markdownToHtml(body, { translate, markers, pageLinks: HELP_PAGES }),
    });
  }
  return pages;
}

// The language the pages are mostly in: the reader's, where they have been
// translated at all, else English. It is what `<html lang>` should say.
function docLocale(locale) {
  return Object.keys(l10n.catalogMessages(locale, 'doc')).length ? locale : l10n.DEFAULT_LOCALE;
}

// Every page in English, for llms-full.txt.
function helpMarkdown() {
  const markers = { flags: flagListMarkdown() };
  return HELP_PAGES.map(pageMarkdown).filter((text) => text !== null)
    .map((text) => text.replace(/^<!--\s*([\w-]+)\s*-->$/gm, (whole, name) => markers[name] || ''))
    .join('\n');
}

// What a translator translates: each block the renderer would hand
// `translate`, by the same walk, so the two cannot disagree about where a
// paragraph ends.
function extractMessages() {
  const found = [];
  for (const slug of HELP_PAGES) {
    const markdown = pageMarkdown(slug);
    if (markdown === null) continue;
    const { title, body } = splitTitle(markdown);
    const file = `docs/help/${slug}.md`;
    found.push({ msgid: title, file });
    markdownToHtml(body, {
      translate: (text) => {
        // An empty table cell has nothing to translate.
        if (text.trim()) found.push({ msgid: text, file });
        return text;
      },
    });
  }
  return found;
}

module.exports = { HELP_PAGES, docLocale, extractMessages, helpMarkdown, renderPages };
