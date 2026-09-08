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
  formatPlayerLabel,
  formatRabbitRank,
  formatScoreboardStats,
  getPlayerStatusIndicator,
  getPlayerTeamMark,
  getScoreboardStatsHeader,
  setHudAlert,
  updateAlertHud,
} from '../public/hud.js';
import { PLAYER_TEAM, getPlayerRanking } from '../public/teams.mjs';

const row = (over = {}) => ({
  id: 'x', kills: 0, deaths: 0, rank: null, isObserver: false,
  connectDate: new Date(0), ...over,
});

// ScoreboardRenderer::sortCompareI2. Observers last, then wins minus losses
// descending, then wins descending, then losses ascending, then who joined
// first.
{
  const sorted = [
    row({ id: 'even', kills: 2, deaths: 2 }),
    row({ id: 'obs', kills: 9, deaths: 0, isObserver: true }),
    row({ id: 'ahead', kills: 5, deaths: 1 }),
    row({ id: 'behind', kills: 0, deaths: 3 }),
  ].sort(compareScoreboardPlayers);
  assert.deepEqual(sorted.map((r) => r.id), ['ahead', 'even', 'behind', 'obs']);
}
{
  // Same score, more kills wins; same again, fewer deaths wins; same again, the
  // older connection.
  const sorted = [
    row({ id: 'younger', kills: 1, deaths: 1, connectDate: new Date(2000) }),
    row({ id: 'busier', kills: 4, deaths: 4 }),
    row({ id: 'older', kills: 1, deaths: 1, connectDate: new Date(1000) }),
  ].sort(compareScoreboardPlayers);
  assert.deepEqual(sorted.map((r) => r.id), ['busier', 'older', 'younger']);
}

// newSortedList's default case (ScoreboardRenderer.cxx:1003) sorts a Rabbit
// Chase world by `getRabbitScore()` instead, so the board is ordered by who is
// next in line for the rabbit. `rank` is only set on such a world, so its
// presence is the `allowRabbit()` that upstream asks.
{
  const ranked = (id, kills, deaths) => row({
    id, kills, deaths, rank: getPlayerRanking(kills, deaths),
  });

  // The case where the two rules disagree, and the reason the rank has to be the
  // one that decides: a player with no record at all ranks 0.5, which is above
  // anyone whose *rate* is worse than even however far ahead they are on kills.
  const fresh = ranked('fresh', 0, 0);
  const mediocre = ranked('mediocre', 5, 4);
  assert.ok(fresh.rank > mediocre.rank, 'no record outranks a losing rate');
  assert.ok((mediocre.kills - mediocre.deaths) > (fresh.kills - fresh.deaths));
  assert.deepEqual(
    [mediocre, fresh].sort(compareScoreboardPlayers).map((r) => r.id),
    ['fresh', 'mediocre'],
    'Rabbit Chase orders by rank, not by wins minus losses'
  );
  // Without a rank -- every other game type -- the same pair goes the other way.
  assert.deepEqual(
    [row({ id: 'mediocre', kills: 5, deaths: 4 }), row({ id: 'fresh' })]
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
    ['2', { userData: { playerState: { id: '2', name: 'hunter', team: PLAYER_TEAM.HUNTER, kills: 1, deaths: 3 } } }],
  ]);
  const myTank = { userData: { playerState: { id: '1', name: 'bun', team: PLAYER_TEAM.RABBIT, kills: 4, deaths: 2 } } };
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

// An observer draws neither score column, which is upstream's own
// `if (player->getTeam() != ObserverTeam)` around both (ScoreboardRenderer.cxx
// :829). It cannot kill or die, so `0 / 0` is the absence of a score rather than
// a score, and it can never be anointed, so a rank would name a place in a queue
// it cannot be picked from.
{
  // The heading names the rank column, which upstream leaves unlabelled -- an
  // unlabelled percentage in front of a kill count is a question, not an answer.
  assert.equal(getScoreboardStatsHeader(false), 'Kills / Deaths');
  assert.equal(getScoreboardStatsHeader(true), 'Rank Kills / Deaths');
  assert.equal(getScoreboardStatsHeader(), 'Kills / Deaths');
  // The headset's panel is narrow, so it takes the same heading abbreviated
  // rather than one of its own.
  assert.equal(getScoreboardStatsHeader(false, true), 'K/D');
  assert.equal(getScoreboardStatsHeader(true, true), 'Rank K/D');

  assert.equal(formatScoreboardStats({ kills: 4, deaths: 2 }), '4 / 2');
  assert.equal(
    formatScoreboardStats({ kills: 4, deaths: 2, rank: getPlayerRanking(4, 2) }),
    '53% 4 / 2'
  );
  assert.equal(formatScoreboardStats({ kills: 0, deaths: 0, isObserver: true }), '');
  // Even one carrying a score from before it switched, and even on a Rabbit
  // Chase world: being an observer is what decides it.
  assert.equal(formatScoreboardStats({ kills: 9, deaths: 1, isObserver: true }), '');
  assert.equal(
    formatScoreboardStats({ kills: 9, deaths: 1, rank: 0.8, isObserver: true }),
    ''
  );
}

// The break between the players and the observers, marked on the row so the flat
// board and the headset's cannot put it in different places.
{
  const tanks = new Map([
    ['2', { userData: { playerState: { id: '2', name: 'watcher', team: PLAYER_TEAM.OBSERVER } } }],
    ['3', { userData: { playerState: { id: '3', name: 'watcher2', team: PLAYER_TEAM.OBSERVER } } }],
  ]);
  const myTank = { userData: { playerState: { id: '1', name: 'bun', team: PLAYER_TEAM.HUNTER, kills: 1, deaths: 0 } } };
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
// for the teams where it says something.
{
  // A colour team names itself: a shade inside that team's band reads clearly on
  // a tank and not at all in one line of text.
  assert.deepEqual(getPlayerTeamMark(PLAYER_TEAM.RED), { label: '(Red)', color: 0xff0000 });
  assert.equal(getPlayerTeamMark(PLAYER_TEAM.PURPLE).label, '(Purple)');
  // " Team" is dropped from the label, as every other place bzo writes a team
  // beside a name drops it.
  assert.ok(!getPlayerTeamMark(PLAYER_TEAM.BLUE).label.includes('Team'));
  // The rabbit names itself, and with the same mark the scoreboard uses -- it is
  // the one thing in the world everybody is hunting.
  assert.equal(getPlayerTeamMark(PLAYER_TEAM.RABBIT), SCOREBOARD_RABBIT_MARK);
  // Rogue, observer and hunter name nothing. Every bzo player has a colour of
  // their own, so `(Rogue)` on every line of an OpenFFA server would be noise,
  // and in Rabbit Chase everyone who is not the rabbit is a hunter.
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

console.log('scoreboard tests passed');
