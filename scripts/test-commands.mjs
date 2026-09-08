/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The server commands' pure half: what a typed line parses to, and what each
// answer looks like. Held against upstream's own formats, because a player who
// types `/uptime` or mistypes `/msg` on a bzfs server should read the same
// sentence here.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  COMMAND_TIER,
  COMMAND_LIST_LINE_LENGTH,
  isCommandLine,
  parseCommandLine,
  parseHelpPrefix,
  formatCommandList,
  formatDuration,
  formatCTime,
  parseMsgCommand,
  formatUnknownCommand,
} = require('../server/commands.cjs');

// Two tiers, which is the whole permission model -- see docs/commands-plan.md
// for why bzo does not port upstream's sixty.
assert.deepEqual(Object.keys(COMMAND_TIER).sort(), ['OPEN', 'OPERATOR']);

// A `/` line is a command whatever channel it was aimed at, which is step 1: it
// is never said out loud.
assert.equal(isCommandLine('/uptime'), true);
assert.equal(isCommandLine('/'), true, 'a bare slash is still a command line, and an unknown one');
assert.equal(isCommandLine('hello'), false);
assert.equal(isCommandLine('say /uptime'), false, 'only a leading slash');
assert.equal(isCommandLine(''), false);
assert.equal(isCommandLine(null), false);

// The name and the rest of the line, with the slash kept so it reads the same
// here as in the help and the log.
assert.deepEqual(parseCommandLine('/uptime'), { name: '/uptime', args: '' });
assert.deepEqual(parseCommandLine('/msg bob hi there'), { name: '/msg', args: 'bob hi there' });
assert.deepEqual(parseCommandLine('/MSG Bob hi'), { name: '/msg', args: 'Bob hi' },
  'the name is matched case-insensitively, the arguments are not touched');
assert.deepEqual(parseCommandLine('/uptime   '), { name: '/uptime', args: '' });
// Interior whitespace in the arguments survives, since a message is made of it.
// The whole rest of the line is the argument string; splitting it is each
// command's own business.
assert.deepEqual(parseCommandLine('/msg bob a  b'), { name: '/msg', args: 'bob a  b' });
assert.equal(parseCommandLine('hello'), null);

// CmdHelp (commands.cxx:476): `/co?` is the help for every command starting with
// `co`, which is the only per-command help either bzo or upstream has.
assert.equal(parseHelpPrefix('/msg?'), '/msg');
assert.equal(parseHelpPrefix('/SE?'), '/se');
assert.equal(parseHelpPrefix('/?'), '/', 'a bare `/?` parses, and the caller prefers the command of that name');
assert.equal(parseHelpPrefix('/msg? bob'), null, 'the `?` has to end the line');
assert.equal(parseHelpPrefix('/msg'), null);
assert.equal(parseHelpPrefix('nope?'), null);

// CmdList's column layout (commands.cxx:490). Padded to the longest name plus
// two, as many columns as fit the line, and filled **down** each column so the
// names read alphabetically top to bottom rather than left to right.
{
  const names = ['/?', '/date', '/help', '/msg', '/serverquery', '/time', '/uptime'];
  const lines = formatCommandList(names);
  // '/serverquery' is 12, so the column is 14 and 64/14 is 4 columns, 2 rows.
  assert.deepEqual(lines, [
    '/?            /help         /serverquery  /uptime',
    '/date         /msg          /time',
  ]);
  // Down the columns: the first row is items 0, 2, 4, 6 of the sorted list.
  const sorted = [...names].sort();
  assert.equal(lines[0].trim().split(/\s+/)[1], sorted[2]);
  // Nothing is lost and nothing is repeated.
  assert.deepEqual(lines.join(' ').split(/\s+/).sort(), sorted);
  // No trailing padding: these go out as chat strings, not into a fixed buffer.
  assert.ok(lines.every((line) => line === line.trimEnd()));

  assert.deepEqual(formatCommandList([]), []);
  assert.deepEqual(formatCommandList(['/a']), ['/a']);
  // A name wider than the line still gets a column of its own rather than none.
  assert.deepEqual(formatCommandList(['/' + 'x'.repeat(80)]), ['/' + 'x'.repeat(80)]);
  assert.equal(COMMAND_LIST_LINE_LENGTH, 64, "upstream's maxLineLen");
}

// TimeKeeper::printTime (TimeKeeper.cxx:301). Whole units, largest first, comma
// separated, and a unit that is zero is left out entirely.
assert.equal(formatDuration(0), '', 'upstream prints nothing for less than a second');
assert.equal(formatDuration(1), '1 sec');
assert.equal(formatDuration(2), '2 secs');
assert.equal(formatDuration(60), '1 min');
assert.equal(formatDuration(61), '1 min, 1 sec');
assert.equal(formatDuration(3600), '1 hour', 'not "1 hour, 0 mins, 0 secs"');
assert.equal(formatDuration(3661), '1 hour, 1 min, 1 sec');
assert.equal(formatDuration(86400), '1 day');
assert.equal(formatDuration(90061), '1 day, 1 hour, 1 min, 1 sec');
assert.equal(formatDuration(172800), '2 days');
// Fractions of a second are dropped rather than rounded, as `(long int)raw` is.
assert.equal(formatDuration(1.9), '1 sec');
assert.equal(formatDuration(-5), '', 'a clock that went backwards says nothing');
assert.equal(formatDuration('nonsense'), '');

// DateTimeCommand (commands.cxx:418) sends `ctime()` cut to 24 characters, which
// is C's fixed-width `Www Mmm dd hh:mm:ss yyyy`.
{
  const stamp = formatCTime(new Date(2026, 8, 8, 11, 52, 20));
  assert.equal(stamp, 'Tue Sep  8 11:52:20 2026');
  assert.equal(stamp.length, 24, 'ctime is fixed width, which is why upstream can cut at 24');
  // The day of the month is space padded, not zero padded -- that is what keeps
  // the width fixed at 24 for both one and two digit days.
  assert.equal(formatCTime(new Date(2026, 8, 18, 1, 2, 3)), 'Fri Sep 18 01:02:03 2026');
  assert.equal(formatCTime(new Date(2026, 8, 18, 1, 2, 3)).length, 24);
  assert.equal(formatCTime(new Date(2026, 0, 1, 0, 0, 0)), 'Thu Jan  1 00:00:00 2026');
  assert.equal(formatCTime(new Date(2026, 11, 31, 23, 59, 59)), 'Thu Dec 31 23:59:59 2026');
}

// MsgCommand (commands.cxx:916), including upstream's error wording.
{
  const usage = 'Usage: /msg "some callsign" some message';
  const roster = { bob: '1', 'ann lee': '2' };
  const resolve = (callsign) => roster[callsign.trim().toLowerCase()] ?? null;
  const channels = { ADMIN: -3, TEAM: -2 };
  const msg = (args) => parseMsgCommand(args, resolve, channels);

  assert.deepEqual(msg('bob hi there'), { to: '1', text: 'hi there' });
  assert.deepEqual(msg('BOB hi'), { to: '1', text: 'hi' }, 'the roster resolves case-insensitively');
  // A quoted callsign is how a name with a space in it is addressed.
  assert.deepEqual(msg('"ann lee" hello'), { to: '2', text: 'hello' });
  // And unquoted still works when the player is here: upstream walks forward to
  // the first space that leaves a name it can resolve.
  assert.deepEqual(msg('ann lee hello'), { to: '2', text: 'hello' });
  // Interior spacing in the message survives, in both branches: upstream takes
  // the message as a substring and splitting on whitespace would collapse it.
  assert.deepEqual(msg('bob a  b'), { to: '1', text: 'a  b' });
  assert.deepEqual(msg('"ann lee" a  b'), { to: '2', text: 'a  b' });
  assert.deepEqual(msg('ann lee a  b'), { to: '2', text: 'a  b' });
  assert.deepEqual(msg('>admin a  b'), { to: -3, text: 'a  b' });

  // `>admin` and `>team` name a channel instead of a player.
  assert.deepEqual(msg('>admin something'), { to: -3, text: 'something' });
  assert.deepEqual(msg('>TEAM something'), { to: -2, text: 'something' });
  assert.deepEqual(msg('>nonsense hi'), { error: '">nonsense" is not here.  No such callsign.' });

  // Upstream's sentences, two spaces after the full stop and all.
  assert.deepEqual(msg('ghost hi'), { error: '"ghost" is not here.  No such callsign.' });
  assert.deepEqual(msg(''), { error: usage });
  assert.deepEqual(msg('bob'), { error: usage }, 'a callsign with nothing to send');
  assert.deepEqual(msg('>admin'), { error: usage });
  // "Quote mismatch?" comes with the usage line after it, which is upstream's
  // pair -- the caller sends both.
  assert.deepEqual(msg('"bob hi'), { error: 'Quote mismatch?', alsoUsage: true });
  assert.deepEqual(msg('"" hi'), { error: usage }, 'an empty quoted callsign is no callsign');
}

// parseServerCommand's last word (commands.cxx:3909). The slash is dropped and
// the arguments are kept, so a player reads back what they typed.
assert.equal(formatUnknownCommand('/kick bob please'), 'Unknown command [kick bob please]');
assert.equal(formatUnknownCommand('/nope'), 'Unknown command [nope]');
assert.equal(formatUnknownCommand('/'), 'Unknown command []');

console.log('server command tests passed');
