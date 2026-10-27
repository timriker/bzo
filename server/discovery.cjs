/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

'use strict';

// What a search engine or an AI reads to find out what a bzo server is: the
// structured data and the card on its pages, `/help`, `robots.txt`,
// `sitemap.xml` and `llms.txt` (docs/api.md, "Discovery"). Every instance
// serves its own, from its own config, so each public server can be found
// and described without anybody writing a page for it. Only the pages a
// person or a model reads are offered; images, sounds, models, maps and
// replays are not.

const REPO_URL = 'https://github.com/timriker/bzo';
const DOCS_URL = `${REPO_URL}/blob/main/docs`;
const BZFLAG_URL = 'https://www.bzflag.org/';
const LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';

const GAME_NAME = 'Battlezone Online';
// The BZFlag community's Discord server.
const DISCORD_INVITE_URL = 'https://discord.gg/6DHkggcXM9';
const GAME_DESCRIPTION = 'Battlezone Online (bzo) is a free, open-source 3D'
  + ' multiplayer tank game that runs in the browser -- on a desktop, a phone'
  + ' or a VR headset -- and plays with BZFlag clients and servers.';

// The pages offered, in the order a sitemap and llms.txt list them.
const PAGES = [
  { path: '/', title: 'Play', note: 'the game itself, in the browser; nothing to install' },
  { path: '/list', title: 'Servers', note: 'every public bzo server, and the BZFlag servers' },
  { path: '/help', title: 'Help', note: 'controls and every flag' },
];

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A server's own line about itself, after the game's.
function serverDescription(title) {
  return title ? `${GAME_DESCRIPTION} This server: ${title}.` : GAME_DESCRIPTION;
}

// JSON inside a <script>: `</` would end the element early.
function jsonLdTag(data) {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

// schema.org's own words for the game this server runs.
function gameJsonLd({ base, name, description, version }) {
  return {
    '@context': 'https://schema.org',
    '@type': ['VideoGame', 'WebApplication'],
    name,
    alternateName: ['bzo', GAME_NAME],
    url: `${base}/`,
    description,
    image: `${base}/icons/any-512.png`,
    applicationCategory: 'GameApplication',
    genre: ['Action', 'Tank combat', 'Multiplayer shooter'],
    gamePlatform: ['Web browser', 'VR headset'],
    operatingSystem: 'Any, in a web browser',
    playMode: 'MultiPlayer',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    license: LICENSE_URL,
    softwareVersion: version,
    sameAs: [REPO_URL],
    isBasedOn: { '@type': 'VideoGame', name: 'BZFlag', url: BZFLAG_URL },
  };
}

// The public bzo servers as a list a crawler can follow, one entry each.
function serverListJsonLd({ base, servers }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Public bzo servers',
    url: `${base}/list`,
    numberOfItems: servers.length,
    itemListElement: servers.map((server, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: {
        '@type': ['VideoGame', 'WebApplication'],
        name: server.title || server.url,
        url: server.url,
        ...(server.description ? { description: server.description } : {}),
        ...(Number.isFinite(server.players) ? { numberOfPlayers: server.players } : {}),
      },
    })),
  };
}

// The head every discovery-facing page carries: a description, the Open Graph
// card and the structured data.
function pageHead({ base, path, title, description, jsonLd = [] }) {
  return [
    `<meta name="description" content="${escapeHtml(description)}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${GAME_NAME}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(base + path)}">`,
    `<meta property="og:image" content="${escapeHtml(base)}/icons/any-512.png">`,
    '<meta property="og:image:width" content="512">',
    '<meta property="og:image:height" content="512">',
    `<meta property="og:image:alt" content="The ${GAME_NAME} tank, in green">`,
    '<meta name="twitter:card" content="summary">',
    `<link rel="canonical" href="${escapeHtml(base + path)}">`,
    ...jsonLd.map(jsonLdTag),
  ].join('\n');
}

// Markdown as the docs write it -- headings, lists, numbered lists, tables,
// paragraphs, `code`, **bold** and links -- to HTML, for `/help`. A link to
// another doc goes to it on GitHub; one within the page stays on the page.
function inlineMarkdown(text, docsUrl) {
  let html = escapeHtml(text);
  // A double-backtick span first: it is how a backtick itself is written.
  html = html.replace(/``\s?(.+?)\s?``/g, (whole, code) => `<code>${code.replace(/`/g, '&#96;')}</code>`);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
    const target = href.startsWith('#') || /^[a-z]+:/i.test(href)
      ? href
      : `${docsUrl}/${href.replace(/^\.\//, '')}`;
    return `<a href="${target}">${label}</a>`;
  });
  return html;
}

function slug(text) {
  return text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-');
}

function markdownToHtml(markdown, docsUrl = DOCS_URL) {
  const lines = markdown.split('\n');
  const out = [];
  let i = 0;
  const isBlockStart = (line) => /^(#{1,6} |\s*[-*] |\s*\d+\. |\|)/.test(line) || line.trim() === '';
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const heading = /^(#{1,6}) (.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length + 1);
      out.push(`<h${level} id="${slug(heading[2])}">${inlineMarkdown(heading[2], docsUrl)}</h${level}>`);
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const body = rows.filter((row) => !/^\|[\s:|-]+\|$/.test(row));
      const [head, ...rest] = body;
      out.push('<table>');
      if (head) out.push(`<tr>${cells(head).map((c) => `<th>${inlineMarkdown(c, docsUrl)}</th>`).join('')}</tr>`);
      for (const row of rest) out.push(`<tr>${cells(row).map((c) => `<td>${inlineMarkdown(c, docsUrl)}</td>`).join('')}</tr>`);
      out.push('</table>');
      continue;
    }
    const item = /^\s*([-*]|\d+\.) (.*)$/.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1]);
      const items = [];
      while (i < lines.length) {
        const next = /^\s*([-*]|\d+\.) (.*)$/.exec(lines[i]);
        if (next && /\d/.test(next[1]) === ordered) {
          items.push(next[2]);
          i++;
        } else if (items.length && lines[i].trim() !== '' && /^\s/.test(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i++;
        } else {
          break;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((text) => `<li>${inlineMarkdown(text, docsUrl)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const paragraph = [line.trim()];
    i++;
    while (i < lines.length && !isBlockStart(lines[i])) paragraph.push(lines[i++].trim());
    out.push(`<p>${inlineMarkdown(paragraph.join(' '), docsUrl)}</p>`);
  }
  return out.join('\n');
}

// Every flag but the team flags, good ones first, by name.
function flagRows(flagTypes) {
  return Object.values(flagTypes)
    .filter((flag) => flag.team === null || flag.team === undefined)
    .sort((a, b) => (a.quality - b.quality) || a.name.localeCompare(b.name));
}

function flagTableHtml(flagTypes, badQuality) {
  const rows = flagRows(flagTypes).map((flag) => '<tr>'
    + `<td><code>${escapeHtml(flag.abbreviation)}</code></td>`
    + `<td>${escapeHtml(flag.name)}</td>`
    + `<td>${flag.quality === badQuality ? 'bad' : 'good'}</td>`
    + `<td>${escapeHtml(String(flag.help || '').replace(/\s+/g, ' '))}</td></tr>`);
  return `<table>\n<tr><th>Flag</th><th>Name</th><th>Kind</th><th>What it does</th></tr>\n${rows.join('\n')}\n</table>`;
}

function flagTableMarkdown(flagTypes, badQuality) {
  const rows = flagRows(flagTypes).map((flag) => `| ${flag.abbreviation} | ${flag.name} | `
    + `${flag.quality === badQuality ? 'bad' : 'good'} | ${String(flag.help || '').replace(/\s+/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|')} |`);
  return ['| Flag | Name | Kind | What it does |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

function helpPage({ base, name, description, version, controlsMarkdown, flagTypes, badQuality, discordLink = false }) {
  const title = `Help -- ${name}`;
  const head = pageHead({
    base, path: '/help', title, description,
    jsonLd: [gameJsonLd({ base, name, description, version })],
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${head}
<link rel="icon" sizes="16x16 32x32 48x48" href="/favicon.ico">
<style>
  body { font: 15px/1.5 Arial, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; color: #fff; background: #000; }
  a { color: #81c784; }
  h1, h2, h3, h4 { color: #4caf50; }
  code { background: #1b1b1b; padding: 0 0.25em; border-radius: 3px; }
  table { border-collapse: collapse; margin: 1rem 0; }
  th, td { border: 1px solid #333; padding: 0.3rem 0.5rem; text-align: left; vertical-align: top; }
  th { background: #111; }
  nav { margin-bottom: 1.5rem; }
</style>
</head>
<body>
<h1>${escapeHtml(name)}</h1>
<p>${escapeHtml(description)}</p>
<nav><a href="/">Play</a> · <a href="/list">Servers</a> · <a href="#controls">Controls</a> · <a href="#flags">Flags</a> · <a href="#discord">Discord</a> · <a href="/source">Source</a></nav>
<h2 id="controls">Controls</h2>
${markdownToHtml(controlsMarkdown.replace(/^# .*\n/, ''))}
<h2 id="flags">Flags</h2>
<p>Drive over a flag to pick it up. Good flags help; bad flags hinder, and stay until they shake off, you kill, or you die.
Team flags are captured by carrying an enemy's to your own base.</p>
${flagTableHtml(flagTypes, badQuality)}
<h2 id="discord">Discord</h2>
<p>Talk with other players on the <a href="${DISCORD_INVITE_URL}">BZFlag Discord</a>.${discordLink
    ? ' Once you are there, <a href="/discord/link">link your bzflag.org account</a> for the BZFlag player role,'
      + ' and your callsign as your name there.'
    : ''}</p>
<p>${escapeHtml(GAME_NAME)} ${escapeHtml(version)} · <a href="${REPO_URL}">Source</a>, AGPL-3.0</p>
</body>
</html>
`;
}

// Everything but the pages, and the data an AI may want.
function robotsTxt(base) {
  return [
    'User-agent: *',
    'Allow: /$',
    'Allow: /list',
    'Allow: /help',
    'Allow: /llms.txt',
    'Allow: /llms-full.txt',
    'Allow: /api/list-server/list',
    'Allow: /icons/',
    'Disallow: /api/',
    'Disallow: /login',
    'Disallow: /logout',
    'Disallow: /maps/',
    'Disallow: /replays/',
    'Disallow: /overviews/',
    'Disallow: /audio/',
    'Disallow: /obj/',
    'Disallow: /textures/',
    'Disallow: /vendor/',
    'Disallow: /bzflag/',
    'Disallow: /view',
    'Disallow: /*?',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}

function sitemapXml(base, lastModified) {
  const urls = PAGES.map((page) => `  <url><loc>${escapeHtml(base + page.path)}</loc>`
    + `<lastmod>${lastModified}</lastmod></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

// llms.txt (llmstxt.org): what this is, in Markdown, with where to read more.
function llmsTxt({ base, name, title, listServerUrl }) {
  return `# ${name}

> ${GAME_DESCRIPTION}

This is ${base}/${title ? ` -- ${title}` : ''}.
Anyone can play: open the page, pick a name and you are in the match.

## Pages

${PAGES.map((page) => `- [${page.title}](${base}${page.path}): ${page.note}`).join('\n')}
- [Help as text](${base}/llms-full.txt): this file, with the controls and every flag inlined

## Data

- [Server list](${listServerUrl}/api/list-server/list): JSON, every public bzo server and the BZFlag servers
- [Players here](${base}/api/players): JSON, everyone in the game on this server, live
- [API reference](${DOCS_URL}/api.md): what a poller can ask a bzo server

## Source

- [bzo on GitHub](${REPO_URL}): AGPL-3.0
- [Docs](${REPO_URL}/tree/main/docs): controls, flags, maps, servers, network
- [BZFlag](${BZFLAG_URL}): the game bzo plays with
`;
}

function llmsFullTxt({ controlsMarkdown, flagTypes, badQuality, ...rest }) {
  return `${llmsTxt(rest)}
## Controls

${controlsMarkdown.replace(/^# .*\n/, '').replace(/^(#+) /gm, '#$1 ')}

## Flags

Drive over a flag to pick it up. Good flags help; bad flags hinder, and stay
until they shake off, you kill, or you die. Team flags are captured by carrying
an enemy's to your own base.

${flagTableMarkdown(flagTypes, badQuality)}
`;
}

module.exports = {
  GAME_DESCRIPTION,
  GAME_NAME,
  escapeHtml,
  gameJsonLd,
  helpPage,
  jsonLdTag,
  llmsFullTxt,
  llmsTxt,
  markdownToHtml,
  pageHead,
  robotsTxt,
  serverDescription,
  serverListJsonLd,
  sitemapXml,
};
