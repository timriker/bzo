/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Keeping a picture of each listed BZFlag server's world up to date, without
// downloading worlds that have not changed (issue #147).
//
// There is nothing to draw here: an imported world is registered like any
// other map, so `registerMapFile` has already drawn its overview beside its
// JSON, and server.js keeps a copy under the world's BZFlag hash that outlives
// the import. What this owns is the *decision* -- whether the picture held for
// a server is still of the world it runs, answered as cheaply as the question
// allows.
//
// Three signals, cheapest first:
//
//   1. **The public list entry.** Refreshed every few minutes anyway, so it
//      costs nothing. A server bzo has never seen is new; one whose listed
//      configuration has changed may have changed map with it. Either makes a
//      server due for a check ahead of its schedule.
//   2. **`MsgWantWHash`.** One short connection and four frames, on a socket
//      that never enters the game, answering "is this the same world?"
//      exactly. A `p` hash is stable across that server's restarts, so the
//      usual answer is yes and nothing further happens.
//   3. **The world itself**, which is the only expensive one and runs only
//      when the hash says the picture is stale or missing.
//
// With no signal at all a server is rechecked on `RECHECK_MS`, or on
// `TEMP_RECHECK_MS` for a generated world. That is the
// floor that makes a weak signal safe: a configuration change the fingerprint
// misses delays a redraw by a day rather than losing it, which is why the
// fingerprint can afford to be a guess.
const fs = require('fs');
const path = require('path');

// How long a picture is trusted with no other reason to doubt it. A day is
// what makes "your thumbnail will update tomorrow" a true answer, and at a
// couple of hundred listed servers it is about ten short dials an hour.
const RECHECK_MS = 24 * 60 * 60 * 1000;

// A `t` world is one bzfs generated rather than read from a file, and it
// usually changes each time that server restarts (`bzfs.cxx:1211`). Its dial
// is the same cheap one, so it is asked hourly, and the world only comes down
// when the hash has moved.
const TEMP_RECHECK_MS = 60 * 60 * 1000;

function recheckMs(worldHash) {
  return /^t/i.test(worldHash || '') ? TEMP_RECHECK_MS : RECHECK_MS;
}

// Every join waits for a server with nobody on it, player or observer: a join
// and a part show in everybody's chat. A server that has somebody on it when
// a join is due owes one, and is dialled again this soon to see whether it has
// emptied; the dial itself joins nothing.
const JOIN_RETRY_MS = 20 * 60 * 1000;

// A server's world variables, read on a join (bzfs sends them to no one else),
// are trusted for a month. A new generated world (`t`) is no reason to read
// them again, since a restart rolls one without touching `-set`; a new world
// from a file (`p`) usually comes with its own. A join that brought none back
// is tried again after a week.
const VARIABLES_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

// What an unregistered player may do there -- watch, chat, spawn -- is asked during
// the one join a server costs (`enterAndProbe` in remote-world-import.cjs) and
// trusted for a month: an operator changes a groups file rarely, and a changed
// list entry asks again sooner. An answer that did not come is tried again
// after a week rather than every day, since the usual reason is a server that
// never had nobody on it.
const GUEST_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
const GUEST_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
// A visit made only for these questions is a join nobody needed for a world,
// so they are spread thin: one every ten minutes, which takes a list of a few
// hundred servers a couple of days to go round. A server whose turn comes too
// soon is simply asked on a later day's check.
const GUEST_VISIT_GAP_MS = 10 * 60 * 1000;
// A server's build changes when its operator upgrades, and one that never
// answers `/serverquery` is asked again only this often.
const VERSION_RECHECK_MS = GUEST_RETRY_MS;

// Whether a server's variables are worth a join: never read, read a month
// ago, or a join that brought none back a week ago. A record from before the
// read was dated counts from its last version check, made on the same join.
function variablesDue(record, now) {
  const at = record.variablesAt || (record.variables?.length ? record.serverVersionAskedAt : 0) || 0;
  if (record.variablesAskedAt > at) return now - record.variablesAskedAt > GUEST_RETRY_MS;
  if (at) return now - at > VARIABLES_RECHECK_MS;
  return true;
}

// Whether a server's record alone says a join is due: a guest answer gone
// stale, its build not asked for a week, or its variables due. Read off the
// record rather than the last check, because something else can confirm its
// world -- a proxy's pass every fifteen minutes, a view -- and date the
// check without making the join.
function joinDue(record, now) {
  if (!record) return false;
  return ['chat', 'watch', 'spawn'].some((field) => guestFactDue(record.guest, field, now, false))
    || !(now - (record.serverVersionAskedAt || 0) < VERSION_RECHECK_MS)
    || variablesDue(record, now);
}

// When a server is next due, and how overdue it is: where it owes a join
// and one could be made now (`joinGapOpen`), `JOIN_RETRY_MS` after this
// tracker last dialled it (`dialedAt`), which a confirmation from elsewhere
// does not move; otherwise its world's recheck after its last check.
function nextDue(record, now, joinGapOpen) {
  if (joinGapOpen && (record?.joinOwed || joinDue(record, now))) {
    const at = (record.dialedAt || 0) + JOIN_RETRY_MS;
    return { at, age: now - (record.dialedAt || 0), wait: JOIN_RETRY_MS };
  }
  const wait = recheckMs(record?.worldHash);
  return { at: (record?.checkedAt || 0) + wait, age: now - (record?.checkedAt || 0), wait };
}

function isGuestAnswer(value) {
  return value === 'yes' || value === 'no';
}

// Whether a guest fact is worth asking about again: never asked, a known
// answer gone stale, or an unanswered one due another try.
function guestFactDue(guest, field, now, listChanged) {
  const at = guest?.[`${field}At`];
  if (!at) return true;
  if (listChanged) return true;
  return now - at > (isGuestAnswer(guest[field]) ? GUEST_RECHECK_MS : GUEST_RETRY_MS);
}

// A new answer over an old one. A silence does not overwrite something a
// server actually said, but it is dated, so the retry waits its week.
function mergeGuest(previous, fresh, now) {
  const next = { ...(previous || {}) };
  for (const field of ['watch', 'chat', 'spawn']) {
    if (fresh?.[field] === undefined) continue;
    if (isGuestAnswer(fresh[field]) || !isGuestAnswer(next[field])) {
      next[field] = fresh[field];
      next[`${field}Detail`] = fresh[`${field}Detail`] || '';
    }
    next[`${field}At`] = now;
  }
  // Banned or not is the latest join's answer, whichever way it went, dated so
  // a ban is asked about again only once a month.
  if (typeof fresh?.banned === 'boolean') {
    next.banned = fresh.banned;
    next.bannedAt = now;
    if (!fresh.banned) {
      delete next.bannedDetail;
      delete next.bannedCode;
    } else if (fresh.bannedDetail) {
      next.bannedDetail = fresh.bannedDetail;
      next.bannedCode = fresh.bannedCode;
    }
  }
  return next;
}

// A server that refused, timed out or sent something unusable is not asked
// again straight away. Shorter than `RECHECK_MS` because being unreachable is
// usually the temporary one of the two -- but doubling per consecutive
// failure, because the other kind exists and retrying it is pure waste. One
// listed world is larger than `JSON.stringify` can return a string for, so it
// fails identically every time it is fetched, and fetching it is not cheap.
// The cap keeps even that one being retried about weekly, which is what a
// server changing to a smaller map deserves.
const FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const FAILURE_COOLDOWN_MAX_MS = 7 * 24 * 60 * 60 * 1000;

function failureCooldown(failCount) {
  const backoff = FAILURE_COOLDOWN_MS * (2 ** Math.max(0, (failCount || 1) - 1));
  return Math.min(backoff, FAILURE_COOLDOWN_MAX_MS);
}

// One server per tick, and a floor between the expensive half. The dials are
// cheap enough that the tick rate is about politeness rather than load; the
// imports are what wants spacing, since the first pass over a list bzo has
// never seen would otherwise download every world on it at once.
const TICK_MS = 30 * 1000;
const IMPORT_GAP_MS = 60 * 1000;

// Once a pass is complete every following tick finds nothing due, so the
// tidy-up it triggers is spaced out rather than run twice a minute for the
// rest of the day.
const PASS_COMPLETE_MIN_GAP_MS = 60 * 60 * 1000;

// What the public list says about a server that is not about who happens to be
// playing. Player and observer counts move constantly and say nothing about
// the world, so they are left out; everything else here is something a change
// of map can move -- the team maxima come from the map's own bases, the option
// bits and shot count from what it sets, and the title is what an operator
// edits when they change what the server is.
//
// A guess, deliberately: it only ever makes a check happen *sooner*, never
// later, so a map change it does not notice still lands on `RECHECK_MS`.
function listEntryFingerprint(server) {
  const info = server?.info || {};
  const teamMaximums = Array.isArray(info.teamMaximums) ? info.teamMaximums.join(',') : '';
  return [
    String(server?.title || '').slice(0, 120),
    info.style, info.maxShots, info.gameOptionsBits, info.maxPlayers,
    teamMaximums, info.maxPlayerScore, info.maxTeamScore, info.maxTime,
    info.shakeTimeout, info.shakeWins,
  ].join('|');
}

function serverKey(host, port) {
  return `${host}:${port}`;
}

// `deps`: `queryServerStatus(host, port, timeout)` for the hash dial,
// `importWorld(host, port, guest)` for the download-and-register, with the
// guest questions to ask while joined; `probeGuestAccess(host, port, { spawn })`
// for those questions alone, when the world needs no download; `hasPicture(host,
// port, worldHash)` for whether a picture of that world is held -- the import
// itself is swept after two hours, the picture is not -- `isExcluded(host,
// port)` for a server this one's operator has been asked to leave alone
// (`excludeServers`, docs/server-check.md), and `log`/`logError`.
function createBzfsWorldTracker(deps) {
  const {
    statePath, queryServerStatus, importWorld, probeGuestAccess, hasPicture, onPassComplete, log, logError,
    isExcluded = () => false,
  } = deps;
  // `host:port` -> { worldHash, fingerprint, checkedAt, error, errorAt }
  const records = new Map();
  // Only servers the public list currently carries are ever checked: an import
  // is refused for a server that is not listed, so there would be nothing to
  // do with the answer.
  let listed = new Map();
  let loaded = false;
  let lastImportAt = 0;
  let lastGuestVisitAt = 0;
  let lastPassCompleteAt = 0;
  let timer = null;
  let writeTimer = null;
  let running = false;

  // Read before anything is written, whether or not the tracker is running:
  // an import somebody triggered still records what it learned, and an
  // operator who turned the sweep off must not thereby have the file
  // overwritten with only what this process happened to see.
  function load() {
    if (loaded) return;
    loaded = true;
    let raw;
    try {
      raw = fs.readFileSync(statePath, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      let pruned = 0;
      for (const [key, value] of Object.entries(parsed || {})) {
        if (!value || typeof value !== 'object') continue;
        // A size is a byte count. An older file recorded these already
        // rounded and formatted -- "10.4 KB" -- which cannot be compared,
        // summed or re-rounded, so it is dropped rather than carried: the
        // next measurement of that world writes the real number, and until
        // then a blank is the honest answer.
        for (const field of ['bzwSize', 'jsonSize', 'brotliSize']) {
          if (typeof value[field] === 'string') { delete value[field]; pruned += 1; }
        }
        for (const field of ['bzw', 'json', 'brotli']) {
          if (value[field] !== undefined && !Number.isFinite(value[field])) {
            delete value[field];
            pruned += 1;
          }
        }
        // A chat or spawn answer could only come from a join that got in, so
        // a guest record from before watching was asked already says yes.
        const g = value.guest;
        if (g && g.watch === undefined) {
          const answered = ['chat', 'spawn'].find((field) => isGuestAnswer(g[field]));
          if (answered) Object.assign(g, { watch: 'yes', watchDetail: '', watchAt: g[`${answered}At`] });
        }
        records.set(key, value);
      }
      log(`[WORLDS] restored ${records.size} tracked BZFlag world(s)`
        + (pruned > 0 ? `, dropped ${pruned} size(s) recorded as text` : ''));
    } catch (error) {
      logError(`Could not read ${statePath}:`, error);
    }
  }

  // Debounced, because a pass over a long list touches every record and this
  // is a cache nothing waits on.
  function save() {
    // Never write what was never read.
    load();
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(Object.fromEntries(records), null, 1) + '\n');
      } catch (error) {
        logError(`Could not write ${statePath}:`, error);
      }
    }, 5000);
    if (writeTimer.unref) writeTimer.unref();
  }

  // Called with each refresh of the public list. Cheap: it only compares
  // strings and marks records, and it is what makes a changed entry jump the
  // queue.
  //
  // Each listed server also says whether it answered this refresh's ping
  // (`pingAnswered`). The list server reached it to keep it listed, so one
  // that does not answer bzo is blocking bzo (`silent`), from this refresh to
  // the first that it answers again. `trustSilence` is false when most of the
  // list went quiet at once, which is this server's network, not theirs.
  function observe(servers, { trustSilence = false } = {}) {
    const next = new Map();
    for (const server of Array.isArray(servers) ? servers : []) {
      if (!server?.host || !server?.port) continue;
      next.set(serverKey(server.host, server.port), server);
    }
    listed = next;
    const now = Date.now();
    for (const [key, server] of listed) {
      const record = records.get(key);
      if (server.pingAnswered === true && record?.silent) {
        records.set(key, { ...record, silent: false, silentAt: undefined, dueNow: true });
        log(`[WORLDS] ${key} answers again`);
        save();
      } else if (server.pingAnswered === false && trustSilence && !record?.silent) {
        records.set(key, { ...record, silent: true, silentAt: now });
        log(`[WORLDS] ${key} does not answer, so excludes bzo`);
        save();
      }
    }
    for (const [key, server] of listed) {
      const record = records.get(key);
      if (!record) continue;
      const fingerprint = listEntryFingerprint(server);
      if (record.fingerprint !== fingerprint) {
        // Due now rather than on schedule, and the new fingerprint is not
        // stored until the check happens -- otherwise a change noticed here
        // would be forgotten if the check failed.
        record.dueNow = true;
      }
    }
  }

  // Whether a record says its server turns bzo away: a ban it said so with,
  // or no answer at all while the list server can still reach it.
  function blocksBzo(record) {
    return record?.guest?.banned === true || record?.silent === true;
  }

  // The most overdue server that is worth asking about, or null. A record with
  // `dueNow` outranks the schedule, and a recent failure outranks both.
  function pickDue(now) {
    let best = null;
    let bestAge = -Infinity;
    for (const [key, server] of listed) {
      if (isExcluded(server.host, server.port)) continue;
      const record = records.get(key);
      // One that does not answer at all is not dialled either: the ping that
      // finds it answering again (`observe`) is what makes it due.
      if (record?.silent) continue;
      // A server that excludes bzo is not dialled at all, hash checks included,
      // until its ban is a month old; then it is only asked whether the ban
      // still stands (`checkBan`).
      if (record?.guest?.banned === true) {
        if (now - (record.guest.bannedAt || 0) < GUEST_RECHECK_MS) continue;
        // A join waits its turn, so this one is not picked until it may go.
        if (now - lastGuestVisitAt < GUEST_VISIT_GAP_MS || now - lastImportAt < IMPORT_GAP_MS) continue;
        if (now - (record.guest.bannedAt || 0) > bestAge) {
          bestAge = now - (record.guest.bannedAt || 0);
          best = server;
        }
        continue;
      }
      if (record?.error && now - (record.errorAt || 0) < failureCooldown(record.failCount)) continue;
      let age;
      if (!record) age = Infinity;
      else if (record.dueNow || !hasPicture(server.host, server.port, record.worldHash)) age = Infinity;
      else {
        const due = nextDue(record, now, now - lastGuestVisitAt >= GUEST_VISIT_GAP_MS);
        if (due.age < due.wait) continue;
        age = due.age;
      }
      if (age > bestAge) { bestAge = age; best = server; }
    }
    return best;
  }

  // Whether a server that excluded bzo still does: one join, the guest check's,
  // and nothing else. A lifted ban leaves the server due at once, so its world
  // and the rest are learned again on the next tick.
  // `force` is an admin asking now (`recheckBan`), who waits on no gap.
  // Resolves to whether the ban is lifted, or null where it did not ask.
  async function checkBan(server, record, key, now, { force = false } = {}) {
    if (!probeGuestAccess) return null;
    if (!force && (now - lastGuestVisitAt < GUEST_VISIT_GAP_MS || now - lastImportAt < IMPORT_GAP_MS)) return null;
    lastImportAt = now;
    lastGuestVisitAt = now;
    let guest;
    try {
      guest = mergeGuest(record.guest,
        await probeGuestAccess(server.host, server.port, { chat: true, spawn: false }), now);
    } catch (error) {
      guest = mergeGuest(record.guest, { banned: true }, now);
      log(`[WORLDS] ${key} ban check failed: ${error.message}`);
    }
    const lifted = guest.banned !== true;
    records.set(key, {
      ...record,
      guest,
      // A server off the list keeps the fingerprint it last had.
      fingerprint: listed.has(key) ? listEntryFingerprint(server) : record.fingerprint,
      checkedAt: now,
      dueNow: lifted,
    });
    log(`[WORLDS] ${key} ${lifted ? 'no longer excludes bzo' : 'still excludes bzo'}`);
    save();
    return lifted;
  }

  async function check(server, now) {
    const key = serverKey(server.host, server.port);
    const record = records.get(key) || {};
    if (record.guest?.banned === true) {
      await checkBan(server, record, key, now);
      return;
    }
    const fingerprint = listEntryFingerprint(server);
    let status;
    try {
      status = await queryServerStatus(server.host, server.port);
    } catch (error) {
      records.set(key, {
        ...record,
        fingerprint,
        error: error.message,
        errorAt: now,
        failCount: (record.failCount || 0) + 1,
        dueNow: false,
      });
      save();
      return;
    }

    // What a join here would be for: the guest questions, the server's build
    // (`/serverquery`), and its world variables. Each waits for a server with
    // nobody on it, so nobody sees bzo-list come and go; a busy one owes the
    // join and is asked again in `JOIN_RETRY_MS`.
    const listChanged = Boolean(record.fingerprint) && record.fingerprint !== fingerprint;
    // Robots see nothing, so a server with only robots on it counts as empty.
    const people = Number.isInteger(status.humans) ? status.humans : status.players + status.observers;
    const empty = people === 0 && !status.full;
    // Watching is answered by the join the chat question already makes.
    const wantChat = guestFactDue(record.guest, 'chat', now, listChanged)
      || guestFactDue(record.guest, 'watch', now, listChanged);
    const wantSpawn = guestFactDue(record.guest, 'spawn', now, listChanged);
    const wantVersion = !(now - (record.serverVersionAskedAt || 0) < VERSION_RECHECK_MS);
    const newFileWorld = Boolean(status.worldHash && record.worldHash && status.worldHash !== record.worldHash
      && !/^t/i.test(status.worldHash));
    const wantVariables = newFileWorld || variablesDue(record, now);
    const wantJoin = wantChat || wantSpawn || wantVersion || wantVariables;
    const join = empty && wantJoin;
    const guestQuestions = { chat: true, spawn: wantSpawn };

    // The whole point of the dial: a world that has not changed needs no
    // download, however long ago the picture was drawn.
    if (status.worldHash && status.worldHash === record.worldHash
      && hasPicture(server.host, server.port, record.worldHash)) {
      let { guest, serverVersion, serverVersionAskedAt, variables, variablesAt, variablesAskedAt } = record;
      let joinOwed = wantJoin;
      if (join && probeGuestAccess && now - lastGuestVisitAt >= GUEST_VISIT_GAP_MS) {
        // A join is a join, so it is spaced like an import is too.
        if (now - lastImportAt < IMPORT_GAP_MS) {
          records.set(key, { ...record, dueNow: true });
          return;
        }
        lastImportAt = now;
        lastGuestVisitAt = now;
        joinOwed = false;
        variablesAskedAt = now;
        try {
          const { serverVersion: visitedVersion, variables: visitedVariables, ...answers } =
            await probeGuestAccess(server.host, server.port, guestQuestions);
          if (visitedVersion) serverVersion = visitedVersion;
          if (Array.isArray(visitedVariables)) {
            variables = visitedVariables;
            variablesAt = now;
          }
          serverVersionAskedAt = now;
          guest = mergeGuest(guest, answers, now);
        } catch (error) {
          serverVersionAskedAt = now;
          // Dated all the same, so a server that will not take the join is
          // asked again in a week rather than on every check.
          guest = mergeGuest(guest, {
            watch: 'unknown',
            watchDetail: error.message,
            chat: 'unknown',
            chatDetail: error.message,
            ...(wantSpawn ? { spawn: 'unknown', spawnDetail: error.message } : {}),
          }, now);
        }
        log(`[WORLDS] ${key} guests: watch ${guest.watch || '?'}, chat ${guest.chat || '?'}`
          + `${wantSpawn ? `, spawn ${guest.spawn || '?'}` : ''}`
          + `${serverVersion ? `; ${serverVersion}` : ''}`);
      }
      records.set(key, {
        ...record,
        guest,
        serverVersion,
        serverVersionAskedAt,
        variables,
        variablesAt,
        variablesAskedAt,
        joinOwed,
        fingerprint,
        checkedAt: now,
        error: null,
        errorAt: null,
        dueNow: false,
      });
      save();
      return;
    }

    // Stale or missing, so the world has to come down. Spaced out rather than
    // taken now if another import was recent: the record is left due, so the
    // next tick picks it up again.
    if (now - lastImportAt < IMPORT_GAP_MS) {
      records.set(key, { ...record, dueNow: true });
      return;
    }
    lastImportAt = now;
    try {
      // Without a join the import keeps the variables already held, and the
      // join is owed. With one it is made only if the server is still empty
      // when the world has come down.
      const {
        safeMapName, byteLength, compressedSize, uncompressedSize,
      } = await importWorld(server.host, server.port, join ? guestQuestions : null, join ? 'ifEmpty' : false);
      // Downloaded but not registered is a failure however well the transfer
      // went -- a world bzo cannot parse has no picture, and treating it as
      // done would leave it permanently due and re-fetched every tick.
      if (!hasPicture(server.host, server.port, status.worldHash)) {
        throw new Error('world downloaded but could not be parsed');
      }
      records.set(key, {
        worldHash: status.worldHash || '',
        // What bzfs actually sent, which is the only size anyone can compare
        // against another client's -- everything else about this world is
        // bzo's own rendering of it. The world crosses the wire deflated and
        // states both figures in its own header, so all three are that
        // server's own numbers: what arrived, what it deflated to, and what
        // it inflates back to.
        worldBytes: Number.isFinite(byteLength) ? byteLength : 0,
        worldCompressed: Number.isFinite(compressedSize) ? compressedSize : 0,
        worldUncompressed: Number.isFinite(uncompressedSize) ? uncompressedSize : 0,
        // Recorded by `noteImport` during the import just made.
        variables: records.get(key)?.variables || record.variables || [],
        variablesAt: records.get(key)?.variablesAt || record.variablesAt,
        variablesAskedAt: join ? now : record.variablesAskedAt,
        joinOwed: wantJoin && !join,
        guest: records.get(key)?.guest || record.guest,
        serverVersion: records.get(key)?.serverVersion || record.serverVersion,
        serverVersionAskedAt: records.get(key)?.serverVersionAskedAt || record.serverVersionAskedAt,
        fingerprint,
        checkedAt: now,
        error: null,
        errorAt: null,
        failCount: 0,
        dueNow: false,
      });
      const guest = records.get(key)?.guest;
      log(`[WORLDS] ${key} world ${status.worldHash || '(unhashed)'} imported as ${safeMapName}`
        + (join ? `; guests: watch ${guest?.watch || '?'}, chat ${guest?.chat || '?'}`
          + `${wantSpawn ? `, spawn ${guest?.spawn || '?'}` : ''}` : (wantJoin ? '; join waits for an empty server' : '')));
    } catch (error) {
      records.set(key, {
        ...record,
        fingerprint,
        error: error.message,
        errorAt: now,
        failCount: (record.failCount || 0) + 1,
        dueNow: false,
      });
      log(`[WORLDS] ${key} could not be imported: ${error.message}`);
    }
    save();
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const server = pickDue(now);
      if (server) {
        try {
          await check(server, now);
        } finally {
          // This tracker's own dial, which `nextDue` times a join's retry by.
          const record = records.get(serverKey(server.host, server.port));
          if (record) {
            record.dialedAt = now;
            save();
          }
        }
        return;
      }
      // Nothing left to ask about: every listed server has a current answer,
      // or a failure still inside its cooldown. That is as complete as the
      // list gets, and the moment it is safe to throw away what nothing
      // refers to any more -- before it, a picture with no reference yet may
      // simply be one this pass has not reached.
      if (!listed.size || !onPassComplete) return;
      if (now - lastPassCompleteAt < PASS_COMPLETE_MIN_GAP_MS) return;
      lastPassCompleteAt = now;
      await onPassComplete();
    } catch (error) {
      logError('[WORLDS] tracker tick failed:', error);
    } finally {
      running = false;
    }
  }

  return {
    observe,
    blocksBzo,
    // When this server is next asked about, as `pickDue` would choose it:
    // `{ at }`, a time, where 0 is as soon as the queue reaches it; `{ refresh:
    // true }` for one that does not answer, which the next list refresh pings;
    // or null for one off the list or left out of the checks. Not before `at`:
    // one server goes per tick, with gaps between joins.
    nextCheck(host, port) {
      load();
      const key = serverKey(host, port);
      const server = listed.get(key);
      if (!server || isExcluded(host, port)) return null;
      const record = records.get(key);
      if (record?.silent) return { refresh: true };
      if (record?.guest?.banned === true) return { at: (record.guest.bannedAt || 0) + GUEST_RECHECK_MS };
      if (record?.error && Date.now() - (record.errorAt || 0) < failureCooldown(record.failCount)) {
        return { at: (record.errorAt || 0) + failureCooldown(record.failCount) };
      }
      if (!record || record.dueNow || !hasPicture(host, port, record.worldHash)) return { at: 0 };
      return { at: nextDue(record, Date.now(), true).at };
    },
    // A server that excludes bzo, asked again now rather than at its month or
    // the next list refresh: an admin's Import on `/list`. A ban is asked with
    // a join (`checkBan`); a server that does not answer (`silent`), with one
    // status query. Resolves to whether it lets bzo in now, or null for a
    // server with neither on record.
    async recheckBan(host, port) {
      load();
      const key = serverKey(host, port);
      const record = records.get(key);
      if (record?.silent === true) {
        try {
          await queryServerStatus(host, port);
        } catch {
          log(`[WORLDS] ${key} still does not answer`);
          return false;
        }
        records.set(key, { ...records.get(key), silent: false, silentAt: undefined, dueNow: true });
        log(`[WORLDS] ${key} answers again`);
        save();
        if (records.get(key)?.guest?.banned !== true) return true;
      }
      if (records.get(key)?.guest?.banned !== true) return null;
      return checkBan(listed.get(key) || { host, port }, records.get(key), key, Date.now(), { force: true });
    },
    // An import somebody else caused -- a `?viewmap=` link, the Operator
    // panel, the `/list` form. It cost the same download this tracker would
    // have made, so recording it here both keeps the picture current and
    // pushes the next check a full cycle out.
    // `variables` are the world variables that server set away from upstream's
    // defaults, as `[name, value]` pairs; null when the join that carries them
    // was refused, which keeps what an earlier import learned.
    noteImport(host, port, worldHash, sizes = null, variables = null, guest = null, serverVersion = null) {
      if (!host || !port) return;
      load();
      const key = serverKey(host, port);
      const record = records.get(key) || {};
      // The listed fingerprint too, where this server is on the list at all:
      // without it the next refresh reads a record whose fingerprint does not
      // match and marks it due again, which is the check this just paid for.
      const server = listed.get(key);
      records.set(key, {
        ...record,
        fingerprint: server ? listEntryFingerprint(server) : record.fingerprint,
        worldHash: worldHash || record.worldHash || '',
        worldBytes: sizes?.byteLength || record.worldBytes || 0,
        worldCompressed: sizes?.compressedSize || record.worldCompressed || 0,
        worldUncompressed: sizes?.uncompressedSize || record.worldUncompressed || 0,
        variables: Array.isArray(variables) ? variables : (record.variables || []),
        variablesAt: Array.isArray(variables) ? Date.now() : record.variablesAt,
        guest: guest ? mergeGuest(record.guest, guest, Date.now()) : record.guest,
        serverVersion: serverVersion || record.serverVersion,
        // Asked whenever the join was made, answered or not.
        serverVersionAskedAt: Array.isArray(variables) ? Date.now() : record.serverVersionAskedAt,
        checkedAt: Date.now(),
        error: null,
        errorAt: null,
        dueNow: false,
      });
      save();
    },
    // The world variables a join here last read, as `[name, value]` pairs of
    // those away from upstream's defaults, or null where none has.
    storedVariables(host, port) {
      load();
      const record = records.get(serverKey(host, port));
      if (!Array.isArray(record?.variables)) return null;
      return record.variablesAt || record.variables.length ? record.variables : null;
    },
    // What a real visit learned: a proxied admin who spawned, or was refused.
    // As good an answer as a probe's, and it cost nobody anything extra.
    noteGuest(host, port, guest) {
      if (!host || !port || !guest) return;
      load();
      const key = serverKey(host, port);
      const record = records.get(key);
      if (!record) return;
      record.guest = mergeGuest(record.guest, guest, Date.now());
      save();
    },
    start() {
      if (timer) return;
      load();
      timer = setInterval(() => { tick(); }, TICK_MS);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    // One step of the schedule, as the timer takes it: for a test.
    tick,
    // Sizes measured off files this server holds -- the reconstructed `.bzw`,
    // the parsed world, its brotli sidecar. Remembered because the files do
    // not last: an import is swept two hours after it was fetched
    // (`sweepStaleImports`), and a row would otherwise lose figures that were
    // perfectly true when taken. Only written when one actually changes, so
    // reading a list does not keep rewriting the file.
    noteSizes(host, port, sizes) {
      load();
      const key = serverKey(host, port);
      const record = records.get(key);
      if (!record) return;
      let changed = false;
      for (const [field, value] of Object.entries(sizes)) {
        if (value && record[field] !== value) {
          record[field] = value;
          changed = true;
        }
      }
      if (changed) save();
    },

    // The world hash of every server on the list, so the picture cleanup
    // keeps each one a listed server is still running. A server off the list
    // uses nothing; the cleanup's own day of grace is what covers one that
    // is only briefly away.
    worldHashes() {
      load();
      return [...listed.keys()].map((key) => records.get(key)?.worldHash).filter(Boolean);
    },

    // Every tracked server last seen running this world, as `host:port`: what
    // a replay's row calls a map no local file matches.
    serversWithWorld(worldHash) {
      load();
      if (!worldHash) return [];
      return [...records.entries()].filter(([, record]) => record.worldHash === worldHash).map(([key]) => key);
    },

    // For `/list`, so a row can say what it knows about that server's world.
    recordFor(host, port) {
      load();
      return records.get(serverKey(host, port)) || null;
    },
    RECHECK_MS,
  };
}

module.exports = {
  createBzfsWorldTracker,
  listEntryFingerprint,
  RECHECK_MS,
  TEMP_RECHECK_MS,
  FAILURE_COOLDOWN_MS,
  GUEST_RECHECK_MS,
  GUEST_RETRY_MS,
  GUEST_VISIT_GAP_MS,
};
