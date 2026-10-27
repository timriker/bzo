#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The pure halves of the bzfs client: what a proxied connection decodes off
// the wire, and what it is allowed to say back. Everything else in
// `bzfs-session.cjs` needs a server to talk to; these do not.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  toBzfsChatText,
  splitBzfsChat,
  CHAT_TEXT_MAX,
  decodePlayerInfo,
  decodeScores,
  decodeCapture,
  decodeShotEnd,
} = require('../server/bzfs-session.cjs');
const { bzdbIsTrue } = require('../public/js/bzdb.mjs');
const { decodeSetVars } = require('../server/remote-world-import.cjs');

// A chat line is read a byte at a time by `isSpamOrGarbage` and every byte is
// asked `TextUtils::isVisible`, whose character classes stop at 126 -- so one
// accent is a kick for "a garbage message". The accents come off instead.
assert.equal(
  toBzfsChatText('Las banderas malas están sobre almohadillas oscuras.'),
  'Las banderas malas estan sobre almohadillas oscuras.',
);
assert.equal(toBzfsChatText('naïve café piñata über'), 'naive cafe pinata uber');
// Plain ASCII is untouched, which is what lets the caller tell whether it had
// to change anything.
assert.equal(toBzfsChatText('/flag show'), '/flag show');
assert.equal(toBzfsChatText('score: 3-1 (50%) [ok]'), 'score: 3-1 (50%) [ok]');
// Anything with no ASCII spelling at all is dropped rather than sent.
assert.equal(toBzfsChatText('日本語'), '');
assert.equal(toBzfsChatText('hi 🙂 there'), 'hi  there');
// Control characters go too: a newline in a chat line is not visible either.
assert.equal(toBzfsChatText('one\ntwo\ttab'), 'onetwotab');

// MsgPlayerInfo: a count, then id and the three `PlayerAttribute` bits.
{
  const payload = Buffer.from([2, 3, 0b011, 7, 0b101]);
  assert.deepEqual(decodePlayerInfo(payload), [
    { id: 3, registered: true, verified: true, admin: false },
    { id: 7, registered: true, verified: false, admin: true },
  ]);
}

// MsgScore: a count, then id and `Score::pack`.
{
  const payload = Buffer.alloc(1 + 7);
  payload.writeUInt8(1, 0);
  payload.writeUInt8(4, 1);
  payload.writeUInt16BE(9, 2);
  payload.writeUInt16BE(2, 4);
  payload.writeUInt16BE(1, 6);
  assert.deepEqual(decodeScores(payload), [{ id: 4, wins: 9, losses: 2, tks: 1 }]);
}

// MsgCaptureFlag: who, which slot, and whose territory it went into.
{
  const payload = Buffer.alloc(5);
  payload.writeUInt8(6, 0);
  payload.writeUInt16BE(3, 1);
  payload.writeUInt16BE(1, 3);
  assert.deepEqual(decodeCapture(payload), { id: 6, index: 3, team: 1 });
}

// MsgShotEnd: the shot id is a slot in its low byte and a counter in its high.
{
  const payload = Buffer.alloc(5);
  payload.writeUInt8(2, 0);
  payload.writeUInt16BE((3 & 0xff) | (5 << 8), 1);
  payload.writeUInt16BE(1, 3);
  assert.deepEqual(decodeShotEnd(payload), { player: 2, id: (5 << 8) | 3, reason: 1 });
}

// MsgEnter's first field is the PlayerType: a person unless asked otherwise,
// and a robot tank (`ComputerPlayer`) for a bot.
{
  const { buildEnterPayload, TANK_PLAYER, COMPUTER_PLAYER } = require('../server/remote-world-import.cjs');
  assert.equal(buildEnterPayload().readUInt16BE(0), TANK_PLAYER);
  assert.equal(buildEnterPayload({ type: COMPUTER_PLAYER }).readUInt16BE(0), 1);
}

// BZDB.isTrue, which is how bzfs reads `_disableBots` -- and `-disableBots`
// sets it to "true", not 1.
for (const on of ['true', '1', 'yes', 'on', '']) assert.equal(bzdbIsTrue(on), true, `"${on}" is on`);
for (const off of ['0', 'false', 'FALSE', 'no', 'off', 'disable']) assert.equal(bzdbIsTrue(off), false, `"${off}" is off`);
assert.equal(bzdbIsTrue(undefined), false, 'unset is off');

// A long chat line goes out as several, broken between words (#169).
assert.equal(CHAT_TEXT_MAX, 127, 'MessageLen less its NUL');
assert.deepEqual(splitBzfsChat('short line'), ['short line'], 'a line that fits is one message');
assert.deepEqual(splitBzfsChat(''), [], 'nothing to say is no message');
{
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const pieces = splitBzfsChat(words);
  assert.ok(pieces.length > 1, 'a long line is split');
  for (const piece of pieces) {
    assert.ok(piece.length <= CHAT_TEXT_MAX, `a piece fits: ${piece.length}`);
    assert.equal(piece, piece.trim(), 'no piece starts or ends with a space');
  }
  assert.equal(pieces.join(' '), words, 'every word arrives, in order, none cut');
}
assert.deepEqual(splitBzfsChat('aaaa bbbb cccc', 9), ['aaaa bbbb', 'cccc'], 'breaks at the last space that fits');
assert.deepEqual(splitBzfsChat('x'.repeat(20), 8), ['xxxxxxxx', 'xxxxxxxx', 'xxxx'], 'one word longer than a message is cut');
assert.deepEqual(splitBzfsChat('aaaa bbbb', 4), ['aaaa', 'bbbb'], 'a space exactly at the limit breaks there');

// MsgSetVar as `PackVars` writes it: each length a uint8, each string whole --
// so a value of 342 says 86 (PackVars.h:68-71).
{
  const setVars = (pairs) => {
    const count = Buffer.alloc(2);
    count.writeUInt16BE(pairs.length);
    return Buffer.concat([count, ...pairs.flatMap(([name, value]) => [
      Buffer.from([name.length & 0xff]), Buffer.from(name, 'latin1'),
      Buffer.from([value.length & 0xff]), Buffer.from(value, 'latin1'),
    ])]);
  };
  const long = 'x'.repeat(100) + 'y'.repeat(242);
  const warnings = [];
  const vars = decodeSetVars(setVars([['_gravity', '-9.8'], ['_motd', long], ['_tankSpeed', '25']]),
    new Map(), (text) => warnings.push(text));
  assert.equal(vars.get('_gravity'), '-9.8', 'the var before it');
  assert.equal(vars.get('_tankSpeed'), '25', 'the var after it, read at the right place');
  assert.equal(vars.get('_motd'), long.slice(0, 255), 'the long one, truncated');
  assert.equal(warnings.length, 1, 'and said so');
  assert.match(warnings[0], /_motd is 342 characters/);

  const last = decodeSetVars(setVars([['_a', '1'], ['_motd', long]]), new Map(), () => {});
  assert.equal(last.get('_motd').length, 255, 'a long value last in the packet');

  const broken = [];
  const partial = decodeSetVars(Buffer.from([0, 2, 2, 0x5f, 0x61, 1, 0x31, 9]), new Map(), (text) => broken.push(text));
  assert.equal(partial.get('_a'), '1', 'what parses is kept');
  assert.equal(broken.length, 1, 'a packet nothing can read is a warning, not a throw');
}

console.log('bzfs session tests passed');
