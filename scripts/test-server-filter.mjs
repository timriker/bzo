/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The /list filter language, which is upstream's own
// (`src/bzflag/ServerListFilter.cxx`) -- the part of that page with real rules
// rather than markup, and the part where a wrong bound silently hides servers
// instead of looking broken. Every exclusive-versus-inclusive case below is
// upstream's arithmetic, not a choice made here.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

// `public/js/list-page.js` is a browser script that hangs its entry points off
// `window`, so it is run here against stubs rather than imported: every
// `getElementById` comes back empty, which makes each `attachList` at the
// bottom of it return before touching anything.
const context = {
  window: {},
  document: { addEventListener() {}, getElementById() { return null; } },
};
context.window.document = context.document;
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(here, '..', 'public', 'js', 'list-page.js'), 'utf8'),
  context,
  { filename: 'list-page.js' },
);
const { parseServerFilter } = context.window;
assert.equal(typeof parseServerFilter, 'function', 'the page exports its parser');

// A server, as the page's own JSON block describes one.
function server(overrides = {}) {
  return {
    a: 'bz.example.org:5154',
    d: 'Example Server',
    s: 3,
    p: 2,
    mp: 20,
    mt: 0,
    mts: 0,
    mps: 0,
    sw: 0,
    st: 0,
    tc: [1, 1, 0, 0, 0, 0],
    tm: [10, 10, 10, 0, 0, 4],
    g: 'ClassicCTF',
    rank: 2,
    rep: 0,
    j: 1,
    fl: 1,
    r: 0,
    h: 0,
    in: 0,
    an: 0,
    im: 0,
    ...overrides,
  };
}

const matches = (filter, entry) => parseServerFilter(filter).check(entry);
const errorsFor = (filter) => parseServerFilter(filter).errors;

// --- no filter at all -----------------------------------------------------
assert.equal(matches('', server()), true, 'an empty filter matches everything');
assert.equal(matches('   ', server()), true, 'and so does whitespace');

// --- the bare glob over address and description ---------------------------
assert.equal(matches('example', server()), true, 'a bare word matches anywhere');
assert.equal(matches('EXAMPLE', server()), true, 'and ignores case');
assert.equal(matches('5154', server()), true, 'the address counts as well as the name');
assert.equal(matches('nothing', server()), false);
// A pattern that brings its own wildcard is *not* wrapped in more of them,
// which is the whole difference between a word and a glob.
assert.equal(matches('*.org:5154', server()), true);
assert.equal(matches('*.org', server()), false, 'an anchored glob has to match the whole string');
assert.equal(matches('bz.example.org:515?', server()), true, '? is one character');

// --- ranges, and their exclusive bounds ----------------------------------
assert.equal(matches('/p>1', server({ p: 2 })), true);
assert.equal(matches('/p>1', server({ p: 1 })), false, '> is exclusive');
assert.equal(matches('/p>=1', server({ p: 1 })), true, '>= is not');
assert.equal(matches('/p<3', server({ p: 2 })), true);
assert.equal(matches('/p<3', server({ p: 3 })), false, '< is exclusive');
assert.equal(matches('/p<=3', server({ p: 3 })), true);
assert.equal(matches('/p=2', server({ p: 2 })), true);
assert.equal(matches('/p=2', server({ p: 3 })), false);
// Two bounds on one value, and the comma that means "and".
assert.equal(matches('/s>1,s<4', server({ s: 3 })), true);
assert.equal(matches('/s>1,s<4', server({ s: 4 })), false);
assert.equal(matches('/s>1,s<4', server({ s: 1 })), false);

// --- booleans -------------------------------------------------------------
assert.equal(matches('/+ctf', server({ g: 'ClassicCTF' })), true);
assert.equal(matches('/+ctf', server({ g: 'TeamFFA' })), false);
assert.equal(matches('/-ctf', server({ g: 'TeamFFA' })), true);
assert.equal(matches('/+C', server({ g: 'ClassicCTF' })), true, 'the short name works too');
// `F` is free-for-all here. Upstream's own table gives the letter to both
// `ffa` and `favorite`, so its documented meaning stops working; bzo has no
// favourites to collide with.
assert.equal(matches('/+F', server({ g: 'TeamFFA' })), true);
assert.equal(matches('/+F', server({ g: 'ClassicCTF' })), false);
assert.equal(matches('/+jump,-rico', server({ j: 1, r: 0 })), true);
assert.equal(matches('/+jump,-rico', server({ j: 1, r: 1 })), false);
assert.equal(matches('/+P', server({ rep: 1 })), true, 'a replay server');
// Upstream's parser takes `i` while its help page prints `I`; both work.
assert.equal(matches('/+i', server({ in: 1 })), true);
assert.equal(matches('/+I', server({ in: 1 })), true);

// --- patterns -------------------------------------------------------------
assert.equal(matches('/d)*example*', server()), true);
assert.equal(matches('/d)*5154*', server()), false, 'the description is not the address');
assert.equal(matches('/a)*5154*', server()), true);
assert.equal(matches('/ad)*5154*', server()), true, 'addrdesc takes either');
// A capitalised label is the one that respects case.
assert.equal(matches('/d)example', server()), true, 'a bare pattern is still wrapped');
assert.equal(matches('/D)example', server({ d: 'Example' })), false);
assert.equal(matches('/D)Example', server({ d: 'Example' })), true);
// Regular expressions, which are unanchored like upstream's `regexec`.
assert.equal(matches('/a]^bz\\.', server()), true);
assert.equal(matches('/a]^example', server()), false);
assert.equal(matches('/d]serv', server()), true, 'and case-insensitive under a lowercase label');

// --- a second slash is "or" ----------------------------------------------
assert.equal(matches('/+ctf/+rabbit', server({ g: 'ClassicCTF' })), true);
assert.equal(matches('/+ctf/+rabbit', server({ g: 'RabbitChase' })), true);
assert.equal(matches('/+ctf/+rabbit', server({ g: 'TeamFFA' })), false);
// A third set works the same way, which is what makes the rule recursive
// rather than a special case for two.
assert.equal(matches('/+ctf/+rabbit/+offa', server({ g: 'OpenFFA' })), true);

// --- comments and leading text -------------------------------------------
assert.equal(matches('/p>1,# busy servers', server({ p: 2 })), true);
assert.equal(matches('/# only a comment', server()), true);
assert.equal(matches('example/+ctf', server()), true, 'a glob and filters together');
assert.equal(matches('example/+rabbit', server()), false);
assert.equal(matches('nothing/+ctf', server()), false, 'the glob still has to match');

// --- the derived per-team numbers ----------------------------------------
assert.equal(matches('/op>0', server({ tc: [0, 0, 0, 0, 0, 1] })), true);
assert.equal(matches('/op>0', server({ tc: [1, 0, 0, 0, 0, 0] })), false);
assert.equal(matches('/rp=1', server({ tc: [0, 1, 0, 0, 0, 0] })), true);
assert.equal(matches('/Rp=1', server({ tc: [1, 0, 0, 0, 0, 0] })), true, 'capital R is rogue');
assert.equal(matches('/om=4', server()), true);
// Three teams have a maximum above zero in the fixture.
assert.equal(matches('/vt=3', server()), true);
// Free slots are the team's own spare seats, capped by what the server has
// left at all -- 20 players less the three already there.
assert.equal(matches('/rf=9', server({ tc: [1, 1, 0, 0, 0, 0], tm: [10, 10, 10, 0, 0, 4] })), true);
// Every playing team's spare seats comes to 28 here, but the server itself has
// only 18 left, and that cap is the answer.
assert.equal(matches('/f=18', server()), true);
assert.equal(matches('/f=28', server()), false);
// A bzo instance too old to report per-team figures cannot satisfy a filter
// about them, and must not read as a server with nobody on any team.
assert.equal(matches('/op>0', server({ tc: null })), false);
assert.equal(matches('/op=0', server({ tc: null })), false);
assert.equal(matches('/vt=3', server({ tm: null })), false);
assert.equal(matches('/p>1', server({ tc: null, tm: null })), true, 'the rest still works');

// --- facts bzo has to find out --------------------------------------------
// Known yes, known no, and not asked yet: the last is on neither side.
for (const [label, field] of [['guestWatch', 'gw'], ['gw', 'gw'], ['guests', 'gs'], ['gu', 'gs'], ['guestChat', 'gc'], ['gc', 'gc'], ['bots', 'bo'], ['b', 'bo']]) {
  assert.equal(matches(`/+${label}`, server({ [field]: 1 })), true, `+${label} on a yes`);
  assert.equal(matches(`/-${label}`, server({ [field]: 1 })), false, `-${label} on a yes`);
  assert.equal(matches(`/-${label}`, server({ [field]: 0 })), true, `-${label} on a no`);
  assert.equal(matches(`/+${label}`, server({ [field]: null })), false, `+${label} on unknown`);
  assert.equal(matches(`/-${label}`, server({ [field]: null })), false, `-${label} on unknown`);
}

// --- what a bad filter says ----------------------------------------------
// `.length`, not a deep compare against `[]`: the parser runs in its own vm
// context, so its arrays have that realm's prototype and never look strictly
// equal to one built here.
assert.equal(errorsFor('/p>1').length, 0, 'a good filter says nothing');
assert.match(errorsFor('/+nonsense')[0], /unknown boolean label/);
assert.match(errorsFor('/nonsense>1')[0], /unknown range label/);
assert.match(errorsFor('/nonsense)x')[0], /unknown pattern label/);
assert.match(errorsFor('/p>banana')[0], /bad range value/);
assert.match(errorsFor('/a](unclosed')[0], /bad regex/);
assert.match(errorsFor('/p!1')[0], /invalid filter/);
// A set with one bad filter in it still applies the rest, which is upstream's
// behaviour: the parser reports and carries on.
assert.equal(matches('/+nonsense,p>1', server({ p: 2 })), true);
assert.equal(matches('/+nonsense,p>1', server({ p: 0 })), false);

// The version tells bzo from bzfs: a pattern, and plain text too.
const bzoRow = server({ ve: 'bzo-1.3.6-df8de6e77f54' });
const bzfsRow = server({ ve: '2.4.26.20240416-MAINT-linux-gnu-SDL2' });
assert.equal(matches('/ve)bzo-*', bzoRow), true);
assert.equal(matches('/ve)bzo-*', bzfsRow), false);
assert.equal(matches('/version]^2\\.4', bzfsRow), true);
assert.equal(matches('bzo-', bzoRow), true, 'plain text searches the version');
assert.equal(matches('bzo-', bzfsRow), false);

console.log('server list filter tests passed');
