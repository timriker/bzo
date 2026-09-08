/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Server commands: the pure half. Upstream's are a `ServerCommand` subclass each
// (`src/bzfs/commands.cxx`), carrying a name, one line of help and a permission;
// bzo keeps the names, the help and the tier in `server.js` beside what each one
// *does*, and everything here is the parsing and formatting that has an answer
// worth testing without a server around it.
//
// See docs/commands-plan.md for the whole command set and what each one needs.
// This is steps 1 and 2 of it.
//
// Server-only. A command is typed into the chat entry the client already has and
// arrives as an ordinary `message`; nothing about the transport is new.

// Upstream's tiers, reduced to the two questions bzo can answer. It has one
// boolean where upstream has sixty per-command permissions, and
// docs/commands-plan.md says why porting the sixty is the wrong move: they are
// granted out of a users file bzo has no equivalent of.
const COMMAND_TIER = Object.freeze({
  OPEN: 'open',
  OPERATOR: 'operator',
});

// `maxLineLen` in CmdList (commands.cxx:471). Upstream lays `/?` out in columns
// against a 64 character line, and bzo's chat is at least as wide.
const COMMAND_LIST_LINE_LENGTH = 64;

// Whether a chat line is a command rather than something to say. Upstream never
// decides this explicitly -- the client tries its local table and the server
// tries its own, and a line that matches neither comes back as "Unknown
// command". The one thing that matters is that it is asked *before* the
// destination: a `/` line is never said out loud, whichever channel it was
// aimed at.
function isCommandLine(text) {
  return typeof text === 'string' && text.startsWith('/');
}

// The command and the rest of the line. Upstream matches the longest registered
// name against the front of the message, which lets `/flag reset` and a
// hypothetical `/flagfoo` coexist; bzo splits on whitespace instead, because
// every name it has is a single word and a table nobody can typo into is worth
// more than that flexibility.
//
// The name keeps its slash, so it reads the same here as it does in the help and
// in the log.
function parseCommandLine(text) {
  if (!isCommandLine(text)) return null;
  const match = /^(\/\S*)\s*([\s\S]*)$/.exec(text);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: match[2].trim() };
}

// CmdHelp (commands.cxx:476) is upstream's per-command help and its completion:
// `/co?` lists the help for every command starting with `co`, and `/co*` runs
// the one command that does if exactly one does. bzo takes the `?` half, which
// is the only way either of us shows a single command's usage -- `/help` upstream
// pages *help files*, which bzo does not read.
//
// Returns the prefix to match, without the trailing `?`, or null.
function parseHelpPrefix(text) {
  if (!isCommandLine(text)) return null;
  const match = /^(\/\S*)\?$/.exec(text.trim());
  if (!match) return null;
  return match[1].toLowerCase();
}

// CmdList's column layout (commands.cxx:490): every name padded to the longest
// plus two, as many columns as fit the line, and filled down each column rather
// than across each row -- so the names read alphabetically top to bottom.
//
// Returned as lines because that is how they are sent: one chat message each,
// as upstream sends one `sendMessage` each.
function formatCommandList(names, maxLineLen = COMMAND_LIST_LINE_LENGTH) {
  const sorted = [...names].sort();
  if (sorted.length === 0) return [];
  const width = Math.max(...sorted.map((name) => name.length)) + 2;
  const cols = Math.max(1, Math.floor(maxLineLen / width));
  const rows = Math.ceil(sorted.length / cols);
  const lines = [];
  for (let row = 0; row < rows; row += 1) {
    let line = '';
    for (let col = 0; col < cols; col += 1) {
      const index = (col * rows) + row;
      if (index >= sorted.length) break;
      line += sorted[index].padEnd(width);
    }
    // The padding on the last column of a row is trailing whitespace nobody can
    // see; upstream leaves it in a fixed buffer and bzo is sending a string.
    lines.push(line.trimEnd());
  }
  return lines;
}

// TimeKeeper::convertTime and printTime (TimeKeeper.cxx:280, :301). Whole units
// only, largest first, comma separated, and a unit that is zero is left out
// entirely -- so a server up for an hour exactly says "1 hour" and not
// "1 hour, 0 mins, 0 secs". Upstream's own abbreviations: `day`, `hour`, `min`,
// `sec`, pluralised with a bare `s`.
//
// Upstream prints nothing at all for a duration under a second, which is what a
// server queried in its first second would say; that is upstream's answer and
// not worth improving on.
function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const parts = [
    [Math.floor(total / 86400), 'day'],
    [Math.floor((total % 86400) / 3600), 'hour'],
    [Math.floor((total % 3600) / 60), 'min'],
    [total % 60, 'sec'],
  ];
  return parts
    .filter(([value]) => value > 0)
    .map(([value, unit]) => `${value} ${unit}${value === 1 ? '' : 's'}`)
    .join(', ');
}

// DateTimeCommand (commands.cxx:418) sends `ctime()` cut to 24 characters, which
// is C's fixed-width `Www Mmm dd hh:mm:ss yyyy` with the newline chopped off.
// Reproduced rather than replaced by a locale format, so a bzo server and a bzfs
// server answer `/date` the same way.
const CTIME_DAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const CTIME_MONTHS = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

function formatCTime(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  // `%e`-style: the day of the month is space padded, not zero padded, which is
  // what makes the string a fixed 24 characters.
  const day = String(date.getDate()).padStart(2, ' ');
  return `${CTIME_DAYS[date.getDay()]} ${CTIME_MONTHS[date.getMonth()]} ${day}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + ` ${date.getFullYear()}`;
}

// MsgCommand (commands.cxx:916). `/msg <callsign> text`, with the callsign
// quoted when it has a space in it, and `>admin` / `>team` naming a channel
// instead of a player. Upstream's error wording throughout, because a player who
// mistypes this on a bzfs server should read the same sentence here.
//
// `resolveCallsign` is injected: who is on the server is the roster's business,
// and keeping it out of here is what lets the parsing be tested on its own. It
// takes a callsign and returns a player id, or null.
//
// Returns `{ error }`, or `{ to, text }` where `to` is a player id or one of
// bzo's channel destinations.
function parseMsgCommand(args, resolveCallsign, channels = {}) {
  const usage = 'Usage: /msg "some callsign" some message';
  if (typeof args !== 'string' || args.length === 0) return { error: usage };

  let callsign;
  let rest;
  if (args.startsWith('"')) {
    const end = args.indexOf('"', 1);
    // "Quote mismatch?" then the usage, which is upstream's pair of lines.
    if (end === -1) return { error: 'Quote mismatch?', alsoUsage: true };
    callsign = args.slice(1, end);
    rest = args.slice(end + 1).trim();
  } else {
    // Upstream walks forward to the first space that leaves a name it can
    // resolve, so an unquoted callsign containing a space still works when the
    // player is here. bzo asks the resolver the same way rather than taking the
    // first word outright.
    //
    // Both halves are taken as *substrings* of the original, as upstream's
    // `substr` does, so the message's own spacing survives -- splitting on
    // whitespace and rejoining would quietly collapse it, and the spacing of a
    // message is part of the message. Same reason a map's `-srvmsg` text is read
    // off the raw line.
    let end = -1;
    for (let i = 0; i < args.length; i += 1) {
      if (!/\s/.test(args[i])) continue;
      if (resolveCallsign(args.slice(0, i)) !== null) {
        end = i;
        break;
      }
    }
    if (end === -1) {
      // Nothing resolved, so the first word is the callsign -- which is what
      // makes the "no such callsign" error name what the player actually typed.
      const firstSpace = args.search(/\s/);
      end = firstSpace === -1 ? args.length : firstSpace;
    }
    callsign = args.slice(0, end);
    rest = args.slice(end).replace(/^\s+/, '');
  }

  if (callsign.length === 0) return { error: usage };

  // `>admin` and `>team` name a channel rather than a player, which is how
  // upstream lets one command reach all three.
  if (callsign.startsWith('>')) {
    const channel = callsign.slice(1).toUpperCase();
    const to = channels[channel];
    if (to === undefined) return { error: `"${callsign}" is not here.  No such callsign.` };
    if (rest.length === 0) return { error: usage };
    return { to, text: rest };
  }

  const to = resolveCallsign(callsign);
  if (to === null) return { error: `"${callsign}" is not here.  No such callsign.` };
  if (rest.length === 0) return { error: usage };
  return { to, text: rest };
}

// parseServerCommand's last word (commands.cxx:3909), in upstream's own
// brackets. The slash is dropped, which is why the text is quoted at all.
function formatUnknownCommand(text) {
  return `Unknown command [${String(text).replace(/^\//, '')}]`;
}

module.exports = {
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
};
