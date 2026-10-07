/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// bzfs's `-UPnP` (the `UPnP` class, bzfs.cxx:6244): ask the LAN's internet
// gateway to forward the game port to this host, TCP and UDP, and take the
// forwarding down again on shutdown. Upstream links miniupnpc for it; this is
// the same three requests -- find the gateway over SSDP, then
// GetExternalIPAddress and AddPortMapping over SOAP -- without the library.
//
// One deliberate difference: upstream maps with a lease of 0, which lasts
// until it is deleted, so a bzfs that crashes leaves its port open for good.
// This asks for a lease and renews it at half-life. A gateway that answers
// OnlyPermanentLeasesSupported (725) gets upstream's 0.

const dgram = require('node:dgram');
const dns = require('node:dns').promises;

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const DISCOVER_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_LEASE_SECONDS = 3600;
const PROTOCOLS = ['TCP', 'UDP'];

// The services a port mapping is asked of, in miniupnpc's preference.
const SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
];

// UPnP's own error codes that mean something here (UPnP IGD WANIPConnection
// spec, section 2.4.16), the ones upstream names and the lease one.
const UPNP_ERRORS = {
  402: 'Invalid Args',
  501: 'Action Failed',
  606: 'Action not authorized',
  715: 'Wildcard not permitted in SrcAddr',
  716: 'Wildcard not permitted in ExtPort',
  718: 'ConflictInMappingEntry',
  724: 'SamePortValuesRequired',
  725: 'OnlyPermanentLeasesSupported',
};

class UpnpError extends Error {
  constructor(code, description) {
    super(`UPnP error ${code}${description ? ` (${description})` : ''}`);
    this.code = code;
  }
}

// The first gateway to answer an M-SEARCH: its description URL, and the
// address it answered from, which is the one to route toward.
function discoverGateway(timeoutMs = DISCOVER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('no internet gateway answered SSDP')), timeoutMs);
    socket.on('error', (error) => finish(error));
    socket.on('message', (message, from) => {
      const text = message.toString('latin1');
      const location = /^location:\s*(\S+)/im.exec(text)?.[1];
      if (location) finish(null, { location, address: from.address });
    });
    socket.bind(() => {
      for (const target of SEARCH_TARGETS) {
        const search = Buffer.from('M-SEARCH * HTTP/1.1\r\n'
          + `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n`
          + 'MAN: "ssdp:discover"\r\n'
          + 'MX: 2\r\n'
          + `ST: ${target}\r\n\r\n`, 'latin1');
        socket.send(search, SSDP_PORT, SSDP_ADDRESS);
      }
    });
  });
}

// The service in a device description that maps ports, and where to send its
// requests. `controlURL` is relative to `URLBase` when there is one, else to
// the description's own URL.
function findMappingService(xml, location) {
  const base = /<URLBase>\s*([^<\s]+)\s*<\/URLBase>/i.exec(xml)?.[1] || location;
  const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((match) => ({
    type: /<serviceType>\s*([^<\s]+)\s*<\/serviceType>/i.exec(match[1])?.[1],
    control: /<controlURL>\s*([^<\s]+)\s*<\/controlURL>/i.exec(match[1])?.[1],
  }));
  for (const type of SERVICE_TYPES) {
    const service = services.find((entry) => entry.type === type && entry.control);
    if (service) return { serviceType: type, controlUrl: new URL(service.control, base).href };
  }
  return null;
}

// This host's address on the gateway's LAN, which is what the mapping points
// at: miniupnpc's `lanaddr`. A connected UDP socket is told by the kernel
// which source address it would use; nothing is sent.
function localAddressToward(host) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.on('error', reject);
    socket.connect(SSDP_PORT, host, () => {
      const { address } = socket.address();
      socket.close();
      resolve(address);
    });
  });
}

function escapeXml(text) {
  return String(text).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  })[c]);
}

async function soap(service, action, args = {}) {
  const body = '<?xml version="1.0"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"'
    + ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
    + `<u:${action} xmlns:u="${service.serviceType}">`
    + Object.entries(args).map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`).join('')
    + `</u:${action}></s:Body></s:Envelope>`;
  const response = await fetch(service.controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${service.serviceType}#${action}"`,
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    const code = Number(/<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(text)?.[1]);
    if (code) throw new UpnpError(code, UPNP_ERRORS[code] || /<errorDescription>([^<]*)/i.exec(text)?.[1]);
    throw new Error(`${action} answered HTTP ${response.status}`);
  }
  return text;
}

// Forwards `publicPort` on the gateway to `localPort` here, TCP and UDP.
// `start()` resolves to the gateway's external address, or rejects with why
// nothing was mapped; `stop()` deletes what `start()` added.
function createUpnpMapping({
  publicPort, localPort = publicPort, description = 'bzo', leaseSeconds = DEFAULT_LEASE_SECONDS, log = () => {},
}) {
  let service = null;
  let lanAddress = null;
  let lease = leaseSeconds;
  let renewTimer = null;
  const mapped = new Set();

  async function addMappings() {
    for (const protocol of PROTOCOLS) {
      const args = {
        NewRemoteHost: '',
        NewExternalPort: publicPort,
        NewProtocol: protocol,
        NewInternalPort: localPort,
        NewInternalClient: lanAddress,
        NewEnabled: 1,
        NewPortMappingDescription: description,
        NewLeaseDuration: lease,
      };
      try {
        await soap(service, 'AddPortMapping', args);
      } catch (error) {
        if (error.code !== 725 || lease === 0) throw error;
        lease = 0;
        await soap(service, 'AddPortMapping', { ...args, NewLeaseDuration: 0 });
      }
      mapped.add(protocol);
    }
  }

  return {
    async start() {
      const gateway = await discoverGateway();
      const xml = await (await fetch(gateway.location, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).text();
      service = findMappingService(xml, gateway.location);
      if (!service) throw new Error(`${gateway.location} offers no port mapping service`);
      lanAddress = await localAddressToward(gateway.address);
      const reply = await soap(service, 'GetExternalIPAddress');
      const externalAddress = /<NewExternalIPAddress>\s*([^<\s]*)/i.exec(reply)?.[1] || '';
      await addMappings();
      log(`[UPNP] ${externalAddress || 'gateway'}:${publicPort} -> ${lanAddress}:${localPort} TCP+UDP`
        + `${lease ? `, renewed every ${Math.round(lease / 2)}s` : ', permanent'}`);
      if (lease > 0) {
        renewTimer = setInterval(() => {
          addMappings().catch((error) => log(`[UPNP] renewing failed: ${error.message}`));
        }, (lease / 2) * 1000);
        renewTimer.unref?.();
      }
      return externalAddress;
    },

    async stop() {
      clearInterval(renewTimer);
      renewTimer = null;
      const protocols = [...mapped];
      mapped.clear();
      await Promise.all(protocols.map((protocol) => soap(service, 'DeletePortMapping', {
        NewRemoteHost: '', NewExternalPort: publicPort, NewProtocol: protocol,
      }).catch((error) => log(`[UPNP] removing ${protocol} ${publicPort} failed: ${error.message}`))));
    },
  };
}

// A name to list instead of a bare address, which upstream lists: the
// address's reverse DNS, taken only where the name resolves back to it --
// the list server checks that `publicAddr` resolves to the address it hears
// from. Null when no name does.
async function nameForAddress(address, resolver = dns) {
  let names = [];
  try {
    names = await resolver.reverse(address);
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      if ((await resolver.resolve4(name)).includes(address)) return name.replace(/\.$/, '');
    } catch {
      // Not this one.
    }
  }
  return null;
}

module.exports = { createUpnpMapping, findMappingService, nameForAddress, UpnpError };
