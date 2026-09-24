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
  parsePlayerTarget,
  parseBearing,
  parseFacing,
  bearingToRotation,
  rotationToBearingName,
  parseMoveCoordinates,
  formatFlagInfo,
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

// Upstream's target syntax, `<#slot|PlayerName|"Player Name">` (BanCommands.cxx
// :191), shared by /kick, /kill, /mute and /mv.
{
  const roster = { bob: '1', 'ann lee': '2' };
  const byName = (callsign) => roster[callsign.trim().toLowerCase()] ?? null;
  const byId = (slot) => (Object.values(roster).includes(String(slot)) ? String(slot) : null);
  const target = (args) => parsePlayerTarget(args, byName, byId);

  assert.deepEqual(target('bob'), { id: '1', rest: '' });
  assert.deepEqual(target('bob and a reason'), { id: '1', rest: 'and a reason' });
  assert.deepEqual(target('"ann lee" a reason'), { id: '2', rest: 'a reason' });
  // A slot is bzo's player id, which is what `#` means here.
  assert.deepEqual(target('#2 hello'), { id: '2', rest: 'hello' });
  assert.deepEqual(target('#9'), { error: 'player #9 is not here' });
  assert.deepEqual(target('ghost'), { error: '"ghost" is not here.  No such callsign.' });
  assert.deepEqual(target('"bob'), { error: 'Quote mismatch?' });
  // Nothing at all is the caller's usage message to give, not this one's.
  assert.deepEqual(target(''), { error: null });
  assert.deepEqual(target('   '), { error: null });
  // The rest keeps its own spacing, as a reason or a message would.
  assert.deepEqual(target('bob a  b'), { id: '1', rest: 'a  b' });
}

// A facing for /mv, as one of the eight compass points and nothing else. A
// number is refused on purpose: bzo's rotation runs anticlockwise from north and
// a bearing runs clockwise, so 90 is ambiguous in the one direction that matters.
{
  assert.equal(parseBearing('n'), 0);
  assert.equal(parseBearing('N'), 0);
  assert.equal(parseBearing('north'), 0);
  assert.equal(parseBearing('e'), 90);
  assert.equal(parseBearing('s'), 180);
  assert.equal(parseBearing('w'), 270);
  assert.equal(parseBearing('ne'), 45);
  assert.equal(parseBearing('sw'), 225);
  // Numbers are not directions here, however plausible they look.
  assert.equal(parseBearing('0'), null);
  assert.equal(parseBearing('90'), null);
  assert.equal(parseBearing('270'), null);
  assert.equal(parseBearing('sideways'), null);
  assert.equal(parseBearing(''), null);
  assert.equal(parseBearing(null), null);

  // bzo faces -Z at 0 and turns toward -X, so rotation runs anticlockwise from
  // north while a compass bearing runs clockwise. These are AGENTS.md's own four
  // values, and the reason a number would have needed explaining.
  const rad = (deg) => Number(bearingToRotation(deg).toFixed(4));
  assert.equal(rad(0), 0, 'north');
  assert.equal(rad(90), Number((3 * Math.PI / 2).toFixed(4)), 'east is 3pi/2');
  assert.equal(rad(180), Number(Math.PI.toFixed(4)), 'south is pi');
  assert.equal(rad(270), Number((Math.PI / 2).toFixed(4)), 'west is pi/2');

  // And back again, for the echo. Round trips through all eight points.
  for (const [deg, name] of [[0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
    [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW']]) {
    assert.equal(rotationToBearingName(bearingToRotation(deg)), name, `${deg} is ${name}`);
  }
  // A rotation between points takes the nearer one, since it is a label.
  assert.equal(rotationToBearingName(bearingToRotation(10)), 'N');
  assert.equal(rotationToBearingName(bearingToRotation(80)), 'E');
}

// /mv's grammar, which is bzo's own -- upstream has no command that moves a tank.
{
  const usage = 'Usage: /mv [player] <x,z|x,y,z|x,y,z,facing> [facing]';
  const notADirection = (token) =>
    `"${token}" is not a direction (n, ne, e, se, s, sw, w, nw) or an angle in degrees`;
  // Two numbers leave the height out, which is the form worth typing.
  assert.deepEqual(parseMoveCoordinates('0,0'), { x: 0, y: null, z: 0, rotation: null });
  assert.deepEqual(parseMoveCoordinates('100,-100'), { x: 100, y: null, z: -100, rotation: null });
  // Three is x,y,z -- the order the rest of bzo writes a position in, so the
  // second number never changes meaning between forms.
  assert.deepEqual(parseMoveCoordinates('0,30,0'), { x: 0, y: 30, z: 0, rotation: null });
  // A facing in the list needs all three coordinates before it, which is what
  // makes the fourth slot unambiguous.
  assert.deepEqual(parseMoveCoordinates('0,30,0,s'),
    { x: 0, y: 30, z: 0, rotation: bearingToRotation(180) });
  assert.deepEqual(parseMoveCoordinates('0,0,0,nw'),
    { x: 0, y: 0, z: 0, rotation: bearingToRotation(315) });
  // A bearing has a slot of its own as well, which is where a letter goes.
  assert.deepEqual(parseMoveCoordinates('0,0 n'),
    { x: 0, y: null, z: 0, rotation: bearingToRotation(0) });
  assert.deepEqual(parseMoveCoordinates('0,0 e'),
    { x: 0, y: null, z: 0, rotation: bearingToRotation(90) });
  assert.deepEqual(parseMoveCoordinates('0,30,0 s'),
    { x: 0, y: 30, z: 0, rotation: bearingToRotation(180) });
  // A trailing facing wins over one in the list, being the later word.
  assert.deepEqual(parseMoveCoordinates('0,0,0,n s'),
    { x: 0, y: 0, z: 0, rotation: bearingToRotation(180) });
  // Decimals and negatives, since a coordinate read off a log has both.
  assert.deepEqual(parseMoveCoordinates('-12.5,3.25'),
    { x: -12.5, y: null, z: 3.25, rotation: null });
  // Spacing around the commas is forgiven; a missing value is not.
  assert.deepEqual(parseMoveCoordinates('0, 0'), { error: usage },
    'a space splits the tokens, so this reads as coordinates and a bearing');
  assert.deepEqual(parseMoveCoordinates('0,,0'), { error: usage });
  assert.deepEqual(parseMoveCoordinates('0'), { error: usage }, 'one number is not a position');
  assert.deepEqual(parseMoveCoordinates('1,2,3,4,5'), { error: usage });
  assert.deepEqual(parseMoveCoordinates('a,b'), { error: usage });
  assert.deepEqual(parseMoveCoordinates(''), { error: usage });
  assert.deepEqual(parseMoveCoordinates('0,0 sideways'), { error: notADirection('sideways') });
  assert.deepEqual(parseMoveCoordinates('0,0 n extra'), { error: usage });
}

// A facing may be an exact angle, so a Share View Link's `pos=` tail pastes
// straight into /mv (issue #109). The number is bzo's own rotation in degrees,
// which is what the link writes and what `readViewPosTarget` reads back.
{
  const deg = (degrees) => ((degrees % 360) + 360) % 360 * Math.PI / 180;
  // The issue's own example, whole.
  assert.deepEqual(parseMoveCoordinates('-320.0,0.0,-310.3,-91.3'),
    { x: -320, y: 0, z: -310.3, rotation: deg(-91.3) });
  // And in the slot of its own, where a letter also goes.
  assert.deepEqual(parseMoveCoordinates('0,0 -91.3'), { x: 0, y: null, z: 0, rotation: deg(-91.3) });

  // The two conventions agree at north and south and disagree at the quarters:
  // bzo's rotation runs anticlockwise from north, a bearing clockwise.
  assert.equal(parseFacing('0'), parseFacing('n'), '0 is north either way');
  assert.equal(parseFacing('180'), parseFacing('s'), 'and 180 is south either way');
  assert.equal(parseFacing('90'), parseFacing('w'), "bzo's 90 is west, where a bearing's is east");
  assert.equal(parseFacing('270'), parseFacing('e'));
  // Which the reply says out loud, so a number that meant the other thing is
  // visible in the answer rather than only in the tank.
  assert.equal(rotationToBearingName(parseFacing('90')), 'W');

  // Negative and out-of-range angles normalize, because an angle off a share
  // link is whatever the tank's rotation happened to be.
  assert.equal(parseFacing('-90'), parseFacing('270'));
  assert.equal(parseFacing('450'), parseFacing('90'));
  assert.equal(parseFacing('-360'), parseFacing('0'));

  // Still not a facing.
  assert.equal(parseFacing('sideways'), null);
  assert.equal(parseFacing(''), null);
  assert.equal(parseFacing('   '), null);
  assert.equal(parseFacing(null), null);
  assert.equal(parseFacing('NaN'), null);
  assert.equal(parseFacing('Infinity'), null, 'a rotation has to be a number you can turn to');
  // `parseBearing` itself is unchanged: it is the compass, and nothing else.
  assert.equal(parseBearing('90'), null);
}

// `/me` is the one `/` line that is not dispatched as a command: it is
// reformatted in the message path so it keeps its destination, which is upstream's
// own reason for putting it there (bzfs.cxx:1490). The test is the shape of the
// line, since that is what the message path matches on.
{
  const isMe = (text) => /^\/me(\s|$)/i.test(text);
  assert.equal(isMe('/me smiles'), true);
  assert.equal(isMe('/ME SHOUTS'), true, 'upstream matches case-insensitively');
  assert.equal(isMe('/me'), true, 'and answers with the "requires an argument" reply');
  assert.equal(isMe('/me   '), true);
  // "don't intercept other messages beginning with /me..." -- upstream's own
  // comment, and the reason the space matters.
  assert.equal(isMe('/mexico'), false);
  assert.equal(isMe('/mercy me'), false);
  assert.equal(isMe('/m'), false);
  assert.equal(isMe('me smiles'), false, 'without the slash it is just chat');
}

// FlagInfo::getTextualInfo (FlagInfo.cxx:284), which is what `/flag show`
// prints. The columns are padded exactly as upstream's `%-3d`/`%-3s`/`%-2d` pad
// them, so a stack of these lines up the way it does on a bzfs server.
{
  assert.equal(
    formatFlagInfo({
      index: 7,
      type: 'GM',
      player: 3,
      required: false,
      grabs: 4,
      status: 2,
      position: { x: -12.25, y: 0, z: 138.5 },
    }),
    '#7   i:GM  p:3   r:0  g:4  s:2  p:{-12.3, 0.0, 138.5}',
  );
  // A pool slot with nothing in it yet: no type, nobody holding it, and the
  // status that says it is not in the world.
  assert.equal(
    formatFlagInfo({
      index: 12,
      type: null,
      player: -1,
      required: false,
      grabs: 0,
      status: 0,
      position: { x: 0, y: 0, z: 0 },
    }),
    '#12  i:    p:-1  r:0  g:0  s:0  p:{0.0, 0.0, 0.0}',
  );
  // A team flag is a required slot upstream, and the columns still line up when
  // the abbreviation is the wide one.
  assert.equal(
    formatFlagInfo({
      index: 0,
      type: 'R*',
      player: -1,
      required: true,
      grabs: 0,
      status: 1,
      position: { x: 100, y: 10, z: -100 },
    }),
    '#0   i:R*  p:-1  r:1  g:0  s:1  p:{100.0, 10.0, -100.0}',
  );
}

// parseServerCommand's last word (commands.cxx:3909). The slash is dropped and
// the arguments are kept, so a player reads back what they typed.
assert.equal(formatUnknownCommand('/kick bob please'), 'Unknown command [kick bob please]');
assert.equal(formatUnknownCommand('/nope'), 'Unknown command [nope]');
assert.equal(formatUnknownCommand('/'), 'Unknown command []');

console.log('server command tests passed');
