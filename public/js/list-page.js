// The /list page's own script: sorting, selection, and the server-list filter
// language. Served as a file rather than inlined in server.js's page template,
// because the parser below is long enough that escaping it into a template
// literal would be the hardest part of reading it.
//
// Every list on the page is a plain HTML list whose rows are already in the
// document, so sorting and filtering never refetch anything. The data each row
// is judged by rides in a JSON block beside it (`<listId>-data`), one entry per
// row, and a row names its entry with `data-i`.

'use strict';

// A sortable table, for the two tables left on the page (local maps, and the
// key admin section's own table, which fetches its rows in later and calls
// this itself). Rows with a `data-href` navigate on click.
window.attachTable = function attachTable(tableId, filterId) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const tbody = table.tBodies[0];
  tbody.addEventListener('click', (e) => {
    if (e.target.closest('.inlineForm') || e.target.closest('button')) return;
    const row = e.target.closest('tr[data-href]');
    if (row) window.location.href = row.dataset.href;
  });
  Array.from(table.tHead.rows[0].cells).forEach((th, colIndex) => {
    let dir = 1;
    th.addEventListener('click', () => {
      const numeric = th.dataset.sort === 'num';
      Array.from(tbody.rows).sort((a, b) => {
        let av = a.cells[colIndex].textContent.trim();
        let bv = b.cells[colIndex].textContent.trim();
        if (numeric) {
          av = parseFloat(av);
          bv = parseFloat(bv);
          return ((isNaN(av) ? -Infinity : av) - (isNaN(bv) ? -Infinity : bv)) * dir;
        }
        return av.localeCompare(bv) * dir;
      }).forEach((row) => { tbody.appendChild(row); });
      dir *= -1;
    });
  });
  const filterInput = filterId && document.getElementById(filterId);
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      const q = filterInput.value.toLowerCase();
      Array.from(tbody.rows).forEach((row) => {
        row.style.display = row.textContent.toLowerCase().indexOf(q) === -1 ? 'none' : '';
      });
    });
  }
};

// ---------------------------------------------------------------------------
// The filter language, which is upstream's (`src/bzflag/ServerListFilter.cxx`).
// Text with no leading slash is a glob over address, description, version, hash and owner. After a
// slash comes a comma-separated set of filters, combined with AND; a second
// slash starts another set, and a server matching any set is shown (OR). A
// filter is `+name`/`-name` for a boolean, `name<value` (`<`, `<=`, `>`, `>=`,
// `=`) for a number, or `name)glob`/`name]regex` for a pattern. `#` is a
// comment.
// ---------------------------------------------------------------------------

// `F` is upstream's own collision: its table assigns the letter to both `ffa`
// and `favorite`, so the second wins and the documented `F` for free-for-all
// silently stops working. bzo has no favourites at all, so the letter goes to
// the game mode the help text says it is.
const BOOL_LABELS = {
  F: 'ffa', ffa: 'ffa',
  O: 'offa', offa: 'offa',
  C: 'ctf', ctf: 'ctf',
  R: 'rabbit', rabbit: 'rabbit',
  j: 'jump', jump: 'jump',
  r: 'rico', rico: 'rico',
  h: 'handicap', handicap: 'handicap',
  P: 'replay', replay: 'replay',
  // Upstream's parser takes the lowercase letter while its own help page
  // prints the capital. Both work here rather than either being wrong.
  i: 'inertia', I: 'inertia', inertia: 'inertia',
  a: 'antidote', antidote: 'antidote',
  ov: 'overview', overview: 'overview',
  t: 'temp', temp: 'temp',
  b: 'bots', bots: 'bots',
  gw: 'guestWatch', guestWatch: 'guestWatch',
  gu: 'guests', guests: 'guests',
  gc: 'guestChat', guestChat: 'guestChat',
};

const RANGE_LABELS = {
  s: 'shots', shots: 'shots',
  p: 'players', players: 'players',
  bc: 'botCount', botCount: 'botCount',
  f: 'freeSlots', freeSlots: 'freeSlots',
  vt: 'validTeams', validTeams: 'validTeams',
  mt: 'maxTime', maxTime: 'maxTime',
  mp: 'maxPlayers', maxPlayers: 'maxPlayers',
  mts: 'maxTeamScore', maxTeamScore: 'maxTeamScore',
  mps: 'maxPlayerScore', maxPlayerScore: 'maxPlayerScore',
  sw: 'shakeWins', shakeWins: 'shakeWins',
  st: 'shakeTime', shakeTime: 'shakeTime',
  Rm: 'rogueMax', rogueMax: 'rogueMax',
  rm: 'redMax', redMax: 'redMax',
  gm: 'greenMax', greenMax: 'greenMax',
  bm: 'blueMax', blueMax: 'blueMax',
  pm: 'purpleMax', purpleMax: 'purpleMax',
  om: 'observerMax', observerMax: 'observerMax',
  Rp: 'roguePlayers', roguePlayers: 'roguePlayers',
  rp: 'redPlayers', redPlayers: 'redPlayers',
  gp: 'greenPlayers', greenPlayers: 'greenPlayers',
  bp: 'bluePlayers', bluePlayers: 'bluePlayers',
  pp: 'purplePlayers', purplePlayers: 'purplePlayers',
  op: 'observerPlayers', observerPlayers: 'observerPlayers',
  Rf: 'rogueFree', rogueFree: 'rogueFree',
  rf: 'redFree', redFree: 'redFree',
  gf: 'greenFree', greenFree: 'greenFree',
  bf: 'blueFree', blueFree: 'blueFree',
  pf: 'purpleFree', purpleFree: 'purpleFree',
  of: 'observerFree', observerFree: 'observerFree',
};

const PATTERN_LABELS = {
  a: 'addr', addr: 'addr', address: 'addr',
  d: 'desc', desc: 'desc', description: 'desc',
  ad: 'addrDesc', addrdesc: 'addrDesc',
  hs: 'hash', hash: 'hash',
  ow: 'owner', owner: 'owner',
  ve: 'version', ver: 'version', version: 'version',
  ip: 'ip',
  v: 'variable', var: 'variable',
};

// A glob is `*` for any run and `?` for any one character; a pattern with
// neither is wrapped in `*...*`, so a bare word is a substring search.
function globToRegExp(glob, noCase) {
  let pattern = glob;
  if (pattern.indexOf('*') === -1 && pattern.indexOf('?') === -1) {
    pattern = `*${pattern}*`;
  }
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${body}$`, noCase ? 'i' : '');
}

// Both bounds are exclusive, and `<=`, `>=` and `=` are the same two bounds
// shifted by one -- upstream's own arithmetic, so `p=2` means 1 < p < 3.
function rangeBounds(op, value) {
  switch (op) {
    case '<': return { max: value };
    case '<=': return { max: value + 1 };
    case '>': return { min: value };
    case '>=': return { min: value - 1 };
    case '=': return { min: value - 1, max: value + 1 };
    default: return null;
  }
}

function parseFilterSet(text, errors) {
  const bools = {};
  const ranges = {};
  const patterns = {};

  text.split(',').forEach((raw) => {
    const token = raw.replace(/^[ \t]+/, '');
    if (!token || token[0] === '#') return;

    if (token[0] === '+' || token[0] === '-') {
      const key = BOOL_LABELS[token.slice(1)];
      if (!key) {
        errors.push(`unknown boolean label, '${token.slice(1)}'`);
        return;
      }
      bools[key] = token[0] === '+';
      return;
    }

    // The label runs to the first character that is not alphanumeric or an
    // underscore, and that character is the operator.
    const match = token.match(/^([A-Za-z0-9_]*)(<=|>=|[<>=)\]])([\s\S]*)$/);
    if (!match) {
      errors.push(`invalid filter, '${token}'`);
      return;
    }
    const [, label, op, param] = match;

    if (op === ')' || op === ']') {
      const key = PATTERN_LABELS[label.toLowerCase()];
      if (!key) {
        errors.push(`unknown pattern label, '${label}'`);
        return;
      }
      // A capitalised label asks for a case-sensitive match, which is the one
      // thing the label's own spelling carries.
      const noCase = label[0] === label[0].toLowerCase();
      try {
        patterns[key] = op === ')'
          ? globToRegExp(param, noCase)
          : new RegExp(param, noCase ? 'i' : '');
      } catch (error) {
        errors.push(`bad regex, ${error.message}`);
      }
      return;
    }

    const key = RANGE_LABELS[label];
    if (!key) {
      errors.push(`unknown range label, '${label}'`);
      return;
    }
    if (!/^-?\d+(\.\d+)?$/.test(param)) {
      errors.push(`bad range value, '${param}'`);
      return;
    }
    const bounds = rangeBounds(op, Number(param));
    // Merged, not replaced: a minimum and a maximum are separate bounds on the
    // same name, which is what makes upstream's own `s>1,s<4` mean "two or
    // three shots" rather than just "fewer than four".
    if (bounds) ranges[key] = { ...(ranges[key] || {}), ...bounds };
  });

  return { bools, ranges, patterns };
}

// One entry's value for every name a range filter can ask about. Per-team
// numbers are missing from a report by a bzo instance too old to send them
// (`teamCounts`/`teamMaximums`), and a filter that asks about one of those
// cannot be satisfied by a row bzo has no figure for -- so it reads
// `undefined` and fails, rather than a zero that would look like an answer.
const TEAM_ORDER = ['rogue', 'red', 'green', 'blue', 'purple', 'observer'];

function rangeValue(entry, key) {
  const counts = entry.tc;
  const maxima = entry.tm;
  const teamIndex = (prefix) => TEAM_ORDER.indexOf(key.slice(0, -prefix.length));

  switch (key) {
    case 'shots': return entry.s;
    case 'players': return entry.p;
    case 'botCount': return entry.bt ?? undefined;
    case 'maxTime': return entry.mt;
    case 'maxPlayers': return entry.mp;
    case 'maxTeamScore': return entry.mts;
    case 'maxPlayerScore': return entry.mps;
    case 'shakeWins': return entry.sw;
    case 'shakeTime': return entry.st;
    default: break;
  }

  if (key === 'validTeams') {
    if (!maxima) return undefined;
    return maxima.slice(0, 5).filter((max) => max > 0).length;
  }
  // Every playing team's spare seats, capped by the seats the server has left
  // at all -- upstream's `countFreeSlots`.
  if (key === 'freeSlots' || key.endsWith('Free')) {
    if (!counts || !maxima) return undefined;
    const totalFree = entry.mp - (entry.p + counts[5]);
    if (key === 'freeSlots') {
      const sum = maxima.slice(0, 5)
        .reduce((acc, max, i) => acc + (max - counts[i]), 0);
      return Math.min(sum, totalFree);
    }
    const index = teamIndex('Free');
    if (index === -1) return undefined;
    return Math.min(totalFree, maxima[index] - counts[index]);
  }
  if (key.endsWith('Players')) {
    if (!counts) return undefined;
    const index = teamIndex('Players');
    return index === -1 ? undefined : counts[index];
  }
  if (key.endsWith('Max')) {
    if (!maxima) return undefined;
    const index = teamIndex('Max');
    return index === -1 ? undefined : maxima[index];
  }
  return undefined;
}

function knownBool(value) {
  return value === 1 ? true : (value === 0 ? false : undefined);
}

function boolValue(entry, key) {
  switch (key) {
    case 'ffa': return entry.g === 'TeamFFA';
    case 'offa': return entry.g === 'OpenFFA';
    case 'ctf': return entry.g === 'ClassicCTF';
    case 'rabbit': return entry.g === 'RabbitChase';
    case 'replay': return entry.rep === 1;
    case 'jump': return entry.j === 1;
    case 'rico': return entry.r === 1;
    case 'handicap': return entry.h === 1;
    case 'inertia': return entry.in === 1;
    case 'antidote': return entry.an === 1;
    case 'overview': return entry.ov === 1;
    case 'temp': return entry.tmp === 1;
    // Unknown is neither true nor false, so `+name` and `-name` both pass it by.
    case 'bots': return knownBool(entry.bo);
    case 'guestWatch': return knownBool(entry.gw);
    case 'guests': return knownBool(entry.gs);
    case 'guestChat': return knownBool(entry.gc);
    default: return false;
  }
}

function checkSet(set, entry) {
  const addr = entry.a || '';
  const desc = entry.d || '';
  if (set.patterns.addr && !set.patterns.addr.test(addr)) return false;
  if (set.patterns.desc && !set.patterns.desc.test(desc)) return false;
  if (set.patterns.hash && !set.patterns.hash.test(entry.hs || '')) return false;
  if (set.patterns.owner && !set.patterns.owner.test(entry.ow || '')) return false;
  if (set.patterns.version && !set.patterns.version.test(entry.ve || '')) return false;
  if (set.patterns.ip && !set.patterns.ip.test(entry.ip || '')) return false;
  if (set.patterns.variable
    && !(entry.v || []).some((line) => set.patterns.variable.test(line))) {
    return false;
  }
  if (set.patterns.addrDesc
    && !set.patterns.addrDesc.test(addr) && !set.patterns.addrDesc.test(desc)) {
    return false;
  }
  for (const key of Object.keys(set.bools)) {
    if (boolValue(entry, key) !== set.bools[key]) return false;
  }
  for (const key of Object.keys(set.ranges)) {
    const value = rangeValue(entry, key);
    if (typeof value !== 'number') return false;
    const bounds = set.ranges[key];
    if (bounds.min !== undefined && value <= bounds.min) return false;
    if (bounds.max !== undefined && value >= bounds.max) return false;
  }
  return true;
}

// Returns a predicate over one list entry, and whatever the text got wrong.
// An empty filter matches everything.
window.parseServerFilter = function parseServerFilter(source) {
  const errors = [];
  const text = typeof source === 'string' ? source : '';
  const slash = text.indexOf('/');
  const head = slash === -1 ? text : text.slice(0, slash);
  const rest = slash === -1 ? '' : text.slice(slash + 1);

  // Two sets at most is all one more slash gives; a third slash starts a third
  // set the same way, so this recurses on the remainder.
  const orAt = rest.indexOf('/');
  const sets = [parseFilterSet(orAt === -1 ? rest : rest.slice(0, orAt), errors)];
  let orFilter = null;
  if (orAt !== -1) {
    orFilter = window.parseServerFilter(`/${rest.slice(orAt + 1)}`);
    errors.push(...orFilter.errors);
  }

  const headPattern = head.trim() ? globToRegExp(head.trim(), true) : null;

  return {
    errors,
    check(entry) {
      if (orFilter && orFilter.check(entry)) return true;
      if (headPattern && !headPattern.test(entry.a || '')
        && !headPattern.test(entry.d || '') && !headPattern.test(entry.hs || '')
        && !headPattern.test(entry.ow || '') && !headPattern.test(entry.ve || '')) {
        return false;
      }
      return checkSet(sets[0], entry);
    },
  };
};

// ---------------------------------------------------------------------------
// The list: selection, sorting and the filter box.
// ---------------------------------------------------------------------------

window.attachList = function attachList(listId, filterId) {
  const wrap = document.getElementById(listId);
  if (!wrap) return;
  const list = wrap.querySelector('.srows');
  const head = wrap.querySelector('.shead');
  const dataNode = document.getElementById(`${listId}-data`);
  const entries = dataNode ? JSON.parse(dataNode.textContent) : [];
  // Queried on every use rather than captured once: a sort reorders these, and
  // the arrow keys have to walk them in the order they are shown in.
  const rows = () => Array.from(wrap.querySelectorAll('.srow'));
  if (!rows().length) return;
  const entryFor = (row) => entries[Number(row.dataset.i)] || {};

  // Nothing selected -- a filter that matches nothing -- hides every pane
  // rather than leaving the last one open beside a row no longer shown.
  function select(row, moveFocus) {
    rows().forEach((candidate) => {
      const pane = document.getElementById(candidate.dataset.pane);
      const actions = document.getElementById(`${candidate.dataset.pane}-actions`);
      candidate.classList.toggle('selected', candidate === row);
      if (pane) pane.hidden = candidate !== row;
      if (actions) actions.hidden = candidate !== row;
    });
    if (row && moveFocus) {
      row.focus({ preventScroll: true });
      // The list is ten rows in its own scroll box: "nearest" moves that box
      // as little as it takes and leaves the page where it is.
      row.scrollIntoView({ block: 'nearest' });
    }
  }
  const shown = () => rows().filter((row) => row.parentNode.style.display !== 'none');

  // A click picks the row rather than following it: the pane holds the row's
  // own details and the bar above holds the way in. With scripting off every
  // row is still a plain link to where it always went.
  wrap.addEventListener('click', (e) => {
    const row = e.target.closest('.srow');
    if (!row) return;
    e.preventDefault();
    select(row, true);
  });
  wrap.addEventListener('keydown', (e) => {
    const row = e.target.closest('.srow');
    if (!row) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const visible = shown();
      select(visible[visible.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)] || row, true);
    } else if (e.key === 'Enter') {
      // The click handler would otherwise swallow the Enter an anchor already
      // means: follow it.
      e.preventDefault();
      window.location.href = row.href;
    }
  });

  // Sorting reorders the rows already in the page. A column's first click
  // takes the direction worth having -- most players first, jumping servers
  // first -- and names from A.
  if (head && list) {
    const directions = {};
    head.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-field]');
      if (!button) return;
      // A header names the entry field it sorts by, so a new column is a
      // header and a field and no change here. Text sorts up, numbers down:
      // names read from A, and every number on these lists is one where more
      // is the interesting end.
      const field = button.dataset.field;
      const text = button.dataset.text !== undefined;
      directions[field] = directions[field] === undefined
        ? (text ? 1 : -1)
        : -directions[field];
      const factor = directions[field];
      Array.from(list.children).sort((a, b) => {
        const left = entryFor(a.firstElementChild)[field];
        const right = entryFor(b.firstElementChild)[field];
        // A blank goes to the bottom whichever way the column is sorted, so
        // sorting on the hash puts every unhashed row at one end and leaves
        // rows sharing a hash next to each other.
        if (text) {
          if (!left !== !right) return left ? -1 : 1;
          return String(left || '').localeCompare(String(right || '')) * factor;
        }
        return ((Number(left) || 0) - (Number(right) || 0)) * factor;
      }).forEach((item) => { list.appendChild(item); });
      Array.from(head.querySelectorAll('button')).forEach((other) => {
        other.classList.toggle('active', other === button);
      });
    });
  }

  const filterInput = filterId && document.getElementById(filterId);
  const errorNode = document.getElementById(`${filterId}Error`);
  // How many rows the filter leaves, in the section's heading, so a filter
  // that matches nothing reads as that rather than as an empty list.
  const countNode = document.getElementById(`${listId}-count`);
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      const filter = window.parseServerFilter(filterInput.value);
      if (errorNode) {
        errorNode.textContent = filter.errors.length ? filter.errors[0] : '';
        errorNode.hidden = filter.errors.length === 0;
      }
      rows().forEach((row) => {
        row.parentNode.style.display = filter.check(entryFor(row)) ? '' : 'none';
      });
      select(shown()[0] || null, false);
      if (countNode) {
        countNode.textContent = filterInput.value.trim() ? `, filtered ${shown().length}` : '';
      }
    });
  }
};

// The syntax reference, which is the same panel for every list on the page --
// one copy, opened by whichever list's own button asked for it.
document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-help]');
  if (!button) return;
  const panel = document.getElementById(button.dataset.help);
  if (panel) panel.hidden = !panel.hidden;
});

window.attachList('serverList', 'serverFilter');
window.attachList('bzoServerList', 'bzoServerFilter');
// The maps list is the same shell as a server list, so it is the same code.
// Only the glob half of the filter language means anything on it, which is why
// it has no syntax-help button beside its box.
window.attachList('mapList', 'mapFilter');
// And so is the replays list, for the same reason.
window.attachList('replayList', 'replayFilter');

// An x inside each filter box's right edge, shown while there is text: a
// click empties the box and filters again, as deleting the text would.
function addClearButtons() {
  if (!document.querySelectorAll) return;
  document.querySelectorAll('input.clearable').forEach((input) => {
    const box = document.createElement('span');
    box.className = 'clearBox';
    input.parentNode.insertBefore(box, input);
    box.appendChild(input);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = '\u00d7';
    clear.title = 'Clear';
    clear.setAttribute('aria-label', 'Clear filter');
    box.appendChild(clear);
    const sync = () => { clear.hidden = input.value === ''; };
    input.addEventListener('input', sync);
    clear.addEventListener('click', () => {
      input.value = '';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      input.focus();
    });
    sync();
  });
}
// After the whole page, the key table's box at the bottom included.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addClearButtons);
else addClearButtons();
