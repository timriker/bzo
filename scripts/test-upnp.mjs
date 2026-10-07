/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// The part of server/upnp.cjs that needs no gateway: picking the service that
// maps ports out of a device description, and resolving where to send to it.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findMappingService, nameForAddress } = require('../server/upnp.cjs');

// miniupnpd's shape: no URLBase, a relative controlURL, and the WAN services
// nested below services that do not map ports.
const miniupnpd = `<?xml version="1.0"?><root><device><serviceList>
<service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>
<controlURL>/ctl/L3F</controlURL></service></serviceList>
<deviceList><device><deviceList><device><serviceList>
<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
<controlURL>/ctl/IPConn</controlURL></service>
</serviceList></device></deviceList></device></deviceList></device></root>`;
assert.deepEqual(findMappingService(miniupnpd, 'http://192.168.12.1:5000/rootDesc.xml'), {
  serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
  controlUrl: 'http://192.168.12.1:5000/ctl/IPConn',
});

// URLBase wins over the description's own address, and WANIPConnection:2 is
// preferred over :1 and over PPP wherever it is listed.
const both = `<root><URLBase>http://10.0.0.1:49000/</URLBase>
<service><serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType><controlURL>ppp</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>ip1</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:2</serviceType><controlURL>ip2</controlURL></service>
</root>`;
assert.deepEqual(findMappingService(both, 'http://10.0.0.1:1900/desc.xml'), {
  serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:2',
  controlUrl: 'http://10.0.0.1:49000/ip2',
});

// A PPP-only gateway still maps.
const ppp = `<root><service><serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType>
<controlURL>/upnp/control/WANPPPConn1</controlURL></service></root>`;
assert.equal(findMappingService(ppp, 'http://192.168.1.1/igd.xml').controlUrl,
  'http://192.168.1.1/upnp/control/WANPPPConn1');

// Nothing that maps ports is nothing.
assert.equal(findMappingService('<root><service><serviceType>urn:x</serviceType><controlURL>/a</controlURL></service></root>',
  'http://h/'), null);

// The listed name: the first reverse name that resolves back to the address.
const fakeDns = (ptr, a) => ({
  reverse: async (ip) => { if (!ptr[ip]) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); return ptr[ip]; },
  resolve4: async (name) => { if (!a[name]) throw new Error('nx'); return a[name]; },
});
const dnsTable = fakeDns(
  { '166.70.240.15': ['dsl-15.isp.example.', 'gw.rikers.org'], '10.9.9.9': ['stale.example'] },
  { 'dsl-15.isp.example': ['1.2.3.4'], 'gw.rikers.org': ['166.70.240.15', '166.70.97.193'], 'stale.example': ['10.9.9.8'] },
);
assert.equal(await nameForAddress('166.70.240.15', dnsTable), 'gw.rikers.org');
assert.equal(await nameForAddress('10.9.9.9', dnsTable), null);
assert.equal(await nameForAddress('98.67.164.178', dnsTable), null);

console.log('test-upnp: ok');
