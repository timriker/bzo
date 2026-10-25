/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The transcript across a reload: which lines are written down, in what order
// they come back, and what `/savemsgs` hands the browser.

import assert from 'node:assert/strict';
import {
  CHAT_CACHE_LIMIT,
  CHAT_CACHE_TABS,
  CHAT_CACHE_VERSION,
  CHAT_RELOAD_DIVIDER,
  formatChatTimestamp,
  formatTranscript,
  formatTranscriptTimestamp,
  packChatCache,
  transcriptFilename,
  unpackChatCache,
} from '../public/js/chat-cache.mjs';

// The tabs as client.js holds them: one entry object pushed into each tab it
// belongs to, which is what makes identity the way to find its tabs.
function makeTabs() {
  const messages = {
    all: [], chat: [], server: [], misc: [], debug: [],
  };
  let seq = 0;
  const add = (tabs, text, extra = {}) => {
    const entry = {
      text, kind: 'chat', segments: null, ts: 1000 + seq, seq, ...extra,
    };
    seq += 1;
    tabs.forEach((tab) => messages[tab].push(entry));
    return entry;
  };
  return { messages, add };
}

// A line in two tabs is written down once, carrying both.
{
  const { messages, add } = makeTabs();
  add(['chat', 'all'], 'hello');
  const { v, lines } = packChatCache(messages);
  assert.equal(v, CHAT_CACHE_VERSION);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'hello');
  assert.deepEqual(lines[0].tabs, ['all', 'chat']);
}

// The debug tab is not written down at all: those lines are already in
// server.log, and they would otherwise spend the whole budget.
{
  const { messages, add } = makeTabs();
  add(['debug'], '[DBG] texture');
  add(['chat', 'all'], 'hello');
  const { lines } = packChatCache(messages);
  assert.deepEqual(lines.map((line) => line.text), ['hello']);
  assert.ok(!CHAT_CACHE_TABS.includes('debug'));
}

// `seq` is the order, not the tab the line was found in and not `ts` -- a burst
// of chat lands on one millisecond.
{
  const { messages, add } = makeTabs();
  add(['server', 'all'], 'first', { ts: 5 });
  add(['chat', 'all'], 'second', { ts: 5 });
  add(['misc', 'all'], 'third', { ts: 5 });
  const { lines } = packChatCache(messages);
  assert.deepEqual(lines.map((line) => line.text), ['first', 'second', 'third']);
}

// The cap keeps the newest, which is what "what did I miss" means.
{
  const { messages, add } = makeTabs();
  for (let i = 0; i < CHAT_CACHE_LIMIT + 10; i += 1) add(['chat', 'all'], `line ${i}`);
  const { lines } = packChatCache(messages);
  assert.equal(lines.length, CHAT_CACHE_LIMIT);
  assert.equal(lines[lines.length - 1].text, `line ${CHAT_CACHE_LIMIT + 9}`);
  assert.equal(lines[0].text, 'line 10');
}

// A round trip through JSON, which is the only way the cache is ever used.
{
  const { messages, add } = makeTabs();
  add(['chat', 'all'], 'Tim: hi', {
    kind: 'chat',
    segments: [{ text: 'Tim', color: 0xff0000 }, { text: ': hi' }],
  });
  add(['server', 'all'], '[SERVER] rules', { kind: 'server' });
  const restored = unpackChatCache(JSON.parse(JSON.stringify(packChatCache(messages))));
  assert.equal(restored.length, 2);
  assert.deepEqual(restored[0].tabs, ['all', 'chat']);
  assert.deepEqual(restored[0].segments, [{ text: 'Tim', color: 0xff0000 }, { text: ': hi' }]);
  assert.equal(restored[1].kind, 'server');
  assert.equal(restored[1].segments, null);
  assert.equal(restored[1].ts, 1001);
}

// Anything that does not make sense is dropped rather than reaching the
// renderer: a cache from an older shape, a line with no text, a tab that no
// longer exists.
{
  assert.deepEqual(unpackChatCache(null), []);
  assert.deepEqual(unpackChatCache({ v: CHAT_CACHE_VERSION - 1, lines: [{ text: 'x', tabs: ['all'] }] }), []);
  assert.deepEqual(unpackChatCache({ v: CHAT_CACHE_VERSION, lines: 'nope' }), []);
  const kept = unpackChatCache({
    v: CHAT_CACHE_VERSION,
    lines: [
      { text: 'ok', tabs: ['all', 'nosuchtab', 'debug'] },
      { text: 'no tabs', tabs: [] },
      { tabs: ['all'] },
      null,
    ],
  });
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].tabs, ['all']);
  assert.equal(kept[0].kind, 'misc', 'a line with no kind still renders');
  assert.equal(kept[0].ts, null);
}

// `/savemsgs`: upstream's header and rule, the All tab in order, and `-t`
// stamping each line the way `formatTimestamp` mode 2 does.
{
  const at = new Date(2026, 8, 27, 14, 5, 9).getTime();
  assert.equal(formatTranscriptTimestamp(at), '[2026-09-27 14:05:09] ');
  assert.equal(transcriptFilename(at), 'msglog-2026-09-27_14-05-09.txt');

  const plain = formatTranscript([{ text: 'hello', ts: at }], { savedAt: at });
  assert.ok(plain.startsWith('\n---'));
  assert.ok(plain.includes('Messages saved: 2026-09-27 14:05:09'));
  assert.ok(plain.endsWith('hello\n'));
  assert.ok(!plain.includes('[2026-09-27 14:05:09] hello'), 'no stamps without -t');

  const stamped = formatTranscript([{ text: 'hello', ts: at }], { timestamps: true, savedAt: at });
  assert.ok(stamped.endsWith('[2026-09-27 14:05:09] hello\n'));

  // A line with no timestamp -- one restored from a cache that had none -- is
  // still written, without one.
  const mixed = formatTranscript([{ text: 'old' }], { timestamps: true, savedAt: at });
  assert.ok(mixed.endsWith('old\n'));
  assert.equal(formatTranscript([], { savedAt: at }).endsWith('\n\n'), true);
}

// The stamp the chat window draws: upstream's mode 1 for a line from today,
// mode 2 once the line is from another day, and nothing at all for a line that
// came back from a cache with no timestamp in it.
{
  const now = new Date(2026, 8, 29, 9, 0, 0).getTime();
  assert.equal(formatChatTimestamp(new Date(2026, 8, 29, 7, 5, 9).getTime(), now), '[07:05:09] ');
  assert.equal(formatChatTimestamp(new Date(2026, 8, 29, 0, 0, 0).getTime(), now), '[00:00:00] ');
  assert.equal(
    formatChatTimestamp(new Date(2026, 8, 28, 23, 59, 59).getTime(), now),
    '[2026-09-28 23:59:59] ',
  );
  // A year apart is still just another day.
  assert.equal(
    formatChatTimestamp(new Date(2025, 8, 29, 9, 0, 0).getTime(), now),
    '[2025-09-29 09:00:00] ',
  );
  assert.equal(formatChatTimestamp(null, now), '');
  assert.equal(formatChatTimestamp(undefined, now), '');
}

// The reload divider belongs to the reload that drew it. It is not written
// down, and one restored from a cache written before that was true is dropped
// on the way back in, so a tab reloaded all morning shows one divider and not
// a column of them.
{
  const { messages, add } = makeTabs();
  add(['chat', 'all'], 'hello');
  add(['all', 'misc'], CHAT_RELOAD_DIVIDER, { kind: 'misc' });
  add(['chat', 'all'], 'still here');
  const { lines } = packChatCache(messages);
  assert.deepEqual(lines.map((line) => line.text), ['hello', 'still here']);

  const stale = {
    v: CHAT_CACHE_VERSION,
    lines: [
      { text: CHAT_RELOAD_DIVIDER, kind: 'misc', tabs: ['all'] },
      { text: 'hello', kind: 'chat', tabs: ['all'] },
    ],
  };
  assert.deepEqual(unpackChatCache(stale).map((line) => line.text), ['hello']);
}

console.log('chat cache tests passed');
