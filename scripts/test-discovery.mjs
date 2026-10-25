#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// What a search engine or an AI reads (`server/discovery.cjs`): the
// structured data parses and says what it should, /help renders the real
// controls doc and every flag, and robots.txt, the sitemap and llms.txt
// point at the pages and nothing else.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const discovery = require('../server/discovery.cjs');
const { FLAG_TYPES, FLAG_QUALITY } = require('../public/js/flags.mjs');

const base = 'https://bz.example.org';
const controlsMarkdown = fs.readFileSync(new URL('../docs/controls.md', import.meta.url), 'utf8');
const context = {
  base,
  name: 'bz.example.org -- Battlezone Online',
  title: 'An example server',
  description: discovery.serverDescription('An example server'),
  version: '1.2.3',
  listServerUrl: 'https://list.example.org',
  controlsMarkdown,
  flagTypes: FLAG_TYPES,
  badQuality: FLAG_QUALITY.BAD,
};

const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
  .map((m) => JSON.parse(m[1]));

// The card and the structured data, with every URL absolute.
{
  const head = discovery.pageHead({
    base, path: '/', title: context.name, description: context.description,
    jsonLd: [discovery.gameJsonLd({ base, name: context.name, description: context.description, version: '1.2.3' })],
  });
  assert.match(head, /<meta property="og:image" content="https:\/\/bz\.example\.org\/icons\/any-512\.png">/);
  assert.match(head, /<link rel="canonical" href="https:\/\/bz\.example\.org\/">/);
  const [game] = ldBlocks(head);
  assert.deepEqual(game['@type'], ['VideoGame', 'WebApplication']);
  assert.equal(game.url, `${base}/`);
  assert.equal(game.isAccessibleForFree, true);
  assert.match(game.description, /This server: An example server\./);
  // A `</script>` in a description cannot end the block early.
  const sneaky = discovery.jsonLdTag({ name: '</script><b>' });
  assert.equal(sneaky.indexOf('</script>'), sneaky.length - '</script>'.length);
}

// Every public server is an entry with its own URL.
{
  const list = discovery.serverListJsonLd({
    base,
    servers: [{ url: 'https://a.example.org', title: 'A', players: 3 }, { url: 'https://b.example.org' }],
  });
  assert.equal(list['@type'], 'ItemList');
  assert.equal(list.numberOfItems, 2);
  assert.deepEqual(list.itemListElement.map((entry) => entry.item.url), ['https://a.example.org', 'https://b.example.org']);
  assert.equal(list.itemListElement[0].item.numberOfPlayers, 3);
}

// /help: the controls doc's own headings and keys, and every flag that is not
// a team's.
{
  const html = discovery.helpPage(context);
  assert.match(html, /<h3 id="keyboard">Keyboard<\/h3>/);
  assert.match(html, /<li><code>Enter<\/code> — shoot<\/li>/);
  assert.match(html, /<code>&#96;<\/code> — toggle debug HUD/, 'a backtick written as a double-backtick span');
  const flags = Object.values(FLAG_TYPES).filter((flag) => flag.team === null || flag.team === undefined);
  for (const flag of flags) assert.ok(html.includes(`<td>${flag.name}</td>`), `${flag.name} listed`);
  assert.equal(ldBlocks(html).length, 1);
  assert.match(html, /<a href="https:\/\/discord\.gg\/6DHkggcXM9">BZFlag Discord<\/a>/);
  assert.doesNotMatch(html, /\/discord\/link/, 'no account link where Linked Roles is off');
  assert.match(discovery.helpPage({ ...context, discordLink: true }), /<a href="\/discord\/link">link your bzflag\.org account<\/a>/);
}

// Markdown the docs use.
{
  const html = discovery.markdownToHtml('# T\n\n1. one\n   more\n2. two\n\n| a | b |\n| --- | --- |\n| `x` | [y](api.md) |\n');
  assert.match(html, /<ol><li>one more<\/li><li>two<\/li><\/ol>/);
  assert.match(html, /<td><code>x<\/code><\/td><td><a href="https:\/\/github\.com\/timriker\/bzo\/blob\/main\/docs\/api\.md">y<\/a><\/td>/);
}

// robots.txt, the sitemap and llms.txt name the pages and keep crawlers off
// the rest.
{
  const robots = discovery.robotsTxt(base);
  assert.match(robots, /^Sitemap: https:\/\/bz\.example\.org\/sitemap\.xml$/m);
  for (const path of ['/api/', '/maps/', '/audio/', '/replays/']) assert.match(robots, new RegExp(`^Disallow: ${path}$`, 'm'));
  const sitemap = discovery.sitemapXml(base, '2026-10-14');
  assert.deepEqual([...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]),
    [`${base}/`, `${base}/list`, `${base}/help`]);
  const llms = discovery.llmsTxt(context);
  assert.match(llms, /^# bz\.example\.org -- Battlezone Online$/m);
  assert.match(llms, /\(https:\/\/list\.example\.org\/api\/list-server\/list\)/);
  const full = discovery.llmsFullTxt(context);
  assert.match(full, /^## Flags$/m);
  assert.match(full, /\| GM \| Guided Missile \| good \|/);
}

console.log('discovery tests passed');
