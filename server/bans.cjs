/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// bans.cjs - the server's ban list, as upstream's AccessControlList keeps
// its BZID and address bans (src/bzfs/AccessControlList.cxx): who, until
// when, banned by whom and why. Persisted by the caller through `onChange`
// and `serialize`, as sessions.json is. The master ban list
// (`setMasterBans`) sits beside it and is never persisted: it is fetched
// again, as upstream's is. `now` is milliseconds, injected so a test can run
// the clock.

const { parseWhitelistEntry, addressMatchesWhitelist } = require('./sessions.cjs');

// An address ban's mask: an IPv4 or IPv6 address or CIDR block, parsed and
// matched as `adminWhitelist` is. Upstream's wildcards (`1.2.*.*`,
// AccessControlList::convert) are taken and become CIDR (`1.2.0.0/16`); a
// `*` that is not a whole trailing octet is refused, as is one beside a `/`.
// Returns the mask as written back, the parsed entry and a key that two
// spellings of one block share, or null.
function parseBanMask(text) {
  let mask = String(text || '').trim().replace(/^::ffff:/i, '');
  if (mask.includes('*')) {
    if (mask.includes('/')) return null;
    const octets = mask.split('.');
    if (octets.length !== 4) return null;
    const stars = octets.findIndex((octet) => octet === '*');
    if (stars === -1 || octets.slice(stars).some((octet) => octet !== '*')) return null;
    mask = `${octets.map((octet) => (octet === '*' ? '0' : octet)).join('.')}/${stars * 8}`;
  }
  const entry = parseWhitelistEntry(mask);
  if (!entry) return null;
  return { mask, entry, key: `${entry.family}:${entry.network}:${entry.mask}` };
}

// An entry's block in CIDR form, `1.2.0.0/16` or `2001:db8::/32`, whatever
// spelling it was written in.
function cidrText(entry) {
  if (entry.family === 4) {
    const bits = entry.mask === 0 ? 0 : Math.clz32(~entry.mask >>> 0);
    const value = entry.network >>> 0;
    return `${[24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.')}/${bits}`;
  }
  let bits = 0;
  for (let bit = 127n; bit >= 0n && ((entry.mask >> bit) & 1n); bit -= 1n) bits += 1;
  const groups = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(Number((entry.network >> shift) & 0xffffn));
  // RFC 5952: the longest run of two or more zero groups becomes `::`.
  let best = -1;
  let bestLength = 1;
  for (let start = 0; start < 8;) {
    let end = start;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - start > bestLength) {
      best = start;
      bestLength = end - start;
    }
    start = end + 1;
  }
  const hex = groups.map((group) => group.toString(16));
  const text = best === -1 ? hex.join(':')
    : `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLength).join(':')}`;
  return `${text}/${bits}`;
}

// The master ban list's text (AccessControlList::merge): blocks of an
// address line -- or `host: <pattern>` or `bzid: <id>` -- then `end: <unix
// seconds, 0 forever>`, `banner: <who>` and `reason: <why>`. Addresses come
// back in CIDR form: a trailing `*` octet is a block, as `/ban` takes it, where
// upstream's merge turns it into the single address `.255`. A ban already over
// is dropped, and a host ban is counted but not kept, since bzo has no host
// bans. A block that does not parse is skipped rather than ending the list.
function parseMasterBans(text, nowMs = Date.now()) {
  const ip = [];
  const id = [];
  let hosts = 0;
  let refused = 0;
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length;) {
    const head = lines[index];
    const field = (offset, name) => {
      const line = lines[index + offset] || '';
      return line.startsWith(`${name}:`) ? line.slice(name.length + 1).trim() : null;
    };
    const end = field(1, 'end');
    const banner = field(2, 'banner');
    const reason = field(3, 'reason');
    if (end === null || banner === null || reason === null || !/^\d+$/.test(end)) {
      refused += 1;
      index += 1;
      while (index < lines.length && /^(end|banner|reason):/.test(lines[index])) index += 1;
      continue;
    }
    index += 4;
    const until = Number(end) * 1000;
    if (until && until <= nowMs) continue;
    const ban = { bannedBy: banner, reason, until, at: nowMs };
    if (head.startsWith('host:')) {
      hosts += 1;
    } else if (head.startsWith('bzid:')) {
      const bzid = head.slice(5).trim();
      if (bzid) id.push({ bzid, ...ban });
      else refused += 1;
    } else {
      const parsed = parseBanMask(head);
      if (parsed) ip.push({ mask: cidrText(parsed.entry), ...ban });
      else refused += 1;
    }
  }
  return { ip, id, hosts, refused };
}

// TimeKeeper::printTime: "2 days, 3 hours, 1 min, 5 secs".
function formatRemaining(seconds) {
  let left = Math.max(0, Math.floor(seconds));
  const parts = [];
  for (const [size, name] of [[86400, 'day'], [3600, 'hour'], [60, 'min'], [1, 'sec']]) {
    const count = Math.floor(left / size);
    left -= count * size;
    if (count > 0) parts.push(`${count} ${name}${count === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}

// TextUtils::parseDuration (src/common/TextUtils.cxx:221), in minutes:
// `short`/`default` is -1 (the server's ban time), `forever`/`max` is 0,
// otherwise digits each followed by w, d, h or m, a bare number being
// minutes. null for anything else.
function parseDuration(text) {
  const value = String(text || '').trim();
  if (/^(short|default)$/i.test(value)) return -1;
  if (/^(forever|max)$/i.test(value)) return 0;
  if (!value || !/^(\d+[hwdm])*\d*$/i.test(value)) return null;
  const unit = { w: 10080, d: 1440, h: 60, m: 1 };
  let minutes = 0;
  for (const [, digits, letter] of value.matchAll(/(\d+)([hwdm]?)/gi)) {
    minutes += Number(digits) * (letter ? unit[letter.toLowerCase()] : 1);
  }
  return minutes;
}

// makeGlobPattern and glob_match: upper case, `*` and `?`, and a pattern with
// no `*` in it matched anywhere.
function globMatcher(pattern) {
  const text = String(pattern || '').trim().toUpperCase();
  if (!text) return () => true;
  const glob = text.includes('*') ? text : `*${text}*`;
  const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  const regex = new RegExp(`^${source}$`, 's');
  return (value) => regex.test(String(value || '').toUpperCase());
}

function createBanStore({ onChange = () => {}, now = () => Date.now() } = {}) {
  // BZID to { bannedBy, reason, until (0 is forever), at }.
  const idBans = new Map();
  // A mask's key (`parseBanMask`) to { mask, entry, bannedBy, reason, until, at }.
  const ipBans = new Map();
  // The master ban list's, keyed the same way, each with `fromMaster`.
  const masterIdBans = new Map();
  const masterIpBans = new Map();
  // Where and when the master list was last loaded, and what it held.
  let masterSource = { urls: [], loadedAt: 0, hosts: 0, refused: 0 };

  function expire() {
    const time = now();
    let changed = false;
    for (const list of [idBans, ipBans, masterIdBans, masterIpBans]) {
      for (const [key, ban] of list) {
        if (ban.until && ban.until <= time) {
          list.delete(key);
          if (list === idBans || list === ipBans) changed = true;
        }
      }
    }
    if (changed) onChange();
  }

  // AccessControlList::ban. The mask as stored, or null for one that does
  // not parse. `minutes` 0 is forever.
  function ipBan(text, { bannedBy = '', minutes = 0, reason = '' } = {}) {
    const parsed = parseBanMask(text);
    if (!parsed) return null;
    const mask = cidrText(parsed.entry);
    ipBans.set(parsed.key, {
      mask, entry: parsed.entry, bannedBy, reason,
      until: minutes > 0 ? now() + (minutes * 60000) : 0, at: now(),
    });
    onChange();
    return mask;
  }

  function ipUnban(text) {
    const parsed = parseBanMask(text);
    const removed = Boolean(parsed) && ipBans.delete(parsed.key);
    if (removed) onChange();
    return removed;
  }

  // The ban that keeps this address out, or null; a null address is never
  // banned, since nothing about it can be trusted. This server's own bans are
  // asked first, so its reason is the one a player is given.
  function ipBanned(address) {
    if (!address) return null;
    expire();
    for (const list of [ipBans, masterIpBans]) {
      for (const ban of list.values()) {
        if (addressMatchesWhitelist(address, [ban.entry])) return ban;
      }
    }
    return null;
  }

  // AccessControlList::sendBan: the mask, the time left under a year, `(m)`
  // for the master list's, who.
  function ipBanLines(ban) {
    let line = ban.mask;
    const remaining = ban.until ? (ban.until - now()) / 1000 : Infinity;
    if (remaining < 365 * 24 * 3600) line += ` (${(remaining / 60).toFixed(1)} minutes)`;
    if (ban.fromMaster) line += ' (m)';
    if (ban.bannedBy) line += ` banned by: ${ban.bannedBy}`;
    return ban.reason ? [line, `   reason: ${ban.reason}`] : [line];
  }

  // AccessControlList::sendBans: the master list's first.
  function listIpBans(pattern = '') {
    expire();
    const matches = globMatcher(pattern);
    const lines = ['IP Ban List', '-----------'];
    for (const ban of [...masterIpBans.values(), ...ipBans.values()]) {
      if (!matches(ban.mask) && !matches(ban.reason) && !matches(ban.bannedBy)) continue;
      lines.push(...ipBanLines(ban));
    }
    return lines;
  }

  // rejectPlayer's words for an address ban (bzfs.cxx:2218), less the colours.
  function ipBanRefusal(ban) {
    const remaining = ban.until ? (ban.until - now()) / 1000 : Infinity;
    return `REFUSED: ${ban.reason || 'General Ban'}`
      + ` (${remaining < 365 * 24 * 3600 ? `${formatRemaining(remaining)} remaining` : 'indefinite'})`
      + `${ban.bannedBy ? ` by ${ban.bannedBy}` : ''}`
      + `${ban.fromMaster ? ' [you are on the master ban list]' : ''}`;
  }

  // The master list (bz_reloadMasterBans), replacing whatever was loaded:
  // `parseMasterBans`'s answer, from one or more URLs. Never persisted.
  function setMasterBans({ ip = [], id = [], hosts = 0, refused = 0 } = {}, urls = []) {
    masterIpBans.clear();
    masterIdBans.clear();
    for (const ban of ip) {
      const parsed = parseBanMask(ban.mask);
      if (!parsed) continue;
      masterIpBans.set(parsed.key, { ...ban, mask: cidrText(parsed.entry), entry: parsed.entry, fromMaster: true });
    }
    for (const ban of id) masterIdBans.set(String(ban.bzid), { ...ban, fromMaster: true });
    masterSource = { urls: [...urls], loadedAt: urls.length ? now() : 0, hosts, refused };
    return masterIpBans.size + masterIdBans.size;
  }

  // AccessControlList::listMasterBans, and where they came from.
  function masterBans() {
    expire();
    return {
      ...masterSource,
      ip: [...masterIpBans.values()],
      id: [...masterIdBans].map(([bzid, ban]) => ({ ...ban, bzid })),
    };
  }

  // Every address ban, master list's first, as the Operator panel shows them.
  function ipBanEntries() {
    expire();
    return [...masterIpBans.values(), ...ipBans.values()].map((ban) => ({
      mask: ban.mask, bannedBy: ban.bannedBy, reason: ban.reason,
      until: ban.until, at: ban.at, master: Boolean(ban.fromMaster),
    }));
  }

  // `minutes` 0 is forever.
  function idBan(bzid, { bannedBy = '', minutes = 0, reason = '' } = {}) {
    const id = String(bzid || '').trim();
    if (!id) return false;
    idBans.set(id, {
      bannedBy, reason, until: minutes > 0 ? now() + (minutes * 60000) : 0, at: now(),
    });
    onChange();
    return true;
  }

  function idUnban(bzid) {
    const removed = idBans.delete(String(bzid || '').trim());
    if (removed) onChange();
    return removed;
  }

  // The ban that keeps this BZID out, or null.
  function idBanned(bzid) {
    if (!bzid) return null;
    expire();
    const ban = idBans.get(String(bzid)) || masterIdBans.get(String(bzid));
    return ban ? { bzid: String(bzid), ...ban } : null;
  }

  // sendIdBans: each matching ban as upstream lists it.
  function listIdBans(pattern = '') {
    expire();
    const matches = globMatcher(pattern);
    const lines = ['BZID Ban List', '-------------'];
    for (const [bzid, ban] of idBans) {
      if (!matches(bzid) && !matches(ban.reason) && !matches(ban.bannedBy)) continue;
      let line = /[ \t]/.test(bzid) ? `"${bzid}"` : bzid;
      const remaining = ban.until ? (ban.until - now()) / 1000 : Infinity;
      if (remaining < 365 * 24 * 3600) line += ` (${(remaining / 60).toFixed(1)} minutes)`;
      if (ban.bannedBy) line += ` banned by: ${ban.bannedBy}`;
      lines.push(line);
      if (ban.reason) lines.push(`   reason: ${ban.reason}`);
    }
    return lines;
  }

  function serialize() {
    expire();
    return {
      idBans: [...idBans].map(([bzid, ban]) => ({ bzid, ...ban })),
      ipBans: [...ipBans.values()].map((ban) => ({
        mask: ban.mask, bannedBy: ban.bannedBy, reason: ban.reason, until: ban.until, at: ban.at,
      })),
    };
  }

  function load(data) {
    idBans.clear();
    for (const entry of data?.idBans || []) {
      if (!entry?.bzid) continue;
      idBans.set(String(entry.bzid), {
        bannedBy: String(entry.bannedBy || ''),
        reason: String(entry.reason || ''),
        until: Number(entry.until) || 0,
        at: Number(entry.at) || 0,
      });
    }
    ipBans.clear();
    for (const entry of data?.ipBans || []) {
      const parsed = parseBanMask(entry?.mask);
      if (!parsed) continue;
      ipBans.set(parsed.key, {
        mask: cidrText(parsed.entry),
        entry: parsed.entry,
        bannedBy: String(entry.bannedBy || ''),
        reason: String(entry.reason || ''),
        until: Number(entry.until) || 0,
        at: Number(entry.at) || 0,
      });
    }
    expire();
    return idBans.size + ipBans.size;
  }

  return {
    idBan, idUnban, idBanned, listIdBans,
    ipBan, ipUnban, ipBanned, ipBanLines, listIpBans, ipBanRefusal, ipBanEntries,
    setMasterBans, masterBans,
    serialize, load,
  };
}

module.exports = {
  parseDuration, globMatcher, parseBanMask, cidrText, parseMasterBans, formatRemaining, createBanStore,
};
