import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cidrText, parseBanMask, parseMasterBans, createBanStore } = require('../server/bans.cjs');

const cidr = (text) => cidrText(parseBanMask(text).entry);

// Every mask is kept in CIDR form, whatever it was written as.
assert.equal(cidr('192.0.2.7'), '192.0.2.7/32');
assert.equal(cidr('192.0.2.7/24'), '192.0.2.0/24');
assert.equal(cidr('198.51.*.*'), '198.51.0.0/16');
assert.equal(cidr('0.0.0.0/0'), '0.0.0.0/0');
assert.equal(cidr('2001:db8::1'), '2001:db8::1/128');
assert.equal(cidr('2001:db8:0:0:1::/64'), '2001:db8::/64');
assert.equal(cidr('2001:0:0:1:0:0:0:1'), '2001:0:0:1::1/128');
assert.equal(cidr('::/0'), '::/0');

const NOW = 1_800_000_000_000;
const LIST = `
192.0.2.10
end: 0
banner: Admin One
reason: cheating

198.51.*.*
end: ${NOW / 1000 + 3600}
banner: Admin Two
reason: a range

203.0.113.5
end: ${NOW / 1000 - 60}
banner: Admin Three
reason: already over

host: *.example.net
end: 0
banner: Admin Four
reason: host ban

bzid: 4242
end: 0
banner: Admin Five
reason: by id

not an address
end: 0
banner: nobody
reason: nothing

2001:db8::/32
end: 0
banner: Admin Six
reason: IPv6 block
`;

// Wildcards become blocks, a ban already over is dropped, a host ban is
// counted and not kept, and a bad block is skipped without ending the list.
const parsed = parseMasterBans(LIST, NOW);
assert.deepEqual(parsed.ip.map((ban) => ban.mask), ['192.0.2.10/32', '198.51.0.0/16', '2001:db8::/32']);
assert.deepEqual(parsed.id.map((ban) => ban.bzid), ['4242']);
assert.equal(parsed.hosts, 1);
assert.equal(parsed.refused, 1);
assert.equal(parsed.ip[1].until, NOW + 3600 * 1000);

let clock = NOW;
let writes = 0;
const store = createBanStore({ onChange: () => { writes += 1; }, now: () => clock });
assert.equal(store.setMasterBans(parsed, ['https://example.org/bans.txt']), 4);
assert.equal(writes, 0, 'the master list is never persisted');
assert.equal(store.ipBanned('198.51.100.1').mask, '198.51.0.0/16');
assert.equal(store.ipBanned('2001:db8:1::5').mask, '2001:db8::/32');
assert.equal(store.idBanned('4242').fromMaster, true);
assert.match(store.ipBanRefusal(store.ipBanned('192.0.2.10')), /\[you are on the master ban list\]$/);
assert.deepEqual(store.serialize().ipBans, []);

// A local ban is asked first, so its reason is the one given.
assert.equal(store.ipBan('192.0.2.0/24', { bannedBy: 'op', reason: 'local' }), '192.0.2.0/24');
assert.equal(store.ipBanned('192.0.2.10').reason, 'local');
assert.deepEqual(store.serialize().ipBans.map((ban) => ban.mask), ['192.0.2.0/24']);
assert.deepEqual(store.ipBanEntries().map((ban) => [ban.mask, ban.master]),
  [['192.0.2.10/32', true], ['198.51.0.0/16', true], ['2001:db8::/32', true], ['192.0.2.0/24', false]]);
assert.match(store.listIpBans().join('\n'), /198\.51\.0\.0\/16 \(60\.0 minutes\) \(m\) banned by: Admin Two/);

// A master ban is not ours to lift; a local one is, by any spelling.
assert.equal(store.ipUnban('198.51.*.*'), false);
assert.equal(store.ipUnban('192.0.2.0/24'), true);
assert.equal(store.ipBanned('192.0.2.10').fromMaster, true);

// A master ban runs out like any other.
clock += 3601 * 1000;
assert.equal(store.ipBanned('198.51.100.1'), null);

// Flushing empties the master list and leaves this server's own.
store.ipBan('203.0.113.0/24', { bannedBy: 'op' });
store.setMasterBans();
assert.equal(store.masterBans().ip.length, 0);
assert.equal(store.ipBanned('203.0.113.9').mask, '203.0.113.0/24');

// Old bans.json masks load into CIDR form.
const reloaded = createBanStore({ now: () => clock });
reloaded.load({ ipBans: [{ mask: '10.1.*.*' }, { mask: '2001:db8::7' }] });
assert.deepEqual(reloaded.ipBanEntries().map((ban) => ban.mask), ['10.1.0.0/16', '2001:db8::7/128']);

console.log('ban tests passed');
