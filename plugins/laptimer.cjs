/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// laptimer.cjs - times laps of a race track. The map draws the line:
//
//   finishline
//     position -85 90 0
//     heading 180
//     width 30
//     height 10
//   end
//
// `position` is the line's middle, `heading` the way racers cross it in
// degrees (0 east, 90 north), `width` how far the line reaches either side,
// and `height` how far above `position` a tank still counts. Crossing it the
// right way starts a lap, and the next crossing finishes it and starts the
// next. Crossing it backwards, dying or leaving drops the lap under way.
//
// `checkpoint` blocks are lines of the same shape, with `order` for which
// comes first (file order where none is given). A lap counts only once every
// checkpoint has been crossed in order since it started, so no teleporter or
// cut across the infield is a shortcut.
//
// Each racer's waypoint (docs/waypoints.md) is the next line to cross: the
// finish line until a lap starts, then each checkpoint in turn, then the
// finish line again.
//
// Each lap is a point on the scoreboard. Each map keeps its ten fastest on
// several boards (`BOARDS`): registered players on any client, then each
// client, then everyone, bots and autopilots included -- today's, the last
// seven days' and all time's (`PERIODS`), kept in the data directory. `/laps`
// lists the first board of all time, and a web page, `/plugins/laptimer/`,
// every board of every map. Today's fastest registered player follows the
// server's title on both lists.
//
// A lap that beats something sets off fireworks over the racer that every
// client sees, bigger the more it beat (`FIREWORKS`): a personal best, today's
// fastest, a place among the fastest, the record. Each is a server Guided
// Missile launched steeply upward and ended high overhead, where a Shock Wave
// and a star of shots, none of them aimed below level, burst in the racer's
// colours. A rocket whose path is not clear sky -- a roof or a sign over the
// line -- is not launched.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RECORDS_KEPT = 10;
// A move faster than this, across or up, is a teleport or a respawn, not a
// crossing. A BZFlag client sends its position only when it strays from where
// it said it was going, about once a second on a conveyor, so the step is
// judged against the time it took rather than a fixed length. Tank and
// conveyor together run about 135 a second; a jump or a fall changes height
// far slower than a teleporter does.
const MAX_SPEED = 200;
const MAX_CLIMB = 60;
const STEP_SLACK = 10;

// Each goal's fireworks: rockets in each wave, waves a second apart, shots in
// each burst's star, and the colours, by upstream's team numbers (1 red,
// 2 green, 3 blue, 4 purple), `own` for the racer's team.
const FIREWORKS = {
  personal: { rockets: 1, waves: 1, star: 6, colors: 'own' },
  today: { rockets: 3, waves: 1, star: 8, colors: [1, 3, 'own'] },
  place: { rockets: 5, waves: 1, star: 8, colors: [2, 4, 'own'] },
  record: { rockets: 4, waves: 2, star: 10, colors: [1, 2, 3, 4] },
};
// Launched from just over the racer's tank, between these angles above level,
// and burst after this long in the air: a hundred or so overhead, well clear
// of a jumping tank and of the Shock Wave's reach.
const ROCKET_RISE = 4;
const ROCKET_ELEVATION_MIN = (62 * Math.PI) / 180;
const ROCKET_ELEVATION_MAX = (80 * Math.PI) / 180;
const ROCKET_FLIGHT_MS = [1100, 1500];
const WAVE_MS = 1000;
// A star's shots leave level to this far above it.
const STAR_ELEVATION = (35 * Math.PI) / 180;
// How often the title's word on today's fastest is checked, for a new day or
// another map.
const TITLE_CHECK_MS = 60000;

function formatTime(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = (ms % 60000) / 1000;
  return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
}

// The boards, first the one a lap's place is announced on. A bot's lap, or
// one Ace or Roger drove for a player, counts only on the last.
const BOARDS = [
  { id: 'registered', title: 'Registered players', counts: (e) => Boolean(e.bzid) && !e.auto },
  { id: 'bzflag', title: 'BZFlag clients', counts: (e) => e.client === 'bzflag' && !e.auto },
  { id: 'mobile', title: 'bzo on mobile', counts: (e) => e.client === 'mobile' && !e.auto },
  { id: 'desktop', title: 'bzo on desktop', counts: (e) => e.client === 'desktop' && !e.auto },
  { id: 'vr', title: 'bzo in VR', counts: (e) => e.client === 'vr' && !e.auto },
  { id: 'everyone', title: 'Everyone, bots included', counts: () => true },
];
const CLIENT_NAMES = { bzflag: 'BZFlag', mobile: 'mobile', desktop: 'desktop', vr: 'VR' };

// Today, by UTC, as a lap's `day` names it; and the day `back` days before.
const dayOf = (date) => date.toISOString().slice(0, 10);
const daysBefore = (day, back) => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) - (back * 86400000)));
const WEEK_DAYS = 7;

// A map's laps for a period: its all-time bests, or each player's best of
// each day for the last week, as kept.
const PERIODS = [
  { id: 'day', title: 'Today', laps: (kept, today) => kept.days.filter((e) => e.day === today) },
  { id: 'week', title: 'Last 7 days',
    laps: (kept, today) => kept.days.filter((e) => e.day > daysBefore(today, WEEK_DAYS)) },
  { id: 'all', title: 'All time', laps: (kept) => kept.all },
];

// A map's kept laps, from any shape the file has held: once a list of all
// time's alone.
const keptLaps = (value) => (Array.isArray(value)
  ? { all: value, days: [] }
  : { all: value?.all || [], days: value?.days || [] });

// Who set a lap: a registered player by BZID, anyone else by callsign.
const identity = (entry) => (entry.bzid ? `bzid:${entry.bzid}` : `callsign:${entry.callsign}`);

// A board's ten fastest from a map's laps, each player's best once.
function board(entries, which) {
  const seen = new Set();
  return entries.filter(which.counts).sort((a, b) => a.ms - b.ms).filter((entry) => {
    if (seen.has(identity(entry))) return false;
    seen.add(identity(entry));
    return true;
  }).slice(0, RECORDS_KEPT);
}

// What a lap was driven on, as the boards' columns show it.
const drivenOn = (entry) => (entry.bot ? 'bot' : `${CLIENT_NAMES[entry.client] ?? ''}${entry.auto ? ' autopilot' : ''}`);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

// The records page for a period: each map's boards, the map being played
// first, and a board with no laps left out. bzo's palette, as `/list` wears.
function recordsPage(records, current, period, today) {
  const maps = Object.keys(records).filter((map) => period.laps(keptLaps(records[map]), today).length)
    .sort((a, b) => (b === current) - (a === current) || a.localeCompare(b));
  const tables = maps.map((map) => {
    const laps = period.laps(keptLaps(records[map]), today);
    const boards = BOARDS.map((which) => {
      const list = board(laps, which);
      if (list.length === 0) return '';
      // On a board of every client, which one each lap was driven on.
      const mixed = which.id === 'registered' || which.id === 'everyone';
      const rows = list.map((entry, index) => `<tr><td>${index + 1}</td><td>${formatTime(entry.ms)}</td>`
        + `<td>${escapeHtml(entry.callsign)}</td>${mixed ? `<td>${escapeHtml(drivenOn(entry))}</td>` : ''}`
        + `<td>${escapeHtml(String(entry.at ?? '').slice(0, 10))}</td></tr>`);
      return `<h3>${which.title}</h3>\n<table><thead><tr><th>#</th><th>Lap</th><th>Player</th>`
        + `${mixed ? '<th>On</th>' : ''}<th>Date</th></tr></thead>\n<tbody>${rows.join('\n')}</tbody>\n</table>`;
    }).filter(Boolean);
    return `<h2>${escapeHtml(map)}${map === current ? ' (playing now)' : ''}</h2>\n${boards.join('\n')}`;
  });
  const nav = PERIODS.map((each) => (each === period
    ? `<strong>${each.title}</strong>`
    : `<a href="?period=${each.id}">${each.title}</a>`)).join(' | ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fastest laps</title>
<link rel="icon" sizes="16x16 32x32 48x48" href="/favicon.ico">
<style>
  body { font: 14px/1.4 Arial, sans-serif; margin: 2rem; color: #fff; background: #000; }
  main { max-width: 40rem; }
  h1 { font-size: 1.3rem; margin: 2rem 0 0.5rem; color: #4CAF50; }
  h2 { font-size: 1.15rem; margin: 2rem 0 0.25rem; color: #4CAF50; }
  h3 { font-size: 1rem; margin: 1.25rem 0 0.25rem; color: #ccc; }
  a { color: #66bb6a; }
  .nav { font-size: 1.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid #333; }
  .muted { color: #999; font-size: 0.9em; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 0.35rem 0.6rem; text-align: left; }
  th { white-space: nowrap; color: #4CAF50; border-bottom: 2px solid #4CAF50; }
  td:nth-child(2) { font-variant-numeric: tabular-nums; }
  tbody tr:nth-child(even) { background: rgba(255, 255, 255, 0.05); }
  tbody tr:hover { background: rgba(76, 175, 80, 0.15); }
</style>
</head><body><main>
<p class="nav"><a href="/">bzo</a> | <a href="/list">servers</a> | ${nav}</p>
<h1>Fastest laps</h1>
${period.id === 'all' ? '' : '<p class="muted">Days are UTC.</p>'}
${tables.length ? tables.join('\n') : '<p>No laps recorded yet.</p>'}
</main></body></html>
`;
}

module.exports = {
  meta: {
    name: 'Lap Timer',
    version: '1.0',
    author: 'Tim Riker',
    description: "times laps across the map's finishline, through its checkpoints, and keeps the best",
    license: 'AGPL-3.0',
  },

  Init(bz) {
    this.bz = bz;
    this.finishes = [];
    this.checkpoints = [];
    this.racers = new Map();
    this.file = path.join(bz.bz_getDataDir(), 'laptimer.json');
    this.records = this.load();
    bz.bz_registerCustomMapObject('FINISHLINE', (name, data) => this.mapObject(name, data));
    bz.bz_registerCustomMapObject('CHECKPOINT', (name, data) => this.mapObject(name, data));
    bz.Register(bz.bz_ePlayerUpdateEvent);
    bz.Register(bz.bz_ePlayerDieEvent);
    bz.Register(bz.bz_ePlayerSpawnEvent);
    bz.Register(bz.bz_ePlayerPartEvent);
    bz.bzhttp_RegisterVDir({
      VDirName: () => 'laptimer',
      VDirDescription: () => 'Fastest laps on each map',
      RequiredAuthentiction: bz.eNoAuth,
      GeneratePage: (request, response) => {
        if (request.Resource.replace(/^\/plugins\/laptimer\/?/i, '') !== '') return bz.eNoPage;
        response.ReturnCode = bz.e200OK;
        response.AddHeader('Content-Type', 'text/html; charset=utf-8');
        const period = PERIODS.find((each) => each.id === request.GetParamater('period'))
          || PERIODS.find((each) => each.id === 'all');
        response.AddBodyData(recordsPage(this.records, bz.bz_getMapName(), period, dayOf(new Date())));
        return bz.ePageDone;
      },
    });
    bz.bz_registerCustomSlashCommand('laps',
      (playerID) => this.listRecords(playerID), { help: '- the fastest laps on this map' });
    this.timers = new Set();
    this.titled = null;
    this.title();
    this.titleTimer = setInterval(() => this.title(), TITLE_CHECK_MS);
    this.titleTimer.unref?.();
  },

  // Today's fastest registered player on this map, after the server's title
  // on both lists; none while no registered player has a lap today.
  title() {
    const { bz } = this;
    const today = dayOf(new Date());
    const laps = PERIODS.find((each) => each.id === 'day').laps(keptLaps(this.records[bz.bz_getMapName()]), today);
    const best = board(laps, BOARDS.find((which) => which.id === 'registered'))[0];
    const text = best ? `today ${best.callsign} ${formatTime(best.ms)}` : '';
    if (text === this.titled) return;
    this.titled = text;
    bz.bz_setPublicDescriptionSuffix?.(text);
  },

  // Rockets from over the racer, each burst high overhead.
  fireworks(player, goal) {
    const { bz } = this;
    const show = FIREWORKS[goal];
    const pos = player.lastKnownState?.pos;
    if (!show || !pos) return;
    const origin = [pos[0], pos[1], pos[2] + ROCKET_RISE];
    const speed = bz.bz_getBZDBDouble?.('_shotSpeed') || 100;
    const colorOf = (n) => {
      const color = show.colors === 'own' ? 'own' : show.colors[n % show.colors.length];
      return color === 'own' ? player.team : color;
    };
    for (let wave = 0; wave < show.waves; wave += 1) {
      this.later(wave * WAVE_MS, () => {
        for (let rocket = 0; rocket < show.rockets; rocket += 1) {
          const heading = (((rocket + (wave / 2)) / show.rockets) + (Math.random() * 0.1)) * 2 * Math.PI;
          const elevation = ROCKET_ELEVATION_MIN + (Math.random() * (ROCKET_ELEVATION_MAX - ROCKET_ELEVATION_MIN));
          const flight = ROCKET_FLIGHT_MS[0] + (Math.random() * (ROCKET_FLIGHT_MS[1] - ROCKET_FLIGHT_MS[0]));
          const dir = [Math.cos(elevation) * Math.cos(heading), Math.cos(elevation) * Math.sin(heading),
            Math.sin(elevation)];
          const reach = (speed * flight) / 1000;
          const burst = origin.map((v, i) => v + (dir[i] * reach));
          if (bz.bz_lineIsClear && !bz.bz_lineIsClear(origin, burst)) continue;
          const color = colorOf(rocket + wave);
          const id = bz.bz_fireServerShot('GM', origin, dir, color);
          if (!id) continue;
          this.later(flight, () => this.burst(id, color, show.star));
        }
      });
    }
  },

  // A rocket's burst where it has got to: a Shock Wave, and a star of shots
  // none of them aimed below level.
  burst(id, color, star) {
    const { bz } = this;
    const at = bz.bz_endServerShot?.(id);
    if (!at) return;
    bz.bz_fireServerShot('SW', at, [0, 0, 0], color);
    const turn = Math.random();
    for (let shot = 0; shot < star; shot += 1) {
      const heading = ((shot + turn) / star) * 2 * Math.PI;
      const elevation = (shot % 2) * STAR_ELEVATION;
      bz.bz_fireServerShot('', at,
        [Math.cos(elevation) * Math.cos(heading), Math.cos(elevation) * Math.sin(heading), Math.sin(elevation)], color);
    }
  },

  // Runs `fn` after `ms`, or now for none, cancelled if the plugin unloads.
  later(ms, fn) {
    if (ms <= 0) {
      fn();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  },


  mapObject(name, data) {
    if ((name !== 'FINISHLINE' && name !== 'CHECKPOINT') || !data) return false;
    const line = { x: 0, y: 0, z: 0, heading: 0, width: 30, height: 10, order: this.checkpoints.length };
    for (const text of data.data) {
      const nubs = String(text).trim().split(/\s+/);
      const key = nubs[0].toUpperCase();
      const n = (i) => Number.parseFloat(nubs[i]);
      if ((key === 'POSITION' || key === 'POS') && nubs.length > 3) {
        [line.x, line.y, line.z] = [n(1), n(2), n(3)];
      } else if (key === 'HEADING' && nubs.length > 1) {
        line.heading = n(1);
      } else if (key === 'WIDTH' && nubs.length > 1) {
        line.width = n(1);
      } else if (key === 'HEIGHT' && nubs.length > 1) {
        line.height = n(1);
      } else if (key === 'ORDER' && nubs.length > 1) {
        line.order = n(1);
      }
    }
    if (![line.x, line.y, line.z, line.heading, line.width, line.height, line.order].every(Number.isFinite)) {
      return false;
    }
    const radians = line.heading * Math.PI / 180;
    line.dirX = Math.cos(radians);
    line.dirY = Math.sin(radians);
    if (name === 'FINISHLINE') {
      this.finishes.push(line);
    } else {
      this.checkpoints.push(line);
      this.checkpoints.sort((a, b) => a.order - b.order);
    }
    return true;
  },

  Event(data) {
    const { bz } = this;
    switch (data.eventType) {
      case bz.bz_ePlayerUpdateEvent:
        this.onUpdate(data.playerID, data.state.pos);
        break;
      case bz.bz_ePlayerSpawnEvent:
      case bz.bz_ePlayerDieEvent:
        this.drop(data.playerID);
        this.aim(data.playerID);
        break;
      case bz.bz_ePlayerPartEvent:
        this.racers.delete(data.playerID);
        break;
      default:
        break;
    }
  },

  racer(playerID) {
    let racer = this.racers.get(playerID);
    if (!racer) {
      racer = { pos: null, at: 0, lapStart: null, next: 0, laps: 0, best: null };
      this.racers.set(playerID, racer);
    }
    return racer;
  },

  // A death or a respawn: the lap under way is lost, and the next position is
  // not a step from the last one.
  drop(playerID) {
    const racer = this.racer(playerID);
    racer.pos = null;
    racer.lapStart = null;
    racer.next = 0;
    racer.aimed = null;
  },

  onUpdate(playerID, pos) {
    const now = Date.now();
    const racer = this.racer(playerID);
    const from = racer.pos;
    const fromAt = racer.at;
    racer.pos = [pos[0], pos[1], pos[2]];
    racer.at = now;
    if (!from) return;
    const seconds = (now - fromAt) / 1000;
    if (Math.hypot(pos[0] - from[0], pos[1] - from[1]) > (MAX_SPEED * seconds) + STEP_SLACK) return;
    if (Math.abs(pos[2] - from[2]) > (MAX_CLIMB * seconds) + STEP_SLACK) return;
    // Every line the step crossed, in the order it crossed them.
    const crossings = [...this.finishes, ...this.checkpoints]
      .map((line) => ({ line, ...this.crossing(line, from, pos) }))
      .filter((crossing) => crossing.fraction !== undefined)
      .sort((a, b) => a.fraction - b.fraction);
    for (const { line, forward, fraction } of crossings) {
      if (this.finishes.includes(line)) {
        if (forward) {
          // When it crossed, between the two moves, rather than when it was told.
          this.cross(playerID, racer, fromAt + ((now - fromAt) * fraction));
        } else {
          racer.lapStart = null;
        }
      } else if (forward && racer.lapStart !== null && this.checkpoints[racer.next] === line) {
        racer.next += 1;
      }
    }
    if (crossings.length > 0) this.aim(playerID);
  },

  // The racer's waypoint at the next line to cross, labelled with which. It
  // has no arrival radius: the line's crossing moves it on.
  aim(playerID) {
    const { bz } = this;
    const racer = this.racer(playerID);
    const checkpoint = racer.lapStart !== null ? this.checkpoints[racer.next] : null;
    const line = checkpoint || this.finishes[0];
    if (!line) return;
    const label = checkpoint
      ? `Checkpoint ${racer.next + 1} of ${this.checkpoints.length}`
      : 'Finish line';
    const key = `${line.x},${line.y},${label}`;
    if (racer.aimed === key) return;
    racer.aimed = key;
    bz.bz_setWaypoint?.(playerID, line.x, line.y, line.z, label, 0);
  },

  // Where the step from `from` to `to` passes the line, if it does: which way,
  // and how far along the step.
  crossing(line, from, to) {
    const along = (p) => ((p[0] - line.x) * line.dirX) + ((p[1] - line.y) * line.dirY);
    const before = along(from);
    const after = along(to);
    if ((before < 0) === (after < 0)) return null;
    const fraction = before / (before - after);
    const x = from[0] + ((to[0] - from[0]) * fraction);
    const y = from[1] + ((to[1] - from[1]) * fraction);
    const z = from[2] + ((to[2] - from[2]) * fraction);
    const across = ((x - line.x) * -line.dirY) + ((y - line.y) * line.dirX);
    if (Math.abs(across) > line.width) return null;
    if (z < line.z - 1 || z > line.z + line.height) return null;
    return { forward: after > before, fraction };
  },

  cross(playerID, racer, at) {
    const { bz } = this;
    const started = racer.lapStart;
    const missed = racer.next < this.checkpoints.length ? racer.next + 1 : null;
    racer.lapStart = at;
    racer.next = 0;
    if (started === null) {
      this.say(playerID, 'Lap started.');
      return;
    }
    if (missed !== null) {
      this.say(playerID, 'Lap not counted: missed checkpoint {checkpoint}. Lap started.', { checkpoint: missed });
      return;
    }
    const ms = Math.round(at - started);
    racer.laps += 1;
    const personal = racer.best === null || ms < racer.best;
    if (personal) racer.best = ms;
    bz.bz_incrementPlayerWins(playerID, 1);
    const player = bz.bz_getPlayerByIndex(playerID);
    if (!player) return;
    const { place, todayPlace } = this.record(player, ms);
    this.title();
    const params = { player: player.callsign, lap: racer.laps, time: formatTime(ms), place };
    // The biggest goal the lap made; a bot's or an autopilot's makes none.
    const goal = place === 1 ? 'record' : (place ? 'place' : (todayPlace === 1 ? 'today'
      : (personal && racer.laps > 1 ? 'personal' : null)));
    if (goal && !player.bot && !player.autopilot) this.fireworks(player, goal);
    if (place === 1) this.say(bz.BZ_ALLUSERS, '{player}: lap {lap} in {time} -- a new lap record!', params);
    else if (place) this.say(bz.BZ_ALLUSERS, '{player}: lap {lap} in {time} -- #{place} on this map', params);
    else if (todayPlace === 1) this.say(bz.BZ_ALLUSERS, "{player}: lap {lap} in {time} -- today's fastest", params);
    else if (personal && racer.laps > 1) this.say(bz.BZ_ALLUSERS, '{player}: lap {lap} in {time} -- a personal best', params);
    else this.say(bz.BZ_ALLUSERS, '{player}: lap {lap} in {time}', params);
  },

  // Keeps the lap where it makes a board, each player's best on each client:
  // all time's where some board shows it, and the day's for a week. Says
  // where it placed on the first board it counts on, of all time and of
  // today, each null where it did not improve their place there or counts
  // only among everyone.
  record(player, ms) {
    const map = this.bz.bz_getMapName();
    const now = new Date();
    const today = dayOf(now);
    const lap = {
      ...(player.bzID ? { bzid: player.bzID } : {}),
      callsign: player.callsign,
      ms,
      at: now.toISOString(),
      client: player.client ?? null,
      ...(player.bot ? { bot: true } : {}),
      ...((player.bot || player.autopilot) ? { auto: true } : {}),
    };
    const sameKind = (entry) => identity(entry) === identity(lap) && entry.client === lap.client
      && Boolean(entry.auto) === Boolean(lap.auto);
    const kept = keptLaps(this.records[map]);
    const first = BOARDS.find((which) => which.id !== 'everyone' && which.counts(lap));
    const placeOn = (laps, entry) => (first ? board(laps, first).indexOf(entry) + 1 || null : null);
    let changed = false;
    let place = null;
    const mine = kept.all.find(sameKind);
    if (!mine || ms < mine.ms) {
      const next = [...kept.all.filter((entry) => !sameKind(entry)), lap];
      // Only a lap some board shows is kept.
      const shown = new Set(BOARDS.flatMap((which) => board(next, which)));
      kept.all = next.filter((entry) => shown.has(entry)).sort((a, b) => a.ms - b.ms);
      if (shown.has(lap)) {
        changed = true;
        place = placeOn(kept.all, lap);
      }
    }
    let todayPlace = null;
    const weekStart = daysBefore(today, WEEK_DAYS);
    const days = kept.days.filter((entry) => entry.day > weekStart);
    if (days.length !== kept.days.length) changed = true;
    const mineToday = days.find((entry) => entry.day === today && sameKind(entry));
    if (!mineToday || ms < mineToday.ms) {
      const dayLap = { ...lap, day: today };
      kept.days = [...days.filter((entry) => entry !== mineToday), dayLap];
      changed = true;
      todayPlace = placeOn(kept.days.filter((entry) => entry.day === today), dayLap);
    } else {
      kept.days = days;
    }
    this.records[map] = kept;
    if (changed) this.save();
    return { place, todayPlace };
  },

  // The first board with laps on it: registered players' where there are any.
  listRecords(playerID) {
    const { bz } = this;
    const entries = keptLaps(this.records[bz.bz_getMapName()]).all;
    const list = BOARDS.map((which) => board(entries, which)).find((laps) => laps.length > 0) || [];
    if (list.length === 0) {
      this.say(playerID, 'No laps recorded on this map yet.');
      return true;
    }
    this.say(playerID, 'Fastest laps on this map:');
    list.forEach((entry, index) => {
      this.say(playerID, '{place}. {time} {player}', { place: index + 1, time: formatTime(entry.ms), player: entry.callsign });
    });
    return true;
  },

  say(to, message, params) {
    this.bz.bz_sendTextMessage(this.bz.BZ_SERVER, to, message, params);
  },

  load() {
    try {
      const records = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return records && typeof records === 'object' ? records : {};
    } catch {
      return {};
    }
  },

  save() {
    try {
      fs.writeFileSync(this.file, `${JSON.stringify(this.records, null, 2)}\n`);
    } catch (error) {
      this.bz.bz_debugMessage(0, `laptimer: could not save ${this.file}: ${error.message}`);
    }
  },

  Cleanup() {
    this.bz.bz_removeCustomSlashCommand('laps');
    clearInterval(this.titleTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.bz.bz_setPublicDescriptionSuffix?.('');
  },
};
