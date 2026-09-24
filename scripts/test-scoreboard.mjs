/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The scoreboard's ordering and the one label shape every surface writes a
// player with. Both are pure, and both are read by more than one renderer -- the
// flat HUD, the XR panel, the roaming leader and the Identify alerts -- so a
// change that suits one and breaks another is exactly what these catch.

import assert from 'node:assert/strict';
import {
  HUD_ALERT_WARNING_COLOR,
  SCOREBOARD_RABBIT_MARK,
  buildScoreboardRows,
  compareScoreboardPlayers,
  fitText,
  formatPersonalTally,
  formatPlayerLabel,
  formatRabbitRank,
  SCOREBOARD_COLUMNS,
  SCOREBOARD_TIER,
  formatScoreboardCell,
  formatScoreboardStats,
  getPlayerStatusIndicator,
  getPlayerTeamMark,
  getScoreboardColumnLabel,
  getScoreboardColumnWidth,
  getScoreboardColumns,
  getScoreboardStatsHeader,
  setHudAlert,
  updateAlertHud,
} from '../public/hud.js';
import { PLAYER_TEAM, getPlayerRanking } from '../public/teams.mjs';

const row = (over = {}) => ({
  id: 'x', wins: 0, losses: 0, rank: null, isObserver: false,
  connectDate: new Date(0), ...over,
});

// ScoreboardRenderer::sortCompareI2. Observers last, then wins minus losses
// descending, then wins descending, then losses ascending, then who joined
// first.
{
  const sorted = [
    row({ id: 'even', wins: 2, losses: 2 }),
    row({ id: 'obs', wins: 9, losses: 0, isObserver: true }),
    row({ id: 'ahead', wins: 5, losses: 1 }),
    row({ id: 'behind', wins: 0, losses: 3 }),
  ].sort(compareScoreboardPlayers);
  assert.deepEqual(sorted.map((r) => r.id), ['ahead', 'even', 'behind', 'obs']);
}
{
  // Same score, more wins ranks higher; same again, fewer losses; same again, the
  // older connection.
  const sorted = [
    row({ id: 'younger', wins: 1, losses: 1, connectDate: new Date(2000) }),
    row({ id: 'busier', wins: 4, losses: 4 }),
    row({ id: 'older', wins: 1, losses: 1, connectDate: new Date(1000) }),
  ].sort(compareScoreboardPlayers);
  assert.deepEqual(sorted.map((r) => r.id), ['busier', 'older', 'younger']);
}

// newSortedList's default case (ScoreboardRenderer.cxx:1003) sorts a Rabbit
// Chase world by `getRabbitScore()` instead, so the board is ordered by who is
// next in line for the rabbit. `rank` is only set on such a world, so its
// presence is the `allowRabbit()` that upstream asks.
{
  const ranked = (id, wins, losses) => row({
    id, wins, losses, rank: getPlayerRanking(wins, losses),
  });

  // The case where the two rules disagree, and the reason the rank has to be the
  // one that decides: a player with no record at all ranks 0.5, which is above
  // anyone whose *rate* is worse than even however far ahead they are on kills.
  const fresh = ranked('fresh', 0, 0);
  const mediocre = ranked('mediocre', 5, 4);
  assert.ok(fresh.rank > mediocre.rank, 'no record outranks a losing rate');
  assert.ok((mediocre.wins - mediocre.losses) > (fresh.wins - fresh.losses));
  assert.deepEqual(
    [mediocre, fresh].sort(compareScoreboardPlayers).map((r) => r.id),
    ['fresh', 'mediocre'],
    'Rabbit Chase orders by rank, not by wins minus losses'
  );
  // Without a rank -- every other game type -- the same pair goes the other way.
  assert.deepEqual(
    [row({ id: 'mediocre', wins: 5, losses: 4 }), row({ id: 'fresh' })]
      .sort(compareScoreboardPlayers).map((r) => r.id),
    ['mediocre', 'fresh']
  );
  // Observers are still last, whatever they rank.
  const sorted = [
    ranked('obs', 9, 0), ranked('good', 4, 1), ranked('bad', 1, 4),
  ].map((r) => (r.id === 'obs' ? { ...r, isObserver: true } : r))
    .sort(compareScoreboardPlayers);
  assert.deepEqual(sorted.map((r) => r.id), ['good', 'bad', 'obs']);
  // A tie on rank falls through to the score, so two unranked players keep the
  // order they would have had.
  const tied = [ranked('worse', 0, 2), ranked('better', 0, 1)].sort(compareScoreboardPlayers);
  assert.deepEqual(tied.map((r) => r.id), ['better', 'worse']);
}

// getRabbitScore() is `rabbitRank(...) * 100` in a short, printed `%2d%%`.
assert.equal(formatRabbitRank(0.5), '50%');
assert.equal(formatRabbitRank(getPlayerRanking(25, 0)), '90%');
assert.equal(formatRabbitRank(getPlayerRanking(0, 7)), '0%');
// Truncated rather than rounded, as the cast to short is.
assert.equal(formatRabbitRank(0.539), '53%');

// The rows a Rabbit Chase board is built from carry the rank and the mark; every
// other board carries neither, which is what keeps the sort above on the plain
// score.
{
  const tanks = new Map([
    ['2', { userData: { playerState: { id: '2', name: 'hunter', team: PLAYER_TEAM.HUNTER, wins: 1, losses: 3 } } }],
  ]);
  const myTank = { userData: { playerState: { id: '1', name: 'bun', team: PLAYER_TEAM.RABBIT, wins: 4, losses: 2 } } };
  const args = { myPlayerId: '1', myPlayerName: 'bun', myTank, tanks };

  const chase = buildScoreboardRows({ ...args, rabbitChase: true });
  assert.deepEqual(chase.map((r) => r.id), ['1', '2']);
  assert.equal(chase[0].rabbit, SCOREBOARD_RABBIT_MARK);
  assert.equal(chase[1].rabbit, null, 'a hunter carries no mark');
  assert.equal(chase[0].rank, getPlayerRanking(4, 2));

  const plain = buildScoreboardRows(args);
  assert.equal(plain[0].rank, null, 'no rank outside Rabbit Chase');
  // The mark is read off the team, so it survives a world that is not asked
  // about -- there is no rabbit team outside Rabbit Chase to read it from.
  assert.equal(plain.find((r) => r.id === '2').rabbit, null);
}

// tks, paused and micOn pass straight through from a player's own
// state, same as wins and losses do -- and default to 0/false for a player
// state that predates any of them, the way a fresh connect always does.
{
  const tanks = new Map([
    ['2', { userData: { playerState: { id: '2', name: 'quiet', team: PLAYER_TEAM.RED } } }],
    ['3', {
      userData: {
        playerState: {
          id: '3', name: 'ridden', team: PLAYER_TEAM.BLUE,
          tks: 2, paused: true, voiceMicEnabled: true,
        },
      },
    }],
  ]);
  const myTank = { userData: { playerState: { id: '1', name: 'me', team: PLAYER_TEAM.RED } } };
  const rows = buildScoreboardRows({ myPlayerId: '1', myPlayerName: 'me', myTank, tanks });
  const quiet = rows.find((r) => r.id === '2');
  const ridden = rows.find((r) => r.id === '3');
  assert.equal(quiet.tks, 0);
  assert.equal(quiet.paused, false);
  assert.equal(quiet.micOn, false);
  assert.equal(ridden.tks, 2);
  assert.equal(ridden.paused, true);
  assert.equal(ridden.micOn, true);
}

// An observer draws neither score column, which is upstream's own
// `if (player->getTeam() != ObserverTeam)` around both (ScoreboardRenderer.cxx
// :829). It cannot kill or die, so `0 / 0` is the absence of a score rather than
// a score, and it can never be anointed, so a rank would name a place in a queue
// it cannot be picked from.
{
  // The heading names the rank column, which upstream leaves unlabelled -- an
  // unlabelled percentage in front of a kill count is a question, not an answer.
  assert.equal(getScoreboardStatsHeader(false), 'Kills-Deaths');
  assert.equal(getScoreboardStatsHeader(true), 'Rank Kills-Deaths');
  assert.equal(getScoreboardStatsHeader(), 'Kills-Deaths');
  // The headset's panel is narrow, so it takes the same heading abbreviated
  // rather than one of its own.
  assert.equal(getScoreboardStatsHeader(false, true), 'K-D');
  assert.equal(getScoreboardStatsHeader(true, true), 'Rank K-D');

  // The score column upstream leads with -- `wins - losses` (Player.h:486) --
  // then the record with upstream's own hyphen.
  assert.equal(formatScoreboardStats({ wins: 4, losses: 2 }), '2  4-2');
  assert.equal(
    formatScoreboardStats({ wins: 4, losses: 2, rank: getPlayerRanking(4, 2) }),
    '53% 2  4-2'
  );
  assert.equal(formatScoreboardStats({ wins: 0, losses: 0, isObserver: true }), '');
  // Even one carrying a score from before it switched, and even on a Rabbit
  // Chase world: being an observer is what decides it.
  assert.equal(formatScoreboardStats({ wins: 9, losses: 1, isObserver: true }), '');
  assert.equal(
    formatScoreboardStats({ wins: 9, losses: 1, rank: 0.8, isObserver: true }),
    ''
  );
  // A losing record scores negative, which upstream prints as readily as it
  // prints a positive one.
  assert.equal(formatScoreboardStats({ wins: 1, losses: 4 }), '-3  1-4');

  // The `[NN]` team-kill bracket (ScoreboardRenderer.cxx:675-686), drawn only
  // once there is one to report -- a zero is the expected state for almost
  // every row, not information. It rides in the record cell, where upstream
  // puts it, rather than becoming a column that is blank on nearly every row.
  assert.equal(formatScoreboardStats({ wins: 4, losses: 2, tks: 0 }), '2  4-2');
  assert.equal(formatScoreboardStats({ wins: 4, losses: 2, tks: 2 }), '2  4-2 [2]');
  assert.equal(
    formatScoreboardStats({ wins: 4, losses: 2, rank: getPlayerRanking(4, 2), tks: 1 }),
    '53% 2  4-2 [1]'
  );

  // The head-to-head tally (ScoreboardRenderer.cxx:692): blank until there is
  // a record to show, tilde-joined once there is one, and my own row shows a
  // self-destruct count instead -- never both.
  assert.equal(
    formatScoreboardStats({ wins: 4, losses: 2, localWins: 3, localLosses: 1 }),
    '2  4-2  3~1'
  );
  assert.equal(formatPersonalTally({ wins: 4, losses: 2, localWins: 0, localLosses: 0 }), '');
  assert.equal(
    formatScoreboardStats({ wins: 4, losses: 2, isCurrent: true, selfKills: 2 }),
    '2  4-2  2 self'
  );
  assert.equal(
    formatScoreboardStats({ wins: 4, losses: 2, isCurrent: true, selfKills: 0 }),
    '2  4-2'
  );
  // `compact` drops the tally first, for a phone-width scoreboard (issue #65).
  assert.equal(
    formatScoreboardStats(
      { wins: 4, losses: 2, localWins: 3, localLosses: 1 }, { tier: SCOREBOARD_TIER.MEDIUM }),
    '2  4-2'
  );
  // A phone drops the record too: `Score` is what the board is sorted by and
  // says the same thing in a third of the width.
  assert.equal(
    formatScoreboardStats(
      { wins: 4, losses: 2, localWins: 3, localLosses: 1 }, { tier: SCOREBOARD_TIER.NARROW }),
    '2'
  );
}

// One column list, read by the flat board, the header row and the headset
// panel alike. A column that appears in one place under a name another place
// never uses is the failure this guards against.
{
  const ids = (options) => getScoreboardColumns(options).map((column) => column.id);

  // The wide board, for someone who is not an admin: upstream's three columns
  // split so each carries its own label, plus the `#` upstream shows only to
  // an admin and bzo shows to everyone.
  assert.deepEqual(ids({}), ['number', 'player', 'score', 'record', 'tally']);

  // BZID is offered to an admin and to nobody else. It has no upstream
  // counterpart; the server is what withholds the value.
  assert.deepEqual(
    ids({ isAdmin: true }),
    ['number', 'bzid', 'player', 'score', 'record', 'tally']
  );

  // The panel stops growing at 900px, so the two widest columns per unit of
  // information go -- the BZID even for an admin, and the head-to-head tally.
  assert.deepEqual(
    ids({ tier: SCOREBOARD_TIER.MEDIUM, isAdmin: true }),
    ['number', 'player', 'score', 'record']
  );

  // A phone gives up the record as well, leaving the name room to be a name.
  assert.deepEqual(
    ids({ tier: SCOREBOARD_TIER.NARROW, isAdmin: true }),
    ['number', 'player', 'score']
  );

  // The long label is what the wide column is sized for, and the short one is
  // what a narrower board has room to say.
  const record = SCOREBOARD_COLUMNS.find((column) => column.id === 'record');
  assert.equal(getScoreboardColumnLabel(record, SCOREBOARD_TIER.WIDE), 'Kills-Deaths');
  assert.equal(getScoreboardColumnLabel(record, SCOREBOARD_TIER.MEDIUM), 'K-D');
  // Wide enough for the label it carries, in both directions -- a cell sized
  // to the value would clip its own heading.
  assert.ok(getScoreboardColumnWidth(record, SCOREBOARD_TIER.WIDE) >= 'Kills-Deaths'.length);
  assert.ok(getScoreboardColumnWidth(record, SCOREBOARD_TIER.MEDIUM) >= 'K-D'.length);
  assert.ok(
    getScoreboardColumnWidth(record, SCOREBOARD_TIER.MEDIUM)
      < getScoreboardColumnWidth(record, SCOREBOARD_TIER.WIDE)
  );

  // Every column a surface draws formats through one function, so no surface
  // can punctuate a number its own way.
  const row = { id: '7', bzid: '9021', wins: 4, losses: 2, tks: 1, localWins: 3, localLosses: 1 };
  assert.equal(formatScoreboardCell(row, 'number'), '7');
  assert.equal(formatScoreboardCell(row, 'bzid'), '9021');
  assert.equal(formatScoreboardCell(row, 'score'), '2');
  assert.equal(formatScoreboardCell(row, 'record'), '4-2 [1]');
  assert.equal(formatScoreboardCell(row, 'tally'), '3~1');
  // A player who never verified has no BZID to show, admin looking or not.
  assert.equal(formatScoreboardCell({ id: '3', bzid: null }, 'bzid'), '');
  // An observer keeps its number -- and its BZID, which says who is watching --
  // and loses every column that describes a fight it cannot join.
  const observer = { id: '4', bzid: '55', wins: 9, losses: 1, isObserver: true };
  assert.equal(formatScoreboardCell(observer, 'number'), '4');
  assert.equal(formatScoreboardCell(observer, 'bzid'), '55');
  assert.equal(formatScoreboardCell(observer, 'score'), '');
  assert.equal(formatScoreboardCell(observer, 'record'), '');
}

// The break between the players and the observers, marked on the row so the flat
// board and the headset's cannot put it in different places.
{
  const tanks = new Map([
    ['2', { userData: { playerState: { id: '2', name: 'watcher', team: PLAYER_TEAM.OBSERVER } } }],
    ['3', { userData: { playerState: { id: '3', name: 'watcher2', team: PLAYER_TEAM.OBSERVER } } }],
  ]);
  const myTank = { userData: { playerState: { id: '1', name: 'bun', team: PLAYER_TEAM.HUNTER, wins: 1, losses: 0 } } };
  const rows = buildScoreboardRows({
    myPlayerId: '1', myPlayerName: 'bun', myTank, tanks, rabbitChase: true,
  });
  assert.deepEqual(rows.map((r) => r.id), ['1', '2', '3'], 'observers sort last');
  assert.equal(rows[0].startsObservers, undefined);
  assert.equal(rows[1].startsObservers, true, 'the first observer carries the break');
  assert.equal(rows[2].startsObservers, undefined, 'and only the first');
  // No rank for either of them, though the world is playing Rabbit Chase.
  assert.equal(rows[0].rank, getPlayerRanking(1, 0));
  assert.equal(rows[1].rank, null);
  assert.equal(rows[2].rank, null);

  // A board of nothing but observers has nobody above the break, so there is no
  // break to draw.
  const allObs = buildScoreboardRows({
    myPlayerId: '2', myPlayerName: 'watcher',
    myTank: tanks.get('2'), tanks: new Map([['3', tanks.get('3')]]),
  });
  assert.equal(allObs.length, 2);
  assert.ok(allObs.every((r) => r.startsObservers === undefined), 'no leading break');
}

// One label shape, so a scoreboard row and an Identify alert cannot describe the
// same tank differently. `text` is the whole line for anything that only wants
// the words; `segments` colour each part as the roster colours it.
{
  const flag = { label: 'GM', color: 0x00ff00 };
  assert.equal(formatPlayerLabel({ name: 'ann' }).text, 'ann');
  assert.equal(formatPlayerLabel({ name: 'ann', flag }).text, 'ann/GM');
  assert.equal(
    formatPlayerLabel({ name: 'ann', flag, mark: SCOREBOARD_RABBIT_MARK }).text,
    'ann/GM (rabbit)'
  );
  // The flag sits tight against the name and the mark stands off it, which is
  // how the scoreboard draws the three.
  assert.equal(
    formatPlayerLabel({ name: 'ann', mark: SCOREBOARD_RABBIT_MARK }).text,
    'ann (rabbit)'
  );

  const { segments } = formatPlayerLabel({
    name: 'ann', nameColor: 0x123456, flag, mark: SCOREBOARD_RABBIT_MARK,
  });
  assert.deepEqual(segments, [
    { text: 'ann', color: 0x123456 },
    { text: '/GM', color: 0x00ff00 },
    { text: ' (rabbit)', color: SCOREBOARD_RABBIT_MARK.color },
  ]);
  // Every segment's text concatenates back to the line, which is what lets a
  // renderer that ignores segments draw something correct.
  assert.equal(segments.map((s) => s.text).join(''), 'ann/GM (rabbit)');
  // A name with no colour of its own inherits the line's, as a chat segment does.
  assert.equal(formatPlayerLabel({ name: 'ann' }).segments[0].color, null);
}

// The `(<Team>)` upstream puts after a callsign in a message (playing.cxx:4016),
// kept only where it says something a reader could not already see.
{
  // A colour team names nothing: describePlayer already colours the name in
  // that player's own shade, so `(Red)` beside an already-red name would be
  // the word "Player" before a quoted name, not information.
  assert.equal(getPlayerTeamMark(PLAYER_TEAM.RED), null);
  assert.equal(getPlayerTeamMark(PLAYER_TEAM.PURPLE), null);
  assert.equal(getPlayerTeamMark(PLAYER_TEAM.BLUE), null);
  // The rabbit names itself, and with the same mark the scoreboard uses -- it is
  // the one thing in the world everybody is hunting, and no notice colours a
  // name specifically to mean "the rabbit".
  assert.equal(getPlayerTeamMark(PLAYER_TEAM.RABBIT), SCOREBOARD_RABBIT_MARK);
  // Rogue, observer and hunter name nothing either. Every bzo player has a
  // colour of their own, so `(Rogue)` on every line of an OpenFFA server would
  // be noise, and in Rabbit Chase everyone who is not the rabbit is a hunter.
  assert.equal(getPlayerTeamMark(PLAYER_TEAM.ROGUE), null);
  assert.equal(getPlayerTeamMark(PLAYER_TEAM.OBSERVER), null);
  assert.equal(getPlayerTeamMark(PLAYER_TEAM.HUNTER), null);
  // An unknown team normalizes to rogue, which names nothing.
  assert.equal(getPlayerTeamMark('nonsense'), null);
  assert.equal(getPlayerTeamMark(null), null);
}

// ScoreboardRenderer.cxx:712 picks exactly one character, and bzo reaches two of
// upstream's three -- it learns nothing about a callsign unless a token verifies.
assert.equal(getPlayerStatusIndicator({ admin: true, verified: true }), '@');
assert.equal(getPlayerStatusIndicator({ verified: true }), '+');
assert.equal(getPlayerStatusIndicator({}), '');
assert.equal(getPlayerStatusIndicator(null), '');

// updateAlertHud, against a stub DOM. This is the renderer that turns an
// alert's segments into coloured spans, and the only way to reach it otherwise
// is a keypress in a browser -- so it gets the smallest `document` that will
// carry it. The XR panel draws the same segments run by run; that one needs a
// canvas and is not reachable here.
{
  const el = (tag) => ({
    tagName: tag, className: '', textContent: '', style: {}, children: [],
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren() { this.children = []; },
  });
  const alertHud = el('div');
  globalThis.document = {
    getElementById: (id) => (id === 'alertHud' ? alertHud : null),
    createElement: el,
  };
  // The module caches the element on its first *call*, not on import, so the
  // stub above is in place in time.
  // A plain alert is one line of text and no spans, exactly as before.
  setHudAlert(0, 'Time Expired', 5, true);
  updateAlertHud();
  assert.equal(alertHud.children.length, 1);
  assert.equal(alertHud.children[0].textContent, 'Time Expired');
  assert.equal(alertHud.children[0].style.color, HUD_ALERT_WARNING_COLOR);
  assert.equal(alertHud.children[0].children.length, 0, 'no segments, no spans');

  // A segmented alert becomes one span per run, each with its own colour, and
  // the line keeps the alert's colour for any run that declines one.
  const label = formatPlayerLabel({
    name: 'ann', nameColor: 0x123456,
    flag: { label: 'GM', color: 0x00ff00 },
    mark: SCOREBOARD_RABBIT_MARK,
  });
  setHudAlert(1, `Looking at ${label.text}`, 5, false, [{ text: 'Looking at ' }, ...label.segments]);
  updateAlertHud();
  const line = alertHud.children.find((child) => child.children.length > 0);
  assert.deepEqual(
    line.children.map((span) => [span.textContent, span.style.color]),
    [
      ['Looking at ', undefined],
      ['ann', '#123456'],
      ['/GM', '#00ff00'],
      [' (rabbit)', '#cccccc'],
    ],
  );
  // The whole line still reads correctly for anything that only wants the words.
  assert.equal(line.children.map((s) => s.textContent).join(''), 'Looking at ann/GM (rabbit)');

  // The repaint is keyed, so an unchanged alert does not rebuild the DOM...
  const before = alertHud.children;
  updateAlertHud();
  assert.equal(alertHud.children, before, 'an unchanged column is left alone');
  // ...but a change of colour alone is a change: two alerts can read the same
  // and be about differently coloured players.
  setHudAlert(1, 'Looking at ann', 5, false, [{ text: 'Looking at ' }, { text: 'ann', color: 0x654321 }]);
  updateAlertHud();
  assert.notEqual(alertHud.children, before, 'a recoloured line repaints');
  assert.equal(alertHud.children.at(-1).children.at(-1).style.color, '#654321');

  delete globalThis.document;
}

// fitText truncates by code point, so a callsign or chat line that ends in an
// astral character loses the whole character rather than half a surrogate pair.
{
  // One unit of width per code unit, which makes the widths below countable.
  const context = { measureText: (text) => ({ width: text.length }) };

  assert.equal(fitText(context, 'Tim Riker', 100), 'Tim Riker', 'text that fits is untouched');
  assert.equal(fitText(context, 'Tim Riker', 8), 'Tim R...', 'ascii truncates to the width');

  const withEmoji = 'Tim Riker\u{1F680}';
  assert.equal(fitText(context, withEmoji, 10), 'Tim Rik...', 'the rocket goes whole');
  assert.equal(fitText(context, '\u{1F680}', 1), '...', 'a lone astral character goes entirely');

  const halfPair = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (let width = 1; width <= withEmoji.length; width += 1) {
    const fitted = fitText(context, withEmoji, width);
    assert.ok(
      !halfPair.test(fitted),
      `no half surrogate pair at width ${width}: ${JSON.stringify(fitted)}`,
    );
  }
}

console.log('scoreboard tests passed');
