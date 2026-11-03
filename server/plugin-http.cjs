/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// plugin-http.cjs - a plugin's web pages, shaped as upstream's
// (include/bzfsHTTPAPI.h) so a VDir ports line for line. Upstream serves them
// at `/<name>/` on the game port; bzo serves them at `/plugins/<name>/` on its
// own web server, with upstream's index of them at `/plugins/`.
//
// Not offered: BZID web login, sessions, templates and resource directories.
// A page that needs a login checks it itself.

'use strict';

const { URL, URLSearchParams } = require('node:url');

// bzhttp_eRequestType, bzhttp_eReturnCode, bzhttp_eDocumentType and
// bzhttp_ePageGenStatus, by upstream's names and in its order.
const REQUEST_TYPES = Object.freeze(['eHTTPUnknown', 'eHTTPGet', 'eHTTPHead', 'eHTTPPost', 'eHTTPPut',
  'eHTTPDelete', 'eHTTPTrace', 'eHTTPOptions', 'eHTTPConnect']);
const RETURN_CODES = Object.freeze(['e200OK', 'e301Redirect', 'e302Found', 'e401Unauthorized', 'e403Forbiden',
  'e404NotFound', 'e418IAmATeapot', 'e500ServerError']);
const STATUS_BY_CODE = Object.freeze([200, 301, 302, 401, 403, 404, 418, 500]);
const DOCUMENT_TYPES = Object.freeze(['eText', 'eOctetStream', 'eBinary', 'eHTML', 'eCSS', 'eXML', 'eJSON', 'eOther']);
const PAGE_STATUS = Object.freeze(['eNoPage', 'eWaitForIt', 'ePageDone']);

// getMimeType (bzfsHTTPAPI.cxx:1246).
const MIME_TYPES = Object.freeze([
  'text/plain', 'application/octet-stream', 'application/binary', 'text/html', 'text/css',
  'application/xml', 'application/json', 'text/plain',
]);

// What a plugin's `bz` gains: the enums by name, as upstream's are.
const HTTP_CONSTANTS = Object.freeze(Object.fromEntries([REQUEST_TYPES, RETURN_CODES, DOCUMENT_TYPES, PAGE_STATUS]
  .flatMap((names) => names.map((name, index) => [name, index]))));

// A name list's lookups, upstream's GetX(name) and GetX(index) both.
function lookup(pairs, folded) {
  return (key) => {
    if (typeof key === 'number') return pairs[key]?.[0] ?? null;
    const want = folded ? String(key).toLowerCase() : String(key);
    const found = pairs.find(([name]) => (folded ? name.toLowerCase() : name) === want);
    return found ? found[1] : null;
  };
}

// bzhttp_Request, from Express's. `body` is the raw bytes; a form POST's
// fields join the query's parameters, as upstream's parseParams adds both.
function makeRequest(req, body, address) {
  const headers = Object.entries(req.headers).map(([name, value]) => [name, String(value)]);
  const cookies = String(req.headers.cookie || '').split(';')
    .map((part) => part.trim()).filter(Boolean)
    .map((part) => {
      const at = part.indexOf('=');
      return at < 0 ? [part, ''] : [part.slice(0, at), decodeURIComponent(part.slice(at + 1))];
    });
  const text = body ? body.toString('utf8') : '';
  const params = [...new URL(req.originalUrl, 'http://x').searchParams];
  if (req.method === 'POST' && /application\/x-www-form-urlencoded/i.test(req.headers['content-type'] || '')) {
    params.push(...new URLSearchParams(text));
  }
  const typeIndex = REQUEST_TYPES.indexOf(`eHTTP${req.method.charAt(0)}${req.method.slice(1).toLowerCase()}`);
  return {
    RequestType: Math.max(0, typeIndex),
    URL: req.originalUrl,
    Resource: req.originalUrl.split('?')[0],
    RequesterIP: address,
    RequesterHost: '',
    BZID: '',
    BZIDCallsign: '',
    BZIDGroups: [],
    Body: text,
    BodyBytes: body || Buffer.alloc(0),
    UserHasPerm: () => false,
    InBZIDGroup: () => false,
    GetHeader: lookup(headers, true),
    GetHeaderCount: () => headers.length,
    GetCookie: lookup(cookies, false),
    GetCookieCount: () => cookies.length,
    GetParamater: lookup(params, false),
    GetParamaterCount: () => params.length,
    Version: 1,
  };
}

// bzhttp_Response, which the page fills.
function makeResponse() {
  const response = {
    ReturnCode: 0,
    DocumentType: 0,
    ForceNoCache: false,
    RedirectLocation: '',
    MimeType: '',
    MD5Hash: '',
    CookieDomain: '',
    CookiePath: '',
    headers: [],
    cookies: [],
    body: [],
    AddHeader(name, value) { response.headers.push([String(name), String(value)]); },
    AddCookies(name, value) { response.cookies.push([String(name), String(value)]); },
    AddBodyData(value) { response.body.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value))); },
    Version: 1,
  };
  return response;
}

// GenerateResponse (bzfsHTTPAPI.cxx:1358): the status, its type only on a
// 200, the redirect, no-cache, MD5, the page's own headers and cookies.
function sendResponse(res, response, vdirName) {
  const status = STATUS_BY_CODE[response.ReturnCode] ?? 500;
  res.status(status);
  if (status === 301 || status === 302) {
    if (response.RedirectLocation) res.set('Location', response.RedirectLocation);
  }
  const body = Buffer.concat(response.body);
  if (body.length > 0) {
    const ownType = response.DocumentType === DOCUMENT_TYPES.indexOf('eOther') && response.MimeType;
    res.type(status === 200 ? (ownType || MIME_TYPES[response.DocumentType] || 'text/plain') : 'text/html');
  }
  if (response.ForceNoCache) res.set('Cache-Control', 'no-cache');
  if (response.MD5Hash) res.set('Content-MD5', response.MD5Hash);
  for (const [name, value] of response.headers) res.set(name, value);
  for (const [name, value] of response.cookies) {
    res.cookie(name, value, {
      domain: response.CookieDomain || undefined,
      path: response.CookiePath || `/plugins/${vdirName}`,
      maxAge: 3600 * 1000,
      httpOnly: true,
    });
  }
  res.end(body);
}

// Upstream's HTTPIndexHandler: each page with a link and its description.
function indexPage(vdirs, host) {
  const escape = (text) => String(text).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const lines = vdirs.length === 0
    ? 'No HTTP Services are running on this server'
    : vdirs.map(({ name, description }) => `<a href="/plugins/${encodeURIComponent(name)}/">${escape(name)}</a>`
      + `&nbsp;${escape(description)}<br/>`).join('');
  return `<!DOCTYPE html><html><head><title>Index page for ${escape(host)}</title></head><body>${lines}</body></html>`;
}

// A page that answers eWaitForIt is asked again, with the same request and
// response, as upstream's Think asks it each pass of its loop; this often,
// and for this long before the request is given up as a 500.
const WAIT_MS = 100;
const WAIT_LIMIT_MS = 120 * 1000;

// Runs one page. `vdir` is the plugin's object, registered as `name`;
// `report` hears what it throws. GeneratePage may also return a promise of its
// status.
async function servePage(vdir, name, req, res, { body, address, report, timers = globalThis }) {
  const request = makeRequest(req, body, address);
  const response = makeResponse();
  const waitForIt = PAGE_STATUS.indexOf('eWaitForIt');
  const started = Date.now();
  let status;
  try {
    status = await vdir.GeneratePage(request, response);
    while (status === waitForIt && Date.now() - started < WAIT_LIMIT_MS && !res.writableEnded) {
      await new Promise((resolve) => { timers.setTimeout(resolve, WAIT_MS); });
      status = await vdir.GeneratePage(request, response);
    }
  } catch (error) {
    report(error);
    res.status(500).type('text/plain').end('Server Error\n');
    return;
  }
  if (status === waitForIt) {
    res.status(500).type('text/plain').end('Server Error\n');
    return;
  }
  if (status === PAGE_STATUS.indexOf('eNoPage') || status === undefined || status === false) {
    res.status(404).type('text/plain').end('Not Found\n');
    return;
  }
  sendResponse(res, response, name);
}

module.exports = { HTTP_CONSTANTS, indexPage, servePage };
